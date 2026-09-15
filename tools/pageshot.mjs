// node tools/pageshot.mjs <url> <out.png> [width] — full-page screenshot for reviewing static pages.
import { chromium } from 'playwright-core';
const [,, url, out, w = '1280'] = process.argv;
const exe = process.env.HOME + '/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: parseInt(w), height: 900 } });
await page.goto(url, { waitUntil: 'networkidle' });
await page.screenshot({ path: out, fullPage: true });
await browser.close();
