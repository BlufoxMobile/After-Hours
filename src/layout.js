// =====================================================================================
// AFTER HOURS 3D — SHARED DATA (read-only for every module; owned by the integrator)
// Units: METRES. World axes: +X = screen right, +Z = toward the camera (screen DOWN),
// +Y = up. The camera sits on the +Z side looking toward -Z, pitched down.
// Facing convention everywhere: an angle `a` means forward = (sin a, 0, cos a), which is
// exactly three.js `object.rotation.y = a` for a model BUILT FACING +Z.
// =====================================================================================

// Playable rectangle for the fox and for enemy CENTRES (enemies may overlap edges by r).
export const ARENA = { minX: -6.3, maxX: 6.3, minZ: -9.4, maxZ: 10.2 };

// The visible room shell (visual only; outside ARENA). Back wall at -Z (top of screen).
export const ROOM = {
  wallX: 7.2,          // side walls at x = ±7.2 (phone display walls live against them)
  backZ: -11.0,        // back wall (big C³ neon, service counter, backroom door)
  frontZ: 11.4,        // glass storefront + entrance (nearest the camera; keep it LOW / cut-away)
  ceilingY: 4.6,
};

// Solid fixtures inside the arena. Everything collides with these (fox, enemies, shots may pass
// over tables — see `shotsPass`). 'box' = axis-aligned: centre (x,z), half-extents (hw,hd), height h.
export const FIXTURES = [
  // Four "experience tables" — modems sit on display on top; they wake up and hop off.
  { id: 'tNW', type: 'box', x: -3.4, z: -4.6, hw: 1.25, hd: 0.62, h: 0.92, role: 'modemTable', shotsPass: true },
  { id: 'tNE', type: 'box', x:  3.4, z: -4.6, hw: 1.25, hd: 0.62, h: 0.92, role: 'modemTable', shotsPass: true },
  { id: 'tSW', type: 'box', x: -3.4, z:  3.6, hw: 1.25, hd: 0.62, h: 0.92, role: 'modemTable', shotsPass: true },
  { id: 'tSE', type: 'box', x:  3.4, z:  3.6, hw: 1.25, hd: 0.62, h: 0.92, role: 'modemTable', shotsPass: true },
  // Round demo-kiosk pillar in the middle (floor-to-ceiling column wrapped in screens). Blocks shots.
  { id: 'kiosk', type: 'circle', x: 0, z: -0.5, r: 0.78, h: 4.6, role: 'kiosk', shotsPass: false },
  // Service counter against the back wall (the fox cannot get behind it).
  { id: 'counter', type: 'box', x: 0, z: -10.05, hw: 3.3, hd: 0.7, h: 1.05, role: 'counter', shotsPass: true },
];

// Where enemies "come alive". Each point is a PERCH (x,y,z) on a display plus a floor LANDING
// spot (lx,lz) inside the arena. Spawn animation = dormant on the perch -> LEDs/eyes power on ->
// hop down to the landing spot. `for` says which families use the point.
export const SPAWNS = [
  // modem tables: 3 display slots each, perched on the table top (y = 0.92)
  ...['tNW', 'tNE', 'tSW', 'tSE'].flatMap((fid) => {
    const f = FIXTURES.find((q) => q.id === fid);
    const side = f.z < 0 ? -1 : 1; // hop toward the centre aisle (z = -0.5)
    return [-0.8, 0, 0.8].map((dx, i) => ({
      id: `${fid}_${i}`, for: 'modem', fixture: fid,
      x: f.x + dx, y: f.h, z: f.z,
      lx: f.x + dx * 1.1, lz: f.z - side * 1.35,
    }));
  }),
  // phone walls: phones stand in wall docks at y = 1.15 against both side walls and hop in
  ...[-7.4, -4.0, -0.6, 2.8, 6.2].flatMap((z, i) => [
    { id: `pwL${i}`, for: 'phone', fixture: 'wallL', x: -6.85, y: 1.15, z, lx: -5.4, lz: z },
    { id: `pwR${i}`, for: 'phone', fixture: 'wallR', x:  6.85, y: 1.15, z, lx:  5.4, lz: z },
  ]),
  // back-room door (top-right of the back wall) and the front entrance (bottom, near camera)
  { id: 'backroom', for: 'any', fixture: 'door', x: 5.0, y: 0, z: -10.6, lx: 5.0, lz: -8.6 },
  { id: 'front',    for: 'any', fixture: 'entrance', x: 0, y: 0, z: 11.2, lx: 0, lz: 9.4 },
];

export const PLAYER_START = { x: 0, z: 6.5 };

// Visual/physical size of every enemy kind. `r` = collision radius used by the SIM,
// `h` = rough model height the visual module must build to. These are FIXED — visuals build
// to them and the sim collides with them, so they always agree. Elites render at scale 1.25
// (and the sim uses r * 1.25 for them).
export const KIND_DIMS = {
  xb6:  { r: 0.42, h: 0.95, family: 'modem' },
  xb3:  { r: 0.50, h: 1.15, family: 'modem' },
  xb7:  { r: 0.46, h: 1.00, family: 'modem' },
  xb8:  { r: 0.44, h: 1.25, family: 'modem' },
  xb10: { r: 0.52, h: 1.15, family: 'modem' },
  pod:  { r: 0.26, h: 0.45, family: 'modem' },
  iphone: { r: 0.44, h: 1.30, family: 'phone' },
  galaxy: { r: 0.44, h: 1.35, family: 'phone' },
  fold:   { r: 0.60, h: 1.30, family: 'phone' },
  boss_gateway:  { r: 1.55, h: 4.2, family: 'modem', boss: true },
  boss_flagship: { r: 1.65, h: 4.5, family: 'phone', boss: true },
};

// Display names + one-line tells (UI uses these for "NEW THREAT" cards and the game-over screen).
export const KIND_INFO = {
  xb6:  { name: 'XB6',  title: 'THE GRUNT',       tip: 'Hops at you in packs. Keep moving.' },
  xb3:  { name: 'XB3',  title: 'THE OLD-TIMER',   tip: 'Slow and tough. Its stomp sends a shockwave.' },
  xb7:  { name: 'XB7',  title: 'THE CHARGER',     tip: 'Glows red, then rockets straight. Sidestep!' },
  xb8:  { name: 'XB8',  title: 'THE BROADCASTER', tip: 'Hangs back and fires Wi-Fi waves.' },
  xb10: { name: 'XB10', title: 'THE COMMANDER',   tip: 'Deploys xFi Pods. Pops into more when it dies.' },
  pod:  { name: 'xFi POD', title: 'THE SWARM',    tip: 'Tiny, fast, fragile.' },
  iphone: { name: 'iPHONE', title: 'THE FLIPPER',  tip: 'Crouches, then flips onto your spot.' },
  galaxy: { name: 'GALAXY', title: 'THE SNIPER',   tip: 'Laser sight first — then the shot. Move off the line.' },
  fold:   { name: 'FOLD',   title: 'THE CHOMPER',  tip: 'Opens wide and lunges. Do not stand in front.' },
  boss_gateway:  { name: 'GIGA GATEWAY', title: 'MIDNIGHT BOSS', tip: 'Dash through the gaps in its Wi-Fi rings.' },
  boss_flagship: { name: 'THE FLAGSHIP', title: '4 AM BOSS',     tip: 'Watch the screen. When it folds, get out from under it.' },
};

// Signature colours per kind — used by FX for debris/sparks and by UI accents.
// body = main shell colour, glow = emissive face/LED colour.
export const KIND_COLORS = {
  xb6:  { body: '#e9edf5', trim: '#1b1f2a', glow: '#b44dff' },
  xb3:  { body: '#16181f', trim: '#3a3f4d', glow: '#ff9a2e' },
  xb7:  { body: '#f2f4f8', trim: '#23262f', glow: '#ff3b3b' },
  xb8:  { body: '#fbfbfd', trim: '#c9ced8', glow: '#35e7ff' },
  xb10: { body: '#2a2d35', trim: '#8f96a6', glow: '#ffd23e' },
  pod:  { body: '#f5f6fa', trim: '#aeb4c2', glow: '#6dffb0' },
  iphone: { body: '#3b3f4a', trim: '#c7ccd6', glow: '#4da3ff' },
  galaxy: { body: '#1d2233', trim: '#8da0c8', glow: '#ff3ec8' },
  fold:   { body: '#2b2438', trim: '#b8a8d8', glow: '#9dff4d' },
  boss_gateway:  { body: '#1f2230', trim: '#9aa3b8', glow: '#ffd23e' },
  boss_flagship: { body: '#121521', trim: '#c9d2ea', glow: '#ff3ec8' },
};

// The night. Each hour is a stage. Boss hours have no `dur` — they last until the boss dies.
// `roster` = kinds that may spawn this hour (the SIM owns weights/pacing). `mood` drives lighting
// (world), music (audio) and colour accents (ui).
export const HOURS = [
  { clock: '10 PM', name: 'LIGHTS OUT',          dur: 35, roster: ['xb6', 'xb3'],                               mood: 'close' },
  { clock: '11 PM', name: 'REBOOT',              dur: 35, roster: ['xb6', 'xb3', 'xb7', 'xb8'],                 mood: 'night' },
  { clock: '12 AM', name: 'GIGA GATEWAY',        boss: 'boss_gateway', roster: ['xb6', 'pod'],                  mood: 'boss' },
  { clock: '1 AM',  name: 'MESH NETWORK',        dur: 38, roster: ['xb6', 'xb3', 'xb7', 'xb8', 'xb10', 'pod'],  mood: 'mesh' },
  { clock: '2 AM',  name: 'THE PHONES WAKE UP',  dur: 40, roster: ['iphone', 'galaxy', 'xb6', 'xb7'],           mood: 'phones' },
  { clock: '3 AM',  name: 'DEAD ZONE',           dur: 40, roster: ['iphone', 'galaxy', 'fold', 'xb8', 'xb10', 'pod'], mood: 'deadzone' },
  { clock: '4 AM',  name: 'THE FLAGSHIP',        boss: 'boss_flagship', roster: ['iphone', 'galaxy'],           mood: 'boss2' },
  { clock: '5 AM',  name: 'LAST CALL',           dur: 45, roster: ['xb6', 'xb3', 'xb7', 'xb8', 'xb10', 'pod', 'iphone', 'galaxy', 'fold'], mood: 'dawn' },
];
// After the last hour: SUNRISE (6 AM) = victory. Player may then "PULL A DOUBLE" (endless overtime,
// mood 'overtime', every roster kind, escalating) — see CONTRACT.md.

// The auto-levelling gun (ported from the 2D game). m = bolts per volley, f = seconds between
// volleys, p = pierce count, sp = fan spread (radians between bolts), w = visual thickness hint.
export const WEAPONS = [
  { n: 'SERVICE BOLT', m: 1, d: 1, f: 0.42, p: 0, sp: 0.00, w: 1.0, c: '#8df3ff' },
  { n: 'RAPID COIL',   m: 1, d: 1, f: 0.34, p: 0, sp: 0.00, w: 1.1, c: '#8df3ff' },
  { n: 'TWIN BOLTS',   m: 2, d: 1, f: 0.40, p: 0, sp: 0.13, w: 1.2, c: '#9ef7ff' },
  { n: 'PIERCE CORE',  m: 2, d: 1, f: 0.34, p: 1, sp: 0.13, w: 1.3, c: '#b6f2ff' },
  { n: 'TRI-BEAM',     m: 3, d: 1, f: 0.38, p: 1, sp: 0.16, w: 1.4, c: '#c9ecff' },
  { n: 'SURGE LANCE',  m: 3, d: 1, f: 0.30, p: 2, sp: 0.16, w: 1.6, c: '#dbe6ff' },
  { n: 'QUAD ARC',     m: 4, d: 1, f: 0.30, p: 2, sp: 0.18, w: 1.7, c: '#eadcff' },
  { n: 'FIBER STORM',  m: 5, d: 1, f: 0.26, p: 3, sp: 0.20, w: 1.9, c: '#ffd9f4' },
];

// Power drops. fam colours: wep cyan / body green / util violet / nrg amber (timed buffs).
export const PICKUP_FAMILIES = {
  wep:  { color: '#7ef0ff', label: 'WEAPON' },
  body: { color: '#8dff9e', label: 'BODY' },
  util: { color: '#c3a4ff', label: 'UTILITY' },
  nrg:  { color: '#ffc24a', label: 'BOOST' },
};
export const PICKUPS = {
  slug:  { name: 'HEAVY SLUG',   fam: 'wep',  icon: 'dmg' },
  clock: { name: 'OVERCLOCK',    fam: 'wep',  icon: 'rate' },
  split: { name: 'SPLIT SHOT',   fam: 'wep',  icon: 'multi' },
  pier:  { name: 'PIERCE CORE+', fam: 'wep',  icon: 'pierce' },
  rein:  { name: 'REINFORCED',   fam: 'body', icon: 'armor' },
  wind:  { name: 'SECOND WIND',  fam: 'body', icon: 'heal' },
  feet:  { name: 'QUICK FEET',   fam: 'util', icon: 'dash' },
  cap:   { name: 'CAPACITOR',    fam: 'util', icon: 'pulse' },
  field: { name: 'STATIC FIELD', fam: 'util', icon: 'aura' },
  scav:  { name: 'SCAVENGER',    fam: 'util', icon: 'gem' },
  nrg:   { name: 'ENERGY BOOST', fam: 'nrg',  icon: 'bolt' },
  shld:  { name: 'OVERSHIELD',   fam: 'nrg',  icon: 'ward' },
  vac:   { name: 'MAG SURGE',    fam: 'nrg',  icon: 'mag' },
};

// Fox outfits (cosmetic unlocks — the "come back tomorrow" hook). The fox model reads the colours;
// the UI shows the lock state from the saved profile (see CONTRACT.md: profile).
export const OUTFITS = [
  { id: 'bomber',   name: 'ORANGE BOMBER', jacket: '#ff8a1f', accent: '#1b2a4a', trim: '#ffd08a', unlock: null },
  { id: 'c3',       name: 'C³ PURPLE',     jacket: '#7b3fe4', accent: '#15102b', trim: '#ffb547', unlock: { type: 'hour', value: 3, label: 'Survive to 1 AM' } },
  { id: 'midnight', name: 'MIDNIGHT',      jacket: '#1a1d29', accent: '#3ee8ff', trim: '#3ee8ff', unlock: { type: 'kills', value: 500, label: '500 lifetime takedowns' } },
  { id: 'neon',     name: 'NEON RUNNER',   jacket: '#29f08a', accent: '#0d2a1c', trim: '#eaff5a', unlock: { type: 'hour', value: 5, label: 'Survive to 3 AM' } },
  { id: 'gold',     name: 'GOLDEN HOUR',   jacket: '#ffcc33', accent: '#3a2400', trim: '#fff4c2', unlock: { type: 'win', value: 1, label: 'Make it to sunrise' } },
];

// Brand palette (store mood, UI).
export const PALETTE = {
  ink: '#05070f', navy: '#070d21', c3purple: '#7b3fe4', cyan: '#3ee8ff', magenta: '#ff3ec8',
  amber: '#ffb547', foxBlue: '#1f6bff', foxBlueLight: '#5aa2ff', white: '#f4f7ff', danger: '#ff3b4d',
};

export const DISTRICTS = ['North Side', 'South Side', 'East Side', 'West Side', 'Big South'];
