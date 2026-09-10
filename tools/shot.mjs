// Headless test harness (no browser extension needed):
//   node tools/shot.mjs [script.js] [out.png] [url]
// Launches Playwright's cached Chromium with SwiftShader (WebGL2 float textures work),
// loads the dev server, clears the autosaved plan, evaluates the script file in the
// page (async; `return` a JSON value to print it), then saves a screenshot.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const [,, scriptPath, out, url = 'http://localhost:5179/'] = process.argv;
const exe = process.env.HOME + '/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 840 } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[console]', m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(url);
await page.evaluate(() => localStorage.removeItem('tiedyer.plan.v1'));
await page.reload();
await page.waitForFunction(() => !!window.tiedyer);
if (scriptPath) {
  const code = fs.readFileSync(scriptPath, 'utf8');
  const result = await page.evaluate(`(async () => { ${code} })()`);
  console.log(JSON.stringify(result, null, 1));
}
await page.evaluate(() => window.tiedyer.render());
await page.waitForTimeout(300);
if (out) await page.screenshot({ path: out });
await browser.close();
