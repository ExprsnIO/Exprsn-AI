import { createHmac, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { ulid } from 'ulid';
import { fetch as undiciFetch } from 'undici';
import { checkUrl, guardedAgent, HostRefused, parseAllowList } from '../mcp/hosts.js';
import { PLATFORM_SCOPE } from '../platform/datakeys.js';
import { badRequest, conflict, notFound } from '../http/problem.js';
import { scrubSecrets } from '../platform/diagnostics.js';
import type { Services } from '../services.js';
import { audit, type OpsActor } from './common.js';
import type { CertRow } from './certs.js';

/*
 * Certificate push hooks (B-904). After an issue or a renewal, each hook of the certificate runs:
 *
 * - `command`: a reload command named in ACME_RELOAD_COMMANDS (an argument array run without a shell, never text
 *   from the API), on every instance once its file sink has written the new PEMs. It gets CERT_NAME, CERT_SERIAL,
 *   CERT_NOT_AFTER and CERT_DIR (the sink directory, when ACME_CERT_DIR is set) in its environment.
 * - `webhook`: a POST from the issuing instance to an internal URL (PLATFORM_ALLOWED_HOSTS for others), signed like
 *   the dns-01 hook: `X-Exprsn-Signature: t=<unix time>,v1=<hex HMAC-SHA256 of "<t>.<body>">` with a per-hook secret
 *   shown once. The body carries the certificate chain and its details, never the private key.
 */

export interface CertHookRow {
  id: string;
  certificate_id: string;
  kind: 'command' | 'webhook';
  command: string | null;
  url: string | null;
  secret_sealed: string | null;
  last_state: 'ok' | 'failed' | null;
  last_detail: string | null;
  last_at: number | null;
  created_by: string | null;
  created_at: number;
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));
const fromRow = (r: Record<string, unknown>): CertHookRow => ({ ...(r as unknown as CertHookRow), last_at: num(r.last_at), created_at: Number(r.created_at) });

export const hookView = (h: CertHookRow) => ({ id: h.id, kind: h.kind, command: h.command, url: h.url, lastState: h.last_state, lastDetail: h.last_detail, lastAt: h.last_at, createdAt: h.created_at });

export type HookEvent = 'certificate.issued' | 'certificate.renewed' | 'certificate.test';

/** Parses ACME_RELOAD_COMMANDS (validated by the config schema). */
export const reloadCommands = (raw: string): Record<string, string[]> => {
  try {
    return JSON.parse(raw) as Record<string, string[]>;
  } catch {
    return {};
  }
};

export class CertHooks {
  constructor(private readonly s: () => Services) {}

  private get commands(): Record<string, string[]> {
    return reloadCommands(this.s().cfg.ACME_RELOAD_COMMANDS);
  }

  commandNames(): string[] {
    return Object.keys(this.commands).sort();
  }

  async list(certId: string): Promise<CertHookRow[]> {
    return ((await this.s().db('platform_cert_hooks').where({ certificate_id: certId }).orderBy('created_at')) as Record<string, unknown>[]).map(fromRow);
  }

  private async get(certId: string, id: string): Promise<CertHookRow> {
    const r = (await this.s().db('platform_cert_hooks').where({ certificate_id: certId, id }).first()) as Record<string, unknown> | undefined;
    if (!r) throw notFound('Hook');
    return fromRow(r);
  }

  private allow() {
    return parseAllowList(this.s().cfg.PLATFORM_ALLOWED_HOSTS);
  }

  /** Adds a hook. A webhook's signing secret is returned once and stored sealed. */
  async add(by: OpsActor, cert: CertRow, input: { kind: 'command'; command: string } | { kind: 'webhook'; url: string }): Promise<{ hook: CertHookRow; secret: string | null }> {
    if (cert.method !== 'acme') throw conflict('Hooks run after ACME issues and renewals; a tracked certificate has none.');
    if ((await this.list(cert.id)).length >= 10) throw conflict('A certificate has at most 10 hooks.');
    const id = ulid();
    let secret: string | null = null;
    const row: Record<string, unknown> = { id, certificate_id: cert.id, kind: input.kind, command: null, url: null, secret_sealed: null, created_by: by.userId, created_at: Date.now() };
    if (input.kind === 'command') {
      if (!this.commands[input.command]) throw badRequest(`${input.command} is not a reload command on this server. ACME_RELOAD_COMMANDS names: ${this.commandNames().join(', ') || 'none'}.`, { field: 'command' });
      row.command = input.command;
    } else {
      try {
        await checkUrl(input.url, this.allow());
      } catch (err) {
        if (err instanceof HostRefused) throw badRequest(err.message, { field: 'url' });
        throw err;
      }
      secret = randomBytes(32).toString('base64url');
      row.url = input.url;
      row.secret_sealed = await this.s().keys.seal(PLATFORM_SCOPE, secret, `platform-cert-hook:${id}`);
    }
    await this.s().db('platform_cert_hooks').insert(row);
    await audit(this.s(), by, 'platform.cert.hook.added', { certificate: cert.id, name: cert.name, hook: id }, { kind: input.kind, command: row.command, url: row.url }, 'admin');
    return { hook: await this.get(cert.id, id), secret };
  }

  async remove(by: OpsActor, cert: CertRow, id: string): Promise<void> {
    const h = await this.get(cert.id, id);
    await this.s().db('platform_cert_hooks').where({ id }).delete();
    await audit(this.s(), by, 'platform.cert.hook.removed', { certificate: cert.id, name: cert.name, hook: id }, { kind: h.kind, command: h.command, url: h.url }, 'admin');
  }

  private async record(by: OpsActor, cert: CertRow, h: CertHookRow, event: HookEvent, ok: boolean, detail: string): Promise<void> {
    const clean = scrubSecrets(detail).slice(0, 500);
    await this.s().db('platform_cert_hooks').where({ id: h.id }).update({ last_state: ok ? 'ok' : 'failed', last_detail: clean, last_at: Date.now() });
    await audit(this.s(), by, ok ? 'platform.cert.hook.ran' : 'platform.cert.hook.failed', { certificate: cert.id, name: cert.name, hook: h.id }, { kind: h.kind, event, command: h.command, url: h.url, detail: clean, instance: hostname() });
  }

  /** The signed webhook POST for one hook. */
  async callWebhook(cert: CertRow, h: CertHookRow, event: HookEvent): Promise<string> {
    if (!h.url || !h.secret_sealed) throw new Error('The hook has no URL or secret.');
    const secret = await this.s().keys.open(PLATFORM_SCOPE, h.secret_sealed, `platform-cert-hook:${h.id}`);
    const allow = this.allow();
    await checkUrl(h.url, allow);
    const body = JSON.stringify({ event, certificate: { id: cert.id, name: cert.name, domains: cert.domains, serial: cert.serial, fingerprint: cert.fingerprint, notBefore: cert.not_before, notAfter: cert.not_after }, chainPem: cert.chain_pem });
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
    const timeoutMs = this.s().cfg.ACME_HOOK_TIMEOUT_MS;
    const agent = guardedAgent(allow, timeoutMs);
    try {
      const res = await undiciFetch(h.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-exprsn-event': event, 'x-exprsn-signature': `t=${t},v1=${sig}` }, body, dispatcher: agent, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
      const text = await res.text().catch(() => '');
      if (!res.ok) throw new Error(`The hook answered ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
      return `HTTP ${res.status}`;
    } finally {
      await agent.close().catch(() => undefined);
    }
  }

  /** Runs a named reload command (no shell) with the certificate in its environment. */
  runCommand(cert: CertRow, name: string, dir: string | null): Promise<string> {
    const argv = this.commands[name];
    if (!argv?.length) return Promise.reject(new Error(`${name} is no longer in ACME_RELOAD_COMMANDS.`));
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', CERT_NAME: cert.name, CERT_SERIAL: cert.serial ?? '', CERT_NOT_AFTER: cert.not_after ? new Date(cert.not_after).toISOString() : '', CERT_DIR: dir ?? '' };
    return new Promise((resolve, reject) => {
      execFile(argv[0]!, argv.slice(1), { env, timeout: this.s().cfg.ACME_HOOK_TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`${name} failed: ${(stderr || err.message).toString().trim().slice(0, 300)}`));
        resolve(`${name} ran${stdout.trim() ? `: ${stdout.trim().slice(0, 200)}` : ''}`);
      });
    });
  }

  /** After an issue or renewal, on the issuing instance: every webhook hook. */
  async fireWebhooks(by: OpsActor, certId: string, event: HookEvent): Promise<void> {
    const cert = await this.s().ops.certs.get(certId);
    for (const h of (await this.list(certId)).filter((x) => x.kind === 'webhook')) {
      try {
        await this.record(by, cert, h, event, true, await this.callWebhook(cert, h, event));
      } catch (err) {
        await this.record(by, cert, h, event, false, (err as Error).message);
      }
    }
  }

  /** On every instance, after its sink wrote the files: every reload command hook. */
  async runCommands(by: OpsActor, certId: string, event: HookEvent, dir: string | null): Promise<void> {
    const cert = await this.s().ops.certs.get(certId);
    for (const h of (await this.list(certId)).filter((x) => x.kind === 'command' && x.command)) {
      try {
        await this.record(by, cert, h, event, true, await this.runCommand(cert, h.command!, dir));
      } catch (err) {
        await this.record(by, cert, h, event, false, (err as Error).message);
      }
    }
  }

  /** Runs one hook now (a test from the console); commands run on this instance only. */
  async test(by: OpsActor, cert: CertRow, id: string): Promise<CertHookRow> {
    const h = await this.get(cert.id, id);
    if (!cert.chain_pem) throw conflict('The certificate has not been issued yet.');
    try {
      const detail = h.kind === 'webhook' ? await this.callWebhook(cert, h, 'certificate.test') : await this.runCommand(cert, h.command!, null);
      await this.record(by, cert, h, 'certificate.test', true, detail);
    } catch (err) {
      await this.record(by, cert, h, 'certificate.test', false, (err as Error).message);
    }
    return this.get(cert.id, id);
  }
}
