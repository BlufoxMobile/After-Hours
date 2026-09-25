# AFTER HOURS 3D — MODULE CONTRACT

"After Hours" is an arcade survival shooter for Blufox Mobile employees (Blufox is an Xfinity
authorized retailer). You play a **blue fox** trapped in an Xfinity store after closing. The
store's **modems come alive** (XB3, XB6, XB7, XB8, XB10 + tiny xFi Pods) and later the
**phones on the display walls wake up** (iPhone-style and Galaxy-style phones, plus a Fold) and
hunt the fox. Survive the night, 10 PM → 6 AM sunrise, with two bosses (GIGA GATEWAY at
midnight, THE FLAGSHIP at 4 AM).

The previous version was a flat 2D canvas game (`/home/claude/ah/code.html` — 2D source,
reference only). This is a **full 3D rebuild with three.js r186** that must look and feel
**AAA / premium-mobile quality**: think Brawl Stars / Archero / Vampire Survivors 3D polish —
chunky readable characters, gorgeous neon night lighting, juicy hit feedback, buttery 60 fps
on a mid-range phone. The owner rejected an earlier hand-rolled WebGL game as looking like
"Atari"; what he loved was three.js with image-based lighting, antialiasing, ACES tonemapping,
tasteful bloom and a vignette. **Do not over-process** (no motion blur / chromatic aberration
soup). Clean, rich, readable.

Primary platform: **phones in PORTRAIT** (390×844 CSS px typical, DPR 3). Must also work in
landscape and on desktop. One self-contained HTML file, zero network requests at runtime.

---------------------------------------------------------------------------------------------

## 0. Ground rules for every module

* ES module in `src/`, `import * as THREE from 'three'` (and `three/addons/...` if needed).
  Bundled by esbuild into ONE file. No other npm packages. No network, no external fonts
  (use `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` stacks or draw text to canvas).
* `src/layout.js` is the shared data file (arena, fixtures, spawn points, kind sizes/colours,
  hours, weapons, pickups, outfits). **Read it. Never edit it.** If you need a change, say so
  in your final report.
* Write ONLY the files you own (listed in your brief) plus anything under `scratch/<yourname>/`.
  Other agents are working in the same tree at the same time.
* Coordinates are METRES. +X = screen right, +Z = toward camera (screen down), +Y up.
  Facing angle `a` ⇒ forward vector `(sin a, 0, cos a)` ⇒ `object.rotation.y = a` for a model
  **built facing +Z**. Build every character facing +Z.
* Time: every `update/sync` takes `(…, t, dt)` in SECONDS. Never read `performance.now()` for
  animation (the integrator applies hit-stop / slow-mo by scaling dt). Clamp `dt` ≤ 0.05.
* Performance budget (whole frame, mid phone): ≤ ~150 draw calls, ≤ ~250k triangles, one
  shadow-casting light at most. Up to **70 enemies + 120 projectiles + 300 particles** on screen
  at once. **Use InstancedMesh** for anything that can appear many times. Share geometries and
  materials; never allocate per frame (no `new THREE.Vector3()` inside update loops — reuse
  scratch objects).
* Readability first: a normal enemy is only ~40–60 px tall on a phone. Chunky silhouettes, big
  glowing faces/LEDs, a distinct colour per kind (`KIND_COLORS`), strong rim/back light.
* Linear workflow: renderer output is sRGB with ACES tonemapping; colours you pass to materials
  as hex are sRGB (three handles conversion). Emissive "neon" should be bright enough to trip
  bloom (luminance > ~1.0 after emissiveIntensity) but NOT so bright it blows out — additive
  particles stacking 20 deep must not turn the screen white.
* Quality tiers: integer `q` 0 (low) … 3 (ultra). Every visual module exposes `setQuality(q)`.
  q0 must be safe for a 4-year-old Android phone.
* Self-test headlessly and **LOOK at your own screenshots** (Read the PNG). The screenshot-and-
  look loop is what produces quality; assertions alone ship bugs you can't see.
  - `node tools/bundle.mjs <entry.js> <out.html>` → single HTML with three bundled.
  - `node tools/shot.mjs <file.html> <out.png> --w 390 --h 844 --wait 4000 [--eval JS] [--evalAfter JS]`
    → headless Chromium with SwiftShader WebGL; prints console errors. SwiftShader renders
    ~2–8 fps, so do NOT depend on rAF cadence for animation checks: expose a
    `window.__step(t)` hook in your harness that poses everything at time t and renders once.
  - Run tools from `/home/claude/ah/proj` (node_modules lives there).
* Finish with a short report: files written, exact public API (signatures), what you verified
  (with screenshot paths), known issues, and anything you need from other modules.

---------------------------------------------------------------------------------------------

## 1. Module map

| file | owner | job |
|---|---|---|
| `src/layout.js` | integrator | shared data (read-only) |
| `src/gfx.js` | WORLD agent | renderer, camera rig, post chain, quality tiers, frame pacer |
| `src/world.js` | WORLD agent | the 3D Xfinity store: room, fixtures, lighting, IBL, hour moods |
| `src/fox.js` | FOX agent | the blue fox hero model + all its animation |
| `src/modems.js` | MODEMS agent | XB3/XB6/XB7/XB8/XB10/pod crowds + GIGA GATEWAY boss visuals |
| `src/phones.js` | PHONES agent | iphone/galaxy/fold crowds + THE FLAGSHIP boss visuals |
| `src/fx.js` | FX agent | projectiles, enemy shots, telegraphs, pickups, particles, damage numbers, shake |
| `src/sim.js` | SIM agent | ALL gameplay rules. Pure JS, no three, no DOM. Runs in node. |
| `src/ui.js`, `src/ui.css` | UI agent | every DOM screen, HUD, touch/keyboard input |
| `src/audio.js` | AUDIO agent | procedural WebAudio music + SFX |
| `src/main.js`, `src/lb.js`, `src/assets.js`, `shell.html`, `build.py` | integrator | wiring, leaderboard client, art |

---------------------------------------------------------------------------------------------

## 2. The simulation state (produced by `sim.js`, read by everyone else)

The sim is the single source of truth. Visual modules only READ these objects (never mutate).
Arrays are rebuilt/compacted by the sim; identify things by `id` (monotonic integers, never reused).

```js
sim.state = {
  phase: 'play' | 'bossIntro' | 'dead' | 'won' | 'overtime',
  t: 0,               // seconds of play since run start (excludes pauses)
  hour: 0,            // index into HOURS (8 = overtime)
  hourT: 0,           // seconds into the current hour
  hourDur: 35,        // null during a boss hour
  clock: '10:42 PM',  // display clock for the HUD
  mood: 'close',      // HOURS[hour].mood, or 'overtime'
  score: 0, kills: 0, combo: 0, mult: 1, bestCombo: 0,
  player: {
    x, z, face,        // movement facing (radians, convention above)
    aim,               // gun/aim facing (radians) — upper body turns to this
    spd,               // current ground speed m/s (for run-cycle rate)
    moving: bool,
    firing: bool,      // a volley fired THIS step
    dashT,             // >0 while dashing (seconds left)
    inv,               // i-frame seconds left (blink the fox while > 0 and not dashing)
    hurtT,             // 0..1 recent-damage flash (decays)
    hp, maxHp,
    od, odT,           // overdrive meter 0..1; odT > 0 while OVERDRIVE is active
    shieldT,           // > 0 while OVERSHIELD buff is active
    buffs: { rapid, shield, vac },  // seconds left on timed buffs
    wTier, wName,      // weapon tier index / name (WEAPONS)
    xp, xpNext,        // progress to next weapon tier
    dashCD, dashCDMax, pulseCD, pulseCDMax,
    aura,              // STATIC FIELD level 0..3 (visual ring radius ~ 1.2 + 0.5*aura m)
    alive: bool,
  },
  enemies: [ {
    id, kind,          // kind ∈ KIND_DIMS keys
    x, y, z,           // y = height off the floor (spawn hops, phone leaps, boss jumps). usually 0
    face,              // radians
    r,                 // collision radius (KIND_DIMS r, ×1.25 if elite)
    spd,               // current speed m/s (drives walk/hop cycle rate)
    state: 'spawn' | 'move' | 'windup' | 'attack' | 'recover' | 'stun' | 'dying',
    stateT, stateDur,  // seconds into state / planned length of state (progress = stateT/stateDur)
    attack,            // name of the current/last attack (bosses + multi-attack kinds), e.g. 'charge','stomp','wave','leap','snipe','chomp','deploy','rings','slam','summon','spin','spray','sweep','fold'
    flash,             // 0..1 hit flash (white), decays fast
    elite: bool,       // gold-ringed elite: render at scale 1.25 with a gold rim/halo
    hp, maxHp,
    boss: bool, phase, // bosses: phase 1..3
    spawnFrom,         // during 'spawn': {x,y,z} perch it woke on (SPAWNS entry), else null
  } ],
  pshots: [ { id, x, z, vx, vz, tier, pierce, big: bool /* overdrive bolts */ } ],   // player bolts, fly at y≈0.8
  eshots: [ {
    id, type,          // 'orb' | 'bolt' | 'wave' | 'ring' | 'notif'
    x, z, vx, vz, r,   // orb/bolt/notif: position, velocity, radius
    // wave: an expanding Wi-Fi arc — centre (x,z), current radius `R`, half-angle `half`, heading `a`, band width `w`
    // ring: an expanding full circle — centre (x,z), radius `R`, width `w`, optional gap: {a, half} (a safe opening)
    R, w, a, half, gap,
    t, life,           // age / max age (seconds)
    color,             // hex string hint
  } ],
  hazards: [ {
    id, type,          // 'spark' (ceiling spark strike, circle) | 'slam' (landing zone, circle) | 'beam' (line) | 'shock' (stomp ring, circle) | 'fold' (rectangle)
    x, z, r,           // circle hazards
    x2, z2, w,         // beam: from (x,z) to (x2,z2), width w
    hw, hd, a,         // fold rectangle: centre (x,z), half extents, rotation a
    warn, warnDur,     // telegraph seconds left / total. Hazard is harmless while warn > 0
    live, liveDur,     // after warn hits 0: seconds of active damage left / total
    src,               // enemy id that owns it (or 0 for environment)
  } ],
  pickups: [ {
    id, type,          // 'gem' (XP chip) | 'heart' | 'orb' (power drop)
    pup,               // for orbs: key into PICKUPS
    fam,               // for orbs: PICKUP_FAMILIES key
    x, z, t, life,     // age / collection window (orbs and hearts expire; blink in last 2 s)
    value,             // gems: xp value (bigger = bigger chip)
  } ],
  boss: null | { id, kind, name, hp, maxHp, phase },
};
sim.events  // array of events emitted during the last step() — see §3. Integrator drains it.
```

### Sim API
```js
import { createSim } from './sim.js';
const sim = createSim({ seed?: number });
sim.start();                          // fresh run at 10 PM
sim.step(dt, input);                  // input = { mx, mz, dash: bool, pulse: bool }
                                      //   (mx,mz) ∈ unit disc, screen-space move: +mx right, +mz DOWN-screen(+Z)
                                      //   dash/pulse are EDGE-triggered (true for one step when pressed)
sim.drain() -> events[]               // returns and clears sim.events
sim.continueOvertime();               // after 'won': keep playing endless overtime (score continues)
sim.result() -> { score, kills, bestCombo, hour, clock, won: bool, overtime: bool, killedBy: kind|null, time }
sim.debug = { god: false, skipTo(hourIndex) }   // for tests
```

---------------------------------------------------------------------------------------------

## 3. Events (sim → fx / audio / ui / world / main)

Every event is `{ type, ...fields }`. Positions are world metres. Consumers ignore types they don't use.

| type | fields | meaning |
|---|---|---|
| `start` | | run began |
| `hour` | `hour, name, clock, boss?` | a new hour started (hour 0 fires on start) |
| `newThreat` | `kind` | first time this kind appears this run (UI shows a small intro card) |
| `spawn` | `id, kind, x, y, z, elite` | enemy began waking up (at its perch) |
| `land` | `id, kind, x, z` | enemy finished its spawn hop and landed |
| `shot` | `x, z, a, tier, count` | player volley fired (a = aim angle) |
| `hit` | `id, kind, x, y, z, dmg, crit, killed` | player damage landed on an enemy |
| `kill` | `id, kind, x, y, z, face, elite, points, combo, mult` | enemy destroyed |
| `enemyShot` | `kind, shotType, x, z` | enemy fired (sfx) |
| `windup` | `id, kind, attack, x, z` | enemy began a telegraph |
| `attack` | `id, kind, attack, x, z` | enemy attack released |
| `hazardWarn` / `hazardLive` | `id, type, x, z` | telegraph started / hazard went active |
| `hurt` | `x, z, hp, by` | player took damage (`by` = kind or 'spark') |
| `shieldBlock` | `x, z` | overshield ate a hit |
| `dash` / `dashHit` | `x, z, a` / `id, x, z` | dash started / dash shredded an enemy |
| `pulse` | `x, z, r` | pulse nova (radius r) |
| `gem` | `x, z, value` | xp chip collected |
| `pickupSpawn` / `pickup` / `pickupExpire` | `id, type, pup, fam, x, z` | power-drop lifecycle |
| `heal` | `hp` | |
| `tierUp` | `tier, name` | weapon auto-levelled |
| `combo` | `combo, mult` | multiplier stepped up (x2..x5) |
| `comboBreak` | `combo` | chain ended (≥ 10) |
| `overdrive` / `overdriveEnd` | `x, z` | OVERDRIVE started / ended |
| `bossIntro` | `kind, name` | boss entrance begins (phase = 'bossIntro', ~2.5 s: camera may push in) |
| `bossPhase` | `kind, phase` | boss changed phase |
| `bossDying` | `kind, x, z` | boss hp hit 0 — 2.5 s death sequence |
| `bossKill` | `kind, x, z, points` | boss fully destroyed |
| `hitstop` | `dur` | integrator freezes dt for `dur` seconds (≤ 0.12) |
| `shake` | `amt` | camera shake impulse 0..1 |
| `victory` | `score` | sunrise |
| `gameover` | `score, killedBy` | fox down |

---------------------------------------------------------------------------------------------

## 4. Visual module APIs

### gfx.js (WORLD agent)
```js
import { createGfx } from './gfx.js';
const gfx = createGfx(containerEl, { quality?: 0..3 });   // creates the <canvas> inside containerEl
gfx.renderer, gfx.scene, gfx.camera                       // three objects others add to
gfx.setQuality(q); gfx.quality                            // tiers; also auto-downgrade watchdog (see below)
gfx.onQuality(cb)                                          // called with new q when the watchdog changes it
gfx.resize()                                              // also bound to window resize/orientation
gfx.follow(x, z, dt, opts?)                               // camera follows the fox (opts: {lead:{x,z}, zoom:1, snap:false})
gfx.focus(x, z, zoom, dur)                                 // temporary cinematic push-in (boss intro), then returns to follow
gfx.setShake(vec3)                                         // additive camera offset this frame (from fx.shake())
gfx.worldToScreen(x, y, z, outVec2) -> outVec2            // CSS px, for UI anchors (off-screen threat arrows)
gfx.render(dt)                                            // renders scene through the post chain
gfx.stats() -> { fps, drawCalls, triangles, q }
```
Camera framing targets: fox slightly BELOW screen centre; portrait shows ≈ 10–11 m of width at
the fox's depth and a comfortable view ahead (up-screen); landscape shows ≈ 11–12 m of depth.
Camera pitch ≈ 55–60° down, mild perspective (FOV ≈ 35–45°). Clamp so the camera never shows
far outside the room. Smooth follow (critically damped), slight look-ahead toward movement.

### world.js (WORLD agent)
```js
import { createWorld } from './world.js';
const world = createWorld(gfx);           // builds the whole store into gfx.scene, sets scene.environment (PMREM IBL)
world.update(t, dt, simState)             // animated screens, neon flicker, mood transitions
world.setMood(mood, instant?)             // 'close'|'night'|'boss'|'mesh'|'phones'|'deadzone'|'boss2'|'dawn'|'overtime'|'title'
world.event(ev)                           // react to sim events: e.g. 'spawn' → the display slot it woke from flickers
world.setQuality(q)
world.perches -> Map(spawnId -> {x,y,z})  // the display positions (same as SPAWNS) for debugging
```

### fox.js (FOX agent)
```js
import { createFox } from './fox.js';
const fox = createFox({ outfit: 'bomber' });   // returns a controller
fox.root                                       // THREE.Object3D to add to the scene
fox.update(t, dt, p)                           // p = sim.state.player (+ p.dead, p.victory flags added by main)
fox.setOutfit(id)                              // OUTFITS id
fox.muzzle(outVec3) -> outVec3                  // world-space gun muzzle position (for muzzle flash)
fox.setQuality(q)
fox.pose(name)                                 // 'title' idle-showoff pose for the title screen / outfit picker
```

### modems.js / phones.js (MODEMS / PHONES agents) — identical shape
```js
import { createModems } from './modems.js';    // and createPhones from './phones.js'
const modems = createModems(scene, { capacity: 80 });
modems.sync(enemies, t, dt)    // pass the FULL sim.state.enemies array; render only your kinds; per-id cosmetic state in a Map, forget ids that vanish
modems.setQuality(q)
modems.kinds                   // array of kinds this module renders
modems.preview(kind) -> Object3D   // a standalone, non-instanced copy of one enemy for UI/title use (idle-animated via previewUpdate)
modems.previewUpdate(obj, t)
```
Kinds: modems.js = `xb3 xb6 xb7 xb8 xb10 pod boss_gateway`; phones.js = `iphone galaxy fold boss_flagship`.
Everything is keyed off each enemy's `state/stateT/stateDur/attack/flash/elite/phase/y/spd`.
`spawn` state = the "coming alive" moment (see §6) and is the signature moment of the game.
`dying` (bosses) = shaking, sparking, panels popping, then gone when removed from the list.
Non-boss deaths are instant removals — FX draws the debris burst.

### fx.js (FX agent)
```js
import { createFX } from './fx.js';
const fx = createFX(scene, camera);
fx.sync(simState, t, dt)       // draws pshots, eshots, hazards (telegraphs + live), pickups, aura ring, shield bubble
fx.event(ev)                   // spawns particles / decals / damage numbers from sim events
fx.update(t, dt)               // advances particles
fx.shake() -> THREE.Vector3    // a VECTOR (reused object), not a function result that needs calling twice
fx.setQuality(q)
```

### ui.js (UI agent) — DOM only, no three
```js
import { createUI } from './ui.js';
const ui = createUI(rootEl, hooks);
// hooks (provided by main.js):
//   onPlay()                 user pressed PLAY (inside a user gesture — main unlocks audio here)
//   onPause(paused)          onQuit()   onRetry()   onOvertime()   onClockOut()
//   onSound(on)              onOutfit(id)
//   lbTop(scope) -> Promise<{ rows:[{rank,name,score,hour,district}], error? }>   scope: 'all' | 'week'
//   lbSubmit({ name, district, score, hour, kills }) -> Promise<{ ok, rank?, error? }>
ui.showTitle(profile)          // title screen (see §5 profile)
ui.showPlaying()               // HUD + controls visible, overlays hidden
ui.hud(simState, dt)           // called every frame; must be cheap (only touch DOM when values change)
ui.event(ev)                   // toasts, threat cards, boss bar, combo pops, tier-up banner...
ui.showPause() / ui.hidePause()
ui.showGameOver(result, profile)   // result = sim.result() + { isBest, portrait? }
ui.showVictory(result, profile)    // SUNRISE: CLOCK OUT (submit) or PULL A DOUBLE (overtime)
ui.readInput() -> { mx, mz, dash, pulse }   // dash/pulse edge-triggered (cleared on read)
ui.setAssets(ASSETS)           // { title: dataURL|null, portraits: { fox, xb3, ... } } — may arrive later; always have fallbacks
ui.threatArrows(list)          // [{x,y,kind,boss}] off-screen threat indicators in CSS px (main computes via gfx.worldToScreen)
```

### audio.js (AUDIO agent)
```js
import { createAudio } from './audio.js';
const audio = createAudio();
audio.unlock()                 // MUST be called inside a user gesture (iOS)
audio.setEnabled(on)           // master mute (persisted by main)
audio.setMood(mood, { boss?, intensity? })   // music follows HOURS mood; intensity 0..1 from on-screen enemy count
audio.event(ev)                // map sim events → SFX (with per-sfx rate gating)
audio.sfx(name)                // 'ui', 'uiBack', 'start', ...
audio.stopMusic(); audio.title()             // title-screen music
audio.update(dt)               // optional per-frame (lookahead scheduling must NOT depend on rAF)
```

---------------------------------------------------------------------------------------------

## 5. Profile (saved by main.js in localStorage, passed to UI)

```js
profile = { best, bestHour, lifetimeKills, wins, runs, outfit, unlocked: ['bomber', ...],
            name, district, sound: bool, newUnlocks: [ids unlocked by the last run] }
```

---------------------------------------------------------------------------------------------

## 6. The creative brief (everyone should read)

* **The fox**: the hero from the 2D game (`/home/claude/ah/asset0.png`, top-left): chibi blue fox,
  big head, big blue eyes, white muzzle/chest/tail-tip, cocky smile, orange bomber jacket with
  a teal diamond badge, black tee, dark-navy pants, chunky navy boots with orange soles. In 3D
  it carries a compact glowing **signal blaster** (the auto-gun). Big fluffy tail that swishes.
* **Modems come alive**: sitting dormant on the display tables like products → a power-on
  flicker (status LEDs blink on, a screen-face lights up with angry eyes) → little robotic legs
  unfold → it hops off the table and hunts. Each model has a real personality:
  - **XB6** — the grunt: squat upright white gateway with dark top vent; hops in packs.
  - **XB3** — the old-timer: tall BLACK vertical tower with ribbed vents; heavy stomper.
  - **XB7** — the charger: white rounded tower, perforated top; glows RED and rockets.
  - **XB8** — the broadcaster: tall, sleek WHITE cylinder-ish tower; antenna glow → fires Wi-Fi arcs.
  - **XB10** — the commander: premium dark tower with a gold/amber light bar; launches xFi Pods.
  - **xFi Pod** — little white rounded plug-in pods with a single green LED eye; swarm.
  - **GIGA GATEWAY** (midnight boss) — a colossal XB10-style tower on four mech legs, crown of
    antennas, a giant screen face; Wi-Fi shock rings, stomp-slam, pod summons, spinning beams.
* **Phones wake up (2 AM)**: phones in the wall docks light their screens, peel off the wall,
  and hop in. Stylised originals — no real logos or wordmarks anywhere.
  - **iPHONE** (the flipper): rounded-rect slab, square camera bump, dynamic-island-style pill;
    screen shows the angry face; crouches then FLIPS end-over-end onto your spot.
  - **GALAXY** (the sniper): taller sharper slab, vertical row of three camera lenses; paints a
    laser sight, then fires.
  - **FOLD** (the chomper): a book-style foldable that opens and closes like a jaw.
  - **THE FLAGSHIP** (4 AM boss): a towering foldable phone that stands, opens its two screens,
    sprays notification bullets, sweeps a camera-laser, summons phones, and FOLDS SHUT onto you.
* **The store**: an Xfinity-style retail store at night after closing — polished dark floor with
  reflections of neon, four white experience tables with product, wall displays of phones in
  glowing docks, a big glowing **C³** neon on the back wall, service counter, a round demo
  kiosk wrapped in screens, glass storefront at the front with the city at night beyond.
  Category signs "MOBILE · INTERNET · TV · HOME". **No real Xfinity/Apple/Samsung logos or
  wordmarks** — Blufox/C³ branding is fine. Palette: deep navy, C³ purple, cyan, magenta,
  warm amber accents. Mood shifts per hour: 10 PM half-lit closing; midnight red emergency
  strobe; 2 AM phone-screens-glow blue-magenta; 3 AM "dead zone" flickering; 5 AM dawn warming
  through the front glass; SUNRISE golden.
* **Juice**: hit flashes, squash/stretch, hitstop on big hits, screen shake, sparks, debris,
  damage numbers, combo pops, a satisfying pickup magnet, big boss entrances.
