// Render the app icon from the simulator itself: the spiral demo, unfolded.
//   node tools/icon.mjs out.png [url]     (dev server on :5179 by default)
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const [,, out = 'icon-src.png', url = 'http://localhost:5179/'] = process.argv;
// ICON_STRENGTH = colour depth (default 1.2 in the app); lower keeps dye overlaps from going dark.
const strength = parseFloat(process.env.ICON_STRENGTH || '0.45');
const steps = parseInt(process.env.ICON_STEPS || '300');
const exe = process.env.HOME + '/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1800, height: 1500 }, deviceScaleFactor: 2 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(url);
await page.evaluate(() => localStorage.removeItem('tiedyer.plan.v1'));
await page.reload();
await page.waitForFunction(() => !!window.tiedyer);
const info = await page.evaluate(`(async () => {
  const T = tiedyer;
  [...document.querySelectorAll('button')].find(b => b.textContent === 'Spiral').click();
  await new Promise(r => { const id = setInterval(() => { if (T.bundle && 'cloth' in T.bundle) { clearInterval(id); r(); } }, 200); });
  await new Promise(r => setTimeout(r, 500));
  T.view.strength = ${strength};
  T.step(${steps}); T.render();
  const c = document.getElementById('flat');
  return { w: c.width, h: c.height, url: c.toDataURL('image/png') };
})()`);
fs.writeFileSync(out, Buffer.from(info.url.split(',')[1], 'base64'));
console.log('canvas', info.w, info.h, '->', out);
await browser.close();
