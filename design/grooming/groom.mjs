#!/usr/bin/env node
// Backlog grooming menu: place every 1.5.0 item and every known gap into Sprints 29 to 34 (1.5.0 and 1.6.0), 1.7 or
// later, or drop it, against a capacity of 78 points a sprint.
//
//   node design/grooming/groom.mjs                 interactive menu
//   node design/grooming/groom.mjs --list          every item with its placement, no terminal needed
//   node design/grooming/groom.mjs --capacity      points per sprint
//   node design/grooming/groom.mjs --export        write GROOMING.md and Backlog-1.6.0.draft.md beside this file
//   node design/grooming/groom.mjs --place B-29 33+34 [--points 42] [--priority P2] [--note "text"]
//   node design/grooming/groom.mjs --recommend     place every open item where items.json recommends
//   node design/grooming/groom.mjs --reset         forget every placement
//
// Reads items.json beside this file; writes grooming.json (the state), GROOMING.md and Backlog-1.6.0.draft.md.
// Pure Node, no dependencies; menu primitives in ../tui-kit.mjs.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { c, cols, pad, trunc, wrap, write, clear, banner, keysOn, keysOff, key, line, menu, pager } from '../tui-kit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = JSON.parse(readFileSync(join(here, 'items.json'), 'utf8'));
const STATE_FILE = join(here, 'grooming.json');
const MD_FILE = join(here, 'GROOMING.md');
const DRAFT_FILE = join(here, 'Backlog-1.6.0.draft.md');
const CAP = DATA.pointsPerSprint;
const SPRINTS = DATA.releases.flatMap((r) => r.sprints);
const releaseOf = (sprint) => DATA.releases.find((r) => r.sprints.includes(sprint));
const TARGETS = DATA.targets; const targetOf = (k) => TARGETS.find((t) => t.key === k);

// ---------- state ----------
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : { version: 1, updatedAt: null, items: {} };
const items = DATA.items; const byId = Object.fromEntries(items.map((i) => [i.id, i]));
const st = (id) => state.items[id] || {};
const pointsOf = (i) => (st(i.id).points != null ? st(i.id).points : i.points);
const priorityOf = (i) => st(i.id).priority || i.priority;
/** Where an item sits now: the groomed target, else its current sprint in the plan, else nothing. */
const placedKey = (i) => st(i.id).target || null;
const effectiveKey = (i) => placedKey(i) || i.current || null;
const groomed = (i) => !!placedKey(i);
function save() {
  state.updatedAt = new Date().toISOString();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
  writeFileSync(MD_FILE, groomingMarkdown());
  writeFileSync(DRAFT_FILE, draft160());
}
function place(id, target, extra) { state.items[id] = { ...st(id), target, ...(extra || {}), at: new Date().toISOString() }; save(); }
function patch(id, extra) { state.items[id] = { ...st(id), ...extra, at: new Date().toISOString() }; save(); }

// ---------- capacity ----------
function loads() {
  const per = Object.fromEntries(SPRINTS.map((s) => [s, { points: 0, items: [] }]));
  const later = [], dropped = [], open = [];
  for (const i of items) {
    const k = effectiveKey(i);
    if (!k) { open.push(i); continue; }
    const t = targetOf(k);
    if (k === 'later') later.push(i); else if (k === 'drop') dropped.push(i);
    else t.sprints.forEach((s) => { per[s].points += pointsOf(i) / t.sprints.length; per[s].items.push(i); });
  }
  return { per, later, dropped, open };
}
const fmtPts = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
function bar(points) {
  const w = 20; const n = Math.min(w, Math.round((points / CAP) * w));
  const tone = points > CAP * 1.15 ? c.red : points > CAP ? c.yellow : c.green;
  return tone + '█'.repeat(n) + c.gray + '░'.repeat(w - n) + c.reset + ' ' + tone + pad(fmtPts(points), 5) + c.reset + c.gray + '/ ' + CAP + c.reset;
}
function capacityBlock() {
  const { per, later, dropped, open } = loads();
  let out = '';
  for (const r of DATA.releases) out += '  ' + c.bold + pad(r.version, 7) + c.reset + r.sprints.map((s) => c.gray + 'S' + s + ' ' + c.reset + bar(per[s].points)).join('   ') + '\n';
  out += '  ' + c.gray + pad('', 7) + 'later ' + later.reduce((a, i) => a + pointsOf(i), 0) + ' pts in ' + later.length + '  ·  dropped ' + dropped.length + '  ·  unplaced ' + open.length + ' (' + open.reduce((a, i) => a + pointsOf(i), 0) + ' pts)' + c.reset + '\n';
  return out;
}
const head = () => banner('EXPRSN-AI BACKLOG GROOMING', c.bold + DATA.title + c.reset + '\n' + wrap(DATA.pointNote, cols() - 4).map((l) => '  ' + c.gray + l + c.reset).join('\n'), capacityBlock());

// ---------- markdown ----------
function row(i) { return '| ' + i.id + ' | ' + i.title + ' | ' + i.doneWhen + ' | ' + fmtPts(pointsOf(i)) + ' |'; }
function groomingMarkdown() {
  const { per, later, dropped, open } = loads();
  let md = '# Grooming: ' + DATA.title + '\n\nWritten by `groom.mjs`; change placements there, not here. ' + items.filter(groomed).length + ' of ' + items.length + ' items groomed' + (state.updatedAt ? ', last change ' + state.updatedAt.slice(0, 16).replace('T', ' ') + ' UTC' : '') + '. Capacity ' + CAP + ' points a sprint.\n\n';
  md += '## Capacity\n\n| Sprint | Release | Points | Against ' + CAP + ' | Items |\n| --- | --- | --- | --- | --- |\n';
  for (const s of SPRINTS) md += '| ' + s + ' | ' + releaseOf(s).version + ' | ' + fmtPts(per[s].points) + ' | ' + (per[s].points > CAP ? '**over by ' + fmtPts(per[s].points - CAP) + '**' : 'fits') + ' | ' + per[s].items.map((i) => i.id).join(', ') + ' |\n';
  for (const s of SPRINTS) {
    md += '\n## Sprint ' + s + ' (' + releaseOf(s).version + ', ' + fmtPts(per[s].points) + ' points)\n\n| ID | Item | Done when | Pts |\n| --- | --- | --- | --- |\n';
    for (const i of per[s].items) md += row(i) + (targetOf(effectiveKey(i)).sprints.length > 1 ? ' split' : '') + '\n';
  }
  md += '\n## Moves from the written plan\n\n';
  const moves = items.filter((i) => groomed(i) && i.current && placedKey(i) !== i.current);
  md += moves.length ? moves.map((i) => '- ' + i.id + ' ' + i.title + ': ' + targetOf(i.current).label + ' → ' + targetOf(placedKey(i)).label + (st(i.id).note ? ' (' + st(i.id).note + ')' : '')).join('\n') + '\n' : 'None yet.\n';
  md += '\n## 1.7 or later\n\n' + (later.length ? later.map((i) => '- ' + i.id + ' ' + i.title + ' (' + fmtPts(pointsOf(i)) + ')' + (st(i.id).note ? ': ' + st(i.id).note : '')).join('\n') : 'None.') + '\n';
  md += '\n## Dropped\n\n' + (dropped.length ? dropped.map((i) => '- ' + i.id + ' ' + i.title + (st(i.id).note ? ': ' + st(i.id).note : ' (no reason recorded)')).join('\n') : 'None.') + '\n';
  md += '\n## Not yet placed\n\n' + (open.length ? open.map((i) => '- ' + i.id + ' ' + i.title + ' (' + fmtPts(pointsOf(i)) + ', recommended ' + targetOf(i.recommended).label + ')').join('\n') : 'None.') + '\n';
  const notes = items.filter((i) => st(i.id).note && effectiveKey(i) !== 'drop' && effectiveKey(i) !== 'later');
  if (notes.length) md += '\n## Notes\n\n' + notes.map((i) => '- ' + i.id + ': ' + st(i.id).note).join('\n') + '\n';
  return md;
}
function draft160() {
  const { per } = loads();
  const r = DATA.releases.find((x) => x.version === '1.6.0');
  const inRelease = items.filter((i) => { const k = effectiveKey(i); const t = k && targetOf(k); return t && t.sprints.some((s) => r.sprints.includes(s)); });
  const total = inRelease.reduce((a, i) => a + pointsOf(i), 0);
  const byPri = (p) => inRelease.filter((i) => priorityOf(i) === p);
  let md = '# Backlog: 1.6.0 (draft from grooming)\n\nGenerated by `design/grooming/groom.mjs`. ' + inRelease.length + ' items, ' + fmtPts(total) + ' points: P0 ' + fmtPts(byPri('P0').reduce((a, i) => a + pointsOf(i), 0)) + ', P1 ' + fmtPts(byPri('P1').reduce((a, i) => a + pointsOf(i), 0)) + ', P2 ' + fmtPts(byPri('P2').reduce((a, i) => a + pointsOf(i), 0)) + '. Rules as in Backlog-1.5.0.md.\n\n## Sprints\n\n| Sprint | Items | Points | Status |\n| --- | --- | --- | --- |\n';
  for (const s of r.sprints) md += '| ' + s + ' | ' + per[s].items.map((i) => i.id).join(', ') + ' | ' + fmtPts(per[s].points) + ' | Planned |\n';
  for (const p of ['P0', 'P1', 'P2']) {
    const list = byPri(p); if (!list.length) continue;
    md += '\n## ' + p + '\n\n| ID | Item | Done when | Pts | Sprint |\n| --- | --- | --- | --- | --- |\n';
    for (const i of list) md += row(i).replace(/ \|$/, '') + ' | ' + targetOf(effectiveKey(i)).sprints.join(' and ') + ' |\n';
  }
  md += '\n## Descriptions\n\n' + inRelease.map((i) => '- **' + i.id + ' ' + i.title + '.** ' + i.description).join('\n') + '\n';
  return md;
}

// ---------- screens ----------
async function itemScreen(item) {
  for (;;) {
    const s = st(item.id); const cur = effectiveKey(item);
    const entries = TARGETS.map((t, n) => ({ num: n + 1, label: t.label + (t.key === item.recommended ? c.gray + '  (recommended)' + c.reset : '') + (t.key === item.current ? c.gray + '  (written plan)' + c.reset : ''), mark: placedKey(item) === t.key ? '✓' : cur === t.key ? '!' : '·', hint: t.sprints.length ? t.sprints.map((sp) => 'S' + sp + ' ' + fmtPts(loads().per[sp].points) + '/' + CAP).join(', ') : '' }));
    entries.push({ sep: true });
    entries.push({ action: 'points', label: 'Change points', hint: fmtPts(pointsOf(item)) + (s.points != null ? ' (was ' + item.points + ')' : '') });
    entries.push({ action: 'priority', label: 'Change priority', hint: priorityOf(item) });
    entries.push({ action: 'note', label: s.note ? 'Edit the note' : 'Add a note', hint: s.note || 'why, a condition, who decides' });
    entries.push({ action: 'clear', label: 'Clear the placement' });
    entries.push({ action: 'back', label: 'Back' });
    const sub = '[' + item.id + ' · ' + priorityOf(item) + ' · ' + fmtPts(pointsOf(item)) + ' pts' + (item.locked ? ' · fixed in the plan' : '') + (item.done ? ' · done' : '') + ']  ' + item.description + '  Done when: ' + item.doneWhen;
    const n = await menu({ head, title: item.title, subtitle: sub, entries, footer: 'Enter places and saves · ! is where the written plan has it · Esc back', labelWidth: 56 });
    if (n < 0) return;
    const e = entries[n];
    if (e.num) { place(item.id, TARGETS[n].key); if (TARGETS[n].key === 'drop' && !s.note) { clear(); head(); const t = await line('  Why drop ' + item.id + '? '); if (t) patch(item.id, { note: t }); } return; }
    if (e.action === 'back') return;
    if (e.action === 'clear') { delete state.items[item.id]; save(); return; }
    clear(); head(); write('  ' + c.bold + item.title + c.reset + '\n\n');
    if (e.action === 'points') { const t = await line('  Points (1 = half a day): ', pointsOf(item)); if (t && !isNaN(+t)) patch(item.id, { points: +t }); }
    if (e.action === 'priority') { const t = (await line('  Priority (P0, P1, P2): ', priorityOf(item))).toUpperCase(); if (/^P[012]$/.test(t)) patch(item.id, { priority: t }); }
    if (e.action === 'note') { const t = await line('  Note: ', s.note || ''); patch(item.id, { note: t }); }
  }
}

async function capacityScreen() {
  const { per, later, dropped, open } = loads(); const lines = [];
  for (const s of SPRINTS) {
    lines.push(c.bold + 'Sprint ' + s + c.reset + c.gray + '  ' + releaseOf(s).version + '  ' + c.reset + bar(per[s].points) + (per[s].points > CAP ? c.red + '  over by ' + fmtPts(per[s].points - CAP) : ''));
    for (const i of per[s].items) lines.push('    ' + pad(i.id, 7) + pad(trunc(i.title, 58), 58) + pad(fmtPts(pointsOf(i) / targetOf(effectiveKey(i)).sprints.length), 5) + c.gray + (groomed(i) ? '' : 'written plan') + (targetOf(effectiveKey(i)).sprints.length > 1 ? ' split' : '') + c.reset);
    lines.push('');
  }
  lines.push(c.bold + '1.7 or later' + c.reset + '  ' + (later.map((i) => i.id + ' (' + fmtPts(pointsOf(i)) + ')').join(', ') || 'none'));
  lines.push(c.bold + 'Dropped' + c.reset + '  ' + (dropped.map((i) => i.id).join(', ') || 'none'));
  lines.push(c.bold + 'Not yet placed' + c.reset + '  ' + (open.map((i) => i.id + ' (' + fmtPts(pointsOf(i)) + ')').join(', ') || 'none'));
  await pager(head, 'Points per sprint', lines);
}

async function about() {
  const text = [
    'Every row is one backlog item: the 1.5.0 epics as Backlog-1.5.0.md and the two open design PRs place them, and the gaps found when comparing exprsn-platform with Exprsn-AI. Pick a row, pick where it goes. The bars under the header are the points per sprint against ' + CAP + '; a sprint turns yellow above that and red above ' + Math.round(CAP * 1.15) + '.',
    'A "!" mark is where the written plan has an item today; "✓" is your placement. Items marked fixed are in progress or already merged, so moving them is a note for the coordinator rather than a change. Split targets spread the points over two sprints.',
    'Every change saves at once to grooming.json and rewrites GROOMING.md (per sprint, the moves from the written plan, later, dropped) and Backlog-1.6.0.draft.md (the 1.6.0 backlog in the house format). Nothing in the real Backlog files changes until you ask for it.',
    'Flags: --list, --capacity, --export, --place <ID> <target> [--points n] [--priority Px] [--note "…"], --recommend, --reset.'
  ];
  await pager(head, 'About', text.flatMap((p) => wrap(p, cols() - 6).concat([''])));
}

async function main() {
  keysOn();
  let pos = 0;
  for (;;) {
    const entries = []; let num = 0;
    for (const g of [...new Set(items.map((i) => i.group))]) {
      entries.push({ sep: true, label: g });
      for (const i of items.filter((x) => x.group === g)) {
        const k = effectiveKey(i); const t = k && targetOf(k);
        entries.push({ num: ++num <= 10 ? num : undefined, id: i.id, label: i.id + '  ' + i.title, mark: i.done ? '✓' : groomed(i) ? (k === 'drop' ? '✗' : '✓') : k ? '!' : '·', hint: fmtPts(pointsOf(i)) + ' pts · ' + (t ? (groomed(i) ? '' : 'plan: ') + t.label.replace(/ \(.*\)$/, '') : 'unplaced') + (groomed(i) ? '' : ' · rec: ' + targetOf(i.recommended).label.replace(/ \(.*\)$/, '')) });
      }
    }
    entries.push({ sep: true });
    entries.push({ action: 'capacity', label: 'Points per sprint', hint: 'every sprint with its items' });
    entries.push({ action: 'recommend', label: 'Place every open item as recommended', hint: 'then adjust one by one' });
    entries.push({ action: 'export', label: 'Write GROOMING.md and the 1.6.0 draft', hint: 'also written on every change' });
    entries.push({ action: 'reset', label: 'Reset every placement', hint: 'asks first' });
    entries.push({ action: 'about', label: 'About' });
    entries.push({ sep: true });
    entries.push({ action: 'quit', label: 'Quit' });
    const n = await menu({ head, entries, start: pos, footer: items.filter(groomed).length + ' of ' + items.length + ' groomed  ·  state: ' + STATE_FILE.replace(process.env.HOME || '', '~') + '\n  ↑/↓ move · PgUp/PgDn · Enter select · 1-9 jump · Esc or q quit', labelWidth: 54 });
    if (n < 0) break;
    pos = n; const e = entries[n];
    if (e.id) await itemScreen(byId[e.id]);
    else if (e.action === 'capacity') await capacityScreen();
    else if (e.action === 'recommend') { items.filter((i) => !groomed(i)).forEach((i) => place(i.id, i.recommended)); }
    else if (e.action === 'export') { save(); await pager(head, 'Written', ['GROOMING.md and Backlog-1.6.0.draft.md are beside groom.mjs.']); }
    else if (e.action === 'reset') { clear(); head(); const t = await line('  Type "reset" to forget every placement: '); if (t === 'reset') { state.items = {}; save(); } }
    else if (e.action === 'about') await about();
    else if (e.action === 'quit') break;
  }
  keysOff(); clear();
  write(items.filter(groomed).length + ' of ' + items.length + ' items groomed. grooming.json, GROOMING.md and Backlog-1.6.0.draft.md are up to date.\n');
}

// ---------- flags ----------
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const after = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
if (flag('--help') || flag('-h')) {
  write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 14).map((l) => l.replace(/^\/\/ ?/, '')).join('\n') + '\n');
} else if (flag('--list')) {
  for (const i of items) { const k = effectiveKey(i); write((groomed(i) ? '[x] ' : '[ ] ') + pad(i.id, 7) + pad(trunc(i.title, 60), 60) + ' ' + pad(fmtPts(pointsOf(i)), 4) + ' ' + (k ? (groomed(i) ? '' : 'plan: ') + targetOf(k).label : 'unplaced; recommended ' + targetOf(i.recommended).label) + '\n'); }
} else if (flag('--capacity')) {
  const { per, later, dropped, open } = loads();
  for (const s of SPRINTS) write('S' + s + ' (' + releaseOf(s).version + ') ' + fmtPts(per[s].points) + '/' + CAP + (per[s].points > CAP ? ' OVER' : '') + ': ' + per[s].items.map((i) => i.id).join(', ') + '\n');
  write('later: ' + later.map((i) => i.id).join(', ') + '\ndropped: ' + dropped.map((i) => i.id).join(', ') + '\nunplaced: ' + open.map((i) => i.id).join(', ') + '\n');
} else if (flag('--export')) {
  save(); write('Wrote ' + MD_FILE + ' and ' + DRAFT_FILE + '\n');
} else if (flag('--reset')) {
  state.items = {}; save(); write('Every placement forgotten.\n');
} else if (flag('--recommend')) {
  items.filter((i) => !groomed(i)).forEach((i) => place(i.id, i.recommended)); write('Placed every open item as recommended.\n');
} else if (flag('--place')) {
  const id = after('--place'); const target = argv[argv.indexOf('--place') + 2]; const item = byId[id];
  if (!item || !targetOf(target)) { write('usage: --place <ID> <' + TARGETS.map((t) => t.key).join('|') + '> [--points n] [--priority Px] [--note "text"]\n'); process.exit(2); }
  const extra = {}; if (after('--points')) extra.points = +after('--points'); if (after('--priority')) extra.priority = after('--priority').toUpperCase(); if (after('--note')) extra.note = after('--note');
  place(id, target, extra); write(id + ' → ' + targetOf(target).label + '\n');
} else if (!process.stdin.isTTY || !process.stdout.isTTY) {
  write('groom.mjs needs an interactive terminal. Without one: --list, --capacity, --export, --place, --recommend, --reset.\n'); process.exit(2);
} else {
  main().catch((e) => { keysOff(); console.error(e); process.exit(1); });
}
