// =====================================================================================
// AFTER HOURS 3D — phones.js (PHONES agent)
// The phone family: iphone (THE FLIPPER), galaxy (THE SNIPER), fold (THE CHOMPER) as
// instanced crowds, plus THE FLAGSHIP (4 AM boss) as a unique rich rig.
// Stylised originals — no real logos / wordmarks / exact product replicas.
//
//   const phones = createPhones(scene, { capacity: 70 });
//   phones.sync(sim.state.enemies, t, dt);   // full enemy list; renders only phone kinds
//   phones.setQuality(q); phones.kinds;
//   const obj = phones.preview('iphone'); phones.previewUpdate(obj, t);
//
// Everything is built facing +Z, standing on y = 0, sized to KIND_DIMS.
// Draw calls: iphone 2, galaxy 2, fold 2, shared decals (shadows/halos/flares/sparks) 1,
// boss ~9 (only while the boss exists). Nothing allocates per frame.
// =====================================================================================
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { KIND_DIMS, KIND_COLORS } from './layout.js';

const TAU = Math.PI * 2;
const PI = Math.PI;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const sat = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = sat((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const easeOut = (t) => 1 - (1 - t) * (1 - t) * (1 - t);
const easeIn = (t) => t * t * t;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const hash1 = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
const prog = (e) => sat(e.stateT / Math.max(1e-3, e.stateDur || 0));

const OWN = ['iphone', 'galaxy', 'fold', 'boss_flagship'];
const SMALL = ['iphone', 'galaxy', 'fold'];

// ------------------------------------------------------------------------------------------
// Dimensions (metres). Heights match KIND_DIMS.h.
// ------------------------------------------------------------------------------------------
const D = {
  iphone: { w: 0.68, h: KIND_DIMS.iphone.h, t: 0.2, r: 0.18, b: 0.055 },
  galaxy: { w: 0.64, h: KIND_DIMS.galaxy.h, t: 0.17, r: 0.075, b: 0.036 },
  fold: { L: 0.66, H: KIND_DIMS.fold.h - 0.07, T: 0.13, r: 0.06, b: 0.032, rh: 0.07, hingeZ: -0.3 },
  boss: { L: 1.62, H: 4.2, T: 0.3, r: 0.16, b: 0.075, rh: 0.17 },
};
const FOLD_REST = 1.85; // resting jaw opening (rad) ~106 deg
const FOLD_WIDE = 2.16; // chomp windup ~124 deg

// ------------------------------------------------------------------------------------------
// Face atlas (canvas): 8 x 4 cells of 128 x 256. Channels are MASKS:
//   R = glow (tinted by the per-instance colour), G = hot core (white-ish), B = dim screen bg.
// ------------------------------------------------------------------------------------------
const CW = 128, CH = 256;
const C = {
  I_ANGRY: 0, I_BLINK: 1, I_SHOUT: 2, I_WARN: 3, I_DIZZY: 4, I_SQUINT: 5, I_LOOKL: 6, I_LOOKR: 7,
  G_ANGRY: 8, G_BLINK: 9, G_AIM: 10, G_FIRE: 11, G_DIZZY: 12, G_SQUINT: 13, G_LOOKL: 14, G_LOOKR: 15,
  F_ANGRY: 16, F_BLINK: 17, F_WIDE: 18, F_SNAP: 19, F_DIZZY: 20, F_SQUINT: 21, F_LOOK: 22, F_HURT: 23,
  X_EYES: 24, STATIC: 25,
};

function eyePts(cx, cy, w, h, dir, slant, n = 36) {
  // Almond eye (ellipse) whose top is clamped under a slanted lid line: outer corner high,
  // inner corner (toward the nose) low = angry. dir = -1 viewer-left eye, +1 viewer-right eye.
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    const x = cx + Math.cos(a) * w * 0.5;
    let y = cy + Math.sin(a) * h * 0.5;
    const tin = clamp(((x - cx) * -dir) / (w * 0.5), -1, 1); // +1 at the inner edge
    const lid = cy - h * 0.5 + h * slant * (0.5 + 0.5 * tin);
    y = Math.max(y, lid);
    pts.push([x, y]);
  }
  return pts;
}

function buildAtlas() {
  const cv = document.createElement('canvas');
  cv.width = CW * 8; cv.height = CH * 4;
  const g = cv.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, cv.width, cv.height);
  const R = 'rgb(255,0,0)', G = 'rgb(0,255,0)';
  const poly = (pts) => { g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]); g.closePath(); };
  const rrect = (x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
  const cell = (i, fn) => {
    g.save();
    const x = (i % 8) * CW, y = Math.floor(i / 8) * CH;
    g.beginPath(); g.rect(x, y, CW, CH); g.clip(); g.translate(x, y);
    fn(); g.restore();
  };
  const bg = (opt = {}) => {
    g.globalCompositeOperation = 'source-over';
    const s = opt.s ?? 1;
    const gr = g.createLinearGradient(0, 0, 0, CH);
    gr.addColorStop(0, `rgba(0,0,255,${0.62 * s})`);
    gr.addColorStop(0.45, `rgba(0,0,255,${0.36 * s})`);
    gr.addColorStop(1, `rgba(0,0,255,${0.5 * s})`);
    g.fillStyle = gr; g.fillRect(0, 0, CW, CH);
    // backlight bloom behind the eyes
    const rg = g.createRadialGradient(CW / 2, opt.ey ?? 92, 4, CW / 2, opt.ey ?? 92, 90);
    rg.addColorStop(0, `rgba(0,0,255,${0.45 * s})`); rg.addColorStop(1, 'rgba(0,0,255,0)');
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = rg; g.fillRect(0, 0, CW, CH);
    g.globalCompositeOperation = 'source-over';
    if (opt.island) { g.fillStyle = '#000'; rrect(CW / 2 - (opt.islandW ?? 21), 11, (opt.islandW ?? 21) * 2, 13, 6.5); g.fill(); }
    g.globalCompositeOperation = 'lighter';
  };
  const eye = (cx, cy, w, h, dir, slant, blur = 16, core = 0.9) => {
    const pts = eyePts(cx, cy, w, h, dir, slant);
    g.shadowColor = R; g.shadowBlur = blur; g.fillStyle = R; poly(pts); g.fill();
    g.shadowBlur = 0; poly(pts); g.fill();
    if (core > 0) {
      const c = eyePts(cx, cy + h * 0.12, w * 0.58, h * 0.52, dir, slant);
      g.fillStyle = `rgba(0,255,0,${core})`; g.shadowColor = G; g.shadowBlur = 6; poly(c); g.fill(); g.shadowBlur = 0;
    }
  };
  const line = (pts, width, color, blur = 8) => {
    g.lineCap = 'round'; g.lineJoin = 'round';
    g.strokeStyle = color; g.lineWidth = width; g.shadowColor = color; g.shadowBlur = blur;
    g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]); g.stroke();
    g.shadowBlur = 0;
  };
  const spiral = (cx, cy, rad, turns, width) => {
    const pts = []; const n = 40;
    for (let i = 0; i <= n; i++) { const a = (i / n) * turns * TAU; const r = rad * (i / n); pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
    line(pts, width, R, 10);
  };
  const xeye = (cx, cy, s, width) => { line([[cx - s, cy - s], [cx + s, cy + s]], width, R, 10); line([[cx + s, cy - s], [cx - s, cy + s]], width, R, 10); };
  const chevron = (cx, cy, s, dir, width) => { line([[cx - dir * s, cy - s * 0.8], [cx + dir * s * 0.6, cy], [cx - dir * s, cy + s * 0.8]], width, R, 10); };
  const zigMouth = (cx, cy, w, h, teeth) => {
    // angry toothy grimace: a thin rounded box with a zig-zag of teeth
    g.fillStyle = 'rgba(255,0,0,0.55)'; g.shadowColor = R; g.shadowBlur = 8;
    rrect(cx - w / 2, cy - h / 2, w, h, Math.min(h / 2, 6)); g.fill(); g.shadowBlur = 0;
    const pts = [];
    for (let i = 0; i <= teeth * 2; i++) pts.push([cx - w / 2 + 3 + (i / (teeth * 2)) * (w - 6), cy + ((i & 1) ? -h * 0.32 : h * 0.32)]);
    line(pts, 2.2, 'rgba(0,255,0,0.9)', 3);
  };
  const shoutMouth = (cx, cy, w, h) => {
    g.fillStyle = R; g.shadowColor = R; g.shadowBlur = 12;
    rrect(cx - w / 2, cy - h / 2, w, h, 10); g.fill(); g.shadowBlur = 0;
    // dark throat
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = '#000'; rrect(cx - w / 2 + 5, cy - h / 2 + 5, w - 10, h - 10, 7); g.fill();
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = 'rgba(255,0,0,0.35)'; rrect(cx - w / 2 + 5, cy - h / 2 + 5, w - 10, h - 10, 7); g.fill();
    // teeth (pixel blocks)
    g.fillStyle = 'rgba(0,255,0,0.95)';
    const n = 5, tw = (w - 12) / n;
    for (let i = 0; i < n; i++) { const x = cx - w / 2 + 6 + i * tw; g.fillRect(x + 1, cy - h / 2 + 5, tw - 3, 7); g.fillRect(x + 1, cy + h / 2 - 12, tw - 3, 7); }
  };

  // ---------------- iPHONE: round, big, expressive ----------------
  const IE = { y: 96, dx: 29, w: 50, h: 40, s: 0.62 };
  cell(C.I_ANGRY, () => { bg({ island: true }); eye(64 - IE.dx, IE.y, IE.w, IE.h, -1, IE.s); eye(64 + IE.dx, IE.y, IE.w, IE.h, 1, IE.s); zigMouth(64, 170, 50, 13, 4); });
  cell(C.I_LOOKL, () => { bg({ island: true }); eye(64 - IE.dx - 8, IE.y, IE.w, IE.h, -1, IE.s); eye(64 + IE.dx - 8, IE.y, IE.w, IE.h, 1, IE.s); zigMouth(60, 170, 50, 13, 4); });
  cell(C.I_LOOKR, () => { bg({ island: true }); eye(64 - IE.dx + 8, IE.y, IE.w, IE.h, -1, IE.s); eye(64 + IE.dx + 8, IE.y, IE.w, IE.h, 1, IE.s); zigMouth(68, 170, 50, 13, 4); });
  cell(C.I_BLINK, () => { bg({ island: true }); eye(64 - IE.dx, IE.y + 10, IE.w, 12, -1, 0.3, 12, 0.5); eye(64 + IE.dx, IE.y + 10, IE.w, 12, 1, 0.3, 12, 0.5); zigMouth(64, 170, 50, 13, 4); });
  cell(C.I_SHOUT, () => { bg({ island: true, islandW: 30, s: 1.2 }); eye(64 - IE.dx, IE.y - 4, IE.w + 6, IE.h + 10, -1, 0.72); eye(64 + IE.dx, IE.y - 4, IE.w + 6, IE.h + 10, 1, 0.72); shoutMouth(64, 172, 62, 44); });
  cell(C.I_WARN, () => {
    // inverted: the whole screen floods with glow, eyes/mouth cut out dark, island expanded
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = 'rgb(255,0,0)'; g.fillRect(0, 0, CW, CH);
    g.fillStyle = 'rgba(0,255,0,0.35)'; g.fillRect(0, 0, CW, CH);
    g.fillStyle = '#000';
    poly(eyePts(64 - IE.dx, IE.y, IE.w + 4, IE.h + 6, -1, 0.72)); g.fill();
    poly(eyePts(64 + IE.dx, IE.y, IE.w + 4, IE.h + 6, 1, 0.72)); g.fill();
    rrect(34, 150, 60, 36, 10); g.fill();
    rrect(CW / 2 - 40, 9, 80, 17, 8.5); g.fill();
    // "!" inside the expanded island
    g.fillStyle = 'rgb(255,255,0)'; g.fillRect(62, 11, 4, 9); g.fillRect(62, 22, 4, 3);
  });
  cell(C.I_DIZZY, () => { bg({ island: true, s: 0.8 }); spiral(64 - IE.dx, IE.y, 20, 2.2, 5); spiral(64 + IE.dx, IE.y, 20, 2.2, 5); line([[44, 172], [54, 166], [64, 174], [74, 166], [84, 172]], 4, R, 8); });
  cell(C.I_SQUINT, () => { bg({ island: true }); chevron(64 - IE.dx, IE.y, 14, -1, 7); chevron(64 + IE.dx, IE.y, 14, 1, 7); zigMouth(64, 170, 40, 11, 3); });

  // ---------------- GALAXY: narrow, sharp sniper slits ----------------
  const GE = { y: 92, dx: 30, w: 50, h: 26, s: 0.78 };
  const hud = (a = 0.55) => {
    const c = `rgba(255,0,0,${a})`, x0 = 10, x1 = 118, y0 = 60, y1 = 124, l = 12;
    for (const [x, y, dx, dy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]]) line([[x + dx * l, y], [x, y], [x, y + dy * l]], 2.5, c, 4);
  };
  const gbg = (s = 1) => { bg({ s, ey: 88 }); hud(); };
  cell(C.G_ANGRY, () => { gbg(); eye(64 - GE.dx, GE.y, GE.w, GE.h, -1, GE.s); eye(64 + GE.dx, GE.y, GE.w, GE.h, 1, GE.s); line([[40, 168], [88, 162]], 4, 'rgba(255,0,0,0.8)', 6); });
  cell(C.G_LOOKL, () => { gbg(); eye(64 - GE.dx - 9, GE.y, GE.w, GE.h, -1, GE.s); eye(64 + GE.dx - 9, GE.y, GE.w, GE.h, 1, GE.s); line([[34, 168], [80, 162]], 4, 'rgba(255,0,0,0.8)', 6); });
  cell(C.G_LOOKR, () => { gbg(); eye(64 - GE.dx + 9, GE.y, GE.w, GE.h, -1, GE.s); eye(64 + GE.dx + 9, GE.y, GE.w, GE.h, 1, GE.s); line([[48, 168], [94, 162]], 4, 'rgba(255,0,0,0.8)', 6); });
  cell(C.G_BLINK, () => { gbg(); line([[64 - GE.dx - 22, GE.y - 4], [64 - GE.dx + 22, GE.y + 6]], 5, R, 10); line([[64 + GE.dx + 22, GE.y - 4], [64 + GE.dx - 22, GE.y + 6]], 5, R, 10); line([[40, 168], [88, 162]], 4, 'rgba(255,0,0,0.8)', 6); });
  cell(C.G_AIM, () => {
    gbg(1.1);
    eye(64 - GE.dx, GE.y + 2, GE.w, GE.h * 0.55, -1, 0.85); // squinting left eye
    // right eye = targeting reticle
    const cx = 64 + GE.dx - 2, cy = GE.y;
    g.strokeStyle = R; g.lineWidth = 4; g.shadowColor = R; g.shadowBlur = 12;
    g.beginPath(); g.arc(cx, cy, 20, 0, TAU); g.stroke();
    g.lineWidth = 3; g.beginPath(); g.arc(cx, cy, 11, 0, TAU); g.stroke(); g.shadowBlur = 0;
    line([[cx - 30, cy], [cx - 14, cy]], 3, R, 6); line([[cx + 14, cy], [cx + 30, cy]], 3, R, 6);
    line([[cx, cy - 30], [cx, cy - 14]], 3, R, 6); line([[cx, cy + 14], [cx, cy + 30]], 3, R, 6);
    g.fillStyle = G; g.beginPath(); g.arc(cx, cy, 4.5, 0, TAU); g.fill();
    line([[40, 166], [88, 166]], 4, 'rgba(255,0,0,0.8)', 6);
  });
  cell(C.G_FIRE, () => {
    gbg(1.4);
    eye(64 - GE.dx, GE.y - 3, GE.w + 6, GE.h + 16, -1, 0.6); eye(64 + GE.dx, GE.y - 3, GE.w + 6, GE.h + 16, 1, 0.6);
    shoutMouth(64, 168, 46, 30);
  });
  cell(C.G_DIZZY, () => { gbg(0.8); spiral(64 - GE.dx, GE.y, 18, 2.2, 4.5); spiral(64 + GE.dx, GE.y, 18, 2.2, 4.5); line([[44, 168], [54, 162], [64, 170], [74, 162], [84, 168]], 4, R, 8); });
  cell(C.G_SQUINT, () => { gbg(); chevron(64 - GE.dx, GE.y, 13, -1, 6); chevron(64 + GE.dx, GE.y, 13, 1, 6); line([[44, 166], [84, 166]], 4, 'rgba(255,0,0,0.8)', 6); });

  // ---------------- FOLD panel (right panel; hinge on the LEFT of the cell, free edge RIGHT) ---
  const FE = { x: 50, y: 70, w: 62, h: 46, s: 0.8 };
  const teeth = (bright = 1, open = 1) => {
    // 5 big pixel fangs along the free edge, pointing toward the hinge
    const px = 4, th = 28, y0 = 108;
    for (let k = 0; k < 5; k++) {
      const ty = y0 + k * th;
      const n = th / px;
      for (let r = 0; r < n - 1; r++) {
        const f = 1 - Math.abs((r + 0.5) - (n - 1) / 2) / ((n - 1) / 2);
        const wpx = Math.max(1, Math.round((f * 40 * open) / px)) * px;
        g.fillStyle = `rgba(0,255,0,${0.95 * bright})`; g.fillRect(CW - 6 - wpx, ty + r * px, wpx, px);
        g.fillStyle = `rgba(255,0,0,${0.55 * bright})`; g.fillRect(CW - 6 - wpx, ty + r * px, wpx, px);
      }
    }
    // gum line along the free edge
    g.fillStyle = `rgba(255,0,0,${0.9 * bright})`; g.shadowColor = R; g.shadowBlur = 10;
    g.fillRect(CW - 7, y0 - 4, 7, 5 * th + 4); g.shadowBlur = 0;
    const gr = g.createLinearGradient(CW - 60, 0, CW, 0);
    gr.addColorStop(0, 'rgba(255,0,0,0)'); gr.addColorStop(1, `rgba(255,0,0,${0.16 * bright})`);
    g.fillStyle = gr; g.fillRect(CW - 60, y0 - 6, 60, 5 * th + 8);
  };
  const fbg = (s = 1) => bg({ s, ey: 70 });
  cell(C.F_ANGRY, () => { fbg(); eye(FE.x, FE.y, FE.w, FE.h, 1, FE.s); teeth(); });
  cell(C.F_LOOK, () => { fbg(); eye(FE.x + 10, FE.y, FE.w, FE.h, 1, FE.s); teeth(); });
  cell(C.F_BLINK, () => { fbg(); line([[FE.x - 26, FE.y + 10], [FE.x + 26, FE.y + 2]], 6, R, 10); teeth(); });
  cell(C.F_WIDE, () => { fbg(1.35); eye(FE.x, FE.y - 4, FE.w + 8, FE.h + 16, 1, 0.5); teeth(1.25, 1.25); });
  cell(C.F_SNAP, () => { fbg(1.2); chevron(FE.x, FE.y, 16, 1, 8); teeth(1.3, 1); });
  cell(C.F_DIZZY, () => { fbg(0.8); spiral(FE.x, FE.y, 22, 2.2, 5); teeth(0.6); });
  cell(C.F_SQUINT, () => { fbg(); chevron(FE.x, FE.y, 16, 1, 7); teeth(0.9); });
  cell(C.F_HURT, () => { fbg(); eye(FE.x, FE.y + 6, FE.w, FE.h * 0.5, 1, 0.8); teeth(0.8); });

  // ---------------- shared ----------------
  cell(C.X_EYES, () => { bg({ s: 0.7 }); xeye(36, 94, 14, 7); xeye(92, 94, 14, 7); });
  cell(C.STATIC, () => {
    g.globalCompositeOperation = 'source-over';
    for (let y = 0; y < CH; y += 4) for (let x = 0; x < CW; x += 4) {
      const v = Math.random(); g.fillStyle = `rgb(${(v * 200) | 0},${v > 0.85 ? 180 : 0},${(v * 120) | 0})`; g.fillRect(x, y, 4, 4);
    }
  });

  // Upload as a DataTexture from a CPU readback (rows flipped so v=1 is the canvas top). The
  // canvas->texImage2D path produced garbage mip levels under SwiftShader; this is deterministic.
  const src = g.getImageData(0, 0, cv.width, cv.height).data;
  const data = new Uint8Array(src.length);
  const rowB = cv.width * 4;
  for (let y = 0; y < cv.height; y++) data.set(src.subarray(y * rowB, (y + 1) * rowB), (cv.height - 1 - y) * rowB);
  const tex = new THREE.DataTexture(data, cv.width, cv.height, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 1; // NOTE: SwiftShader's anisotropic filtering returns noise; screens face the camera anyway
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return { tex, canvas: cv };
}

// ------------------------------------------------------------------------------------------
// Geometry: smooth-shaded rounded slab with separate bezel / band / back zones.
// Vertex attributes: position, normal, color (linear), aMR (metalness, roughness, glowMask).
// ------------------------------------------------------------------------------------------
function outline(w, h, r, seg) {
  const hw = w / 2, hh = h / 2;
  r = Math.min(r, hw - 1e-4, hh - 1e-4);
  const pts = [];
  const corners = [[hw - r, -hh + r, -PI / 2], [hw - r, hh - r, 0], [-hw + r, hh - r, PI / 2], [-hw + r, -hh + r, PI]];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (i / seg) * (PI / 2);
      pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, nx: Math.cos(a), ny: Math.sin(a) });
    }
  }
  return pts;
}

function Z(hex, metal, rough, glow = 0) { return { c: new THREE.Color(hex), m: metal, r: rough, g: glow }; }

// zones: { bezel, band, back } each a Z(); frontSplit/backSplit = arc fraction where band starts/ends.
function slabGeometry({ w, h, t, r, b, seg = 6, bseg = 3, zones, frontSplit = 0.34, backSplit = 0.66 }) {
  const ol = outline(w, h, r, seg);
  const n = ol.length;
  const rings = [];
  const fa = [], ba = [];
  for (let i = 0; i <= bseg; i++) fa.push((i / bseg) * (PI / 2));
  for (let i = 0; i <= bseg; i++) ba.push(PI / 2 + (i / bseg) * (PI / 2));
  const splitF = frontSplit * (PI / 2), splitB = PI / 2 + backSplit * (PI / 2);
  // front arc
  for (const a of fa) {
    if (a > splitF && (rings.length === 0 || rings[rings.length - 1].a < splitF)) {
      rings.push({ a: splitF, zc: 1, z: zones.bezel }); rings.push({ a: splitF, zc: 1, z: zones.band, brk: true });
    }
    rings.push({ a, zc: 1, z: a < splitF ? zones.bezel : zones.band });
  }
  // back arc
  for (const a of ba) {
    if (a > splitB && rings[rings.length - 1].a < splitB) {
      rings.push({ a: splitB, zc: -1, z: zones.band }); rings.push({ a: splitB, zc: -1, z: zones.back, brk: true });
    }
    rings.push({ a, zc: -1, z: a <= splitB ? zones.band : zones.back });
  }
  const pos = [], nor = [], col = [], mr = [], idx = [];
  const zc0 = t / 2 - b;
  for (const ring of rings) {
    const inset = b - b * Math.sin(ring.a);
    const z = ring.zc * zc0 + b * Math.cos(ring.a);
    const sa = Math.sin(ring.a), ca = Math.cos(ring.a);
    for (const p of ol) {
      pos.push(p.x - p.nx * inset, p.y - p.ny * inset + h / 2, z);
      const nx = p.nx * sa, ny = p.ny * sa, nz = ca; const l = Math.hypot(nx, ny, nz) || 1;
      nor.push(nx / l, ny / l, nz / l);
      col.push(ring.z.c.r, ring.z.c.g, ring.z.c.b);
      mr.push(ring.z.m, ring.z.r, ring.z.g);
    }
  }
  for (let k = 0; k < rings.length - 1; k++) {
    if (rings[k + 1].brk) continue;
    const A = k * n, B = (k + 1) * n;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      idx.push(A + i, B + i, A + j, A + j, B + i, B + j);
    }
  }
  // caps
  const contour = ol.map((p) => new THREE.Vector2(p.x - p.nx * b, p.y - p.ny * b));
  const tris = THREE.ShapeUtils.triangulateShape(contour, []);
  const front = 0, back = (rings.length - 1) * n;
  for (const tr of tris) {
    const [a, bq, c] = tr;
    const ax = contour[a].x, ay = contour[a].y, bx = contour[bq].x, by = contour[bq].y, cx = contour[c].x, cy = contour[c].y;
    const ccw = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax) > 0;
    if (ccw) { idx.push(front + a, front + bq, front + c); idx.push(back + a, back + c, back + bq); }
    else { idx.push(front + a, front + c, front + bq); idx.push(back + a, back + bq, back + c); }
  }
  const gm = new THREE.BufferGeometry();
  gm.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  gm.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  gm.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  gm.setAttribute('aMR', new THREE.Float32BufferAttribute(mr, 3));
  gm.setIndex(idx);
  return gm;
}

function paint(geom, z) {
  const g = geom.index ? geom : geom; // primitives are indexed
  g.deleteAttribute('uv');
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3), mr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col.set([z.c.r, z.c.g, z.c.b], i * 3); mr.set([z.m, z.r, z.g], i * 3); }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aMR', new THREE.BufferAttribute(mr, 3));
  return g;
}
function withSide(geom, side) {
  const n = geom.attributes.position.count;
  geom.setAttribute('aSide', new THREE.BufferAttribute(new Float32Array(n).fill(side), 1));
  return geom;
}
// A lens: metal ring + dark glass disk (glass carries the glow mask), axis along Z, facing `dir` (+1 front / -1 back)
function lens(x, y, z, rad, dir, ringZ, glassZ, glow = 1, depth = 0.04, ringGlow = 0, seg = 14) {
  // low-poly: open-ended ring + flat glass disc + pupil disc (~50 tris)
  const ring = paint(new THREE.CylinderGeometry(rad, rad * 1.06, depth, seg, 1, true), ringGlow ? Z('#' + ringZ.c.getHexString(), ringZ.m, ringZ.r, ringGlow) : ringZ);
  ring.rotateX(PI / 2); ring.translate(x, y, z + dir * depth / 2);
  const disc = (r, n, zc, g) => { const c = paint(new THREE.CircleGeometry(r, n), zc === 'glass' ? Z(glassZ, 0.3, 0.04, g) : zc); if (dir < 0) c.rotateY(PI); return c; };
  const glass = disc(rad * 0.76, seg, 'glass', glow); glass.translate(x, y, z + dir * (depth - 0.004));
  const face = paint(new THREE.RingGeometry(rad * 0.74, rad * 1.02, seg, 1), ringGlow ? Z('#' + ringZ.c.getHexString(), ringZ.m, ringZ.r, ringGlow) : ringZ);
  if (dir < 0) face.rotateY(PI); face.translate(x, y, z + dir * depth);
  const pupil = paint(new THREE.CircleGeometry(rad * 0.32, 8), Z('#1a2340', 0.5, 0.05, glow * 1.4)); if (dir < 0) pupil.rotateY(PI);
  pupil.translate(x, y, z + dir * (depth - 0.001));
  return [ring, face, glass, pupil];
}
function dot(x, y, z, r, dir, zone, seg = 10) {
  const c = paint(new THREE.CircleGeometry(r, seg), zone); if (dir < 0) c.rotateY(PI); c.translate(x, y, z); return c;
}

function buildIphoneGeometry() {
  const d = D.iphone, col = KIND_COLORS.iphone;
  const zones = { bezel: Z('#05060a', 0.05, 0.06), band: Z(col.trim, 0.95, 0.2), back: Z(col.body, 0.25, 0.3) };
  const parts = [slabGeometry({ w: d.w, h: d.h, t: d.t, r: d.r, b: d.b, seg: 5, bseg: 2, zones, frontSplit: 0.3, backSplit: 0.72 })];
  // camera bump (top-right seen from the front == top-left seen from the back)
  const bx = d.w / 2 - 0.19, by = d.h - 0.19, bz = -d.t / 2;
  const bump = slabGeometry({ w: 0.3, h: 0.3, t: 0.05, r: 0.085, b: 0.02, seg: 3, bseg: 1, zones: { bezel: Z(col.body, 0.3, 0.22), band: Z(col.body, 0.35, 0.3), back: Z('#50566a', 0.3, 0.35) } });
  bump.translate(bx, by - 0.15, bz - 0.012);
  parts.push(bump);
  const lz = bz - 0.035;
  for (const [ox, oy] of [[0.066, 0.066], [0.066, -0.066], [-0.07, 0.0]]) parts.push(...lens(bx + ox, by + oy, lz, 0.056, -1, Z(col.trim, 0.9, 0.2), '#070910', 1.3, 0.03));
  // flash (flashes during the leap warning)
  parts.push(dot(bx - 0.075, by + 0.085, lz - 0.02, 0.024, -1, Z('#fff2cc', 0.1, 0.3, 1.0)));
  const ms = paint(new THREE.RingGeometry(0.112, 0.162, 28, 1), Z('#101420', 0.2, 0.3, 1.9)); ms.rotateY(PI); ms.translate(0, d.h * 0.47, -d.t / 2 - 0.0015); parts.push(ms);
  const ms2 = paint(new THREE.PlaneGeometry(0.03, 0.075), Z('#101420', 0.2, 0.3, 1.7)); ms2.rotateY(PI); ms2.translate(0, d.h * 0.47 - 0.2, -d.t / 2 - 0.0015); parts.push(ms2);
  const gm = mergeGeometries(parts, false);
  return gm;
}

function buildGalaxyGeometry() {
  const d = D.galaxy, col = KIND_COLORS.galaxy;
  const zones = { bezel: Z('#05060a', 0.05, 0.05), band: Z(col.trim, 0.9, 0.24), back: Z(col.body, 0.35, 0.2) };
  const parts = [slabGeometry({ w: d.w, h: d.h, t: d.t, r: d.r, b: d.b, seg: 3, bseg: 2, zones, frontSplit: 0.3, backSplit: 0.7 })];
  // vertical row of three big lenses on the back (top-left from behind == +x from the front)
  const lx = d.w / 2 - 0.16, lz = -d.t / 2 + 0.002;
  for (let i = 0; i < 3; i++) parts.push(...lens(lx, d.h - 0.17 - i * 0.165, lz, 0.07, -1, Z(col.trim, 0.9, 0.22), '#08070f', 0.7, 0.045, 1.45));
  parts.push(dot(lx - 0.13, d.h - 0.17, lz - 0.004, 0.022, -1, Z('#ffe9f6', 0.1, 0.3, 0.8)));
  // punch-hole selfie cam on the screen (the snipe muzzle)
  parts.push(dot(0, d.h - 0.085, d.t / 2 + 0.004, 0.032, 1, Z('#020205', 0.4, 0.05, 1.0), 12));
  return mergeGeometries(parts, false);
}

function buildFoldGeometry() {
  const d = D.fold, col = KIND_COLORS.fold;
  const zones = { bezel: Z('#05060a', 0.05, 0.06), band: Z(col.trim, 0.9, 0.24), back: Z(col.body, 0.3, 0.26) };
  // panel slab: w = L (along x), h = H, t = T ; inner (screen) face at z = 0, back at z = -T
  const mk = (side) => {
    const g = slabGeometry({ w: d.L, h: d.H, t: d.T, r: d.r, b: d.b, seg: 3, bseg: 2, zones, frontSplit: 0.4, backSplit: 0.6 });
    g.translate(side * (d.rh + d.L / 2), 0.035, -d.T / 2);
    return withSide(g, side);
  };
  const parts = [mk(1), mk(-1)];
  // camera pill on the back of the LEFT panel
  const cx = -(d.rh + d.L - 0.14), cz = -d.T;
  const pill = slabGeometry({ w: 0.16, h: 0.42, t: 0.04, r: 0.075, b: 0.015, seg: 3, bseg: 1, zones: { bezel: Z(col.body, 0.3, 0.25), band: Z(col.trim, 0.8, 0.3), back: Z('#3a3150', 0.3, 0.3) } });
  pill.translate(cx, d.H - 0.5, cz - 0.01); parts.push(withSide(pill, -1));
  for (let i = 0; i < 3; i++) for (const p of lens(cx, d.H - 0.16 - i * 0.12, cz - 0.03, 0.045, -1, Z(col.trim, 0.9, 0.2), '#08070f', 0.5, 0.02, 0, 10)) parts.push(withSide(p, -1));
  // hinge spine (static) with glowing rings
  const hs = d.H + 0.07;
  const spine = paint(new THREE.CylinderGeometry(d.T * 0.92, d.T * 0.92, hs, 14, 1, true), Z(col.trim, 0.95, 0.18));
  spine.translate(0, hs / 2, 0); parts.push(withSide(spine, 0));
  for (const fy of [0.22, 0.5, 0.78]) {
    const rg = paint(new THREE.CylinderGeometry(d.T * 0.97, d.T * 0.97, 0.035, 14, 1, true), Z('#101010', 0.2, 0.3, 1.6));
    rg.translate(0, hs * fy, 0); parts.push(withSide(rg, 0));
  }
  const cap = paint(new THREE.SphereGeometry(d.T * 0.92, 14, 4, 0, TAU, 0, PI / 2), Z(col.trim, 0.95, 0.18));
  cap.translate(0, hs, 0); parts.push(withSide(cap, 0));
  return mergeGeometries(parts, false);
}

function screenPlane(w, h, x, y, z) {
  const g = new THREE.PlaneGeometry(w, h);
  g.translate(x, y, z);
  return g;
}
function buildScreens() {
  const di = D.iphone, dg = D.galaxy, df = D.fold;
  const iw = di.w - 2 * (di.b + 0.02), ih = di.h - 2 * (di.b + 0.02);
  const gw = dg.w - 2 * (dg.b + 0.018), gh = dg.h - 2 * (dg.b + 0.018);
  const fw = df.L - 2 * (df.b + 0.02), fh = df.H - 2 * (df.b + 0.02);
  const iphone = screenPlane(iw, ih, 0, di.h / 2, di.t / 2 + 0.0015);
  const galaxy = screenPlane(gw, gh, 0, dg.h / 2, dg.t / 2 + 0.0015);
  const fr = withSide(screenPlane(fw, fh, df.rh + df.L / 2, 0.035 + df.H / 2, 0.0015), 1);
  const fl = withSide(screenPlane(fw, fh, -(df.rh + df.L / 2), 0.035 + df.H / 2, 0.0015), -1);
  const uv = fl.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i)); // mirror
  const fold = mergeGeometries([fr, fl], false);
  return {
    iphone: { geom: iphone, scr: [iw, ih, di.r - di.b - 0.02] },
    galaxy: { geom: galaxy, scr: [gw, gh, 0.045] },
    fold: { geom: fold, scr: [fw, fh, 0.04] },
  };
}

// ------------------------------------------------------------------------------------------
// Materials
// ------------------------------------------------------------------------------------------
const FOLD_VERT = (attr) => `
{ float psi = -aSide * (3.14159265 - ${attr}) * 0.5; float cs = cos(psi), sn = sin(psi);
  transformed.xz = vec2(cs * transformed.x + sn * transformed.z, -sn * transformed.x + cs * transformed.z); }`;
const FOLD_NORM = (attr) => `
{ float psi = -aSide * (3.14159265 - ${attr}) * 0.5; float cs = cos(psi), sn = sin(psi);
  objectNormal.xz = vec2(cs * objectNormal.x + sn * objectNormal.z, -sn * objectNormal.x + cs * objectNormal.z); }`;

function makeBodyMaterial(glowHex, { fold = false, heat = false } = {}) {
  const m = new THREE.MeshPhysicalMaterial({
    vertexColors: true, metalness: 1, roughness: 1, clearcoat: 0.8, clearcoatRoughness: 0.08, envMapIntensity: 1.15,
  });
  const u = { uGlow: { value: new THREE.Color(glowHex) }, uHeat: { value: 0 }, uHeatCol: { value: new THREE.Color('#ff4a12') } };
  m.userData.u = u;
  if (fold) m.defines = { PH_FOLD: '' };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 aFx; attribute vec3 aMR;
#ifdef PH_FOLD
attribute float aSide;
#endif
varying vec4 vFx; varying vec3 vMR;`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
#ifdef PH_FOLD
${FOLD_NORM('aFx.w')}
#endif`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vFx = aFx; vMR = aMR;
#ifdef PH_FOLD
${FOLD_VERT('aFx.w')}
#endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec4 vFx; varying vec3 vMR; uniform vec3 uGlow; uniform float uHeat; uniform vec3 uHeatCol;`)
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vMR.x;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vMR.y;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{ float nv = saturate(dot(normal, normalize(vViewPosition)));
  float fr = pow(1.0 - nv, 3.0);
  totalEmissiveRadiance += vec3(1.8) * vFx.x;
  totalEmissiveRadiance += vec3(1.0, 0.66, 0.14) * vFx.y * (0.05 + 2.6 * fr);
  float gl = min(vMR.z, 1.0), gs = max(vMR.z - 1.0, 0.0);
  totalEmissiveRadiance += uGlow * (gl * (0.12 + vFx.z * 6.0) + gs * (1.7 + vFx.z * 3.0));
  totalEmissiveRadiance += uGlow * fr * 0.45;
  totalEmissiveRadiance += uHeatCol * uHeat * (0.25 + 1.8 * fr); }`);
  };
  m.customProgramCacheKey = () => 'phBody' + (fold ? 'F' : '');
  return m;
}

function makeDepthMaterialFold() {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aFx; attribute float aSide;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${FOLD_VERT('aFx.w')}`);
  };
  m.customProgramCacheKey = () => 'phDepthF';
  return m;
}

const SHARED_U = { uTime: { value: 0 }, uAtlas: { value: null } };

function makeScreenMaterial(scr, { fold = false } = {}) {
  const m = new THREE.MeshStandardMaterial({ color: 0x020306, roughness: 0.13, metalness: 0.0, envMapIntensity: 1.2 });
  m.defines = { SCR_W: scr[0].toFixed(4), SCR_H: scr[1].toFixed(4), SCR_R: Math.max(0.005, scr[2]).toFixed(4) };
  if (fold) m.defines.PH_FOLD = '';
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = SHARED_U.uTime; sh.uniforms.uAtlas = SHARED_U.uAtlas;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 aFace; attribute vec4 aTint;
#ifdef PH_FOLD
attribute float aSide;
#endif
varying vec4 vFace; varying vec4 vTint; varying vec2 vSUv;`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
#ifdef PH_FOLD
${FOLD_NORM('aTint.w')}
#endif`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vFace = aFace; vTint = aTint; vSUv = uv;
#ifdef PH_FOLD
${FOLD_VERT('aTint.w')}
#endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D uAtlas; uniform float uTime;
varying vec4 vFace; varying vec4 vTint; varying vec2 vSUv;
float phH(float n) { return fract(sin(n) * 43758.5453123); }
vec3 phScreen() {
  vec2 uv = vSUv;
  float cell = floor(vFace.x + 0.5);
  float glitch = vFace.w;
  float tt = floor(uTime * 20.0);
  if (glitch > 0.001) {
    float band = floor(uv.y * 22.0);
    float r = phH(band * 7.13 + tt * 3.1 + cell);
    uv.x += step(1.0 - glitch * 0.55, r) * (phH(band + tt * 1.7) - 0.5) * 0.4 * glitch;
  }
  vec2 cuv = vec2((mod(cell, 8.0) + clamp(uv.x, 0.004, 0.996)) / 8.0,
                  (3.0 - floor(cell / 8.0 + 0.01) + clamp(uv.y, 0.002, 0.998)) / 4.0);
  vec4 a = texture2D(uAtlas, cuv);
  vec3 tint = vTint.rgb;
  float lum = max(0.12, dot(tint, vec3(0.2126, 0.7152, 0.0722)));
  vec3 col = tint * (a.r * 2.4 * sqrt(0.35 / lum) + a.b * 0.045 / lum) + mix(tint, vec3(1.0), 0.6) * a.g * 1.6;
  col *= vFace.y;
  if (glitch > 0.001) {
    float nz = phH(dot(floor(uv * vec2(34.0, 70.0)), vec2(1.0, 57.0)) + tt * 13.0);
    col += tint * nz * max(0.0, glitch - 0.45) * 1.6 * step(0.55, nz);
  }
  float boot = vFace.z;
  if (boot < 0.999) {
    float on = step(0.27, boot);
    float k = clamp((boot - 0.3) / 0.62, 0.0, 1.0);
    float ln = 1.0 - k;
    float fl = 0.45 + 0.55 * step(0.32, phH(floor(uTime * 28.0) + cell * 1.7 + vTint.x * 9.0));
    float scan = exp(-pow((uv.y - ln) * 30.0, 2.0));
    float rows = 0.5 + 0.5 * sin(uv.y * 150.0 - uTime * 40.0);
    vec3 c = tint * (0.18 + 0.3 * rows) * step(ln, uv.y) + mix(tint, vec3(1.0), 0.65) * scan * 3.2;
    c += col * 0.55 * smoothstep(0.55, 1.0, k) * step(ln, uv.y);
    col = c * fl * on;
  }
  vec2 q = abs(uv - 0.5) * vec2(SCR_W, SCR_H) - (vec2(SCR_W, SCR_H) * 0.5 - SCR_R);
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - SCR_R;
  col *= smoothstep(0.003, -0.003, d);
  return col;
}`)
      .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance = phScreen();');
  };
  m.customProgramCacheKey = () => 'phScreen' + (fold ? 'F' : '') + scr.join(',');
  return m;
}

// Decals: blob shadows (premultiplied darkening), elite halos, muzzle flares, sparks — ONE draw call.
// Blend: ONE, ONE_MINUS_SRC_ALPHA  => shadows output (0,0,0,a); glows output (rgb,0) = additive.
function makeDecalMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    uniforms: { uTime: SHARED_U.uTime },
    vertexShader: `
      attribute vec4 aDecal; varying vec4 vD; varying vec2 vUv; varying vec3 vCol;
      void main() {
        vUv = uv; vD = aDecal;
        #ifdef USE_INSTANCING_COLOR
          vCol = instanceColor;
        #else
          vCol = vec3(1.0);
        #endif
        if (aDecal.x < 1.5) {
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        } else {
          vec4 c = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          float s = length(instanceMatrix[0].xyz);
          float st = aDecal.z > 0.0 ? aDecal.z : 1.0;   // stretch for sparks
          c.xy += position.xy * s * vec2(1.0, st);
          gl_Position = projectionMatrix * c;
        }
      }`,
    fragmentShader: `
      uniform float uTime; varying vec4 vD; varying vec2 vUv; varying vec3 vCol;
      void main() {
        vec2 p = vUv * 2.0 - 1.0; float r = length(p);
        vec4 o = vec4(0.0);
        if (vD.x < 0.5) {
          float a = pow(clamp(1.0 - r, 0.0, 1.0), 1.7) * vD.y;
          o = vec4(0.0, 0.0, 0.0, a);
        } else if (vD.x < 1.5) {
          float ring = exp(-pow((r - 0.8) / 0.055, 2.0)) * 1.2 + exp(-pow((r - 0.8) / 0.2, 2.0)) * 0.35;
          float tick = 0.75 + 0.25 * sin(atan(p.y, p.x) * 6.0 + uTime * 3.0);
          o = vec4(vCol * ring * tick * vD.y * (1.0 - smoothstep(0.86, 1.0, r)), 0.0);
        } else if (vD.x < 2.5) {
          float core = exp(-r * r * 22.0) * 3.0;
          float star = exp(-abs(p.y) * 26.0) * exp(-abs(p.x) * 2.2) + exp(-abs(p.x) * 26.0) * exp(-abs(p.y) * 3.0) * 0.6;
          float halo = exp(-r * r * 4.0) * 0.35;
          o = vec4(vCol * (core + star * 1.6 + halo) * vD.y * (1.0 - smoothstep(0.8, 1.0, max(abs(p.x), abs(p.y)))), 0.0);
        } else {
          float c = exp(-r * r * 7.0);
          o = vec4(vCol * c * vD.y * 2.2, 0.0);
        }
        gl_FragColor = o;
      }`,
  });
}

// ------------------------------------------------------------------------------------------
// Shared resources (built lazily once per page)
// ------------------------------------------------------------------------------------------
let RES = null;
function resources() {
  if (RES) return RES;
  const atlas = buildAtlas();
  SHARED_U.uAtlas.value = atlas.tex;
  const scr = buildScreens();
  RES = {
    atlas,
    geom: { iphone: buildIphoneGeometry(), galaxy: buildGalaxyGeometry(), fold: buildFoldGeometry() },
    screenGeom: { iphone: scr.iphone.geom, galaxy: scr.galaxy.geom, fold: scr.fold.geom },
    bodyMat: {
      iphone: makeBodyMaterial(KIND_COLORS.iphone.glow),
      galaxy: makeBodyMaterial(KIND_COLORS.galaxy.glow),
      fold: makeBodyMaterial(KIND_COLORS.fold.glow, { fold: true }),
    },
    screenMat: {
      iphone: makeScreenMaterial(scr.iphone.scr),
      galaxy: makeScreenMaterial(scr.galaxy.scr),
      fold: makeScreenMaterial(scr.fold.scr, { fold: true }),
    },
    foldDepth: makeDepthMaterialFold(),
    decalGeom: new THREE.PlaneGeometry(1, 1),
    decalMat: makeDecalMaterial(),
    glow: {
      iphone: new THREE.Color(KIND_COLORS.iphone.glow),
      galaxy: new THREE.Color(KIND_COLORS.galaxy.glow),
      fold: new THREE.Color(KIND_COLORS.fold.glow),
      boss_flagship: new THREE.Color(KIND_COLORS.boss_flagship.glow),
    },
    red: new THREE.Color('#ff3040'), amber: new THREE.Color('#ffb020'), white: new THREE.Color('#ffffff'), gold: new THREE.Color('#ffc53a'),
  };
  return RES;
}

// ------------------------------------------------------------------------------------------
// Instanced crowd of one small kind (body + screen)
// ------------------------------------------------------------------------------------------
class Crowd {
  constructor(kind, cap, parent) {
    this.kind = kind; this.parent = parent; this.n = 0; this.cap = 0; this.cast = false;
    this.alloc(cap);
  }
  alloc(cap) {
    const R = resources();
    if (this.body) { this.parent.remove(this.body); this.parent.remove(this.screen); this.body.dispose(); this.screen.dispose(); }
    this.cap = cap;
    this.body = new THREE.InstancedMesh(R.geom[this.kind], R.bodyMat[this.kind], cap);
    this.screen = new THREE.InstancedMesh(R.screenGeom[this.kind], R.screenMat[this.kind], cap);
    for (const m of [this.body, this.screen]) {
      m.frustumCulled = false; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.count = 0; m.visible = false;
      m.name = 'phones_' + this.kind;
    }
    this.fx = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.face = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.tint = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.body.geometry = R.geom[this.kind];
    // per-mesh instanced attributes must live on the geometry; geometries are shared per kind, so
    // each Crowd gets a lightweight geometry clone that shares the vertex buffers.
    this.body.geometry = shallowGeom(R.geom[this.kind]);
    this.body.geometry.setAttribute('aFx', this.fx);
    this.screen.geometry = shallowGeom(R.screenGeom[this.kind]);
    this.screen.geometry.setAttribute('aFace', this.face);
    this.screen.geometry.setAttribute('aTint', this.tint);
    if (this.kind === 'fold') this.body.customDepthMaterial = R.foldDepth;
    this.body.castShadow = this.cast;
    this.parent.add(this.body); this.parent.add(this.screen);
  }
  begin() { this.n = 0; }
  push(M, P, tint) {
    if (this.n >= this.cap) this.alloc(Math.ceil(this.cap * 1.6) + 4);
    const i = this.n++;
    const e = M.elements;
    this.body.instanceMatrix.array.set(e, i * 16);
    this.screen.instanceMatrix.array.set(e, i * 16);
    const f = this.fx.array, fa = this.face.array, ta = this.tint.array;
    f[i * 4] = P.flash; f[i * 4 + 1] = P.elite; f[i * 4 + 2] = P.lens; f[i * 4 + 3] = P.open;
    fa[i * 4] = P.cell; fa[i * 4 + 1] = P.bright; fa[i * 4 + 2] = P.boot; fa[i * 4 + 3] = P.glitch;
    ta[i * 4] = tint.r; ta[i * 4 + 1] = tint.g; ta[i * 4 + 2] = tint.b; ta[i * 4 + 3] = P.open;
  }
  end() {
    const n = this.n;
    this.body.count = n; this.body.visible = n > 0;
    this.screen.count = n; this.screen.visible = n > 0;
    if (n > 0) {
      touch(this.body.instanceMatrix, n * 16); touch(this.screen.instanceMatrix, n * 16);
      touch(this.fx, n * 4); touch(this.face, n * 4); touch(this.tint, n * 4);
    }
  }
  setCast(on) { this.cast = on; this.body.castShadow = on; }
}
function touch(attr, count) { attr.clearUpdateRanges(); attr.addUpdateRange(0, count); attr.needsUpdate = true; }
function shallowGeom(src) {
  const g = new THREE.BufferGeometry();
  for (const k in src.attributes) g.setAttribute(k, src.attributes[k]);
  g.setIndex(src.index);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.7, 0), 2);
  return g;
}

// Decal batch (shadows first, then glows)
class Decals {
  constructor(cap, parent) {
    const R = resources();
    this.parent = parent; this.cap = 0; this.alloc(cap);
    this.R = R;
  }
  alloc(cap) {
    const R = resources();
    if (this.mesh) { this.parent.remove(this.mesh); this.mesh.dispose(); }
    this.cap = cap;
    const g = shallowGeom(R.decalGeom);
    this.attr = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aDecal', this.attr);
    this.mesh = new THREE.InstancedMesh(g, R.decalMat, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 2; this.mesh.count = 0; this.mesh.name = 'phones_decals';
    this.parent.add(this.mesh);
    // glow queue (written after the shadows)
    this.q = new Float32Array(cap * 11); this.qn = 0; this.n = 0;
  }
  begin() { this.n = 0; this.qn = 0; }
  _grow() {
    const oldQ = this.q, oldQn = this.qn, oldN = this.n;
    const oldM = this.mesh.instanceMatrix.array.slice(0, oldN * 16), oldA = this.attr.array.slice(0, oldN * 4), oldC = this.mesh.instanceColor.array.slice(0, oldN * 3);
    this.alloc(this.cap * 2);
    this.mesh.instanceMatrix.array.set(oldM); this.attr.array.set(oldA); this.mesh.instanceColor.array.set(oldC);
    this.q.set(oldQ.subarray(0, oldQn * 11)); this.qn = oldQn; this.n = oldN;
  }
  // flat shadow blob on the floor
  shadow(x, z, rad, alpha) {
    if (this.n + this.qn + 1 >= this.cap) this._grow();
    const i = this.n++;
    const m = this.mesh.instanceMatrix.array, o = i * 16;
    m[o] = rad * 2; m[o + 1] = 0; m[o + 2] = 0; m[o + 3] = 0;
    m[o + 4] = 0; m[o + 5] = 0; m[o + 6] = -rad * 2; m[o + 7] = 0;
    m[o + 8] = 0; m[o + 9] = rad * 2; m[o + 10] = 0; m[o + 11] = 0;
    m[o + 12] = x; m[o + 13] = 0.012; m[o + 14] = z; m[o + 15] = 1;
    const a = this.attr.array; a[i * 4] = 0; a[i * 4 + 1] = alpha; a[i * 4 + 2] = 0; a[i * 4 + 3] = 0;
    const c = this.mesh.instanceColor.array; c[i * 3] = 0; c[i * 3 + 1] = 0; c[i * 3 + 2] = 0;
  }
  // glows: type 1 = floor ring, 2 = billboard flare, 3 = spark
  glow(type, x, y, z, size, alpha, col, stretch = 0) {
    if (this.n + this.qn + 1 >= this.cap) this._grow();
    const q = this.q, o = this.qn++ * 11;
    q[o] = type; q[o + 1] = x; q[o + 2] = y; q[o + 3] = z; q[o + 4] = size; q[o + 5] = alpha;
    q[o + 6] = col.r; q[o + 7] = col.g; q[o + 8] = col.b; q[o + 9] = stretch; q[o + 10] = 0;
  }
  end() {
    const m = this.mesh.instanceMatrix.array, a = this.attr.array, c = this.mesh.instanceColor.array, q = this.q;
    for (let k = 0; k < this.qn; k++) {
      const s = k * 11, i = this.n + k, o = i * 16, size = q[s + 4];
      m.fill(0, o, o + 16);
      if (q[s] < 1.5) { m[o] = size; m[o + 6] = -size; m[o + 9] = size; } else { m[o] = size; m[o + 5] = size; m[o + 10] = size; }
      m[o + 12] = q[s + 1]; m[o + 13] = q[s + 2]; m[o + 14] = q[s + 3]; m[o + 15] = 1;
      a[i * 4] = q[s]; a[i * 4 + 1] = q[s + 5]; a[i * 4 + 2] = q[s + 9]; a[i * 4 + 3] = 0;
      c[i * 3] = q[s + 6]; c[i * 3 + 1] = q[s + 7]; c[i * 3 + 2] = q[s + 8];
    }
    const n = this.n + this.qn;
    this.mesh.count = n; this.mesh.visible = n > 0;
    if (n > 0) {
      this.mesh.instanceMatrix.clearUpdateRanges(); this.mesh.instanceMatrix.addUpdateRange(0, n * 16); this.mesh.instanceMatrix.needsUpdate = true;
      this.attr.clearUpdateRanges(); this.attr.addUpdateRange(0, n * 4); this.attr.needsUpdate = true;
      this.mesh.instanceColor.clearUpdateRanges(); this.mesh.instanceColor.addUpdateRange(0, n * 3); this.mesh.instanceColor.needsUpdate = true;
    }
  }
}

// ------------------------------------------------------------------------------------------
// Pose (shared scratch — no allocations per frame)
// ------------------------------------------------------------------------------------------
const P = {
  ox: 0, oz: 0, hopY: 0, roll: 0, flip: 0, lean: 0, yaw: 0, sx: 1, sy: 1, sz: 1,
  cell: 0, bright: 1, boot: 1, glitch: 0, flash: 0, elite: 0, lens: 0, open: 0, flare: 0, shadow: 1,
};
const TINT = new THREE.Color();
const _M = new THREE.Matrix4(), _T = new THREE.Matrix4(), _V = new THREE.Vector3(), _V2 = new THREE.Vector3();

function resetPose(open) {
  P.ox = 0; P.oz = 0; P.hopY = 0; P.roll = 0; P.flip = 0; P.lean = 0; P.yaw = 0; P.sx = 1; P.sy = 1; P.sz = 1;
  P.cell = 0; P.bright = 1; P.boot = 1; P.glitch = 0; P.flash = 0; P.elite = 0; P.lens = 0; P.open = open; P.flare = 0; P.shadow = 1;
}

function newState(e, t) {
  return {
    id: e.id, seen: 0, seed: hash1(e.id * 1.37 + 0.5), gait: hash1(e.id * 3.1), px: e.x, pz: e.z, vf: 0, vs: 0,
    prevState: e.state, stateAge: 0, landT: 99, leaveP: -1, lastT: t,
  };
}

// Compose the root matrix from the sim transform + P. Pivots are in body-local units.
// halfW = half width at the bottom (roll pivot corners), cy = flip centre height.
function composeRoot(M, e, scale, halfW, cy) {
  M.makeRotationY(e.face + P.yaw);
  M.setPosition(e.x, e.y || 0, e.z);
  if (scale !== 1) M.scale(_V.set(scale, scale, scale));
  if (P.ox || P.oz || P.hopY) { _T.makeTranslation(P.ox, P.hopY, P.oz); M.multiply(_T); }
  if (P.roll) {
    const px = P.roll > 0 ? -halfW : halfW;
    _T.makeTranslation(px, 0, 0); M.multiply(_T);
    _T.makeRotationZ(P.roll); M.multiply(_T);
    _T.makeTranslation(-px, 0, 0); M.multiply(_T);
  }
  if (P.flip) {
    _T.makeTranslation(0, cy, 0); M.multiply(_T);
    _T.makeRotationX(P.flip); M.multiply(_T);
    _T.makeTranslation(0, -cy, 0); M.multiply(_T);
  }
  if (P.lean) { _T.makeRotationX(P.lean); M.multiply(_T); }
  if (P.sx !== 1 || P.sy !== 1 || P.sz !== 1) M.scale(_V.set(P.sx, P.sy, P.sz));
  return M;
}

// Volume-preserving squash (sy < 1 = squash)
function squash(sy) { P.sy *= sy; const k = 1 / Math.sqrt(Math.max(0.3, sy)); P.sx *= k; P.sz *= k; }

function blinkOrLook(s, t, base, blink, lookL, lookR) {
  const period = 2.6 + s.seed * 2.2;
  const bt = (t + s.seed * 13.7) % period;
  if (bt < 0.11) return blink;
  if (lookL >= 0) {
    const lt = Math.floor((t + s.seed * 5.3) / 1.7);
    const r = hash1(lt * 7.1 + s.seed * 31);
    if (r < 0.22) return lookL; if (r > 0.78) return lookR;
  }
  return base;
}

// ---- spawn (every small kind): dark -> buzz -> boot scan -> face SNAPS on -> peel off dock -> hop
function spawnPose(e, s, t, kindGlow) {
  const p = prog(e);
  const sf = e.spawnFrom;
  const perch = !!(sf && sf.y > 0.3);
  let away = 0;
  if (sf) { const dx = e.x - sf.x, dy = (e.y || 0) - sf.y, dz = e.z - sf.z; away = Math.sqrt(dx * dx + dy * dy + dz * dz); }
  const airborne = away > 0.05;
  if (airborne && s.leaveP < 0) s.leaveP = p;
  P.boot = p < 0.22 ? 0 : p < 0.46 ? 0.3 + ((p - 0.22) / 0.24) * 0.62 : 1;
  // vibrate on the dock like an incoming call
  if (p < 0.46) P.ox = Math.sin(t * 97 + s.seed * 10) * (p < 0.22 ? 0.014 : 0.008);
  const snap = p >= 0.46 ? Math.exp(-(p - 0.46) * 16) : 0;
  P.sx *= 1 + snap * 0.12; P.sz *= 1 + snap * 0.12; P.sy *= 1 + snap * 0.1;
  P.bright = 1 + snap * 1.2;
  if (perch) {
    // turn to glare at the camera (+Z) while docked so the boot reads from the top-down view
    let dy = -e.face; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    const turn = clamp(dy, -0.95, 0.95);
    if (!airborne) {
      const peel = smooth(0.46, 0.72, p);
      P.lean = lerp(-0.2, 0.16, peel);
      squash(1 - 0.12 * smooth(0.6, 0.78, p));
      P.yaw = turn * (0.55 + 0.45 * smooth(0.3, 0.5, p));
    } else {
      P.lean = 0.22 - 0.3 * smooth(0.7, 1, p);
      squash(1.1 - 0.2 * smooth(0.92, 1, p));
      P.yaw = turn * (1 - 0.6 * smooth(s.leaveP, 1, p));
    }
  } else {
    // door / floor spawn: stand up straight from a slight slump, then a hop-in (sim moves it)
    P.lean = lerp(-0.12, 0, smooth(0.4, 0.6, p));
    if (airborne) squash(1.08); else squash(1 - 0.1 * smooth(0.55, 0.7, p) * (1 - smooth(0.7, 0.75, p)));
  }
  TINT.copy(kindGlow);
  P.shadow = perch && !airborne ? 0 : 1;
}

function commonState(e, s, t, dt, kind, glow) {
  // returns true if handled (spawn/stun/dying)
  if (e.state === 'spawn') { spawnPose(e, s, t, glow); return true; }
  if (e.state === 'stun') {
    P.roll = Math.sin(t * 6.5 + s.seed * 9) * 0.13;
    P.yaw = Math.sin(t * 4.2 + s.seed * 3) * 0.12;
    P.cell = kind === 'iphone' ? C.I_DIZZY : kind === 'galaxy' ? C.G_DIZZY : C.F_DIZZY;
    P.glitch = 0.25; P.bright = 0.75 + 0.25 * Math.sin(t * 17);
    TINT.copy(glow);
    return true;
  }
  if (e.state === 'dying') {
    const p = prog(e);
    P.glitch = 1; P.cell = C.STATIC; P.bright = (1 - p) * (0.6 + 0.4 * Math.sin(t * 43));
    P.lean = -0.9 * easeIn(p); P.ox = Math.sin(t * 80) * 0.02;
    TINT.copy(glow);
    return true;
  }
  return false;
}

// ---------------------------------------- iPHONE ----------------------------------------
function poseIphone(e, s, t, dt, R) {
  const glow = R.glow.iphone;
  resetPose(0);
  TINT.copy(glow);
  P.cell = C.I_ANGRY;
  if (commonState(e, s, t, dt, 'iphone', glow)) {
    if (e.state === 'spawn') P.cell = C.I_ANGRY;
    return;
  }
  const p = prog(e), k = e.stateT;
  if (e.state === 'windup') {
    const c = easeOut(sat(p / 0.75));
    squash(1 - 0.27 * c);
    P.lean = -0.1 * c;
    P.ox = Math.sin(t * 72) * 0.014 * c;
    const on = (Math.floor(k * 11) & 1) === 0;
    P.cell = on ? C.I_WARN : C.I_SHOUT;
    if (on) TINT.copy(R.red);
    P.lens = on ? 1 : 0;
    P.bright = on ? 1.1 : 1.2;
  } else if (e.state === 'attack') {
    const turns = (e.stateDur || 0.6) > 0.95 ? 2 : 1;
    // quick unfurl, fast spin through the apex, slows to land upright
    const pf = sat(p);
    P.flip = TAU * turns * (pf < 0.5 ? 2 * pf * pf : 1 - 2 * (1 - pf) * (1 - pf));
    const st = Math.exp(-k * 9);
    P.sy *= 1 + 0.16 * st; P.sx *= 1 - 0.07 * st; P.sz *= 1 - 0.07 * st;
    if (pf > 0.85) squash(1 - 0.18 * smooth(0.85, 1, pf));
    P.cell = C.I_SHOUT; P.bright = 1.25;
  } else if (e.state === 'recover') {
    squash(1 - 0.3 * Math.exp(-k * 9) * Math.cos(k * 20));
    P.roll = 0.17 * Math.exp(-k * 4.5) * Math.sin(k * 17 + 0.4);
    P.cell = k < 0.3 ? C.I_SQUINT : C.I_ANGRY;
  } else {
    // move / idle: springy Luxo hops with a side-to-side waddle
    const amp = sat(e.spd / 1.5);
    s.gait += dt * (e.spd * 1.65);
    const ph = s.gait % 1;
    const hop = Math.sin(PI * ph);
    P.hopY = hop * 0.22 * amp;
    const contact = Math.max(0, 1 - Math.min(ph, 1 - ph) / 0.16);
    squash(1 + 0.08 * amp * hop - 0.16 * amp * contact * contact);
    P.roll = 0.1 * amp * hop * ((Math.floor(s.gait) & 1) ? 1 : -1);
    P.lean = clamp(s.vf * 0.06, -0.12, 0.2);
    squash(1 + 0.018 * Math.sin(t * 3.1 + s.seed * 6) * (1 - amp));
    P.cell = blinkOrLook(s, t, C.I_ANGRY, C.I_BLINK, C.I_LOOKL, C.I_LOOKR);
    if (s.landT < 0.4) squash(1 - 0.22 * Math.exp(-s.landT * 12) * Math.cos(s.landT * 22));
  }
}

// ---------------------------------------- GALAXY ----------------------------------------
function poseGalaxy(e, s, t, dt, R) {
  const glow = R.glow.galaxy;
  resetPose(0);
  TINT.copy(glow);
  P.cell = C.G_ANGRY;
  if (commonState(e, s, t, dt, 'galaxy', glow)) { if (e.state === 'spawn') P.cell = C.G_ANGRY; return; }
  const p = prog(e), k = e.stateT;
  if (e.state === 'windup') {
    P.lean = -0.08 * easeOut(p);
    squash(1 - 0.04 * p);
    const ch = Math.pow(p, 1.3);
    P.lens = ch * (0.85 + 0.15 * Math.sin(t * 45));
    if (p > 0.72) P.ox = Math.sin(t * 85) * 0.01;
    P.cell = C.G_AIM; P.bright = 1 + 0.5 * p;
    TINT.copy(glow).lerp(R.white, 0.15 * p);
    P.flare = smooth(0.35, 1, p) * 0.45 * (0.8 + 0.2 * Math.sin(t * 50));
  } else if (e.state === 'attack') {
    const r = sat(k / 0.03);
    P.lean = -0.36 * Math.exp(-k * 7) * r;
    P.oz = -0.2 * Math.exp(-k * 5) * r;
    P.flare = Math.exp(-k * 8) * 1.6;
    P.lens = Math.exp(-k * 4);
    P.cell = C.G_FIRE; P.bright = 1.4;
    squash(1 + 0.05 * Math.exp(-k * 10));
  } else if (e.state === 'recover') {
    P.lean = -0.05 * (1 - p);
    P.cell = k < 0.25 ? C.G_SQUINT : C.G_ANGRY;
    P.lens = Math.exp(-k * 4) * 0.3;
  } else {
    // menacing rocking waddle (pivots on its bottom corners), scanning when idle
    const amp = sat(e.spd / 1.3);
    s.gait += dt * (e.spd * 1.25);
    P.roll = Math.sin(TAU * s.gait) * 0.12 * amp;
    const idle = 1 - amp;
    P.yaw = Math.sin(t * 0.9 + s.seed * 6) * 0.1 * idle;
    P.lean = clamp(s.vf * 0.04, -0.1, 0.12) + 0.02 * Math.sin(t * 2.3 + s.seed) * idle;
    squash(1 + 0.012 * Math.sin(t * 2.6 + s.seed * 4) * idle);
    const side = s.vs;
    if (Math.abs(side) > 0.3) P.cell = side > 0 ? C.G_LOOKR : C.G_LOOKL;
    else P.cell = blinkOrLook(s, t, C.G_ANGRY, C.G_BLINK, C.G_LOOKL, C.G_LOOKR);
    if (s.landT < 0.4) squash(1 - 0.2 * Math.exp(-s.landT * 12) * Math.cos(s.landT * 22));
  }
}

// ----------------------------------------- FOLD -----------------------------------------
function poseFold(e, s, t, dt, R) {
  const glow = R.glow.fold;
  resetPose(FOLD_REST);
  TINT.copy(glow);
  P.cell = C.F_ANGRY;
  if (commonState(e, s, t, dt, 'fold', glow)) {
    if (e.state === 'spawn') {
      const p = prog(e);
      P.open = lerp(0.08, FOLD_REST, easeOut(smooth(0.46, 0.7, p)));
      P.cell = p < 0.6 ? C.F_SQUINT : C.F_ANGRY;
    } else if (e.state === 'stun') P.open = 1.2 + 0.25 * Math.sin(t * 3);
    else P.open = lerp(FOLD_REST, 2.9, prog(e));
    return;
  }
  const p = prog(e), k = e.stateT;
  if (e.state === 'windup') {
    const c = easeOut(sat(p / 0.55));
    P.open = lerp(FOLD_REST, FOLD_WIDE, c) + Math.sin(t * 38) * 0.03 * p;
    P.lean = -0.16 * c;
    P.sy *= 1 + 0.05 * c;
    P.ox = Math.sin(t * 60) * 0.012 * p;
    P.cell = C.F_WIDE; P.bright = 1.15 + 0.25 * Math.sin(t * 30);
    TINT.copy(glow).lerp(R.amber, 0.25 * p);
  } else if (e.state === 'attack') {
    const snapT = Math.min(0.11, (e.stateDur || 0.4) * 0.3);
    if (k < snapT) P.open = lerp(FOLD_WIDE, 0.07, easeIn(k / snapT));
    else P.open = 0.07 + 0.06 * Math.abs(Math.sin((k - snapT) * 45)) * Math.exp(-(k - snapT) * 9);
    P.lean = 0.26 * sat(k / 0.07) * (1 - smooth(0.6, 1, p));
    if (k >= snapT) squash(1 - 0.14 * Math.exp(-(k - snapT) * 12)); else P.sy *= 1.06;
    P.cell = C.F_SNAP; P.bright = 1.3;
  } else if (e.state === 'recover') {
    P.open = lerp(0.07, FOLD_REST, easeInOut(p));
    P.lean = 0.05 * (1 - p);
    P.cell = p < 0.5 ? C.F_SQUINT : C.F_ANGRY;
  } else {
    // lazy chattering-teeth clack + heavy little hop
    const amp = sat(e.spd / 1.1);
    s.gait += dt * (0.55 + e.spd * 0.8);
    const ph = s.gait % 1;
    let c;
    if (ph < 0.1) c = easeIn(ph / 0.1); else if (ph < 0.2) c = 1; else if (ph < 0.55) c = 1 - easeOut((ph - 0.2) / 0.35); else c = 0;
    P.open = lerp(FOLD_REST, 0.5, c * (0.5 + 0.5 * amp));
    const hp = ph > 0.12 && ph < 0.52 ? Math.sin(PI * (ph - 0.12) / 0.4) : 0;
    P.hopY = hp * 0.16 * amp;
    squash(1 + 0.06 * hp * amp - 0.12 * amp * (ph < 0.12 ? 1 - ph / 0.12 : 0));
    P.lean = clamp(s.vf * 0.05, -0.1, 0.16) - 0.05 * c;
    P.cell = c > 0.7 ? C.F_SNAP : blinkOrLook(s, t, C.F_ANGRY, C.F_BLINK, C.F_LOOK, C.F_LOOK);
    if (s.landT < 0.4) squash(1 - 0.22 * Math.exp(-s.landT * 12) * Math.cos(s.landT * 22));
  }
}

// ------------------------------------------------------------------------------------------
// THE FLAGSHIP — unique rig
// ------------------------------------------------------------------------------------------
const BOSS_SCREEN_GLSL = `
uniform float uTime, uBoot, uNotif, uPortal, uStatic, uCrt, uCrack, uGlitch, uHeat, uAlert;
uniform float uEyeOpen, uSquint, uMouth, uHp, uBright, uFlash, uXEyes, uCover, uCoverWarn, uCoverSpin;
uniform vec2 uLook;
uniform vec3 uGlow;
uniform vec4 uCrackSeg[28];
uniform float uCrackN;
varying vec2 vSUv;
float bH(float n) { return fract(sin(n) * 43758.5453123); }
float bH2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float sdBox(vec2 p, vec2 b) { vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
float sdSeg(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }
float fillD(float d, float aa) { return smoothstep(aa, -aa, d); }
// angry almond eye in mirrored eye-local coords (inner corner toward -x)
float eyeSD(vec2 q, vec2 r, float slant) {
  float de = (length(q / r) - 1.0) * min(r.x, r.y);
  float lid = (q.y - (r.y * (0.42 - slant * 0.62) + slant * 0.55 * q.x * (r.y / r.x) * 1.6)) / 1.2;
  return max(de, lid);
}
vec3 bossFace(vec2 fp, vec3 tint, float aa, out vec3 eyes) {
  vec3 col = vec3(0.0);
  eyes = vec3(0.0);
  // background: dim gradient, pixel grid, slow scan bar
  float gy = fp.y / SCR_H;
  col += tint * (0.03 + 0.035 * (1.0 - gy));
  vec2 gp = fract(fp * 16.0);
  col *= 0.8 + 0.2 * step(0.12, gp.x) * step(0.12, gp.y);
  col += tint * 0.06 * exp(-pow(fract(gy * 0.7 - uTime * 0.22) - 0.5, 2.0) * 90.0);
  // status bar: signal bars (left), battery = boss hp (right)
  float sy = SCR_H - 0.16;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float hb = 0.035 + fi * 0.03;
    float d = sdBox(fp - vec2(-1.55 + fi * 0.075, sy - 0.05 + hb * 0.5 - 0.035), vec2(0.022, hb * 0.5));
    col += mix(tint, vec3(1.0), 0.5) * fillD(d, aa) * (fi < 3.0 ? 0.9 : 0.25);
  }
  {
    vec2 bp = fp - vec2(1.42, sy - 0.035);
    float ob = abs(sdBox(bp, vec2(0.13, 0.055))) - 0.012;
    col += vec3(0.8) * fillD(ob, aa);
    col += vec3(0.8) * fillD(sdBox(bp - vec2(0.15, 0.0), vec2(0.015, 0.025)), aa);
    float w = 0.105 * clamp(uHp, 0.0, 1.0);
    vec3 bc = uHp > 0.5 ? vec3(0.3, 1.0, 0.45) : uHp > 0.25 ? vec3(1.0, 0.8, 0.2) : vec3(1.0, 0.2, 0.2);
    col += bc * 1.4 * fillD(sdBox(bp - vec2(-0.105 + w, 0.0), vec2(w, 0.033)), aa);
  }
  // eyes
  float side = fp.x < 0.0 ? -1.0 : 1.0;
  vec2 ep = vec2(abs(fp.x), fp.y) - vec2(0.92, 2.78) - vec2(uLook.x * side, uLook.y) * 0.12;
  float open = clamp(uEyeOpen, 0.05, 1.3);
  vec2 er = vec2(0.6, 0.42 * open);
  float slant = 0.55 + 0.35 * uSquint;
  float de = eyeSD(ep, er, slant);
  float xe = min(sdSeg(ep, vec2(-0.28, -0.28), vec2(0.28, 0.28)), sdSeg(ep, vec2(-0.28, 0.28), vec2(0.28, -0.28))) - 0.07;
  de = mix(de, xe, step(0.5, uXEyes));
  eyes += tint * 2.6 * fillD(de, aa) + tint * 0.55 * exp(-max(de, 0.0) * 7.0);
  eyes += mix(tint, vec3(1.0), 0.7) * 1.8 * fillD(eyeSD(ep - vec2(0.03, -0.07 * open), er * vec2(0.5, 0.45), slant) , aa * 3.0) * (1.0 - step(0.5, uXEyes));
  // brows
  vec2 bq = vec2(abs(fp.x), fp.y) - vec2(0.92, 2.8);
  float bd = sdSeg(bq, vec2(0.66, 0.56 - uSquint * 0.06), vec2(-0.52, 0.26 - uSquint * 0.12)) - 0.075;
  eyes += tint * 2.2 * fillD(bd, aa) + tint * 0.35 * exp(-max(bd, 0.0) * 8.0);
  col *= 1.0 - 0.8 * clamp(fillD(de - 0.04, aa * 3.0) + fillD(bd - 0.03, aa * 3.0), 0.0, 1.0);
  // mouth: toothy grimace (corners down); opens with uMouth
  vec2 mp = fp - vec2(0.0, 1.42);
  mp.y += 0.16 * pow(clamp(abs(mp.x) / 1.1, 0.0, 1.0), 2.0);
  float mh = 0.16 + 0.5 * uMouth;
  float md = sdBox(mp, vec2(1.18, mh)) - 0.06;
  float inside = fillD(md, aa);
  float rim = fillD(abs(md) - 0.035, aa);
  float tw = 0.19;
  float tx = abs(fract(mp.x / tw) * 2.0 - 1.0);
  float topT = step(mp.y, mh + 0.02) * step(mh - (0.12 + 0.06 * uMouth) * tx - 0.02, mp.y);
  float botT = step(-mh - 0.02, mp.y) * step(mp.y, -mh + (0.12 + 0.06 * uMouth) * (1.0 - tx) + 0.02);
  float teeth = clamp(topT + botT, 0.0, 1.0) * inside;
  col = mix(col, tint * 0.25 + vec3(0.02), inside * 0.85);
  col += tint * 2.2 * rim + mix(tint, vec3(1.0), 0.75) * 2.0 * teeth;
  col += tint * 0.3 * exp(-max(md, 0.0) * 6.0) * (1.0 - inside);
  // home indicator
  col += vec3(0.8) * fillD(sdBox(fp - vec2(0.0, 0.16), vec2(0.42, 0.018)) - 0.012, aa) * 0.8;
  return col;
}
vec3 notifLayer(vec2 fp, vec3 col, vec3 tint, float aa) {
  if (uNotif < 0.01) return col;
  vec2 cs = vec2(0.78, 0.34);
  vec2 id = floor(fp / cs);
  vec2 lp = (fract(fp / cs) - 0.5) * cs;
  float h = bH2(id + 3.7);
  float ph = fract(uTime * (0.8 + h * 0.9) + h * 7.0);
  float vis = step(h, uNotif * 0.62) * step(ph, 0.72);
  float pop = smoothstep(0.0, 0.07, ph) * (1.0 + 0.15 * exp(-ph * 30.0));
  vec2 hsz = cs * 0.43 * pop;
  float d = sdBox(lp, hsz - 0.05) - 0.05;
  float card = fillD(d, aa) * vis;
  vec3 cc = mix(tint, vec3(0.6, 0.8, 1.0), 0.35);
  vec3 c2 = col * (1.0 - card * 0.8) + cc * card * 0.22 + cc * fillD(abs(d) - 0.01, aa) * vis * 0.9;
  // text lines
  float tl = fillD(sdBox(lp - vec2(0.02, 0.04), vec2(hsz.x * 0.6, 0.018)), aa) + fillD(sdBox(lp - vec2(-0.06, -0.04), vec2(hsz.x * 0.45, 0.016)), aa);
  c2 += vec3(0.75) * tl * vis * 0.45;
  // icon square
  c2 += cc * 0.9 * fillD(sdBox(lp - vec2(-hsz.x + 0.1, 0.0), vec2(0.055)) - 0.02, aa) * vis;
  // red badge
  float bd = length(lp - vec2(hsz.x - 0.02, hsz.y - 0.02)) - 0.085 * pop;
  float pulse = 0.8 + 0.4 * sin(uTime * 18.0 + h * 20.0);
  c2 += vec3(1.0, 0.06, 0.1) * 3.0 * fillD(bd, aa) * vis * pulse + vec3(1.0, 0.1, 0.12) * 0.5 * exp(-max(bd, 0.0) * 14.0) * vis;
  c2 += vec3(1.0, 0.8, 0.8) * 0.9 * fillD(sdBox(lp - vec2(hsz.x - 0.02, hsz.y - 0.02), vec2(0.012, 0.04)), aa) * vis;
  return mix(col, c2, clamp(uNotif, 0.0, 1.0));
}
vec3 portalLayer(vec2 fp, vec3 col, vec3 tint, float aa) {
  if (uPortal < 0.01) return col;
  vec2 d = (fp - vec2(0.0, 1.45)) * vec2(1.0, 1.25);
  float r = length(d), a = atan(d.y, d.x);
  float sw = sin(a * 4.0 + r * 6.5 - uTime * 7.0);
  float arms = smoothstep(0.35, 1.0, sw) * exp(-r * 0.55);
  float rings = pow(0.5 + 0.5 * sin(r * 16.0 - uTime * 11.0), 8.0) * exp(-r * 0.7);
  vec3 pc = mix(vec3(0.3, 0.9, 1.0), tint, clamp(r / 1.6, 0.0, 1.0));
  vec3 c2 = col * 0.3 + pc * (arms * 1.1 + rings * 0.7) + mix(pc, vec3(1.0), 0.5) * exp(-r * r * 9.0) * 1.6;
  c2 *= 1.0 - 0.9 * exp(-r * r * 60.0); // dark eye of the portal
  // app icons streaming outward
  float sect = PI2 / 9.0;
  float ai = floor((a + PI) / sect);
  float rr = r - uTime * 0.7 + bH(ai) * 0.4;
  float ri = floor(rr / 0.5);
  vec2 lp = vec2((fract((a + PI) / sect) - 0.5) * sect * r, (fract(rr / 0.5) - 0.5) * 0.5);
  float sz = 0.06 + 0.07 * clamp(r / 1.6, 0.0, 1.0);
  float hh = bH(ai * 13.0 + ri * 7.0);
  float ic = fillD(sdBox(lp, vec2(sz)) - sz * 0.35, aa) * step(0.35, hh) * smoothstep(0.25, 0.6, r);
  vec3 icol = hh > 0.8 ? vec3(0.3, 1.0, 0.5) : hh > 0.65 ? vec3(1.0, 0.75, 0.2) : hh > 0.5 ? vec3(0.35, 0.65, 1.0) : vec3(1.0, 0.3, 0.7);
  c2 = mix(c2, icol * 1.6, ic);
  return mix(col, c2, clamp(uPortal, 0.0, 1.0));
}
vec3 bossPost(vec2 uv, vec2 fp, vec3 col, vec3 tint, float aa) {
  // cracks (phase >= 2)
  if (uCrackN > 0.5) {
    float dmin = 10.0;
    for (int i = 0; i < 28; i++) {
      if (float(i) >= uCrackN) break;
      vec4 s = uCrackSeg[i];
      dmin = min(dmin, sdSeg(fp, s.xy, s.zw));
    }
    float crack = fillD(dmin - 0.008, aa);
    col *= 1.0 - 0.55 * exp(-dmin * 26.0);
    col += vec3(0.9, 0.95, 1.0) * crack * 1.6 + tint * exp(-dmin * 40.0) * 0.4;
  }
  // glitch colour lines
  if (uGlitch > 0.01) {
    float row = floor(fp.y * 14.0);
    float tt = floor(uTime * 16.0);
    float gl = step(1.0 - uGlitch * 0.35, bH(row * 3.1 + tt));
    col = mix(col, col.gbr * 1.4 + vec3(0.2, 0.0, 0.3) * 0.5, gl * 0.8);
    col += vec3(0.4, 1.0, 1.0) * step(0.985 - uGlitch * 0.02, bH(floor(fp.y * 60.0) + tt * 5.0)) * uGlitch * 1.5;
  }
  if (uStatic > 0.01) {
    float n = bH2(floor(fp * vec2(46.0, 60.0)) + floor(uTime * 30.0) * 1.3);
    float roll = exp(-pow(fract(fp.y * 0.3 + uTime * 1.3) - 0.5, 2.0) * 40.0);
    col = mix(col, vec3(n) * (0.6 + 0.8 * roll) * mix(vec3(1.0), tint, 0.4) * 1.3, clamp(uStatic, 0.0, 1.0));
  }
  if (uAlert > 0.01) {
    vec2 e = min(uv, 1.0 - uv) * vec2(SCR_W, SCR_H);
    float ed = min(e.x, e.y);
    col += vec3(1.0, 0.1, 0.1) * exp(-ed * 9.0) * uAlert * 2.5;
  }
  col = mix(col, col * vec3(1.35, 0.55, 0.35) + vec3(0.25, 0.02, 0.0), uHeat * 0.6);
  col *= uBright;
  col += tint * uFlash * 0.8 + vec3(uFlash * 0.4);
  // boot
  if (uBoot < 0.999) {
    float on = step(0.27, uBoot);
    float k = clamp((uBoot - 0.3) / 0.62, 0.0, 1.0);
    float ln = 1.0 - k;
    float fl = 0.5 + 0.5 * step(0.3, bH(floor(uTime * 24.0)));
    float scan = exp(-pow((uv.y - ln) * 26.0, 2.0));
    float rows = 0.5 + 0.5 * sin(uv.y * 300.0 - uTime * 30.0);
    vec3 c = tint * (0.1 + 0.25 * rows) * step(ln, uv.y) + mix(tint, vec3(1.0), 0.6) * scan * 3.0;
    c += col * 0.6 * smoothstep(0.5, 1.0, k) * step(ln, uv.y);
    col = c * fl * on;
  }
  // CRT power-off
  if (uCrt > 0.001) {
    float sq = 1.0 - smoothstep(0.0, 0.5, uCrt);
    float cy = 0.5;
    float band = max(sq * 0.5, 0.004);
    float inb = step(abs(uv.y - cy), band);
    float lw = 1.0 - smoothstep(0.5, 0.92, uCrt);
    float lineV = exp(-pow((uv.y - cy) / 0.006, 2.0)) * step(abs(uv.x - 0.5), lw * 0.5 + 0.02);
    col = col * inb / max(sq, 0.25) + vec3(1.0) * lineV * 2.0 * (1.0 - smoothstep(0.9, 1.0, uCrt));
    col *= 1.0 - smoothstep(0.95, 1.0, uCrt);
  }
  return col;
}
`;

function makeBossScreenMaterial(side, sw, sh, gap, uniforms, cover = false) {
  const m = new THREE.MeshStandardMaterial({ color: 0x020307, roughness: 0.11, metalness: 0.0, envMapIntensity: 1.3 });
  m.defines = { B_SIDE: side.toFixed(1), SCR_W: sw.toFixed(4), SCR_H: sh.toFixed(4), B_GAP: gap.toFixed(4) };
  if (cover) m.defines.B_COVER = '';
  m.onBeforeCompile = (sh2) => {
    Object.assign(sh2.uniforms, uniforms);
    sh2.vertexShader = sh2.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vSUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSUv = uv;');
    sh2.fragmentShader = sh2.fragmentShader
      .replace('#include <common>', '#include <common>\n' + BOSS_SCREEN_GLSL + `
vec3 bossScreen() {
  vec2 uv = vSUv;
  vec3 tint = mix(uGlow, vec3(1.0, 0.24, 0.08), uHeat * 0.7);
  float aa = 0.012;
#ifdef B_COVER
  vec2 cp = (uv - 0.5) * vec2(SCR_W, SCR_H);
  vec3 col = tint * 0.05;
  // spinner (boot) - logo-less ring of dots
  if (uCoverSpin > 0.01) {
    vec2 sp = cp - vec2(0.0, 0.35);
    float a = atan(sp.y, sp.x); float r = length(sp);
    float seg = floor((a + PI) / (PI2 / 12.0));
    float tr = fract(seg / 12.0 + uTime * 1.3);
    float dotD = length(vec2((fract((a + PI) / (PI2 / 12.0)) - 0.5) * r * (PI2 / 12.0), r - 0.34)) - 0.045;
    col += mix(tint, vec3(1.0), 0.6) * fillD(dotD, aa) * (0.25 + 1.8 * tr) * uCoverSpin;
    float bar = fillD(sdBox(cp - vec2(0.0, -0.45), vec2(0.45, 0.018)), aa);
    float prog = fillD(sdBox(cp - vec2(-0.45 + 0.45 * uCoverSpin, -0.45), vec2(0.45 * uCoverSpin, 0.018)), aa);
    col += tint * (bar * 0.35 + prog * 2.0) * uCoverSpin;
  }
  // mini angry face
  {
    float side = cp.x < 0.0 ? -1.0 : 1.0;
    vec2 ep = vec2(abs(cp.x), cp.y) - vec2(0.36, 0.7);
    float de = eyeSD(ep, vec2(0.25, 0.15), 0.8);
    col += tint * (3.0 * fillD(de, aa) + 0.7 * exp(-max(de, 0.0) * 9.0)) * uCover;
  }
  // warning: red triangle + "!" (the FOLD slam)
  if (uCoverWarn > 0.01) {
    vec2 wp = cp - vec2(0.0, -0.3);
    vec2 q = vec2(abs(wp.x), wp.y + 0.2);
    float tri = max(q.x * 0.866 + q.y * 0.5 - 0.3, -q.y);
    float ring = fillD(abs(tri) - 0.035, aa);
    float ex = fillD(sdBox(wp - vec2(0.0, 0.06), vec2(0.03, 0.12)), aa) + fillD(length(wp - vec2(0.0, -0.14)) - 0.035, aa);
    float pulse = 0.6 + 0.4 * sin(uTime * 22.0);
    col += vec3(1.0, 0.12, 0.08) * (ring + ex) * 3.0 * uCoverWarn * pulse + vec3(1.0, 0.1, 0.05) * 0.25 * uCoverWarn * pulse;
  }
  vec2 fp = cp;
  if (uStatic > 0.01) {
    float n = bH2(floor(cp * vec2(40.0, 50.0)) + floor(uTime * 30.0));
    col = mix(col, vec3(n) * tint * 1.2, uStatic);
  }
  col *= uBright;
  col += tint * uFlash * 0.6;
  vec2 e = min(uv, 1.0 - uv) * vec2(SCR_W, SCR_H);
  col *= smoothstep(0.0, 0.02, min(e.x, e.y));
  return col;
#else
  vec2 fp = vec2(B_SIDE * (uv.x * SCR_W + B_GAP), uv.y * SCR_H);
  if (uGlitch > 0.01) {
    float band = floor(fp.y * 9.0); float tt = floor(uTime * 18.0);
    fp.x += step(1.0 - uGlitch * 0.5, bH(band * 5.7 + tt)) * (bH(band + tt * 2.3) - 0.5) * 0.5 * uGlitch;
  }
  vec3 eyes;
  vec3 col = bossFace(fp, tint, aa, eyes);
  col = notifLayer(fp, col, tint, aa);
  col = portalLayer(fp, col, tint, aa);
  col += eyes;
  col = bossPost(uv, fp, col, tint, aa);
  vec2 e = min(uv, 1.0 - uv) * vec2(SCR_W, SCR_H);
  col *= smoothstep(0.0, 0.025, min(e.x, e.y));
  return col;
#endif
}`)
      .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance = bossScreen();');
  };
  m.customProgramCacheKey = () => 'phBossScr' + side + (cover ? 'C' : '');
  return m;
}

function singleMesh(geom, mat) {
  const g = shallowGeom(geom);
  const fx = new THREE.InstancedBufferAttribute(new Float32Array(4), 4).setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('aFx', fx);
  const m = new THREE.InstancedMesh(g, mat, 1);
  m.setMatrixAt(0, new THREE.Matrix4());
  m.frustumCulled = false;
  m.userData.fx = fx;
  return m;
}

class Flagship {
  constructor(parent, decals) {
    this.parent = parent; this.decals = decals;
    const d = D.boss, col = KIND_COLORS.boss_flagship;
    this.d = d;
    this.glow = new THREE.Color(col.glow);
    const bodyMat = makeBodyMaterial(col.glow);
    this.bodyMat = bodyMat;
    const zones = { bezel: Z('#040509', 0.05, 0.05), band: Z('#aab3cc', 0.9, 0.3), back: Z(col.body, 0.35, 0.22) };
    // right panel: its BACK is the cover screen (dark glass); left panel back carries the camera array
    const zonesR = { bezel: zones.bezel, band: zones.band, back: Z('#07080d', 0.1, 0.06) };
    const mkPanel = (side, zz) => {
      const g = slabGeometry({ w: d.L, h: d.H, t: d.T, r: d.r, b: d.b, seg: 8, bseg: 4, zones: zz, frontSplit: 0.3, backSplit: 0.72 });
      g.translate(side * (d.rh + d.L / 2), 0.02, -d.T / 2);
      return g;
    };
    const partsL = [mkPanel(-1, zones)];
    // camera plateau + 3 big lenses + flash on the left panel's back
    const cx = -(d.rh + d.L - 0.5), cy = d.H - 0.62, cz = -d.T;
    const plate = slabGeometry({ w: 0.78, h: 0.95, t: 0.1, r: 0.22, b: 0.04, seg: 6, bseg: 2, zones: { bezel: Z(col.body, 0.4, 0.2), band: Z(col.trim, 0.9, 0.2), back: Z('#1d2236', 0.4, 0.2) } });
    plate.translate(cx, cy - 0.475, cz - 0.03); partsL.push(plate);
    for (const [ox, oy] of [[-0.17, 0.22], [0.17, 0.22], [-0.17, -0.2]]) partsL.push(...lens(cx + ox, cy + oy, cz - 0.08, 0.14, -1, Z(col.trim, 0.9, 0.2), '#07060d', 1.0, 0.06));
    const flash = paint(new THREE.CylinderGeometry(0.05, 0.05, 0.03, 14), Z('#fff0fa', 0.1, 0.3, 1.0));
    flash.rotateX(PI / 2); flash.translate(cx + 0.17, cy - 0.2, cz - 0.1); partsL.push(flash);
    const geomL = mergeGeometries(partsL, false);
    const geomR = mkPanel(1, zonesR);
    // spine with glow rings
    const hs = d.H + 0.12;
    const sp = [paint(new THREE.CylinderGeometry(0.16, 0.16, hs, 28, 1), Z(col.trim, 0.95, 0.16))];
    sp[0].translate(0, hs / 2, -0.11);
    for (const fy of [0.16, 0.38, 0.62, 0.84]) {
      const rg = paint(new THREE.CylinderGeometry(0.17, 0.17, 0.06, 28, 1), Z('#0c0c10', 0.2, 0.3, 1.0));
      rg.translate(0, hs * fy, -0.11); sp.push(rg);
    }
    const capG = paint(new THREE.SphereGeometry(0.16, 20, 8, 0, TAU, 0, PI / 2), Z(col.trim, 0.95, 0.16));
    capG.translate(0, hs, -0.11); sp.push(capG);
    const geomS = mergeGeometries(sp, false);
    // pop-up camera turret
    const tp = [slabGeometry({ w: 0.95, h: 0.46, t: 0.42, r: 0.16, b: 0.06, seg: 5, bseg: 2, zones: { bezel: Z('#0a0b12', 0.3, 0.15), band: Z(col.trim, 0.9, 0.2), back: Z(col.body, 0.4, 0.2) } })];
    for (const ox of [-0.27, 0, 0.27]) tp.push(...lens(ox, 0.23, 0.21, 0.1, 1, Z(col.trim, 0.9, 0.2), '#06050b', 1.0, 0.05));
    const neck = paint(new THREE.CylinderGeometry(0.1, 0.13, 0.5, 14), Z(col.trim, 0.95, 0.2)); neck.translate(0, -0.25, 0); tp.push(neck);
    const geomT = mergeGeometries(tp, false);

    // hierarchy: root(pos, yaw) > tilt(fall pivot) > rock(corner pivot) > body(scale) > parts
    this.root = new THREE.Group(); this.root.name = 'flagship';
    this.tilt = new THREE.Group(); this.tiltIn = new THREE.Group();
    this.rock = new THREE.Group(); this.rockIn = new THREE.Group();
    this.body = new THREE.Group();
    this.root.add(this.tilt); this.tilt.add(this.tiltIn); this.tiltIn.add(this.rock); this.rock.add(this.rockIn); this.rockIn.add(this.body);
    this.spine = singleMesh(geomS, bodyMat); this.body.add(this.spine);
    this.pL = new THREE.Group(); this.pR = new THREE.Group(); this.body.add(this.pL); this.body.add(this.pR);
    this.mL = singleMesh(geomL, bodyMat); this.mR = singleMesh(geomR, bodyMat);
    this.pL.add(this.mL); this.pR.add(this.mR);
    // screens
    const m = 0.1;
    const sw = d.L - 2 * m, sh = d.H - 2 * m, gap = d.rh + m;
    this.U = {
      uTime: SHARED_U.uTime, uBoot: { value: 1 }, uNotif: { value: 0 }, uPortal: { value: 0 }, uStatic: { value: 0 }, uCrt: { value: 0 },
      uCrack: { value: 0 }, uGlitch: { value: 0 }, uHeat: { value: 0 }, uAlert: { value: 0 }, uEyeOpen: { value: 1 }, uSquint: { value: 0 },
      uMouth: { value: 0 }, uHp: { value: 1 }, uBright: { value: 1 }, uFlash: { value: 0 }, uXEyes: { value: 0 }, uCover: { value: 0 },
      uCoverWarn: { value: 0 }, uCoverSpin: { value: 0 }, uLook: { value: new THREE.Vector2() }, uGlow: { value: this.glow.clone() },
      uCrackSeg: { value: Array.from({ length: 28 }, () => new THREE.Vector4()) }, uCrackN: { value: 0 },
    };
    this.buildCracks();
    const sR = new THREE.PlaneGeometry(sw, sh); sR.translate(d.rh + d.L / 2, 0.02 + d.H / 2, 0.003);
    const sL = new THREE.PlaneGeometry(sw, sh); sL.translate(-(d.rh + d.L / 2), 0.02 + d.H / 2, 0.003);
    { const uv = sL.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i)); }
    this.scrR = new THREE.Mesh(sR, makeBossScreenMaterial(1, sw, sh, gap, this.U));
    this.scrL = new THREE.Mesh(sL, makeBossScreenMaterial(-1, sw, sh, gap, this.U));
    const sc = new THREE.PlaneGeometry(sw, sh); sc.rotateY(PI); sc.translate(d.rh + d.L / 2, 0.02 + d.H / 2, -d.T - 0.003);
    this.scrC = new THREE.Mesh(sc, makeBossScreenMaterial(1, sw, sh, gap, this.U, true));
    this.pR.add(this.scrR); this.pL.add(this.scrL); this.pR.add(this.scrC);
    for (const s of [this.scrR, this.scrL, this.scrC]) s.frustumCulled = false;
    // turret
    this.tur = new THREE.Group(); this.turM = singleMesh(geomT, bodyMat); this.tur.add(this.turM);
    this.tur.position.set(0, d.H + 0.12, -0.11); this.body.add(this.tur);
    for (const mm of [this.spine, this.mL, this.mR, this.turM]) mm.castShadow = false;
    this.root.visible = false;
    parent.add(this.root);
    // cosmetic state
    this.sparks = []; for (let i = 0; i < 48; i++) this.sparks.push({ life: 0, max: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, s: 0 });
    this.spawnAcc = 0; this.gait = 0; this.id = -1; this.q = 2; this.lastT = 0;
    this.tmpC = new THREE.Color(); this.sparkCol = new THREE.Color('#ffd27a'); this.sparkHot = new THREE.Color('#ff7a2a'); this.heatGlow = new THREE.Color('#ff5a1a');
  }
  buildCracks() {
    // procedural crack web from two impact points (face-space metres)
    const segs = [];
    const web = (cx, cy, n, len, seed) => {
      for (let i = 0; i < n; i++) {
        let a = (i / n) * TAU + hash1(seed + i) * 0.5, x = cx, y = cy;
        const steps = 3;
        for (let k = 0; k < steps; k++) {
          const l = len * (0.35 + hash1(seed * 3 + i * 7 + k) * 0.5);
          const nx = x + Math.cos(a) * l, ny = y + Math.sin(a) * l;
          segs.push([x, y, nx, ny]);
          x = nx; y = ny; a += (hash1(seed + i * 13 + k * 5) - 0.5) * 0.9;
        }
      }
      // ring shards
      for (let i = 0; i < 5; i++) {
        const a0 = (i / 5) * TAU + 0.3, a1 = a0 + 0.9, r = len * 0.35;
        segs.push([cx + Math.cos(a0) * r, cy + Math.sin(a0) * r, cx + Math.cos(a1) * r, cy + Math.sin(a1) * r]);
      }
    };
    web(0.95, 2.05, 6, 0.55, 11);   // phase 2 (right screen)  -> 6*3 + 5 = 23 segs
    this.crackN2 = segs.length;
    web(-1.05, 1.1, 1, 0.5, 29);     // phase 3 adds a smaller second web (left) -> +3 +5 = 31, clamp to 28
    const arr = this.U.uCrackSeg.value;
    for (let i = 0; i < 28; i++) { const s = segs[i] || [0, 0, 0, 0]; arr[i].set(s[0], s[1], s[2], s[3]); }
    this.crackN3 = Math.min(28, segs.length);
  }
  hide() { this.root.visible = false; this.id = -1; }
  setQuality(q) { this.q = q; for (const mm of [this.spine, this.mL, this.mR, this.turM]) mm.castShadow = q >= 2; }
  setFx(mesh, flash, lens, heat) { const a = mesh.userData.fx.array; a[0] = flash; a[1] = 0; a[2] = lens; a[3] = 0; mesh.userData.fx.needsUpdate = true; }
  emitSpark(x, y, z, speed) {
    for (let i = 0; i < this.sparks.length; i++) { const s = this.sparks[i]; if (s.life > 0) continue;
      const a = Math.random() * TAU, u = Math.random() * 0.8 + 0.2;
      s.x = x; s.y = y; s.z = z; s.vx = Math.cos(a) * speed * u; s.vz = Math.sin(a) * speed * u; s.vy = speed * (0.6 + Math.random() * 0.9);
      s.life = s.max = 0.35 + Math.random() * 0.5; s.s = 0.08 + Math.random() * 0.09; return;
    }
  }
  update(e, t, dt, decals) {
    const d = this.d, U = this.U;
    if (this.id !== e.id) { this.id = e.id; this.gait = 0; this.prevState = e.state; this.prevPhase = e.phase || 1; this.phaseFlash = 0; for (let i = 0; i < this.sparks.length; i++) this.sparks[i].life = 0; }
    if (e.state !== this.prevState) { this.stateStart = t; this.prevState = e.state; }
    if ((e.phase || 1) !== this.prevPhase) { this.phaseFlash = 1; this.prevPhase = e.phase || 1; }
    this.phaseFlash = Math.max(0, this.phaseFlash - dt * 1.5);
    this.root.visible = true;
    const p = prog(e), k = e.stateT || 0, phase = e.phase || 1;
    // ---- defaults
    let open = 2.62, asym = 0, tilt = 0, tiltPivot = 1, rock = 0, sy = 1, twist = 0, lift = 0;
    let turUp = 0, turYaw = 0, lensG = 0.15, notif = 0, portal = 0, boot = 1, stat = 0, crt = 0, alert = 0;
    let eyeOpen = 1, squint = 0.2, mouth = 0.05, bright = 1, xeyes = 0, cover = 0, coverWarn = 0, coverSpin = 0;
    let shakeX = 0, shakeZ = 0, sparkRate = 0;
    const lookX = Math.sin(t * 0.7) * 0.5, lookY = Math.sin(t * 0.43) * 0.25;
    const blink = ((t + 0.3) % 3.7) < 0.12 ? 0.08 : 1;
    const breath = Math.sin(t * 1.4);
    const atk = e.attack;
    if (e.state === 'spawn') {
      // lying on its back, folded -> cover boots -> stands up -> unfolds -> face snaps on with a roar
      const standP = smooth(0.14, 0.44, p);
      tilt = -PI / 2 * (1 - easeInOut(standP)) + Math.sin(standP * PI) * 0.0;
      if (standP >= 1) tilt = 0.07 * Math.sin((p - 0.44) * 18) * Math.exp(-(p - 0.44) * 10);
      tiltPivot = -1;
      const unf = easeOut(smooth(0.46, 0.7, p));
      open = lerp(0.05, 2.75, unf); asym = 1 - unf;
      coverSpin = smooth(0.03, 0.08, p) * (1 - smooth(0.44, 0.5, p)) * Math.min(1, p / 0.4);
      cover = 0;
      boot = p < 0.46 ? 0 : p < 0.7 ? 0.3 + ((p - 0.46) / 0.24) * 0.62 : 1;
      const roar = p > 0.7 ? Math.exp(-(p - 0.7) * 5) : 0;
      mouth = 0.05 + roar * 1.0; squint = 0.2 + roar * 0.6; bright = 1 + roar * 0.8;
      sy = 1 + (p > 0.7 ? 0.05 * Math.exp(-(p - 0.7) * 12) : 0);
      lensG = 0.3 + (p > 0.7 ? roar : 0);
    } else if (e.state === 'dying') {
      // glitch + sparks + violent shake -> panels pop past flat -> topples onto its back, CRT off
      const shk = (1 - smooth(0.7, 0.8, p));
      shakeX = (Math.sin(t * 71) + Math.sin(t * 43)) * 0.05 * shk; shakeZ = Math.sin(t * 57) * 0.04 * shk;
      twist = Math.sin(t * 37) * 0.05 * shk;
      stat = smooth(0.05, 0.5, p) * 0.75;
      U.uGlitch.value = 1;
      xeyes = p > 0.35 ? 1 : 0;
      mouth = 0.9 + 0.1 * Math.sin(t * 30);
      const pop = smooth(0.55, 0.62, p);
      open = lerp(2.62, 3.35, pop) - 0.35 * smooth(0.66, 0.85, p);
      tilt = -PI / 2 * easeIn(smooth(0.74, 0.96, p));
      if (p > 0.96) tilt = -PI / 2 + 0.05 * Math.abs(Math.sin((p - 0.96) * 60)) * (1 - p) * 25;
      tiltPivot = -1;
      crt = smooth(0.8, 1.0, p);
      sparkRate = 60 * (1 - smooth(0.85, 1, p));
      bright = 1 + Math.sin(t * 40) * 0.3;
      lensG = 0.6 * Math.abs(Math.sin(t * 25));
    } else if (e.state === 'stun') {
      rock = Math.sin(t * 5) * 0.05; stat = 0.35; eyeOpen = 0.4; xeyes = 0; squint = 0;
    } else if (e.state === 'windup' || e.state === 'attack' || e.state === 'recover') {
      const W = e.state === 'windup', A = e.state === 'attack', Rc = e.state === 'recover';
      if (atk === 'spray') {
        if (W) { open = lerp(2.62, 3.1, easeOut(p)); notif = smooth(0, 0.6, p); squint = 0.6; mouth = 0.5 * p; alert = 0.3 * p; tilt = -0.04 * p; }
        else if (A) { open = 3.1; notif = 1; squint = 0.7; mouth = 0.6 + 0.3 * Math.abs(Math.sin(k * 14)); tilt = -0.03 * Math.abs(Math.sin(k * 14)); sy = 1 - 0.012 * Math.abs(Math.sin(k * 14)); bright = 1.15 + 0.15 * Math.sin(k * 28); }
        else { open = lerp(3.1, 2.62, easeInOut(p)); notif = 1 - smooth(0, 0.5, p); squint = 0.5; }
      } else if (atk === 'sweep') {
        if (W) { turUp = easeOut(smooth(0, 0.5, p)); lensG = 0.3 + 2.2 * smooth(0.3, 1, p); squint = 0.9; turYaw = -0.95 * smooth(0.4, 1, p); eyeOpen = 0.7; alert = 0.2 * p; }
        else if (A) { turUp = 1; turYaw = lerp(-0.95, 0.95, easeInOut(p)); lensG = 2.6 + 0.4 * Math.sin(k * 40); squint = 1; eyeOpen = 0.6; twist = turYaw * 0.08; }
        else { turUp = 1 - easeIn(smooth(0.2, 0.8, p)); turYaw = 0.95 * (1 - smooth(0, 0.6, p)); lensG = 2.6 * (1 - smooth(0, 0.4, p)); }
      } else if (atk === 'summon') {
        if (W) { open = lerp(2.62, 3.12, easeOut(p)); portal = smooth(0, 0.7, p); mouth = 0.9 * p; squint = 0.3; tilt = -0.06 * p; }
        else if (A) { open = 3.12 + 0.03 * Math.sin(k * 20); portal = 1; mouth = 0.9; squint = 0.4; bright = 1.2; tilt = -0.06 + 0.03 * Math.sin(k * 9); sy = 1 + 0.015 * Math.sin(k * 18); }
        else { open = lerp(3.12, 2.62, easeInOut(p)); portal = 1 - smooth(0, 0.5, p); }
      } else if (atk === 'fold') {
        if (W) {
          const c = easeInOut(smooth(0, 0.55, p));
          open = lerp(2.62, 0.05, c); asym = c;
          coverWarn = smooth(0.35, 0.6, p); cover = coverWarn;
          alert = smooth(0, 0.4, p);
          squint = 1; mouth = 0.4;
          tilt = -0.14 * easeOut(smooth(0.55, 1, p)); tiltPivot = -1;
          shakeX = Math.sin(t * 60) * 0.02 * smooth(0.7, 1, p);
        } else if (A) {
          open = 0.05; asym = 1; cover = 1; coverWarn = 1;
          const fallT = Math.min(0.34, (e.stateDur || 1) * 0.3);
          if (k < fallT) { const f = k / fallT; tilt = lerp(-0.1, PI / 2, f * f); tiltPivot = f * f < 0.07 ? -1 : 1; }
          else { const b = k - fallT; tilt = PI / 2 - 0.06 * Math.abs(Math.sin(b * 16)) * Math.exp(-b * 6); tiltPivot = 1; shakeX = Math.sin(t * 45) * 0.01 * sat(1 - b); }
        } else {
          const up = easeInOut(smooth(0, 0.55, p));
          tilt = PI / 2 * (1 - up) - 0.05 * Math.sin(smooth(0.5, 0.75, p) * PI); tiltPivot = 1;
          const ro = easeOut(smooth(0.55, 1, p));
          open = lerp(0.05, 2.62, ro); asym = 1 - ro; cover = 1 - ro; coverWarn = 1 - smooth(0, 0.3, p);
          sy = 1 - 0.03 * Math.sin(smooth(0.0, 0.5, p) * PI);
        }
      } else {
        if (W) { squint = 0.8; mouth = 0.4; } else if (A) { mouth = 0.8; }
      }
    } else {
      // move: heavy corner-rocking walk + breathing screens
      const amp = sat((e.spd || 0) / 1.2);
      this.gait += dt * (0.4 + (e.spd || 0) * 0.55);
      const s = Math.sin(TAU * this.gait);
      rock = s * 0.045 * amp;
      sy = 1 - 0.02 * amp * Math.pow(1 - Math.abs(s), 6);
      open = 2.62 + 0.06 * breath;
      eyeOpen = blink;
    }
    // phases
    const heat = phase >= 3 ? 0.65 + 0.35 * Math.sin(t * 5.3) : 0;
    const glitchBase = phase >= 3 ? 0.4 : phase >= 2 ? 0.28 : 0;
    if (e.state !== 'dying') U.uGlitch.value = Math.min(1, glitchBase * (0.5 + 0.5 * Math.sin(t * 2.7 + Math.sin(t * 7.1) * 2)) + this.phaseFlash * 0.8);
    if (phase >= 3 && e.state !== 'dying') sparkRate = Math.max(sparkRate, 22);
    U.uCrackN.value = phase >= 3 ? this.crackN3 : phase >= 2 ? this.crackN2 : 0;
    U.uHeat.value = heat;
    this.bodyMat.userData.u.uHeat.value = heat * 1.4;
    this.bodyMat.userData.u.uGlow.value.copy(this.glow).lerp(this.heatGlow, heat * 0.7);
    U.uBoot.value = boot; U.uNotif.value = notif; U.uPortal.value = portal; U.uStatic.value = stat; U.uCrt.value = crt; U.uAlert.value = alert;
    U.uEyeOpen.value = eyeOpen * (e.state === 'move' ? 1 : 1); U.uSquint.value = squint; U.uMouth.value = mouth;
    U.uHp.value = e.maxHp ? sat(e.hp / e.maxHp) : 1;
    U.uBright.value = bright * (1 - 0.5 * this.phaseFlash * Math.abs(Math.sin(t * 40)));
    U.uFlash.value = e.flash || 0; U.uXEyes.value = xeyes; U.uCover.value = Math.max(cover, e.state === 'dying' ? 0 : 0);
    U.uCoverWarn.value = coverWarn; U.uCoverSpin.value = coverSpin;
    U.uLook.value.set(lookX, lookY);
    // ---- transforms
    this.root.position.set(e.x + shakeX, e.y || 0, e.z + shakeZ);
    this.root.rotation.y = e.face + twist;
    const openN = open / PI;
    // closed stack re-centre so the slab falls straight ahead
    const shiftX = asym * (d.rh + d.L / 2 - 0.16) * (1 - Math.min(1, openN));
    const psiL = (PI - open) / 2 - asym * (PI - open) / 2;
    const psiR = -(PI - open) / 2 - asym * (PI - open) / 2;
    this.pL.rotation.y = psiL; this.pR.rotation.y = psiR;
    this.body.position.x = shiftX;
    this.body.scale.set(1 / Math.sqrt(sy), sy, 1 / Math.sqrt(sy));
    // fall pivots: forward = front face of the closed stack; backward = back of the rig
    const zF = asym > 0.5 ? d.T + 0.02 : 0.5, zB = -d.T - 0.12;
    const pz = tilt >= 0 ? (tiltPivot > 0 ? zF : zB) : zB;
    this.tilt.position.set(0, 0, pz); this.tiltIn.position.set(0, 0, -pz);
    this.tilt.rotation.x = tilt;
    const halfW = 0.6 + 1.1 * Math.min(1, openN);
    const rx = rock > 0 ? -halfW : halfW;
    this.rock.position.set(rx, 0, 0); this.rockIn.position.set(-rx, 0, 0); this.rock.rotation.z = rock;
    // turret
    const tu = turUp;
    this.tur.visible = tu > 0.01;
    this.tur.position.y = d.H + 0.12 + lerp(-0.5, 0.62, tu) + (tu > 0 && tu < 1 ? Math.sin(tu * PI) * 0.15 : 0);
    this.tur.scale.setScalar(Math.max(0.01, tu * 1.4));
    this.tur.rotation.y = turYaw;
    // fx on body parts
    const fl = e.flash || 0;
    const ringGlow = lensG * 0.5 + (phase >= 3 ? 0.3 + 0.3 * Math.sin(t * 9) : 0.12) + this.phaseFlash;
    this.setFx(this.spine, fl, e.state === 'dying' ? Math.abs(Math.sin(t * 30)) * 0.5 : ringGlow, 0);
    this.setFx(this.mL, fl, lensG * 0.6, 0); this.setFx(this.mR, fl, 0, 0); this.setFx(this.turM, fl, lensG, 0);
    // ---- decals: shadow + sparks
    this.root.updateMatrixWorld(true);
    const lying = Math.abs(tilt) > 0.5;
    if (decals) {
      _V.set(0, 0, 0);
      if (lying) { _V.set(0, 0, tilt > 0 ? 2.2 : -2.2); }
      _V.applyAxisAngle(_V2.set(0, 1, 0), e.face).add(this.root.position);
      decals.shadow(_V.x, _V.z, lying ? 2.6 : 2.1, lying ? 0.55 : 0.6);
    }
    // sparks
    if (sparkRate > 0 && this.q >= 1) {
      this.spawnAcc += dt * sparkRate * (this.q >= 2 ? 1 : 0.5);
      while (this.spawnAcc >= 1) {
        this.spawnAcc -= 1;
        const sx = (Math.random() - 0.5) * 3.0, sy2 = 0.5 + Math.random() * 3.6;
        _V.set(sx, sy2, 0.1);
        this.body.localToWorld(_V);
        this.emitSpark(_V.x, _V.y, _V.z, 2.5 + Math.random() * 2.5);
      }
    }
    for (let si = 0; si < this.sparks.length; si++) {
      const s = this.sparks[si];
      if (s.life <= 0) continue;
      s.life -= dt; s.vy -= 9.8 * dt; s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
      if (s.y < 0.02) { s.y = 0.02; s.vy *= -0.35; s.vx *= 0.6; s.vz *= 0.6; }
      if (decals) {
        const a = sat(s.life / s.max);
        this.tmpC.copy(this.sparkHot).lerp(this.sparkCol, a);
        decals.glow(3, s.x, s.y, s.z, s.s * (0.6 + a), a * 1.7, this.tmpC, 1.0 + Math.min(3, Math.abs(s.vy) * 0.4));
      }
    }
    // turret lens glare
    if (decals && tu > 0.5 && lensG > 1) {
      _V.set(0, 0.23, 0.3); this.turM.localToWorld(_V);
      this.tmpC.copy(this.glow);
      decals.glow(2, _V.x, _V.y, _V.z, 0.9 + 0.2 * Math.sin(t * 40), 0.6 * (lensG / 2.6), this.tmpC);
    }
  }
}

// ------------------------------------------------------------------------------------------
// Public factory
// ------------------------------------------------------------------------------------------
export function createPhones(scene, opts = {}) {
  const R = resources();
  const capacity = opts.capacity || 70;
  const k = capacity / 70;
  const group = new THREE.Group(); group.name = 'phones';
  scene.add(group);
  const crowds = {
    iphone: new Crowd('iphone', Math.max(8, Math.ceil(32 * k)), group),
    galaxy: new Crowd('galaxy', Math.max(6, Math.ceil(24 * k)), group),
    fold: new Crowd('fold', Math.max(4, Math.ceil(16 * k)), group),
  };
  const decals = new Decals(Math.max(64, capacity * 2 + 64), group);
  const boss = new Flagship(group, decals);
  const states = new Map();
  let frame = 0, quality = 2, curFrame = 0;
  const forget = (s, id) => { if (s.seen !== curFrame) states.delete(id); };

  function writeSmall(e, s, t, dt, crowd, decalsRef) {
    const kind = e.kind;
    // local-frame velocity (smoothed) for lean / look
    const idt = dt > 1e-4 ? 1 / dt : 0;
    const vx = (e.x - s.px) * idt, vz = (e.z - s.pz) * idt;
    s.px = e.x; s.pz = e.z;
    const sa = Math.sin(e.face), ca = Math.cos(e.face);
    const f = vx * sa + vz * ca, sd = vx * ca - vz * sa;
    const kk = 1 - Math.exp(-dt * 8);
    if (Math.abs(f) < 30 && Math.abs(sd) < 30) { s.vf += (f - s.vf) * kk; s.vs += (sd - s.vs) * kk; }
    if (e.state !== s.prevState) {
      if (s.prevState === 'spawn' || (s.prevState === 'attack' && kind === 'iphone')) s.landT = 0;
      s.prevState = e.state;
    }
    s.landT += dt;
    if (kind === 'iphone') poseIphone(e, s, t, dt, R);
    else if (kind === 'galaxy') poseGalaxy(e, s, t, dt, R);
    else poseFold(e, s, t, dt, R);
    P.flash = e.flash || 0;
    P.elite = e.elite ? 1 : 0;
    P.bright += P.flash * 1.4;
    const scale = e.elite ? 1.25 : 1;
    let halfW, cy;
    if (kind === 'fold') { halfW = D.fold.L * 0.55; cy = D.fold.H / 2; P.hopY += 0; }
    else { halfW = D[kind].w / 2; cy = D[kind].h / 2; }
    composeRoot(_M, e, scale, halfW, cy);
    crowd.push(_M, P, TINT);
    if (decalsRef) {
      const y = (e.y || 0) + P.hopY * scale;
      const rad = (KIND_DIMS[kind].r * 1.15) * scale * (1 + y * 0.25);
      const baseA = kind === 'fold' ? 0.62 : 0.55;
      if (P.shadow > 0) decalsRef.shadow(e.x, e.z, rad, baseA / (1 + y * 1.4));
      if (e.elite) decalsRef.glow(1, e.x, 0.02, e.z, KIND_DIMS[kind].r * 2.9, 0.9 + 0.2 * Math.sin(t * 4 + s.seed * 6), R.gold);
      if (P.flare > 0.01 && kind === 'galaxy') {
        _V.set(0, D.galaxy.h - 0.085, D.galaxy.t / 2 + 0.05).applyMatrix4(_M);
        decalsRef.glow(2, _V.x, _V.y, _V.z, 0.55 + 0.5 * P.flare, Math.min(1.5, P.flare), R.glow.galaxy);
      }
    }
  }

  function sync(enemies, t, dt) {
    dt = Math.min(Math.max(dt || 0, 0), 0.05);
    frame++;
    SHARED_U.uTime.value = t;
    crowds.iphone.begin(); crowds.galaxy.begin(); crowds.fold.begin(); decals.begin();
    let bossSeen = false;
    if (enemies) {
      for (let i = 0; i < enemies.length; i++) {
        const e = enemies[i];
        const kind = e.kind;
        if (kind === 'boss_flagship') { if (!bossSeen) { bossSeen = true; boss.update(e, t, dt, decals); } continue; }
        const crowd = crowds[kind];
        if (!crowd) continue;
        let s = states.get(e.id);
        if (!s) { s = newState(e, t); states.set(e.id, s); }
        s.seen = frame;
        writeSmall(e, s, t, dt, crowd, decals);
      }
    }
    if (!bossSeen && boss.root.visible) boss.hide();
    crowds.iphone.end(); crowds.galaxy.end(); crowds.fold.end(); decals.end();
    curFrame = frame; states.forEach(forget);
  }

  function setQuality(q) {
    quality = q | 0;
    for (const c of Object.values(crowds)) c.setCast(quality >= 3);
    boss.setQuality(quality);
    const cc = quality >= 1 ? 0.8 : 0;
    for (const m of Object.values(R.bodyMat)) { m.clearcoat = cc; }
    boss.bodyMat.clearcoat = cc;
  }
  setQuality(opts.quality ?? 2);

  // ---- previews: a private 1-instance crowd (or a private boss rig) driven by a fake record
  function preview(kind) {
    const g = new THREE.Group(); g.name = 'phonePreview_' + kind;
    const pd = new Decals(32, g);
    const fake = { id: -1000 - Math.floor(Math.random() * 1e6), kind, x: 0, y: 0, z: 0, face: 0, r: KIND_DIMS[kind]?.r || 0.5, spd: 0,
      state: 'move', stateT: 0, stateDur: 1, attack: null, flash: 0, elite: false, hp: 1, maxHp: 1, boss: kind === 'boss_flagship', phase: 1, spawnFrom: null };
    const ud = { kind, fake, decals: pd, lastT: null };
    if (kind === 'boss_flagship') ud.boss = new Flagship(g, pd);
    else if (crowds[kind]) { ud.crowd = new Crowd(kind, 1, g); ud.state = newState(fake, 0); }
    g.userData.phonePreview = ud;
    return g;
  }
  function previewUpdate(obj, t) {
    const ud = obj && obj.userData.phonePreview; if (!ud) return;
    const dt = ud.lastT == null ? 1 / 60 : Math.min(0.05, Math.max(0, t - ud.lastT));
    ud.lastT = t;
    SHARED_U.uTime.value = t;
    const e = ud.fake;
    e.stateT = t; e.stateDur = 1e9;
    ud.decals.begin();
    if (ud.boss) { e.state = 'move'; e.spd = 0; ud.boss.update(e, t, dt, ud.decals); }
    else {
      // idle show-off: gentle in-place gait
      e.spd = 0.35 + 0.3 * Math.sin(t * 0.8);
      ud.crowd.begin();
      ud.state.px = e.x; ud.state.pz = e.z;
      writeSmall(e, ud.state, t, dt, ud.crowd, ud.decals);
      ud.crowd.end();
    }
    ud.decals.end();
  }

  return {
    kinds: OWN.slice(),
    sync, setQuality, preview, previewUpdate,
    get quality() { return quality; },
    group,
    // debug / harness helpers
    _debug: { crowds, decals, boss, states, atlas: () => R.atlas.canvas, U: SHARED_U },
  };
}
