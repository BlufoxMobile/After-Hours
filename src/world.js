// =====================================================================================
// AFTER HOURS 3D — world.js (WORLD agent)
// The Blufox / C³ store at night: floor with fake planar neon reflections, walls, fixtures,
// phone docks, kiosk, C³ neon, signage, lighting rig, IBL, hour moods.
// Everything is procedural (canvas textures ≤ 1024, merged geometry, a handful of materials).
// =====================================================================================
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { ARENA, ROOM, FIXTURES, SPAWNS, KIND_DIMS } from './layout.js';

// ---------------------------------------------------------------------------- utilities
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
function mulberry(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
function mkCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d')]; }

const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _eu = new THREE.Euler(), _sv = new THREE.Vector3(), _pv = new THREE.Vector3();
function xf(geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _eu.set(rx, ry, rz); _q.setFromEuler(_eu); _sv.set(sx, sy, sz); _pv.set(x, y, z);
  _m4.compose(_pv, _q, _sv); geo.applyMatrix4(_m4); return geo;
}
const BOX = (w, h, d) => new THREE.BoxGeometry(w, h, d);

// channels (mood-controlled groups of emissive stuff)
const CH = { neon: 0, strip: 1, sign: 2, screen: 3, dock: 4, pool: 5, out: 6, emerg: 7, mesh: 8, sun: 9, edge: 10, under: 11, puck: 12, sweep: 13, phone: 14, spare: 15 };
const NCH = 16;
const MODE = { stat: 0, scrollU: 1, scrollV: 2, sweep: 3, pulse: 4, blink: 6, mirrorOnly: 7, noMirror: 8 };

// ---------------------------------------------------------------------------- geometry batches
const _c1 = new THREE.Color(), _c2 = new THREE.Color();
class Batch {
  constructor(kind) { this.kind = kind; this.parts = []; } // kind: 'lit' | 'emit' | 'ao'
  add(geo, color, o = {}) {
    if (geo.index === null) { const n = geo.attributes.position.count; const idx = new Uint32Array(n); for (let i = 0; i < n; i++) idx[i] = i; geo.setIndex(new THREE.BufferAttribute(idx, 1)); }
    const n = geo.attributes.position.count, pos = geo.attributes.position;
    const itemSize = this.kind === 'ao' ? 4 : 3;
    const col = new Float32Array(n * itemSize);
    _c1.set(color);
    for (let i = 0; i < n; i++) {
      const c = o.grad ? o.grad(pos.getX(i), pos.getY(i), pos.getZ(i), _c2) : _c1;
      col[i * itemSize] = c.r; col[i * itemSize + 1] = c.g; col[i * itemSize + 2] = c.b;
      if (itemSize === 4) col[i * 4 + 3] = o.alpha != null ? o.alpha : 1;
    }
    for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(k)) geo.deleteAttribute(k);
    geo.setAttribute('color', new THREE.BufferAttribute(col, itemSize));
    if (this.kind === 'lit') { geo.deleteAttribute('uv'); if (!geo.attributes.normal) geo.computeVertexNormals(); }
    else {
      geo.deleteAttribute('normal');
      if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
      const uv = geo.attributes.uv;
      if (this.kind === 'ao') { // bake atlas cell directly into uv
        const c = o.cell || GCELL.srect;
        for (let i = 0; i < n; i++) uv.setXY(i, c[0] + uv.getX(i) * c[2], c[1] + uv.getY(i) * c[3]);
      } else {
        if (o.swapUV) for (let i = 0; i < n; i++) uv.setXY(i, uv.getY(i), uv.getX(i));
        if (o.uvScale) for (let i = 0; i < n; i++) uv.setXY(i, uv.getX(i) * o.uvScale[0], uv.getY(i) * o.uvScale[1]);
        const cell = o.cell || ACELL.white;
        const anim = [o.ch || 0, o.mode || 0, o.speed || 0, o.seed != null ? o.seed : Math.random()];
        const ac = new Float32Array(n * 4), aa = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) { ac.set(cell, i * 4); aa.set(anim, i * 4); }
        geo.setAttribute('aCell', new THREE.BufferAttribute(ac, 4));
        geo.setAttribute('aAnim', new THREE.BufferAttribute(aa, 4));
      }
    }
    this.parts.push(geo);
    return geo;
  }
  geometry() { const g = mergeGeometries(this.parts, false); g.computeBoundingSphere(); g.computeBoundingBox(); return g; }
}

// ---------------------------------------------------------------------------- atlas cells
// [u0, v0, du, dv] in texture space (v up). Canvas px → cell with inset padding.
const AW = 1024;
const acell = (x, y, w, h, pad = 3) => [(x + pad) / AW, 1 - (y + h - pad) / AW, (w - 2 * pad) / AW, (h - 2 * pad) / AW];
const ACELL = {
  poster: [acell(0, 0, 256, 448), acell(256, 0, 256, 448), acell(512, 0, 256, 448), acell(768, 0, 256, 448)],
  blufox: acell(0, 448, 384, 64), staff: acell(384, 448, 192, 64), exit: acell(576, 448, 128, 64),
  price: acell(704, 448, 64, 64), white: acell(776, 456, 48, 48, 8), c3badge: acell(832, 448, 192, 64), soft: acell(960, 944, 64, 80, 1),
  kA: acell(0, 512, 512, 216), kB: acell(512, 512, 512, 216),
  kC: acell(0, 728, 512, 216), wall: [acell(512, 728, 96, 216), acell(608, 728, 96, 216), acell(704, 728, 96, 216), acell(800, 728, 96, 216)],
  dock: acell(896, 728, 128, 216), cat: acell(0, 944, 944, 80),
};
const GW = 512, GH = 256;
const gcell = (x, y, w, h, pad = 2) => [(x + pad) / GW, 1 - (y + h - pad) / GH, (w - 2 * pad) / GW, (h - 2 * pad) / GH];
const GCELL = { blob: gcell(0, 0, 128, 128), ring: gcell(128, 0, 128, 128), srect: gcell(0, 128, 128, 128), beam: gcell(128, 128, 128, 64), line: gcell(128, 192, 128, 32), spot: gcell(128, 224, 32, 32), pool: gcell(256, 0, 128, 128), soft: gcell(384, 0, 128, 128) };

// ---------------------------------------------------------------------------- textures
function paintFloor(rng) {
  const S = 512, T = 256;
  const [c, g] = mkCanvas(S, S), [cr, gr] = mkCanvas(S, S);
  const wrap = (x, y, r, fn) => { for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) if (x + ox > -r && x + ox < S + r && y + oy > -r && y + oy < S + r) fn(x + ox, y + oy); };
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
    const v = (rng() - 0.5) * 5;
    g.fillStyle = `rgb(${25 + v | 0},${33 + v | 0},${64 + v * 1.4 | 0})`; g.fillRect(i * T, j * T, T, T);
    const rv = 44 + (rng() - 0.5) * 12;
    gr.fillStyle = `rgb(${rv | 0},${rv | 0},${rv | 0})`; gr.fillRect(i * T, j * T, T, T);
  }
  const blob = (ctx, x, y, r, col, a) => wrap(x, y, r, (px, py) => {
    const gg = ctx.createRadialGradient(px, py, 0, px, py, r);
    gg.addColorStop(0, `rgba(${col},${a})`); gg.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = gg; ctx.fillRect(px - r, py - r, r * 2, r * 2);
  });
  for (let k = 0; k < 220; k++) {
    const x = rng() * S, y = rng() * S, r = 10 + rng() * 60;
    blob(g, x, y, r, rng() < 0.5 ? '120,140,220' : '0,0,10', 0.012 + rng() * 0.016);
  }
  // faint marble veins
  g.lineCap = 'round';
  for (let k = 0; k < 14; k++) {
    let x = rng() * S, y = rng() * S; const pts = [[x, y]];
    let a = rng() * TAU;
    for (let s = 0; s < 9; s++) { a += (rng() - 0.5) * 0.9; x += Math.cos(a) * 22; y += Math.sin(a) * 22; pts.push([x, y]); }
    for (const [ox, oy] of [[0, 0], [-S, 0], [S, 0], [0, -S], [0, S]]) {
      g.strokeStyle = `rgba(150,165,235,${0.04 + rng() * 0.05})`; g.lineWidth = 0.8 + rng() * 1.4;
      g.beginPath(); pts.forEach(([px, py], i) => (i ? g.lineTo(px + ox, py + oy) : g.moveTo(px + ox, py + oy))); g.stroke();
    }
  }
  // roughness mottling + wear (rougher = duller)
  for (let k = 0; k < 160; k++) {
    const x = rng() * S, y = rng() * S, r = 14 + rng() * 70;
    blob(gr, x, y, r, rng() < 0.6 ? '110,110,110' : '20,20,20', 0.05 + rng() * 0.08);
  }
  for (let k = 0; k < 70; k++) { // scuffs
    const x = rng() * S, y = rng() * S, r = 8 + rng() * 26, a0 = rng() * TAU;
    wrap(x, y, r, (px, py) => {
      gr.strokeStyle = `rgba(180,180,180,${0.12 + rng() * 0.14})`; gr.lineWidth = 1 + rng() * 1.5;
      gr.beginPath(); gr.arc(px, py, r, a0, a0 + 0.6 + rng()); gr.stroke();
      g.strokeStyle = 'rgba(140,150,200,0.035)'; g.lineWidth = 1.5; g.beginPath(); g.arc(px, py, r, a0, a0 + 0.6); g.stroke();
    });
  }
  // grout seams (tile = 256 px = 1.2 m); + soft bevel highlight
  const seam = (ctx, col, w) => { ctx.fillStyle = col; for (const p of [0, T, S]) { ctx.fillRect(p - w / 2, 0, w, S); ctx.fillRect(0, p - w / 2, S, w); } };
  seam(g, 'rgba(90,110,190,0.10)', 9);
  seam(g, '#04060e', 4);
  seam(gr, 'rgb(235,235,235)', 5);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const rough = new THREE.CanvasTexture(cr); rough.colorSpace = THREE.NoColorSpace;
  for (const t of [tex, rough]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; }
  return { tex, rough };
}

function glowText(g, text, x, y, size, fill, glow, weight = 800, blur = 0.35, spacing = 0, maxW = 4096) {
  g.save();
  g.font = `${weight} ${size}px ${FONT}`;
  if ('letterSpacing' in g) g.letterSpacing = `${spacing}px`;
  g.fillStyle = fill; g.shadowColor = glow; g.shadowBlur = size * blur;
  g.fillText(text, x, y, maxW); g.shadowBlur = size * blur * 0.4; g.fillText(text, x, y, maxW);
  g.shadowBlur = 0; g.fillText(text, x, y, maxW);
  g.restore();
}

function paintAtlas(rng) {
  const [c, g] = mkCanvas(AW, AW);
  g.fillStyle = '#000'; g.fillRect(0, 0, AW, AW);
  g.textBaseline = 'middle';
  // ---- posters: abstract light-streak art
  const PAL = [
    ['#0a0b2e', '#2a0f55', '#3ee8ff', '#b44dff', '#ff3ec8', 'Signal never\nsleeps.'],
    ['#07102c', '#10245e', '#ff9a3c', '#ff3ec8', '#7b3fe4', 'Always on.\nAlways you.'],
    ['#150a2e', '#3a0d4d', '#3ee8ff', '#ffb547', '#ff3ec8', 'Connect\neverything.'],
    ['#06132a', '#0b3a5a', '#6dffb0', '#3ee8ff', '#7b3fe4', 'Built for the\nnight shift.'],
  ];
  PAL.forEach((p, i) => {
    const x = i * 256, y = 0, w = 256, h = 448;
    g.save(); g.beginPath(); g.rect(x + 3, y + 3, w - 6, h - 6); g.clip();
    const bg = g.createLinearGradient(x, y, x + w * 0.4, y + h); bg.addColorStop(0, p[0]); bg.addColorStop(1, p[1]);
    g.fillStyle = bg; g.fillRect(x, y, w, h);
    g.globalCompositeOperation = 'lighter';
    const cx = x + w * (0.3 + rng() * 0.4), cy = y + h * (0.55 + rng() * 0.2);
    const rg = g.createRadialGradient(cx, cy, 0, cx, cy, 170); rg.addColorStop(0, p[3] + '55'); rg.addColorStop(1, p[3] + '00');
    g.fillStyle = rg; g.fillRect(x, y, w, h);
    for (let k = 0; k < 9; k++) {
      const col = p[2 + (k % 3)];
      g.strokeStyle = col; g.lineWidth = 1 + rng() * 3.5; g.shadowColor = col; g.shadowBlur = 14 + rng() * 10; g.globalAlpha = 0.55 + rng() * 0.45;
      g.beginPath();
      const y0 = y + h * (0.45 + rng() * 0.5), y1 = y + h * (0.25 + rng() * 0.5);
      g.moveTo(x - 20, y0);
      g.bezierCurveTo(x + w * 0.3, y0 - 120 * rng(), x + w * 0.6, y1 + 160 * (rng() - 0.3), x + w + 20, y1);
      g.stroke();
    }
    g.globalAlpha = 1; g.shadowBlur = 0; g.globalCompositeOperation = 'source-over';
    p[5].split('\n').forEach((ln, k) => glowText(g, ln, x + 22, y + 52 + k * 34, 28, '#f4f7ff', 'rgba(160,200,255,0.8)', 800, 0.25));
    glowText(g, 'C³', x + w - 70, y + h - 38, 30, '#ffffff', p[2], 900, 0.5);
    g.restore();
  });
  // ---- small signs
  { // BLUFOX MOBILE
    const x = 0, y = 448;
    g.save(); g.translate(x + 30, y + 32); g.rotate(Math.PI / 4);
    g.fillStyle = '#3ee8ff'; g.shadowColor = '#3ee8ff'; g.shadowBlur = 10; g.fillRect(-10, -10, 20, 20); g.restore();
    glowText(g, 'BLUFOX MOBILE', x + 54, y + 33, 32, '#e8f3ff', 'rgba(90,160,255,0.9)', 800, 0.3, 2, 318);
  }
  glowText(g, 'STAFF ONLY', 384 + 12, 448 + 33, 26, '#dfe6ff', 'rgba(150,170,255,0.6)', 800, 0.2, 1, 168);
  g.fillStyle = '#062a12'; g.fillRect(576 + 6, 448 + 8, 116, 48);
  glowText(g, 'EXIT', 576 + 22, 448 + 33, 34, '#5dff8a', 'rgba(60,255,120,0.9)', 900, 0.35, 3);
  { // price card
    const x = 704, y = 448; g.fillStyle = '#f2f4fa'; g.fillRect(x + 6, y + 8, 52, 48);
    g.fillStyle = '#7b3fe4'; g.fillRect(x + 6, y + 8, 52, 12);
    g.fillStyle = '#9aa3b8'; g.fillRect(x + 12, y + 28, 36, 5); g.fillRect(x + 12, y + 38, 26, 5);
  }
  g.fillStyle = '#fff'; g.fillRect(768, 448, 64, 64); // white (neon tubes / strips)
  glowText(g, 'C³', 832 + 20, 448 + 33, 44, '#ffffff', '#b44dff', 900, 0.4);
  glowText(g, 'STORE', 832 + 88, 448 + 33, 26, '#cfe6ff', '#3ee8ff', 800, 0.3, 2);
  // ---- kiosk band A: product tiles
  {
    const x = 0, y = 512, w = 512, h = 216;
    g.fillStyle = '#060818'; g.fillRect(x, y, w, h);
    const cols = [['#2b1a6e', '#6a2bd9'], ['#08305e', '#1f8fff'], ['#4a0f4a', '#e0339f'], ['#0b3b3a', '#1ec9a5']];
    const labels = ['INTERNET', 'MOBILE', 'TV', 'HOME'];
    for (let i = 0; i < 4; i++) {
      const tx = x + 8 + i * 126, ty = y + 14, tw = 116, th = 188;
      const gg = g.createLinearGradient(tx, ty, tx + tw, ty + th); gg.addColorStop(0, cols[i][0]); gg.addColorStop(1, cols[i][1]);
      g.fillStyle = gg; roundRect(g, tx, ty, tw, th, 14); g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 5; g.lineCap = 'round'; g.lineJoin = 'round';
      const ix = tx + tw / 2, iy = ty + 78;
      g.beginPath();
      if (i === 0) { for (let r = 1; r <= 3; r++) { g.moveTo(ix + Math.cos(-2.4) * r * 16, iy + 20 + Math.sin(-2.4) * r * 16); g.arc(ix, iy + 20, r * 16, -2.4, -0.74); } }
      else if (i === 1) { roundRect(g, ix - 20, iy - 36, 40, 72, 9); }
      else if (i === 2) { roundRect(g, ix - 36, iy - 26, 72, 44, 5); g.moveTo(ix - 14, iy + 30); g.lineTo(ix + 14, iy + 30); }
      else { g.moveTo(ix - 32, iy + 4); g.lineTo(ix, iy - 26); g.lineTo(ix + 32, iy + 4); g.moveTo(ix - 22, iy - 4); g.lineTo(ix - 22, iy + 30); g.lineTo(ix + 22, iy + 30); g.lineTo(ix + 22, iy - 4); }
      g.stroke();
      if (i === 0) { g.fillStyle = '#fff'; g.beginPath(); g.arc(ix, iy + 20, 5, 0, TAU); g.fill(); }
      glowText(g, labels[i], tx + 12, ty + th - 30, 19, '#ffffff', 'rgba(255,255,255,0.4)', 800, 0.2, 1);
    }
  }
  // ---- kiosk band B: C³ hero
  {
    const x = 512, y = 512, w = 512, h = 216;
    const gg = g.createLinearGradient(x, y, x + w, y + h); gg.addColorStop(0, '#1a0840'); gg.addColorStop(0.55, '#2b1470'); gg.addColorStop(1, '#063a6e');
    g.fillStyle = gg; g.fillRect(x, y, w, h);
    g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip(); g.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 6; k++) {
      g.strokeStyle = ['#3ee8ff', '#b44dff', '#ff3ec8'][k % 3]; g.globalAlpha = 0.6; g.lineWidth = 2 + k % 2 * 2; g.shadowColor = g.strokeStyle; g.shadowBlur = 12;
      g.beginPath(); for (let s = 0; s <= 64; s++) { const px = x + s * 8, py = y + 150 + Math.sin(s * 0.22 + k) * (14 + k * 5) + k * 6; s ? g.lineTo(px, py) : g.moveTo(px, py); } g.stroke();
    }
    g.restore(); g.globalAlpha = 1;
    glowText(g, 'C³', x + 26, y + 84, 96, '#ffffff', '#b44dff', 900, 0.35);
    glowText(g, 'STAY', x + 200, y + 62, 40, '#dff7ff', '#3ee8ff', 800, 0.3, 4);
    glowText(g, 'CONNECTED', x + 200, y + 106, 40, '#dff7ff', '#3ee8ff', 800, 0.3, 4);
  }
  // ---- kiosk band C: ticker + signal bars
  {
    const x = 0, y = 728, w = 512, h = 216;
    g.fillStyle = '#04060f'; g.fillRect(x, y, w, h);
    g.fillStyle = 'rgba(62,232,255,0.35)'; g.fillRect(x, y + 20, w, 3); g.fillRect(x, y + 104, w, 3);
    glowText(g, 'MOBILE · INTERNET · TV · HOME ·', x + 10, y + 64, 34, '#8df3ff', '#3ee8ff', 800, 0.35, 2, 496);
    for (let i = 0; i < 32; i++) {
      const bh = 12 + (Math.sin(i * 0.7) * 0.5 + 0.5) * 70 * (0.5 + rng() * 0.5);
      const gg = g.createLinearGradient(0, y + 200 - bh, 0, y + 200); gg.addColorStop(0, '#ff3ec8'); gg.addColorStop(1, '#7b3fe4');
      g.fillStyle = gg; g.fillRect(x + 6 + i * 16, y + 200 - bh, 10, bh);
    }
  }
  // ---- phone wallpapers
  const WP = [['#1238ff', '#8a2be2', '#3ee8ff'], ['#ff3ec8', '#ff8a3c', '#ffd23e'], ['#00b3a6', '#1f4bff', '#6dffb0'], ['#6a2bd9', '#ff3ec8', '#3ee8ff']];
  WP.forEach((p, i) => {
    const x = 512 + i * 96, y = 728, w = 96, h = 216;
    const gg = g.createLinearGradient(x, y, x + w, y + h); gg.addColorStop(0, p[0]); gg.addColorStop(1, p[1]);
    g.fillStyle = gg; g.fillRect(x + 3, y + 3, w - 6, h - 6);
    g.save(); g.beginPath(); g.rect(x + 3, y + 3, w - 6, h - 6); g.clip(); g.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 3; k++) { const bx = x + rng() * w, by = y + 60 + rng() * 140, r = 30 + rng() * 40; const rg = g.createRadialGradient(bx, by, 0, bx, by, r); rg.addColorStop(0, p[2] + 'aa'); rg.addColorStop(1, p[2] + '00'); g.fillStyle = rg; g.fillRect(bx - r, by - r, 2 * r, 2 * r); }
    g.restore();
    g.fillStyle = '#05060a'; roundRect(g, x + 34, y + 10, 28, 9, 4.5); g.fill();
    glowText(g, '10:42', x + 18, y + 50, 22, '#ffffff', 'rgba(255,255,255,0.4)', 700, 0.2);
    g.fillStyle = 'rgba(255,255,255,0.28)';
    for (let r = 0; r < 3; r++) for (let q = 0; q < 3; q++) { roundRect(g, x + 14 + q * 24, y + 120 + r * 26, 16, 16, 4); g.fill(); }
  });
  // ---- dock backplate
  {
    const x = 896, y = 728, w = 128, h = 216;
    const gg = g.createLinearGradient(x, y, x, y + h); gg.addColorStop(0, '#1b2a7a'); gg.addColorStop(1, '#4a1266');
    g.fillStyle = gg; roundRect(g, x + 8, y + 8, w - 16, h - 16, 16); g.fill();
    g.strokeStyle = '#8fd8ff'; g.lineWidth = 3; g.shadowColor = '#3ee8ff'; g.shadowBlur = 8; roundRect(g, x + 10, y + 10, w - 20, h - 20, 14); g.stroke();
    g.shadowBlur = 0;
  }
  // ---- soft gaussian (mirror-only fixture streaks)
  { const x = 960, y = 944, w = 64, h = 80; const rg = g.createRadialGradient(x + w / 2, y + h / 2, 0, x + w / 2, y + h / 2, 30);
    rg.addColorStop(0, '#fff'); rg.addColorStop(0.35, 'rgba(255,255,255,0.45)'); rg.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = '#000'; g.fillRect(x, y, w, h); g.fillStyle = rg; g.save(); g.translate(x + w / 2, y + h / 2); g.scale(1, h / w); g.translate(-x - w / 2, -y - h / 2); g.fillRect(x, y, w, h); g.restore(); }
  // ---- category band
  g.textAlign = 'center';
  glowText(g, 'MOBILE  ·  INTERNET  ·  TV  ·  HOME', 470, 944 + 42, 46, '#f4f7ff', 'rgba(120,190,255,0.9)', 800, 0.3, 4, 900);
  g.textAlign = 'left';
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}
function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }

function paintGlow() {
  const [c, g] = mkCanvas(GW, GH);
  g.fillStyle = '#000'; g.fillRect(0, 0, GW, GH);
  const img = g.getImageData(0, 0, GW, GH), d = img.data;
  const put = (x, y, v) => { const i = (y * GW + x) * 4; const b = Math.round(clamp(v, 0, 1) * 255); d[i] = d[i + 1] = d[i + 2] = b; d[i + 3] = 255; };
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    const u = (x + 0.5) / 64 - 1, v = (y + 0.5) / 64 - 1, r = Math.sqrt(u * u + v * v);
    const b = Math.pow(clamp(1 - r, 0, 1), 1.6) * (0.75 + 0.25 * Math.exp(-r * r * 30)); put(x, y, b); // blob with hot core
    const ring = Math.exp(-Math.pow((r - 0.62) / 0.16, 2)) * clamp((1 - r) * 5, 0, 1); put(128 + x, y, ring);
    const ax = Math.abs(u), ay = Math.abs(v);
    const e = Math.min(clamp((1 - ax) / 0.38, 0, 1), clamp((1 - ay) / 0.38, 0, 1)); put(x, 128 + y, e * e * (3 - 2 * e)); // soft rect
    const edge = 1 - smooth((r - 0.62) / 0.36);                                  // downlight pool: defined disc, soft rim
    put(256 + x, y, edge * (0.55 + 0.45 * (1 - r * r)) + 0.08 * Math.exp(-r * r * 2));
    put(384 + x, y, Math.exp(-r * r * 4.5) * clamp((1 - r) * 3, 0, 1));        // soft gaussian
  }
  for (let y = 0; y < 64; y++) for (let x = 0; x < 128; x++) { // beam: bright at u=0 fading to u=1, soft sides
    const u = (x + 0.5) / 128, v = Math.abs((y + 0.5) / 32 - 1);
    const s = clamp((1 - v) / 0.55, 0, 1); put(128 + x, 128 + y, Math.pow(1 - u, 1.3) * s * s * (3 - 2 * s));
  }
  for (let y = 0; y < 32; y++) for (let x = 0; x < 128; x++) { const v = Math.abs((y + 0.5) / 16 - 1); put(128 + x, 192 + y, Math.exp(-v * v * 9)); }
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) { const u = (x + 0.5) / 16 - 1, v = (y + 0.5) / 16 - 1; put(128 + x, 224 + y, Math.exp(-(u * u + v * v) * 5)); }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

function paintSkyline(rng) {
  const [c, g] = mkCanvas(1024, 256);
  const sky = g.createLinearGradient(0, 0, 0, 256); sky.addColorStop(0, '#02030a'); sky.addColorStop(0.55, '#0b0a2a'); sky.addColorStop(0.85, '#2a1245'); sky.addColorStop(1, '#3a1a4a');
  g.fillStyle = sky; g.fillRect(0, 0, 1024, 256);
  for (let k = 0; k < 90; k++) { g.fillStyle = `rgba(255,255,255,${rng() * 0.5})`; g.fillRect(rng() * 1024, rng() * 110, 1, 1); }
  for (let layer = 0; layer < 3; layer++) {
    let x = -10;
    while (x < 1034) {
      const bw = 18 + rng() * (50 - layer * 8), bh = 40 + rng() * (layer === 0 ? 150 : 110 - layer * 25);
      const shade = 8 + layer * 7;
      g.fillStyle = `rgb(${shade},${shade + 2},${shade + 14})`; g.fillRect(x, 256 - bh, bw, bh);
      if (rng() < 0.2) { g.fillStyle = '#ff3b4d'; g.fillRect(x + bw / 2, 256 - bh - 4, 2, 2); }
      for (let wy = 256 - bh + 5; wy < 250; wy += 6) for (let wx = x + 3; wx < x + bw - 3; wx += 5) {
        if (rng() < 0.28 - layer * 0.06) { g.fillStyle = rng() < 0.7 ? `rgba(255,${190 + rng() * 50 | 0},120,${0.5 + rng() * 0.5})` : `rgba(120,220,255,${0.5 + rng() * 0.5})`; g.fillRect(wx, wy, 2, 3); }
      }
      x += bw + rng() * 6;
    }
  }
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function paintSweep() {
  const S = 256; const [c, g] = mkCanvas(S, S);
  const img = g.createImageData(S, S), d = img.data;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = (x + 0.5) / S * 2 - 1, v = (y + 0.5) / S * 2 - 1, r = Math.sqrt(u * u + v * v), a = Math.atan2(v, u);
    const fall = clamp(1 - r, 0, 1) * clamp(r * 6, 0, 1);
    const wA = Math.exp(-Math.pow(Math.atan2(Math.sin(a), Math.cos(a)) / 0.28, 2));
    const wB = Math.exp(-Math.pow(Math.atan2(Math.sin(a - Math.PI), Math.cos(a - Math.PI)) / 0.28, 2));
    const i = (y * S + x) * 4; d[i] = Math.round(wA * fall * 255); d[i + 1] = Math.round(wB * fall * 255); d[i + 2] = 0; d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.NoColorSpace; return tex;
}

// ---------------------------------------------------------------------------- the channel shader
const EMIT_VERT = /* glsl */`
  attribute vec4 aCell; attribute vec4 aAnim;
  #ifdef INST
  attribute vec4 aICell; attribute float aIB;
  #endif
  uniform float uTime; uniform vec4 uChA[${NCH}]; uniform vec4 uChT[${NCH}];
  varying vec2 vUv; varying vec4 vCell; varying vec3 vCol; varying vec3 vAnim;
  #ifdef MIRROR
  varying vec3 vWorld;
  #endif
  float h11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
  void main() {
    int ci = int(aAnim.x + 0.5);
    vec4 A = uChA[ci]; vec4 T = uChT[ci];
    float seed = aAnim.w;
    float g = A.x * step(fract(seed), A.z + 0.0001);
    if (A.y > 0.001) {
      float r = uTime * (4.0 + 10.0 * h11(seed * 91.7));
      float n = h11(floor(r) + seed * 37.0);
      float n2 = h11(floor(uTime * (0.8 + h11(seed * 13.1))) + seed * 11.0);
      float dead = step(1.0 - A.y * 0.5, n2);
      g *= mix(1.0, 0.3 + 0.7 * n, A.y) * (1.0 - dead * 0.93);
    }
    float mode = aAnim.y;
    if (abs(mode - 4.0) < 0.5) g *= 0.72 + 0.28 * sin(uTime * aAnim.z + seed * 6.2832);
    if (abs(mode - 6.0) < 0.5) g *= step(0.55, fract(uTime * aAnim.z + seed));
    #ifdef MIRROR
    if (abs(mode - 8.0) < 0.5) g = 0.0;
    #else
    if (abs(mode - 7.0) < 0.5) g = 0.0;
    #endif
    vec3 c = color;
    float m = max(max(c.r, c.g), c.b);
    float tm = T.a;
    if (abs(A.w) > 0.0001) tm *= 0.5 + 0.5 * sin(uTime * A.w * 2.0 + seed * 6.2832 + dot(position.xz, vec2(0.35, 0.22)));
    c = mix(c, T.rgb * m, tm);
    vCell = aCell;
    #ifdef INST
    if (aICell.z > 0.0) vCell = aICell;
    g *= aIB;
    vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
    #else
    vec4 wp = modelMatrix * vec4(position, 1.0);
    #endif
    vCol = c * g;
    vUv = uv; vAnim = vec3(mode, aAnim.z, seed);
    #ifdef MIRROR
    vWorld = wp.xyz;
    #endif
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;
const EMIT_FRAG = /* glsl */`
  uniform sampler2D uAtlas; uniform float uTime;
  #ifdef MIRROR
  uniform sampler2D uFloorRough; uniform float uReflect; uniform float uFade;
  varying vec3 vWorld;
  #endif
  varying vec2 vUv; varying vec4 vCell; varying vec3 vCol; varying vec3 vAnim;
  void main() {
    if (dot(vCol, vCol) < 1e-7) discard;
    vec2 uv = vUv;
    if (abs(vAnim.x - 1.0) < 0.5) uv.x += uTime * vAnim.y;
    else if (abs(vAnim.x - 2.0) < 0.5) uv.y += uTime * vAnim.y;
    vec2 f = fract(uv);
    vec2 auv = vCell.xy + f * vCell.zw;
    vec3 tex = textureGrad(uAtlas, auv, dFdx(uv) * vCell.zw, dFdy(uv) * vCell.zw).rgb;
    if (abs(vAnim.x - 3.0) < 0.5) {
      float s = fract(uTime * vAnim.y + vAnim.z);
      float d = f.x + f.y * 0.4 - s * 2.0 + 0.4;
      float b = exp(-d * d * 60.0);
      tex += tex * 1.2 * b + 0.12 * b;
    }
    vec3 col = tex * vCol;
    #ifdef MIRROR
    vec3 rd = vWorld - cameraPosition;
    float t = cameraPosition.y / max(1e-3, cameraPosition.y - vWorld.y);
    vec2 hit = cameraPosition.xz + rd.xz * t;
    float rough = texture2D(uFloorRough, vec2(hit.x, -hit.y) / 2.4).g;
    col *= uReflect * exp(vWorld.y * uFade) * clamp(1.45 - rough * 2.3, 0.0, 1.0);
    #endif
    gl_FragColor = vec4(col, 1.0);
  }`;

function makeEmitMaterial(uniforms, o = {}) {
  const m = new THREE.ShaderMaterial({
    uniforms, vertexShader: EMIT_VERT, fragmentShader: EMIT_FRAG, vertexColors: true,
    defines: Object.assign({}, o.defines || {}), blending: THREE.AdditiveBlending,
    transparent: !!o.transparent, depthWrite: !!o.depthWrite, depthTest: true, toneMapped: true,
  });
  if (o.depthFunc != null) m.depthFunc = o.depthFunc;
  return m;
}

// ---------------------------------------------------------------------------- moods
// ch entries: [intensity, flicker, fracOn, tintHex, tintMix, hueSpeed]
const DEFAULT_CH = {
  neon: [2.16], strip: [1.5], sign: [1.3], screen: [1.35], dock: [1.4], pool: [0.043, 0, 1], out: [1.0], emerg: [0.25],
  mesh: [0], sun: [0], edge: [1.0], under: [0.5], puck: [1.6], sweep: [0], phone: [1.2], spare: [0],
};
const MOODS = {
  title: {
    exposure: 1.06, sat: 1.08, contrast: 1.04, tint: '#ffffff', vignette: 0.42, bloom: 0.62,
    hemiSky: '#6c7fd0', hemiGround: '#1c1030', hemi: 0.56, key: '#e9eeff', keyI: 2.29, rim: '#9d8cff', rimI: 2.2, rimDir: [0.55, 0.62, -1],
    p: [['#8a4dff', 15.6], ['#2fbfff', 16], ['#ff3ec8', 14]], env: 'cool', envI: 0.6,
    ch: { pool: [0.1, 0, 1, '#ffe7cc', 0.5], neon: [2.38], screen: [1.5], dock: [1.6], under: [0.6] },
    bg: '#04050c',
  },
  close: { // 10 PM: half the lights off, cozy
    exposure: 1.0, sat: 1.05, contrast: 1.04, tint: '#fff6ee', vignette: 0.45, bloom: 0.6,
    hemiSky: '#6173b8', hemiGround: '#20122a', hemi: 0.46, key: '#f1ecff', keyI: 2.09, rim: '#a08cff', rimI: 2.1, rimDir: [0.55, 0.62, -1],
    p: [['#8a4dff', 14.4], ['#39a8ff', 12], ['#ff4fc8', 11]], env: 'cool', envI: 0.52,
    ch: { pool: [0.1, 0, 0.5, '#ffd7a8', 0.6], screen: [1.2], dock: [1.25], strip: [1.4] },
    bg: '#04050c',
  },
  night: { // 11 PM
    exposure: 0.98, sat: 1.06, contrast: 1.05, tint: '#eef2ff', vignette: 0.48, bloom: 0.64,
    hemiSky: '#4d64b8', hemiGround: '#140c28', hemi: 0.41, key: '#d8e2ff', keyI: 1.96, rim: '#6fa8ff', rimI: 2.2, rimDir: [0.55, 0.62, -1],
    p: [['#7b3fe4', 15.6], ['#2f8cff', 16], ['#b44dff', 12]], env: 'cool', envI: 0.48,
    ch: { pool: [0.08, 0, 0.26, '#bcd0ff', 0.5], strip: [1.6, 0, 1, '#5aa2ff', 0.35], under: [0.6] },
    bg: '#03040b',
  },
  boss: { // MIDNIGHT: red emergency strobes, siren sweep, dim
    exposure: 0.96, sat: 1.1, contrast: 1.06, tint: '#fff0f0', vignette: 0.55, vigColor: '#0a0003', bloom: 0.66,
    hemiSky: '#8a4c60', hemiGround: '#1a0608', hemi: 0.49, key: '#ffe6e6', keyI: 2.29, rim: '#ff4050', rimI: 2.5, rimDir: [0.55, 0.62, -1],
    p: [['#ff2233', 15.6], ['#ff2a3a', 17], ['#3a5cff', 16]], env: 'red', envI: 0.45,
    ch: { pool: [0.06, 0, 0.18, '#ff5040', 0.7], neon: [1.87, 0, 1, '#ff3050', 0.45], strip: [1.8, 0, 1, '#ff2030', 0.85], screen: [1.1, 0.15, 1, '#ff4060', 0.5], dock: [1.0, 0, 1, '#ff3050', 0.5], emerg: [4.0], sweep: [1.0], under: [0.5, 0, 1, '#ff2030', 0.8], puck: [1.3, 0, 1, '#ff4050', 0.7] },
    strobe: 1, bg: '#070205',
  },
  mesh: { // 1 AM: cyan-green network glow
    exposure: 1.0, sat: 1.08, contrast: 1.05, tint: '#eefff8', vignette: 0.48, bloom: 0.66,
    hemiSky: '#3f8a90', hemiGround: '#081a1c', hemi: 0.43, key: '#dcfff4', keyI: 2.03, rim: '#34ffc0', rimI: 2.3, rimDir: [0.55, 0.62, -1],
    p: [['#20e0c0', 13.2], ['#1fb8ff', 11], ['#30ff9a', 10]], env: 'teal', envI: 0.5,
    ch: { pool: [0.07, 0, 0.3, '#7affd8', 0.6], strip: [1.8, 0, 1, '#34ffc0', 0.8], mesh: [0.6], neon: [2.02], screen: [1.4, 0, 1, '#40ffd0', 0.25], under: [0.7, 0, 1, '#34ffc0', 0.8], puck: [1.8, 0, 1, '#6dffb0', 0.6] },
    bg: '#020807',
  },
  phones: { // 2 AM: phone walls blaze blue/magenta
    exposure: 1.0, sat: 1.12, contrast: 1.05, tint: '#f6f0ff', vignette: 0.48, bloom: 0.7,
    hemiSky: '#5a4ab8', hemiGround: '#1a0a2a', hemi: 0.42, key: '#ece4ff', keyI: 1.96, rim: '#ff3ec8', rimI: 2.4, rimDir: [0.55, 0.62, -1],
    p: [['#7b3fe4', 10.8], ['#2f6bff', 21], ['#ff2ec0', 20]], env: 'phones', envI: 0.55,
    ch: { pool: [0.085, 0, 0.35, '#b08aff', 0.85], dock: [2.6], phone: [2.1], strip: [1.8, 0, 1, '#ff3ec8', 0.85], screen: [1.6, 0, 1, '#ff60d0', 0.25], under: [0.9, 0, 1, '#ff3ec8', 0.7], puck: [1.8, 0, 1, '#ff3ec8', 0.6], edge: [1.3, 0, 1, '#4d7bff', 0.8] },
    bg: '#05030c',
  },
  deadzone: { // 3 AM: lights flicker / fail, darker, sickly
    exposure: 1.0, sat: 0.8, contrast: 1.06, tint: '#eef8dc', vignette: 0.58, vigColor: '#020400', bloom: 0.58,
    hemiSky: '#7a8a62', hemiGround: '#10120a', hemi: 0.49, key: '#e8f4d4', keyI: 2.23, rim: '#9aff6a', rimI: 1.9, rimDir: [0.55, 0.62, -1],
    p: [['#6a8a30', 7.2], ['#3a6a5a', 10], ['#7a6a20', 9]], env: 'dim', envI: 0.38,
    ch: { neon: [1.73, 0.65], strip: [1.0, 0.75, 1, '#b8ff80', 0.4], sign: [1.0, 0.6], screen: [1.0, 0.85, 1, '#a0ff90', 0.35], dock: [1.1, 0.7], pool: [0.09, 0.8, 0.35, '#dfffb0', 0.6], edge: [0.6, 0.7], under: [0.3, 0.7], puck: [1.2, 0.6], phone: [1.0, 0.7], emerg: [0.6, 0.5] },
    flick: 1, bg: '#030402',
  },
  boss2: { // 4 AM: magenta/red
    exposure: 0.97, sat: 1.12, contrast: 1.06, tint: '#fff0fa', vignette: 0.55, vigColor: '#0a0008', bloom: 0.68,
    hemiSky: '#8a4a90', hemiGround: '#1a0614', hemi: 0.49, key: '#ffe8f6', keyI: 2.29, rim: '#ff3ec8', rimI: 2.5, rimDir: [0.55, 0.62, -1],
    p: [['#ff2ec0', 16.8], ['#ff2a3a', 15], ['#b44dff', 15]], env: 'magenta', envI: 0.48,
    ch: { pool: [0.06, 0, 0.2, '#ff50c0', 0.7], neon: [2.02, 0, 1, '#ff3ec8', 0.4], strip: [1.8, 0, 1, '#ff2ec0', 0.85], screen: [1.3, 0.1, 1, '#ff40a0', 0.4], dock: [1.8, 0, 1, '#ff3ec8', 0.4], emerg: [3.6], sweep: [0.9], under: [0.6, 0, 1, '#ff2ec0', 0.8], phone: [1.6] },
    strobe: 0.8, sweepB: '#b44dff', bg: '#07020a',
  },
  dawn: { // 5 AM: warm light through the front glass
    exposure: 1.1, sat: 1.06, contrast: 1.03, tint: '#fff4e4', vignette: 0.38, vigColor: '#0a0402', bloom: 0.6,
    hemiSky: '#ffc9a0', hemiGround: '#2a1a2a', hemi: 0.6, key: '#ffe0bf', keyI: 2.43, rim: '#ffab66', rimI: 2.9, rimDir: [0.25, 0.55, 1],
    p: [['#b070ff', 8.4], ['#ff9a60', 10], ['#ff7a90', 10]], env: 'warm', envI: 0.7,
    ch: { pool: [0.03, 0, 0.2], neon: [1.73], sun: [0.075], out: [1.4, 0, 1, '#ffb070', 0.5], strip: [1.1], screen: [1.1], under: [0.3] },
    bg: '#0c0708',
  },
  sunrise: { // 6 AM victory: golden hour
    exposure: 1.16, sat: 1.1, contrast: 1.03, tint: '#fff0d8', vignette: 0.34, vigColor: '#0c0602', bloom: 0.64,
    hemiSky: '#ffd29a', hemiGround: '#3a2418', hemi: 0.7, key: '#ffe2b0', keyI: 2.6, rim: '#ffb050', rimI: 2.8, rimDir: [0.3, 0.45, 1],
    p: [['#ffb070', 9], ['#ffc080', 12], ['#ff9a70', 12]], env: 'warm', envI: 0.8,
    ch: { pool: [0.02, 0, 0.1], neon: [1.5], sun: [0.09, 0, 1, '#ffd08a', 0.6], out: [2.6, 0, 1, '#ffc070', 0.6], strip: [1.0, 0, 1, '#ffc060', 0.5], screen: [1.0], under: [0.3, 0, 1, '#ffb050', 0.6], edge: [0.8, 0, 1, '#ffc060', 0.6] },
    bg: '#140c08',
  },
  overtime: { // neon purple / gold party
    exposure: 1.02, sat: 1.18, contrast: 1.05, tint: '#fff4ff', vignette: 0.45, bloom: 0.74,
    hemiSky: '#7a4ac0', hemiGround: '#221030', hemi: 0.46, key: '#fff0e0', keyI: 2.09, rim: '#ffc14a', rimI: 2.5, rimDir: [0.55, 0.62, -1],
    p: [['#9a4dff', 15.6], ['#ffb547', 20], ['#ff3ec8', 20]], env: 'party', envI: 0.55,
    ch: { pool: [0.1, 0, 0.7, '#ffcf70', 0.9, 1.2], strip: [2.0, 0, 1, '#ffb547', 1.0, 1.6], neon: [2.59, 0, 1, '#c070ff', 0.25], under: [0.7, 0, 1, '#ffb547', 1.0, 1.1], mesh: [0.35, 0, 1, '#ffb547', 1.0, 1.4], puck: [2.0, 0, 1, '#ffd23e', 1.0, 1.3], screen: [1.6], dock: [2.0, 0, 1, '#ffb547', 0.8, 0.9], edge: [1.4, 0, 1, '#ffb547', 1.0, 1.0] },
    party: 1, bg: '#07040c',
  },
};
const ENVS = {
  cool:    { base: '#0a0f26', ceil: '#dfe6ff', ceilI: 0.7, back: '#8a4dff', back2: '#3ee8ff', backI: 3.2, left: '#2f8cff', leftI: 2.0, right: '#ff3ec8', rightI: 1.8, front: '#ffb070', frontI: 0.4 },
  red:     { base: '#1a0508', ceil: '#ffd0d0', ceilI: 0.6, back: '#ff2233', back2: '#ff5a3a', backI: 3.0, left: '#ff2030', leftI: 2.2, right: '#3a5cff', rightI: 1.8, front: '#ff6040', frontI: 0.3 },
  teal:    { base: '#04141a', ceil: '#d8fff4', ceilI: 0.9, back: '#20e0c0', back2: '#8a4dff', backI: 2.8, left: '#1fb8ff', leftI: 2.0, right: '#30ff9a', rightI: 1.8, front: '#ffb070', frontI: 0.3 },
  phones:  { base: '#0c0620', ceil: '#e6dcff', ceilI: 0.8, back: '#7b3fe4', back2: '#3ee8ff', backI: 2.4, left: '#2f6bff', leftI: 3.4, right: '#ff2ec0', rightI: 3.4, front: '#ffb070', frontI: 0.3 },
  dim:     { base: '#080a06', ceil: '#dfffc0', ceilI: 0.5, back: '#6a8a30', back2: '#3a6a5a', backI: 1.6, left: '#3a6a5a', leftI: 1.0, right: '#7a6a20', rightI: 1.0, front: '#ffb070', frontI: 0.2 },
  magenta: { base: '#14041a', ceil: '#ffd0f0', ceilI: 0.6, back: '#ff2ec0', back2: '#b44dff', backI: 3.0, left: '#ff2a3a', leftI: 2.2, right: '#b44dff', rightI: 2.2, front: '#ff6040', frontI: 0.3 },
  warm:    { base: '#1a1016', ceil: '#fff0dc', ceilI: 1.4, back: '#b070ff', back2: '#ff9a60', backI: 2.0, left: '#ff9a60', leftI: 1.4, right: '#ff7a90', rightI: 1.4, front: '#ffc080', frontI: 5.0 },
  party:   { base: '#140a20', ceil: '#fff0e0', ceilI: 1.0, back: '#9a4dff', back2: '#ffb547', backI: 3.2, left: '#ffb547', leftI: 2.2, right: '#ff3ec8', rightI: 2.2, front: '#ffb070', frontI: 0.5 },
};

function flattenMood(name) {
  const M = MOODS[name] || MOODS.close;
  const col = (h) => new THREE.Color(h);
  const s = {
    exposure: M.exposure, sat: M.sat, contrast: M.contrast, tint: col(M.tint), vignette: M.vignette, vigColor: col(M.vigColor || '#000003'), bloom: M.bloom,
    hemiSky: col(M.hemiSky), hemiGround: col(M.hemiGround), hemi: M.hemi, key: col(M.key), keyI: M.keyI, rim: col(M.rim), rimI: M.rimI,
    rimDir: new THREE.Vector3(...M.rimDir).normalize(),
    p: M.p.map(([c, i]) => ({ c: col(c), i })), envI: M.envI, env: M.env,
    strobe: M.strobe || 0, flick: M.flick || 0, party: M.party || 0, bg: col(M.bg), sweepA: col(M.sweepA || '#ff2030'), sweepB: col(M.sweepB || '#2a50ff'),
    ch: [],
  };
  for (const [k, idx] of Object.entries(CH)) {
    const d = Object.assign([], DEFAULT_CH[k], (M.ch && M.ch[k]) || []);
    s.ch[idx] = { i: d[0] ?? 0, f: d[1] ?? 0, on: d[2] ?? 1, t: col(d[3] || '#ffffff'), tm: d[3] ? (d[4] ?? 0.5) : 0, h: d[5] ?? 0 };
  }
  return s;
}
function copyState(o, a) {
  for (const k of ['exposure', 'sat', 'contrast', 'vignette', 'bloom', 'hemi', 'keyI', 'rimI', 'envI', 'strobe', 'flick', 'party']) o[k] = a[k];
  for (const k of ['tint', 'vigColor', 'hemiSky', 'hemiGround', 'key', 'rim', 'bg', 'sweepA', 'sweepB']) o[k] = a[k].clone();
  o.rimDir = a.rimDir.clone(); o.env = a.env;
  o.p = a.p.map((p) => ({ c: p.c.clone(), i: p.i }));
  o.ch = a.ch.map((c) => ({ i: c.i, f: c.f, on: c.on, t: c.t.clone(), tm: c.tm, h: c.h }));
  return o;
}
function lerpState(o, a, b, k) {
  for (const key of ['exposure', 'sat', 'contrast', 'vignette', 'bloom', 'hemi', 'keyI', 'rimI', 'envI', 'strobe', 'flick', 'party']) o[key] = lerp(a[key], b[key], k);
  for (const key of ['tint', 'vigColor', 'hemiSky', 'hemiGround', 'key', 'rim', 'bg', 'sweepA', 'sweepB']) o[key].copy(a[key]).lerp(b[key], k);
  o.rimDir.copy(a.rimDir).lerp(b.rimDir, k).normalize();
  for (let i = 0; i < o.p.length; i++) { o.p[i].c.copy(a.p[i].c).lerp(b.p[i].c, k); o.p[i].i = lerp(a.p[i].i, b.p[i].i, k); }
  for (let i = 0; i < NCH; i++) {
    const oc = o.ch[i], ac = a.ch[i], bc = b.ch[i];
    oc.i = lerp(ac.i, bc.i, k); oc.f = lerp(ac.f, bc.f, k); oc.on = lerp(ac.on, bc.on, k); oc.tm = lerp(ac.tm, bc.tm, k); oc.h = lerp(ac.h, bc.h, k);
    // tint: when one side has no tint, keep the other's colour so mixing fades cleanly
    if (ac.tm < 0.001) oc.t.copy(bc.t); else if (bc.tm < 0.001) oc.t.copy(ac.t); else oc.t.copy(ac.t).lerp(bc.t, k);
  }
}

// ---------------------------------------------------------------------------- createWorld
export function createWorld(gfx) {
  const { scene, renderer } = gfx;
  const rng = mulberry(20240611);
  const root = new THREE.Group(); root.name = 'world'; scene.add(root);

  // ---------------- textures
  const floorT = paintFloor(rng);
  const atlas = paintAtlas(rng);
  const glowTex = paintGlow();
  const skyTex = paintSkyline(rng);
  const sweepTex = paintSweep();

  // ---------------- shared uniforms / materials
  const chA = Array.from({ length: NCH }, () => new THREE.Vector4(1, 0, 1, 0));
  const chT = Array.from({ length: NCH }, () => new THREE.Vector4(1, 1, 1, 0));
  const uTime = { value: 0 };
  const baseU = { uTime, uChA: { value: chA }, uChT: { value: chT } };
  const uFloorRough = { value: floorT.rough };
  const uReflect = { value: 0.26 };
  const emitMat = makeEmitMaterial({ ...baseU, uAtlas: { value: atlas } }, { depthWrite: true });
  const emitMirrorMat = makeEmitMaterial({ ...baseU, uAtlas: { value: atlas }, uFloorRough, uReflect, uFade: { value: 0.3 } }, { defines: { MIRROR: '' }, depthFunc: THREE.GreaterDepth });
  const glowMat = makeEmitMaterial({ ...baseU, uAtlas: { value: glowTex } }, { transparent: true });
  const instMat = makeEmitMaterial({ ...baseU, uAtlas: { value: atlas } }, { defines: { INST: '' }, depthWrite: true });
  const instMirrorMat = makeEmitMaterial({ ...baseU, uAtlas: { value: atlas }, uFloorRough, uReflect, uFade: { value: 0.22 } }, { defines: { INST: '', MIRROR: '' }, depthFunc: THREE.GreaterDepth });
  const matte = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.0 });
  const gloss = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.05 });
  const aoMat = new THREE.MeshBasicMaterial({ color: 0x000000, alphaMap: glowTex, vertexColors: true, transparent: true, depthWrite: false, toneMapped: false });
  aoMat.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', 'diffuseColor.a *= vColor.a; diffuseColor.rgb = vec3(0.0);'); };

  // ---------------- batches
  const B = {
    shell: new Batch('lit'), shellGloss: new Batch('lit'), fixM: new Batch('lit'), fixG: new Batch('lit'),
    emit: new Batch('emit'), glow: new Batch('emit'), ao: new Batch('ao'), out: new Batch('lit'),
  };
  const W = ROOM.wallX, BZ = ROOM.backZ, FZ = ROOM.frontZ;
  const WALL_H = 4.6, BACK_H = 6.4;
  const plane = (w, h) => new THREE.PlaneGeometry(w, h);
  const floorQuad = (w, d) => xf(new THREE.PlaneGeometry(w, d), 0, 0, 0, -Math.PI / 2);
  const glowFloor = (x, z, w, d, color, o) => B.glow.add(xf(floorQuad(w, d), x, 0.012 + (o && o.lift || 0), z, 0, (o && o.ry) || 0), color, o);
  const ao = (x, z, w, d, a, cell, ry = 0) => B.ao.add(xf(floorQuad(w, d), x, 0.006, z, 0, ry), '#000', { alpha: a, cell: cell || GCELL.srect });

  // =============================== FLOOR
  const floorGeo = new THREE.PlaneGeometry(2 * W + 0.4, FZ - BZ + 0.3, 1, 1);
  xf(floorGeo, 0, 0, (FZ + BZ) / 2, -Math.PI / 2);
  { const p = floorGeo.attributes.position, uv = floorGeo.attributes.uv; for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / 2.4, -p.getZ(i) / 2.4); }
  const floorMat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: floorT.tex, roughnessMap: floorT.rough, roughness: 1.0, metalness: 0.08, envMapIntensity: 0.55 });
  // Direct-light specular on the floor is mostly suppressed: the rim light sits near the camera's mirror
  // direction and would paint a big glare. Floor gloss comes from IBL + the mirrored emissive cards.
  const uFloorSpec = { value: 0.18 };
  floorMat.onBeforeCompile = (sh) => {
    sh.uniforms.uFloorSpec = uFloorSpec;
    sh.fragmentShader = 'uniform float uFloorSpec;\n' + sh.fragmentShader.replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n reflectedLight.directSpecular *= uFloorSpec;');
  };
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.receiveShadow = true; floor.renderOrder = -10; floor.name = 'floor';
  root.add(floor);

  // =============================== SHELL (walls, caps, outside)
  const WALLC = '#0c1230', WALLC2 = '#111a3f', CAP = '#1c2448', BASE = '#070a18';
  // back wall + bulkhead
  B.shell.add(xf(BOX(2 * W + 0.8, BACK_H, 0.4), 0, BACK_H / 2, BZ - 0.2), WALLC);
  B.shell.add(xf(BOX(2 * W + 0.8, 0.08, 0.5), 0, BACK_H + 0.04, BZ - 0.2), CAP);
  // side walls
  for (const s of [-1, 1]) {
    B.shell.add(xf(BOX(0.4, WALL_H, FZ - BZ + 0.4), s * (W + 0.2), WALL_H / 2, (FZ + BZ) / 2), WALLC);
    B.shell.add(xf(BOX(0.5, 0.08, FZ - BZ + 0.4), s * (W + 0.2), WALL_H + 0.04, (FZ + BZ) / 2), CAP);
    B.shell.add(xf(BOX(0.04, 0.12, FZ - BZ), s * (W - 0.02), 0.06, (FZ + BZ) / 2), BASE);
    // vertical panel reveals on the side walls
    for (let z = BZ + 1.7; z < FZ - 0.5; z += 3.4) {
      B.shell.add(xf(BOX(0.06, WALL_H - 0.2, 0.14), s * (W - 0.03), WALL_H / 2, z), '#070b1e');
      B.emit.add(xf(BOX(0.02, WALL_H - 0.5, 0.04), s * (W - 0.065), WALL_H / 2 + 0.1, z), '#6a5cff', { ch: CH.edge, seed: 0.41 + z * 0.001 });
    }
    // wall top inner edge light line
    B.emit.add(xf(BOX(0.03, 0.03, FZ - BZ), s * (W - 0.02), WALL_H - 0.02, (FZ + BZ) / 2), '#7a5cff', { ch: CH.edge });
  }
  B.shell.add(xf(BOX(2 * W, 0.12, 0.04), 0, 0.06, BZ + 0.02), BASE);
  B.emit.add(xf(BOX(2 * W, 0.03, 0.03), 0, BACK_H - 0.03, BZ + 0.02), '#7a5cff', { ch: CH.edge });
  // back wall: slat feature wall behind the counter / C³ sign
  B.shell.add(xf(BOX(8.8, BACK_H - 0.6, 0.05), 0, (BACK_H - 0.6) / 2 + 0.6, BZ + 0.03), '#060918');
  for (let x = -4.3; x <= 4.31; x += 0.18) B.shell.add(xf(BOX(0.08, BACK_H - 0.7, 0.07), x, (BACK_H - 0.7) / 2 + 0.6, BZ + 0.09), WALLC2);
  // back-wall side panels (poster frames)
  for (const x of [-5.75, 6.35]) B.shell.add(xf(BOX(x < 0 ? 2.2 : 1.35, 3.5, 0.06), x, 2.75, BZ + 0.03), '#161d40');
  // outside: sidewalk, curb, street, dark ground
  B.out.add(xf(BOX(40, 0.1, 5.2), 0, -0.062, FZ + 2.75), '#1a1d28');
  for (let x = -19.5; x < 20; x += 1.5) B.out.add(xf(BOX(0.03, 0.005, 5.2), x, -0.01, FZ + 2.75), '#0c0e14');
  B.out.add(xf(BOX(40, 0.14, 0.25), 0, -0.02, FZ + 5.3), '#2a2d38');
  B.out.add(xf(BOX(40, 0.1, 14), 0, -0.2, FZ + 12.4), '#07070a');
  for (let x = -18; x < 19; x += 4) B.out.add(xf(BOX(1.8, 0.01, 0.14), x, -0.145, FZ + 9.5), '#3a3a30');
  B.out.add(xf(BOX(90, 0.1, 90), 0, -0.3, 0), '#030407');
  // street lamps (posts + warm pools on the sidewalk), parked cars, light streaks
  for (const x of [-9.5, -3.2, 3.2, 9.5]) {
    const lz = FZ + 4.7;
    B.fixG.add(xf(new THREE.CylinderGeometry(0.06, 0.08, 3.4, 10), x, 1.7, lz), '#20232e');
    B.fixG.add(xf(BOX(0.9, 0.08, 0.2), x, 3.42, lz - 0.35), '#20232e');
    B.emit.add(xf(BOX(0.5, 0.03, 0.12), x, 3.37, lz - 0.55), '#ffd7a0', { ch: CH.out, seed: 0.011 });
    glowFloor(x, FZ + 3.2, 4.2, 3.6, '#ffb070', { ch: CH.out, cell: GCELL.blob, seed: 0.01 });
  }
  const car = (x, z, col, dir) => {
    B.fixG.add(xf(new RoundedBoxGeometry(4.2, 0.62, 1.8, 3, 0.2), x, 0.33 - 0.15 + 0.12, z), col);
    B.fixG.add(xf(new RoundedBoxGeometry(2.3, 0.55, 1.6, 3, 0.22), x - dir * 0.2, 0.88 - 0.15 + 0.1, z), '#07080d');
    for (const s of [-1, 1]) {
      B.emit.add(xf(BOX(0.04, 0.1, 0.34), x - dir * 2.1, 0.46, z + s * 0.62), '#ff2030', { ch: CH.out, seed: 0.012 });
      B.emit.add(xf(BOX(0.04, 0.1, 0.3), x + dir * 2.1, 0.46, z + s * 0.62), '#e8f0ff', { ch: CH.out, seed: 0.012 });
    }
    B.ao.add(xf(floorQuad(4.8, 2.4), x, -0.138, z), '#000', { alpha: 0.8, cell: GCELL.srect });
  };
  car(-5.2, FZ + 6.6, '#1b2a55', 1); car(4.6, FZ + 6.6, '#5a1020', -1);
  glowFloor(-0.2, FZ + 6.6, 6, 2.0, '#e8f0ff', { ch: CH.out, cell: GCELL.beam, lift: -0.14, seed: 0.013 });
  glowFloor(-3, FZ + 8.4, 16, 0.3, '#ff3040', { ch: CH.out, cell: GCELL.line, lift: -0.14, seed: 0.02 });
  glowFloor(5, FZ + 10.6, 14, 0.3, '#fff0d0', { ch: CH.out, cell: GCELL.line, lift: -0.14, seed: 0.03 });

  // wall-base AO strips
  ao(0, BZ + 0.35, 2 * W, 0.9, 0.55);
  for (const s of [-1, 1]) ao(s * (W - 0.3), (FZ + BZ) / 2, 0.9, FZ - BZ, 0.5);

  // =============================== C³ NEON SIGN
  // Built in a local frame, then tilted ~20° toward the camera (reads rounder from the 57° gameplay pitch).
  const signY = 3.75, signZ = BZ + 0.8, TILT = -0.34; // negative: face tilts UP toward the high camera
  {
    const sg = (g) => xf(xf(g, 0, 0, 0, TILT, 0, 0), 0, signY, signZ);
    const cyan = new THREE.Color('#3ee8ff'), purple = new THREE.Color('#9a4dff');
    const gradC = (x, y, z, o) => o.copy(purple).lerp(cyan, clamp((y - (signY - 1.05)) / 2.1, 0, 1));
    const R = 1.1, tube = 0.085, cx = -0.48;
    B.emit.add(sg(xf(new THREE.TorusGeometry(R, tube, 10, 72, Math.PI * 1.52), cx, 0, 0, 0, 0, Math.PI * 0.24)), '#fff', { ch: CH.neon, grad: gradC, seed: 0.101 });
    B.emit.add(sg(xf(new THREE.TorusGeometry(R, tube * 0.4, 6, 72, Math.PI * 1.52), cx, 0, 0.065, 0, 0, Math.PI * 0.24)), '#fff', { ch: CH.neon, grad: (x, y, z, o) => gradC(x, y, z, o).lerp(_c1.set('#ffffff'), 0.5), seed: 0.101 });
    // superscript 3 — two arcs
    const r3 = 0.3, t3 = 0.085, x3 = cx + R + 0.6, y3 = 0.6;
    for (const [yy, rot] of [[y3 + r3, -Math.PI / 2], [y3 - r3, -Math.PI * 0.84]]) {
      B.emit.add(sg(xf(new THREE.TorusGeometry(r3, t3, 8, 36, Math.PI * 1.34), x3, yy, 0, 0, 0, rot)), '#ffa53a', { ch: CH.neon, seed: 0.101 });
      B.emit.add(sg(xf(new THREE.TorusGeometry(r3, t3 * 0.4, 6, 36, Math.PI * 1.34), x3, yy, 0.06, 0, 0, rot)), '#ffe0a8', { ch: CH.neon, seed: 0.101 });
    }
    // dark acrylic backing plate + standoff arm + soft wall wash (kept dim: it shares the neon channel)
    B.shellGloss.add(sg(xf(new RoundedBoxGeometry(3.9, 2.75, 0.05, 2, 0.02), 0.05, 0.05, -0.12)), '#080b1c');
    B.shellGloss.add(xf(BOX(0.1, 0.1, 1.1), -1.6, signY - 1.0, BZ + 0.6), '#20263e');
    B.shellGloss.add(xf(BOX(0.1, 0.1, 1.1), 1.7, signY - 1.0, BZ + 0.6), '#20263e');
    B.glow.add(xf(plane(7.0, 5.0), 0.1, signY, BZ + 0.2), new THREE.Color('#7b3fe4').multiplyScalar(0.14), { ch: CH.neon, cell: GCELL.blob, seed: 0.101 });
    B.glow.add(xf(plane(2.4, 2.4), x3, signY + y3, BZ + 0.21), new THREE.Color('#ff9a2e').multiplyScalar(0.12), { ch: CH.neon, cell: GCELL.blob, seed: 0.101 });
  }
  // category band + badge on the slat wall
  B.emit.add(xf(plane(7.0, 0.6), 0, 5.62, BZ + 0.16), '#ffffff', { ch: CH.sign, cell: ACELL.cat, seed: 0.3 });

  // =============================== SERVICE COUNTER
  {
    const f = FIXTURES.find((q) => q.id === 'counter');
    const fzF = f.z + f.hd; // front face z
    B.fixG.add(xf(BOX(f.hw * 2, f.h - 0.06, f.hd * 2), f.x, (f.h - 0.06) / 2, f.z), '#141a36');
    B.fixG.add(xf(new RoundedBoxGeometry(f.hw * 2 + 0.1, 0.06, f.hd * 2 + 0.08, 2, 0.02), f.x, f.h - 0.03, f.z), '#b9c0d0');
    B.fixM.add(xf(BOX(f.hw * 2 - 0.1, 0.1, 0.05), f.x, 0.05, fzF - 0.05), '#05070f');
    B.emit.add(xf(BOX(f.hw * 2 - 0.1, 0.035, 0.02), f.x, 0.13, fzF + 0.005), '#5a8cff', { ch: CH.strip, seed: 0.2 });
    B.emit.add(xf(BOX(f.hw * 2 + 0.08, 0.03, 0.02), f.x, f.h - 0.075, fzF + 0.045), '#b44dff', { ch: CH.strip, seed: 0.2, mode: MODE.noMirror });
    B.emit.add(xf(plane(2.7, 0.45), f.x, 0.6, fzF + 0.006), '#ffffff', { ch: CH.sign, cell: ACELL.blufox, seed: 0.31 });
    glowFloor(f.x, fzF + 0.6, 7.6, 1.6, '#6a4dff', { ch: CH.under, cell: GCELL.srect, seed: 0.2 });
    ao(f.x, f.z, f.hw * 2 + 0.6, f.hd * 2 + 0.5, 0.7);
    // staff monitors (backs to camera) + customer tablet + card reader
    for (const x of [-1.9, 1.9]) {
      B.fixG.add(xf(BOX(0.06, 0.28, 0.06), x, f.h + 0.14, f.z - 0.2), '#2a2f42');
      B.fixG.add(xf(new RoundedBoxGeometry(0.72, 0.44, 0.05, 2, 0.015), x, f.h + 0.46, f.z - 0.22, -0.12), '#1a1e2c');
      B.emit.add(xf(plane(0.66, 0.38), x, f.h + 0.46, f.z - 0.25, -0.12, Math.PI), '#9ad8ff', { ch: CH.screen, cell: ACELL.kB, seed: 0.4 });
    }
    B.fixG.add(xf(BOX(0.34, 0.03, 0.24), 0, f.h + 0.1, f.z + 0.25, -0.5), '#1a1e2c');
    B.emit.add(xf(plane(0.3, 0.2), 0, f.h + 0.12, f.z + 0.26, -0.5 - Math.PI / 2), '#ffffff', { ch: CH.screen, cell: ACELL.wall[0], seed: 0.41 });
    B.fixG.add(xf(BOX(0.12, 0.05, 0.16), 0.8, f.h + 0.025, f.z + 0.3), '#0d0f18');
    B.emit.add(xf(plane(0.46, 0.15), -0.9, f.h + 0.1, f.z + 0.35, -0.3), '#ffffff', { ch: CH.sign, cell: ACELL.c3badge, seed: 0.32 });
    B.fixG.add(xf(BOX(0.5, 0.18, 0.03), -0.9, f.h + 0.07, f.z + 0.33, -0.3), '#0b0e1c');
  }

  // =============================== BACK WALL: posters, door, exit
  B.emit.add(xf(plane(1.95, 3.35), -5.75, 2.75, BZ + 0.07), '#ffffff', { ch: CH.sign, cell: ACELL.poster[0], mode: MODE.sweep, speed: 0.07, seed: 0.33 });
  B.emit.add(xf(plane(1.15, 2.0), 6.35, 2.9, BZ + 0.07), '#ffffff', { ch: CH.sign, cell: ACELL.poster[2], mode: MODE.sweep, speed: 0.05, seed: 0.6 });
  B.glow.add(xf(plane(3.4, 4.6), -5.75, 2.75, BZ + 0.1), '#5a3cff', { ch: CH.sign, cell: GCELL.srect, seed: 0.33 });
  // back-room door (x 4.45..5.55)
  const door = { x: 5.0, w: 1.1, h: 2.3 };
  B.fixM.add(xf(BOX(0.1, door.h + 0.1, 0.12), door.x - door.w / 2 - 0.05, (door.h + 0.1) / 2, BZ + 0.06), '#2c3456');
  B.fixM.add(xf(BOX(0.1, door.h + 0.1, 0.12), door.x + door.w / 2 + 0.05, (door.h + 0.1) / 2, BZ + 0.06), '#2c3456');
  B.fixM.add(xf(BOX(door.w + 0.2, 0.1, 0.12), door.x, door.h + 0.05, BZ + 0.06), '#2c3456');
  B.shell.add(xf(BOX(door.w, door.h, 0.02), door.x, door.h / 2, BZ + 0.005), '#1a0f06');
  B.emit.add(xf(plane(1.1, 0.37), door.x, door.h + 0.42, BZ + 0.05), '#ffffff', { ch: CH.sign, cell: ACELL.staff, seed: 0.34 });
  B.emit.add(xf(plane(0.6, 0.3), 2.9, 5.45, BZ + 0.05), '#ffffff', { ch: CH.sign, cell: ACELL.exit, seed: 0.35 });
  const doorPivot = new THREE.Group(); doorPivot.position.set(door.x - door.w / 2, 0, BZ + 0.04); root.add(doorPivot);
  const doorLeaf = new THREE.Mesh(xf(BOX(door.w, door.h, 0.05), door.w / 2, door.h / 2, 0.025), new THREE.MeshStandardMaterial({ color: 0x323a5c, roughness: 0.45, metalness: 0.2 }));
  doorLeaf.castShadow = true; doorLeaf.receiveShadow = true; doorPivot.add(doorLeaf);
  const doorWinMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 0.45, 0.25) });
  const doorWin = new THREE.Mesh(xf(plane(0.26, 0.7), door.w / 2 + 0.25, 1.55, 0.052), doorWinMat); doorPivot.add(doorWin);
  const doorSpillMat = new THREE.MeshBasicMaterial({ map: glowTex, color: new THREE.Color('#ffc080'), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 });
  const dsGeo = floorQuad(1, 1); { const uv = dsGeo.attributes.uv; const c = GCELL.beam; for (let i = 0; i < uv.count; i++) { const u = uv.getX(i), v = uv.getY(i); uv.setXY(i, c[0] + (1 - v) * c[2], c[1] + u * c[3]); } }
  const doorSpill = new THREE.Mesh(dsGeo, doorSpillMat); doorSpill.scale.set(1.8, 1, 4.2); doorSpill.position.set(door.x, 0.014, BZ + 2.2); doorSpill.visible = false; root.add(doorSpill);

  // emergency beacons (dark domes, blink red in boss moods)
  const beacons = [[-6.6, BACK_H - 0.45, BZ + 0.1], [6.6, BACK_H - 0.45, BZ + 0.1], [0, BACK_H - 0.4, BZ + 0.1]];
  for (const s of [-1, 1]) for (const z of [-6.5, 0.5, 7.5]) beacons.push([s * (W - 0.08), WALL_H - 0.35, z]);
  beacons.forEach(([x, y, z], i) => {
    B.fixG.add(xf(BOX(0.22, 0.08, 0.22), x, y - 0.1, z), '#20222c');
    B.emit.add(xf(new THREE.SphereGeometry(0.12, 12, 8, 0, TAU, 0, Math.PI / 2), x, y - 0.06, z), '#ff2030', { ch: CH.emerg, mode: MODE.blink, speed: 2.6, seed: (i * 0.37) % 1 });
    B.glow.add(xf(plane(1.6, 1.6), x - Math.sign(x) * 0.01, y, z + (Math.abs(x) > 7 ? 0 : 0.05), 0, Math.abs(x) > 7 ? -Math.sign(x) * Math.PI / 2 : 0), '#ff2030', { ch: CH.emerg, cell: GCELL.blob, mode: MODE.blink, speed: 2.6, seed: (i * 0.37) % 1 });
  });

  // =============================== MODEM TABLES + PUCKS
  const puckSpots = [];
  for (const f of FIXTURES.filter((q) => q.role === 'modemTable')) {
    const side = f.z < 0 ? -1 : 1;
    const topY = f.h;
    B.fixG.add(xf(new RoundedBoxGeometry(f.hw * 2, 0.07, f.hd * 2, 2, 0.028), f.x, topY - 0.035, f.z), '#d3d9e4');
    B.fixG.add(xf(BOX(f.hw * 2 - 0.5, topY - 0.12, f.hd * 2 - 0.36), f.x, (topY - 0.12) / 2 + 0.05, f.z), '#1a2044');
    B.fixM.add(xf(BOX(f.hw * 2 - 0.4, 0.05, f.hd * 2 - 0.26), f.x, 0.025, f.z), '#0a0d1c');
    // LED line under the top edge (all four sides)
    const ly = topY - 0.085;
    B.emit.add(xf(BOX(f.hw * 2 - 0.06, 0.03, 0.03), f.x, ly, f.z + f.hd - 0.03), '#3ee8ff', { ch: CH.strip, seed: 0.21, mode: MODE.noMirror });
    B.emit.add(xf(BOX(f.hw * 2 - 0.06, 0.03, 0.03), f.x, ly, f.z - f.hd + 0.03), '#3ee8ff', { ch: CH.strip, seed: 0.21, mode: MODE.noMirror });
    for (const sx of [-1, 1]) B.emit.add(xf(BOX(0.03, 0.03, f.hd * 2 - 0.06), f.x + sx * (f.hw - 0.03), ly, f.z), '#3ee8ff', { ch: CH.strip, seed: 0.21, mode: MODE.noMirror });
    glowFloor(f.x, f.z, f.hw * 2 + 0.9, f.hd * 2 + 0.9, '#3a50d0', { ch: CH.under, cell: GCELL.srect, seed: 0.22 });
    ao(f.x, f.z, f.hw * 2 + 0.3, f.hd * 2 + 0.3, 0.75);
    // props along the edge away from the hop direction (all face the aisle / camera, +Z)
    const pz = f.z + side * 0.44;
    for (const [dx, kind] of [[-1.12, 'tab'], [-0.4, 'card'], [0.4, 'remote'], [1.12, 'tab']]) {
      const x = f.x + dx;
      if (kind === 'tab') {
        B.fixG.add(xf(BOX(0.05, 0.12, 0.05), x, topY + 0.06, pz - 0.04), '#c9ced8');
        B.fixG.add(xf(new RoundedBoxGeometry(0.34, 0.24, 0.02, 1, 0.01), x, topY + 0.16, pz, -0.5), '#1a1e2c');
        B.emit.add(xf(xf(plane(0.3, 0.2), 0, 0, 0.012), x, topY + 0.16, pz, -0.5), '#ffffff', { ch: CH.screen, cell: ACELL.wall[(Math.abs(Math.round(x * 3))) % 4], seed: rng() });
      } else if (kind === 'card') {
        B.emit.add(xf(plane(0.14, 0.14), x, topY + 0.075, pz, -0.25), '#ffffff', { ch: CH.screen, cell: ACELL.price, seed: rng() });
        B.fixG.add(xf(BOX(0.16, 0.02, 0.06), x, topY + 0.01, pz - 0.02), '#d0d4de');
      } else {
        B.fixG.add(xf(new THREE.CapsuleGeometry(0.025, 0.16, 3, 8), x, topY + 0.028, pz, Math.PI / 2, 0.4, 0), '#0e1018');
        B.emit.add(xf(new THREE.SphereGeometry(0.014, 6, 4), x - 0.03, topY + 0.056, pz - 0.06), '#ff3040', { ch: CH.screen, seed: rng() });
      }
    }
    for (const dx of [-0.8, 0, 0.8]) puckSpots.push({ x: f.x + dx, y: topY, z: f.z, fid: f.id });
  }

  // =============================== KIOSK
  {
    const k = FIXTURES.find((q) => q.id === 'kiosk');
    const R = k.r;
    B.fixG.add(xf(new THREE.CylinderGeometry(R + 0.08, R + 0.12, 0.1, 48), k.x, 0.05, k.z), '#10142a');
    // screen tower cut at ~2.9 m (the room has no ceiling; a full-height column hides too much floor)
    const TOP = 2.86;
    B.fixM.add(xf(new THREE.CylinderGeometry(R - 0.03, R - 0.03, TOP, 32), k.x, TOP / 2, k.z), '#05060c');
    const bands = [[0.12, 0.98, ACELL.kA, 0.018, 2], [1.03, 1.93, ACELL.kB, -0.012, 2], [1.98, 2.8, ACELL.kC, 0.03, 2]];
    bands.forEach(([y0, y1, cell, sp, rep], i) => {
      const g = new THREE.CylinderGeometry(R, R, y1 - y0, 48, 1, true);
      xf(g, k.x, (y0 + y1) / 2, k.z);
      B.emit.add(g, '#ffffff', { ch: CH.screen, cell, mode: MODE.scrollU, speed: sp, uvScale: [rep, 1], seed: 0.5 + i * 0.05 });
    });
    for (const y of [0.1, 1.005, 1.955]) B.fixG.add(xf(new THREE.CylinderGeometry(R + 0.025, R + 0.025, 0.05, 48), k.x, y, k.z), '#1d2236');
    B.fixG.add(xf(new THREE.CylinderGeometry(R + 0.07, R + 0.04, 0.12, 48), k.x, TOP, k.z), '#151a30');
    B.emit.add(xf(new THREE.TorusGeometry(R + 0.075, 0.03, 6, 64), k.x, TOP + 0.02, k.z, Math.PI / 2), '#3ee8ff', { ch: CH.edge, seed: 0.24 });
    B.emit.add(xf(new THREE.TorusGeometry(R + 0.03, 0.02, 6, 64), k.x, TOP - 0.075, k.z, Math.PI / 2), '#b44dff', { ch: CH.strip, seed: 0.23 });
    B.emit.add(xf(plane(1.14, 0.38), k.x, TOP + 0.065, k.z, -Math.PI / 2), '#ffffff', { ch: CH.sign, cell: ACELL.c3badge, seed: 0.24 });
    B.emit.add(xf(new THREE.RingGeometry(R - 0.12, R - 0.08, 64), k.x, TOP + 0.064, k.z, -Math.PI / 2), '#7b3fe4', { ch: CH.strip, seed: 0.23 });
    glowFloor(k.x, k.z, 3.1, 3.1, '#5a4dcc', { ch: CH.screen, cell: GCELL.ring, seed: 0.5 });
    ao(k.x, k.z, 2.3, 2.3, 0.7, GCELL.blob);
  }

  // =============================== PHONE WALLS (counters, docks, decor phones)
  const phonePerches = SPAWNS.filter((s) => s.for === 'phone');
  for (const s of [-1, 1]) {
    for (const z of [...new Set(phonePerches.map((p) => p.z))]) {
      const len = 2.6, cx = s * (W - 0.35);
      B.fixG.add(xf(BOX(0.7, 0.95, len), cx, 0.475, z), '#141a38');
      B.fixG.add(xf(new RoundedBoxGeometry(0.78, 0.05, len + 0.06, 1, 0.015), s * (W - 0.39), 0.975, z), '#e7ebf3');
      B.emit.add(xf(BOX(0.03, 0.03, len - 0.1), s * (W - 0.79), 0.935, z), '#3ee8ff', { ch: CH.strip, seed: 0.25, mode: MODE.noMirror });
      B.fixM.add(xf(BOX(0.05, 0.08, len - 0.1), s * (W - 0.72), 0.04, z), '#05070f');
      glowFloor(s * (W - 0.95), z, 0.9, len + 0.2, '#3a50d0', { ch: CH.under, cell: GCELL.srect, seed: 0.26 });
      ao(s * (W - 0.45), z, 1.2, len + 0.4, 0.6);
      // dock pedestal
      B.fixG.add(xf(new RoundedBoxGeometry(0.36, 0.16, 0.82, 1, 0.02), s * (W - 0.33), 1.07, z), '#d6dbe6');
      // accessories on the counter
      for (const dz of [-0.95, 0.95]) {
        B.fixG.add(xf(new RoundedBoxGeometry(0.16, 0.1, 0.16, 1, 0.02), s * (W - 0.45), 1.05, z + dz), rng() < 0.5 ? '#f2f4fa' : '#2a2f40');
        B.fixG.add(xf(BOX(0.05, 0.22, 0.18), s * (W - 0.3), 1.11, z + dz * 0.72), '#1a1e2c');
        B.emit.add(xf(plane(0.15, 0.19), s * (W - 0.33), 1.12, z + dz * 0.72, 0, -s * Math.PI / 2, 0), '#ffffff', { ch: CH.screen, cell: ACELL.wall[(Math.round(z * 7 + dz * 3) & 3)], seed: rng() });
        B.emit.add(xf(plane(0.12, 0.12), s * (W - 0.6), 1.09, z + dz * 0.5, 0, -s * Math.PI / 2, 0), '#ffffff', { ch: CH.sign, cell: ACELL.price, seed: rng() });
      }
      // poster above
      B.emit.add(xf(plane(2.3, 1.05), s * (W - 0.01), 3.55, z, 0, -s * Math.PI / 2), '#ffffff', { ch: CH.sign, cell: [ACELL.kB, ACELL.kA, ACELL.kC][Math.abs(Math.round(z)) % 3], seed: rng() });
    }
  }
  // decor phones (instanced; hide / restock) + dock glow plates (instanced; flash)
  const NP = phonePerches.length;
  const phoneBodyGeo = new RoundedBoxGeometry(0.1, 1.3, 0.62, 2, 0.045);
  const phoneBodies = new THREE.InstancedMesh(phoneBodyGeo, new THREE.MeshStandardMaterial({ color: 0x252a38, roughness: 0.32, metalness: 0.55 }), NP);
  phoneBodies.castShadow = true; phoneBodies.receiveShadow = true; phoneBodies.name = 'decorPhones';
  const scrGeo = new THREE.PlaneGeometry(0.56, 1.22);
  const initInstAttrs = (geo, n, cellFn) => {
    for (const k of Object.keys(geo.attributes)) if (!['position', 'uv'].includes(k)) geo.deleteAttribute(k);
    const cnt = geo.attributes.position.count;
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(cnt * 3).fill(1), 3));
    if (!geo.attributes.aCell) { const ac = new Float32Array(cnt * 4); for (let i = 0; i < cnt; i++) ac.set(ACELL.white, i * 4); geo.setAttribute('aCell', new THREE.BufferAttribute(ac, 4)); }
    const ic = new Float32Array(n * 4); for (let i = 0; i < n; i++) ic.set(cellFn(i), i * 4);
    geo.setAttribute('aICell', new THREE.InstancedBufferAttribute(ic, 4));
    geo.setAttribute('aIB', new THREE.InstancedBufferAttribute(new Float32Array(n).fill(1), 1));
  };
  initInstAttrs(scrGeo, NP, (i) => ACELL.wall[i % 4]);
  { const aa = new Float32Array(scrGeo.attributes.position.count * 4); for (let i = 0; i < scrGeo.attributes.position.count; i++) aa.set([CH.phone, 0, 0, 0.77], i * 4); scrGeo.setAttribute('aAnim', new THREE.BufferAttribute(aa, 4)); }
  const phoneScreens = new THREE.InstancedMesh(scrGeo, instMat, NP); phoneScreens.renderOrder = 1; phoneScreens.name = 'decorPhoneScreens';
  // dock plate geometry: backplate on the wall + lip strip (merged, emit batch format)
  const dockB = new Batch('emit');
  dockB.add(xf(plane(1.45, 1.95), 0, 2.05, 0, 0, -Math.PI / 2), '#ffffff', { ch: CH.dock, cell: ACELL.dock, seed: 0.7 });
  dockB.add(xf(BOX(0.025, 0.025, 0.8), -0.19, 1.155, 0), '#8fd8ff', { ch: CH.dock, seed: 0.7 });
  dockB.add(xf(BOX(0.02, 0.02, 0.8), -0.19, 0.99, 0), '#b44dff', { ch: CH.dock, seed: 0.7 });
  const dockGeo = dockB.geometry();
  { const cnt = NP; dockGeo.setAttribute('aICell', new THREE.InstancedBufferAttribute(new Float32Array(cnt * 4), 4)); dockGeo.setAttribute('aIB', new THREE.InstancedBufferAttribute(new Float32Array(cnt).fill(1), 1)); }
  const dockGlows = new THREE.InstancedMesh(dockGeo, instMat, NP); dockGlows.renderOrder = 1; dockGlows.name = 'dockGlows';
  const phoneState = [];
  const _o = new THREE.Object3D();
  phonePerches.forEach((p, i) => {
    const s = Math.sign(p.x);
    const lean = 0.16;
    // body: base at (p.x, p.y), leaning back toward the wall
    _o.position.set(p.x + s * Math.sin(lean) * 0.65 + s * 0.02, p.y + Math.cos(lean) * 0.65, p.z);
    _o.rotation.set(0, 0, -s * lean); _o.scale.set(1, 1, 1); _o.updateMatrix();
    phoneBodies.setMatrixAt(i, _o.matrix);
    const bodyM = _o.matrix.clone();
    // screen: offset toward the room along local -s x
    _o.position.set(-s * 0.052, 0, 0); _o.rotation.set(0, -s * Math.PI / 2, 0); _o.updateMatrix();
    const scrM = bodyM.clone().multiply(_o.matrix);
    phoneScreens.setMatrixAt(i, scrM);
    _o.position.set(s * (W - 0.01) - 0, 0, p.z); _o.rotation.set(0, s > 0 ? 0 : Math.PI, 0); _o.updateMatrix();
    // dock geometry is authored for the RIGHT wall (+x) facing -x; mirror for left by rotating PI
    _o.position.set(s > 0 ? W - 0.01 + 0.0 : -W + 0.01, 0, p.z); _o.updateMatrix();
    dockGlows.setMatrixAt(i, _o.matrix);
    phoneState.push({ id: p.id, x: p.x, y: p.y, z: p.z, bodyM, scrM, hidden: false, restockAt: 0, flicker: 0, flash: 0 });
  });
  // shift dock plate so its lip sits at the pedestal edge: authored at x=0 == wall; lip at -0.19 → wall - 0.19 ≈ pedestal inner edge
  for (const m of [phoneBodies, phoneScreens, dockGlows]) m.frustumCulled = false;
  root.add(phoneBodies, phoneScreens, dockGlows);
  const dockMirror = new THREE.InstancedMesh(dockGeo, instMirrorMat, NP);
  dockMirror.instanceMatrix = dockGlows.instanceMatrix; dockMirror.renderOrder = -5; dockMirror.frustumCulled = false;

  // modem display pucks (instanced; flash on spawn)
  const puckB = new Batch('emit');
  puckB.add(xf(new THREE.TorusGeometry(0.3, 0.022, 6, 48), 0, 0.012, 0, Math.PI / 2), '#3ee8ff', { ch: CH.puck, seed: 0.8 });
  puckB.add(xf(new THREE.CircleGeometry(0.27, 40), 0, 0.006, 0, -Math.PI / 2), '#1a3a7a', { ch: CH.puck, seed: 0.8 });
  puckB.add(xf(new THREE.TorusGeometry(0.16, 0.01, 4, 32), 0, 0.01, 0, Math.PI / 2), '#b44dff', { ch: CH.puck, seed: 0.8 });
  const puckGeo = puckB.geometry();
  puckGeo.setAttribute('aICell', new THREE.InstancedBufferAttribute(new Float32Array(puckSpots.length * 4), 4));
  puckGeo.setAttribute('aIB', new THREE.InstancedBufferAttribute(new Float32Array(puckSpots.length).fill(1), 1));
  const pucks = new THREE.InstancedMesh(puckGeo, instMat, puckSpots.length); pucks.renderOrder = 1; pucks.name = 'pucks';
  puckSpots.forEach((p, i) => { _o.position.set(p.x, p.y, p.z); _o.rotation.set(0, 0, 0); _o.updateMatrix(); pucks.setMatrixAt(i, _o.matrix); p.flash = 0; });
  pucks.frustumCulled = false;
  root.add(pucks);

  // =============================== PLANTS
  function plant(x, z, scale = 1, tall = false) {
    const pr = 0.3 * scale;
    B.fixG.add(xf(new THREE.CylinderGeometry(pr, pr * 0.85, 0.55 * scale, 20), x, 0.275 * scale, z), '#161a2c');
    B.fixM.add(xf(new THREE.CylinderGeometry(pr * 0.92, pr * 0.92, 0.02, 20), x, 0.55 * scale, z), '#1a0f08');
    const n = tall ? 13 : 11;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + rng() * 0.4, tilt = 0.45 + rng() * 0.55, len = (tall ? 0.95 : 0.6) * scale * (0.7 + rng() * 0.5);
      const g = new THREE.SphereGeometry(1, 6, 4);
      xf(g, 0, 1, 0, 0, 0, 0, 0.1 * scale, 1, 0.025);          // leaf: long ellipsoid standing on its base
      xf(g, 0, 0, 0, 0, 0, 0, 1, len / 2, 1);
      xf(g, 0, 0, 0, tilt, a, 0);
      xf(g, x, 0.55 * scale, z);
      const shade = ['#2f7d46', '#3d9b57', '#22603a', '#4aa864'][i % 4];
      B.fixM.add(g, shade);
    }
    ao(x, z, 1.1 * scale, 1.1 * scale, 0.6, GCELL.blob);
  }
  plant(-6.6, BZ + 0.55, 1.1, true); plant(-3.95, BZ + 0.55); plant(3.95, BZ + 0.55); plant(6.62, BZ + 0.55, 1.1, true);
  plant(-2.5, FZ - 0.45, 0.95); plant(2.5, FZ - 0.45, 0.95); plant(-6.7, FZ - 0.5, 1.05, true); plant(6.7, FZ - 0.5, 1.05, true);

  // =============================== STOREFRONT (low / cut-away)
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x8fa6ff, transparent: true, opacity: 0.1, roughness: 0.04, metalness: 0.6, envMapIntensity: 1.6, depthWrite: false, side: THREE.DoubleSide });
  const GH = 1.25, ENT = 1.35;
  const glassGeos = [];
  for (const s of [-1, 1]) {
    const x0 = s * ENT, x1 = s * (W + 0.2), cx = (x0 + x1) / 2, w = Math.abs(x1 - x0);
    B.fixG.add(xf(BOX(w, 0.16, 0.14), cx, 0.08, FZ), '#20263a');
    B.fixG.add(xf(BOX(w, 0.05, 0.12), cx, GH + 0.025, FZ), '#2a3148');
    B.emit.add(xf(BOX(w, 0.015, 0.03), cx, GH + 0.055, FZ), '#bfd2ff', { ch: CH.out, seed: 0.9 });
    for (let x = x0; s > 0 ? x <= x1 + 0.01 : x >= x1 - 0.01; x += s * (w / 3)) B.fixG.add(xf(BOX(0.07, GH, 0.1), x, GH / 2, FZ), '#2a3148');
    glassGeos.push(xf(plane(w, GH - 0.16), cx, 0.16 + (GH - 0.16) / 2, FZ));
    // faint glass sheen (brighter toward the top rail) + inside threshold LED
    const sh = xf(plane(w, GH - 0.2), cx, 0.18 + (GH - 0.2) / 2, FZ - 0.012);
    { const uv = sh.attributes.uv; for (let k = 0; k < uv.count; k++) { const u = uv.getX(k), v = uv.getY(k); uv.setXY(k, 1 - v, u); } }
    B.glow.add(sh, new THREE.Color('#9fd8ff').multiplyScalar(0.12), { ch: CH.out, cell: GCELL.beam, seed: 0.91 });
    B.emit.add(xf(BOX(w - 0.1, 0.012, 0.03), cx, 0.006, FZ - 0.16), '#3ee8ff', { ch: CH.strip, seed: 0.92, mode: MODE.noMirror });
    glowFloor(cx, FZ - 0.45, w, 0.8, new THREE.Color('#3ee8ff').multiplyScalar(0.35), { ch: CH.strip, cell: GCELL.beam, seed: 0.92, swapUV: true });
  }
  B.emit.add(xf(plane(1.5, 0.5), 0, 0.014, FZ - 0.72, -Math.PI / 2), new THREE.Color(0.1, 0.1, 0.12), { ch: CH.sign, cell: ACELL.c3badge, seed: 0.93, mode: MODE.noMirror });
  const glass = new THREE.Mesh(mergeGeometries(glassGeos), glassMat); glass.renderOrder = 2; root.add(glass);
  // sliding entrance doors (2 instances)
  const slideGeo = mergeGeometries([xf(plane(ENT - 0.04, GH - 0.1), 0, (GH - 0.1) / 2 + 0.05, 0)]);
  const slides = new THREE.InstancedMesh(slideGeo, glassMat, 2); slides.renderOrder = 2; root.add(slides);
  const slideFrameGeo = mergeGeometries([xf(BOX(0.05, GH, 0.06), -(ENT - 0.04) / 2, GH / 2, 0), xf(BOX(0.05, GH, 0.06), (ENT - 0.04) / 2, GH / 2, 0), xf(BOX(ENT - 0.04, 0.05, 0.06), 0, GH - 0.025, 0), xf(BOX(ENT - 0.04, 0.05, 0.06), 0, 0.03, 0)]);
  const slideFrames = new THREE.InstancedMesh(slideFrameGeo, new THREE.MeshStandardMaterial({ color: 0x3a4260, roughness: 0.4, metalness: 0.5 }), 2); root.add(slideFrames);
  let doorsOpen = 0, doorsOpenT = -10;
  function setSlides(o) {
    for (let i = 0; i < 2; i++) {
      const s = i ? 1 : -1;
      _o.position.set(s * (ENT / 2 + o * (ENT - 0.1)), 0, FZ + 0.1 + (o > 0 ? 0.06 : 0)); _o.rotation.set(0, 0, 0); _o.updateMatrix();
      slides.setMatrixAt(i, _o.matrix); slideFrames.setMatrixAt(i, _o.matrix);
    }
    slides.instanceMatrix.needsUpdate = true; slideFrames.instanceMatrix.needsUpdate = true;
  }
  setSlides(0);
  // security gates + entry mat
  for (const s of [-1, 1]) {
    B.fixG.add(xf(new RoundedBoxGeometry(0.1, 1.25, 0.5, 1, 0.03), s * 1.15, 0.625, FZ - 0.7), '#dfe3ec');
    B.emit.add(xf(BOX(0.02, 1.05, 0.02), s * 1.09, 0.65, FZ - 0.7), '#8df3ff', { ch: CH.strip, seed: 0.27 });
  }
  B.fixM.add(xf(BOX(2.0, 0.012, 1.1), 0, 0.006, FZ - 0.72), '#0a0c14');
  // outside skyline cards (title / cinematic views)
  const skyMat = new THREE.MeshBasicMaterial({ map: skyTex, color: new THREE.Color(1, 1, 1), fog: false });
  const skyBack = new THREE.Mesh(plane(150, 37.5), skyMat); skyBack.position.set(0, 12, -60); root.add(skyBack);
  const skyFront = new THREE.Mesh(plane(150, 37.5), skyMat); skyFront.position.set(0, 12, 64); skyFront.rotation.y = Math.PI; root.add(skyFront);

  // =============================== LIGHT POOLS / MESH NET / SUNBEAMS
  const poolCols = [-5.1, -1.75, 1.75, 5.1], poolRows = [-8.2, -5.0, -1.8, 1.4, 4.6, 7.8];
  poolRows.forEach((z, r) => poolCols.forEach((x, c) => {
    const on = ((r + c) % 2 ? 0.75 : 0.25) + (r * 4 + c) * 0.004;
    glowFloor(x, z, 2.7, 2.7, '#eef0ff', { ch: CH.pool, cell: GCELL.blob, seed: on });
    // the fixture itself, seen only in the floor mirror (a crisp specular dot above each pool)
    B.emit.add(xf(plane(0.7, 2.4), x, ROOM.ceilingY, z, Math.PI / 2), new THREE.Color(1, 0.9, 0.8).multiplyScalar(30), { ch: CH.pool, mode: MODE.mirrorOnly, cell: ACELL.soft, seed: on });
  }));
  // mesh network lines between tables, kiosk and walls
  {
    const nodes = [[-3.4, -4.6], [3.4, -4.6], [-3.4, 3.6], [3.4, 3.6], [0, -0.5], [-5.6, -0.6], [5.6, -0.6], [0, -8.4], [0, 7.6], [-5.6, -7.4], [5.6, 6.2]];
    const links = [[0, 4], [1, 4], [2, 4], [3, 4], [0, 1], [2, 3], [0, 2], [1, 3], [5, 0], [6, 1], [5, 2], [6, 3], [7, 0], [7, 1], [8, 2], [8, 3], [9, 0], [10, 3]];
    for (const [a, b] of links) {
      const [x0, z0] = nodes[a], [x1, z1] = nodes[b], len = Math.hypot(x1 - x0, z1 - z0), ang = Math.atan2(x1 - x0, z1 - z0);
      glowFloor((x0 + x1) / 2, (z0 + z1) / 2, 0.11, len, '#34ffc0', { ch: CH.mesh, cell: GCELL.line, ry: ang, mode: MODE.pulse, speed: 3, seed: rng(), lift: 0.002, swapUV: true });
    }
    for (const [x, z] of nodes) glowFloor(x, z, 1.1, 1.1, '#6dffd8', { ch: CH.mesh, cell: GCELL.blob, mode: MODE.pulse, speed: 4, seed: rng(), lift: 0.003 });
  }
  // dawn sunbeams through the storefront (slanted, soft)
  for (let i = 0; i < 6; i++) {
    const x = -6.1 + i * 2.45, len = 14;
    const g = floorQuad(1.5, len);
    // beam cell: bright at u=0 → map u along length (from the glass inward)
    const uv = g.attributes.uv; for (let k = 0; k < uv.count; k++) { const u = uv.getX(k), v = uv.getY(k); uv.setXY(k, v, u); }
    xf(g, 0, 0, 0, 0, 0.32, 0);
    xf(g, x - 1.9, 0.016, FZ - len / 2 * Math.cos(0.32) - 0.1, 0, 0, 0);
    B.glow.add(g, '#ffc58a', { ch: CH.sun, cell: GCELL.beam, seed: 0.95 });
  }

  // =============================== BUILD MERGED MESHES
  const meshes = {};
  const mk = (name, batch, mat, o = {}) => {
    if (!batch.parts.length) return null;
    const m = new THREE.Mesh(batch.geometry(), mat); m.name = name;
    m.castShadow = !!o.cast; m.receiveShadow = !!o.receive; if (o.ro != null) m.renderOrder = o.ro;
    root.add(m); meshes[name] = m; return m;
  };
  mk('shell', B.shell, matte, { receive: true });
  mk('outside', B.out, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, envMapIntensity: 0.08 }), { receive: true });
  mk('shellGloss', B.shellGloss, gloss, { receive: true });
  mk('fixMatte', B.fixM, matte, { cast: true, receive: true });
  mk('fixGloss', B.fixG, gloss, { cast: true, receive: true });
  const emitMesh = mk('emissive', B.emit, emitMat, { ro: 1 });
  mk('glow', B.glow, glowMat, { ro: 3 });
  mk('ao', B.ao, aoMat, { ro: 1 });
  // mirrored emissives under the floor (fake planar reflection, see header)
  const mirror = new THREE.Group(); mirror.name = 'floorMirror'; mirror.scale.y = -1; root.add(mirror);
  const emitMirror = new THREE.Mesh(emitMesh.geometry, emitMirrorMat); emitMirror.renderOrder = -5; emitMirror.frustumCulled = false;
  mirror.add(emitMirror, dockMirror);

  // siren sweep (boss moods): rotating two-beam decal on the floor
  const sweepMat = new THREE.ShaderMaterial({
    uniforms: { map: { value: sweepTex }, cA: { value: new THREE.Color() }, cB: { value: new THREE.Color() }, k: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'uniform sampler2D map; uniform vec3 cA; uniform vec3 cB; uniform float k; varying vec2 vUv; void main(){ vec4 t = texture2D(map, vUv); gl_FragColor = vec4((t.r * cA + t.g * cB) * k, 1.0); }',
    blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
  });
  const sweep = new THREE.Mesh(floorQuad(26, 26), sweepMat); sweep.position.set(0, 0.02, -0.5); sweep.renderOrder = 3; sweep.visible = false; root.add(sweep);

  // =============================== LIGHTS
  const hemi = new THREE.HemisphereLight(0x6c7fd0, 0x1c1030, 0.7); root.add(hemi);
  const rim = new THREE.DirectionalLight(0x9d8cff, 1.6); rim.position.set(0, 9, -10); root.add(rim); root.add(rim.target);
  const pl = [new THREE.PointLight(0x8a4dff, 20, 18, 1.6), new THREE.PointLight(0x2fbfff, 14, 14, 1.6), new THREE.PointLight(0xff3ec8, 14, 14, 1.6)];
  pl[0].position.set(0, 4.6, BZ + 0.9); pl[1].position.set(-W + 1.3, 2.6, -0.8); pl[2].position.set(W - 1.3, 2.6, -0.8);
  pl.forEach((p) => root.add(p));
  const key = gfx.key;

  // =============================== ENVIRONMENT (PMREM of a tinted room scene)
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const envMats = {};
  {
    const mat = (k) => (envMats[k] = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.BackSide }));
    const room = new THREE.Mesh(new THREE.BoxGeometry(16, 8, 24), mat('base')); room.position.y = 3; envScene.add(room);
    const panel = (k, w, h, x, y, z, ry, rx = 0) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), envMats[k] || mat(k)); m.material.side = THREE.DoubleSide; m.position.set(x, y, z); m.rotation.set(rx, ry, 0); envScene.add(m); };
    panel('back', 5, 1.6, -0.6, 4.5, -11.5, 0); panel('back2', 3, 1.0, 2.2, 5.3, -11.5, 0);
    for (const z of [-7.4, -4, -0.6, 2.8, 6.2]) { panel('left', 1.6, 2.0, -7.8, 2.2, z, Math.PI / 2); panel('right', 1.6, 2.0, 7.8, 2.2, z, -Math.PI / 2); }
    for (const x of [-4, 0, 4]) for (const z of [-7, -2, 3, 8]) panel('ceil', 1.4, 1.4, x, 6.9, z, 0, Math.PI / 2);
    panel('front', 16, 3, 0, 1.6, 11.8, Math.PI);
  }
  const envCache = new Map();
  function getEnv(k) {
    if (envCache.has(k)) return envCache.get(k);
    const E = ENVS[k] || ENVS.cool;
    envMats.base.color.set(E.base);
    const set = (m, c, i) => m.color.set(c).multiplyScalar(i);
    set(envMats.ceil, E.ceil, E.ceilI); set(envMats.back, E.back, E.backI); set(envMats.back2, E.back2, E.backI);
    set(envMats.left, E.left, E.leftI); set(envMats.right, E.right, E.rightI); set(envMats.front, E.front, E.frontI);
    const rt = pmrem.fromScene(envScene, 0.035, 0.1, 60, { size: 128, position: new THREE.Vector3(0, 1.6, 0) });
    envCache.set(k, rt.texture);
    return rt.texture;
  }

  // =============================== MOOD STATE
  let moodName = 'title';
  const cur = copyState({}, flattenMood('title'));
  let from = copyState({}, cur), to = flattenMood('title');
  let transT = 1, transDur = 1.5, envSwapped = true, lastSimMood = null;
  scene.environment = getEnv(cur.env);
  function setMood(name, instant) {
    if (!MOODS[name]) name = 'close';
    if (name === moodName && !instant) return;
    moodName = name;
    from = copyState({}, cur);
    to = flattenMood(name);
    transT = instant ? 1 : 0; envSwapped = false;
    if (instant) { copyState(cur, to); scene.environment = getEnv(to.env); envSwapped = true; applyState(0, 0); }
  }

  // =============================== EVENTS
  let T = 0;
  const allPerch = SPAWNS.map((s) => ({ ...s }));
  function nearestPerch(x, y, z, filter) {
    let best = null, bd = 1e9;
    for (const s of allPerch) { if (filter && !filter(s)) continue; const d = (s.x - x) ** 2 + (s.z - z) ** 2 + ((s.y - (y || 0)) ** 2) * 0.25; if (d < bd) { bd = d; best = s; } }
    return bd < 4 ? best : null;
  }
  let doorOpenT = -10;
  function event(ev) {
    if (!ev || ev.type !== 'spawn') return;
    const fam = KIND_DIMS[ev.kind] && KIND_DIMS[ev.kind].family;
    const p = nearestPerch(ev.x, ev.y, ev.z);
    if (!p) return;
    if (p.for === 'phone') {
      const ps = phoneState.find((q) => q.id === p.id);
      if (ps) {
        ps.flash = 1;
        if (fam === 'phone') { ps.hidden = true; ps.restockAt = T + 20; ps.flicker = 0; }
      }
    } else if (p.for === 'modem') {
      const pk = puckSpots.find((q) => Math.abs(q.x - p.x) < 0.05 && Math.abs(q.z - p.z) < 0.05);
      if (pk) pk.flash = 1;
    } else if (p.id === 'backroom') { doorOpenT = T; }
    else if (p.id === 'front') { doorsOpenT = T; }
  }

  // =============================== QUALITY
  let q = gfx.quality;
  function setQuality(nq) {
    q = clamp(nq | 0, 0, 3);
    mirror.visible = q >= 1;
    const pOn = q >= 1;
    if (pl[0].visible !== pOn) { pl.forEach((p) => { p.visible = pOn; }); }
    const an = [2, 4, 8, 8][q];
    for (const t of [floorT.tex, floorT.rough]) if (t.anisotropy !== an) { t.anisotropy = an; t.needsUpdate = true; }
    uReflect.value = q >= 2 ? 0.28 : 0.24;
  }
  setQuality(q);
  gfx.onQuality((nq) => setQuality(nq));

  // =============================== UPDATE
  const _col = new THREE.Color();
  let flickT = 0, keyFlick = 1, hemiFlick = 1, plFlick = [1, 1, 1];
  function applyState(t, dt) {
    const s = cur;
    // channels → uniforms
    for (let i = 0; i < NCH; i++) {
      const c = s.ch[i];
      chA[i].set(c.i, c.f, c.on, c.h * (s.party > 0 ? 1 : 1));
      chT[i].set(c.t.r, c.t.g, c.t.b, c.tm);
    }
    // grade
    const G = gfx.grade;
    G.exposure = s.exposure; G.sat = s.sat; G.contrast = s.contrast; G.vignette = s.vignette; G.bloom = s.bloom;
    G.tint.copy(s.tint); G.vigColor.copy(s.vigColor);
    if (scene.background && scene.background.isColor) scene.background.copy(s.bg);
    scene.environmentIntensity = s.envI;
    // lights (+ strobe / flicker / party)
    const strobe = s.strobe;
    const sq = (f, ph) => (Math.sin((t * f + ph) * TAU) > 0 ? 1 : 0);
    hemi.color.copy(s.hemiSky); hemi.groundColor.copy(s.hemiGround); hemi.intensity = s.hemi * hemiFlick;
    key.color.copy(s.key); key.intensity = s.keyI * keyFlick;
    rim.color.copy(s.rim); rim.intensity = s.rimI * (1 - strobe * 0.25 + strobe * 0.25 * sq(1.3, 0));
    rim.position.copy(s.rimDir).multiplyScalar(14); rim.target.position.set(0, 0, 0);
    for (let i = 0; i < 3; i++) {
      pl[i].color.copy(s.p[i].c);
      let k = 1;
      if (strobe > 0) k = lerp(1, i === 0 ? 0.55 + 0.45 * Math.abs(Math.sin(t * 2.2)) : 0.15 + 1.35 * sq(2.4, i * 0.5), strobe);
      if (s.party > 0) { pl[i].color.offsetHSL(((t * 0.08 + i * 0.33) % 1) * s.party * 0.25, 0, 0); k *= lerp(1, 0.7 + 0.3 * Math.sin(t * 4 + i * 2), s.party); }
      pl[i].intensity = s.p[i].i * k * plFlick[i];
    }
    // sweep
    const sw = s.ch[CH.sweep].i;
    sweep.visible = sw > 0.01;
    if (sweep.visible) { sweep.rotation.y = -t * 1.7; sweepMat.uniforms.k.value = sw * 0.32; sweepMat.uniforms.cA.value.copy(s.sweepA); sweepMat.uniforms.cB.value.copy(s.sweepB); }
    // skyline / outside warmth
    skyMat.color.setRGB(1, 1, 1).lerp(_col.set('#ffb890'), clamp(s.ch[CH.sun].i, 0, 1) * 0.7).multiplyScalar(0.8 + 0.6 * clamp(s.ch[CH.sun].i, 0, 1));
  }

  function update(t, dt, state) {
    dt = clamp(dt || 0, 0, 0.05);
    if (t < T - 0.5) { // clock went backwards (new run): restock everything, close doors
      phoneState.forEach((ps) => { if (ps.hidden) ps.restockAt = t; });
      doorOpenT = -10; doorsOpenT = -10;
    }
    T = t;
    uTime.value = t % 3600;
    if (state && state.mood && state.mood !== lastSimMood) { lastSimMood = state.mood; setMood(state.mood); }
    // mood transition
    if (transT < 1) {
      transT = Math.min(1, transT + dt / transDur);
      lerpState(cur, from, to, smooth(transT));
      if (!envSwapped && transT >= 0.5) { scene.environment = getEnv(to.env); envSwapped = true; }
    }
    // deadzone flicker of the real lights
    if (cur.flick > 0.01) {
      flickT -= dt;
      if (flickT <= 0) {
        flickT = 0.05 + Math.random() * 0.12;
        const r = Math.random();
        keyFlick = r < 0.07 * cur.flick ? 0.45 : 1 - Math.random() * 0.12 * cur.flick;
        hemiFlick = r < 0.05 * cur.flick ? 0.5 : 1;
        for (let i = 0; i < 3; i++) plFlick[i] = Math.random() < 0.18 * cur.flick ? 0.1 : 1 - Math.random() * 0.25 * cur.flick;
      }
    } else { keyFlick = 1; hemiFlick = 1; plFlick[0] = plFlick[1] = plFlick[2] = 1; }
    applyState(t, dt);

    // pucks flash decay
    const pib = puckGeo.attributes.aIB;
    let pdirty = false;
    puckSpots.forEach((p, i) => {
      if (p.flash > 0) { p.flash = Math.max(0, p.flash - dt * 1.6); pdirty = true; }
      const v = 1 + p.flash * 5 * (0.6 + 0.4 * Math.sin(t * 40 + i));
      if (pib.array[i] !== v) { pib.array[i] = v; pdirty = true; }
    });
    if (pdirty) pib.needsUpdate = true;
    // phones: hide / restock with flicker; dock flash
    const sib = scrGeo.attributes.aIB, dib = dockGeo.attributes.aIB;
    let mdirty = false, sdirty = false;
    phoneState.forEach((ps, i) => {
      if (ps.hidden && t >= ps.restockAt) { ps.hidden = false; ps.flicker = 0.9; mdirty = true; phoneBodies.setMatrixAt(i, ps.bodyM); phoneScreens.setMatrixAt(i, ps.scrM); }
      if (ps.hidden && !ps.applied) { _o.scale.set(0, 0, 0); _o.position.set(0, -50, 0); _o.updateMatrix(); phoneBodies.setMatrixAt(i, _o.matrix); phoneScreens.setMatrixAt(i, _o.matrix); _o.scale.set(1, 1, 1); mdirty = true; }
      ps.applied = ps.hidden;
      let sb = 1;
      if (ps.flicker > 0) { ps.flicker = Math.max(0, ps.flicker - dt); sb = Math.random() < 0.5 ? 0.15 : 1.8; }
      if (ps.flash > 0) ps.flash = Math.max(0, ps.flash - dt * 1.4);
      const db = 1 + ps.flash * 4 * (0.6 + 0.4 * Math.sin(t * 38 + i));
      if (sib.array[i] !== sb) { sib.array[i] = sb; sdirty = true; }
      if (dib.array[i] !== db) { dib.array[i] = db; sdirty = true; }
    });
    if (mdirty) { phoneBodies.instanceMatrix.needsUpdate = true; phoneScreens.instanceMatrix.needsUpdate = true; }
    if (sdirty) { sib.needsUpdate = true; dib.needsUpdate = true; }
    // back-room door swing
    const dtO = t - doorOpenT;
    const open = dtO >= 0 && dtO < 2.4 ? (dtO < 0.35 ? smooth(dtO / 0.35) : dtO > 1.7 ? 1 - smooth((dtO - 1.7) / 0.7) : 1) : 0;
    doorPivot.rotation.y = -open * 1.45;
    doorSpill.visible = open > 0.01; doorSpillMat.opacity = open * 0.55;
    doorWinMat.color.setRGB(0.5 + open * 2.5, 0.38 + open * 1.8, 0.2 + open * 1.0);
    // front sliding doors
    const dF = t - doorsOpenT;
    const so = dF >= 0 && dF < 2.6 ? (dF < 0.45 ? smooth(dF / 0.45) : dF > 1.9 ? 1 - smooth((dF - 1.9) / 0.7) : 1) : 0;
    if (so !== doorsOpen) { doorsOpen = so; setSlides(so); }
  }

  setMood('title', true);

  // Pre-warm: compile hidden-by-default materials now (siren sweep / door spill) so a boss intro never
  // stalls on a shader compile, and bake every mood's PMREM in the background (one per ~120 ms).
  try {
    sweep.visible = true; doorSpill.visible = true;
    renderer.compile(scene, gfx.camera);
  } catch (e) { /* compile is an optimisation only */ }
  sweep.visible = false; doorSpill.visible = false;
  { const keys = Object.keys(ENVS).filter((k) => !envCache.has(k)); const next = () => { const k = keys.shift(); if (!k) return; getEnv(k); setTimeout(next, 120); }; setTimeout(next, 400); }

  const perches = new Map(SPAWNS.map((s) => [s.id, { x: s.x, y: s.y, z: s.z }]));
  return {
    root, perches, update, setMood, event, setQuality,
    get mood() { return moodName; },
    lights: { hemi, rim, points: pl, key },
    meshes,
    moods: Object.keys(MOODS),
  };
}
