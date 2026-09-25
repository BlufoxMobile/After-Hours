// =====================================================================================
// AFTER HOURS 3D — FX module (FX agent)
// Projectiles, enemy shots, floor telegraphs, pickups, player auras, contact shadows,
// particles, damage numbers and trauma camera shake. Everything is pooled + instanced.
//
//   const fx = createFX(scene, camera, { dmgScale?: 10, quality?: 2 });
//   fx.sync(simState, t, dt)   // rebuild instance buffers from sim state (+ state-driven emitters)
//   fx.event(ev)               // spawn one-shot effects from a sim event (never mutates state)
//   fx.update(t, dt)           // advance particles, sequences, shake
//   fx.shake() -> THREE.Vector3 // reused object; pass to gfx.setShake() once per frame
//   fx.setQuality(q)           // 0..3 (q0: half particles, no light curtains, flat shield)
//   fx.reset()                 // clear everything (also done on the 'start' event)
//   fx.root                    // THREE.Group holding all FX meshes (added to `scene`)
//   fx.dmgScale                // damage-number multiplier (sim dmg ~1 per bolt -> shows 10, 13, 20...)
//   fx.stats()                 // debug counters
//
// Call order per frame is free: sync() and update() each finish with a full buffer flush,
// so whichever runs last defines the frame. Events may arrive between them. Everything is
// driven by the passed t/dt (hit-stop: dt = 0 freezes particles, still renders them).
//
// Draw calls (only non-empty systems draw): contact/dark decals, glow decals, bands (rings,
// arcs, curtains), normal sprites (smoke, bubbles, icons, confetti), additive sprites, streaks
// (bolts, sparks, beams, lightning), damage numbers, debris, gems, hearts, pickup orbs,
// shield = 12 max. Additive layers carry an energy governor (uGain) so stacked glows can't
// blow the frame to white under bloom; colours are linear HDR with a white-core "hot" term.
//
// Hot paths pass per-instance values through a Float64Array param block (PB) instead of
// double arguments (V8 boxes doubles across non-inlined calls) and write instance arrays
// directly — no Vector3/Matrix4 temporaries per frame.
// =====================================================================================
import * as THREE from 'three';
import { KIND_COLORS, KIND_DIMS, WEAPONS, PICKUPS, PICKUP_FAMILIES, FIXTURES, ROOM } from './layout.js';

const TAU = Math.PI * 2;
const CEIL_Y = ROOM.ceilingY;
const CELLS = 8, CELL = 128;

// atlas frames
const F = {
  SOFT: 0, HOT: 1, STAR: 2, RING: 3, FLARE: 4, SMOKE: 5, DOT: 6, SQUARE: 7,
  BUBBLE: 8, CRACKLE: 9, PLUS: 10, HEX: 11, SOFTRING: 12, DUST: 13, SHARD: 14, HEART: 15,
  ICON: 16, DIGIT: 32, GDOT: 42, GPLUS: 43, GX: 44,
};
const ICONS = ['dmg', 'rate', 'multi', 'pierce', 'armor', 'heal', 'dash', 'pulse', 'aura', 'gem', 'bolt', 'ward', 'mag'];

// ------------------------------------------------------------------ colour helpers
const _cc = new THREE.Color();
function lc(hex, k = 1) { _cc.set(hex); return [_cc.r * k, _cc.g * k, _cc.b * k]; }
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// palette (linear, HDR-scaled where noted)
const WHITE = [1, 1, 1];
const C_PLAYER = lc('#5ff2ff');
const C_GOLD = lc('#ffc24a');
const C_GOLDW = lc('#ffe7a6');
const C_WARN = lc('#ff2a1e');
const C_ORB = lc('#ff2fb4');
const C_EBOLT = lc('#ff4a12');
const C_WAVE = lc('#ff3ec8');
const C_RING = lc('#ff6a1a');
const C_PINK = lc('#ff6fcf');
const C_BEAM = lc('#ff2a6a');
const C_SPARKHZ = lc('#ff3a5a');
const C_AURA = lc('#a58bff');
const C_SHIELD = lc('#8ffff0');
const C_HURT = lc('#ff2a3a');
const C_HEAL = lc('#6dff8e');
const C_DUST = lc('#aab4d4');
const C_SMOKE = lc('#2a2c36');
const C_SHADOW = [0.0, 0.0, 0.012];
const C_ORBBACK = [0.06, 0.0, 0.035];
const C_WARNUNDER = [0.2, 0.0, 0.015];
const C_BEAMUNDER = [0.2, 0.0, 0.03];
const C_FOLDUNDER = [0.16, 0.0, 0.02];
const C_FOLDSHADOW = [0.01, 0.0, 0.03];
const C_FOLDSHADOW2 = [0.01, 0.0, 0.02];
const C_ICON = [0.9, 0.9, 0.9];
const C_SCORCH = [0.02, 0.014, 0.018];
const C_CHIP = [0.05, 0.06, 0.1];
const TMP3 = [0, 0, 0];
const PB = new Float64Array(16);   // param block for hot writers (see wSpr)
const LOG2 = new Float64Array(256); for (let i = 1; i < 256; i++) LOG2[i] = Math.log2(i);
// deterministic noise table (lightning jitter) — table lookups instead of sin-hash calls in hot loops
const NOISE = new Float64Array(1024); { let q = 12345; for (let i = 0; i < 1024; i++) { q = (q * 1103515245 + 12345) & 0x7fffffff; NOISE[i] = q / 0x7fffffff; } }
// column-major TRS matrix straight into an instanceMatrix array (no Matrix4/Vector3 round trips)
function writeTRS(m, o, q) {          // PB: x y z sx sy sz
  const x = PB[0], y = PB[1], z = PB[2], sx = PB[3], sy = PB[4], sz = PB[5];
  const qx = q._x, qy = q._y, qz = q._z, qw = q._w;
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2, yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  m[o] = (1 - (yy + zz)) * sx; m[o + 1] = (xy + wz) * sx; m[o + 2] = (xz - wy) * sx; m[o + 3] = 0;
  m[o + 4] = (xy - wz) * sy; m[o + 5] = (1 - (xx + zz)) * sy; m[o + 6] = (yz + wx) * sy; m[o + 7] = 0;
  m[o + 8] = (xz + wy) * sz; m[o + 9] = (yz - wx) * sz; m[o + 10] = (1 - (xx + yy)) * sz; m[o + 11] = 0;
  m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;
}
// rotation Y(yaw) * X(tilt) * Z(roll) with uniform-ish scale, written directly (gems / hearts)
function writeYXZ(m, o) {             // PB: x y z yaw tilt roll sx sy sz
  const x = PB[0], y = PB[1], z = PB[2], yaw = PB[3], tilt = PB[4], roll = PB[5], sx = PB[6], sy = PB[7], sz = PB[8];
  const cy = Math.cos(yaw), sy_ = Math.sin(yaw), cx = Math.cos(tilt), sx_ = Math.sin(tilt), cz = Math.cos(roll), sz_ = Math.sin(roll);
  // R = Ry * Rx * Rz (three.js Euler order 'YXZ')
  const m11 = cy * cz + sy_ * sx_ * sz_, m12 = sy_ * sx_ * cz - cy * sz_, m13 = sy_ * cx;
  const m21 = cx * sz_, m22 = cx * cz, m23 = -sx_;
  const m31 = cy * sx_ * sz_ - sy_ * cz, m32 = sy_ * sz_ + cy * sx_ * cz, m33 = cy * cx;
  m[o] = m11 * sx; m[o + 1] = m21 * sx; m[o + 2] = m31 * sx; m[o + 3] = 0;
  m[o + 4] = m12 * sy; m[o + 5] = m22 * sy; m[o + 6] = m32 * sy; m[o + 7] = 0;
  m[o + 8] = m13 * sz; m[o + 9] = m23 * sz; m[o + 10] = m33 * sz; m[o + 11] = 0;
  m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;
}
function mixInto(o, a, b, t) { o[0] = a[0] + (b[0] - a[0]) * t; o[1] = a[1] + (b[1] - a[1]) * t; o[2] = a[2] + (b[2] - a[2]) * t; return o; }
const TIER_C = WEAPONS.map((w) => lc(w.c));
const TIER_SAT = TIER_C.map((c) => { const m = Math.max(c[0], c[1], c[2]); return [c[0] * c[0] / m, c[1] * c[1] / m, c[2] * c[2] / m]; });
const FAM_C = {}; for (const k in PICKUP_FAMILIES) FAM_C[k] = lc(PICKUP_FAMILIES[k].color);
const KC = {};
for (const k in KIND_COLORS) KC[k] = { body: lc(KIND_COLORS[k].body), trim: lc(KIND_COLORS[k].trim), glow: lc(KIND_COLORS[k].glow) };
const KC_DEF = KC.xb6;
const PUP_FRAME = {}; for (const k in PICKUPS) PUP_FRAME[k] = F.ICON + Math.max(0, ICONS.indexOf(PICKUPS[k].icon));
const BOXES = FIXTURES.filter((f) => f.type === 'box');
const GEM_A = lc('#4ff6ff'), GEM_B = lc('#b86bff');
const CONFETTI = ['#ff3ec8', '#3ee8ff', '#ffc24a', '#8dff9e', '#b44dff', '#ffffff', '#ff6a3a'].map((h) => lc(h));

// hint colour -> threat colour (keep enemy threats warm/magenta; refuse cyan/green/blue hints)
const _hintCache = new Map();
const _hsl = { h: 0, s: 0, l: 0 };
function threatColor(hint, fallback) {
  if (!hint || typeof hint !== 'string') return fallback;
  let v = _hintCache.get(hint);
  if (v === undefined) {
    v = null;
    try {
      _cc.set(hint); _cc.getHSL(_hsl);
      if ((_hsl.h < 0.035 || _hsl.h > 0.8) && _hsl.s > 0.35) v = [_cc.r, _cc.g, _cc.b]; // magenta..red only
    } catch (e) { v = null; }
    _hintCache.set(hint, v);
  }
  return v || fallback;
}

// ------------------------------------------------------------------ GLSL
const TONE = `
#include <tonemapping_fragment>
#include <colorspace_fragment>`;

const SPRITE_VS = `
uniform float uCells;
attribute vec4 iPos; attribute vec4 iCol; attribute vec4 iMisc;
varying vec2 vUv; varying vec4 vCol; varying float vHot;
void main(){
  float c = cos(iMisc.x), s = sin(iMisc.x);
  vec2 p = position.xy * vec2(iPos.w * iMisc.z, iPos.w);
  p = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
  // billboard corner in world space (camera right/up from the view matrix rows)
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 wp = (modelMatrix * vec4(iPos.xyz, 1.0)).xyz + right * p.x + up * p.y;
  // corners that dip below the floor slide along their view ray back above it: same pixel,
  // no hard depth-clip line where big flashes / halos intersect the floor
  if (wp.y < 0.02) { vec3 tc = cameraPosition - wp; wp += tc * ((0.02 - wp.y) / max(tc.y, 1e-3)); }
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  float f = floor(iMisc.y + 0.5);
  float cx = mod(f, uCells), cy = floor(f / uCells);
  vUv = vec2((cx + uv.x) / uCells, (uCells - 1.0 - cy + uv.y) / uCells);
  vCol = iCol; vHot = iMisc.w;
}`;
const SPRITE_ADD_FS = `
uniform sampler2D uMap; uniform float uGain;
varying vec2 vUv; varying vec4 vCol; varying float vHot;
void main(){
  float a = texture2D(uMap, vUv).a;
  float k = a * vCol.a;
  float a2 = a * a;
  vec3 col = vCol.rgb * k + vec3(a2 * a2 * vHot * vCol.a);
  gl_FragColor = vec4(min(col * uGain, vec3(6.0)), 1.0);
  ${TONE}
}`;
const SPRITE_NRM_FS = `
uniform sampler2D uMap;
varying vec2 vUv; varying vec4 vCol; varying float vHot;
void main(){
  vec4 t = texture2D(uMap, vUv);
  float a = t.a * vCol.a;
  if (a < 0.002) discard;
  gl_FragColor = vec4(vCol.rgb * t.rgb * vCol.a, a);
  ${TONE}
}`;

const STREAK_VS = `
attribute vec4 iA; attribute vec4 iB; attribute vec4 iCol; attribute vec4 iMisc;
varying vec2 vP; varying float vL; varying vec4 vCol; varying vec4 vMisc; varying float vTail;
void main(){
  vec3 A = (modelMatrix * vec4(iA.xyz, 1.0)).xyz;
  vec3 B = (modelMatrix * vec4(iB.xyz, 1.0)).xyz;
  vec3 d = B - A; float L = length(d);
  vec3 dir = L > 1e-5 ? d / L : vec3(0.0, 0.0, 1.0);
  vec3 V = normalize(cameraPosition - (A + B) * 0.5);
  vec3 side = cross(dir, V); float sl = length(side);
  side = sl > 1e-4 ? side / sl : vec3(1.0, 0.0, 0.0);
  float hw = max(iA.w, 1e-4); float ext = hw * iMisc.w;
  float s = mix(-ext, L + ext, position.x);
  vec3 wp = A + dir * s + side * (position.y * ext);
  if (wp.y < 0.015) { vec3 tc = cameraPosition - wp; wp += tc * ((0.015 - wp.y) / max(tc.y, 1e-3)); }
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  vP = vec2(s, position.y * ext) / hw; vL = L / hw;
  vCol = iCol; vMisc = iMisc; vTail = iB.w;
}`;
const STREAK_FS = `
uniform float uTime; uniform float uGain;
varying vec2 vP; varying float vL; varying vec4 vCol; varying vec4 vMisc; varying float vTail;
void main(){
  float s = vP.x, c = vP.y;
  float ds = s < 0.0 ? -s : max(s - vL, 0.0);
  float d = length(vec2(ds, c));
  float along = vL > 0.001 ? clamp(s / vL, 0.0, 1.0) : 1.0;
  float tail = mix(vTail, 1.0, along);
  float st = vMisc.y;
  float body = 1.0 - smoothstep(0.3, 1.0, d);
  float glow = exp(-d * 1.7) * 0.42;
  float core = 1.0 - smoothstep(0.0, 0.5, d);
  if (st > 0.5 && st < 1.5) {
    float fl = 0.62 + 0.38 * sin(s * 0.21 - uTime * 43.0 + vMisc.z * 17.0);
    body *= fl; glow *= fl; core *= fl;
  } else if (st > 1.5 && st < 2.5) {
    float fl = 0.8 + 0.2 * sin(s * 0.7 - uTime * 55.0 + vMisc.z);
    body *= fl; core *= 0.82 + 0.18 * sin(s * 1.9 + uTime * 37.0);
  } else if (st > 2.5) {
    float edge = 1.0 - smoothstep(vMisc.w * 0.55, vMisc.w, abs(c));
    body = exp(-c * c * 1.3) * 0.7 * edge; core = exp(-c * c * 7.0); glow = exp(-abs(c) * 1.2) * 0.2 * edge;
    float e = (1.0 - smoothstep(vL * 0.45, vL, s)) * smoothstep(-1.0, 0.6, s);
    body *= e; core *= e; glow *= e;
  }
  float a = vCol.a * tail;
  float mx = max(max(vCol.r, vCol.g), max(vCol.b, 1e-3));
  vec3 sat = vCol.rgb * vCol.rgb / mx;
  vec3 col = (vCol.rgb * body + sat * glow * 1.3) * a + vec3(core * vMisc.x * a);
  gl_FragColor = vec4(min(col * uGain, vec3(6.0)), 1.0);
  ${TONE}
}`;

const DECAL_VS = `
attribute vec4 iP; attribute vec4 iS; attribute vec4 iCol; attribute vec4 iQ;
varying vec2 vL; varying vec4 vS; varying vec4 vCol; varying vec4 vQ;
void main(){
  vec2 lp = position.xy * iS.xy;
  float c = cos(iP.w), s = sin(iP.w);
  vec3 wp = vec3(iP.x + lp.x * c + lp.y * s, iP.y, iP.z - lp.x * s + lp.y * c);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(wp, 1.0);
  vL = lp; vS = iS; vCol = iCol; vQ = iQ;
}`;
const DECAL_FS = `
uniform float uTime; uniform float uGain;
varying vec2 vL; varying vec4 vS; varying vec4 vCol; varying vec4 vQ;
float sdBox(vec2 p, vec2 b){ vec2 q = abs(p) - b; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0); }
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y); }
void main(){
  float shape = vS.z;
  vec2 n = vL / vS.xy; float r = length(n);
  float I = 0.0;
  if (shape < 0.5) {                       // 0 glow blob
    float q = clamp(1.0 - r * r, 0.0, 1.0); I = q * q;
  } else if (shape < 1.5) {                // 1 warning disc: w=fill, q.x=pulse, q.y=R
    float R = vQ.y; float rm = length(vL);
    float dE = rm - R;
    float inside = 1.0 - smoothstep(-0.015, 0.015, dE);
    float edge = exp(-(dE * dE) / 0.0025) * (0.7 + 0.9 * vQ.x);
    float halo = exp(-max(dE, 0.0) * 9.0) * 0.16 * (1.0 - inside);
    float fr = vS.w * R;
    float fill = (1.0 - smoothstep(fr - 0.03, fr, rm)) * 0.26 * inside;
    float fe = rm - fr; float fillEdge = exp(-(fe * fe) / 0.0012) * 0.8 * inside * step(0.02, vS.w);
    float hatch = step(0.55, fract((vL.x + vL.y) * 2.6 - uTime * 0.7)) * 0.05 * inside;
    I = edge + halo + fill + fillEdge + 0.07 * inside + hatch;
  } else if (shape < 2.5) {                // 2 warning rect: w=fill x, q=(pulse,hx,hz,fill z)
    vec2 hb = vQ.yz;
    float sd = sdBox(vL, hb);
    float inside = 1.0 - smoothstep(-0.015, 0.015, sd);
    float edge = exp(-(sd * sd) / 0.0025) * (0.7 + 0.9 * vQ.x);
    float halo = exp(-max(sd, 0.0) * 9.0) * 0.16 * (1.0 - inside);
    float sdf = sdBox(vL, hb * vec2(vS.w, vQ.w));
    float fill = (1.0 - smoothstep(-0.03, 0.0, sdf)) * 0.26 * inside;
    float fillEdge = exp(-(sdf * sdf) / 0.0012) * 0.6 * inside * step(0.02, vS.w);
    float hatch = step(0.55, fract((vL.x + vL.y) * 2.6 - uTime * 0.7)) * 0.05 * inside;
    I = edge + halo + fill + fillEdge + 0.07 * inside + hatch;
  } else if (shape < 3.5) {                // 3 scorch (noisy dark)
    float nz = vnoise(n * 3.0 + vQ.xy) * 0.45 + vnoise(n * 7.0 + vQ.yx) * 0.2;
    I = 1.0 - smoothstep(0.25, 0.95, r + nz * 0.55 - 0.15);
  } else if (shape < 4.5) {                // 4 contact shadow
    I = exp(-r * r * 3.0) * (1.0 - smoothstep(0.75, 1.0, r));
  } else if (shape < 5.5) {                // 5 soft rect (w = softness m)
    float soft = max(vS.w, 0.01);
    float sd = sdBox(vL, vS.xy - vec2(soft));
    I = 1.0 - smoothstep(-soft, soft, sd);
  } else if (shape < 6.5) {                // 6 glow strip (gaussian across x)
    float ax = abs(n.x); I = exp(-ax * ax * 5.0) * (1.0 - smoothstep(0.8, 1.0, abs(n.y)));
  } else {                                 // 7 soft disc (w = edge softness fraction)
    I = 1.0 - smoothstep(1.0 - max(vS.w, 0.01), 1.0, r);
  }
  float a = I * vCol.a;
  if (a < 0.002) discard;
  gl_FragColor = vec4(vCol.rgb * a * uGain, a);
  ${TONE}
}`;

const BAND_VS = `
attribute vec4 iC; attribute vec4 iW; attribute vec4 iCol; attribute vec4 iS;
varying vec2 vB; varying float vHL; varying vec4 vCol; varying vec4 vS; varying float vAng; varying float vHw; varying float vMode; varying float vHalf;
void main(){
  float t = position.x, side = position.y;
  float ang = iW.y + (t * 2.0 - 1.0) * iW.z;
  vec2 dir = vec2(sin(ang), cos(ang));
  float hw = max(iW.x * 0.5, 0.005);
  float R = max(iC.w, 0.0);
  vec3 wp;
  if (iW.w < 0.5) {
    float pad = hw * 0.8 + 0.06;
    float rad = max(0.0, R + side * (hw + pad));
    wp = vec3(iC.x + dir.x * rad, iC.y, iC.z + dir.y * rad);
    vB.x = (rad - R) / hw;
  } else {
    wp = vec3(iC.x + dir.x * R, iC.y + (side * 0.5 + 0.5) * iS.y, iC.z + dir.y * R);
    vB.x = side * 0.5 + 0.5;
  }
  float Rm = max(R, 0.05);
  vB.y = (t * 2.0 - 1.0) * iW.z * Rm;
  vHL = iW.z * Rm; vHalf = iW.z;
  vCol = iCol; vS = iS; vAng = ang; vHw = hw; vMode = iW.w;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(wp, 1.0);
}`;
const BAND_FS = `
uniform float uTime; uniform float uGain;
varying vec2 vB; varying float vHL; varying vec4 vCol; varying vec4 vS; varying float vAng; varying float vHw; varying float vMode; varying float vHalf;
void main(){
  float st = vS.x; float x = vB.x;
  float endD = vHL - abs(vB.y);
  float full = step(3.13, vHalf);
  float endFade = mix(smoothstep(0.0, 0.28, endD), 1.0, full);
  float caps = (1.0 - full) * vS.w * exp(-endD * 10.0);
  float I = 0.0;
  if (vMode > 0.5) {                          // vertical curtain
    float h = x;
    I = pow(1.0 - h, 1.7) * 0.5 + exp(-h * 16.0) * 0.45;
    if (st > 0.5 && st < 1.5) I *= 0.7 + 0.3 * sin(h * 26.0 - uTime * 14.0);
    caps *= 1.0 - h;
  } else if (st < 0.5) {                      // 0 danger band: fill + bright leading edge
    float ax = abs(x);
    float inside = 1.0 - smoothstep(0.9, 1.0, ax);
    float lead = exp(-pow((x - 0.9) * vHw / 0.05, 2.0));
    float trail = exp(-pow((x + 0.9) * vHw / 0.05, 2.0)) * 0.5;
    float outer = exp(-max(ax - 1.0, 0.0) * vHw * 7.0) * 0.14 * step(1.0, ax);
    I = inside * 0.3 + lead * 1.15 + trail + outer;
  } else if (st < 1.5) {                      // 1 wi-fi: three stripes, leading brightest
    float s1 = exp(-pow((x - 0.72) / 0.17, 2.0)) * 1.1;
    float s2 = exp(-pow(x / 0.16, 2.0)) * 0.75;
    float s3 = exp(-pow((x + 0.72) / 0.15, 2.0)) * 0.5;
    float inside = 1.0 - smoothstep(0.92, 1.1, abs(x));
    I = s1 + s2 + s3 + inside * 0.24;
  } else if (st < 2.5) {                      // 2 thin ring
    I = exp(-x * x * 2.6);
  } else if (st < 3.5) {                      // 3 electric crackle
    float j = x - 0.42 * (sin(vAng * 29.0 + uTime * 31.0 + vS.z) * 0.6 + sin(vAng * 47.0 - uTime * 43.0) * 0.4);
    float flick = 0.55 + 0.45 * step(0.45, fract(vAng * 3.7 + uTime * 5.3 + sin(uTime * 13.0)));
    I = exp(-j * j * 10.0) * flick + exp(-x * x * 1.4) * 0.12;
  } else {                                    // 4 comet swirl
    float along = clamp(vB.y / max(vHL, 0.001) * 0.5 + 0.5, 0.0, 1.0);
    I = exp(-x * x * 2.4) * along * along;
  }
  I = I * endFade + caps;
  float a = I * vCol.a;
  gl_FragColor = vec4(min(vCol.rgb * a * uGain, vec3(6.0)), 1.0);
  ${TONE}
}`;

const ORB_VS = `
attribute vec4 iP; attribute vec4 iCol;
varying vec3 vN; varying vec3 vV; varying vec4 vCol; varying vec3 vLoc;
void main(){
  vec3 wp = iP.xyz + position * iP.w;
  vec4 mv = modelViewMatrix * vec4(wp, 1.0);
  vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
  vCol = iCol; vLoc = position;
  gl_Position = projectionMatrix * mv;
}`;
const ORB_FS = `
uniform float uTime;
varying vec3 vN; varying vec3 vV; varying vec4 vCol; varying vec3 vLoc;
void main(){
  vec3 N = normalize(vN), V = normalize(vV);
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float fres = pow(1.0 - ndv, 2.0);
  vec3 c = vCol.rgb;
  float sw = 0.5 + 0.5 * sin(vLoc.y * 8.0 + atan(vLoc.x, vLoc.z) * 3.0 - uTime * 5.0);
  vec3 inner = c * (0.42 + 0.14 * sw + 0.2 * (vLoc.y * 0.5 + 0.5));
  vec3 rim = c * 2.2 * fres;
  vec3 L = normalize(vec3(-0.45, 0.75, 0.5)); vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), 70.0) * 1.8;
  vec3 col = (inner + rim) * (0.55 + 0.75 * vCol.a) + vec3(spec);
  gl_FragColor = vec4(col, 1.0);
  ${TONE}
}`;

const SHIELD_VS = `
varying vec3 vN; varying vec3 vV; varying vec3 vO;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); vO = position;
  gl_Position = projectionMatrix * mv;
}`;
const SHIELD_FS = `
uniform float uTime; uniform float uAlpha; uniform float uFlash; uniform float uHex; uniform vec3 uColor;
varying vec3 vN; varying vec3 vV; varying vec3 vO;
float hexEdge(vec2 p){
  vec2 r = vec2(1.0, 1.7320508); vec2 h = r * 0.5;
  vec2 a = mod(p, r) - h; vec2 b = mod(p - h, r) - h;
  vec2 g = dot(a, a) < dot(b, b) ? a : b;
  vec2 q = abs(g);
  float d = max(dot(q, normalize(r)), q.x);
  return smoothstep(0.38, 0.48, d);
}
void main(){
  vec3 N = normalize(vN), V = normalize(vV);
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float fres = pow(1.0 - ndv, 2.6);
  float hx = hexEdge(N.xy * 4.2 + vec2(0.0, uTime * 0.12)) * uHex;
  float scan = exp(-pow(fract(vO.y * 0.55 - uTime * 0.7) - 0.5, 2.0) * 90.0);
  float rim = smoothstep(0.55, 1.0, 1.0 - ndv);
  float I = fres * 1.3 + rim * 0.9 + hx * (0.06 + 0.7 * fres + scan * 0.55) + 0.02 + scan * 0.05 + uFlash * (0.12 + hx * 0.7 + fres * 0.9);
  vec3 col = mix(uColor, vec3(1.0), 0.35 * rim);
  gl_FragColor = vec4(col * I * uAlpha, 1.0);
  ${TONE}
}`;

const NUM_VS = `
attribute vec4 iPos; attribute vec4 iG; attribute vec4 iCol; attribute vec4 iM;
varying vec2 vUv; varying vec4 vG; varying vec4 vCol; varying float vN;
void main(){
  vec4 mv = modelViewMatrix * vec4(iPos.xyz, 1.0);
  float n = max(iM.x, 1.0);
  mv.xy += position.xy * vec2(iPos.w * 0.6 * n, iPos.w);
  gl_Position = projectionMatrix * mv;
  vUv = uv; vG = iG; vCol = iCol; vN = n;
}`;
const NUM_FS = `
uniform sampler2D uMap; uniform float uCells;
varying vec2 vUv; varying vec4 vG; varying vec4 vCol; varying float vN;
void main(){
  float fx = vUv.x * vN; float cell = floor(fx); float lx = fract(fx);
  float g = cell < 0.5 ? vG.x : (cell < 1.5 ? vG.y : (cell < 2.5 ? vG.z : vG.w));
  float cx = mod(g, uCells), cy = floor(g / uCells);
  vec2 uv = vec2((cx + 0.2 + lx * 0.6) / uCells, (uCells - 1.0 - cy + vUv.y) / uCells);
  vec2 gx = vec2(dFdx(vUv.x) * vN * 0.6, dFdx(vUv.y)) / uCells;
  vec2 gy = vec2(dFdy(vUv.x) * vN * 0.6, dFdy(vUv.y)) / uCells;
  vec4 t = textureGrad(uMap, uv, gx, gy);
  float a = t.a * vCol.a;
  if (a < 0.003) discard;
  gl_FragColor = vec4(t.rgb * vCol.rgb * vCol.a, a);
  ${TONE}
}`;

// ------------------------------------------------------------------ atlas
function buildAtlas() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = CELLS * CELL;
  const ctx = cv.getContext('2d');
  let seed = 1234567;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const OUT = '#0a0d20';
  function cell(f, fn) {
    const cx = f % CELLS, cy = Math.floor(f / CELLS);
    ctx.save(); ctx.translate(cx * CELL, cy * CELL);
    ctx.beginPath(); ctx.rect(0, 0, CELL, CELL); ctx.clip();
    fn(ctx); ctx.restore();
  }
  function radial(c, stops, r = 62) {
    const g = c.createRadialGradient(64, 64, 0, 64, 64, r);
    for (const [o, a] of stops) g.addColorStop(o, `rgba(255,255,255,${a})`);
    c.fillStyle = g; c.fillRect(0, 0, 128, 128);
  }
  cell(F.SOFT, (c) => radial(c, [[0, 1], [0.2, 0.62], [0.45, 0.22], [0.7, 0.06], [1, 0]]));
  cell(F.HOT, (c) => radial(c, [[0, 1], [0.14, 0.95], [0.24, 0.5], [0.45, 0.14], [0.75, 0.03], [1, 0]]));
  cell(F.STAR, (c) => {
    c.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 2; k++) {
      c.save(); c.translate(64, 64); c.rotate(k * Math.PI / 2);
      const g = c.createLinearGradient(-60, 0, 60, 0);
      g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g; c.beginPath(); c.moveTo(-60, 0); c.lineTo(0, -7); c.lineTo(60, 0); c.lineTo(0, 7); c.closePath(); c.fill();
      c.restore();
    }
    const g = c.createRadialGradient(64, 64, 0, 64, 64, 22);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(0, 0, 128, 128);
  });
  cell(F.RING, (c) => {
    c.shadowColor = '#fff'; c.shadowBlur = 8; c.strokeStyle = '#fff'; c.lineWidth = 7;
    c.beginPath(); c.arc(64, 64, 50, 0, TAU); c.stroke(); c.stroke();
  });
  cell(F.FLARE, (c) => {
    c.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 6; k++) {
      c.save(); c.translate(64, 64); c.rotate(k * Math.PI / 3 + 0.2);
      const L = k % 2 ? 44 : 60;
      const g = c.createLinearGradient(0, 0, L, 0);
      g.addColorStop(0, 'rgba(255,255,255,0.9)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g; c.beginPath(); c.moveTo(0, -6); c.lineTo(L, 0); c.lineTo(0, 6); c.closePath(); c.fill();
      c.restore();
    }
    const g = c.createRadialGradient(64, 64, 0, 64, 64, 30);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.4, 'rgba(255,255,255,0.6)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(0, 0, 128, 128);
  });
  const puff = (c, n, a) => {
    for (let i = 0; i < n; i++) {
      const x = 64 + (rnd() - 0.5) * 44, y = 64 + (rnd() - 0.5) * 44, r = 20 + rnd() * 20;
      const g = c.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(255,255,255,${a})`); g.addColorStop(0.6, `rgba(255,255,255,${a * 0.5})`); g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill();
    }
  };
  cell(F.SMOKE, (c) => puff(c, 11, 0.32));
  cell(F.DUST, (c) => { puff(c, 26, 0.16); radial(c, [[0, 0.35], [0.5, 0.15], [1, 0]], 50); });
  cell(F.DOT, (c) => radial(c, [[0, 1], [0.3, 1], [0.5, 0.45], [0.75, 0.1], [1, 0]], 40));
  cell(F.SQUARE, (c) => { c.fillStyle = '#fff'; c.fillRect(34, 20, 60, 88); });
  cell(F.BUBBLE, (c) => {
    // chat bubble: white/pink body, magenta outline, tail, typing dots, red badge
    const body = () => {
      c.beginPath();
      const x0 = 12, y0 = 28, x1 = 108, y1 = 86, r = 22;
      c.moveTo(x0 + r, y0); c.lineTo(x1 - r, y0); c.quadraticCurveTo(x1, y0, x1, y0 + r);
      c.lineTo(x1, y1 - r); c.quadraticCurveTo(x1, y1, x1 - r, y1);
      c.lineTo(46, y1); c.lineTo(24, 108); c.lineTo(30, y1);
      c.lineTo(x0 + r, y1); c.quadraticCurveTo(x0, y1, x0, y1 - r);
      c.lineTo(x0, y0 + r); c.quadraticCurveTo(x0, y0, x0 + r, y0); c.closePath();
    };
    body(); c.lineWidth = 10; c.strokeStyle = '#3a0626'; c.stroke();
    const g = c.createLinearGradient(0, 28, 0, 90); g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#ffd0ee');
    body(); c.fillStyle = g; c.fill(); c.lineWidth = 5; c.strokeStyle = '#ff3ec8'; c.stroke();
    c.fillStyle = '#ff3ec8';
    for (let i = 0; i < 3; i++) { c.beginPath(); c.arc(40 + i * 20, 57, 7, 0, TAU); c.fill(); }
    c.beginPath(); c.arc(100, 26, 19, 0, TAU); c.fillStyle = '#3a0010'; c.fill();
    c.beginPath(); c.arc(100, 26, 15, 0, TAU); c.fillStyle = '#ff1f3d'; c.fill();
    c.fillStyle = '#fff'; c.fillRect(97, 16, 6, 14); c.fillRect(97, 33, 6, 5);
  });
  cell(F.CRACKLE, (c) => {
    c.strokeStyle = '#fff'; c.lineWidth = 4; c.shadowColor = '#fff'; c.shadowBlur = 7; c.lineJoin = 'round';
    for (let k = 0; k < 6; k++) {
      const a0 = k / 6 * TAU + rnd() * 0.5;
      c.beginPath(); c.moveTo(64, 64);
      for (let s = 1; s <= 5; s++) {
        const rr = s * 11.5, aa = a0 + (rnd() - 0.5) * 0.9;
        c.lineTo(64 + Math.cos(aa) * rr, 64 + Math.sin(aa) * rr);
      }
      c.stroke();
    }
  });
  cell(F.PLUS, (c) => {
    c.shadowColor = '#fff'; c.shadowBlur = 10; c.fillStyle = '#fff';
    c.fillRect(52, 20, 24, 88); c.fillRect(20, 52, 88, 24);
  });
  cell(F.HEX, (c) => {
    c.strokeStyle = '#fff'; c.lineWidth = 8; c.shadowColor = '#fff'; c.shadowBlur = 6;
    c.beginPath(); for (let k = 0; k < 6; k++) { const a = k / 6 * TAU + Math.PI / 6; c.lineTo(64 + Math.cos(a) * 44, 64 + Math.sin(a) * 44); } c.closePath(); c.stroke();
  });
  cell(F.SOFTRING, (c) => radial(c, [[0, 0], [0.5, 0.0], [0.78, 1], [0.9, 0.35], [1, 0]]));
  cell(F.SHARD, (c) => { c.fillStyle = '#fff'; c.beginPath(); c.moveTo(64, 10); c.lineTo(84, 70); c.lineTo(64, 118); c.lineTo(46, 64); c.closePath(); c.fill(); });
  const heartPath = (c, s, ox, oy) => {
    c.beginPath(); c.moveTo(ox, oy + 30 * s);
    c.bezierCurveTo(ox - 8 * s, oy + 22 * s, ox - 40 * s, oy + 4 * s, ox - 38 * s, oy - 14 * s);
    c.bezierCurveTo(ox - 36 * s, oy - 34 * s, ox - 10 * s, oy - 38 * s, ox, oy - 18 * s);
    c.bezierCurveTo(ox + 10 * s, oy - 38 * s, ox + 36 * s, oy - 34 * s, ox + 38 * s, oy - 14 * s);
    c.bezierCurveTo(ox + 40 * s, oy + 4 * s, ox + 8 * s, oy + 22 * s, ox, oy + 30 * s); c.closePath();
  };
  cell(F.HEART, (c) => { heartPath(c, 1.3, 64, 62); c.fillStyle = '#fff'; c.fill(); });

  // ---- pickup icons: white glyph, dark outline
  const icon = (f, draw) => cell(f, (c) => {
    c.lineCap = 'round'; c.lineJoin = 'round';
    c.save(); c.strokeStyle = OUT; c.fillStyle = OUT; draw(c, true); c.restore();
    c.save(); c.strokeStyle = '#fff'; c.fillStyle = '#fff'; draw(c, false); c.restore();
  });
  const LW = (c, o, w) => { c.lineWidth = o ? w + 12 : w; };
  const fillS = (c, o) => { c.fill(); if (o) { c.lineWidth = 12; c.stroke(); } };
  icon(F.ICON + 0, (c, o) => { // dmg: heavy slug
    c.beginPath(); c.moveTo(44, 100); c.lineTo(44, 56); c.quadraticCurveTo(44, 18, 64, 14); c.quadraticCurveTo(84, 18, 84, 56); c.lineTo(84, 100); c.closePath(); fillS(c, o);
    c.beginPath(); c.rect(38, 96, 52, 14); fillS(c, o);
    if (!o) { c.fillStyle = OUT; c.fillRect(44, 80, 40, 6); }
  });
  icon(F.ICON + 1, (c, o) => { // rate: stopwatch
    LW(c, o, 9); c.beginPath(); c.arc(64, 72, 34, 0, TAU); c.stroke();
    c.beginPath(); c.rect(56, 22, 16, 12); fillS(c, o);
    LW(c, o, 8); c.beginPath(); c.moveTo(64, 72); c.lineTo(64, 50); c.moveTo(64, 72); c.lineTo(80, 80); c.stroke();
    LW(c, o, 7); c.beginPath(); c.moveTo(92, 34); c.lineTo(100, 26); c.stroke();
  });
  icon(F.ICON + 2, (c, o) => { // multi: split fan
    LW(c, o, 9);
    const tips = [[26, 38], [64, 20], [102, 38]];
    for (const [x, y] of tips) { c.beginPath(); c.moveTo(64, 108); c.lineTo(x, y); c.stroke(); }
    for (const [x, y] of tips) {
      const a = Math.atan2(y - 108, x - 64);
      c.beginPath(); c.moveTo(x + Math.cos(a) * 10, y + Math.sin(a) * 10);
      c.lineTo(x + Math.cos(a + 2.5) * 16, y + Math.sin(a + 2.5) * 16);
      c.lineTo(x + Math.cos(a - 2.5) * 16, y + Math.sin(a - 2.5) * 16); c.closePath(); fillS(c, o);
    }
  });
  icon(F.ICON + 3, (c, o) => { // pierce: arrow through a wall
    c.beginPath(); c.rect(56, 18, 16, 30); fillS(c, o);
    c.beginPath(); c.rect(56, 80, 16, 30); fillS(c, o);
    LW(c, o, 10); c.beginPath(); c.moveTo(16, 64); c.lineTo(94, 64); c.stroke();
    c.beginPath(); c.moveTo(112, 64); c.lineTo(88, 48); c.lineTo(88, 80); c.closePath(); fillS(c, o);
  });
  icon(F.ICON + 4, (c, o) => { // armor: shield
    c.beginPath(); c.moveTo(64, 16); c.lineTo(102, 30); c.lineTo(100, 64); c.quadraticCurveTo(96, 96, 64, 112); c.quadraticCurveTo(32, 96, 28, 64); c.lineTo(26, 30); c.closePath(); fillS(c, o);
    if (!o) { c.fillStyle = OUT; c.fillRect(58, 40, 12, 48); c.fillRect(40, 58, 48, 12); }
  });
  icon(F.ICON + 5, (c, o) => { // heal: heart + plus
    heartPath(c, 1.18, 64, 66); fillS(c, o);
    if (!o) { c.fillStyle = OUT; c.fillRect(58, 44, 12, 36); c.fillRect(46, 56, 36, 12); }
  });
  icon(F.ICON + 6, (c, o) => { // dash: chevrons + speed lines
    LW(c, o, 10);
    c.beginPath(); c.moveTo(56, 30); c.lineTo(88, 64); c.lineTo(56, 98); c.stroke();
    c.beginPath(); c.moveTo(80, 30); c.lineTo(112, 64); c.lineTo(80, 98); c.stroke();
    LW(c, o, 8);
    c.beginPath(); c.moveTo(14, 46); c.lineTo(40, 46); c.moveTo(8, 64); c.lineTo(44, 64); c.moveTo(14, 82); c.lineTo(40, 82); c.stroke();
  });
  icon(F.ICON + 7, (c, o) => { // pulse: nova rings
    c.beginPath(); c.arc(64, 64, 12, 0, TAU); fillS(c, o);
    LW(c, o, 8); c.beginPath(); c.arc(64, 64, 30, 0, TAU); c.stroke();
    LW(c, o, 7);
    for (let k = 0; k < 4; k++) { c.beginPath(); c.arc(64, 64, 48, k * Math.PI / 2 + 0.3, k * Math.PI / 2 + 1.27); c.stroke(); }
  });
  icon(F.ICON + 8, (c, o) => { // aura: ring + lightning
    LW(c, o, 7); c.beginPath(); c.arc(64, 64, 46, 0, TAU); c.stroke();
    c.beginPath(); c.moveTo(70, 24); c.lineTo(46, 68); c.lineTo(62, 68); c.lineTo(56, 104); c.lineTo(84, 56); c.lineTo(68, 56); c.lineTo(76, 24); c.closePath(); fillS(c, o);
  });
  icon(F.ICON + 9, (c, o) => { // gem
    c.beginPath(); c.moveTo(30, 50); c.lineTo(46, 26); c.lineTo(82, 26); c.lineTo(98, 50); c.lineTo(64, 106); c.closePath(); fillS(c, o);
    if (!o) {
      c.strokeStyle = OUT; c.lineWidth = 4;
      c.beginPath(); c.moveTo(30, 50); c.lineTo(98, 50); c.moveTo(52, 50); c.lineTo(64, 106); c.lineTo(76, 50); c.moveTo(46, 26); c.lineTo(52, 50); c.moveTo(82, 26); c.lineTo(76, 50); c.stroke();
    }
  });
  icon(F.ICON + 10, (c, o) => { // bolt
    c.beginPath(); c.moveTo(74, 12); c.lineTo(34, 70); c.lineTo(60, 70); c.lineTo(50, 116); c.lineTo(94, 52); c.lineTo(68, 52); c.lineTo(84, 12); c.closePath(); fillS(c, o);
  });
  icon(F.ICON + 11, (c, o) => { // ward: hex bubble
    LW(c, o, 9);
    c.beginPath(); for (let k = 0; k < 6; k++) { const a = k / 6 * TAU + Math.PI / 6; c.lineTo(64 + Math.cos(a) * 46, 64 + Math.sin(a) * 46); } c.closePath(); c.stroke();
    c.beginPath(); for (let k = 0; k < 6; k++) { const a = k / 6 * TAU + Math.PI / 6; c.lineTo(64 + Math.cos(a) * 20, 64 + Math.sin(a) * 20); } c.closePath(); fillS(c, o);
  });
  icon(F.ICON + 12, (c, o) => { // mag: horseshoe magnet
    c.lineCap = 'butt'; LW(c, o, 20);
    c.beginPath(); c.moveTo(34, 100); c.lineTo(34, 58); c.arc(64, 58, 30, Math.PI, 0); c.lineTo(94, 100); c.stroke();
    if (!o) { c.fillStyle = OUT; c.fillRect(22, 84, 24, 5); c.fillRect(82, 84, 24, 5); }
  });
  // ---- digits and glyphs: white fill, dark outline
  const glyph = (f, ch) => cell(f, (c) => {
    c.font = 'bold 104px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.lineJoin = 'round'; c.lineWidth = 16; c.strokeStyle = '#140a18';
    c.strokeText(ch, 64, 70); c.fillStyle = '#fff'; c.fillText(ch, 64, 70);
  });
  for (let d = 0; d < 10; d++) glyph(F.DIGIT + d, String(d));
  glyph(F.GDOT, '.'); glyph(F.GPLUS, '+'); glyph(F.GX, 'x');

  const tex = new THREE.CanvasTexture(cv);
  tex.premultiplyAlpha = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// ------------------------------------------------------------------ instanced shader system
class InstSys {
  constructor(base, cap, names, material, renderOrder) {
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    for (const k in base.attributes) g.setAttribute(k, base.attributes[k]);
    this.cap = cap; this.names = names;
    this.gpu = []; this.imm = []; this.attrs = []; this.ranges = [];
    for (const nm of names) {
      const arr = new Float32Array(cap * 4);
      const at = new THREE.InstancedBufferAttribute(arr, 4); at.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute(nm, at);
      this.gpu.push(arr); this.imm.push(new Float32Array(cap * 4)); this.attrs.push(at); this.ranges.push({ start: 0, count: 0 });
    }
    g.instanceCount = 0;
    this.geo = g; this.n = 0; this.nImm = 0; this.cur = this.imm;
    this.acc = 0; this.loadImm = 0; this.budget = 0; this.gain = 1; this.gainT = 1;
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = renderOrder; this.mesh.visible = false;
    this.mat = material;
  }
  beginImm() { this.nImm = 0; this.acc = 0; this.cur = this.imm; }
  // index for next instance in the current target (imm during sync, gpu during flush).
  // Callers add their glow "load" to this.acc directly (no double args -> no boxing).
  add() {
    if (this.cur === this.imm) return this.nImm < this.cap ? this.nImm++ : -1;
    return this.n < this.cap ? this.n++ : -1;
  }
  put(k, i, a, b, c, d) { const arr = this.cur[k]; const o = i * 4; arr[o] = a; arr[o + 1] = b; arr[o + 2] = c; arr[o + 3] = d; }
  beginFlush() {
    if (this.cur === this.imm) this.loadImm = this.acc;
    const m = this.nImm * 4;
    for (let k = 0; k < this.gpu.length; k++) { const s = this.imm[k], d = this.gpu[k]; for (let j = 0; j < m; j++) d[j] = s[j]; }
    this.n = this.nImm; this.acc = this.loadImm; this.cur = this.gpu;
  }
  endFlush() {
    const n = this.n;
    for (let k = 0; k < this.attrs.length; k++) {
      const at = this.attrs[k], rg = this.ranges[k];
      rg.start = 0; rg.count = n * 4;
      if (at.updateRanges.indexOf(rg) < 0) at.updateRanges.push(rg);
      at.needsUpdate = true;
    }
    this.geo.instanceCount = n;
    this.mesh.visible = n > 0;
    this.gainT = this.budget > 0 && this.acc > this.budget ? this.budget / this.acc : 1;
    this.cur = this.imm;
  }
  clear() { this.n = 0; this.nImm = 0; this.geo.instanceCount = 0; this.mesh.visible = false; }
}

class Pool {
  constructor(cap, make) { this.a = new Array(cap); for (let i = 0; i < cap; i++) this.a[i] = make(); this.n = 0; this.cap = cap; this.rr = 0; }
  get() { if (this.n < this.cap) return this.a[this.n++]; this.rr = (this.rr + 7) % this.cap; return this.a[this.rr]; }
  kill(i) { const l = --this.n; if (i !== l) { const t = this.a[i]; this.a[i] = this.a[l]; this.a[l] = t; } }
  clear() { this.n = 0; }
}

// ------------------------------------------------------------------ main factory
export function createFX(scene, camera, opts = {}) {
  const root = new THREE.Group(); root.name = 'fx'; scene.add(root);
  const atlas = buildAtlas();
  const U = { uTime: { value: 0 } };

  // --- base geometries
  const quad = new THREE.PlaneGeometry(1, 1);
  const streakBase = new THREE.BufferGeometry();
  streakBase.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3));
  streakBase.setIndex([0, 1, 2, 0, 2, 3]);
  const decalBase = new THREE.BufferGeometry();
  decalBase.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  decalBase.setIndex([0, 2, 1, 0, 3, 2]);
  const SEG = 56;
  const bandPos = [], bandIdx = [];
  for (let i = 0; i <= SEG; i++) { bandPos.push(i / SEG, -1, 0, i / SEG, 1, 0); }
  for (let i = 0; i < SEG; i++) { const a = i * 2; bandIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const bandBase = new THREE.BufferGeometry();
  bandBase.setAttribute('position', new THREE.Float32BufferAttribute(bandPos, 3)); bandBase.setIndex(bandIdx);

  // --- materials
  const addBlend = (m) => {
    m.transparent = true; m.depthWrite = false; m.blending = THREE.CustomBlending;
    m.blendEquation = THREE.AddEquation; m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneFactor;
    m.blendSrcAlpha = THREE.ZeroFactor; m.blendDstAlpha = THREE.OneFactor; return m;
  };
  const preBlend = (m) => {
    m.transparent = true; m.depthWrite = false; m.blending = THREE.CustomBlending;
    m.blendEquation = THREE.AddEquation; m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor;
    m.blendSrcAlpha = THREE.OneFactor; m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor; return m;
  };
  const mk = (vs, fs, extra) => new THREE.ShaderMaterial({
    vertexShader: vs, fragmentShader: fs,
    uniforms: Object.assign({ uTime: U.uTime, uGain: { value: 1 }, uMap: { value: atlas }, uCells: { value: CELLS } }, extra || {}),
    fog: false, toneMapped: true,
  });
  const mSprA = addBlend(mk(SPRITE_VS, SPRITE_ADD_FS));
  const mSprN = preBlend(mk(SPRITE_VS, SPRITE_NRM_FS));
  const mStreak = addBlend(mk(STREAK_VS, STREAK_FS)); mStreak.side = THREE.DoubleSide;
  const mDecA = addBlend(mk(DECAL_VS, DECAL_FS)); mDecA.side = THREE.DoubleSide;
  const mDecN = preBlend(mk(DECAL_VS, DECAL_FS)); mDecN.side = THREE.DoubleSide;
  mDecA.polygonOffset = mDecN.polygonOffset = true; mDecA.polygonOffsetFactor = mDecN.polygonOffsetFactor = -2; mDecA.polygonOffsetUnits = mDecN.polygonOffsetUnits = -4;
  const mBand = addBlend(mk(BAND_VS, BAND_FS)); mBand.side = THREE.DoubleSide;
  const mNum = preBlend(mk(NUM_VS, NUM_FS)); mNum.depthTest = false;
  const mOrb = new THREE.ShaderMaterial({ vertexShader: ORB_VS, fragmentShader: ORB_FS, uniforms: { uTime: U.uTime }, fog: false });
  const mShield = addBlend(new THREE.ShaderMaterial({
    vertexShader: SHIELD_VS, fragmentShader: SHIELD_FS, fog: false,
    uniforms: { uTime: U.uTime, uAlpha: { value: 1 }, uFlash: { value: 0 }, uHex: { value: 1 }, uColor: { value: new THREE.Color().setRGB(C_SHIELD[0] * 1.3, C_SHIELD[1] * 1.3, C_SHIELD[2] * 1.3) } },
  }));

  // --- systems (render order: shadows < floor glow < bands < normal sprites < additive < streaks < numbers)
  const decN = new InstSys(decalBase, 520, ['iP', 'iS', 'iCol', 'iQ'], mDecN, 1);
  const decA = new InstSys(decalBase, 520, ['iP', 'iS', 'iCol', 'iQ'], mDecA, 2);
  const band = new InstSys(bandBase, 200, ['iC', 'iW', 'iCol', 'iS'], mBand, 3);
  const sprN = new InstSys(quad, 640, ['iPos', 'iCol', 'iMisc'], mSprN, 5);
  const sprA = new InstSys(quad, 1500, ['iPos', 'iCol', 'iMisc'], mSprA, 6);
  const strk = new InstSys(streakBase, 1000, ['iA', 'iB', 'iCol', 'iMisc'], mStreak, 7);
  const nums = new InstSys(quad, 72, ['iPos', 'iG', 'iCol', 'iM'], mNum, 30);
  const SYS = [decN, decA, band, sprN, sprA, strk];
  decN.mesh.name = 'fx.darkDecals'; decA.mesh.name = 'fx.glowDecals'; band.mesh.name = 'fx.bands'; sprN.mesh.name = 'fx.sprites';
  sprA.mesh.name = 'fx.glowSprites'; strk.mesh.name = 'fx.streaks'; nums.mesh.name = 'fx.numbers';
  sprA.budget = 110; decA.budget = 70; band.budget = 110; strk.budget = 0; decN.budget = 0; sprN.budget = 0;
  for (const s of SYS) root.add(s.mesh);
  root.add(nums.mesh);

  // --- lit instanced meshes: debris, gems, hearts, orbs, shield
  function emissivePatch(mat, uniformK) {
    mat.onBeforeCompile = (sh) => {
      if (uniformK) sh.uniforms.uEmitK = uniformK;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aEmit;\nvarying float vEmit;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEmit = aEmit;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vEmit;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n#ifdef USE_COLOR\ntotalEmissiveRadiance += vColor.rgb * vEmit;\n#endif');
    };
  }
  const DEB_CAP = 520;
  const debGeo = new THREE.CylinderGeometry(0.6, 0.6, 1, 3, 1);
  debGeo.setAttribute('aEmit', new THREE.InstancedBufferAttribute(new Float32Array(DEB_CAP), 1));
  const debMat = new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0.2, flatShading: true });
  emissivePatch(debMat);
  const debMesh = new THREE.InstancedMesh(debGeo, debMat, DEB_CAP);
  debMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(DEB_CAP * 3), 3);
  debMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); debMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  debMesh.frustumCulled = false; debMesh.count = 0; debMesh.visible = false; debMesh.name = 'fx.debris'; root.add(debMesh);

  const GEM_CAP = 220;
  const gemGeo = new THREE.OctahedronGeometry(1, 0);
  gemGeo.setAttribute('aEmit', new THREE.InstancedBufferAttribute(new Float32Array(GEM_CAP).fill(0.9), 1));
  const gemMat = new THREE.MeshStandardMaterial({ roughness: 0.12, metalness: 0.35, flatShading: true, envMapIntensity: 1.6 });
  emissivePatch(gemMat);
  const gemMesh = new THREE.InstancedMesh(gemGeo, gemMat, GEM_CAP);
  gemMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(GEM_CAP * 3), 3);
  gemMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  gemMesh.frustumCulled = false; gemMesh.count = 0; gemMesh.visible = false; gemMesh.name = 'fx.gems'; root.add(gemMesh);

  const HEART_CAP = 16;
  const hs = new THREE.Shape();
  hs.moveTo(0, -0.5);
  hs.bezierCurveTo(-0.12, -0.36, -0.56, -0.08, -0.52, 0.2);
  hs.bezierCurveTo(-0.48, 0.48, -0.12, 0.52, 0, 0.26);
  hs.bezierCurveTo(0.12, 0.52, 0.48, 0.48, 0.52, 0.2);
  hs.bezierCurveTo(0.56, -0.08, 0.12, -0.36, 0, -0.5);
  const heartGeo = new THREE.ExtrudeGeometry(hs, { depth: 0.16, bevelEnabled: true, bevelThickness: 0.12, bevelSize: 0.1, bevelSegments: 4, curveSegments: 14 });
  heartGeo.center();
  const heartMat = new THREE.MeshPhysicalMaterial({ color: 0xff1f4a, emissive: 0xff0a3c, emissiveIntensity: 0.55, roughness: 0.18, metalness: 0.05, clearcoat: 1, clearcoatRoughness: 0.08 });
  const heartMesh = new THREE.InstancedMesh(heartGeo, heartMat, HEART_CAP);
  heartMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  heartMesh.frustumCulled = false; heartMesh.count = 0; heartMesh.visible = false; heartMesh.name = 'fx.hearts'; root.add(heartMesh);

  const ORB_CAP = 24;
  const orbSphere = new THREE.SphereGeometry(1, 28, 18);
  const orbGeo = new THREE.InstancedBufferGeometry();
  orbGeo.index = orbSphere.index;
  for (const k in orbSphere.attributes) orbGeo.setAttribute(k, orbSphere.attributes[k]);
  const orbP = new THREE.InstancedBufferAttribute(new Float32Array(ORB_CAP * 4), 4).setUsage(THREE.DynamicDrawUsage);
  const orbC = new THREE.InstancedBufferAttribute(new Float32Array(ORB_CAP * 4), 4).setUsage(THREE.DynamicDrawUsage);
  orbGeo.setAttribute('iP', orbP); orbGeo.setAttribute('iCol', orbC); orbGeo.instanceCount = 0;
  const orbMesh = new THREE.Mesh(orbGeo, mOrb); orbMesh.frustumCulled = false; orbMesh.visible = false; orbMesh.name = 'fx.orbs'; root.add(orbMesh);

  const shieldMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 24), mShield);
  shieldMesh.frustumCulled = false; shieldMesh.visible = false; shieldMesh.renderOrder = 8; shieldMesh.name = 'fx.shield'; root.add(shieldMesh);

  // --- particle pools
  const mkSprite = () => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, g: 0, drag: 0, age: 0, life: 1, s0: 1, s1: 1, cr: 1, cg: 1, cb: 1, a: 1, rot: 0, vrot: 0, frame: 0, aspect: 1, hot: 0, hold: 0, fi: 0, floor: -99, bounce: 0, flutter: 0, fph: 0 });
  const mkStreak = () => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, g: 0, drag: 0, age: 0, life: 1, w0: 0.03, w1: 0, stretch: 0.03, minL: 0.02, maxL: 0.6, cr: 1, cg: 1, cb: 1, a: 1, hot: 0, style: 0, glow: 2.4, tail: 0, bounce: 0.3, fixed: false, ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, hold: 0, seed: 0 });
  const mkDebris = () => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, q: new THREE.Quaternion(), wx: 0, wy: 0, wz: 0, sx: 0.1, sy: 0.1, sz: 0.1, cr: 1, cg: 1, cb: 1, emit: 0, age: 0, life: 1, g: 18, bounce: 0.35, rest: false });
  const mkBand = () => ({ x: 0, y: 0, z: 0, R0: 0, R1: 1, w0: 0.2, w1: 0.1, a: 0, half: Math.PI, mode: 0, style: 0, h0: 0.5, h1: 0.5, cr: 1, cg: 1, cb: 1, al: 1, age: 0, life: 0.4, ease: 2, caps: 0, spin: 0, hold: 0 });
  const mkDecal = () => ({ x: 0, y: 0, z: 0, rot: 0, sx0: 1, sz0: 1, sx1: 1, sz1: 1, shape: 0, p0: 0, q0: 0, q1: 0, q2: 0, q3: 0, cr: 1, cg: 1, cb: 1, al: 1, age: 0, life: 1, hold: 0, fi: 0 });
  const mkNum = () => ({ x: 0, y: 0, z: 0, g0: 0, g1: 0, g2: 0, g3: 0, n: 1, crit: false, age: 0, life: 0.7, val: 0, id: -1 });
  const mkSeq = () => ({ type: '', age: 0, dur: 1, x: 0, z: 0, kind: '', stage: 0, acc: 0, r: 1 });
  const PA = new Pool(900, mkSprite);     // additive sprite particles
  const PN = new Pool(360, mkSprite);     // normal sprite particles (smoke/dust/confetti)
  const PS = new Pool(640, mkStreak);     // streak particles (sparks, lightning, trails)
  const PD = new Pool(DEB_CAP, mkDebris); // debris shards
  const PBD = new Pool(80, mkBand);        // timed bands (rings, novas)
  const PDA = new Pool(160, mkDecal);     // timed additive decals
  const PDN = new Pool(160, mkDecal);     // timed dark decals (scorch, craters)
  const PNUM = new Pool(nums.cap, mkNum); // damage numbers
  const SEQ = new Pool(12, mkSeq);        // timed sequences (boss death, confetti)

  // --- state
  const SEED = new Int32Array(1); SEED[0] = 1;
  const rand = () => { const s0 = (SEED[0] + 0x6D2B79F5) | 0; SEED[0] = s0; let t = Math.imul(s0 ^ (s0 >>> 15), 1 | s0); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const rr = (a, b) => a + (b - a) * rand();
  const nEmit = (x) => { const f = Math.floor(x); return f + (rand() < x - f ? 1 : 0); };
  let Q = 2, qMul = 1, walls = true;
  let time = 0, fdt = 0, trauma = 0, shT = 0;
  const shakeVec = new THREE.Vector3();
  let lastState = null;
  let px = 0, pz = 0, ppx = 0, ppz = 0, pAlive = false, pFace = 0, havePrev = false;
  let prevShield = 0, shieldAge = 0, shieldFlash = 0, prevOd = 0;
  let bossX = 0, bossZ = 0, bossKind = 'boss_gateway';
  const gemTrack = new Map(); // id -> {x, z, stamp}
  const trackPool = []; let stamp = 0;
  const camPos = new THREE.Vector3();
  const _v = new THREE.Vector3(), _e = new THREE.Euler();
  let gemLoadAcc = 0;

  // ================================================================ spawn helpers
  // ---- particle spawners (PB param block in, pooled particle out)
  function spriteP(pool, frame, c) {   // PB: x y z s0 s1 life k alpha
    const p = pool.get(), k = PB[6];
    p.x = PB[0]; p.y = PB[1]; p.z = PB[2]; p.vx = 0; p.vy = 0; p.vz = 0; p.g = 0; p.drag = 0; p.age = 0; p.life = PB[5];
    p.s0 = PB[3]; p.s1 = PB[4]; p.cr = c[0] * k; p.cg = c[1] * k; p.cb = c[2] * k; p.a = PB[7];
    p.rot = 0; p.vrot = 0; p.frame = frame; p.aspect = 1; p.hot = 0; p.hold = 0; p.fi = 0; p.floor = -99; p.bounce = 0; p.flutter = 0; p.fph = 0;
    return p;
  }
  function sparkP(c) {                 // PB: x y z vx vy vz k life w
    const p = PS.get(), k = PB[6], w = PB[8];
    p.x = PB[0]; p.y = PB[1]; p.z = PB[2]; p.vx = PB[3]; p.vy = PB[4]; p.vz = PB[5]; p.g = 14; p.drag = 1.5; p.age = 0; p.life = PB[7];
    p.w0 = w; p.w1 = w * 0.3; p.stretch = 0.035; p.minL = 0.03; p.maxL = 0.55; p.cr = c[0] * k; p.cg = c[1] * k; p.cb = c[2] * k;
    p.a = 1; p.hot = 0.8; p.style = 0; p.glow = 2.4; p.tail = 0.05; p.bounce = 0.35; p.fixed = false; p.hold = 0.2; p.seed = rand() * 10;
    return p;
  }
  function segP(c, style) {            // PB: ax ay az bx by bz w k life hot
    const p = PS.get(), k = PB[7];
    p.fixed = true; p.ax = PB[0]; p.ay = PB[1]; p.az = PB[2]; p.bx = PB[3]; p.by = PB[4]; p.bz = PB[5];
    p.x = PB[3]; p.y = PB[4]; p.z = PB[5]; p.vx = 0; p.vy = 0; p.vz = 0; p.g = 0; p.drag = 0; p.age = 0; p.life = PB[8];
    p.w0 = PB[6]; p.w1 = PB[6]; p.cr = c[0] * k; p.cg = c[1] * k; p.cb = c[2] * k; p.a = 1; p.hot = PB[9]; p.style = style;
    p.glow = 2.4; p.tail = 1; p.hold = 0.3; p.seed = rand() * 10;
    return p;
  }
  function ringP(c, style, mode) {     // PB: x y z R0 R1 w0 w1 life k alpha h
    const p = PBD.get(), k = PB[8], h = PB[10];
    p.x = PB[0]; p.y = PB[1]; p.z = PB[2]; p.R0 = PB[3]; p.R1 = PB[4]; p.w0 = PB[5]; p.w1 = PB[6]; p.life = PB[7]; p.age = 0;
    p.cr = c[0] * k; p.cg = c[1] * k; p.cb = c[2] * k; p.al = PB[9]; p.style = style; p.mode = mode;
    p.h0 = h; p.h1 = h * 0.3; p.a = 0; p.half = Math.PI; p.ease = 2.2; p.caps = 0; p.spin = 0; p.hold = 0.15;
    return p;
  }
  function decalP(pool, shape, c) {    // PB: x z sx0 sx1 life k alpha
    const p = pool.get(), k = PB[5];
    p.x = PB[0]; p.y = pool === PDA ? 0.018 : 0.014; p.z = PB[1]; p.rot = 0; p.sx0 = PB[2]; p.sz0 = PB[2]; p.sx1 = PB[3]; p.sz1 = PB[3];
    p.shape = shape; p.p0 = 0; p.q0 = rand() * 10; p.q1 = rand() * 10; p.q2 = 0; p.q3 = 0;
    p.cr = c[0] * k; p.cg = c[1] * k; p.cb = c[2] * k; p.al = PB[6]; p.age = 0; p.life = PB[4]; p.hold = 0.2; p.fi = 0;
    return p;
  }
  function debrisP(c) {                // PB: x y z emit size spd up
    const p = PD.get(), size = PB[4], spd = PB[5], up = PB[6];
    p.x = PB[0]; p.y = PB[1]; p.z = PB[2]; p.emit = PB[3];
    const a = rand() * TAU, h = (0.3 + 0.7 * rand()) * spd;
    p.vx = Math.sin(a) * h; p.vz = Math.cos(a) * h; p.vy = up * (0.5 + 0.5 * rand());
    _e.set(rand() * TAU, rand() * TAU, rand() * TAU); p.q.setFromEuler(_e);
    p.wx = rr(-14, 14); p.wy = rr(-14, 14); p.wz = rr(-14, 14);
    p.sx = size * rr(0.8, 1.25); p.sy = size * rr(0.4, 0.7); p.sz = size * rr(0.7, 1.2);
    p.cr = c[0]; p.cg = c[1]; p.cb = c[2]; p.age = 0; p.life = rr(1.1, 1.8); p.g = 18; p.bounce = 0.38; p.rest = false;
    return p;
  }
  function flashP(c) {                 // PB: x y z size k life hot
    const p = PA.get(), size = PB[3], k = PB[4];
    p.x = PB[0]; p.y = PB[1]; p.z = PB[2]; p.vx = 0; p.vy = 0; p.vz = 0; p.g = 0; p.drag = 0; p.age = 0; p.life = PB[5];
    p.s0 = size; p.s1 = size * 1.25; p.cr = c[0] * k; p.cg = c[1] * k; p.cb = c[2] * k; p.a = 1;
    p.rot = 0; p.vrot = 0; p.frame = F.HOT; p.aspect = 1; p.hot = PB[6]; p.hold = 0; p.fi = 0; p.floor = -99; p.bounce = 0; p.flutter = 0; p.fph = 0;
    return p;
  }
  // ---- event-only convenience wrappers (plain args; one-shot events may box a few doubles)
  function sprite(pool, x, y, z, frame, s0, s1, life, c, k, a) { PB[0] = x; PB[1] = y; PB[2] = z; PB[3] = s0; PB[4] = s1; PB[5] = life; PB[6] = k; PB[7] = a; return spriteP(pool, frame, c); }
  function ring(x, y, z, R0, R1, w0, w1, life, c, k, al, style, mode, h) { PB[0] = x; PB[1] = y; PB[2] = z; PB[3] = R0; PB[4] = R1; PB[5] = w0; PB[6] = w1; PB[7] = life; PB[8] = k; PB[9] = al; PB[10] = h || 0.6; return ringP(c, style || 0, mode || 0); }
  function seg(ax, ay, az, bx, by, bz, w, c, k, life, hot, style) { PB[0] = ax; PB[1] = ay; PB[2] = az; PB[3] = bx; PB[4] = by; PB[5] = bz; PB[6] = w; PB[7] = k; PB[8] = life; PB[9] = hot; return segP(c, style || 0); }
  function spark(x, y, z, vx, vy, vz, c, k, life, w) { PB[0] = x; PB[1] = y; PB[2] = z; PB[3] = vx; PB[4] = vy; PB[5] = vz; PB[6] = k; PB[7] = life; PB[8] = w; return sparkP(c); }
  // camera-facing expanding soft ring: frames the fox instead of covering it
  function halo(x, y, z, s0, s1, life, c, k, a) { const p = sprite(PA, x, y, z, F.SOFTRING, s0, s1, life, c, k, a); p.hold = 0; return p; }
  // thin light pillars standing in a circle (fox-centred celebrations)
  function pillars(x, z, n, R, h, c, k, life) {
    const a0 = rand() * TAU;
    for (let i = 0; i < n; i++) {
      const a = a0 + i / n * TAU, px_ = x + Math.sin(a) * R, pz_ = z + Math.cos(a) * R;
      const q = seg(px_, 0.02, pz_, px_, h * rr(0.75, 1.1), pz_, 0.07, c, k, life * rr(0.85, 1.1), 0.8, 3); q.w1 = 0.02; q.glow = 2.4; q.hold = 0.2;
    }
  }
  function burstSparks(n, x, y, z, s0, s1, c, k, up, life, w, whiteMix) {
    n = Math.round(n * qMul);
    for (let i = 0; i < n; i++) {
      const a = rand() * TAU, e = rr(-0.25, up), sp = rr(s0, s1);
      const hz = Math.sqrt(Math.max(0, 1 - e * e));
      const cc = rand() < (whiteMix || 0) ? WHITE : c;
      (PB[0] = x, PB[1] = y, PB[2] = z, PB[3] = Math.sin(a) * hz * sp, PB[4] = e * sp, PB[5] = Math.cos(a) * hz * sp, PB[6] = k, PB[7] = life * rr(0.6, 1.2), PB[8] = w * rr(0.7, 1.2), sparkP(cc));
    }
  }
  function lightningImm(nseg, c, sdi) {   // PB: ax ay az bx by bz amp w k alpha ; sdi = integer seed
    const ax = PB[0], ay = PB[1], az = PB[2], bx = PB[3], by = PB[4], bz = PB[5], amp = PB[6], w = PB[7], k = PB[8], al = PB[9];
    let x0 = ax, y0 = ay, z0 = az;
    for (let i = 1; i <= nseg; i++) {
      const f = i / nseg, env = Math.sin(f * Math.PI);
      let x1 = ax + (bx - ax) * f, y1 = ay + (by - ay) * f, z1 = az + (bz - az) * f;
      if (i < nseg) { const n = (sdi + i * 7) & 1023; x1 += (NOISE[n] - 0.5) * 2 * amp * env; z1 += (NOISE[(n + 331) & 1023] - 0.5) * 2 * amp * env; y1 += (NOISE[(n + 677) & 1023] - 0.5) * amp * env * 0.4; }
      PB[0] = x0; PB[1] = y0; PB[2] = z0; PB[3] = x1; PB[4] = y1; PB[5] = z1; PB[6] = w; PB[7] = k; PB[8] = al; PB[9] = 1.1; PB[10] = 0; PB[11] = 2.2; PB[12] = 1; PB[13] = 0; wStk(c);
      x0 = x1; y0 = y1; z0 = z1;
    }
  }

  function lightP(nseg, c) {           // PB: ax ay az bx by bz amp w k life
    const ax = PB[0], ay = PB[1], az = PB[2], bx = PB[3], by = PB[4], bz = PB[5], amp = PB[6], w = PB[7], k = PB[8], life = PB[9];
    let x0 = ax, y0 = ay, z0 = az; const sd = (rand() * 1024) | 0;
    for (let i = 1; i <= nseg; i++) {
      const f = i / nseg, env = Math.sin(f * Math.PI);
      let x1 = ax + (bx - ax) * f, y1 = ay + (by - ay) * f, z1 = az + (bz - az) * f;
      if (i < nseg) { const n = (sd + i * 7) & 1023; x1 += (NOISE[n] - 0.5) * 2 * amp * env; z1 += (NOISE[(n + 331) & 1023] - 0.5) * 2 * amp * env; y1 += (NOISE[(n + 677) & 1023] - 0.5) * amp * env * 0.5; }
      PB[0] = x0; PB[1] = y0; PB[2] = z0; PB[3] = x1; PB[4] = y1; PB[5] = z1; PB[6] = w; PB[7] = k; PB[8] = life; PB[9] = 1.0; segP(c, 0);
      x0 = x1; y0 = y1; z0 = z1;
    }
  }

  function smoke(x, y, z, n, c, k, al, s0, s1, life, up) {
    n = Math.max(1, Math.round(n * qMul));
    for (let i = 0; i < n; i++) {
      const p = (PB[0] = x + rr(-0.25, 0.25), PB[1] = y + rr(0, 0.2), PB[2] = z + rr(-0.25, 0.25), PB[3] = s0 * rr(0.8, 1.2), PB[4] = s1 * rr(0.8, 1.3), PB[5] = life * rr(0.8, 1.2), PB[6] = k, PB[7] = al, spriteP(PN, rand() < 0.5 ? F.SMOKE : F.DUST, c));
      const a = rand() * TAU; p.vx = Math.sin(a) * rr(0.2, 0.9); p.vz = Math.cos(a) * rr(0.2, 0.9); p.vy = up * rr(0.6, 1.2);
      p.drag = 2.2; p.rot = rand() * TAU; p.vrot = rr(-1.5, 1.5); p.fi = 0.08; p.hold = 0.1;
    }
  }
  function dust(x, z, n, R, c, al) {
    n = Math.max(2, Math.round(n * qMul));
    for (let i = 0; i < n; i++) {
      const a = i / n * TAU + rr(-0.2, 0.2);
      const p = (PB[0] = x + Math.sin(a) * R * 0.4, PB[1] = 0.12, PB[2] = z + Math.cos(a) * R * 0.4, PB[3] = 0.3 * R + 0.12, PB[4] = 0.8 * R + 0.3, PB[5] = rr(0.4, 0.6), PB[6] = 1, PB[7] = (al || 0.42) * 0.7, spriteP(PN, F.DUST, c || C_DUST));
      const sp = rr(2.2, 3.4) * (0.6 + R * 0.4);
      p.vx = Math.sin(a) * sp; p.vz = Math.cos(a) * sp; p.vy = rr(0.2, 0.8); p.drag = 5; p.rot = rand() * TAU; p.vrot = rr(-2, 2); p.hold = 0.05; p.fi = 0.04;
    }
  }

  function explosion(x, y, z, s, kc, dbr) {
    const fb = (PB[0] = x, PB[1] = y, PB[2] = z, PB[3] = 0.7 * s, PB[4] = 2.0 * s, PB[5] = rr(0.3, 0.42), PB[6] = 1.25, PB[7] = 1, spriteP(PA, F.SOFT, rand() < 0.5 ? C_RING : C_GOLD));
    fb.vy = 0.9; fb.hot = 0.7; fb.hold = 0.1; fb.rot = rand() * TAU;
    (PB[0] = x, PB[1] = y, PB[2] = z, PB[3] = 1.1 * s, PB[4] = 1.0, PB[5] = 0.09, PB[6] = 1, flashP(WHITE));
    burstSparks(7, x, y, z, 3, 8, rand() < 0.5 ? C_GOLDW : kc.glow, 1.8, 0.9, 0.45, 0.028, 0.3);
    const sm = (PB[0] = x, PB[1] = y + 0.2, PB[2] = z, PB[3] = 0.7 * s, PB[4] = 2.1 * s, PB[5] = rr(1.0, 1.5), PB[6] = 1, PB[7] = 0.5, spriteP(PN, F.SMOKE, C_SMOKE));
    sm.vy = rr(0.8, 1.5); sm.drag = 1; sm.rot = rand() * TAU; sm.vrot = rr(-1, 1); sm.fi = 0.18; sm.hold = 0.15;
    for (let i = 0; i < dbr; i++) (PB[0] = x, PB[1] = y, PB[2] = z, PB[3] = 0, PB[4] = rr(0.12, 0.24), PB[5] = 4.5, PB[6] = 6, debrisP(rand() < 0.6 ? kc.body : kc.trim));
  }

  // ================================================================ immediate writers
  // ---- hot per-instance writers. Values arrive through the PB param block (Float64Array) instead
  // of double arguments: V8 boxes doubles passed across non-inlined calls, PB stores never allocate.
  function wSpr(sys, c, frame) {       // PB: x y z size k alpha rot aspect hot
    const i = sys.add(); if (i < 0) return;
    const o = i * 4, k = PB[4], a = PB[5], size = PB[3], hot = PB[8];
    const P0 = sys.cur[0], P1 = sys.cur[1], P2 = sys.cur[2];
    P0[o] = PB[0]; P0[o + 1] = PB[1]; P0[o + 2] = PB[2]; P0[o + 3] = size;
    P1[o] = c[0] * k; P1[o + 1] = c[1] * k; P1[o + 2] = c[2] * k; P1[o + 3] = a;
    P2[o] = PB[6]; P2[o + 1] = frame; P2[o + 2] = PB[7]; P2[o + 3] = hot;
    const m = c[0] > c[1] ? (c[0] > c[2] ? c[0] : c[2]) : (c[1] > c[2] ? c[1] : c[2]);
    sys.acc += (size * size < 3 ? size * size : 3) * a * k * m * (1 + hot);
  }
  function wStk(c) {                   // PB: ax ay az bx by bz hw k alpha hot style glow tail seed
    const i = strk.add(); if (i < 0) return;
    const o = i * 4, k = PB[7];
    const P0 = strk.cur[0], P1 = strk.cur[1], P2 = strk.cur[2], P3 = strk.cur[3];
    P0[o] = PB[0]; P0[o + 1] = PB[1]; P0[o + 2] = PB[2]; P0[o + 3] = PB[6];
    P1[o] = PB[3]; P1[o + 1] = PB[4]; P1[o + 2] = PB[5]; P1[o + 3] = PB[12];
    P2[o] = c[0] * k; P2[o + 1] = c[1] * k; P2[o + 2] = c[2] * k; P2[o + 3] = PB[8];
    P3[o] = PB[9]; P3[o + 1] = PB[10]; P3[o + 2] = PB[13]; P3[o + 3] = PB[11];
  }
  function wDec(sys, c) {              // PB: x y z rot hx hz shape p0 k alpha q0 q1 q2 q3
    const i = sys.add(); if (i < 0) return;
    const o = i * 4, k = PB[8], a = PB[9];
    const P0 = sys.cur[0], P1 = sys.cur[1], P2 = sys.cur[2], P3 = sys.cur[3];
    P0[o] = PB[0]; P0[o + 1] = PB[1]; P0[o + 2] = PB[2]; P0[o + 3] = PB[3];
    P1[o] = PB[4]; P1[o + 1] = PB[5]; P1[o + 2] = PB[6]; P1[o + 3] = PB[7];
    P2[o] = c[0] * k; P2[o + 1] = c[1] * k; P2[o + 2] = c[2] * k; P2[o + 3] = a;
    P3[o] = PB[10]; P3[o + 1] = PB[11]; P3[o + 2] = PB[12]; P3[o + 3] = PB[13];
    const m = c[0] > c[1] ? (c[0] > c[2] ? c[0] : c[2]) : (c[1] > c[2] ? c[1] : c[2]);
    sys.acc += PB[4] * PB[5] * a * k * m * 0.6;
  }
  function wBnd(c) {                   // PB: x y z R w a half mode k alpha style h seed caps
    const i = band.add(); if (i < 0) return;
    const o = i * 4, k = PB[8], al = PB[9], R = PB[3], mode = PB[7];
    const P0 = band.cur[0], P1 = band.cur[1], P2 = band.cur[2], P3 = band.cur[3];
    P0[o] = PB[0]; P0[o + 1] = PB[1]; P0[o + 2] = PB[2]; P0[o + 3] = R;
    P1[o] = PB[4]; P1[o + 1] = PB[5]; P1[o + 2] = PB[6]; P1[o + 3] = mode;
    P2[o] = c[0] * k; P2[o + 1] = c[1] * k; P2[o + 2] = c[2] * k; P2[o + 3] = al;
    P3[o] = PB[10]; P3[o + 1] = PB[11]; P3[o + 2] = PB[12]; P3[o + 3] = PB[13];
    band.acc += (R > 0.2 ? R : 0.2) * PB[6] * (mode ? (PB[11] || 0.5) : PB[4]) * al * k * 0.6;
  }

  function surfaceY(x, z) {
    for (let i = 0; i < BOXES.length; i++) { const f = BOXES[i]; if (Math.abs(x - f.x) <= f.hw && Math.abs(z - f.z) <= f.hd) return f.h; }
    return 0;
  }

  // ================================================================ SYNC
  function sync(st, t, dt) {
    if (!st) return;
    lastState = st; time = t; U.uTime.value = t;
    dt = Math.min(0.05, Math.max(0, dt || 0)); fdt = dt;
    // camera.matrixWorld is refreshed by the renderer each frame; a one-frame-old camera position is
    // plenty for billboard offsets and avoids three's per-call Matrix4 temporaries here.
    camPos.setFromMatrixPosition(camera.matrixWorld);
    for (let i = 0; i < SYS.length; i++) SYS[i].beginImm();
    const P = st.player;
    if (P) {
      px = P.x; pz = P.z; pAlive = P.alive !== false; pFace = P.face || 0;
      if (!havePrev) { ppx = px; ppz = pz; havePrev = true; }
    }

    // ---- contact shadows + elite rings
    const en = st.enemies || [];
    for (let i = 0; i < en.length; i++) {
      const e = en[i];
      const sy = surfaceY(e.x, e.z);
      const hgt = Math.max(0, (e.y || 0) - sy);
      const fade = Math.min(1, Math.max(0.18, 1 - hgt / 2.6));
      const r = (e.r || 0.4) * (e.boss ? 1.25 : 1.55) * (1 + hgt * 0.22);
      (PB[0] = e.x, PB[1] = sy + 0.011, PB[2] = e.z, PB[3] = 0, PB[4] = r, PB[5] = r, PB[6] = 4, PB[7] = 0, PB[8] = 1, PB[9] = 0.72 * fade, PB[10] = 0, PB[11] = 0, PB[12] = 0, PB[13] = 0, wDec(decN, C_SHADOW));
      if (e.boss) { bossX = e.x; bossZ = e.z; bossKind = e.kind; }
    }
    if (P && pAlive) (PB[0] = px, PB[1] = 0.011, PB[2] = pz, PB[3] = 0, PB[4] = 0.62, PB[5] = 0.62, PB[6] = 4, PB[7] = 0, PB[8] = 1, PB[9] = 0.7, PB[10] = 0, PB[11] = 0, PB[12] = 0, PB[13] = 0, wDec(decN, C_SHADOW));

    // ---- player bolts
    const ps = st.pshots || [];
    for (let i = 0; i < ps.length; i++) {
      const s = ps[i];
      const sp = Math.sqrt((s.vx || 0) * (s.vx || 0) + (s.vz || 0) * (s.vz || 0)) || 1, dx = (s.vx || 0) / sp, dz = (s.vz || 1) / sp;
      const tier = Math.min(WEAPONS.length - 1, Math.max(0, s.tier | 0)), W = WEAPONS[tier];
      let hw = 0.058 * W.w, len = Math.min(0.8, Math.max(0.34, sp * 0.032)) * (0.82 + 0.18 * W.w), c = TIER_C[tier], k = 1.5, hot = 1.0;
      if (s.big) { hw = 0.11; len *= 1.2; c = C_GOLDW; k = 1.4; hot = 1.1; }
      if (s.pierce > 0) k *= 1.1;
      const y = 0.8;
      const md = Math.sqrt((s.x - px) * (s.x - px) + (s.z - pz) * (s.z - pz)), mf = Math.min(1, Math.max(0, (md - 0.3) / 1.1)) * 0.6 + 0.4;
      (PB[0] = s.x - dx * len, PB[1] = y, PB[2] = s.z - dz * len, PB[3] = s.x, PB[4] = y, PB[5] = s.z, PB[6] = hw, PB[7] = k, PB[8] = mf, PB[9] = hot * 0.75, PB[10] = 0, PB[11] = 2.7, PB[12] = 0.12, PB[13] = s.id * 0.37, wStk(c));
      (PB[0] = s.x - dx * len * 0.5, PB[1] = 0.016, PB[2] = s.z - dz * len * 0.5, PB[3] = Math.atan2(dx, dz), PB[4] = 0.1 + hw * 1.2, PB[5] = len * 0.5 + 0.18, PB[6] = 0, PB[7] = 0, PB[8] = s.big ? 0.2 : 0.12, PB[9] = 1, PB[10] = 0, PB[11] = 0, PB[12] = 0, PB[13] = 0, wDec(decA, c));
    }

    // ---- enemy shots
    const es = st.eshots || [];
    for (let i = 0; i < es.length; i++) syncEshot(es[i]);

    // ---- hazards
    const hz = st.hazards || [];
    for (let i = 0; i < hz.length; i++) syncHazard(hz[i]);

    // ---- pickups
    syncPickups(st.pickups || [], t, dt);

    // ---- player auras
    if (P) syncPlayer(P, t, dt);

    ppx = px; ppz = pz;
    flush();
  }



  function syncEshot(s) {
    const t = time;
    const type = s.type;
    if (type === 'orb') {
      const r = s.r || 0.18, y = 0.62, f = (Math.min(1, Math.max(0, (s.t || 0) / 0.06)) * Math.min(1, Math.max(0, ((s.life || 99) - (s.t || 0)) / 0.12)));
      const c = threatColor(s.color, C_ORB);
      const pul = 1 + 0.08 * Math.sin(t * 22 + s.id);
      (PB[0] = s.x, PB[1] = y, PB[2] = s.z, PB[3] = r * 3.4, PB[4] = 1, PB[5] = 0.7 * f, PB[6] = 0, PB[7] = 1, PB[8] = 0, wSpr(sprN, C_ORBBACK, F.SOFT));
      (PB[0] = s.x, PB[1] = y, PB[2] = s.z, PB[3] = r * 5.2 * pul, PB[4] = 0.35, PB[5] = f, PB[6] = 0, PB[7] = 1, PB[8] = 0, wSpr(sprA, c, F.SOFT));
      (PB[0] = s.x, PB[1] = y, PB[2] = s.z, PB[3] = r * 2.9 * pul, PB[4] = 1.25, PB[5] = f, PB[6] = 0, PB[7] = 1, PB[8] = 0, wSpr(sprA, c, F.DOT));
      (PB[0] = s.x, PB[1] = y, PB[2] = s.z, PB[3] = r * 1.7, PB[4] = 0.9, PB[5] = f, PB[6] = 0, PB[7] = 1, PB[8] = 0.6, wSpr(sprA, WHITE, F.HOT));
      (PB[0] = s.x, PB[1] = y, PB[2] = s.z, PB[3] = r * 3.3 * pul, PB[4] = 0.9, PB[5] = 0.7 * f, PB[6] = t * 3 + s.id, PB[7] = 1, PB[8] = 0, wSpr(sprA, c, F.RING));
      (PB[0] = s.x, PB[1] = 0.016, PB[2] = s.z, PB[3] = 0, PB[4] = r * 2.6, PB[5] = r * 2.6, PB[6] = 0, PB[7] = 0, PB[8] = 0.16, PB[9] = f, PB[10] = 0, PB[11] = 0, PB[12] = 0, PB[13] = 0, wDec(decA, c));
    } else if (type === 'bolt') {
      const r = s.r || 0.12, sp = Math.sqrt((s.vx || 0) * (s.vx || 0) + (s.vz || 0) * (s.vz || 0)) || 1, dx = (s.vx || 0) / sp, dz = (s.vz || 1) / sp;
      const len = Math.min(1.1, Math.max(0.4, sp * 0.05)), hw = Math.max(0.085, r * 0.8), f = (Math.min(1, Math.max(0, (s.t || 0) / 0.04)) * Math.min(1, Math.max(0, ((s.life || 99) - (s.t || 0)) / 0.1)));
      const c = threatColor(s.color, C_EBOLT);
      (PB[0] = s.x - dx * len, PB[1] = 0.66, PB[2] = s.z - dz * len, PB[3] = s.x, PB[4] = 0.66, PB[5] = s.z, PB[6] = hw, PB[7] = 1.7, PB[8] = f, PB[9] = 0.9, PB[10] = 0, PB[11] = 2.6, PB[12] = 0.08, PB[13] = 0, wStk(c));
      (PB[0] = s.x, PB[1] = 0.66, PB[2] = s.z, PB[3] = hw * 5, PB[4] = 0.5, PB[5] = f, PB[6] = 0, PB[7] = 1, PB[8] = 0, wSpr(sprA, c, F.SOFT));
      (PB[0] = s.x - dx * len * 0.5, PB[1] = 0.016, PB[2] = s.z - dz * len * 0.5, PB[3] = Math.atan2(dx, dz), PB[4] = 0.25, PB[5] = len * 0.5 + 0.3, PB[6] = 0, PB[7] = 0, PB[8] = 0.3, PB[9] = f, PB[10] = 0, PB[11] = 0, PB[12] = 0, PB[13] = 0, wDec(decA, c));
    } else if (type === 'notif') {
      const r = s.r || 0.2, f = (Math.min(1, Math.max(0, (s.t || 0) / 0.08)) * Math.min(1, Math.max(0, ((s.life || 99) - (s.t || 0)) / 0.15))), sz = Math.max(0.68, r * 4.0);
      const y = 0.9 + 0.06 * Math.sin(t * 6 + s.id);
      const pop = 1 + 0.25 * Math.max(0, 1 - (s.t || 1) / 0.12);
      (PB[0] = s.x, PB[1] = y, PB[2] = s.z, PB[3] = sz * 1.7, PB[4] = 0.3, PB[5] = f, PB[6] = 0, PB[7] = 1, PB[8] = 0, wSpr(sprA, C_PINK, F.SOFT));
      (PB[0] = s.x, PB[1] = y, PB[2] = s.z, PB[3] = sz * pop, PB[4] = 0.82, PB[5] = f, PB[6] = Math.sin(t * 7 + s.id) * 0.12, PB[7] = 1, PB[8] = 0, wSpr(sprN, WHITE, F.BUBBLE));
      (PB[0] = s.x, PB[1] = 0.016, PB[2] = s.z, PB[3] = 0, PB[4] = sz * 0.6, PB[5] = sz * 0.6, PB[6] = 0, PB[7] = 0, PB[8] = 0.14, PB[9] = f, PB[10] = 0, PB[11] = 0, PB[12] = 0, PB[13] = 0, wDec(decA, C_PINK));
    } else if (type === 'wave') {
      const R = s.R || 0.5, w = s.w || 0.5, half = s.half || 0.6, f = (Math.min(1, Math.max(0, (s.t || 0) / 0.08)) * Math.min(1, Math.max(0, ((s.life || 99) - (s.t || 0)) / 0.25)));
      const c = threatColor(s.color, C_WAVE);
      (PB[0] = s.x, PB[1] = 0.02, PB[2] = s.z, PB[3] = R, PB[4] = w, PB[5] = s.a || 0, PB[6] = half, PB[7] = 0, PB[8] = 1.35, PB[9] = f, PB[10] = 1, PB[11] = 0, PB[12] = s.id, PB[13] = 0, wBnd(c));
      if (walls) (PB[0] = s.x, PB[1] = 0.0, PB[2] = s.z, PB[3] = R + w * 0.36, PB[4] = w, PB[5] = s.a || 0, PB[6] = half, PB[7] = 1, PB[8] = 1.1, PB[9] = f * 0.9, PB[10] = 1, PB[11] = 0.6, PB[12] = s.id, PB[13] = 0, wBnd(c));
    } else if (type === 'ring') {
      const R = s.R || 0.5, w = s.w || 0.4, f = (Math.min(1, Math.max(0, (s.t || 0) / 0.08)) * Math.min(1, Math.max(0, ((s.life || 99) - (s.t || 0)) / 0.25)));
      const c = threatColor(s.color, C_RING);
      let ca = 0, h = Math.PI, caps = 0;
      if (s.gap && s.gap.half > 0) { ca = s.gap.a + Math.PI; h = Math.PI - s.gap.half; caps = 1.4; }
      (PB[0] = s.x, PB[1] = 0.02, PB[2] = s.z, PB[3] = R, PB[4] = w, PB[5] = ca, PB[6] = h, PB[7] = 0, PB[8] = 1.25, PB[9] = f, PB[10] = 0, PB[11] = 0, PB[12] = s.id, PB[13] = caps, wBnd(c));
      if (walls) (PB[0] = s.x, PB[1] = 0.0, PB[2] = s.z, PB[3] = R + w * 0.3, PB[4] = w, PB[5] = ca, PB[6] = h, PB[7] = 1, PB[8] = 0.85, PB[9] = f * 0.8, PB[10] = 0, PB[11] = 0.7, PB[12] = s.id, PB[13] = caps, wBnd(c));
      if (caps) {
        for (let sgn = -1; sgn <= 1; sgn += 2) {
          const ea = ca + sgn * h, ex = s.x + Math.sin(ea) * R, ez = s.z + Math.cos(ea) * R;
          (PB[0] = ex, PB[1] = 0.0, PB[2] = ez, PB[3] = ex, PB[4] = 1.1, PB[5] = ez, PB[6] = 0.075, PB[7] = 1.6, PB[8] = f, PB[9] = 0.7, PB[10] = 3, PB[11] = 2.2, PB[12] = 1, PB[13] = 0, wStk(mixInto(TMP3, c, WHITE, 0.45)));
        }
      }
    } else {
      // unknown type: draw as orb
      const r = s.r || 0.18;
      (PB[0] = s.x, PB[1] = 0.62, PB[2] = s.z, PB[3] = r * 3.0, PB[4] = 1.4, PB[5] = 1, PB[6] = 0, PB[7] = 1, PB[8] = 0.8, wSpr(sprA, C_ORB, F.HOT));
    }
  }

  function syncHazard(h) {
    const t = time, dt = fdt;
    const warnDur = h.warnDur || 1;
    const warning = h.warn > 0;
    const prog = warning ? Math.min(1, Math.max(0, 1 - h.warn / warnDur)) : 1;
    const liveK = !warning && h.live > 0 ? Math.min(1, Math.max(0, h.live / (h.liveDur || 0.3))) : 0;
    if (!warning && liveK <= 0) return;
    const pulse = 0.5 + 0.5 * Math.sin(t * (9 + prog * 16) + h.id);
    const type = h.type;
    if (type === 'spark' || type === 'slam' || type === 'shock' || type == null) {
      const R = h.r || 1;
      if (warning) {
        (PB[0] = h.x, PB[1] = 0.012, PB[2] = h.z, PB[3] = 0, PB[4] = R, PB[5] = R, PB[6] = 7, PB[7] = 0.08, PB[8] = 1, PB[9] = 0.3 + 0.25 * prog, PB[10] = 0, PB[11] = 0, PB[12] = 0, PB[13] = 0, wDec(decN, C_WARNUNDER));
        (PB[0] = h.x, PB[1] = 0.018, PB[2] = h.z, PB[3] = 0, PB[4] = R + 0.3, PB[5] = R + 0.3, PB[6] = 1, PB[7] = prog, PB[8] = 1.0, PB[9] = 1, PB[10] = pulse, PB[11] = R, PB[12] = 0, PB[13] = 0, wDec(decA, C_WARN));
        if (type === 'slam') (PB[0] = h.x, PB[1] = 0.013, PB[2] = h.z, PB[3] = 0, PB[4] = R * (0.3 + 0.8 * prog), PB[5] = R * (0.3 + 0.8 * prog), PB[6] = 4, PB[7] = 0, PB[8] = 1, PB[9] = 0.65 * prog, PB[10] = 0, PB[11] = 0, PB[12] = 0, PB[13] = 0, wDec(decN, C_SHADOW));
        else if (type === 'shock') {
          for (let j = 0; j < 2; j++) { const f = (t * 1.3 + j * 0.5 + h.id * 0.1) % 1; (PB[0] = h.x, PB[1] = 0.021, PB[2] = h.z, PB[3] = R * f, PB[4] = 0.08, PB[5] = 0, PB[6] = Math.PI, PB[7] = 0, PB[8] = 1, PB[9] = 0.35 * (1 - f) * (0.4 + 0.6 * prog), PB[10] = 2, PB[11] = 0, PB[12] = 0, PB[13] = 0, wBnd(C_WARN)); }
        } else if (type === 'spark') {
          const n = nEmit(dt * (4 + 16 * prog) * qMul);
          for (let j = 0; j < n; j++) {
            const a = rand() * TAU, rd = Math.sqrt(rand()) * R * 0.7;
            const p = (PB[0] = h.x + Math.sin(a) * rd, PB[1] = CEIL_Y - 0.6, PB[2] = h.z + Math.cos(a) * rd, PB[3] = 0, PB[4] = -rr(3, 6), PB[5] = 0, PB[6] = 1.8, PB[7] = 0.7, PB[8] = 0.02, sparkP(C_GOLDW));
            p.g = 12; p.drag = 0; p.stretch = 0.02;
          }
          // flickering glint high above the target
          if (pulse > 0.6) (PB[0] = h.x, PB[1] = 3.2, PB[2] = h.z, PB[3] = 0.5 + 0.4 * prog, PB[4] = 1.2 * prog, PB[5] = 1, PB[6] = t * 10, PB[7] = 1, PB[8] = 0.8, wSpr(sprA, C_SPARKHZ, F.FLARE));
        }
      } else {
        if (type === 'spark') {
          const sd = ((h.id | 0) * 131 + ((t * 28) | 0) * 37) & 1023;
          PB[0] = h.x + (NOISE[sd] - 0.5) * 0.4; PB[1] = CEIL_Y; PB[2] = h.z + (NOISE[(sd + 1) & 1023] - 0.5) * 0.4; PB[3] = h.x; PB[4] = 0.05; PB[5] = h.z;
          PB[6] = 0.45; PB[7] = 0.06; PB[8] = 1.8; PB[9] = liveK; lightningImm(9, C_SPARKHZ, sd);
          PB[0] = h.x + (NOISE[(sd + 2) & 1023] - 0.5) * 0.8; PB[1] = CEIL_Y; PB[2] = h.z + (NOISE[(sd + 3) & 1023] - 0.5) * 0.8;
          PB[3] = h.x + (NOISE[(sd + 4) & 1023] - 0.5) * R; PB[4] = 0.05; PB[5] = h.z + (NOISE[(sd + 5) & 1023] - 0.5) * R;
          PB[6] = 0.55; PB[7] = 0.035; PB[8] = 1.3; PB[9] = liveK * 0.8; lightningImm(7, C_SPARKHZ, (sd + 97) & 1023);
          (PB[0] = h.x, PB[1] = 0.018, PB[2] = h.z, PB[3] = 0, PB[4] = R * 1.4, PB[5] = R * 1.4, PB[6] = 0, PB[7] = 0, PB[8] = 0.9, PB[9] = liveK, PB[10] = 0, PB[11] = 0, PB[12] = 0, PB[13] = 0, wDec(decA, C_SPARKHZ));
          (PB[0] = h.x, PB[1] = 0.25, PB[2] = h.z, PB[3] = R * 2.2 * (0.8 + 0.4 * NOISE[(sd + 6) & 1023]), PB[4] = 0.9, PB[5] = liveK, PB[6] = 0, PB[7] = 1, PB[8] = 1, wSpr(sprA, C_SPARKHZ, F.HOT));
        } else if (type === 'slam') {
          (PB[0] = h.x, PB[1] = 0.018, PB[2] = h.z, PB[3] = 0, PB[4] = R * 1.2, PB[5] = R * 1.2, PB[6] = 0, PB[7] = 0, PB[8] = 1.0, PB[9] = liveK, PB[10] = 0, PB[11] = 0, PB[12] = 0, PB[13] = 0, wDec(decA, C_RING));
          (PB[0] = h.x, PB[1] = 0.022, PB[2] = h.z, PB[3] = R * (1.25 - 0.6 * liveK), PB[4] = 0.3 * liveK + 0.08, PB[5] = 0, PB[6] = Math.PI, PB[7] = 0, PB[8] = 1.2, PB[9] = liveK, PB[10] = 0, PB[11] = 0, PB[12] = 0, PB[13] = 0, wBnd(C_RING));
        } else {
          const e = 1 - liveK;
          (PB[0] = h.x, PB[1] = 0.022, PB[2] = h.z, PB[3] = R * (0.15 + 0.85 * e), PB[4] = 0.5, PB[5] = 0, PB[6] = Math.PI, PB[7] = 0, PB[8] = 1.4, PB[9] = Math.min(1, liveK * 2), PB[10] = 0, PB[11] = 0, PB[12] = 0, PB[13] = 0, wBnd(C_WARN));
          if (walls) (PB[0] = h.x, PB[1] = 0, PB[2] = h.z, PB[3] = R * (0.15 + 0.85 * e) + 0.15, PB[4] = 0.4, PB[5] = 0, PB[6] = Math.PI, PB[7] = 1, PB[8] = 0.9, PB[9] = liveK, PB[10] = 0, PB[11] = 0.7, PB[12] = 0, PB[13] = 0, wBnd(C_WARN));
          (PB[0] = h.x, PB[1] = 0.018, PB[2] = h.z, PB[3] = 0, PB[4] = R, PB[5] = R, PB[6] = 0, PB[7] = 0, PB[8] = 0.35, PB[9] = liveK, PB[10] = 0, PB[11] = 0, PB[12] = 0, PB[13] = 0, wDec(decA, C_WARN));
        }
      }
    } else if (type === 'beam') {
      const x2 = h.x2 != null ? h.x2 : h.x, z2 = h.z2 != null ? h.z2 : h.z + 5;
      const dx = x2 - h.x, dz = z2 - h.z, L = Math.sqrt((dx) * (dx) + (dz) * (dz)) || 0.01, rot = Math.atan2(dx, dz);
      const mx = (h.x + x2) * 0.5, mz = (h.z + z2) * 0.5, w = h.w || 0.5, y = 0.8;
      if (warning) {
        (PB[0] = mx, PB[1] = 0.012, PB[2] = mz, PB[3] = rot, PB[4] = w * 0.5 + 0.05, PB[5] = L * 0.5, PB[6] = 5, PB[7] = 0.08, PB[8] = 1, PB[9] = 0.3 * prog + 0.1, PB[10] = 0, PB[11] = 0, PB[12] = 0, PB[13] = 0, wDec(decN, C_BEAMUNDER));
        (PB[0] = mx, PB[1] = 0.018, PB[2] = mz, PB[3] = rot, PB[4] = w * 0.5 + 0.3, PB[5] = L * 0.5 + 0.3, PB[6] = 2, PB[7] = prog, PB[8] = 0.9, PB[9] = 1, PB[10] = pulse, PB[11] = w * 0.5, PB[12] = L * 0.5, PB[13] = 1, wDec(decA, C_BEAM));
        const fl = 0.75 + 0.25 * Math.sin(t * 61 + h.id * 3);
        (PB[0] = h.x, PB[1] = y, PB[2] = h.z, PB[3] = x2, PB[4] = y, PB[5] = z2, PB[6] = 0.018 + 0.03 * prog, PB[7] = (0.7 + 1.6 * prog) * fl, PB[8] = 1, PB[9] = 0.4 + 0.6 * prog, PB[10] = 1, PB[11] = 3.0, PB[12] = 1, PB[13] = h.id, wStk(C_BEAM));
        (PB[0] = h.x, PB[1] = y, PB[2] = h.z, PB[3] = 0.5 + 0.6 * prog, PB[4] = 1.2 * fl, PB[5] = 1, PB[6] = t * 8, PB[7] = 1, PB[8] = 0.9, wSpr(sprA, C_BEAM, F.FLARE));
      } else {
        (PB[0] = h.x, PB[1] = y, PB[2] = h.z, PB[3] = x2, PB[4] = y, PB[5] = z2, PB[6] = w * 0.95, PB[7] = 0.55, PB[8] = liveK, PB[9] = 0, PB[10] = 2, PB[11] = 1.8, PB[12] = 1, PB[13] = h.id, wStk(C_BEAM));
        (PB[0] = h.x, PB[1] = y, PB[2] = h.z, PB[3] = x2, PB[4] = y, PB[5] = z2, PB[6] = w * 0.42, PB[7] = 2.2, PB[8] = liveK, PB[9] = 1.5, PB[10] = 2, PB[11] = 2.2, PB[12] = 1, PB[13] = h.id, wStk(C_BEAM));
        (PB[0] = mx, PB[1] = 0.018, PB[2] = mz, PB[3] = rot, PB[4] = w * 1.3, PB[5] = L * 0.5, PB[6] = 6, PB[7] = 0, PB[8] = 0.75, PB[9] = liveK, PB[10] = 0, PB[11] = 0, PB[12] = 0, PB[13] = 0, wDec(decA, C_BEAM));
        (PB[0] = h.x, PB[1] = y, PB[2] = h.z, PB[3] = w * 3.5, PB[4] = 1.2, PB[5] = liveK, PB[6] = 0, PB[7] = 1, PB[8] = 1, wSpr(sprA, C_BEAM, F.HOT));
        (PB[0] = x2, PB[1] = y, PB[2] = z2, PB[3] = w * 2.5, PB[4] = 0.9, PB[5] = liveK, PB[6] = t * 20, PB[7] = 1, PB[8] = 0.6, wSpr(sprA, C_BEAM, F.FLARE));
        const n = nEmit(dt * 50 * qMul * liveK);
        for (let j = 0; j < n; j++) {
          const f = rand(); const sx = h.x + dx * f, sz = h.z + dz * f;
          (PB[0] = sx, PB[1] = y, PB[2] = sz, PB[3] = rr(-3, 3), PB[4] = rr(1, 4), PB[5] = rr(-3, 3), PB[6] = 1.8, PB[7] = 0.35, PB[8] = 0.022, sparkP(rand() < 0.5 ? WHITE : C_BEAM));
        }
      }
    } else if (type === 'fold') {
      const hw = h.hw || 1, hd = h.hd || 0.8, rot = h.a || 0;
      if (warning) {
        const g = 0.35 + 0.65 * prog;
        (PB[0] = h.x, PB[1] = 0.012, PB[2] = h.z, PB[3] = rot, PB[4] = hw, PB[5] = hd, PB[6] = 5, PB[7] = 0.1, PB[8] = 1, PB[9] = 0.28, PB[10] = 0, PB[11] = 0, PB[12] = 0, PB[13] = 0, wDec(decN, C_FOLDUNDER));
        (PB[0] = h.x, PB[1] = 0.013, PB[2] = h.z, PB[3] = rot, PB[4] = hw * g, PB[5] = hd * g, PB[6] = 5, PB[7] = 0.25, PB[8] = 1, PB[9] = 0.3 + 0.5 * prog, PB[10] = 0, PB[11] = 0, PB[12] = 0, PB[13] = 0, wDec(decN, C_FOLDSHADOW));
        (PB[0] = h.x, PB[1] = 0.018, PB[2] = h.z, PB[3] = rot, PB[4] = hw + 0.3, PB[5] = hd + 0.3, PB[6] = 2, PB[7] = prog, PB[8] = 1.0, PB[9] = 1, PB[10] = pulse, PB[11] = hw, PB[12] = hd, PB[13] = prog, wDec(decA, C_WARN));
      } else {
        (PB[0] = h.x, PB[1] = 0.018, PB[2] = h.z, PB[3] = rot, PB[4] = hw, PB[5] = hd, PB[6] = 5, PB[7] = 0.25, PB[8] = 1.3, PB[9] = liveK * 0.8, PB[10] = 0, PB[11] = 0, PB[12] = 0, PB[13] = 0, wDec(decA, C_PINK));
        (PB[0] = h.x, PB[1] = 0.013, PB[2] = h.z, PB[3] = rot, PB[4] = hw, PB[5] = hd, PB[6] = 5, PB[7] = 0.2, PB[8] = 1, PB[9] = 0.5 * liveK, PB[10] = 0, PB[11] = 0, PB[12] = 0, PB[13] = 0, wDec(decN, C_FOLDSHADOW2));
      }
    }
  }

  function syncPickups(pk, t, dt) {
    let ng = 0, nh = 0, no = 0;
    stamp++;
    for (let i = 0; i < pk.length; i++) {
      const p = pk[i];
      const age = p.t || 0, life = p.life || 0;
      const rem = life > 0 ? life - age : 99;
      const blink = rem < 2 ? 0.5 + 0.5 * Math.cos(age * TAU * (rem < 1 ? 8 : 5)) : 1;
      if (p.type === 'gem') {
        if (ng >= GEM_CAP) continue;
        const v = p.value > 1 ? p.value : 1, lv = v < 256 ? LOG2[v | 0] : Math.log2(v);
        let sc = 1 + lv * 0.28; if (sc > 2.1) sc = 2.1;
        const tc = lv >= 4 ? 1 : lv * 0.25;
        const cr = GEM_A[0] + (GEM_B[0] - GEM_A[0]) * tc, cg = GEM_A[1] + (GEM_B[1] - GEM_A[1]) * tc, cb = GEM_A[2] + (GEM_B[2] - GEM_A[2]) * tc;
        const y = 0.26 + 0.05 * Math.sin(t * 4 + p.id * 1.7) + 0.02 * sc;
        PB[0] = p.x; PB[1] = y; PB[2] = p.z; PB[3] = t * 2.6 + p.id; PB[4] = 0.3; PB[5] = 0.15; PB[6] = 0.08 * sc; PB[7] = 0.17 * sc; PB[8] = 0.08 * sc; writeYXZ(gemMesh.instanceMatrix.array, ng * 16);
        const ci = ng * 3; gemMesh.instanceColor.array[ci] = cr; gemMesh.instanceColor.array[ci + 1] = cg; gemMesh.instanceColor.array[ci + 2] = cb;
        ng++;
        const gc = GEMTMP; gc[0] = cr; gc[1] = cg; gc[2] = cb;
        (PB[0] = p.x, PB[1] = y, PB[2] = p.z, PB[3] = 0.42 * sc, PB[4] = 0.55, PB[5] = 0.9, PB[6] = 0, PB[7] = 1, PB[8] = 0, wSpr(sprA, gc, F.SOFT));
        // magnet trail
        let tr = gemTrack.get(p.id);
        if (!tr) { tr = trackPool.pop() || { x: 0, z: 0, s: 0 }; tr.x = p.x; tr.z = p.z; gemTrack.set(p.id, tr); }
        const mv = Math.sqrt((p.x - tr.x) * (p.x - tr.x) + (p.z - tr.z) * (p.z - tr.z));
        if (dt > 0 && mv > dt * 1.2) {
          const n = nEmit(dt * 38 * qMul);
          for (let j = 0; j < n; j++) {
            const f = rand();
            const q = (PB[0] = tr.x + (p.x - tr.x) * f + rr(-0.05, 0.05), PB[1] = y + rr(-0.05, 0.05), PB[2] = tr.z + (p.z - tr.z) * f + rr(-0.05, 0.05), PB[3] = 0.14 * sc, PB[4] = 0.02, PB[5] = rr(0.18, 0.32), PB[6] = 1.3, PB[7] = 1, spriteP(PA, rand() < 0.3 ? F.STAR : F.DOT, gc));
            q.rot = rand() * TAU;
          }
          (PB[0] = tr.x, PB[1] = y, PB[2] = tr.z, PB[3] = p.x, PB[4] = y, PB[5] = p.z, PB[6] = 0.03 * sc, PB[7] = 1.1, PB[8] = 0.8, PB[9] = 0.5, PB[10] = 0, PB[11] = 2.5, PB[12] = 0, PB[13] = 0, wStk(gc));
        }
        tr.x = p.x; tr.z = p.z; tr.s = stamp;
      } else if (p.type === 'heart') {
        if (nh >= HEART_CAP) continue;
        const app = Math.min(1, Math.max(0, age / 0.2));
        const y = 0.55 + 0.08 * Math.sin(t * 3.2 + p.id);

        const beat = Math.pow(Math.max(0, Math.sin(t * 7.5 + p.id)), 8) * 0.12;
        const sc = 0.5 * (0.5 + 0.5 * app) * (rem < 2 ? 0.82 + 0.18 * blink : 1) * (1 + beat);
        PB[0] = p.x; PB[1] = y; PB[2] = p.z; PB[3] = Math.sin(t * 2.4 + p.id) * 0.7; PB[4] = -0.75; PB[5] = 0; PB[6] = sc; PB[7] = sc; PB[8] = sc; writeYXZ(heartMesh.instanceMatrix.array, nh * 16); nh++;
        (PB[0] = p.x, PB[1] = y, PB[2] = p.z, PB[3] = 1.1, PB[4] = 0.35 * (0.6 + 0.4 * blink), PB[5] = 1, PB[6] = 0, PB[7] = 1, PB[8] = 0, wSpr(sprA, C_HURT, F.SOFT));
        (PB[0] = p.x, PB[1] = 0.011, PB[2] = p.z, PB[3] = 0, PB[4] = 0.36, PB[5] = 0.36, PB[6] = 4, PB[7] = 0, PB[8] = 1, PB[9] = 0.55, PB[10] = 0, PB[11] = 0, PB[12] = 0, PB[13] = 0, wDec(decN, C_SHADOW));
        (PB[0] = p.x, PB[1] = 0.016, PB[2] = p.z, PB[3] = 0, PB[4] = 0.7, PB[5] = 0.7, PB[6] = 0, PB[7] = 0, PB[8] = 0.25 * blink, PB[9] = 1, PB[10] = 0, PB[11] = 0, PB[12] = 0, PB[13] = 0, wDec(decA, C_HURT));
      } else if (p.type === 'orb') {
        if (no >= ORB_CAP) continue;
        const fam = p.fam || (PICKUPS[p.pup] ? PICKUPS[p.pup].fam : 'wep');
        const c = FAM_C[fam] || FAM_C.wep;
        const drop = Math.min(1, Math.max(0, age / 0.32)), de = 1 - (1 - drop) * (1 - drop);
        const bob = 0.07 * Math.sin(t * 3 + p.id);
        const y = 0.78 + bob + (1 - de) * 2.6;
        const urgent = rem < 2;
        const sc = 0.33 * (0.4 + 0.6 * de) * (urgent ? 0.86 + 0.14 * blink : 1) * (1 + 0.04 * Math.sin(t * 6 + p.id));
        const o = no * 4;
        orbP.array[o] = p.x; orbP.array[o + 1] = y; orbP.array[o + 2] = p.z; orbP.array[o + 3] = sc;
        orbC.array[o] = c[0]; orbC.array[o + 1] = c[1]; orbC.array[o + 2] = c[2]; orbC.array[o + 3] = urgent ? blink : 0.6 + 0.4 * Math.sin(t * 5 + p.id) * 0.5;
        no++;
        // icon in front of the orb (toward the camera)
        _v.set(camPos.x - p.x, camPos.y - y, camPos.z - p.z).normalize();
        (PB[0] = p.x + _v.x * sc * 1.05, PB[1] = y + _v.y * sc * 1.05, PB[2] = p.z + _v.z * sc * 1.05, PB[3] = sc * 1.95, PB[4] = 1, PB[5] = urgent ? 0.55 + 0.45 * blink : 1, PB[6] = 0, PB[7] = 1, PB[8] = 0, wSpr(sprN, C_ICON, PUP_FRAME[p.pup] || F.ICON));
        (PB[0] = p.x, PB[1] = y, PB[2] = p.z, PB[3] = 4.2 * sc, PB[4] = 0.42 * (urgent ? 0.5 + 0.5 * blink : 1), PB[5] = 1, PB[6] = 0, PB[7] = 1, PB[8] = 0, wSpr(sprA, c, F.SOFT));
        // beacon shaft + floor ring timer
        (PB[0] = p.x, PB[1] = 0.02, PB[2] = p.z, PB[3] = p.x, PB[4] = 2.0, PB[5] = p.z, PB[6] = 0.2, PB[7] = 0.3, PB[8] = urgent ? 0.4 * blink : 0.55, PB[9] = 0.15, PB[10] = 3, PB[11] = 2.2, PB[12] = 1, PB[13] = 0, wStk(c));
        const frac = life > 0 ? Math.min(1, Math.max(0, rem / life)) : 1;
        const rc = urgent ? C_HURT : c;
        (PB[0] = p.x, PB[1] = 0.022, PB[2] = p.z, PB[3] = 0.62, PB[4] = 0.3, PB[5] = 0, PB[6] = Math.PI, PB[7] = 0, PB[8] = 0.22, PB[9] = 0.6, PB[10] = 2, PB[11] = 0, PB[12] = 0, PB[13] = 0, wBnd(c));
        if (frac > 0.002) (PB[0] = p.x, PB[1] = 0.024, PB[2] = p.z, PB[3] = 0.62, PB[4] = 0.075, PB[5] = Math.PI - frac * Math.PI, PB[6] = frac * Math.PI, PB[7] = 0, PB[8] = 1.7, PB[9] = urgent ? 0.5 + 0.5 * blink : 1, PB[10] = 2, PB[11] = 0, PB[12] = 0, PB[13] = 0, wBnd(rc));
        (PB[0] = p.x, PB[1] = 0.016, PB[2] = p.z, PB[3] = 0, PB[4] = 0.95, PB[5] = 0.95, PB[6] = 0, PB[7] = 0, PB[8] = 0.3, PB[9] = 1, PB[10] = 0, PB[11] = 0, PB[12] = 0, PB[13] = 0, wDec(decA, c));
        (PB[0] = p.x, PB[1] = 0.011, PB[2] = p.z, PB[3] = 0, PB[4] = 0.42, PB[5] = 0.42, PB[6] = 4, PB[7] = 0, PB[8] = 1, PB[9] = 0.5 * de, PB[10] = 0, PB[11] = 0, PB[12] = 0, PB[13] = 0, wDec(decN, C_SHADOW));
      }
    }
    // forget vanished gems
    if (gemTrack.size) gemTrack.forEach(purgeGem);
    gemMesh.count = ng; gemMesh.visible = ng > 0;
    if (ng) { gemMesh.instanceMatrix.needsUpdate = true; gemMesh.instanceColor.needsUpdate = true; }
    heartMesh.count = nh; heartMesh.visible = nh > 0; if (nh) heartMesh.instanceMatrix.needsUpdate = true;
    orbGeo.instanceCount = no; orbMesh.visible = no > 0;
    if (no) { orbP.needsUpdate = true; orbC.needsUpdate = true; }
  }
  const GEMTMP = [0, 0, 0];
  function purgeGem(tr, id) { if (tr.s !== stamp) { gemTrack.delete(id); trackPool.push(tr); } }

  function syncPlayer(P, t, dt) {
    const alive = P.alive !== false;
    // STATIC FIELD
    const L = alive ? (P.aura | 0) : 0;
    if (L > 0) {
      const R = 1.2 + 0.5 * L;
      (PB[0] = px, PB[1] = 0.03, PB[2] = pz, PB[3] = R, PB[4] = 0.26, PB[5] = 0, PB[6] = Math.PI, PB[7] = 0, PB[8] = 1.5, PB[9] = 0.95, PB[10] = 3, PB[11] = 0, PB[12] = 1.7, PB[13] = 0, wBnd(C_AURA));
      (PB[0] = px, PB[1] = 0.028, PB[2] = pz, PB[3] = R, PB[4] = 0.55, PB[5] = 0, PB[6] = Math.PI, PB[7] = 0, PB[8] = 0.3, PB[9] = 0.7, PB[10] = 2, PB[11] = 0, PB[12] = 0, PB[13] = 0, wBnd(C_AURA));
      (PB[0] = px, PB[1] = 0.017, PB[2] = pz, PB[3] = 0, PB[4] = R * 1.05, PB[5] = R * 1.05, PB[6] = 0, PB[7] = 0, PB[8] = 0.08, PB[9] = 1, PB[10] = 0, PB[11] = 0, PB[12] = 0, PB[13] = 0, wDec(decA, C_AURA));
      const n = nEmit(dt * (5 + 4 * L) * qMul);
      for (let j = 0; j < n; j++) {
        const a0 = rand() * TAU, a1 = a0 + rr(0.3, 0.7);
        (PB[0] = px + Math.sin(a0) * R, PB[1] = rr(0.05, 0.25), PB[2] = pz + Math.cos(a0) * R, PB[3] = px + Math.sin(a1) * R, PB[4] = rr(0.05, 0.35), PB[5] = pz + Math.cos(a1) * R, PB[6] = 0.14, PB[7] = 0.025, PB[8] = 2.2, PB[9] = rr(0.06, 0.12), lightP(4, C_AURA));
      }
    }
    // OVERSHIELD
    const sh = alive ? (P.shieldT || 0) : 0;
    if (sh > 0) {
      shieldAge += dt;
      shieldMesh.visible = true;
      shieldMesh.position.set(px, 0.6, pz);
      shieldMesh.scale.setScalar(0.95 * (0.85 + 0.15 * Math.min(1, Math.max(0, shieldAge * 6))) * (1 + 0.02 * Math.sin(t * 5)));
      const fl = sh < 1.5 ? 0.55 + 0.45 * (Math.sin(t * TAU * 5) > 0 ? 1 : 0) : 1;
      mShield.uniforms.uAlpha.value = Math.min(1, Math.max(0, shieldAge * 5)) * fl;
      (PB[0] = px, PB[1] = 0.017, PB[2] = pz, PB[3] = 0, PB[4] = 1.1, PB[5] = 1.1, PB[6] = 0, PB[7] = 0, PB[8] = 0.18, PB[9] = 1, PB[10] = 0, PB[11] = 0, PB[12] = 0, PB[13] = 0, wDec(decA, C_SHIELD));
    } else {
      if (prevShield > 0 && P.alive !== false) shieldPop(px, pz);
      shieldAge = 0;
      shieldMesh.visible = shieldFlash > 0.02;
      if (shieldMesh.visible) { shieldMesh.position.set(px, 0.6, pz); mShield.uniforms.uAlpha.value = shieldFlash; }
    }
    prevShield = sh;
    mShield.uniforms.uFlash.value = shieldFlash;
    // OVERDRIVE
    const od = alive ? (P.odT || 0) : 0;
    if (od > 0) {
      const pu = 0.85 + 0.15 * Math.sin(t * 9);
      (PB[0] = px, PB[1] = 0.017, PB[2] = pz, PB[3] = 0, PB[4] = 1.7, PB[5] = 1.7, PB[6] = 0, PB[7] = 0, PB[8] = 0.42 * pu, PB[9] = 1, PB[10] = 0, PB[11] = 0, PB[12] = 0, PB[13] = 0, wDec(decA, C_GOLD));
      (PB[0] = px, PB[1] = 0.03, PB[2] = pz, PB[3] = 0.95, PB[4] = 0.3, PB[5] = t * 5.5, PB[6] = 1.3, PB[7] = 0, PB[8] = 2.4, PB[9] = 1, PB[10] = 4, PB[11] = 0, PB[12] = 0, PB[13] = 0, wBnd(C_GOLD));
      (PB[0] = px, PB[1] = 0.03, PB[2] = pz, PB[3] = 0.95, PB[4] = 0.3, PB[5] = t * 5.5 + Math.PI, PB[6] = 1.3, PB[7] = 0, PB[8] = 2.4, PB[9] = 1, PB[10] = 4, PB[11] = 0, PB[12] = 0, PB[13] = 0, wBnd(C_GOLD));
      (PB[0] = px, PB[1] = 0.03, PB[2] = pz, PB[3] = 1.4, PB[4] = 0.22, PB[5] = -t * 3.8, PB[6] = 1.0, PB[7] = 0, PB[8] = 1.8, PB[9] = 0.85, PB[10] = 4, PB[11] = 0, PB[12] = 0, PB[13] = 0, wBnd(C_GOLDW));
      (PB[0] = px, PB[1] = 0.03, PB[2] = pz, PB[3] = 1.4, PB[4] = 0.22, PB[5] = -t * 3.8 + Math.PI, PB[6] = 1.0, PB[7] = 0, PB[8] = 1.8, PB[9] = 0.85, PB[10] = 4, PB[11] = 0, PB[12] = 0, PB[13] = 0, wBnd(C_GOLDW));
      if (walls) (PB[0] = px, PB[1] = 0, PB[2] = pz, PB[3] = 1.0, PB[4] = 0.2, PB[5] = 0, PB[6] = Math.PI, PB[7] = 1, PB[8] = 0.6, PB[9] = 0.45 * pu, PB[10] = 0, PB[11] = 0.7, PB[12] = 0, PB[13] = 0, wBnd(C_GOLD));
      const n = nEmit(dt * 44 * qMul);
      for (let j = 0; j < n; j++) {
        const a = rand() * TAU, rd = rr(0.35, 1.2);
        const q = (PB[0] = px + Math.sin(a) * rd, PB[1] = rr(0.05, 0.4), PB[2] = pz + Math.cos(a) * rd, PB[3] = rr(0.14, 0.26), PB[4] = 0.03, PB[5] = rr(0.5, 0.8), PB[6] = 1.7, PB[7] = 1, spriteP(PA, rand() < 0.35 ? F.STAR : F.DOT, rand() < 0.4 ? C_GOLDW : C_GOLD));
        q.vy = rr(1.4, 2.6); q.vx = Math.cos(a) * 0.6; q.vz = -Math.sin(a) * 0.6; q.rot = rand() * TAU;
      }
    } else if (prevOd > 0 && od <= 0) {
      burstSparks(14, px, 0.5, pz, 1, 3, C_GOLD, 1.5, 1, 0.5, 0.02, 0.3);
    }
    prevOd = od;
    // DASH afterimages
    if (alive && (P.dashT || 0) > 0 && dt > 0) {
      const mx = px - ppx, mz = pz - ppz, md = Math.sqrt((mx) * (mx) + (mz) * (mz));
      const n = nEmit(dt * 45);
      for (let j = 0; j < n; j++) {
        const f = rand();
        const q = (PB[0] = ppx + mx * f, PB[1] = 0.58, PB[2] = ppz + mz * f, PB[3] = 1.25, PB[4] = 0.9, PB[5] = 0.22, PB[6] = 0.45, PB[7] = 1, spriteP(PA, F.SOFT, C_PLAYER));
        q.aspect = 0.55; q.hold = 0;
      }
      if (md > 0.01) {
        const nx = -mz / md, nz = mx / md;
        for (let l = -1; l <= 1; l++) {
          const o = l * 0.26, y = 0.35 + (l + 1) * 0.25;
          const q = (PB[0] = ppx + nx * o - mx * 0.6, PB[1] = y, PB[2] = ppz + nz * o - mz * 0.6, PB[3] = px + nx * o, PB[4] = y, PB[5] = pz + nz * o, PB[6] = 0.028, PB[7] = 1.4, PB[8] = 0.2, PB[9] = 0.5, segP(C_PLAYER, 0));
          q.tail = 0; q.hold = 0;
        }
      }
    }
  }

  function shieldPop(x, z) {
    shieldFlash = 1;
    (PB[0] = x, PB[1] = 0.03, PB[2] = z, PB[3] = 0.6, PB[4] = 1.9, PB[5] = 0.3, PB[6] = 0.06, PB[7] = 0.35, PB[8] = 1.6, PB[9] = 1, PB[10] = 0.6, ringP(C_SHIELD, 0, 0));
    for (let i = 0; i < Math.round(10 * qMul); i++) {
      const a = rand() * TAU, e = rr(-0.2, 0.9);
      const p = (PB[0] = x + Math.sin(a) * 0.8, PB[1] = 0.6 + e * 0.6, PB[2] = z + Math.cos(a) * 0.8, PB[3] = 0.28, PB[4] = 0.08, PB[5] = rr(0.35, 0.55), PB[6] = 1.5, PB[7] = 1, spriteP(PA, F.HEX, C_SHIELD));
      p.vx = Math.sin(a) * rr(1.5, 3); p.vz = Math.cos(a) * rr(1.5, 3); p.vy = rr(0.5, 2.5); p.g = 3; p.drag = 1.5; p.rot = rand() * TAU; p.vrot = rr(-6, 6);
    }
    halo(x, 0.6, z, 1.4, 2.6, 0.18, C_SHIELD, 1.0, 1);
  }

  // ================================================================ FLUSH (instances -> GPU)
  function flush() {
    for (let i = 0; i < SYS.length; i++) SYS[i].beginFlush();
    // additive + normal sprite particles
    writeSprites(PA, sprA); writeSprites(PN, sprN);
    // streak particles
    const it = PS.a;
    for (let i = 0; i < PS.n; i++) {
      const p = it[i], k = p.age / p.life;
      const fo = k < p.hold ? 1 : 1 - (k - p.hold) / (1 - p.hold);
      const a = p.a * fo, w = p.w0 + (p.w1 - p.w0) * k;
      const j = strk.add(); if (j < 0) break;
      const o = j * 4, S0 = strk.gpu[0], S1 = strk.gpu[1], S2 = strk.gpu[2], S3 = strk.gpu[3];
      if (p.fixed) {
        S0[o] = p.ax; S0[o + 1] = p.ay; S0[o + 2] = p.az; S1[o] = p.bx; S1[o + 1] = p.by; S1[o + 2] = p.bz;
      } else {
        const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy + p.vz * p.vz) || 1;
        let L = sp * p.stretch; L = L < p.minL ? p.minL : L > p.maxL ? p.maxL : L;
        const q = L / sp;
        S0[o] = p.x - p.vx * q; S0[o + 1] = p.y - p.vy * q; S0[o + 2] = p.z - p.vz * q; S1[o] = p.x; S1[o + 1] = p.y; S1[o + 2] = p.z;
      }
      S0[o + 3] = w; S1[o + 3] = p.tail;
      S2[o] = p.cr; S2[o + 1] = p.cg; S2[o + 2] = p.cb; S2[o + 3] = a;
      S3[o] = p.hot; S3[o + 1] = p.style; S3[o + 2] = p.seed; S3[o + 3] = p.glow;
    }
    // timed bands
    const bt = PBD.a;
    for (let i = 0; i < PBD.n; i++) {
      const p = bt[i], k = p.age / p.life, e = 1 - Math.pow(1 - k, p.ease);
      const fo = k < p.hold ? 1 : 1 - (k - p.hold) / (1 - p.hold);
      const R = p.R0 + (p.R1 - p.R0) * e, w = p.w0 + (p.w1 - p.w0) * e, al = p.al * fo * fo;
      if (p.mode === 1 && !walls) continue;
      const j = band.add(); if (j < 0) break;
      band.acc += (R > 0.2 ? R : 0.2) * p.half * (p.mode ? p.h0 : w) * al * 0.6;
      const o = j * 4, B0 = band.gpu[0], B1 = band.gpu[1], B2 = band.gpu[2], B3 = band.gpu[3];
      B0[o] = p.x; B0[o + 1] = p.y; B0[o + 2] = p.z; B0[o + 3] = R;
      B1[o] = w; B1[o + 1] = p.a + p.spin * p.age; B1[o + 2] = p.half; B1[o + 3] = p.mode;
      B2[o] = p.cr; B2[o + 1] = p.cg; B2[o + 2] = p.cb; B2[o + 3] = al;
      B3[o] = p.style; B3[o + 1] = p.h0 + (p.h1 - p.h0) * e; B3[o + 2] = 0; B3[o + 3] = p.caps;
    }
    writeDecals(PDA, decA); writeDecals(PDN, decN);
    for (let i = 0; i < SYS.length; i++) SYS[i].endFlush();
    // debris
    const dt_ = PD.a; const ea = debGeo.attributes.aEmit.array; const ca = debMesh.instanceColor.array; const DM = debMesh.instanceMatrix.array;
    for (let i = 0; i < PD.n; i++) {
      const p = dt_[i], k = p.age / p.life;
      const sh = k > 0.75 ? 1 - (k - 0.75) / 0.25 : 1;
      PB[0] = p.x; PB[1] = p.y; PB[2] = p.z; PB[3] = p.sx * sh; PB[4] = p.sy * sh; PB[5] = p.sz * sh; writeTRS(DM, i * 16, p.q);
      ca[i * 3] = p.cr; ca[i * 3 + 1] = p.cg; ca[i * 3 + 2] = p.cb; ea[i] = p.emit * (1 - k * 0.6);
    }
    debMesh.count = PD.n; debMesh.visible = PD.n > 0;
    if (PD.n) { debMesh.instanceMatrix.needsUpdate = true; debMesh.instanceColor.needsUpdate = true; debGeo.attributes.aEmit.needsUpdate = true; }
    // damage numbers
    nums.beginImm(); nums.beginFlush();
    const nt = PNUM.a;
    for (let i = 0; i < PNUM.n; i++) {
      const p = nt[i], k = p.age / p.life;
      const pop = p.age < 0.09 ? 1 + (p.crit ? 0.9 : 0.6) * (1 - p.age / 0.09) : 1;
      const rise = 1 - Math.pow(1 - Math.min(1, p.age / (p.life * 0.7)), 3);
      const a = k < 0.65 ? 1 : 1 - (k - 0.65) / 0.35;
      const j = nums.add(); if (j < 0) break;
      const hgt = (p.crit ? 0.6 : 0.46) * pop;
      const o = j * 4, N0 = nums.gpu[0], N1 = nums.gpu[1], N2 = nums.gpu[2], N3 = nums.gpu[3];
      N0[o] = p.x; N0[o + 1] = p.y + rise * (p.crit ? 0.95 : 0.75); N0[o + 2] = p.z; N0[o + 3] = hgt;
      N1[o] = p.g0; N1[o + 1] = p.g1; N1[o + 2] = p.g2; N1[o + 3] = p.g3;
      if (p.crit) { N2[o] = 1.25; N2[o + 1] = 0.72; N2[o + 2] = 0.16; } else { N2[o] = 0.8; N2[o + 1] = 0.83; N2[o + 2] = 0.88; }
      N2[o + 3] = a; N3[o] = p.n; N3[o + 1] = 0; N3[o + 2] = 0; N3[o + 3] = 0;
    }
    nums.endFlush();
  }
  function writeSprites(pool, sys) {
    const it = pool.a;
    for (let i = 0; i < pool.n; i++) {
      const p = it[i], k = p.age / p.life;
      const fi = p.fi > 0 ? Math.min(1, 0.25 + p.age / p.fi) : 1;
      const fo = k < p.hold ? 1 : 1 - (k - p.hold) / (1 - p.hold);
      const a = p.a * fi * fo;
      const s = p.s0 + (p.s1 - p.s0) * (1 - (1 - k) * (1 - k));
      const j = sys.add(); if (j < 0) break;
      sys.acc += (s * s < 3 ? s * s : 3) * a * (p.cr > p.cg ? (p.cr > p.cb ? p.cr : p.cb) : (p.cg > p.cb ? p.cg : p.cb)) * (1 + p.hot);
      let asp = p.aspect;
      if (p.flutter) asp *= 0.25 + 0.75 * Math.abs(Math.cos(p.age * p.flutter + p.fph));
      const o = j * 4, A0 = sys.gpu[0], A1 = sys.gpu[1], A2 = sys.gpu[2];
      A0[o] = p.x; A0[o + 1] = p.y; A0[o + 2] = p.z; A0[o + 3] = s;
      A1[o] = p.cr; A1[o + 1] = p.cg; A1[o + 2] = p.cb; A1[o + 3] = a;
      A2[o] = p.rot + p.vrot * p.age; A2[o + 1] = p.frame; A2[o + 2] = asp; A2[o + 3] = p.hot;
    }
  }
  function writeDecals(pool, sys) {
    const it = pool.a;
    for (let i = 0; i < pool.n; i++) {
      const p = it[i], k = p.age / p.life, e = 1 - (1 - k) * (1 - k);
      const fo = k < p.hold ? 1 : 1 - (k - p.hold) / (1 - p.hold);
      const fi = p.fi > 0 ? Math.min(1, p.age / p.fi) : 1;
      const a = p.al * fo * fi;
      const hx = p.sx0 + (p.sx1 - p.sx0) * e, hz = p.sz0 + (p.sz1 - p.sz0) * e;
      const j = sys.add(); if (j < 0) break;
      sys.acc += hx * hz * a * (p.cr > p.cg ? (p.cr > p.cb ? p.cr : p.cb) : (p.cg > p.cb ? p.cg : p.cb)) * 0.6;
      const o = j * 4, D0 = sys.gpu[0], D1 = sys.gpu[1], D2 = sys.gpu[2], D3 = sys.gpu[3];
      D0[o] = p.x; D0[o + 1] = p.y; D0[o + 2] = p.z; D0[o + 3] = p.rot;
      D1[o] = hx; D1[o + 1] = hz; D1[o + 2] = p.shape; D1[o + 3] = p.p0;
      D2[o] = p.cr; D2[o + 1] = p.cg; D2[o + 2] = p.cb; D2[o + 3] = a;
      D3[o] = p.q0; D3[o + 1] = p.q1; D3[o + 2] = p.q2; D3[o + 3] = p.q3;
    }
  }

  // ================================================================ UPDATE
  function update(t, dt) {
    dt = clamp(dt || 0, 0, 0.05);
    time = t; U.uTime.value = t;
    if (dt > 0) {
      // sprites
      stepSprites(PA, dt); stepSprites(PN, dt);
      // streaks
      for (let i = PS.n - 1; i >= 0; i--) {
        const p = PS.a[i]; p.age += dt;
        if (p.age >= p.life) { PS.kill(i); continue; }
        if (!p.fixed) {
          const dr = Math.max(0, 1 - p.drag * dt);
          p.vx *= dr; p.vz *= dr; p.vy = p.vy * dr - p.g * dt;
          p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
          if (p.y < 0.02 && p.vy < 0) { p.y = 0.02; p.vy *= -p.bounce; p.vx *= 0.7; p.vz *= 0.7; }
        }
      }
      // debris
      for (let i = PD.n - 1; i >= 0; i--) {
        const p = PD.a[i]; p.age += dt;
        if (p.age >= p.life) { PD.kill(i); continue; }
        if (p.rest) continue;
        p.vy -= p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        const fl = p.sy * 0.5 + 0.005;
        if (p.y < fl) {
          p.y = fl;
          if (p.vy < 0) { p.vy *= -p.bounce; p.vx *= 0.55; p.vz *= 0.55; p.wx *= 0.5; p.wy *= 0.5; p.wz *= 0.5; }
          if (Math.abs(p.vy) < 0.6 && Math.sqrt((p.vx) * (p.vx) + (p.vz) * (p.vz)) < 0.3) { p.rest = true; p.vy = 0; }
        }
        const w = Math.sqrt(p.wx * p.wx + p.wy * p.wy + p.wz * p.wz);
        if (w > 1e-3) {
          // q = dq(axis-angle) * q, written on the quaternion's fields directly (no Vector3/Quaternion calls)
          const half = w * dt * 0.5, sn = Math.sin(half) / w, ax = p.wx * sn, ay = p.wy * sn, az = p.wz * sn, aw = Math.cos(half);
          const q = p.q, bx = q._x, by = q._y, bz = q._z, bw = q._w;
          q._x = ax * bw + aw * bx + ay * bz - az * by; q._y = ay * bw + aw * by + az * bx - ax * bz;
          q._z = az * bw + aw * bz + ax * by - ay * bx; q._w = aw * bw - ax * bx - ay * by - az * bz;
        }
      }
      stepAges(PBD, dt); stepAges(PDA, dt); stepAges(PDN, dt);
      for (let i = PNUM.n - 1; i >= 0; i--) { const p = PNUM.a[i]; p.age += dt; if (p.age >= p.life) PNUM.kill(i); }
      // sequences
      for (let i = SEQ.n - 1; i >= 0; i--) {
        const s = SEQ.a[i]; s.age += dt;
        runSeq(s, dt);
        if (s.age >= s.dur) SEQ.kill(i);
      }
      // shake
      trauma = Math.max(0, trauma - dt * 1.5);
      shT += dt;
      shieldFlash = Math.max(0, shieldFlash - dt * 6);
      // governor smoothing
      for (let i = 0; i < SYS.length; i++) {
        const s = SYS[i];
        s.gain += (s.gainT - s.gain) * Math.min(1, dt * (s.gainT < s.gain ? 25 : 5));
        s.mat.uniforms.uGain.value = s.gain;
      }
    }
    const tt = trauma * trauma;
    shakeVec.set(
      (Math.sin(shT * 37.3) * 0.6 + Math.sin(shT * 71.9 + 1.7) * 0.4) * 0.42 * tt,
      (Math.sin(shT * 43.1 + 0.6) * 0.6 + Math.sin(shT * 89.3 + 2.9) * 0.4) * 0.26 * tt,
      (Math.sin(shT * 29.7 + 4.2) * 0.6 + Math.sin(shT * 63.1 + 0.4) * 0.4) * 0.3 * tt,
    );
    flush();
  }
  function stepSprites(pool, dt) {
    for (let i = pool.n - 1; i >= 0; i--) {
      const p = pool.a[i]; p.age += dt;
      if (p.age >= p.life) { pool.kill(i); continue; }
      const dr = Math.max(0, 1 - p.drag * dt);
      p.vx *= dr; p.vz *= dr; p.vy = p.vy * dr - p.g * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.y < p.floor) { p.y = p.floor; if (p.vy < 0) { p.vy *= -p.bounce; p.vx *= 0.4; p.vz *= 0.4; if (p.flutter) { p.flutter = 0; p.vrot = 0; p.vx = p.vz = 0; p.g = 0; p.vy = 0; } } }
    }
  }
  function stepAges(pool, dt) { for (let i = pool.n - 1; i >= 0; i--) { const p = pool.a[i]; p.age += dt; if (p.age >= p.life) pool.kill(i); } }

  // ================================================================ sequences
  function seq(type, x, z, dur, kind) {
    const s = SEQ.get(); s.type = type; s.x = x; s.z = z; s.dur = dur; s.age = 0; s.kind = kind || ''; s.stage = 0; s.acc = 0; return s;
  }
  function runSeq(s, dt) {
    const kc = KC[s.kind] || KC.boss_gateway;
    if (s.type === 'bossDying') {
      const k = clamp01(s.age / s.dur);
      const H = (KIND_DIMS[s.kind] || KIND_DIMS.boss_gateway).h, BR = (KIND_DIMS[s.kind] || KIND_DIMS.boss_gateway).r;
      if (s.stage === 0) {
        s.stage = 1;
        const g = (PB[0] = s.x, PB[1] = s.z, PB[2] = 2.6, PB[3] = 3.4, PB[4] = s.dur + 0.1, PB[5] = 0.55, PB[6] = 1, decalP(PDA, 0, C_RING)); g.fi = s.dur * 0.85; g.hold = 0.9;
      }
      // explosions ramping 4/s -> 26/s, growing in size
      const n = nEmit(dt * (4 + 22 * k * k) * qMul);
      for (let i = 0; i < n; i++) {
        // on the camera-facing half of the hull so the hull never hides them
        const a = rr(-1.9, 1.9), rd = BR * rr(0.85, 1.25), ex = s.x + Math.sin(a) * rd, ez = s.z + Math.cos(a) * rd, ey = rr(0.4, H * 0.95);
        explosion(ex, ey, ez, rr(0.7, 1.2) * (0.8 + 0.7 * k), kc, rand() < 0.6 ? 1 : 0);
        trauma = Math.min(1, trauma + 0.05 + 0.05 * k);
      }
      const la = nEmit(dt * (3 + 6 * k) * qMul);
      for (let i = 0; i < la; i++) {
        const a = rr(-1.8, 1.8), ey = rr(0.5, H * 0.9), a2 = a + rr(-0.9, 0.9);
        (PB[0] = s.x + Math.sin(a) * BR * 1.05, PB[1] = ey, PB[2] = s.z + Math.cos(a) * BR * 1.05, PB[3] = s.x + Math.sin(a2) * BR * 1.1, PB[4] = ey + rr(-1.2, 1.2), PB[5] = s.z + Math.cos(a2) * BR * 1.1, PB[6] = 0.3, PB[7] = 0.035, PB[8] = 2.2, PB[9] = rr(0.08, 0.14), lightP(5, kc.glow));
      }
      // continuous spark streams from the body
      const m = nEmit(dt * (30 + 40 * k) * qMul);
      for (let i = 0; i < m; i++) {
        const a = rr(-2, 2); const ex = s.x + Math.sin(a) * BR, ez = s.z + Math.cos(a) * BR, ey = rr(0.8, H * 0.85);
        (PB[0] = ex, PB[1] = ey, PB[2] = ez, PB[3] = Math.sin(a) * rr(2, 5), PB[4] = rr(1, 5), PB[5] = Math.cos(a) * rr(2, 5), PB[6] = 1.8, PB[7] = 0.5, PB[8] = 0.022, sparkP(rand() < 0.5 ? C_GOLDW : kc.glow));
      }
      // growing core light near the end
      if (k > 0.7) {
        const p = (PB[0] = s.x, PB[1] = H * 0.5, PB[2] = s.z, PB[3] = 2 + 5 * (k - 0.7), PB[4] = 2.5 + 5 * (k - 0.7), PB[5] = 0.05, PB[6] = 0.9 * (k - 0.7) / 0.3 + 0.2, PB[7] = 1, spriteP(PA, F.SOFT, kc.glow)); p.hot = 0.4;
      }
    } else if (s.type === 'bossKill') {
      const H = (KIND_DIMS[s.kind] || KIND_DIMS.boss_gateway).h;
      if (s.stage === 0 && s.age >= 0.16) {
        s.stage = 1;
        for (let i = 0; i < 5; i++) {
          const a = i / 5 * TAU + rr(-0.3, 0.3), rd = rr(1.4, 2.8), ex = s.x + Math.sin(a) * rd, ez = s.z + Math.cos(a) * rd;
          explosion(ex, rr(0.6, 1.8), ez, rr(1.6, 2.2), kc, 2);
          (PB[0] = ex, PB[1] = 0.03, PB[2] = ez, PB[3] = 0.3, PB[4] = rr(1.2, 1.8), PB[5] = 0.3, PB[6] = 0.06, PB[7] = 0.35, PB[8] = 1.1, PB[9] = 0.6, PB[10] = 0.6, ringP(C_RING, 0, 0));
          (PB[0] = ex, PB[1] = ez, PB[2] = 1.0, PB[3] = 1.1, PB[4] = 3.5, PB[5] = 1, PB[6] = 0.55, decalP(PDN, 3, C_SCORCH));
        }
        trauma = Math.min(1, trauma + 0.4);
      }
      if (s.stage === 1 && s.age >= 0.45) {
        s.stage = 2;
        const n = Math.round(46 * qMul);
        for (let i = 0; i < n; i++) {
          const pc = rand() < 0.3 ? C_GOLD : rand() < 0.5 ? kc.glow : kc.body;
          const d = (PB[0] = s.x + rr(-3, 3), PB[1] = rr(4.5, 6.5), PB[2] = s.z + rr(-3, 3), PB[3] = pc === kc.body ? 0 : 1.2, PB[4] = rr(0.08, 0.18), PB[5] = 1.5, PB[6] = 0.5, debrisP(pc));
          d.life = rr(1.8, 2.6);
        }
        for (let i = 0; i < Math.round(8 * qMul); i++) {
          const p = (PB[0] = s.x + rr(-1, 1), PB[1] = rr(0.5, 2), PB[2] = s.z + rr(-1, 1), PB[3] = rr(1.5, 2.2), PB[4] = rr(3, 4.5), PB[5] = rr(1.6, 2.4), PB[6] = 1, PB[7] = 0.55, spriteP(PN, F.SMOKE, C_SMOKE));
          p.vy = rr(1.2, 2.4); p.vx = rr(-0.6, 0.6); p.vz = rr(-0.6, 0.6); p.drag = 0.8; p.rot = rand() * TAU; p.vrot = rr(-0.8, 0.8); p.fi = 0.2;
        }
        for (let i = 0; i < Math.round(30 * qMul); i++) {
          const p = (PB[0] = s.x + rr(-2, 2), PB[1] = rr(0.2, 2.5), PB[2] = s.z + rr(-2, 2), PB[3] = rr(0.08, 0.16), PB[4] = 0.02, PB[5] = rr(1.2, 2.2), PB[6] = 1.8, PB[7] = 1, spriteP(PA, F.DOT, rand() < 0.5 ? C_GOLD : C_RING));
          p.vy = rr(0.8, 2.2); p.vx = rr(-0.8, 0.8); p.vz = rr(-0.8, 0.8); p.drag = 0.6;
        }
      }
      void H;
    } else if (s.type === 'victory') {
      const n = nEmit(dt * 150 * qMul * (s.age < 2 ? 1 : 0.3));
      for (let i = 0; i < n; i++) {
        const c = CONFETTI[(rand() * CONFETTI.length) | 0];
        const p = (PB[0] = s.x + rr(-6, 6), PB[1] = rr(5, 7.5), PB[2] = s.z + rr(-7, 5), PB[3] = rr(0.2, 0.3), PB[4] = rr(0.2, 0.3), PB[5] = rr(2.6, 3.6), PB[6] = 1.0, PB[7] = 1, spriteP(PN, F.SQUARE, c));
        p.g = 2.4; p.drag = 1.2; p.vy = rr(-1.5, 0); p.vx = rr(-1, 1); p.vz = rr(-1, 1);
        p.rot = rand() * TAU; p.vrot = rr(-7, 7); p.aspect = 0.7; p.flutter = rr(5, 10); p.fph = rand() * 6; p.floor = 0.03; p.hold = 0.75;
      }
    }
  }

  // ================================================================ EVENTS
  function kindColors(kind) { return KC[kind] || KC_DEF; }
  function killBurst(ev) {
    const kind = ev.kind, kc = kindColors(kind), dims = KIND_DIMS[kind] || KIND_DIMS.xb6;
    const pod = kind === 'pod', elite = !!ev.elite;
    const sc = (pod ? 0.6 : 1) * (elite ? 1.3 : 1);
    const x = ev.x, z = ev.z, cy = (ev.y || 0) + dims.h * 0.5 * (elite ? 1.25 : 1);
    const phone = dims.family === 'phone';
    // debris shards
    const nd = Math.round((pod ? 5 : phone ? 11 : 10) * (elite ? 1.6 : 1) * qMul);
    for (let i = 0; i < nd; i++) {
      const r = rand();
      const c = r < 0.55 ? kc.body : r < 0.84 ? kc.trim : kc.glow;
      (PB[0] = x + rr(-0.15, 0.15) * sc, PB[1] = cy + rr(-0.2, 0.2) * sc, PB[2] = z + rr(-0.15, 0.15) * sc, PB[3] = c === kc.glow ? 1.6 : 0, PB[4] = rr(0.12, 0.24) * sc, PB[5] = 3.6, PB[6] = 7, debrisP(c));
    }
    if (elite) for (let i = 0; i < Math.round(5 * qMul); i++) (PB[0] = x, PB[1] = cy, PB[2] = z, PB[3] = 0.9, PB[4] = rr(0.1, 0.17), PB[5] = 4.5, PB[6] = 7.5, debrisP(C_GOLD));
    // sparks
    burstSparks(pod ? 8 : 15, x, cy, z, 3.5, 9, kc.glow, 1.9, 0.9, 0.45, 0.028, 0.35);
    // electric pop
    (PB[0] = x, PB[1] = cy, PB[2] = z, PB[3] = 1.7 * sc, PB[4] = 1.0, PB[5] = 0.13, PB[6] = 0.9, flashP(kc.glow));
    const rp = (PB[0] = x, PB[1] = cy, PB[2] = z, PB[3] = 0.3 * sc, PB[4] = 1.5 * sc, PB[5] = 0.2, PB[6] = 1.1, PB[7] = 0.85, spriteP(PA, F.SOFTRING, kc.glow)); rp.hold = 0;
    const cp = (PB[0] = x, PB[1] = cy, PB[2] = z, PB[3] = 1.1 * sc, PB[4] = 1.5 * sc, PB[5] = 0.12, PB[6] = 1.2, PB[7] = 1, spriteP(PA, F.CRACKLE, WHITE)); cp.rot = rand() * TAU; cp.hold = 0.3;
    if (Q > 0) for (let i = 0; i < 2; i++) { const a = rand() * TAU, l = rr(0.5, 0.9) * sc; (PB[0] = x, PB[1] = cy, PB[2] = z, PB[3] = x + Math.sin(a) * l, PB[4] = cy + rr(-0.3, 0.4), PB[5] = z + Math.cos(a) * l, PB[6] = 0.12, PB[7] = 0.025, PB[8] = 2.2, PB[9] = 0.1, lightP(4, kc.glow)); }
    // floor
    (PB[0] = x, PB[1] = 0.03, PB[2] = z, PB[3] = 0.25 * sc, PB[4] = 1.2 * sc, PB[5] = 0.2, PB[6] = 0.05, PB[7] = 0.3, PB[8] = 1.2, PB[9] = 0.65, PB[10] = 0.6, ringP(kc.glow, 0, 0));
    (PB[0] = x, PB[1] = z, PB[2] = 1.3 * sc, PB[3] = 1.6 * sc, PB[4] = 0.22, PB[5] = 0.55, PB[6] = 1, decalP(PDA, 0, kc.glow)).hold = 0;
    (PB[0] = x, PB[1] = z, PB[2] = 0.55 * sc, PB[3] = 0.6 * sc, PB[4] = 2.2, PB[5] = 1, PB[6] = 0.55, decalP(PDN, 3, C_SCORCH));
    smoke(x, cy, z, pod ? 1 : 2, C_SMOKE, 1, 0.45, 0.5 * sc, 1.2 * sc, 0.8, 0.9);
    if (elite) {
      (PB[0] = x, PB[1] = 0.035, PB[2] = z, PB[3] = 0.4, PB[4] = 1.7, PB[5] = 0.14, PB[6] = 0.04, PB[7] = 0.45, PB[8] = 1.6, PB[9] = 0.9, PB[10] = 0.6, ringP(C_GOLD, 0, 0));
      for (let i = 0; i < Math.round(9 * qMul); i++) {
        const a = rand() * TAU;
        const p = (PB[0] = x, PB[1] = cy, PB[2] = z, PB[3] = rr(0.3, 0.5), PB[4] = 0.05, PB[5] = rr(0.5, 0.8), PB[6] = 1.6, PB[7] = 1, spriteP(PA, F.STAR, C_GOLDW));
        p.vx = Math.sin(a) * rr(1.5, 3.5); p.vz = Math.cos(a) * rr(1.5, 3.5); p.vy = rr(1, 3.5); p.drag = 2.5; p.g = 2; p.rot = rand() * TAU;
      }
    }
    trauma = Math.min(1, trauma + (elite ? 0.12 : pod ? 0.03 : 0.06));
  }

  function numGlyphs(p, v) {
    // integer or one-decimal (< 10) formatting, max 4 glyphs
    let n = 0; const g = NUMTMP;
    if (v < 9.95 && Math.abs(v - Math.round(v)) > 0.05) {
      const t10 = Math.round(v * 10), ip = Math.floor(t10 / 10), fp = t10 % 10;
      g[n++] = F.DIGIT + ip; g[n++] = F.GDOT; g[n++] = F.DIGIT + fp;
    } else {
      let iv = Math.min(9999, Math.max(0, Math.round(v)));
      const d = iv >= 1000 ? 4 : iv >= 100 ? 3 : iv >= 10 ? 2 : 1;
      for (let i = d - 1; i >= 0; i--) { g[i] = F.DIGIT + (iv % 10); iv = Math.floor(iv / 10); }
      n = d;
    }
    p.n = n; p.g0 = g[0]; p.g1 = n > 1 ? g[1] : 0; p.g2 = n > 2 ? g[2] : 0; p.g3 = n > 3 ? g[3] : 0;
  }
  const NUMTMP = [0, 0, 0, 0];
  let numSide = 1;
  function damageNumber(ev) {
    const v = (ev.dmg || 0) * api.dmgScale;
    if (!(v > 0)) return;
    const crit = !!ev.crit;
    // merge with a fresh number on the same enemy
    for (let i = 0; i < PNUM.n; i++) {
      const p = PNUM.a[i];
      if (p.id === ev.id && p.age < 0.2 && p.crit === crit) { p.val += v; numGlyphs(p, p.val); p.age = 0; return; }
    }
    const p = PNUM.get();
    const dims = KIND_DIMS[ev.kind];
    p.id = ev.id; p.crit = crit; p.val = v; p.age = 0; p.life = crit ? 0.85 : 0.62;
    numSide = -numSide; p.x = ev.x + numSide * rr(0.12, 0.38); p.z = ev.z + rr(-0.1, 0.1);
    p.y = Math.max((ev.y || 0) + 0.3, dims ? Math.min(dims.h, 2.2) + 0.25 : 1.2);
    // older numbers on the same target fast-forward to their fade-out so the newest one reads cleanly
    for (let i = 0; i < PNUM.n; i++) { const q = PNUM.a[i]; if (q !== p && q.id === ev.id) q.age = Math.max(q.age, q.life - 0.12); }
    numGlyphs(p, v);
  }

  function event(ev) {
    if (!ev || !ev.type) return;
    const T = ev.type;
    switch (T) {
      case 'start': reset(); break;
      case 'spawn': {
        const kc = kindColors(ev.kind), y = (ev.y || 0) + (KIND_DIMS[ev.kind] ? KIND_DIMS[ev.kind].h * 0.5 : 0.5);
        (PB[0] = ev.x, PB[1] = y, PB[2] = ev.z, PB[3] = 1.4, PB[4] = 1.1, PB[5] = 0.24, PB[6] = 0.8, flashP(kc.glow));
        const rp = (PB[0] = ev.x, PB[1] = y, PB[2] = ev.z, PB[3] = 0.2, PB[4] = 1.6, PB[5] = 0.32, PB[6] = 1.3, PB[7] = 1, spriteP(PA, F.RING, kc.glow)); rp.hold = 0;
        const cp = (PB[0] = ev.x, PB[1] = y, PB[2] = ev.z, PB[3] = 0.9, PB[4] = 1.3, PB[5] = 0.14, PB[6] = 1.1, PB[7] = 1, spriteP(PA, F.CRACKLE, WHITE)); cp.rot = rand() * TAU;
        const bm = (PB[0] = ev.x, PB[1] = (ev.y || 0), PB[2] = ev.z, PB[3] = ev.x, PB[4] = (ev.y || 0) + 1.8, PB[5] = ev.z, PB[6] = 0.3, PB[7] = 1.2, PB[8] = 0.35, PB[9] = 0.8, segP(kc.glow, 3)); bm.w1 = 0.05; bm.glow = 2.2;
        (PB[0] = ev.x, PB[1] = (ev.y || 0) + 0.025, PB[2] = ev.z, PB[3] = 0.2, PB[4] = 1.0, PB[5] = 0.16, PB[6] = 0.04, PB[7] = 0.3, PB[8] = 1.3, PB[9] = 0.8, PB[10] = 0.6, ringP(kc.glow, 0, 0));
        burstSparks(10, ev.x, y, ev.z, 1.5, 4.5, kc.glow, 1.8, 1, 0.45, 0.022, 0.3);
        if (ev.elite) burstSparks(6, ev.x, y, ev.z, 1.5, 3.5, C_GOLD, 1.8, 1, 0.5, 0.022, 0);
        break;
      }
      case 'land': {
        const big = ev.kind === 'xb3' || ev.kind === 'fold' || (KIND_DIMS[ev.kind] && KIND_DIMS[ev.kind].boss);
        const R = KIND_DIMS[ev.kind] ? KIND_DIMS[ev.kind].r : 0.45;
        dust(ev.x, ev.z, big ? 8 : 5, R * 1.6, C_DUST, 0.38);
        (PB[0] = ev.x, PB[1] = 0.025, PB[2] = ev.z, PB[3] = R, PB[4] = R * 2.4, PB[5] = 0.18, PB[6] = 0.04, PB[7] = 0.28, PB[8] = 0.5, PB[9] = 0.5, PB[10] = 0.6, ringP(WHITE, 0, 0));
        if (big) trauma = Math.min(1, trauma + 0.08);
        break;
      }
      case 'shot': {
        const tier = clamp(ev.tier | 0, 0, WEAPONS.length - 1), c = lastState && lastState.player && lastState.player.odT > 0 ? C_GOLDW : TIER_C[tier];
        // optional exact muzzle (integrator may add ev.mx/my/mz from fox.muzzle()); else 0.45 m along the aim at y 0.75
        const a = ev.a || 0, mx = ev.mx != null ? ev.mx : ev.x + Math.sin(a) * 0.45, mz = ev.mz != null ? ev.mz : ev.z + Math.cos(a) * 0.45;
        const my = ev.my != null ? ev.my : 0.75;
        const p = (PB[0] = mx, PB[1] = my, PB[2] = mz, PB[3] = 0.55 + 0.05 * tier, PB[4] = 0.75 + 0.05 * tier, PB[5] = 0.075, PB[6] = 1.4, PB[7] = 1, spriteP(PA, F.FLARE, c)); p.rot = rand() * TAU; p.hot = 1; p.hold = 0;
        (PB[0] = mx, PB[1] = my, PB[2] = mz, PB[3] = 0.4, PB[4] = 1.2, PB[5] = 0.05, PB[6] = 1, flashP(c));
        if (rand() < 0.6) { const b = (PB[0] = mx, PB[1] = my, PB[2] = mz, PB[3] = Math.sin(a + rr(-0.5, 0.5)) * 5, PB[4] = rr(0.5, 2), PB[5] = Math.cos(a + rr(-0.5, 0.5)) * 5, PB[6] = 1.8, PB[7] = 0.12, PB[8] = 0.018, sparkP(c)); b.g = 4; }
        break;
      }
      case 'hit': {
        const hy = ev.y != null && ev.y > 0.05 ? ev.y : 0.7;   // sim sends mid-height of the target
        const c = ev.crit ? C_GOLDW : WHITE;
        if (!ev.killed) {
          (PB[0] = ev.x, PB[1] = hy, PB[2] = ev.z, PB[3] = ev.crit ? 0.85 : 0.5, PB[4] = 1.1, PB[5] = 0.07, PB[6] = 1, flashP(ev.crit ? C_GOLD : C_PLAYER));
          burstSparks(ev.crit ? 8 : 4, ev.x, hy, ev.z, 2.5, 6, c, 1.8, 0.7, 0.22, 0.018, 0.5);
          if (ev.crit) { const p = (PB[0] = ev.x, PB[1] = hy, PB[2] = ev.z, PB[3] = 0.9, PB[4] = 0.3, PB[5] = 0.16, PB[6] = 1.5, PB[7] = 1, spriteP(PA, F.STAR, C_GOLDW)); p.rot = rand(); }
        }
        damageNumber(ev);
        break;
      }
      case 'kill': killBurst(ev); break;
      case 'enemyShot': {
        const c = ev.shotType === 'bolt' ? C_EBOLT : ev.shotType === 'ring' ? C_RING : ev.shotType === 'notif' ? C_PINK : C_ORB;
        (PB[0] = ev.x, PB[1] = 0.7, PB[2] = ev.z, PB[3] = 0.7, PB[4] = 1.0, PB[5] = 0.09, PB[6] = 0.6, flashP(c));
        break;
      }
      case 'windup': {
        const dims = KIND_DIMS[ev.kind];
        const y = dims ? Math.min(dims.h, 3) + 0.25 : 1.4;
        const p = (PB[0] = ev.x, PB[1] = y, PB[2] = ev.z, PB[3] = 0.7, PB[4] = 0.25, PB[5] = 0.28, PB[6] = 1.5, PB[7] = 1, spriteP(PA, F.FLARE, C_WARN)); p.rot = rand(); p.vrot = 6; p.hot = 0.6;
        break;
      }
      case 'attack': {
        const dims = KIND_DIMS[ev.kind] || KIND_DIMS.xb6, boss = !!dims.boss;
        const at = ev.attack;
        if (at === 'stomp' || at === 'slam' || at === 'leap' || at === 'flip' || at === 'fold' || at === 'chomp') {
          const R = dims.r * (boss ? 1.4 : 1.7);
          dust(ev.x, ev.z, boss ? 12 : 6, R, C_DUST, 0.42);
          (PB[0] = ev.x, PB[1] = 0.025, PB[2] = ev.z, PB[3] = dims.r, PB[4] = R * 2, PB[5] = boss ? 0.5 : 0.22, PB[6] = 0.05, PB[7] = boss ? 0.5 : 0.32, PB[8] = 0.6, PB[9] = 0.6, PB[10] = 0.6, ringP(WHITE, 0, 0));
          trauma = Math.min(1, trauma + (boss ? 0.35 : ev.kind === 'xb3' || ev.kind === 'fold' ? 0.16 : 0.07));
        } else if (at === 'charge') {
          dust(ev.x, ev.z, 4, 0.6, C_DUST, 0.35);
          trauma = Math.min(1, trauma + 0.04);
        } else if (boss) trauma = Math.min(1, trauma + 0.15);
        break;
      }
      case 'hazardWarn': {
        (PB[0] = ev.x, PB[1] = 0.025, PB[2] = ev.z, PB[3] = 1.6, PB[4] = 0.5, PB[5] = 0.12, PB[6] = 0.06, PB[7] = 0.3, PB[8] = 1.3, PB[9] = 0.8, PB[10] = 0.6, ringP(C_WARN, 2, 0));
        break;
      }
      case 'hazardLive': {
        let H = null;
        if (lastState && lastState.hazards) for (let i = 0; i < lastState.hazards.length; i++) if (lastState.hazards[i].id === ev.id) { H = lastState.hazards[i]; break; }
        // NOTE: the contract's hazard `type` field collides with the event's own `type`, so the
        // hazard kind is resolved from the last synced state by id (fallback: common alt names).
        const R = H && H.r ? H.r : 1;
        const ty = H ? H.type : (ev.hazard || ev.htype || ev.hazardType || ev.shape || 'spark');
        hazardLive(ty, ev, H, R);
        break;
      }
      case 'hurt': {
        const x = ev.x != null ? ev.x : px, z = ev.z != null ? ev.z : pz;
        halo(x, 0.6, z, 1.0, 2.6, 0.2, C_HURT, 1.3, 1);
        burstSparks(16, x, 0.6, z, 3, 8, C_HURT, 1.8, 0.9, 0.35, 0.026, 0.25);
        (PB[0] = x, PB[1] = 0.03, PB[2] = z, PB[3] = 0.3, PB[4] = 1.8, PB[5] = 0.3, PB[6] = 0.05, PB[7] = 0.32, PB[8] = 1.4, PB[9] = 0.9, PB[10] = 0.6, ringP(C_HURT, 0, 0));
        trauma = Math.min(1, trauma + 0.42);
        break;
      }
      case 'shieldBlock': shieldPop(ev.x != null ? ev.x : px, ev.z != null ? ev.z : pz); trauma = Math.min(1, trauma + 0.15); break;
      case 'dash': {
        const x = ev.x, z = ev.z, a = ev.a || 0;
        dust(x, z, 5, 0.5, C_DUST, 0.35);
        (PB[0] = x, PB[1] = 0.03, PB[2] = z, PB[3] = 0.3, PB[4] = 1.2, PB[5] = 0.2, PB[6] = 0.04, PB[7] = 0.25, PB[8] = 1.3, PB[9] = 0.8, PB[10] = 0.6, ringP(C_PLAYER, 0, 0));
        for (let i = 0; i < Math.round(8 * qMul); i++) {
          const o = rr(-0.45, 0.45), y = rr(0.2, 1.1), bx = -Math.sin(a), bz = -Math.cos(a), nx = Math.cos(a), nz = -Math.sin(a);
          const l = rr(0.8, 1.8);
          const q = (PB[0] = x + nx * o, PB[1] = y, PB[2] = z + nz * o, PB[3] = x + nx * o + bx * l, PB[4] = y, PB[5] = z + nz * o + bz * l, PB[6] = 0.022, PB[7] = 1.5, PB[8] = rr(0.15, 0.25), PB[9] = 0.6, segP(C_PLAYER, 0));
          q.tail = 1; q.hold = 0;
        }
        break;
      }
      case 'dashHit': {
        const y = 0.6;
        for (let s = -1; s <= 1; s += 2) {
          const a = rand() * Math.PI, l = 0.75;
          const q = (PB[0] = ev.x - Math.cos(a) * l, PB[1] = y + s * 0.15, PB[2] = ev.z - Math.sin(a) * l, PB[3] = ev.x + Math.cos(a) * l, PB[4] = y - s * 0.15, PB[5] = ev.z + Math.sin(a) * l, PB[6] = 0.05, PB[7] = 1.6, PB[8] = 0.14, PB[9] = 1.2, segP(WHITE, 0)); q.hold = 0;
        }
        (PB[0] = ev.x, PB[1] = y, PB[2] = ev.z, PB[3] = 1.1, PB[4] = 1.2, PB[5] = 0.1, PB[6] = 1, flashP(C_PLAYER));
        burstSparks(8, ev.x, y, ev.z, 3, 7, C_PLAYER, 1.8, 0.7, 0.3, 0.02, 0.5);
        trauma = Math.min(1, trauma + 0.1);
        break;
      }
      case 'pulse': {
        const x = ev.x != null ? ev.x : px, z = ev.z != null ? ev.z : pz, r = ev.r || 3.5;
        (PB[0] = x, PB[1] = 0.035, PB[2] = z, PB[3] = 0.3, PB[4] = r, PB[5] = 0.9, PB[6] = 0.3, PB[7] = 0.42, PB[8] = 1.7, PB[9] = 1, PB[10] = 0.6, ringP(C_PLAYER, 0, 0)).ease = 3;
        const wr = (PB[0] = x, PB[1] = 0, PB[2] = z, PB[3] = 0.3, PB[4] = r, PB[5] = 0.3, PB[6] = 0.2, PB[7] = 0.42, PB[8] = 1.0, PB[9] = 0.8, PB[10] = 1.4, ringP(C_PLAYER, 0, 1)); wr.ease = 3;
        (PB[0] = x, PB[1] = 0.03, PB[2] = z, PB[3] = 0.2, PB[4] = r * 0.7, PB[5] = 0.3, PB[6] = 0.1, PB[7] = 0.5, PB[8] = 1.4, PB[9] = 0.7, PB[10] = 0.6, ringP(C_AURA, 2, 0)).ease = 2.5;
        halo(x, 0.7, z, 1.2, 3.6, 0.22, C_PLAYER, 1.2, 1);
        (PB[0] = x, PB[1] = z, PB[2] = r * 0.5, PB[3] = r * 1.05, PB[4] = 0.26, PB[5] = 0.12, PB[6] = 1, decalP(PDA, 0, C_PLAYER)).hold = 0;
        const n = Math.round(26 * qMul);
        for (let i = 0; i < n; i++) { const a = i / n * TAU + rr(-0.1, 0.1), sp = rr(8, 13); (PB[0] = x, PB[1] = rr(0.3, 0.9), PB[2] = z, PB[3] = Math.sin(a) * sp, PB[4] = rr(0, 1.5), PB[5] = Math.cos(a) * sp, PB[6] = 1.8, PB[7] = 0.3, PB[8] = 0.03, sparkP(rand() < 0.4 ? WHITE : C_PLAYER)).drag = 4; }
        trauma = Math.min(1, trauma + 0.28);
        break;
      }
      case 'gem': {
        if (gemLoadAcc > 30) break; // rate-limit twinkles during vacuum storms
        gemLoadAcc += 1;
        const v = Math.max(1, ev.value || 1), tc = clamp01(Math.log2(v) / 4);
        const c = tc < 0.5 ? GEM_A : GEM_B;
        for (let i = 0; i < 2; i++) {
          const p = (PB[0] = ev.x + rr(-0.15, 0.15), PB[1] = rr(0.3, 0.6), PB[2] = ev.z + rr(-0.15, 0.15), PB[3] = rr(0.35, 0.5), PB[4] = 0.05, PB[5] = rr(0.25, 0.4), PB[6] = 1.6, PB[7] = 1, spriteP(PA, F.STAR, c));
          p.vy = rr(0.8, 1.6); p.rot = rand(); p.vrot = rr(-4, 4);
        }
        break;
      }
      case 'pickupSpawn': {
        const c = FAM_C[ev.fam] || (PICKUPS[ev.pup] ? FAM_C[PICKUPS[ev.pup].fam] : (ev.pickup || ev.pickupType) === 'heart' ? C_HURT : C_PLAYER);
        const b = (PB[0] = ev.x, PB[1] = 0, PB[2] = ev.z, PB[3] = ev.x, PB[4] = CEIL_Y + 0.5, PB[5] = ev.z, PB[6] = 0.42, PB[7] = 1.4, PB[8] = 0.75, PB[9] = 0.9, segP(c, 3)); b.w1 = 0.05; b.hold = 0.25; b.glow = 2.2;
        (PB[0] = ev.x, PB[1] = 0.03, PB[2] = ev.z, PB[3] = 0.2, PB[4] = 1.4, PB[5] = 0.3, PB[6] = 0.05, PB[7] = 0.45, PB[8] = 1.5, PB[9] = 1, PB[10] = 0.6, ringP(c, 0, 0));
        (PB[0] = ev.x, PB[1] = ev.z, PB[2] = 1.4, PB[3] = 0.9, PB[4] = 0.6, PB[5] = 0.6, PB[6] = 1, decalP(PDA, 0, c));
        for (let i = 0; i < Math.round(10 * qMul); i++) {
          const p = (PB[0] = ev.x + rr(-0.3, 0.3), PB[1] = rr(0.3, 3.5), PB[2] = ev.z + rr(-0.3, 0.3), PB[3] = rr(0.2, 0.35), PB[4] = 0.04, PB[5] = rr(0.4, 0.7), PB[6] = 1.6, PB[7] = 1, spriteP(PA, F.STAR, c));
          p.vy = rr(-2.5, -1); p.rot = rand() * TAU;
        }
        break;
      }
      case 'pickup': {
        const c = FAM_C[ev.fam] || (PICKUPS[ev.pup] ? FAM_C[PICKUPS[ev.pup].fam] : C_HURT);
        (PB[0] = ev.x, PB[1] = 0.03, PB[2] = ev.z, PB[3] = 0.3, PB[4] = 1.7, PB[5] = 0.3, PB[6] = 0.05, PB[7] = 0.36, PB[8] = 1.6, PB[9] = 1, PB[10] = 0.6, ringP(c, 0, 0));
        halo(ev.x, 0.7, ev.z, 0.8, 2.4, 0.26, c, 1.3, 1);
        pillars(ev.x, ev.z, 5, 0.75, 1.3, c, 1.4, 0.4);
        burstSparks(16, ev.x, 0.8, ev.z, 2, 6, c, 1.8, 1, 0.4, 0.024, 0.4);
        for (let i = 0; i < Math.round(8 * qMul); i++) {
          const a = rand() * TAU;
          const p = (PB[0] = ev.x + Math.sin(a) * 0.7, PB[1] = rr(0.3, 1), PB[2] = ev.z + Math.cos(a) * 0.7, PB[3] = rr(0.25, 0.4), PB[4] = 0.04, PB[5] = rr(0.4, 0.7), PB[6] = 1.6, PB[7] = 1, spriteP(PA, F.STAR, c));
          p.vy = rr(1.5, 3); p.rot = rand() * TAU;
        }
        break;
      }
      case 'pickupExpire': {
        const c = FAM_C[ev.fam] || C_DUST;
        smoke(ev.x, 0.6, ev.z, 3, C_SMOKE, 1.5, 0.4, 0.4, 0.9, 0.6, 0.8);
        (PB[0] = ev.x, PB[1] = 0.03, PB[2] = ev.z, PB[3] = 0.6, PB[4] = 0.1, PB[5] = 0.1, PB[6] = 0.05, PB[7] = 0.3, PB[8] = 0.8, PB[9] = 0.6, PB[10] = 0.6, ringP(c, 2, 0));
        burstSparks(6, ev.x, 0.7, ev.z, 0.5, 1.5, c, 1.0, 0.5, 0.3, 0.015, 0);
        break;
      }
      case 'heal': {
        for (let i = 0; i < Math.round(8 * qMul); i++) {
          const a = rand() * TAU, rd = rr(0.3, 0.8);
          const p = (PB[0] = px + Math.sin(a) * rd, PB[1] = rr(0.2, 0.9), PB[2] = pz + Math.cos(a) * rd, PB[3] = rr(0.22, 0.34), PB[4] = 0.08, PB[5] = rr(0.6, 0.9), PB[6] = 1.5, PB[7] = 1, spriteP(PA, F.PLUS, C_HEAL));
          p.vy = rr(0.8, 1.6); p.hold = 0.4;
        }
        (PB[0] = px, PB[1] = 0.03, PB[2] = pz, PB[3] = 0.4, PB[4] = 1.4, PB[5] = 0.2, PB[6] = 0.05, PB[7] = 0.4, PB[8] = 1.3, PB[9] = 0.8, PB[10] = 0.6, ringP(C_HEAL, 0, 0));
        break;
      }
      case 'tierUp': {
        const tier = clamp(ev.tier | 0, 0, WEAPONS.length - 1), c = TIER_SAT[tier];
        pillars(px, pz, 8, 1.05, 2.0, c, 1.6, 0.6);
        halo(px, 0.6, pz, 1.0, 3.2, 0.3, c, 1.2, 0.9);
        ring(px, 0.035, pz, 0.8, 2.6, 0.3, 0.06, 0.5, c, 1.7, 1, 0);
        ring(px, 0, pz, 0.9, 2.4, 0.3, 0.1, 0.5, c, 1.0, 0.6, 0, 1, 1.3);
        (PB[0] = px, PB[1] = pz, PB[2] = 1.2, PB[3] = 2.4, PB[4] = 0.35, PB[5] = 0.15, PB[6] = 1, decalP(PDA, 0, c)).hold = 0;
        for (let i = 0; i < Math.round(24 * qMul); i++) { const a = rand() * TAU, sp = rr(4, 9); spark(px + Math.sin(a) * 0.6, rr(0.3, 1.0), pz + Math.cos(a) * 0.6, Math.sin(a) * sp, rr(1, 5), Math.cos(a) * sp, rand() < 0.4 ? WHITE : c, 1.9, rr(0.35, 0.6), 0.026); }
        for (let i = 0; i < Math.round(12 * qMul); i++) {
          const a = rand() * TAU, rd = rr(0.7, 1.2);
          const p = (PB[0] = px + Math.sin(a) * rd, PB[1] = rr(0.2, 1.4), PB[2] = pz + Math.cos(a) * rd, PB[3] = rr(0.3, 0.5), PB[4] = 0.05, PB[5] = rr(0.6, 1), PB[6] = 1.7, PB[7] = 1, spriteP(PA, F.STAR, c));
          p.vy = rr(1.5, 3); p.rot = rand() * TAU;
        }
        trauma = Math.min(1, trauma + 0.18);
        break;
      }
      case 'combo': {
        const m = Math.max(2, ev.mult || 2);
        (PB[0] = px, PB[1] = 0.035, PB[2] = pz, PB[3] = 0.4, PB[4] = 1.2 + m * 0.15, PB[5] = 0.14, PB[6] = 0.04, PB[7] = 0.3, PB[8] = 1.4, PB[9] = 0.8, PB[10] = 0.6, ringP(C_GOLD, 2, 0));
        for (let i = 0; i < Math.round(m * 2 * qMul); i++) {
          const a = rand() * TAU;
          const p = (PB[0] = px + Math.sin(a) * 0.5, PB[1] = rr(0.6, 1.3), PB[2] = pz + Math.cos(a) * 0.5, PB[3] = rr(0.25, 0.4), PB[4] = 0.05, PB[5] = rr(0.4, 0.6), PB[6] = 1.6, PB[7] = 1, spriteP(PA, F.STAR, C_GOLDW));
          p.vy = rr(1, 2.2); p.vx = Math.sin(a) * 1.2; p.vz = Math.cos(a) * 1.2; p.rot = rand() * TAU;
        }
        break;
      }
      case 'overdrive': {
        const x = ev.x != null ? ev.x : px, z = ev.z != null ? ev.z : pz;
        (PB[0] = x, PB[1] = 0.035, PB[2] = z, PB[3] = 0.3, PB[4] = 3.8, PB[5] = 0.6, PB[6] = 0.15, PB[7] = 0.5, PB[8] = 1.7, PB[9] = 1, PB[10] = 0.6, ringP(C_GOLD, 0, 0)).ease = 3;
        (PB[0] = x, PB[1] = 0, PB[2] = z, PB[3] = 0.3, PB[4] = 3.5, PB[5] = 0.3, PB[6] = 0.1, PB[7] = 0.5, PB[8] = 1.0, PB[9] = 0.8, PB[10] = 1.5, ringP(C_GOLD, 0, 1)).ease = 3;
        halo(x, 0.7, z, 1.2, 4.0, 0.28, C_GOLD, 1.3, 1);
        burstSparks(30, x, 0.6, z, 4, 10, C_GOLDW, 1.9, 1.1, 0.55, 0.028, 0.3);
        trauma = Math.min(1, trauma + 0.3);
        break;
      }
      case 'overdriveEnd': break; // handled in sync (odT edge)
      case 'bossIntro': trauma = Math.min(1, trauma + 0.25); break;
      case 'bossPhase': {
        const kc = kindColors(ev.kind || bossKind);
        (PB[0] = bossX, PB[1] = 2, PB[2] = bossZ, PB[3] = 4, PB[4] = 1.0, PB[5] = 0.25, PB[6] = 0.8, flashP(kc.glow));
        (PB[0] = bossX, PB[1] = 0.035, PB[2] = bossZ, PB[3] = 1, PB[4] = 6, PB[5] = 0.6, PB[6] = 0.15, PB[7] = 0.6, PB[8] = 1.5, PB[9] = 1, PB[10] = 0.6, ringP(kc.glow, 0, 0));
        if (walls) (PB[0] = bossX, PB[1] = 0, PB[2] = bossZ, PB[3] = 1, PB[4] = 5.5, PB[5] = 0.3, PB[6] = 0.1, PB[7] = 0.6, PB[8] = 0.9, PB[9] = 0.8, PB[10] = 1.6, ringP(kc.glow, 0, 1));
        burstSparks(30, bossX, 2, bossZ, 4, 10, kc.glow, 1.9, 1, 0.6, 0.03, 0.4);
        trauma = Math.min(1, trauma + 0.45);
        break;
      }
      case 'bossDying': {
        const kind = ev.kind || bossKind;
        seq('bossDying', ev.x != null ? ev.x : bossX, ev.z != null ? ev.z : bossZ, 2.5, kind);
        trauma = Math.min(1, trauma + 0.35);
        break;
      }
      case 'bossKill': {
        const kind = ev.kind || bossKind, kc = kindColors(kind), x = ev.x != null ? ev.x : bossX, z = ev.z != null ? ev.z : bossZ;
        const H = (KIND_DIMS[kind] || KIND_DIMS.boss_gateway).h;
        const f = (PB[0] = x, PB[1] = H * 0.45, PB[2] = z, PB[3] = 9, PB[4] = 1.2, PB[5] = 0.3, PB[6] = 1.2, flashP(WHITE)); f.s1 = 11;
        for (let i = 0; i < Math.round(12 * qMul); i++) {
          const p = (PB[0] = x + rr(-1.2, 1.2), PB[1] = rr(0.5, H * 0.8), PB[2] = z + rr(-1.2, 1.2), PB[3] = rr(1.8, 3.2), PB[4] = rr(3, 4.5), PB[5] = rr(0.45, 0.8), PB[6] = 1.3, PB[7] = 1, spriteP(PA, F.SOFT, rand() < 0.5 ? C_RING : C_GOLD));
          p.vy = rr(0.5, 2); p.hot = 0.5; p.hold = 0.2;
        }
        for (let i = 0; i < Math.round(6 * qMul); i++) {
          const p = (PB[0] = x + rr(-1.2, 1.2), PB[1] = rr(0.8, H * 0.7), PB[2] = z + rr(-1.2, 1.2), PB[3] = rr(1.4, 2.2), PB[4] = rr(3.5, 5), PB[5] = rr(1.6, 2.4), PB[6] = 1, PB[7] = 0.55, spriteP(PN, F.SMOKE, C_SMOKE));
          p.vy = rr(1.0, 2.2); p.vx = rr(-1, 1); p.vz = rr(-1, 1); p.drag = 0.9; p.rot = rand() * TAU; p.vrot = rr(-0.6, 0.6); p.fi = 0.3; p.hold = 0.2;
        }
        (PB[0] = x, PB[1] = 0.04, PB[2] = z, PB[3] = 0.8, PB[4] = 9.5, PB[5] = 1.3, PB[6] = 0.2, PB[7] = 0.75, PB[8] = 1.6, PB[9] = 1, PB[10] = 0.6, ringP(C_RING, 0, 0)).ease = 3;
        (PB[0] = x, PB[1] = 0, PB[2] = z, PB[3] = 0.8, PB[4] = 9, PB[5] = 0.4, PB[6] = 0.2, PB[7] = 0.75, PB[8] = 1.0, PB[9] = 0.8, PB[10] = 2.6, ringP(C_RING, 0, 1)).ease = 3;
        (PB[0] = x, PB[1] = 0.035, PB[2] = z, PB[3] = 0.5, PB[4] = 6, PB[5] = 0.4, PB[6] = 0.1, PB[7] = 0.6, PB[8] = 1.5, PB[9] = 0.9, PB[10] = 0.6, ringP(kc.glow, 2, 0)).ease = 2.5;
        (PB[0] = x, PB[1] = z, PB[2] = 3, PB[3] = 7, PB[4] = 0.35, PB[5] = 0.6, PB[6] = 1, decalP(PDA, 0, C_GOLD)).hold = 0;
        (PB[0] = x, PB[1] = z, PB[2] = 3.2, PB[3] = 3.4, PB[4] = 5, PB[5] = 1, PB[6] = 0.7, decalP(PDN, 3, C_SCORCH));
        const nd = Math.round(70 * qMul);
        for (let i = 0; i < nd; i++) {
          const r = rand(); const c = r < 0.5 ? kc.body : r < 0.8 ? kc.trim : kc.glow;
          (PB[0] = x + rr(-1, 1), PB[1] = rr(0.5, H * 0.8), PB[2] = z + rr(-1, 1), PB[3] = c === kc.glow ? 1.5 : 0, PB[4] = rr(0.12, 0.34), PB[5] = rr(6, 12), PB[6] = rr(6, 12), debrisP(c));
        }
        burstSparks(60, x, H * 0.5, z, 6, 16, C_GOLDW, 1.9, 1.2, 0.8, 0.035, 0.4);
        for (let i = 0; i < 4; i++) { const a = rand() * TAU; (PB[0] = x, PB[1] = H * 0.5, PB[2] = z, PB[3] = x + Math.sin(a) * 3, PB[4] = rr(0.1, H), PB[5] = z + Math.cos(a) * 3, PB[6] = 0.4, PB[7] = 0.04, PB[8] = 2.2, PB[9] = 0.18, lightP(6, kc.glow)); }
        seq('bossKill', x, z, 1.2, kind);
        trauma = 1;
        break;
      }
      case 'shake': trauma = Math.min(1, trauma + clamp01(ev.amt || 0) * 0.85); break;
      case 'victory': {
        seq('victory', px, pz, 3.5, '');
        (PB[0] = px, PB[1] = 0.035, PB[2] = pz, PB[3] = 0.3, PB[4] = 4, PB[5] = 0.5, PB[6] = 0.1, PB[7] = 0.8, PB[8] = 1.6, PB[9] = 1, PB[10] = 0.6, ringP(C_GOLD, 0, 0)).ease = 3;
        halo(px, 0.8, pz, 1.2, 4.2, 0.4, C_GOLDW, 1.2, 1);
        break;
      }
      case 'gameover': {
        (PB[0] = px, PB[1] = 0.6, PB[2] = pz, PB[3] = 2.4, PB[4] = 1.0, PB[5] = 0.25, PB[6] = 0.6, flashP(C_PLAYER));
        burstSparks(24, px, 0.6, pz, 3, 8, C_PLAYER, 1.8, 1, 0.6, 0.026, 0.4);
        smoke(px, 0.4, pz, 4, C_SMOKE, 1, 0.55, 0.6, 1.6, 1.4, 1.2);
        trauma = Math.min(1, trauma + 0.5);
        break;
      }
      default: break;
    }
  }

  function hazardLive(type, ev, H, R) {
    const x = ev.x, z = ev.z;
    if (type === 'spark') {
      (PB[0] = x, PB[1] = 0.4, PB[2] = z, PB[3] = 2.4, PB[4] = 1.1, PB[5] = 0.16, PB[6] = 1, flashP(C_SPARKHZ));
      (PB[0] = x, PB[1] = 0.2, PB[2] = z, PB[3] = 1.2, PB[4] = 1.0, PB[5] = 0.08, PB[6] = 1, flashP(WHITE));
      burstSparks(22, x, 0.15, z, 3, 8, C_GOLDW, 1.9, 1.1, 0.5, 0.024, 0.3);
      (PB[0] = x, PB[1] = z, PB[2] = R * 0.85, PB[3] = R * 0.9, PB[4] = 3.2, PB[5] = 1, PB[6] = 0.7, decalP(PDN, 3, C_SCORCH));
      (PB[0] = x, PB[1] = z, PB[2] = R * 1.6, PB[3] = R * 1.2, PB[4] = 0.3, PB[5] = 0.9, PB[6] = 1, decalP(PDA, 0, C_SPARKHZ)).hold = 0;
      (PB[0] = x, PB[1] = 0.03, PB[2] = z, PB[3] = R * 0.4, PB[4] = R * 1.6, PB[5] = 0.25, PB[6] = 0.05, PB[7] = 0.3, PB[8] = 1.4, PB[9] = 1, PB[10] = 0.6, ringP(C_SPARKHZ, 0, 0));
      trauma = Math.min(1, trauma + 0.22);
    } else if (type === 'slam') {
      dust(x, z, 10, R * 1.2, C_DUST, 0.45);
      for (let i = 0; i < Math.round(8 * qMul); i++) (PB[0] = x + rr(-R, R) * 0.4, PB[1] = 0.1, PB[2] = z + rr(-R, R) * 0.4, PB[3] = 0, PB[4] = rr(0.08, 0.16), PB[5] = 4, PB[6] = 5, debrisP(C_CHIP));
      (PB[0] = x, PB[1] = 0.03, PB[2] = z, PB[3] = R * 0.5, PB[4] = R * 1.8, PB[5] = 0.4, PB[6] = 0.06, PB[7] = 0.4, PB[8] = 1.5, PB[9] = 1, PB[10] = 0.6, ringP(C_RING, 0, 0));
      (PB[0] = x, PB[1] = 0.3, PB[2] = z, PB[3] = R * 2.2, PB[4] = 1.0, PB[5] = 0.14, PB[6] = 0.7, flashP(C_RING));
      (PB[0] = x, PB[1] = z, PB[2] = R * 0.75, PB[3] = R * 0.8, PB[4] = 3, PB[5] = 1, PB[6] = 0.65, decalP(PDN, 3, C_SCORCH));
      trauma = Math.min(1, trauma + 0.32);
    } else if (type === 'shock') {
      dust(x, z, 8, R, C_DUST, 0.4);
      (PB[0] = x, PB[1] = 0.3, PB[2] = z, PB[3] = 1.8, PB[4] = 1.0, PB[5] = 0.12, PB[6] = 0.6, flashP(C_WARN));
      trauma = Math.min(1, trauma + 0.28);
    } else if (type === 'beam') {
      (PB[0] = x, PB[1] = 0.8, PB[2] = z, PB[3] = 1.8, PB[4] = 1.2, PB[5] = 0.14, PB[6] = 1, flashP(C_BEAM));
      if (H && H.x2 != null) (PB[0] = H.x2, PB[1] = 0.8, PB[2] = H.z2, PB[3] = 1.4, PB[4] = 1.0, PB[5] = 0.14, PB[6] = 1, flashP(C_BEAM));
      trauma = Math.min(1, trauma + 0.2);
    } else if (type === 'fold') {
      if (H) {
        const hw = H.hw || 1, hd = H.hd || 0.8, a = H.a || 0, c = Math.cos(a), s = Math.sin(a);
        const n = Math.round(14 * qMul);
        for (let i = 0; i < n; i++) {
          const u = rr(-1, 1), side = i % 4;
          const lx = side < 2 ? u * hw : (side === 2 ? -hw : hw), lz = side < 2 ? (side === 0 ? -hd : hd) : u * hd;
          const wx = x + lx * c + lz * s, wz = z - lx * s + lz * c;
          const p = (PB[0] = wx, PB[1] = 0.15, PB[2] = wz, PB[3] = 0.5, PB[4] = 1.2, PB[5] = rr(0.5, 0.8), PB[6] = 1, PB[7] = 0.45, spriteP(PN, F.DUST, C_DUST));
          const ox = wx - x, oz = wz - z, ol = Math.sqrt((ox) * (ox) + (oz) * (oz)) || 1;
          p.vx = ox / ol * rr(2, 3.5); p.vz = oz / ol * rr(2, 3.5); p.vy = rr(0.2, 0.8); p.drag = 4.5; p.rot = rand() * TAU; p.vrot = rr(-2, 2);
        }
        const d = (PB[0] = x, PB[1] = z, PB[2] = 1, PB[3] = 1, PB[4] = 0.3, PB[5] = 1.2, PB[6] = 1, decalP(PDA, 5, C_PINK)); d.sx0 = d.sx1 = hw + 0.2; d.sz0 = d.sz1 = hd + 0.2; d.rot = a; d.p0 = 0.3; d.hold = 0;
      } else dust(x, z, 12, 1.5, C_DUST, 0.45);
      trauma = Math.min(1, trauma + 0.45);
    } else {
      (PB[0] = x, PB[1] = 0.4, PB[2] = z, PB[3] = 1.6, PB[4] = 1.0, PB[5] = 0.12, PB[6] = 0.8, flashP(C_WARN));
    }
  }

  // ================================================================ API
  function reset() {
    PA.clear(); PN.clear(); PS.clear(); PD.clear(); PBD.clear(); PDA.clear(); PDN.clear(); PNUM.clear(); SEQ.clear();
    trauma = 0; shT = 0; shakeVec.set(0, 0, 0); SEED[0] = 1; havePrev = false;
    prevShield = 0; shieldAge = 0; shieldFlash = 0; prevOd = 0; gemLoadAcc = 0;
    gemTrack.forEach((tr) => trackPool.push(tr)); gemTrack.clear();
    for (let i = 0; i < SYS.length; i++) { SYS[i].clear(); SYS[i].gain = SYS[i].gainT = 1; SYS[i].mat.uniforms.uGain.value = 1; }
    nums.clear(); debMesh.count = 0; debMesh.visible = false; gemMesh.visible = false; heartMesh.visible = false; orbMesh.visible = false; shieldMesh.visible = false;
  }
  function setQuality(q) {
    Q = clamp(q | 0, 0, 3);
    qMul = [0.5, 0.75, 1, 1.15][Q];
    walls = Q >= 1;
    mShield.uniforms.uHex.value = Q >= 1 ? 1 : 0;
    sprA.budget = [70, 90, 110, 120][Q];
  }
  // gem twinkle limiter decays in update via this hook
  const _upd = update;
  function updateWrapped(t, dt) { gemLoadAcc = Math.max(0, gemLoadAcc - (dt || 0) * 120); _upd(t, dt); }

  const api = {
    root,
    sync, event, update: updateWrapped, setQuality, reset,
    shake: () => shakeVec,
    dmgScale: opts.dmgScale != null ? opts.dmgScale : 10,
    stats: () => ({
      sprA: sprA.n, sprN: sprN.n, streaks: strk.n, decA: decA.n, decN: decN.n, bands: band.n, debris: PD.n, numbers: PNUM.n,
      gems: gemMesh.count, orbs: orbGeo.instanceCount, gain: [sprA.gain, decA.gain, band.gain].map((v) => +v.toFixed(2)).join('/'),
    }),
    get trauma() { return trauma; },
  };
  setQuality(opts.quality != null ? opts.quality : 2);
  return api;
}
