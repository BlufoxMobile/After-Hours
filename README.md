# AFTER HOURS

**The store is closed. The chaos is open.**

A 3D arcade survival game for the Blufox Mobile team. You're the Blufox, stuck in an Xfinity store overnight. The modems on the display tables come alive, and later the phones jump off the wall docks. Survive from 10 PM to sunrise.

**Play:** https://blufoxmobile.github.io/After-Hours/ (phone in portrait is the main target; landscape and desktop work too)

## How to play

- **Move:** drag anywhere on the screen. On a keyboard, use WASD or the arrow keys.
- **Shooting is automatic.** Your gun locks onto the nearest target and levels itself up as you pick up XP chips.
- **Dash:** DASH button, a quick flick, a second-finger tap, or Space. You're invincible while dashing, and it damages anything you pass through.
- **Pulse:** PULSE button, or E or Shift. Blasts everything close to you.
- **Power drops** fall into the store. Grab them before they vanish.
- Chaining takedowns raises your multiplier (up to ×5) and fills OVERDRIVE.

## The night

| Time | Hour | What's new |
|---|---|---|
| 10 PM | Lights Out | XB6 grunts, XB3 old-timers (stomp shockwave) |
| 11 PM | Reboot | XB7 chargers, XB8 broadcasters (Wi-Fi waves), ceiling sparks |
| 12 AM | **GIGA GATEWAY** | Midnight boss. Dash through the gaps in its Wi-Fi rings. |
| 1 AM | Mesh Network | XB10 commanders that launch xFi Pods |
| 2 AM | The Phones Wake Up | iPhone flippers and Galaxy snipers come off the wall docks |
| 3 AM | Dead Zone | Fold chompers; the lights start failing |
| 4 AM | **THE FLAGSHIP** | A giant foldable boss. When it folds shut, get out from under it. |
| 5 AM | Last Call | Everything at once |
| 6 AM | Sunrise | Clock out and post your score, or **Pull a Double** for endless overtime |

**Locker:** fox outfits unlock as you reach new hours, rack up takedowns, and make it to sunrise.

**Leaderboard:** there's a company-wide board (all-time and this week) with your name and district.

## For maintainers

- `index.html` is the whole game in one self-contained file. Everything is inlined, including three.js and the art, and it makes no network requests except to the leaderboard.
- `src/` holds the source as ES modules: `sim.js` (all gameplay rules; pure JS that runs in node), `gfx.js` + `world.js` (renderer and store), `fox.js`, `modems.js`, `phones.js`, `fx.js`, `ui.js` + `ui.css`, `audio.js` (procedural music and SFX), and `main.js` (wiring).
- `CONTRACT.md` is the interface between the modules. `src/layout.js` holds the shared data (arena, hours, weapons, pickups, outfits).
- Balance numbers are in `src/sim-tuning.js`.
- To build: `npm install && npm run build`, which writes `dist/index.html`. Copy that file to `index.html`.
- `worker/worker.js` is the Cloudflare Worker for the leaderboard (KV namespace bound as `BOARD`). The client is `src/lb.js`.
- `After-Hours.html` redirects here so old links keep working.
