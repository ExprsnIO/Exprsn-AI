import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { BreachedPasswords } from '../identity/breached.js';
import { digestOf, HASH_KINDS, IMPORT_FORMATS, type HashKind, type ImportFormat } from '../identity/leaked/hashes.js';
import type { Actor, ListRow } from '../identity/leaked/service.js';
import type { Services } from '../services.js';
import { metadataSafeFetch } from '../platform/egress.js';

/*
 * 1.9.0, Sprint 55 (B-195): the leaked-password CLI.
 *
 *   passwords:import  a list from a file (or stdin) into a platform or tenant list, built here with progress
 *   passwords:lists   the lists, their active versions and sizes
 *   passwords:check   a k-anonymous self-check: the password is read without echo, hashed here, and only the first
 *                     five hex characters of its hash go to each source (this server's lists, and the HIBP range API
 *                     when BREACHED_PASSWORDS allows it or --online is given); the suffixes that come back are compared
 *                     here. It prints found or not found, never the password or its hash.
 */

export const PASSWORDS_COMMANDS = ['passwords:import', 'passwords:lists', 'passwords:check'] as const;

export const PASSWORDS_USAGE = `  passwords:import <file|-> --list <name> [--platform | --tenant <slug>] [--format hibp|hashes|plain]
      [--create [--kind sha1|ntlm]] [--note <text>] [--no-activate]
                               1.9.0 (B-192): import a leaked-password list (HIBP "hash:count", one hash per line,
                               or plain text hashed as it is read and never stored) as a new version, built here
                               with progress; it becomes the active version unless --no-activate
  passwords:lists [--platform | --tenant <slug>]
                               1.9.0 (B-192): the leaked-password lists with their active version, size and date
  passwords:check [--tenant <slug>] [--online | --offline]
                               1.9.0 (B-195): a k-anonymous self-check of a password read from the terminal (or one
                               line of stdin): only a five-character hash prefix leaves this process. Exit 2 when found
`;

/** A source the self-check asks for the suffixes under a prefix. Only the prefix is ever passed. */
export interface RangeSource {
  name: string;
  kind: HashKind;
  range(prefix: string): Promise<string[]>;
}

/** The k-anonymous comparison: one prefix per hash kind goes out, the suffixes are compared here. */
export async function selfCheck(password: string, sources: RangeSource[]): Promise<{ found: boolean; asked: number; failed: string[] }> {
  const digests = new Map<HashKind, string>();
  let asked = 0;
  const failed: string[] = [];
  for (const src of sources) {
    const hex = digests.get(src.kind) ?? digests.set(src.kind, digestOf(src.kind, password).toString('hex').toUpperCase()).get(src.kind)!;
    try {
      const suffixes = await src.range(hex.slice(0, 5));
      asked++;
      const want = hex.slice(5);
      if (suffixes.some((s) => s.toUpperCase().split(':')[0] === want)) return { found: true, asked, failed };
    } catch (err) {
      failed.push(`${src.name}: ${(err as Error).message}`);
    }
  }
  return { found: false, asked, failed };
}

/** The HIBP-compatible range API as a source: GET <base>/range/<prefix>, padded, zero counts ignored. */
export function hibpSource(base: string, kind: HashKind, timeoutMs: number): RangeSource {
  return {
    name: `range API (${kind})`,
    kind,
    range: async (prefix) => {
      const url = `${base.replace(/\/+$/, '')}/range/${prefix}${kind === 'ntlm' ? '?mode=ntlm' : ''}`;
      const res = await metadataSafeFetch(url, { headers: { 'Add-Padding': 'true', 'User-Agent': 'Exprsn-AI password self-check' }, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
      if (!res.ok) throw new Error(`answered ${res.status}`);
      return (await res.text()).split('\n').map((l) => l.trim()).filter((l) => l && Number(l.split(':')[1] ?? '1') > 0);
    }
  };
}

async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, terminal: false });
    for await (const line of rl) {
      rl.close();
      return line.replace(/\r$/, '');
    }
    return '';
  }
  let muted = false;
  const out = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stderr.write(chunk);
      cb();
    }
  });
  const rl = createInterface({ input: process.stdin, output: out, terminal: true });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      process.stderr.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

const cliActor = (tenantId: string): Actor => ({ tenantId, userId: null, audit: { service: 'cli' }, traceId: null, platform: true, identity: true });

async function tenantOf(s: Services, slug: string | undefined): Promise<{ id: string; slug: string }> {
  const t = await s.tenants.bySlug(slug ?? s.cfg.DEFAULT_TENANT);
  if (!t) throw new Error(`Unknown tenant ${slug ?? s.cfg.DEFAULT_TENANT}`);
  return t;
}

const size = (n: number | null | undefined) => (n == null ? '-' : n.toLocaleString('en-US'));
const day = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString().slice(0, 10) : '-');

export async function passwordsCommand(s: Services, cmd: string, argv: string[], out: (t: string) => void, err: (t: string) => void = (t) => void process.stderr.write(t)): Promise<number> {
  const svc = s.leakedPasswords;
  if (cmd === 'passwords:check') {
    const { values } = parseArgs({ args: argv, options: { tenant: { type: 'string' }, online: { type: 'boolean' }, offline: { type: 'boolean' } } });
    const tenant = await tenantOf(s, values.tenant);
    const password = await readSecret('Password to check (not shown): ');
    if (!password) {
      out('No password given.\n');
      return 64;
    }
    const sources: RangeSource[] = [];
    const kinds = new Set((await svc.versionsFor(tenant.id)).map((v) => v.kind));
    for (const kind of kinds) sources.push({ name: `this server's ${kind} lists`, kind, range: (prefix) => svc.range(tenant.id, kind, prefix) });
    const mode = s.cfg.BREACHED_PASSWORDS;
    if (!values.offline && (values.online || mode === 'hibp' || mode === 'both')) sources.push(hibpSource(s.cfg.BREACHED_HIBP_URL, 'sha1', s.cfg.BREACHED_TIMEOUT_MS));
    const r = await selfCheck(password, sources);
    let found = r.found;
    // The local file (BREACHED_FILE) is searched here; nothing leaves the machine for it.
    if (!found && (mode === 'file' || mode === 'both') && s.cfg.BREACHED_FILE) {
      const f = await new BreachedPasswords({ mode: 'file', hibpUrl: s.cfg.BREACHED_HIBP_URL, timeoutMs: s.cfg.BREACHED_TIMEOUT_MS, file: s.cfg.BREACHED_FILE }).check(password);
      found = f.breached;
      if (f.unavailable?.length) r.failed.push('BREACHED_FILE: could not be read');
    }
    for (const f of r.failed) err(`warning: ${f}\n`);
    if (!sources.length && !(mode === 'file' || mode === 'both')) {
      out('Nothing to check against: no leaked-password lists, and BREACHED_PASSWORDS is off (use --online for the range API).\n');
      return 3;
    }
    out(found ? 'Found in a leaked-password list. Do not use this password.\n' : `Not found in the ${sources.length + ((mode === 'file' || mode === 'both') && s.cfg.BREACHED_FILE ? 1 : 0)} source(s) checked.\n`);
    return found ? 2 : 0;
  }

  if (!(await svc.installed())) throw new Error('Leaked-password lists need the migration 131_leaked_password_lists, which has not been applied.');

  if (cmd === 'passwords:lists') {
    const { values } = parseArgs({ args: argv, options: { tenant: { type: 'string' }, platform: { type: 'boolean' } } });
    const tenant = await tenantOf(s, values.tenant);
    const scopes: ('platform' | 'tenant')[] = values.platform ? ['platform'] : values.tenant ? ['tenant'] : ['platform', 'tenant'];
    for (const sc of scopes) {
      const { lists } = await svc.lists(cliActor(tenant.id), sc);
      out(`${sc === 'platform' ? 'Platform lists' : `Lists of ${tenant.slug}`}: ${lists.length}\n`);
      for (const l of lists) {
        const vs = await svc.versions(l.id);
        const act = vs.find((v) => v.version === l.active_version);
        out(`  ${l.name}  ${l.hash_kind}  ${l.enabled ? 'enabled' : 'off'}  active v${l.active_version ?? '-'}  ${size(act?.entries)} hashes  built ${day(act?.built_at)}  ${vs.length} version(s)${vs[0] && vs[0].state !== 'ready' ? `  latest v${vs[0].version} ${vs[0].state}` : ''}\n`);
      }
    }
    return 0;
  }

  if (cmd === 'passwords:import') {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { list: { type: 'string' }, tenant: { type: 'string' }, platform: { type: 'boolean' }, format: { type: 'string' }, create: { type: 'boolean' }, kind: { type: 'string' }, note: { type: 'string' }, 'no-activate': { type: 'boolean' } } });
    const file = positionals[0];
    if (!file || !values.list) {
      out(`Usage:\n${PASSWORDS_USAGE}`);
      return 64;
    }
    const format = (values.format ?? 'hibp') as ImportFormat;
    if (!(IMPORT_FORMATS as readonly string[]).includes(format)) throw new Error(`--format is one of ${IMPORT_FORMATS.join(', ')}`);
    const kind = (values.kind ?? 'sha1') as HashKind;
    if (!(HASH_KINDS as readonly string[]).includes(kind)) throw new Error(`--kind is one of ${HASH_KINDS.join(', ')}`);
    const tenant = await tenantOf(s, values.tenant);
    const actor = cliActor(tenant.id);
    const scope = values.platform || !values.tenant ? 'platform' : 'tenant';
    let list: ListRow | undefined = (await svc.lists(actor, scope)).lists.find((l) => l.name === values.list);
    if (!list) {
      if (!values.create) throw new Error(`No ${scope} list named ${values.list}; add --create to make it.`);
      list = await svc.create(actor, { scope, name: values.list, hashKind: kind, source: 'cli' });
      out(`Created the ${scope} list ${list.name} (${list.hash_kind}).\n`);
    }
    const source = file === '-' ? (process.stdin as AsyncIterable<Buffer>) : createReadStream(file, { highWaterMark: 1024 * 1024 });
    let last = -1;
    const r = await svc.upload(actor, list.id, {
      format, source, note: values.note ?? null, activate: !values['no-activate'], via: 'cli',
      inline: { onProgress: (pct, message) => { if (pct !== last) { last = pct; err(`${pct}% ${message}\n`); } } }
    });
    out(`Version ${r.version.version} of ${list.name}: ${size(r.counts.lines)} lines read, ${size(r.counts.invalid)} invalid${r.counts.invalidLines.length ? ` (lines ${r.counts.invalidLines.join(', ')}${r.counts.invalid > r.counts.invalidLines.length ? ', …' : ''})` : ''}, ${size(r.version.entries)} hashes after ${size(r.version.duplicates)} duplicates, Bloom filter ${(r.version.fp_rate * 100).toFixed(3)}% false positives; ${r.version.activate ? 'now active' : 'not made active'}.\n`);
    return r.version.state === 'ready' ? 0 : 2;
  }
  out(`Usage:\n${PASSWORDS_USAGE}`);
  return 64;
}
