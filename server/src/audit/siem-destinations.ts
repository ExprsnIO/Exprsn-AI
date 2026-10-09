import { connect as tlsConnect } from 'node:tls';
import { fetch as undiciFetch } from 'undici';
import { ulid } from 'ulid';
import type { Logger } from 'pino';
import type { Db } from '../db/knex.js';
import type { Principal } from '../authz/policy.js';
import { badRequest, conflict, forbidden, notFound } from '../http/problem.js';
import { checkServiceHost, checkServiceUrl, serviceAgent, serviceLookup, type ServicePolicy } from '../platform/egress.js';
import type { DataKeys } from '../platform/datakeys.js';
import type { AuditEvent, AuditLog } from './chain.js';
import { SiemForwarder, type SiemStatus } from './siem.js';

export type DestinationKind = 'https' | 'syslog';
export type DestinationState = 'proposed' | 'active' | 'rejected' | 'disabled';

export interface DestinationRow {
  id: string;
  tenant_id: string;
  name: string;
  kind: DestinationKind;
  url: string;
  token: string | null;
  ca_pem: string | null;
  state: DestinationState;
  proposed_by: string;
  proposed_at: number;
  approved_by: string | null;
  approved_at: number | null;
  decided_by: string | null;
  decided_at: number | null;
  note: string | null;
  delivered: number;
  dropped: number;
  last_delivered_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface DestinationInput {
  name: string;
  kind: DestinationKind;
  url: string;
  token?: string | null;
  caPem?: string | null;
  note?: string | null;
}

const fromRow = (r: Record<string, unknown>): DestinationRow => ({ ...(r as unknown as DestinationRow), delivered: Number(r.delivered ?? 0), dropped: Number(r.dropped ?? 0), proposed_at: Number(r.proposed_at), approved_at: r.approved_at == null ? null : Number(r.approved_at), decided_at: r.decided_at == null ? null : Number(r.decided_at), last_delivered_at: r.last_delivered_at == null ? null : Number(r.last_delivered_at), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });

export const destinationView = (d: DestinationRow, live?: SiemStatus) => ({
  id: d.id, name: d.name, kind: d.kind, url: d.url, hasToken: !!d.token, hasCa: !!d.ca_pem, state: d.state,
  proposedBy: d.proposed_by, proposedAt: d.proposed_at, approvedBy: d.approved_by, approvedAt: d.approved_at, decidedBy: d.decided_by, decidedAt: d.decided_at, note: d.note,
  delivered: d.delivered + (live?.delivered ?? 0), dropped: d.dropped + (live?.dropped ?? 0), pending: live?.pending ?? 0,
  lastDeliveredAt: live?.lastDeliveredAt ?? d.last_delivered_at, lastError: live?.lastError ?? d.last_error, connection: live?.state ?? (d.state === 'active' ? 'idle' : 'disabled')
});

/** RFC 5424 syslog line for one audit event, with RFC 6587 octet-counting framing. Facility 13 (log audit), severity 6 (informational). */
export function syslogFrame(e: AuditEvent, hostname: string): string {
  const pri = 13 * 8 + 6;
  const msgid = e.action.replace(/[^\x21-\x7e]/g, '').slice(0, 32) || '-';
  const line = `<${pri}>1 ${new Date(e.ts).toISOString()} ${hostname} exprsn-ai - ${msgid} - ${JSON.stringify({ source: 'exprsn-ai', ...e })}`;
  return `${Buffer.byteLength(line, 'utf8')} ${line}`;
}

/** Parses `host:port` (or `[v6]:port`); the port is required. */
export function parseSyslogAddress(raw: string): { host: string; port: number } {
  const m = /^(?:\[([^\]]+)\]|([^:\s]+)):(\d{1,5})$/.exec(raw.trim());
  if (!m) throw badRequest('A syslog destination is host:port (for example siem.example.com:6514).');
  const port = Number(m[3]);
  if (port < 1 || port > 65535) throw badRequest('The syslog port is out of range.');
  return { host: (m[1] ?? m[2])!.toLowerCase(), port };
}

/**
 * B-7501: per-tenant audit streaming to a SIEM. A tenant admin proposes a destination (HTTPS, NDJSON batches with a
 * bearer token; or syslog over TLS, RFC 5424 with octet counting), a second tenant admin approves it, and only then
 * do events flow: one forwarder per active destination, fed by the chain's append listener, filtered to the
 * destination's tenant. The outbound address guard applies (no cloud metadata, internal hosts only as the operator
 * allows). Tokens are sealed with the tenant key and never shown again. Counters are flushed to the row every
 * minute so the screen shows delivery across restarts.
 */
export class SiemDestinations {
  private readonly forwarders = new Map<string, { forwarder: SiemForwarder; row: DestinationRow }>();
  private off: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly audit: AuditLog,
    private readonly keys: DataKeys,
    private readonly log: Logger,
    private readonly o: { policy: ServicePolicy; hostname: string; maxPerTenant: number; send?: (d: DestinationRow, body: string) => Promise<void> }
  ) {}

  /** Loads the active destinations and starts streaming. Called once at start (and after each change). */
  async start(): Promise<void> {
    if (!this.off) {
      this.off = this.audit.onAppend((e) => {
        for (const f of this.forwarders.values()) if (f.row.tenant_id === e.tenant_id) f.forwarder.push(e);
      });
      this.timer = setInterval(() => void this.persistCounters().catch(() => undefined), 60_000);
      this.timer.unref();
    }
    const active = (await this.db('audit_siem_destinations').where({ state: 'active' })).map(fromRow);
    const keep = new Set(active.map((d) => d.id));
    for (const [id, f] of this.forwarders) {
      if (!keep.has(id)) {
        f.forwarder.close();
        this.forwarders.delete(id);
      }
    }
    for (const d of active) if (!this.forwarders.has(d.id)) this.forwarders.set(d.id, { forwarder: this.forwarder(d), row: d });
  }

  private forwarder(d: DestinationRow): SiemForwarder {
    const fake = { onAppend: () => () => undefined } as unknown as AuditLog; // events arrive through push(), filtered per tenant
    return new SiemForwarder(fake, this.log, { send: (body) => this.deliver(d, body), batch: 200, external: true });
  }

  /** Sends one NDJSON batch to the destination (HTTPS POST, or one syslog frame per line over TLS). */
  async deliver(d: DestinationRow, body: string): Promise<void> {
    if (this.o.send) return this.o.send(d, body);
    if (d.kind === 'https') {
      await checkServiceUrl(d.url, this.o.policy, { protocols: ['https:'], requireResolve: true });
      const token = d.token ? await this.keys.open(d.tenant_id, d.token, `siem-token:${d.id}`) : null;
      // The dispatcher checks every address it dials against the policy; a private CA applies to this destination only.
      const dispatcher = serviceAgent(this.o.policy, d.ca_pem ? { ca: d.ca_pem } : {}, { headersTimeout: 10_000, bodyTimeout: 10_000 });
      try {
        const res = await undiciFetch(d.url, { method: 'POST', headers: { 'Content-Type': 'application/x-ndjson', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body, signal: AbortSignal.timeout(10_000), redirect: 'error', dispatcher });
        if (!res.ok) throw new Error(`SIEM answered ${res.status}`);
        await res.body?.cancel().catch(() => undefined);
      } finally {
        await dispatcher.close().catch(() => undefined);
      }
      return;
    }
    const { host, port } = parseSyslogAddress(d.url);
    const { addresses } = await checkServiceHost(host, this.o.policy);
    const frames = body.split('\n').filter(Boolean).map((line) => syslogFrame(JSON.parse(line) as AuditEvent, this.o.hostname)).join('');
    await new Promise<void>((resolve, reject) => {
      const sock = tlsConnect({ host: addresses[0], port, servername: host, ...(d.ca_pem ? { ca: d.ca_pem } : {}), lookup: serviceLookup(this.o.policy) as never, timeout: 10_000 }, () => {
        sock.end(frames, () => resolve());
      });
      sock.once('error', reject);
      sock.once('timeout', () => reject(new Error('timed out')));
    });
  }

  private async persistCounters(): Promise<void> {
    for (const f of this.forwarders.values()) {
      const v = f.forwarder.view();
      if (!v.delivered && !v.dropped && !v.lastError) continue;
      await this.db('audit_siem_destinations').where({ id: f.row.id }).update({ delivered: this.db.raw('delivered + ?', [v.delivered]), dropped: this.db.raw('dropped + ?', [v.dropped]), last_delivered_at: v.lastDeliveredAt ?? f.row.last_delivered_at, last_error: v.lastError, updated_at: Date.now() });
      f.forwarder.reset();
    }
  }

  async list(tenantId: string): Promise<(DestinationRow & { live?: SiemStatus })[]> {
    const rows = (await this.db('audit_siem_destinations').where({ tenant_id: tenantId }).orderBy('created_at', 'desc')).map(fromRow);
    return rows.map((r) => ({ ...r, live: this.forwarders.get(r.id)?.forwarder.view() }));
  }

  async get(tenantId: string, id: string): Promise<DestinationRow> {
    const r = await this.db('audit_siem_destinations').where({ tenant_id: tenantId, id }).first();
    if (!r) throw notFound('SIEM destination');
    return fromRow(r);
  }

  async propose(p: Principal, input: DestinationInput): Promise<DestinationRow> {
    const url = input.url.trim();
    if (input.kind === 'https') {
      try {
        await checkServiceUrl(url, this.o.policy, { protocols: ['https:'] });
      } catch (err) {
        throw badRequest((err as Error).message);
      }
    } else parseSyslogAddress(url);
    const open = await this.db('audit_siem_destinations').where({ tenant_id: p.tenantId }).whereIn('state', ['proposed', 'active']).count({ n: '*' }).first();
    if (Number(open?.n ?? 0) >= this.o.maxPerTenant) throw conflict(`This tenant already has ${this.o.maxPerTenant} proposed or active destinations (SIEM_TENANT_MAX_DESTINATIONS).`);
    const t = Date.now();
    const id = ulid();
    const row: DestinationRow = {
      id, tenant_id: p.tenantId, name: input.name.trim().slice(0, 100), kind: input.kind, url: url.slice(0, 500),
      token: input.token ? await this.keys.seal(p.tenantId, input.token, `siem-token:${id}`) : null, ca_pem: input.caPem?.trim() || null,
      state: 'proposed', proposed_by: p.userId, proposed_at: t, approved_by: null, approved_at: null, decided_by: null, decided_at: null, note: input.note?.trim().slice(0, 300) || null,
      delivered: 0, dropped: 0, last_delivered_at: null, last_error: null, created_at: t, updated_at: t
    };
    await this.db('audit_siem_destinations').insert(row);
    await this.audit.append({ tenantId: p.tenantId, action: 'audit.siem.proposed', kind: 'admin', actor: { user: p.userId, username: p.username, name: p.displayName }, target: { destination: id, name: row.name }, detail: { kind: row.kind, host: hostOf(row), hasToken: !!row.token } });
    return row;
  }

  async decide(p: Principal, id: string, decision: 'approve' | 'reject', note: string | null): Promise<DestinationRow> {
    const d = await this.get(p.tenantId, id);
    if (d.state !== 'proposed') throw conflict('Only a proposed destination can be approved or rejected.');
    if (d.proposed_by === p.userId) throw forbidden('Dual control: someone other than the proposer must decide.', { step: 'dual-control' });
    const t = Date.now();
    const patch = decision === 'approve' ? { state: 'active' as const, approved_by: p.userId, approved_at: t, decided_by: p.userId, decided_at: t } : { state: 'rejected' as const, decided_by: p.userId, decided_at: t };
    await this.db('audit_siem_destinations').where({ id }).update({ ...patch, note: note ?? d.note, updated_at: t });
    // The forwarder is up before the decision is written to the chain, so the approval is the first event delivered.
    await this.start();
    await this.audit.append({ tenantId: p.tenantId, action: decision === 'approve' ? 'audit.siem.approved' : 'audit.siem.rejected', kind: 'admin', actor: { user: p.userId, username: p.username, name: p.displayName }, target: { destination: id, name: d.name }, detail: { kind: d.kind, host: hostOf(d), proposedBy: d.proposed_by, note } });
    return this.get(p.tenantId, id);
  }

  async disable(p: Principal, id: string, note: string | null): Promise<DestinationRow> {
    const d = await this.get(p.tenantId, id);
    if (d.state !== 'active' && d.state !== 'proposed') throw conflict('The destination is not active.');
    await this.persistCounters();
    const t = Date.now();
    await this.db('audit_siem_destinations').where({ id }).update({ state: 'disabled', decided_by: p.userId, decided_at: t, note: note ?? d.note, updated_at: t });
    await this.audit.append({ tenantId: p.tenantId, action: 'audit.siem.disabled', kind: 'admin', actor: { user: p.userId, username: p.username, name: p.displayName }, target: { destination: id, name: d.name }, detail: { kind: d.kind, host: hostOf(d), was: d.state, note } });
    await this.start();
    return this.get(p.tenantId, id);
  }

  /** Sends one test event now (any state but rejected), and reports the outcome; audited either way. */
  async test(p: Principal, id: string): Promise<{ ok: boolean; error: string | null }> {
    const d = await this.get(p.tenantId, id);
    if (d.state === 'rejected') throw conflict('A rejected destination is not tested.');
    const event: AuditEvent = { id: ulid(), tenant_id: p.tenantId, seq: 0, ts: Date.now(), action: 'audit.siem.test', kind: 'system', actor: { user: p.userId, username: p.username }, target: { destination: d.id }, label: 'internal', decision: null, detail: { test: true }, trace_id: null, corrects: null, prev_hash: '', hash: '' };
    let error: string | null = null;
    try {
      await this.deliver(d, JSON.stringify({ source: 'exprsn-ai', ...event }) + '\n');
    } catch (err) {
      error = (err as Error).message.slice(0, 300);
    }
    await this.db('audit_siem_destinations').where({ id }).update({ last_error: error, ...(error ? {} : { last_delivered_at: Date.now() }), updated_at: Date.now() });
    await this.audit.append({ tenantId: p.tenantId, action: 'audit.siem.tested', kind: 'admin', actor: { user: p.userId, username: p.username, name: p.displayName }, target: { destination: id, name: d.name }, detail: { ok: !error, error } });
    return { ok: !error, error };
  }

  /** Flushes every forwarder (tests), then returns the live statuses. */
  async flush(): Promise<void> {
    for (const f of this.forwarders.values()) await f.forwarder.flush();
  }

  async close(): Promise<void> {
    this.off?.();
    this.off = null;
    if (this.timer) clearInterval(this.timer);
    await this.persistCounters().catch(() => undefined);
    for (const f of this.forwarders.values()) f.forwarder.close();
    this.forwarders.clear();
  }
}

const hostOf = (d: DestinationRow): string => {
  try {
    return d.kind === 'https' ? new URL(d.url).host : parseSyslogAddress(d.url).host;
  } catch {
    return d.url;
  }
};
