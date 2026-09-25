// =====================================================================================
// AFTER HOURS 3D — AUDIO ENGINE  (src/audio.js · AUDIO agent)
// 100% procedural WebAudio: music + SFX. No files, no network, no rAF.
//
//  music notes ─► stem gains (10 stems) ─► dry / wet buses ─► mood lowpass ─► musicMix ─► duck ─► musicOut ─┐
//                    └─(lead/arp/counter)─► ping-pong delay ─► wet bus       └─► reverb send ─► convolver ───┤
//  stingers (hour chime, boss intro, fanfares, game-over) ─► stingBus ─────────────────────────────────────┤
//  SFX voices (pre-rendered procedural buffers + in-key live synth) ─► 5 fixed stereo pan buses ─► sfxBus ─┤
//                                                                                                   master ◄┘
//  master ─► pause lowpass ─► glue compressor ─► limiter ─► soft-clip ceiling (|x| ≤ 0.945) ─► enable gain ─► out
//
//  • Music: a lookahead sequencer on the AudioContext clock (setInterval pump every 25 ms, plus
//    update() as a safety net). Notes are scheduled 150 ms ahead on a 16th grid. Mood switches,
//    stem entries/exits, tempo and key changes land ONLY on bar downbeats. One recurring main motif
//    ("the After Hours theme", tresillo hook) is re-voiced per mood: different mode, tempo, voice,
//    augmentation, fragments, stutters, canons.
//  • Layering (Mario-style): energy E = f(intensity, hour progress, boss phase, overdrive). Each mood
//    lists its stems with entry thresholds; at most +2 stems / −1 stem per downbeat, with hysteresis.
//  • SFX: ~70 procedural buffers rendered in JS on first use (and warmed up in the background after
//    unlock), round-robin variants + pitch jitter, per-sound rate gates, per-group caps, a global
//    voice cap with priority stealing, and music ducking under big hits. Tonal SFX (gems, pickups,
//    tier-up, combo, heal) are synthesised live IN THE KEY/CHORD of the music that is playing.
//  • createAudio({ ctx: offlineAudioContext }) renders the whole engine offline (tests).
// =====================================================================================
import { HOURS, KIND_DIMS } from './layout.js';

const TAU = Math.PI * 2;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const ex = (t, tau) => (t < 0 ? 0 : Math.exp(-t / tau));
const att = (t, a) => (t <= 0 ? 0 : t < a ? t / a : 1);
const sweep = (t, dur, a, b) => a * Math.exp(Math.log(b / a) * clamp(t / dur, 0, 1));
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
function rng(seed) {
  let s = ((seed >>> 0) ^ 0x9e3779b9) >>> 0; if (!s) s = 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

// ---------------------------------------------------------------- tiny JS DSP (buffer rendering)
function blep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}
class Osc {
  constructor(sr, ph) { this.sr = sr; this.p = ph || 0; }
  adv(f) { this.p += f / this.sr; if (this.p >= 1) this.p -= Math.floor(this.p); }
  sin(f) { const v = Math.sin(TAU * this.p); this.adv(f); return v; }
  tri(f) { const v = 1 - 4 * Math.abs(this.p - 0.5); this.adv(f); return v; }
  saw(f) { const dt = f / this.sr; const v = 2 * this.p - 1 - blep(this.p, dt); this.adv(f); return v; }
  sqr(f, pw) {
    pw = pw || 0.5; const dt = f / this.sr, p = this.p;
    let v = p < pw ? 1 : -1; v += blep(p, dt); v -= blep((p + 1 - pw) % 1, dt); this.adv(f); return v;
  }
}
class SVF { // TPT state-variable filter (Zavalishin)
  constructor(sr) { this.sr = sr; this.a = 0; this.b = 0; this.lp = 0; this.bp = 0; this.hp = 0; this.fc = -1; this.q = -1; }
  run(x, fc, q) {
    q = q || 0.707;
    if (q !== this.q || fc > this.fc * 1.003 || fc < this.fc * 0.997) {
      const g = Math.tan(Math.PI * Math.min(fc, this.sr * 0.45) / this.sr);
      this.k = 1 / q; this.a1 = 1 / (1 + g * (g + this.k)); this.a2 = g * this.a1; this.a3 = g * this.a2; this.fc = fc; this.q = q;
    }
    const k = this.k, a1 = this.a1, a2 = this.a2, a3 = this.a3;
    const v3 = x - this.b, v1 = a1 * this.a + a2 * v3, v2 = this.b + a2 * this.a + a3 * v3;
    this.a = 2 * v1 - this.a; this.b = 2 * v2 - this.b;
    this.lp = v2; this.bp = v1; this.hp = x - k * v1 - v2; return this;
  }
}
const mixIn = (d, s, off, g) => { for (let i = Math.max(0, -off); i < s.length && i + off < d.length; i++) d[i + off] += s[i] * g; };
const M808 = [205.3, 304.4, 369.6, 522.7, 540, 800];
function metalSet(sr) { return M808.map((_, i) => new Osc(sr, i * 0.17)); }
function metal(os, k) { let s = 0; for (let j = 0; j < 6; j++) s += os[j].sqr(M808[j] * k, 0.5); return s / 6; }

// ---------------------------------------------------------------- procedural recipes
// Each recipe renders a mono Float32Array. Rendering = DC-block → fade tail → peak-normalise.
const REC = {};
const R_ = (name, dur, fn, norm, rate) => { REC[name] = { dur, fn, norm: norm || 0.9, rate: rate || 0 }; };
const LO = 24000; // render rate for sounds with nothing above ~9 kHz

// ===== drums
R_('kick', 0.42, (d, sr, R) => {
  const o = new Osc(sr), f = new SVF(sr);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    const body = o.sin(46 + 118 * ex(t, 0.032)) * att(t, 0.0015) * (t < 0.03 ? 1 : ex(t - 0.03, 0.15));
    const clk = f.run(R() * 2 - 1, 3200, 0.9).bp * ex(t, 0.0035) * 1.2;
    d[i] = Math.tanh(1.6 * (body + clk));
  }
});
R_('kickSoft', 0.34, (d, sr) => {
  const o = new Osc(sr);
  for (let i = 0; i < d.length; i++) { const t = i / sr; d[i] = Math.tanh(1.15 * o.sin(48 + 62 * ex(t, 0.03)) * att(t, 0.002) * ex(t, 0.12)); }
}, 0.9, LO);
R_('kickHeavy', 0.48, (d, sr, R) => {
  const o = new Osc(sr), f = new SVF(sr), n = new SVF(sr);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    const body = o.sin(42 + 150 * ex(t, 0.045)) * att(t, 0.001) * (t < 0.04 ? 1 : ex(t - 0.04, 0.15));
    const clk = f.run(R() * 2 - 1, 2600, 0.8).bp * ex(t, 0.005) * 1.6;
    const thump = n.run(R() * 2 - 1, 180, 0.7).lp * ex(t, 0.05) * 1.5;
    d[i] = Math.tanh(2.6 * (body + clk + thump));
  }
});
R_('snare', 0.32, (d, sr, R) => {
  const a = new Osc(sr), b = new Osc(sr), h = new SVF(sr), l = new SVF(sr);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    const tone = a.sin(188 * (1 + 0.5 * ex(t, 0.012))) * ex(t, 0.055) * 0.7 + b.sin(332) * ex(t, 0.03) * 0.3;
    const nz = l.run(h.run(R() * 2 - 1, 1100, 0.7).hp, 9000, 0.6).lp;
    const ne = ex(t, 0.075) * 0.9 + (t < 0.2 ? 0.22 * (1 - t / 0.2) : 0);
    d[i] = Math.tanh(1.3 * (tone * att(t, 0.001) + nz * ne * att(t, 0.0015)));
  }
});
R_('clap', 0.3, (d, sr, R) => {
  const f = new SVF(sr), g = new SVF(sr), H = [0, 0.011, 0.021, 0.032];
  for (let i = 0; i < d.length; i++) {
    const t = i / sr; let e = 0;
    for (let k = 0; k < 4; k++) if (t >= H[k]) e += k < 3 ? ex(t - H[k], 0.0045) : ex(t - H[k], 0.09);
    d[i] = f.run(R() * 2 - 1, 1250, 1.3).bp * e * att(t, 0.0005) + g.run(R() * 2 - 1, 3600, 1).bp * ex(t, 0.03) * 0.2;
  }
});
R_('rim', 0.08, (d, sr, R) => {
  const o = new Osc(sr), f = new SVF(sr);
  for (let i = 0; i < d.length; i++) { const t = i / sr; d[i] = o.sin(1700) * ex(t, 0.012) * att(t, 0.0005) + f.run(R() * 2 - 1, 2500, 3).bp * ex(t, 0.02) * 0.8; }
});
R_('snap', 0.12, (d, sr, R) => {
  const f = new SVF(sr), o = new Osc(sr);
  for (let i = 0; i < d.length; i++) { const t = i / sr; d[i] = f.run(R() * 2 - 1, 2200, 2).bp * ex(t, 0.012) * att(t, 0.0004) + o.sin(1150) * ex(t, 0.01) * 0.25; }
});
const hatFn = (dec, k) => (d, sr, R) => {
  const ms = metalSet(sr), h = new SVF(sr), b = new SVF(sr);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr, x = metal(ms, k) * 0.6 + (R() * 2 - 1) * 0.45;
    d[i] = b.run(h.run(x, 7200, 0.7).hp, 10500, 0.8).bp * ex(t, dec) * att(t, 0.0008);
  }
};
R_('hatC', 0.09, hatFn(0.026, 1));
R_('hatO', 0.5, hatFn(0.2, 1));
R_('shaker', 0.1, (d, sr, R) => {
  const h = new SVF(sr);
  for (let i = 0; i < d.length; i++) { const t = i / sr; d[i] = h.run(R() * 2 - 1, 6200, 0.8).hp * att(t, 0.012) * ex(t - 0.012, 0.035); }
});
R_('ride', 1.1, (d, sr, R) => {
  const ms = metalSet(sr), h = new SVF(sr), o = new Osc(sr);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr, x = metal(ms, 1.38) * 0.7 + (R() * 2 - 1) * 0.2;
    d[i] = h.run(x, 5200, 0.7).hp * ex(t, 0.42) * att(t, 0.001) + o.sin(3120) * ex(t, 0.6) * 0.12;
  }
});
R_('crash', 1.5, (d, sr, R) => {
  const ms = metalSet(sr), h = new SVF(sr), l = new SVF(sr);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr, x = (R() * 2 - 1) * 0.75 + metal(ms, 1.72) * 0.4;
    d[i] = l.run(h.run(x, 3000, 0.6).hp, 5200 + 9000 * ex(t, 0.9), 0.6).lp * att(t, 0.002) * ex(t, 0.65);
  }
});
const tomFn = (fs, fe, dec) => (d, sr, R) => {
  const o = new Osc(sr), f = new SVF(sr);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    d[i] = Math.tanh(1.2 * (o.sin(fe + (fs - fe) * ex(t, 0.09)) * ex(t, dec) * att(t, 0.001) + f.run(R() * 2 - 1, fs * 3, 1.2).bp * ex(t, 0.012) * 0.3));
  }
};
R_('tomL', 0.5, tomFn(118, 78, 0.24), 0.9, LO);
R_('tomM', 0.42, tomFn(165, 118, 0.2), 0.9, LO);
R_('tomH', 0.36, tomFn(225, 165, 0.17), 0.9, LO);
R_('cowbell', 0.35, (d, sr) => {
  const a = new Osc(sr), b = new Osc(sr, 0.3), f = new SVF(sr);
  for (let i = 0; i < d.length; i++) { const t = i / sr; d[i] = f.run(a.sqr(540) + b.sqr(800), 900, 1.4).bp * (ex(t, 0.02) * 0.6 + ex(t, 0.16) * 0.4) * att(t, 0.0008); }
});
R_('anvil', 0.5, (d, sr, R) => {
  const P = [1, 2.32, 3.67, 5.13, 6.9], A = [1, 0.7, 0.5, 0.4, 0.25], D = [0.32, 0.2, 0.12, 0.08, 0.05];
  const os = P.map((_, i) => new Osc(sr, i * 0.1)), f = new SVF(sr);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr; let s = 0;
    for (let k = 0; k < 5; k++) s += os[k].sin(372 * P[k]) * A[k] * ex(t, D[k]);
    d[i] = Math.tanh(1.4 * (s * att(t, 0.0006) + f.run(R() * 2 - 1, 4000, 1).bp * ex(t, 0.006)));
  }
});
R_('impact', 2.0, (d, sr, R) => {
  const o = new Osc(sr), o2 = new Osc(sr), l = new SVF(sr);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    const s = o.sin(28 + 55 * ex(t, 0.12)) * ex(t, 0.7) * att(t, 0.003) + l.run(R() * 2 - 1, sweep(t, 1.2, 2500, 90), 0.8).lp * ex(t, 0.3) * 0.7 + o2.sin(55) * ex(t, 0.22) * 0.3;
    d[i] = Math.tanh(1.8 * s);
  }
}, 0.9, LO);
R_('revCym', 1.3, (d, sr, R) => {
  const n = d.length, tmp = new Float32Array(n); REC.crash.fn(tmp, sr, R);
  for (let i = 0; i < n; i++) d[i] = tmp[n - 1 - i] * att(i / sr, 0.3) * (i > n - sr * 0.004 ? (n - i) / (sr * 0.004) : 1);
});
R_('static', 0.5, (d, sr, R) => {
  const f = new SVF(sr), h = new SVF(sr); let gate = 1, gt = 0;
  for (let i = 0; i < d.length; i++) {
    const t = i / sr; if (t > gt) { gate = R() < 0.6 ? 1 : 0.1; gt = t + 0.015 + R() * 0.03; }
    const imp = R() < 0.012 ? (R() * 2 - 1) * 3 : 0;
    d[i] = (f.run(imp, 2600, 0.8).bp + h.run(R() * 2 - 1, 5000, 0.7).hp * 0.12) * gate * att(t, 0.01) * (t > 0.42 ? (0.5 - t) / 0.08 : 1);
  }
});

// ===== player
function gShot(sr, n, R, f0, f1, len, pw, bright) {
  const d = new Float32Array(n), a = new Osc(sr), b = new Osc(sr, 0.3), f = new SVF(sr), h = new SVF(sr);
  for (let i = 0; i < n; i++) {
    const t = i / sr, fr = sweep(t, len, f0, f1), e = att(t, 0.0012) * ex(t, len * 0.42);
    let x = a.sqr(fr, pw) * 0.55 + b.saw(fr * 1.007) * 0.35;
    x = f.run(x, 700 + bright * ex(t, 0.018), 1.1).lp * e;
    d[i] = x + h.run(R() * 2 - 1, 5000, 0.8).bp * ex(t, 0.0045) * 0.9;
  }
  return d;
}
for (let k = 0; k < 4; k++) {
  R_('shot' + k, 0.17, (d, sr, R, v) => {
    const p = [1, 1.045, 0.958][v % 3], n = d.length;
    const f0 = [1500, 1320, 1180, 1060][k] * p, f1 = [430, 360, 300, 250][k] * p, len = [0.07, 0.08, 0.095, 0.11][k];
    mixIn(d, gShot(sr, n, R, f0, f1, len, 0.32, 6500 - k * 600), 0, 1);
    if (k >= 1) mixIn(d, gShot(sr, n, R, f0 * 1.19, f1 * 1.19, len * 0.9, 0.5, 4800), Math.round(0.009 * sr), 0.55);
    if (k >= 2) { const o = new Osc(sr); for (let i = 0; i < n; i++) { const t = i / sr; d[i] += o.sin(sweep(t, 0.06, 170, 62)) * ex(t, 0.045) * att(t, 0.002) * (0.35 + 0.2 * (k - 2)); } }
    if (k >= 3) {
      mixIn(d, gShot(sr, n, R, f0 * 0.84, f1 * 0.8, len * 1.1, 0.25, 4000), Math.round(0.017 * sr), 0.45);
      const f = new SVF(sr); for (let i = 0; i < n; i++) { const t = i / sr; d[i] += f.run(R() < 0.03 ? R() * 2 - 1 : 0, 3500, 1).bp * ex(t, 0.05) * 1.5; }
    }
  });
}
R_('shotOD', 0.2, (d, sr, R, v) => {
  const a = new Osc(sr), b = new Osc(sr), m = new Osc(sr), f = new SVF(sr), h = new SVF(sr), p = [1, 1.05, 0.95][v % 3];
  for (let i = 0; i < d.length; i++) {
    const t = i / sr, fr = sweep(t, 0.12, 2300 * p, 480 * p) * (1 + 0.08 * m.sin(70));
    const x = f.run(a.saw(fr) * 0.6 + b.sqr(fr * 0.5, 0.25) * 0.4, 1200 + 8000 * ex(t, 0.03), 1.4).lp * att(t, 0.001) * ex(t, 0.055);
    d[i] = x + h.run(R() * 2 - 1, 6000, 0.7).bp * ex(t, 0.005) + Math.sin(TAU * 120 * t) * ex(t, 0.04) * 0.4;
  }
});
R_('hit', 0.07, (d, sr, R, v) => {
  const f = new SVF(sr), o = new Osc(sr), q = new Osc(sr), fc = [2800, 3200, 2500][v % 3];
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    d[i] = f.run(R() * 2 - 1, fc, 1.5).bp * ex(t, 0.008) * att(t, 0.0004) + o.sin(sweep(t, 0.03, 1000, 620)) * ex(t, 0.014) * 0.5 + q.sqr(2200) * ex(t, 0.004) * 0.15;
  }
});
R_('crit', 0.28, (d, sr, R, v) => {
  const P = [1, 2.76, 5.4, 8.93], A = [1, 0.6, 0.4, 0.25], D = [0.12, 0.08, 0.05, 0.03], b = [1650, 1760][v % 2];
  const os = P.map((_, i) => new Osc(sr, i * 0.2)), h = new SVF(sr);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr; let s = 0;
    for (let k = 0; k < 4; k++) s += os[k].sin(b * P[k]) * A[k] * ex(t, D[k]);
    d[i] = s * att(t, 0.0005) * 0.6 + h.run(R() * 2 - 1, 4200, 0.8).hp * ex(t, 0.004) * 0.9;
  }
});
R_('bossHit', 0.32, (d, sr, R, v) => {
  const P = [1, 1.52, 2.44, 3.1], os = P.map((_, i) => new Osc(sr, i * 0.3)), f = new SVF(sr), s0 = new Osc(sr), b = [190, 176][v % 2];
  for (let i = 0; i < d.length; i++) {
    const t = i / sr; let s = 0;
    for (let k = 0; k < 4; k++) s += os[k].sin(b * P[k]) * ex(t, 0.18 / (1 + k * 0.5));
    d[i] = Math.tanh(1.5 * (s * 0.35 * att(t, 0.0008) + f.run(R() * 2 - 1, 1200, 1.4).bp * ex(t, 0.03) + s0.sin(sweep(t, 0.08, 120, 55)) * ex(t, 0.07) * 0.6));
  }
});

// ===== kills
function gCrunch(sr, n, R, f0, f1, len, hold) {
  const d = new Float32Array(n), o = new Osc(sr), l = new SVF(sr), f = new SVF(sr); let held = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    if (i % hold === 0) held = o.sqr(sweep(t, len, f0, f1), 0.4); else o.adv(sweep(t, len, f0, f1));
    const crush = Math.round(held * 3) / 3;
    d[i] = l.run(crush, 4200, 0.8).lp * att(t, 0.001) * ex(t, len * 0.6) * 0.7 + f.run(R() * 2 - 1, sweep(t, 0.15, 5000, 300), 0.9).lp * ex(t, 0.05) * 0.9;
  }
  return d;
}
function gRelay(sr, n, R, tc) {
  const d = new Float32Array(n), f = new SVF(sr), o = new Osc(sr);
  for (let i = 0; i < n; i++) {
    const t = i / sr - tc; if (t < 0) { f.run(0, 3500, 2); continue; }
    d[i] = f.run(R() * 2 - 1, 3500, 2).bp * (ex(t, 0.0018) + (t > 0.007 ? ex(t - 0.007, 0.0015) * 0.7 : 0)) * 2 + o.sin(2600) * ex(t, 0.003) * 0.4;
  }
  return d;
}
function gSparks(sr, n, R, t0, t1, dens) {
  const d = new Float32Array(n), f = new SVF(sr);
  for (let i = 0; i < n; i++) {
    const t = i / sr, on = t > t0 && t < t1 ? 1 - (t - t0) / (t1 - t0) : 0;
    d[i] = f.run(R() < dens * on ? R() * 2 - 1 : 0, 3800, 1.1).bp * 3;
  }
  return d;
}
function gSub(sr, n, f0, f1, len, dec, a) {
  const d = new Float32Array(n), o = new Osc(sr);
  for (let i = 0; i < n; i++) { const t = i / sr; d[i] = o.sin(sweep(t, len, f0, f1)) * ex(t, dec) * att(t, 0.002) * a; }
  return d;
}
function gShards(sr, n, R, count, span) {
  const d = new Float32Array(n);
  for (let k = 0; k < count; k++) {
    const t0 = Math.pow(R(), 2) * span, fr = 2500 + R() * 5500, dec = 0.015 + R() * 0.04, amp = (1 - t0 / span) * (0.4 + R() * 0.6);
    const s0 = Math.floor(t0 * sr), len = Math.min(n - s0, Math.floor(dec * 6 * sr));
    for (let i = 0; i < len; i++) { const t = i / sr; d[s0 + i] += (Math.sin(TAU * fr * t) + 0.4 * Math.sin(TAU * fr * 2.31 * t)) * ex(t, dec) * att(t, 0.0005) * amp * 0.5; }
  }
  return d;
}
function gBling(sr, n, t0, f) {
  const d = new Float32Array(n), a = new Osc(sr), b = new Osc(sr);
  for (let i = 0; i < n; i++) { const t = i / sr - t0; if (t < 0) continue; d[i] = (a.sin(f) + b.sin(f * 1.5) * 0.7) * ex(t, 0.28) * att(t, 0.002) * 0.4; }
  return d;
}
const killModemFn = (d, sr, R, v) => {
  const n = d.length, p = [1, 1.08, 0.93][v % 3];
  mixIn(d, gCrunch(sr, n, R, 900 * p, 90 * p, 0.12, 5 + v), 0, 1);
  mixIn(d, gSub(sr, n, 140, 45, 0.08, 0.06, 0.8), 0, 1);
  mixIn(d, gRelay(sr, n, R, 0.075 + 0.012 * v), 0, 0.55);
  mixIn(d, gSparks(sr, n, R, 0.09, 0.32, 0.01), 0, 0.35);
};
R_('killModem', 0.4, killModemFn);
R_('killPod', 0.22, (d, sr, R, v) => {
  const n = d.length, p = [1, 1.1, 0.92][v % 3];
  mixIn(d, gCrunch(sr, n, R, 1400 * p, 200 * p, 0.06, 4), 0, 0.9);
  mixIn(d, gRelay(sr, n, R, 0.04), 0, 0.4);
  mixIn(d, gSub(sr, n, 260, 90, 0.05, 0.04, 0.5), 0, 1);
});
const killPhoneFn = (d, sr, R, v) => {
  const n = d.length, h = new SVF(sr), q = new Osc(sr), l = new SVF(sr);
  mixIn(d, gSub(sr, n, 320, 110, 0.05, 0.04, 0.6), 0, 1);
  mixIn(d, gShards(sr, n, R, 16, 0.28), 0, 1);
  const pr = [[1319, 988], [1568, 1175], [1760, 1319]][v % 3];
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let x = h.run(R() * 2 - 1, 3000, 0.7).hp * (ex(t, 0.012) * 0.9 + ex(t, 0.08) * 0.12);
    const t1 = t - 0.02, t2 = t - 0.07;
    let blip = 0; if (t1 > 0 && t1 < 0.045) blip = q.sqr(pr[0], 0.3) * ex(t1, 0.03); else if (t2 > 0 && t2 < 0.09) blip = q.sqr(pr[1] * (1 - 0.3 * t2), 0.3) * ex(t2, 0.04); else q.adv(pr[0]);
    x += l.run(blip, 3000, 0.7).lp * 0.3;
    d[i] += x;
  }
};
R_('killPhone', 0.45, killPhoneFn);
R_('killEliteM', 0.85, (d, sr, R, v) => {
  const n = d.length; killModemFn(d, sr, R, v);
  mixIn(d, gSub(sr, n, 95, 32, 0.3, 0.25, 1.2), 0, 1);
  mixIn(d, gBling(sr, n, 0.06, 2093), 0, 1); mixIn(d, gBling(sr, n, 0.12, 3136), 0, 0.7);
  for (let i = 0; i < n; i++) d[i] = Math.tanh(d[i] * 1.2);
});
R_('killEliteP', 0.85, (d, sr, R, v) => {
  const n = d.length; killPhoneFn(d, sr, R, v);
  mixIn(d, gSub(sr, n, 95, 32, 0.3, 0.25, 1.2), 0, 1);
  mixIn(d, gBling(sr, n, 0.06, 2349), 0, 1); mixIn(d, gBling(sr, n, 0.12, 3520), 0, 0.7);
  for (let i = 0; i < n; i++) d[i] = Math.tanh(d[i] * 1.2);
});
R_('multiKill', 0.65, (d, sr, R) => {
  const n = d.length;
  mixIn(d, gCrunch(sr, n, R, 600, 60, 0.2, 7), 0, 1);
  mixIn(d, gSub(sr, n, 110, 35, 0.25, 0.2, 1.1), 0, 1);
  mixIn(d, gSparks(sr, n, R, 0.05, 0.55, 0.02), 0, 0.5);
  mixIn(d, gShards(sr, n, R, 10, 0.3), 0, 0.6);
  for (let i = 0; i < n; i++) d[i] = Math.tanh(d[i] * 1.3);
});

// ===== spawns / movement
R_('bootModem', 0.26, (d, sr, R, v) => {
  const n = d.length, o = new Osc(sr), q = new Osc(sr), l = new SVF(sr);
  mixIn(d, gRelay(sr, n, R, 0), 0, 0.6);
  const bits = []; for (let k = 0; k < 24; k++) bits.push(R() < 0.5);
  const lo = [1070, 1180, 980][v % 3], hi = lo * 1.187;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const up = t > 0.01 && t < 0.07 ? o.sin(sweep(t - 0.01, 0.05, 260, 1150)) * ex(t - 0.01, 0.035) * 0.45 : (o.adv(260), 0);
    let fsk = 0; if (t > 0.06 && t < 0.22) { const b = bits[Math.floor((t - 0.06) / 0.008) % 24]; fsk = q.sqr(b ? hi : lo, 0.5) * att(t - 0.06, 0.005) * (t > 0.2 ? (0.22 - t) / 0.02 : 1) * 0.3; } else q.adv(lo);
    d[i] += up + l.run(fsk, 4000, 0.7).lp;
  }
});
R_('bootPhone', 0.22, (d, sr, R, v) => {
  const h = new SVF(sr), a = new Osc(sr), b = new Osc(sr, 0.25), pr = [[1319, 1976], [1568, 2093], [1175, 1760]][v % 3];
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    let x = h.run(R() * 2 - 1, sweep(t, 0.05, 2000, 8000), 1.2).bp * att(t, 0.004) * ex(t, 0.025) * 0.35;
    const t1 = t - 0.01, t2 = t - 0.07;
    const f = t2 > 0 ? pr[1] : pr[0], tt = t2 > 0 ? t2 : t1;
    if (t1 > 0 && (t2 < 0 ? t1 < 0.055 : t2 < 0.12)) x += (a.sin(f) * 0.8 + b.sqr(f, 0.25) * 0.2) * att(tt, 0.002) * ex(tt, t2 > 0 ? 0.05 : 0.03) * 0.6;
    else { a.adv(f); b.adv(f); }
    d[i] = x;
  }
});
R_('bootPod', 0.13, (d, sr) => {
  const o = new Osc(sr);
  for (let i = 0; i < d.length; i++) { const t = i / sr, tt = t < 0.05 ? t : t - 0.05; d[i] = o.sin(sweep(tt, 0.03, 1600, 2600)) * ex(tt, 0.02) * att(tt, 0.001) * 0.6; }
});
R_('land', 0.2, (d, sr, R, v) => {
  const n = d.length, l = new SVF(sr);
  mixIn(d, gSub(sr, n, 120 * (v ? 1.1 : 1), 45, 0.08, 0.07, 1), 0, 1);
  for (let i = 0; i < n; i++) { const t = i / sr; d[i] += l.run(R() * 2 - 1, 600, 0.8).lp * ex(t, 0.03) * 0.6 * att(t, 0.001); }
});
R_('landHeavy', 0.42, (d, sr, R) => {
  const n = d.length, l = new SVF(sr), b = new SVF(sr);
  mixIn(d, gSub(sr, n, 90, 30, 0.15, 0.14, 1.2), 0, 1);
  for (let i = 0; i < n; i++) { const t = i / sr; d[i] = Math.tanh(1.3 * (d[i] + l.run(R() * 2 - 1, 400, 0.8).lp * ex(t, 0.08) * 0.8 + b.run(R() * 2 - 1, 1500, 2).bp * ex(t, 0.1) * (0.5 + 0.5 * Math.sin(TAU * 40 * t)) * 0.35)); }
}, 0.9, LO);

// ===== telegraphs / attacks
const fadeEnd = (t, dur, f) => (t > dur - f ? Math.max(0, (dur - t) / f) : 1);
R_('windCharge', 0.85, (d, sr) => {
  const a = new Osc(sr), b = new Osc(sr), l = new SVF(sr);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr, f = sweep(t, 0.8, 180, 1500), trem = 0.65 + 0.35 * Math.sin(TAU * (8 + 30 * t) * t);
    d[i] = (l.run(a.saw(f), 600 + f * 2, 1.5).lp + b.sin(f * 2) * 0.2) * att(t, 0.6) * trem * fadeEnd(t, 0.85, 0.05);
  }
});
R_('windSnipe', 0.9, (d, sr, R) => {
  const a = new Osc(sr), b = new Osc(sr), c = new Osc(sr), h = new SVF(sr);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr, f = 1320 * (1 + 0.01 * t);
    d[i] = (a.sin(f) * 0.5 + b.sin(f + 7) * 0.5 + c.sqr(f * 2, 0.5) * 0.04 + h.run(R() * 2 - 1, 8000, 0.7).hp * 0.06) * att(t, 0.12) * fadeEnd(t, 0.9, 0.06);
  }
});
R_('windFold', 0.62, (d, sr, R) => {
  const f = new SVF(sr), o = new Osc(sr); let ph = 0;
  for (let i = 0; i < d.length; i++) {
    const t = i / sr; ph += (25 + 45 * t / 0.6) / sr; let imp = 0; if (ph >= 1) { ph -= 1; imp = 0.5 + R(); }
    d[i] = f.run(imp, 900 + 200 * Math.sin(TAU * 3 * t), 10).bp * 1.5 * fadeEnd(t, 0.62, 0.05) + o.sin(sweep(t, 0.03, 300, 120)) * ex(t, 0.02) * 0.4;
  }
});
R_('windStomp', 0.75, (d, sr, R) => {
  const l = new SVF(sr), o = new Osc(sr), o2 = new Osc(sr);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    d[i] = (l.run(R() * 2 - 1, 140, 0.9).lp * 2.2 + o.sin(42) * (0.6 + 0.4 * Math.sin(TAU * 6 * t)) * 0.6 + o2.sin(sweep(t, 0.7, 60, 95)) * 0.25) * att(t, 0.5) * fadeEnd(t, 0.75, 0.05);
  }
}, 0.9, LO);
R_('windLeap', 0.45, (d, sr) => {
  const o = new Osc(sr), q = new Osc(sr);
  for (let i = 0; i < d.length; i++) { const t = i / sr; d[i] = (o.sin(sweep(t, 0.4, 180, 520) * (1 + 0.06 * Math.sin(TAU * 18 * t))) + q.tri(sweep(t, 0.4, 360, 1040)) * 0.2) * att(t, 0.05) * ex(t, 0.25); }
});
R_('windWave', 0.55, (d, sr) => {
  const c = new Osc(sr), m = new Osc(sr);
  for (let i = 0; i < d.length; i++) { const t = i / sr, f = sweep(t, 0.5, 440, 900); d[i] = c.sin(f + m.sin(60) * f * 0.3 * t / 0.5) * att(t, 0.3) * fadeEnd(t, 0.55, 0.05); }
});
R_('windDeploy', 0.5, (d, sr, R) => {
  const o = new Osc(sr), l = new SVF(sr);
  mixIn(d, gRelay(sr, d.length, R, 0), 0, 0.5); mixIn(d, gRelay(sr, d.length, R, 0.44), 0, 0.5);
  for (let i = 0; i < d.length; i++) { const t = i / sr; d[i] += l.run(o.saw(sweep(t, 0.45, 140, 260)), 1200, 1.2).lp * (Math.sin(TAU * 22 * t) > 0 ? 1 : 0.4) * att(t, 0.03) * fadeEnd(t, 0.5, 0.04) * 0.6; }
});
R_('windBoss', 1.25, (d, sr) => {
  const a = new Osc(sr), b = new Osc(sr, 0.4), s = new Osc(sr), l = new SVF(sr);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr, f = sweep(t, 1.2, 55, 110);
    d[i] = (l.run(a.saw(f) + b.saw(f * 1.01), sweep(t, 1.2, 200, 2200), 2).lp * 0.6 + s.sin(f / 2) * 0.6) * att(t, 0.8) * fadeEnd(t, 1.25, 0.06);
  }
}, 0.9, LO);
R_('atkCharge', 0.55, (d, sr, R) => {
  const f = new SVF(sr), o = new Osc(sr), l = new SVF(sr);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    d[i] = f.run(R() * 2 - 1, sweep(t, 0.4, 400, 2200), 1).bp * att(t, 0.03) * ex(t, 0.22) * 1.3 + l.run(o.saw(70), 300, 1).lp * ex(t, 0.25) * att(t, 0.01) * 0.6;
  }
});
function boomFn(f0, f1, len, dec, nlp, amt) {
  return (d, sr, R) => {
    const o = new Osc(sr), l = new SVF(sr);
    mixIn(d, gSparks(sr, d.length, R, 0.03, d.length / sr, 0.008), 0, 0.3);
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      d[i] = Math.tanh(amt * (d[i] + o.sin(sweep(t, len, f0, f1)) * ex(t, dec) * att(t, 0.002) + l.run(R() * 2 - 1, sweep(t, len, nlp, 100), 0.8).lp * ex(t, dec * 0.4) * 0.9));
    }
  };
}
R_('atkStomp', 0.6, boomFn(72, 28, 0.25, 0.3, 700, 2), 0.9, LO);
R_('atkSlam', 0.95, boomFn(56, 22, 0.45, 0.5, 1400, 2.2), 0.9, LO);
R_('atkFold', 1.0, (d, sr, R) => {
  boomFn(48, 20, 0.5, 0.5, 1800, 2.2)(d, sr, R);
  mixIn(d, gRelay(sr, d.length, R, 0), 0, 1.2);
}, 0.9, LO);
R_('atkChomp', 0.26, (d, sr, R) => {
  const n = d.length, q = new Osc(sr);
  mixIn(d, gRelay(sr, n, R, 0), 0, 1); mixIn(d, gRelay(sr, n, R, 0.012), 0, 0.8);
  mixIn(d, gSub(sr, n, 180, 70, 0.05, 0.05, 0.8), 0, 1);
  for (let i = 0; i < n; i++) { const t = i / sr; d[i] += q.sqr(600, 0.5) * ex(t, 0.012) * 0.25; }
});
R_('atkLeap', 0.36, (d, sr, R) => {
  const f = new SVF(sr);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr, fc = t < 0.18 ? sweep(t, 0.18, 600, 2400) : sweep(t - 0.18, 0.18, 2400, 900);
    d[i] = f.run(R() * 2 - 1, fc, 1.4).bp * Math.abs(Math.sin(TAU * 2.8 * t)) * att(t, 0.02) * fadeEnd(t, 0.36, 0.05) * 1.3;
  }
});

// ===== enemy shots / hazards
R_('eWave', 0.42, (d, sr, R) => {
  const a = new Osc(sr), b = new Osc(sr), l = new SVF(sr), f = new SVF(sr);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr, e = att(t, 0.05) * ex(t, 0.14);
    d[i] = (a.sin(sweep(t, 0.3, 160, 108)) + l.run(b.saw(76), 420, 1).lp * 0.5 + f.run(R() * 2 - 1, 700, 2).bp * 0.4) * e * (0.75 + 0.25 * Math.sin(TAU * 14 * t));
  }
});
R_('eNotif', 0.24, (d, sr) => {
  const P = [1, 2.4, 4.1], D = [0.12, 0.06, 0.03], os = P.map((_, i) => new Osc(sr, i * 0.2));
  for (let i = 0; i < d.length; i++) { const t = i / sr; let s = 0; for (let k = 0; k < 3; k++) s += os[k].sin(1760 * P[k]) * ex(t, D[k]) / (k + 1); d[i] = s * att(t, 0.001); }
});
R_('eOrb', 0.14, (d, sr) => {
  const a = new Osc(sr), b = new Osc(sr);
  for (let i = 0; i < d.length; i++) { const t = i / sr; d[i] = (a.sin(sweep(t, 0.08, 520, 260)) + b.sin(1040) * ex(t, 0.01) * 0.3) * ex(t, 0.05) * att(t, 0.002); }
});
R_('eBolt', 0.2, (d, sr, R) => {
  const a = new Osc(sr), l = new SVF(sr), h = new SVF(sr);
  for (let i = 0; i < d.length; i++) { const t = i / sr; d[i] = l.run(a.saw(sweep(t, 0.12, 3200, 380)), 6000, 0.8).lp * ex(t, 0.07) * att(t, 0.001) + h.run(R() * 2 - 1, 5000, 0.8).hp * ex(t, 0.005) * 0.8; }
});
R_('eRing', 0.72, (d, sr, R) => {
  const a = new Osc(sr), b = new Osc(sr), l = new SVF(sr), f = new SVF(sr);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    d[i] = (a.sin(sweep(t, 0.5, 92, 58)) + l.run(b.saw(46), 260, 1).lp * 0.6 + f.run(R() * 2 - 1, 320, 1).bp * 0.6) * att(t, 0.12) * ex(t, 0.3);
  }
}, 0.9, LO);
R_('warnBeep', 0.2, (d, sr) => {
  const a = new Osc(sr), b = new Osc(sr), l = new SVF(sr);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr, on = (t < 0.05) ? att(t, 0.002) * fadeEnd(t, 0.05, 0.004) : (t > 0.09 && t < 0.14) ? att(t - 0.09, 0.002) * fadeEnd(t - 0.09, 0.05, 0.004) : 0;
    d[i] = l.run(a.sqr(1046, 0.5) * 0.7 + b.sin(2093) * 0.3, 3000, 0.7).lp * on;
  }
});
R_('zap', 0.36, (d, sr, R) => {
  const f = new SVF(sr), o = new Osc(sr), h = new SVF(sr); let g = 1, gt = 0;
  for (let i = 0; i < d.length; i++) {
    const t = i / sr; if (t > gt) { g = 0.3 + R() * 0.7; gt = t + 0.01 + R() * 0.02; }
    d[i] = (f.run(R() < 0.03 ? R() * 2 - 1 : 0, 3000, 1.5).bp * 4 + o.saw(60) * 0.3 * g + h.run(R() * 2 - 1, 4000, 0.7).hp * 0.3 * g) * ex(t, 0.15) * att(t, 0.002);
  }
});

// ===== player feedback
R_('hurt', 0.42, (d, sr, R) => {
  const l = new SVF(sr), q = new Osc(sr), s = new Osc(sr), g = new Osc(sr); let held = 0;
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    if (i % 9 === 0) held = g.sqr(1200, 0.5); else g.adv(1200);
    const glitch = t > 0.05 && t < 0.12 ? Math.round(held * 2) / 2 * 0.12 : 0;
    const x = l.run(R() * 2 - 1, sweep(t, 0.1, 2000, 300), 0.9).lp * ex(t, 0.07) * 1.1 + q.sqr(sweep(t, 0.12, 300, 90), 0.5) * ex(t, 0.1) * 0.5 + s.sin(sweep(t, 0.15, 95, 40)) * ex(t, 0.15) * 1.2 + glitch;
    d[i] = Math.tanh(1.5 * x * att(t, 0.001));
  }
});
R_('shield', 0.45, (d, sr, R) => {
  const P = [1, 2.76, 5.4], os = P.map((_, i) => new Osc(sr, i * 0.3)), h = new SVF(sr), s = new Osc(sr);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr, pf = 1 + 0.12 * (1 - ex(t, 0.04)); let x = 0;
    for (let k = 0; k < 3; k++) x += os[k].sin(1400 * P[k] * pf) * ex(t, 0.25 / (k + 1)) / (k + 1);
    d[i] = x * 0.6 * att(t, 0.001) + h.run(R() * 2 - 1, 7000, 0.7).hp * (0.5 + 0.5 * Math.sin(TAU * 30 * t)) * ex(t, 0.2) * 0.25 + s.sin(300) * ex(t, 0.03) * 0.4;
  }
});
R_('dash', 0.32, (d, sr, R) => {
  const f = new SVF(sr), o = new Osc(sr);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    d[i] = f.run(R() * 2 - 1, sweep(t, 0.26, 350, 3800), 1.6).bp * att(t, 0.04) * ex(t - 0.04, 0.09) * 1.4 + o.sin(sweep(t, 0.2, 700, 200)) * ex(t, 0.1) * 0.15;
  }
});
R_('dashHit', 0.18, (d, sr, R) => {
  const a = new Osc(sr), h = new SVF(sr), f = new SVF(sr);
  for (let i = 0; i < d.length; i++) { const t = i / sr; d[i] = a.saw(sweep(t, 0.05, 2600, 500)) * ex(t, 0.04) * att(t, 0.0008) * 0.6 + h.run(R() * 2 - 1, 3000, 0.7).hp * ex(t, 0.01) * 0.7 + f.run(R() * 2 - 1, 2800, 1.5).bp * ex(t, 0.008) * 0.5; }
});
R_('pulse', 1.0, (d, sr, R) => {
  const a = new Osc(sr), b = new Osc(sr), r = new Osc(sr), l = new SVF(sr), n = new SVF(sr);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    const x = a.sin(sweep(t, 0.5, 170, 32)) * ex(t, 0.35) + l.run(b.saw(sweep(t, 0.5, 85, 30)), sweep(t, 0.5, 3000, 120), 1.2).lp * ex(t, 0.3) * 0.5 +
      n.run(R() * 2 - 1, sweep(t, 0.6, 6000, 200), 0.8).lp * ex(t, 0.25) * 0.45 + r.sin(880) * (0.5 + 0.5 * Math.sin(TAU * 12 * t)) * ex(t, 0.4) * 0.08;
    d[i] = Math.tanh(1.5 * x * att(t, 0.002));
  }
});
function gGrains(sr, n, freqs, step, dec, t0) {
  const d = new Float32Array(n);
  freqs.forEach((f, k) => {
    const s0 = Math.floor((t0 + k * step) * sr), len = Math.min(n - s0, Math.floor(dec * 6 * sr));
    for (let i = 0; i < len; i++) { const t = i / sr; d[s0 + i] += (Math.sin(TAU * f * t) + 0.35 * Math.sin(TAU * f * 2.76 * t) * ex(t, dec * 0.4)) * ex(t, dec) * att(t, 0.002) * 0.5; }
  });
  return d;
}
R_('pupSpawn', 0.62, (d, sr, R) => {
  const h = new SVF(sr);
  mixIn(d, gGrains(sr, d.length, [3136, 2637, 2349, 2093, 1760, 1568, 1319], 0.055, 0.14, 0), 0, 1);
  for (let i = 0; i < d.length; i++) { const t = i / sr; d[i] += h.run(R() * 2 - 1, sweep(t, 0.5, 9000, 3000), 1.5).bp * ex(t, 0.25) * 0.2; }
});
R_('sparkle', 0.6, (d, sr, R) => {
  const h = new SVF(sr);
  mixIn(d, gGrains(sr, d.length, [1760, 2217, 2637, 3520, 4435, 5274], 0.04, 0.15, 0), 0, 0.8);
  for (let i = 0; i < d.length; i++) { const t = i / sr; d[i] += h.run(R() * 2 - 1, 7000, 0.8).hp * att(t, 0.02) * ex(t, 0.15) * 0.15; }
});
R_('pupGet', 0.32, (d, sr, R) => {
  const h = new SVF(sr), o = new Osc(sr);
  for (let i = 0; i < d.length; i++) { const t = i / sr; d[i] = h.run(R() * 2 - 1, 5000, 0.8).hp * ex(t, 0.08) * att(t, 0.002) * 0.4 + o.sin(2637) * ex(t, 0.12) * 0.3 + Math.sin(TAU * sweep(t, 0.2, 160, 80) * t) * ex(t, 0.1) * 0.4; }
});
R_('pupGone', 0.45, (d, sr, R) => {
  const l = new SVF(sr), o = new Osc(sr);
  for (let i = 0; i < d.length; i++) { const t = i / sr; d[i] = (l.run(R() < 0.25 ? R() * 2 - 1 : 0, sweep(t, 0.4, 1500, 150), 1).lp * 2 + o.sin(sweep(t, 0.3, 700, 140)) * 0.3) * ex(t, 0.2) * att(t, 0.003); }
});
R_('comboBreak', 0.45, (d, sr, R) => {
  const q = new Osc(sr), f = new SVF(sr);
  mixIn(d, gShards(sr, d.length, R, 6, 0.08), 0, 0.6);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr, fr = t < 0.16 ? sweep(t, 0.15, 660, 440) : sweep(t - 0.17, 0.25, 440, 300);
    const e = t < 0.16 ? att(t, 0.005) * fadeEnd(t, 0.16, 0.01) : att(t - 0.17, 0.005) * ex(t - 0.17, 0.12);
    d[i] += f.run(q.sqr(fr, 0.4), 500 + 1800 * (0.5 + 0.5 * Math.sin(TAU * 5 * t)), 4).bp * e * 0.9;
  }
});
R_('tierRise', 0.6, (d, sr, R) => {
  const h = new SVF(sr);
  mixIn(d, gGrains(sr, d.length, [2093, 2637, 3136, 4186], 0.06, 0.12, 0.22), 0, 0.6);
  for (let i = 0; i < d.length; i++) { const t = i / sr; d[i] += h.run(R() * 2 - 1, sweep(t, 0.3, 1000, 8000), 1.2).bp * att(t, 0.25) * ex(t - 0.25, 0.08) * 0.6; }
});
R_('odStart', 1.0, (d, sr, R) => {
  const s = new Osc(sr), os = [110, 165, 220, 330].map((f, i) => new Osc(sr, i * 0.2)), l = new SVF(sr), h = new SVF(sr);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr; let ch = 0; for (let k = 0; k < 4; k++) ch += os[k].saw([110, 165, 220, 330][k]);
    d[i] = Math.tanh(1.3 * (s.sin(sweep(t, 0.3, 70, 35)) * ex(t, 0.3) + l.run(ch * 0.25, sweep(t, 0.4, 300, 5000), 1.5).lp * att(t, 0.01) * ex(t, 0.5) * 0.8 + h.run(R() * 2 - 1, sweep(t, 0.5, 1000, 8000), 1).bp * att(t, 0.2) * ex(t, 0.4) * 0.35));
  }
});
R_('odEnd', 0.7, (d, sr, R) => {
  const a = new Osc(sr), l = new SVF(sr);
  for (let i = 0; i < d.length; i++) { const t = i / sr; d[i] = l.run(a.saw(sweep(t, 0.6, 880, 55)) + (R() * 2 - 1) * 0.2, sweep(t, 0.6, 5000, 200), 1.5).lp * ex(t, 0.35) * att(t, 0.005); }
});
R_('newThreat', 0.45, (d, sr) => {
  const a = new Osc(sr), b = new Osc(sr), l = new SVF(sr);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr, f = t < 0.13 ? 988 : 740, tt = t < 0.13 ? t : t - 0.14, e = t < 0.13 ? att(t, 0.004) * fadeEnd(t, 0.13, 0.01) : att(tt, 0.004) * ex(tt, 0.12) * (t > 0.14 ? 1 : 0);
    d[i] = l.run(a.sin(f) * 0.7 + b.sqr(f, 0.5) * 0.3, 3000, 0.7).lp * e;
  }
});

// ===== bosses
R_('bossPhase', 1.1, (d, sr, R) => {
  const os = [110, 113, 165].map((f, i) => new Osc(sr, i * 0.3)), l = new SVF(sr), f = new SVF(sr), s = new Osc(sr);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr, pf = sweep(t, 1, 1, 0.6); let x = 0;
    for (let k = 0; k < 3; k++) x += os[k].saw([110, 113, 165][k] * pf);
    x = l.run(x * 0.33, sweep(t, 1, 2500, 500), 1.2).lp * (0.6 + 0.4 * Math.sin(TAU * 28 * t));
    d[i] = Math.tanh(1.8 * ((x + f.run(R() * 2 - 1, sweep(t, 1, 3000, 1200), 8).bp * 0.5) * att(t, 0.02) * ex(t, 0.45) + s.sin(sweep(t, 0.3, 80, 30)) * ex(t, 0.3) * 0.8));
  }
});
R_('bossDying', 2.7, (d, sr, R) => {
  const n = d.length, l = new SVF(sr);
  for (let i = 0; i < n; i++) { const t = i / sr; d[i] = l.run(R() * 2 - 1, 120, 0.9).lp * 2.5 * att(t, 1.5) * fadeEnd(t, 2.7, 0.3); }
  mixIn(d, gSparks(sr, n, R, 0, 2.6, 0.004), 0, 0.5);
  for (let k = 0; k < 44; k++) { const t0 = Math.sqrt(R()) * 2.5; mixIn(d, gGrains(sr, Math.floor(0.12 * sr), [2000 + R() * 3000], 0, 0.015, 0), Math.floor(t0 * sr), 0.5); }
  for (let k = 0; k < 6; k++) { const t0 = 0.3 + R() * 2.2; mixIn(d, gSub(sr, Math.floor(0.4 * sr), 80, 30, 0.15, 0.12, 0.7), Math.floor(t0 * sr), 1); }
  for (let i = 0; i < n; i++) d[i] = Math.tanh(d[i]);
}, 0.9, LO);
R_('bossKill', 2.3, (d, sr, R) => {
  const n = d.length, o = new Osc(sr), l = new SVF(sr), h = new SVF(sr);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    d[i] = Math.tanh(2 * (o.sin(sweep(t, 0.8, 70, 22)) * ex(t, 0.7) * att(t, 0.002) + l.run(R() * 2 - 1, sweep(t, 1.5, 8000, 80), 0.7).lp * ex(t, 0.45) * 0.9 + h.run(R() * 2 - 1, 5000, 0.7).hp * ex(t, 0.012) * 0.8));
  }
  mixIn(d, gSparks(sr, n, R, 0.1, 2.2, 0.01), 0, 0.35);
});
R_('tapeStop', 0.9, (d, sr, R) => {
  const a = new Osc(sr), b = new Osc(sr), l = new SVF(sr);
  for (let i = 0; i < d.length; i++) { const t = i / sr, k = Math.max(0, 1 - t / 0.9); d[i] = l.run(a.saw(220 * k * k + 25) + b.sqr(110 * k * k + 12, 0.5) * 0.5, 200 + 2200 * k, 1).lp * ex(t, 0.5) * att(t, 0.003); }
});

// ===== UI
R_('ui', 0.07, (d, sr) => {
  const a = new Osc(sr), b = new Osc(sr);
  for (let i = 0; i < d.length; i++) { const t = i / sr; d[i] = (a.sin(1320) * ex(t, 0.02) + b.sqr(2640, 0.5) * ex(t, 0.004) * 0.2) * att(t, 0.0008); }
});
R_('uiBack', 0.1, (d, sr) => {
  const a = new Osc(sr);
  for (let i = 0; i < d.length; i++) { const t = i / sr; d[i] = a.sin(sweep(t, 0.06, 990, 700)) * ex(t, 0.03) * att(t, 0.001); }
});
R_('toggle', 0.06, (d, sr, R) => {
  const a = new Osc(sr), f = new SVF(sr);
  for (let i = 0; i < d.length; i++) { const t = i / sr; d[i] = a.sin(1760) * ex(t, 0.01) * att(t, 0.0005) + f.run(R() * 2 - 1, 4000, 2).bp * ex(t, 0.003); }
});
R_('start', 0.75, (d, sr, R) => {
  mixIn(d, gGrains(sr, d.length, [880, 1319, 1760, 2637], 0.07, 0.16, 0), 0, 1);
  const q = new Osc(sr), h = new SVF(sr);
  for (let i = 0; i < d.length; i++) { const t = i / sr; d[i] += q.sqr(t < 0.07 ? 880 : t < 0.14 ? 1319 : 1760, 0.25) * ex(t % 0.07 + (t > 0.14 ? t - 0.14 : 0), 0.05) * 0.12 + h.run(R() * 2 - 1, 8000, 0.8).hp * att(t, 0.2) * ex(t, 0.2) * 0.1; }
});

// ---------------------------------------------------------------- music theory
const MODES = {
  aeol: [0, 2, 3, 5, 7, 8, 10], dor: [0, 2, 3, 5, 7, 9, 10], phry: [0, 1, 3, 5, 7, 8, 10],
  harm: [0, 2, 3, 5, 7, 8, 11], ion: [0, 2, 4, 5, 7, 9, 11], mix: [0, 2, 4, 5, 7, 9, 10],
};
const CHORDS = {
  m: [0, 3, 7], M: [0, 4, 7], 5: [0, 7, 12], sus2: [0, 2, 7], sus4: [0, 5, 7], m7: [0, 3, 7, 10], M7: [0, 4, 7, 11],
  7: [0, 4, 7, 10], m9: [0, 3, 7, 10, 14], add9: [0, 4, 7, 14], dim: [0, 3, 6],
};
const expand = (c) => { const tn = []; for (let o = 0; o < 4; o++) for (const iv of c) if (iv < 12) tn.push(iv + 12 * o); return tn; };
const degSemi = (mode, d) => { const n = mode.length, o = Math.floor(d / n), i = ((d % n) + n) % n; return mode[i] + 12 * o; };
// THE AFTER HOURS THEME — 4 bars, [16th-step, scale degree, length]. Tresillo hook (3+3+2).
// Over i–VI–III–VII: bar1 leaps to the octave and walks down, bar2 lands on the 5th (maj7 colour),
// bar3 answers with the same rhythm rising, bar4 peaks on the minor 3rd and settles on the root.
const MOTIF = [
  [0, 7, 3], [3, 4, 3], [6, 6, 2], [8, 7, 2], [10, 9, 2], [12, 8, 2], [14, 6, 2],
  [16, 7, 3], [19, 5, 3], [22, 4, 8], [30, 3, 2],
  [32, 4, 3], [35, 3, 3], [38, 2, 2], [40, 4, 2], [42, 6, 2], [44, 7, 2], [46, 8, 2],
  [48, 9, 3], [51, 8, 3], [54, 6, 2], [56, 7, 8],
];
const MOTIF_AT = new Array(64).fill(null);
for (const [s, dg, l] of MOTIF) MOTIF_AT[s] = [dg, l];
const VEL = { X: 1, x: 0.72, o: 0.4, g: 0.28 };
const STEMS = ['kick', 'snare', 'hat', 'perc', 'bass', 'arp', 'lead', 'pad', 'counter', 'top'];
const FILL = { s: ['snare', 0.7], S: ['snare', 1], t: ['tomL', 0.9], m: ['tomM', 0.85], h: ['tomH', 0.8], k: ['kick', 0.9], r: ['snare', 0.55], R: ['snare', 0.8] };

// ---------------------------------------------------------------- the soundtrack
// stems: [stem, entry threshold on energy E]. Listed in entry order (Mario-style layering).
const MOODS = {
  title: { // inviting, cool, mid-tempo synthwave — the theme on a soft pluck
    trim: 1.9,
    bpm: 100, key: 57, mode: 'aeol', swing: 0, leadLP: 3200,
    prog: [[0, 'm9'], [8, 'M7'], [3, 'M7'], [10, 'add9']],
    kick: [['X.......X.x.....', 'kickSoft', 0.9]],
    snare: [['....x.......x...', 'clap', 0.75], ['..............o.', 'rim', 0.5]],
    hat: [['..x...x...x...x.', 'hatC', 0.55], ['x.x.x.x.x.x.x.x.', 'shaker', 0.3]],
    bass: { pat: 'r_____r___r_o___', voice: 'sub', oct: -12, vel: 0.85 },
    arp: { pat: '0.2.1.3.0.2.1.4.', voice: 'bell', oct: 12, len: 2, vel: 0.45 },
    lead: { voice: 'pluck', oct: 0, vel: 0.7 },
    pad: { voice: 'warm', vel: 0.5 },
    counter: { type: 'echo', delay: 12, voice: 'glass', oct: 12, vel: 0.3 },
    top: { lanes: [['..........x.....', 'hatO', 0.3]] },
    fill: '..sS',
    stems: [['pad', 0], ['arp', 0.12], ['kick', 0.24], ['bass', 0.3], ['hat', 0.4], ['snare', 0.5], ['lead', 0.6], ['counter', 0.75], ['top', 0.85]],
  },
  close: { // 10 PM: sparse & sneaky — swung pizzicato, a ticking clock, the theme in fragments on a music box
    trim: 1.9,
    bpm: 96, key: 57, mode: 'harm', swing: 0.16, leadLP: 4000,
    prog: [[0, 'm'], [0, 'm'], [5, 'm'], [7, 'M']],
    kick: [['X.........x.....', 'kickSoft', 0.7]],
    bass: { pat: 'r.r.f.o.r.r.s.f.', voice: 'pizz', oct: -12, vel: 0.9 },
    hat: [['..x...x...x...xx', 'hatC', 0.45], ['s.s.s.s.s.s.s.s.', 'shaker', 0.22]],
    snare: [['....x......x..x.', 'rim', 0.7], ['............x...', 'snap', 0.5]],
    arp: { pat: '0...2...0...2...', voice: 'wood', oct: 24, len: 1, vel: 0.45 },
    lead: { voice: 'musicbox', oct: 12, frag: [0, 2], vel: 0.55, gate: 0.6 },
    pad: { voice: 'dark', vel: 0.45 },
    counter: { type: 'trem', vel: 0.24 },
    top: { lanes: [['..............o.', 'hatO', 0.3], ['........x.......', 'tomL', 0.25]] },
    fill: '.m.t',
    stems: [['kick', 0], ['bass', 0], ['hat', 0.2], ['snare', 0.33], ['arp', 0.45], ['lead', 0.56], ['pad', 0.68], ['counter', 0.8], ['top', 0.9]],
  },
  night: { // 11 PM: driving synthwave — four on the floor, pulsing bass, supersaw theme
    trim: 1.0,
    bpm: 118, key: 57, mode: 'aeol', swing: 0, leadLP: 4200,
    prog: [[0, 'm'], [8, 'M'], [3, 'M'], [10, 'M']],
    kick: [['X...X...X...X...', 'kick', 1]],
    bass: { pat: 'R.r.o.r.R.r.o.rr', voice: 'bpluck', oct: -12, vel: 0.9 },
    hat: [['xxXxxxXxxxXxxxXx', 'hatC', 0.42]],
    snare: [['....X.......X...', 'snare', 0.9]],
    arp: { pat: '0123210123432121', voice: 'sawpluck', oct: 12, len: 1, vel: 0.5 },
    lead: { voice: 'supersaw', oct: 0, vel: 0.75 },
    pad: { voice: 'warm', vel: 0.5 },
    counter: { type: 'stabs', pat: '..x...x...x...x.', vel: 0.45, oct: 0 },
    top: { lanes: [['..............o.', 'hatO', 0.4]], double: true, dvoice: 'pluck' },
    fill: 'ssSS',
    stems: [['kick', 0], ['bass', 0], ['hat', 0.15], ['snare', 0.3], ['arp', 0.42], ['lead', 0.55], ['pad', 0.66], ['counter', 0.78], ['top', 0.88]],
  },
  boss: { // MIDNIGHT — GIGA GATEWAY: D phrygian power chords, galloping distorted bass, anvils, sirens
    trim: 0.62,
    bpm: 140, key: 50, mode: 'phry', swing: 0, leadLP: 2600, phaseBpm: [0, 4, 10],
    prog: [[0, '5'], [1, '5'], [0, '5'], [10, '5']],
    kick: [['X.X...X.X.X...X.', 'kickHeavy', 1]],
    bass: { pat: 'r.rrr.rrr.rrr.rr', voice: 'dist', oct: -12, vel: 0.9 },
    snare: [['....X.......X...', 'snare', 1]],
    hat: [['x.x.x.x.x.x.x.x.', 'hatC', 0.55]],
    perc: [['..x.....x.....x.', 'anvil', 0.4], ['............x.xx', 'tomL', 0.6]],
    lead: { voice: 'brass', oct: 0, vel: 0.85 },
    pad: { voice: 'choir', vel: 0.55 },
    counter: { type: 'siren', vel: 0.24 },
    arp: { pat: '0121012101210121', voice: 'sawpluck', oct: 24, len: 1, vel: 0.35 },
    top: { lanes: [['............xxxx', 'kickHeavy', 0.6]], double: true, dvoice: 'supersaw' },
    fill: 'hmtt',
    stems: [['kick', 0], ['bass', 0], ['snare', 0.12], ['hat', 0.25], ['perc', 0.36], ['lead', 0.48], ['pad', 0.58], ['counter', 0.7], ['arp', 0.8], ['top', 0.9]],
  },
  mesh: { // 1 AM: brighter B dorian, interlocking arpeggios (a 16th arp vs a dotted-8th marimba)
    trim: 1.12,
    bpm: 124, key: 59, mode: 'dor', swing: 0, leadLP: 5200,
    prog: [[0, 'm7'], [5, 'M'], [8, 'M7'], [10, 'sus2']],
    arp: { pat: '0213243543213210', voice: 'pluck', oct: 12, len: 1, vel: 0.5 },
    kick: [['X...X...X...X...', 'kick', 0.95]],
    bass: { pat: 'r..r..r...r..o..', voice: 'bpluck', oct: -24, vel: 0.85 },
    hat: [['xxXxxxXxxxXxxxXx', 'hatC', 0.42]],
    snare: [['....x.......x...', 'clap', 0.85]],
    counter: { type: 'arp2', pat: '4..2..5..3..6..4', voice: 'marimba', oct: 12, vel: 0.5 },
    lead: { voice: 'supersaw', oct: 0, vel: 0.7 },
    pad: { voice: 'glasspad', vel: 0.45 },
    top: { lanes: [['x.x.x.x.x.x.x.x.', 'ride', 0.28]], double: true, dvoice: 'bell' },
    fill: 'ssSS',
    stems: [['arp', 0], ['kick', 0.1], ['bass', 0.2], ['hat', 0.3], ['snare', 0.4], ['counter', 0.5], ['lead', 0.62], ['pad', 0.74], ['top', 0.88]],
  },
  phones: { // 2 AM: KEY CHANGE to C# minor — glitchy ringtone trills, stuttered theme, bit-crushed arps
    trim: 1.2,
    bpm: 128, key: 49, mode: 'aeol', swing: 0.08, leadLP: 5000,
    prog: [[0, 'm'], [8, 'M'], [3, 'M'], [10, 'M']],
    counter: { type: 'ring', pat: '0101010.2323232.', bars: [0, 2], vel: 0.4, oct: 24 },
    kick: [['X.....X...X.....', 'kick', 1]],
    bass: { pat: 'r..r..r...r.o.r.', voice: 'bpluck', oct: -12, vel: 0.85 },
    snare: [['....X..o....X.o.', 'snare', 0.9]],
    hat: [['xxxxxxxxxxxxxxxx', 'hatC', 0.38]],
    lead: { voice: 'ringtone', oct: 12, stut: [8, 14], vel: 0.55 },
    arp: { pat: '0.3.1.4.2.5.1.3.', voice: 'glitch', oct: 24, len: 1, vel: 0.35 },
    pad: { voice: 'glasspad', vel: 0.4 },
    top: { lanes: [['..............xx', 'hatC', 0.35]], tritone: true },
    fill: 'rrRR',
    stems: [['counter', 0], ['kick', 0.1], ['bass', 0.2], ['snare', 0.28], ['hat', 0.36], ['lead', 0.5], ['arp', 0.64], ['pad', 0.76], ['top', 0.88]],
  },
  deadzone: { // 3 AM: Bb minor (a semitone above home = unease), heartbeat kick, reese bass, detuned & filtered
    trim: 1.1,
    bpm: 112, key: 58, mode: 'aeol', swing: 0, leadLP: 3000, lp: 1500, lfo: 650, wobble: true,
    prog: [[0, 'm'], [1, 'M'], [5, 'm'], [7, 'M']],
    pad: { voice: 'reesepad', vel: 0.5 },
    kick: [['X.x.......x.....', 'kick', 0.9]],
    bass: { pat: 'r_______________', voice: 'reese', oct: -24, vel: 0.8 },
    snare: [['........X.......', 'snare', 0.95]],
    hat: [['x.xxx.x.x.xxx.xx', 'hatC', 0.28]],
    lead: { voice: 'theremin', oct: 0, aug: 2, vel: 0.6 },
    arp: { pat: '0.......2.......', voice: 'ping', oct: 24, len: 2, vel: 0.45 },
    counter: { type: 'static', vel: 0.45 },
    top: { lanes: [['....x.......x...', 'tomL', 0.35]], revcym: true },
    fill: 'tt.m',
    stems: [['pad', 0], ['kick', 0.1], ['bass', 0.16], ['snare', 0.28], ['hat', 0.38], ['lead', 0.5], ['arp', 0.62], ['counter', 0.74], ['top', 0.86]],
  },
  boss2: { // 4 AM — THE FLAGSHIP: F# harmonic minor, choir, brass theme, tresillo orchestral hits; phase 3 modulates up
    trim: 0.7,
    bpm: 152, key: 54, mode: 'harm', swing: 0, leadLP: 3400, phaseBpm: [0, 0, 6], phaseKey: [0, 0, 1],
    prog: [[0, 'm'], [8, 'M'], [5, 'm'], [7, 'M']],
    kick: [['X..X..X...X.X...', 'kick', 1], ['X...............', 'kickHeavy', 0.6]],
    bass: { pat: 'r.o.r.o.r.o.r.oo', voice: 'dist', oct: -12, vel: 0.8 },
    snare: [['....X.......X...', 'snare', 1]],
    pad: { voice: 'choir', vel: 0.6 },
    perc: [['x...x..xx...x.x.', 'tomL', 0.65], ['..x.......x.....', 'tomM', 0.5]],
    hat: [['xxXxxxXxxxXxxxXx', 'hatC', 0.42]],
    lead: { voice: 'brass', oct: 0, vel: 0.9 },
    counter: { type: 'hits', pat: 'X..X..X.........', vel: 0.55 },
    arp: { pat: '0102010201020102', voice: 'sawpluck', oct: 12, len: 1, vel: 0.4 },
    top: { lanes: [], double: true, dvoice: 'supersaw' },
    fill: 'hmtt',
    stems: [['kick', 0], ['bass', 0], ['snare', 0.1], ['pad', 0.2], ['perc', 0.32], ['hat', 0.42], ['lead', 0.52], ['counter', 0.62], ['arp', 0.74], ['top', 0.86]],
  },
  dawn: { // 5 AM: the theme returns in A MAJOR — hopeful, climactic, canon of bells
    trim: 0.95,
    bpm: 132, key: 57, mode: 'ion', swing: 0, leadLP: 5200,
    prog: [[0, 'M'], [7, 'M'], [9, 'm'], [5, 'M']],
    kick: [['X...X...X...X...', 'kick', 1]],
    bass: { pat: 'r_o_r_o_r_o_r_o_', voice: 'bpluck', oct: -12, vel: 0.85 },
    pad: { voice: 'warm', vel: 0.55 },
    hat: [['x.X.x.X.x.X.x.X.', 'hatC', 0.42], ['..o...o...o...o.', 'hatO', 0.22]],
    snare: [['....X.......X...', 'clap', 0.9]],
    arp: { pat: '0123123423452345', voice: 'pluck', oct: 12, len: 1, vel: 0.45 },
    lead: { voice: 'supersaw', oct: 0, vel: 0.8 },
    counter: { type: 'echo', delay: 8, voice: 'bell', oct: 24, vel: 0.3 },
    top: { lanes: [['x.x.x.x.x.x.x.x.', 'ride', 0.28]], double: true, dvoice: 'supersaw' },
    fill: 'ssSS',
    stems: [['kick', 0], ['bass', 0], ['pad', 0.1], ['hat', 0.2], ['snare', 0.3], ['arp', 0.42], ['lead', 0.55], ['counter', 0.7], ['top', 0.84]],
  },
  overtime: { // PULL A DOUBLE: D mixolydian party at 160 — disco hats, cowbell, octave-doubled theme
    trim: 0.9,
    bpm: 160, key: 50, mode: 'mix', swing: 0, leadLP: 5000,
    prog: [[0, 'M'], [10, 'M'], [5, 'M'], [0, 'M']],
    kick: [['X...X...X...X...', 'kick', 1]],
    bass: { pat: 'r_o_r_o_r_o_r_oo', voice: 'bpluck', oct: -12, vel: 0.85 },
    hat: [['xxxxxxxxxxxxxxxx', 'hatC', 0.32], ['..o...o...o...o.', 'hatO', 0.38]],
    snare: [['....X.......X...', 'clap', 1], ['....x.......x...', 'snare', 0.45]],
    perc: [['x..x..x...x..x..', 'cowbell', 0.4]],
    counter: { type: 'stabs', pat: '..x...x...x...x.', vel: 0.5, oct: 12 },
    lead: { voice: 'sqlead', oct: 12, vel: 0.6 },
    arp: { pat: '5432543254325432', voice: 'sawpluck', oct: 12, len: 1, vel: 0.4 },
    pad: { voice: 'warm', vel: 0.45 },
    top: { lanes: [['X...............', 'crash', 0.3]], double: true, dvoice: 'supersaw' },
    fill: 'SSSS',
    stems: [['kick', 0], ['bass', 0], ['hat', 0.1], ['snare', 0.2], ['perc', 0.3], ['counter', 0.4], ['lead', 0.5], ['arp', 0.62], ['pad', 0.74], ['top', 0.84]],
  },
  sunrise: { // after VICTORY: calm A-major reprise
    trim: 1.7,
    bpm: 96, key: 57, mode: 'ion', swing: 0, leadLP: 3000,
    prog: [[0, 'add9'], [5, 'M7'], [9, 'm7'], [7, 'sus4']],
    kick: [['X.......X.......', 'kickSoft', 0.8]],
    hat: [['..x...x...x...x.', 'shaker', 0.35]],
    bass: { pat: 'r_______r_______', voice: 'sub', oct: -12, vel: 0.8 },
    arp: { pat: '0.2.1.3.2.4.3.5.', voice: 'bell', oct: 12, len: 2, vel: 0.4 },
    lead: { voice: 'pluck', oct: 0, vel: 0.6 },
    pad: { voice: 'warm', vel: 0.5 },
    counter: { type: 'echo', delay: 12, voice: 'glass', oct: 12, vel: 0.28 },
    stems: [['pad', 0], ['arp', 0.1], ['bass', 0.25], ['kick', 0.35], ['hat', 0.45], ['lead', 0.55], ['counter', 0.65]],
  },
  aftermath: { // after a boss falls, until the next hour: a calm vamp in the fanfare's major key
    trim: 1.7,
    bpm: 100, key: 53, mode: 'ion', swing: 0, leadLP: 3000,
    prog: [[0, 'add9'], [5, 'M'], [0, 'add9'], [7, 'sus4']],
    kick: [['X.......X.......', 'kickSoft', 0.7]],
    bass: { pat: 'r_______r___o___', voice: 'sub', oct: -12, vel: 0.7 },
    arp: { pat: '0.2.1.3.0.2.1.3.', voice: 'bell', oct: 12, len: 2, vel: 0.35 },
    pad: { voice: 'warm', vel: 0.45 },
    stems: [['pad', 0], ['arp', 0.1], ['bass', 0.25], ['kick', 0.35]],
  },
};
const MOOD_OK = { title: 1, close: 1, night: 1, boss: 1, mesh: 1, phones: 1, deadzone: 1, boss2: 1, dawn: 1, overtime: 1 };

// SFX table: r = recipe, n = round-robin variants, vol, pri (0 low … 3 critical), gate (s), cap (per group),
// jit = random pitch ± fraction, grp = gate/cap group, verb = reverb send, duck = music level while it plays, dist = distance attenuation
const SFX = {
  shot0: { r: 'shot0', n: 3, vol: 0.2, pri: 0, gate: 0.045, cap: 3, jit: 0.03, grp: 'shot' },
  shot1: { r: 'shot1', n: 3, vol: 0.2, pri: 0, gate: 0.045, cap: 3, jit: 0.03, grp: 'shot' },
  shot2: { r: 'shot2', n: 3, vol: 0.21, pri: 0, gate: 0.045, cap: 3, jit: 0.03, grp: 'shot' },
  shot3: { r: 'shot3', n: 3, vol: 0.22, pri: 0, gate: 0.045, cap: 3, jit: 0.03, grp: 'shot' },
  shotOD: { r: 'shotOD', n: 3, vol: 0.22, pri: 0, gate: 0.045, cap: 3, jit: 0.03, grp: 'shot' },
  hit: { r: 'hit', n: 3, vol: 0.26, pri: 0, gate: 0.03, cap: 4, jit: 0.07, dist: 1 },
  crit: { r: 'crit', n: 2, vol: 0.3, pri: 1, gate: 0.06, cap: 2, jit: 0.04, dist: 1 },
  bossHit: { r: 'bossHit', n: 2, vol: 0.36, pri: 1, gate: 0.07, cap: 2, jit: 0.05 },
  killModem: { r: 'killModem', n: 3, vol: 0.42, pri: 1, gate: 0.04, cap: 4, jit: 0.05, dist: 1, grp: 'killM' },
  killPod: { r: 'killPod', n: 3, vol: 0.34, pri: 1, gate: 0.035, cap: 3, jit: 0.06, dist: 1, grp: 'killM' },
  killPhone: { r: 'killPhone', n: 3, vol: 0.42, pri: 1, gate: 0.04, cap: 4, jit: 0.04, dist: 1, grp: 'killP' },
  killEliteM: { r: 'killEliteM', n: 2, vol: 0.55, pri: 2, gate: 0.08, cap: 2, jit: 0.03, verb: 1, grp: 'elite' },
  killEliteP: { r: 'killEliteP', n: 2, vol: 0.55, pri: 2, gate: 0.08, cap: 2, jit: 0.03, verb: 1, grp: 'elite' },
  multiKill: { r: 'multiKill', n: 1, vol: 0.5, pri: 2, gate: 0.18, cap: 1, jit: 0.05, verb: 1 },
  bootModem: { r: 'bootModem', n: 3, vol: 0.26, pri: 0, gate: 0.07, cap: 3, jit: 0.05, dist: 1, grp: 'boot' },
  bootPhone: { r: 'bootPhone', n: 3, vol: 0.26, pri: 0, gate: 0.07, cap: 3, jit: 0.02, dist: 1, grp: 'boot' },
  bootPod: { r: 'bootPod', n: 1, vol: 0.2, pri: 0, gate: 0.05, cap: 2, jit: 0.08, dist: 1, grp: 'boot' },
  land: { r: 'land', n: 2, vol: 0.3, pri: 0, gate: 0.05, cap: 3, jit: 0.08, dist: 1 },
  landHeavy: { r: 'landHeavy', n: 1, vol: 0.4, pri: 1, gate: 0.08, cap: 2, jit: 0.05, dist: 1 },
  windCharge: { r: 'windCharge', n: 1, vol: 0.24, pri: 1, gate: 0.15, cap: 2, jit: 0.04, dist: 1, grp: 'wind' },
  windSnipe: { r: 'windSnipe', n: 1, vol: 0.16, pri: 1, gate: 0.15, cap: 2, jit: 0.03, dist: 1, grp: 'wind' },
  windFold: { r: 'windFold', n: 1, vol: 0.3, pri: 1, gate: 0.15, cap: 2, jit: 0.05, dist: 1, grp: 'wind' },
  windStomp: { r: 'windStomp', n: 1, vol: 0.34, pri: 1, gate: 0.15, cap: 2, jit: 0.05, dist: 1, grp: 'wind' },
  windLeap: { r: 'windLeap', n: 1, vol: 0.22, pri: 1, gate: 0.12, cap: 2, jit: 0.06, dist: 1, grp: 'wind' },
  windWave: { r: 'windWave', n: 1, vol: 0.2, pri: 1, gate: 0.15, cap: 2, jit: 0.05, dist: 1, grp: 'wind' },
  windDeploy: { r: 'windDeploy', n: 1, vol: 0.26, pri: 1, gate: 0.15, cap: 2, jit: 0.05, dist: 1, grp: 'wind' },
  windBoss: { r: 'windBoss', n: 1, vol: 0.42, pri: 2, gate: 0.3, cap: 1, jit: 0.02, verb: 1 },
  atkCharge: { r: 'atkCharge', n: 1, vol: 0.34, pri: 1, gate: 0.1, cap: 2, jit: 0.05, dist: 1, grp: 'atk' },
  atkStomp: { r: 'atkStomp', n: 1, vol: 0.48, pri: 2, gate: 0.1, cap: 2, jit: 0.04, dist: 1, grp: 'boom' },
  atkSlam: { r: 'atkSlam', n: 1, vol: 0.6, pri: 2, gate: 0.15, cap: 1, jit: 0.03, verb: 1, grp: 'boom', duck: 0.6 },
  atkFold: { r: 'atkFold', n: 1, vol: 0.62, pri: 2, gate: 0.15, cap: 1, jit: 0.03, verb: 1, grp: 'boom', duck: 0.6 },
  atkChomp: { r: 'atkChomp', n: 1, vol: 0.4, pri: 1, gate: 0.08, cap: 2, jit: 0.06, dist: 1, grp: 'atk' },
  atkLeap: { r: 'atkLeap', n: 1, vol: 0.28, pri: 1, gate: 0.08, cap: 2, jit: 0.06, dist: 1, grp: 'atk' },
  eWave: { r: 'eWave', n: 1, vol: 0.3, pri: 1, gate: 0.12, cap: 2, jit: 0.05, dist: 1 },
  eNotif: { r: 'eNotif', n: 1, vol: 0.14, pri: 0, gate: 0.06, cap: 3, jit: 0, dist: 1 },
  eOrb: { r: 'eOrb', n: 1, vol: 0.2, pri: 0, gate: 0.07, cap: 3, jit: 0.08, dist: 1 },
  eBolt: { r: 'eBolt', n: 1, vol: 0.3, pri: 1, gate: 0.08, cap: 2, jit: 0.04, dist: 1 },
  eRing: { r: 'eRing', n: 1, vol: 0.42, pri: 1, gate: 0.2, cap: 2, jit: 0.03 },
  warnBeep: { r: 'warnBeep', n: 1, vol: 0.18, pri: 1, gate: 0.15, cap: 2, jit: 0 },
  zap: { r: 'zap', n: 1, vol: 0.3, pri: 1, gate: 0.1, cap: 2, jit: 0.06, dist: 1 },
  hurt: { r: 'hurt', n: 1, vol: 0.7, pri: 3, gate: 0.12, cap: 1, jit: 0.03, duck: 0.45 },
  shield: { r: 'shield', n: 1, vol: 0.45, pri: 2, gate: 0.12, cap: 1, jit: 0.03 },
  dash: { r: 'dash', n: 1, vol: 0.42, pri: 2, gate: 0.1, cap: 1, jit: 0.05 },
  dashHit: { r: 'dashHit', n: 1, vol: 0.32, pri: 1, gate: 0.04, cap: 3, jit: 0.08 },
  pulse: { r: 'pulse', n: 1, vol: 0.75, pri: 3, gate: 0.2, cap: 1, jit: 0, verb: 1, duck: 0.35 },
  pupSpawn: { r: 'pupSpawn', n: 1, vol: 0.3, pri: 1, gate: 0.2, cap: 2, jit: 0.02, verb: 1 },
  pupGet: { r: 'pupGet', n: 1, vol: 0.35, pri: 2, gate: 0.08, cap: 2, jit: 0.02 },
  pupGone: { r: 'pupGone', n: 1, vol: 0.28, pri: 1, gate: 0.2, cap: 2, jit: 0.03 },
  comboBreak: { r: 'comboBreak', n: 1, vol: 0.34, pri: 2, gate: 0.3, cap: 1, jit: 0 },
  sparkle: { r: 'sparkle', n: 1, vol: 0.26, pri: 2, gate: 0.1, cap: 2, jit: 0.02, verb: 1 },
  tierRise: { r: 'tierRise', n: 1, vol: 0.32, pri: 2, gate: 0.2, cap: 1, jit: 0 },
  odStart: { r: 'odStart', n: 1, vol: 0.55, pri: 3, gate: 0.3, cap: 1, jit: 0, verb: 1, duck: 0.5 },
  odEnd: { r: 'odEnd', n: 1, vol: 0.4, pri: 2, gate: 0.3, cap: 1, jit: 0 },
  newThreat: { r: 'newThreat', n: 1, vol: 0.28, pri: 2, gate: 0.5, cap: 1, jit: 0 },
  bossPhase: { r: 'bossPhase', n: 1, vol: 0.62, pri: 3, gate: 0.3, cap: 1, jit: 0, verb: 1, duck: 0.45 },
  bossDying: { r: 'bossDying', n: 1, vol: 0.6, pri: 3, gate: 1, cap: 1, jit: 0, verb: 1 },
  bossKill: { r: 'bossKill', n: 1, vol: 0.85, pri: 3, gate: 1, cap: 1, jit: 0, verb: 1, duck: 0.3 },
  tapeStop: { r: 'tapeStop', n: 1, vol: 0.45, pri: 3, gate: 0.5, cap: 1, jit: 0 },
  ui: { r: 'ui', n: 1, vol: 0.32, pri: 3, gate: 0.03, cap: 2, jit: 0 },
  uiBack: { r: 'uiBack', n: 1, vol: 0.32, pri: 3, gate: 0.03, cap: 2, jit: 0 },
  toggle: { r: 'toggle', n: 1, vol: 0.3, pri: 3, gate: 0.03, cap: 2, jit: 0 },
  start: { r: 'start', n: 1, vol: 0.45, pri: 3, gate: 0.2, cap: 1, jit: 0, verb: 1 },
};
const WIND = { charge: 'windCharge', snipe: 'windSnipe', fold: 'windFold', chomp: 'windFold', stomp: 'windStomp', slam: 'windStomp', leap: 'windLeap', wave: 'windWave', deploy: 'windDeploy' };
const ATK = { charge: 'atkCharge', stomp: 'atkStomp', slam: 'atkSlam', leap: 'atkLeap', chomp: 'atkChomp', fold: 'atkChomp' };
const ESHOT = { wave: 'eWave', notif: 'eNotif', orb: 'eOrb', bolt: 'eBolt', ring: 'eRing' };
const PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21];
const PUP_FAM = { slug: 'wep', clock: 'wep', split: 'wep', pier: 'wep', rein: 'body', wind: 'body', feet: 'util', cap: 'util', field: 'util', scav: 'util', nrg: 'nrg', shld: 'nrg', vac: 'nrg' };
// the §3 table gives hazard events a `type` field that collides with the event type; accept the usual aliases
const hazType = (ev) => ev.htype || ev.hazType || ev.hazard || ev.shape || ev.kind || (ev.type !== 'hazardLive' && ev.type !== 'hazardWarn' ? ev.type : '');
const WARM = [ // background render order: music first, then the most frequent SFX
  'kick', 'kickSoft', 'kickHeavy', 'snare', 'clap', 'hatC', 'hatO', 'shaker', 'crash', 'impact', 'rim', 'snap', 'tomL', 'tomM', 'tomH',
  'shot0', 'shot1', 'shot2', 'shot3', 'hit', 'killModem', 'killPhone', 'killPod', 'bootModem', 'bootPhone', 'land', 'gem',
  'crit', 'dash', 'hurt', 'pulse', 'pupSpawn', 'pupGet', 'sparkle', 'eNotif', 'eWave', 'eOrb', 'eBolt', 'windCharge', 'windSnipe',
  'windFold', 'windStomp', 'windLeap', 'windWave', 'windDeploy', 'atkCharge', 'atkStomp', 'atkChomp', 'atkLeap', 'warnBeep', 'zap',
  'shield', 'dashHit', 'landHeavy', 'bootPod', 'killEliteM', 'killEliteP', 'multiKill', 'shotOD', 'odStart', 'odEnd', 'pupGone',
  'comboBreak', 'tierRise', 'newThreat', 'ride', 'cowbell', 'anvil', 'revCym', 'static', 'bossHit', 'windBoss', 'eRing', 'atkSlam',
  'atkFold', 'bossPhase', 'bossDying', 'bossKill', 'tapeStop', 'ui', 'uiBack', 'toggle', 'start',
];

// =====================================================================================
export function createAudio(opts = {}) {
  const AC = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
  const external = opts.ctx || null, manual = !!external, DEBUG = !!opts.debug;
  const LOOK = 0.15, LOOK_MAX = 0.3;
  let look = LOOK, lastPump = -1;
  let ctx = null, ready = false, enabled = opts.enabled !== false, unlocked = manual, timer = 0, offTok = 0, listeners = false;
  const vol = { music: 0.52, sfx: 0.85 };
  const dbg = { lead: [], nodes: 0, maxNodes: 0, sfxPlayed: 0, sfxGated: 0, sfxDropped: 0, sfxStolen: 0, minMargin: 1e9, notes: 0, bars: [], kicks: [], maxVoices: 0 };
  // graph nodes
  let out, master, pauseLP, sfxBus, stingBus, musicOut, duckG, trimG, musicMix, fDry, fWet, lfoG, verbIn, sfxVerb, dlIn, d1, d2, dfb, bassDist, crushIn, choirIn, leadLP;
  const stemIn = {}, stemG = {}, panB = [], PW = {};
  const BANK = Object.create(null);
  let warmI = 0;
  const mr = rng(777), sr_ = rng(4242);
  // state
  const st = { intensity: 0, I: 0, lastT: 0, progressExt: null, bossFlag: false, hour: -1, hourT: 0, hourDur: 35, bossPhase: 1, bossP: 0,
    od: false, px: 0, pz: 6.5, streak: 0, lastGem: -1, kills: [], lastUpd: -1, afterKey: 53, afterFrom: null, dying: false, paused: false, notif: 0 };
  const seq = { def: null, mood: null, target: null, pend: null, restart: false, next: 0, step: 0, bar: 0, bpm: 100, key: 57,
    mode: MODES.aeol, act: {}, since: {}, E: 0, jingle: false, lock: null, stopMood: null, croot: 57, chord: CHORDS.m, tones: expand(CHORDS.m),
    lastLead: 0, sirenF: 0, wob: false, holdUntil: 0, keyAdd: 0, bpmAdd: 0 };
  const mv = []; // music voices {g, end}
  const sv = []; // sfx voices {g, src, end, pri, grp, t0, own}
  const trash = []; // tonal-SFX output gains waiting to be disconnected {n, at}
  const lastT = Object.create(null), rr = Object.create(null);

  // ------------------------------------------------------------ graph
  const G = (v, dest) => { const g = ctx.createGain(); g.gain.value = v; if (dest) g.connect(dest); return g; };
  const BQ = (type, f, q, dest) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q || 0.707; if (dest) b.connect(dest); return b; };
  const PAN = (p, dest) => { let n; if (ctx.createStereoPanner) { n = ctx.createStereoPanner(); n.pan.value = p; } else n = ctx.createGain(); if (dest) n.connect(dest); return n; };
  function comp(th, knee, ratio, a, r, dest) {
    const c = ctx.createDynamicsCompressor();
    c.threshold.value = th; c.knee.value = knee; c.ratio.value = ratio; c.attack.value = a; c.release.value = r;
    if (dest) c.connect(dest); return c;
  }
  function shaper(curve, dest) { const w = ctx.createWaveShaper(); w.curve = curve; if (dest) w.connect(dest); return w; }
  function curveOf(fn, n) { const c = new Float32Array(n || 2048); for (let i = 0; i < c.length; i++) c[i] = fn(i / (c.length - 1) * 2 - 1); return c; }
  function makeIR() {
    const sr = ctx.sampleRate, dur = 1.25, n = Math.floor(sr * dur), b = ctx.createBuffer(2, n, sr);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c), R = rng(11 + c * 17), pre = 0.011 + c * 0.004; let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr; if (t < pre) { d[i] = 0; continue; }
        const k = 0.2 + 0.72 * (t / dur); lp += ((R() * 2 - 1) - lp) * (1 - k);
        d[i] = lp * Math.exp(-(t - pre) / 0.32) * Math.min(1, (t - pre) / 0.004);
      }
    }
    return b;
  }
  function build() {
    const dest = ctx.destination;
    out = G(enabled ? 1 : 0);
    const clip = shaper(curveOf((x) => { const a = Math.abs(x), y = a < 0.8 ? a : 0.8 + 0.18 * Math.tanh((a - 0.8) / 0.18); return x < 0 ? -y : y; }, 4096), out);
    const lim = comp(-6, 4, 12, 0.002, 0.12, clip);
    pauseLP = BQ('lowpass', 20000, 0.5, lim);
    master = G(0.95, pauseLP);
    if (opts.tap && dest.channelCount >= 4) { // debug: ch0/1 = final output, ch2/3 = pre-soft-clip (limiter out)
      dest.channelCountMode = 'explicit'; dest.channelInterpretation = 'discrete';
      const mg = ctx.createChannelMerger(4), s1 = ctx.createChannelSplitter(2), s2 = ctx.createChannelSplitter(2);
      out.connect(s1); s1.connect(mg, 0, 0); s1.connect(mg, 1, 1); lim.connect(s2); s2.connect(mg, 0, 2); s2.connect(mg, 1, 3); mg.connect(dest);
    } else out.connect(dest);
    sfxBus = G(vol.sfx, master);
    stingBus = G(0.5, master);
    musicOut = G(vol.music, master); duckG = G(1, musicOut); trimG = G(1, duckG); musicMix = G(1, trimG);
    fDry = BQ('lowpass', 20000, 0.5, musicMix); fWet = BQ('lowpass', 20000, 0.5, musicMix);
    const dryBus = G(1, fDry), wetBus = G(1, fWet);
    // reverb (shared by music, stingers, big SFX)
    const verb = ctx.createConvolver(); verb.buffer = makeIR(); verb.connect(G(0.6, master));
    verbIn = G(1, verb); fWet.connect(G(0.24, verbIn)); stingBus.connect(G(0.3, verbIn)); sfxVerb = G(0.2, verbIn);
    // ping-pong delay (lead / arp / counter)
    dlIn = G(1); d1 = ctx.createDelay(2); d2 = ctx.createDelay(2); dfb = G(0.3); const dlf = BQ('lowpass', 2600, 0.5);
    dlIn.connect(d1); d1.connect(dlf); dlf.connect(d2); d2.connect(dfb); dfb.connect(d1);
    d1.connect(G(0.3, PAN(-0.6, wetBus))); d2.connect(G(0.3, PAN(0.6, wetBus)));
    // deadzone filter LFO (permanent)
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07; lfoG = G(0); lfo.connect(lfoG); lfoG.connect(fDry.frequency); lfoG.connect(fWet.frequency); lfo.start();
    // stems
    const MIX = { kick: 0.52, snare: 0.5, hat: 0.34, perc: 0.36, bass: 0.34, arp: 0.32, lead: 0.44, pad: 0.34, counter: 0.32, top: 0.32 };
    const PANS = { hat: 0.22, arp: -0.25, counter: 0.3, perc: -0.15 };
    const SEND = { arp: 0.35, lead: 0.26, counter: 0.35 };
    for (const k of STEMS) {
      const g = G(MIX[k] * (opts.solo && !opts.solo.includes(k) ? 0 : 1), k === 'kick' || k === 'bass' ? dryBus : wetBus);
      stemG[k] = g; stemIn[k] = PANS[k] ? PAN(PANS[k], g) : g;
      if (SEND[k]) g.connect(G(SEND[k], dlIn));
    }
    bassDist = shaper(curveOf((x) => Math.tanh(2.5 * x) / Math.tanh(2.5)), stemIn.bass);
    leadLP = BQ('lowpass', 4200, 0.7, stemIn.lead);
    const crushPost = G(0.4, stemIn.arp); crushIn = G(2.5, shaper(curveOf((x) => Math.round(x * 8) / 8, 1024), crushPost));
    choirIn = G(1); [[700, 5, 0.9], [1150, 6, 0.6], [2600, 8, 0.25]].forEach(([f, q, a]) => choirIn.connect(BQ('bandpass', f, q, G(a * 2.2, stemIn.pad))));
    // SFX pan buses
    for (const p of [-0.6, -0.3, 0, 0.3, 0.6]) panB.push(PAN(p, sfxBus));
    // periodic waves
    const pulse = (w) => { const n = 32, re = new Float32Array(n), im = new Float32Array(n); for (let k = 1; k < n; k++) im[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * w); return ctx.createPeriodicWave(re, im); };
    PW.pulse25 = pulse(0.25); PW.pulse12 = pulse(0.125);
  }
  function init() {
    if (ready) return true;
    try {
      if (!ctx) {
        if (external) ctx = external;
        else if (AC) { try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { ctx = new AC(); } }
      }
    } catch (e) { ctx = null; }
    if (!ctx) return false;
    try { build(); ready = true; } catch (e) { ready = false; }
    return ready;
  }

  // ------------------------------------------------------------ buffers
  function buf(name, v) {
    v = v || 0; let arr = BANK[name]; if (!arr) arr = BANK[name] = [];
    if (arr[v]) return arr[v];
    const r = REC[name]; if (!r) return null;
    const sr = r.rate && r.rate < ctx.sampleRate ? r.rate : ctx.sampleRate, n = Math.max(1, Math.ceil(r.dur * sr)), d = new Float32Array(n);
    r.fn(d, sr, rng(hash(name) + v * 101), v);
    let x1 = 0, y1 = 0, pk = 0; const k = 1 - TAU * 10 / sr;
    for (let i = 0; i < n; i++) { const x = d[i] === d[i] ? d[i] : 0, y = x - x1 + k * y1; x1 = x; y1 = y; d[i] = y; const a = y < 0 ? -y : y; if (a > pk) pk = a; }
    const nf = Math.min(n, Math.floor(sr * 0.005)); for (let j = 0; j < nf; j++) d[n - 1 - j] *= j / nf;
    const s = pk > 1e-9 ? r.norm / pk : 0; for (let i = 0; i < n; i++) d[i] *= s;
    const b = ctx.createBuffer(1, n, sr); b.getChannelData(0).set(d);
    arr[v] = b; return b;
  }
  let warmBusy = false;
  function warmStep(budget) {
    const t0 = Date.now();
    while (warmI < WARM.length && Date.now() - t0 < budget) {
      const name = WARM[warmI++], S = SFX[name], r = S ? S.r : name, n = S ? S.n : 1;
      if (REC[r]) for (let v = 0; v < n; v++) buf(r, v);
    }
  }
  function warmTick() { // render the procedural bank in the background (idle callbacks when the browser has them)
    if (warmI >= WARM.length || manual || warmBusy) return;
    if (typeof requestIdleCallback === 'function') {
      warmBusy = true;
      requestIdleCallback((dl) => { warmBusy = false; if (ready) warmStep(Math.max(2, Math.min(8, dl.timeRemaining() - 1))); }, { timeout: 400 });
    } else warmStep(3);
  }

  // ------------------------------------------------------------ live synth voices
  const gain0 = () => { const g = ctx.createGain(); g.gain.value = 0; return g; };
  const wobAt = (t) => Math.sin(t * 1.43) * 14 + Math.sin(t * 0.61 + 1) * 9;
  function osc(w, f, t, det) {
    const o = ctx.createOscillator();
    if (typeof w === 'string') o.type = w; else o.setPeriodicWave(w);
    o.frequency.setValueAtTime(f, t);
    let d = det || 0; if (seq.wob) d += wobAt(t) + (mr() - 0.5) * 12;
    if (d) o.detune.setValueAtTime(d, t);
    return o;
  }
  function envPluck(p, t, a, peak, dec) { p.setValueAtTime(0, t); p.linearRampToValueAtTime(peak, t + a); p.exponentialRampToValueAtTime(1e-4, t + a + dec); return t + a + dec; }
  function envASR(p, t, a, peak, hold, rel, sus, dec) {
    p.setValueAtTime(0, t); p.linearRampToValueAtTime(peak, t + a);
    const tr = t + Math.max(a + 0.002, hold); let lvl = peak;
    if (sus < 1) { const td = Math.min(t + a + dec, tr); lvl = peak * Math.pow(sus, (td - t - a) / dec); p.exponentialRampToValueAtTime(Math.max(lvl, 1e-4), td); }
    p.setValueAtTime(Math.max(lvl, 1e-4), tr); p.exponentialRampToValueAtTime(1e-4, tr + rel);
    return tr + rel;
  }
  function fin(srcs, nodes, t, end, g, list) {
    for (const s of srcs) { s.start(t); s.stop(end + 0.02); }
    const n = nodes.length; dbg.nodes += n; if (dbg.nodes > dbg.maxNodes) dbg.maxNodes = dbg.nodes; dbg.notes++;
    srcs[srcs.length - 1].onended = () => { for (const x of nodes) { try { x.disconnect(); } catch (e) { /* already gone */ } } dbg.nodes -= n; };
    if (list) list.push({ g, end: end + 0.02 });
    return srcs[srcs.length - 1];
  }
  function vFilt(t, f, vel, dest, list, w, fc0, fc1, q, fdec, adec, det) {
    const o = osc(w, f, t, det), fl = BQ('lowpass', fc0, q), g = gain0();
    fl.frequency.setValueAtTime(fc0, t); fl.frequency.exponentialRampToValueAtTime(Math.max(fc1, 40), t + fdec);
    o.connect(fl); fl.connect(g); g.connect(dest);
    return fin([o], [o, fl, g], t, envPluck(g.gain, t, 0.003, vel, adec), g, list);
  }
  function vSimple(t, parts, vel, dest, list, a, dec) { // parts: [[wave, freq, amp]]
    const g = gain0(), srcs = [], nodes = [g];
    for (const [w, f, amp] of parts) { const o = osc(w, f, t); srcs.push(o); nodes.push(o); if (amp === 1) o.connect(g); else { const og = G(amp, g); nodes.push(og); o.connect(og); } }
    g.connect(dest);
    return fin(srcs, nodes, t, envPluck(g.gain, t, a, vel, dec), g, list);
  }
  function mNote(v, t, m, dur, vel, dest, list) {
    const f = mtof(m);
    switch (v) {
      case 'pluck': return vFilt(t, f, vel, dest, list, 'square', 900 + 4200 * vel, 320, 3, 0.16, dur * 0.8 + 0.1);
      case 'sawpluck': return vFilt(t, f, vel, dest, list, 'sawtooth', 700 + 3800 * vel, 260, 5, 0.12, dur * 0.8 + 0.08);
      case 'glitch': return vFilt(t, f, vel, crushIn, list, 'square', 6000, 1500, 1, 0.05, 0.07);
      case 'bpluck': {
        const a = osc('sawtooth', f, t), s = osc('sine', f, t), sg = G(0.35), fl = BQ('lowpass', 200, 5), g = gain0();
        fl.frequency.setValueAtTime(260 + 1900 * vel, t); fl.frequency.exponentialRampToValueAtTime(190, t + Math.max(0.06, dur * 0.9));
        a.connect(fl); s.connect(sg); sg.connect(fl); fl.connect(g); g.connect(dest);
        return fin([a, s], [a, s, sg, fl, g], t, envASR(g.gain, t, 0.004, vel * 0.8, dur, 0.05, 0.7, 0.1), g, list);
      }
      case 'sub': return vSimple(t, [['sine', f, 1], ['triangle', f * 2, 0.25]], vel * 0.9, dest, list, 0.006, dur + 0.1);
      case 'pizz': {
        const o = osc('triangle', f, t), fl = BQ('lowpass', 1800, 1), g = gain0();
        o.connect(fl); fl.connect(g); g.connect(dest);
        return fin([o], [o, fl, g], t, envPluck(g.gain, t, 0.002, vel, 0.16), g, list);
      }
      case 'dist': {
        const a = osc('sawtooth', f, t), b = osc('square', f, t, -10), fl = BQ('lowpass', 600, 3), g = gain0();
        fl.frequency.setValueAtTime(900 + 2400 * vel, t); fl.frequency.exponentialRampToValueAtTime(500, t + 0.15);
        a.connect(fl); b.connect(fl); fl.connect(g); g.connect(bassDist);
        return fin([a, b], [a, b, fl, g], t, envASR(g.gain, t, 0.003, vel * 0.5, dur, 0.04, 0.5, 0.12), g, list);
      }
      case 'reese': {
        const a = osc('sawtooth', f, t, -16), b = osc('sawtooth', f, t, 16), fl = BQ('lowpass', 500, 2), g = gain0();
        fl.frequency.setValueAtTime(420, t); fl.frequency.linearRampToValueAtTime(1100, t + dur);
        a.connect(fl); b.connect(fl); fl.connect(g); g.connect(dest);
        return fin([a, b], [a, b, fl, g], t, envASR(g.gain, t, 0.03, vel * 0.6, dur, 0.15, 1, 1), g, list);
      }
      case 'supersaw': {
        const g = gain0(), srcs = [-13, 0, 13].map((d) => osc('sawtooth', f, t, d));
        for (const o of srcs) o.connect(g); g.connect(dest === stemIn.lead ? leadLP : dest);
        return fin(srcs, [...srcs, g], t, envASR(g.gain, t, 0.012, vel * 0.42, dur, 0.12, 0.75, 0.15), g, list);
      }
      case 'sqlead': {
        const a = osc('square', f, t), b = osc('sawtooth', f * 2, t, 8), fl = BQ('lowpass', 4000, 1), g = gain0();
        a.connect(fl); b.connect(fl); fl.connect(g); g.connect(dest === stemIn.lead ? leadLP : dest);
        return fin([a, b], [a, b, fl, g], t, envASR(g.gain, t, 0.005, vel * 0.5, dur, 0.08, 0.8, 0.12), g, list);
      }
      case 'brass': {
        const a = osc('sawtooth', f, t, -7), b = osc('sawtooth', f, t, 7), fl = BQ('lowpass', 300, 2), g = gain0();
        const fp = fl.frequency; fp.setValueAtTime(260, t); fp.exponentialRampToValueAtTime(260 + 2600 * vel, t + 0.06); fp.exponentialRampToValueAtTime(400 + 1100 * vel, t + 0.35);
        a.connect(fl); b.connect(fl); fl.connect(g); g.connect(dest === stemIn.lead ? leadLP : dest);
        return fin([a, b], [a, b, fl, g], t, envASR(g.gain, t, 0.025, vel * 0.55, dur, 0.1, 0.8, 0.2), g, list);
      }
      case 'bell': {
        const car = osc('sine', f, t), mod = osc('sine', f * 3.5, t), mg = G(0), g = gain0();
        mg.gain.setValueAtTime(f * 2.2 * vel, t); mg.gain.exponentialRampToValueAtTime(f * 0.15, t + 0.5);
        mod.connect(mg); mg.connect(car.frequency); car.connect(g); g.connect(dest);
        return fin([mod, car], [mod, mg, car, g], t, envPluck(g.gain, t, 0.002, vel * 0.7, Math.max(dur, 0.6) + 0.3), g, list);
      }
      case 'musicbox': return vSimple(t, [['sine', f, 1], ['sine', f * 4, 0.18]], vel * 0.8, dest, list, 0.002, 0.55);
      case 'glass': return vSimple(t, [['triangle', f, 1], ['sine', f * 2, 0.5]], vel * 0.7, dest, list, 0.006, dur + 0.6);
      case 'marimba': return vSimple(t, [['sine', f, 1], ['sine', f * 3.93, 0.3]], vel, dest, list, 0.002, 0.28);
      case 'wood': return vSimple(t, [['sine', f, 1], ['triangle', f * 2.76, 0.4]], vel, dest, list, 0.001, 0.06);
      case 'ping': return vSimple(t, [['sine', f, 1]], vel, dest, list, 0.002, 0.4);
      case 'gem': return vSimple(t, [['triangle', f, 1], ['sine', f * 2, 0.35]], vel, dest, list, 0.002, 0.075);
      case 'ringtone': {
        const o = osc(PW.pulse25, f, t), fl = BQ('lowpass', 5200, 0.7), g = gain0();
        o.connect(fl); fl.connect(g); g.connect(dest === stemIn.lead ? leadLP : dest);
        return fin([o], [o, fl, g], t, envASR(g.gain, t, 0.002, vel * 0.5, dur * 0.85, 0.03, 0.7, 0.08), g, list);
      }
      case 'theremin': {
        const o = osc('sine', seq.lastLead || f, t), lf = osc('sine', 5.2, t), lg = G(f * 0.013), tri = osc('triangle', f * 2, t, 7), tg = G(0.12), g = gain0();
        o.frequency.exponentialRampToValueAtTime(f, t + 0.07); seq.lastLead = f;
        lf.connect(lg); lg.connect(o.frequency); o.connect(g); tri.connect(tg); tg.connect(g); g.connect(dest === stemIn.lead ? leadLP : dest);
        return fin([lf, tri, o], [o, lf, lg, tri, tg, g], t, envASR(g.gain, t, 0.05, vel * 0.8, dur, 0.18, 0.85, 0.3), g, list);
      }
      case 'siren': {
        const a = osc('sawtooth', seq.sirenF || f, t), b = osc('sawtooth', seq.sirenF || f, t, 9), fl = BQ('lowpass', 1600, 1.5), g = gain0();
        a.frequency.exponentialRampToValueAtTime(f, t + dur * 0.3); b.frequency.exponentialRampToValueAtTime(f, t + dur * 0.3); seq.sirenF = f;
        a.connect(fl); b.connect(fl); fl.connect(g); g.connect(dest);
        return fin([a, b], [a, b, fl, g], t, envASR(g.gain, t, 0.08, vel * 0.5, dur, 0.1, 1, 1), g, list);
      }
      case 'strings': {
        const a = osc('sawtooth', f, t, -9), b = osc('sawtooth', f, t, 9), fl = BQ('lowpass', 2400, 0.7), g = gain0();
        a.connect(fl); b.connect(fl); fl.connect(g); g.connect(dest);
        return fin([a, b], [a, b, fl, g], t, envASR(g.gain, t, 0.02, vel * 0.4, dur, 0.06, 1, 1), g, list);
      }
      default: return vSimple(t, [['triangle', f, 1]], vel, dest, list, 0.003, dur);
    }
  }
  function mChord(v, t, ms, dur, vel, dest, list) { // 'stab' / 'hit'
    const hit = v === 'hit', fl = BQ('lowpass', 4000, hit ? 1.5 : 3), g = gain0(), srcs = [];
    fl.frequency.setValueAtTime(hit ? 6500 : 4200, t); fl.frequency.exponentialRampToValueAtTime(hit ? 700 : 500, t + (hit ? 0.3 : 0.18));
    for (const m of ms) { const f = mtof(m); srcs.push(osc('sawtooth', f, t, -6)); if (hit) srcs.push(osc('sawtooth', f * 2, t, 6)); }
    for (const o of srcs) o.connect(fl); fl.connect(g); g.connect(dest);
    return fin(srcs, [...srcs, fl, g], t, envPluck(g.gain, t, 0.003, vel * (hit ? 0.5 : 0.55) / Math.sqrt(srcs.length), hit ? 0.42 : Math.max(0.2, dur)), g, list);
  }
  function mPad(v, t, ms, dur, vel, dest, list) {
    const g = gain0(), srcs = [], nodes = [g];
    let into = g;
    if (v === 'warm' || v === 'reesepad' || v === 'dark') {
      const fl = BQ('lowpass', 500, 0.8); nodes.push(fl); fl.connect(g); into = fl;
      const hi = v === 'warm' ? 2200 : v === 'dark' ? 900 : 1100;
      fl.frequency.setValueAtTime(hi * 0.3, t); fl.frequency.exponentialRampToValueAtTime(hi, t + dur * 0.45);
    }
    const spread = v === 'reesepad' ? 20 : v === 'choir' ? 6 : 9;
    for (const m of ms) {
      const f = mtof(m);
      const ws = v === 'glasspad' ? [['triangle', f, 0], ['sine', f * 2, 0]] : v === 'dark' ? [['triangle', f, 0], ['sawtooth', f, 6]] : [['sawtooth', f, -spread], ['sawtooth', f, spread]];
      for (const [w, fr, d] of ws) {
        const o = osc(w, fr, t, d); o.connect(into); srcs.push(o); nodes.push(o);
        if (seq.wob) o.detune.linearRampToValueAtTime(d + wobAt(t + dur), t + dur);
      }
    }
    g.connect(v === 'choir' ? choirIn : dest);
    const a = Math.min(0.6, dur * 0.25), peak = vel * 0.5 / Math.sqrt(srcs.length);
    return fin(srcs, nodes, t, envASR(g.gain, t, a, peak, dur, v === 'choir' ? 1.0 : 0.8, 1, 1), g, list);
  }
  function vSwell(t, ms, dur, vel, dest) {
    const fl = BQ('lowpass', 150, 2), g = gain0(), srcs = [];
    fl.frequency.setValueAtTime(150, t); fl.frequency.exponentialRampToValueAtTime(3500, t + dur);
    g.gain.setValueAtTime(1e-4, t); g.gain.exponentialRampToValueAtTime(vel, t + dur); g.gain.exponentialRampToValueAtTime(1e-4, t + dur + 0.15);
    for (const m of ms) { srcs.push(osc('sawtooth', mtof(m), t, -8)); srcs.push(osc('sawtooth', mtof(m), t, 8)); }
    for (const o of srcs) o.connect(fl); fl.connect(g); g.connect(dest);
    return fin(srcs, [...srcs, fl, g], t, t + dur + 0.15, g, null);
  }
  function mHit(snd, t, vel, dest, rate, list) {
    const b = buf(snd); if (!b) return;
    const s = ctx.createBufferSource(), g = ctx.createGain();
    s.buffer = b; if (rate && rate !== 1) s.playbackRate.value = rate; g.gain.value = vel;
    s.connect(g); g.connect(dest); s.start(t);
    dbg.nodes += 2; if (dbg.nodes > dbg.maxNodes) dbg.maxNodes = dbg.nodes;
    s.onended = () => { try { s.disconnect(); g.disconnect(); } catch (e) { /* gone */ } dbg.nodes -= 2; };
    if (list) list.push({ g, end: t + b.duration / (rate || 1) });
    if (DEBUG && dest === stemIn.kick) dbg.kicks.push(t);
  }

  // ------------------------------------------------------------ sequencer
  function energy() {
    const m = seq.mood;
    if (m === 'title') { const b = seq.bar; if (b < 16) return Math.min(0.92, 0.18 + b * 0.055); return (b - 16) % 32 < 24 ? 0.92 : 0.28; } // build, then breathe: 24 bars full / 8 bars breakdown
    if (m === 'sunrise') return Math.min(0.72, 0.3 + seq.bar * 0.05);
    if (m === 'aftermath') return 0.4;
    let P = st.progressExt;
    if (P == null) P = (m === 'boss' || m === 'boss2') ? Math.max(st.bossP, Math.min(0.3, st.hourT / 90)) : clamp(st.hourT / Math.max(10, st.hourDur), 0, 1);
    let E = 0.08 + 0.72 * st.I + 0.42 * P + (st.bossFlag ? 0.08 : 0);
    if (st.od) E = 1;
    return clamp(E, 0, 1);
  }
  function rampTo(p, v, t, tau) { try { p.cancelScheduledValues(t); p.setTargetAtTime(v, t, tau); } catch (e) { /* ignore */ } }
  function switchMood(m, t) {
    const D = MOODS[m]; if (!D) return;
    const from = seq.def;
    if (!from) killMusic(t, 0.02);
    seq.def = D; seq.mood = m; seq.bar = 0; seq.restart = false;
    seq.keyAdd = 0; seq.bpmAdd = 0; phaseAdjust();
    seq.bpm = D.bpm + seq.bpmAdd; seq.key = (m === 'aftermath' ? st.afterKey : D.key) + seq.keyAdd; seq.mode = MODES[D.mode];
    seq.wob = !!D.wobble; seq.lastLead = 0; seq.sirenF = 0;
    const lp = D.lp || 20000;
    rampTo(fDry.frequency, lp, t, from ? 0.5 : 0.01); rampTo(fWet.frequency, lp, t, from ? 0.5 : 0.01);
    rampTo(lfoG.gain, D.lfo || 0, t, 0.5); rampTo(leadLP.frequency, D.leadLP || 4200, t, 0.05);
    const dt = 3 * 60 / seq.bpm / 4; d1.delayTime.setValueAtTime(dt, t); d2.delayTime.setValueAtTime(dt, t);
    rampTo(musicOut.gain, vol.music * (st.paused ? 0.5 : 1), t, 0.02); rampTo(musicMix.gain, 1, t, 0.01); rampTo(trimG.gain, D.trim || 1, t, from ? 0.08 : 0.005);
    seq.act = {}; seq.since = {};
    const E = energy(), cap = Math.min(E, 0.35); seq.E = E;
    for (const [k, th] of D.stems) if (th <= cap) { seq.act[k] = true; seq.since[k] = 0; }
    if (from && m !== 'title') mHit('crash', t, 0.4, stemIn.top, 1, mv);
  }
  function phaseAdjust() {
    const D = seq.def; if (!D) return;
    const ph = clamp(st.bossPhase | 0, 1, 3) - 1;
    seq.bpmAdd = D.phaseBpm ? D.phaseBpm[ph] : 0; seq.keyAdd = D.phaseKey ? D.phaseKey[ph] : 0;
  }
  function downbeat(t) {
    if (seq.pend || seq.restart) {
      const m = seq.pend || seq.target || seq.mood;
      seq.pend = null;
      if (m && (m !== seq.mood || seq.restart || !seq.def)) switchMood(m, t); else seq.restart = false;
    }
    const D = seq.def; if (!D) return;
    if (seq.bar > 0) { // boss phase key/tempo shifts land here
      const pk = seq.keyAdd, pb = seq.bpmAdd; phaseAdjust();
      if (pk !== seq.keyAdd || pb !== seq.bpmAdd) { seq.key = D.key + seq.keyAdd; seq.bpm = D.bpm + seq.bpmAdd; mHit('crash', t, 0.5, stemIn.top, 1, mv); }
    }
    const pc = D.prog[seq.bar % D.prog.length], r = pc[0];
    seq.croot = seq.key + (r > 6 ? r - 12 : r); seq.chord = CHORDS[pc[1]] || CHORDS.m;
    seq.tones = expand(seq.chord);
    if (seq.bar > 0) {
      const E = energy(); seq.E = E; let adds = 0, drops = 0;
      for (const [k, th] of D.stems) {
        if (!seq.act[k] && E >= th && adds < 2) { seq.act[k] = true; seq.since[k] = seq.bar; adds++; }
        else if (seq.act[k] && th > 0 && E < th - 0.1 && seq.bar - seq.since[k] >= 2 && drops < 1) { seq.act[k] = false; drops++; }
      }
      if (st.od && D.stems.some((s) => s[0] === 'top')) seq.act.top = true;
    }
    if (seq.jingle) { seq.jingle = false; jingleHour(t); }
    if (DEBUG) dbg.bars.push({ t, bar: seq.bar, mood: seq.mood, bpm: seq.bpm, E: +seq.E.toFixed(3), stems: STEMS.filter((k) => seq.act[k]) });
  }
  function lanes(L, dest, s, bar, t) {
    if (!L) return;
    for (const [pat, snd, v] of L) { const ch = pat[(bar * 16 + s) % pat.length]; if (ch !== '.') mHit(snd, t, (v || 1) * (VEL[ch] || 0.72), dest, 1, mv); }
  }
  function voiced(lo, hi) { const out = []; for (const iv of seq.chord) { let m = seq.croot + iv; while (m < lo) m += 12; while (m > hi) m -= 12; if (!out.includes(m)) out.push(m); } return out.sort((a, b) => a - b); }
  function motifNote(ms) { const n = MOTIF_AT[((ms % 64) + 64) % 64]; return n; }
  function step(s, t) {
    if (s === 0) downbeat(t);
    const D = seq.def; if (!D) return;
    const spb = 60 / seq.bpm / 4, bar = seq.bar, A = seq.act;
    const tt = (s & 1) ? t + (D.swing || 0) * spb : t;
    const fillNow = s >= 12 && D.fill && A.snare && ((seq.pend && seq.pend !== seq.mood) || (bar % 4 === 3 && seq.E > 0.45));
    if (A.kick) lanes(D.kick, stemIn.kick, s, bar, tt);
    if (A.hat) lanes(D.hat, stemIn.hat, s, bar, tt);
    if (fillNow) {
      const c = D.fill[s - 12], F = FILL[c];
      if (F) { mHit(F[0], tt, F[1], stemIn.snare, 1, mv); if (c === 'r' || c === 'R') mHit(F[0], tt + spb / 2, F[1] * 0.8, stemIn.snare, 1, mv); }
    } else {
      if (A.snare) lanes(D.snare, stemIn.snare, s, bar, tt);
      if (A.perc) lanes(D.perc, stemIn.perc, s, bar, tt);
    }
    if (A.top && D.top) {
      lanes(D.top.lanes, stemIn.top, s, bar, tt);
      if (D.top.revcym && bar % 4 === 3 && s === 3) mHit('revCym', t + 13 * spb - buf('revCym').duration, 0.35, stemIn.top, 1, mv);
      if (D.top.tritone && bar % 4 === 3 && (s === 8 || s === 10 || s === 12)) mNote('ringtone', tt, seq.key + 24 + [0, 4, 7][(s - 8) / 2], spb * 1.6, 0.4, stemIn.top, mv);
    }
    if (s === 0 && bar > 0 && bar % 4 === 0 && (A.top || seq.E > 0.6)) mHit('crash', t, 0.4, stemIn.top, 1, mv);
    // bass
    if (A.bass && D.bass) {
      const P = D.bass.pat, c = P[s % P.length];
      if (c !== '.' && c !== '_') {
        let len = 1; while (len < 16 && P[(s + len) % P.length] === '_') len++;
        const lc = c.toLowerCase(), ch = seq.chord;
        const iv = lc === 'o' ? 12 : lc === 'f' ? (ch[2] != null ? ch[2] : 7) : lc === 't' ? ch[1] : lc === 's' ? (ch[3] != null && ch[3] < 12 ? ch[3] : 10) : 0;
        mNote(D.bass.voice, tt, seq.croot + D.bass.oct + iv, len * spb * 0.92, (c === lc ? 0.8 : 1) * (D.bass.vel || 0.85), stemIn.bass, mv);
      }
    }
    // arp
    if (A.arp && D.arp) {
      const c = D.arp.pat[s % D.arp.pat.length];
      if (c >= '0' && c <= '9') mNote(D.arp.voice, tt, seq.croot + D.arp.oct + seq.tones[+c], (D.arp.len || 1) * spb * 0.9, (s % 4 === 0 ? 1 : 0.8) * (D.arp.vel || 0.5), stemIn.arp, mv);
    }
    // lead — the theme
    if (A.lead && D.lead) {
      const L = D.lead, aug = L.aug || 1, gs = (bar % (4 * aug)) * 16 + s;
      if (gs % aug === 0) {
        const ms = gs / aug, n = MOTIF_AT[ms];
        const cyc = Math.floor(bar / (4 * aug));
        if (n && !(L.frag && !L.frag.includes(Math.floor(ms / 16))) && !(L.every && cyc % L.every)) {
          const m = seq.key + (L.oct || 0) + degSemi(seq.mode, n[0]), dur = n[1] * aug * spb * (L.gate || 0.92), v = L.vel || 0.8;
          if (L.stut && L.stut.includes(ms % 16)) { for (let k = 0; k < 3; k++) mNote(L.voice, tt + k * spb / 2, m + (k === 2 ? 12 : 0), spb * 0.45, v * (1 - 0.15 * k), stemIn.lead, mv); }
          else mNote(L.voice, tt, m, dur, v, stemIn.lead, mv);
          if (DEBUG && dbg.lead.length < 400) dbg.lead.push([+tt.toFixed(3), m, seq.mood]);
          if (A.top && D.top && D.top.double) mNote(D.top.dvoice || L.voice, tt, m + 12, dur, v * 0.45, stemIn.top, mv);
        }
      }
    }
    // pad
    if (A.pad && D.pad && s === 0) mPad(D.pad.voice, t, voiced(seq.key - 3 + (D.pad.oct || 0), seq.key + 11 + (D.pad.oct || 0)), 16 * spb * 0.98, D.pad.vel || 0.5, stemIn.pad, mv);
    // counter
    if (A.counter && D.counter) counterStep(D, D.counter, s, bar, t, tt, spb);
  }
  function counterStep(D, C, s, bar, t, tt, spb) {
    const dest = stemIn.counter;
    switch (C.type) {
      case 'stabs': { const c = C.pat[s % C.pat.length]; if (c !== '.') mChord('stab', tt, voiced(seq.key + (C.oct || 0), seq.key + 12 + (C.oct || 0)), spb * 1.5, (VEL[c] || 0.72) * C.vel, dest, mv); break; }
      case 'echo': {
        const aug = (D.lead && D.lead.aug) || 1, gs = (bar % (4 * aug)) * 16 + s;
        if (gs % aug) break;
        const ms = gs / aug - C.delay, n = motifNote(ms);
        if (n && !(ms < 0 && bar < 4 * aug)) mNote(C.voice, tt, seq.key + C.oct + degSemi(seq.mode, n[0]), n[1] * aug * spb, C.vel, dest, mv);
        break;
      }
      case 'arp2': { const c = C.pat[s % C.pat.length]; if (c >= '0' && c <= '9') mNote(C.voice, tt, seq.croot + C.oct + seq.tones[+c], spb * 2, C.vel, dest, mv); break; }
      case 'siren': if (s === 0 || s === 8) mNote('siren', t, seq.croot + 24 + (s === 0 ? 0 : 1), 8 * spb, C.vel, dest, mv); break;
      case 'ring': { if (!C.bars.includes(bar % 4)) break; const c = C.pat[s]; if (c >= '0' && c <= '9') mNote('ringtone', tt, seq.croot + C.oct + seq.tones[+c], spb * 0.9, C.vel, dest, mv); break; }
      case 'trem': mNote('strings', tt, seq.croot + 12 + seq.chord[1 + (s & 1)], spb * 0.9, C.vel * (s % 4 === 0 ? 1 : 0.7), dest, mv); break;
      case 'hits': { const c = C.pat[s % C.pat.length]; if (c !== '.') { mChord('hit', tt, voiced(seq.key - 5, seq.key + 9), spb * 2, (VEL[c] || 0.72) * C.vel, dest, mv); mHit('crash', tt, 0.12, dest, 1.3, mv); } break; }
      case 'static': {
        const h = hash('z' + (bar * 16 + s)) % 29;
        if (h % 5 === 0) mHit('static', tt, C.vel, dest, 0.8 + (h % 3) * 0.2, mv);
        if (seq.E > 0.84 && h === 7) { const p = musicMix.gain; p.setValueAtTime(0.12, tt); p.setValueAtTime(1, tt + spb * 0.9); }
        break;
      }
      default: break;
    }
  }
  function killMusic(now, fade) {
    for (const v of mv) {
      if (v.end <= now) continue;
      const p = v.g.gain;
      try {
        if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(now); else { const cur = p.value; p.cancelScheduledValues(now); p.setValueAtTime(cur, now); }
        p.setTargetAtTime(0, now, Math.max(0.005, fade / 4));
      } catch (e) { /* ignore */ }
    }
    mv.length = 0;
  }
  function pump() {
    if (!ready) return;
    if (!manual && (!enabled || ctx.state !== 'running')) return;
    const now = ctx.currentTime;
    if (lastPump >= 0) { const gap = now - lastPump; look = gap > 0.06 ? Math.min(LOOK_MAX, Math.max(look, gap * 1.6 + 0.05)) : Math.max(LOOK, look - (now - lastPump) * 0.04); }
    lastPump = now;
    // smooth intensity (fast attack, slow release)
    const dtc = Math.min(0.5, Math.max(0, now - st.lastT)); st.lastT = now;
    const tau = st.intensity > st.I ? 0.6 : 3.5; st.I += (st.intensity - st.I) * (1 - Math.exp(-dtc / tau));
    if (st.lastUpd < 0 || now - st.lastUpd > 1) st.hourT += dtc; // update() not being called: keep the hour clock on audio time
    // prune voice lists
    if (mv.length > 64) { let k = 0; for (const v of mv) if (v.end > now) mv[k++] = v; mv.length = k; }
    if (sv.length || trash.length) prune(now);
    if (!seq.def) {
      if (!seq.pend && !seq.restart) { seq.next = now; warmTick(); return; }
      if (seq.next < now + 0.02 || seq.next > Math.max(now, seq.holdUntil) + 0.5) { seq.next = Math.max(now + 0.06, seq.holdUntil); seq.step = 0; }
    } else if (seq.next < now + 0.004) { seq.next = now + 0.03; } // fell behind (tab throttled): skip, never play late bursts
    let guard = 0;
    while (seq.next < now + look && guard++ < 64) {
      const t = seq.next;
      if (t - now < dbg.minMargin) dbg.minMargin = t - now;
      step(seq.step, t);
      seq.next += 60 / seq.bpm / 4;
      if (++seq.step >= 16) { seq.step = 0; seq.bar++; }
    }
    warmTick(); // after scheduling, never before
  }
  function requestMood(m) {
    seq.target = m;
    if (m !== seq.mood || !seq.def) seq.pend = m; else seq.pend = null;
  }
  function hold(dur, after) {
    const now = ctx.currentTime;
    killMusic(now, 0.08);
    seq.holdUntil = now + dur; seq.next = now + dur; seq.step = 0; seq.pend = after; seq.restart = true; seq.jingle = false;
  }

  // ------------------------------------------------------------ stingers (on the music clock, own bus)
  const stN = (v, t, m, dur, vel) => mNote(v, t, m, dur, vel, stingBus, null);
  const stH = (s, t, vel, rate) => mHit(s, t, vel, stingBus, rate || 1, null);
  function jingleHour(t) { // the hour chime = the theme's head, on bells, in the new key & tempo
    const spb = 60 / seq.bpm / 4, k = seq.key, M = seq.mode;
    stH('impact', t, 0.45); stH('crash', t, 0.35);
    for (const [s, dg, l] of [[0, 7, 2], [2, 4, 2], [4, 6, 2], [6, 7, 8]]) { stN('bell', t + s * spb, k + 12 + degSemi(M, dg), l * spb, 0.42); stN('glass', t + s * spb, k + degSemi(M, dg), l * spb, 0.18); }
    stN('bell', t, k - 12, 16 * spb, 0.3);
  }
  function stBossIntro(t, D) { // 2.4 s: boom, dissonant brass swell + accelerating roll, huge hit
    const k = D.key;
    stH('impact', t, 1);
    vSwell(t, [k - 12, k - 11, k - 5, k], 2.25, 0.34, stingBus);
    let tt = t + 1.0, dt = 0.11; while (tt < t + 2.22) { stH('snare', tt, 0.18 + 0.6 * (tt - t - 1) / 1.2); tt += dt; dt = Math.max(0.035, dt * 0.88); }
    stH('revCym', t + 2.3 - 1.7, 0.5);
    stH('impact', t + 2.3, 0.8); stH('crash', t + 2.3, 0.7); stH('kickHeavy', t + 2.3, 0.8);
    mChord('hit', t + 2.3, [k - 12, k - 5, k, k + 1], 0.5, 1.0, stingBus, null);
  }
  function stFanfare(t, k) { // boss defeated: "da-da-da DAAA" (the theme's tresillo) in major, IV–V–I
    const spb = 60 / 132 / 4, mel = [[0, 7, 3], [3, 7, 3], [6, 7, 2], [8, 12, 4], [12, 9, 2], [14, 11, 2], [16, 12, 12]];
    for (const [s, iv, l] of mel) { stN('brass', t + s * spb, k + iv, l * spb * 0.95, 0.8); stN('supersaw', t + s * spb, k + 12 + iv, l * spb * 0.95, 0.3); }
    for (const [s, ch, l] of [[0, [0, 4, 7], 12], [12, [5, 9, 12], 2], [14, [7, 11, 14], 2], [16, [0, 4, 7, 12], 14]]) mPad('warm', t + s * spb, ch.map((x) => k - 12 + x), l * spb, 0.7, stingBus, null);
    for (const s of [0, 3, 6, 8, 16]) stH('tomL', t + s * spb, 0.9, 0.8);
    stH('crash', t + 8 * spb, 0.5); stH('crash', t + 16 * spb, 0.6); stH('impact', t + 16 * spb, 0.45);
    [0, 4, 7, 12, 16, 19, 24].forEach((iv, i) => stN('bell', t + (16 + i) * spb, k + 12 + iv, 6 * spb, 0.35));
    stN('sub', t + 16 * spb, k - 24, 12 * spb, 0.6);
  }
  function stVictory(t) { // SUNRISE: roll + reverse cymbal into the theme in A major, IV–V–I, bells, crash
    const k = 57, spb = 60 / 112 / 4, t0 = t + 0.9;
    stH('revCym', t0 - 1.7, 0.6);
    let tt = t, dt = 0.12; while (tt < t0 - 0.02) { stH('snare', tt, 0.12 + 0.5 * (tt - t) / 0.9); tt += dt; dt = Math.max(0.04, dt * 0.85); }
    const mel = [[0, 12, 3], [3, 7, 3], [6, 11, 2], [8, 12, 2], [10, 16, 2], [12, 14, 2], [14, 11, 2], [16, 16, 4], [20, 14, 4], [24, 12, 16]];
    for (const [s, iv, l] of mel) { stN('brass', t0 + s * spb, k + iv, l * spb * 0.95, 0.85); stN('supersaw', t0 + s * spb, k + 12 + iv, l * spb * 0.95, 0.3); }
    for (const [s, ch, l] of [[0, [0, 4, 7], 16], [16, [5, 9, 12], 4], [20, [7, 11, 14], 4], [24, [0, 4, 7, 12], 16]]) { mPad('warm', t0 + s * spb, ch.map((x) => k - 12 + x), l * spb, 0.75, stingBus, null); stN('sub', t0 + s * spb, k - 24 + ch[0], l * spb * 0.95, 0.55); }
    for (let s = 0; s < 24; s += 4) stH('kick', t0 + s * spb, 0.7);
    for (let s = 4; s < 24; s += 8) stH('snare', t0 + s * spb, 0.7);
    stH('impact', t0, 0.55); stH('crash', t0, 0.6); stH('impact', t0 + 24 * spb, 0.6); stH('crash', t0 + 24 * spb, 0.7);
    [0, 4, 7, 12, 16, 19, 24, 28].forEach((iv, i) => stN('bell', t0 + (24 + i) * spb, k + 12 + iv, 8 * spb, 0.32));
  }
  function stGameOver(t) { // power-down, then the theme's descent on a music box over a dark pad
    const k = 57;
    for (const f of [fDry, fWet]) { try { const p = f.frequency; p.cancelScheduledValues(t); p.setValueAtTime(Math.min(20000, p.value || 20000), t); p.exponentialRampToValueAtTime(160, t + 0.8); } catch (e) { /* ignore */ } }
    killMusic(t, 0.8);
    const t1 = t + 0.85;
    [7, 5, 3, 2].forEach((iv, i) => stN('musicbox', t1 + i * 0.3, k + 12 + iv, 0.3, 0.5));
    stN('musicbox', t1 + 1.2, k + 12, 1.6, 0.55);
    mPad('dark', t1, [k - 12, k - 9, k - 5, k + 2], 2.6, 0.8, stingBus, null);
    stN('bell', t1 + 1.2, k - 12, 2.0, 0.35);
  }

  // ------------------------------------------------------------ SFX
  function panBus(x) { if (x == null || x !== x) return panB[2]; return panB[Math.round((clamp((x - st.px) / 6.5, -1, 1) + 1) * 2)]; }
  function prune(now) {
    let k = 0;
    for (const v of sv) { if (v.end > now) sv[k++] = v; else if (v.own) trash.push({ n: v.own, at: v.end + 0.1 }); }
    sv.length = k;
    if (trash.length) { let j = 0; for (const x of trash) { if (x.at <= now) { try { x.n.disconnect(); } catch (e) { /* gone */ } } else trash[j++] = x; } trash.length = j; }
  }
  function stealV(v, now) {
    const p = v.g.gain;
    try { if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(now); else { const c = p.value; p.cancelScheduledValues(now); p.setValueAtTime(c, now); } p.setTargetAtTime(0, now, 0.01); } catch (e) { /* ignore */ }
    if (v.src) { try { v.src.stop(now + 0.06); } catch (e) { /* ignore */ } }
    v.end = now + 0.06; const i = sv.indexOf(v); if (i >= 0) sv.splice(i, 1);
    if (v.own) { trash.push({ n: v.own, at: now + 0.1 }); v.own = null; }
    dbg.sfxStolen++;
  }
  const MAXV = 26;
  function alloc(pri, grp, cap, now) {
    prune(now);
    if (cap) {
      let c = 0, old = null;
      for (const v of sv) if (v.grp === grp) { c++; if (!old || v.t0 < old.t0) old = v; }
      if (c >= cap) { if (old && old.pri <= pri) stealV(old, now); else return false; }
    }
    if (sv.length >= MAXV) {
      let vic = null;
      for (const v of sv) if (v.pri <= pri && (!vic || v.pri < vic.pri || (v.pri === vic.pri && v.t0 < vic.t0))) vic = v;
      if (!vic) return false; stealV(vic, now);
    }
    return true;
  }
  function play(name, o) {
    const S = SFX[name]; if (!S) return false;
    const now = ctx.currentTime, grp = S.grp || name;
    const lt = lastT[grp]; if (lt !== undefined && now - lt < S.gate && now >= lt) { dbg.sfxGated++; return false; }
    if (!alloc(S.pri, grp, S.cap, now)) { dbg.sfxDropped++; return false; }
    lastT[grp] = now;
    let v = 0; if (S.n > 1) { v = ((rr[name] || 0) + 1 + (sr_() < 0.3 ? 1 : 0)) % S.n; rr[name] = v; }
    const b = buf(S.r, v); if (!b) return false;
    const src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = b;
    const rate = ((o && o.rate) || 1) * (1 + (sr_() * 2 - 1) * (S.jit || 0));
    src.playbackRate.value = rate;
    // density-aware level: a pile of voices is mostly masking, so each one gets quieter (70-enemy chaos never slams the limiter)
    let gv = S.vol * (o && o.vol != null ? o.vol : 1) * (0.92 + sr_() * 0.08) * (S.pri >= 3 ? 1 : clamp(1.3 / Math.sqrt(1 + sv.length / 5), 0.42, 1));
    const x = o && o.x != null ? o.x : null;
    if (S.dist && x != null) { const dz = (o.z != null ? o.z : st.pz) - st.pz, dd = Math.sqrt((x - st.px) * (x - st.px) + dz * dz); gv *= clamp(1.12 - dd / 20, 0.5, 1); }
    g.gain.value = gv;
    src.connect(g); g.connect(panBus(x)); if (S.verb) g.connect(sfxVerb);
    src.start(now);
    dbg.nodes += 2; if (dbg.nodes > dbg.maxNodes) dbg.maxNodes = dbg.nodes;
    src.onended = () => { try { src.disconnect(); g.disconnect(); } catch (e) { /* gone */ } dbg.nodes -= 2; };
    sv.push({ g, src, end: now + b.duration / rate, pri: S.pri, grp, t0: now, own: null });
    if (sv.length > dbg.maxVoices) dbg.maxVoices = sv.length;
    dbg.sfxPlayed++;
    if (S.duck) duck(S.duck, Math.min(0.5, b.duration * 0.4));
    return true;
  }
  // live, in-key tonal SFX: returns an output gain registered as a voice, or null if gated/capped
  function tonal(name, pri, gate, cap, dur, x) {
    const now = ctx.currentTime, lt = lastT[name];
    if (lt !== undefined && now - lt < gate && now >= lt) { dbg.sfxGated++; return null; }
    if (!alloc(pri, name, cap, now)) { dbg.sfxDropped++; return null; }
    lastT[name] = now;
    const g = G(1, panBus(x));
    sv.push({ g, src: null, end: now + dur, pri, grp: name, t0: now, own: g });
    dbg.sfxPlayed++;
    return g;
  }
  let duckUntil = 0, duckLvl = 1;
  function duck(lvl, hold) {
    const now = ctx.currentTime;
    if (now < duckUntil && lvl >= duckLvl) return;
    duckLvl = lvl; duckUntil = now + hold;
    const p = duckG.gain;
    try { p.cancelScheduledValues(now); p.setTargetAtTime(lvl, now, 0.012); p.setTargetAtTime(1, now + hold, 0.18); } catch (e) { /* ignore */ }
  }
  function gemSfx(x) {
    const now = ctx.currentTime;
    st.streak = (st.lastGem >= 0 && now - st.lastGem < 0.45) ? Math.min(st.streak + 1, 14) : 0;
    const g = tonal('gem', 0, 0.025, 3, 0.14, x); if (!g) return;
    st.lastGem = now;
    mNote('gem', now, seq.key + 24 + degSemi(seq.mode, Math.min(st.streak, 12)), 0.07, 0.16 + Math.min(0.08, st.streak * 0.006), g, null);
  }
  function tierUpSfx() {
    const now = ctx.currentTime, g = tonal('tierUp', 2, 0.3, 1, 1.4); if (!g) return;
    const b = seq.croot + 12;
    for (let i = 0; i < 6; i++) mNote('sawpluck', now + i * 0.042, b + seq.tones[i], 0.08, 0.45, g, null);
    mNote('bell', now + 0.26, b + 24, 0.4, 0.4, g, null);
    play('tierRise');
  }
  function comboSfx(mult) {
    const now = ctx.currentTime, b = seq.croot + 12;
    if (mult >= 5) {
      const g = tonal('combo', 2, 0.2, 1, 1.3); if (!g) return;
      for (let i = 0; i < 8; i++) mNote('pluck', now + i * 0.028, seq.key + 12 + degSemi(seq.mode, i), 0.07, 0.3, g, null);
      for (const iv of [0, seq.chord[1], seq.chord[2], 12]) mNote('bell', now + 0.24, b + 12 + iv, 0.5, 0.2, g, null);
      play('sparkle');
    } else {
      const g = tonal('combo', 2, 0.1, 1, 0.5); if (!g) return;
      const i = clamp(mult - 1, 1, 4);
      mNote('pluck', now, b + seq.tones[i], 0.06, 0.34, g, null); mNote('pluck', now + 0.06, b + seq.tones[i + 1], 0.12, 0.4, g, null);
    }
  }
  function pickupSfx(fam, x) {
    const now = ctx.currentTime, g = tonal('pickup', 2, 0.08, 2, 1.2, x); if (!g) return;
    const b = seq.croot + 12, T = seq.tones;
    if (fam === 'wep') mChord('stab', now, [b, b + 7, b + 12], 0.25, 0.9, g, null);
    else if (fam === 'body') { [0, 1, 2, 3].forEach((i) => mNote('glass', now + i * 0.05, b + T[i], 0.2, 0.4, g, null)); mNote('sub', now, b - 12, 0.25, 0.4, g, null); }
    else if (fam === 'util') for (const iv of [0, 2, 7, 12]) mNote('bell', now, b + iv, 0.4, 0.26, g, null);
    else for (let i = 0; i < 6; i++) mNote('pluck', now + i * 0.03, b + T[i], 0.06, 0.34, g, null);
    play('pupGet', { x });
  }
  function healSfx() {
    const now = ctx.currentTime, g = tonal('heal', 2, 0.2, 1, 1.3); if (!g) return;
    const b = seq.croot + 12; [0, seq.chord[1], seq.chord[2], 12].forEach((iv, i) => mNote('glass', now + i * 0.07, b + iv, 0.25, 0.26, g, null));
    play('sparkle', { vol: 0.6 });
  }
  function bestSfx() {
    const now = ctx.currentTime, g = tonal('best', 3, 0.5, 1, 1.8); if (!g) return;
    const k = 69; PENTA.slice(0, 8).forEach((iv, i) => mNote('pluck', now + i * 0.045, k + iv, 0.08, 0.3, g, null));
    for (const iv of [12, 16, 19, 24]) mNote('bell', now + 0.4, k + iv, 0.8, 0.22, g, null);
    play('sparkle');
  }

  // ------------------------------------------------------------ lifecycle
  function startTimer() { if (!timer && !manual && typeof setInterval !== 'undefined') timer = setInterval(pump, 25); }
  function stopTimer() { if (timer) { clearInterval(timer); timer = 0; } }
  function resume() { if (ctx && !manual && ctx.state !== 'running' && ctx.state !== 'closed') { try { const p = ctx.resume(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ignore */ } } }
  function resync() { if (ready) seq.next = Math.max(seq.next, ctx.currentTime + 0.05); }
  function addListeners() {
    if (listeners || manual || typeof document === 'undefined') return; listeners = true;
    document.addEventListener('visibilitychange', () => {
      if (!ctx) return;
      if (document.hidden) { try { const p = ctx.suspend(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ignore */ } }
      else if (enabled && unlocked) { resume(); resync(); }
    });
    const kick = () => { if (enabled && unlocked && ctx && ctx.state !== 'running') { resume(); resync(); } };
    for (const e of ['pointerup', 'touchend', 'keydown']) window.addEventListener(e, kick, { capture: true, passive: true });
  }

  // ------------------------------------------------------------ public API
  function unlock() {
    if (!init()) return false;
    unlocked = true;
    if (!manual) {
      // opt-in: play through the iPhone ring/silent switch (Safari 16.4+ Audio Session API). Default respects it.
      if (opts.ignoreSilentSwitch && typeof navigator !== 'undefined' && navigator.audioSession) { try { navigator.audioSession.type = 'playback'; } catch (e) { /* ignore */ } }
      resume();
      try { const s = ctx.createBufferSource(); s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate); s.connect(ctx.destination); s.start(0); } catch (e) { /* ignore */ }
      addListeners(); startTimer(); resync();
      if (!enabled) { const tok = ++offTok; setTimeout(() => { if (!enabled && tok === offTok && ctx.state === 'running') { try { const p = ctx.suspend(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ignore */ } } }, 300); }
    }
    return true;
  }
  function setEnabled(on) {
    on = !!on; if (on === enabled) return; enabled = on;
    if (!ready) return;
    const now = ctx.currentTime;
    rampTo(out.gain, on ? 1 : 0, now, on ? 0.08 : 0.05);
    if (manual) return;
    const tok = ++offTok;
    if (on) { if (unlocked) { resume(); startTimer(); resync(); } }
    else setTimeout(() => { if (!enabled && tok === offTok && ctx.state === 'running') { try { const p = ctx.suspend(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ignore */ } } }, 400);
  }
  function setMood(mood, o) {
    if (o) {
      if (o.intensity != null) st.intensity = clamp(+o.intensity || 0, 0, 1);
      if (o.progress != null) st.progressExt = clamp(+o.progress || 0, 0, 1);
      st.bossFlag = !!o.boss;
    }
    if (!MOOD_OK[mood]) return;
    if (seq.lock === 'gameover') return;
    if (seq.lock === 'victory' && mood !== 'overtime' && mood !== 'title') return;
    if (seq.lock === 'aftermath' && mood === st.afterFrom) return;
    if (seq.lock === 'stopped' && mood === seq.stopMood) return;
    seq.lock = null;
    if (mood !== seq.target || !seq.def) requestMood(mood);
  }
  function title() { seq.lock = null; st.od = false; st.progressExt = null; requestMood('title'); }
  function stopMusic() {
    seq.lock = 'stopped'; seq.stopMood = seq.target || seq.mood; seq.pend = null; seq.target = null; seq.restart = false; seq.jingle = false;
    if (ready) killMusic(ctx.currentTime, 0.35);
    seq.def = null; seq.mood = null;
  }
  function sfx(name, o) {
    if (!ready || !enabled) return;
    if (name === 'best' || name === 'newBest') return bestSfx();
    if (name === 'pause') return play('uiBack');
    if (name === 'resume') return play('ui');
    if (name === 'tierUp') return tierUpSfx();
    if (name === 'gem') return gemSfx();
    if (name === 'heal') return healSfx();
    if (name === 'combo') return comboSfx((o && o.mult) || 2);
    play(name, o);
  }
  function event(ev) {
    if (!ev || !ev.type) return;
    const T = ev.type, on = ready && enabled;
    switch (T) { // ---- music/state events (tracked even while muted)
      case 'start': st.streak = 0; st.od = false; st.kills.length = 0; st.progressExt = null; st.bossPhase = 1; st.bossP = 0; st.dying = false; seq.lock = null; if (ev.x != null) { st.px = ev.x; st.pz = ev.z; } return;
      case 'hour': {
        const h = ev.hour | 0, H = HOURS[h], m = H ? H.mood : 'overtime';
        st.hour = h; st.hourT = 0; st.hourDur = (H && H.dur) || (m === 'overtime' ? 60 : 45); st.bossPhase = 1; st.bossP = 0; st.dying = false; st.progressExt = null;
        seq.lock = null; requestMood(m);
        if (!(H && H.boss) && !ev.boss) seq.jingle = true;
        return;
      }
      case 'bossIntro': {
        const m = ev.kind === 'boss_flagship' ? 'boss2' : 'boss';
        seq.lock = null; seq.target = m;
        if (on) { const now = ctx.currentTime; hold(2.4, m); stBossIntro(now + 0.02, MOODS[m]); duck(0.5, 0.3); }
        else seq.pend = m;
        return;
      }
      case 'bossPhase': st.bossPhase = ev.phase | 0; st.bossP = clamp((st.bossPhase - 1) / 2, 0, 1); if (on) play('bossPhase'); return;
      case 'bossDying':
        st.dying = true;
        if (on) { const now = ctx.currentTime; play('bossDying'); for (const f of [fDry, fWet]) { try { const p = f.frequency; p.cancelScheduledValues(now); p.setValueAtTime(Math.min(20000, p.value || 20000), now); p.exponentialRampToValueAtTime(650, now + 2.3); } catch (e) { /* ignore */ } } }
        return;
      case 'bossKill': {
        const bm = ev.kind === 'boss_flagship' ? 'boss2' : 'boss', k = MOODS[bm].key + 3;
        st.afterKey = k; st.afterFrom = bm; st.dying = false; seq.lock = 'aftermath';
        if (on) { const now = ctx.currentTime; play('bossKill', { x: ev.x }); hold(3.4, 'aftermath'); stFanfare(now + 0.45, k); seq.target = 'aftermath'; }
        else { seq.target = 'aftermath'; seq.pend = 'aftermath'; }
        return;
      }
      case 'victory':
        seq.lock = 'victory'; st.od = false;
        if (on) { const now = ctx.currentTime; hold(6.4, 'sunrise'); stVictory(now + 0.05); seq.target = 'sunrise'; } else { seq.target = 'sunrise'; seq.pend = 'sunrise'; }
        return;
      case 'gameover':
        seq.lock = 'gameover'; st.od = false;
        if (on) { const now = ctx.currentTime; play('tapeStop'); stGameOver(now); }
        seq.def = null; seq.mood = null; seq.pend = null; seq.target = null; seq.restart = false; seq.jingle = false;
        return;
      case 'overdrive': st.od = true; if (on) play('odStart'); return;
      case 'overdriveEnd': st.od = false; if (on) play('odEnd'); return;
      default: break;
    }
    if (!on) return;
    const x = ev.x;
    switch (T) { // ---- SFX
      case 'shot': {
        st.px = ev.x; st.pz = ev.z;
        const tr = ev.tier | 0; play(st.od ? 'shotOD' : 'shot' + (tr < 2 ? 0 : tr < 4 ? 1 : tr < 6 ? 2 : 3));
        break;
      }
      case 'hit': {
        if (ev.killed) break;
        const K = KIND_DIMS[ev.kind];
        if (K && K.boss) play('bossHit', { x });
        else if (ev.crit) play('crit', { x, z: ev.z }); else play('hit', { x, z: ev.z });
        break;
      }
      case 'kill': {
        const now = ctx.currentTime, K = KIND_DIMS[ev.kind], fam = K ? K.family : 'modem';
        const ks = st.kills; ks.push(now); while (ks.length && now - ks[0] > 0.14) ks.shift();
        if (ks.length >= 4) { if (play('multiKill', { x })) ks.length = 0; }
        if (ev.elite) play(fam === 'phone' ? 'killEliteP' : 'killEliteM', { x });
        else play(ev.kind === 'pod' ? 'killPod' : fam === 'phone' ? 'killPhone' : 'killModem', { x, z: ev.z });
        break;
      }
      case 'spawn': {
        const K = KIND_DIMS[ev.kind]; if (K && K.boss) break;
        play(ev.kind === 'pod' ? 'bootPod' : K && K.family === 'phone' ? 'bootPhone' : 'bootModem', { x, z: ev.z });
        if (ev.elite) play('sparkle', { x, vol: 0.5 });
        break;
      }
      case 'land': play(ev.kind === 'xb3' || ev.kind === 'fold' || ev.kind === 'xb10' ? 'landHeavy' : 'land', { x, z: ev.z }); break;
      case 'windup': {
        const K = KIND_DIMS[ev.kind];
        if (K && K.boss) play('windBoss', { x }); else play(WIND[ev.attack] || 'windWave', { x, z: ev.z });
        break;
      }
      case 'attack': {
        const K = KIND_DIMS[ev.kind];
        if (ev.attack === 'fold' && K && K.boss) play('atkFold', { x });
        else if (ev.attack === 'slam' || ((ev.attack === 'stomp') && K && K.boss)) play('atkSlam', { x });
        else if (ATK[ev.attack]) play(ATK[ev.attack], { x, z: ev.z });
        break;
      }
      case 'enemyShot': {
        const n = ESHOT[ev.shotType] || 'eOrb';
        if (n === 'eNotif') { st.notif = (st.notif + 1) % 5; play(n, { x, z: ev.z, rate: Math.pow(2, PENTA[st.notif] / 12) }); }
        else play(n, { x, z: ev.z });
        break;
      }
      case 'hazardWarn': play('warnBeep', { x }); break;
      case 'hazardLive': { const ht = hazType(ev); play(ht === 'shock' ? 'eRing' : ht === 'fold' ? 'atkFold' : ht === 'slam' ? 'atkSlam' : 'zap', { x, z: ev.z }); break; }
      case 'hurt': if (ev.x != null) { st.px = ev.x; st.pz = ev.z; } play('hurt'); break;
      case 'shieldBlock': play('shield'); break;
      case 'dash': if (ev.x != null) { st.px = ev.x; st.pz = ev.z; } play('dash'); break;
      case 'dashHit': play('dashHit', { x }); break;
      case 'pulse': if (ev.x != null) { st.px = ev.x; st.pz = ev.z; } play('pulse'); break;
      case 'gem': gemSfx(x); break;
      case 'pickupSpawn': play('pupSpawn', { x }); break;
      case 'pickup': { const fam = ev.fam || (ev.pup && PUP_FAM[ev.pup]); if (fam) pickupSfx(fam, x); else healSfx(); break; }
      case 'pickupExpire': play('pupGone', { x }); break;
      case 'heal': healSfx(); break;
      case 'tierUp': tierUpSfx(); break;
      case 'combo': comboSfx(ev.mult | 0); break;
      case 'comboBreak': play('comboBreak'); break;
      case 'newThreat': play('newThreat'); break;
      default: break;
    }
  }
  function update(dt) {
    if (dt > 0 && dt < 1) st.hourT += dt;
    if (ready) st.lastUpd = ctx.currentTime;
    pump();
  }
  function pause(on) {
    st.paused = !!on; if (!ready) return;
    const now = ctx.currentTime;
    rampTo(pauseLP.frequency, on ? 700 : 20000, now, 0.08);
    rampTo(musicOut.gain, on ? vol.music * 0.5 : vol.music, now, 0.08);
    rampTo(sfxBus.gain, on ? 0 : vol.sfx, now, 0.05);
  }
  function setVolume(o) {
    if (!o) return;
    if (o.music != null) vol.music = clamp(+o.music, 0, 1);
    if (o.sfx != null) vol.sfx = clamp(+o.sfx, 0, 1);
    if (!ready) return;
    const now = ctx.currentTime; rampTo(musicOut.gain, vol.music, now, 0.05); rampTo(sfxBus.gain, vol.sfx, now, 0.05);
  }
  function debug(light) {
    const base = { state: ctx ? ctx.state : 'none', t: ctx ? ctx.currentTime : 0, mood: seq.mood, target: seq.target, lock: seq.lock, bar: seq.bar, bpm: seq.bpm, key: seq.key,
      E: seq.E, I: st.I, stems: STEMS.filter((k) => seq.act[k]), nodes: dbg.nodes, maxNodes: dbg.maxNodes, sfxVoices: sv.length, musicVoices: mv.length,
      maxVoices: dbg.maxVoices, sfxPlayed: dbg.sfxPlayed, sfxGated: dbg.sfxGated, sfxDropped: dbg.sfxDropped, sfxStolen: dbg.sfxStolen, minMargin: dbg.minMargin, notes: dbg.notes,
      buffers: Object.keys(BANK).length };
    if (!light) { base.bars = dbg.bars.slice(); base.kicks = dbg.kicks.slice(); base.lead = dbg.lead.slice(); let by = 0; for (const k in BANK) for (const b of BANK[k]) if (b) by += b.length * 4; base.bankBytes = by; }
    return base;
  }
  if (manual) init();
  else if (AC && typeof window !== 'undefined' && opts.autoUnlock !== false) {
    // unlock on the first real user activation anywhere (touch pointerdown is NOT an activation in Chrome; pointerup/touchend are)
    const EV = ['pointerup', 'touchend', 'mousedown', 'keydown', 'click'];
    const off = () => { for (const e of EV) window.removeEventListener(e, auto, true); };
    const auto = () => { unlock(); if (ctx && ctx.state === 'running') off(); };
    for (const e of EV) window.addEventListener(e, auto, { capture: true, passive: true });
  }
  return {
    unlock, setEnabled, setMood, event, sfx, title, stopMusic, update, pause, setVolume, debug,
    get ctx() { return ctx; }, get ready() { return ready; }, get enabled() { return enabled; },
    sfxNames: Object.keys(SFX).concat(['best', 'tierUp', 'gem', 'heal', 'combo', 'pause', 'resume']),
    moods: Object.keys(MOOD_OK),
  };
}

// test hook (scratch/audio harness): the recipe table, for render-cost profiling
export const _audioInternals = { REC, SFX, MOODS };
