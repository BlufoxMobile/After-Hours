// Drive the full game headless. usage: node tools/play.mjs <html> <outdir> [--w 390 --h 844] [--script name]
import { chromium } from 'playwright-core';
import path from 'path'; import fs from 'fs';
const a = process.argv.slice(2);
const opt = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
const file = path.resolve(a[0]), out = a[1]; fs.mkdirSync(out, { recursive: true });
const W = +opt('w', 390), H = +opt('h', 844), script = opt('script', 'basic'), q = opt('q', '2');
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2, hasTouch: opt('touch', '0') === '1' });
const errs = [];
page.on('pageerror', e => errs.push('PAGEERROR ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 4).join('\n')));
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.type().toUpperCase() + ' ' + m.text()); });
await page.goto('file://' + file + '?debug&q=' + q);
await page.waitForFunction('window.__ah && window.__ah.ui', null, { timeout: 120000 });
let n = 0;
const shot = async (name) => { const p = `${out}/${String(n++).padStart(2, '0')}_${name}.png`; await page.screenshot({ path: p }); console.log('shot', p); };
const ev = (js) => page.evaluate(js);
const wait = (ms) => page.waitForTimeout(ms);
await wait(2500); await shot('title');
const scripts = {
  async basic() {
    await page.click('text=PLAY', { timeout: 5000 }).catch(async () => { await ev(`document.querySelector('.ah-play')?.click()`); });
    await wait(4000); await shot('start');
    await page.keyboard.down('KeyD'); await wait(3000); await page.keyboard.up('KeyD'); await shot('moved');
    await ev(`__ah.sim.debug.god = true`);
    await page.keyboard.down('KeyW'); await wait(6000); await page.keyboard.up('KeyW'); await shot('t10');
    await wait(8000); await shot('t18');
  },
  async hours() {
    await ev(`document.querySelector('.ah-play')?.click()`); await wait(2000);
    await ev(`__ah.sim.debug.god = true`);
    for (const h of (opt('hours', '1,2,4,6,7')).split(',').map(Number)) {
      await ev(`__ah.sim.debug.skipTo(${h})`); await wait(+opt('dwell', '14000'));
      await shot('hour' + h);
    }
  },
  async death() {
    await ev(`document.querySelector('.ah-play')?.click()`); await wait(2000);
    await ev(`__ah.sim.debug.skipTo(5)`); await wait(25000); await shot('late');
    await page.waitForFunction(`__ah.sim.state.phase === 'dead'`, null, { timeout: 240000 }).catch(() => {});
    await wait(9000); await shot('gameover');
  },
  async tour() {
    await ev(`document.querySelector('.ah-play').click()`); await wait(1500);
    const step = async (js, name, w = 3000) => { const r = await ev(js); console.log(name, JSON.stringify(r)); await wait(w); await shot(name); };
    await step(`__ah.ff(12)`, '10pm');
    await step(`__ah.sim.debug.god = true; __ah.sim.debug.skipTo(1); __ah.ff(20)`, '11pm');
    await step(`__ah.sim.debug.skipTo(2); __ah.ff(1.2)`, 'boss1intro');
    await step(`__ah.ff(14)`, 'boss1fight');
    await step(`__ah.sim.debug.skipTo(4); __ah.ff(16)`, '2am');
    await step(`__ah.sim.debug.skipTo(6); __ah.ff(1.5)`, 'boss2intro');
    await step(`__ah.ff(16)`, 'boss2fight');
    await step(`__ah.sim.debug.skipTo(7); __ah.ff(30)`, '5am');
    await step(`__ah.ff(20)`, 'sunrise', 5000);
  },
  async die() {
    await ev(`document.querySelector('.ah-play').click()`); await wait(1500);
    const r = await ev(`__ah.sim.debug.skipTo(3); __ah.ff(120)`); console.log(JSON.stringify(r));
    await wait(4000); await shot('gameover');
  },
  async menus() {
    await ev(`document.querySelector('.ah-go-locker')?.click()`); await wait(5000); await shot('locker');
    await ev(`document.querySelector('.ah-lk-done')?.click()`); await wait(1500);
    await ev(`document.querySelector('.ah-lk-done')?.click()`);
    await ev(`__ah.ui.showHow()`); await wait(1500); await shot('how');
  },
  async cam() {
    await ev(`document.querySelector('.ah-play').click()`); await wait(1500);
    for (const [x, z] of [[0, 9.8], [0, 2], [-5.8, -8.8], [5.8, 6]]) {
      await ev(`__ah.sim.debug.god = true; const P = __ah.sim.state.player; P.x = ${x}; P.z = ${z}; __ah.ff(1.5, false); P.x = ${x}; P.z = ${z}; __ah.ff(0.6, false)`);
      await wait(2500); await shot(`cam_${x}_${z}`);
    }
  },
  async locker() {
    await ev(`document.querySelector('.ah-go-locker')?.click()`);
    await wait(4000); await shot('locker');
  },
};
await scripts[script]();
console.log(errs.length ? 'ERRORS:\n' + errs.slice(0, 25).join('\n') : 'no console errors');
console.log(JSON.stringify(await ev(`({stats: __ah.gfx.stats(), phase: __ah.sim.state.phase, hour: __ah.sim.state.hour, clock: __ah.sim.state.clock, en: __ah.sim.state.enemies.length, mode: document.querySelector('#ui').className})`)));
await browser.close();
