// Builds design/mockups/cloud.html from cloud.src.html, the console's css/app.css, the part files in cloud/ and the
// epics, items and sprints of Backlog-2.0.0.md (the backlog part is generated, so the storyboard never drifts from it).
// The output is one self-contained page (no external resources except Google Fonts, which fall back to system fonts).
// Run: node design/mockups/build-cloud.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Inline markdown: `code`, **bold**; everything else escaped.
const md = (s) => esc(s).replace(/`([^`]+)`/g, '<span class="mono">$1</span>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');

function backlogPart() {
  const src = readFileSync(join(here, '../../Backlog-2.0.0.md'), 'utf8');
  const lines = src.split('\n');
  const epics = []; let cur = null; let section = null; const sprints = [];
  for (const line of lines) {
    if (/^## /.test(line)) section = line.slice(3).trim();
    const h = line.match(/^### (B-\d+) (.+?) \((\d+) points?\)/);
    if (h) { cur = { id: h[1], title: h[2], pts: +h[3], pri: section, items: [] }; epics.push(cur); continue; }
    if (/^#{2,3} /.test(line)) cur = null;
    const row = line.match(/^\| (B-\d{5}) \| (.+) \| (.+) \| (\d+|—) \|$/);
    if (row && cur) cur.items.push({ id: row[1], item: row[2], done: row[3], pts: row[4] });
    const sp = line.match(/^\| (\d{2}) \| (.+?) \| (.+?) \| (\d+) \| (.+?) \| (.+?) \|$/);
    if (sp && section === 'Sprints') sprints.push(sp.slice(1));
  }
  const total = epics.reduce((a, e) => a + e.pts, 0);
  const items = epics.reduce((a, e) => a + e.items.length, 0);
  let html = '<section class="section" id="backlog"><div class="part-head"><span class="eyebrow">Backlog</span><h2>Backlog 2.0.0 summary</h2>'
    + '<p>Generated from <span class="mono">Backlog-2.0.0.md</span> when this page is built: ' + epics.length + ' epics, ' + items + ' items, ' + total + ' points (1 point is about half a day for one engineer, tests included). The open decisions and risks are in the backlog file.</p></div>';
  html += '<div class="tablewrap"><table class="dt" style="min-width:640px"><thead><tr><th>Sprint</th><th>Theme</th><th>Items</th><th class="r">Points</th><th>Status</th></tr></thead><tbody>'
    + sprints.map((s) => '<tr><td><b>' + esc(s[0]) + '</b></td><td>' + md(s[1]) + '</td><td class="mono" style="font-size:11px">' + esc(s[2]) + '</td><td class="r num">' + esc(s[3]) + '</td><td>' + esc(s[5]) + '</td></tr>').join('')
    + '</tbody></table></div>';
  for (const e of epics) {
    html += '<details class="panel"><summary class="hstack wrap" style="cursor:pointer;gap:8px"><b>' + esc(e.id) + '</b><span class="grow" style="min-width:0">' + md(e.title) + '</span><span class="pill outline">' + esc(e.pri || '') + '</span><span class="pill">' + e.pts + ' points</span><span class="muted">' + e.items.length + ' items</span></summary>'
      + '<div class="tablewrap minitable" style="margin-top:10px"><table class="dt" style="min-width:640px"><thead><tr><th>ID</th><th>Item</th><th>Done when</th><th class="r">Pts</th></tr></thead><tbody>'
      + e.items.map((it) => '<tr><td><b>' + esc(it.id) + '</b></td><td>' + md(it.item) + '</td><td>' + md(it.done) + '</td><td class="r num">' + esc(it.pts) + '</td></tr>').join('')
      + '</tbody></table></div></details>';
  }
  return html + '<p class="example">Prototype: <span class="mono">design/prototype</span> routes <span class="mono">#/cloud</span>, <span class="mono">#/deployments</span>, <span class="mono">#/cloud-data</span>, <span class="mono">#/cloud-compute</span>, <span class="mono">#/finops</span> and the provider filter on <span class="mono">#/models</span>.</p></section>';
}

const css = readFileSync(join(here, '../prototype/css/app.css'), 'utf8');
let html = readFileSync(join(here, 'cloud.src.html'), 'utf8').replace('/*APP_CSS*/', () => css);
html = html.replace(/<!--PART:([a-z-]+)-->/g, (m, name) => {
  if (name === 'backlog') return backlogPart();
  const file = join(here, 'cloud', name + '.html');
  if (!existsSync(file)) { console.warn('missing part', name); return ''; }
  return readFileSync(file, 'utf8').trim();
});
html = html.replace(/<!--INC:([a-z-]+\.[a-z]+)-->/g, (m, name) => {
  const file = join(here, 'cloud', name + '.html');
  if (!existsSync(file)) { console.warn('missing include', name); return ''; }
  return readFileSync(file, 'utf8').trim();
});
// Standalone-page guard: nothing external but Google Fonts, no dialogs or print calls.
const bad = [/<iframe/i, /<img\s/i, /\balert\(/, /\bconfirm\(/, /\bprompt\(/, /window\.print/, /\sdownload[\s=>]/, /<script[^>]+src=/i];
for (const re of bad) if (re.test(html)) console.warn('standalone check failed:', re);
for (const m of html.matchAll(/(?:href|src)="(https?:[^"]+)"/g)) if (!/^https:\/\/fonts\.googleapis\.com\//.test(m[1])) console.warn('external reference:', m[1]);
writeFileSync(join(here, 'cloud.html'), html);
console.log('wrote cloud.html,', html.split('\n').length, 'lines,', (html.length / 1024).toFixed(0), 'KB');
