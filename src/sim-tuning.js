// =====================================================================================
// AFTER HOURS 3D — SIM BALANCE TABLE (owned by the SIM agent; read only by sim.js)
// Units: metres, seconds, m/s. 1 m = 50 px of the old 2D game (240 px/s -> 4.8 m/s).
// Every number that decides "is this fun / fair" lives here so balance passes never have
// to touch the rules in sim.js. Verified with scratch/sim/bots.mjs.
// =====================================================================================

export const TUNE = {
  dtMax: 0.05,          // step() clamps dt to this
  subStep: 1 / 60,      // internal fixed-ish substep (never larger)

  cap: { enemies: 70, pshots: 100, eshots: 110, gems: 90, hazards: 40 },

  player: {
    r: 0.35,            // body radius vs fixtures / walls
    hurtR: 0.28,        // hurt box vs bullets / beams / rings
    touchR: 0.30,       // contact damage when enemy centre is within e.r + touchR
    speed: 4.8,
    accelTau: 0.035,    // velocity time-constant when steering (≈95 % in 0.1 s — snappy)
    decelTau: 0.028,    // when the stick is released (no ice-skating)
    turnRate: 22,       // rad/s body turn
    hp: 5, hpCap: 8,
    hurtInv: 1.1, hurtKnock: 4.5,
    dashDur: 0.22, dashSpeed: 19, dashInv: 0.36, dashCD: 2.2, dashCDMin: 1.1,
    dashReach: 0.55, dashDmg: 4, dashBossDmg: 3,           // × hour hp multiplier
    pulseR: 4.0, pulseCD: 8, pulseCDMin: 4, pulseDmg: 7, pulseBossDmg: 14,   // × hour hp mult
    pulseKnock: 7.5, pulseStun: 0.45,
    buffer: 0.26,       // a dash/pulse tap during cooldown is remembered this long
    magnet: 2.6, gemPull: 8.5, vacPull: 15,
    gemCollect: 0.6, heartCollect: 0.7, orbCollect: 0.78, orbAssist: 1.5, orbAssistSpd: 2.4,
    odDur: 5, odFire: 0.34, odBolts: 0, odPierce: 2, odDmg: 0, odSpeed: 1.16,
    tierAir: { inv: 0.66, push: 1.8 },   // "a beat of air" on every weapon tier-up
  },

  gun: { range: 8.8, speed: 16, life: 0.66, r: 0.13, crit: 0.08, faceBias: 0.14, knock: 1.1 },

  // xp needed for tier i -> i+1 (WEAPONS has 8 tiers). After max tier every `xpOverflow`
  // xp gives +1 hp (or a score bonus when full).
  xp: [12, 28, 50, 80, 110, 170, 250],
  xpOverflow: 300,

  combo: { window: 2.8, steps: [6, 15, 28, 45] },     // combo needed for x2, x3, x4, x5
  od: { kill: 0.028, elite: 0.1, boss: 0.5, orb: 0.05, hourDiv: 0.3 },

  elite: { hp: 2.4, r: 1.25, pts: 2.6, speed: 0.92, xp: 3 },
  heart: { chance: 0.006, eliteChance: 0.04, life: 12 },
  gemLife: 14,

  buffs: { rapid: 6.5, shield: 5, vac: 6 },
  rapid: { fire: 0.55, speed: 1.1 },

  score: {
    gem: 10,                          // per xp value, × mult
    heartFull: 250,
    hourClear: [500, 250],            // base + per hour index
    noHit: [1500, 500],
    victory: 10000,
    overflow: 1000,
    otMulStep: 0.25,                  // overtime points × (1 + 0.25·level)
  },

  // ---------------------------------------------------------------- kinds
  // hp = bolts at 1 dmg before the hour multiplier. speed m/s. pts base score. xp gem value.
  kinds: {
    xb6:  { hp: 2,  speed: 2.05, pts: 75,  xp: 1, hopHz: 1.7, flank: 1.5 },
    pod:  { hp: 1,  speed: 3.3,  pts: 45,  xp: 1, weave: 0.55 },
    xb3:  { hp: 7,  speed: 1.15, pts: 180, xp: 2, knock: 0.35, tokens: 3,
            range: 2.2, windup: 0.8, stompR: 2.3, live: 0.22, recover: 0.55, cd: [2.8, 4.2] },
    xb7:  { hp: 5,  speed: 1.5,  pts: 170, xp: 2, tokens: 3,
            minR: 2.4, maxR: 8.5, windup: 0.7, lock: 0.28, track: 5, charge: 11, dur: 0.55,
            recover: 0.6, stun: 1.3, cd: [2.2, 3.4] },
    xb8:  { hp: 4,  speed: 1.35, pts: 190, xp: 2, tokens: 2, keep: [5, 7], fireR: 9.5,
            windup: 0.7, lock: 0.2, waveSpd: 4.6, waveLife: 2.1, half: 0.38, w: 0.42,
            recover: 0.45, cd: [2.6, 3.6] },
    xb10: { hp: 9,  speed: 1.05, pts: 260, xp: 3, tokens: 2, keep: 4.5, knock: 0.5,
            windup: 0.7, pods: 2, maxPods: 6, split: 3, recover: 0.4, cd: [4.8, 6.4] },
    iphone: { hp: 5, speed: 2.0, pts: 200, xp: 2, tokens: 3,
            minR: 2.2, maxR: 6.5, windup: 0.45, dur: 0.7, apex: 2.2, lead: 0.2,
            slamR: 1.1, live: 0.15, recover: 0.45, cd: [2.2, 3.2] },
    galaxy: { hp: 4, speed: 1.4, pts: 220, xp: 2, tokens: 2, keep: [6, 8], fireR: 11,
            windup: 0.95, lock: 0.3, track: 2.6, live: 0.18, w: 0.36, len: 16,
            recover: 0.5, cd: [2.8, 3.8] },
    fold: { hp: 10, speed: 1.75, pts: 260, xp: 3, tokens: 3, knock: 0.5,
            range: 2.3, windup: 0.5, lock: 0.2, dur: 0.28, lunge: 8.5, reach: 0.9, cone: 0.8,
            recover: 0.65, cd: [1.6, 2.4] },
  },

  // ---------------------------------------------------------------- bosses
  bosses: {
    boss_gateway: {
      hp: 540, pts: 5000, speed: [1.1, 1.35, 1.7], keep: 3.0,
      gap: [1.6, 1.3, 0.95],                       // seconds in 'move' between attacks
      bag: [['rings', 'slam', 'summon', 'rings', 'slam'],
            ['rings', 'spin', 'slam', 'summon', 'rings', 'spin'],
            ['spin', 'rings', 'slam', 'rings', 'summon', 'slam', 'spin']],
      windup: { rings: 0.9, slam: 0.55, summon: 0.8, spin: 0.95 },
      rings: { count: [2, 2, 3], spacing: 0.62, speed: [3.6, 4.1, 4.6], w: 0.5, gapHalf: 0.55, gapJit: 0.6, reach: 13.5 },
      slam: { dur: [1.0, 0.95, 0.85], apex: 3.6, r: 2.4, live: 0.22, lead: 0.15, recover: 1.0, orbs: [0, 6, 10], orbSpd: 3.4 },
      summon: { pods: [4, 5, 6], xb6: [2, 2, 3] },
      spin: { dur: [3.0, 3.0, 3.6], speed: [0.65, 0.65, 0.95], len: 8.5, w: 0.45, beams: [4, 4, 4] },
    },
    boss_flagship: {
      hp: 1150, pts: 8000, speed: [1.0, 1.15, 1.35], keep: [3.8, 6.0],
      gap: [1.5, 1.2, 0.85],
      bag: [['spray', 'sweep', 'summon', 'spray', 'fold'],
            ['spray', 'fold', 'sweep', 'summon', 'spray', 'sweep', 'fold'],
            ['spray', 'fold', 'sweep', 'bolt', 'spray', 'summon', 'fold', 'bolt']],
      windup: { spray: 0.6, sweep: 1.0, summon: 0.8, fold: 1.1, bolt: 0.5 },
      spray: { dur: [2.4, 2.4, 2.8], every: [0.3, 0.26, 0.24], arms: [5, 5, 6], spin: [1.1, 1.3, 1.5],
               speed: [4.2, 4.5, 4.8], r: 0.2, life: 3.4, fanN: 9, fanStep: 0.27 },
      sweep: { dur: [1.5, 1.4, 1.25], arc: 1.5, len: 12, w: 0.5 },
      summon: { iphone: [2, 2, 2], galaxy: [1, 1, 2] },
      fold: { hw: 1.5, hd: 3.0, live: 0.25, stun: 2.4, dmgMul: 2 },
      bolt: { volleys: 3, every: 0.4, n: 5, step: 0.2, speed: 6, r: 0.16, life: 2.8 },
    },
    intro: 2.5, introBoot: 1.2, apex: 2.8, dying: 2.5,
  },

  // ---------------------------------------------------------------- the night
  // rate = trickle spawns/s (lerped over the hour), pulse = seconds between "a table wakes up"
  // pulses, pack = pulse size, w = kind weights, elite chance, spark = seconds between ceiling
  // sparks (0 = none), sparkN = strikes per salvo, hp = enemy hp multiplier.
  hours: [
    { rate: [1.0, 2.0], pulse: [8, 10], pack: [3, 3], w: { xb6: 0.86, xb3: 0.14 }, elite: 0, spark: 0, sparkN: 1, hp: 1.0 },
    { rate: [1.8, 2.6], pulse: [7, 9], pack: [3, 5], w: { xb6: 0.48, xb3: 0.14, xb7: 0.22, xb8: 0.16 }, elite: 0.05, spark: 6, sparkN: 1, hp: 1.2 },
    { rate: [0.5, 0.7], pulse: [10, 12], pack: [3, 3], w: { xb6: 0.55, pod: 0.45 }, elite: 0.05, spark: 0, sparkN: 1, hp: 1.35 },
    { rate: [2.5, 3.3], pulse: [6.5, 8.5], pack: [4, 6], w: { xb6: 0.3, xb3: 0.13, xb7: 0.15, xb8: 0.12, xb10: 0.1, pod: 0.2 }, elite: 0.1, spark: 5, sparkN: 1, hp: 1.8 },
    { rate: [2.4, 3.1], pulse: [6.5, 8.5], pack: [4, 6], w: { iphone: 0.3, galaxy: 0.16, xb6: 0.36, xb7: 0.18 }, elite: 0.12, spark: 4.5, sparkN: 1, hp: 2.3 },
    { rate: [2.3, 3.0], pulse: [6, 8], pack: [4, 7], w: { iphone: 0.24, galaxy: 0.15, fold: 0.14, xb8: 0.14, xb10: 0.1, pod: 0.23 }, elite: 0.15, spark: 2.6, sparkN: 2, hp: 2.8 },
    { rate: [0.45, 0.55], pulse: [10, 12], pack: [2, 3], w: { iphone: 0.6, galaxy: 0.4 }, elite: 0.1, spark: 0, sparkN: 1, hp: 3.0 },
    { rate: [2.8, 3.6], pulse: [5.5, 7.5], pack: [5, 8], w: { xb6: 0.16, xb3: 0.08, xb7: 0.12, xb8: 0.1, xb10: 0.08, pod: 0.12, iphone: 0.14, galaxy: 0.1, fold: 0.1 }, elite: 0.18, spark: 3.2, sparkN: 1, hp: 3.2 },
  ],
  overtime: {
    dur: 40, rate: 4.0, rateStep: 0.35, rateMax: 6, hp: 3.7, hpStep: 0.4, elite: 0.2, eliteStep: 0.03, eliteMax: 0.5,
    spark: 2.8, sparkStep: -0.2, sparkMin: 1.2, pulse: [5, 7], pack: [4, 7],
    w: { xb6: 0.15, xb3: 0.09, xb7: 0.12, xb8: 0.1, xb10: 0.08, pod: 0.12, iphone: 0.13, galaxy: 0.1, fold: 0.11 },
    names: ['OVERTIME', 'DOUBLE SHIFT', 'NO BREAKS', 'INVENTORY DAY', 'RED-EYE', 'THE LONG HAUL'],
  },
  director: { firstPulse: 2.5, hourPulse: 2.5, afterBoss: 4, quietTail: 3, spawnSafe: 3.0 },
  hazards: { sparkR: 1.35, sparkWarn: 1.1, sparkLive: 0.3, sparkNear: 3.5, sparkOnYou: 0.35 },
  pups: { first: 7, every: [12, 15], bossEvery: [10, 12], maxLive: 3, minDist: 5, farDist: 9, risky: 0.4 },

  // weapon tier granted by debug.skipTo(hour) so tests start with a plausible build
  skipTier: [0, 2, 3, 4, 5, 6, 6, 7, 7],
};
