// =====================================================================================
// AFTER HOURS 3D — integration. Wires sim → renderers / fx / audio / ui, owns the loop,
// the saved profile and the leaderboard hooks.
// =====================================================================================
import * as THREE from 'three';
import css from './ui.css';
import { createGfx } from './gfx.js';
import { createWorld } from './world.js';
import { createFox } from './fox.js';
import { createModems } from './modems.js';
import { createPhones } from './phones.js';
import { createFX } from './fx.js';
import { createSim } from './sim.js';
import { createUI } from './ui.js';
import { createAudio } from './audio.js';
import { OUTFITS, HOURS, PLAYER_START } from './layout.js';
import { ASSETS } from './assets.js';
import { createLB } from './lb.js';

const VERSION = '3.0.0';
const PKEY = 'c3-after-hours-3d-profile-v1';
const qs = new URLSearchParams(location.search);
const DEBUG = qs.has('debug');

// ---------------------------------------------------------------- style + DOM layers
{
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
}
const stageEl = document.getElementById('stage');
const uiEl = document.getElementById('ui');

// ---------------------------------------------------------------- profile
function loadProfile() {
  let p = null;
  try { p = JSON.parse(localStorage.getItem(PKEY) || 'null'); } catch (e) { p = null; }
  p = Object.assign({ best: 0, bestHour: 0, lifetimeKills: 0, wins: 0, runs: 0, outfit: 'bomber', unlocked: ['bomber'], name: '', district: '', sound: true, newUnlocks: [] }, p || {});
  if (!Array.isArray(p.unlocked)) p.unlocked = ['bomber'];
  if (!p.unlocked.includes('bomber')) p.unlocked.unshift('bomber');
  if (!OUTFITS.some((o) => o.id === p.outfit) || !p.unlocked.includes(p.outfit)) p.outfit = 'bomber';
  p.newUnlocks = [];
  return p;
}
function saveProfile() {
  try { const c = Object.assign({}, profile); delete c.newUnlocks; localStorage.setItem(PKEY, JSON.stringify(c)); } catch (e) { /* private mode */ }
}
function checkUnlocks() {
  const fresh = [];
  for (const o of OUTFITS) {
    if (!o.unlock || profile.unlocked.includes(o.id)) continue;
    const u = o.unlock;
    const ok = (u.type === 'hour' && profile.bestHour >= u.value) || (u.type === 'kills' && profile.lifetimeKills >= u.value) || (u.type === 'win' && profile.wins >= u.value);
    if (ok) { profile.unlocked.push(o.id); fresh.push(o.id); }
  }
  return fresh;
}
const profile = loadProfile();

// ---------------------------------------------------------------- leaderboard
const LB = createLB();

// ---------------------------------------------------------------- UI first (boot screen paints immediately)
let mode = 'boot';          // boot | title | locker | play | paused | over | won
let sim = null, gfx = null, world = null, fox = null, modems = null, phones = null, fx = null, audio = null;
let lastResult = null, runRecorded = false, killsAtVictory = 0, lockerFill = null;

const ui = createUI(uiEl, {
  onPlay() { if (audio) { audio.unlock(); audio.sfx('start'); } startRun(); },
  onRetry() { if (audio) audio.sfx('start'); startRun(); },
  onQuit() { toTitle(); },
  onPause(p) {
    if (p && mode === 'play') { mode = 'paused'; if (audio) audio.pause(true); ui.showPause(); }
    else if (!p && mode === 'paused') { mode = 'play'; if (audio) audio.pause(false); ui.hidePause(); lastNow = performance.now(); }
  },
  onOvertime() {
    if (!sim) return;
    if (sim.continueOvertime()) { mode = 'play'; fox.pose('play'); ui.showPlaying(); }
  },
  onClockOut() { /* UI shows the post panel; the run is already recorded at sunrise */ },
  onSound(on) { profile.sound = !!on; saveProfile(); if (audio) { if (on) audio.unlock(); audio.setEnabled(!!on); } },
  onOutfit(id) {
    if (!profile.unlocked.includes(id)) return;
    profile.outfit = id; saveProfile(); if (fox) fox.setOutfit(id);
  },
  onProfile(o) {
    if (o && typeof o.name === 'string') profile.name = o.name;
    if (o && typeof o.district === 'string') profile.district = o.district;
    saveProfile();
  },
  onScreen(name) {
    if (name === 'locker') enterLocker();
    else if (name === 'title' && mode === 'locker') { mode = 'title'; fox.root.visible = false; lockerFill.intensity = 0; }
  },
  lbTop(scope) { return LB.top(scope); },
  lbSubmit(entry) {
    if (entry && entry.name) { profile.name = entry.name; profile.district = entry.district || profile.district; saveProfile(); }
    return LB.submit(entry);
  },
});
ui.setAssets(ASSETS);

// ---------------------------------------------------------------- 3D + everything else (after first paint)
function boot() {
  gfx = createGfx(stageEl, qs.has('q') ? { quality: +qs.get('q') } : {});
  world = createWorld(gfx);
  fx = createFX(gfx.scene, gfx.camera);
  modems = createModems(gfx.scene, { capacity: 80, quality: gfx.quality });
  phones = createPhones(gfx.scene, { capacity: 70, quality: gfx.quality });
  fox = createFox({ outfit: profile.outfit, quality: gfx.quality });
  gfx.scene.add(fox.root);
  fox.root.visible = false;
  // locker fill light: always present (constant light count = no shader recompiles), lit only in the locker
  lockerFill = new THREE.DirectionalLight(0xfff1e6, 0);
  lockerFill.position.set(LOCKER.x - 1.5, 2.6, LOCKER.z - 4);
  lockerFill.target.position.set(LOCKER.x, 0.6, LOCKER.z);
  gfx.scene.add(lockerFill, lockerFill.target);
  const applyQ = (q) => { fx.setQuality(q); modems.setQuality(q); phones.setQuality(q); fox.setQuality(q); if (world.setQuality) world.setQuality(q); };
  applyQ(gfx.quality);
  gfx.onQuality((q) => applyQ(q));
  // warm the instanced shaders (modems/phones compile on their first two syncs)
  modems.sync([], 0, 0); modems.sync([], 0, 0); phones.sync([], 0, 0); phones.sync([], 0, 0);
  sim = createSim({});
  audio = createAudio({ enabled: profile.sound !== false });
  audio.setEnabled(profile.sound !== false);
  try { gfx.renderer.compile(gfx.scene, gfx.camera); } catch (e) { /* optional */ }
  if (DEBUG) Object.assign(window, { __ah: { gfx, world, fox, modems, phones, fx, sim, audio, ui, profile, LB, THREE, ff } });
  toTitle();
  lastNow = performance.now();
  requestAnimationFrame(frame);
}

function toTitle() {
  mode = 'title';
  fox.root.visible = false;
  world.setMood('title');
  if (audio) audio.title();
  profile.newUnlocks = [];
  ui.showTitle(profile);
}

// locker: hero camera on the fox, standing in front of the service counter (C³ neon behind)
const LOCKER = { x: 0, z: 7.6 }; // just inside the storefront: the night street + skyline sit behind the fox
function enterLocker() {
  mode = 'locker';
  fox.pose('locker');
  fox.setOutfit(profile.outfit);
  fox.root.visible = true;
  fox.root.position.set(LOCKER.x, 0, LOCKER.z);
  fox.root.rotation.set(0, Math.PI + 0.32, 0);
  lockerFill.intensity = 2.4;
}
function lockerCamera() {
  const W = gfx.size.w, H = gfx.size.h;
  // camera stands inside the store looking out toward the front glass (+Z)
  if (W >= H) { // landscape: fox sits in the LEFT ~45% of the screen
    gfx.showcase(LOCKER.x - 1.25, 1.1, LOCKER.z - 4.3, LOCKER.x - 1.45, 0.7, LOCKER.z, 30);
  } else {      // portrait: fox sits in the upper half
    gfx.showcase(LOCKER.x, 1.3, LOCKER.z - 4.6, LOCKER.x, 0.25, LOCKER.z, 34);
  }
}

// ---------------------------------------------------------------- run lifecycle
let endTimer = 0, endKind = '', hitstop = 0, slowmo = 0, slowmoScale = 1;
let runClock = 0;

function startRun() {
  mode = 'play';
  if (lockerFill) lockerFill.intensity = 0;
  sim.start();
  fx.reset();
  runClock = 0; hitstop = 0; slowmo = 0; endTimer = 0; endKind = '';
  runRecorded = false; killsAtVictory = 0;
  profile.newUnlocks = [];
  fox.setOutfit(profile.outfit);
  fox.pose('play');
  fox.root.visible = true;
  fox.root.rotation.set(0, 0, 0);
  const P = sim.state.player; P.dead = false; P.victory = false;
  gfx.follow(P.x, P.z, 0, { snap: true });
  ui.showPlaying();
  // the sim emitted start + hour(0) inside start(); deliver them now
  dispatch(sim.drain());
  lastNow = performance.now();
}

function recordRun(res, won) {
  if (!runRecorded) {
    profile.runs++;
    profile.lifetimeKills += res.kills;
    if (won) profile.wins++;
    runRecorded = true;
    killsAtVictory = res.kills;
  } else {
    // overtime death after a recorded sunrise: add only the overtime takedowns
    profile.lifetimeKills += Math.max(0, res.kills - killsAtVictory);
    killsAtVictory = res.kills;
  }
  const hourReached = won || res.overtime ? HOURS.length : res.hour;
  profile.bestHour = Math.max(profile.bestHour, hourReached);
  const isBest = res.score > profile.best;
  if (isBest) profile.best = res.score;
  const fresh = checkUnlocks();
  profile.newUnlocks = (profile.newUnlocks || []).concat(fresh);
  saveProfile();
  return isBest;
}

function finishRun(kind) {
  const res = sim.result();
  const won = kind === 'victory';
  const isBest = recordRun(res, won);
  const out = Object.assign({}, res, { isBest });
  if (res.killedBy && ASSETS.portraits && ASSETS.portraits[res.killedBy]) out.portrait = ASSETS.portraits[res.killedBy];
  lastResult = out;
  if (won) { mode = 'won'; ui.showVictory(out, profile); if (isBest && audio) audio.sfx('newBest'); }
  else { mode = 'over'; ui.showGameOver(out, profile); if (isBest && audio) setTimeout(() => audio.sfx('newBest'), 900); }
}

// ---------------------------------------------------------------- event fan-out
const _muz = new THREE.Vector3();
function dispatch(evs) {
  for (let i = 0; i < evs.length; i++) {
    const ev = evs[i];
    switch (ev.type) {
      case 'hitstop': hitstop = Math.max(hitstop, Math.min(0.12, ev.dur || 0)); break;
      case 'shot': fox.muzzle(_muz); ev.mx = _muz.x; ev.my = _muz.y; ev.mz = _muz.z; break;
      case 'bossIntro': {
        const b = sim.state.enemies.find((e) => e.boss);
        gfx.focus(b ? b.x : 0, b ? b.z - 1.2 : -7.5, 1.45, 2.1);
        break;
      }
      case 'bossDying': slowmo = 0.9; slowmoScale = 0.45; break;
      case 'gameover': endKind = 'over'; endTimer = 2.0; slowmo = 1.1; slowmoScale = 0.35; break;
      case 'victory': endKind = 'victory'; endTimer = 3.0; break;
      default: break;
    }
    fx.event(ev);
    world.event(ev);
    audio.event(ev);
    ui.event(ev);
  }
}

// ---------------------------------------------------------------- threat arrows (off-screen enemies)
const _v2 = new THREE.Vector2();
const arrows = [];
const arrowPool = Array.from({ length: 10 }, () => ({ x: 0, y: 0, kind: '', boss: false, d: 0 }));
function computeArrows(S) {
  arrows.length = 0;
  const W = gfx.size.w, H = gfx.size.h, m = 12;
  const px = S.player.x, pz = S.player.z;
  let n = 0;
  for (const e of S.enemies) {
    if (e.state === 'spawn' || e.state === 'dying') continue;
    gfx.worldToScreen(e.x, 0.6, e.z, _v2);
    if (_v2.x > m && _v2.x < W - m && _v2.y > m && _v2.y < H - m) continue;
    const d = (e.x - px) * (e.x - px) + (e.z - pz) * (e.z - pz);
    if (n < arrowPool.length) {
      const a = arrowPool[n++]; a.x = _v2.x; a.y = _v2.y; a.kind = e.kind; a.boss = !!e.boss; a.d = e.boss ? -1 : d; arrows.push(a);
    } else {
      // replace the farthest non-boss
      let wi = -1, wd = -1;
      for (let k = 0; k < arrows.length; k++) if (arrows[k].d > wd) { wd = arrows[k].d; wi = k; }
      if (wi >= 0 && (e.boss || d < wd)) { const a = arrows[wi]; a.x = _v2.x; a.y = _v2.y; a.kind = e.kind; a.boss = !!e.boss; a.d = e.boss ? -1 : d; }
    }
  }
  ui.threatArrows(arrows);
}

// ---------------------------------------------------------------- debug fast-forward (headless tests)
// steps the sim at 60 Hz with an autopilot, fanning events out exactly like the real loop
function ff(sec, auto = true) {
  const dt = 1 / 60, N = Math.round(sec * 60);
  for (let f = 0; f < N && (mode === 'play' || mode === 'over' || mode === 'won'); f++) {
    const S = sim.state, P = S.player;
    let mx = 0, mz = 0, dash = false, pulse = false;
    if (auto && mode === 'play') {
      // steer away from the nearest threats, toward the arena middle
      let ax = -P.x * 0.08, az = (1.5 - P.z) * 0.06;
      for (const e of S.enemies) { const dx = P.x - e.x, dz = P.z - e.z, d2 = dx * dx + dz * dz + 0.2; if (d2 < 30) { ax += dx / d2; az += dz / d2; } }
      for (const h of S.hazards) { const dx = P.x - h.x, dz = P.z - h.z, d2 = dx * dx + dz * dz + 0.2; if (d2 < 12) { ax += 2 * dx / d2; az += 2 * dz / d2; } }
      const L = Math.hypot(ax, az) || 1; mx = ax / L; mz = az / L;
      dash = f % 150 === 75; pulse = f % 420 === 200;
    }
    sim.step(dt, { mx, mz, dash, pulse });
    const evs = sim.drain(); if (evs.length) dispatch(evs);
    vt += dt; runClock += dt;
    fx.update(vt, dt);
    gfx.follow(P.x, P.z, dt, { lead: { x: P.vx || 0, z: P.vz || 0 } });
    if (mode === 'play') ui.hud(S, dt);
    if (endTimer > 0) { endTimer -= dt; if (endTimer <= 0) { finishRun(endKind); endKind = ''; } }
  }
  return { t: sim.state.t, hour: sim.state.hour, phase: sim.state.phase, hp: sim.state.player.hp, score: sim.state.score, mode };
}

// ---------------------------------------------------------------- the loop
let lastNow = 0, vt = 0, statT = 0;
const dbgEl = DEBUG ? (() => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;left:4px;bottom:4px;z-index:99;font:11px monospace;color:#9ff;background:#0008;padding:3px 6px;pointer-events:none;white-space:pre'; document.body.appendChild(d); return d; })() : null;

function frame(now) {
  requestAnimationFrame(frame);
  let real = (now - lastNow) / 1000; lastNow = now;
  if (!(real > 0)) real = 0; if (real > 0.1) real = 0.1;
  const dtR = Math.min(real, 0.05);

  if (mode === 'title') {
    vt += dtR;
    gfx.attract(vt);
    world.update(vt, dtR, null);
    fx.update(vt, dtR);
    audio.update(dtR);
    gfx.render(dtR);
    return;
  }
  if (mode === 'locker') {
    vt += dtR;
    lockerCamera();
    fox.update(vt, dtR, null);
    world.update(vt, dtR, null);
    audio.update(dtR);
    gfx.render(dtR);
    return;
  }
  if (mode === 'paused') { audio.update(0); gfx.render(0); return; }

  // play / over / won — the world keeps living behind the result screens
  let dt = dtR;
  if (hitstop > 0) { hitstop -= real; dt = 0; }
  if (slowmo > 0) { slowmo -= real; dt *= slowmoScale; }
  const S = sim.state;

  if (dt > 0) {
    const input = mode === 'play' ? ui.readInput() : null;
    sim.step(dt, input || { mx: 0, mz: 0, dash: false, pulse: false });
    const evs = sim.drain();
    if (evs.length) dispatch(evs);
  } // during hitstop the UI keeps dash/pulse presses in its own 260 ms buffer (hitstop is ≤ 120 ms)
  vt += dt; runClock += dt;

  const P = S.player;
  P.dead = S.phase === 'dead';
  P.victory = S.phase === 'won';
  fox.update(vt, dt, P);
  modems.sync(S.enemies, vt, dt);
  phones.sync(S.enemies, vt, dt);
  fx.sync(S, vt, dt);
  fx.update(vt, dt);
  world.update(runClock, dt, S);
  gfx.follow(P.x, P.z, dtR, { lead: { x: P.vx || 0, z: P.vz || 0 } });
  gfx.setShake(fx.shake());

  if (mode === 'play') {
    const enemiesN = S.enemies.length;
    audio.setMood(S.mood, { boss: !!S.boss, intensity: Math.min(1, enemiesN / 36) });
    ui.hud(S, dtR);
    computeArrows(S);
  } else if (mode === 'over' || mode === 'won') {
    if (arrows.length) { arrows.length = 0; ui.threatArrows(arrows); }
  }
  audio.update(dtR);
  gfx.render(dtR);

  if (endTimer > 0) {
    endTimer -= real;
    if (endTimer <= 0) { finishRun(endKind); endKind = ''; }
  }
  if (dbgEl && (statT += real) > 0.5) {
    statT = 0;
    const s = gfx.stats();
    dbgEl.textContent = `fps ${s.fps} q${s.q} pr${s.pr} calls ${s.drawCalls} tris ${(s.triangles / 1000) | 0}k  en ${S.enemies.length} ps ${S.pshots.length} es ${S.eshots.length}  ${S.clock} ${S.phase}`;
  }
}

// paint the boot screen, then build the 3D (it takes a moment on phones)
requestAnimationFrame(() => setTimeout(() => {
  try { boot(); } catch (err) {
    console.error(err);
    uiEl.insertAdjacentHTML('beforeend', `<div style="position:fixed;inset:auto 12px 12px 12px;z-index:99;padding:12px;border-radius:10px;background:#300a;color:#fcc;font:13px system-ui">This device couldn't start 3D graphics (${String(err && err.message || err).replace(/</g, '&lt;')}). Try Chrome or Safari with hardware acceleration on.</div>`);
  }
}, 30));
window.__AFTER_HOURS_VERSION = VERSION;
