#!/usr/bin/env node
// Terminal menu for the open questions and concerns of the platform-administration design.
//
//   node design/platform-admin/decide.mjs            interactive menu
//   node design/platform-admin/decide.mjs --list     every item with its current answer, no terminal needed
//   node design/platform-admin/decide.mjs --export   the lines to carry into Backlog-1.5.0.md "Open decisions"
//   node design/platform-admin/decide.mjs --answer Q2 readonly [--note "text"]   answer without the menu
//   node design/platform-admin/decide.mjs --reset    forget every answer
//
// Reads questions.json beside this file, writes decisions.json and DECISIONS.md beside it. Pure Node (readline and
// ANSI), no dependencies, the same family as the platform's exprsn-configure tool.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const here = dirname(fileURLToPath(import.meta.url));
const QUESTIONS = JSON.parse(readFileSync(join(here, 'questions.json'), 'utf8'));
const DECISIONS_FILE = join(here, 'decisions.json');
const MARKDOWN_FILE = join(here, 'DECISIONS.md');

// ---------- state ----------
const load = () => (existsSync(DECISIONS_FILE) ? JSON.parse(readFileSync(DECISIONS_FILE, 'utf8')) : { version: 1, updatedAt: null, answers: {} });
const state = load();
const items = QUESTIONS.items;
const byId = Object.fromEntries(items.map((i) => [i.id, i]));
const answerOf = (id) => state.answers[id] || null;
const labelOf = (item, a) => (a ? (a.choice === 'other' ? a.answer : (item.options.find((o) => o.key === a.choice) || {}).label || a.answer) : null);
const defaultOf = (item) => item.options.find((o) => o.default) || item.options[0];

function save() {
  state.updatedAt = new Date().toISOString();
  writeFileSync(DECISIONS_FILE, JSON.stringify(state, null, 2) + '\n');
  writeFileSync(MARKDOWN_FILE, markdown());
}
function setAnswer(id, choice, answer, note) {
  state.answers[id] = { choice, answer, note: note || (answerOf(id) || {}).note || '', at: new Date().toISOString() };
  save();
}
function setNote(id, note) {
  const a = answerOf(id) || { choice: null, answer: null, at: null };
  state.answers[id] = { ...a, note, at: a.at || new Date().toISOString() };
  save();
}

// ---------- output: markdown and the backlog lines ----------
function backlogLines() {
  return items.filter((i) => i.kind === 'question').map((i) => {
    const a = answerOf(i.id);
    const text = a ? labelOf(i, a) : null;
    return (a ? '- [x] ' : '- [ ] ') + i.title.replace(/\?$/, '') + ': ' + (text ? text + (a.note ? ' (' + a.note + ')' : '') : 'open; the board shows "' + defaultOf(i).label + '"') + ' (' + i.id + ', design/platform-admin).';
  });
}
function markdown() {
  const answered = items.filter((i) => answerOf(i.id) && answerOf(i.id).choice);
  const rows = items.map((i) => {
    const a = answerOf(i.id);
    return '| ' + i.id + ' | ' + i.screen + ' | ' + i.title + ' | ' + (a && a.choice ? labelOf(i, a) : '_open_ (board shows: ' + defaultOf(i).label + ')') + ' | ' + ((a && a.note) || '') + ' | ' + (a && a.at ? a.at.slice(0, 10) : '') + ' |';
  });
  return '# Decisions: Exprsn-platform administration screens\n\nWritten by `decide.mjs`; edit the answers there, not here. ' + answered.length + ' of ' + items.length + ' items answered'
    + (state.updatedAt ? ', last change ' + state.updatedAt.slice(0, 16).replace('T', ' ') + ' UTC' : '') + '.\n\n| ID | Screen | Item | Decision | Note | When |\n| --- | --- | --- | --- | --- | --- |\n' + rows.join('\n')
    + '\n\n## Lines for Backlog-1.5.0.md, Open decisions\n\n' + backlogLines().join('\n') + '\n';
}

// ---------- ANSI ----------
const colour = process.env.NO_COLOR === undefined && process.stdout.isTTY && process.env.TERM !== 'dumb';
const E = '\x1b[';
const C = (n) => (colour ? E + n + 'm' : '');
const c = { reset: C(0), bold: C(1), dim: C(2), gray: C(90), green: C(32), yellow: C(33), cyan: C(36), red: C(31), white: C(37), accent: C(33) };
const cols = () => Math.max(60, Math.min(process.stdout.columns || 100, 110));
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - strip(s).length));
const trunc = (s, n) => (strip(s).length <= n ? s : s.slice(0, Math.max(0, n - 1)) + '…');
const wrap = (text, width) => {
  const out = []; let line = '';
  for (const w of text.split(/\s+/)) { if ((line + ' ' + w).trim().length > width) { out.push(line.trim()); line = w; } else line = (line + ' ' + w).trim(); }
  if (line) out.push(line); return out;
};
const write = (s) => process.stdout.write(s);
const clear = () => write(E + '2J' + E + '3J' + E + 'H');
function banner() {
  const w = cols() - 2; const title = '◆  EXPRSN-AI DESIGN DECISIONS  ◆';
  const inner = ' '.repeat(Math.floor((w - title.length) / 2)) + title;
  write(c.accent + '╔' + '═'.repeat(w) + '╗\n║' + pad(inner, w) + '║\n╚' + '═'.repeat(w) + '╝' + c.reset + '\n');
  write('  ' + c.bold + QUESTIONS.title + c.reset + '  ' + c.gray + QUESTIONS.doc + c.reset + '\n\n');
}

// ---------- keys ----------
let raw = false;
function keysOn() { if (raw) return; readline.emitKeypressEvents(process.stdin); process.stdin.setRawMode(true); process.stdin.resume(); write(E + '?25l'); raw = true; }
function keysOff() { if (!raw) return; process.stdin.setRawMode(false); process.stdin.pause(); write(E + '?25h'); raw = false; }
function key() {
  return new Promise((resolve) => {
    const on = (str, k) => { process.stdin.off('keypress', on); if (k && k.ctrl && k.name === 'c') { keysOff(); write('\n'); process.exit(130); } resolve({ str, name: (k && k.name) || str }); };
    process.stdin.on('keypress', on);
  });
}
async function line(prompt, initial) {
  keysOff();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => { rl.question(prompt, resolve); if (initial) rl.write(initial); });
  rl.close(); keysOn();
  return answer.trim();
}

/** A vertical menu: entries are {label, hint, mark}; returns the index, or -1 on Esc. */
async function menu(title, subtitle, entries, start, footer) {
  let i = Math.max(0, start || 0);
  for (;;) {
    clear(); banner();
    if (title) write('  ' + c.bold + title + c.reset + '\n');
    if (subtitle) for (const l of wrap(subtitle, cols() - 6)) write('  ' + c.gray + l + c.reset + '\n');
    write('\n');
    entries.forEach((e, n) => {
      if (e.sep) { write('\n'); return; }
      const cur = n === i;
      const num = e.num != null ? String(e.num).padStart(2) + '. ' : '    ';
      const mark = e.mark ? (e.mark === '✓' ? c.green : e.mark === '·' ? c.gray : c.yellow) + e.mark + c.reset + ' ' : '  ';
      const label = (cur ? c.bold + c.white : '') + e.label + c.reset;
      write('  ' + (cur ? c.accent + '❯ ' + c.reset : '  ') + num + mark + pad(trunc(label, 44), 44) + (e.hint ? '  ' + c.gray + trunc(e.hint, cols() - 60) + c.reset : '') + '\n');
    });
    write('\n  ' + c.gray + (footer || '↑/↓ move · Enter select · 1-9 jump · Esc back · Ctrl-C quit') + c.reset + '\n');
    const k = await key();
    const live = (d) => { let n = i; do { n = (n + d + entries.length) % entries.length; } while (entries[n].sep); return n; };
    if (k.name === 'up' || k.name === 'k') i = live(-1);
    else if (k.name === 'down' || k.name === 'j') i = live(1);
    else if (k.name === 'return' || k.name === 'space') return i;
    else if (k.name === 'escape' || k.name === 'q') return -1;
    else if (/^[1-9]$/.test(k.str || '')) { const n = entries.findIndex((e) => e.num === Number(k.str)); if (n >= 0) i = n; }
    else if (k.str === '0') { const n = entries.findIndex((e) => e.num === 10); if (n >= 0) i = n; }
  }
}

// ---------- screens ----------
async function askItem(item) {
  for (;;) {
    const a = answerOf(item.id);
    const entries = item.options.map((o, n) => ({ num: n + 1, label: o.label + (o.default ? c.gray + '  (board default)' + c.reset : ''), mark: a && a.choice === o.key ? '✓' : '·' }));
    entries.push({ sep: true });
    entries.push({ label: 'Other: type an answer', mark: a && a.choice === 'other' ? '✓' : '·', hint: a && a.choice === 'other' ? a.answer : '' });
    entries.push({ label: (a && a.note ? 'Edit the note' : 'Add a note'), mark: a && a.note ? '✓' : '·', hint: a && a.note ? a.note : 'context, a condition, who to ask' });
    entries.push({ label: 'Clear the answer', mark: ' ' });
    entries.push({ label: 'Back', mark: ' ' });
    const sub = '[' + item.id + ' · ' + item.screen + ' · ' + item.kind + ']  ' + item.context;
    const n = await menu(item.title, sub, entries, 0, 'Enter picks and saves · Esc back');
    if (n < 0 || entries[n].label === 'Back') return;
    if (n < item.options.length) { setAnswer(item.id, item.options[n].key, item.options[n].label); return; }
    const label = entries[n].label;
    if (label.startsWith('Other')) { clear(); banner(); write('  ' + c.bold + item.title + c.reset + '\n\n'); const t = await line('  Your answer: ', a && a.choice === 'other' ? a.answer : ''); if (t) setAnswer(item.id, 'other', t); return; }
    if (label.endsWith('note')) { clear(); banner(); write('  ' + c.bold + item.title + c.reset + '\n\n'); const t = await line('  Note: ', (a && a.note) || ''); setNote(item.id, t); continue; }
    if (label.startsWith('Clear')) { delete state.answers[item.id]; save(); return; }
  }
}

async function review() {
  clear(); banner();
  write('  ' + c.bold + 'Answers so far' + c.reset + '\n\n');
  for (const i of items) {
    const a = answerOf(i.id);
    write('  ' + (a && a.choice ? c.green + '✓' : c.gray + '·') + c.reset + ' ' + pad(i.id, 4) + ' ' + pad(trunc(i.title, 46), 46) + '  ' + (a && a.choice ? c.white + trunc(labelOf(i, a), cols() - 60) : c.gray + 'open, board shows: ' + trunc(defaultOf(i).label, cols() - 80)) + c.reset + '\n');
    if (a && a.note) write('       ' + c.gray + 'note: ' + trunc(a.note, cols() - 14) + c.reset + '\n');
  }
  write('\n  ' + c.gray + 'Saved in decisions.json and DECISIONS.md beside this script. Any key to go back.' + c.reset + '\n');
  await key();
}

async function exportScreen() {
  clear(); banner();
  write('  ' + c.bold + 'Lines for Backlog-1.5.0.md, Open decisions' + c.reset + '\n\n');
  for (const l of backlogLines()) write('  ' + l + '\n');
  write('\n  ' + c.gray + 'Also in DECISIONS.md. Any key to go back.' + c.reset + '\n');
  await key();
}

async function about() {
  clear(); banner();
  const text = [
    'This menu holds the questions and concerns the platform-administration design could not settle alone: one entry per item in questions.json, grouped as questions (a choice the boards need) and concerns (something to acknowledge or redirect).',
    'Picking an option saves at once to decisions.json and rewrites DECISIONS.md with a table and the lines for Backlog-1.5.0.md. Nothing else is written. Every item has a board default, which is what the prototype shows today; answering differently is a note for the sprint that makes the screen live.',
    'Flags for scripts: --list, --export, --answer <ID> <key or text> [--note "…"], --reset.'
  ];
  for (const p of text) { for (const l of wrap(p, cols() - 6)) write('  ' + l + '\n'); write('\n'); }
  write('  ' + c.gray + 'Any key to go back.' + c.reset + '\n');
  await key();
}

async function main() {
  keysOn();
  let pos = 0;
  for (;;) {
    const questions = items.filter((i) => i.kind === 'question'); const concerns = items.filter((i) => i.kind === 'concern');
    const entries = [];
    questions.forEach((i, n) => { const a = answerOf(i.id); entries.push({ num: n + 1, id: i.id, label: i.title, mark: a && a.choice ? '✓' : '·', hint: a && a.choice ? labelOf(i, a) : i.screen }); });
    entries.push({ sep: true });
    concerns.forEach((i) => { const a = answerOf(i.id); entries.push({ id: i.id, label: i.title, mark: a && a.choice ? '✓' : '!', hint: a && a.choice ? labelOf(i, a) : 'concern · ' + i.screen }); });
    entries.push({ sep: true });
    entries.push({ action: 'review', label: 'Review answers', hint: 'what has been decided and what is open' });
    entries.push({ action: 'export', label: 'Export for Backlog-1.5.0.md', hint: 'the Open decisions lines' });
    entries.push({ action: 'reset', label: 'Reset every answer', hint: 'asks first' });
    entries.push({ action: 'about', label: 'About', hint: 'what this writes, and where' });
    entries.push({ sep: true });
    entries.push({ action: 'quit', label: 'Quit' });
    const answered = items.filter((i) => answerOf(i.id) && answerOf(i.id).choice).length;
    const n = await menu(null, null, entries, pos, answered + ' of ' + items.length + ' items answered  ·  state: ' + DECISIONS_FILE.replace(process.env.HOME || '', '~') + '\n  ↑/↓ move · Enter select · 1-9 jump · Esc or q quit');
    if (n < 0) break;
    pos = n;
    const e = entries[n];
    if (e.id) await askItem(byId[e.id]);
    else if (e.action === 'review') await review();
    else if (e.action === 'export') await exportScreen();
    else if (e.action === 'about') await about();
    else if (e.action === 'reset') { clear(); banner(); const t = await line('  Type "reset" to forget every answer: '); if (t === 'reset') { state.answers = {}; save(); } }
    else if (e.action === 'quit') break;
  }
  keysOff(); clear();
  write(answered() + ' of ' + items.length + ' items answered. decisions.json and DECISIONS.md are up to date.\n');
}
const answered = () => items.filter((i) => answerOf(i.id) && answerOf(i.id).choice).length;

// ---------- flags ----------
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const after = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
if (flag('--help') || flag('-h')) {
  write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 11).map((l) => l.replace(/^\/\/ ?/, '')).join('\n') + '\n');
} else if (flag('--list')) {
  for (const i of items) { const a = answerOf(i.id); write((a && a.choice ? '[x] ' : '[ ] ') + i.id + '  ' + i.title + '\n      ' + (a && a.choice ? labelOf(i, a) + (a.note ? '  (' + a.note + ')' : '') : 'open; board shows: ' + defaultOf(i).label) + '\n'); }
} else if (flag('--export')) {
  write(backlogLines().join('\n') + '\n');
} else if (flag('--reset')) {
  state.answers = {}; save(); write('Every answer forgotten.\n');
} else if (flag('--answer')) {
  const id = after('--answer'); const value = argv[argv.indexOf('--answer') + 2]; const note = after('--note');
  const item = byId[id];
  if (!item || !value) { write('usage: --answer <ID> <option key or free text> [--note "text"]\n'); process.exit(2); }
  const opt = item.options.find((o) => o.key === value);
  setAnswer(id, opt ? opt.key : 'other', opt ? opt.label : value, note);
  write(id + ': ' + (opt ? opt.label : value) + '\n');
} else if (!process.stdin.isTTY || !process.stdout.isTTY) {
  write('decide.mjs needs an interactive terminal. Without one: --list, --export, --answer <ID> <key> [--note "…"], --reset.\n');
  process.exit(2);
} else {
  main().catch((e) => { keysOff(); console.error(e); process.exit(1); });
}
