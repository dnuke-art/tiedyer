// App Store screenshots from the app's own renderer at exact device pixel sizes.
//   node tools/screenshots.mjs [outdir] [url] [device]      (dev server on :5179)
// Renders with a fake Capacitor bridge so the native layout (no GitHub link) is shown.
// iPhone 6.9": 440x956 @3 = 1320x2868 portrait. iPad 13": 1376x1032 @2 = 2752x2064 landscape.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const [,, outdir = 'ios/appstore/screenshots', url = 'http://localhost:5179/', only] = process.argv; // only: device key to render
const exe = process.env.HOME + '/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const DEVICES = {
  'iphone-6.9': { width: 440, height: 956, scale: 3, phone: true },
  'ipad-13':    { width: 1376, height: 1032, scale: 2, phone: false },  // landscape: the app is a side-by-side layout
};
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

const waitTwist = `await new Promise(r => { const id = setInterval(() => { if (T.bundle && 'cloth' in T.bundle) { clearInterval(id); r(); } }, 200); }); await new Promise(r => setTimeout(r, 800)); T.step(200); T.render();`;
const click = (label) => `[...document.querySelectorAll('button')].find(b => b.textContent === '${label}').click();`;

const SCENES = [
  { name: '01-kikko', run: `${click('Kikko')} await new Promise(r => setTimeout(r, 300)); T.render();` },
  { name: '02-spiral-3d', run: `${click('Spiral')} ${waitTwist} document.getElementById('v3d').click(); document.getElementById('fitView').click();
      const c = T.view3d.cam; c.az = -1.1; c.el = 0.8; c.dist *= 0.95; T.render(); await new Promise(r => setTimeout(r, 300)); T.render();` },
  { name: '03-spiral-flat', run: `document.getElementById('v2d').click(); T.render();` },
  { name: '04-bands', run: `${click('Kikko')} await new Promise(r => setTimeout(r, 300));
      const bb = T.bundle.bbox(); const cx = (bb.minX + bb.maxX) / 2, cy = (bb.minY + bb.maxY) / 2;
      T.plan.bands.push({ p: { x: cx, y: cy }, r: 2.5 }); T.pressChanged(); T.step(120); T.render();`, phoneMenu: true },
];

for (const [dev, d] of Object.entries(DEVICES)) {
  if (only && dev !== only) continue;
  const page = await browser.newPage({ viewport: { width: d.width, height: d.height }, deviceScaleFactor: d.scale, isMobile: d.phone, hasTouch: d.phone });
  page.on('pageerror', (e) => console.log('[pageerror]', dev, e.message));
  await page.addInitScript(() => { window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' }; });
  await page.goto(url);
  await page.evaluate(() => localStorage.removeItem('tiedyer.plan.v1'));
  await page.reload();
  await page.waitForFunction(() => !!window.tiedyer);
  fs.mkdirSync(`${outdir}/${dev}`, { recursive: true });
  for (const s of SCENES) {
    await page.evaluate(`(async () => { const T = window.tiedyer; ${s.run} })()`);
    if (s.phoneMenu && d.phone) { await page.evaluate(() => document.getElementById('menu-btn').click()); await page.waitForTimeout(400); }
    await page.waitForTimeout(400);
    const file = `${outdir}/${dev}/${s.name}.png`;
    await page.screenshot({ path: file });
    if (s.phoneMenu && d.phone) { await page.evaluate(() => document.getElementById('menu-btn').click()); await page.waitForTimeout(300); }
    console.log(dev, s.name);
  }
  await page.close();
}
await browser.close();
