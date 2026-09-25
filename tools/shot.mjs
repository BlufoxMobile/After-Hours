// Headless screenshot of a local HTML file with WebGL (SwiftShader). Prints console errors.
// usage: node tools/shot.mjs <file.html> <out.png> [--w 390] [--h 844] [--dpr 2] [--wait 6000]
//        [--eval "js expression run after load"] [--evalAfter "js run just before screenshot"] [--waitFor "js condition"]
// NOTE: SwiftShader renders ~1 frame per 0.3-2 s. For animation states, drive your module's update() manually
// from a window hook rather than relying on requestAnimationFrame cadence.
import { chromium } from 'playwright-core';
import path from 'path';
const a = process.argv.slice(2);
const opt = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
const file = path.resolve(a[0]), out = a[1];
const W = +opt('w', 390), H = +opt('h', 844), dpr = +opt('dpr', 2), wait = +opt('wait', 6000);
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: dpr });
const errs = [];
page.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.type().toUpperCase() + ' ' + m.text()); else if (a.includes('--log')) console.log('LOG', m.text()); });
await page.goto('file://' + file);
if (opt('eval')) { const r = await page.evaluate(opt('eval')); if (r !== undefined) console.log('eval ->', JSON.stringify(r)); }
if (opt('waitFor')) await page.waitForFunction(opt('waitFor'), null, { timeout: 180000 });
await page.waitForTimeout(wait);
if (opt('evalAfter')) { const r = await page.evaluate(opt('evalAfter')); if (r !== undefined) console.log('evalAfter ->', JSON.stringify(r)); await page.waitForTimeout(+opt('settle', 1500)); }
await page.screenshot({ path: out });
console.log('shot', out, errs.length ? '\n' + errs.slice(0, 30).join('\n') : '(no console errors)');
await browser.close();
