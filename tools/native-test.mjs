// node tools/native-test.mjs out.png — load the app with a fake Capacitor bridge so the native code paths run in headless Chromium.
import { chromium } from 'playwright-core';
const exe = process.env.HOME + '/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('response', (r) => { if (r.status() >= 400) errs.push(r.status() + ' ' + r.url()); });
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200) + ' @ ' + m.location().url); });
await page.addInitScript(() => { window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' }; });
await page.goto('http://localhost:5179/');
await page.waitForFunction(() => !!window.tiedyer);
const r = await page.evaluate(async () => {
  const T = window.tiedyer;
  const native = document.body.classList.contains('native');
  const gh = getComputedStyle(document.querySelector('a.gh')).display;
  T.addStroke({ kind: 'brush', p: { x: 5, y: 5 }, r: 2, dye: 0, amount: 0.8, side: 'top', pen: 8 });
  [...document.querySelectorAll('button')].find(b => b.textContent === 'Image').click();
  await new Promise(r => setTimeout(r, 1500));
  return { native, gh, status: document.getElementById('status').textContent.split('\n')[0] };
});
await page.screenshot({ path: process.argv[2] });
console.log(JSON.stringify(r), 'errors:', JSON.stringify(errs));
await browser.close();
