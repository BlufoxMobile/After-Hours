// =====================================================================================
// AFTER HOURS 3D — sim.js (SIM agent)
// ALL gameplay rules. Pure JS ES module: no three.js, no DOM, no Math.random, no clocks.
// Deterministic for a given seed + input sequence. Runs in node.
//
//   import { createSim } from './sim.js';
//   const sim = createSim({ seed });
//   sim.start(seed?)                      fresh run at 10 PM (optional new seed)
//   sim.step(dt, { mx, mz, dash, pulse }) dt clamped to 0.05, fixed substeps ≤ 1/60
//   sim.drain() -> events[]               returns + clears the event queue
//   sim.continueOvertime() -> bool        after 'won': endless overtime
//   sim.result() -> { score, kills, bestCombo, hour, clock, won, overtime, killedBy, time }
//   sim.state / sim.events                (see CONTRACT.md §2 / §3)
//   sim.debug = { god, skipTo(hourIndex), stats }
//
// Contract ADDITIONS (removals/renames: none):
//   state.hourName (display name of the current hour / overtime level), state.otLevel, state.introT
//   player.vx, player.vz (velocity m/s), player.dmg / bolts / pierce / fireInt (derived gun stats)
//   hazards: `by` (kind that owns it, or 'spark'); a0, a1, len — non-null only on the FLAGSHIP's
//     sweeping beam: the beam rotates from angle a0 to a1 while live (FX may draw the fan during warn)
//   fold hazard rectangle: local X axis = (cos a, -sin a) spans ±hw, local Z = (sin a, cos a) spans ±hd
//   eshots: `vR` (growth m/s of wave/ring R). Ring `gap` = { a, half }: the SAFE opening.
//   Event field notes — `type` is always the EVENT type, so:
//     hazardWarn / hazardLive carry the hazard type as `hazard` (alias `hazardType`) + `src`
//     pickupSpawn / pickup / pickupExpire carry the pickup type as `pickup` (alias `pickupType`),
//       'orb' | 'heart'  (gems only emit `gem` when collected)
//   hit.src: 'bolt' | 'od' (overdrive bolt) | 'dash' | 'pulse' | 'aura' | 'spark'
//   hurt.how: 'touch' | eshot type | hazard type | 'chomp' | attack name (what landed)
//   new event `bonus` { label, points }: hour clear, no-hit hour, sunrise, max-tier overflow
//   Internal bookkeeping fields on entities start with `_` — ignore them.
// =====================================================================================

import {
  ARENA, FIXTURES, SPAWNS, KIND_DIMS, KIND_INFO, HOURS, WEAPONS, PICKUPS, PLAYER_START,
} from './layout.js';
import { TUNE } from './sim-tuning.js';

const PI = Math.PI;
const TAU = PI * 2;
const NOINPUT = { mx: 0, mz: 0, dash: false, pulse: false };

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function wrapA(a) {
  a %= TAU;
  if (a > PI) a -= TAU; else if (a < -PI) a += TAU;
  return a;
}
function turnTo(a, b, max) {
  const d = wrapA(b - a);
  if (d > max) return wrapA(a + max);
  if (d < -max) return wrapA(a - max);
  return b;
}
function mulberry32(seed) {
  const st = new Uint32Array(1);
  st[0] = seed >>> 0;
  return function () {
    st[0] = st[0] + 0x6D2B79F5;
    let t = st[0];
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// first entry parameter (0..1) of segment p0->p1 into circle, or -1
function segCircle(x0, z0, x1, z1, cx, cz, r) {
  const fx = x0 - cx, fz = z0 - cz;
  const c = fx * fx + fz * fz - r * r;
  if (c <= 0) return 0;
  const dx = x1 - x0, dz = z1 - z0;
  const a = dx * dx + dz * dz;
  if (a < 1e-12) return -1;
  const b = 2 * (fx * dx + fz * dz);
  if (b >= 0) return -1;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t <= 1 ? t : -1;
}
function distSeg(px, pz, x0, z0, x1, z1) {
  const dx = x1 - x0, dz = z1 - z0;
  const L = dx * dx + dz * dz;
  let t = L > 1e-9 ? ((px - x0) * dx + (pz - z0) * dz) / L : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = x0 + dx * t - px, qz = z0 + dz * t - pz;
  return Math.sqrt(qx * qx + qz * qz);
}

// ------------------------------------------------------------------ world geometry
// Hot loops read fixtures every substep. layout.js objects come in two shapes (box / circle)
// with some Smi coordinates, which makes V8 box every double read — so keep a monomorphic,
// double-typed copy here (measured: ~20 KB/step of garbage -> ~0).
const FX = FIXTURES.map((f) => ({
  box: f.type === 'box', x: f.x + 0.5 - 0.5, z: f.z + 0.5 - 0.5, hw: (f.hw || 0) + 0.5 - 0.5, hd: (f.hd || 0) + 0.5 - 0.5,
  r: (f.r || 0) + 0.5 - 0.5, shotsPass: !!f.shotsPass,
}));
const AX0 = ARENA.minX, AX1 = ARENA.maxX, AZ0 = ARENA.minZ, AZ1 = ARENA.maxZ;
const KIOSK = FX.find((f) => !f.box && !f.shotsPass) || null;
const PERCHES = SPAWNS.map((s, i) => Object.assign({}, s, { idx: i }));
const MODEM_PERCHES = PERCHES.filter((p) => p.for === 'modem');
const PHONE_PERCHES = PERCHES.filter((p) => p.for === 'phone');
const DOOR_PERCHES = PERCHES.filter((p) => p.for === 'any');
const TABLE_GROUPS = (() => {
  const m = new Map();
  for (const p of MODEM_PERCHES) { if (!m.has(p.fixture)) m.set(p.fixture, []); m.get(p.fixture).push(p); }
  return [...m.values()];
})();
const WALL_GROUPS = (() => {
  const out = [];
  for (const side of ['wallL', 'wallR']) {
    const w = PHONE_PERCHES.filter((p) => p.fixture === side).sort((a, b) => a.z - b.z);
    for (let i = 0; i + 3 <= w.length; i++) out.push(w.slice(i, i + 3));
  }
  return out;
})();
// bosses wake up standing ON the service counter at the back of the store, then leap down
const BOSS_PERCH = { x: 0, y: 1.05, z: -10.0 };
const HOUR_H24 = HOURS.map((H) => {
  const m = /^(\d+)\s*(AM|PM)$/i.exec(H.clock.trim());
  if (!m) return 0;
  let h = parseInt(m[1], 10) % 12;
  if (m[2].toUpperCase() === 'PM') h += 12;
  return h;
});
const EEK = { orb: '#ff9a2e', bolt: '#ff3b3b', wave: '#35e7ff', ring: '#ffd23e', notif: '#ff3ec8' };
const ENEMY_KINDS = Object.keys(KIND_DIMS).filter((k) => !KIND_DIMS[k].boss);

function weightArr(w) {
  const arr = [];
  let tot = 0;
  for (const k in w) { if (w[k] > 0 && KIND_DIMS[k]) { tot += w[k]; arr.push({ k, c: tot, fam: KIND_DIMS[k].family }); } }
  for (const o of arr) o.c /= tot;
  return arr;
}
const HOUR_W = TUNE.hours.map((H) => weightArr(H.w));
const OT_W = weightArr(TUNE.overtime.w);

function fmtClock(h24, min) {
  h24 = ((h24 % 24) + 24) % 24;
  const ap = h24 < 12 ? 'AM' : 'PM';
  let h12 = h24 % 12;
  if (h12 === 0) h12 = 12;
  return h12 + ':' + (min < 10 ? '0' : '') + min + ' ' + ap;
}
function fmtHour(h24) {
  h24 = ((h24 % 24) + 24) % 24;
  let h12 = h24 % 12;
  if (h12 === 0) h12 = 12;
  return h12 + (h24 < 12 ? ' AM' : ' PM');
}

// Push a circle (x,z, radius r) out of every fixture and clamp its centre into ARENA (shrunk by
// `inset`). Result in CW[0], CW[1]; returns true if anything was hit. Works on plain numbers so
// hot call sites stay monomorphic (no boxed doubles / GC churn).
const CW = new Float64Array(4);   // in: x, z, r, inset   out: x, z
function collideCW() {
  let x = CW[0], z = CW[1];
  const r = CW[2], inset = CW[3];
  let hit = false;
  for (let i = 0; i < FX.length; i++) {
    const f = FX[i];
    if (f.box) {
      const dx = x - f.x, dz = z - f.z;
      if (dx > f.hw + r || dx < -f.hw - r || dz > f.hd + r || dz < -f.hd - r) continue;
      const cx = dx < -f.hw ? -f.hw : dx > f.hw ? f.hw : dx;
      const cz = dz < -f.hd ? -f.hd : dz > f.hd ? f.hd : dz;
      const px = dx - cx, pz = dz - cz;
      const d2 = px * px + pz * pz;
      if (d2 >= r * r) continue;
      if (d2 > 1e-10) {
        const d = Math.sqrt(d2), k = (r - d) / d;
        x += px * k; z += pz * k;
      } else {
        const ox = f.hw - Math.abs(dx), oz = f.hd - Math.abs(dz);
        if (ox < oz) x = f.x + (dx >= 0 ? 1 : -1) * (f.hw + r);
        else z = f.z + (dz >= 0 ? 1 : -1) * (f.hd + r);
      }
      hit = true;
    } else {
      const dx = x - f.x, dz = z - f.z, rr = f.r + r;
      const d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr) continue;
      const d = Math.sqrt(d2);
      if (d > 1e-6) { x = f.x + dx / d * rr; z = f.z + dz / d * rr; }
      else { z = f.z + rr; }
      hit = true;
    }
  }
  if (x < AX0 + inset) { x = AX0 + inset; hit = true; }
  else if (x > AX1 - inset) { x = AX1 - inset; hit = true; }
  if (z < AZ0 + inset) { z = AZ0 + inset; hit = true; }
  else if (z > AZ1 - inset) { z = AZ1 - inset; hit = true; }
  CW[0] = x; CW[1] = z;
  return hit;
}
function collideXZ(x, z, r, inset) { CW[0] = x; CW[1] = z; CW[2] = r; CW[3] = inset; return collideCW(); }
// monomorphic wrappers for the hot paths (enemies / player): no double args crossing calls
function collideEnemy(e) {
  CW[0] = e.x; CW[1] = e.z; CW[2] = e.boss ? e.r * 0.9 : e.r; CW[3] = 0;
  if (!collideCW()) return false;
  e.x = CW[0]; e.z = CW[1];
  return true;
}
function collidePlayer(P) {
  CW[0] = P.x; CW[1] = P.z; CW[2] = 0.35; CW[3] = 0;
  if (!collideCW()) return false;
  P.x = CW[0]; P.z = CW[1];
  return true;
}
// convenience for cold paths (temporary {x,z} objects)
function collideWorld(o, r, inset) {
  const hit = collideXZ(o.x, o.z, r, inset || 0);
  o.x = CW[0]; o.z = CW[1];
  return hit;
}
function insideFixture(x, z, margin) {
  for (const f of FX) {
    if (f.box) {
      if (Math.abs(x - f.x) < f.hw + margin && Math.abs(z - f.z) < f.hd + margin) return true;
    } else {
      const dx = x - f.x, dz = z - f.z, rr = f.r + margin;
      if (dx * dx + dz * dz < rr * rr) return true;
    }
  }
  return false;
}
function los(x0, z0, x1, z1) {
  return !KIOSK || segCircle(x0, z0, x1, z1, KIOSK.x, KIOSK.z, KIOSK.r) < 0;
}
// end point of a beam from (x,z) at angle a, clipped by the arena (+0.6 m) and the kiosk
const BEAM_END = { x: 0, z: 0, len: 0 };
function beamEnd(x, z, a, len) {
  const dx = Math.sin(a), dz = Math.cos(a);
  let t = len;
  const minX = ARENA.minX - 0.6, maxX = ARENA.maxX + 0.6, minZ = ARENA.minZ - 0.6, maxZ = ARENA.maxZ + 0.6;
  if (dx > 1e-6) t = Math.min(t, (maxX - x) / dx); else if (dx < -1e-6) t = Math.min(t, (minX - x) / dx);
  if (dz > 1e-6) t = Math.min(t, (maxZ - z) / dz); else if (dz < -1e-6) t = Math.min(t, (minZ - z) / dz);
  if (t < 0) t = 0;
  if (KIOSK) {
    const k = segCircle(x, z, x + dx * t, z + dz * t, KIOSK.x, KIOSK.z, KIOSK.r);
    if (k > 0) t *= k;
  }
  BEAM_END.x = x + dx * t; BEAM_END.z = z + dz * t; BEAM_END.len = t;
  return BEAM_END;
}

// ------------------------------------------------------------------ spatial hash
const CELL = 1.25, GX0 = -8.5, GZ0 = -12.5, GW = 14, GH = 21;
function gCellX(x) { const c = Math.floor((x - GX0) / CELL); return c < 0 ? 0 : c >= GW ? GW - 1 : c; }
function gCellZ(z) { const c = Math.floor((z - GZ0) / CELL); return c < 0 ? 0 : c >= GH ? GH - 1 : c; }

// =====================================================================================
export function createSim(opts = {}) {
  const baseSeed = (opts.seed == null ? 0xC3F0C5 : Number(opts.seed)) >>> 0;
  let runNo = 0;
  let rand = mulberry32(baseSeed);
  const rnd = (a, b) => a + rand() * (b - a);
  const irnd = (a, b) => a + Math.floor(rand() * (b - a + 1));

  const S = {
    phase: 'play', t: 0, hour: 0, hourT: 0, hourDur: 35, clock: '10:00 PM', mood: 'close',
    hourName: '', otLevel: 0, introT: 0,
    score: 0, kills: 0, combo: 0, mult: 1, bestCombo: 0,
    player: {
      x: 0, z: 0, face: PI, aim: PI, spd: 0, moving: false, firing: false, dashT: 0, inv: 0, hurtT: 0,
      hp: 5, maxHp: 5, od: 0, odT: 0, shieldT: 0, buffs: { rapid: 0, shield: 0, vac: 0 },
      wTier: 0, wName: WEAPONS[0].n, xp: 0, xpNext: TUNE.xp[0],
      dashCD: 0, dashCDMax: TUNE.player.dashCD, pulseCD: 0, pulseCDMax: TUNE.player.pulseCD,
      aura: 0, alive: true, vx: 0, vz: 0, dmg: 1, bolts: 1, pierce: 0, fireInt: WEAPONS[0].f, _spread: 0.13,
    },
    enemies: [], pshots: [], eshots: [], hazards: [], pickups: [], boss: null,
  };
  const EV = [];   // stable array: accumulates until drain()
  let G = null;
  let nextId = 1;
  const nid = () => nextId++;
  const debug = { god: false, skipTo, stats: null };

  // grid storage (enemies indices)
  const gHead = new Int32Array(GW * GH);
  let gNext = new Int32Array(160);

  function emit(ev) {
    EV.push(ev);
    if (EV.length > 6000) EV.splice(0, EV.length - 4000);   // nobody is draining: keep it bounded
  }
  function hitstop(dur, big) {
    if (!big && G.hitstopCD > 0) return;
    G.hitstopCD = 0.2;
    emit({ type: 'hitstop', dur: Math.min(0.12, dur) });
  }
  function shake(amt) { emit({ type: 'shake', amt: Math.min(1, amt) }); }

  // ================================================================== reset / start
  function freshG() {
    return {
      vx: 0, vz: 0, fireT: 0.2, dashBuf: 0, pulseBuf: 0, dashId: 0, dashDX: 0, dashDZ: -1,
      dmgBonus: 0, fireMul: 1, multiBonus: 0, pierceBonus: 0, speedMul: 1, scav: 0, gemMul: 1, magnetBonus: 0,
      comboT: 0, hurtHour: false, killedBy: null, won: false, overtime: false, otLevel: 0,
      budget: 0, pulseT: TUNE.director.firstPulse, queue: [], perchBusy: new Float64Array(PERCHES.length),
      seen: new Set(), packId: 0, pupT: TUNE.pups.first, pupSeq: 0, sparkT: 0, auraT: 0,
      introT: 0, boss: null, bossStartT: 0, bossTimes: [], afterBoss: false,
      clockKey: -1, hitstopCD: 0, godHits: 0, maxEnemies: 0, maxE: 0, maxP: 0, maxH: 0, maxK: 0,
    };
  }
  function reset(seed) {
    rand = mulberry32(seed >>> 0);
    G = freshG();
    S.phase = 'play'; S.t = 0; S.hour = 0; S.hourT = 0; S.hourDur = HOURS[0].dur; S.mood = HOURS[0].mood;
    S.clock = fmtClock(HOUR_H24[0], 0); S.hourName = HOURS[0].name; S.otLevel = 0; S.introT = 0;
    S.score = 0; S.kills = 0; S.combo = 0; S.mult = 1; S.bestCombo = 0;
    const P = S.player, TP = TUNE.player;
    P.x = PLAYER_START.x; P.z = PLAYER_START.z; P.face = PI; P.aim = PI; P.spd = 0; P.moving = false;
    P.firing = false; P.dashT = 0; P.inv = 0; P.hurtT = 0; P.hp = TP.hp; P.maxHp = TP.hp; P.od = 0; P.odT = 0;
    P.shieldT = 0; P.buffs.rapid = 0; P.buffs.shield = 0; P.buffs.vac = 0;
    P.wTier = 0; P.wName = WEAPONS[0].n; P.xp = 0; P.xpNext = TUNE.xp[0];
    P.dashCD = 0; P.dashCDMax = TP.dashCD; P.pulseCD = 0; P.pulseCDMax = TP.pulseCD; P.aura = 0; P.alive = true;
    P.vx = 0; P.vz = 0;
    S.enemies.length = 0; S.pshots.length = 0; S.eshots.length = 0; S.hazards.length = 0; S.pickups.length = 0;
    S.boss = null;
    recalcGun();
    debug.stats = G;
  }
  function start(seed) {
    const sd = seed != null ? Number(seed) >>> 0 : (baseSeed + Math.imul(runNo, 7919)) >>> 0;
    runNo++;
    reset(sd);
    EV.length = 0;
    emit({ type: 'start' });
    beginHour(0);
  }
  function drain() { const out = EV.slice(); EV.length = 0; return out; }

  // ================================================================== helpers
  function hourTune() {
    if (S.hour < 8) return TUNE.hours[S.hour];
    return OT_CACHE();
  }
  let otCacheLevel = -1, otCacheObj = null;
  function OT_CACHE() {
    if (otCacheLevel === G.otLevel && otCacheObj) return otCacheObj;
    const O = TUNE.overtime, L = G.otLevel;
    const r = Math.min(O.rateMax, O.rate + O.rateStep * L);
    otCacheObj = {
      rate: [r, r + 0.3], pulse: O.pulse, pack: O.pack, w: O.w, elite: Math.min(O.eliteMax, O.elite + O.eliteStep * L),
      spark: Math.max(O.sparkMin, O.spark + O.sparkStep * L), sparkN: L >= 3 ? 2 : 1, hp: O.hp + O.hpStep * L,
    };
    otCacheLevel = L;
    return otCacheObj;
  }
  function hourW() { return S.hour < 8 ? HOUR_W[S.hour] : OT_W; }
  function hpMul() { return hourTune().hp; }
  function otMul() { return S.hour >= 8 ? 1 + TUNE.score.otMulStep * (G.otLevel + 1) : 1; }
  function pickKind(fam) {
    const W = hourW();
    for (let tries = 0; tries < 6; tries++) {
      const r = rand();
      for (const o of W) {
        if (r <= o.c) { if (!fam || o.fam === fam) return o.k; break; }
      }
    }
    if (fam) { for (const o of W) if (o.fam === fam) return o.k; }
    return W.length ? W[W.length - 1].k : 'xb6';
  }
  function rollElite() { return rand() < hourTune().elite; }
  function setSt(e, st, dur) { e.state = st; e.stateT = 0; e.stateDur = dur; }
  function targetable(e) { return !e._dead && e.state !== 'spawn' && e.state !== 'dying'; }

  // ================================================================== enemies: creation / spawn
  function newEnemy(kind, elite) {
    const D = KIND_DIMS[kind];
    const boss = !!D.boss;
    const K = boss ? TUNE.bosses[kind] : TUNE.kinds[kind];
    const E = TUNE.elite;
    const hp = K.hp * (boss ? 1 : hpMul()) * (elite ? E.hp : 1);
    return {
      id: nid(), kind, x: 0, y: 0, z: 0, face: 0, r: D.r * (elite ? E.r : 1), spd: 0,
      state: 'spawn', stateT: 0, stateDur: 1, attack: null, flash: 0, elite: !!elite,
      hp, maxHp: hp, boss, phase: boss ? 1 : 0, spawnFrom: null,
      _dead: false, _kx: 0, _kz: 0,
      _cd: boss ? 1.2 : rnd(0.7, 1.8), _dir: rand() < 0.5 ? -1 : 1,
      _sm: boss ? 1 : (1 + 0.035 * Math.min(S.hour, 11)) * (elite ? E.speed : 1) * rnd(0.92, 1.08),
      _ph: rand() * TAU, _slot: 0, _pack: 0, _haz: null, _hazList: null, _lastDash: -1,
      _parent: null, _pods: 0, _a: 0, _a0: 0, _a1: 0, _tx: 0, _tz: 0, _sx: 0, _sz: 0, _lx: 0, _lz: 0,
      _boot: 0, _apex: 0, _hitP: false, _n: 0, _nt: 0, _last: null, _flipT: rnd(2, 4), _variant: 0,
      _h: D.h * (elite ? E.r : 1) + 0.5 - 0.5, _grace: 0.5 - 0.5, _spinDir: 1, _avSide: 0, _avT: 0, _avF: -1, _avAge: 0, _avStall: 0, _px: 0, _pz: 0, _want: 0, _pts: K.pts * (elite ? E.pts : 1), _xp: (K.xp || 0) * (elite ? E.xp : 1),
    };
  }
  function beginSpawn(e, px, py, pz, lx, lz, boot, hop, apex) {
    e.state = 'spawn'; e.stateT = 0; e.stateDur = boot + hop;
    e.spawnFrom = { x: px, y: py, z: pz };
    e.x = px; e.y = py; e.z = pz; e._lx = lx; e._lz = lz; e._boot = boot; e._apex = apex;
    e.face = Math.atan2(lx - px, lz - pz);
  }
  function addEnemy(e) {
    S.enemies.push(e);
    emit({ type: 'spawn', id: e.id, kind: e.kind, x: e.x, y: e.y, z: e.z, elite: e.elite });
    if (!G.seen.has(e.kind)) { G.seen.add(e.kind); emit({ type: 'newThreat', kind: e.kind }); }
  }
  function perchOK(p) {
    if (G.perchBusy[p.idx] > S.t) return false;
    const P = S.player, s2 = TUNE.director.spawnSafe * TUNE.director.spawnSafe;
    let dx = p.x - P.x, dz = p.z - P.z;
    if (dx * dx + dz * dz < s2) return false;
    dx = p.lx - P.x; dz = p.lz - P.z;
    return dx * dx + dz * dz >= s2;
  }
  function pickOK(pool) {
    const n = pool.length;
    if (!n) return null;
    const o = Math.floor(rand() * n);
    for (let i = 0; i < n; i++) { const p = pool[(o + i) % n]; if (perchOK(p)) return p; }
    return null;
  }
  function choosePerch(kind) {
    const fam = KIND_DIMS[kind].family;
    if (rand() < 0.12) { const d = pickOK(DOOR_PERCHES); if (d) return d; }
    return pickOK(fam === 'phone' ? PHONE_PERCHES : MODEM_PERCHES) || pickOK(DOOR_PERCHES);
  }
  function spawnFromPerch(kind, perch, elite, pack, slot) {
    const e = newEnemy(kind, elite);
    const door = perch.for === 'any', phone = perch.for === 'phone';
    const boot = 0.45, hop = door ? 0.6 : 0.5, apex = door ? 0.25 : phone ? 0.7 : 0.55;
    beginSpawn(e, perch.x, perch.y, perch.z, perch.lx + rnd(-0.15, 0.15), perch.lz + rnd(-0.15, 0.15), boot, hop, apex);
    G.perchBusy[perch.idx] = S.t + boot + hop + 0.2;
    e._pack = pack || 0; e._slot = slot || 0;
    addEnemy(e);
    return e;
  }
  function spawnPodFrom(src, ang, dist) {
    if (S.enemies.length >= TUNE.cap.enemies) return null;
    const e = newEnemy('pod', false);
    const tmp = { x: src.x + Math.sin(ang) * dist, z: src.z + Math.cos(ang) * dist };
    collideWorld(tmp, e.r, 0);
    beginSpawn(e, src.x, 0.9, src.z, tmp.x, tmp.z, 0.12, 0.4, 0.55);
    e._parent = src;
    addEnemy(e);
    return e;
  }
  function updSpawn(e) {
    const t = e.stateT, b = e._boot;
    if (t <= b) { e.spd = 0; return; }
    const hop = e.stateDur - b;
    const u = Math.min(1, (t - b) / hop);
    const sf = e.spawnFrom;
    e.x = sf.x + (e._lx - sf.x) * u; e.z = sf.z + (e._lz - sf.z) * u;
    e.y = sf.y * (1 - u) + e._apex * 4 * u * (1 - u);
    const dx = e._lx - sf.x, dz = e._lz - sf.z;
    e.spd = Math.sqrt(dx * dx + dz * dz) / hop;
    if (u >= 1) land(e);
  }
  function land(e) {
    e.y = 0; e.spawnFrom = null; e.spd = 0; e._grace = 0.35;
    setSt(e, 'move', 1);
    emit({ type: 'land', id: e.id, kind: e.kind, x: e.x, z: e.z });
    if (e.boss) { e._cd = 1.3; shake(0.8); hitstop(0.08, true); }
  }

  // ================================================================== director
  function queueSpawn(delay, kind, perch, elite, pack, slot) {
    G.queue.push({ at: S.t + delay, kind, perch, elite, pack, slot });
  }
  function processQueue() {
    const q = G.queue;
    for (let i = 0; i < q.length; i++) {
      const s = q[i];
      if (s.at > S.t) continue;
      let done = true;
      if (S.enemies.length < TUNE.cap.enemies) {
        if (perchOK(s.perch)) spawnFromPerch(s.kind, s.perch, s.elite, s.pack, s.slot);
        else if (S.t - s.at > 2.5) { const p = choosePerch(s.kind); if (p) spawnFromPerch(s.kind, p, s.elite, s.pack, s.slot); }
        else done = false;
      }
      if (done) { q[i] = q[q.length - 1]; q.pop(); i--; }
    }
  }
  function doPulse(extra) {
    const T = hourTune();
    let n = irnd(T.pack[0], T.pack[1]) + (extra || 0);
    n = Math.min(n, TUNE.cap.enemies - S.enemies.length - G.queue.length);
    if (n <= 0) return;
    const lead = pickKind(null);
    const fam = KIND_DIMS[lead].family;
    const same = lead === 'xb6' || lead === 'pod' || rand() < 0.35;
    const groups = fam === 'phone' ? WALL_GROUPS : TABLE_GROUPS;
    const off = Math.floor(rand() * groups.length);
    let g = null;
    for (let i = 0; i < groups.length && !g; i++) {
      const cand = groups[(off + i) % groups.length];
      if (cand.every(perchOK)) g = cand;
    }
    const pack = ++G.packId;
    let placed = 0;
    if (g) {
      for (let i = 0; i < g.length && placed < n; i++) {
        const kind = placed === 0 || same ? lead : pickKind(fam);
        queueSpawn(i * 0.14, kind, g[i], rollElite(), pack, i - 1);
        placed++;
      }
    }
    let di = Math.floor(rand() * 2);
    while (placed < n) {
      const door = DOOR_PERCHES[di % DOOR_PERCHES.length]; di++;
      const kind = same ? lead : pickKind(null);
      queueSpawn(0.4 + placed * 0.3, kind, door, rollElite(), pack, (placed % 3) - 1);
      placed++;
    }
  }
  function director(h) {
    if (G.boss && G.boss.state === 'dying') return;
    processQueue();
    const T = hourTune();
    const quiet = S.hourDur != null && S.hourT > S.hourDur - TUNE.director.quietTail;
    if (!quiet) {
      const u = S.hourDur ? clamp(S.hourT / S.hourDur, 0, 1) : 0;
      G.budget += (T.rate[0] + (T.rate[1] - T.rate[0]) * u) * h;
      let room = TUNE.cap.enemies - S.enemies.length - G.queue.length;
      if (room <= 0) G.budget = Math.min(G.budget, 1.5);
      while (G.budget >= 1 && room > 0) {
        const kind = pickKind(null);
        const p = choosePerch(kind);
        if (!p) { G.budget = Math.min(G.budget, 3); break; }
        spawnFromPerch(kind, p, rollElite(), 0, 0);
        G.budget -= 1; room--;
      }
      G.pulseT -= h;
      if (G.pulseT <= 0) { G.pulseT = rnd(T.pulse[0], T.pulse[1]); doPulse(0); }
      if (T.spark > 0) {
        G.sparkT -= h;
        if (G.sparkT <= 0) {
          G.sparkT = T.spark * rnd(0.8, 1.2);
          for (let i = 0; i < (T.sparkN || 1); i++) addSpark(i > 0);
        }
      }
    }
    // power drops
    G.pupT -= h;
    if (G.pupT <= 0) {
      const boss = !!(G.boss && !G.boss._dead);
      const ev = boss ? TUNE.pups.bossEvery : TUNE.pups.every;
      G.pupT = rnd(ev[0], ev[1]);
      let live = 0;
      for (const o of S.pickups) if (o.type === 'orb' && !o._dead) live++;
      if (live < TUNE.pups.maxLive) spawnPup();
    }
  }
  function addSpark(far) {
    const P = S.player, T = TUNE.hazards;
    let x, z;
    if (!far && rand() < T.sparkOnYou) { x = P.x + rnd(-0.4, 0.4); z = P.z + rnd(-0.4, 0.4); }
    else { const a = rand() * TAU, d = rnd(1.2, T.sparkNear); x = P.x + Math.sin(a) * d; z = P.z + Math.cos(a) * d; }
    x = clamp(x, ARENA.minX + 0.3, ARENA.maxX - 0.3); z = clamp(z, ARENA.minZ + 0.3, ARENA.maxZ - 0.3);
    addHazard('spark', { x, z, r: T.sparkR, warn: T.sparkWarn, live: T.sparkLive, src: 0, by: 'spark' });
  }

  // ================================================================== hours / clock
  function beginHour(hi) {
    const wasBoss = G.afterBoss;
    G.afterBoss = false;
    S.hour = hi; S.hourT = 0;
    const H = HOURS[hi];
    S.hourDur = H.dur != null ? H.dur : null; S.mood = H.mood; S.hourName = H.name;
    G.hurtHour = false; G.budget = 0;
    G.pulseT = hi === 0 ? TUNE.director.firstPulse : wasBoss ? TUNE.director.afterBoss : TUNE.director.hourPulse;
    G.sparkT = (TUNE.hours[hi].spark || 0) * 0.7;
    const ev = { type: 'hour', hour: hi, name: H.name, clock: H.clock };
    if (H.boss) ev.boss = H.boss;
    emit(ev);
    if (H.boss) startBossIntro(H.boss);
    G.clockKey = -1; updClock();
  }
  function hourBonuses(hi) {
    const Sc = TUNE.score;
    const clear = Math.round((Sc.hourClear[0] + Sc.hourClear[1] * hi) * otMul());
    S.score += clear;
    emit({ type: 'bonus', label: 'HOUR CLEAR', points: clear });
    if (!G.hurtHour) {
      const nh = Math.round((Sc.noHit[0] + Sc.noHit[1] * hi) * otMul());
      S.score += nh;
      emit({ type: 'bonus', label: 'NO-HIT HOUR', points: nh });
    }
  }
  function hourCheck() {
    if (S.hourDur == null || S.hourT < S.hourDur) return;
    if (S.phase !== 'play' && S.phase !== 'overtime') return;
    if (S.hour >= 8) {
      hourBonuses(8 + G.otLevel);
      G.otLevel++; S.otLevel = G.otLevel; S.hourT = 0; G.hurtHour = false;
      const names = TUNE.overtime.names;
      const nm = G.otLevel < names.length ? names[G.otLevel] : 'OVERTIME +' + G.otLevel;
      S.hourName = nm;
      emit({ type: 'hour', hour: 8, name: nm, clock: fmtHour(6 + G.otLevel) });
      G.pulseT = 1.5;
      G.clockKey = -1;
      return;
    }
    hourBonuses(S.hour);
    if (S.hour + 1 >= HOURS.length) victory();
    else beginHour(S.hour + 1);
  }
  function updClock() {
    let key, h24, min;
    if (G.won && S.phase === 'won') { key = 9999; h24 = 6; min = 0; }
    else if (S.hour >= 8) { min = Math.min(59, Math.floor(60 * S.hourT / TUNE.overtime.dur)); h24 = 6 + G.otLevel; key = 10000 + G.otLevel * 60 + min; }
    else if (S.hourDur == null) { h24 = HOUR_H24[S.hour]; min = 0; key = S.hour * 100; }
    else { h24 = HOUR_H24[S.hour]; min = Math.min(59, Math.floor(60 * S.hourT / S.hourDur)); key = S.hour * 100 + min; }
    if (key !== G.clockKey) { G.clockKey = key; S.clock = fmtClock(h24, min); }
  }
  function victory() {
    S.phase = 'won'; G.won = true;
    const P = S.player;
    for (const e of S.enemies) {
      if (e._dead) continue;
      if (e.state === 'spawn') { e.x = e._lx; e.z = e._lz; e.spawnFrom = null; }
      cancelHaz(e); setSt(e, 'stun', 9999); e.spd = 0; e.y = 0; e.attack = null;
    }
    S.eshots.length = 0; S.hazards.length = 0; S.pshots.length = 0; G.queue.length = 0;
    const b = TUNE.score.victory;
    S.score += b;
    emit({ type: 'bonus', label: 'SUNRISE', points: b });
    P.firing = false; P.spd = 0; P.moving = false; G.vx = G.vz = 0; P.vx = P.vz = 0;
    G.clockKey = -1; updClock();
    emit({ type: 'victory', score: S.score });
  }
  function continueOvertime() {
    if (S.phase !== 'won') return false;
    G.overtime = true; G.otLevel = 0; S.otLevel = 0;
    S.phase = 'overtime'; S.hour = 8; S.hourT = 0; S.hourDur = TUNE.overtime.dur; S.mood = 'overtime';
    S.hourName = TUNE.overtime.names[0];
    for (const e of S.enemies) if (!e._dead) { setSt(e, 'recover', 0.8); e._cd = rnd(0.8, 2); }
    S.player.inv = Math.max(S.player.inv, 1.5);
    G.pulseT = 2; G.sparkT = 3; G.budget = 0; G.hurtHour = false; G.pupT = Math.min(G.pupT, 4);
    emit({ type: 'hour', hour: 8, name: S.hourName, clock: fmtHour(6) });
    G.clockKey = -1; updClock();
    return true;
  }

  // ================================================================== bosses: intro / death
  function startBossIntro(kind) {
    S.phase = 'bossIntro';
    G.introT = TUNE.bosses.intro; S.introT = G.introT;
    S.pshots.length = 0; S.eshots.length = 0; S.hazards.length = 0; G.queue.length = 0;
    for (const e of S.enemies) {
      if (e._dead || e.state === 'spawn') continue;
      if (e.kind === 'iphone' && e.state === 'attack') { e.x = e._tx; e.z = e._tz; }
      e.y = 0; e._haz = null; e._hazList = null;
      if (e.state !== 'move') { setSt(e, 'move', 1); e._cd = rnd(1, 2); }
    }
    const P = S.player;
    const e = newEnemy(kind, false);
    let lx = 0, lz = -6.4;
    if ((P.x - lx) ** 2 + (P.z - lz) ** 2 < 16) { lx = P.x > 0 ? -3.0 : 3.0; lz = -7.4; }
    const B = TUNE.bosses;
    beginSpawn(e, BOSS_PERCH.x, BOSS_PERCH.y, BOSS_PERCH.z, lx, lz, B.introBoot, B.intro - B.introBoot, B.apex);
    e.face = 0;
    addEnemy(e);
    G.boss = e; G.bossStartT = S.t;
    S.boss = { id: e.id, kind, name: KIND_INFO[kind].name, hp: e.hp, maxHp: e.maxHp, phase: 1 };
    emit({ type: 'bossIntro', kind, name: KIND_INFO[kind].name });
  }
  function bossDie(e) {
    e.hp = 0;
    cancelHaz(e, true);
    setSt(e, 'dying', TUNE.bosses.dying);
    e.spd = 0;
    for (const s of S.eshots) s._dead = true;
    for (const hz of S.hazards) if (hz.src === e.id) hz._dead = true;
    G.queue.length = 0;
    if (S.boss) S.boss.hp = 0;
    emit({ type: 'bossDying', kind: e.kind, x: e.x, z: e.z });
    hitstop(0.12, true); shake(1);
  }
  function finishBoss(e) {
    e._dead = true;
    const B = TUNE.bosses[e.kind];
    comboAdd();
    S.kills++;
    const pts = Math.round(B.pts * S.mult * otMul());
    S.score += pts;
    emit({ type: 'bossKill', kind: e.kind, x: e.x, z: e.z, points: pts });
    shake(1);
    odGain(TUNE.od.boss);
    for (let i = 0; i < 14; i++) {
      const a = rand() * TAU, d = rnd(0.6, 2.8);
      addGem(e.x + Math.sin(a) * d, e.z + Math.cos(a) * d, 3);
    }
    addHeart(e.x - 1, e.z + 1.2); addHeart(e.x + 1, e.z + 1.2);
    for (const o of S.enemies) if (!o._dead && !o.boss) killEnemy(o, true);
    G.queue.length = 0;
    G.bossTimes.push({ kind: e.kind, t: S.t - G.bossStartT });
    G.boss = null; S.boss = null;
    G.afterBoss = true;
    if (S.hour + 1 >= HOURS.length) victory();
    else beginHour(S.hour + 1);
  }
  function bossPhaseCheck(e) {
    const f = e.hp / e.maxHp;
    const ph = f > 0.66 ? 1 : f > 0.33 ? 2 : 3;
    if (ph > e.phase && e.hp > 0) {
      e.phase = ph;
      if (S.boss) S.boss.phase = ph;
      emit({ type: 'bossPhase', kind: e.kind, phase: ph });
      hitstop(0.1, true); shake(0.8);
    }
  }

  // ================================================================== combat helpers
  function cancelHaz(e, all) {
    if (e._haz) { if (all || e._haz.warn > 0) e._haz._dead = true; e._haz = null; }
    if (e._hazList) { for (const hz of e._hazList) hz._dead = true; e._hazList = null; }
  }
  function addHazard(type, o) {
    const hz = {
      id: nid(), type, x: o.x, z: o.z, r: o.r || 0,
      x2: o.x2 != null ? o.x2 : o.x, z2: o.z2 != null ? o.z2 : o.z, w: o.w || 0,
      hw: o.hw || 0, hd: o.hd || 0, a: o.a || 0,
      warn: o.warn, warnDur: o.warn, live: o.live, liveDur: o.live, src: o.src || 0, by: o.by || 'spark',
      a0: null, a1: null, len: 0,
      _dead: false, _live: false, _hitP: false,
    };
    if (S.hazards.length >= TUNE.cap.hazards) {
      for (const q of S.hazards) if (q.type === 'spark' && !q._dead) { q._dead = true; break; }
    }
    S.hazards.push(hz);
    emit({ type: 'hazardWarn', id: hz.id, hazard: type, hazardType: type, x: hz.x, z: hz.z, src: hz.src });
    return hz;
  }
  function addEshot(type, kind, x, z, o) {
    if (S.eshots.length >= TUNE.cap.eshots) {
      if (type !== 'wave' && type !== 'ring') return null;
      for (const s of S.eshots) if (!s._dead && s.type !== 'wave' && s.type !== 'ring') { s._dead = true; break; }
    }
    const s = {
      id: nid(), type, x, z, vx: o.vx || 0, vz: o.vz || 0, r: o.r || 0,
      R: o.R || 0, w: o.w || 0, a: o.a || 0, half: o.half || 0, gap: o.gap || null,
      t: 0, life: o.life, color: EEK[type] || '#ffffff', vR: o.vR || 0,
      _dead: false, _hit: false, _kind: kind,
    };
    S.eshots.push(s);
    return s;
  }
  function comboAdd() {
    S.combo++;
    G.comboT = TUNE.combo.window;
    if (S.combo > S.bestCombo) S.bestCombo = S.combo;
    let m = 1;
    const st = TUNE.combo.steps;
    for (let i = 0; i < st.length; i++) if (S.combo >= st[i]) m = i + 2;
    if (m > S.mult) { S.mult = m; emit({ type: 'combo', combo: S.combo, mult: m }); }
  }
  function comboBreak() {
    if (S.combo >= 10) emit({ type: 'comboBreak', combo: S.combo });
    S.combo = 0; S.mult = 1; G.comboT = 0;
  }
  function odGain(v) {
    const P = S.player;
    if (P.odT > 0) return;
    P.od = Math.min(1, P.od + v);
    if (P.od >= 1) {
      P.odT = TUNE.player.odDur; P.od = 1;
      emit({ type: 'overdrive', x: P.x, z: P.z });
      shake(0.5);
      recalcGun();
    }
  }
  function addGem(x, z, value) {
    x = clamp(x, ARENA.minX + 0.2, ARENA.maxX - 0.2); z = clamp(z, ARENA.minZ + 0.2, ARENA.maxZ - 0.2);
    // merge into a near gem when crowded (keeps the pickup count bounded)
    let nGems = 0, best = null, bd = 2.25;
    for (const o of S.pickups) {
      if (o.type !== 'gem' || o._dead) continue;
      nGems++;
      const dx = o.x - x, dz = o.z - z, d2 = dx * dx + dz * dz;
      if (d2 < bd) { bd = d2; best = o; }
    }
    if (nGems >= TUNE.cap.gems) {
      if (!best) { for (const o of S.pickups) if (o.type === 'gem' && !o._dead) { best = o; break; } }
      if (best) { best.value += value; best.t = Math.min(best.t, 2); return; }
    }
    S.pickups.push({ id: nid(), type: 'gem', pup: null, fam: null, x, z, t: 0, life: TUNE.gemLife, value, _dead: false, _pull: false });
  }
  function addHeart(x, z) {
    x = clamp(x, ARENA.minX + 0.4, ARENA.maxX - 0.4); z = clamp(z, ARENA.minZ + 0.4, ARENA.maxZ - 0.4);
    const tmp = { x, z }; collideWorld(tmp, 0.4, 0.4);
    const o = { id: nid(), type: 'heart', pup: null, fam: null, x: tmp.x, z: tmp.z, t: 0, life: TUNE.heart.life, value: 1, _dead: false, _pull: false };
    S.pickups.push(o);
    pickupEv('pickupSpawn', o);
  }
  // pickup lifecycle event. `type` is the event type, so the pickup's own type travels as
  // `pickup` (alias `pickupType`): 'orb' | 'heart'.
  function pickupEv(evType, o) {
    emit({ type: evType, id: o.id, pickup: o.type, pickupType: o.type, pup: o.pup, fam: o.fam, x: o.x, z: o.z });
  }
  function heal(n) {
    const P = S.player;
    const before = P.hp;
    P.hp = Math.min(P.maxHp, P.hp + n);
    if (P.hp > before) emit({ type: 'heal', hp: P.hp });
  }

  // enemy takes damage. Returns true if killed.
  function damage(e, dmg, crit, kx, kz, src) {
    if (!targetable(e)) return false;
    if (e.boss && e.kind === 'boss_flagship' && e.state === 'stun') { dmg *= TUNE.bosses.boss_flagship.fold.dmgMul; crit = true; }
    e.hp -= dmg; e.flash = 1;
    if (!e.boss && (kx || kz) && e.y < 0.3) {
      const kk = TUNE.kinds[e.kind].knock != null ? TUNE.kinds[e.kind].knock : 1;
      e._kx += kx * kk; e._kz += kz * kk;
    }
    const killed = e.hp <= 0;
    emit({ type: 'hit', id: e.id, kind: e.kind, x: e.x, y: e.y + e._h * 0.5, z: e.z, dmg: Math.round(dmg * 10) / 10, crit: !!crit, killed, src: src || 'bolt' });
    if (e.boss) {
      if (e.hp < 0) e.hp = 0;
      bossPhaseCheck(e);
      if (killed) bossDie(e);
    } else if (killed) killEnemy(e, false);
    return killed;
  }
  function killEnemy(e, silentSplit) {
    if (e._dead) return;
    e._dead = true; e.hp = 0;
    cancelHaz(e, false);
    if (e._parent) { e._parent._pods = Math.max(0, e._parent._pods - 1); e._parent = null; }
    S.kills++;
    comboAdd();
    const pts = Math.round(e._pts * S.mult * otMul());
    S.score += pts;
    // later hours kill faster, so each kill fills less: OVERDRIVE stays a moment (~every 20-30 s)
    odGain((e.elite ? TUNE.od.elite : TUNE.od.kill) / (1 + TUNE.od.hourDiv * Math.min(S.hour, 8)));
    if (e._xp > 0) addGem(e.x + rnd(-0.25, 0.25), e.z + rnd(-0.25, 0.25), e._xp);
    if (rand() < (e.elite ? TUNE.heart.eliteChance : TUNE.heart.chance)) addHeart(e.x, e.z);
    if (e.kind === 'xb10' && !silentSplit) {
      const n = TUNE.kinds.xb10.split;
      for (let i = 0; i < n; i++) spawnPodFrom(e, e.face + (i - (n - 1) / 2) * 2.1 + rnd(-0.3, 0.3), 1.3);
    }
    emit({ type: 'kill', id: e.id, kind: e.kind, x: e.x, y: e.y, z: e.z, face: e.face, elite: e.elite, points: pts, combo: S.combo, mult: S.mult });
    if (e.elite) { hitstop(0.035, false); shake(0.2); }
  }

  // ================================================================== player
  function recalcGun() {
    const P = S.player, TP = TUNE.player;
    const W = WEAPONS[Math.min(P.wTier, WEAPONS.length - 1)];
    const od = P.odT > 0;
    P.fireInt = Math.max(0.06, W.f * G.fireMul * (P.buffs.rapid > 0 ? TUNE.rapid.fire : 1) * (od ? TP.odFire : 1));
    P.bolts = W.m + G.multiBonus + (od ? TP.odBolts : 0);
    P.pierce = W.p + G.pierceBonus + (od ? TP.odPierce : 0);
    P.dmg = W.d + G.dmgBonus + (od ? TP.odDmg : 0);
    P._spread = W.sp || 0.13;
  }
  function hurt(by, sx, sz, how) {
    const P = S.player;
    if (!P.alive || (S.phase !== 'play' && S.phase !== 'overtime')) return false;
    if (P.inv > 0 || P.dashT > 0) return false;
    if (debug.god) { G.godHits++; P.inv = 0.4; return true; }
    if (P.buffs.shield > 0) {
      P.inv = Math.max(P.inv, 0.5);
      emit({ type: 'shieldBlock', x: P.x, z: P.z });
      shake(0.3);
      return true;
    }
    P.hp -= 1;
    P.inv = TUNE.player.hurtInv; P.hurtT = 1;
    G.hurtHour = true;
    comboBreak();
    const dx = P.x - sx, dz = P.z - sz, d = Math.sqrt(dx * dx + dz * dz);
    if (d > 1e-3) { G.vx += dx / d * TUNE.player.hurtKnock; G.vz += dz / d * TUNE.player.hurtKnock; }
    emit({ type: 'hurt', x: P.x, z: P.z, hp: P.hp, by, how: how || 'touch' });
    shake(0.55); hitstop(0.06, true);
    if (P.hp <= 0) die(by);
    return true;
  }
  function die(by) {
    const P = S.player;
    P.hp = 0; P.alive = false; P.firing = false; P.dashT = 0;
    S.phase = 'dead';
    G.killedBy = by;
    shake(1); hitstop(0.12, true);
    emit({ type: 'gameover', score: S.score, killedBy: by });
  }
  function startDash(mx, mz, ml) {
    const P = S.player, TP = TUNE.player;
    let dx, dz;
    if (ml > 0.2) { dx = mx / ml; dz = mz / ml; }
    else if (P.spd > 0.5) { dx = G.vx / P.spd; dz = G.vz / P.spd; }
    else { dx = Math.sin(P.face); dz = Math.cos(P.face); }
    G.dashDX = dx; G.dashDZ = dz; G.dashId++;
    P.dashT = TP.dashDur; P.dashCD = P.dashCDMax; P.inv = Math.max(P.inv, TP.dashInv);
    P.face = Math.atan2(dx, dz);
    G.dashBuf = 0;
    emit({ type: 'dash', x: P.x, z: P.z, a: P.face });
  }
  function firePulse() {
    const P = S.player, TP = TUNE.player;
    P.pulseCD = P.pulseCDMax; G.pulseBuf = 0;
    const r = TP.pulseR;
    emit({ type: 'pulse', x: P.x, z: P.z, r });
    shake(0.4);
    const hm = hpMul();
    const list = S.enemies;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!targetable(e)) continue;
      const dx = e.x - P.x, dz = e.z - P.z, d = Math.sqrt(dx * dx + dz * dz) || 1e-3;
      if (d > r + e.r) continue;
      const nx = dx / d, nz = dz / d, k = TP.pulseKnock * Math.max(0, 1 - d / (r + e.r)) + 2.5;
      const killed = damage(e, (e.boss ? TP.pulseBossDmg : TP.pulseDmg) * hm, false, nx * k, nz * k, 'pulse');
      if (!killed && !e.boss && e.y < 0.3 && e.state !== 'spawn') {
        cancelHaz(e, false);
        setSt(e, 'stun', TP.pulseStun);
      }
    }
    for (const s of S.eshots) {
      if (s._dead || s.type === 'wave' || s.type === 'ring') continue;
      const dx = s.x - P.x, dz = s.z - P.z;
      if (dx * dx + dz * dz < r * r) s._dead = true;
    }
  }
  function tierAir() {
    const P = S.player, A = TUNE.player.tierAir;
    P.inv = Math.max(P.inv, A.inv);
    for (const e of S.enemies) {
      if (!targetable(e) || e.boss || e.y > 0.3) continue;
      const dx = e.x - P.x, dz = e.z - P.z, d = Math.sqrt(dx * dx + dz * dz) || 1e-3;
      if (d < A.push) {
        const k = (A.push + 0.6 - d) / d;
        e.x += dx * k; e.z += dz * k;
        collideEnemy(e);
        if (e.state === 'windup') { cancelHaz(e, false); setSt(e, 'move', 1); e._cd = Math.max(e._cd, 1.0); }
      }
    }
    for (const s of S.eshots) {
      if (s._dead || s.type === 'wave' || s.type === 'ring') continue;
      const dx = s.x - P.x, dz = s.z - P.z;
      if (dx * dx + dz * dz < A.push * A.push) s._dead = true;
    }
  }
  function checkTier() {
    const P = S.player;
    let guard = 0;
    while (P.xp >= P.xpNext && guard++ < 20) {
      P.xp -= P.xpNext;
      if (P.wTier < WEAPONS.length - 1) {
        P.wTier++;
        P.wName = WEAPONS[P.wTier].n;
        P.xpNext = P.wTier < TUNE.xp.length ? TUNE.xp[P.wTier] : TUNE.xpOverflow;
        recalcGun();
        emit({ type: 'tierUp', tier: P.wTier, name: P.wName });
        shake(0.3);
        tierAir();
      } else {
        P.xpNext = TUNE.xpOverflow;
        if (P.hp < P.maxHp) heal(1);
        else {
          const b = Math.round(TUNE.score.overflow * otMul());
          S.score += b;
          emit({ type: 'bonus', label: 'MAX POWER', points: b });
        }
      }
    }
  }

  function updatePlayer(h, inp, allowActions) {
    const P = S.player, TP = TUNE.player;
    let mx = +inp.mx || 0, mz = +inp.mz || 0;
    if (!(mx === mx) || !isFinite(mx)) mx = 0;
    if (!(mz === mz) || !isFinite(mz)) mz = 0;
    let ml = Math.sqrt(mx * mx + mz * mz);
    if (ml > 1) { mx /= ml; mz /= ml; ml = 1; }
    if (ml < 0.05) { mx = 0; mz = 0; ml = 0; }
    if (allowActions) {
      if (G.dashBuf > 0 && P.dashCD <= 0 && P.dashT <= 0) startDash(mx, mz, ml);
      if (G.pulseBuf > 0 && P.pulseCD <= 0) firePulse();
    }
    const spdMax = TP.speed * G.speedMul * (P.odT > 0 ? TP.odSpeed : 1) * (P.buffs.rapid > 0 ? TUNE.rapid.speed : 1);
    const ox = P.x, oz = P.z;
    if (P.dashT > 0) {
      G.vx = G.dashDX * TP.dashSpeed; G.vz = G.dashDZ * TP.dashSpeed;
      P.dashT -= h;
      if (P.dashT <= 0) { P.dashT = 0; G.vx = G.dashDX * spdMax; G.vz = G.dashDZ * spdMax; }
    } else {
      const k = 1 - Math.exp(-h / (ml > 0 ? TP.accelTau : TP.decelTau));
      G.vx += (mx * spdMax - G.vx) * k; G.vz += (mz * spdMax - G.vz) * k;
      if (ml === 0 && G.vx * G.vx + G.vz * G.vz < 0.0025) { G.vx = 0; G.vz = 0; }
    }
    P.x += G.vx * h; P.z += G.vz * h;
    if (collidePlayer(P)) {
      // slide: keep only the displacement that actually happened
      G.vx = (P.x - ox) / h; G.vz = (P.z - oz) / h;
    }
    const sp = Math.sqrt(G.vx * G.vx + G.vz * G.vz);
    P.spd = sp; P.moving = sp > 0.35; P.vx = G.vx; P.vz = G.vz;
    if (sp > 0.3 && P.dashT <= 0) P.face = turnTo(P.face, Math.atan2(G.vx, G.vz), TP.turnRate * h);
    // dash shreds whatever it passes through
    if (P.dashT > 0) {
      const hm = hpMul();
      const list = S.enemies;
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (!targetable(e) || e._lastDash === G.dashId || e.y > 1.2) continue;
        const dx = e.x - P.x, dz = e.z - P.z, rr = e.r + TP.dashReach;
        if (dx * dx + dz * dz > rr * rr) continue;
        e._lastDash = G.dashId;
        emit({ type: 'dashHit', id: e.id, x: e.x, z: e.z });
        damage(e, (e.boss ? TP.dashBossDmg : TP.dashDmg) * hm, false, G.dashDX * 2.5, G.dashDZ * 2.5, 'dash');
      }
    }
  }

  function findTarget() {
    const P = S.player, R = TUNE.gun.range, fb = TUNE.gun.faceBias;
    const fx = Math.sin(P.face), fz = Math.cos(P.face);
    let best = null, bs = 1e9;
    const list = S.enemies;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!targetable(e) || e.y > 2.6) continue;
      const dx = e.x - P.x, dz = e.z - P.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      const de = d - e.r;
      if (de > R) continue;
      const dot = d > 1e-3 ? (dx * fx + dz * fz) / d : 1;
      let sc = Math.max(0.1, de) * (1 - fb * dot);
      if (KIOSK && d > 1.5 && !los(P.x, P.z, e.x, e.z)) sc += 3;
      if (sc < bs) { bs = sc; best = e; }
    }
    return best;
  }
  function updateGun(h) {
    const P = S.player, Gn = TUNE.gun;
    G.fireT -= h;
    const tg = findTarget();
    if (tg) {
      const a = Math.atan2(tg.x - P.x, tg.z - P.z);
      P.aim = turnTo(P.aim, a, 30 * h);
      if (G.fireT <= 0) {
        G.fireT = P.fireInt;
        const n = P.bolts, sp = P._spread;
        const big = P.odT > 0;
        for (let i = 0; i < n; i++) {
          if (S.pshots.length >= TUNE.cap.pshots) break;
          const aa = a + (i - (n - 1) / 2) * sp;
          const sx = Math.sin(aa), sz = Math.cos(aa);
          S.pshots.push({
            id: nid(), x: P.x + sx * 0.35, z: P.z + sz * 0.35, vx: sx * Gn.speed, vz: sz * Gn.speed,
            tier: P.wTier, pierce: P.pierce, big, _life: Gn.life, _dead: false, _hits: null, _dmg: P.dmg,
          });
        }
        P.firing = true;
        emit({ type: 'shot', x: P.x, z: P.z, a, tier: P.wTier, count: n });
      }
    } else {
      P.aim = turnTo(P.aim, P.face, 8 * h);
      if (G.fireT < 0) G.fireT = 0;
    }
  }

  // ================================================================== enemy AI
  const AIS = new Float64Array(4);   // per-enemy inputs to the ai* functions: h, dx, dz, d
  // Attack tokens: at most N enemies of a kind may be winding up / attacking at once, so late-game
  // crowds never turn into unreadable crossfire. Counted at the start of every enemy pass.
  const KIND_IDX = {}; ENEMY_KINDS.forEach((k, i) => { KIND_IDX[k] = i; });
  const ATK = new Int32Array(ENEMY_KINDS.length);
  const TOK = new Int32Array(ENEMY_KINDS.length);
  ENEMY_KINDS.forEach((k, i) => { TOK[i] = (TUNE.kinds[k] && TUNE.kinds[k].tokens) || 99; });
  function tokenFree(e) {
    const i = KIND_IDX[e.kind];
    if (ATK[i] >= TOK[i]) { e._cd = 0.25 + rand() * 0.5; return false; }
    ATK[i]++;
    return true;
  }
  const AV = new Float64Array(6);   // in: dx, dz, px, pz, h   out: AV[0], AV[1]
  // Steering round fixtures: strip the component heading into a nearby fixture and slide along
  // it. The go-round side is chosen ONCE per obstacle contact (nearer end, biased toward the
  // fox) and latched until the enemy has been clear for 0.6 s — so it never dithers behind a table.
  function avoid(e) {
    let dx = AV[0], dz = AV[1];
    const px = AV[2], pz = AV[3], h = AV[4];
    const pl = Math.sqrt(px * px + pz * pz) || 1;
    const fr = e.boss ? 0.9 : 1;
    let blocked = false;
    for (let i = 0; i < FX.length; i++) {
      const f = FX[i];
      let nx, nz, gap;
      if (f.box) {
        const qx = clamp(e.x, f.x - f.hw, f.x + f.hw), qz = clamp(e.z, f.z - f.hd, f.z + f.hd);
        nx = e.x - qx; nz = e.z - qz;
        const d = Math.sqrt(nx * nx + nz * nz);
        if (d < 1e-6) continue;
        nx /= d; nz /= d; gap = d - e.r * fr;
      } else {
        nx = e.x - f.x; nz = e.z - f.z;
        const d = Math.sqrt(nx * nx + nz * nz);
        if (d < 1e-6) continue;
        nx /= d; nz /= d; gap = d - f.r - e.r * fr;
      }
      if (gap > 0.8) continue;
      const into = dx * nx + dz * nz;
      if (into >= 0) continue;
      blocked = true;
      const w = 1 - Math.max(0, gap) / 0.8;
      dx -= nx * into * w; dz -= nz * into * w;
      const tx = -nz, tz = nx;
      if (!e._avSide || e._avF !== i || e._avAge > 2) {
        e._avF = i; e._avAge = 0;
        const ext = f.box ? (Math.abs(tx) > 0.5 ? f.hw : f.hd) : f.r;
        const off = (tx * (e.x - f.x) + tz * (e.z - f.z)) / ext;
        const sc = off + 1.2 * (tx * px + tz * pz) / pl;
        e._avSide = Math.abs(sc) > 0.05 ? (sc > 0 ? 1 : -1) : e._dir;
      }
      dx += tx * e._avSide * 0.85 * w; dz += tz * e._avSide * 0.85 * w;
    }
    if (blocked) { e._avT = 0.6; e._avAge += h; }
    else if (e._avSide) { e._avT -= h; if (e._avT <= 0) e._avSide = 0; }
    const l = Math.sqrt(dx * dx + dz * dz) || 1;
    AV[0] = dx / l; AV[1] = dz / l;
  }
  // move along (dx,dz) at `speed`; faceA = NaN => face the movement
  function walk(e, h, dx, dz, speed, faceA) {
    const l = Math.sqrt(dx * dx + dz * dz);
    if (l < 1e-6 || speed <= 0) { e.spd = 0; if (faceA === faceA) e.face = turnTo(e.face, faceA, 8 * h); return; }
    const P = S.player;
    AV[0] = dx / l; AV[1] = dz / l; AV[2] = P.x - e.x; AV[3] = P.z - e.z; AV[4] = h;
    avoid(e);
    const ax = AV[0], az = AV[1];
    e.x += ax * speed * h; e.z += az * speed * h;
    e.spd = speed; e._want = speed * h;
    e.face = turnTo(e.face, faceA === faceA ? faceA : Math.atan2(ax, az), 10 * h);
  }
  function startWindup(e, name, dur) {
    e.attack = name;
    setSt(e, 'windup', dur);
    e.spd = 0;
    emit({ type: 'windup', id: e.id, kind: e.kind, attack: name, x: e.x, z: e.z });
  }
  function emitAttack(e) { emit({ type: 'attack', id: e.id, kind: e.kind, attack: e.attack, x: e.x, z: e.z }); }
  function tailRecover(e, K) {
    e.spd = 0;
    if (e.stateT >= e.stateDur) { setSt(e, 'move', 1); if (e._cd < 0.3) e._cd = K.cd ? rnd(K.cd[0], K.cd[1]) : 1; }
  }
  // keep-distance strafing movement (xb8 / galaxy / xb10)
  function strafe(e, lo, hi, speed) {
    const h = AIS[0], dx = AIS[1], dz = AIS[2], d = AIS[3];
    e._flipT -= h;
    if (e._flipT <= 0) { e._flipT = rnd(2, 4); e._dir = -e._dir; }
    const want = d < lo ? -1 : d > hi ? 1 : 0;
    const ux = dx / d, uz = dz / d;
    const px = -uz * e._dir, pz = ux * e._dir;
    let mx = ux * want + px * 0.7, mz = uz * want + pz * 0.7;
    // near a wall: flip strafe direction
    const nx = e.x + mx * 0.8, nz = e.z + mz * 0.8;
    if (nx < ARENA.minX + 0.4 || nx > ARENA.maxX - 0.4 || nz < ARENA.minZ + 0.4 || nz > ARENA.maxZ - 0.4) {
      e._dir = -e._dir; e._flipT = rnd(2, 4);
    }
    walk(e, h, mx, mz, speed * (want === 0 ? 0.7 : 1), Math.atan2(dx, dz));
  }

  function aiGrunt(e) {
    const h = AIS[0], dx = AIS[1], dz = AIS[2], d = AIS[3]; // xb6: hops at you in packs (flanking offsets per pack slot)
    const K = TUNE.kinds.xb6;
    if (e.state !== 'move') { tailRecover(e, K); return; }
    let tx = dx, tz = dz;
    if (e._slot && d > 2.6) { tx += (-dz / d) * e._slot * K.flank; tz += (dx / d) * e._slot * K.flank; }
    e._ph += h * K.hopHz * TAU;
    const s = Math.sin(e._ph);
    walk(e, h, tx, tz, K.speed * e._sm * (0.8 + 0.4 * (s > 0 ? s : 0)), NaN);
  }
  function aiPod(e) {
    const h = AIS[0], dx = AIS[1], dz = AIS[2], d = AIS[3];
    const K = TUNE.kinds.pod;
    if (e.state !== 'move') { tailRecover(e, K); return; }
    const a = Math.atan2(dx, dz) + Math.sin(S.t * 5.5 + e._ph) * K.weave * Math.min(1, d / 3);
    walk(e, h, Math.sin(a), Math.cos(a), K.speed * e._sm, NaN);
  }
  function aiTank(e) {
    const h = AIS[0], dx = AIS[1], dz = AIS[2], d = AIS[3]; // xb3: slow; stomp -> shock ring
    const K = TUNE.kinds.xb3;
    switch (e.state) {
      case 'move':
        if (e._cd <= 0 && d < K.range + e.r && tokenFree(e)) {
          startWindup(e, 'stomp', K.windup);
          e._haz = addHazard('shock', { x: e.x, z: e.z, r: K.stompR * (e.elite ? 1.2 : 1), warn: K.windup, live: K.live, src: e.id, by: e.kind });
        } else walk(e, h, dx, dz, K.speed * e._sm, NaN);
        break;
      case 'windup':
        e.spd = 0;
        if (e.stateT >= e.stateDur) { setSt(e, 'attack', K.live + 0.08); emitAttack(e); shake(0.2); }
        break;
      case 'attack':
        if (e.stateT >= e.stateDur) { e._haz = null; setSt(e, 'recover', K.recover); e._cd = rnd(K.cd[0], K.cd[1]); }
        break;
      default: tailRecover(e, K);
    }
  }
  function aiCharger(e) {
    const h = AIS[0], dx = AIS[1], dz = AIS[2], d = AIS[3]; // xb7
    const K = TUNE.kinds.xb7;
    switch (e.state) {
      case 'move':
        if (e._cd <= 0 && d > K.minR && d < K.maxR && los(e.x, e.z, S.player.x, S.player.z) && tokenFree(e)) {
          startWindup(e, 'charge', K.windup);
          e._a = Math.atan2(dx, dz);
        } else walk(e, h, dx, dz, K.speed * e._sm, NaN);
        break;
      case 'windup':
        e.spd = 0;
        if (e.stateT < e.stateDur - K.lock) e._a = turnTo(e._a, Math.atan2(dx, dz), K.track * h);
        e.face = e._a;
        if (e.stateT >= e.stateDur) { setSt(e, 'attack', K.dur); emitAttack(e); }
        break;
      case 'attack': {
        const sp = K.charge * (e.elite ? 1.05 : 1);
        e.x += Math.sin(e._a) * sp * h; e.z += Math.cos(e._a) * sp * h;
        e.spd = sp; e.face = e._a;
        if (collideEnemy(e)) { setSt(e, 'stun', K.stun); e.spd = 0; e._cd = rnd(K.cd[0], K.cd[1]) + K.stun; shake(0.15); }
        else if (e.stateT >= e.stateDur) { setSt(e, 'recover', K.recover); e._cd = rnd(K.cd[0], K.cd[1]); }
        break;
      }
      default: tailRecover(e, K);
    }
  }
  function aiBroadcaster(e) {
    const h = AIS[0], dx = AIS[1], dz = AIS[2], d = AIS[3]; // xb8: keeps distance, Wi-Fi wave arcs
    const K = TUNE.kinds.xb8;
    switch (e.state) {
      case 'move':
        if (e._cd <= 0 && d < K.fireR && tokenFree(e)) { startWindup(e, 'wave', K.windup); e._a = Math.atan2(dx, dz); }
        else strafe(e, K.keep[0], K.keep[1], K.speed * e._sm);
        break;
      case 'windup':
        e.spd = 0;
        if (e.stateT < e.stateDur - K.lock) e._a = turnTo(e._a, Math.atan2(dx, dz), 6 * h);
        e.face = e._a;
        if (e.stateT >= e.stateDur) {
          setSt(e, 'attack', 0.2); emitAttack(e);
          addEshot('wave', e.kind, e.x, e.z, { R: e.r + 0.2, vR: K.waveSpd, a: e._a, half: K.half * (e.elite ? 1.2 : 1), w: K.w, life: K.waveLife });
          emit({ type: 'enemyShot', kind: e.kind, shotType: 'wave', x: e.x, z: e.z });
        }
        break;
      case 'attack':
        if (e.stateT >= e.stateDur) { setSt(e, 'recover', K.recover); e._cd = rnd(K.cd[0], K.cd[1]); }
        break;
      default: tailRecover(e, K);
    }
  }
  function aiCommander(e) {
    const h = AIS[0], dx = AIS[1], dz = AIS[2], d = AIS[3]; // xb10: deploys pods
    const K = TUNE.kinds.xb10;
    switch (e.state) {
      case 'move':
        if (e._cd <= 0 && e._pods < K.maxPods && d < 11 && S.enemies.length < TUNE.cap.enemies - 2 && tokenFree(e)) startWindup(e, 'deploy', K.windup);
        else strafe(e, K.keep - 1, K.keep + 1, K.speed * e._sm);
        break;
      case 'windup':
        e.spd = 0; e.face = turnTo(e.face, Math.atan2(dx, dz), 6 * h);
        if (e.stateT >= e.stateDur) {
          setSt(e, 'attack', 0.3); emitAttack(e);
          for (let i = 0; i < K.pods; i++) {
            const p = spawnPodFrom(e, e.face + (i === 0 ? -0.9 : 0.9), 1.5);
            if (p) e._pods++;
          }
        }
        break;
      case 'attack':
        if (e.stateT >= e.stateDur) { setSt(e, 'recover', K.recover); e._cd = rnd(K.cd[0], K.cd[1]); }
        break;
      default: tailRecover(e, K);
    }
  }
  function aiFlipper(e) {
    const h = AIS[0], dx = AIS[1], dz = AIS[2], d = AIS[3]; // iphone: crouch -> parabolic flip onto your spot
    const K = TUNE.kinds.iphone;
    const P = S.player;
    switch (e.state) {
      case 'move':
        if (e._cd <= 0 && d > K.minR && d < K.maxR && los(e.x, e.z, P.x, P.z) && tokenFree(e)) startWindup(e, 'leap', K.windup);
        else walk(e, h, dx, dz, K.speed * e._sm, NaN);
        break;
      case 'windup':
        e.spd = 0; e.face = turnTo(e.face, Math.atan2(dx, dz), 8 * h);
        if (e.stateT >= e.stateDur) {
          const tmp = { x: P.x + P.vx * K.lead, z: P.z + P.vz * K.lead };
          collideWorld(tmp, e.r, 0.1);
          e._sx = e.x; e._sz = e.z; e._tx = tmp.x; e._tz = tmp.z;
          e.face = Math.atan2(tmp.x - e.x, tmp.z - e.z);
          setSt(e, 'attack', K.dur); emitAttack(e);
          e._haz = addHazard('slam', { x: tmp.x, z: tmp.z, r: K.slamR, warn: K.dur, live: K.live, src: e.id, by: e.kind });
        }
        break;
      case 'attack': {
        const u = Math.min(1, e.stateT / e.stateDur);
        e.x = e._sx + (e._tx - e._sx) * u; e.z = e._sz + (e._tz - e._sz) * u;
        e.y = 4 * K.apex * u * (1 - u);
        const ddx = e._tx - e._sx, ddz = e._tz - e._sz;
        e.spd = Math.sqrt(ddx * ddx + ddz * ddz) / e.stateDur;
        if (u >= 1) { e.y = 0; e._haz = null; setSt(e, 'recover', K.recover); e._cd = rnd(K.cd[0], K.cd[1]); shake(0.12); }
        break;
      }
      default: tailRecover(e, K);
    }
  }
  function aiSniper(e) {
    const h = AIS[0], dx = AIS[1], dz = AIS[2], d = AIS[3]; // galaxy: laser sight tracks, locks, fires
    const K = TUNE.kinds.galaxy;
    const P = S.player;
    switch (e.state) {
      case 'move':
        if (e._cd <= 0 && d < K.fireR && los(e.x, e.z, P.x, P.z) && tokenFree(e)) {
          startWindup(e, 'snipe', K.windup);
          e._a = Math.atan2(dx, dz);
          const be = beamEnd(e.x, e.z, e._a, K.len);
          e._haz = addHazard('beam', { x: e.x, z: e.z, x2: be.x, z2: be.z, w: K.w, warn: K.windup, live: K.live, src: e.id, by: e.kind });
        } else strafe(e, K.keep[0], K.keep[1], K.speed * e._sm);
        break;
      case 'windup': {
        e.spd = 0;
        if (e.stateT < e.stateDur - K.lock) e._a = turnTo(e._a, Math.atan2(dx, dz), K.track * h);
        e.face = e._a;
        const hz = e._haz;
        if (hz && !hz._dead) { const be = beamEnd(e.x, e.z, e._a, K.len); hz.x = e.x; hz.z = e.z; hz.x2 = be.x; hz.z2 = be.z; }
        if (e.stateT >= e.stateDur) {
          setSt(e, 'attack', K.live + 0.1); emitAttack(e);
          emit({ type: 'enemyShot', kind: e.kind, shotType: 'beam', x: e.x, z: e.z });
        }
        break;
      }
      case 'attack':
        e.spd = 0;
        if (e.stateT >= e.stateDur) { e._haz = null; setSt(e, 'recover', K.recover); e._cd = rnd(K.cd[0], K.cd[1]); }
        break;
      default: tailRecover(e, K);
    }
  }
  function aiChomper(e) {
    const h = AIS[0], dx = AIS[1], dz = AIS[2], d = AIS[3]; // fold: opens (windup) then lunge-bites
    const K = TUNE.kinds.fold;
    const P = S.player;
    switch (e.state) {
      case 'move':
        if (e._cd <= 0 && d < K.range + e.r && tokenFree(e)) { startWindup(e, 'chomp', K.windup); e._a = Math.atan2(dx, dz); }
        else walk(e, h, dx, dz, K.speed * e._sm, NaN);
        break;
      case 'windup':
        e.spd = 0;
        if (e.stateT < e.stateDur - K.lock) e._a = turnTo(e._a, Math.atan2(dx, dz), 7 * h);
        e.face = e._a;
        if (e.stateT >= e.stateDur) { setSt(e, 'attack', K.dur); emitAttack(e); e._hitP = false; }
        break;
      case 'attack': {
        e.x += Math.sin(e._a) * K.lunge * h; e.z += Math.cos(e._a) * K.lunge * h;
        e.spd = K.lunge; e.face = e._a;
        collideEnemy(e);
        if (!e._hitP) {
          const rx = P.x - e.x, rz = P.z - e.z, rd = Math.sqrt(rx * rx + rz * rz);
          if (rd < e.r + K.reach && Math.abs(wrapA(Math.atan2(rx, rz) - e._a)) < K.cone) {
            if (hurt(e.kind, e.x, e.z, 'chomp')) e._hitP = true;
          }
        }
        if (e.stateT >= e.stateDur) { setSt(e, 'recover', K.recover); e._cd = rnd(K.cd[0], K.cd[1]); }
        break;
      }
      default: tailRecover(e, K);
    }
  }

  // ------------------------------------------------------------------ bosses
  function bossPick(e, B) {
    const bag = B.bag[e.phase - 1];
    let a = null;
    for (let i = 0; i < 8; i++) {
      a = bag[Math.floor(rand() * bag.length)];
      if (a === e._last && i < 7) continue;
      if (a === 'summon' && S.enemies.length > TUNE.cap.enemies - 8) continue;
      break;
    }
    if (a === 'summon' && S.enemies.length > TUNE.cap.enemies - 8) a = bag[0];
    e._last = a;
    return a;
  }
  function bossSummonModems(e, pods, grunts) {
    let n = 0;
    for (let i = 0; i < grunts; i++) { const p = pickOK(MODEM_PERCHES) || pickOK(DOOR_PERCHES); if (p && S.enemies.length < TUNE.cap.enemies) { spawnFromPerch('xb6', p, false, 0, 0); n++; } }
    for (let i = 0; i < pods; i++) {
      if (S.enemies.length >= TUNE.cap.enemies) break;
      const p = pickOK(MODEM_PERCHES);
      if (p) spawnFromPerch('pod', p, false, 0, 0);
      else spawnPodFrom(e, e.face + (i - (pods - 1) / 2) * (TAU / Math.max(pods, 1)), 2.2);
    }
    return n;
  }
  function bossSummonPhones(nI, nG) {
    for (let i = 0; i < nI + nG; i++) {
      const p = pickOK(PHONE_PERCHES) || pickOK(DOOR_PERCHES);
      if (!p || S.enemies.length >= TUNE.cap.enemies) break;
      spawnFromPerch(i < nI ? 'iphone' : 'galaxy', p, false, 0, 0);
    }
  }
  function updGateway(e, h) {
    const B = TUNE.bosses.boss_gateway, ph = e.phase, P = S.player;
    const dx = P.x - e.x, dz = P.z - e.z, d = Math.sqrt(dx * dx + dz * dz) || 1e-3;
    const ang = Math.atan2(dx, dz);
    switch (e.state) {
      case 'move':
        if (d > B.keep + e.r) walk(e, h, dx, dz, B.speed[ph - 1], ang);
        else { e.spd = 0; e.face = turnTo(e.face, ang, 3 * h); }
        if (e._cd <= 0) {
          const a = bossPick(e, B);
          startWindup(e, a, B.windup[a]);
          if (a === 'spin') {
            const Sp = B.spin;
            e._a = rand() * TAU; e._spinDir = rand() < 0.5 ? -1 : 1;
            e._hazList = [];
            const nb = Sp.beams[ph - 1];
            for (let k = 0; k < nb; k++) {
              const be = beamEnd(e.x, e.z, e._a + k * TAU / nb, Sp.len);
              e._hazList.push(addHazard('beam', { x: e.x, z: e.z, x2: be.x, z2: be.z, w: Sp.w, warn: B.windup.spin, live: Sp.dur[ph - 1], src: e.id, by: e.kind }));
            }
          }
        }
        break;
      case 'windup':
        e.spd = 0;
        if (e.attack !== 'spin') e.face = turnTo(e.face, ang, 4 * h);
        if (e.stateT >= e.stateDur) {
          const a = e.attack;
          if (a === 'rings') {
            const R = B.rings;
            setSt(e, 'attack', R.count[ph - 1] * R.spacing + 0.1);
            e._n = 0; e._nt = 0; e._a = ang + rnd(-R.gapJit, R.gapJit); e._spinDir = rand() < 0.5 ? -1 : 1;
          } else if (a === 'slam') {
            const Sl = B.slam;
            const tmp = { x: P.x + P.vx * Sl.lead, z: P.z + P.vz * Sl.lead };
            collideWorld(tmp, e.r * 0.9, 0.3);
            e._sx = e.x; e._sz = e.z; e._tx = tmp.x; e._tz = tmp.z;
            setSt(e, 'attack', Sl.dur[ph - 1]);
            e._haz = addHazard('slam', { x: tmp.x, z: tmp.z, r: Sl.r, warn: Sl.dur[ph - 1], live: Sl.live, src: e.id, by: e.kind });
          } else if (a === 'summon') {
            setSt(e, 'attack', 0.6);
            bossSummonModems(e, B.summon.pods[ph - 1], B.summon.xb6[ph - 1]);
          } else if (a === 'spin') {
            setSt(e, 'attack', B.spin.dur[ph - 1]);
          }
          emitAttack(e);
        }
        break;
      case 'attack': {
        const a = e.attack;
        e.spd = 0;
        if (a === 'rings') {
          const R = B.rings;
          e._nt -= h;
          if (e._nt <= 0 && e._n < R.count[ph - 1]) {
            e._nt += R.spacing;
            const sp = R.speed[ph - 1];
            const gapA = e._a + e._n * e._spinDir * rnd(0.45, 0.75);
            addEshot('ring', e.kind, e.x, e.z, { R: e.r * 0.8, vR: sp, w: R.w, gap: { a: wrapA(gapA), half: R.gapHalf }, life: R.reach / sp });
            emit({ type: 'enemyShot', kind: e.kind, shotType: 'ring', x: e.x, z: e.z });
            e._n++;
          }
          if (e.stateT >= e.stateDur) { setSt(e, 'recover', 0.5); }
        } else if (a === 'slam') {
          const Sl = B.slam;
          const u = Math.min(1, e.stateT / e.stateDur);
          e.x = e._sx + (e._tx - e._sx) * u; e.z = e._sz + (e._tz - e._sz) * u;
          e.y = 4 * Sl.apex * u * (1 - u);
          e.face = turnTo(e.face, Math.atan2(e._tx - e._sx, e._tz - e._sz), 6 * h);
          const ddx = e._tx - e._sx, ddz = e._tz - e._sz;
          e.spd = Math.sqrt(ddx * ddx + ddz * ddz) / e.stateDur;
          if (u >= 1) {
            e.y = 0; e._haz = null;
            shake(0.75); hitstop(0.07, false);
            const n = Sl.orbs[ph - 1];
            if (n > 0) {
              const off = rand() * TAU;
              for (let k = 0; k < n; k++) {
                const aa = off + k * TAU / n;
                addEshot('orb', e.kind, e.x + Math.sin(aa) * e.r, e.z + Math.cos(aa) * e.r, { vx: Math.sin(aa) * Sl.orbSpd, vz: Math.cos(aa) * Sl.orbSpd, r: 0.24, life: 3.2 });
              }
              emit({ type: 'enemyShot', kind: e.kind, shotType: 'orb', x: e.x, z: e.z });
            }
            setSt(e, 'recover', Sl.recover);
          }
        } else if (a === 'spin') {
          const Sp = B.spin;
          if (e._hazList && e._hazList.length && e._hazList[0].warn <= 0) e._a += e._spinDir * Sp.speed[ph - 1] * h;
          if (e._hazList) {
            for (let k = 0; k < e._hazList.length; k++) {
              const hz = e._hazList[k];
              const be = beamEnd(e.x, e.z, e._a + k * TAU / e._hazList.length, Sp.len);
              hz.x = e.x; hz.z = e.z; hz.x2 = be.x; hz.z2 = be.z;
            }
          }
          if (e.stateT >= e.stateDur) { e._hazList = null; setSt(e, 'recover', 0.6); }
        } else if (e.stateT >= e.stateDur) setSt(e, 'recover', 0.4);
        break;
      }
      case 'recover':
      case 'stun':
        e.spd = 0;
        if (e.stateT >= e.stateDur) { setSt(e, 'move', 1); e._cd = B.gap[ph - 1]; }
        break;
    }
  }
  function updFlagship(e, h) {
    const B = TUNE.bosses.boss_flagship, ph = e.phase, P = S.player;
    const dx = P.x - e.x, dz = P.z - e.z, d = Math.sqrt(dx * dx + dz * dz) || 1e-3;
    const ang = Math.atan2(dx, dz);
    switch (e.state) {
      case 'move':
        AIS[0] = h; AIS[1] = dx; AIS[2] = dz; AIS[3] = d;
        strafe(e, B.keep[0] + e.r * 0.5, B.keep[1] + e.r * 0.5, B.speed[ph - 1]);
        if (e._cd <= 0) {
          const a = bossPick(e, B);
          startWindup(e, a, B.windup[a]);
          if (a === 'sweep') {
            const Sw = B.sweep, dir = rand() < 0.5 ? -1 : 1;
            e._a0 = ang - dir * Sw.arc / 2; e._a1 = ang + dir * Sw.arc / 2; e._a = e._a0;
            const be = beamEnd(e.x, e.z, e._a0, Sw.len);
            e._haz = addHazard('beam', { x: e.x, z: e.z, x2: be.x, z2: be.z, w: Sw.w, warn: B.windup.sweep, live: Sw.dur[ph - 1], src: e.id, by: e.kind });
            e._haz.a0 = e._a0; e._haz.a1 = e._a1; e._haz.len = Sw.len;
            e.face = ang;
          } else if (a === 'fold') {
            const F = B.fold;
            e._a = ang; e.face = ang;
            const off = e.r * 0.6 + F.hd;
            e._haz = addHazard('fold', { x: e.x + Math.sin(ang) * off, z: e.z + Math.cos(ang) * off, hw: F.hw, hd: F.hd, a: ang, warn: B.windup.fold, live: F.live, src: e.id, by: e.kind });
          }
        }
        break;
      case 'windup':
        e.spd = 0;
        if (e.attack === 'spray' || e.attack === 'summon' || e.attack === 'bolt') e.face = turnTo(e.face, ang, 4 * h);
        if (e.stateT >= e.stateDur) {
          const a = e.attack;
          if (a === 'spray') {
            const Sp = B.spray;
            e._variant = ph >= 2 && rand() < 0.5 ? 1 : 0;
            e._nt = 0; e._n = 0; e._a = ang; e._spinDir = rand() < 0.5 ? -1 : 1;
            setSt(e, 'attack', Sp.dur[ph - 1]);
          } else if (a === 'sweep') {
            setSt(e, 'attack', B.sweep.dur[ph - 1]);
            emit({ type: 'enemyShot', kind: e.kind, shotType: 'beam', x: e.x, z: e.z });
          } else if (a === 'summon') {
            setSt(e, 'attack', 0.6);
            bossSummonPhones(B.summon.iphone[ph - 1], B.summon.galaxy[ph - 1]);
          } else if (a === 'fold') {
            setSt(e, 'attack', 0.3);
            e._haz = null;
            shake(0.8); hitstop(0.08, false);
          } else if (a === 'bolt') {
            e._n = 0; e._nt = 0;
            setSt(e, 'attack', B.bolt.volleys * B.bolt.every + 0.1);
          }
          emitAttack(e);
        }
        break;
      case 'attack': {
        const a = e.attack;
        e.spd = 0;
        if (a === 'spray') {
          const Sp = B.spray;
          e._nt -= h;
          if (e._variant === 0) {
            e._a += e._spinDir * Sp.spin[ph - 1] * h;
            if (e._nt <= 0) {
              e._nt += Sp.every[ph - 1];
              const arms = Sp.arms[ph - 1], sp = Sp.speed[ph - 1];
              for (let k = 0; k < arms; k++) {
                const aa = e._a + k * TAU / arms;
                addEshot('notif', e.kind, e.x + Math.sin(aa) * e.r * 0.7, e.z + Math.cos(aa) * e.r * 0.7, { vx: Math.sin(aa) * sp, vz: Math.cos(aa) * sp, r: Sp.r, life: Sp.life });
              }
              if ((e._n++ & 1) === 0) emit({ type: 'enemyShot', kind: e.kind, shotType: 'notif', x: e.x, z: e.z });
            }
          } else if (e._nt <= 0) {
            e._nt += 0.55;
            const n = Sp.fanN, step = Sp.fanStep, sp = Sp.speed[ph - 1] * 0.95;
            const base = ang + ((e._n & 1) ? step / 2 : 0);
            for (let k = 0; k < n; k++) {
              const aa = base + (k - (n - 1) / 2) * step;
              addEshot('notif', e.kind, e.x + Math.sin(aa) * e.r * 0.7, e.z + Math.cos(aa) * e.r * 0.7, { vx: Math.sin(aa) * sp, vz: Math.cos(aa) * sp, r: Sp.r, life: Sp.life });
            }
            e._n++;
            emit({ type: 'enemyShot', kind: e.kind, shotType: 'notif', x: e.x, z: e.z });
          }
          if (e.stateT >= e.stateDur) setSt(e, 'recover', 0.5);
        } else if (a === 'sweep') {
          const Sw = B.sweep;
          const u = Math.min(1, e.stateT / e.stateDur);
          e._a = e._a0 + (e._a1 - e._a0) * u;
          e.face = e._a;
          const hz = e._haz;
          if (hz && !hz._dead) { const be = beamEnd(e.x, e.z, e._a, Sw.len); hz.x = e.x; hz.z = e.z; hz.x2 = be.x; hz.z2 = be.z; }
          if (e.stateT >= e.stateDur) { e._haz = null; setSt(e, 'recover', 0.5); }
        } else if (a === 'fold') {
          if (e.stateT >= e.stateDur) setSt(e, 'stun', B.fold.stun);
        } else if (a === 'bolt') {
          const Bo = B.bolt;
          e._nt -= h;
          e.face = turnTo(e.face, ang, 5 * h);
          if (e._nt <= 0 && e._n < Bo.volleys) {
            e._nt += Bo.every; e._n++;
            for (let k = 0; k < Bo.n; k++) {
              const aa = ang + (k - (Bo.n - 1) / 2) * Bo.step;
              addEshot('bolt', e.kind, e.x + Math.sin(aa) * e.r * 0.8, e.z + Math.cos(aa) * e.r * 0.8, { vx: Math.sin(aa) * Bo.speed, vz: Math.cos(aa) * Bo.speed, r: Bo.r, life: Bo.life });
            }
            emit({ type: 'enemyShot', kind: e.kind, shotType: 'bolt', x: e.x, z: e.z });
          }
          if (e.stateT >= e.stateDur) setSt(e, 'recover', 0.4);
        } else if (e.stateT >= e.stateDur) setSt(e, 'recover', 0.4);
        break;
      }
      case 'recover':
      case 'stun':
        e.spd = 0;
        if (e.stateT >= e.stateDur) { setSt(e, 'move', 1); e._cd = B.gap[ph - 1]; }
        break;
    }
  }

  function updEnemies(h) {
    const P = S.player;
    const list = S.enemies;
    ATK.fill(0);
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e._dead && !e.boss && (e.state === 'windup' || e.state === 'attack')) ATK[KIND_IDX[e.kind]]++;
    }
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e._dead) continue;
      if (e.flash > 0) e.flash = Math.max(0, e.flash - h * 7);
      e.stateT += h;
      e._px = e.x; e._pz = e.z; e._want = 0;
      if (e._grace > 0) e._grace -= h;
      if (e.state === 'spawn') { updSpawn(e); continue; }
      if (e.boss) {
        if (e.state === 'dying') { e.spd = 0; if (e.y > 0) e.y = Math.max(0, e.y - h * 6); if (e.stateT >= e.stateDur) finishBoss(e); continue; }
        e._cd -= h;
        if (e.kind === 'boss_gateway') updGateway(e, h); else updFlagship(e, h);
        continue;
      }
      if (e._kx !== 0 || e._kz !== 0) {
        e.x += e._kx * h; e.z += e._kz * h;
        const k = Math.exp(-9 * h);
        e._kx *= k; e._kz *= k;
        if (Math.abs(e._kx) + Math.abs(e._kz) < 0.03) { e._kx = 0; e._kz = 0; }
      }
      e._cd -= h;
      const dx = P.x - e.x, dz = P.z - e.z, d = Math.sqrt(dx * dx + dz * dz) || 1e-3;
      AIS[0] = h; AIS[1] = dx; AIS[2] = dz; AIS[3] = d;
      switch (e.kind) {
        case 'xb6': aiGrunt(e); break;
        case 'pod': aiPod(e); break;
        case 'xb3': aiTank(e); break;
        case 'xb7': aiCharger(e); break;
        case 'xb8': aiBroadcaster(e); break;
        case 'xb10': aiCommander(e); break;
        case 'iphone': aiFlipper(e); break;
        case 'galaxy': aiSniper(e); break;
        case 'fold': aiChomper(e); break;
        default: walk(e, h, dx, dz, 1.5, NaN);
      }
    }
  }

  // separation (spatial hash), fixture collision, player push. Also builds the grid for shots.
  function resolveEnemies() {
    const list = S.enemies, n = list.length;
    if (gNext.length < n) gNext = new Int32Array(n * 2);
    gHead.fill(-1);
    for (let i = 0; i < n; i++) {
      const e = list[i];
      if (e._dead || e.state === 'spawn' || e.boss) continue;
      const c = gCellZ(e.z) * GW + gCellX(e.x);
      gNext[i] = gHead[c]; gHead[c] = i;
    }
    // separation
    for (let i = 0; i < n; i++) {
      const a = list[i];
      if (a._dead || a.state === 'spawn' || a.boss || a.y > 0.3) continue;
      const cx = gCellX(a.x), cz = gCellZ(a.z);
      const aHeavy = a.kind === 'xb7' && a.state === 'attack';
      for (let zz = cz - 1; zz <= cz + 1; zz++) {
        if (zz < 0 || zz >= GH) continue;
        for (let xx = cx - 1; xx <= cx + 1; xx++) {
          if (xx < 0 || xx >= GW) continue;
          for (let j = gHead[zz * GW + xx]; j !== -1; j = gNext[j]) {
            if (j <= i) continue;
            const b = list[j];
            if (b._dead || b.y > 0.3) continue;
            const dx = b.x - a.x, dz = b.z - a.z, rr = a.r + b.r;
            const d2 = dx * dx + dz * dz;
            if (d2 >= rr * rr) continue;
            let d = Math.sqrt(d2), nx, nz;
            if (d < 1e-5) { nx = (i & 1) ? 1 : -1; nz = 0; d = 0; } else { nx = dx / d; nz = dz / d; }
            const ov = (rr - d) * 0.5;
            const bHeavy = b.kind === 'xb7' && b.state === 'attack';
            const wa = aHeavy ? 0 : bHeavy ? 2 : 1, wb = bHeavy ? 0 : aHeavy ? 2 : 1;
            a.x -= nx * ov * wa; a.z -= nz * ov * wa;
            b.x += nx * ov * wb; b.z += nz * ov * wb;
          }
        }
      }
    }
    // bosses push minions away
    const boss = G.boss;
    if (boss && !boss._dead && boss.state !== 'spawn' && boss.y < 0.5) {
      for (let i = 0; i < n; i++) {
        const e = list[i];
        if (e === boss || e._dead || e.state === 'spawn' || e.y > 0.3) continue;
        const dx = e.x - boss.x, dz = e.z - boss.z, rr = e.r + boss.r;
        const d2 = dx * dx + dz * dz;
        if (d2 >= rr * rr) continue;
        const d = Math.sqrt(d2) || 1e-3;
        e.x = boss.x + dx / d * rr; e.z = boss.z + dz / d * rr;
      }
    }
    // world + player push
    const P = S.player;
    for (let i = 0; i < n; i++) {
      const e = list[i];
      if (e._dead || e.state === 'spawn') continue;
      if (e.y > 0.3) continue;
      if (!e.boss && P.alive && P.dashT <= 0) {
        const dx = e.x - P.x, dz = e.z - P.z, rr = e.r + 0.2;
        const d2 = dx * dx + dz * dz;
        if (d2 < rr * rr) {
          const d = Math.sqrt(d2) || 1e-3;
          e.x = P.x + dx / d * rr; e.z = P.z + dz / d * rr;
        }
      }
      if (e.kind === 'xb7' && e.state === 'attack') continue; // handled by the charge itself
      collideEnemy(e);
    }
    if (boss && !boss._dead && boss.state !== 'spawn' && boss.y < 0.5 && P.alive) {
      const dx = P.x - boss.x, dz = P.z - boss.z, rr = boss.r + TUNE.player.r * 0.8;
      const d2 = dx * dx + dz * dz;
      if (d2 < rr * rr && P.dashT <= 0) {
        const d = Math.sqrt(d2) || 1e-3;
        P.x = boss.x + dx / d * rr; P.z = boss.z + dz / d * rr;
        collidePlayer(P);
      }
    }
    // stall detection: steering round a fixture but going nowhere (jammed by a neighbour) -> flip side
    for (let i = 0; i < n; i++) {
      const e = list[i];
      if (!e._avSide || e._want <= 0) continue;
      const mx = e.x - e._px, mz = e.z - e._pz;
      if (mx * mx + mz * mz < (0.25 * e._want) * (0.25 * e._want)) {
        e._avStall += e._want / Math.max(0.1, e.spd);
        if (e._avStall > 0.4) { e._avSide = -e._avSide; e._avStall = 0; e._avAge = 0; }
      } else if (e._avStall > 0) e._avStall = Math.max(0, e._avStall - e._want / Math.max(0.1, e.spd));
    }
    // rebuild grid after movement for the shot pass
    gHead.fill(-1);
    for (let i = 0; i < n; i++) {
      const e = list[i];
      if (e._dead || e.state === 'spawn' || e.boss) continue;
      const c = gCellZ(e.z) * GW + gCellX(e.x);
      gNext[i] = gHead[c]; gHead[c] = i;
    }
  }

  function shotHit(s, e, x0, z0) {
    if (s._hits && s._hits.indexOf(e.id) >= 0) return false;
    if (segCircle(x0, z0, s.x, s.z, e.x, e.z, e.r + TUNE.gun.r) < 0) return false;
    let dmg = s._dmg, crit = false;
    if (rand() < TUNE.gun.crit) { dmg *= 2; crit = true; }
    const sp = Math.sqrt(s.vx * s.vx + s.vz * s.vz) || 1, kb = TUNE.gun.knock;
    damage(e, dmg, crit, s.vx / sp * kb, s.vz / sp * kb, s.big ? 'od' : 'bolt');
    if (s.pierce > 0) {
      s.pierce--;
      if (!s._hits) s._hits = [];
      s._hits.push(e.id);
      return false;
    }
    s._dead = true;
    return true;
  }
  function updPShots(h) {
    const list = S.enemies, shots = S.pshots;
    const boss = G.boss;
    for (let si = 0; si < shots.length; si++) {
      const s = shots[si];
      if (s._dead) continue;
      const x0 = s.x, z0 = s.z;
      s.x += s.vx * h; s.z += s.vz * h;
      s._life -= h;
      if (s._life <= 0 || s.x < ARENA.minX - 1.5 || s.x > ARENA.maxX + 1.5 || s.z < ARENA.minZ - 1.5 || s.z > ARENA.maxZ + 1.5) { s._dead = true; continue; }
      if (KIOSK && segCircle(x0, z0, s.x, s.z, KIOSK.x, KIOSK.z, KIOSK.r) >= 0) { s._dead = true; continue; }
      if (boss && !boss._dead && targetable(boss)) { if (shotHit(s, boss, x0, z0)) continue; }
      const cx = gCellX(s.x), cz = gCellZ(s.z);
      let done = false;
      for (let zz = cz - 1; zz <= cz + 1 && !done; zz++) {
        if (zz < 0 || zz >= GH) continue;
        for (let xx = cx - 1; xx <= cx + 1 && !done; xx++) {
          if (xx < 0 || xx >= GW) continue;
          for (let j = gHead[zz * GW + xx]; j !== -1; j = gNext[j]) {
            const e = list[j];
            if (!targetable(e)) continue;
            if (shotHit(s, e, x0, z0)) { done = true; break; }
          }
        }
      }
    }
  }
  function updEShots(h) {
    const P = S.player, hr = TUNE.player.hurtR;
    for (let i = 0; i < S.eshots.length; i++) {
      const s = S.eshots[i];
      if (s._dead) continue;
      s.t += h;
      if (s.t >= s.life) { s._dead = true; continue; }
      if (s.type === 'wave' || s.type === 'ring') {
        s.R += s.vR * h;
        if (!s._hit && P.alive) {
          const dx = P.x - s.x, dz = P.z - s.z, d = Math.sqrt(dx * dx + dz * dz);
          if (Math.abs(d - s.R) < s.w * 0.5 + hr) {
            const a = Math.atan2(dx, dz);
            let inside;
            // generous: the fox's CENTRE must be inside the drawn arc (edge grazes never count)
            if (s.type === 'wave') inside = Math.abs(wrapA(a - s.a)) < s.half;
            else inside = !s.gap || Math.abs(wrapA(a - s.gap.a)) > s.gap.half;
            if (inside && hurt(s._kind, s.x, s.z, s.type)) s._hit = true;
          }
        }
      } else {
        const x0 = s.x, z0 = s.z;
        s.x += s.vx * h; s.z += s.vz * h;
        if (s.x < ARENA.minX - 2 || s.x > ARENA.maxX + 2 || s.z < ARENA.minZ - 2 || s.z > ARENA.maxZ + 2) { s._dead = true; continue; }
        if (KIOSK && segCircle(x0, z0, s.x, s.z, KIOSK.x, KIOSK.z, KIOSK.r) >= 0) { s._dead = true; continue; }
        if (P.alive && distSeg(P.x, P.z, x0, z0, s.x, s.z) < s.r + hr) {
          if (hurt(s._kind, s.x, s.z, s.type)) s._dead = true;
        }
      }
    }
  }
  function hazardHitsPlayer(hz) {
    const P = S.player, hr = TUNE.player.hurtR;
    switch (hz.type) {
      case 'beam': return distSeg(P.x, P.z, hz.x, hz.z, hz.x2, hz.z2) < hz.w * 0.5 + hr;
      case 'fold': {
        const dx = P.x - hz.x, dz = P.z - hz.z, c = Math.cos(hz.a), s = Math.sin(hz.a);
        const lx = dx * c - dz * s, lz = dx * s + dz * c;
        return Math.abs(lx) < hz.hw + 0.1 && Math.abs(lz) < hz.hd + 0.1;
      }
      default: {
        const dx = P.x - hz.x, dz = P.z - hz.z, rr = hz.r + 0.1;
        return dx * dx + dz * dz < rr * rr;
      }
    }
  }
  function updHazards(h) {
    for (let i = 0; i < S.hazards.length; i++) {
      const hz = S.hazards[i];
      if (hz._dead) continue;
      if (hz.warn > 0) {
        hz.warn -= h;
        if (hz.warn > 0) continue;
        hz.warn = 0;
      }
      if (!hz._live) {
        hz._live = true;
        emit({ type: 'hazardLive', id: hz.id, hazard: hz.type, hazardType: hz.type, x: hz.x, z: hz.z, src: hz.src });
        if (hz.type === 'spark') {
          shake(0.25);
          const hm = hpMul();
          for (const e of S.enemies) {
            if (!targetable(e) || e.boss || e.y > 0.5) continue;
            const dx = e.x - hz.x, dz = e.z - hz.z, rr = hz.r + e.r * 0.5;
            if (dx * dx + dz * dz < rr * rr) damage(e, 3 * hm, false, 0, 0, 'spark');
          }
        }
      }
      hz.live -= h;
      if (!hz._hitP && S.player.alive && hazardHitsPlayer(hz)) {
        if (hurt(hz.by, hz.x, hz.z, hz.type)) hz._hitP = true;
      }
      if (hz.live <= 0) { hz.live = 0; hz._dead = true; }
    }
  }

  // ------------------------------------------------------------------ power drops
  const PUP_DEFS = {
    slug:  { life: 6.0, cap: () => G.dmgBonus < 1, f: () => { G.dmgBonus++; } },
    clock: { life: 7.5, cap: () => G.fireMul > 0.74, f: () => { G.fireMul *= 0.9; } },
    split: { life: 6.0, cap: () => G.multiBonus < 1, f: () => { G.multiBonus++; } },
    pier:  { life: 7.5, cap: () => G.pierceBonus < 2, f: () => { G.pierceBonus++; } },
    rein:  { life: 6.5, cap: () => S.player.maxHp < TUNE.player.hpCap, f: () => { S.player.maxHp++; heal(1); } },
    wind:  { life: 7.0, cap: () => true, f: () => { heal(2); G.speedMul = Math.min(1.2, G.speedMul * 1.04); } },
    feet:  { life: 7.5, cap: () => S.player.dashCDMax > TUNE.player.dashCDMin + 1e-6, f: () => { const P = S.player; P.dashCDMax = Math.max(TUNE.player.dashCDMin, P.dashCDMax - 0.35); P.dashCD = Math.min(P.dashCD, P.dashCDMax); } },
    cap:   { life: 7.5, cap: () => S.player.pulseCDMax > TUNE.player.pulseCDMin + 1e-6, f: () => { const P = S.player; P.pulseCDMax = Math.max(TUNE.player.pulseCDMin, P.pulseCDMax - 1.5); P.pulseCD = Math.min(P.pulseCD, P.pulseCDMax); } },
    field: { life: 7.5, cap: () => S.player.aura < 3, f: () => { S.player.aura++; } },
    scav:  { life: 7.5, cap: () => G.scav < 2, f: () => { G.scav++; G.gemMul *= 1.5; G.magnetBonus += 1.2; } },
    nrg:   { life: 6.5, cap: () => true, buff: 'rapid', f: () => { S.player.buffs.rapid = TUNE.buffs.rapid; } },
    shld:  { life: 6.5, cap: () => true, buff: 'shield', f: () => { S.player.buffs.shield = TUNE.buffs.shield; } },
    vac:   { life: 6.5, cap: () => true, buff: 'vac', f: () => { S.player.buffs.vac = TUNE.buffs.vac; } },
  };
  const PUP_KEYS = Object.keys(PICKUPS).filter((k) => PUP_DEFS[k]);
  function pupPick() {
    let bag = PUP_KEYS.filter((k) => PUP_DEFS[k].cap());
    if (!bag.length) bag = PUP_KEYS.filter((k) => PICKUPS[k].fam === 'nrg');
    if (G.pupSeq % 3 === 2) { const n = bag.filter((k) => PICKUPS[k].fam === 'nrg'); if (n.length) bag = n; }
    return bag[Math.floor(rand() * bag.length)];
  }
  function pupSpot() {
    const P = S.player, T = TUNE.pups;
    let cx = 0, cz = 0, n = 0;
    for (const e of S.enemies) if (targetable(e) && !e.boss) { cx += e.x; cz += e.z; n++; }
    if (n) { cx /= n; cz /= n; }
    const risky = n > 2 && rand() < T.risky;
    let bx = 0, bz = 0, bs = -1e9;
    for (let i = 0; i < 24; i++) {
      const x = rnd(ARENA.minX + 0.9, ARENA.maxX - 0.9), z = rnd(ARENA.minZ + 0.9, ARENA.maxZ - 0.9);
      if (insideFixture(x, z, 0.7)) continue;
      const dx = x - P.x, dz = z - P.z, d = Math.sqrt(dx * dx + dz * dz);
      if (d < T.minDist) continue;
      let sc = Math.min(d, T.farDist);
      if (risky) { const ex = x - cx, ez = z - cz; sc += 7.6 - Math.min(7.6, Math.sqrt(ex * ex + ez * ez)); }
      if (sc > bs) { bs = sc; bx = x; bz = z; }
    }
    if (bs === -1e9) {
      const a = rand() * TAU;
      const tmp = { x: P.x + Math.sin(a) * 5.5, z: P.z + Math.cos(a) * 5.5 };
      collideWorld(tmp, 0.7, 0.9);
      bx = tmp.x; bz = tmp.z;
    }
    return { x: bx, z: bz };
  }
  function spawnPup() {
    const key = pupPick();
    if (!key) return;
    const spot = pupSpot();
    const o = { id: nid(), type: 'orb', pup: key, fam: PICKUPS[key].fam, x: spot.x, z: spot.z, t: 0, life: PUP_DEFS[key].life, value: 0, _dead: false, _pull: false };
    S.pickups.push(o);
    G.pupSeq++;
    pickupEv('pickupSpawn', o);
  }
  function updPickups(h) {
    const P = S.player, TP = TUNE.player;
    const vac = P.buffs.vac > 0;
    const mag = TP.magnet + G.magnetBonus;
    for (let i = 0; i < S.pickups.length; i++) {
      const o = S.pickups[i];
      if (o._dead) continue;
      o.t += h;
      const dx = P.x - o.x, dz = P.z - o.z, d = Math.sqrt(dx * dx + dz * dz) || 1e-4;
      if (o.type === 'gem') {
        if (vac || o._pull || d < mag) {
          o._pull = true;
          const sp = vac ? TP.vacPull : TP.gemPull + 6 * Math.min(1, o.t * 0.5);
          const st = Math.min(d, sp * h);
          o.x += dx / d * st; o.z += dz / d * st;
        }
        if (d < TP.gemCollect) {
          o._dead = true;
          P.xp += o.value * G.gemMul;
          S.score += Math.round(TUNE.score.gem * o.value * S.mult * otMul());
          emit({ type: 'gem', x: o.x, z: o.z, value: o.value });
          checkTier();
        } else if (o.t >= o.life && !o._pull) o._dead = true;
      } else if (o.type === 'heart') {
        if (vac || d < mag * 0.8) { const st = Math.min(d, 5 * h); o.x += dx / d * st; o.z += dz / d * st; }
        if (d < TP.heartCollect) {
          o._dead = true;
          pickupEv('pickup', o);
          if (P.hp < P.maxHp) heal(1);
          else { const b = Math.round(TUNE.score.heartFull * otMul()); S.score += b; }
        } else if (o.t >= o.life) {
          o._dead = true;
          pickupEv('pickupExpire', o);
        }
      } else {
        if (d < TP.orbAssist) { const st = Math.min(d, TP.orbAssistSpd * h); o.x += dx / d * st; o.z += dz / d * st; }
        if (d < TP.orbCollect) {
          o._dead = true;
          const def = PUP_DEFS[o.pup];
          if (def) def.f();
          recalcGun();
          odGain(TUNE.od.orb);
          pickupEv('pickup', o);
        } else if (o.t >= o.life) {
          o._dead = true;
          pickupEv('pickupExpire', o);
        }
      }
    }
  }
  function updAura(h) {
    const P = S.player;
    if (P.aura <= 0) return;
    G.auraT -= h;
    if (G.auraT > 0) return;
    G.auraT = 0.28;
    const r = 1.2 + 0.5 * P.aura, dmg = 0.4 * P.aura * hpMul();
    for (const e of S.enemies) {
      if (!targetable(e) || e.y > 1) continue;
      const dx = e.x - P.x, dz = e.z - P.z, rr = r + e.r * 0.5;
      if (dx * dx + dz * dz < rr * rr) damage(e, dmg, false, 0, 0, 'aura');
    }
  }
  function contactDamage() {
    const P = S.player;
    if (!P.alive || P.inv > 0 || P.dashT > 0) return;
    const tr = TUNE.player.touchR;
    for (const e of S.enemies) {
      if (e._dead || e.state === 'spawn' || e.state === 'dying' || e.state === 'stun' || e.y > 0.6 || e._grace > 0) continue;
      const dx = e.x - P.x, dz = e.z - P.z, rr = e.r + tr;
      if (dx * dx + dz * dz < rr * rr) { if (hurt(e.kind, e.x, e.z, e.state === 'attack' ? e.attack || 'touch' : 'touch')) return; }
    }
  }
  function compact(arr) {
    let j = 0;
    for (let i = 0; i < arr.length; i++) { const o = arr[i]; if (!o._dead) arr[j++] = o; }
    arr.length = j;
  }
  function timers(h) {
    const P = S.player;
    if (P.inv > 0) P.inv = Math.max(0, P.inv - h);
    if (P.hurtT > 0) P.hurtT = Math.max(0, P.hurtT - h * 2);
    if (P.dashCD > 0) P.dashCD = Math.max(0, P.dashCD - h);
    if (P.pulseCD > 0) P.pulseCD = Math.max(0, P.pulseCD - h);
    const B = P.buffs;
    let changed = false;
    if (B.rapid > 0) { B.rapid -= h; if (B.rapid <= 0) { B.rapid = 0; changed = true; } }
    if (B.shield > 0) { B.shield -= h; if (B.shield <= 0) B.shield = 0; }
    if (B.vac > 0) { B.vac -= h; if (B.vac <= 0) B.vac = 0; }
    P.shieldT = B.shield;
    if (P.odT > 0) {
      P.odT -= h;
      P.od = Math.max(0, P.odT / TUNE.player.odDur);
      if (P.odT <= 0) { P.odT = 0; P.od = 0; changed = true; emit({ type: 'overdriveEnd', x: P.x, z: P.z }); }
    }
    if (changed) recalcGun();
    if (G.comboT > 0) { G.comboT -= h; if (G.comboT <= 0) comboBreak(); }
    if (G.dashBuf > 0) G.dashBuf = Math.max(0, G.dashBuf - h);
    if (G.pulseBuf > 0) G.pulseBuf = Math.max(0, G.pulseBuf - h);
    if (G.hitstopCD > 0) G.hitstopCD -= h;
  }
  function syncBoss() {
    const b = G.boss;
    if (b && S.boss) { S.boss.hp = Math.max(0, b.hp); S.boss.maxHp = b.maxHp; S.boss.phase = b.phase; }
  }
  function trackStats() {
    if (S.enemies.length > G.maxEnemies) G.maxEnemies = S.enemies.length;
    if (S.eshots.length > G.maxE) G.maxE = S.eshots.length;
    if (S.pshots.length > G.maxP) G.maxP = S.pshots.length;
    if (S.hazards.length > G.maxH) G.maxH = S.hazards.length;
    if (S.pickups.length > G.maxK) G.maxK = S.pickups.length;
  }

  // ================================================================== ticks
  function tickPlay(h, inp) {
    S.t += h; S.hourT += h;
    timers(h);
    recalcGun();
    updatePlayer(h, inp, true);
    if (S.phase === 'dead') return;
    updateGun(h);
    director(h);
    updEnemies(h);
    resolveEnemies();
    updPShots(h);
    if (S.phase === 'play' || S.phase === 'overtime') updEShots(h);
    if (S.phase === 'play' || S.phase === 'overtime') updHazards(h);
    if (S.phase === 'play' || S.phase === 'overtime') updPickups(h);
    if (S.phase === 'play' || S.phase === 'overtime') updAura(h);
    if (S.phase === 'play' || S.phase === 'overtime') contactDamage();
    compact(S.enemies); compact(S.pshots); compact(S.eshots); compact(S.hazards); compact(S.pickups);
    if (S.phase === 'play' || S.phase === 'overtime') hourCheck();
    syncBoss();
    updClock();
    trackStats();
  }
  function tickIntro(h, inp) {
    S.t += h; S.hourT += h;
    const P = S.player;
    if (P.hurtT > 0) P.hurtT = Math.max(0, P.hurtT - h * 2);
    if (P.dashCD > 0) P.dashCD = Math.max(0, P.dashCD - h);
    if (P.pulseCD > 0) P.pulseCD = Math.max(0, P.pulseCD - h);
    P.inv = Math.max(P.inv, 0.5);
    if (P.dashT > 0) P.dashT = 0;
    updatePlayer(h, inp, false);
    P.aim = turnTo(P.aim, P.face, 8 * h);
    const b = G.boss;
    if (b && !b._dead && b.state === 'spawn') {
      b.stateT += h;
      updSpawn(b);
    }
    G.introT -= h; S.introT = Math.max(0, G.introT);
    if (G.introT <= 0) {
      if (b && b.state === 'spawn') { b.stateT = b.stateDur; updSpawn(b); }
      S.phase = G.overtime ? 'overtime' : 'play';
      P.inv = Math.max(P.inv, 1.0);
    }
    syncBoss();
    updClock();
  }
  function tickIdle(h) {
    const P = S.player;
    if (P.hurtT > 0) P.hurtT = Math.max(0, P.hurtT - h * 2);
    P.spd = 0; P.moving = false; P.vx = 0; P.vz = 0; G.vx = 0; G.vz = 0;
    for (const e of S.enemies) { if (e.flash > 0) e.flash = Math.max(0, e.flash - h * 7); e.spd = 0; }
  }
  function step(dt, input) {
    if (!(dt > 0)) return;
    if (dt > TUNE.dtMax) dt = TUNE.dtMax;
    const inp = input || NOINPUT;
    if (inp.dash) G.dashBuf = TUNE.player.buffer;
    if (inp.pulse) G.pulseBuf = TUNE.player.buffer;
    S.player.firing = false;
    const n = Math.max(1, Math.ceil(dt / TUNE.subStep - 1e-6));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const ph = S.phase;
      if (ph === 'play' || ph === 'overtime') tickPlay(h, inp);
      else if (ph === 'bossIntro') tickIntro(h, inp);
      else tickIdle(h);
    }
  }
  function result() {
    return {
      score: S.score, kills: S.kills, bestCombo: S.bestCombo, hour: S.hour, clock: S.clock,
      won: G.won, overtime: G.overtime, killedBy: G.killedBy, time: S.t,
    };
  }

  // ================================================================== debug
  function skipTo(hi) {
    hi = Math.max(0, Math.min(8, hi | 0));
    const P = S.player;
    for (const e of S.enemies) e._dead = true;
    S.enemies.length = 0; S.pshots.length = 0; S.eshots.length = 0; S.hazards.length = 0;
    for (const o of S.pickups) o._dead = true;
    S.pickups.length = 0;
    G.queue.length = 0; G.boss = null; S.boss = null;
    const tier = TUNE.skipTier[Math.min(hi, TUNE.skipTier.length - 1)];
    P.wTier = tier; P.wName = WEAPONS[tier].n; P.xp = 0; P.xpNext = tier < TUNE.xp.length ? TUNE.xp[tier] : TUNE.xpOverflow;
    P.hp = P.maxHp; P.alive = true; P.inv = 1;
    comboBreak();
    recalcGun();
    if (hi >= 8) {
      G.won = true; S.phase = 'won';
      continueOvertime();
    } else {
      S.phase = 'play';
      beginHour(hi);
    }
  }

  reset(baseSeed);
  return {
    get state() { return S; },
    get events() { return EV; },
    start, step, drain, continueOvertime, result, debug,
  };
}
