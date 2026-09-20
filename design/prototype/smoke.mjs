// Loads every registered screen (light + dark), applies each of its states, opens the palette and map,
// and reports console/page errors. Usage: node smoke.mjs
import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' && !/ERR_CERT|fonts\.g/.test(m.text())) errors.push('[console] ' + m.text()); });
page.on('pageerror', (e) => errors.push('[page] ' + String(e)));
const url = 'file://' + join(root, 'index.html');
await page.goto(url);
await page.evaluate(() => { try { localStorage.setItem('exprsn.signedIn', '1'); } catch (e) {} });
await page.reload();
const ids = await page.evaluate(() => Object.keys(App.screens));
let n = 0;
for (const id of ids) {
  if (id === 'not-found') continue;
  for (const dark of [false, true]) {
    await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
    const before = errors.length;
    await page.evaluate((r) => { location.hash = '#/' + r; }, id);
    await page.waitForTimeout(150);
    const states = await page.evaluate(() => (App.screens[App.state.route].states || []).length);
    for (let i = 0; i < states; i++) { await page.evaluate((k) => App.applyState(k), i); await page.waitForTimeout(80); }
    await page.evaluate(() => { App.state.screenState[App.state.route] = {}; App.render(); });
    const rendered = await page.evaluate(() => document.querySelector('#main').children.length > 0);
    if (!rendered) errors.push('[empty] ' + id);
    n++;
    if (errors.length > before) errors.splice(before, 0, '--- in ' + id + (dark ? ' (dark)' : ''));
  }
}
await page.evaluate(() => App.palette()); await page.waitForTimeout(100); await page.evaluate(() => App.closeOverlay());
await page.evaluate(() => App.map()); await page.waitForTimeout(100); await page.evaluate(() => App.closeOverlay());
console.log('screens checked:', n / 2, 'of', ids.length - 1);
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no errors');
await browser.close();
process.exit(errors.length ? 1 : 0);
