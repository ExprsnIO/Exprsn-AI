// Usage: node shot.mjs <route> [out.png] [width] [dark]
// Screenshots the prototype (signed in) at #/<route>. Prints console errors.
import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
const [route = 'chat', out = 'shot.png', width = '1440', dark = ''] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell' });
const page = await browser.newPage({ viewport: { width: +width, height: 900 }, colorScheme: dark ? 'dark' : 'light' });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('file://' + join(root, 'index.html'));
await page.evaluate(() => { try { localStorage.setItem('exprsn.signedIn', '1'); } catch (e) {} });
await page.goto('file://' + join(root, 'index.html') + '#/' + route);
await page.reload();
await page.waitForTimeout(600);
await page.screenshot({ path: out, fullPage: false });
console.log('saved', out, errors.length ? '\nERRORS:\n' + errors.filter((e) => !/net::ERR_FILE_NOT_FOUND|fonts.googleapis/.test(e)).join('\n') : '(no console errors)');
await browser.close();
