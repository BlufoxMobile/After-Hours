// =====================================================================================
// AFTER HOURS 3D — MODEMS (owner: MODEMS agent)
// Crowd renderer for the modem family (XB6 / XB3 / XB7 / XB8 / XB10 / xFi Pod) + the
// GIGA GATEWAY boss. Everything is keyed off the sim's enemy records (CONTRACT §2).
//
//   const modems = createModems(scene, { capacity: 80 });
//   modems.sync(enemies, t, dt)   // FULL sim.state.enemies; renders only modem kinds
//   modems.setQuality(q)          // 0..3
//   modems.kinds                  // ['xb3','xb6','xb7','xb8','xb10','pod','boss_gateway']
//   modems.preview(kind) -> Object3D ; modems.previewUpdate(obj, t)
//
// Tech: one InstancedMesh per kind for the rigid body (merged geometry with per-vertex
// colour / roughness / metalness / LED-index), shared instanced meshes for the face
// screens (canvas-free procedural expression atlas + per-instance frame/dart/boot),
// the telescoping leg pistons and boots, XB8 halo rings and XB10 hatches, plus one
// additive glow-sprite pool and one ground-decal pool (contact shadows + elite rings).
// All robot parts share ONE MeshStandardMaterial program (onBeforeCompile).
// =====================================================================================
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { KIND_DIMS, KIND_COLORS, FIXTURES } from './layout.js';

const MY_KINDS = ['xb3', 'xb6', 'xb7', 'xb8', 'xb10', 'pod', 'boss_gateway'];
const CROWD_KINDS = ['xb6', 'xb3', 'xb7', 'xb8', 'xb10', 'pod'];
const BASE_CAP = { xb6: 60, xb3: 20, xb7: 20, xb8: 20, xb10: 20, pod: 40 };

// ------------------------------------------------------------------ small math helpers
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };
const range = (p, a, b) => clamp01((p - a) / (b - a));
const bump = (p, a, b) => { const u = range(p, a, b); return Math.sin(u * Math.PI); };
const easeOut = (t) => { t = clamp01(t); return 1 - (1 - t) * (1 - t) * (1 - t); };
const easeIn = (t) => { t = clamp01(t); return t * t * t; };
const easeOutBack = (t, k = 1.9) => { t = clamp01(t) - 1; return 1 + (k + 1) * t * t * t + k * t * t; };
const fract = (x) => x - Math.floor(x);
const hash = (n) => fract(Math.sin(n * 127.1 + 311.7) * 43758.5453);
const TAU = Math.PI * 2;
const wrapA = (a) => { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; };
function lin(hex) { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; }

// Floor height under a point (tables / counter), for contact shadows + airborne detection.
const SOLIDS = FIXTURES.filter((f) => f.type === 'box');
function groundY(x, z) {
  for (let i = 0; i < SOLIDS.length; i++) {
    const f = SOLIDS[i];
    if (Math.abs(x - f.x) <= f.hw && Math.abs(z - f.z) <= f.hd) return f.h;
  }
  return 0;
}

// =====================================================================================
// FACE ATLAS — 4 x 8 cells of 256 x 128. R = hot eye core, G = blurred halo.
// =====================================================================================
const F = {
  ANGRY: 0, SQUINT: 1, FURY: 2, DIZZY: 3, DEAD: 4, BOOT: 5, POWER: 6, GLITCH: 7,
  CYC: 8, CYC_SQUINT: 9, CYC_FURY: 10, CYC_DIZZY: 11, BOSS: 12, BOSS_SQUINT: 13, BOSS_ROAR: 14, BOSS_CRACK: 15,
  GRUMPY: 16, SHARP: 17, COOL: 18, STERN: 19, GRUMPY_SQUINT: 20, COOL_SQUINT: 21, CYC_DEAD: 22, SHARP_SQUINT: 23,
};
let _atlas = null;
function getAtlas() {
  if (_atlas) return _atlas;
  const W = 1024, H = 1024, CW = 256, CH = 128;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  const fill = '#fff';
  // angry eye: ellipse clipped below a slanted brow line. dir = +1 left eye (inner side +x), -1 right eye
  const eye = (cx, cy, w, h, slope, cut, dir, round = 1) => {
    ctx.save(); ctx.beginPath();
    const yAt = (x) => cy - h * cut + slope * (x - cx) * dir;
    const x0 = cx - w, x1 = cx + w;
    ctx.moveTo(x0, yAt(x0)); ctx.lineTo(x1, yAt(x1)); ctx.lineTo(x1, cy + h * 2); ctx.lineTo(x0, cy + h * 2);
    ctx.closePath(); ctx.clip();
    ctx.beginPath();
    if (round >= 1) ctx.ellipse(cx, cy, w / 2, h / 2, 0, 0, TAU);
    else rrect(cx - w / 2, cy - h / 2, w, h, Math.min(w, h) * 0.5 * round);
    ctx.fill(); ctx.restore();
  };
  const rrect = (x, y, w, h, r) => {
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  };
  const slit = (cx, cy, len, tilt, width) => {
    ctx.save(); ctx.lineCap = 'round'; ctx.lineWidth = width; ctx.beginPath();
    ctx.moveTo(cx - len / 2, cy - tilt / 2); ctx.lineTo(cx + len / 2, cy + tilt / 2); ctx.stroke(); ctx.restore();
  };
  const spiral = (cx, cy, R, lw) => {
    ctx.save(); ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.beginPath();
    for (let i = 0; i <= 60; i++) { const a = i / 60 * TAU * 2.3; const r = 3 + (R - 3) * i / 60; const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.stroke(); ctx.restore();
  };
  const cross = (cx, cy, r, lw) => {
    ctx.save(); ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.beginPath();
    ctx.moveTo(cx - r, cy - r); ctx.lineTo(cx + r, cy + r); ctx.moveTo(cx + r, cy - r); ctx.lineTo(cx - r, cy + r); ctx.stroke(); ctx.restore();
  };
  const zig = (x0, x1, y, amp, n, lw) => {
    ctx.save(); ctx.lineWidth = lw; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.beginPath();
    for (let i = 0; i <= n; i++) { const x = lerp(x0, x1, i / n), yy = y + (i % 2 ? amp : -amp); i ? ctx.lineTo(x, yy) : ctx.moveTo(x, yy); }
    ctx.stroke(); ctx.restore();
  };
  const teeth = (x0, x1, yTop, yBot, n) => { // filled grin: jagged teeth band
    ctx.save(); ctx.beginPath(); ctx.moveTo(x0, yTop);
    for (let i = 0; i <= n; i++) { const x = lerp(x0, x1, i / n); ctx.lineTo(x, i % 2 ? yBot : yTop); }
    ctx.lineTo(x1, yTop); ctx.lineTo(x1 - 6, yTop - 6); ctx.lineTo(x0 + 6, yTop - 6); ctx.closePath(); ctx.fill(); ctx.restore();
  };
  const cyc = (cx, cy, w, h, s, cut) => { // single eye, V brow
    ctx.save(); ctx.beginPath();
    const yAt = (x) => cy - h * cut - s * Math.abs(x - cx);
    ctx.moveTo(cx - w, yAt(cx - w)); ctx.lineTo(cx, yAt(cx)); ctx.lineTo(cx + w, yAt(cx + w));
    ctx.lineTo(cx + w, cy + h); ctx.lineTo(cx - w, cy + h); ctx.closePath(); ctx.clip();
    ctx.beginPath(); ctx.ellipse(cx, cy, w / 2, h / 2, 0, 0, TAU); ctx.fill(); ctx.restore();
  };
  const vbrow = (cx, y, hw, dip, lw) => { ctx.save(); ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath(); ctx.moveTo(cx - hw, y); ctx.lineTo(cx, y + dip); ctx.lineTo(cx + hw, y); ctx.stroke(); ctx.restore(); };
  // lens eye: ring iris + hot pupil, top clipped by an angry brow cut
  const lens = (cx, cy, rx, ry, lw, pr, cut) => {
    ctx.save(); ctx.beginPath();
    ctx.moveTo(cx - 80, cy - ry * (1 - cut) - 40); ctx.lineTo(cx, cy - ry * (1 - cut) + 6); ctx.lineTo(cx + 80, cy - ry * (1 - cut) - 40);
    ctx.lineTo(cx + 80, cy + 80); ctx.lineTo(cx - 80, cy + 80); ctx.closePath(); ctx.clip();
    ctx.lineWidth = lw; ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, TAU); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy + 2, pr, 0, TAU); ctx.fill(); ctx.restore();
  };
  const L = 72, R = 184;
  const frames = {
    [F.ANGRY]: () => { eye(L, 66, 78, 70, 0.42, 0.10, 1); eye(R, 66, 78, 70, 0.42, 0.10, -1); },
    [F.SQUINT]: () => { slit(L, 66, 50, 20, 17); slit(R, 66, 50, -20, 17); },
    [F.FURY]: () => { eye(L, 58, 74, 70, 0.62, 0.02, 1); eye(R, 58, 74, 70, 0.62, 0.02, -1); zig(84, 172, 108, 6, 8, 6); },
    [F.DIZZY]: () => { spiral(L, 64, 30, 8); spiral(R, 64, 30, 8); },
    [F.DEAD]: () => { cross(L, 64, 22, 13); cross(R, 64, 22, 13); },
    [F.BOOT]: () => {
      ctx.fillRect(36, 44, 184, 7);
      ctx.save(); ctx.lineWidth = 5; ctx.strokeStyle = fill; ctx.beginPath(); rrect(66, 70, 124, 20, 8); ctx.stroke(); ctx.restore();
      ctx.beginPath(); rrect(72, 76, 74, 8, 4); ctx.fill();
    },
    [F.POWER]: () => {
      ctx.save(); ctx.lineWidth = 10; ctx.lineCap = 'round'; ctx.beginPath(); ctx.arc(128, 68, 28, -Math.PI / 2 + 0.75, -Math.PI / 2 - 0.75 + TAU); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(128, 30); ctx.lineTo(128, 62); ctx.stroke(); ctx.restore();
    },
    [F.GLITCH]: () => {
      eye(L + 10, 62, 60, 52, 0.42, 0.1, 1); eye(R - 6, 70, 60, 52, 0.42, 0.1, -1);
      ctx.save(); ctx.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < 7; i++) ctx.fillRect(0, 20 + i * 14 + (i % 3) * 3, 256, 4 + (i % 2) * 3);
      ctx.restore();
      for (let i = 0; i < 9; i++) ctx.fillRect(20 + hash(i * 3.1) * 200, 16 + hash(i * 7.7) * 96, 10 + hash(i) * 40, 4 + hash(i * 1.3) * 6);
    },
    [F.CYC]: () => { lens(128, 72, 34, 30, 11, 12, 0.34); vbrow(128, 24, 62, 16, 12); },
    [F.CYC_SQUINT]: () => { slit(128, 76, 70, 0, 16); vbrow(128, 36, 62, 20, 12); },
    [F.CYC_FURY]: () => { lens(128, 72, 40, 36, 12, 8, 0.55); vbrow(128, 18, 66, 24, 14); },
    [F.CYC_DIZZY]: () => { spiral(128, 64, 38, 9); },
    [F.BOSS]: () => { eye(70, 52, 78, 62, 0.5, 0.08, 1); eye(186, 52, 78, 62, 0.5, 0.08, -1); teeth(64, 192, 94, 114, 12); },
    [F.BOSS_SQUINT]: () => { slit(70, 54, 60, 24, 18); slit(186, 54, 60, -24, 18); teeth(64, 192, 94, 114, 12); },
    [F.BOSS_ROAR]: () => {
      eye(70, 44, 72, 52, 0.66, 0.02, 1); eye(186, 44, 72, 52, 0.66, 0.02, -1);
      ctx.save(); ctx.lineWidth = 6; ctx.beginPath(); rrect(70, 80, 116, 40, 12); ctx.stroke(); ctx.restore();
      zig(78, 178, 90, 7, 10, 5); zig(78, 178, 110, 7, 10, 5);
    },
    [F.BOSS_CRACK]: () => {
      eye(70, 52, 78, 62, 0.5, 0.08, 1); eye(186, 52, 78, 62, 0.5, 0.08, -1); teeth(64, 192, 94, 114, 12);
      ctx.save(); ctx.globalCompositeOperation = 'destination-out'; ctx.lineWidth = 4; ctx.beginPath();
      ctx.moveTo(40, 10); ctx.lineTo(62, 40); ctx.lineTo(56, 58); ctx.lineTo(84, 84); ctx.lineTo(80, 118);
      ctx.moveTo(62, 40); ctx.lineTo(92, 36);
      ctx.moveTo(214, 8); ctx.lineTo(196, 44); ctx.lineTo(206, 70); ctx.lineTo(186, 96);
      ctx.stroke(); ctx.restore();
      ctx.save(); ctx.lineWidth = 2; ctx.globalAlpha = 0.6; ctx.strokeStyle = fill; ctx.beginPath();
      ctx.moveTo(40, 10); ctx.lineTo(62, 40); ctx.lineTo(56, 58); ctx.moveTo(214, 8); ctx.lineTo(196, 44); ctx.stroke(); ctx.restore();
    },
    [F.GRUMPY]: () => {
      eye(L, 74, 70, 44, 0.16, 0.30, 1, 0.9); eye(R, 74, 70, 44, 0.16, 0.30, -1, 0.9);
      ctx.save(); ctx.lineWidth = 13; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath();
      ctx.moveTo(34, 38); ctx.lineTo(118, 56); ctx.lineTo(138, 56); ctx.lineTo(222, 38); ctx.stroke(); ctx.restore();
    },
    [F.SHARP]: () => {
      const wedge = (cx, d) => { ctx.beginPath(); ctx.moveTo(cx - 36 * d, 42); ctx.lineTo(cx + 34 * d, 66); ctx.lineTo(cx + 26 * d, 90); ctx.lineTo(cx - 26 * d, 88); ctx.lineTo(cx - 38 * d, 70); ctx.closePath(); ctx.fill(); };
      ctx.save(); ctx.lineJoin = 'round'; ctx.lineWidth = 10; ctx.strokeStyle = fill; wedge(L, 1); ctx.stroke(); wedge(R, -1); ctx.stroke(); ctx.restore();
    },
    [F.COOL]: () => {
      const bar = (cx, a) => { ctx.save(); ctx.translate(cx, 66); ctx.rotate(a); ctx.beginPath(); rrect(-44, -15, 88, 30, 15); ctx.fill(); ctx.restore(); };
      bar(L + 4, 0.22); bar(R - 4, -0.22);
      ctx.save(); ctx.globalCompositeOperation = 'destination-out'; ctx.fillRect(0, 40, 256, 8); ctx.restore();
    },
    [F.STERN]: () => {
      eye(L, 72, 64, 52, 0.36, 0.06, 1); eye(R, 72, 64, 52, 0.36, 0.06, -1);
      slit(L - 4, 34, 58, 18, 10); slit(R + 4, 34, 58, -18, 10);
    },
    [F.GRUMPY_SQUINT]: () => {
      slit(L, 76, 52, 8, 16); slit(R, 76, 52, -8, 16);
      ctx.save(); ctx.lineWidth = 13; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath();
      ctx.moveTo(34, 44); ctx.lineTo(118, 62); ctx.lineTo(138, 62); ctx.lineTo(222, 44); ctx.stroke(); ctx.restore();
    },
    [F.COOL_SQUINT]: () => { slit(L + 4, 66, 70, 22, 12); slit(R - 4, 66, 70, -22, 12); },
    [F.CYC_DEAD]: () => { cross(128, 64, 30, 16); },
    [F.SHARP_SQUINT]: () => { slit(L, 68, 60, 26, 14); slit(R, 68, 60, -26, 14); },
  };
  ctx.fillStyle = fill; ctx.strokeStyle = fill;
  for (const k in frames) {
    const f = +k; const ox = (f % 4) * CW, oy = Math.floor(f / 4) * CH;
    ctx.save(); ctx.translate(ox, oy); ctx.beginPath(); ctx.rect(0, 0, CW, CH); ctx.clip();
    ctx.fillStyle = fill; ctx.strokeStyle = fill; frames[k](); ctx.restore();
  }
  // halo: separable box blur of the core (x3 ~ gaussian)
  const src = ctx.getImageData(0, 0, W, H).data;
  const core = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) core[i] = src[i * 4] / 255;
  let a = core.slice(), b = new Float32Array(W * H);
  const blur = (inp, out, rad, horiz) => {
    const n = horiz ? W : H, m = horiz ? H : W, inv = 1 / (rad * 2 + 1);
    for (let j = 0; j < m; j++) {
      let acc = 0;
      const idx = (i) => (horiz ? j * W + clamp(i, 0, n - 1) : clamp(i, 0, n - 1) * W + j);
      for (let i = -rad; i <= rad; i++) acc += inp[idx(i)];
      for (let i = 0; i < n; i++) {
        out[horiz ? j * W + i : i * W + j] = acc * inv;
        acc += inp[idx(i + rad + 1)] - inp[idx(i - rad)];
      }
    }
  };
  for (let it = 0; it < 3; it++) { blur(a, b, 6, true); blur(b, a, 6, false); }
  const data = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = src[i * 4];
    data[i * 4 + 1] = Math.min(255, Math.max(core[i] * 200, a[i] * 380));
    data[i * 4 + 2] = 0; data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4; tex.colorSpace = THREE.NoColorSpace; tex.needsUpdate = true;
  _atlas = tex;
  return tex;
}

// =====================================================================================
// MATERIALS (module-level singletons: one program each)
// =====================================================================================
let _robotMat = null, _faceMat = null, _spriteMat = null, _groundMat = null;
function robotMat() {
  if (_robotMat) return _robotMat;
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.0 });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 aMask; attribute vec4 iFx; attribute vec4 iGlow;
varying vec4 vMask; varying vec4 vFx; varying vec4 vGlow;`)
      .replace('#include <color_vertex>', `vColor = vec4(1.0); vColor.rgb *= color;
#ifdef USE_INSTANCING_COLOR
vColor.rgb *= mix(vec3(1.0), instanceColor.rgb, aMask.y);
#endif
vMask = aMask; vFx = iFx; vGlow = iGlow;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
#define SOFTBOX 1.0
varying vec4 vMask; varying vec4 vFx; varying vec4 vGlow;`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
roughnessFactor = vMask.z; metalnessFactor = vMask.w;
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0, 0.22, 0.16), vFx.w * 0.6);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), vFx.x * 0.55);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  float led = floor(vMask.x + 0.01);          // LED index (1..6 sequential power-on, 8 = crack)
  float lfr = vMask.x - led;                   // fractional part = per-part strength (0 => 1)
  float ls = lfr > 0.02 ? lfr : 1.0;
  float on = 0.0;
  vec3 lc = vGlow.rgb;
  if (led > 0.5 && led < 7.5) { on = clamp(vFx.y * 6.0 - (led - 1.0), 0.0, 1.0) * max(vFx.y, 1.0) * ls; }
  else if (led > 7.5) { on = vGlow.w; lc = mix(vec3(1.0, 0.55, 0.12), vec3(1.0, 0.12, 0.05), clamp(vGlow.w - 0.8, 0.0, 1.0)); }
  if (led > 0.5) { diffuseColor.rgb = diffuseColor.rgb * 0.05 + 0.025; roughnessFactor = 0.2; }
  totalEmissiveRadiance += lc * on * 1.55;
  vec3 vdir = normalize(vViewPosition);
  float fr = pow(1.0 - clamp(dot(normal, vdir), 0.0, 1.0), 2.6);
  totalEmissiveRadiance += vec3(1.0, 0.70, 0.18) * fr * vFx.z * 1.2;
  totalEmissiveRadiance += vGlow.rgb * fr * 0.14 * min(vFx.y, 1.0);
  totalEmissiveRadiance += vec3(1.0, 0.1, 0.03) * vFx.w * (0.4 + 1.7 * fr);
  totalEmissiveRadiance += vec3(1.0) * vFx.x * 0.45;
  // stylised 'softbox' reflections (ceiling light up/back + a cool kicker) -> glossy toy plastic
  vec3 rv = reflect(-vdir, normal);
  vec3 rw = normalize((vec4(rv, 0.0) * viewMatrix).xyz);
  float gl = (1.0 - roughnessFactor); gl *= gl;
  float fres = mix(0.10, 1.0, pow(1.0 - clamp(dot(normal, vdir), 0.0, 1.0), 4.0));
  float box = smoothstep(0.80, 0.93, dot(rw, normalize(vec3(0.25, 0.8, -0.55))));
  float kick = smoothstep(0.86, 0.97, dot(rw, normalize(vec3(-0.8, 0.35, -0.3))));
  if (led < 0.5) totalEmissiveRadiance += (vec3(1.0, 0.98, 0.95) * box * 1.6 + vec3(0.55, 0.75, 1.0) * kick * 0.9) * gl * fres * SOFTBOX;
}`);
  };
  m.customProgramCacheKey = () => 'modemRobot1';
  _robotMat = m;
  return m;
}

function faceMat() {
  if (_faceMat) return _faceMat;
  _faceMat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uAtlas: { value: null } }]),
    fog: true,
    vertexShader: /* glsl */`
attribute vec4 iFace; attribute vec4 iFace2;
varying vec2 vUv; varying vec4 vF; varying vec4 vF2; varying vec3 vCol;
#include <common>
#include <fog_pars_vertex>
void main() {
  vUv = uv; vF = iFace; vF2 = iFace2; vCol = vec3(1.0);
#ifdef USE_INSTANCING_COLOR
  vCol = instanceColor;
#endif
#ifdef USE_INSTANCING
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
#else
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
#endif
  gl_Position = projectionMatrix * mvPosition;
#include <fog_vertex>
}`,
    fragmentShader: /* glsl */`
uniform sampler2D uAtlas;
varying vec2 vUv; varying vec4 vF; varying vec4 vF2; varying vec3 vCol;
#include <common>
#include <fog_pars_fragment>
float rrect(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
void main() {
  vec2 p = (vUv - 0.5) * vec2(2.0, 1.0);
  float d = rrect(p, vec2(1.0, 0.5), 0.16);
  if (d > 0.0) discard;
  float open = max(vF2.w, 0.03);
  vec2 uv = vUv;
  uv.y = 0.5 + (uv.y - 0.5) / open;
  uv -= vF.yz;
  float gl = vF2.y;
  if (gl > 0.001) {
    float row = floor(vUv.y * 10.0 + vF2.z * 5.0);
    uv.x += gl * (fract(sin(row * 91.7 + floor(vF2.z * 9.0) * 13.1) * 437.58) - 0.5) * 0.35;
  }
  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  vec2 c = clamp(uv, 0.004, 0.996);
  float fr = floor(vF.x + 0.5);
  float col = mod(fr, 4.0), row = floor(fr / 4.0);
  vec2 auv = vec2((col + c.x) / 4.0, (row + 1.0 - c.y) / 8.0);
  vec4 tx = texture2D(uAtlas, auv) * inside;
  float br = vF.w;
  vec3 g = vCol;
  vec3 hot = mix(g, vec3(1.0), 0.32);
  float scan = 0.82 + 0.18 * sin(vUv.y * 140.0);
  vec3 c3 = (g * tx.g * 1.5 + hot * tx.r * 2.3) * br * scan;
  float on = min(br, 1.0);
  vec3 base = vec3(0.008, 0.009, 0.016) + g * (0.022 * on) * (1.0 - 0.6 * length(p));
  float sheen = smoothstep(0.62, 0.98, vUv.y) * smoothstep(0.35, 0.0, abs(p.x * 0.5 + 0.25 - (vUv.y - 0.8)));
  base += vec3(0.06, 0.065, 0.08) * sheen;
  base += g * smoothstep(-0.05, 0.0, d) * 0.16 * on;
  c3 += base;
  c3 = mix(c3, vec3(2.4), clamp(vF2.x, 0.0, 1.0) * 0.65);
  gl_FragColor = vec4(c3, 1.0);
#include <tonemapping_fragment>
#include <colorspace_fragment>
#include <fog_fragment>
}`,
  });
  _faceMat.uniforms.uAtlas.value = getAtlas();
  return _faceMat;
}

function spriteMat() {
  if (_spriteMat) return _spriteMat;
  _spriteMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
attribute vec3 iPos; attribute vec4 iCol; attribute vec2 iSize;
varying vec2 vUv; varying vec4 vCol; varying float vShape;
void main() {
  vUv = position.xy * 2.0; vCol = iCol; vShape = iSize.y;
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  float sc = length(modelMatrix[0].xyz);
  mv.xy += position.xy * iSize.x * sc;
  gl_Position = projectionMatrix * mv;
}`,
    fragmentShader: /* glsl */`
varying vec2 vUv; varying vec4 vCol; varying float vShape;
void main() {
  float r2 = dot(vUv, vUv);
  float a;
  if (vShape < 0.5) a = exp(-r2 * 5.0) * (1.0 - smoothstep(0.7, 1.0, r2));
  else if (vShape < 1.5) {
    vec2 q = abs(vUv);
    a = (exp(-q.x * 18.0) * exp(-q.y * 2.6) + exp(-q.y * 18.0) * exp(-q.x * 2.6)) * 0.9 + exp(-r2 * 30.0);
    a *= 1.0 - smoothstep(0.8, 1.0, r2);
  } else {
    float r = sqrt(r2);
    a = exp(-pow((r - 0.72) * 9.0, 2.0)) * (1.0 - smoothstep(0.9, 1.0, r));
  }
  if (a < 0.004) discard;
  gl_FragColor = vec4(vCol.rgb * vCol.a * a, 1.0);
#include <tonemapping_fragment>
#include <colorspace_fragment>
}`,
  });
  return _spriteMat;
}

function groundMat() {
  if (_groundMat) return _groundMat;
  _groundMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */`
attribute vec3 iPos; attribute vec4 iCol; attribute vec2 iSize;
varying vec2 vUv; varying vec4 vCol; varying float vShape;
void main() {
  vUv = position.xz * 2.0; vCol = iCol; vShape = iSize.y;
  vec3 p = iPos + vec3(position.x, 0.0, position.z) * iSize.x;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`,
    fragmentShader: /* glsl */`
uniform float uTime;
varying vec2 vUv; varying vec4 vCol; varying float vShape;
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  vec3 add = vec3(0.0); float dark = 0.0;
  if (vShape < 0.5) {
    dark = vCol.a * pow(1.0 - smoothstep(0.0, 1.0, r), 1.6);
  } else {
    float ang = atan(vUv.y, vUv.x);
    float ring = exp(-pow((r - 0.82) * 16.0, 2.0));
    float ticks = step(0.5, fract(ang * 1.909859 + uTime * 0.35)) * exp(-pow((r - 0.95) * 30.0, 2.0));
    float inner = (1.0 - smoothstep(0.0, 0.85, r)) * 0.18;
    add = vCol.rgb * (ring + ticks * 0.8 + inner) * vCol.a;
  }
  gl_FragColor = vec4(add, dark);
#include <tonemapping_fragment>
#include <colorspace_fragment>
}`,
  });
  return _groundMat;
}

// =====================================================================================
// GEOMETRY KIT
// =====================================================================================
const _gm = new THREE.Matrix4(), _gq = new THREE.Quaternion(), _ge = new THREE.Euler(), _gv = new THREE.Vector3(), _gs = new THREE.Vector3();
// A coloured, flagged part. o: { p:[x,y,z], r:[x,y,z], s:[x,y,z], led, tint, rough, metal }
function P(geo, col, o = {}) {
  let g = geo;
  if (!g.index) {
    const n = g.attributes.position.count, idx = new Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(idx);
  }
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  g.morphAttributes = {};
  g.clearGroups();
  const r = o.r || [0, 0, 0], p = o.p || [0, 0, 0], s = o.s || [1, 1, 1];
  _ge.set(r[0], r[1], r[2], o.ro || 'XYZ'); _gq.setFromEuler(_ge);
  _gm.compose(_gv.set(p[0], p[1], p[2]), _gq, _gs.set(s[0], s[1], s[2]));
  g.applyMatrix4(_gm);
  if (o.m) g.applyMatrix4(o.m);
  const n = g.attributes.position.count;
  const c = Array.isArray(col) ? col : lin(col);
  const ca = new Float32Array(n * 3), ma = new Float32Array(n * 4);
  const pa = g.attributes.position;
  for (let i = 0; i < n; i++) {
    let k = 1;
    if (o.ao) k = lerp(o.ao[2], 1, smooth((pa.getY(i) - o.ao[0]) / (o.ao[1] - o.ao[0])));
    ca[i * 3] = c[0] * k; ca[i * 3 + 1] = c[1] * k; ca[i * 3 + 2] = c[2] * k;
    ma[i * 4] = o.led || 0; ma[i * 4 + 1] = o.tint || 0; ma[i * 4 + 2] = o.rough ?? 0.3; ma[i * 4 + 3] = o.metal ?? 0.0;
  }
  g.setAttribute('color', new THREE.BufferAttribute(ca, 3));
  g.setAttribute('aMask', new THREE.BufferAttribute(ma, 4));
  return g;
}
function merge(parts) {
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  g.computeBoundingSphere(); g.computeBoundingBox();
  return g;
}
const RB = (w, h, d, r, seg) => new RoundedBoxGeometry(w, h, d, Math.max(1, seg), r);
const BX = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const CY = (rt, rb, h, n) => new THREE.CylinderGeometry(rt, rb, h, n, 1);
const SP = (r, w, h) => new THREE.SphereGeometry(r, w, h);
const TO = (R, t, rs, ts) => new THREE.TorusGeometry(R, t, rs, ts);
// taper x/z linearly with height (for squat, planted silhouettes)
function taper(g, y0, y1, s0, s1) {
  const a = g.attributes.position;
  for (let i = 0; i < a.count; i++) { const k = lerp(s0, s1, clamp01((a.getY(i) - y0) / (y1 - y0))); a.setX(i, a.getX(i) * k); a.setZ(i, a.getZ(i) * k); }
  a.needsUpdate = true; return g;
}
// a rounded-profile lathe (XB8 tower)
function roundLathe(rBot, rTop, h, cb, ct, seg, rad) {
  const pts = [];
  pts.push(new THREE.Vector2(0.0001, 0));
  for (let i = 0; i <= seg; i++) { const a = -Math.PI / 2 + i / seg * Math.PI / 2; pts.push(new THREE.Vector2(rBot - cb + Math.cos(a) * cb, cb + Math.sin(a) * cb)); }
  for (let i = 0; i <= seg; i++) { const a = i / seg * Math.PI / 2; pts.push(new THREE.Vector2(rTop - ct + Math.cos(a) * ct, h - ct + Math.sin(a) * ct)); }
  pts.push(new THREE.Vector2(0.0001, h));
  return new THREE.LatheGeometry(pts, rad);
}

// Face placement helper: bezel + face plane share centre/tilt.
function faceMatrix(f) {
  const m = new THREE.Matrix4();
  _ge.set(-f.tilt, 0, 0); _gq.setFromEuler(_ge);
  const off = new THREE.Vector3(0, 0, f.bd / 2 + 0.004).applyQuaternion(_gq);
  m.compose(new THREE.Vector3(0, f.y + off.y, f.z + off.z), _gq, new THREE.Vector3(f.w, f.h, 1));
  return m;
}

// =====================================================================================
// KIND SPECS (body-local: origin = body bottom centre, +Z forward). Heights match KIND_DIMS.
// =====================================================================================
const SPEC = {
  xb6: {
    W: 0.68, H: 0.68, D: 0.56, legH: 0.21, legs: 2,
    hips: [[-0.18, 0.02, 0.0], [0.18, 0.02, 0.0]], feet: [[-0.21, 0, 0.03], [0.21, 0, 0.03]],
    foot: [0.17, 0.09, 0.25], pistonR: 0.034,
    face: { y: 0.41, z: 0.27, w: 0.50, h: 0.25, bw: 0.58, bh: 0.33, bd: 0.08, tilt: 0.3 },
    frames: { base: F.ANGRY, squint: F.SQUINT, fury: F.FURY, dizzy: F.DIZZY, dead: F.DEAD },
    gait: 'hop', idleK: 'bouncy', stride: 0.85, refSpd: 1.6, hopH: 0.17, lean: 0.12,
    ledPos: [0, 0.12, 0.27], topY: 0.8,
  },
  xb3: {
    W: 0.46, H: 0.86, D: 0.42, legH: 0.24, legs: 2,
    hips: [[-0.13, 0.02, 0.0], [0.13, 0.02, 0.0]], feet: [[-0.17, 0, 0.04], [0.17, 0, 0.04]],
    foot: [0.22, 0.10, 0.30], pistonR: 0.048,
    face: { y: 0.67, z: 0.205, w: 0.40, h: 0.20, bw: 0.45, bh: 0.26, bd: 0.07, tilt: 0.3 },
    frames: { base: F.GRUMPY, squint: F.GRUMPY_SQUINT, fury: F.FURY, dizzy: F.DIZZY, dead: F.DEAD },
    gait: 'stomp', idleK: 'grumpy', stride: 1.0, refSpd: 1.1, lean: 0.06,
    ledPos: [0, 0.48, 0.22], topY: 0.92,
  },
  xb7: {
    W: 0.50, H: 0.72, D: 0.48, legH: 0.23, legs: 2,
    hips: [[-0.14, 0.02, -0.02], [0.14, 0.02, -0.02]], feet: [[-0.16, 0, 0.0], [0.16, 0, 0.0]],
    foot: [0.15, 0.08, 0.27], pistonR: 0.030,
    face: { y: 0.46, z: 0.235, w: 0.40, h: 0.20, bw: 0.45, bh: 0.27, bd: 0.07, tilt: 0.3 },
    frames: { base: F.SHARP, squint: F.SHARP_SQUINT, fury: F.FURY, dizzy: F.DIZZY, dead: F.DEAD },
    gait: 'run', idleK: 'tap', stride: 1.1, refSpd: 2.0, lean: 0.16,
    ledPos: [0, 0.11, 0.25], topY: 0.78,
  },
  xb8: {
    W: 0.50, H: 0.88, D: 0.50, legH: 0.17, legs: 3,
    hips: [[0.105, 0.03, 0.06], [-0.105, 0.03, 0.06], [0, 0.03, -0.12]],
    feet: [[0.21, 0, 0.13], [-0.21, 0, 0.13], [0, 0, -0.24]],
    foot: [0.10, 0.06, 0.15], pistonR: 0.022,
    face: { y: 0.63, z: 0.205, w: 0.36, h: 0.18, bw: 0.41, bh: 0.23, bd: 0.10, tilt: 0.3 },
    frames: { base: F.COOL, squint: F.COOL_SQUINT, fury: F.FURY, dizzy: F.DIZZY, dead: F.DEAD },
    gait: 'skitter', idleK: 'hover', stride: 0.45, refSpd: 1.3, lean: 0.08,
    ledPos: [0, 0.2, 0.25], topY: 1.1, ringY: 0.95,
  },
  xb10: {
    W: 0.62, H: 0.72, D: 0.54, legH: 0.22, legs: 2,
    hips: [[-0.18, 0.02, 0.0], [0.18, 0.02, 0.0]], feet: [[-0.21, 0, 0.03], [0.21, 0, 0.03]],
    foot: [0.18, 0.09, 0.27], pistonR: 0.038,
    face: { y: 0.47, z: 0.265, w: 0.46, h: 0.23, bw: 0.53, bh: 0.30, bd: 0.07, tilt: 0.28 },
    frames: { base: F.STERN, squint: F.SQUINT, fury: F.FURY, dizzy: F.DIZZY, dead: F.DEAD },
    gait: 'march', idleK: 'stern', stride: 0.95, refSpd: 1.2, lean: 0.07,
    ledPos: [0, 0.13, 0.28], topY: 0.95,
    hatch: { x: 0.322, y: 0.60, h: 0.30, d: 0.34 },
  },
  pod: {
    W: 0.31, H: 0.32, D: 0.23, legH: 0.1, legs: 4,
    hips: [[-0.085, 0.02, 0.05], [0.085, 0.02, 0.05], [-0.085, 0.02, -0.05], [0.085, 0.02, -0.05]],
    feet: [[-0.13, 0, 0.08], [0.13, 0, 0.08], [-0.13, 0, -0.07], [0.13, 0, -0.07]],
    foot: [0.065, 0.04, 0.085], pistonR: 0.014,
    face: { y: 0.19, z: 0.11, w: 0.23, h: 0.115, bw: 0.265, bh: 0.15, bd: 0.05, tilt: 0.3 },
    frames: { base: F.CYC, squint: F.CYC_SQUINT, fury: F.CYC_FURY, dizzy: F.CYC_DIZZY, dead: F.CYC_DEAD },
    gait: 'scurry', idleK: 'jitter', stride: 0.36, refSpd: 2.4, lean: 0.14, lowLegs: true,
    ledPos: [0.08, 0.34, 0.05], topY: 0.38,
  },
};
for (const k of CROWD_KINDS) {
  const s = SPEC[k];
  s.glow = lin(KIND_COLORS[k].glow);
  s.bodyCol = lin(KIND_COLORS[k].body);
  s.pistonR *= 1.4; s.foot = s.foot.map((v) => v * 1.15);
  s.ankleH = s.foot[1] * 0.85;
  s.faceM = faceMatrix(s.face);
  s.h = KIND_DIMS[k].h;
}
// foot boot tint per kind (multiplies the white boot shell)
SPEC.xb6.bootTint = lin('#e9edf5'); SPEC.xb3.bootTint = lin('#2a2d36'); SPEC.xb7.bootTint = lin('#f2f4f8');
SPEC.xb8.bootTint = lin('#e4e8ef'); SPEC.xb10.bootTint = lin('#3a3e49'); SPEC.pod.bootTint = lin('#eceef4');
// body LED gain (bright yellows/cyans bloom harder than purples/reds)
for (const k of CROWD_KINDS) SPEC[k].ledGain = 1;
SPEC.xb10.ledGain = 0.55; SPEC.xb8.ledGain = 0.75; SPEC.xb3.ledGain = 0.85; SPEC.pod.ledGain = 0.8;

const DARK = '#0b0d14', GUN = '#2b2f3a', STEEL = '#6a7080';

function bezel(f, seg) {
  return P(RB(f.bw, f.bh, f.bd, Math.min(0.05, f.bh * 0.3), seg), '#07080d', { p: [0, f.y, f.z], r: [-f.tilt, 0, 0], rough: 0.1, metal: 0.1 });
}
function hipSockets(sp, r, col = GUN) {
  return sp.hips.map((h) => P(new THREE.CylinderGeometry(r * 0.9, r, r * 0.9, 8, 1, true), col, { p: [h[0], 0.005, h[2]], rough: 0.4, metal: 0.6 }));
}

function buildBody(kind, det) {
  const sp = SPEC[kind], C = Object.assign({}, KIND_COLORS[kind]);
  if (kind !== 'xb3' && kind !== 'xb10') C.body = lin(C.body).map((v) => v * 0.86);
  const seg = det >= 2 ? 4 : 2;
  const s1 = det >= 2 ? 2 : 1;
  const parts = [];
  const { W, H, D } = sp;
  if (kind === 'xb6') {
    parts.push(P(taper(RB(W, H, D, 0.15, seg), -H / 2, H / 2, 1.04, 0.95), C.body, { p: [0, H / 2, 0], rough: 0.2, ao: [0, H * 0.6, 0.62] }));
    parts.push(P(RB(0.60, 0.1, 0.50, 0.06, s1), C.trim, { p: [0, H - 0.005, -0.005], rough: 0.35, metal: 0.2 }));
    for (const z of [-0.11, 0, 0.11]) parts.push(P(BX(0.4, 0.02, 0.028), C.glow, { p: [0, H + 0.046, z], led: 3.6 }));
    parts.push(bezel(sp.face, s1));
    parts.push(P(BX(0.12, 0.03, 0.03), C.glow, { p: [0, 0.1, D / 2 * 1.02 - 0.005], led: 1 }));
    parts.push(P(BX(0.05, 0.28, 0.03), C.glow, { p: [0, 0.32, -D / 2 * 0.99], led: 2 }));
    for (const x of [-1, 1]) for (const y of [0.27, 0.35, 0.43]) parts.push(P(BX(0.02, 0.028, 0.30), C.trim, { p: [x * W / 2 * 0.99, y, 0], rough: 0.6 }));
    parts.push(...hipSockets(sp, 0.07));
  } else if (kind === 'xb3') {
    parts.push(P(RB(W, H, D, 0.07, seg), C.body, { p: [0, H / 2, 0], rough: 0.18, metal: 0.1, ao: [0, H * 0.5, 0.7] }));
    const nR = det >= 1 ? 7 : 5;
    for (let i = 0; i < nR; i++) {
      const y = 0.12 + i * (0.68 / (nR - 1));
      for (const x of [-1, 1]) parts.push(P(BX(0.03, 0.032, 0.34), C.trim, { p: [x * (W / 2 + 0.008), y, 0], rough: 0.45, metal: 0.3 }));
      if (i % 2 === 0) parts.push(P(BX(0.36, 0.03, 0.03), C.trim, { p: [0, y, -D / 2 - 0.008], rough: 0.45, metal: 0.3 }));
    }
    parts.push(P(RB(0.38, 0.05, 0.32, 0.02, 1), C.trim, { p: [0, H + 0.01, 0], rough: 0.4, metal: 0.4 }));
    parts.push(bezel(sp.face, s1));
    for (let i = 0; i < 5; i++) parts.push(P(BX(0.06, 0.028, 0.02), C.glow, { p: [0, 0.50 - i * 0.075, D / 2 + 0.004], led: i + 1 }));
    // amber vents on the back (readable from behind)
    for (let i = 0; i < 3; i++) parts.push(P(BX(0.24, 0.02, 0.02), C.glow, { p: [0, 0.55 + i * 0.07, -D / 2 - 0.01], led: 2 }));
    // coax "tail" with a gold plug
    const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(0.05, 0.16, -0.2), new THREE.Vector3(0.07, 0.12, -0.33), new THREE.Vector3(0.12, 0.0, -0.42), new THREE.Vector3(0.2, -0.14, -0.46)]);
    parts.push(P(new THREE.TubeGeometry(curve, det >= 2 ? 14 : 8, 0.022, det >= 2 ? 8 : 5, false), '#1c1e24', { rough: 0.6 }));
    parts.push(P(CY(0.03, 0.03, 0.07, 6), '#d9a441', { p: [0.21, -0.15, -0.465], r: [0, 0, 1.1], rough: 0.3, metal: 0.9 }));
    parts.push(...hipSockets(sp, 0.085));
  } else if (kind === 'xb7') {
    parts.push(P(RB(W, H, D, 0.21, seg), C.body, { p: [0, H / 2, 0], rough: 0.2, ao: [0, H * 0.6, 0.62] }));
    parts.push(P(RB(0.40, 0.07, 0.38, 0.05, s1), '#9aa0ac', { p: [0, H - 0.01, 0], rough: 0.5 }));
    // perforated grille: crossing dark slats
    const n = det >= 1 ? 5 : 3;
    for (let i = 0; i < n; i++) {
      const o = (i - (n - 1) / 2) * (0.32 / (n - 1));
      parts.push(P(BX(0.012, 0.012, 0.34), '#474c58', { p: [o, H + 0.022, 0], rough: 0.7 }));
      parts.push(P(BX(0.36, 0.012, 0.012), '#474c58', { p: [0, H + 0.022, o * 0.95], rough: 0.7 }));
    }
    parts.push(bezel(sp.face, s1));
    // red chevron "grille" under the face
    for (const x of [-1, 1]) parts.push(P(BX(0.13, 0.03, 0.03), C.glow, { p: [x * 0.055, 0.17, D / 2 - 0.004], r: [0, 0, x * 0.42], led: 1 }));
    // swept rocket fins
    for (const x of [-1, 1]) {
      parts.push(P(RB(0.07, 0.26, 0.24, 0.03, det >= 2 ? 2 : 1), C.trim, { p: [x * (W / 2 + 0.02), 0.34, -0.07], r: [0.5, 0, 0], rough: 0.4, metal: 0.3 }));
      parts.push(P(BX(0.075, 0.2, 0.02), C.glow, { p: [x * (W / 2 + 0.022), 0.35, 0.03], r: [0.5, 0, 0], led: 2 }));
    }
    // rear thruster
    parts.push(P(CY(0.1, 0.12, 0.1, det >= 2 ? 16 : 10), GUN, { p: [0, 0.27, -D / 2 - 0.03], r: [Math.PI / 2, 0, 0], rough: 0.35, metal: 0.8 }));
    parts.push(P(CY(0.08, 0.08, 0.02, det >= 2 ? 16 : 10), C.glow, { p: [0, 0.27, -D / 2 - 0.082], r: [Math.PI / 2, 0, 0], led: 2 }));
    parts.push(...hipSockets(sp, 0.065));
  } else if (kind === 'xb8') {
    const rad = det >= 2 ? 32 : det >= 1 ? 18 : 14, ps = det >= 2 ? 5 : 3;
    parts.push(P(roundLathe(0.25, 0.215, H, 0.07, 0.11, ps, rad), C.body, { rough: 0.22, ao: [0, H * 0.55, 0.62] }));
    parts.push(P(CY(0.16, 0.18, 0.025, rad), C.trim, { p: [0, H + 0.004, 0], rough: 0.45 }));
    parts.push(P(CY(0.012, 0.018, 0.16, 6), C.trim, { p: [0, H + 0.08, 0], rough: 0.4, metal: 0.5 }));
    parts.push(P(SP(0.03, 8, 5), C.glow, { p: [0, H + 0.17, 0], led: 2 }));
    parts.push(P(TO(0.252, 0.014, 4, rad), C.glow, { p: [0, 0.2, 0], r: [Math.PI / 2, 0, 0], led: 1 }));
    parts.push(P(BX(0.035, 0.42, 0.03), C.glow, { p: [0, 0.48, -0.228], led: 3 }));
    const f = sp.face;
    parts.push(P(RB(f.bw, f.bh, f.bd + 0.06, 0.05, s1), '#07080d', { p: [0, f.y, f.z - 0.03], r: [-f.tilt, 0, 0], rough: 0.1, metal: 0.1 }));
    parts.push(...hipSockets(sp, 0.05));
  } else if (kind === 'xb10') {
    parts.push(P(RB(W, H, D, 0.11, seg), C.body, { p: [0, H / 2, 0], rough: 0.28, metal: 0.35, ao: [0, H * 0.55, 0.7] }));
    parts.push(P(RB(0.56, 0.05, 0.48, 0.02, s1), C.trim, { p: [0, H + 0.005, 0], rough: 0.3, metal: 0.8 }));
    // gold light band wrapping the base + a vertical accent
    parts.push(P(RB(W + 0.014, 0.034, D + 0.014, 0.11, 1), C.glow, { p: [0, 0.13, 0], led: 1 }));
    // command crown
    parts.push(P(CY(0.018, 0.026, 0.16, 6), C.trim, { p: [0, H + 0.1, -0.06], rough: 0.3, metal: 0.8 }));
    parts.push(P(SP(0.036, 8, 5), C.glow, { p: [0, H + 0.19, -0.06], led: 1 }));
    for (const x of [-1, 1]) {
      parts.push(P(CY(0.015, 0.022, 0.12, 6), C.trim, { p: [x * 0.16, H + 0.07, -0.08], r: [0, 0, -x * 0.4], rough: 0.3, metal: 0.8 }));
      parts.push(P(SP(0.03, 8, 5), C.glow, { p: [x * 0.185, H + 0.125, -0.08], led: 1 }));
      // hatch recess glow (hidden behind closed hatch)
      parts.push(P(BX(0.006, 0.25, 0.28), C.glow, { p: [x * (W / 2 + 0.001), 0.44, 0], led: 3 }));
    }
    parts.push(P(BX(0.4, 0.04, 0.02), C.glow, { p: [0, 0.27, D / 2 + 0.002], led: 2 }));
    parts.push(bezel(sp.face, s1));
    parts.push(...hipSockets(sp, 0.075));
  } else if (kind === 'pod') {
    parts.push(P(RB(W, H, D, 0.095, seg), C.body, { p: [0, H / 2, 0], rough: 0.25, ao: [0, H * 0.6, 0.65] }));
    parts.push(P(BX(0.17, 0.02, 0.10), C.trim, { p: [0, H + 0.002, -0.01], rough: 0.5 }));
    parts.push(P(SP(0.022, 6, 4), C.glow, { p: [0.08, H + 0.006, 0.05], led: 1 }));
    parts.push(bezel(sp.face, s1));
    parts.push(P(BX(0.15, 0.13, 0.02), C.trim, { p: [0, 0.14, -D / 2 - 0.005], rough: 0.5 }));
    for (const x of [-1, 1]) parts.push(P(CY(0.012, 0.012, 0.075, 6), '#d0d5de', { p: [x * 0.035, 0.14, -D / 2 - 0.045], r: [Math.PI / 2, 0, 0], rough: 0.25, metal: 0.95 }));
    parts.push(...hipSockets(sp, 0.03));
  }
  return merge(parts);
}

// Shared leg parts (unit-sized; scaled per kind by instance matrix)
const CYo = (rt, rb, h, n) => new THREE.CylinderGeometry(rt, rb, h, n, 1, true);
function buildPiston(det) {
  const n = det >= 2 ? 10 : 6;
  return merge([
    P(CYo(1.0, 1.15, 0.5, n), GUN, { p: [0, 0.25, 0], rough: 0.35, metal: 0.7 }),
    P(CYo(1.32, 1.32, 0.1, n), '#ffffff', { p: [0, 0.5, 0], led: 1 }),
    P(CYo(0.72, 0.72, 0.52, n), STEEL, { p: [0, 0.76, 0], rough: 0.22, metal: 0.9 }),
  ]);
}
function buildFoot(det) {
  return merge([
    P(RB(1.0, 0.78, 1.0, 0.32, det >= 2 ? 3 : 1), '#ffffff', { p: [0, 0.5, 0.04], tint: 1, rough: 0.28 }),
    P(BX(1.06, 0.24, 1.08), '#15171e', { p: [0, 0.12, 0.05], rough: 0.8 }),
    P(BX(0.62, 0.13, 0.06), '#ffffff', { p: [0, 0.42, 0.56], led: 1 }),
    P(CYo(0.3, 0.36, 0.3, det >= 2 ? 10 : 6), GUN, { p: [0, 0.92, -0.02], rough: 0.35, metal: 0.7 }),
  ]);
}
function buildPistonLo() {
  return merge([
    P(CYo(1.05, 1.1, 0.55, 4), GUN, { p: [0, 0.27, 0], r: [0, Math.PI / 4, 0], rough: 0.35, metal: 0.7 }),
    P(CYo(1.3, 1.3, 0.1, 4), '#ffffff', { p: [0, 0.52, 0], r: [0, Math.PI / 4, 0], led: 1 }),
    P(CYo(0.75, 0.75, 0.48, 4), STEEL, { p: [0, 0.76, 0], r: [0, Math.PI / 4, 0], rough: 0.22, metal: 0.9 }),
  ]);
}
function buildFootLo() {
  return merge([
    P(BX(1.0, 0.62, 1.0), '#ffffff', { p: [0, 0.55, 0.04], tint: 1, rough: 0.28 }),
    P(BX(1.06, 0.26, 1.08), '#15171e', { p: [0, 0.13, 0.05], rough: 0.8 }),
    P(BX(0.62, 0.13, 0.06), '#ffffff', { p: [0, 0.42, 0.56], led: 1 }),
  ]);
}
function buildRing(det) {
  const n = det >= 2 ? 32 : 18;
  const parts = [P(TO(0.2, 0.022, det >= 2 ? 6 : 4, n), '#ffffff', { r: [Math.PI / 2, 0, 0], led: 1 })];
  for (let i = 0; i < 4; i++) { const a = i / 4 * TAU; parts.push(P(SP(0.032, 6, 4), '#c9ced8', { p: [Math.sin(a) * 0.2, 0, Math.cos(a) * 0.2], rough: 0.3, metal: 0.4 })); }
  return merge(parts);
}
function buildHatch(det) {
  const h = SPEC.xb10.hatch;
  return merge([
    P(RB(0.03, h.h, h.d, 0.012, det >= 2 ? 2 : 1), KIND_COLORS.xb10.body, { p: [0, -h.h / 2, 0], rough: 0.3, metal: 0.35 }),
    P(BX(0.034, 0.025, h.d * 0.8), KIND_COLORS.xb10.glow, { p: [0, -h.h + 0.04, 0], led: 2 }),
  ]);
}
function buildFacePlane() {
  const g = new THREE.PlaneGeometry(1, 1);
  return g;
}

// ------------------------------------------------------------------ GIGA GATEWAY geometry
const BOSS = {
  W: 2.05, H: 2.3, D: 1.6, standY: 0.85,
  hips: [[-0.98, 0.32, 0.5], [0.98, 0.32, 0.5], [-0.98, 0.32, -0.5], [0.98, 0.32, -0.5]],
  feet: [[-1.8, 0, 1.15], [1.8, 0, 1.15], [-1.8, 0, -1.1], [1.8, 0, -1.1]],
  L1: 1.25, L2: 1.75, ankleH: 0.28,
  face: { y: 1.62, z: 0.76, w: 1.6, h: 0.8, bw: 1.8, bh: 0.98, bd: 0.16, tilt: 0.16 },
  ants: [ // angle (from +Z), length, outward tilt
    [Math.PI * 0.5, 0.66, 0.42], [Math.PI * 0.76, 0.78, 0.3], [Math.PI, 0.86, 0.2], [Math.PI * 1.24, 0.78, 0.3], [Math.PI * 1.5, 0.66, 0.42],
  ],
  antR: 0.44, antY: 2.55,
  doors: { y: 0.62, z: 0.825, px: 0.46, w: 0.44, h: 0.56 },
  panels: [ // pos, yaw
    [-1.06, 0.95, 0.29, 0], [-1.06, 0.95, -0.29, 0], [1.06, 0.95, 0.29, 0], [1.06, 0.95, -0.29, 0],
    [-0.42, 1.15, -0.835, Math.PI / 2], [0.42, 1.15, -0.835, Math.PI / 2],
  ],
  seamDim: 0.5,
};
BOSS.faceM = faceMatrix(BOSS.face);
BOSS.glow = lin(KIND_COLORS.boss_gateway.glow);
BOSS.red = lin('#ff2a1a');

function buildBoss(det) {
  const C = KIND_COLORS.boss_gateway, seg = det >= 2 ? 4 : det >= 1 ? 3 : 2, s1 = det >= 1 ? 2 : 1;
  const { W, H, D } = BOSS;
  const T = [];
  T.push(P(taper(RB(W, H, D, 0.24, seg), -H / 2, H / 2, 1.0, 0.94), C.body, { p: [0, H / 2, 0], rough: 0.3, metal: 0.35, ao: [0, H * 0.5, 0.65] }));
  // thin gold seams
  T.push(P(RB(W + 0.03, 0.045, D + 0.03, 0.24, s1), C.glow, { p: [0, 0.14, 0], led: 1 }));
  T.push(P(taper(RB(W * 0.94 + 0.03, 0.04, D * 0.94 + 0.03, 0.23, s1), -1, 1, 1, 1), C.glow, { p: [0, H - 0.12, 0], led: 3 }));
  for (const x of [-1, 1]) for (const z of [-1, 1]) T.push(P(BX(0.03, H - 0.4, 0.03), C.glow, { p: [x * (W / 2 - 0.07) * 0.985, H / 2, z * (D / 2 - 0.07) * 0.985], r: [0, x * z * Math.PI / 4, 0], led: 2 }));
  // XB10-style gold light bar between face and chest
  T.push(P(RB(1.3, 0.06, 0.04, 0.025, 1), C.glow, { p: [0, 1.04, D / 2 + 0.005], led: 2 }));
  // top: trim plate + crown turret
  T.push(P(RB(W * 0.9, 0.1, D * 0.86, 0.05, s1), C.trim, { p: [0, H + 0.01, 0], rough: 0.3, metal: 0.8 }));
  T.push(P(CY(0.56, 0.72, 0.2, 6), '#2a2e3e', { p: [0, H + 0.15, -0.05], r: [0, Math.PI / 6, 0], rough: 0.3, metal: 0.6 }));
  T.push(P(CY(0.5, 0.56, 0.06, 6), C.trim, { p: [0, H + 0.27, -0.05], r: [0, Math.PI / 6, 0], rough: 0.3, metal: 0.8 }));
  T.push(P(CY(0.575, 0.575, 0.025, 6), C.glow, { p: [0, H + 0.235, -0.05], r: [0, Math.PI / 6, 0], led: 4 }));
  // upper side vent grilles
  for (const x of [-1, 1]) for (let i = 0; i < 4; i++) T.push(P(BX(0.05, 0.045, 0.9), '#11131b', { p: [x * (W / 2 * 0.96 + 0.01), 1.55 + i * 0.13, 0], rough: 0.5, metal: 0.4 }));
  const f = BOSS.face;
  T.push(P(RB(f.bw, f.bh, f.bd, 0.12, s1), '#07080d', { p: [0, f.y, f.z], r: [-f.tilt, 0, 0], rough: 0.1, metal: 0.1 }));
  // chest bay: dark frame + glowing interior (revealed when doors open)
  T.push(P(RB(0.98, 0.64, 0.05, 0.03, 1), '#101219', { p: [0, BOSS.doors.y, D / 2 - 0.0], rough: 0.5 }));
  T.push(P(BX(0.84, 0.5, 0.02), '#6dffb0', { p: [0, BOSS.doors.y, D / 2 + 0.018], led: 5 }));
  // cracks (LED index 8 = lit by crack level)
  const crack = (pts, x0, face) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const [a0, b0] = pts[i], [a1, b1] = pts[i + 1];
      const len = Math.hypot(a1 - a0, b1 - b0), ang = Math.atan2(b1 - b0, a1 - a0);
      if (face === 'front') T.push(P(BX(len + 0.02, 0.03, 0.02), '#0a0b10', { p: [(a0 + a1) / 2, (b0 + b1) / 2, D / 2 + 0.006], r: [0, 0, ang], led: 8, rough: 0.6 }));
      else T.push(P(BX(0.02, 0.03, len + 0.02), '#0a0b10', { p: [x0, (b0 + b1) / 2, (a0 + a1) / 2], r: [-ang, 0, 0], led: 8, rough: 0.6 }));
    }
  };
  crack([[-0.92, 0.3], [-0.76, 0.5], [-0.84, 0.7], [-0.62, 0.92]], 0, 'front');
  crack([[0.6, 0.12], [0.76, 0.32], [0.68, 0.48], [0.88, 0.7]], 0, 'front');
  crack([[-0.3, 2.22], [-0.12, 2.12], [0.08, 2.18]], 0, 'front');
  crack([[0.5, 0.3], [0.28, 0.55], [0.38, 0.8], [0.1, 1.2]], W / 2 + 0.003, 'side');
  crack([[-0.45, 1.3], [-0.2, 1.15], [-0.32, 0.9]], -W / 2 - 0.003, 'side');
  // shoulder lamps + back spine
  for (const x of [-1, 1]) T.push(P(SP(0.07, 10, 8), C.glow, { p: [x * 0.86, H + 0.08, 0.6], led: 6 }));
  T.push(P(BX(0.1, 1.5, 0.04), C.glow, { p: [0, 1.2, -D / 2 - 0.005], led: 2 }));
  for (const h of BOSS.hips) T.push(P(SP(0.27, det >= 1 ? 14 : 10, det >= 1 ? 10 : 7), GUN, { p: h, rough: 0.35, metal: 0.7 }));
  const torso = merge(T);

  const nL = det >= 1 ? 12 : 8, L1 = BOSS.L1, L2 = BOSS.L2;
  const thigh = merge([
    P(taper(RB(0.36, L1 * 0.72, 0.42, 0.1, s1), -L1 * 0.36, L1 * 0.36, 1.1, 0.8), '#2a2e3e', { p: [0, L1 * 0.48, 0], rough: 0.3, metal: 0.5 }),
    P(BX(0.03, L1 * 0.5, 0.43), C.glow, { p: [0, L1 * 0.48, 0], led: 2 }),
    P(SP(0.25, nL + 2, nL), GUN, { p: [0, L1, 0], rough: 0.3, metal: 0.8 }),
    P(TO(0.25, 0.035, 5, nL + 4), C.glow, { p: [0, L1, 0], r: [0, 0, Math.PI / 2], led: 4 }),
  ]);
  const shin = merge([
    P(taper(RB(0.46, L2 * 0.46, 0.5, 0.12, s1), -L2 * 0.23, L2 * 0.23, 1.0, 0.72), C.body, { p: [0, L2 * 0.27, 0], rough: 0.28, metal: 0.45 }),
    P(RB(0.3, 0.08, 0.52, 0.03, 1), C.trim, { p: [0, L2 * 0.12, 0], rough: 0.3, metal: 0.8 }),
    P(CY(0.2, 0.2, 0.05, nL), C.glow, { p: [0, L2 * 0.52, 0], led: 4 }),
    P(CY(0.11, 0.12, L2 * 0.42, nL), STEEL, { p: [0, L2 * 0.74, 0], rough: 0.2, metal: 0.9 }),
  ]);
  const footParts = [
    P(CY(0.34, 0.44, 0.18, det >= 1 ? 16 : 10), '#1f2230', { p: [0, 0.09, 0], rough: 0.5, metal: 0.4 }),
    P(TO(0.4, 0.022, 4, det >= 1 ? 20 : 12), C.glow, { p: [0, 0.11, 0], r: [Math.PI / 2, 0, 0], led: 1 }),
    P(SP(0.16, 10, 8), GUN, { p: [0, BOSS.ankleH, 0], rough: 0.3, metal: 0.8 }),
  ];
  for (const a of [-0.6, 0, 0.6]) footParts.push(P(RB(0.15, 0.13, 0.38, 0.045, 1), STEEL, { p: [Math.sin(a) * 0.42, 0.065, Math.cos(a) * 0.42], r: [0, a, 0], rough: 0.3, metal: 0.85 }));
  const foot = merge(footParts);
  const antenna = merge([
    P(CY(0.12, 0.14, 0.1, 8), C.trim, { p: [0, 0.05, 0], rough: 0.3, metal: 0.8 }),
    P(CY(0.045, 0.07, 0.86, 8), GUN, { p: [0, 0.45, 0], rough: 0.3, metal: 0.7 }),
    P(CY(0.085, 0.085, 0.04, 8), C.glow, { p: [0, 0.32, 0], led: 4 }),
    P(CY(0.07, 0.07, 0.04, 8), C.glow, { p: [0, 0.62, 0], led: 4 }),
    P(SP(0.11, 12, 8), C.glow, { p: [0, 0.92, 0], led: 6 }),
  ]);
  const d = BOSS.doors;
  const door = merge([
    P(RB(d.w, d.h, 0.05, 0.03, s1), '#2a2e3e', { rough: 0.3, metal: 0.45 }),
    P(BX(d.w * 0.7, 0.03, 0.056), C.glow, { p: [0, -d.h * 0.3, 0], led: 2 }),
    P(BX(0.05, d.h * 0.7, 0.056), STEEL, { p: [0, 0, 0], rough: 0.3, metal: 0.8 }),
  ]);
  const panel = merge([
    P(RB(0.07, 0.56, 0.54, 0.04, s1), '#2a2e3e', { rough: 0.35, metal: 0.45 }),
    P(BX(0.075, 0.03, 0.42), C.glow, { p: [0, 0.22, 0], led: 2 }),
    P(BX(0.075, 0.36, 0.035), '#1a1c26', { p: [0, -0.04, 0], rough: 0.6 }),
  ]);
  return { torso, thigh, shin, foot, antenna, door, panel };
}

const _geoCache = {};
function GEO(det) {
  if (_geoCache[det]) return _geoCache[det];
  const g = { body: {}, piston: buildPiston(det), foot: buildFoot(det), pistonLo: buildPistonLo(), footLo: buildFootLo(), ring: buildRing(det), hatch: buildHatch(det), face: buildFacePlane(), boss: null };
  for (const k of CROWD_KINDS) g.body[k] = buildBody(k, det);
  _geoCache[det] = g;
  return g;
}
function bossGeo(det) { const g = GEO(det); if (!g.boss) g.boss = buildBoss(det); return g.boss; }

// Instanced wrapper sharing the base buffers + its own per-instance attributes.
function instGeo(base, cap, attrs) {
  const g = new THREE.BufferGeometry();
  g.setIndex(base.index);
  for (const k in base.attributes) g.setAttribute(k, base.attributes[k]);
  g.boundingSphere = base.boundingSphere; g.boundingBox = base.boundingBox;
  for (const [name, size, fill] of attrs) {
    const arr = new Float32Array(cap * size); if (fill) arr.fill(fill);
    const a = new THREE.InstancedBufferAttribute(arr, size); a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute(name, a);
  }
  return g;
}
function mkRobotIM(base, cap) {
  const g = instGeo(base, cap, [['iFx', 4], ['iGlow', 4]]);
  const im = new THREE.InstancedMesh(g, robotMat(), cap);
  im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
  im.instanceColor.setUsage(THREE.DynamicDrawUsage);
  im.frustumCulled = false; im.count = 0; im.visible = false;
  im.userData.base = base;
  return im;
}
function mkFaceIM(base, cap) {
  const g = instGeo(base, cap, [['iFace', 4], ['iFace2', 4]]);
  const im = new THREE.InstancedMesh(g, faceMat(), cap);
  im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
  im.instanceColor.setUsage(THREE.DynamicDrawUsage);
  im.frustumCulled = false; im.count = 0; im.visible = false;
  im.userData.base = base;
  return im;
}
function reGeo(im, newBase) { // swap base buffers keeping instanced attributes
  const old = im.geometry, g = new THREE.BufferGeometry();
  g.setIndex(newBase.index);
  for (const k in newBase.attributes) g.setAttribute(k, newBase.attributes[k]);
  for (const k in old.attributes) if (old.attributes[k].isInstancedBufferAttribute) g.setAttribute(k, old.attributes[k]);
  g.boundingSphere = newBase.boundingSphere; g.boundingBox = newBase.boundingBox;
  im.geometry = g; im.userData.base = newBase;
}
function upd(a, count) { a.clearUpdateRanges(); a.addUpdateRange(0, count); a.needsUpdate = true; }
function flushIM(im, n) {
  im.count = n;
  im.visible = n > 0;
  if (n <= 0) return;
  upd(im.instanceMatrix, n * 16);
  if (im.instanceColor) upd(im.instanceColor, n * 3);
  const ia = im.userData.inst || (im.userData.inst = []);
  if (ia.geo !== im.geometry) { ia.length = 0; ia.geo = im.geometry; const at = im.geometry.attributes; for (const k in at) if (at[k].isInstancedBufferAttribute) ia.push(at[k]); }
  for (let i = 0; i < ia.length; i++) upd(ia[i], n * ia[i].itemSize);
}
// write one robot-part instance
function wR(im, i, m, flash, led, elite, heat, gr, gg, gb, gw, tr = 1, tg = 1, tb = 1) {
  m.toArray(im.instanceMatrix.array, i * 16);
  const at = im.geometry.attributes, f = at.iFx.array, g = at.iGlow.array, c = im.instanceColor.array;
  const j = i * 4;
  f[j] = flash; f[j + 1] = led; f[j + 2] = elite; f[j + 3] = heat;
  g[j] = gr; g[j + 1] = gg; g[j + 2] = gb; g[j + 3] = gw;
  c[i * 3] = tr; c[i * 3 + 1] = tg; c[i * 3 + 2] = tb;
}
function wF(im, i, m, frame, dx, dy, bright, flash, glitch, seed, open, gr, gg, gb) {
  m.toArray(im.instanceMatrix.array, i * 16);
  const at = im.geometry.attributes, a = at.iFace.array, b = at.iFace2.array, c = im.instanceColor.array;
  const j = i * 4;
  a[j] = frame; a[j + 1] = dx; a[j + 2] = dy; a[j + 3] = bright;
  b[j] = flash; b[j + 1] = glitch; b[j + 2] = seed; b[j + 3] = open;
  c[i * 3] = gr; c[i * 3 + 1] = gg; c[i * 3 + 2] = gb;
}

// ------------------------------------------------------------------ pools
class SpritePool {
  constructor(cap) {
    const g = new THREE.InstancedBufferGeometry();
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    const mk = (n) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * n), n); a.setUsage(THREE.DynamicDrawUsage); return a; };
    this.aPos = mk(3); this.aCol = mk(4); this.aSize = mk(2);
    g.setAttribute('iPos', this.aPos); g.setAttribute('iCol', this.aCol); g.setAttribute('iSize', this.aSize);
    g.instanceCount = 0;
    this.mesh = new THREE.Mesh(g, spriteMat());
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 6; this.mesh.visible = false;
    this.cap = cap; this.n = 0; this.enabled = true;
  }
  begin() { this.n = 0; }
  add(x, y, z, size, r, g, b, a, shape = 0) {
    if (this.n >= this.cap || a <= 0.002 || size <= 0.001) return;
    const i = this.n++;
    const p = this.aPos.array, c = this.aCol.array, s = this.aSize.array;
    p[i * 3] = x; p[i * 3 + 1] = y; p[i * 3 + 2] = z;
    c[i * 4] = r; c[i * 4 + 1] = g; c[i * 4 + 2] = b; c[i * 4 + 3] = a;
    s[i * 2] = size; s[i * 2 + 1] = shape;
  }
  end() {
    const n = this.n; this.mesh.geometry.instanceCount = n; this.mesh.visible = n > 0;
    if (!n) return;
    upd(this.aPos, n * 3); upd(this.aCol, n * 4); upd(this.aSize, n * 2);
  }
}
class GroundPool extends SpritePool {
  constructor(cap) {
    super(cap);
    const g = this.mesh.geometry;
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, -0.5, -0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, 0, -0.5], 3));
    this.mesh.material = groundMat();
    this.mesh.renderOrder = 1;
  }
}

// =====================================================================================
// POSE (shared scratch; no allocation per frame)
// =====================================================================================
const PS = {
  x: 0, y: 0, z: 0, face: 0, s: 1,
  bx: 0, by: 0, bz: 0, pitch: 0, roll: 0, yaw: 0, sx: 1, sy: 1, sz: 1, legExt: 1,
  feet: [0, 1, 2, 3].map(() => ({ x: 0, y: 0, z: 0, pitch: 0, yaw: 0, sc: 1 })),
  frame: 0, bright: 1, dx: 0, dy: 0, open: 1, glitch: 0,
  flash: 0, led: 1, heat: 0, elite: 0, gr: 1, gg: 1, gb: 1, crack: 0,
  ringY: 0, ringSpin: 0, ringS: 1, ringGlow: 1, hatch: 0, face2: 0,
};
const _mRoot = new THREE.Matrix4(), _mBody = new THREE.Matrix4(), _mA = new THREE.Matrix4(), _mB = new THREE.Matrix4();
const _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, 'YXZ'), _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _sc = new THREE.Vector3();
const _Y = new THREE.Vector3(0, 1, 0);

// Y-axis segment from a to b (world), x-axis ~ `right`. Y column scaled by |b-a|/lenDiv.
function segMatrix(out, ax, ay, az, bx, by, bz, th, rx, rz, lenDiv = 1) {
  let dx = bx - ax, dy = by - ay, dz = bz - az;
  const len = Math.hypot(dx, dy, dz) || 1e-4;
  dx /= len; dy /= len; dz /= len;
  let zx = -rz * dy, zy = rz * dx - rx * dz, zz = rx * dy;
  let zl = Math.hypot(zx, zy, zz);
  if (zl < 1e-5) { zx = 0; zy = 0; zz = 1; zl = 1; }
  zx /= zl; zy /= zl; zz /= zl;
  const xx = dy * zz - dz * zy, xy = dz * zx - dx * zz, xz = dx * zy - dy * zx;
  const e = out.elements, L = len / lenDiv;
  e[0] = xx * th; e[1] = xy * th; e[2] = xz * th; e[3] = 0;
  e[4] = dx * L; e[5] = dy * L; e[6] = dz * L; e[7] = 0;
  e[8] = zx * th; e[9] = zy * th; e[10] = zz * th; e[11] = 0;
  e[12] = ax; e[13] = ay; e[14] = az; e[15] = 1;
  return len;
}

// ------------------------------------------------------------------ cosmetic per-id state
function newCos() {
  return {
    id: -1, seen: 0, seed: 1, phase: 0, face: 0, init: false, lastFace: 0, turn: 0,
    air: false, landT: -9, landAmt: 0, prevY: 0, blinkNext: 0, blinkT: -9, dartX: 0, dartY: 0, dtx: 0, dty: 0, dartNext: 0,
    rig: null, lastState: '', stateT0: 0, spinA: 0, bossDead: false, t: 0, vx: 0, vz: 0, px: 0, pz: 0,
  };
}
function resetCos(c) {
  c.id = -1; c.seen = 0; c.seed = 1; c.phase = 0; c.face = 0; c.init = false; c.lastFace = 0; c.turn = 0;
  c.air = false; c.landT = -9; c.landAmt = 0; c.prevY = 0; c.blinkNext = 0; c.blinkT = -9; c.dartX = 0; c.dartY = 0; c.dtx = 0; c.dty = 0; c.dartNext = 0;
  c.rig = null; c.lastState = ''; c.stateT0 = 0; c.spinA = 0; c.bossDead = false; c.t = 0; c.vx = 0; c.vz = 0; c.px = 0; c.pz = 0;
}
function rnd(c) { c.seed = (c.seed * 16807) % 2147483647; return (c.seed - 1) / 2147483646; }

function commonCos(e, c, t, dt) {
  if (!c.init) {
    c.init = true; c.face = e.face || 0; c.lastFace = c.face; c.seed = 1 + ((e.id * 7919) % 2147483000);
    c.phase = hash(e.id * 1.37); c.blinkNext = t + 0.8 + hash(e.id) * 2; c.dartNext = t + hash(e.id * 3.1);
    c.px = e.x; c.pz = e.z; c.prevY = e.y || 0; c.landT = -9; c.air = false;
  }
  // facing (visual smoothing)
  const target = e.face || 0;
  const d = wrapA(target - c.face);
  c.face += d * Math.min(1, dt * 16);
  c.turn = lerp(c.turn, dt > 0 ? wrapA(c.face - c.lastFace) / dt : 0, Math.min(1, dt * 8));
  c.lastFace = c.face;
  // blink / darts
  if (t >= c.blinkNext) { c.blinkT = t; c.blinkNext = t + 1.6 + rnd(c) * 2.8; }
  if (t >= c.dartNext) {
    c.dtx = (rnd(c) - 0.5) * 0.16; c.dty = (rnd(c) - 0.5) * 0.05;
    c.dartNext = t + 0.5 + rnd(c) * 1.8;
    if (rnd(c) < 0.35) { c.dtx = 0; c.dty = 0; }
  }
  const k = Math.min(1, dt * 20);
  c.dartX += (c.dtx - c.dartX) * k; c.dartY += (c.dty - c.dartY) * k;
  // airborne / landing
  const y = e.y || 0, gy = groundY(e.x, e.z);
  const air = y > gy + 0.035;
  if (c.air && !air) { c.landT = t; c.landAmt = clamp((c.prevY - y) / Math.max(dt, 1e-3) * 0.12 + 0.6, 0.6, 1.3); }
  c.air = air; c.prevY = y;
  if (e.state !== c.lastState) { c.lastState = e.state; c.stateT0 = t; }
}
function blinkOpen(c, t) {
  const b = t - c.blinkT;
  return b >= 0 && b < 0.14 ? 1 - Math.sin(b / 0.14 * Math.PI) * 0.92 : 1;
}

// =====================================================================================
// CROWD
// =====================================================================================
class Crowd {
  constructor(parent, caps, det, poolCaps) {
    this.root = new THREE.Group(); this.root.name = 'modems';
    this.root.matrixAutoUpdate = false;
    parent.add(this.root);
    this.det = det; this.caps = caps; this.q = 2; this.fxLevel = 2;
    this.k = {}; let faceCap = 0, legCap = 0;
    const G = GEO(det);
    this.kindsHere = Object.keys(caps);
    for (const kind of this.kindsHere) {
      const cap = caps[kind];
      const im = mkRobotIM(G.body[kind], cap); im.name = 'modem_' + kind; this.root.add(im);
      this.k[kind] = { im, n: 0, cap, warned: false };
      faceCap += cap; legCap += cap * SPEC[kind].legs;
    }
    this.face = mkFaceIM(G.face, faceCap); this.root.add(this.face);
    this.piston = mkRobotIM(G.piston, legCap); this.root.add(this.piston);
    this.foot = mkRobotIM(G.foot, legCap); this.root.add(this.foot);
    this.pistonLo = mkRobotIM(G.pistonLo, legCap); this.root.add(this.pistonLo);
    this.footLo = mkRobotIM(G.footLo, legCap); this.root.add(this.footLo);
    this.allLow = false; this.nLegLo = 0;
    this.ring = caps.xb8 ? mkRobotIM(G.ring, caps.xb8) : null; if (this.ring) this.root.add(this.ring);
    this.hatch = caps.xb10 ? mkRobotIM(G.hatch, caps.xb10 * 2) : null; if (this.hatch) this.root.add(this.hatch);
    this.sprites = new SpritePool(poolCaps.sprites); this.root.add(this.sprites.mesh);
    this.ground = new GroundPool(poolCaps.ground); this.root.add(this.ground.mesh);
    this.nFace = 0; this.nLeg = 0; this.nRing = 0; this.nHatch = 0;
  }
  allIMs() {
    const out = [this.face, this.piston, this.foot, this.pistonLo, this.footLo];
    for (const k of this.kindsHere) out.push(this.k[k].im);
    if (this.ring) out.push(this.ring); if (this.hatch) out.push(this.hatch);
    return out;
  }
  setDet(det) {
    if (det === this.det) return;
    this.det = det; const G = GEO(det);
    for (const k of this.kindsHere) reGeo(this.k[k].im, G.body[k]);
    reGeo(this.piston, G.piston); reGeo(this.foot, G.foot);
    if (this.ring) reGeo(this.ring, G.ring); if (this.hatch) reGeo(this.hatch, G.hatch);
  }
  setShadows(on) { // bodies only (legs/faces/rings are small; blob contact shadows cover them)
    for (const k of this.kindsHere) this.k[k].im.castShadow = on;
  }
  begin(t) {
    for (const k of this.kindsHere) this.k[k].n = 0;
    this.nFace = 0; this.nLeg = 0; this.nLegLo = 0; this.nRing = 0; this.nHatch = 0;
    this.sprites.begin(); this.ground.begin();
    this.ground.mesh.material.uniforms.uTime.value = t;
  }
  end() {
    for (const k of this.kindsHere) flushIM(this.k[k].im, this.k[k].n);
    flushIM(this.face, this.nFace); flushIM(this.piston, this.nLeg); flushIM(this.foot, this.nLeg);
    flushIM(this.pistonLo, this.nLegLo); flushIM(this.footLo, this.nLegLo);
    if (this.ring) flushIM(this.ring, this.nRing); if (this.hatch) flushIM(this.hatch, this.nHatch);
    this.sprites.end(); this.ground.end();
  }
  add(e, c, t, dt) {
    const slot = this.k[e.kind];
    if (!slot) return;
    if (slot.n >= slot.cap) { if (!slot.warned) { slot.warned = true; console.warn('[modems] capacity exceeded for', e.kind); } return; }
    const sp = SPEC[e.kind];
    poseCrowd(e, c, t, dt, sp, PS, this);
    this.write(e, sp, PS, slot, t, c);
  }
  write(e, sp, P, slot, t, c) {
    // root
    _e.set(0, P.face, 0); _q.setFromEuler(_e);
    _mRoot.compose(_v.set(P.x, P.y, P.z), _q, _sc.set(P.s, P.s, P.s));
    // body
    _e.set(P.pitch, P.yaw, P.roll); _q.setFromEuler(_e);
    _mA.compose(_v.set(P.bx, sp.legH * P.legExt + P.by, P.bz), _q, _sc.set(P.sx, P.sy, P.sz));
    _mBody.multiplyMatrices(_mRoot, _mA);
    const lg = sp.ledGain;
    wR(slot.im, slot.n++, _mBody, P.flash, P.led, P.elite, P.heat, P.gr * lg, P.gg * lg, P.gb * lg, 0);
    // face
    _mA.multiplyMatrices(_mBody, sp.faceM);
    wF(this.face, this.nFace++, _mA, P.frame, P.dx, P.dy, P.bright, P.flash, P.glitch, P.face2, P.open, P.gr, P.gg, P.gb);
    // legs
    const fa = P.face, rx = Math.cos(fa), rz = -Math.sin(fa), ext = P.legExt, s = P.s;
    const bt = sp.bootTint;
    const lo = !this.preview && (this.allLow || sp.lowLegs);
    const imF = lo ? this.footLo : this.foot, imP = lo ? this.pistonLo : this.piston;
    for (let j = 0; j < sp.legs; j++) {
      const li = lo ? this.nLegLo : this.nLeg;
      const f = P.feet[j], h = sp.hips[j];
      const fs = Math.max(0.001, ext * f.sc);
      // foot
      _e.set(f.pitch, f.yaw, 0); _q.setFromEuler(_e);
      _mA.compose(_v.set(f.x, f.y, f.z), _q, _sc.set(sp.foot[0] * fs, sp.foot[1] * fs, sp.foot[2] * fs));
      _mB.multiplyMatrices(_mRoot, _mA);
      wR(imF, li, _mB, P.flash, P.led * 0.55, P.elite, P.heat * 0.6, P.gr * lg, P.gg * lg, P.gb * lg, 0, bt[0], bt[1], bt[2]);
      // piston: ankle -> hip
      _v2.set(f.x, f.y + sp.ankleH * fs, f.z).applyMatrix4(_mRoot);
      _v3.set(h[0], h[1], h[2]).applyMatrix4(_mBody);
      segMatrix(_mA, _v2.x, _v2.y, _v2.z, _v3.x, _v3.y, _v3.z, sp.pistonR * s * Math.max(0.05, Math.min(1, ext * 1.4)), rx, rz);
      wR(imP, li, _mA, P.flash, P.led * 0.55, P.elite, P.heat * 0.6, P.gr * lg, P.gg * lg, P.gb * lg, 0);
      if (lo) this.nLegLo++; else this.nLeg++;
    }
    // XB8 halo ring
    if (e.kind === 'xb8' && this.ring) {
      _e.set(0, P.ringSpin, 0); _q.setFromEuler(_e);
      _mA.compose(_v.set(0, sp.ringY + P.ringY, 0), _q, _sc.set(P.ringS, P.ringS * 0.9 + 0.1, P.ringS));
      _mB.multiplyMatrices(_mBody, _mA);
      wR(this.ring, this.nRing++, _mB, P.flash, P.ringGlow, P.elite, 0, P.gr * lg, P.gg * lg, P.gb * lg, 0);
    }
    // XB10 hatches (gull-wing, hinged at top edge)
    if (e.kind === 'xb10' && this.hatch) {
      const hs = sp.hatch;
      for (let si = 0; si < 2; si++) {
        const side = si * 2 - 1;
        _e.set(0, 0, side * P.hatch * 1.25); _q.setFromEuler(_e);
        _mA.compose(_v.set(side * hs.x, hs.y, 0), _q, _sc.set(1, 1, 1));
        _mB.multiplyMatrices(_mBody, _mA);
        wR(this.hatch, this.nHatch++, _mB, P.flash, P.led, P.elite, 0, P.gr * lg, P.gg * lg, P.gb * lg, 0);
      }
    }
    // ground: contact shadow (+ elite ring)
    const gy = groundY(P.x, P.z);
    const hgt = Math.max(0, P.y - gy + P.by * 0.5);
    const shadowA = 0.55 * clamp01(1 - hgt * 0.9) * (0.5 + 0.5 * Math.min(1, P.legExt + 0.3));
    const r = KIND_DIMS[e.kind].r * s;
    this.ground.add(P.x, gy + 0.012, P.z, r * 2.5 * (1 + hgt * 0.35), 0, 0, 0, shadowA, 0);
    if (P.elite > 0) {
      this.ground.add(P.x, gy + 0.014, P.z, r * 2.6, 1.0, 0.72, 0.2, 0.75, 1);
      // crown sparkle over elites
      const tw = 0.5 + 0.5 * Math.sin(t * 5 + e.id);
      _v.set(0, sp.topY + 0.14, 0).applyMatrix4(_mBody);
      this.sprites.add(_v.x, _v.y, _v.z, 0.28 * s * (0.7 + 0.3 * tw), 1.0, 0.75, 0.25, 0.9 * tw, 1);
    }
  }
}

// =====================================================================================
// CROWD POSING — states & gaits
// =====================================================================================
const _sprite = new THREE.Vector3();
function bodyPt(crowd, P, sp, x, y, z, out) { // body-local -> world using the pose (before write)
  _e.set(0, P.face, 0); _q.setFromEuler(_e);
  _mRoot.compose(_v.set(P.x, P.y, P.z), _q, _sc.set(P.s, P.s, P.s));
  _e.set(P.pitch, P.yaw, P.roll); _q.setFromEuler(_e);
  _mA.compose(_v.set(P.bx, sp.legH * P.legExt + P.by, P.bz), _q, _sc.set(P.sx, P.sy, P.sz));
  _mBody.multiplyMatrices(_mRoot, _mA);
  return out.set(x, y, z).applyMatrix4(_mBody);
}

function gait(sp, c, P, t, spd, dt) {
  const amt = clamp01(spd / sp.refSpd);
  const idle = 1 - clamp01(spd / 0.25);
  c.phase += dt * spd / sp.stride;
  const ph = c.phase, seedT = t + hash(c.id) * 10;
  // idle breathing
  P.by += idle * (0.008 + 0.008 * Math.sin(seedT * 2.4));
  P.sy *= 1 + idle * 0.018 * Math.sin(seedT * 2.4);
  const fx = P.feet;
  if (sp.gait === 'hop') {
    const u = fract(ph), ua = 0.66;
    if (u < ua) {
      const w = u / ua, h = Math.sin(w * Math.PI);
      P.by += sp.hopH * h * amt;
      const st = 0.1 * amt * Math.abs(Math.cos(w * Math.PI));
      P.sy *= 1 + st; P.sx *= 1 - st * 0.4; P.sz *= 1 - st * 0.4;
      P.pitch += 0.16 * amt * Math.cos(w * Math.PI);
      for (let j = 0; j < sp.legs; j++) { fx[j].y = sp.hopH * h * amt * 0.55; fx[j].z += -0.05 * h * amt; fx[j].pitch = -0.35 * h * amt; }
    } else {
      const w = (u - ua) / (1 - ua), q = Math.sin(w * Math.PI);
      P.sy *= 1 - 0.17 * amt * q; P.sx *= 1 + 0.08 * amt * q; P.sz *= 1 + 0.08 * amt * q;
      P.by -= 0.03 * amt * q;
    }
  } else if (sp.gait === 'skitter') {
    P.by += 0.02 * Math.sin(t * 2.6 + c.id) * (0.4 + 0.6 * amt) + 0.012 * amt;
    for (let j = 0; j < sp.legs; j++) stepFoot(fx[j], ph + j / 3, sp.stride / 4 * amt, 0.05 * amt);
    P.roll += 0.03 * Math.sin(ph * TAU * 3) * amt;
  } else if (sp.gait === 'scurry') {
    const offs = [0, 0.5, 0.5, 0];
    for (let j = 0; j < sp.legs; j++) stepFoot(fx[j], ph + offs[j], sp.stride / 4 * amt, 0.04 * amt);
    P.by += 0.018 * Math.abs(Math.sin(ph * TAU)) * amt;
    P.roll += 0.1 * Math.sin(ph * TAU) * amt;
    P.yaw += 0.08 * Math.sin(ph * TAU * 0.5 + 1) * amt;
  } else { // bipeds: stomp / run / march
    const heavy = sp.gait === 'stomp', run = sp.gait === 'run';
    const sw = sp.stride / 4 * amt, lift = (heavy ? 0.13 : run ? 0.12 : 0.09) * amt;
    for (let j = 0; j < 2; j++) stepFoot(fx[j], ph + j * 0.5, sw, lift);
    const c4 = Math.cos(ph * TAU * 2);
    if (heavy) {
      const pulse = Math.pow(Math.max(0, c4), 8);
      P.by += (0.035 * (1 - Math.max(0, c4)) - 0.03 * pulse) * amt;
      P.sy *= 1 - 0.07 * pulse * amt; P.sx *= 1 + 0.035 * pulse * amt; P.sz *= 1 + 0.035 * pulse * amt;
      P.roll += 0.09 * Math.sin(ph * TAU) * amt;
      P.yaw += 0.06 * Math.sin(ph * TAU) * amt;
    } else if (run) {
      P.by += 0.035 * Math.abs(Math.sin(ph * TAU)) * amt;
      P.roll += 0.05 * Math.sin(ph * TAU) * amt;
      P.sy *= 1 + 0.04 * Math.sin(ph * TAU * 2) * amt;
    } else {
      P.by += 0.02 * Math.abs(Math.sin(ph * TAU)) * amt;
      P.roll += 0.035 * Math.sin(ph * TAU) * amt;
      P.yaw += 0.03 * Math.sin(ph * TAU) * amt;
    }
  }
  P.pitch += sp.lean * amt;
  P.roll += clamp(-c.turn * 0.05, -0.22, 0.22) * (0.3 + amt);
  // per-kind idle personality
  if (idle > 0.01) {
    const k = sp.idleK || 'none';
    if (k === 'bouncy') { // XB6: impatient little hop in place every ~1.8 s
      const u = fract(seedT / 1.8);
      if (u < 0.22) { const w = u / 0.22, h = Math.sin(w * Math.PI); P.by += 0.07 * h * idle; P.sy *= 1 + 0.06 * h * idle; for (let j = 0; j < sp.legs; j++) fx[j].y += 0.03 * h * idle; }
      else if (u < 0.32) { const q = Math.sin((u - 0.22) / 0.1 * Math.PI); P.sy *= 1 - 0.09 * q * idle; P.sx *= 1 + 0.045 * q * idle; P.sz *= 1 + 0.045 * q * idle; }
    } else if (k === 'grumpy') { // XB3: slow heavy breathing + side-to-side weight shift
      P.sy *= 1 + 0.022 * Math.sin(seedT * 1.3) * idle; P.roll += 0.04 * Math.sin(seedT * 0.7) * idle;
    } else if (k === 'tap') { // XB7: foot tapping + restless lean
      const u = fract(seedT * 1.6);
      fx[1].y += 0.035 * Math.max(0, Math.sin(u * TAU)) * idle; fx[1].pitch -= 0.3 * Math.max(0, Math.sin(u * TAU)) * idle;
      P.pitch += (0.08 + 0.03 * Math.sin(seedT * 3.2)) * idle; P.yaw += 0.05 * Math.sin(seedT * 0.9) * idle;
    } else if (k === 'hover') { // XB8: floaty sway
      P.by += 0.02 * Math.sin(seedT * 1.7) * idle; P.roll += 0.035 * Math.sin(seedT * 1.1) * idle;
    } else if (k === 'stern') { // XB10: slow surveying turn
      P.yaw += 0.18 * Math.sin(seedT * 0.55) * idle;
    } else if (k === 'jitter') { // pod: twitchy
      const n = Math.floor(seedT * 4);
      P.yaw += (hash(n) - 0.5) * 0.35 * idle; P.by += (hash(n * 1.7) > 0.8 ? 0.02 : 0) * idle;
    }
  }
  return amt;
}
function stepFoot(f, ph, sw, lift) {
  const u = fract(ph);
  if (u < 0.5) { const w = u / 0.5; f.z += sw * (1 - 2 * w); }
  else { const w = (u - 0.5) / 0.5, sm = smooth(w); f.z += sw * (-1 + 2 * sm); f.y += lift * Math.sin(w * Math.PI); f.pitch += -0.45 * Math.sin(w * Math.PI) * (lift > 0 ? 1 : 0); }
}

function resetPose(P, e, c, sp) {
  P.x = e.x; P.y = e.y || 0; P.z = e.z; P.face = c.face; P.s = e.elite ? 1.25 : 1;
  P.bx = P.by = P.bz = 0; P.pitch = P.roll = P.yaw = 0; P.sx = P.sy = P.sz = 1; P.legExt = 1;
  for (let j = 0; j < 4; j++) {
    const f = P.feet[j], r = sp && sp.feet[j];
    f.x = r ? r[0] : 0; f.y = r ? r[1] : 0; f.z = r ? r[2] : 0; f.pitch = 0; f.yaw = 0; f.sc = 1;
  }
  P.bright = 1; P.dx = c.dartX; P.dy = c.dartY; P.open = 1; P.glitch = 0;
  P.flash = clamp01(e.flash || 0); P.led = 1; P.heat = 0; P.elite = e.elite ? 1 : 0; P.crack = 0;
  P.ringY = 0; P.ringSpin = 0; P.ringS = 1; P.ringGlow = 1; P.hatch = 0; P.face2 = hash(e.id * 0.7);
}

// attack style: from the sim's attack name when we know it, else the kind's signature move
const KIND_STYLE = { xb3: 'stomp', xb7: 'charge', xb8: 'wave', xb10: 'deploy', xb6: 'lunge', pod: 'lunge' };
const ATK_STYLE = { stomp: 'stomp', slam: 'stomp', charge: 'charge', dash: 'charge', rush: 'charge', wave: 'wave', deploy: 'deploy', lunge: 'lunge', bite: 'lunge', leap: 'lunge', hop: 'lunge', pounce: 'lunge' };
function attackStyle(kind, atk) {
  let st = (atk && ATK_STYLE[atk]) || KIND_STYLE[kind] || 'lunge';
  if (st === 'wave' && kind !== 'xb8') st = 'lunge';
  if (st === 'deploy' && kind !== 'xb10') st = 'lunge';
  return st;
}

function poseCrowd(e, c, t, dt, sp, P, crowd) {
  commonCos(e, c, t, dt);
  c.id = e.id;
  resetPose(P, e, c, sp);
  P.gr = sp.glow[0]; P.gg = sp.glow[1]; P.gb = sp.glow[2];
  P.frame = sp.frames.base;
  P.open = blinkOpen(c, t);
  const FR = sp.frames;
  const dur = e.stateDur > 0 ? e.stateDur : 1;
  const p = clamp01((e.stateT || 0) / dur);
  const st = e.state;
  const spd = st === 'move' || st === 'spawn' ? (e.spd || 0) : (e.spd || 0) * 0.5;
  const kind = e.kind;
  const sty = attackStyle(kind, e.attack);
  const S = crowd.sprites, fxOn = crowd.fxLevel;
  const G = sp.glow;
  // locomotion (spawn does its own)
  if (st !== 'spawn') gait(sp, c, P, t, spd, dt);
  // XB8 ring idle spin, XB10 crown blink
  if (kind === 'xb8') { c.spinA += dt * 1.4; P.ringSpin = c.spinA; P.ringY = 0.015 * Math.sin(t * 2 + e.id); }

  if (st === 'spawn') {
    poseSpawn(e, c, t, dt, sp, P, p, crowd);
  } else if (st === 'windup') {
    const k = smooth(p);
    if (sty === 'stomp') { // rear up, LEDs charge
      P.pitch -= 0.38 * easeOut(p); P.by += 0.09 * easeOut(p); P.legExt = 1 + 0.25 * easeOut(p);
      P.sy *= 1 + 0.06 * k; P.led = 1 + 2.2 * k; P.frame = p < 0.8 ? FR.squint : FR.fury;
      const sh = range(p, 0.6, 1) * 0.02; P.bx += Math.sin(t * 71) * sh; P.bz += Math.cos(t * 63) * sh;
      bodyPt(crowd, P, sp, 0, 0.3, 0.24, _sprite); S.add(_sprite.x, _sprite.y, _sprite.z, 0.5 + 0.6 * k, G[0], G[1], G[2], 0.5 * k, 0);
      for (let j = 0; j < 2; j++) P.feet[j].x *= 1 + 0.12 * k;
    } else if (sty === 'charge') { // crouch, shiver, glow red hot, steam
      P.sy *= 1 - 0.2 * k; P.sx *= 1 + 0.07 * k; P.sz *= 1 + 0.07 * k; P.by -= 0.07 * k; P.pitch += 0.28 * k;
      P.bx += Math.sin(t * 83) * 0.018 * k; P.bz += Math.cos(t * 77) * 0.012 * k; P.roll += Math.sin(t * 91) * 0.04 * k;
      P.heat = k; P.led = 1 + 2 * k; P.frame = FR.squint;
      for (let j = 0; j < 2; j++) { P.feet[j].z -= 0.05 * k; P.feet[j].x *= 1 + 0.15 * k; }
      if (fxOn) for (let i = 0; i < 3; i++) {
        const u = fract(t * 1.6 + i / 3 + hash(e.id));
        bodyPt(crowd, P, sp, (hash(i + e.id) - 0.5) * 0.3, sp.H + 0.05 + u * 0.5, (hash(i * 3 + e.id) - 0.5) * 0.25, _sprite);
        S.add(_sprite.x, _sprite.y, _sprite.z, 0.25 + u * 0.35, 0.9, 0.8, 0.8, 0.35 * k * (1 - u), 0);
      }
      bodyPt(crowd, P, sp, 0, 0.27, -sp.D / 2 - 0.08, _sprite); S.add(_sprite.x, _sprite.y, _sprite.z, 0.3 + 0.35 * k, 1, 0.2, 0.1, 1.2 * k, 0);
    } else if (sty === 'wave') { // ring charges
      P.ringY += 0.13 * easeOut(p); c.spinA += dt * 16 * k; P.ringSpin = c.spinA; P.ringGlow = 1 + 2.4 * k;
      P.ringS = 1 + 0.06 * Math.sin(t * 40) * k; P.by += 0.04 * k; P.pitch -= 0.1 * k; P.led = 1 + k; P.frame = FR.squint;
      bodyPt(crowd, P, sp, 0, sp.ringY + P.ringY, 0, _sprite); S.add(_sprite.x, _sprite.y, _sprite.z, 0.35 + 0.75 * k, G[0], G[1], G[2], 1.1 * k, 0);
      bodyPt(crowd, P, sp, 0, sp.H + 0.17, 0, _sprite); S.add(_sprite.x, _sprite.y, _sprite.z, 0.2 + 0.3 * k, 1, 1, 1, 0.8 * k, 1);
    } else if (sty === 'deploy') { // hatches open, crown blinks
      P.hatch = easeOutBack(range(p, 0, 0.6), 1.4); P.sy *= 1 - 0.07 * k; P.by -= 0.02 * k;
      P.led = 1 + 1.4 * k + (Math.sin(t * 30) > 0 ? 0.6 * k : 0); P.frame = FR.squint;
      for (let si = 0; si < 2; si++) { const sd = si * 2 - 1; bodyPt(crowd, P, sp, sd * (sp.W / 2 + 0.06), 0.44, 0, _sprite); S.add(_sprite.x, _sprite.y, _sprite.z, 0.3 + 0.4 * P.hatch, G[0], G[1], G[2], 0.9 * P.hatch, 0); }
    } else { // generic crouch + charge (xb6 / pod / unknown)
      P.sy *= 1 - 0.16 * k; P.sx *= 1 + 0.08 * k; P.sz *= 1 + 0.08 * k; P.by -= 0.03 * k; P.pitch += 0.1 * k;
      P.bx += Math.sin(t * 70) * 0.012 * k; P.led = 1 + 1.5 * k; P.frame = FR.squint;
      bodyPt(crowd, P, sp, 0, sp.face.y, sp.face.z + 0.1, _sprite); S.add(_sprite.x, _sprite.y, _sprite.z, (0.3 + 0.4 * k) * sp.face.w * 2.2, G[0], G[1], G[2], 0.7 * k, 0);
    }
  } else if (st === 'attack') {
    if (sty === 'stomp') { // SLAM
      const a = range(p, 0, 0.16), after = range(p, 0.16, 1);
      const dn = easeIn(a);
      P.pitch += lerp(-0.38, 0.14, dn) * (1 - after * 0.8);
      P.by += lerp(0.09, -0.1, dn) * (1 - smooth(after));
      const sq = a < 1 ? dn : Math.exp(-after * 4) * Math.cos(after * 14);
      P.sy *= 1 - 0.3 * sq; P.sx *= 1 + 0.16 * sq; P.sz *= 1 + 0.16 * sq;
      P.led = 3 - 2 * after; P.frame = FR.fury;
      for (let j = 0; j < 2; j++) P.feet[j].x *= 1 + 0.14 * (1 - after);
      if (a >= 1 && after < 0.35) { bodyPt(crowd, P, sp, 0, 0.05, 0.1, _sprite); S.add(_sprite.x, _sprite.y - 0.1, _sprite.z, 1.4 * (1 - after), G[0], G[1], G[2], 1.2 * (1 - after / 0.35), 0); }
    } else if (sty === 'charge') { // STREAK
      const k = 1 - range(p, 0.75, 1);
      P.pitch += 0.5 * k; P.sz *= 1 + 0.35 * k; P.sy *= 1 - 0.15 * k; P.sx *= 1 - 0.1 * k; P.by += 0.03 * k;
      P.heat = 0.6 + 0.4 * k; P.led = 3; P.frame = FR.fury;
      for (let j = 0; j < 2; j++) { P.feet[j].z = -0.2 * k + P.feet[j].z * (1 - k); P.feet[j].y += 0.1 * k; P.feet[j].pitch = -0.8 * k; }
      const fl = 0.8 + 0.4 * Math.sin(t * 60 + j0(e.id));
      bodyPt(crowd, P, sp, 0, 0.27, -sp.D / 2 - 0.12, _sprite); S.add(_sprite.x, _sprite.y, _sprite.z, 0.5 * fl * k + 0.1, 1, 0.45, 0.15, 1.6 * k, 0);
      bodyPt(crowd, P, sp, 0, 0.27, -sp.D / 2 - 0.3, _sprite); S.add(_sprite.x, _sprite.y, _sprite.z, 0.45 * fl * k, 1, 0.15, 0.05, 1.0 * k, 0);
      if (fxOn) for (let i = 1; i <= 4; i++) {
        const d = i * 0.34 * P.s, fs = Math.sin(P.face), fc = Math.cos(P.face);
        S.add(P.x - fs * d, P.y + 0.42 * P.s, P.z - fc * d, (0.75 - i * 0.08) * P.s, 1, 0.12, 0.08, (0.5 - i * 0.1) * k, 0);
      }
    } else if (sty === 'wave') { // EMIT
      const a = range(p, 0, 0.35), k = 1 - smooth(range(p, 0.3, 1));
      P.ringS = 1 + 1.3 * easeOut(a) * (1 - range(p, 0.35, 0.6)); P.ringGlow = 4 * (1 - a) + 1; P.ringY += 0.13 * k;
      c.spinA += dt * 10 * k; P.ringSpin = c.spinA;
      P.bz -= 0.12 * Math.sin(Math.min(1, p * 2.5) * Math.PI) ; P.pitch -= 0.28 * Math.exp(-p * 5); P.frame = FR.fury; P.led = 2 * k + 1;
      bodyPt(crowd, P, sp, 0, sp.ringY + P.ringY, 0, _sprite);
      S.add(_sprite.x, _sprite.y, _sprite.z, 0.6 + 1.6 * a, G[0], G[1], G[2], 1.4 * (1 - a), 0);
      S.add(_sprite.x, _sprite.y, _sprite.z, 0.6 + 1.2 * a, G[0], G[1], G[2], 1.0 * (1 - a), 2);
    } else if (sty === 'deploy') { // DEPLOY: pods pop
      const a = range(p, 0, 0.3);
      P.hatch = 1 + 0.2 * Math.sin(a * Math.PI); P.by += 0.07 * Math.sin(a * Math.PI); P.sy *= 1 + 0.08 * Math.sin(a * Math.PI);
      P.frame = FR.fury; P.led = 2.2 - p;
      if (fxOn) for (let si = 0; si < 6; si++) {
        const sd = (si >> 1) * 2 - 1, i = si % 3;
        const u = clamp01(p * 2.2 - i * 0.12);
        if (u <= 0 || u >= 1) continue;
        bodyPt(crowd, P, sp, sd * (sp.W / 2 + 0.05 + u * 0.7), 0.44 + Math.sin(u * Math.PI) * 0.35 + (i - 1) * 0.06, (i - 1) * 0.15 * u, _sprite);
        S.add(_sprite.x, _sprite.y, _sprite.z, 0.18, G[0], G[1], G[2], 1.3 * (1 - u), 1);
      }
    } else { // generic lunge
      const k = Math.sin(Math.min(1, p * 1.6) * Math.PI);
      P.pitch += 0.35 * k; P.sz *= 1 + 0.2 * k; P.sy *= 1 - 0.08 * k; P.bz += 0.12 * k; P.by += 0.05 * k;
      P.frame = FR.fury; P.led = 2;
    }
  } else if (st === 'recover') {
    const k = 1 - smooth(p);
    if (sty === 'charge') { dizzy(P, sp, t, k, crowd, e); P.heat = 0.5 * k; P.frame = p < 0.7 ? FR.dizzy : FR.base; }
    else if (sty === 'stomp') { P.yaw += Math.sin(t * 14) * 0.12 * k; P.sy *= 1 - 0.05 * k; P.frame = p < 0.5 ? FR.squint : FR.base;
      if (fxOn) for (let i = 0; i < 2; i++) { const u = fract(t * 1.2 + i * 0.5); bodyPt(crowd, P, sp, (i - 0.5) * 0.2, sp.H + 0.05 + u * 0.4, 0, _sprite); S.add(_sprite.x, _sprite.y, _sprite.z, 0.2 + u * 0.3, 0.7, 0.7, 0.75, 0.3 * k * (1 - u), 0); } }
    else if (sty === 'deploy') { P.hatch = k; }
    else if (sty === 'wave') { P.ringY += 0.13 * k; P.ringGlow = 1 + k; }
    else { P.by -= 0.02 * Math.sin(p * Math.PI); }
  } else if (st === 'stun') {
    dizzy(P, sp, t, 1, crowd, e); P.frame = FR.dizzy; P.led = 0.6 + 0.4 * Math.sin(t * 20);
  } else if (st === 'dying') {
    const k = p;
    P.bx += Math.sin(t * 90) * 0.03 * (1 + k); P.bz += Math.cos(t * 83) * 0.03 * (1 + k);
    P.s *= 1 - 0.5 * easeIn(k); P.flash = Math.max(P.flash, k > 0.8 ? 1 : 0.3 * Math.sin(t * 40) + 0.3);
    P.frame = FR.dead; P.glitch = 0.6; P.face2 = fract(t * 7);
  }
  if (e._frame !== undefined) { P.frame = e._frame; P.open = 1; P.bright = 1; P.glitch = 0; } // debug/harness override
  // hit reaction
  if (P.flash > 0) { P.sy *= 1 - 0.1 * P.flash; P.sx *= 1 + 0.05 * P.flash; P.sz *= 1 + 0.05 * P.flash; P.bz -= 0.03 * P.flash; P.bright = Math.max(P.bright, 1 + P.flash); }
  // airborne: stretch + legs dangle; landing: squash spring
  if (c.air) {
    P.sy *= 1.08; P.sx *= 0.96; P.sz *= 0.96;
    for (let j = 0; j < sp.legs; j++) { P.feet[j].y -= 0.02; P.feet[j].z -= 0.03; P.feet[j].pitch -= 0.15; }
    P.legExt = Math.max(P.legExt, 0.85);
  }
  const lt = t - c.landT;
  if (lt >= 0 && lt < 0.55) {
    const k = Math.exp(-lt * 7) * Math.cos(lt * 22) * c.landAmt;
    P.sy *= 1 - 0.26 * k; P.sx *= 1 + 0.13 * k; P.sz *= 1 + 0.13 * k; P.by -= 0.04 * Math.max(0, k);
    for (let j = 0; j < sp.legs; j++) P.feet[j].x *= 1 + 0.12 * Math.max(0, k);
  }
}
function j0(id) { return hash(id) * 10; }

function dizzy(P, sp, t, k, crowd, e) {
  P.roll += Math.sin(t * 9) * 0.2 * k; P.pitch += Math.cos(t * 9) * 0.12 * k; P.yaw += Math.sin(t * 4.5) * 0.15 * k;
  for (let j = 0; j < sp.legs; j++) P.feet[j].x *= 1 + 0.1 * Math.sin(t * 9 + j * 2) * k;
  if (k > 0.2) for (let i = 0; i < 3; i++) {
    const a = t * 5 + i * TAU / 3;
    bodyPt(crowd, P, sp, Math.cos(a) * 0.2 * (sp.W / 0.6), sp.topY + 0.12 + Math.sin(a * 2) * 0.02, Math.sin(a) * 0.2 * (sp.W / 0.6), _sprite);
    crowd.sprites.add(_sprite.x, _sprite.y, _sprite.z, 0.2 * P.s, 1.0, 0.85, 0.3, 1.2 * k, 1);
  }
}

// THE SIGNATURE MOMENT: dormant product -> LEDs flicker on -> screen boots -> eyes snap -> legs unfold -> hop.
function poseSpawn(e, c, t, dt, sp, P, p, crowd) {
  const S = crowd.sprites, G = sp.glow;
  const airborne = c.air;
  const from = e.spawnFrom;
  const moved = from ? Math.hypot(e.x - from.x, e.z - from.z) : 0;
  const hopping = airborne || moved > 0.08;
  // LEDs: sequential with flicker
  const lr = range(p, 0.08, 0.36);
  const flick = lr > 0 && lr < 1 ? (hash(Math.floor(t * 24) + e.id * 13) > 0.3 ? 1 : 0.25) : 1;
  P.led = lr * flick;
  // screen boot
  if (p < 0.28) { P.bright = 0; }
  else if (p < 0.35) { P.frame = F.POWER; P.bright = hash(Math.floor(t * 30) + e.id) > 0.35 ? 0.9 : 0.15; P.open = 1; }
  else if (p < 0.45) { P.frame = F.BOOT; P.bright = 0.55 + 0.45 * hash(Math.floor(t * 40) + e.id * 3); P.glitch = 0.25; P.face2 = fract(t * 9); }
  else {
    const o = range(p, 0.45, 0.52);
    P.frame = sp.frames.fury; if (p > 0.72) P.frame = sp.frames.base;
    P.open = Math.max(0.03, easeOutBack(o, 2.6));
    P.bright = 1 + 1.4 * (1 - range(p, 0.47, 0.64));
    // eye-snap pop: a flash on the face + body jolt
    const j = bump(p, 0.45, 0.56);
    P.by += 0.035 * j; P.sy *= 1 + 0.1 * j; P.sx *= 1 - 0.04 * j;
    if (j > 0.01) {
      bodyPt(crowd, P, sp, 0, sp.face.y, sp.face.z + 0.08, _sprite);
      S.add(_sprite.x, _sprite.y, _sprite.z, sp.face.w * 3.2 * P.s * (0.6 + 0.4 * j), G[0], G[1], G[2], 1.2 * j, 0);
      S.add(_sprite.x, _sprite.y, _sprite.z, sp.face.w * 2.6 * P.s, 1, 1, 1, 0.9 * j, 1);
    }
    // omnidirectional power-on ring above the head (reads even when it faces away)
    const rp = range(p, 0.45, 0.62);
    if (rp > 0 && rp < 1) {
      bodyPt(crowd, P, sp, 0, sp.topY + 0.08, 0, _sprite);
      S.add(_sprite.x, _sprite.y, _sprite.z, (0.4 + 1.2 * easeOut(rp)) * sp.W * 1.6 * P.s, G[0], G[1], G[2], 1.4 * (1 - rp), 2);
    }
  }
  // status LED sparkle as the first LED pops
  const sp1 = bump(p, 0.08, 0.2);
  if (sp1 > 0.01) { bodyPt(crowd, P, sp, sp.ledPos[0], sp.ledPos[1], sp.ledPos[2] + 0.03, _sprite); S.add(_sprite.x, _sprite.y, _sprite.z, 0.35 * P.s, G[0], G[1], G[2], 1.3 * sp1, 1); }
  P.ringGlow = P.led; // XB8 halo stays dark until powered
  // legs unfold
  const lg = range(p, 0.5, 0.68);
  P.legExt = easeOutBack(lg, 2.2);
  for (let j = 0; j < sp.legs; j++) P.feet[j].x *= lerp(0.55, 1, smooth(lg));
  // shake-off wiggle
  const w = bump(p, 0.6, 0.72);
  P.roll += Math.sin(t * 38) * 0.12 * w; P.yaw += Math.sin(t * 27) * 0.08 * w;
  // pre-hop crouch
  if (!hopping) {
    const cr = bump(p, 0.66, 0.8) * (p < 0.8 ? 1 : 0);
    const crr = p > 0.73 && p < 0.8 ? 1 : cr;
    P.sy *= 1 - 0.18 * crr; P.sx *= 1 + 0.08 * crr; P.sz *= 1 + 0.08 * crr; P.by -= 0.03 * crr;
    if (p < 0.08) { // dormant: dead still, dim
      P.led = 0;
    }
  } else {
    P.legExt = Math.max(P.legExt, 0.9);
    if (P.bright < 1) { P.bright = 1; P.frame = sp.frames.fury; P.open = 1; }
    P.frame = sp.frames.fury;
    P.pitch += 0.18;
    for (let j = 0; j < sp.legs; j++) { P.feet[j].z -= 0.04; P.feet[j].pitch -= 0.2; }
  }
  // gentle idle once alive, tiny motion before
  if (p > 0.5) { P.by += 0.006 * Math.sin(t * 6 + e.id); }
}

// =====================================================================================
// GIGA GATEWAY RIG
// =====================================================================================
class BossRig {
  constructor(parent, det, sprites, ground) {
    this.root = new THREE.Group(); this.root.name = 'gigaGateway'; this.root.matrixAutoUpdate = false;
    parent.add(this.root);
    const B = bossGeo(det), G = GEO(det);
    this.torso = mkRobotIM(B.torso, 1); this.face = mkFaceIM(G.face, 1);
    this.thigh = mkRobotIM(B.thigh, 4); this.shin = mkRobotIM(B.shin, 4); this.foot = mkRobotIM(B.foot, 4);
    this.ant = mkRobotIM(B.antenna, 5); this.door = mkRobotIM(B.door, 2); this.panel = mkRobotIM(B.panel, 6);
    this.ims = [this.torso, this.face, this.thigh, this.shin, this.foot, this.ant, this.door, this.panel];
    for (const im of this.ims) this.root.add(im);
    this.sprites = sprites; this.ground = ground; this.det = det; this.id = -1;
    this.feetW = [0, 1, 2, 3].map(() => new THREE.Vector3());
  }
  setDet(det) {
    if (det === this.det) return; this.det = det;
    const B = bossGeo(det);
    reGeo(this.torso, B.torso); reGeo(this.thigh, B.thigh); reGeo(this.shin, B.shin); reGeo(this.foot, B.foot);
    reGeo(this.ant, B.antenna); reGeo(this.door, B.door); reGeo(this.panel, B.panel);
  }
  setShadows(on) { for (const im of this.ims) if (im !== this.face) im.castShadow = on; }
  hide() { for (const im of this.ims) { im.count = 0; im.visible = false; } this.id = -1; }
  update(e, c, t, dt, fxOn) {
    commonCos(e, c, t, dt);
    c.id = e.id;
    this.id = e.id;
    const S = this.sprites;
    const dur = e.stateDur > 0 ? e.stateDur : 1;
    const p = clamp01((e.stateT || 0) / dur);
    const st = e.state, atk = e.attack || '';
    const phase = e.phase || 1;
    // ---------------- pose params
    let x = e.x, y = e.y || 0, z = e.z;
    let bodyY = BOSS.standY, bx = 0, bz = 0, pitch = 0, roll = 0, yaw = 0, sx = 1, sy = 1, sz = 1;
    let led = 1, flash = clamp01(e.flash || 0), heat = 0, crack = 0;
    let frame = F.BOSS, bright = 1, open = blinkOpen(c, t), glitch = 0, seed = hash(e.id);
    let door = 0, antUp = 1, antTilt = 0, antScale = 1, antGlow = 1, crownYaw = 0, feetSplay = 1, feetTuck = 0;
    const antStagger = this.antStagger || (this.antStagger = [1, 1, 1, 1, 1]); antStagger.fill(1);
    let gr = BOSS.glow[0], gg = BOSS.glow[1], gb = BOSS.glow[2];
    const panelPop = this.panelPop || (this.panelPop = [-1, -1, -1, -1, -1, -1]); panelPop.fill(-1);
    // phase escalation
    if (phase >= 2) { crack = 0.55 + 0.25 * Math.sin(t * 7) * Math.sin(t * 3.1); }
    if (phase >= 3) {
      crack = 1.5 + 0.3 * Math.sin(t * 9); heat = 0.05 + 0.04 * Math.sin(t * 6);
      const k = 0.75; gr = lerp(gr, BOSS.red[0], k); gg = lerp(gg, BOSS.red[1], k); gb = lerp(gb, BOSS.red[2], k);
      frame = F.BOSS_CRACK;
    }
    const baseFrame = frame;
    // ---------------- locomotion (diagonal gait)
    const spd = st === 'move' ? (e.spd || 0) : 0;
    const amt = clamp01(spd / 1.2);
    c.phase += dt * spd / 1.7;
    const ph = c.phase;
    const offs = [0, 0.5, 0.5, 0];
    const fl = this.footL || (this.footL = [0, 1, 2, 3].map(() => ({ x: 0, y: 0, z: 0 })));
    for (let j = 0; j < 4; j++) {
      const r = BOSS.feet[j]; fl[j].x = r[0]; fl[j].y = 0; fl[j].z = r[2];
      const u = fract(ph + offs[j]), sw = 0.42 * amt;
      if (u < 0.5) fl[j].z += sw * (1 - 4 * u);
      else { const w = (u - 0.5) / 0.5; fl[j].z += sw * (-1 + 2 * smooth(w)); fl[j].y += 0.38 * amt * Math.sin(w * Math.PI); }
    }
    const c4 = Math.cos(ph * TAU * 2);
    bodyY += (0.06 * (1 - Math.max(0, c4)) - 0.05 * Math.pow(Math.max(0, c4), 8)) * amt;
    roll += 0.04 * Math.sin(ph * TAU) * amt; pitch += 0.05 * amt;
    bodyY += (1 - amt) * 0.02 * Math.sin(t * 1.8);
    // ---------------- states
    if (st === 'spawn') {
      const stand = easeOutBack(range(p, 0.5, 0.78), 1.4);
      bodyY = lerp(0.42, BOSS.standY, stand);
      const lr = range(p, 0.08, 0.5);
      led = lr * (lr > 0 && lr < 1 && hash(Math.floor(t * 20)) < 0.25 ? 0.3 : 1);
      if (p < 0.34) { bright = 0; }
      else if (p < 0.4) { frame = F.POWER; bright = hash(Math.floor(t * 30)) > 0.3 ? 1 : 0.2; }
      else if (p < 0.5) { frame = F.BOOT; bright = 0.6 + 0.4 * hash(Math.floor(t * 40)); glitch = 0.3; seed = fract(t * 7); }
      else { frame = F.BOSS; open = Math.max(0.03, easeOutBack(range(p, 0.5, 0.58), 2.5)); bright = 1 + 1.2 * (1 - range(p, 0.52, 0.7)); }
      for (let i = 0; i < 5; i++) antStagger[i] = easeOutBack(range(p, 0.55 + i * 0.045, 0.72 + i * 0.045), 2);
      antUp = 1;
      const roar = range(p, 0.8, 1);
      if (roar > 0) {
        frame = F.BOSS_ROAR; const sh = Math.sin(roar * Math.PI);
        bx += Math.sin(t * 60) * 0.04 * sh; bz += Math.cos(t * 53) * 0.03 * sh; sy *= 1 + 0.05 * sh; pitch -= 0.12 * sh;
        antGlow = 1 + 1.6 * sh; bright = 1.2;
      }
      if (fxOn && lr > 0 && lr < 1) this.seamSparks(t, lr);
      feetSplay = lerp(0.8, 1, smooth(stand));
    } else if (st === 'windup') {
      const k = smooth(p);
      if (atk === 'rings') {
        antGlow = 1 + 1.8 * k; antScale = 1 + 0.1 * k; bodyY -= 0.14 * k; frame = F.BOSS_SQUINT; led = 1 + 0.25 * k;
        bx += Math.sin(t * 50) * 0.02 * k;
      } else if (atk === 'slam') {
        bodyY -= 0.55 * easeOut(p); sy *= 1 - 0.06 * k; frame = F.BOSS_SQUINT; feetSplay = 1 + 0.1 * k;
        bx += Math.sin(t * 60) * 0.03 * range(p, 0.5, 1); pitch += 0.1 * k;
      } else if (atk === 'summon') {
        door = easeOutBack(range(p, 0, 0.7), 1.3); frame = F.BOSS_SQUINT; led = 1 + 0.15 * k; pitch -= 0.06 * k;
      } else if (atk === 'spin') {
        antTilt = 1.2 * easeOutBack(range(p, 0, 0.8), 1.5); antGlow = 1 + 1.6 * k; frame = F.BOSS_SQUINT;
        c.spinA += dt * 2.5 * k; crownYaw = c.spinA;
      } else { bodyY -= 0.15 * k; frame = F.BOSS_SQUINT; }
    } else if (st === 'attack') {
      if (atk === 'rings') {
        const a = range(p, 0, 0.3);
        antGlow = 2.6 * (1 - a) + 1.1; bodyY += 0.14 * Math.sin(a * Math.PI) - 0.14 * (1 - a); frame = F.BOSS_ROAR; sy *= 1 + 0.06 * Math.sin(a * Math.PI);
        antScale = 1 + 0.1 * (1 - a);
        if (a < 1) {
          const tp = this.crownCenter(x, y, z, c.face, bodyY);
          S.add(tp.x, tp.y, tp.z, 1.5 + 5 * a, gr, gg, gb, 1.6 * (1 - a), 2);
          S.add(tp.x, tp.y, tp.z, 1.2 + 2 * a, gr, gg, gb, 0.8 * (1 - a), 0);
        }
      } else if (atk === 'slam') {
        if (c.air) { bodyY = BOSS.standY + 0.25; feetTuck = 1; sy *= 1.06; frame = F.BOSS_ROAR; }
        else { frame = p < 0.6 ? F.BOSS_ROAR : baseFrame; bodyY -= 0.2 * (1 - range(p, 0.5, 1)); }
      } else if (atk === 'summon') {
        door = 1 + 0.15 * Math.sin(range(p, 0, 0.3) * Math.PI); frame = F.BOSS_ROAR; pitch -= 0.1 * Math.sin(range(p, 0, 0.3) * Math.PI);
        if (fxOn) for (let i = 0; i < 6; i++) {
          const u = clamp01(p * 1.6 - i * 0.1); if (u <= 0 || u >= 1) continue;
          const a = (i / 6 - 0.5) * 1.6;
          const lx = Math.sin(a) * u * 2.2, lz = BOSS.D / 2 + 0.2 + u * 2.4, ly = BOSS.doors.y + Math.sin(u * Math.PI) * 1.4;
          const w = this.localToWorld(x, y, z, c.face, bodyY, lx, ly, lz);
          S.add(w.x, w.y, w.z, 0.35, 0.43, 1.0, 0.69, 1.3 * (1 - u * 0.7), 0);
        }
      } else if (atk === 'spin') {
        antTilt = 1.2; antGlow = 2.4; frame = F.BOSS_ROAR;
        if (typeof e.beamA === 'number') crownYaw = e.beamA - c.face; else { c.spinA += dt * 2.4; crownYaw = c.spinA; }
        bodyY += 0.03 * Math.sin(t * 20);
      } else { frame = F.BOSS_ROAR; }
    } else if (st === 'recover') {
      const k = 1 - smooth(p);
      if (atk === 'summon') door = k;
      if (atk === 'spin') { antTilt = 1.2 * k; c.spinA = wrapA(c.spinA) * k; crownYaw = c.spinA; }
      if (atk === 'slam') bodyY -= 0.2 * k;
      if (atk === 'rings') antGlow = 1 + k;
    } else if (st === 'stun') {
      frame = F.DIZZY; roll += Math.sin(t * 6) * 0.08; pitch += Math.cos(t * 6) * 0.05; bodyY -= 0.15; antTilt = 0.3 + 0.1 * Math.sin(t * 8);
      if (fxOn) for (let i = 0; i < 4; i++) { const a = t * 3 + i * TAU / 4; const w = this.localToWorld(x, y, z, c.face, bodyY, Math.cos(a) * 0.9, BOSS.H + 1.4, Math.sin(a) * 0.9); S.add(w.x, w.y, w.z, 0.45, 1, 0.85, 0.3, 1.2, 1); }
    } else if (st === 'dying') {
      const k = p;
      const sh = 0.05 + 0.12 * k;
      bx += Math.sin(t * 71) * sh; bz += Math.cos(t * 67) * sh; roll += Math.sin(t * 53) * 0.05 * (0.5 + k); yaw += Math.sin(t * 43) * 0.04;
      const fr = Math.floor(t * 14) % 4;
      frame = fr === 0 ? F.GLITCH : fr === 1 ? F.BOSS_CRACK : fr === 2 ? F.DEAD : F.GLITCH;
      glitch = 0.5 + 0.5 * k; seed = fract(t * 5.3); bright = 0.6 + 0.8 * hash(Math.floor(t * 25));
      crack = 2; heat = 0.06 + 0.3 * k * k; led = hash(Math.floor(t * 18)) > 0.4 ? 1.5 : 0.2;
      antTilt = 0.5 * k + 0.1 * Math.sin(t * 13); antGlow = led;
      const buckle = easeIn(range(p, 0.6, 1));
      bodyY = lerp(bodyY, 0.45, buckle); pitch += 0.25 * buckle; feetSplay = 1 + 0.25 * buckle;
      for (let i = 0; i < 6; i++) panelPop[i] = (p - (0.06 + i * 0.1)) * dur;
      door = 0.6 + 0.4 * Math.sin(t * 17);
      if (p > 0.9) flash = Math.max(flash, range(p, 0.9, 1));
      if (fxOn) for (let i = 0; i < 4; i++) {
        const hs = Math.floor(t * 16) * 4 + i;
        const w = this.localToWorld(x, y, z, c.face, bodyY, (hash(hs) - 0.5) * 2.4, hash(hs * 1.7) * 2.2, (hash(hs * 2.3) - 0.5) * 1.9);
        S.add(w.x, w.y, w.z, 0.4 + hash(hs * 3.1) * 0.6, 1, 0.75, 0.3, 1.5, 1);
      }
    }
    if (phase >= 2 && st !== 'dying' && fxOn) { // intermittent crack sparks
      const hs = Math.floor(t * 6);
      if (hash(hs + e.id) > (phase >= 3 ? 0.35 : 0.65)) {
        const w = this.localToWorld(x, y, z, c.face, bodyY, (hash(hs * 1.3) - 0.5) * 2.2, 0.3 + hash(hs * 2.1) * 1.5, BOSS.D / 2 + 0.05);
        S.add(w.x, w.y, w.z, 0.5, 1, 0.6, 0.2, 1.4 * (1 - fract(t * 6)), 1);
      }
    }
    if (flash > 0) { sy *= 1 - 0.04 * flash; bright = Math.max(bright, 1 + flash); }
    // landing squash
    const lt = t - c.landT;
    if (lt >= 0 && lt < 0.8) {
      const k = Math.exp(-lt * 5) * Math.cos(lt * 16);
      bodyY -= 0.45 * Math.max(0, k) * c.landAmt; sy *= 1 - 0.14 * k; sx *= 1 + 0.07 * k; sz *= 1 + 0.07 * k; feetSplay += 0.15 * Math.max(0, k);
    }
    if (c.air) feetTuck = Math.max(feetTuck, 1);
    // ---------------- write
    const dm = BOSS.seamDim * (phase >= 3 ? 1.3 : 1);
    _e.set(0, c.face, 0); _q.setFromEuler(_e);
    _mRoot.compose(_v.set(x, y, z), _q, _sc.set(1, 1, 1));
    _e.set(pitch, yaw, roll); _q.setFromEuler(_e);
    _mA.compose(_v.set(bx, bodyY, bz), _q, _sc.set(sx, sy, sz));
    _mBody.multiplyMatrices(_mRoot, _mA);
    this.bodyM = this.bodyM || new THREE.Matrix4(); this.bodyM.copy(_mBody);
    this.rootM = this.rootM || new THREE.Matrix4(); this.rootM.copy(_mRoot);
    wR(this.torso, 0, _mBody, flash, led, 0, heat, gr * dm, gg * dm, gb * dm, crack);
    _mA.multiplyMatrices(_mBody, BOSS.faceM);
    wF(this.face, 0, _mA, frame, c.dartX * 0.6, c.dartY * 0.6, bright, flash, glitch, seed, open, gr, gg, gb);
    // antennas
    for (let i = 0; i < 5; i++) {
      const an = BOSS.ants[i], ang = an[0], len = an[1], tilt = an[2];
      const up = antStagger[i] * antUp;
      const a = ang + crownYaw;
      const tl = lerp(-1.3, tilt, up) + antTilt * (1.57 - tilt) / 1.2;
      _e.set(tl, a, 0); _q.setFromEuler(_e);
      const sc = len * antScale * (1 + 0.3 * clamp01(antTilt / 1.2)) * Math.max(0.05, up);
      _mA.compose(_v.set(Math.sin(a) * BOSS.antR, BOSS.antY, Math.cos(a) * BOSS.antR), _q, _sc.set(sc, sc, sc));
      _mB.multiplyMatrices(_mBody, _mA);
      const g = antGlow * (st === 'windup' && atk === 'rings' ? (0.8 + 0.4 * Math.sin(t * 25 + i)) : 1);
      wR(this.ant, i, _mB, flash, Math.min(led, 1) * g, 0, heat, gr, gg, gb, 0);
      if (antGlow > 1.2 || (st === 'spawn' && up > 0.9)) {
        _v.set(0, 0.92, 0).applyMatrix4(_mB);
        S.add(_v.x, _v.y, _v.z, 0.4 + 0.15 * antGlow, gr, gg, gb, 0.14 * antGlow, 0);
        if (antTilt > 0.9) S.add(_v.x, _v.y, _v.z, 0.9, 1, 1, 1, 0.7, 1);
      }
    }
    // doors
    const dd = BOSS.doors;
    for (let i = 0; i < 2; i++) {
      const sd = i === 0 ? -1 : 1;
      _e.set(0, -sd * door * 1.9, 0); _q.setFromEuler(_e);
      _mA.compose(_v.set(sd * dd.px, dd.y, dd.z), _q, _sc.set(1, 1, 1));
      _mB.makeTranslation(-sd * dd.w / 2, 0, 0);
      _mA.multiply(_mB);
      _mB.multiplyMatrices(_mBody, _mA);
      wR(this.door, i, _mB, flash, led, 0, heat, gr * dm, gg * dm, gb * dm, 0);
    }
    if (door > 0.05) {
      const w = this.localToWorld(x, y, z, c.face, bodyY, 0, dd.y, dd.z + 0.2);
      S.add(w.x, w.y, w.z, 1.2 + 0.6 * door, gr, gg, gb, 0.5 * Math.min(1, door), 0);
    }
    // panels
    for (let i = 0; i < 6; i++) {
      const pn = BOSS.panels[i], px = pn[0], py = pn[1], pz = pn[2], pyaw = pn[3];
      const tau = panelPop[i];
      if (tau > 0) {
        const nx = Math.abs(px) > 1 ? Math.sign(px) : 0, nz = Math.abs(px) > 1 ? 0 : -1;
        const vx = nx * 2.2 + (hash(i) - 0.5), vz = nz * 2.2 + (hash(i + 7) - 0.5), vy = 3.2 + hash(i + 3) * 1.5;
        let ly = py + vy * tau - 4.9 * tau * tau;
        const floorLocal = -bodyY + 0.05;
        const landed = ly < floorLocal;
        if (landed) ly = floorLocal;
        _e.set(tau * 6 * (landed ? 0 : 1) + (landed ? Math.PI / 2 : 0), pyaw + tau * 3, tau * 4 * (landed ? 0 : 1)); _q.setFromEuler(_e);
        const fade = 1 - clamp01((tau - 1.2) * 2);
        _mA.compose(_v.set(px + vx * Math.min(tau, 1.1), ly, pz + vz * Math.min(tau, 1.1)), _q, _sc.set(fade, fade, fade));
        _mB.multiplyMatrices(_mRoot, _mA.premultiply(_mB.makeTranslation(bx, bodyY, bz)));
      } else {
        _e.set(0, pyaw, 0); _q.setFromEuler(_e);
        _mA.compose(_v.set(px, py, pz), _q, _sc.set(1, 1, 1));
        _mB.multiplyMatrices(_mBody, _mA);
      }
      wR(this.panel, i, _mB, flash, led, 0, heat, gr * dm, gg * dm, gb * dm, 0);
    }
    // legs (2-bone IK)
    const rx = Math.cos(c.face), rz = -Math.sin(c.face);
    for (let j = 0; j < 4; j++) {
      const r = BOSS.feet[j];
      let fx = fl[j].x * feetSplay, fy = fl[j].y, fz = fl[j].z * (0.9 + 0.1 * feetSplay);
      if (feetTuck > 0) { fx = lerp(fx, r[0] * 0.72, feetTuck); fz = lerp(fz, r[2] * 0.72, feetTuck); fy = lerp(fy, 0.25, feetTuck); }
      // foot
      const fyaw = Math.atan2(r[0], r[2]);
      _e.set(0, fyaw, 0); _q.setFromEuler(_e);
      _mA.compose(_v.set(fx, fy, fz), _q, _sc.set(1, 1, 1));
      _mB.multiplyMatrices(_mRoot, _mA);
      wR(this.foot, j, _mB, flash, led, 0, heat, gr * dm, gg * dm, gb * dm, 0);
      // IK
      const hip = _v3.set(BOSS.hips[j][0], BOSS.hips[j][1], BOSS.hips[j][2]).applyMatrix4(_mBody);
      const ank = _v2.set(fx, fy + BOSS.ankleH, fz).applyMatrix4(_mRoot);
      const knee = this.ik(hip, ank, r[0], r[2], c.face);
      segMatrix(_mA, hip.x, hip.y, hip.z, knee.x, knee.y, knee.z, 1, rx, rz, BOSS.L1);
      wR(this.thigh, j, _mA, flash, led, 0, heat, gr * dm, gg * dm, gb * dm, 0);
      segMatrix(_mA, knee.x, knee.y, knee.z, ank.x, ank.y, ank.z, 1, rx, rz, BOSS.L2);
      wR(this.shin, j, _mA, flash, led, 0, heat, gr * dm, gg * dm, gb * dm, 0);
      this.feetW[j].set(ank.x, ank.y, ank.z);
      this.ground.add(ank.x, groundY(ank.x, ank.z) + 0.012, ank.z, 1.3, 0, 0, 0, 0.45 * clamp01(1 - (ank.y - 0.26) * 0.8), 0);
    }
    const hgt = Math.max(0, y);
    this.ground.add(x, 0.012, z, 5.2 * (1 + hgt * 0.15), 0, 0, 0, 0.6 * clamp01(1 - hgt * 0.3), 0);
    flushIM(this.torso, 1); flushIM(this.face, 1);
    flushIM(this.thigh, 4); flushIM(this.shin, 4); flushIM(this.foot, 4);
    flushIM(this.ant, 5); flushIM(this.door, 2); flushIM(this.panel, 6);
  }
  ik(hip, ank, ox, oz, face) {
    const L1 = BOSS.L1, L2 = BOSS.L2;
    let dx = ank.x - hip.x, dy = ank.y - hip.y, dz = ank.z - hip.z;
    let d = Math.hypot(dx, dy, dz);
    const dmax = L1 + L2 - 0.01, dmin = Math.abs(L1 - L2) + 0.01;
    d = clamp(d, dmin, dmax);
    const n = Math.hypot(dx, dy, dz) || 1; dx /= n; dy /= n; dz /= n;
    const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
    // bend: outward (world) + up, orthogonalised against the hip->ankle direction
    const cs = Math.cos(face), sn = Math.sin(face);
    const ol = Math.hypot(ox, oz) || 1;
    let bx = (ox * cs + oz * sn) / ol, by = 1.1, bz = (-ox * sn + oz * cs) / ol;
    const dot = bx * dx + by * dy + bz * dz; bx -= dx * dot; by -= dy * dot; bz -= dz * dot;
    const bl = Math.hypot(bx, by, bz) || 1; bx /= bl; by /= bl; bz /= bl;
    this._knee = this._knee || new THREE.Vector3();
    return this._knee.set(hip.x + dx * a + bx * h, hip.y + dy * a + by * h, hip.z + dz * a + bz * h);
  }
  localToWorld(x, y, z, face, bodyY, lx, ly, lz) {
    this._w = this._w || new THREE.Vector3();
    const cs = Math.cos(face), sn = Math.sin(face);
    return this._w.set(x + lx * cs + lz * sn, y + bodyY + ly, z - lx * sn + lz * cs);
  }
  crownCenter(x, y, z, face, bodyY) { return this.localToWorld(x, y, z, face, bodyY, 0, BOSS.H + 0.9, -0.2); }
  seamSparks(t, lr) {
    const S = this.sprites;
    for (let i = 0; i < 3; i++) {
      const hs = Math.floor(t * 12) * 3 + i;
      const w = _v.set((hash(hs) - 0.5) * 2.2, 0.15 + lr * 1.8 * hash(hs * 1.9), 0.87).applyMatrix4(this.bodyM || _mBody);
      S.add(w.x, w.y, w.z, 0.5, BOSS.glow[0], BOSS.glow[1], BOSS.glow[2], 1.2, 1);
    }
  }
}

// =====================================================================================
// PUBLIC API
// =====================================================================================
export function createModems(scene, opts = {}) {
  const capScale = (opts.capacity || 80) / 80;
  const caps = {};
  for (const k of CROWD_KINDS) caps[k] = Math.max(4, Math.round(BASE_CAP[k] * capScale));
  let q = opts.quality ?? 2;
  let det = q <= 0 ? 0 : 1;
  const crowd = new Crowd(scene, caps, det, { sprites: Math.round(700 * capScale) + 120, ground: Math.round(200 * capScale) + 20 });
  crowd.fxLevel = q >= 1 ? 2 : 0;
  const bosses = [new BossRig(crowd.root, det, crowd.sprites, crowd.ground)];
  bosses[0].hide();
  const cos = new Map();
  const pool = [];
  let frame = 0;
  // warm-up: keep meshes "visible" (0 instances => no draw) for the first frames so programs compile early
  let warm = 2, unwarm = false;
  const purge = (c, id) => { if (c.seen !== frame) { cos.delete(id); if (c.rig) { c.rig.hide(); c.rig = null; } pool.push(c); } };

  function setQuality(nq) {
    q = clamp(nq | 0, 0, 3);
    const nd = q <= 0 ? 0 : 1; // det 2 (hero detail) is reserved for preview()
    det = nd;
    crowd.setDet(nd); for (const b of bosses) b.setDet(nd);
    crowd.setShadows(q >= 3); for (const b of bosses) b.setShadows(q >= 2);
    crowd.fxLevel = q >= 1 ? 2 : 0;
    crowd.allLow = q <= 0;
  }
  setQuality(q);

  function sync(enemies, t, dt) {
    dt = clamp(dt || 0, 0, 0.05);
    frame++;
    crowd.begin(t);
    for (let i = 0; i < bosses.length; i++) bosses[i].used = false;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      const kind = e.kind;
      if (kind !== 'boss_gateway' && !SPEC[kind]) continue;
      let c = cos.get(e.id);
      if (!c) { c = pool.pop() || newCos(); resetCos(c); cos.set(e.id, c); }
      c.seen = frame;
      if (kind === 'boss_gateway') {
        let rig = c.rig;
        if (!rig) {
          rig = bosses.find((b) => b.id < 0 && !b.used);
          if (!rig) { rig = new BossRig(crowd.root, crowd.det, crowd.sprites, crowd.ground); rig.setShadows(q >= 2); rig.setDet(det); bosses.push(rig); }
          c.rig = rig;
        }
        rig.used = true;
        rig.update(e, c, t, dt, crowd.fxLevel);
      } else {
        crowd.add(e, c, t, dt);
      }
    }
    for (let i = 0; i < bosses.length; i++) if (!bosses[i].used && bosses[i].id >= 0) bosses[i].hide();
    crowd.end();
    if (warm > 0) {
      warm--;
      for (const im of crowd.allIMs()) im.visible = true;
      crowd.sprites.mesh.visible = true; crowd.ground.mesh.visible = true;
      if (bosses[0].id < 0) for (const im of bosses[0].ims) im.visible = true;
      if (warm === 0) unwarm = true;
    } else if (unwarm) { unwarm = false; if (bosses[0].id < 0) bosses[0].hide(); }
    cos.forEach(purge);
  }

  // ---------------- previews (standalone, non-shared objects for UI / title cards)
  function preview(kind) {
    const g = new THREE.Group(); g.name = 'modemPreview_' + kind;
    const fake = { id: 900000 + Math.floor(Math.random() * 99999), kind, x: 0, y: 0, z: 0, face: 0, r: KIND_DIMS[kind]?.r || 0.4, spd: 0,
      state: 'move', stateT: 0, stateDur: 1, attack: '', flash: 0, elite: false, hp: 1, maxHp: 1, boss: kind === 'boss_gateway', phase: 1, spawnFrom: null };
    const c = newCos();
    if (kind === 'boss_gateway') {
      const sprites = new SpritePool(80), ground = new GroundPool(8);
      g.add(sprites.mesh); g.add(ground.mesh);
      const rig = new BossRig(g, 2, sprites, ground);
      g.userData.modemPreview = { kind, fake, c, rig, sprites, ground, lastT: null };
    } else if (SPEC[kind]) {
      const pc = new Crowd(g, { [kind]: 1 }, 2, { sprites: 24, ground: 4 });
      pc.preview = true;
      g.userData.modemPreview = { kind, fake, c, crowd: pc, lastT: null };
    } else {
      return g;
    }
    previewUpdate(g, 0);
    return g;
  }
  function previewUpdate(obj, t) {
    const u = obj && obj.userData && obj.userData.modemPreview;
    if (!u) return;
    const dt = u.lastT === null ? 1 / 60 : clamp(t - u.lastT, 0, 0.05);
    u.lastT = t;
    const e = u.fake;
    e.stateT = t;
    if (u.rig) {
      u.sprites.begin(); u.ground.begin();
      u.rig.update(e, u.c, t, dt, 2);
      u.sprites.end(); u.ground.end();
    } else {
      // idle with a little personality hop every few seconds
      const cyc = t % 4.2;
      e.spd = cyc > 3.2 && cyc < 3.2 + SPEC[e.kind].stride / 1.2 ? 1.2 : 0;
      u.crowd.begin(t); u.crowd.add(e, u.c, t, dt); u.crowd.end();
    }
  }

  return {
    kinds: MY_KINDS.slice(),
    sync, setQuality, preview, previewUpdate,
    root: crowd.root,
    _debug: { crowd, bosses, cos, SPEC, BOSS, F },
    _reset() { cos.forEach((c) => { if (c.rig) { c.rig.hide(); c.rig = null; } }); cos.clear(); },
  };
}
