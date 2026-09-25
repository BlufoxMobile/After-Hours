// =====================================================================================
// AFTER HOURS 3D — ui.js (UI agent)
// DOM only (no three.js). Every screen, the HUD, the non-blocking card queue, off-screen
// threat arrows, and ALL player input (touch joystick + buttons, keyboard, gamepad).
// Styles live in ui.css (the integrator injects it as text). The WebGL canvas sits UNDER
// the root element passed to createUI(); see the report for z-index / pointer rules.
// =====================================================================================
import { HOURS, KIND_INFO, KIND_COLORS, WEAPONS, PICKUPS, PICKUP_FAMILIES, OUTFITS, DISTRICTS } from './layout.js';

// ---- input tuning (px are CSS px) ---------------------------------------------------
const BUF_MS = 260;               // a dash/pulse pressed during cooldown fires if it comes ready within this window
const STICK_R = 62;               // leash: the anchor is never further than this from the finger
const STICK_FULL = 0.8 * STICK_R; // full speed lands at 80% of the leash
const STICK_DEAD = 6;             // dead zone
const STICK_TRAIL = 0.6;          // reversal assist: backwards finger travel also drags the anchor forward
const SWIPE_DIST = 62, SWIPE_WIN = 130, SWIPE_LOCK = 340; // flick-to-dash (from the 2D game, owner-tuned)
const MAX_CARDS = 2;
const ARROW_POOL = 16;
const RING_C = 2 * Math.PI * 47;  // cooldown ring circumference (r=47 in a 100-unit viewBox)

const HOUR_COLORS = ['#7fe9ff', '#a98bff', '#ff5566', '#3ee8ff', '#ff5ad2', '#8dffb8', '#ff4fb8', '#ffbf5a'];
const MULT_COLORS = { 2: '#3ee8ff', 3: '#b08bff', 4: '#ff5ad2', 5: '#ffc93c' };
const SPARK_INFO = { name: 'CEILING SPARK', title: 'LIVE WIRE', tip: 'A glowing ring on the floor means a strike is coming. Step out of it.' };

// ---- small helpers ------------------------------------------------------------------
const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mmss = (sec) => { sec = Math.max(0, Math.floor(Number(sec) || 0)); return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); };
function buzz(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) { /* unsupported */ } }
function retrigger(el, cls) { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }
function withTimeout(p, ms) {
  if (p === undefined || p === null) return Promise.reject(new Error('unavailable'));
  if (typeof p.then !== 'function') return Promise.resolve(p); // a hook may answer synchronously
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout')), ms);
    p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
  });
}
function sanitizeLive(s) {
  return String(s || '').replace(/[^\p{L}\p{N} ._'\-]/gu, '').replace(/\s{2,}/g, ' ').replace(/^\s+/, '').slice(0, 14);
}
const sanitizeName = (s) => sanitizeLive(s).trim();
function hourBadge(hv) {
  if (typeof hv === 'string' && isNaN(Number(hv))) return { label: hv.toUpperCase().slice(0, 9), color: '#9fb0d8' };
  const i = Number(hv);
  if (!isFinite(i)) return { label: '—', color: '#8899bb' };
  if (i >= HOURS.length) return { label: 'SUNRISE', color: '#ffd35a' };
  const k = Math.max(0, i | 0);
  return { label: HOURS[k].clock, color: HOUR_COLORS[k] };
}

// ---- icons (inline SVG, currentColor) -------------------------------------------------
const svg = (body, sw = 2.2) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const I = {
  pause: svg('<path d="M8.5 5.5v13M15.5 5.5v13"/>', 3.2),
  play: svg('<path d="M7 4.9v14.2a1 1 0 0 0 1.5.86l11.9-7.1a1 1 0 0 0 0-1.72L8.5 4.04A1 1 0 0 0 7 4.9z" fill="currentColor" stroke="none"/>'),
  sndOn: svg('<path d="M3.8 9.4h3.4L12 5.5v13l-4.8-3.9H3.8z" fill="currentColor" stroke="none"/><path d="M15.4 9.1a4 4 0 0 1 0 5.8M18.2 6.5a7.7 7.7 0 0 1 0 11"/>'),
  sndOff: svg('<path d="M3.8 9.4h3.4L12 5.5v13l-4.8-3.9H3.8z" fill="currentColor" stroke="none"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>'),
  trophy: svg('<path d="M7.5 4h9v5.3a4.5 4.5 0 0 1-9 0z" fill="currentColor" fill-opacity=".28"/><path d="M7.5 6H4.3v1.3a3.3 3.3 0 0 0 3.6 3.2M16.5 6h3.2v1.3a3.3 3.3 0 0 1-3.6 3.2M12 13.8V17M8.5 20.3h7M9.6 17h4.8"/>'),
  shirt: svg('<path d="M8.7 3.8 12 5.6l3.3-1.8 5.3 3.1-2.1 4.2-2.3-1.1v10.2H7.8V10L5.5 11.1 3.4 6.9z" fill="currentColor" fill-opacity=".28"/><path d="M12 5.6V20"/>'),
  help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.4 9.4a2.7 2.7 0 1 1 3.9 2.4c-.8.4-1.3 1-1.3 1.9v.3M12 17.1h.01" stroke-width="2.5"/>'),
  back: svg('<path d="M15 5l-7 7 7 7"/>', 2.8),
  dash: svg('<path d="M4.5 6l6 6-6 6M12.5 6l6 6-6 6"/>', 3),
  pulse: svg('<circle cx="12" cy="12" r="3.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="7.4" stroke-dasharray="3.4 2.4"/><path d="M12 1.5v2.2M12 20.3v2.2M1.5 12h2.2M20.3 12h2.2"/>'),
  heart: svg('<path d="M12 20.4s-8-4.9-8-10.7a4.4 4.4 0 0 1 8-2.5 4.4 4.4 0 0 1 8 2.5c0 5.8-8 10.7-8 10.7z" fill="currentColor" stroke="none"/>'),
  bolt: svg('<path d="M13.6 2.4 4.8 13.6h6.3l-1 8 8.8-11.4h-6.4z" fill="currentColor" stroke="none"/>'),
  shield: svg('<path d="M12 2.7l7.7 3v5.7c0 4.6-3.3 8.4-7.7 9.9-4.4-1.5-7.7-5.3-7.7-9.9V5.7z" fill="currentColor" stroke="none"/>'),
  magnet: svg('<path d="M6.5 3.5v8a5.5 5.5 0 0 0 11 0v-8" stroke-width="4.4" stroke-linecap="butt"/><path d="M4.3 5.2h4.4M15.3 5.2h4.4" stroke="#fff" stroke-width="2.4" stroke-linecap="butt"/>'),
  lock: svg('<rect x="5" y="10.4" width="14" height="10.2" rx="2.4" fill="currentColor" stroke="none"/><path d="M8.3 10.4V8a3.7 3.7 0 0 1 7.4 0v2.4"/>', 2.4),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 2.8),
  retry: svg('<path d="M20 12a8 8 0 1 1-2.4-5.7M20 4.2v4.6h-4.6"/>', 2.6),
  home: svg('<path d="M4 11.2 12 4l8 7.2V20h-5.4v-5.6H9.4V20H4z" fill="currentColor" fill-opacity=".22"/>'),
  sun: svg('<circle cx="12" cy="12" r="4.2" fill="currentColor"/><path d="M12 2.4v2.3M12 19.3v2.3M2.4 12h2.3M19.3 12h2.3M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M5.2 18.8l1.6-1.6M17.2 6.8l1.6-1.6"/>'),
  clock: svg('<circle cx="12" cy="12" r="8.6"/><path d="M12 7.4V12l3 2"/>'),
  warn: svg('<path d="M12 3.4 2.6 19.6h18.8z" fill="currentColor" fill-opacity=".22"/><path d="M12 9.4v4.6M12 17h.01" stroke-width="2.6"/>'),
  offline: svg('<path d="M2.6 8.8a14 14 0 0 1 18.8 0M5.9 12.3a9 9 0 0 1 12.2 0M9.3 15.7a4.2 4.2 0 0 1 5.4 0M12 19.4h.01M3.4 3.4l17.2 17.2"/>'),
  target: svg('<circle cx="12" cy="12" r="7.4"/><circle cx="12" cy="12" r="2.1" fill="currentColor" stroke="none"/><path d="M12 1.8v3.8M12 18.4v3.8M1.8 12h3.8M18.4 12h3.8"/>'),
  move: svg('<path d="M12 3.5v17M3.5 12h17M12 3.5 9.3 6.2M12 3.5l2.7 2.7M12 20.5l-2.7-2.7M12 20.5l2.7-2.7M3.5 12l2.7-2.7M3.5 12l2.7 2.7M20.5 12l-2.7-2.7M20.5 12l-2.7 2.7"/>'),
  drop: svg('<circle cx="12" cy="12" r="4.3" fill="currentColor" stroke="none"/><path d="M12 3.3a8.7 8.7 0 1 1-8.1 5.6"/>'),
  star: svg('<path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z" fill="currentColor" stroke="none"/>'),
  mug: svg('<path d="M4.8 8.2h11v6.3a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z" fill="currentColor" fill-opacity=".28"/><path d="M15.8 10.2h1.6a2.5 2.5 0 0 1 0 5h-1.6M8.2 2.8c-.7.9.7 1.8 0 2.8M12.4 2.8c-.7.9.7 1.8 0 2.8"/>'),
  exit: svg('<path d="M13.5 4H6.2v16h7.3M10.5 12H21M17.6 8.4 21 12l-3.4 3.6"/>'),
};
// pickup glyphs (PICKUPS[].icon)
const PICON = {
  dmg: svg('<path d="M9 21h6V10.5a3 3 0 0 0-6 0z" fill="currentColor" stroke="none"/><path d="M8 21h8"/>'),
  rate: I.bolt, bolt: I.bolt,
  multi: svg('<path d="M12 20V5M12 20 5.5 7.5M12 20l6.5-12.5"/>'),
  pierce: svg('<path d="M3 12h16M14.5 7.5 19 12l-4.5 4.5M8 7v10"/>'),
  armor: I.shield, ward: I.shield, heal: I.heart, dash: I.dash, pulse: I.pulse,
  aura: svg('<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="8.2"/>'),
  gem: svg('<path d="M12 3.2l7 7.2L12 21 5 10.4z" fill="currentColor" fill-opacity=".3"/><path d="M5 10.4h14M9.4 3.8 12 10.4l2.6-6.6"/>'),
  mag: I.magnet,
};

// ---- art: outfit jacket + enemy silhouettes (fallback portraits) ---------------------
function jacketSVG(o) {
  const body = 'M22 9 32 13l10-4 11 5.5 7.5 22-7.8 3.2L49 28v27.5H15V28l-3.7 11.7-7.8-3.2 7.5-22z';
  return `<svg class="ah-jk" viewBox="0 0 64 64" aria-hidden="true">
<path d="${body}" fill="${o.jacket}" stroke="rgba(0,0,0,.4)" stroke-width="1"/>
<path d="M32 13l10-4 11 5.5 7.5 22-7.8 3.2L49 28v27.5H32z" fill="#000" opacity=".16"/>
<path d="M11 14.5 22 9l2.6 1.4-10.8 6.2z" fill="#fff" opacity=".22"/>
<path d="M25.3 10.3 32 13l6.7-2.7L32 27.5z" fill="${o.accent}"/>
<path d="M24.6 10 32 27.5 39.4 10" fill="none" stroke="${o.trim}" stroke-width="2.2" stroke-linejoin="round"/>
<path d="M32 27.5v24" stroke="${o.trim}" stroke-width="1.6"/>
<rect x="15" y="51" width="34" height="5.5" rx="1.8" fill="${o.trim}"/>
<path d="M3.5 36.5l7.8 3.2-1.2 3.1-7.8-3.2zM60.5 36.5l-7.8 3.2 1.2 3.1 7.8-3.2z" fill="${o.trim}"/>
<path d="M41.5 31l3.2 3.2-3.2 3.2-3.2-3.2z" fill="#3ee8ff"/>
</svg>`;
}
function portraitSVG(kind) {
  const c = KIND_COLORS[kind] || { body: '#2a2f45', trim: '#8891a8', glow: kind === 'spark' ? '#ffb547' : '#ff3b4d' };
  const g = c.glow, b = c.body, t = c.trim;
  const face = (cx, cy, w = 22, hgt = 14, s = 1) => {
    const e = 5.5 * s;
    return `<rect x="${cx - w / 2}" y="${cy - hgt / 2}" width="${w}" height="${hgt}" rx="3.2" fill="#06080f" stroke="${g}" stroke-opacity=".45" stroke-width="1"/>
<path d="M${cx - e - 3.6 * s} ${cy - 3.4 * s}l${6 * s} ${2.4 * s}M${cx + e + 3.6 * s} ${cy - 3.4 * s}l${-6 * s} ${2.4 * s}" stroke="${g}" stroke-width="${2.2 * s}" stroke-linecap="round"/>
<circle cx="${cx - e}" cy="${cy + 1.9 * s}" r="${2.3 * s}" fill="${g}"/><circle cx="${cx + e}" cy="${cy + 1.9 * s}" r="${2.3 * s}" fill="${g}"/>`;
  };
  const legs = (x1, x2, y) => `<rect x="${x1}" y="${y}" width="6" height="7" rx="2" fill="${t}"/><rect x="${x2}" y="${y}" width="6" height="7" rx="2" fill="${t}"/>`;
  const halo = `<circle cx="32" cy="34" r="27" fill="${g}" opacity=".13"/><circle cx="32" cy="34" r="17" fill="${g}" opacity=".12"/>`;
  let s = '';
  switch (kind) {
    case 'xb6': s = `${legs(21, 37, 48)}<rect x="15" y="19" width="34" height="31" rx="7" fill="${b}" stroke="${t}" stroke-opacity=".5"/><rect x="19" y="19" width="26" height="5" rx="2" fill="${t}"/>${face(32, 35)}`; break;
    case 'xb3': s = `${legs(22, 36, 50)}<rect x="20" y="7" width="24" height="45" rx="5" fill="${b}" stroke="${t}"/>${[11, 14, 17, 20].map((y) => `<path d="M24 ${y}h16" stroke="${t}" stroke-width="1.4"/>`).join('')}${face(32, 34, 20, 13)}`; break;
    case 'xb7': s = `${legs(22, 36, 49)}<rect x="19" y="8" width="26" height="44" rx="12" fill="${b}" stroke="${t}" stroke-opacity=".5"/>${[27, 32, 37].map((x) => `<circle cx="${x}" cy="14" r="1.3" fill="${t}"/>`).join('')}<circle cx="32" cy="46" r="1.8" fill="${g}"/>${face(32, 30, 20, 13)}`; break;
    case 'xb8': s = `${legs(23, 35, 50)}<rect x="21" y="5" width="22" height="47" rx="11" fill="${b}" stroke="${t}"/><circle cx="32" cy="10" r="2.2" fill="${g}"/>${face(32, 30, 18, 12, .9)}`; break;
    case 'xb10': s = `${legs(21, 37, 50)}<rect x="18" y="7" width="28" height="45" rx="6" fill="${b}" stroke="${t}" stroke-opacity=".7"/><rect x="22" y="12" width="20" height="3" rx="1.5" fill="${g}"/>${face(32, 32)}`; break;
    case 'pod': s = `<path d="M17 47a15 15 0 0 1 30 0v3H17z" fill="${b}" stroke="${t}"/><circle cx="32" cy="41" r="7" fill="${g}" opacity=".3"/><circle cx="32" cy="41" r="4" fill="${g}"/>`; break;
    case 'iphone': s = `<rect x="20" y="5" width="24" height="50" rx="6.5" fill="${b}" stroke="${t}" stroke-width="1.5"/><rect x="22.5" y="7.5" width="19" height="45" rx="4.5" fill="#06080f"/><rect x="28.5" y="10" width="7" height="2.6" rx="1.3" fill="#000" stroke="${t}" stroke-opacity=".4"/>${face(32, 27, 17, 12, .85)}<path d="M26.5 38q5.5-3.4 11 0" stroke="${g}" stroke-width="2" fill="none" stroke-linecap="round"/>`; break;
    case 'galaxy': s = `<rect x="20" y="4" width="24" height="52" rx="3" fill="${b}" stroke="${t}" stroke-width="1.5"/><rect x="22" y="6.5" width="20" height="47" rx="2" fill="#06080f"/><circle cx="32" cy="9.5" r="1.3" fill="${t}"/>${face(32, 27, 17, 12, .85)}<path d="M27 38h10" stroke="${g}" stroke-width="2" stroke-linecap="round"/>`; break;
    case 'fold': s = `<rect x="12" y="10" width="40" height="42" rx="4" fill="${b}" stroke="${t}" stroke-width="1.5"/><rect x="14.5" y="12.5" width="35" height="37" rx="2.5" fill="#06080f"/><path d="M32 10v42" stroke="${t}" stroke-width="1.4"/>${face(32, 25, 30, 12)}<path d="M17 40l3.5 3.5 3.5-3.5 3.5 3.5 3.5-3.5 3.5 3.5 3.5-3.5 3.5 3.5 3.5-3.5 3.5 3.5" stroke="${g}" stroke-width="1.8" fill="none" stroke-linejoin="round"/>`; break;
    case 'boss_gateway': s = `${[17, 25, 39, 47].map((x, i) => `<path d="M${x} 18V${i % 3 ? 5 : 8}" stroke="${t}" stroke-width="2.2"/><circle cx="${x}" cy="${i % 3 ? 5 : 8}" r="2" fill="${g}"/>`).join('')}<path d="M18 48l-6 10M26 50l-3 8M38 50l3 8M46 48l6 10" stroke="${t}" stroke-width="3" stroke-linecap="round"/><rect x="11" y="17" width="42" height="34" rx="7" fill="${b}" stroke="${t}"/><rect x="15" y="21" width="34" height="3" rx="1.5" fill="${g}"/>${face(32, 36, 28, 16, 1.2)}`; break;
    case 'boss_flagship': s = `<path d="M9 9l22 4v43L9 52z" fill="${b}" stroke="${t}" stroke-width="1.4"/><path d="M55 9l-22 4v43l22-4z" fill="${b}" stroke="${t}" stroke-width="1.4"/><path d="M12 13l17 3v36l-17-3zM52 13l-17 3v36l17-3z" fill="#06080f"/><path d="M14 23l9 3.5M50 23l-9 3.5" stroke="${g}" stroke-width="2.6" stroke-linecap="round"/><circle cx="20" cy="30" r="3" fill="${g}"/><circle cx="44" cy="30" r="3" fill="${g}"/><path d="M15 42q8 4 12 0M37 42q4 4 12 0" stroke="${g}" stroke-width="2" fill="none"/>`; break;
    case 'spark': s = `<path d="M35 6 17 35h12l-4 23 21-33H34z" fill="${g}" stroke="#fff" stroke-opacity=".6"/>`; break;
    case 'fox': s = `<path d="M14 12l8 14h20l8-14-6 22a12 12 0 0 1-24 0z" fill="#1f6bff"/><path d="M24 38a8 7 0 0 0 16 0z" fill="#fff"/><circle cx="26" cy="31" r="3" fill="#fff"/><circle cx="38" cy="31" r="3" fill="#fff"/>`; break;
    default: s = `<text x="32" y="42" text-anchor="middle" font-size="28" font-weight="900" fill="${g}">?</text>`;
  }
  return `<svg viewBox="0 0 64 64" aria-hidden="true">${halo}${s}</svg>`;
}

// ---- markup ---------------------------------------------------------------------------
const ringSVG = `<svg class="ah-ring" viewBox="0 0 100 100" aria-hidden="true"><circle class="bg" cx="50" cy="50" r="47"/><circle class="fg" cx="50" cy="50" r="47" stroke-dasharray="${RING_C.toFixed(1)}" stroke-dashoffset="0"/></svg>`;
const STREAKS = [
  { top: 16, rot: -14, dl: 0.2, dur: 7.5, c: '#3ee8ff', op: 0.75 },
  { top: 41, rot: -9, dl: 2.6, dur: 8.5, c: '#ff3ec8', op: 0.55 },
  { top: 58, rot: -16, dl: 4.4, dur: 7, c: '#7b3fe4', op: 0.7 },
  { top: 73, rot: -11, dl: 1.4, dur: 9, c: '#ffb547', op: 0.45 },
  { top: 29, rot: -18, dl: 5.8, dur: 8, c: '#3ee8ff', op: 0.5 },
];
const HOW = [
  { ico: I.move, c: '#3ee8ff', t: 'MOVE', p: '<em>Drag anywhere.</em> The stick pops up under your thumb and follows it.' },
  { ico: I.target, c: '#7ef0ff', t: 'AUTO-FIRE', p: 'Your blaster aims and fires itself. XP chips level your gun up.' },
  { ico: I.dash, c: '#b7ff5a', t: 'DASH', p: '<em>Flick</em>, tap a <em>second finger</em>, or hit DASH. Invincible &mdash; shred straight through them.' },
  { ico: I.pulse, c: '#c3a4ff', t: 'PULSE', p: 'A nova that blasts everything close and wipes incoming shots.' },
  { ico: I.drop, c: '#ffc24a', t: 'GRAB THE DROPS', p: 'Power orbs burn out in seconds. Go get them.', fams: true },
  { ico: I.sun, c: '#ffd35a', t: 'SURVIVE TO SUNRISE', p: '10 PM to 6 AM. Two bosses. No breaks.' },
];

function template() {
  const streaks = STREAKS.map((s) => `<i class="ah-streak" style="top:${s.top}%;--rot:${s.rot}deg;--sc:${s.c};--op:${s.op};animation-delay:${s.dl}s;animation-duration:${s.dur}s"></i>`).join('');
  const fams = Object.values(PICKUP_FAMILIES).map((f) => `<span style="--fc:${f.color}"><i></i>${esc(f.label)}</span>`).join('');
  const how = HOW.map((r) => `<div class="ah-howrow" style="--hc:${r.c}"><div class="ah-howico">${r.ico}</div><div><b>${r.t}</b><p>${r.p}</p>${r.fams ? `<div class="ah-fams">${fams}</div>` : ''}</div></div>`).join('');
  return `
<div class="ah-safe"></div>
<div class="ah-run">
  <div class="ah-vig ah-vig-od"></div><div class="ah-vig ah-vig-low"></div><div class="ah-vig ah-vig-hurt"></div>
  <div class="ah-zone"></div>
  <div class="ah-stick"><div class="ah-stick-base"></div><div class="ah-knob"></div><div class="ah-stick-hint">DRAG ANYWHERE<br>TO MOVE</div></div>
  <div class="ah-arrows"></div>
  <div class="ah-scrim"></div>
  <div class="ah-hud">
    <div class="ah-hl">
      <button class="ah-pz" tabindex="-1" aria-label="Pause">${I.pause}</button>
      <div class="ah-hp">${I.heart}<span class="ah-cells"></span></div>
      <div class="ah-od"><span class="ah-od-l">${I.bolt}</span><div class="ah-od-bar"><i class="ah-od-fill"></i></div></div>
      <div class="ah-wep"><b class="ah-wep-t">1</b><span class="ah-wep-n">SERVICE BOLT</span><span class="ah-wep-xp"><i></i></span></div>
      <div class="ah-popL"></div>
    </div>
    <div class="ah-hc">
      <div class="ah-clock"><b class="ah-num">10:00</b><span>PM</span></div>
      <div class="ah-hname">LIGHTS OUT</div>
      <div class="ah-hbar"><i></i></div>
    </div>
    <div class="ah-hr">
      <div class="ah-score ah-num">0</div>
      <div class="ah-cm"><div class="ah-combo"><b class="ah-num">0</b><small>COMBO</small></div><div class="ah-mult ah-num" data-m="1">×1</div></div>
      <div class="ah-buffs">
        <div class="ah-buff" data-b="rapid" style="--bc:#ffc24a">${I.bolt}<span class="ah-num">0</span><i></i></div>
        <div class="ah-buff" data-b="shield" style="--bc:#9ff3ff">${I.shield}<span class="ah-num">0</span><i></i></div>
        <div class="ah-buff" data-b="vac" style="--bc:#e0b8ff">${I.magnet}<span class="ah-num">0</span><i></i></div>
      </div>
      <div class="ah-popR"></div>
    </div>
  </div>
  <div class="ah-boss"><div class="ah-boss-top"><div class="ah-boss-n"></div><div class="ah-boss-ph">PHASE 1</div></div>
    <div class="ah-boss-bar"><i class="ah-boss-lag"></i><i class="ah-boss-fill"></i><i class="ah-boss-notch" style="left:33.33%"></i><i class="ah-boss-notch" style="left:66.66%"></i></div></div>
  <div class="ah-cards" aria-live="polite"></div>
  <div class="ah-banner" aria-live="assertive"><div class="ah-bn-stripe"></div><div class="ah-bn-warn">WARNING · BOSS INCOMING</div><div class="ah-bn-name"></div><div class="ah-bn-title"></div><div class="ah-bn-tip"></div><div class="ah-bn-stripe"></div></div>
  <div class="ah-btns">
    <button class="ah-act ah-act-pulse" tabindex="-1" aria-label="Pulse">${ringSVG}<span class="ah-ico">${I.pulse}</span><span class="ah-lab">PULSE</span><span class="ah-cdn ah-num"></span></button>
    <button class="ah-act ah-act-dash" tabindex="-1" aria-label="Dash">${ringSVG}<span class="ah-ico">${I.dash}</span><span class="ah-lab">DASH</span><span class="ah-cdn ah-num"></span></button>
  </div>
  <div class="ah-keys"><span><kbd>WASD</kbd>MOVE</span><span><kbd>SPACE</kbd>DASH</span><span><kbd>E</kbd>PULSE</span><span><kbd>P</kbd>PAUSE</span></div>
</div>

<section class="ah-scr ah-boot" aria-label="Loading">
  <div class="ah-boot-in"><div class="ah-c3">C<sup>3</sup></div><div class="ah-boot-logo">AFTER HOURS</div><div class="ah-boot-bar"><i></i></div><small>POWERING ON THE STORE…</small></div>
</section>

<section class="ah-scr ah-title" aria-label="Title">
  <div class="ah-title-art"></div><div class="ah-title-bg"></div>
  <div class="ah-title-fx"><div class="ah-grid"></div>${streaks}</div>
  <div class="ah-topbar"><div class="ah-brand"><div class="ah-c3">C<sup>3</sup></div><span>BLUFOX MOBILE<br><em>STAFF ARCADE</em></span></div><button class="ah-icon ah-snd" aria-label="Sound">${I.sndOn}</button></div>
  <div class="ah-logo-wrap">
    <div class="ah-eyebrow">BLUFOX MOBILE PRESENTS</div>
    <h1 class="ah-logo" aria-label="After Hours"><span class="ah-logo-a">AFTER</span><span class="ah-logo-b">HOURS</span></h1>
    <p class="ah-sub">THE STORE IS CLOSED.<br><em>THE CHAOS IS OPEN.</em></p>
  </div>
  <div class="ah-title-bottom">
    <div class="ah-best"></div>
    <button class="ah-btn ah-primary ah-play">${I.play}PLAY</button>
    <div class="ah-menu3"><button class="ah-btn ah-go-lb">${I.trophy}LEADERBOARD</button><button class="ah-btn ah-go-locker">${I.shirt}LOCKER</button><button class="ah-btn ah-go-how">${I.help}HOW TO PLAY</button></div>
    <footer>C³ ARCADE · MADE FOR THE BLUFOX TEAM</footer>
  </div>
</section>

<section class="ah-scr ah-how" aria-label="How to play">
  <header class="ah-bar"><button class="ah-icon ah-back" aria-label="Back">${I.back}</button><div class="ah-bar-t"><small>THE NIGHT SHIFT</small><b>HOW TO PLAY</b></div><span class="ah-bar-sp"></span></header>
  <div class="ah-how-body ah-scroll"><div class="ah-col">${how}
    <div class="ah-keysline"><kbd>WASD</kbd> move · <kbd>SPACE</kbd> dash · <kbd>E</kbd> pulse · <kbd>P</kbd> pause</div></div></div>
  <div class="ah-foot"><button class="ah-btn ah-primary ah-how-ok">GOT IT</button></div>
</section>

<section class="ah-scr ah-lb" aria-label="Leaderboard">
  <header class="ah-bar"><button class="ah-icon ah-back" aria-label="Back">${I.back}</button><div class="ah-bar-t"><small>EVERY BLUFOX DISTRICT</small><b>LEADERBOARD</b></div><span class="ah-bar-sp"></span></header>
  <div class="ah-lb-body ah-scroll"><div class="ah-col ah-lb-slot"></div></div>
</section>

<section class="ah-scr ah-locker" aria-label="Locker">
  <header class="ah-bar"><button class="ah-icon ah-back" aria-label="Back">${I.back}</button><div class="ah-bar-t"><small>FOX OUTFITS</small><b>LOCKER</b></div><span class="ah-bar-sp ah-lk-count ah-num"></span></header>
  <div class="ah-lk-window"><div class="ah-lk-ped"></div><div class="ah-lk-name"><b></b><small></small></div></div>
  <div class="ah-lk-sheet"><div class="ah-lk-list"></div><button class="ah-btn ah-primary ah-lk-done">DONE</button></div>
</section>

<section class="ah-scr ah-pause" aria-label="Paused">
  <div class="ah-modal">
    <div class="ah-k">RUN ON HOLD</div>
    <h2>PAUSED</h2>
    <div class="ah-pz-stats"><div><small>SCORE</small><b class="ah-num ah-pz-score">0</b></div><div><small>CLOCK</small><b class="ah-pz-clock">—</b></div></div>
    <button class="ah-btn ah-primary ah-resume">${I.play}RESUME</button>
    <div class="ah-row2"><button class="ah-btn ah-restart">${I.retry}RESTART</button><button class="ah-btn ah-quit">${I.home}QUIT</button></div>
    <button class="ah-toggle ah-snd2">SOUND<span class="ah-sw"></span></button>
  </div>
</section>

<section class="ah-scr ah-over" aria-label="Clocked out">
  <div class="ah-sheet ah-scroll"><div class="ah-col ah-res">
    <div class="ah-colA">
      <div class="ah-stamp"><h2 class="ah-over-h">CLOCKED OUT</h2><div class="ah-punch">${I.clock}<span class="ah-punch-t"></span></div></div>
      <div class="ah-newbest">NEW PERSONAL BEST</div>
      <div class="ah-scorebox"><small>FINAL SCORE</small><div class="ah-bigscore ah-num">0</div><div class="ah-prevbest"></div></div>
      <div class="ah-track"></div>
    </div>
    <div class="ah-colB">
      <div class="ah-stats"></div>
      <div class="ah-killed"></div>
      <div class="ah-unls"></div>
      <div class="ah-post-slot"></div>
    </div>
  </div></div>
  <div class="ah-foot"><button class="ah-btn ah-over-menu">${I.home}MENU</button><button class="ah-btn ah-primary ah-over-retry">${I.retry}RETRY</button></div>
</section>

<section class="ah-scr ah-win" aria-label="Sunrise">
  <div class="ah-sheet ah-scroll"><div class="ah-col ah-res">
    <div class="ah-colA">
      <div class="ah-win-bg"><div class="ah-rays"></div><div class="ah-sun"></div></div>
      <div class="ah-win-k">6:00 AM · SHIFT COMPLETE</div>
      <h2 class="ah-win-h">SUNRISE</h2>
      <div class="ah-win-sub">You survived the night.</div>
      <div class="ah-newbest">NEW PERSONAL BEST</div>
      <div class="ah-scorebox"><small>FINAL SCORE</small><div class="ah-bigscore ah-num">0</div><div class="ah-prevbest"></div></div>
      <div class="ah-track"></div>
    </div>
    <div class="ah-colB">
      <div class="ah-stats"></div>
      <div class="ah-unls"></div>
      <div class="ah-post-slot"></div>
    </div>
  </div></div>
  <div class="ah-foot ah-choices">
    <button class="ah-choice ah-clockout">${I.exit}<b>CLOCK OUT</b><span>Lock in your score and post it.</span></button>
    <button class="ah-choice ah-double">${I.mug}<b>PULL A DOUBLE</b><span>Endless overtime. Score keeps climbing.</span></button>
  </div>
  <div class="ah-foot ah-foot-after"><button class="ah-btn ah-win-menu">${I.home}MENU</button><button class="ah-btn ah-primary ah-gold ah-win-again">${I.retry}PLAY AGAIN</button></div>
</section>`;
}

// =====================================================================================
export function createUI(rootEl, hooks) {
  hooks = hooks || {};
  const call = (name, ...a) => {
    const f = hooks[name];
    if (typeof f !== 'function') return undefined;
    try { return f(...a); } catch (e) { console.error('[ui] hook ' + name + ' threw', e); return undefined; }
  };
  const mq = (s) => !!(window.matchMedia && window.matchMedia(s).matches);
  const reduced = mq('(prefers-reduced-motion: reduce)');

  rootEl.classList.add('ah-host');
  const root = document.createElement('div');
  root.className = 'ah';
  root.dataset.screen = 'boot';
  root.dataset.mood = 'close';
  root.innerHTML = template();
  rootEl.appendChild(root);
  const q = (s, r = root) => r.querySelector(s);
  const qa = (s, r = root) => Array.from(r.querySelectorAll(s));

  const R = {
    safe: q('.ah-safe'), run: q('.ah-run'), zone: q('.ah-zone'), stick: q('.ah-stick'), knob: q('.ah-knob'), arrows: q('.ah-arrows'),
    vigOd: q('.ah-vig-od'), vigLow: q('.ah-vig-low'), vigHurt: q('.ah-vig-hurt'),
    hud: q('.ah-hud'), hl: q('.ah-hl'), hc: q('.ah-hc'), hr: q('.ah-hr'), pz: q('.ah-pz'),
    hp: q('.ah-hp'), cells: q('.ah-cells'), od: q('.ah-od'), odFill: q('.ah-od-fill'),
    wep: q('.ah-wep'), wepT: q('.ah-wep-t'), wepN: q('.ah-wep-n'), wepXp: q('.ah-wep-xp i'),
    clkT: q('.ah-clock b'), clkA: q('.ah-clock span'), hname: q('.ah-hname'), hbar: q('.ah-hbar i'),
    score: q('.ah-score'), combo: q('.ah-combo'), comboN: q('.ah-combo b'), mult: q('.ah-mult'),
    buffs: qa('.ah-buff'), popL: q('.ah-popL'), popR: q('.ah-popR'),
    boss: q('.ah-boss'), bossN: q('.ah-boss-n'), bossPh: q('.ah-boss-ph'), bossFill: q('.ah-boss-fill'), bossLag: q('.ah-boss-lag'),
    cards: q('.ah-cards'), banner: q('.ah-banner'), bnName: q('.ah-bn-name'), bnTitle: q('.ah-bn-title'), bnTip: q('.ah-bn-tip'),
    dashBtn: q('.ah-act-dash'), pulseBtn: q('.ah-act-pulse'), keys: q('.ah-keys'),
    title: q('.ah-title'), titleArt: q('.ah-title-art'), best: q('.ah-best'), snd: q('.ah-snd'), snd2: q('.ah-snd2'),
    lbSlot: q('.ah-lb-slot'), lkList: q('.ah-lk-list'), lkName: q('.ah-lk-name b'), lkStat: q('.ah-lk-name small'), lkCount: q('.ah-lk-count'),
    pzScore: q('.ah-pz-score'), pzClock: q('.ah-pz-clock'),
    over: q('.ah-over'), win: q('.ah-win'),
  };
  for (const b of [R.dashBtn, R.pulseBtn]) { b._fg = q('.fg', b); b._cdn = q('.ah-cdn', b); }
  R.buffs.forEach((el) => { el._k = el.dataset.b; el._n = q('span', el); el._bar = q('i', el); el._max = 1; el._v = 0; el._q = -1; el._s = -1; });

  // ---- state -------------------------------------------------------------------------
  let screen = 'boot';
  let profile = normProfile(null);
  let assets = { title: null, portraits: {} };
  let soundOn = true;
  let touchUI = mq('(pointer: coarse)');
  let lastState = null;
  let sessionName = '', sessionDistrict = '';
  let vw = 390, vh = 844, rootL = 0, rootT = 0, land = false;
  let ins = { t: 0, r: 0, b: 0, l: 0 };
  let hudBottom = 100, hcBottom = 60;
  let cardTop = -1;
  const C = {};                 // HUD value cache (only touch the DOM on change)
  let cells = [];
  let scoreDisp = -1;
  let odMax = 1;
  let bannerT = 0, bannerFallback = 0;
  const cardQ = [], cardA = [];

  function normProfile(p) {
    const d = { best: 0, bestHour: 0, lifetimeKills: 0, wins: 0, runs: 0, outfit: 'bomber', unlocked: ['bomber'], name: '', district: '', sound: true, newUnlocks: [] };
    if (!p || typeof p !== 'object') return d;
    return Object.assign(d, p, {
      unlocked: Array.isArray(p.unlocked) ? p.unlocked.slice() : d.unlocked,
      newUnlocks: Array.isArray(p.newUnlocks) ? p.newUnlocks.slice() : [],
    });
  }

  function setScreen(name) {
    if (screen === name) return;
    const prev = screen;
    screen = name;
    root.dataset.screen = name;
    if (name !== 'play') { clearInputs(); }
    if (name !== 'play' && name !== 'pause') { threatArrows(null); }
    const ae = document.activeElement;
    if (ae && root.contains(ae) && ae.blur) ae.blur();
    call('onScreen', name, prev);
  }

  // =====================================================================================
  // LAYOUT MEASUREMENT
  // =====================================================================================
  function measure() {
    const r = root.getBoundingClientRect();
    vw = r.width || window.innerWidth; vh = r.height || window.innerHeight; rootL = r.left; rootT = r.top;
    const cs = getComputedStyle(R.safe);
    ins = { t: parseFloat(cs.paddingTop) || 0, r: parseFloat(cs.paddingRight) || 0, b: parseFloat(cs.paddingBottom) || 0, l: parseFloat(cs.paddingLeft) || 0 };
    land = vw > vh && vh <= 560;
    if (screen === 'play' || screen === 'pause') {
      const big = vw >= 900 && vh >= 600;
      if (land || big) cellBudget = big ? 120 : 96;
      else {
        const cl = R.cells.getBoundingClientRect().left, hl = R.hc.getBoundingClientRect().left;
        cellBudget = clamp(hl - cl - 8, 40, 110);
      }
      if (cells.length) sizeCells(cells.length);
      hudBottom = R.hud.offsetTop + R.hud.offsetHeight;
      hcBottom = R.hud.offsetTop + R.hc.offsetTop + R.hc.offsetHeight;
      R.boss.style.top = ((land ? hcBottom : hudBottom) + 4) + 'px';
      cardTop = -1;
      layoutCards();
    }
    placeHome();
  }
  function layoutCards() {
    let top = land ? R.hud.offsetTop + R.hl.offsetTop + R.hl.offsetHeight + 6 : hudBottom + 4;
    if (R.boss.classList.contains('on')) top = R.boss.offsetTop + R.boss.offsetHeight + 8;
    if (top !== cardTop) { R.cards.style.top = top + 'px'; cardTop = top; }
  }
  const onResize = () => requestAnimationFrame(measure);
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => setTimeout(measure, 250));

  // =====================================================================================
  // HUD
  // =====================================================================================
  function resetHud() {
    for (const k of Object.keys(C)) delete C[k];
    scoreDisp = -1;
    R.buffs.forEach((el) => { el._v = 0; el._q = -1; el._s = -1; el.classList.remove('on', 'low'); });
    R.boss.classList.remove('on', 'dying', 'flash');
    R.vigOd.classList.remove('on'); R.vigLow.classList.remove('on');
    R.dashBtn.classList.remove('armed', 'cool', 'sec'); R.pulseBtn.classList.remove('armed', 'cool', 'sec');
    layoutCards();
  }
  let cellBudget = 64;
  function sizeCells(n) {
    // fit the cells into the room left of the clock capsule (portrait) / a fixed budget otherwise
    const gap = n > 8 ? 2 : 2.5;
    const w = clamp(Math.floor((cellBudget - (n - 1) * gap) / n), 4, 12);
    R.hp.style.setProperty('--cw', w + 'px');
    R.hp.style.setProperty('--cg', gap + 'px');
  }
  function buildCells(n) {
    sizeCells(n);
    R.cells.textContent = '';
    cells = [];
    for (let i = 0; i < n; i++) { const c = document.createElement('i'); c.className = 'ah-cell'; c._f = -1; R.cells.appendChild(c); cells.push(c); }
  }
  function paintCells(hp, animate) {
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const f = Math.round(clamp(hp - i, 0, 1) * 20) / 20;
      if (c._f === f) continue;
      c.style.setProperty('--f', f);
      c.classList.toggle('on', f >= 1);
      if (animate && c._f >= 0 && !reduced) retrigger(c, f < c._f ? 'lose' : 'gain');
      c._f = f;
    }
  }
  function bump(el, s) {
    if (reduced || !el.animate) return;
    el.animate([{ transform: `scale(${s || 1.25})` }, { transform: 'scale(1)' }], { duration: 170, easing: 'ease-out' });
  }

  function hud(s, dt) {
    if (!s) return;
    lastState = s;
    dt = dt > 0 && dt < 0.25 ? dt : 0.016;
    const p = s.player || {};

    // mood accent
    const mood = s.mood || 'close';
    if (mood !== C.mood) { root.dataset.mood = mood; C.mood = mood; }

    // health cells
    const maxHp = Math.max(1, Math.round(p.maxHp || 1));
    const hp = Math.max(0, Number(p.hp) || 0);
    if (maxHp !== C.maxHp) { buildCells(maxHp); C.maxHp = maxHp; C.hp = undefined; }
    if (hp !== C.hp) { paintCells(hp, C.hp !== undefined); C.hp = hp; }
    const shield = (p.shieldT || 0) > 0;
    if (shield !== C.shield) { R.hp.classList.toggle('shield', shield); C.shield = shield; }
    const low = hp > 0 && hp <= 1 && maxHp >= 3;
    if (low !== C.low) { R.hp.classList.toggle('low', low); R.vigLow.classList.toggle('on', low); C.low = low; }

    // overdrive
    const odOn = (p.odT || 0) > 0;
    if (odOn && (!C.odOn || p.odT > odMax)) odMax = Math.max(0.5, p.odT);
    const odv = odOn ? clamp(p.odT / odMax, 0, 1) : clamp(p.od || 0, 0, 1);
    const oq = Math.round(odv * 100) / 100;
    if (oq !== C.od) { R.odFill.style.transform = `scaleX(${oq})`; C.od = oq; }
    if (odOn !== C.odOn) { R.od.classList.toggle('on', odOn); R.vigOd.classList.toggle('on', odOn); C.odOn = odOn; }
    const odReady = !odOn && (p.od || 0) >= 0.999;
    if (odReady !== C.odReady) { R.od.classList.toggle('ready', odReady); C.odReady = odReady; }

    // weapon tier chip
    const tier = Math.max(0, p.wTier | 0);
    const wname = p.wName || (WEAPONS[tier] || WEAPONS[WEAPONS.length - 1]).n;
    if (tier !== C.wTier || wname !== C.wName) {
      R.wepT.textContent = String(tier + 1);
      R.wepN.textContent = wname;
      const maxed = tier >= WEAPONS.length - 1;
      R.wep.classList.toggle('max', maxed);
      if (C.wTier !== undefined && tier > C.wTier && !reduced) retrigger(R.wep, 'up');
      C.wTier = tier; C.wName = wname; C.xp = undefined;
    }
    const xf = tier >= WEAPONS.length - 1 ? 1 : p.xpNext > 0 ? clamp((p.xp || 0) / p.xpNext, 0, 1) : 0;
    const xq = Math.round(xf * 100) / 100;
    if (xq !== C.xp) { R.wepXp.style.transform = `scaleX(${xq})`; C.xp = xq; }

    // clock + hour
    const clock = s.clock || '';
    if (clock !== C.clock) {
      const m = /^\s*(\d{1,2}(?::\d{2})?)\s*([AP]M)?/i.exec(clock);
      R.clkT.textContent = m ? m[1] : clock;
      R.clkA.textContent = m && m[2] ? m[2].toUpperCase() : '';
      C.clock = clock;
    }
    const hi = s.hour | 0;
    const ot = s.phase === 'overtime' || mood === 'overtime' || hi >= HOURS.length;
    const bossHour = !ot && !!(HOURS[hi] || {}).boss;
    const hn = ot ? 'OVERTIME' : bossHour ? 'BOSS FIGHT' : (HOURS[hi] || HOURS[0]).name;
    if (hn !== C.hn) { R.hname.textContent = hn; C.hn = hn; }
    if (bossHour !== C.bh) { R.hc.classList.toggle('bosshour', bossHour); C.bh = bossHour; }
    const hq = s.hourDur ? Math.round(clamp((s.hourT || 0) / s.hourDur, 0, 1) * 200) / 200 : 0;
    if (hq !== C.hq) { R.hbar.style.transform = `scaleX(${hq})`; C.hq = hq; }

    // score (rolls up)
    const target = Math.max(0, Number(s.score) || 0);
    if (scoreDisp < 0 || target < scoreDisp || reduced) scoreDisp = target;
    else if (scoreDisp < target) { scoreDisp += Math.max(1, (target - scoreDisp) * Math.min(1, dt * 14)); if (scoreDisp > target) scoreDisp = target; }
    const shown = Math.floor(scoreDisp);
    if (shown !== C.score) { R.score.textContent = fmt(shown); C.score = shown; }

    // combo + multiplier
    const combo = s.combo | 0;
    if (combo !== C.combo) {
      const on = combo >= 2;
      if (on !== C.comboOn) { R.combo.classList.toggle('on', on); C.comboOn = on; }
      if (on) { R.comboN.textContent = String(combo); if (C.combo !== undefined && combo > C.combo) bump(R.comboN, 1.3); }
      C.combo = combo;
    }
    const mult = Math.max(1, Math.round(s.mult || 1));
    if (mult !== C.mult) {
      R.mult.classList.toggle('on', mult > 1);
      R.mult.dataset.m = String(Math.min(5, mult));
      R.mult.textContent = '×' + mult;
      if (C.mult !== undefined && mult > C.mult) bump(R.mult, 1.4);
      C.mult = mult;
    }

    // timed buffs
    const bf = p.buffs || {};
    for (let i = 0; i < R.buffs.length; i++) {
      const el = R.buffs[i];
      const v = Math.max(0, Number(bf[el._k]) || 0);
      if (v > 0 && (el._v <= 0 || v > el._v + 0.25)) el._max = Math.max(v, 0.5);
      el._v = v;
      const on = v > 0;
      if (on !== el._on) { el.classList.toggle('on', on); el._on = on; }
      if (!on) continue;
      const fq = Math.round(clamp(v / el._max, 0, 1) * 50) / 50;
      if (fq !== el._q) { el._bar.style.transform = `scaleX(${fq})`; el._q = fq; }
      const sec = Math.ceil(v);
      if (sec !== el._s) { el._n.textContent = String(sec); el._s = sec; }
      const lw = v < 2;
      if (lw !== el._low) { el.classList.toggle('low', lw); el._low = lw; }
    }

    // boss bar
    bossHud(s.boss);

    // action-button cooldown rings
    lastCD.dash = Number(p.dashCD) || 0; lastCD.pulse = Number(p.pulseCD) || 0; cdKnown = true;
    actHud(R.dashBtn, lastCD.dash, Number(p.dashCDMax) || 0, 'd');
    actHud(R.pulseBtn, lastCD.pulse, Number(p.pulseCDMax) || 0, 'p');
    if (pend.dash || pend.pulse) expirePending(nowMs());

    // timers
    if (bannerT > 0) { bannerT -= dt; if (bannerT <= 0) hideBanner(false); }
    tickCards(dt);
  }

  function actHud(btn, cd, max, k) {
    const frac = max > 0 ? clamp(1 - cd / max, 0, 1) : 1;
    const qf = Math.round(frac * 60) / 60;
    if (qf !== C[k]) { btn._fg.style.strokeDashoffset = (RING_C * (1 - qf)).toFixed(1); C[k] = qf; }
    const cool = cd > 0.02;
    if (cool !== C[k + 'c']) {
      btn.classList.toggle('cool', cool);
      if (!cool && C[k + 'c'] === true && !reduced) retrigger(btn, 'ready');
      C[k + 'c'] = cool;
    }
    const secs = cd >= 1 ? Math.ceil(cd) : 0;
    if (secs !== C[k + 's']) { btn._cdn.textContent = secs ? String(secs) : ''; btn.classList.toggle('sec', secs > 0); C[k + 's'] = secs; }
  }

  function bossHud(b) {
    if (!b) {
      if (C.boss) { R.boss.classList.remove('on', 'dying', 'flash'); C.boss = null; layoutCards(); }
      return;
    }
    if (C.boss !== b.id) {
      C.boss = b.id;
      const info = KIND_INFO[b.kind] || {};
      R.boss.style.setProperty('--bk', (KIND_COLORS[b.kind] || {}).glow || '#ff3b4d');
      R.bossN.innerHTML = `${esc(b.name || info.name || 'BOSS')}<small>${esc(info.title || '')}</small>`;
      R.boss.classList.remove('dying');
      R.boss.classList.add('on');
      C.bhp = undefined; C.bph = undefined;
      layoutCards();
    }
    const f = b.maxHp > 0 ? Math.round(clamp(b.hp / b.maxHp, 0, 1) * 400) / 400 : 0;
    if (f !== C.bhp) { const tr = `scaleX(${f})`; R.bossFill.style.transform = tr; R.bossLag.style.transform = tr; C.bhp = f; }
    const ph = b.phase | 0 || 1;
    if (ph !== C.bph) {
      R.bossPh.textContent = 'PHASE ' + ph;
      if (C.bph !== undefined && !reduced) retrigger(R.boss, 'flash');
      C.bph = ph;
    }
  }

  // ---- pops (tiny transient text inside the top strip) ---------------------------------
  function pop(side, text, cls, color) {
    const host = side === 'L' ? R.popL : R.popR;
    while (host.childElementCount >= 3) host.firstElementChild.remove();
    const e = document.createElement('div');
    e.className = 'ah-pop' + (cls ? ' ' + cls : '');
    e.textContent = text;
    if (color) e.style.setProperty('--pc', color);
    e.style.top = (2 + host.childElementCount * 17) + 'px';
    host.appendChild(e);
    setTimeout(() => e.remove(), 1000);
  }

  // =====================================================================================
  // CARD QUEUE (slim, non-blocking, top strip only; max 2 visible)
  // =====================================================================================
  function pushCard(c) {
    c.dur = c.dur || 2.2; c.pri = c.pri || 1; c.born = nowMs();
    if (c.key) {
      const a = cardA.find((x) => x.key === c.key);
      if (a) { const nel = buildCard(c); a.el.replaceWith(nel); a.el = nel; a.t = c.dur; return; }
      const qi = cardQ.findIndex((x) => x.key === c.key);
      if (qi >= 0) cardQ.splice(qi, 1);
    }
    cardQ.push(c);
    cardQ.sort((a, b) => b.pri - a.pri || a.born - b.born);
    if (cardQ.length > 6) cardQ.length = 6;
    if (cardA.length >= (land ? 1 : MAX_CARDS) && c.pri >= 2) {
      let lo = null;
      for (const a of cardA) if (a.pri < c.pri && (!lo || a.pri < lo.pri)) lo = a;
      if (lo) lo.t = Math.min(lo.t, 0.3);
    }
    pump();
  }
  function pump() {
    const maxCards = land ? 1 : MAX_CARDS;
    while (cardA.length < maxCards && cardQ.length) {
      const c = cardQ.shift();
      if (c.pri <= 1 && nowMs() - c.born > 2500) continue; // stale pickup name: drop it
      c.el = buildCard(c); c.t = c.dur;
      R.cards.appendChild(c.el);
      cardA.push(c);
    }
  }
  function tickCards(dt) {
    if (bannerT > 0) return;
    for (let i = cardA.length - 1; i >= 0; i--) {
      const c = cardA[i];
      c.t -= dt;
      if (c.t <= 0) { cardA.splice(i, 1); retireCard(c.el); }
    }
    if (cardQ.length && cardA.length < (land ? 1 : MAX_CARDS)) pump();
  }
  function retireCard(el) { el.classList.add('out'); setTimeout(() => el.remove(), reduced ? 0 : 230); }
  function clearCards(keepNewerThan) {
    if (keepNewerThan) { // keep cards pushed in the same event batch (e.g. an 'hour' drained just before 'start')
      const cut = nowMs() - keepNewerThan;
      for (let i = cardQ.length - 1; i >= 0; i--) if (cardQ[i].born < cut) cardQ.splice(i, 1);
      for (let i = cardA.length - 1; i >= 0; i--) if (cardA[i].born < cut) { cardA[i].el.remove(); cardA.splice(i, 1); }
      return;
    }
    cardQ.length = 0; cardA.length = 0; R.cards.textContent = '';
  }
  function buildCard(c) {
    const el = document.createElement('div');
    el.className = 'ah-card ah-card-' + c.kind + (c.gold ? ' ah-card-gold' : '') + (c.bad ? ' ah-card-bad' : '');
    if (c.color) el.style.setProperty('--cc', c.color);
    el.style.setProperty('--life', c.dur + 's');
    let html = '';
    switch (c.kind) {
      case 'hour': {
        const m = /^(\d{1,2})(?::\d\d)?\s*(AM|PM)$/i.exec(c.clock || '');
        html = `<div class="ah-card-tag">${m ? `${m[1]}<span>${m[2].toUpperCase()}</span>` : esc(c.clock)}</div><div class="ah-card-body"><small>${esc(c.sub)}</small><b>${esc(c.name)}</b></div>`;
        break;
      }
      case 'threat': {
        const info = KIND_INFO[c.k] || { name: String(c.k).toUpperCase(), title: '', tip: '' };
        el.style.setProperty('--cc', (KIND_COLORS[c.k] || {}).glow || '#ff3b4d');
        html = `<div class="ah-card-body"><b>${esc(info.name)}<span>${esc(info.title)}</span></b><p>${esc(info.tip)}</p></div><small class="ah-card-flag">NEW THREAT</small>`;
        break;
      }
      case 'tier':
        html = `<div class="ah-card-tag">T${(c.tier | 0) + 1}</div><div class="ah-card-body"><small>WEAPON UP</small><b>${esc(c.name)}</b></div>`;
        break;
      case 'pickup': {
        const pk = PICKUPS[c.pup] || { name: String(c.pup).toUpperCase(), fam: 'nrg', icon: 'bolt' };
        const fam = PICKUP_FAMILIES[pk.fam] || { color: '#7ef0ff', label: '' };
        el.style.setProperty('--cc', fam.color);
        html = `<div class="ah-card-ico">${PICON[pk.icon] || I.bolt}</div><div class="ah-card-body"><b>${esc(pk.name)}</b><small>${esc(fam.label)}</small></div>`;
        break;
      }
      case 'bonus':
        html = `<div class="ah-card-ico">${I.star}</div><div class="ah-card-body"><small>BONUS</small><b>${esc(c.label)}</b></div><div class="ah-card-pts ah-num">+${fmt(c.points)}</div>`;
        break;
      case 'bossKill':
        html = `<div class="ah-card-ico">${I.trophy}</div><div class="ah-card-body"><small>BOSS DOWN</small><b>${esc(c.name)}</b></div>${c.points ? `<div class="ah-card-pts ah-num">+${fmt(c.points)}</div>` : ''}`;
        break;
      case 'od':
        html = `<div class="ah-card-ico">${I.bolt}</div><b>OVERDRIVE</b>`;
        break;
      default: // toast
        html = esc(c.text);
    }
    el.innerHTML = html + '<i class="ah-card-life"></i>';
    if (c.kind === 'threat') el.insertBefore(portraitEl(c.k), el.firstChild);
    return el;
  }

  // ---- portraits ------------------------------------------------------------------------
  function portraitEl(kind, url) {
    const w = document.createElement('div');
    w.className = 'ah-por';
    w.style.setProperty('--pc', (KIND_COLORS[kind] || {}).glow || (kind === 'spark' ? '#ffb547' : '#ff3b4d'));
    const src = url || (assets.portraits && assets.portraits[kind]);
    if (src) {
      const img = new Image();
      img.alt = ''; img.decoding = 'async';
      img.onerror = () => { w.innerHTML = portraitSVG(kind); };
      img.src = src;
      w.appendChild(img);
    } else {
      w.innerHTML = portraitSVG(kind);
    }
    return w;
  }

  // ---- boss intro banner (TOP band only) ---------------------------------------------------
  function showBanner(kind, name) {
    const info = KIND_INFO[kind] || {};
    R.banner.style.setProperty('--bk', (KIND_COLORS[kind] || {}).glow || '#ff3b4d');
    R.bnName.textContent = name || info.name || 'BOSS';
    R.bnTitle.textContent = info.title || '';
    R.bnTip.textContent = info.tip || '';
    R.banner.classList.remove('out');
    retrigger(R.banner, 'on');
    root.classList.add('ah-bannering');
    bannerT = 3.0;
    clearTimeout(bannerFallback);
    bannerFallback = setTimeout(() => { if (bannerT > 0) hideBanner(false); }, 5000);
  }
  function hideBanner(instant) {
    const was = R.banner.classList.contains('on');
    bannerT = 0;
    clearTimeout(bannerFallback);
    R.banner.classList.remove('on');
    root.classList.remove('ah-bannering');
    if (was && !instant && !reduced) {
      R.banner.classList.add('out');
      setTimeout(() => R.banner.classList.remove('out'), 360);
    } else R.banner.classList.remove('out');
  }

  // =====================================================================================
  // EVENTS
  // =====================================================================================
  function event(ev) {
    if (!ev || !ev.type) return;
    switch (ev.type) {
      case 'start':
        clearCards(30); hideBanner(true); resetHud(); root.classList.remove('ah-stick-used');
        break;
      case 'hour': {
        const i = ev.hour | 0;
        const H0 = HOURS[i];
        if (ev.boss || (H0 && H0.boss)) break; // the boss banner is the hour card for boss hours
        const ot = i >= HOURS.length;
        const clock = ev.clock || (H0 ? H0.clock : '6 AM');
        const name = ev.name || (H0 ? H0.name : 'OVERTIME');
        const sub = ot ? 'OVERTIME · NO CEILING' : i === 0 ? 'SURVIVE UNTIL 6 AM' : `HOUR ${i + 1} OF ${HOURS.length}`;
        pushCard({ kind: 'hour', pri: 4, dur: 2.6, clock, name, sub, color: HOUR_COLORS[i] || '#ff8a3d' });
        break;
      }
      case 'newThreat':
        if (ev.kind && !String(ev.kind).startsWith('boss')) pushCard({ kind: 'threat', k: ev.kind, pri: 3, dur: 3.2 });
        break;
      case 'tierUp':
        pushCard({ kind: 'tier', pri: 2, dur: 2.2, tier: ev.tier | 0, name: ev.name || (WEAPONS[ev.tier | 0] || {}).n || 'UPGRADE' });
        buzz(12);
        break;
      case 'pickup':
        if (ev.pup && PICKUPS[ev.pup]) pushCard({ kind: 'pickup', key: 'pickup', pri: 1, dur: 1.7, pup: ev.pup });
        break;
      case 'heal': pop('L', '+ HEALTH', 'heal'); break;
      case 'shieldBlock': pop('L', 'BLOCKED', 'shield'); buzz(10); break;
      case 'combo': pop('R', '×' + (ev.mult | 0 || 2), 'm', MULT_COLORS[Math.min(5, ev.mult | 0)] || '#3ee8ff'); break;
      case 'comboBreak': if ((ev.combo | 0) >= 10) pop('R', 'CHAIN BROKEN', 'bad'); break;
      case 'overdrive': pushCard({ kind: 'od', key: 'od', pri: 2, dur: 1.5, color: '#ffb547' }); buzz(20); break;
      case 'hurt':
        if (!reduced) { retrigger(R.vigHurt, 'on'); retrigger(R.hp, 'hit'); }
        buzz(45);
        break;
      case 'dash': buzz(12); break;
      case 'pulse': buzz(18); break;
      case 'bossIntro': showBanner(ev.kind, ev.name); buzz([70, 50, 160]); break;
      case 'bossPhase': {
        const info = KIND_INFO[ev.kind] || {};
        pushCard({ kind: 'toast', text: `${info.name || 'BOSS'} · PHASE ${ev.phase | 0}`, bad: true, pri: 3, dur: 1.6 });
        buzz([30, 30, 60]);
        break;
      }
      case 'bossDying': R.boss.classList.add('dying'); buzz([60, 40, 60]); break;
      case 'bossKill': {
        const info = KIND_INFO[ev.kind] || {};
        pushCard({ kind: 'bossKill', gold: true, pri: 5, dur: 3, name: info.name || 'BOSS', points: ev.points | 0 });
        buzz([100, 50, 100, 50, 220]);
        break;
      }
      case 'bonus': case 'noHit': case 'noHitHour':
        pushCard({ kind: 'bonus', gold: true, pri: 3, dur: 2.4, label: ev.label || 'NO-HIT HOUR', points: ev.points != null ? ev.points : ev.bonus != null ? ev.bonus : 2000 });
        break;
      case 'gameover': buzz([120, 80, 260]); hideBanner(true); threatArrows(null); break;
      case 'victory': buzz([40, 40, 40, 40, 220]); hideBanner(true); threatArrows(null); break;
      default: break;
    }
  }
  function toast(text, opts) {
    opts = opts || {};
    pushCard({ kind: 'toast', text: String(text), pri: opts.pri != null ? opts.pri : 2, dur: opts.dur || 1.8, bad: opts.tone === 'bad', gold: opts.tone === 'gold', color: opts.color });
  }

  // =====================================================================================
  // OFF-SCREEN THREAT ARROWS
  // =====================================================================================
  const arrows = [];
  const ARROW_SVG = '<svg viewBox="0 0 30 30" aria-hidden="true"><path d="M7 4.5 L26 15 L7 25.5 L12 15 Z" fill="rgba(4,6,16,.55)" transform="translate(-1.5 0)"/><path d="M8 5 L25 15 L8 25 L12.5 15 Z" fill="currentColor" stroke="#fff" stroke-opacity=".85" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  let arrowsShown = 0;
  function threatArrows(list) {
    const n = list && (screen === 'play' || screen === 'pause') ? Math.min(list.length, ARROW_POOL) : 0;
    while (arrows.length < n) {
      const e = document.createElement('div');
      e.className = 'ah-arw'; e.innerHTML = ARROW_SVG; e._k = null; e._b = null; e._x = NaN; e._y = NaN; e._a = NaN;
      R.arrows.appendChild(e); arrows.push(e);
    }
    const L = 16 + ins.l, Rr = vw - 16 - ins.r, T = (land ? hcBottom : hudBottom) + 14, B = vh - 18 - ins.b;
    const cx = vw * 0.5, cy = vh * 0.56;
    for (let i = 0; i < n; i++) {
      const it = list[i], e = arrows[i];
      const dx = (Number(it.x) || 0) - cx, dy = (Number(it.y) || 0) - cy;
      let s = 1e9;
      if (dx > 0) s = Math.min(s, (Rr - cx) / dx); else if (dx < 0) s = Math.min(s, (L - cx) / dx);
      if (dy > 0) s = Math.min(s, (B - cy) / dy); else if (dy < 0) s = Math.min(s, (T - cy) / dy);
      if (!(s < 1e8)) s = 0;
      s = Math.min(s, 1);
      const x = Math.round((cx + dx * s) * 2) / 2, y = Math.round((cy + dy * s) * 2) / 2;
      const a = Math.round(Math.atan2(dy, dx) * 100) / 100;
      if (x !== e._x || y !== e._y || a !== e._a) { e.style.transform = `translate3d(${x}px,${y}px,0) rotate(${a}rad)`; e._x = x; e._y = y; e._a = a; }
      if (it.kind !== e._k) { e.style.setProperty('--k', (KIND_COLORS[it.kind] || {}).glow || '#ff3b4d'); e._k = it.kind; }
      const boss = !!(it.boss || String(it.kind || '').startsWith('boss'));
      if (boss !== e._b) { e.classList.toggle('boss', boss); e._b = boss; }
      if (i >= arrowsShown) e.style.display = 'block';
    }
    for (let i = n; i < arrowsShown; i++) arrows[i].style.display = 'none';
    arrowsShown = n;
  }

  // =====================================================================================
  // INPUT
  // =====================================================================================
  const keys = new Set();
  const pend = { dash: 0, pulse: 0 };
  const lastCD = { dash: 0, pulse: 0 };
  let cdKnown = false;
  const st = { id: null, ox: 0, oy: 0, x: 0, y: 0, lx: 0, ly: 0, trail: [], swipeAt: -1e9, homeX: 100, homeY: 600 };
  const OUT = { mx: 0, mz: 0, dash: false, pulse: false };
  const padAcc = { x: 0, y: 0 };
  const padPrev = {};

  function setTouchUI(on) { if (touchUI === on) return; touchUI = on; root.classList.toggle('ah-touch', on); placeHome(); }
  root.classList.toggle('ah-touch', touchUI);

  function request(kind) {
    if (screen !== 'play') return;
    pend[kind] = nowMs();
    if (cdKnown && lastCD[kind] > 0.0001) { (kind === 'dash' ? R.dashBtn : R.pulseBtn).classList.add('armed'); buzz(6); }
  }
  function consume(kind, t) {
    const at = pend[kind];
    if (!at) return false;
    const btn = kind === 'dash' ? R.dashBtn : R.pulseBtn;
    if (t - at > BUF_MS) { pend[kind] = 0; btn.classList.remove('armed'); return false; }
    if (cdKnown && lastCD[kind] > 0.0001) return false; // still cooling: hold it in the buffer
    pend[kind] = 0; btn.classList.remove('armed');
    return true;
  }
  function expirePending(t) {
    if (pend.dash && t - pend.dash > BUF_MS) { pend.dash = 0; R.dashBtn.classList.remove('armed'); }
    if (pend.pulse && t - pend.pulse > BUF_MS) { pend.pulse = 0; R.pulseBtn.classList.remove('armed'); }
  }
  function clearInputs() {
    keys.clear();
    endStick();
    pend.dash = pend.pulse = 0;
    R.dashBtn.classList.remove('armed', 'press'); R.pulseBtn.classList.remove('armed', 'press');
  }

  function readInput() {
    OUT.mx = 0; OUT.mz = 0; OUT.dash = false; OUT.pulse = false;
    if (screen !== 'play') { pend.dash = pend.pulse = 0; return OUT; }
    let x = st.x, y = st.y;
    const kx = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
    const ky = (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) - (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0);
    if (kx || ky) { const l = Math.hypot(kx, ky); x += kx / l; y += ky / l; }
    padAcc.x = 0; padAcc.y = 0;
    pollPad(padAcc);
    x += padAcc.x; y += padAcc.y;
    const l = Math.hypot(x, y);
    if (l > 1) { x /= l; y /= l; }
    OUT.mx = x || 0; OUT.mz = y || 0;
    const t = nowMs();
    OUT.dash = consume('dash', t);
    OUT.pulse = consume('pulse', t);
    return OUT;
  }

  // ---- gamepad (bonus) ----------------------------------------------------------------------
  function pollPad(acc) {
    let pads = null;
    try { pads = navigator.getGamepads ? navigator.getGamepads() : null; } catch (e) { pads = null; }
    if (!pads) return;
    for (let i = 0; i < pads.length; i++) {
      const g = pads[i];
      if (!g || !g.connected) continue;
      const bt = (n) => !!(g.buttons[n] && (g.buttons[n].pressed || g.buttons[n].value > 0.5));
      let x = g.axes[0] || 0, y = g.axes[1] || 0;
      const dl = bt(14), dr = bt(15), du = bt(12), dd = bt(13);
      if (dl || dr || du || dd) { x = (dr ? 1 : 0) - (dl ? 1 : 0); y = (dd ? 1 : 0) - (du ? 1 : 0); } // D-pad owns both axes
      const l = Math.hypot(x, y);
      if (l > 0.18) { const k = Math.min(1, (l - 0.18) / 0.72) / l; acc.x += x * k; acc.y += y * k; }
      const a = bt(0), b = bt(1) || bt(2), s = bt(9);
      const pv = padPrev[i] || (padPrev[i] = { a: false, b: false, s: false });
      if (a && !pv.a) request('dash');
      if (b && !pv.b) request('pulse');
      if (s && !pv.s && screen === 'play') userPause();
      pv.a = a; pv.b = b; pv.s = s;
    }
  }
  let padTimer = 0;
  function menuPad() {
    if (screen === 'play') return;
    let pads = null;
    try { pads = navigator.getGamepads ? navigator.getGamepads() : null; } catch (e) { pads = null; }
    if (!pads) return;
    for (let i = 0; i < pads.length; i++) {
      const g = pads[i];
      if (!g || !g.connected) continue;
      const bt = (n) => !!(g.buttons[n] && g.buttons[n].pressed);
      const a = bt(0), s = bt(9);
      const pv = padPrev[i] || (padPrev[i] = { a: false, b: false, s: false });
      if ((s && !pv.s) || (a && !pv.a)) {
        if (screen === 'pause') userResume();
        else if (screen === 'over' && a) call('onRetry');
      }
      pv.a = a; pv.s = s;
    }
  }
  const onPadConnect = () => { if (!padTimer) padTimer = setInterval(menuPad, 120); };
  window.addEventListener('gamepadconnected', onPadConnect);

  // ---- keyboard -----------------------------------------------------------------------------
  const MOVE_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
  function onKeyDown(e) {
    const tg = e.target;
    if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.isContentEditable)) return;
    const c = e.code;
    if (screen === 'play') {
      if (MOVE_CODES.has(c)) { e.preventDefault(); keys.add(c); return; }
      if (c === 'Space') { e.preventDefault(); if (!e.repeat) request('dash'); return; }
      if (c === 'KeyE' || c === 'ShiftLeft' || c === 'ShiftRight') { if (!e.repeat) request('pulse'); return; }
      if (c === 'KeyP' || c === 'Escape') { e.preventDefault(); if (!e.repeat) userPause(); return; }
      return;
    }
    if (e.repeat) return;
    if (screen === 'pause' && (c === 'KeyP' || c === 'Escape')) { e.preventDefault(); userResume(); return; }
    if ((screen === 'lb' || screen === 'locker' || screen === 'how') && c === 'Escape') { e.preventDefault(); setScreen('title'); return; }
    const ae = document.activeElement;
    const onButton = ae && ae.tagName === 'BUTTON' && root.contains(ae);
    if (screen === 'title' && c === 'Enter' && !onButton) { e.preventDefault(); doPlay(); }
    if (screen === 'over' && c === 'KeyR') { e.preventDefault(); call('onRetry'); }
  }
  function onKeyUp(e) { keys.delete(e.code); }
  const onBlur = () => keys.clear();
  window.addEventListener('keydown', onKeyDown, { passive: false });
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  // ---- touch joystick -------------------------------------------------------------------------
  function setStickPos(x, y) { R.stick.style.transform = `translate3d(${(x - rootL).toFixed(1)}px,${(y - rootT).toFixed(1)}px,0)`; }
  function placeHome() {
    if (land) { st.homeX = rootL + ins.l + Math.max(110, Math.min(170, vw * 0.15)); st.homeY = rootT + vh - ins.b - 105; }
    else { st.homeX = rootL + ins.l + clamp(vw * 0.25, 92, 130); st.homeY = rootT + vh - ins.b - clamp(vh * 0.2, 150, 210); }
    if (st.id === null) { setStickPos(st.homeX, st.homeY); R.knob.style.transform = ''; }
  }
  function pushTrail(x, y, ts) {
    const tr = st.trail;
    tr.push({ x, y, t: ts });
    while (tr.length > 2 && ts - tr[0].t > SWIPE_WIN) tr.shift();
    if (tr.length > 24) tr.shift();
  }
  function checkSwipe(ts) {
    const tr = st.trail;
    if (ts - st.swipeAt < SWIPE_LOCK || tr.length < 3) return;
    const a = tr[0], b = tr[tr.length - 1];
    if (b.t - a.t < 30) return;
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
    if (d < SWIPE_DIST) return;
    const p = tr[tr.length - 2], hx = b.x - p.x, hy = b.y - p.y, hl = Math.hypot(hx, hy);
    if (hl > 0.5 && (hx * dx + hy * dy) / (hl * d) < 0.7) return; // must be a straight flick
    st.swipeAt = ts; tr.length = 0;
    st.x = dx / d; st.y = dy / d; // the dash goes where you flicked
    request('dash');
  }
  function moveStick(cx, cy) {
    const ul = Math.hypot(st.x, st.y);
    if (ul > 0.12) { // reversal assist
      const dot = ((cx - st.lx) * st.x + (cy - st.ly) * st.y) / ul;
      if (dot < 0) { st.ox -= (st.x / ul) * dot * STICK_TRAIL; st.oy -= (st.y / ul) * dot * STICK_TRAIL; }
    }
    st.lx = cx; st.ly = cy;
    let dx = cx - st.ox, dy = cy - st.oy, l = Math.hypot(dx, dy);
    if (l > STICK_R) { // the anchor trails the finger so the stick never saturates far away
      st.ox = cx - (dx / l) * STICK_R; st.oy = cy - (dy / l) * STICK_R;
      dx = cx - st.ox; dy = cy - st.oy; l = STICK_R;
    }
    if (l < STICK_DEAD) { st.x = 0; st.y = 0; }
    else {
      const n = Math.min(1, (l - STICK_DEAD) / (STICK_FULL - STICK_DEAD));
      const k = n * (0.55 + 0.45 * n); // gentle ease-in: fine control near the centre, 100% at 80% travel
      st.x = (dx / l) * k; st.y = (dy / l) * k;
    }
    setStickPos(st.ox, st.oy);
    R.knob.style.transform = `translate3d(${dx.toFixed(1)}px,${dy.toFixed(1)}px,0)`;
  }
  function endStick() {
    if (st.id !== null) { try { R.zone.releasePointerCapture(st.id); } catch (e) { /* already released */ } }
    st.id = null; st.x = 0; st.y = 0; st.trail.length = 0;
    R.stick.classList.remove('live');
    R.knob.style.transform = '';
    setStickPos(st.homeX, st.homeY);
  }
  R.zone.addEventListener('pointerdown', (e) => {
    if (screen !== 'play') return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    if (e.pointerType === 'touch') setTouchUI(true);
    if (st.id !== null) { if (e.pointerId !== st.id) request('dash'); return; } // second finger anywhere = DASH
    const r = root.getBoundingClientRect(); rootL = r.left; rootT = r.top;
    st.id = e.pointerId; st.ox = e.clientX; st.oy = e.clientY; st.lx = e.clientX; st.ly = e.clientY; st.x = 0; st.y = 0;
    st.trail.length = 0; pushTrail(e.clientX, e.clientY, e.timeStamp || nowMs());
    try { R.zone.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
    R.stick.classList.add('live');
    root.classList.add('ah-stick-used');
    setStickPos(st.ox, st.oy);
    R.knob.style.transform = '';
  }, { passive: false });
  R.zone.addEventListener('pointermove', (e) => {
    if (st.id === null || e.pointerId !== st.id) return;
    e.preventDefault();
    let pts = null;
    try { if (e.getCoalescedEvents) { const cc = e.getCoalescedEvents(); if (cc && cc.length) pts = cc; } } catch (err) { pts = null; }
    if (pts) for (const p of pts) pushTrail(p.clientX, p.clientY, p.timeStamp || e.timeStamp || nowMs());
    else pushTrail(e.clientX, e.clientY, e.timeStamp || nowMs());
    moveStick(e.clientX, e.clientY);
    checkSwipe(e.timeStamp || nowMs());
  }, { passive: false });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    R.zone.addEventListener(type, (e) => { if (e.pointerId === st.id) endStick(); });
  }

  // ---- action buttons ----------------------------------------------------------------------------
  function bindAct(btn, kind) {
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.pointerType === 'touch') setTouchUI(true);
      btn.classList.add('press');
      try { btn.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
      request(kind);
    }, { passive: false });
    const up = () => btn.classList.remove('press');
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) btn.addEventListener(t, up);
    btn.addEventListener('click', (e) => e.preventDefault());
  }
  bindAct(R.dashBtn, 'dash');
  bindAct(R.pulseBtn, 'pulse');

  // ---- page hardening (iOS rubber-band, pinch, double-tap zoom, long-press menus) -------------------
  const inScroll = (t) => !!(t && t.closest && t.closest('.ah-scroll, .ah-lk-list'));
  const onTouchMove = (e) => { if (!e.cancelable) return; if (inScroll(e.target)) return; if (screen === 'play' || root.contains(e.target)) e.preventDefault(); };
  const onGesture = (e) => e.preventDefault();
  const onDbl = (e) => { if (root.contains(e.target)) e.preventDefault(); };
  const onCtx = (e) => { if (root.contains(e.target) && !(e.target.tagName === 'INPUT')) e.preventDefault(); };
  const onSel = (e) => { const t = e.target; if (t && t.nodeType === 1 && t.tagName === 'INPUT') return; if (root.contains(t && t.nodeType === 1 ? t : t && t.parentNode)) e.preventDefault(); };
  const onVis = () => { if (document.hidden) { keys.clear(); if (screen === 'play') userPause(); } };
  const onAnyPointer = (e) => { if (e.pointerType === 'touch') setTouchUI(true); };
  document.addEventListener('touchmove', onTouchMove, { passive: false });
  document.addEventListener('gesturestart', onGesture, { passive: false });
  document.addEventListener('gesturechange', onGesture, { passive: false });
  document.addEventListener('dblclick', onDbl, { passive: false });
  document.addEventListener('contextmenu', onCtx);
  document.addEventListener('selectstart', onSel);
  document.addEventListener('visibilitychange', onVis);
  root.addEventListener('pointerdown', onAnyPointer, true);

  // =====================================================================================
  // SCREENS
  // =====================================================================================
  function paintSound() {
    R.snd.innerHTML = soundOn ? I.sndOn : I.sndOff;
    R.snd.setAttribute('aria-label', soundOn ? 'Sound on' : 'Sound off');
    R.snd.classList.toggle('off', !soundOn);
    R.snd2.classList.toggle('on', soundOn);
  }
  function toggleSound() { soundOn = !soundOn; profile.sound = soundOn; paintSound(); call('onSound', soundOn); }
  R.snd.addEventListener('click', toggleSound);
  R.snd2.addEventListener('click', toggleSound);

  // ---- title ----------------------------------------------------------------------------------
  function paintTitle() {
    const p = profile;
    if (p.best > 0) {
      const bh = (p.bestHour | 0) >= HOURS.length ? 'SUNRISE' : (HOURS[p.bestHour | 0] || HOURS[0]).clock;
      R.best.innerHTML = `<div class="ah-bestchip gold"><small>PERSONAL BEST</small><b class="ah-num">${fmt(p.best)}</b></div><div class="ah-bestchip cy"><small>${(p.bestHour | 0) >= HOURS.length ? 'MADE IT TO' : 'BEST HOUR'}</small><b>${esc(bh)}</b></div>`;
    } else {
      R.best.innerHTML = '<div class="ah-firstshift">FIRST SHIFT? SURVIVE UNTIL SUNRISE.</div>';
    }
  }
  let playLock = -1e9;
  function doPlay() {
    const t = nowMs();
    if (t - playLock < 600) return;
    playLock = t;
    call('onPlay');
  }
  q('.ah-play').addEventListener('click', doPlay);
  q('.ah-go-lb').addEventListener('click', () => showLeaderboard('all'));
  q('.ah-go-locker').addEventListener('click', () => showLocker());
  q('.ah-go-how').addEventListener('click', () => showHow());
  qa('.ah-back').forEach((b) => b.addEventListener('click', () => setScreen('title')));
  q('.ah-how-ok').addEventListener('click', () => setScreen('title'));
  q('.ah-lk-done').addEventListener('click', () => setScreen('title'));

  function showTitle(prof) {
    profile = normProfile(prof);
    soundOn = profile.sound !== false;
    paintSound();
    paintTitle();
    clearCards(); hideBanner(true);
    R.win.classList.remove('clocked');
    setScreen('title');
  }
  function showHow() { setScreen('how'); const sc = q('.ah-how-body'); if (sc) sc.scrollTop = 0; }

  // ---- leaderboard component --------------------------------------------------------------------------
  function scrollToEl(el) {
    const sc = el.closest('.ah-scroll');
    if (!sc) return;
    const sr = sc.getBoundingClientRect(), er = el.getBoundingClientRect();
    const top = sc.scrollTop + (er.top - sr.top) - (sr.height / 2 - er.height / 2);
    try { sc.scrollTo({ top: Math.max(0, top), behavior: reduced ? 'auto' : 'smooth' }); } catch (e) { sc.scrollTop = Math.max(0, top); }
  }
  function makeBoard(slot, opts) {
    opts = opts || {};
    const el = document.createElement('div');
    el.className = 'ah-board';
    el.innerHTML = '<div class="ah-tabs" role="tablist"><button data-s="all" role="tab">ALL-TIME</button><button data-s="week" role="tab">THIS WEEK</button></div><div class="ah-rows"></div>';
    slot.appendChild(el);
    const tabs = qa('.ah-tabs button', el), rows = q('.ah-rows', el);
    let scope = 'all', hl = null, token = 0;
    tabs.forEach((b) => b.addEventListener('click', () => { if (b.dataset.s !== scope) load(b.dataset.s, hl); }));
    function setTab(s) { scope = s === 'week' ? 'week' : 'all'; tabs.forEach((b) => { const on = b.dataset.s === scope; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); }); }
    function skeleton() {
      let hs = '';
      const n = opts.inline ? 5 : 9;
      for (let i = 0; i < n; i++) hs += `<div class="ah-skel" style="animation-delay:${i * 70}ms;opacity:${(1 - i * 0.08).toFixed(2)}"></div>`;
      rows.innerHTML = hs;
    }
    function message(kind, detail) {
      const off = typeof navigator !== 'undefined' && navigator.onLine === false;
      const title = kind === 'empty' ? 'NO SCORES YET' : off ? 'YOU’RE OFFLINE' : 'LEADERBOARD OFFLINE';
      const text = kind === 'empty' ? (scope === 'week' ? 'Nobody has posted this week. Be the first.' : 'Be the first name on the board.')
        : 'Couldn’t reach the scores right now. Your run still counts on this device.';
      rows.innerHTML = `<div class="ah-lmsg">${kind === 'empty' ? I.trophy : I.offline}<b>${title}</b><p>${text}</p>${kind === 'empty' ? '' : `<button class="ah-btn ah-lretry">${I.retry}TRY AGAIN</button>`}</div>`;
      const rb = q('.ah-lretry', rows);
      if (rb) rb.addEventListener('click', () => load(scope, hl));
      if (detail) rows.firstChild.dataset.error = String(detail).slice(0, 80);
    }
    function rowEl(r, me) {
      const rank = r.rank | 0;
      const d = document.createElement('div');
      d.className = 'ah-lrow' + (rank >= 1 && rank <= 3 ? ' r' + rank : '') + (me ? ' me' : '');
      const hb = hourBadge(r.hour);
      d.innerHTML = `<div class="ah-rank ah-num">${rank || '–'}</div><div class="ah-lwho"><b></b><small></small></div><span class="ah-hbadge" style="--hb:${hb.color}">${esc(hb.label)}</span><div class="ah-lscore ah-num">${fmt(r.score)}</div>`;
      q('b', d).textContent = String(r.name == null ? '???' : r.name).slice(0, 18);
      q('small', d).textContent = r.district ? String(r.district).slice(0, 24) : '';
      return d;
    }
    function paint(list) {
      rows.textContent = '';
      let meEl = null;
      const hn = hl ? String(hl.name || '').trim().toLowerCase() : '';
      list.forEach((r, i) => {
        const row = Object.assign({ rank: i + 1 }, r);
        const me = !!hl && !meEl && String(row.name || '').trim().toLowerCase() === hn && (Number(row.score) === Number(hl.score) || (hl.rank && row.rank === hl.rank));
        const el2 = rowEl(row, me);
        el2.style.animationDelay = Math.min(i * 22, 400) + 'ms';
        rows.appendChild(el2);
        if (me) meEl = el2;
      });
      if (hl && !meEl && scope === 'all') {
        // the board may lag behind the submit: place our row at its rank (or after a gap if it's below the top list)
        meEl = rowEl({ rank: hl.rank || 0, name: hl.name, district: hl.district, hour: hl.hour, score: hl.score }, true);
        const at = hl.rank > 0 && hl.rank <= list.length ? rows.children[hl.rank - 1] : null;
        if (at) {
          rows.insertBefore(meEl, at);
          for (let i = hl.rank; i < rows.children.length; i++) {
            const rw = rows.children[i], rk = q('.ah-rank', rw);
            if (rk) rk.textContent = String(i + 1);
            rw.classList.remove('r1', 'r2', 'r3');
            if (i < 3) rw.classList.add('r' + (i + 1));
          }
          if (rows.children.length > 25) rows.lastElementChild.remove();
        } else {
          const gap = document.createElement('div'); gap.className = 'ah-lgap'; gap.textContent = '• • •';
          rows.appendChild(gap);
          rows.appendChild(meEl);
        }
      }
      if (meEl) requestAnimationFrame(() => scrollToEl(meEl));
    }
    async function load(s, hlx) {
      setTab(s || 'all');
      hl = hlx || null;
      const my = ++token;
      skeleton();
      let res;
      try { res = await withTimeout(call('lbTop', scope), 12000); } catch (e) { res = { rows: [], error: (e && e.message) || 'offline' }; }
      if (my !== token) return;
      if (!res || res.error || !Array.isArray(res.rows)) { message('err', res && res.error); return; }
      if (!res.rows.length && !hl) { message('empty'); return; }
      paint(res.rows.slice(0, 25));
    }
    return { load, el };
  }
  const lbBoard = makeBoard(R.lbSlot, {});
  function showLeaderboard(scope) { setScreen('lb'); const sc = q('.ah-lb-body'); if (sc) sc.scrollTop = 0; lbBoard.load(scope || 'all', null); }

  // ---- post-your-score component ------------------------------------------------------------------------
  function makePost(slot) {
    const el = document.createElement('div');
    el.className = 'ah-post';
    el.innerHTML = `<div class="ah-post-h">${I.trophy}<span>POST TO THE LEADERBOARD</span></div>
<div class="ah-post-form">
  <label class="ah-lbl">YOUR NAME</label>
  <input class="ah-input" type="text" maxlength="14" autocomplete="nickname" autocapitalize="characters" autocorrect="off" spellcheck="false" enterkeyhint="done" placeholder="2–14 characters" aria-label="Your name">
  <label class="ah-lbl">DISTRICT</label>
  <div class="ah-chips" role="radiogroup">${DISTRICTS.map((d) => `<button class="ah-chip" data-d="${esc(d)}" role="radio" aria-checked="false">${esc(d)}</button>`).join('')}</div>
  <button class="ah-btn ah-submit">SUBMIT SCORE</button>
  <div class="ah-post-msg" role="status"></div>
</div>
<div class="ah-post-done" hidden><div class="ah-rankline"><small>SCORE POSTED</small><b></b></div><div class="ah-board-slot"></div></div>`;
    slot.appendChild(el);
    const input = q('.ah-input', el), chipBox = q('.ah-chips', el), chips = qa('.ah-chip', el), btn = q('.ah-submit', el), msg = q('.ah-post-msg', el);
    const form = q('.ah-post-form', el), done = q('.ah-post-done', el), rankB = q('.ah-rankline b', el), head = q('.ah-post-h', el);
    const board = makeBoard(q('.ah-board-slot', el), { inline: true });
    let district = '', busy = false, posted = false, run = null;
    function setDistrict(d) {
      district = d || '';
      chips.forEach((c) => { const on = c.dataset.d === district; c.classList.toggle('on', on); c.setAttribute('aria-checked', on ? 'true' : 'false'); });
    }
    function setMsg(text, cls) { msg.textContent = text || ''; msg.className = 'ah-post-msg' + (cls ? ' ' + cls : ''); }
    function paintBtn(mode) {
      if (mode === 'busy') btn.innerHTML = '<span class="ah-spin"></span>POSTING…';
      else if (mode === 'retry') btn.innerHTML = I.retry + 'TRY AGAIN';
      else btn.innerHTML = 'SUBMIT SCORE';
    }
    chips.forEach((c) => c.addEventListener('click', () => { setDistrict(c.dataset.d); if (msg.classList.contains('err')) setMsg(''); }));
    input.addEventListener('input', () => { const s = sanitizeLive(input.value); if (s !== input.value) input.value = s; if (msg.classList.contains('err')) setMsg(''); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); submit(); } });
    input.addEventListener('blur', () => { setTimeout(() => { try { window.scrollTo(0, 0); } catch (e) { /* noop */ } rootEl.scrollTop = 0; root.scrollTop = 0; }, 60); });
    btn.addEventListener('click', submit);
    function reset(r) {
      run = r ? { score: Math.max(0, Math.round(r.score || 0)), hour: r.won && !r.overtime ? HOURS.length : (r.hour | 0), kills: r.kills | 0 } : null;
      posted = false; busy = false;
      form.hidden = false; done.hidden = true; head.hidden = false;
      el.hidden = !run || run.score <= 0;
      input.value = sessionName || profile.name || '';
      setDistrict(sessionDistrict || profile.district || '');
      btn.disabled = false; paintBtn('idle'); setMsg('');
    }
    async function submit() {
      if (busy || posted || !run) return;
      const name = sanitizeName(input.value);
      input.value = name;
      if (name.length < 2) { if (!reduced) retrigger(input, 'ah-shake'); setMsg('Name needs 2–14 letters or numbers.', 'err'); return; }
      if (!district) { if (!reduced) retrigger(chipBox, 'ah-shake'); setMsg('Pick your district.', 'err'); return; }
      busy = true; btn.disabled = true; paintBtn('busy'); setMsg('');
      sessionName = name; sessionDistrict = district; profile.name = name; profile.district = district;
      call('onProfile', { name, district });
      let res;
      try { res = await withTimeout(call('lbSubmit', { name, district, score: run.score, hour: run.hour, kills: run.kills }), 12000); }
      catch (e) { res = { ok: false, error: (e && e.message) || 'offline' }; }
      busy = false; btn.disabled = false;
      if (!res || !res.ok) {
        paintBtn('retry');
        const off = typeof navigator !== 'undefined' && navigator.onLine === false;
        setMsg(off ? 'You’re offline. Your best is saved on this device — try again when you’re back.' : 'Couldn’t reach the leaderboard. Give it another shot.', 'err');
        requestAnimationFrame(() => scrollToEl(msg));
        return;
      }
      posted = true; form.hidden = true; head.hidden = true; done.hidden = false;
      rankB.innerHTML = res.rank ? `#${fmt(res.rank)}<span>ALL-TIME</span>` : 'YOU’RE ON THE BOARD';
      buzz(20);
      board.load('all', { name, score: run.score, rank: res.rank | 0, district, hour: run.hour });
    }
    return { reset, el };
  }
  const overPost = makePost(q('.ah-post-slot', R.over));
  const winPost = makePost(q('.ah-post-slot', R.win));

  // ---- results (game over + victory) ------------------------------------------------------------------------
  let countRaf = 0;
  function countUp(el, to) {
    cancelAnimationFrame(countRaf);
    to = Math.max(0, Math.round(to || 0));
    if (reduced || to <= 0) { el.textContent = fmt(to); return; }
    const t0 = nowMs(), dur = Math.min(1600, 700 + Math.log10(to + 1) * 160);
    const step = () => {
      const k = clamp((nowMs() - t0) / dur, 0, 1);
      el.textContent = fmt(to * (1 - Math.pow(1 - k, 3)));
      if (k < 1) countRaf = requestAnimationFrame(step);
    };
    el.textContent = '0';
    countRaf = requestAnimationFrame(step);
  }
  function statsHTML(r) {
    const tile = (k, v) => `<div class="ah-stat"><small>${k}</small><b class="ah-num">${esc(v)}</b></div>`;
    return tile('TAKEDOWNS', fmt(r.kills)) + tile('BEST COMBO', fmt(r.bestCombo)) + tile('TIME ON SHIFT', mmss(r.time));
  }
  // the night as 9 pips (10 PM … 6 AM), lit up to where the run ended
  function trackHTML(r) {
    const all = !!(r.won || r.overtime);
    const reached = all ? HOURS.length : clamp(r.hour | 0, 0, HOURS.length - 1);
    let nodes = '';
    for (let i = 0; i <= HOURS.length; i++) {
      const lab = i < HOURS.length ? HOURS[i].clock.replace(' ', '') : '6AM';
      const cls = (i < reached || all ? ' done' : i === reached ? ' here' : '') + (HOURS[i] && HOURS[i].boss ? ' boss' : '') + (i === HOURS.length ? ' sun' : '');
      nodes += `<div class="ah-tn${cls}"><i></i><span>${lab}</span></div>`;
    }
    const pct = (all ? 1 : reached / HOURS.length) * 100;
    return `<div class="ah-track-rail"><i style="width:${pct.toFixed(1)}%"></i></div><div class="ah-track-nodes">${nodes}</div>`;
  }
  function paintKilled(el, r) {
    const k = r.killedBy;
    if (!k || (r.won && !r.overtime)) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    const info = KIND_INFO[k] || (k === 'spark' ? SPARK_INFO : { name: String(k).toUpperCase(), title: '', tip: '' });
    el.style.setProperty('--kc', (KIND_COLORS[k] || {}).glow || (k === 'spark' ? '#ffb547' : '#ff3b4d'));
    el.textContent = '';
    el.appendChild(portraitEl(k, r.portrait));
    const d = document.createElement('div');
    d.innerHTML = `<small>TAKEN OUT BY</small><b>${esc(info.name)}<span>${esc(info.title)}</span></b>${info.tip ? `<p><i>TIP</i>${esc(info.tip)}</p>` : ''}`;
    el.appendChild(d);
  }
  function paintUnlocks(el, ids) {
    el.textContent = '';
    (ids || []).forEach((id) => {
      const o = OUTFITS.find((x) => x.id === id);
      if (!o) return;
      const d = document.createElement('div');
      d.className = 'ah-unl';
      const wearing = profile.outfit === o.id;
      d.innerHTML = `${jacketSVG(o)}<div><small>OUTFIT UNLOCKED</small><b>${esc(o.name)}</b></div><button class="ah-btn${wearing ? ' done' : ''}">${wearing ? I.check + 'WEARING' : 'WEAR IT'}</button>`;
      const b = q('button', d);
      b.addEventListener('click', () => { if (profile.outfit === o.id) return; profile.outfit = o.id; call('onOutfit', o.id); qa('.ah-unl button', el).forEach((x) => { x.classList.remove('done'); x.textContent = 'WEAR IT'; }); b.innerHTML = I.check + 'WEARING'; b.classList.add('done'); });
      el.appendChild(d);
    });
    el.hidden = !el.childElementCount;
  }
  function confetti(host) {
    if (reduced) return;
    const box = document.createElement('div');
    box.className = 'ah-confetti';
    const cols = ['#ffd35a', '#3ee8ff', '#ff3ec8', '#8f6bff', '#ffffff', '#ffb547'];
    let hs = '';
    for (let i = 0; i < 36; i++) {
      hs += `<i style="left:${(Math.random() * 100).toFixed(1)}%;--cc:${cols[i % cols.length]};--d:${(1.9 + Math.random() * 1.5).toFixed(2)}s;--dl:${(0.35 + Math.random() * 0.9).toFixed(2)}s;--dx:${((Math.random() - 0.5) * 170).toFixed(0)}px;--r:${(Math.random() * 1000 - 500).toFixed(0)}deg;width:${(6 + Math.random() * 5) | 0}px;height:${(9 + Math.random() * 8) | 0}px"></i>`;
    }
    box.innerHTML = hs;
    host.appendChild(box);
    setTimeout(() => box.remove(), 4400);
  }
  function paintResult(scr, r) {
    const isBest = !!r.isBest && (r.score | 0) > 0;
    scr.classList.toggle('is-best', isBest);
    countUp(q('.ah-bigscore', scr), r.score);
    const prev = q('.ah-prevbest', scr);
    prev.textContent = isBest ? (profile.best > 0 && profile.best !== r.score ? '' : '') : profile.best > 0 ? 'PERSONAL BEST ' + fmt(Math.max(profile.best, 0)) : '';
    q('.ah-stats', scr).innerHTML = statsHTML(r);
    const tk = q('.ah-track', scr);
    tk.innerHTML = trackHTML(r);
    tk.classList.toggle('won', !!(r.won || r.overtime));
    paintUnlocks(q('.ah-unls', scr), profile.newUnlocks);
    if (isBest) confetti(scr);
    const sc = q('.ah-sheet', scr); if (sc) sc.scrollTop = 0;
  }
  q('.ah-over-retry').addEventListener('click', () => call('onRetry'));
  q('.ah-over-menu').addEventListener('click', () => call('onQuit'));
  q('.ah-win-again').addEventListener('click', () => call('onRetry'));
  q('.ah-win-menu').addEventListener('click', () => call('onQuit'));
  q('.ah-clockout').addEventListener('click', () => {
    if (R.win.classList.contains('clocked')) return;
    R.win.classList.add('clocked');
    call('onClockOut');
    const slot = q('.ah-post-slot', R.win);
    requestAnimationFrame(() => scrollToEl(slot));
  });
  q('.ah-double').addEventListener('click', () => call('onOvertime'));

  function showGameOver(result, prof) {
    if (prof) profile = normProfile(prof);
    const r = result || {};
    clearCards(); hideBanner(true);
    let sub;
    if (r.overtime) sub = `${r.clock || ''} · OVERTIME`;
    else { const H0 = HOURS[clamp(r.hour | 0, 0, HOURS.length - 1)]; sub = `${r.clock || H0.clock} · ${H0.name}`; }
    q('.ah-punch-t', R.over).textContent = sub.replace(/^ · /, '');
    q('.ah-over-h', R.over).textContent = 'CLOCKED OUT';
    paintResult(R.over, r);
    paintKilled(q('.ah-killed', R.over), r);
    overPost.reset(r);
    setScreen('over');
  }
  function showVictory(result, prof) {
    if (prof) profile = normProfile(prof);
    const r = Object.assign({ won: true }, result || {});
    clearCards(); hideBanner(true);
    R.win.classList.remove('clocked');
    paintResult(R.win, r);
    winPost.reset(Object.assign({}, r, { won: true, overtime: false }));
    setScreen('win');
  }

  // ---- pause -------------------------------------------------------------------------------------------------
  function showPause() {
    if (screen !== 'play' && screen !== 'pause') return;
    const s = lastState;
    R.pzScore.textContent = fmt(s ? s.score : 0);
    R.pzClock.textContent = s && s.clock ? s.clock : '—';
    setScreen('pause');
  }
  function hidePause() { if (screen === 'pause') { setScreen('play'); measure(); } }
  function userPause() { if (screen !== 'play') return; showPause(); call('onPause', true); }
  function userResume() { if (screen !== 'pause') return; hidePause(); call('onPause', false); }
  R.pz.addEventListener('click', (e) => { e.preventDefault(); userPause(); });
  R.pz.addEventListener('pointerdown', (e) => e.stopPropagation());
  q('.ah-resume').addEventListener('click', userResume);
  q('.ah-restart').addEventListener('click', () => call('onRetry'));
  q('.ah-quit').addEventListener('click', () => call('onQuit'));

  // ---- playing ------------------------------------------------------------------------------------------------
  function showPlaying() {
    // NB: cards are NOT cleared here — main may have drained sim.start()'s 'start'/'hour' events
    // before calling showPlaying(); the 'start' event and the leave-run screens do the clearing.
    const continuing = screen === 'pause' || screen === 'win';
    if (!continuing) root.classList.remove('ah-stick-used');
    resetHud();
    clearInputs();
    cdKnown = false;
    setScreen('play');
    measure();
    if (!touchUI && !reduced) { R.keys.style.animation = 'none'; void R.keys.offsetWidth; R.keys.style.animation = ''; }
  }

  // ---- locker -------------------------------------------------------------------------------------------------
  function isUnlocked(o) { return !o.unlock || (profile.unlocked || []).indexOf(o.id) >= 0; }
  function paintLockerName(o) {
    const un = isUnlocked(o);
    R.lkName.textContent = o.name;
    R.lkStat.textContent = un ? (profile.outfit === o.id ? 'EQUIPPED' : 'UNLOCKED') : 'LOCKED · ' + o.unlock.label.toUpperCase();
    R.lkStat.classList.toggle('lock', !un);
  }
  function paintLocker() {
    R.lkList.textContent = '';
    let count = 0;
    OUTFITS.forEach((o) => {
      const un = isUnlocked(o);
      if (un) count++;
      const sel = profile.outfit === o.id;
      const b = document.createElement('button');
      b.className = 'ah-oc' + (un ? '' : ' locked') + (sel ? ' sel' : '');
      b.dataset.id = o.id;
      b.innerHTML = `${jacketSVG(o)}${un ? '' : `<span class="ah-lock">${I.lock}</span>`}<b>${esc(o.name)}</b><div class="ah-sw3"><i style="background:${o.jacket}"></i><i style="background:${o.accent}"></i><i style="background:${o.trim}"></i></div><small>${un ? (sel ? 'EQUIPPED' : 'TAP TO WEAR') : esc(o.unlock.label.toUpperCase())}</small>`;
      b.addEventListener('click', () => pickOutfit(o, b));
      R.lkList.appendChild(b);
    });
    R.lkCount.textContent = `${count}/${OUTFITS.length}`;
    paintLockerName(OUTFITS.find((o) => o.id === profile.outfit) || OUTFITS[0]);
  }
  function pickOutfit(o, b) {
    paintLockerName(o);
    if (!isUnlocked(o)) { if (!reduced) retrigger(b, 'nope'); buzz(25); return; }
    if (profile.outfit !== o.id) { profile.outfit = o.id; call('onOutfit', o.id); }
    qa('.ah-oc', R.lkList).forEach((x) => {
      const sel = x.dataset.id === o.id;
      x.classList.toggle('sel', sel);
      const oo = OUTFITS.find((y) => y.id === x.dataset.id);
      if (oo && isUnlocked(oo)) q('small', x).textContent = sel ? 'EQUIPPED' : 'TAP TO WEAR';
    });
    paintLockerName(o);
  }
  function showLocker() {
    paintLocker();
    setScreen('locker');
    const sel = q('.ah-oc.sel', R.lkList);
    if (sel) {
      const lr = R.lkList.getBoundingClientRect(), sr = sel.getBoundingClientRect();
      R.lkList.scrollLeft = Math.max(0, R.lkList.scrollLeft + (sr.left - lr.left) - (lr.width - sr.width) / 2);
    }
  }

  // ---- assets --------------------------------------------------------------------------------------------------
  function setAssets(A) {
    if (!A) return;
    if ('title' in A) assets.title = A.title || null;
    if ('titleWide' in A) assets.titleWide = A.titleWide || null;
    if (A.portraits) assets.portraits = Object.assign({}, assets.portraits, A.portraits);
    if (assets.title) {
      R.titleArt.style.setProperty('--art-p', `url("${assets.title}")`);
      R.titleArt.style.setProperty('--art-l', `url("${assets.titleWide || assets.title}")`);
      R.title.classList.add('has-art');
    } else { R.titleArt.style.removeProperty('--art-p'); R.titleArt.style.removeProperty('--art-l'); R.title.classList.remove('has-art'); }
  }

  function destroy() {
    window.removeEventListener('resize', onResize);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('gamepadconnected', onPadConnect);
    document.removeEventListener('touchmove', onTouchMove);
    document.removeEventListener('gesturestart', onGesture);
    document.removeEventListener('gesturechange', onGesture);
    document.removeEventListener('dblclick', onDbl);
    document.removeEventListener('contextmenu', onCtx);
    document.removeEventListener('selectstart', onSel);
    document.removeEventListener('visibilitychange', onVis);
    clearInterval(padTimer); cancelAnimationFrame(countRaf); clearTimeout(bannerFallback);
    root.remove(); rootEl.classList.remove('ah-host');
  }

  measure();
  paintSound();

  return {
    showTitle, showPlaying, hud, event, showPause, hidePause, showGameOver, showVictory,
    readInput, setAssets, threatArrows,
    // extras
    showLeaderboard, showLocker, showHow, toast, destroy,
    setSound(on) { soundOn = !!on; profile.sound = soundOn; paintSound(); },
    get screen() { return screen; },
    get root() { return root; },
  };
}
