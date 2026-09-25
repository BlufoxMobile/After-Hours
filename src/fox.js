// =====================================================================================
// AFTER HOURS 3D — THE FOX (hero model + all of its procedural animation)
// Owner: FOX agent.  API (CONTRACT §4):
//   const fox = createFox({ outfit: 'bomber' });
//   fox.root                      THREE.Object3D (feet at y = 0, built facing +Z)
//   fox.update(t, dt, p)          p = sim.state.player (+ p.dead, p.victory)
//   fox.setOutfit(id)             OUTFITS id (colour swap, no geometry rebuild)
//   fox.muzzle(outVec3) -> out    world-space blaster emitter tip
//   fox.setQuality(q)             0..3
//   fox.pose(name)                'title' | 'locker' -> showcase idle (update ignores p and never
//                                 touches root position/rotation); anything else -> gameplay
//   fox.outfit, fox.quality       current values (read-only getters)
//
// Gameplay mode: update() places root at (p.x, 0, p.z) and sets root.rotation.y to the smoothed
// body yaw, which chases p.aim (twin-stick: upper body + blaster face the aim). The hips twist
// toward p.face and the legs stride along the movement direction relative to the hips, so strafing
// side-steps and moving opposite the aim backpedals instead of moonwalking. The blaster hand is
// solved in world space every frame so the barrel points exactly along p.aim (±69° beyond the
// body while the body is still turning). Arms are posed with analytic two-bone IK.
//
// Construction: one SkinnedMesh for the whole body (fur, clothes, boots, blaster — colours and
// per-vertex roughness/metal/sheen/glow baked into vertex attributes, outfit colours looked up
// from uniforms by a per-vertex slot id, baked sphere-proxy AO), one small textured face decal
// (eyes + brows, a 6-expression atlas drawn to a canvas) parented to the head bone, one additive
// muzzle-flare sprite and one blob contact shadow => 3-4 draw calls + 1 shadow-pass call.
// q>=1: ~11.0k + 1.4k tris (MeshPhysical w/ sheen);  q0: ~7.1k + 0.7k tris (MeshStandard).
// =====================================================================================
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { OUTFITS } from './layout.js';

const TAU = Math.PI * 2;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wrapA = (a) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };
const dampK = (k, dt) => 1 - Math.exp(-k * dt);
const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

// ------------------------------------------------------------------------------------------
// Palette (sRGB hex; THREE.Color converts to linear working space)
// ------------------------------------------------------------------------------------------
const COL = {
  fur: '#175af2', furTop: '#3b86ff', furDeep: '#0e3cb8', furDark: '#0b2b85',
  white: '#e8edf8', cream: '#e4ebfb',
  earIn: '#f4b4c6', earTip: '#132a78',
  nose: '#0d0f16', mouth: '#1a1020', earTipD: '#0a1648',
  tee: '#17181f', pants: '#1c2a55', boot: '#1a2350', glove: '#1a2350',
  zip: '#cfd6e2', badge: '#1fe6cf', badgeRim: '#0b1a2a',
  gunShell: '#c4cddd', gunCore: '#262d40', gunGlow: '#3ee8ff',
};
const C = {}; for (const k in COL) C[k] = new THREE.Color(COL[k]);

// per-vertex material params [roughness, metalness, sheen, glowClass] (glow: 1 = always, 0.5 = trim/OD)
const M_FUR = [0.74, 0, 0.45, 0], M_WHITE = [0.8, 0, 0.5, 0], M_JACKET = [0.48, 0, 0.12, 0];
const M_RIB = [0.9, 0, 0.6, 0], M_TRIM = [0.35, 0.35, 0, 0.5], M_TEE = [0.92, 0, 0.35, 0];
const M_PANTS = [0.8, 0, 0.45, 0], M_BOOT = [0.42, 0, 0.1, 0], M_SOLE = [0.62, 0, 0, 0];
const M_NOSE = [0.18, 0, 0, 0], M_GLOVE = [0.62, 0, 0.3, 0], M_EARIN = [0.85, 0, 0.6, 0];
const M_GUN = [0.28, 0.1, 0, 0], M_GUNCORE = [0.35, 0.65, 0, 0], M_GLOW = [0.25, 0, 0, 1], M_GLOW2 = [0.3, 0, 0, 0.8];
const SLOT_NONE = 0, SLOT_JACKET = 1, SLOT_ACCENT = 2, SLOT_TRIM = 3, SLOT_SOLE = 4;

// ------------------------------------------------------------------------------------------
// Skeleton layout (bind pose, model space, metres). All rest rotations are identity.
// ------------------------------------------------------------------------------------------
const B = {
  base: 0, hips: 1, chest: 2, head: 3, earL: 4, earR: 5,
  shL: 6, elL: 7, hdL: 8, shR: 9, elR: 10, hdR: 11,
  thL: 12, knL: 13, ftL: 14, thR: 15, knR: 16, ftR: 17,
  t0: 18, t1: 19, t2: 20, t3: 21, t4: 22,
};
const PARENT = [-1, 0, 1, 2, 3, 3, 2, 6, 7, 2, 9, 10, 1, 12, 13, 1, 15, 16, 1, 18, 19, 20, 21];
const HEAD_C = V3(0, 0.795, 0.03);                // head centre
const HR = { x: 0.26, y: 0.22, z: 0.218 };      // head radii
const ARM_A = 0.26;                               // bind arm angle out from vertical
const UP_LEN = 0.12, FORE_LEN = 0.105, FIST_OFF = 0.034;
const SHOULDER = (side) => V3(0.148 * side, 0.492, 0.0);
const ARM_DIR = (side) => V3(Math.sin(ARM_A) * side, -Math.cos(ARM_A), 0);
const TAIL_S = [0, 0.2, 0.4, 0.6, 0.8];
function tailPath(s, out) { // cubic bezier from the lower back, sweeping back and curling up
  const p0 = [0, 0.30, -0.10], p1 = [0.02, 0.2, -0.36], p2 = [0.09, 0.5, -0.5], p3 = [0.14, 0.8, -0.36];
  const u = 1 - s, a = u * u * u, b = 3 * u * u * s, c = 3 * u * s * s, d = s * s * s;
  return out.set(a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1], a * p0[2] + b * p1[2] + c * p2[2] + d * p3[2]);
}
function bindPositions() {
  const P = [];
  P[B.base] = V3(0, 0, 0); P[B.hips] = V3(0, 0.30, 0); P[B.chest] = V3(0, 0.40, 0); P[B.head] = V3(0, 0.575, 0.0);
  P[B.earL] = earBase(1); P[B.earR] = earBase(-1);
  for (const side of [1, -1]) {
    const sh = SHOULDER(side), d = ARM_DIR(side);
    const el = sh.clone().addScaledVector(d, UP_LEN), hd = el.clone().addScaledVector(d, FORE_LEN + FIST_OFF);
    P[side > 0 ? B.shL : B.shR] = sh; P[side > 0 ? B.elL : B.elR] = el; P[side > 0 ? B.hdL : B.hdR] = hd;
    P[side > 0 ? B.thL : B.thR] = V3(0.075 * side, 0.30, 0);
    P[side > 0 ? B.knL : B.knR] = V3(0.08 * side, 0.175, 0.008);
    P[side > 0 ? B.ftL : B.ftR] = V3(0.086 * side, 0.08, 0.0);
  }
  for (let i = 0; i < 5; i++) P[B.t0 + i] = tailPath(TAIL_S[i], V3());
  return P;
}

// ------------------------------------------------------------------------------------------
// Head surface (analytic, shared by the head mesh and the face decal so they match exactly)
// u = unit direction from the head centre (head-local). Returns offset from HEAD_C.
// ------------------------------------------------------------------------------------------
function headSurface(ux, uy, uz, out) {
  let x = ux * HR.x, y = uy * HR.y, z = uz * HR.z;
  if (uz > 0) z *= 1 - 0.12 * uz * uz;                          // flatter face plane for the big eyes
  const jowl = 1 + 0.11 * Math.exp(-((uy + 0.3) * (uy + 0.3)) / 0.12);  // chubby cheeks
  x *= jowl;
  if (uy < 0) { z *= 1 - 0.1 * uy * uy * Math.max(0, -uz); y *= 1 - 0.06 * Math.max(0, uz); } // tuck back of jaw
  if (uy > 0.2) { x *= 1 - 0.05 * (uy - 0.2); }                 // slightly narrower cranium
  return out.set(x, y, z);
}
function earBase(side) {
  const u = V3(0.56 * side, 0.8, -0.08).normalize();
  const o = headSurface(u.x, u.y, u.z, V3()).multiplyScalar(0.86);
  return o.add(HEAD_C);
}

// ------------------------------------------------------------------------------------------
// Geometry toolkit
// ------------------------------------------------------------------------------------------
// Sweep a (possibly non-circular) cross-section along a path. Returns indexed geometry with
// userData.s / userData.th per vertex.  shape(s, th, out) -> out.x along N (frame normal),
// out.y along B (binormal). up = initial N hint.
function sweep(o) {
  const R = o.rings, S = o.seg, Cn = [], T = [], N = [], Bn = [];
  for (let i = 0; i <= R; i++) Cn.push(o.path(i / R, V3()));
  for (let i = 0; i <= R; i++) {
    const a = Cn[Math.max(0, i - 1)], b = Cn[Math.min(R, i + 1)];
    T.push(V3().subVectors(b, a).normalize());
  }
  let n = o.up ? o.up.clone() : V3(0, 1, 0);
  for (let i = 0; i <= R; i++) {
    n = n.clone().addScaledVector(T[i], -n.dot(T[i]));
    if (n.lengthSq() < 1e-9) n = V3(1, 0, 0).addScaledVector(T[i], -T[i].x);
    n.normalize(); N.push(n); Bn.push(V3().crossVectors(T[i], n).normalize());
  }
  const pos = [], sA = [], thA = [], idx = [], start = [], tmp = { x: 0, y: 0 };
  for (let i = 0; i <= R; i++) {
    const s = i / R; start.push(pos.length / 3);
    if ((i === 0 && o.tip0) || (i === R && o.tip1)) { pos.push(Cn[i].x, Cn[i].y, Cn[i].z); sA.push(s); thA.push(0); continue; }
    for (let k = 0; k < S; k++) {
      const th = (k / S) * TAU + (o.th0 || 0);
      o.shape(s, th, tmp);
      pos.push(Cn[i].x + N[i].x * tmp.x + Bn[i].x * tmp.y, Cn[i].y + N[i].y * tmp.x + Bn[i].y * tmp.y, Cn[i].z + N[i].z * tmp.x + Bn[i].z * tmp.y);
      sA.push(s); thA.push(th);
    }
  }
  for (let i = 0; i < R; i++) {
    const a = start[i], b = start[i + 1], aT = i === 0 && o.tip0, bT = i + 1 === R && o.tip1;
    for (let k = 0; k < S; k++) {
      const k1 = (k + 1) % S;
      if (aT) idx.push(a, b + k1, b + k);
      else if (bT) idx.push(a + k, a + k1, b);
      else idx.push(a + k, a + k1, b + k, a + k1, b + k1, b + k);
    }
  }
  if (o.cap0 && !o.tip0) { const c = pos.length / 3; pos.push(Cn[0].x, Cn[0].y, Cn[0].z); sA.push(0); thA.push(0); for (let k = 0; k < S; k++) idx.push(c, start[0] + (k + 1) % S, start[0] + k); }
  if (o.cap1 && !o.tip1) { const c = pos.length / 3, b = start[R]; pos.push(Cn[R].x, Cn[R].y, Cn[R].z); sA.push(1); thA.push(0); for (let k = 0; k < S; k++) idx.push(c, b + k, b + (k + 1) % S); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx); g.computeVertexNormals();
  g.userData.s = sA; g.userData.th = thA;
  return g;
}
// Sculpted icosphere: fn(unitDir, out) sets the vertex position.
function blob(detail, fn) {
  let g = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('normal'); g.deleteAttribute('uv');
  g = mergeVertices(g);
  const p = g.attributes.position, u = V3(), o = V3(), U = [];
  for (let i = 0; i < p.count; i++) {
    u.fromBufferAttribute(p, i).normalize(); U.push(u.clone());
    fn(u, o); p.setXYZ(i, o.x, o.y, o.z);
  }
  g.computeVertexNormals(); g.userData.u = U;
  return g;
}
// average normals of vertices that share a position (crisp colour seams without shading seams)
function smoothNormals(g) {
  g.computeVertexNormals();
  const P = g.attributes.position, N = g.attributes.normal, map = new Map(), key = (i) => `${Math.round(P.getX(i) * 1e4)},${Math.round(P.getY(i) * 1e4)},${Math.round(P.getZ(i) * 1e4)}`;
  for (let i = 0; i < P.count; i++) { const k = key(i); const e = map.get(k); if (e) { e[0] += N.getX(i); e[1] += N.getY(i); e[2] += N.getZ(i); } else map.set(k, [N.getX(i), N.getY(i), N.getZ(i)]); }
  for (let i = 0; i < P.count; i++) { const e = map.get(key(i)), l = Math.hypot(e[0], e[1], e[2]) || 1; N.setXYZ(i, e[0] / l, e[1] / l, e[2] / l); }
}
const bez2 = (a, b, c, s, out) => { const u = 1 - s; return out.set(u * u * a.x + 2 * u * s * b.x + s * s * c.x, u * u * a.y + 2 * u * s * b.y + s * s * c.y, u * u * a.z + 2 * u * s * b.z + s * s * c.z); };
// A tapered fur lock / spike from `base` along `dir` with a bend toward `bend`.
function spike(base, dir, len, r0, opt = {}) {
  const d = dir.clone().normalize(), tip = base.clone().addScaledVector(d, len);
  const mid = base.clone().addScaledVector(d, len * 0.5).addScaledVector(opt.bend || V3(), len);
  const flat = opt.flat || 1, seg = opt.seg || 8, rings = opt.rings || 5, pw = opt.pw || 0.9, leaf = !!opt.leaf, flame = !!opt.flame;
  return sweep({
    rings, seg, up: opt.up || V3(0, 1, 0), tip1: true, cap0: true,
    path: (s, out) => bez2(base, mid, tip, s, out),
    shape: (s, th, out) => { const r = flame ? r0 * Math.pow(1 - s, 1.3) * (1 + 1.2 * s) : leaf ? r0 * Math.pow(Math.sin(Math.PI * (0.22 + 0.78 * s)), 0.8) : r0 * Math.pow(1 - s, pw) * (1 + 0.25 * Math.sin(Math.PI * Math.min(1, s * 2.2))); out.x = Math.cos(th) * r * flat; out.y = Math.sin(th) * r; },
  });
}
const superE = (th, p) => { const c = Math.cos(th), s = Math.sin(th); const k = Math.pow(Math.pow(Math.abs(c), p) + Math.pow(Math.abs(s), p), -1 / p); return [c * k, s * k]; };

// ------------------------------------------------------------------------------------------
// Build the fox body geometry (all parts merged; per-part paint + skin callbacks)
// ------------------------------------------------------------------------------------------
function buildBody(q, BP) {
  const hi = q >= 1;
  const parts = [];
  let grp = 'head';
  const add = (g, paint, skin) => parts.push({ g, paint, skin, grp });
  const rig = (b) => (c) => { c.sk = [[b, 1]]; };
  const set = (c, col, mat, slot = 0) => { c.col.copy(col); c.mat = mat; c.slot = slot; };

  // ---------------- HEAD ----------------
  grp = 'head';
  const headG = blob(hi ? 9 : 7, (u, o) => headSurface(u.x, u.y, u.z, o).add(HEAD_C));
  add(headG, (c) => {
    const u = c.u, ax = Math.abs(u.x);
    // white lower face: hugs under the eyes, rises into the cheek fluff at the sides
    const yb = ax < 0.55 ? lerp(-0.31, -0.25, ax / 0.55) : -0.25 + (ax - 0.55) * 1.25;
    let w = sstep(-0.25, 0.15, u.z) * (1 - sstep(yb - 0.065, yb + 0.06, u.y));
    const fur = 0.95 + 0.05 * Math.sin(u.x * 23 + u.y * 17) * Math.sin(u.y * 19 - u.z * 21);
    c.col.copy(C.fur).lerp(C.furTop, sstep(0.3, 0.95, u.y) * 0.55).lerp(C.furDeep, sstep(0.0, 0.8, -u.y) * 0.6 * (1 - w)).multiplyScalar(fur);
    c.col.lerp(C.white, w);
    if (u.y < -0.55) c.col.multiplyScalar(lerp(1, 0.8, sstep(-0.55, -0.95, u.y)));   // chin/neck occlusion
    c.mat = w > 0.5 ? M_WHITE : M_FUR; c.slot = 0;
  }, rig(B.head));

  // snout (small soft muzzle) + nose + smirk
  const SN_C = V3(0, -0.118, 0.168).add(HEAD_C), SN_R = V3(0.078, 0.058, 0.07);
  add(blob(hi ? 3 : 2, (u, o) => {
    const x = u.x * SN_R.x * (1 - 0.12 * Math.max(0, -u.y)), y = u.y * SN_R.y, z = u.z * SN_R.z * (1 + 0.12 * Math.max(0, u.y));
    o.set(x, y, z).add(SN_C);
  }), (c) => set(c, C.white, M_WHITE), rig(B.head));
  const onSnout = (x, y, lift = 0.0015) => { // project a head-local point (x,y) onto the snout front
    const nx = x / SN_R.x, ny = (y - (SN_C.y - HEAD_C.y)) / SN_R.y; const nz = Math.sqrt(Math.max(0.02, 1 - nx * nx - ny * ny));
    return V3(x, y, 0).add(V3(0, 0, SN_C.z + nz * SN_R.z * (1 + 0.12 * Math.max(0, ny)) + lift)).add(V3(HEAD_C.x, HEAD_C.y, 0));
  };
  const NOSE_C = V3(0, -0.083, 0).add(HEAD_C); NOSE_C.z = onSnout(0, -0.083).z - 0.004;
  add(blob(hi ? 2 : 1, (u, o) => {
    const x = u.x * 0.034 * (1 - 0.35 * Math.max(0, -u.y)), y = u.y * 0.022, z = u.z * 0.022;
    o.set(x, y, z).add(NOSE_C);
  }), (c) => set(c, C.nose, M_NOSE), rig(B.head));
  const mouthPts = [[-0.047, -0.127], [-0.031, -0.1385], [-0.012, -0.1445], [0.006, -0.1435], [0.026, -0.1375], [0.043, -0.1265], [0.054, -0.1125]].map(([x, y]) => onSnout(x, y - 0.002, 0.001));
  const mouthCurve = new THREE.CatmullRomCurve3(mouthPts);
  add(sweep({ rings: hi ? 14 : 8, seg: 5, path: (s, o) => o.copy(mouthCurve.getPoint(s)), up: V3(0, 0, 1),
    shape: (s, th, o) => { const r = 0.0042 * (0.55 + 0.45 * Math.sin(Math.PI * s)); o.x = Math.cos(th) * r; o.y = Math.sin(th) * r; }, cap0: true, cap1: true }),
  (c) => set(c, C.mouth, M_NOSE), rig(B.head));
  const phA = onSnout(0, -0.1, 0.001), phB = onSnout(0.001, -0.1425, 0.001);
  add(sweep({ rings: 3, seg: 5, path: (s, o) => o.lerpVectors(phA, phB, s), up: V3(0, 0, 1),
    shape: (s, th, o) => { o.x = Math.cos(th) * 0.0035; o.y = Math.sin(th) * 0.0035; }, cap0: true, cap1: true }),
  (c) => set(c, C.mouth, M_NOSE), rig(B.head));

  // cheek fluff (white locks fanning out/down from the jowls)
  for (const side of [1, -1]) {
    const locks = [[0.92, -0.08, 0.2, 1.0, 0.25, -0.1, 0.055, 0.058], [0.9, -0.32, 0.24, 1.0, -0.2, 0.0, 0.07, 0.066], [0.8, -0.55, 0.3, 0.8, -0.7, 0.1, 0.05, 0.056], [0.93, -0.2, 0.0, 1, 0.0, -0.4, 0.045, 0.05]];
    for (const [ux, uy, uz, dx, dy, dz, len, r] of locks) {
      const u = V3(ux * side, uy, uz).normalize();
      const base = headSurface(u.x, u.y, u.z, V3()).multiplyScalar(0.84).add(HEAD_C);
      add(spike(base, V3(dx * side, dy, dz), len + 0.035, r, { flat: 0.45, up: V3(0, 0, 1), bend: V3(0.05 * side, -0.25, -0.1), seg: hi ? 7 : 6, rings: 5, flame: true }),
        (c) => { set(c, C.white, M_WHITE); c.col.multiplyScalar(0.9 + 0.1 * c.s); }, rig(B.head));
    }
  }
  // nape / back-of-head fur tufts (break the ball silhouette from behind and above)
  for (const [ux, uy, uz, len, r] of [[0, -0.5, -0.87, 0.1, 0.06], [0.42, -0.45, -0.8, 0.095, 0.058], [-0.42, -0.45, -0.8, 0.095, 0.058], [0.76, -0.32, -0.56, 0.08, 0.052], [-0.76, -0.32, -0.56, 0.08, 0.052]]) {
    const u = V3(ux, uy, uz).normalize();
    const base = headSurface(u.x, u.y, u.z, V3()).multiplyScalar(0.8).add(HEAD_C);
    add(spike(base, V3(u.x * 0.55, -1, u.z * 0.55), len + 0.04, r, { flat: 0.42, up: u.clone(), bend: V3(u.x * 0.1, 0, u.z * 0.15), seg: hi ? 7 : 5, rings: 4, flame: true }),
      (c) => { set(c, C.fur, M_FUR); c.col.lerp(C.furDeep, 0.3 - 0.15 * c.s); }, rig(B.head));
  }
  // forehead forelock: big swoopy blue locks sweeping up/forward and curling to the fox's left
  const locks = [ // base dir (head-local unit-ish), growth dir, length, radius, sideways curl
    [0.02, 0.96, 0.26, 0.25, 1.0, 0.1, 0.2, 0.068, 0.3],
    [-0.14, 0.92, 0.36, -0.05, 1.0, 0.3, 0.16, 0.06, 0.36],
    [0.17, 0.92, 0.28, 0.6, 0.9, 0.05, 0.15, 0.056, 0.2],
    [0.0, 0.84, 0.54, 0.3, 0.7, 0.8, 0.12, 0.058, 0.26],
    [-0.05, 0.98, -0.1, 0.1, 1.0, -0.4, 0.12, 0.055, 0.2],
  ];
  for (const [ux, uy, uz, dx, dy, dz, len, r, bx] of locks) {
    const u = V3(ux, uy, uz).normalize(), dir = V3(dx, dy, dz).normalize();
    const base = headSurface(u.x, u.y, u.z, V3()).multiplyScalar(0.88).add(HEAD_C);
    const thin = V3().crossVectors(dir, V3(1, 0, 0)).normalize();   // blades are wide side-to-side
    add(spike(base, dir, len, r, { flat: 0.34, up: thin, bend: V3(bx, -0.12, 0.1), seg: hi ? 8 : 6, rings: hi ? 6 : 4, leaf: true }),
      (c) => { set(c, C.fur, M_FUR); c.col.lerp(C.furTop, 0.3 + 0.15 * c.s); }, rig(B.head));
  }

  // ---------------- EARS ----------------
  grp = 'ear';
  for (const side of [1, -1]) {
    const b0 = BP[side > 0 ? B.earL : B.earR];
    const ax = V3(0.4 * side, 0.9, -0.1).normalize(), len = 0.27;
    const tip = b0.clone().addScaledVector(ax, len), mid = b0.clone().addScaledVector(ax, len * 0.5).add(V3(0.02 * side, 0, -0.025));
    const fwd = V3(0.18 * side, 0.0, 1).normalize(); // ear opening faces mostly forward
    const earShape = (inner) => (s, th, o) => {
      const w = (inner ? 0.06 : 0.086) * Math.pow(1 - s, 0.85) * (1 + 0.18 * Math.sin(Math.PI * Math.min(1, s * 1.6)));
      const d = (inner ? 0.012 : 0.042) * Math.pow(1 - s, 0.8);
      const a = Math.cos(th), b = Math.sin(th);
      let dep = d * a; if (!inner && a > 0) dep -= d * 1.75 * (1 - b * b) * (1 - 0.6 * s);
      o.x = dep; o.y = w * b;
    };
    const earPath = (sh) => (s, o) => bez2(b0, mid, tip, s, o).addScaledVector(fwd, sh);
    add(sweep({ rings: hi ? 8 : 6, seg: hi ? 16 : 12, up: fwd, tip1: true, cap0: true, path: earPath(0), shape: earShape(false) }), (c) => {
      const front = Math.cos(c.th), side2 = Math.abs(Math.sin(c.th));
      const inner = front > 0.2 && side2 < 0.86;
      if (inner) { set(c, C.earIn, M_EARIN); c.col.lerp(C.white, sstep(0.3, 0.05, c.s) * 0.85); c.col.lerp(C.earTip, sstep(0.62, 0.85, c.s)); }
      else { set(c, C.fur, M_FUR); c.col.lerp(C.furTop, 0.2).lerp(C.earTipD, sstep(0.45, 0.75, c.s)); }
    }, rig(side > 0 ? B.earL : B.earR));
    // inner-ear white fluff
    for (const [ox, oy, dx, len] of [[-0.026, 0.015, -0.5, 0.07], [0.024, 0.01, 0.55, 0.065]]) {
      const base = b0.clone().addScaledVector(ax, 0.02 + oy).add(V3(ox * side, 0, 0)).addScaledVector(fwd, -0.012);
      add(spike(base, V3().addScaledVector(ax, 1).add(V3(dx * side, 0, 0.25)), len, 0.02, { flat: 0.4, up: fwd, seg: 6, rings: 4, pw: 1.2 }),
        (c) => set(c, C.white, M_WHITE), rig(side > 0 ? B.earL : B.earR));
    }
  }

  // ---------------- TORSO ----------------
  grp = 'torso';
  // tee (inner body, black) — visible through the open jacket
  add(sweep({ rings: hi ? 7 : 5, seg: hi ? 14 : 10, cap0: true, cap1: true, up: V3(0, 0, 1),
    path: (s, o) => o.set(0, lerp(0.25, 0.60, s), lerp(0.0, 0.01, s)),
    shape: (s, th, o) => { const k = 1 - 0.3 * sstep(0.75, 1, s); o.x = Math.cos(th) * 0.128 * k; o.y = Math.sin(th) * 0.15 * k; } }),
  (c) => set(c, C.tee, M_TEE), (c) => { const t = sstep(0.31, 0.4, c.p.y); c.sk = [[B.hips, 1 - t], [B.chest, t]]; });
  // chest ruff: a smooth white V-bib down the tee with soft fur locks along its edges
  add(sweep({ rings: hi ? 9 : 6, seg: hi ? 12 : 8, up: V3(0, 0, 1), cap0: true, tip1: true,
    path: (u, o) => o.set(0, lerp(0.6, 0.43, u), lerp(0.085, 0.132, Math.sin(u * Math.PI / 2))),
    shape: (u, th, o) => { const w = 0.078 * Math.pow(1 - u, 0.75) * (1 + 0.12 * Math.sin(u * Math.PI * 4) * u), d = 0.022 * (1 - 0.6 * u);
      const c = Math.cos(th); o.x = c > 0 ? c * d : c * d * 0.4; o.y = Math.sin(th) * w; } }),
  (c) => { set(c, C.white, M_WHITE); c.col.multiplyScalar(1 - 0.1 * c.s); }, rig(B.chest));
  for (const [x, y, z, dx, len, r] of [[-0.055, 0.54, 0.112, -0.55, 0.06, 0.028], [0.055, 0.54, 0.112, 0.55, 0.06, 0.028], [-0.035, 0.49, 0.126, -0.4, 0.05, 0.022], [0.035, 0.49, 0.126, 0.4, 0.05, 0.022]]) {
    add(spike(V3(x, y, z), V3(dx, -1, 0.25), len, r, { flat: 0.45, up: V3(0, 0, 1), bend: V3(dx * 0.05, 0.02, 0.04), seg: 6, rings: 3, flame: true }),
      (c) => { set(c, C.white, M_WHITE); c.col.multiplyScalar(0.95 - 0.1 * c.s); }, rig(B.chest));
  }
  // jacket shell (open front, puffy bomber, hem band + collar in the accent colour)
  const JY0 = 0.245, JY1 = 0.615;
  const jProf = [[0.245, 0.150, 0.128], [0.285, 0.158, 0.134], [0.305, 0.172, 0.144], [0.37, 0.182, 0.150], [0.44, 0.178, 0.146], [0.49, 0.163, 0.134], [0.53, 0.138, 0.117], [0.555, 0.113, 0.104], [0.585, 0.106, 0.098], [0.615, 0.103, 0.094]];
  const jR = (y) => { const f = 1 + 0.07 * (1 - sstep(0.48, 0.56, y)); for (let i = 1; i < jProf.length; i++) if (y <= jProf[i][0]) { const a = jProf[i - 1], b = jProf[i], t = (y - a[0]) / (b[0] - a[0]); const e = t * t * (3 - 2 * t); return [lerp(a[1], b[1], e) * f, lerp(a[2], b[2], e) * f]; } return [jProf[jProf.length - 1][1], jProf[jProf.length - 1][2]]; };
  const open = (y) => lerp(0.3, 0.62, sstep(0.3, 0.6, y));
  const JR = hi ? 17 : 11, JC = hi ? 26 : 18;
  {
    const pos = [], idx = [], ys = [], ths = [], band = [];
    const rowsY = [];
    const pushRows = (a, b, n, bd) => { for (let i = 0; i <= n; i++) { rowsY.push(lerp(a, b, i / n)); band.push(bd); } };
    pushRows(JY0, 0.284, 2, 1); pushRows(0.284, 0.556, JR - 5, 0); pushRows(0.556, JY1, 2, 1);
    for (let i = 0; i < rowsY.length; i++) {
      const y = rowsY[i], [rx, rz] = jR(y), o0 = open(y);
      for (let k = 0; k <= JC; k++) {
        const th = lerp(o0, TAU - o0, k / JC);
        pos.push(Math.sin(th) * rx, y, Math.cos(th) * rz + 0.005); ys.push(band[i]); ths.push(th);
      }
    }
    const JRR = rowsY.length - 1;
    for (let i = 0; i < JRR; i++) { if (rowsY[i + 1] - rowsY[i] < 1e-5) continue; for (let k = 0; k < JC; k++) {
      const a = i * (JC + 1) + k, b = a + JC + 1;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    } }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
    // fix winding if needed (outward normals): test one triangle
    smoothNormals(g);
    const n0 = V3().fromBufferAttribute(g.attributes.normal, Math.floor(JRR / 2) * (JC + 1) + Math.floor(JC / 2));
    if (n0.z > 0) { for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; } g.setIndex(idx); smoothNormals(g); }
    g.userData.s = ys; g.userData.th = ths;
    add(g, (c) => {
      const y = c.p.y;
      if (c.s > 0.5) { set(c, C.white, M_RIB, SLOT_ACCENT); c.col.setScalar(y < 0.3 ? 0.9 : 1); return; }
      set(c, C.white, M_JACKET, SLOT_JACKET); c.col.setScalar(0.88);
      c.col.multiplyScalar(0.82 + 0.18 * sstep(0.29, 0.4, y));  // soft AO near the hem band
      // teal diamond badge region is separate geometry
    }, (c) => { const t = sstep(0.3, 0.42, c.p.y); c.sk = [[B.hips, 1 - t], [B.chest, t]]; });
  }
  // zipper tapes along the opening edges (trim colour, hides the shell edge)
  for (const side of [1, -1]) {
    add(sweep({ rings: hi ? 10 : 6, seg: 5, up: V3(0, 0, 1), cap0: true, cap1: true,
      path: (s, o) => { const y = lerp(JY0 + 0.004, 0.556, s), [rx, rz] = jR(y), th = open(y) * side; return o.set(Math.sin(th) * rx, y, Math.cos(th) * rz + 0.005); },
      shape: (s, th, o) => { o.x = Math.cos(th) * 0.0095; o.y = Math.sin(th) * 0.0095; } }),
    (c) => { set(c, C.white, M_TRIM, SLOT_TRIM); c.col.setScalar(1); }, (c) => { const t = sstep(0.3, 0.42, c.p.y); c.sk = [[B.hips, 1 - t], [B.chest, t]]; });
  }
  // badge: teal diamond on the fox's LEFT chest (+X), glowing
  {
    const th = 0.78, y = 0.45, [rx, rz] = jR(y);
    const P = V3(Math.sin(th) * rx, y, Math.cos(th) * rz + 0.005);
    const nrm = V3(Math.sin(th) / rx, 0, Math.cos(th) / rz).normalize();
    const mk = (sc, dz, col, mat) => {
      const g2 = new THREE.OctahedronGeometry(1, 0); g2.deleteAttribute('uv'); g2.deleteAttribute('normal');
      g2.setIndex([...Array(g2.attributes.position.count).keys()]);
      const p = g2.attributes.position, tmp = V3();
      const qn = new THREE.Quaternion().setFromUnitVectors(V3(0, 0, 1), nrm);
      for (let i = 0; i < p.count; i++) { tmp.fromBufferAttribute(p, i); tmp.set(tmp.x * 0.024 * sc, tmp.y * 0.032 * sc, tmp.z * 0.009).applyQuaternion(qn).add(P).addScaledVector(nrm, dz); p.setXYZ(i, tmp.x, tmp.y, tmp.z); }
      g2.computeVertexNormals();
      add(g2, (c) => set(c, col, mat), rig(B.chest));
    };
    mk(1.28, 0.001, C.badgeRim, M_GUNCORE); mk(1, 0.004, C.badge, M_GLOW2);
  }
  // pelvis / pants
  add(sweep({ rings: 5, seg: 12, tip0: true, cap1: true, up: V3(0, 0, 1),
    path: (s, o) => o.set(0, lerp(0.2, 0.34, s), 0),
    shape: (s, th, o) => { const k = Math.sqrt(Math.sin(Math.min(1, s * 1.6) * Math.PI / 2)); o.x = Math.cos(th) * 0.108 * k; o.y = Math.sin(th) * 0.13 * k; } }),
  (c) => set(c, C.pants, M_PANTS), rig(B.hips));

  // ---------------- LEGS ----------------
  for (const side of [1, -1]) {
    grp = side > 0 ? 'legL' : 'legR';
    const th = side > 0 ? B.thL : B.thR, kn = side > 0 ? B.knL : B.knR, ft = side > 0 ? B.ftL : B.ftR;
    const hip = V3(0.072 * side, 0.33, 0), knee = BP[kn], ank = V3(0.086 * side, 0.07, 0.004);
    const legPath = (s, o) => (s < 0.5 ? o.lerpVectors(hip, knee, s * 2) : o.lerpVectors(knee, ank, s * 2 - 1));
    add(sweep({ rings: hi ? 8 : 6, seg: hi ? 12 : 10, cap0: true, cap1: true, up: V3(0, 0, 1), path: legPath,
      shape: (s, t2, o) => { const r = lerp(0.07, 0.057, sstep(0, 0.55, s)) + 0.008 * sstep(0.75, 1, s); o.x = Math.cos(t2) * r; o.y = Math.sin(t2) * r; } }),
    (c) => { set(c, C.pants, M_PANTS); c.col.multiplyScalar(0.85 + 0.15 * sstep(0.2, 0.3, c.p.y)); },
    (c) => { const t = sstep(0.4, 0.6, c.s); c.sk = [[th, 1 - t], [kn, t]]; });
    // boot shaft
    add(sweep({ rings: 3, seg: hi ? 12 : 10, cap1: true, up: V3(0, 0, 1),
      path: (s, o) => o.set(0.087 * side, lerp(0.04, 0.128, s), 0.0),
      shape: (s, t2, o) => { const r = 0.06 + 0.004 * Math.sin(Math.PI * s); o.x = Math.cos(t2) * r; o.y = Math.sin(t2) * r; } }),
    (c) => { if (c.p.y > 0.116) { set(c, C.white, M_BOOT, SLOT_SOLE); c.col.setScalar(1); } else set(c, C.boot, M_BOOT); }, rig(ft));
    // boot foot (chunky, rounded, along +Z)
    const Z0 = -0.07, Z1 = 0.145;
    add(sweep({ rings: hi ? 10 : 7, seg: hi ? 14 : 10, tip0: true, tip1: true, up: V3(0, 1, 0),
      path: (s, o) => o.set(0.09 * side, lerp(0.07, 0.052, s), lerp(Z0, Z1, s)),
      shape: (s, t2, o) => {
        const end = Math.pow(Math.max(0, 1 - Math.pow(Math.abs(2 * s - 1), 5)), 0.35);
        const [cx, cy] = superE(t2, 2.6);
        const h = lerp(0.052, 0.036, sstep(0.3, 1, s)), w = lerp(0.056, 0.064, sstep(0.2, 0.9, s));
        o.x = cx * h * end * (cx < 0 ? 1.15 : 1); o.y = cy * w * end;
      } }),
    (c) => { set(c, C.boot, M_BOOT); c.col.multiplyScalar(0.85 + 0.15 * sstep(-0.5, 0.5, Math.cos(c.th))); }, rig(ft));
    // instep strap (accent band over the boot)
    for (const s0 of [0.5]) {
      const Cc = V3(0.09 * side, lerp(0.07, 0.052, s0), lerp(Z0, Z1, s0)), h0 = lerp(0.052, 0.036, sstep(0.3, 1, s0)) * 1.07, w0 = lerp(0.056, 0.064, sstep(0.2, 0.9, s0)) * 1.07;
      add(sweep({ rings: hi ? 10 : 7, seg: 5, up: V3(0, 0, 1), cap0: true, cap1: true,
        path: (u, o) => { const th = lerp(-1.75, 1.75, u), [cx, cy] = superE(th, 2.6); return o.set(Cc.x - cy * w0 * side * 0 - cy * w0, Cc.y + cx * h0, Cc.z); },
        shape: (u, th, o) => { o.x = Math.cos(th) * 0.014; o.y = Math.sin(th) * 0.0055; } }),
      (c) => { set(c, C.white, M_BOOT, SLOT_SOLE); c.col.setScalar(1); }, rig(ft));
    }
    // sole
    add(sweep({ rings: hi ? 8 : 6, seg: hi ? 12 : 10, tip0: true, tip1: true, up: V3(0, 1, 0),
      path: (s, o) => o.set(0.09 * side, 0.017, lerp(Z0 - 0.008, Z1 + 0.01, s)),
      shape: (s, t2, o) => { const end = Math.pow(Math.max(0, 1 - Math.pow(Math.abs(2 * s - 1), 6)), 0.3); const [cx, cy] = superE(t2, 3.5); o.x = cx * 0.019 * end; o.y = cy * 0.068 * end; } }),
    (c) => { set(c, C.white, M_SOLE, SLOT_SOLE); c.col.setScalar(c.n.y < -0.5 ? 0.55 : 1); }, rig(ft));
  }

  // ---------------- ARMS (sleeves, cuffs, fists) ----------------
  for (const side of [1, -1]) {
    grp = side > 0 ? 'armL' : 'armR';
    const sh = BP[side > 0 ? B.shL : B.shR], d = ARM_DIR(side);
    const bS = side > 0 ? B.shL : B.shR, bE = side > 0 ? B.elL : B.elR, bH = side > 0 ? B.hdL : B.hdR;
    const p0 = sh.clone().add(V3(-0.035 * side, 0.012, 0)), wr = sh.clone().addScaledVector(d, UP_LEN + FORE_LEN);
    const L = p0.distanceTo(wr), sEl = p0.distanceTo(BP[bE]) / L;
    add(sweep({ rings: hi ? 10 : 7, seg: hi ? 12 : 10, cap0: true, cap1: true, up: V3(0, 0, 1),
      path: (s, o) => o.lerpVectors(p0, wr, s),
      shape: (s, t2, o) => {
        let r = 0.064 + 0.012 * Math.sin(Math.PI * clamp(s / 0.5, 0, 1)) - 0.004 * sstep(sEl - 0.1, sEl, s) + 0.007 * Math.sin(Math.PI * clamp((s - sEl) / (0.85 - sEl), 0, 1));
        if (s > 0.84) r = 0.053; o.x = Math.cos(t2) * r; o.y = Math.sin(t2) * r;
      } }),
    (c) => { if (c.s > 0.83) { set(c, C.white, M_RIB, SLOT_ACCENT); c.col.setScalar(1); } else { set(c, C.white, M_JACKET, SLOT_JACKET); c.col.setScalar(0.82 + 0.08 * Math.cos(c.th)); } },
    (c) => { const t = sstep(sEl - 0.08, sEl + 0.08, c.s); c.sk = [[bS, 1 - t], [bE, t]]; });
    // fist (navy fingerless glove + blue fingertips)
    const F = BP[bH];
    add(blob(2, (u, o) => { o.set(u.x * 0.047, u.y * 0.05, u.z * 0.05); o.y += 0.004 * u.z; o.add(F); }),
      (c) => set(c, C.glove, M_GLOVE), rig(bH));
    add(sweep({ rings: 4, seg: 8, cap0: true, cap1: true, up: V3(0, 1, 0), path: (s, o) => o.set(F.x + lerp(-0.034, 0.034, s), F.y - 0.018, F.z + 0.036),
      shape: (s, t2, o) => { const r = 0.017 * (0.8 + 0.2 * Math.sin(Math.PI * s)); o.x = Math.cos(t2) * r; o.y = Math.sin(t2) * r; } }),
    (c) => set(c, C.fur, M_FUR), rig(bH));
    add(spike(F.clone().add(V3(-0.03 * side, 0.02, 0.02)), V3(0.3 * side, 0.2, 1), 0.04, 0.017, { seg: 6, rings: 3, pw: 0.5 }),
      (c) => set(c, C.glove, M_GLOVE), rig(bH));
  }

  // ---------------- BLASTER (right hand) ----------------
  grp = 'armR';
  {
    const F = BP[B.hdR], gx = F.x, gy = F.y + 0.056;
    const torus = (R, r, z, rs, ts) => { const tg = new THREE.TorusGeometry(R, r, rs, ts); tg.deleteAttribute('uv'); tg.deleteAttribute('normal'); const m = mergeVertices(tg); m.translate(gx, gy, F.z + z); m.computeVertexNormals(); return m; };
    // receiver: boxy rounded block sitting on the fist (white shell top, dark flanks, cyan side line)
    add(sweep({ rings: hi ? 9 : 6, seg: hi ? 16 : 12, cap0: true, cap1: true, up: V3(0, 1, 0),
      path: (s, o) => o.set(gx, gy + 0.003 * s, F.z + lerp(-0.045, 0.068, s)),
      shape: (s, t2, o) => {
        const e = Math.pow(Math.max(0, 1 - Math.pow(Math.abs(2 * s - 1), 8)), 0.25);
        const [cx, cy] = superE(t2, 3.2);
        o.x = cx * 0.032 * Math.max(0.4, e) * (cx < 0 ? 0.95 : 1) * lerp(1, 0.84, s); o.y = cy * 0.027 * Math.max(0.4, e);
      } }),
    (c) => {
      const up = Math.cos(c.th), sideAbs = Math.abs(Math.sin(c.th));
      if (up > 0.3) set(c, C.gunShell, M_GUN); else set(c, C.gunCore, M_GUNCORE);
      if (sideAbs > 0.97 && c.s > 0.2 && c.s < 0.85) set(c, C.gunGlow, M_GLOW2);
    }, rig(B.hdR));
    // grip (angled back, pokes out below the fist)
    add(sweep({ rings: 3, seg: 8, cap0: true, cap1: true, up: V3(0, 0, 1),
      path: (s, o) => o.set(gx, lerp(F.y - 0.062, gy - 0.01, s), F.z + lerp(-0.034, -0.008, s)),
      shape: (s, t2, o) => { const [cx, cy] = superE(t2, 3); o.x = cx * 0.021; o.y = cy * 0.015; } }),
    (c) => set(c, C.gunCore, M_GUNCORE), rig(B.hdR));
    // barrel + glowing coil rings
    add(sweep({ rings: 4, seg: hi ? 12 : 8, cap1: true, up: V3(0, 1, 0),
      path: (s, o) => o.set(gx, gy + 0.004, F.z + lerp(0.05, 0.138, s)),
      shape: (s, t2, o) => { const r = 0.0155; o.x = Math.cos(t2) * r; o.y = Math.sin(t2) * r; } }),
    (c) => set(c, C.gunCore, M_GUNCORE), rig(B.hdR));
    for (const z of [0.086, 0.112]) add(torus(0.0175, 0.0042, z, 5, hi ? 12 : 8).translate(0, 0.004, 0), (c) => set(c, C.gunGlow, M_GLOW2), rig(B.hdR));
    // flared emitter + hot core
    add(torus(0.023, 0.0078, 0.144, 6, hi ? 14 : 10).translate(0, 0.004, 0), (c) => set(c, C.gunGlow, M_GLOW), rig(B.hdR));
    add(blob(1, (u, o) => o.set(u.x * 0.016, u.y * 0.016, u.z * 0.011).add(V3(gx, gy + 0.004, F.z + 0.147))), (c) => { set(c, C.white, M_GLOW2); c.col.lerp(C.gunGlow, 0.3); }, rig(B.hdR));
    // little "signal" antenna with a glowing tip on the back of the receiver
    add(sweep({ rings: 2, seg: 5, cap0: true, cap1: true, up: V3(0, 0, 1), path: (s, o) => o.set(gx + 0.01, gy + lerp(0.02, 0.06, s), F.z - 0.028 - 0.012 * s),
      shape: (s, t2, o) => { o.x = Math.cos(t2) * 0.0035; o.y = Math.sin(t2) * 0.0035; } }), (c) => set(c, C.gunCore, M_GUNCORE), rig(B.hdR));
    add(blob(0, (u, o) => o.set(u.x * 0.008, u.y * 0.008, u.z * 0.008).add(V3(gx + 0.01, gy + 0.064, F.z - 0.041))), (c) => set(c, C.gunGlow, M_GLOW), rig(B.hdR));
  }

  // ---------------- TAIL ----------------
  grp = 'tail';
  {
    const TR = hi ? 22 : 16, TS = hi ? 15 : 12;
    const tp = V3();
    add(sweep({ rings: TR, seg: TS, cap0: true, tip1: true, up: V3(1, 0, 0),
      path: (s, o) => tailPath(s, o),
      shape: (s, th, o) => {
        let r = 0.036 * (1 - s) + 0.135 * Math.sin(Math.PI * Math.pow(s, 0.72));
        const lock = Math.pow(0.5 + 0.5 * Math.cos(th * 7 + s * 16), 2.5);
        r *= 1 + (0.13 * lock - 0.05) * sstep(0.08, 0.3, s);
        o.x = Math.cos(th) * r; o.y = Math.sin(th) * r;
      } }),
    (c) => {
      const lock = Math.cos(c.th * 7 + c.s * 16);
      const wt = sstep(0.67, 0.71, c.s + 0.02 * lock);
      set(c, C.fur, wt > 0.5 ? M_WHITE : M_FUR);
      c.col.lerp(C.furDeep, 0.3 * (1 - sstep(0.0, 0.3, c.s))).lerp(C.furTop, 0.25 * (0.5 + 0.5 * lock));
      c.col.lerp(C.white, wt);
    },
    (c) => { // blend along the tail chain
      const s = c.s; let k = 0; while (k < 4 && s > TAIL_S[k + 1]) k++;
      if (k >= 4) { c.sk = [[B.t4, 1]]; return; }
      const t = sstep(0, 1, (s - TAIL_S[k]) / (TAIL_S[k + 1] - TAIL_S[k]));
      c.sk = [[B.t0 + k, 1 - t], [B.t0 + k + 1, t]];
    });
    void tp;
  }

  // ---------------- baked ambient occlusion from sphere proxies ----------------
  const OCC = [
    ['head', HEAD_C, 0.235], ['torso', V3(0, 0.42, 0.0), 0.155], ['torso', V3(0, 0.29, 0), 0.13],
    ['armL', BP[B.elL], 0.06], ['armR', BP[B.elR], 0.06], ['armL', BP[B.hdL], 0.05], ['armR', BP[B.hdR], 0.05],
    ['legL', BP[B.knL], 0.065], ['legR', BP[B.knR], 0.065], ['tail', tailPath(0.45, V3()), 0.13], ['tail', tailPath(0.15, V3()), 0.07],
    ['ear', BP[B.earL].clone().add(V3(0.04, 0.08, 0)), 0.05], ['ear', BP[B.earR].clone().add(V3(-0.04, 0.08, 0)), 0.05],
  ];
  const aoAt = (grpName, p, n) => {
    let o = 0;
    for (const [g2, cc, r] of OCC) {
      if (g2 === grpName || (grpName === 'ear' && g2 === 'head')) continue;
      const dx = cc.x - p.x, dy = cc.y - p.y, dz = cc.z - p.z, d2 = dx * dx + dy * dy + dz * dz, d = Math.sqrt(d2);
      if (d < r * 0.9) { o += 0.5; continue; }
      const cosT = (n.x * dx + n.y * dy + n.z * dz) / d;
      o += clamp(cosT, 0, 1) * (r * r) / d2;
    }
    return 1 - clamp(o * 0.55, 0, 0.5) - 0.12 * clamp(0.3 - p.y, 0, 0.3) / 0.3 * clamp(-n.y + 0.3, 0, 1);
  };
  // ---------------- merge ----------------
  let nv = 0, ni = 0; for (const pt of parts) { nv += pt.g.attributes.position.count; ni += pt.g.index.count; }
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), col = new Float32Array(nv * 3);
  const mat = new Float32Array(nv * 4), slot = new Float32Array(nv), si = new Uint16Array(nv * 4), sw = new Float32Array(nv * 4);
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  const c = { p: V3(), n: V3(), s: 0, th: 0, u: null, col: new THREE.Color(), mat: M_FUR, slot: 0, sk: null };
  let vo = 0, io = 0;
  for (const pt of parts) {
    const g = pt.g, P = g.attributes.position, Nn = g.attributes.normal, I = g.index.array, ud = g.userData;
    for (let i = 0; i < P.count; i++) {
      c.p.fromBufferAttribute(P, i); c.n.fromBufferAttribute(Nn, i);
      c.s = ud.s ? ud.s[i] : 0; c.th = ud.th ? ud.th[i] : 0; c.u = ud.u ? ud.u[i] : null;
      c.col.setRGB(1, 1, 1); c.slot = 0; c.mat = M_FUR; c.sk = null;
      pt.paint(c); pt.skin(c);
      if (!(c.mat[3] > 0.25)) c.col.multiplyScalar(aoAt(pt.grp, c.p, c.n));
      const o = vo + i;
      pos.set([c.p.x, c.p.y, c.p.z], o * 3); nor.set([c.n.x, c.n.y, c.n.z], o * 3);
      col.set([c.col.r, c.col.g, c.col.b], o * 3); mat.set(c.mat, o * 4); slot[o] = c.slot;
      let tw = 0; for (const [, w] of c.sk) tw += w;
      for (let j = 0; j < 4; j++) { const e = c.sk[j]; si[o * 4 + j] = e ? e[0] : 0; sw[o * 4 + j] = e ? e[1] / tw : 0; }
    }
    for (let j = 0; j < I.length; j++) idx[io + j] = I[j] + vo;
    vo += P.count; io += I.length;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aMat', new THREE.BufferAttribute(mat, 4));
  g.setAttribute('aSlot', new THREE.BufferAttribute(slot, 1));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

// ------------------------------------------------------------------------------------------
// FACE DECAL: eyes + brows painted into an expression atlas, laid on the analytic head surface
// ------------------------------------------------------------------------------------------
const DEC = { phiMax: 0.88, psiMin: -0.4, psiMax: 0.64 };      // decal extent (radians)
const DEC_WM = 2 * DEC.phiMax * 0.255, DEC_HM = (DEC.psiMax - DEC.psiMin) * 0.232; // metres (approx arc)
const EYE = { x: 0.099, y: 0.014, rx: 0.073, ry: 0.077 };        // eye centre/half-size in decal metres
const CELL_W = 576, CELL_H = 320, ATLAS_C = 2, ATLAS_R = 3;
const EXPR = { open: 0, blink: 1, hurt: 2, happy: 3, dead: 4, fierce: 5 };
function buildDecalGeo(q, headBindPos) {
  const NU = q >= 1 ? 34 : 24, NV = q >= 1 ? 20 : 14;
  const pos = [], uv = [], idx = [], o = V3(), o2 = V3(), o3 = V3(), n = V3(), du = V3(), dv = V3();
  const v0 = -DEC.psiMin / (DEC.psiMax - DEC.psiMin);
  const surf = (phi, psi, out) => headSurface(Math.cos(psi) * Math.sin(phi), Math.sin(psi), Math.cos(psi) * Math.cos(phi), out);
  for (let j = 0; j <= NV; j++) for (let i = 0; i <= NU; i++) {
    const u = i / NU, v = j / NV;
    const phi = (u - 0.5) * 2 * DEC.phiMax, psi = lerp(DEC.psiMin, DEC.psiMax, v);
    surf(phi, psi, o); surf(phi + 0.01, psi, o2); surf(phi, psi + 0.01, o3);
    du.subVectors(o2, o); dv.subVectors(o3, o); n.crossVectors(du, dv).normalize();
    // bulge over each eye so they read as glossy domes
    const tx = (u - 0.5) * DEC_WM, ty = (v - v0) * DEC_HM;
    let bulge = 0;
    for (const sd of [-1, 1]) {
      const dx = (tx - EYE.x * sd) / (EYE.rx * 1.02), dy = (ty - EYE.y) / (EYE.ry * 1.02), d2 = dx * dx + dy * dy;
      if (d2 < 1) bulge += 0.011 * (1 - d2) * (1 - d2);
    }
    o.addScaledVector(n, 0.0016 + bulge).add(HEAD_C).sub(headBindPos);
    pos.push(o.x, o.y, o.z); uv.push(u, v);
  }
  for (let j = 0; j < NV; j++) for (let i = 0; i < NU; i++) {
    const a = j * (NU + 1) + i, b = a + NU + 1;
    idx.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  // make sure normals face outward (+Z-ish)
  const nz = g.attributes.normal.getZ(Math.floor(NV / 2) * (NU + 1) + Math.floor(NU / 2));
  if (nz < 0) { const I = g.index.array; for (let i = 0; i < I.length; i += 3) { const t = I[i + 1]; I[i + 1] = I[i + 2]; I[i + 2] = t; } g.computeVertexNormals(); }
  return g;
}
function drawAtlas() {
  const cv = document.createElement('canvas'); cv.width = CELL_W * ATLAS_C; cv.height = CELL_H * ATLAS_R;
  const g = cv.getContext('2d');
  const mk = document.createElement('canvas'); mk.width = cv.width / 4; mk.height = cv.height / 4;
  const mg = mk.getContext('2d'); mg.fillStyle = 'rgb(0,245,0)'; mg.fillRect(0, 0, mk.width, mk.height); mg.scale(0.25, 0.25);
  const PXM = CELL_W / DEC_WM, PYM = CELL_H / DEC_HM;
  const v0 = -DEC.psiMin / (DEC.psiMax - DEC.psiMin);
  const X = (tx) => CELL_W / 2 + tx * PXM, Y = (ty) => CELL_H * (1 - v0) - ty * PYM;
  const INK = '#070812', BROW = '#0a0c1a';
  // filled tapered stroke through points (quadratic spline), widths per point
  const taper = (pts, wid, col) => {
    const P = [], W = [];
    for (let i = 0; i < pts.length - 1; i++) for (let k = 0; k < 12; k++) {
      const t = k / 12, a = pts[i], b = pts[i + 1];
      P.push([lerp(a[0], b[0], t), lerp(a[1], b[1], t)]); W.push(lerp(wid[i], wid[i + 1], t));
    }
    P.push(pts[pts.length - 1]); W.push(wid[wid.length - 1]);
    // chaikin smooth
    for (let it = 0; it < 2; it++) { const Q = [P[0]], QW = [W[0]]; for (let i = 0; i < P.length - 1; i++) { Q.push([P[i][0] * 0.75 + P[i + 1][0] * 0.25, P[i][1] * 0.75 + P[i + 1][1] * 0.25], [P[i][0] * 0.25 + P[i + 1][0] * 0.75, P[i][1] * 0.25 + P[i + 1][1] * 0.75]); QW.push(W[i] * 0.75 + W[i + 1] * 0.25, W[i] * 0.25 + W[i + 1] * 0.75); } Q.push(P[P.length - 1]); QW.push(W[W.length - 1]); P.length = 0; W.length = 0; P.push(...Q); W.push(...QW); }
    const L = [], R = [];
    for (let i = 0; i < P.length; i++) {
      const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)];
      let nx = -(b[1] - a[1]), ny = b[0] - a[0]; const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
      L.push([P[i][0] + nx * W[i] / 2, P[i][1] + ny * W[i] / 2]); R.push([P[i][0] - nx * W[i] / 2, P[i][1] - ny * W[i] / 2]);
    }
    g.fillStyle = col; g.beginPath(); g.moveTo(L[0][0], L[0][1]);
    for (const q of L) g.lineTo(q[0], q[1]);
    for (let i = R.length - 1; i >= 0; i--) g.lineTo(R[i][0], R[i][1]);
    g.closePath(); g.fill();
  };
  const cells = ['open', 'blink', 'hurt', 'happy', 'dead', 'fierce'];
  cells.forEach((name, ci) => {
    g.save(); mg.save();
    g.translate((ci % ATLAS_C) * CELL_W, Math.floor(ci / ATLAS_C) * CELL_H); mg.translate((ci % ATLAS_C) * CELL_W, Math.floor(ci / ATLAS_C) * CELL_H);
    g.beginPath(); g.rect(3, 3, CELL_W - 6, CELL_H - 6); g.clip();
    for (const sd of [-1, 1]) { // sd = +1 -> fox's LEFT eye (canvas right when facing camera)
      const cx = X(EYE.x * sd), cy = Y(EYE.y), rx = EYE.rx * PXM, ry = EYE.ry * PYM;
      const mine = sd > 0;   // the smirk side: brow cocked up, lid a touch higher
      const brow = (lift, angle, thick, arch = 0.25) => {
        const ix = cx - sd * rx * 0.72, iy = cy - ry * (0.92 - lift) + angle * ry * 0.2;
        const mx = cx + sd * rx * 0.1, my = cy - ry * (1.14 + arch * 0.22 - lift) - angle * ry * 0.03;
        const ox = cx + sd * rx * 0.98, oy = cy - ry * (1.08 - lift) - angle * ry * 0.1;
        taper([[ix - sd * 4, iy + 3], [ix, iy], [mx, my], [ox, oy]], [thick * 0.8, thick, thick * 0.8, thick * 0.2], BROW);
      };
      if (name === 'open' || name === 'fierce') {
        const fierce = name === 'fierce';
        const lid = fierce ? 0.34 : (mine ? 0.1 : 0.2);          // how far the upper lid drops (cocky, half-lidded)
        const I = [cx - sd * rx * 0.97, cy + ry * 0.12], O = [cx + sd * rx * 1.0, cy - ry * 0.2];
        const upper = (ctx, first) => {
          if (first) ctx.moveTo(I[0], I[1]);
          ctx.bezierCurveTo(cx - sd * rx * 0.9, cy - ry * (0.7 - lid), cx + sd * rx * 0.35, cy - ry * (1.08 - lid * 0.7), O[0], O[1]);
        };
        const lower = (ctx) => ctx.bezierCurveTo(cx + sd * rx * 1.05, cy + ry * 0.75, cx - sd * rx * 0.55, cy + ry * 1.12, I[0], I[1]);
        const shape = () => { g.beginPath(); upper(g, true); lower(g); g.closePath(); };
        mg.fillStyle = 'rgb(255,70,0)'; mg.beginPath(); upper(mg, true); lower(mg); mg.closePath(); mg.fill();
        // sclera
        shape(); const sg = g.createLinearGradient(0, cy - ry, 0, cy + ry);
        sg.addColorStop(0, '#b9c8e6'); sg.addColorStop(0.4, '#f4f8ff'); sg.addColorStop(1, '#ffffff'); g.fillStyle = sg; g.fill();
        g.save(); shape(); g.clip();
        // iris (big, tucked under the upper lid)
        const ix = cx - sd * rx * 0.06, iy = cy + ry * 0.14, ir = ry * (fierce ? 0.72 : 0.8);
        const ig = g.createRadialGradient(ix, iy + ir * 0.45, ir * 0.05, ix, iy, ir);
        ig.addColorStop(0, '#b4f6ff'); ig.addColorStop(0.3, '#46b4ff'); ig.addColorStop(0.68, '#1a5ee8'); ig.addColorStop(1, '#0a2270');
        g.fillStyle = ig; g.beginPath(); g.arc(ix, iy, ir, 0, TAU); g.fill();
        g.strokeStyle = '#051238'; g.lineWidth = 6; g.stroke();
        g.strokeStyle = 'rgba(170,235,255,0.4)'; g.lineWidth = 3; g.beginPath(); g.arc(ix, iy, ir * 0.66, 0.35, Math.PI - 0.35); g.stroke();
        // pupil
        g.fillStyle = '#040716'; g.beginPath(); g.ellipse(ix, iy, ir * (fierce ? 0.33 : 0.43), ir * (fierce ? 0.44 : 0.48), 0, 0, TAU); g.fill();
        // lid shadow on the eyeball
        const lg = g.createLinearGradient(0, cy - ry * (1.0 - lid), 0, cy - ry * (0.2 - lid)); lg.addColorStop(0, 'rgba(8,16,55,0.6)'); lg.addColorStop(1, 'rgba(8,16,55,0)');
        g.fillStyle = lg; g.fillRect(cx - rx * 1.2, cy - ry * 1.2, rx * 2.4, ry * 1.4);
        // highlights
        g.fillStyle = '#ffffff';
        g.beginPath(); g.ellipse(ix - ir * 0.34, iy - ir * 0.3, ir * 0.3, ir * 0.24, -0.5, 0, TAU); g.fill();
        g.beginPath(); g.arc(ix + ir * 0.36, iy + ir * 0.36, ir * 0.11, 0, TAU); g.fill();
        g.fillStyle = 'rgba(255,255,255,0.55)'; g.beginPath(); g.arc(ix + ir * 0.2, iy - ir * 0.5, ir * 0.07, 0, TAU); g.fill();
        g.restore();
        // thick upper lid line with a wing at the outer corner; thin lower lid
        g.lineCap = 'round'; g.lineJoin = 'round';
        g.strokeStyle = INK; g.lineWidth = 15; g.beginPath(); upper(g, true); g.stroke();
        taper([[O[0] - sd * rx * 0.25, O[1] - ry * 0.02], [O[0] + sd * rx * 0.12, O[1] - ry * 0.12], [O[0] + sd * rx * 0.3, O[1] - ry * 0.34]], [15, 11, 2], INK);
        g.strokeStyle = 'rgba(7,8,18,0.9)'; g.lineWidth = 5; g.beginPath(); g.moveTo(O[0], O[1]); lower(g); g.stroke();
        if (fierce) brow(0.02, 1.2, 30, 0.0);
        else if (mine) brow(0.02, 0.3, 30, 0.5);
        else brow(-0.06, 0.9, 30, 0.15);
      } else if (name === 'blink' || name === 'happy') {
        g.strokeStyle = INK; g.lineCap = 'round'; g.lineWidth = 15; g.beginPath();
        if (name === 'blink') { g.moveTo(cx - rx * 0.95, cy + ry * 0.05); g.quadraticCurveTo(cx, cy + ry * 0.5, cx + rx * 0.95, cy + ry * 0.0); }
        else { g.moveTo(cx - rx * 0.85, cy + ry * 0.3); g.quadraticCurveTo(cx, cy - ry * 0.7, cx + rx * 0.85, cy + ry * 0.3); }
        g.stroke();
        const fx = cx + sd * rx * 0.88, fy = name === 'blink' ? cy + ry * 0.02 : cy + ry * 0.28;
        taper([[fx - sd * 10, fy], [fx + sd * 8, fy - 8], [fx + sd * 22, fy - 26]], [14, 10, 2], INK);
        if (name === 'happy') brow(0.18, -0.4, 24, 0.5);
        else if (mine) brow(0.02, 0.3, 30, 0.5); else brow(-0.06, 0.9, 30, 0.15);
      } else if (name === 'hurt') {
        g.strokeStyle = INK; g.lineCap = 'round'; g.lineJoin = 'round'; g.lineWidth = 15; g.beginPath();
        g.moveTo(cx - sd * rx * 0.7, cy - ry * 0.5); g.lineTo(cx + sd * rx * 0.55, cy + ry * 0.05); g.lineTo(cx - sd * rx * 0.7, cy + ry * 0.55); g.stroke();
        brow(0.1, -1.0, 22, 0.1);
      } else if (name === 'dead') {
        g.strokeStyle = INK; g.lineCap = 'round'; g.lineWidth = 15; g.beginPath();
        g.moveTo(cx - rx * 0.6, cy - ry * 0.55); g.lineTo(cx + rx * 0.6, cy + ry * 0.6);
        g.moveTo(cx + rx * 0.6, cy - ry * 0.55); g.lineTo(cx - rx * 0.6, cy + ry * 0.6); g.stroke();
        brow(0.05, -0.5, 20, 0.2);
      }
    }
    g.restore(); mg.restore();
  });
  return { color: cv, mask: mk };
}
function radialTex(size, stops) {
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  const g = cv.getContext('2d'), gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, c] of stops) gr.addColorStop(o, c);
  g.fillStyle = gr; g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}

// ------------------------------------------------------------------------------------------
// Body material: per-vertex roughness/metal/sheen/glow + outfit slot colours + rim + hurt flash
// ------------------------------------------------------------------------------------------
function makeBodyMaterial(U, physical) {
  const Mat = physical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
  const opts = { vertexColors: true, roughness: 0.7, metalness: 0 };
  if (physical) Object.assign(opts, { sheen: 1, sheenColor: new THREE.Color('#7fa8ff'), sheenRoughness: 0.5 });
  const m = new Mat(opts);
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 aMat; attribute float aSlot; varying vec4 vMat;
uniform vec3 uJacket; uniform vec3 uAccent; uniform vec3 uTrim; uniform vec3 uSole;`)
      .replace('#include <color_vertex>', `#include <color_vertex>
vMat = aMat;
if (aSlot > 0.5) { vec3 sc = aSlot < 1.5 ? uJacket : (aSlot < 2.5 ? uAccent : (aSlot < 3.5 ? uTrim : uSole)); vColor.rgb *= sc; }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec4 vMat; uniform float uGlowA; uniform float uGlowB; uniform vec3 uFlash; uniform float uFlashAmt; uniform float uFlashE; uniform vec3 uRim; uniform float uRimPow;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
diffuseColor.rgb = mix(diffuseColor.rgb, uFlash, uFlashAmt);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = vMat.x;`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
metalnessFactor = vMat.y;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{ float eA = step(0.75, vMat.w); float eB = step(0.25, vMat.w) * (1.0 - eA);
  totalEmissiveRadiance += diffuseColor.rgb * (eA * uGlowA * (vMat.w - 0.6) * 2.5 + eB * uGlowB);
  float rimF = 1.0 - saturate(dot(normal, normalize(vViewPosition)));
  totalEmissiveRadiance += uRim * pow(rimF, uRimPow) * (1.0 - eA);
  totalEmissiveRadiance += uFlash * uFlashE; }`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
#ifdef USE_SHEEN
material.sheenColor *= vMat.z;
#endif`);
  };
  m.customProgramCacheKey = () => 'fox-body-' + (physical ? 'p' : 's');
  return m;
}

// ------------------------------------------------------------------------------------------
// Pose channels (a flat Float32Array per pose; blended, then applied to bones)
// ------------------------------------------------------------------------------------------
const CH = ['baseX', 'baseY', 'baseZ', 'leanX', 'leanZ', 'spin', 'sqY', 'sqZ',
  'hipYaw', 'hipX', 'hipZ', 'chestYaw', 'chestX', 'chestZ', 'headYaw', 'headX', 'headZ',
  'earLx', 'earLz', 'earRx', 'earRz', 'tailLift', 'tailSway', 'tailCurl', 'tailStream',
  'hLx', 'hLy', 'hLz', 'pLx', 'pLy', 'pLz', 'hdLx', 'hdLz',            // left hand IK target (chest space, rel. shoulder) + elbow pole
  'hRx', 'hRy', 'hRz', 'pRx', 'pRy', 'pRz', 'gunAim', 'gunPitch', 'gunYaw',
  'thLx', 'thLz', 'thLy', 'knL', 'ftLx', 'thRx', 'thRz', 'thRy', 'knR', 'ftRx'];
const I = {}; CH.forEach((k, i) => { I[k] = i; });
const NCH = CH.length;
const newPose = () => { const p = new Float32Array(NCH); p[I.sqY] = 1; p[I.sqZ] = 1; return p; };
const blendInto = (a, b, w) => { if (w <= 0) return; if (w >= 1) { a.set(b); return; } for (let i = 0; i < NCH; i++) a[i] += (b[i] - a[i]) * w; };

// ------------------------------------------------------------------------------------------
// createFox
// ------------------------------------------------------------------------------------------
export function createFox(opts = {}) {
  const root = new THREE.Object3D(); root.name = 'fox';
  const BP = bindPositions();

  // bones
  const bones = BP.map((p, i) => { const b = new THREE.Bone(); b.name = 'b' + i; return b; });
  bones.forEach((b, i) => { const par = PARENT[i]; if (par < 0) { b.position.copy(BP[i]); root.add(b); } else { b.position.subVectors(BP[i], BP[par]); bones[par].add(b); } });
  for (const i of [B.shL, B.shR, B.hips, B.base, B.thL, B.thR]) bones[i].rotation.order = 'YXZ';
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);

  // shared uniforms
  const U = {
    uJacket: { value: new THREE.Color() }, uAccent: { value: new THREE.Color() }, uTrim: { value: new THREE.Color() }, uSole: { value: new THREE.Color() },
    uGlowA: { value: 1.0 }, uGlowB: { value: 0 }, uFlash: { value: new THREE.Color(1, 1, 1) }, uFlashAmt: { value: 0 }, uFlashE: { value: 0 },
    uRim: { value: new THREE.Color('#4f7dff').multiplyScalar(0.28) }, uRimPow: { value: 3.0 },
  };
  const matHi = makeBodyMaterial(U, true);
  let matLo = null;
  const geoCache = {};
  const geoFor = (lod) => geoCache[lod] || (geoCache[lod] = buildBody(lod, BP));
  const body = new THREE.SkinnedMesh(geoFor(1), matHi);
  body.name = 'foxBody'; body.castShadow = true; body.receiveShadow = true; body.frustumCulled = false;
  root.add(body); body.bind(skeleton);

  // face decal (child of head bone)
  const atlasCanvas = drawAtlas();
  const atlas = new THREE.CanvasTexture(atlasCanvas.color); atlas.colorSpace = THREE.SRGBColorSpace; atlas.anisotropy = 4;
  atlas.repeat.set(1 / ATLAS_C, 1 / ATLAS_R);
  const atlasMask = new THREE.CanvasTexture(atlasCanvas.mask); atlasMask.repeat.set(1 / ATLAS_C, 1 / ATLAS_R);
  const faceMat = new THREE.MeshPhysicalMaterial({
    map: atlas, emissiveMap: atlas, emissive: new THREE.Color('#9fe8ff'), emissiveIntensity: 0.0,
    clearcoatMap: atlasMask, roughnessMap: atlasMask,
    transparent: true, depthWrite: false, roughness: 1, clearcoat: 0.25, clearcoatRoughness: 0.3,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const decalGeo = {};
  const decalFor = (lod) => decalGeo[lod] || (decalGeo[lod] = buildDecalGeo(lod, BP[B.head]));
  const face = new THREE.Mesh(decalFor(1), faceMat); face.name = 'foxFace'; face.frustumCulled = false;
  bones[B.head].add(face);
  const setExpr = (e) => { atlas.offset.set((e % ATLAS_C) / ATLAS_C, 1 - (Math.floor(e / ATLAS_C) + 1) / ATLAS_R); atlasMask.offset.copy(atlas.offset); };
  setExpr(EXPR.open);

  // muzzle + flare
  const muzzleObj = new THREE.Object3D(); muzzleObj.position.set(0, 0.06, 0.162); bones[B.hdR].add(muzzleObj);
  const flareMat = new THREE.SpriteMaterial({ map: radialTex(64, [[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(160,250,255,0.9)'], [0.6, 'rgba(40,200,255,0.25)'], [1, 'rgba(0,120,255,0)']]),
    color: new THREE.Color(1.6, 2.4, 2.6), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
  const flare = new THREE.Sprite(flareMat); flare.scale.setScalar(0.001); flare.visible = false; muzzleObj.add(flare);

  // blob contact shadow
  const shadowMat = new THREE.MeshBasicMaterial({ map: radialTex(64, [[0, 'rgba(0,0,0,0.55)'], [0.55, 'rgba(0,0,0,0.3)'], [1, 'rgba(0,0,0,0)']]), transparent: true, depthWrite: false, color: 0x000000 });
  const blobShadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shadowMat);
  blobShadow.name = 'foxBlobShadow'; blobShadow.rotation.x = -Math.PI / 2; blobShadow.position.y = 0.012; blobShadow.scale.set(0.62, 0.62, 1); blobShadow.renderOrder = -1;
  root.add(blobShadow);

  // ---------- outfit ----------
  const cur = { jacket: new THREE.Color(), accent: new THREE.Color(), trim: new THREE.Color(), sole: new THREE.Color() };
  const tgt = { jacket: new THREE.Color(), accent: new THREE.Color(), trim: new THREE.Color(), sole: new THREE.Color() };
  let outfitId = null, outfitLerp = 1, trimGlowBase = 0;
  function setOutfit(id, instant) {
    const o = OUTFITS.find((x) => x.id === id) || OUTFITS[0];
    outfitId = o.id;
    tgt.jacket.set(o.jacket); tgt.accent.set(o.accent); tgt.trim.set(o.trim);
    const jl = tgt.jacket.r * 0.2126 + tgt.jacket.g * 0.7152 + tgt.jacket.b * 0.0722;
    tgt.sole.set(jl < 0.05 ? o.trim : o.jacket);
    trimGlowBase = o.id === 'midnight' ? 0.9 : 0.0;
    if (instant) { for (const k in cur) cur[k].copy(tgt[k]); outfitLerp = 1; } else outfitLerp = 0;
    applyOutfit();
  }
  function applyOutfit() { U.uJacket.value.copy(cur.jacket); U.uAccent.value.copy(cur.accent); U.uTrim.value.copy(cur.trim); U.uSole.value.copy(cur.sole); }

  // ---------- quality ----------
  let quality = 2;
  function setQuality(q) {
    quality = q | 0;
    const lod = quality <= 0 ? 0 : 1;
    const g = geoFor(lod);
    if (body.geometry !== g) body.geometry = g;
    const dg = decalFor(lod); if (face.geometry !== dg) face.geometry = dg;
    if (quality <= 0) { if (!matLo) matLo = makeBodyMaterial(U, false); body.material = matLo; faceMat.clearcoat = 0; }
    else { body.material = matHi; faceMat.clearcoat = 0.25; }
    faceMat.needsUpdate = true;
  }

  // ---------- animation state ----------
  let mode = opts.pose === 'title' ? 'title' : 'game';
  const S = {
    first: true, yaw: 0, hipTwist: 0, phase: 0, runW: 0, aimW: 0, lastFire: 9, recoil: 0, flare: 0,
    hurt: 0, prevHurtT: 0, dashW: 0, dashDur: 0.2, dashDir: 0, wasDash: false,
    deadT: -1, vicT: -1, od: 0, prevFace: 0, faceRate: 0, bank: 0, aimRelWorld: 0,
    sqV: 0, sq: 0, tailSp: 0, tailSv: 0, earSp: 0, earSv: 0, yawVel: 0,
    blinkNext: 2.2, blinkT: -1, twitchNext: 1.5, twitchT: -1, twitchSide: 1,
  };
  const P0 = newPose(), PL = newPose(), PX = newPose();  // result, locomotion, overlay scratch
  const qA = new THREE.Quaternion(), qB = new THREE.Quaternion(), qC = new THREE.Quaternion();
  const vX = V3(1, 0, 0), vZ = V3(0, 0, 1);
  const eTmp = new THREE.Euler(0, 0, 0, 'YXZ');
  // per tail bone side-sway axis (perpendicular to the rest tangent and X)
  const tailAxis = [];
  for (let i = 0; i < 5; i++) { const a = tailPath(Math.max(0, TAIL_S[i] - 0.02), V3()), b = tailPath(Math.min(1, TAIL_S[i] + 0.05), V3()); const t = b.sub(a).normalize(); tailAxis.push(V3().crossVectors(t, vX).normalize()); }

  // ---------- helpers ----------
  const hash = (x) => { const s = Math.sin(x * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

  // arm targets are given with x = OUTWARD (+) for either side; stored in real chest-space coords
  const arm = (P, side, x, y, z, px, py, pz) => {
    if (side > 0) { P[I.hLx] = x; P[I.hLy] = y; P[I.hLz] = z; P[I.pLx] = px; P[I.pLy] = py; P[I.pLz] = pz; }
    else { P[I.hRx] = -x; P[I.hRy] = y; P[I.hRz] = z; P[I.pRx] = -px; P[I.pRy] = py; P[I.pRz] = pz; }
  };

  function idleLayer(p, t, P, breathAmt = 1) {
    const br = Math.sin(t * 2.1);
    P[I.chestX] += 0.025 * br * breathAmt; P[I.headX] += -0.02 * br * breathAmt; P[I.baseY] += 0.004 * br * breathAmt;
    P[I.hLy] += 0.006 * br * breathAmt; P[I.hLx] += 0.004 * br * breathAmt;
    P[I.tailSway] += 0.22 * Math.sin(t * 1.3) + 0.06 * Math.sin(t * 3.1);
    P[I.tailCurl] += 0.08 * Math.sin(t * 0.9 + 1);
    P[I.headZ] += 0.03 * Math.sin(t * 0.7); P[I.headYaw] += 0.05 * Math.sin(t * 0.43);
  }

  function legCycle(P, sgn, psi, amp, rw, dx, dz) {
    const sw = Math.sin(psi), lift = Math.max(0, Math.cos(psi));
    const kx = sgn > 0 ? I.thLx : I.thRx, kz = sgn > 0 ? I.thLz : I.thRz, kk = sgn > 0 ? I.knL : I.knR, kf = sgn > 0 ? I.ftLx : I.ftRx;
    P[kx] = -amp * sw * dz; P[kz] = amp * sw * dx * 0.8;
    P[kk] = rw * (0.25 + 1.25 * Math.pow(lift, 1.4)) * (0.6 + 0.4 * Math.abs(dz));
    P[kf] = -(P[kx] + P[kk]) * 0.85 + rw * 0.3 * Math.max(0, -Math.cos(psi)) * dz;
  }

  function locomotion(p, t, dt, P) {
    P.fill(0); P[I.sqY] = 1; P[I.sqZ] = 1;
    const spd = p.spd || 0;
    const rw = S.runW;
    // relative move direction in body frame
    const rel = wrapA((p.face || 0) - S.yaw);
    // hips twist toward the movement (or away from it when backpedalling) — upper body keeps facing the aim
    let tw;
    if (Math.abs(rel) <= 1.95) tw = clamp(rel * 0.62, -0.75, 0.75);
    else tw = clamp(wrapA(rel - Math.PI) * 0.5, -0.6, 0.6);
    S.hipTwist += (tw * rw - S.hipTwist) * dampK(10, dt);
    const d = rel - S.hipTwist, dx = Math.sin(d), dz = Math.cos(d);   // stride direction in hip space
    const ph = S.phase;
    const amp = 0.62 * rw * clamp(0.6 + spd / 8, 0.6, 1.25);
    legCycle(P, 1, ph, amp, rw, dx, dz); legCycle(P, -1, ph + Math.PI, amp, rw, dx, dz);
    P[I.hipYaw] = S.hipTwist; P[I.chestYaw] = -S.hipTwist * 0.85;
    // bounce
    const bob = Math.abs(Math.sin(ph));
    P[I.baseY] = rw * (0.05 * bob - 0.012);
    P[I.sqY] = 1 + rw * 0.06 * (bob - 0.5);
    P[I.hipZ] = rw * 0.06 * Math.sin(ph) * dz; P[I.hipX] = rw * 0.08;
    // lean into move + bank into turns
    const lean = 0.2 * rw * clamp(spd / 4.8, 0, 1.3);
    const lx = Math.sin(rel) * lean + Math.cos(rel) * S.bank, lz = Math.cos(rel) * lean - Math.sin(rel) * S.bank;
    P[I.leanX] = lz; P[I.leanZ] = -lx;
    P[I.chestX] += 0.06 * rw; P[I.headX] -= 0.1 * rw;
    P[I.chestZ] += -0.04 * rw * Math.sin(ph);
    // free (left) arm: relaxed hang -> pumping run swing, opposite the left leg
    const sw = Math.sin(ph) * dz;
    arm(P, 1, lerp(0.05, 0.06, rw), lerp(-0.228, -0.165 + 0.03 * Math.abs(sw), rw), lerp(0.035, 0.04 - 0.15 * sw, rw), 0.25, -0.2 * rw, -1);
    // ears / tail secondary with run
    P[I.earLx] = -0.25 * rw; P[I.earRx] = -0.25 * rw;
    P[I.earLz] = 0.05 * Math.sin(ph * 2) * rw; P[I.earRz] = -0.05 * Math.sin(ph * 2 + 0.5) * rw;
    P[I.tailLift] = -0.25 * rw + 0.12 * rw * Math.sin(ph * 2 - 0.8); P[I.tailSway] = 0.25 * rw * Math.sin(ph + 0.8);
    P[I.tailStream] = 0.35 * rw;
    idleLayer(p, t, P, 1 - rw * 0.8);
    P[I.hdLz] = 0.15 * (1 - rw);
    P[I.thLz] += 0.06 * (1 - rw); P[I.thRz] -= 0.06 * (1 - rw);
    // gun (right) arm: relaxed low-ready vs aiming along p.aim
    const aw = S.aimW;
    const aimRel = clamp(wrapA((p.aim || 0) - S.yaw), -1.0, 0.55);   // positive = across the body
    const ca = Math.cos(aimRel), sa = Math.sin(aimRel);
    // aim target: in front of the chest (x inward 0.075), rotated about the shoulder by the residual aim
    const ax0 = 0.075, az0 = 0.215;
    const axr = ax0 * ca + az0 * sa, azr = -ax0 * sa + az0 * ca;    // real-space x (inward = +X for the right arm)
    const relaxZ = 0.1 + 0.08 * sw * rw;
    arm(P, -1, lerp(-0.02, -axr, aw), lerp(-0.212, -0.055, aw), lerp(relaxZ, azr, aw), lerp(0.25, 0.9, aw), lerp(0, -0.6, aw), lerp(-1, -0.3, aw));
    P[I.gunAim] = aw; P[I.gunPitch] = lerp(0.3, 0, aw); P[I.gunYaw] = 0;
    P[I.headYaw] += aimRel * 0.3;
    P[I.headX] -= 0.2;
  }

  function dashPose(p, t, P, pr) {
    P.fill(0); P[I.sqY] = 1; P[I.sqZ] = 1;
    const e = Math.sin(Math.PI * clamp(pr, 0, 1));
    P[I.baseY] = 0.03 - 0.02 * e;
    P[I.leanX] = 0.62; P[I.hipX] = 0.1; P[I.chestX] = 0.18; P[I.headX] = -0.45;
    P[I.sqY] = 0.86; P[I.sqZ] = 1.22;
    P[I.earLx] = -1.0; P[I.earRx] = -1.0; P[I.earLz] = -0.25; P[I.earRz] = 0.25;
    P[I.tailStream] = 1; P[I.tailLift] = -0.2; P[I.tailSway] = 0.08 * Math.sin(t * 30);
    arm(P, 1, 0.08, -0.12, -0.19, 0.3, 0.5, -0.3);
    arm(P, -1, -0.02, -0.03, 0.235, 0.9, -0.6, -0.2); P[I.gunAim] = 1; P[I.gunPitch] = 0;
    P[I.thLx] = -1.0; P[I.knL] = 1.4; P[I.ftLx] = 0.2;
    P[I.thRx] = 0.75; P[I.knR] = 0.45; P[I.ftRx] = 0.5;
  }

  function deadPose(t, P, T) {
    P.fill(0); P[I.sqY] = 1; P[I.sqZ] = 1;
    // 0-0.1 recoil, 0.1-0.8 hop + spin + fall backward, 0.8 impact bounce, settle by 1.3
    const fall = sstep(0.1, 0.78, T);
    const hop = T < 0.8 ? Math.sin(Math.PI * clamp(T / 0.8, 0, 1)) * 0.34 : 0.06 * Math.max(0, Math.sin(Math.PI * clamp((T - 0.8) / 0.28, 0, 1)));
    P[I.spin] = 2.6 * (1 - Math.pow(1 - clamp(T / 0.85, 0, 1), 2.2));
    P[I.leanX] = -1.5 * fall;
    P[I.leanZ] = 0.22 * fall;
    P[I.baseY] = hop + 0.16 * fall;
    P[I.baseX] = 0.42 * Math.sin(P[I.spin]) * fall; P[I.baseZ] = 0.42 * Math.cos(P[I.spin]) * fall;
    const imp = T > 0.78 ? Math.exp(-(T - 0.78) * 9) : 0;
    P[I.sqY] = 1 - 0.18 * imp; P[I.sqZ] = 1 + 0.12 * imp;
    const flail = 1 - sstep(0.7, 1.2, T), fw = Math.sin(T * 22);
    // arms flung up, then splayed out on the floor
    arm(P, 1, lerp(0.1, 0.22, fall), lerp(0.2, 0.03, fall) + 0.04 * flail * fw, lerp(0.06, 0.08, fall), 0, -1, -0.3);
    arm(P, -1, lerp(0.1, 0.22, fall), lerp(0.2, 0.05, fall) - 0.04 * flail * fw, lerp(0.06, 0.04, fall), 0, -1, -0.3);
    P[I.gunAim] = 0; P[I.gunPitch] = 0.3; P[I.gunYaw] = -0.8;
    P[I.thLx] = -0.5 * fall; P[I.thLz] = 0.28; P[I.knL] = 0.55 * fall;
    P[I.thRx] = -0.2 * fall; P[I.thRz] = -0.25; P[I.knR] = 0.3 * fall;
    P[I.headX] = -0.45 * fall + 0.35 * imp; P[I.headZ] = 0.25 * fall; P[I.headYaw] = 0.2 * fall;
    P[I.earLx] = -0.9 * fall; P[I.earRx] = -0.9 * fall; P[I.earLz] = -0.5 * fall; P[I.earRz] = 0.6 * fall;
    P[I.tailLift] = lerp(0, -1.2, fall) + 0.3 * flail * Math.sin(T * 14); P[I.tailCurl] = -0.4 * fall; P[I.tailSway] = 0.7 * fall;
    if (T > 1.3) P[I.tailSway] += 0.02 * Math.sin(t * 1.4);
  }

  function victoryPose(t, P, T) {
    P.fill(0); P[I.sqY] = 1; P[I.sqZ] = 1;
    const per = 1.1, ph = (T % per) / per;
    let y = 0, sq = 1;
    if (ph < 0.22) { const k = sstep(0, 0.22, ph); sq = 1 - 0.14 * k; y = 0; }
    else if (ph < 0.72) { const k = (ph - 0.22) / 0.5; y = 0.36 * Math.sin(Math.PI * k); sq = 1 + 0.1 * Math.sin(Math.PI * Math.min(1, k * 2)); }
    else if (ph < 0.86) { const k = (ph - 0.72) / 0.14; sq = 1 - 0.16 * Math.sin(Math.PI * k); }
    P[I.baseY] = y; P[I.sqY] = sq; P[I.sqZ] = 1;
    const air = y / 0.36;
    arm(P, 1, lerp(0.1, 0.075, air), lerp(0.1, 0.235, air), lerp(0.1, 0.04, air), 1, -0.3, -0.4);        // fist pump
    arm(P, -1, lerp(0.14, 0.11, air), lerp(0.02, 0.17, air), lerp(0.1, 0.06, air), 1, -0.5, -0.3);       // blaster raised
    P[I.gunAim] = 0; P[I.gunPitch] = lerp(-0.7, -1.35, air); P[I.gunYaw] = -0.2;
    P[I.thLx] = -0.45 * air; P[I.knL] = 0.9 * air + 0.25 * (1 - sq) * 5; P[I.thRx] = 0.15 * air; P[I.knR] = 0.5 * air + 0.25 * (1 - sq) * 5;
    P[I.ftLx] = -0.3 * air; P[I.ftRx] = 0.1 * air;
    P[I.headX] = -0.2 - 0.12 * air; P[I.headZ] = 0.1 * Math.sin(T * 5.7);
    P[I.chestX] = -0.08 * air;
    P[I.earLx] = 0.15 - 0.3 * air; P[I.earRx] = 0.15 - 0.3 * air;
    P[I.tailSway] = 0.55 * Math.sin(T * 12); P[I.tailLift] = 0.25;
  }

  function titlePose(t, P) {
    P.fill(0); P[I.sqY] = 1; P[I.sqZ] = 1;
    const br = Math.sin(t * 1.9);
    P[I.baseY] = 0.004 * br; P[I.chestX] = 0.02 * br - 0.04; P[I.chestZ] = -0.03;
    P[I.hipZ] = 0.07; P[I.baseX] = 0.015; P[I.hipYaw] = -0.12; P[I.chestYaw] = 0.2;
    P[I.headZ] = -0.1 + 0.02 * Math.sin(t * 0.7); P[I.headYaw] = -0.1 + 0.08 * Math.sin(t * 0.45); P[I.headX] = -0.1 - 0.015 * br;
    // blaster at low-ready; every few seconds a quick showboat spin (flip the blaster 360° and catch it)
    const cyc = t % 5.2, fl = cyc > 3.9 ? (cyc - 3.9) / 1.0 : 0, up = fl > 0 ? Math.sin(Math.PI * Math.min(1, fl)) : 0;
    const spinA = fl > 0 ? -TAU * sstep(0.12, 0.8, fl) : 0;
    arm(P, -1, lerp(0.05, 0.1, up), lerp(-0.2, -0.07, up) + 0.004 * br, lerp(0.07, 0.15, up), 0.4, -0.3, -1);
    P[I.gunAim] = 0; P[I.gunPitch] = lerp(0.62, -0.2, up) + spinA; P[I.gunYaw] = -0.35;
    P[I.headX] -= 0.08 * up; P[I.tailSway] += 0.25 * up; P[I.earLx] += 0.2 * up; P[I.earRx] += 0.2 * up;
    // left fist on the hip, elbow out
    arm(P, 1, 0.05, -0.175 + 0.004 * br, -0.03, 1, 0.15, -0.6); P[I.hdLz] = 0.4; P[I.hdLx] = 0.3;
    // stance: weight on the left leg
    P[I.thLz] = 0.02; P[I.thRz] = -0.14; P[I.thRx] = -0.08; P[I.knR] = 0.12; P[I.ftRx] = 0.05; P[I.thRy] = -0.25;
    P[I.tailSway] = 0.3 * Math.sin(t * 1.2) + 0.08 * Math.sin(t * 2.9); P[I.tailCurl] = 0.08 * Math.sin(t * 0.8);
  }

  // ---------- two-bone arm IK (chest space) ----------
  const _D = V3(), _pl = V3(), _a1 = V3(), _f1 = V3(), _g = V3(), _u0 = V3(), _v0 = V3(), _w0 = V3(), _u1 = V3(), _v1 = V3(), _w1 = V3();
  const _m0 = new THREE.Matrix4(), _m1 = new THREE.Matrix4();
  const L1 = UP_LEN, L2 = FORE_LEN + FIST_OFF, SX = Math.sin(ARM_A), CY = Math.cos(ARM_A);
  function frame(u, g, fb, U, Vv, W) {
    U.copy(u); Vv.copy(g).addScaledVector(u, -g.dot(u));
    if (Vv.lengthSq() < 1e-8) Vv.copy(fb).addScaledVector(u, -fb.dot(u));
    Vv.normalize(); W.crossVectors(U, Vv);
  }
  function solveArm(side, tx, ty, tz, px, py, pz, shB, elB) {
    _D.set(tx, ty, tz); let dist = _D.length(); dist = clamp(dist, 0.04, L1 + L2 - 0.004); _D.normalize();
    const cosA = clamp((L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist), -1, 1), sinA = Math.sqrt(1 - cosA * cosA);
    _pl.set(px, py, pz).addScaledVector(_D, -(px * _D.x + py * _D.y + pz * _D.z));
    if (_pl.lengthSq() < 1e-8) _pl.set(0, -1, 0).addScaledVector(_D, -_D.y * -1);
    _pl.normalize();
    _a1.copy(_D).multiplyScalar(cosA).addScaledVector(_pl, sinA);                       // upper-arm direction
    _f1.copy(_D).multiplyScalar(dist).addScaledVector(_a1, -L1).normalize();             // forearm direction
    const c = _a1.dot(_f1), cb = clamp((c - SX * SX) / (CY * CY), -1, 1), bnd = Math.acos(cb);
    _u0.set(SX * side, -CY, 0); _g.set(SX * side, -CY * cb, CY * Math.sin(bnd));           // rest arm dir & rest-frame forearm after bend
    frame(_u0, _g, vZ, _u0, _v0, _w0); frame(_a1, _f1, _pl, _u1, _v1, _w1);
    _m0.makeBasis(_u0, _v0, _w0).transpose(); _m1.makeBasis(_u1, _v1, _w1).multiply(_m0);
    shB.quaternion.setFromRotationMatrix(_m1);
    elB.rotation.set(-bnd, 0, 0);
  }

  // ---------- apply pose to bones ----------
  function applyPose(P, t) {
    const b = bones;
    b[B.base].position.set(P[I.baseX], P[I.baseY], P[I.baseZ]);
    b[B.base].rotation.set(P[I.leanX], P[I.spin], P[I.leanZ]);
    const sq = P[I.sqY], sxz = 1 / Math.sqrt(Math.max(0.3, sq));
    b[B.base].scale.set(sxz, sq, sxz * P[I.sqZ]);
    b[B.hips].rotation.set(P[I.hipX], P[I.hipYaw], P[I.hipZ]);
    b[B.chest].rotation.set(P[I.chestX], P[I.chestYaw], P[I.chestZ]);
    b[B.head].rotation.set(P[I.headX], P[I.headYaw], P[I.headZ]);
    b[B.earL].rotation.set(P[I.earLx], 0, -P[I.earLz]);
    b[B.earR].rotation.set(P[I.earRx], 0, P[I.earRz]);
    // arms (IK)
    solveArm(1, P[I.hLx], P[I.hLy], P[I.hLz], P[I.pLx], P[I.pLy], P[I.pLz], b[B.shL], b[B.elL]);
    solveArm(-1, P[I.hRx], P[I.hRy], P[I.hRz], P[I.pRx], P[I.pRy], P[I.pRz], b[B.shR], b[B.elR]);
    b[B.hdL].rotation.set(P[I.hdLx], 0, P[I.hdLz]);
    // legs
    b[B.thL].rotation.set(P[I.thLx], P[I.thLy], P[I.thLz]);
    b[B.knL].rotation.set(P[I.knL], 0, 0);
    b[B.ftL].rotation.set(P[I.ftLx], 0, 0);
    b[B.thR].rotation.set(P[I.thRx], P[I.thRy], P[I.thRz]);
    b[B.knR].rotation.set(P[I.knR], 0, 0);
    b[B.ftR].rotation.set(P[I.ftRx], 0, 0);
    // tail: per-bone lift (about X) + side sway (about axis ⟂ rest tangent)
    for (let i = 0; i < 5; i++) {
      const w = i / 4;
      const lift = P[I.tailLift] * (0.5 + 0.3 * w) + P[I.tailCurl] * w * 1.2 - P[I.tailStream] * (i === 0 ? 0.1 : i < 3 ? 0.45 : 0.55);
      const sway = P[I.tailSway] * (0.35 + 0.5 * w) * (0.7 + 0.3 * Math.sin(t * 2 - i * 0.7));
      qA.setFromAxisAngle(tailAxis[i], sway); qB.setFromAxisAngle(vX, lift);
      b[B.t0 + i].quaternion.multiplyQuaternions(qA, qB);
    }
    // gun hand: orient the blaster in world space — chest-relative when relaxed, exactly along p.aim when aiming
    const aw = P[I.gunAim];
    b[B.chest].getWorldQuaternion(qC);
    eTmp.set(P[I.gunPitch], P[I.gunYaw], 0); _qT.setFromEuler(eTmp); qC.multiply(_qT);
    if (aw > 0.001) {
      root.getWorldQuaternion(qB);
      eTmp.set(P[I.gunPitch], S.aimRelWorld, 0); _qT.setFromEuler(eTmp); qB.multiply(_qT);
      qC.slerp(qB, aw);
    }
    b[B.elR].getWorldQuaternion(qA);
    b[B.hdR].quaternion.copy(qA.invert().multiply(qC));
  }
  const _qT = new THREE.Quaternion();

  // ---------- update ----------
  function update(t, dt, p) {
    dt = clamp(dt || 0, 0, 0.05);
    if (outfitLerp < 1) { outfitLerp = Math.min(1, outfitLerp + dt / 0.25); for (const k in cur) cur[k].lerp(tgt[k], outfitLerp >= 1 ? 1 : 0.25); applyOutfit(); }
    // blink + ear twitch timers
    S.blinkNext -= dt; if (S.blinkNext <= 0) { S.blinkT = 0.11; S.blinkNext = 2 + 2.8 * hash(t * 1.37); }
    if (S.blinkT > 0) S.blinkT -= dt;
    S.twitchNext -= dt; if (S.twitchNext <= 0) { S.twitchT = 0.28; S.twitchSide = hash(t * 3.1) > 0.5 ? 1 : -1; S.twitchNext = 1.6 + 3 * hash(t * 0.71); }
    if (S.twitchT > 0) S.twitchT -= dt;

    if (mode === 'title' || !p) {
      titlePose(t, P0);
      commonOverlays(t, dt, P0, null);
      setExpr(S.blinkT > 0 ? EXPR.blink : EXPR.open);
      flare.visible = false; body.visible = true; face.visible = true;
      U.uFlashAmt.value = 0; U.uFlashE.value = 0; U.uGlowA.value = 1.0; U.uGlowB.value = trimGlowBase;
      U.uRim.value.setRGB(0.07, 0.12, 0.3); U.uRimPow.value = 3.0; faceMat.emissiveIntensity = 0;
      S.aimRelWorld = 0; S.yawVel = 0;
      applyPose(P0, t);
      return;
    }
    root.position.set(p.x || 0, 0, p.z || 0);
    const aim = p.aim || 0, moveA = p.face || 0, spd = p.spd || 0;
    if (S.first) { S.yaw = aim; S.prevFace = moveA; S.first = false; S.prevHurtT = p.hurtT || 0; }
    const dead = !!p.dead, vic = !!p.victory && !dead;
    // dash tracking
    const dashing = (p.dashT || 0) > 0;
    if (dashing && !S.wasDash) { S.dashDur = Math.max(0.08, p.dashT); S.dashDir = moveA; S.sqV -= 2.2; }
    if (!dashing && S.wasDash) { S.sqV -= 2.8; }
    S.wasDash = dashing;
    if (dashing) S.dashDir = moveA;
    S.dashW += ((dashing ? 1 : 0) - S.dashW) * dampK(dashing ? 30 : 14, dt);
    // yaw: follow aim quickly (dash direction while dashing, camera while celebrating)
    let yawT = aim;
    if (S.dashW > 0.5) yawT = S.dashDir;
    if (vic) yawT = 0;
    const dy = wrapA(yawT - S.yaw);
    const k = dead ? 0 : (S.dashW > 0.5 ? 26 : 16);
    let step = dy * dampK(k, dt); const maxStep = 16 * dt; if (Math.abs(step) > maxStep) step = Math.sign(step) * maxStep;
    const prevYaw = S.yaw; S.yaw = wrapA(S.yaw + step);
    S.yawVel = dt > 0 ? wrapA(S.yaw - prevYaw) / dt : 0;
    root.rotation.y = S.yaw;
    S.aimRelWorld = clamp(wrapA(aim - S.yaw), -1.2, 1.2);
    // locomotion drivers
    const moving = !!p.moving && spd > 0.15;
    S.runW += ((moving ? clamp(spd / 3.2, 0, 1) : 0) - S.runW) * dampK(moving ? 10 : 7, dt);
    const cps = 1.2 + 0.45 * clamp(spd, 0, 9);           // run cycles per second (chibi scamper)
    if (moving) S.phase = (S.phase + dt * cps * TAU) % (TAU * 1000);
    const fr = dt > 0 ? wrapA(moveA - S.prevFace) / dt : 0; S.prevFace = moveA;
    S.faceRate += (fr - S.faceRate) * dampK(8, dt);
    S.bank += (clamp(S.faceRate * 0.035 * S.runW, -0.22, 0.22) - S.bank) * dampK(8, dt);
    // firing / aim weight / recoil
    if (p.firing) { S.lastFire = 0; S.recoil = 1; S.flare = 1; } else S.lastFire += dt;
    S.aimW += ((S.lastFire < 1.4 ? 1 : 0) - S.aimW) * dampK(S.lastFire < 1.4 ? 14 : 3, dt);
    S.recoil *= Math.exp(-dt * 16); S.flare *= Math.exp(-dt * 22);
    // hurt
    const ht = p.hurtT || 0;
    if (ht > S.prevHurtT + 0.05) { S.hurt = 1; S.sqV -= 1.5; }
    S.prevHurtT = ht; S.hurt *= Math.exp(-dt * 7);
    // overdrive
    S.od += (((p.odT || 0) > 0 ? 1 : 0) - S.od) * dampK(6, dt);
    // death / victory timers
    if (dead) { if (S.deadT < 0) S.deadT = 0; else S.deadT += dt; } else S.deadT = -1;
    if (vic) { if (S.vicT < 0) S.vicT = 0; else S.vicT += dt; } else S.vicT = -1;

    // ---- build pose ----
    locomotion(p, t, dt, PL);
    P0.set(PL);
    if (S.dashW > 0.01) { dashPose(p, t, PX, 1 - (p.dashT || 0) / S.dashDur); blendInto(P0, PX, S.dashW); }
    // firing recoil overlay
    P0[I.hRz] -= 0.045 * S.recoil; P0[I.hRy] += 0.02 * S.recoil; P0[I.gunPitch] -= 0.3 * S.recoil; P0[I.chestX] -= 0.035 * S.recoil; P0[I.chestYaw] += 0.05 * S.recoil;
    // hurt recoil overlay
    if (S.hurt > 0.01) { const h = S.hurt; P0[I.leanX] -= 0.32 * h; P0[I.chestX] -= 0.2 * h; P0[I.headX] -= 0.25 * h; P0[I.earLx] -= 0.8 * h; P0[I.earRx] -= 0.8 * h; P0[I.hLx] += 0.06 * h; P0[I.hLy] += 0.08 * h; P0[I.tailLift] += 0.5 * h; }
    if (vic) { victoryPose(t, PX, S.vicT); blendInto(P0, PX, sstep(0, 0.25, S.vicT)); }
    if (dead) { deadPose(t, PX, S.deadT); blendInto(P0, PX, sstep(0, 0.08, S.deadT)); }
    commonOverlays(t, dt, P0, p);

    // ---- expression ----
    let e = EXPR.open;
    if (S.od > 0.5 || S.dashW > 0.5) e = EXPR.fierce;
    if (S.blinkT > 0) e = EXPR.blink;
    if (ht > 0.35 || S.hurt > 0.4) e = EXPR.hurt;
    if (vic) e = EXPR.happy;
    if (dead) e = S.deadT < 0.75 ? EXPR.hurt : EXPR.dead;
    setExpr(e);

    // ---- materials / fx ----
    const odP = S.od * (0.75 + 0.25 * Math.sin(t * 9));
    U.uGlowA.value = (dead ? lerp(1.0, 0.1, sstep(0.3, 1.2, S.deadT)) : 1.0) + 1.8 * S.od + 1.0 * S.flare;
    U.uGlowB.value = trimGlowBase + 1.6 * odP;
    faceMat.emissiveIntensity = 0.9 * odP;
    const rim = U.uRim.value;
    rim.setRGB(0.07, 0.12, 0.3).lerp(_odRim, S.od * (0.55 + 0.45 * Math.sin(t * 9)));
    U.uRimPow.value = lerp(3.0, 1.8, S.od);
    // hurt flash: white pop, then red
    const hf = clamp(ht, 0, 1);
    const white = hf > 0.84;
    if (white) U.uFlash.value.setRGB(1, 1, 1); else U.uFlash.value.setRGB(1, 0.12, 0.03);
    U.uFlashAmt.value = dead ? 0 : (white ? 0.42 : 0.7 * Math.pow(hf / 0.84, 1.1));
    U.uFlashE.value = dead ? 0 : (white ? 0.06 : 0.14 * Math.pow(hf / 0.84, 1.5));
    // muzzle flare
    const fl = dead ? 0 : S.flare;
    flare.visible = fl > 0.03;
    flare.scale.setScalar(0.06 + 0.2 * fl * (1 + 0.6 * S.od));
    flareMat.opacity = Math.min(1, fl * 1.5);
    // invulnerability blink (not while dashing)
    const inv = (p.inv || 0) > 0 && !dashing && !dead;
    const on = !inv || (Math.floor(t * 24) % 2 === 0);
    body.visible = on; face.visible = on;
    // blob shadow follows the pose
    const lift = clamp(P0[I.baseY], 0, 1);
    const lying = dead ? sstep(0.4, 0.9, S.deadT) : 0;
    const sc = (0.62 + 0.35 * lying) * (1 - lift * 0.9) * (1 + 0.25 * S.dashW);
    blobShadow.scale.set(sc, sc * (1 + 0.5 * lying), 1);
    shadowMat.opacity = 1 - lift * 1.2;
    applyPose(P0, t);
  }
  const _odRim = new THREE.Color(0.25, 0.95, 1.3);

  function commonOverlays(t, dt, P, p) {
    // squash spring (impulses from dash/hurt)
    const ks = 260, cs = 16;
    const n = dt > 0.02 ? 2 : 1, h = dt / n;
    for (let i = 0; i < n; i++) { S.sqV += (-ks * S.sq - cs * S.sqV) * h; S.sq += S.sqV * h; }
    P[I.sqY] *= 1 + clamp(S.sq * 0.12, -0.25, 0.25);
    // tail + ear springs react to turning
    const yv = clamp(S.yawVel || 0, -20, 20);
    for (let i = 0; i < n; i++) {
      S.tailSv += (-90 * S.tailSp - 9 * S.tailSv - yv * 2.2) * h; S.tailSp += S.tailSv * h;
      S.earSv += (-150 * S.earSp - 10 * S.earSv - yv * 1.2) * h; S.earSp += S.earSv * h;
    }
    P[I.tailSway] += clamp(S.tailSp * 0.35, -0.8, 0.8);
    P[I.earLz] += clamp(S.earSp * 0.08, -0.3, 0.3); P[I.earRz] -= clamp(S.earSp * 0.08, -0.3, 0.3);
    // ear twitch
    if (S.twitchT > 0) { const k = Math.sin((1 - S.twitchT / 0.28) * Math.PI * 3) * 0.22 * (S.twitchT / 0.28); if (S.twitchSide > 0) { P[I.earLx] += k; P[I.earLz] += k * 0.5; } else { P[I.earRx] += k; P[I.earRz] += k * 0.5; } }
    void p;
  }

  function muzzle(out) { muzzleObj.updateWorldMatrix(true, false); return out.setFromMatrixPosition(muzzleObj.matrixWorld); }
  function pose(name) {
    mode = name === 'title' || name === 'locker' ? 'title' : 'game';
    S.first = true; S.deadT = -1; S.vicT = -1; S.sq = 0; S.sqV = 0; S.dashW = 0; S.hurt = 0; S.recoil = 0; S.flare = 0;
    body.visible = true; face.visible = true; flare.visible = false;
    if (mode === 'title') { blobShadow.scale.set(0.62, 0.62, 1); shadowMat.opacity = 1; }
  }

  setOutfit(opts.outfit || 'bomber', true);
  setQuality(opts.quality != null ? opts.quality : 2);
  if (mode === 'title') update(0, 0, null);
  return {
    root, update, setOutfit: (id) => setOutfit(id, false), muzzle, setQuality, pose,
    get outfit() { return outfitId; }, get quality() { return quality; },
    // debug / tooling
    _dbg: { bones, body, face, flare, blobShadow, skeleton, S, U, EXPR, setExpr },
  };
}
