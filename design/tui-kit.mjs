// Shared terminal-menu primitives for the design tools (decide.mjs, groom.mjs): ANSI colour that switches itself off
// without a TTY, a banner, a vertical menu with arrow keys and number jumps, a line editor and a keypress reader.
// Pure Node (readline), no dependencies; the same family as the platform's exprsn-configure tool.
import readline from 'node:readline';

const colour = process.env.NO_COLOR === undefined && process.stdout.isTTY && process.env.TERM !== 'dumb';
const E = '\x1b[';
const C = (n) => (colour ? E + n + 'm' : '');
export const c = { reset: C(0), bold: C(1), dim: C(2), gray: C(90), green: C(32), yellow: C(33), cyan: C(36), red: C(31), white: C(37), accent: C(33) };
export const cols = () => Math.max(60, Math.min(process.stdout.columns || 100, 120));
export const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
export const pad = (s, n) => s + ' '.repeat(Math.max(0, n - strip(s).length));
export const trunc = (s, n) => (strip(s).length <= n ? s : s.slice(0, Math.max(0, n - 1)) + '…');
export const wrap = (text, width) => {
  const out = []; let line = '';
  for (const w of String(text).split(/\s+/)) { if ((line + ' ' + w).trim().length > width) { out.push(line.trim()); line = w; } else line = (line + ' ' + w).trim(); }
  if (line) out.push(line); return out;
};
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });
export const write = (s) => process.stdout.write(s);
export const clear = () => write(E + '2J' + E + '3J' + E + 'H');

/** The boxed header every screen starts with. `extra` is printed under it (capacity bars, counts). */
export function banner(title, subtitle, extra) {
  const w = cols() - 2; const t = '◆  ' + title + '  ◆';
  write(c.accent + '╔' + '═'.repeat(w) + '╗\n║' + pad(' '.repeat(Math.max(0, Math.floor((w - t.length) / 2))) + t, w) + '║\n╚' + '═'.repeat(w) + '╝' + c.reset + '\n');
  if (subtitle) write('  ' + subtitle + '\n');
  if (extra) write(extra);
  write('\n');
}

let raw = false;
export function keysOn() { if (raw) return; readline.emitKeypressEvents(process.stdin); process.stdin.setRawMode(true); process.stdin.resume(); write(E + '?25l'); raw = true; }
export function keysOff() { if (!raw) return; process.stdin.setRawMode(false); process.stdin.pause(); write(E + '?25h'); raw = false; }
export function key() {
  return new Promise((resolve) => {
    const on = (str, k) => { process.stdin.off('keypress', on); if (k && k.ctrl && k.name === 'c') { keysOff(); write('\n'); process.exit(130); } resolve({ str, name: (k && k.name) || str }); };
    process.stdin.on('keypress', on);
  });
}
export async function line(prompt, initial) {
  keysOff();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => { rl.question(prompt, resolve); if (initial) rl.write(String(initial)); });
  rl.close(); keysOn();
  return answer.trim();
}

/**
 * A vertical menu. `entries` are {label, hint, mark, num, sep}; `head()` returns the banner block to draw each time
 * (so capacity bars can change). Returns the chosen index, or -1 on Esc or q.
 */
export async function menu({ head, title, subtitle, entries, start = 0, footer, labelWidth = 46 }) {
  let i = Math.max(0, start);
  while (entries[i] && entries[i].sep) i++;
  for (;;) {
    clear(); head();
    if (title) write('  ' + c.bold + title + c.reset + '\n');
    if (subtitle) for (const l of wrap(subtitle, cols() - 6)) write('  ' + c.gray + l + c.reset + '\n');
    write('\n');
    entries.forEach((e, n) => {
      if (e.sep) { write(e.label ? '  ' + c.gray + e.label + c.reset + '\n' : '\n'); return; }
      const cur = n === i;
      const num = e.num != null ? String(e.num).padStart(2) + '. ' : '    ';
      const markColour = e.mark === '✓' ? c.green : e.mark === '✗' ? c.red : e.mark === '!' ? c.yellow : c.gray;
      const mark = e.mark ? markColour + e.mark + c.reset + ' ' : '  ';
      const label = (cur ? c.bold + c.white : '') + e.label + c.reset;
      write('  ' + (cur ? c.accent + '❯ ' + c.reset : '  ') + num + mark + pad(trunc(label, labelWidth), labelWidth) + (e.hint ? '  ' + c.gray + trunc(e.hint, cols() - labelWidth - 16) + c.reset : '') + '\n');
    });
    write('\n  ' + c.gray + (footer || '↑/↓ move · Enter select · 1-9 jump · Esc back · Ctrl-C quit') + c.reset + '\n');
    const k = await key();
    const live = (d) => { let n = i; do { n = (n + d + entries.length) % entries.length; } while (entries[n].sep); return n; };
    if (k.name === 'up' || k.name === 'k') i = live(-1);
    else if (k.name === 'down' || k.name === 'j') i = live(1);
    else if (k.name === 'pagedown') { for (let s = 0; s < 8; s++) i = live(1); }
    else if (k.name === 'pageup') { for (let s = 0; s < 8; s++) i = live(-1); }
    else if (k.name === 'return' || k.name === 'space') return i;
    else if (k.name === 'escape' || k.name === 'q') return -1;
    else if (/^[1-9]$/.test(k.str || '')) { const n = entries.findIndex((e) => e.num === Number(k.str)); if (n >= 0) i = n; }
    else if (k.str === '0') { const n = entries.findIndex((e) => e.num === 10); if (n >= 0) i = n; }
  }
}

/** A text screen that waits for any key. */
export async function pager(head, title, lines) {
  clear(); head();
  if (title) write('  ' + c.bold + title + c.reset + '\n\n');
  const max = Math.max(8, (process.stdout.rows || 40) - 12);
  let shown = 0;
  for (const l of lines) {
    write('  ' + l + '\n'); shown++;
    if (shown % max === 0 && shown < lines.length) { write('  ' + c.gray + 'more: any key' + c.reset + '\n'); await key(); clear(); head(); if (title) write('  ' + c.bold + title + c.reset + '\n\n'); }
  }
  write('\n  ' + c.gray + 'Any key to go back.' + c.reset + '\n');
  await key();
}
