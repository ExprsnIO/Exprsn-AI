import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { AuditActor } from '../audit/chain.js';
import { clears, type Label } from '../authz/labels.js';
import type { Permission } from '../authz/permissions.js';
import { json } from '../db/knex.js';
import { badRequest, conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import { notifyAdmins } from '../ops/common.js';
import type { Services } from '../services.js';
import { licenceDenied, parseReport, ScanFormatError, SEVERITIES, type Finding, type ScanFormat, type ScanSummary, type Severity } from './scan-formats.js';

/*
 * 1.8.0, Sprint 48 (B-144): security scan results attached to artefacts, and the gate that promotion asks.
 *
 * Artefacts and their digests (a result applies only to the exact digest it was uploaded for):
 *   app-package    `sha256:<package hash>` (`app_packages.hash`): what a pipeline promotes
 *   plugin-bundle  the bundle digest a plugin was installed from, or `sha256:<manifest hash>` for an inline manifest
 *   script-image   the image digest (`<repository>@sha256:…`): a SCRIPT_IMAGE_* setting names its image by digest to
 *                  match a result; a tag alone is mutable, so it counts as "no result"
 *
 * The gate (`evaluate`, `gate`) reads the tenant's policy:
 *   - the latest fresh result of each format for the digest (one older than `maxAgeDays` is ignored: a digest whose
 *     results are all stale is refused);
 *   - critical and high findings above `maxCritical` and `maxHigh` refuse it, less those an active exception accepts;
 *   - a licence on the deny-list refuses it (an `A OR B` expression only when every alternative is denied);
 *   - no result at all: `missing: 'warn'` (the default) allows it with a warning, `missing: 'refuse'` refuses it.
 *
 * Why "no result" allows by default: promotion, plugin enablement and the script images worked before scans existed,
 * and most installations have no CI hook uploading results yet. Refusing everything unscanned the day this lands
 * would stop every deployment at once, including the rollback-adjacent fixes an incident needs; a warning on every
 * unscanned promotion (and in the audit log, `security.gate.warned`) makes the gap visible until a platform admin
 * turns `missing` to `refuse`. A tenant that uploads results gets the full gate for those artefacts immediately.
 *
 * Who may do what (each route names its permission):
 *   - read and upload results for a kind: that kind's permission (KIND_PERMISSION): apps:design, plugins:manage,
 *     platform:manage; a CI hook uses an API key with that scope;
 *   - change the policy, delete a result, approve or revoke an exception: platform:manage;
 *   - request an exception: the kind's permission; an exception for every kind needs platform:manage;
 *   - an exception is approved by someone other than its requester (dual control).
 */

export const ARTEFACT_KINDS = ['app-package', 'plugin-bundle', 'script-image'] as const;
export type ArtefactKind = (typeof ARTEFACT_KINDS)[number];

export const KIND_PERMISSION: Record<ArtefactKind, Permission> = { 'app-package': 'apps:design', 'plugin-bundle': 'plugins:manage', 'script-image': 'platform:manage' };
export const KIND_NOUN: Record<ArtefactKind, string> = { 'app-package': 'app package', 'plugin-bundle': 'plugin bundle', 'script-image': 'script runner image' };

export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
export const MAX_REPORT_BYTES = 16 * 1024 * 1024;
export const MAX_EXCEPTION_DAYS = 365;

export interface ScanPolicy {
  maxCritical: number | null;
  maxHigh: number | null;
  maxAgeDays: number | null;
  missing: 'warn' | 'refuse';
  licenceDeny: string[];
}

export const DEFAULT_POLICY: ScanPolicy = { maxCritical: 0, maxHigh: null, maxAgeDays: null, missing: 'warn', licenceDeny: [] };

export interface ScanActor {
  tenantId: string;
  userId: string | null;
  clearance: Label;
  audit: AuditActor;
  traceId?: string | null;
}

export interface Artefact {
  kind: ArtefactKind;
  /** null when the artefact has no digest to match (an image named by tag). */
  digest: string | null;
  ref?: string | null;
  name?: string | null;
}

export type GateWhere = 'pipeline.promote' | 'pipeline.deploy' | 'plugin.enable' | 'plugin.upgrade' | 'script-image' | 'preview';

export interface GateFinding extends Finding {
  reason: string;
  exception?: string;
}

export interface GateOutcome {
  outcome: 'pass' | 'warn' | 'block';
  allowed: boolean;
  artefact: Artefact;
  reasons: string[];
  warnings: string[];
  results: { id: string; format: ScanFormat; tool: string | null; scannedAt: number; uploadedAt: number; stale: boolean }[];
  counts: Record<Severity, number>;
  blocking: GateFinding[];
  excepted: GateFinding[];
  policy: ScanPolicy;
}

interface ResultRow {
  id: string;
  tenant_id: string;
  artefact_kind: ArtefactKind;
  artefact_digest: string;
  artefact_ref: string | null;
  artefact_name: string | null;
  label: Label;
  format: ScanFormat;
  tool: string | null;
  tool_version: string | null;
  report_digest: string;
  summary: string;
  findings: string;
  finding_count: number;
  scanned_at: number;
  uploaded_by: string | null;
  uploaded_via: string;
  uploaded_at: number;
}

interface ExceptionRow {
  id: string;
  tenant_id: string;
  finding_id: string;
  package: string | null;
  artefact_kind: ArtefactKind | null;
  artefact_digest: string | null;
  reason: string;
  expires_at: number;
  state: 'pending' | 'active' | 'rejected' | 'withdrawn' | 'revoked';
  requested_by: string;
  requested_at: number;
  decided_by: string | null;
  decided_at: number | null;
  note: string | null;
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));

const resultView = (r: ResultRow, withFindings = false) => ({
  id: r.id,
  kind: r.artefact_kind,
  digest: r.artefact_digest,
  ref: r.artefact_ref,
  name: r.artefact_name,
  label: r.label,
  format: r.format,
  tool: r.tool,
  toolVersion: r.tool_version,
  reportDigest: r.report_digest,
  summary: json<ScanSummary>(r.summary, { total: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }, byKind: {}, licences: [], truncated: false }),
  findingCount: Number(r.finding_count),
  scannedAt: Number(r.scanned_at),
  uploadedBy: r.uploaded_by,
  uploadedVia: r.uploaded_via,
  uploadedAt: Number(r.uploaded_at),
  ...(withFindings ? { findings: json<Finding[]>(r.findings, []) } : {})
});
export type ScanResultView = ReturnType<typeof resultView>;

const exceptionView = (e: ExceptionRow, names: Map<string, string>, now = Date.now()) => ({
  id: e.id,
  findingId: e.finding_id,
  package: e.package,
  kind: e.artefact_kind,
  digest: e.artefact_digest,
  reason: e.reason,
  expiresAt: Number(e.expires_at),
  expired: Number(e.expires_at) <= now,
  state: e.state,
  requestedBy: e.requested_by,
  requestedByName: names.get(e.requested_by) ?? null,
  requestedAt: Number(e.requested_at),
  acceptedBy: e.state === 'active' || e.state === 'revoked' ? e.decided_by : null,
  decidedBy: e.decided_by,
  decidedByName: e.decided_by ? (names.get(e.decided_by) ?? null) : null,
  decidedAt: num(e.decided_at),
  note: e.note
});

/** Severities that count towards the thresholds (licence findings are judged by the deny-list instead). */
const counted = (f: Finding) => f.kind !== 'licence';

export class SecurityScans {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  private audit(by: ScanActor, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>, label: Label = 'internal') {
    return this.s().audit.append({ tenantId: by.tenantId, action, kind: by.userId ? 'admin' : 'system', actor: by.audit, target, label, ...(detail ? { detail } : {}), traceId: by.traceId ?? null });
  }

  private async names(ids: (string | null)[]): Promise<Map<string, string>> {
    const want = [...new Set(ids.filter((x): x is string => !!x))];
    if (!want.length) return new Map();
    const rows = (await this.db('users').whereIn('id', want).select('id', 'display_name', 'username')) as { id: string; display_name: string | null; username: string }[];
    return new Map(rows.map((u) => [u.id, u.display_name || u.username]));
  }

  // ---------- policy ----------

  async policy(tenantId: string): Promise<ScanPolicy & { version: number; updatedBy: string | null; updatedAt: number | null }> {
    const r = (await this.db('security_scan_policies').where({ tenant_id: tenantId }).first()) as Record<string, unknown> | undefined;
    if (!r) return { ...DEFAULT_POLICY, version: 0, updatedBy: null, updatedAt: null };
    return { maxCritical: num(r.max_critical), maxHigh: num(r.max_high), maxAgeDays: num(r.max_age_days), missing: r.missing === 'refuse' ? 'refuse' : 'warn', licenceDeny: json<string[]>(r.licence_deny, []), version: Number(r.version), updatedBy: (r.updated_by as string | null) ?? null, updatedAt: num(r.updated_at) };
  }

  async setPolicy(by: ScanActor, input: ScanPolicy): Promise<Awaited<ReturnType<SecurityScans['policy']>>> {
    const before = await this.policy(by.tenantId);
    const deny = [...new Set(input.licenceDeny.map((l) => l.trim()).filter(Boolean))].sort();
    const row = { max_critical: input.maxCritical, max_high: input.maxHigh, max_age_days: input.maxAgeDays, missing: input.missing, licence_deny: JSON.stringify(deny), version: before.version + 1, updated_by: by.userId, updated_at: Date.now() };
    const n = await this.db('security_scan_policies').where({ tenant_id: by.tenantId }).update(row);
    if (!n) await this.db('security_scan_policies').insert({ tenant_id: by.tenantId, ...row });
    const { version: _v, updatedBy: _u, updatedAt: _a, ...was } = before;
    void _v; void _u; void _a;
    await this.audit(by, 'security.scan.policy.updated', { policy: by.tenantId }, { before: was, after: { maxCritical: input.maxCritical, maxHigh: input.maxHigh, maxAgeDays: input.maxAgeDays, missing: input.missing, licenceDeny: deny }, version: row.version });
    return this.policy(by.tenantId);
  }

  // ---------- artefacts ----------

  /** The artefact behind a kind and digest, checked against what exists in the tenant, with its label and name. */
  private async resolveArtefact(tenantId: string, kind: ArtefactKind, digest: string, ref: string | null): Promise<{ ref: string | null; name: string | null; label: Label }> {
    if (kind === 'app-package') {
      const pkg = (await this.db('app_packages').where({ tenant_id: tenantId, hash: digest.slice(7) }).orderBy('created_at', 'desc').first('id', 'app_id', 'app_name', 'version')) as { id: string; app_id: string; app_name: string; version: number } | undefined;
      if (!pkg) throw notFound(`App package with digest ${digest}`);
      const app = (await this.db('apps').where({ id: pkg.app_id }).first('label')) as { label: Label } | undefined;
      return { ref: pkg.id, name: `${pkg.app_name} v${pkg.version}`, label: app?.label ?? 'internal' };
    }
    if (kind === 'plugin-bundle') {
      const rows = (await this.db('plugins').where({ tenant_id: tenantId }).select('plugin_key', 'version', 'bundle_digest', 'manifest_hash', 'max_label')) as { plugin_key: string; version: string; bundle_digest: string | null; manifest_hash: string; max_label: Label }[];
      const p = rows.find((r) => r.bundle_digest === digest || `sha256:${r.manifest_hash}` === digest);
      return { ref: p ? p.plugin_key : ref, name: p ? `${p.plugin_key} ${p.version}` : ref, label: p?.max_label ?? 'internal' };
    }
    return { ref, name: ref ? ref.split('@')[0]!.slice(0, 200) : null, label: 'internal' };
  }

  /** The digest of a SCRIPT_IMAGE_* value: `<repository>@sha256:<hex>`, or null for a tag. */
  static imageDigest(image: string): string | null {
    const m = /@(sha256:[0-9a-f]{64})$/.exec(image.trim());
    return m ? m[1]! : null;
  }

  /** The gate's artefact for a stored app package. */
  static packageArtefact(pkg: { id: string; hash: string; app_name: string; version: number }): Artefact {
    return { kind: 'app-package', digest: `sha256:${pkg.hash}`, ref: pkg.id, name: `${pkg.app_name} v${pkg.version}` };
  }

  /** The gate's artefact for an installed plugin: its bundle digest, or its manifest hash when installed inline. */
  static pluginArtefact(p: { plugin_key: string; version: string; bundle_digest: string | null; manifest_hash: string }): Artefact {
    return { kind: 'plugin-bundle', digest: p.bundle_digest && DIGEST_RE.test(p.bundle_digest) ? p.bundle_digest : `sha256:${p.manifest_hash}`, ref: p.plugin_key, name: `${p.plugin_key} ${p.version}` };
  }

  // ---------- results ----------

  /** Reads a report, normalises it and stores it against the artefact's digest. */
  async upload(by: ScanActor, input: { kind: ArtefactKind; digest?: string | null; ref?: string | null; format?: ScanFormat; scannedAt?: number | null; via: 'console' | 'api' }, text: string) {
    if (Buffer.byteLength(text) > MAX_REPORT_BYTES) throw new HttpProblem(413, 'Report too large', `A report is at most ${MAX_REPORT_BYTES} bytes.`);
    let parsed;
    try {
      parsed = parseReport(text, input.format);
    } catch (err) {
      if (err instanceof ScanFormatError) throw new HttpProblem(422, 'Report refused', err.message, { extensions: { step: 'scan-format' } });
      throw err;
    }
    const digest = input.digest ?? parsed.digest;
    if (!digest) throw badRequest('Name the artefact\'s digest (sha256:…): this report does not carry one.');
    if (!DIGEST_RE.test(digest)) throw badRequest('The digest is sha256: followed by 64 lower-case hexadecimal characters.');
    if (input.digest && parsed.digest && parsed.digest !== input.digest && input.kind === 'script-image') throw new HttpProblem(422, 'Report refused', `The report is for ${parsed.digest}, not ${input.digest}.`, { extensions: { step: 'scan-digest' } });
    const art = await this.resolveArtefact(by.tenantId, input.kind, digest, input.ref ?? parsed.artefactName ?? null);
    if (!clears(by.clearance, art.label)) throw forbidden(`Your clearance is ${by.clearance}; this artefact is ${art.label}.`, { step: 'clearance' });
    const now = Date.now();
    const scannedAt = input.scannedAt ?? parsed.scannedAt ?? now;
    if (scannedAt > now + 5 * 60_000) throw badRequest('The scan time is in the future.');
    const row: ResultRow = {
      id: ulid(),
      tenant_id: by.tenantId,
      artefact_kind: input.kind,
      artefact_digest: digest,
      artefact_ref: art.ref?.slice(0, 300) ?? null,
      artefact_name: art.name?.slice(0, 200) ?? null,
      label: art.label,
      format: parsed.format,
      tool: parsed.tool,
      tool_version: parsed.toolVersion,
      report_digest: 'sha256:' + createHash('sha256').update(text).digest('hex'),
      summary: JSON.stringify(parsed.summary),
      findings: JSON.stringify(parsed.findings),
      finding_count: parsed.summary.total,
      scanned_at: scannedAt,
      uploaded_by: by.userId,
      uploaded_via: input.via,
      uploaded_at: now
    };
    await this.db('security_scan_results').insert(row);
    await this.audit(by, 'security.scan.uploaded', { result: row.id, kind: row.artefact_kind, digest, ref: row.artefact_ref, name: row.artefact_name }, { format: row.format, tool: row.tool, toolVersion: row.tool_version, reportDigest: row.report_digest, scannedAt, bySeverity: parsed.summary.bySeverity, licences: parsed.summary.licences.slice(0, 50), total: parsed.summary.total, via: input.via }, art.label);
    return resultView(row);
  }

  async list(tenantId: string, clearance: Label, opts: { kinds: readonly ArtefactKind[]; digest?: string; limit?: number }) {
    if (!opts.kinds.length) return [];
    const q = this.db('security_scan_results').where({ tenant_id: tenantId }).whereIn('artefact_kind', [...opts.kinds]).orderBy('uploaded_at', 'desc').limit(Math.min(Math.max(opts.limit ?? 100, 1), 500));
    if (opts.digest) q.andWhere({ artefact_digest: opts.digest });
    return ((await q) as ResultRow[]).filter((r) => clears(clearance, r.label)).map((r) => resultView(r));
  }

  private async row(tenantId: string, id: string): Promise<ResultRow> {
    const r = (await this.db('security_scan_results').where({ tenant_id: tenantId, id }).first()) as ResultRow | undefined;
    if (!r) throw notFound('Scan result');
    return r;
  }

  async get(tenantId: string, clearance: Label, id: string, kinds: readonly ArtefactKind[]) {
    const r = await this.row(tenantId, id);
    if (!kinds.includes(r.artefact_kind) || !clears(clearance, r.label)) throw notFound('Scan result');
    return resultView(r, true);
  }

  async remove(by: ScanActor, id: string): Promise<void> {
    const r = await this.row(by.tenantId, id);
    await this.db('security_scan_results').where({ id: r.id }).delete();
    await this.audit(by, 'security.scan.deleted', { result: r.id, kind: r.artefact_kind, digest: r.artefact_digest, name: r.artefact_name }, { format: r.format, scannedAt: Number(r.scanned_at) }, r.label);
  }

  // ---------- exceptions (dual control) ----------

  async exceptions(tenantId: string, opts: { state?: ExceptionRow['state'] } = {}) {
    const q = this.db('security_scan_exceptions').where({ tenant_id: tenantId }).orderBy('requested_at', 'desc').limit(500);
    if (opts.state) q.andWhere({ state: opts.state });
    const rows = (await q) as ExceptionRow[];
    const names = await this.names(rows.flatMap((r) => [r.requested_by, r.decided_by]));
    return rows.map((r) => exceptionView(r, names));
  }

  private async exceptionRow(tenantId: string, id: string): Promise<ExceptionRow> {
    const r = (await this.db('security_scan_exceptions').where({ tenant_id: tenantId, id }).first()) as ExceptionRow | undefined;
    if (!r) throw notFound('Exception');
    return r;
  }

  private async exceptionOut(tenantId: string, id: string) {
    const r = await this.exceptionRow(tenantId, id);
    return exceptionView(r, await this.names([r.requested_by, r.decided_by]));
  }

  async requestException(by: ScanActor, input: { findingId: string; package?: string | null; kind?: ArtefactKind | null; digest?: string | null; reason: string; expiresAt: number }) {
    if (!by.userId) throw forbidden('An exception is requested by a person.');
    const now = Date.now();
    if (input.expiresAt <= now) throw badRequest('The expiry is in the past.');
    if (input.expiresAt > now + MAX_EXCEPTION_DAYS * 86_400_000) throw badRequest(`An exception lasts at most ${MAX_EXCEPTION_DAYS} days.`);
    if (input.digest && !DIGEST_RE.test(input.digest)) throw badRequest('The digest is sha256: followed by 64 lower-case hexadecimal characters.');
    if (input.digest && !input.kind) throw badRequest('An exception for one digest names its kind.');
    const row: ExceptionRow = { id: ulid(), tenant_id: by.tenantId, finding_id: input.findingId, package: input.package ?? null, artefact_kind: input.kind ?? null, artefact_digest: input.digest ?? null, reason: input.reason, expires_at: input.expiresAt, state: 'pending', requested_by: by.userId, requested_at: now, decided_by: null, decided_at: null, note: null };
    await this.db('security_scan_exceptions').insert(row);
    await this.audit(by, 'security.scan.exception.requested', { exception: row.id, finding: row.finding_id, package: row.package, kind: row.artefact_kind, digest: row.artefact_digest }, { reason: row.reason, expiresAt: row.expires_at });
    await notifyAdmins(this.s(), { kind: 'security.scan.exception', title: `An exception for ${row.finding_id} waits for a second platform admin`, body: row.reason.slice(0, 300) }).catch(() => 0);
    return this.exceptionOut(by.tenantId, row.id);
  }

  private async decide(by: ScanActor, id: string, from: ExceptionRow['state'], to: ExceptionRow['state'], note: string | null): Promise<ExceptionRow> {
    const r = await this.exceptionRow(by.tenantId, id);
    if (r.state !== from) throw conflict(`The exception is ${r.state}.`);
    const n = await this.db('security_scan_exceptions').where({ id, state: from }).update({ state: to, decided_by: by.userId, decided_at: Date.now(), note });
    if (!n) throw conflict('The exception was decided by someone else.');
    return r;
  }

  /** Dual control: the approver is a platform admin other than the requester. The approver is who accepted it. */
  async approveException(by: ScanActor, id: string, note: string | null) {
    const r = await this.exceptionRow(by.tenantId, id);
    if (r.requested_by === by.userId) throw forbidden('Dual control: you cannot approve your own exception. Another platform admin must approve it.', { step: 'dual-control' });
    if (Number(r.expires_at) <= Date.now()) throw conflict('The exception has already expired; request a new one.');
    await this.decide(by, id, 'pending', 'active', note);
    await this.audit(by, 'security.scan.exception.approved', { exception: id, finding: r.finding_id, package: r.package, kind: r.artefact_kind, digest: r.artefact_digest }, { requestedBy: r.requested_by, acceptedBy: by.userId, reason: r.reason, expiresAt: Number(r.expires_at), note });
    return this.exceptionOut(by.tenantId, id);
  }

  async rejectException(by: ScanActor, id: string, note: string | null) {
    const r = await this.exceptionRow(by.tenantId, id);
    if (r.requested_by === by.userId) throw conflict('This is your own request: withdraw it instead.');
    await this.decide(by, id, 'pending', 'rejected', note);
    await this.audit(by, 'security.scan.exception.rejected', { exception: id, finding: r.finding_id }, { requestedBy: r.requested_by, note });
    return this.exceptionOut(by.tenantId, id);
  }

  async withdrawException(by: ScanActor, id: string) {
    const r = await this.exceptionRow(by.tenantId, id);
    if (r.requested_by !== by.userId) throw forbidden('Only the requester can withdraw an exception; reject it instead.', { step: 'dual-control' });
    await this.decide(by, id, 'pending', 'withdrawn', null);
    await this.audit(by, 'security.scan.exception.withdrawn', { exception: id, finding: r.finding_id }, {});
    return this.exceptionOut(by.tenantId, id);
  }

  /** Ends an active exception early (any platform admin: narrowing needs no second person). */
  async revokeException(by: ScanActor, id: string, note: string | null) {
    const r = await this.exceptionRow(by.tenantId, id);
    if (r.state !== 'active') throw conflict(`The exception is ${r.state}.`);
    const n = await this.db('security_scan_exceptions').where({ id, state: 'active' }).update({ state: 'revoked', note, decided_at: Date.now() });
    if (!n) throw conflict('The exception changed meanwhile.');
    await this.audit(by, 'security.scan.exception.revoked', { exception: id, finding: r.finding_id }, { acceptedBy: r.decided_by, revokedBy: by.userId, note });
    return this.exceptionOut(by.tenantId, id);
  }

  // ---------- the gate ----------

  /** What the gate would decide for an artefact now. Reads only; writes nothing. */
  async evaluate(tenantId: string, a: Artefact): Promise<GateOutcome> {
    const p = await this.policy(tenantId);
    const policy: ScanPolicy = { maxCritical: p.maxCritical, maxHigh: p.maxHigh, maxAgeDays: p.maxAgeDays, missing: p.missing, licenceDeny: p.licenceDeny };
    const now = Date.now();
    const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
    const out: GateOutcome = { outcome: 'pass', allowed: true, artefact: a, reasons: [], warnings: [], results: [], counts, blocking: [], excepted: [], policy };
    const noun = KIND_NOUN[a.kind];
    const missing = (why: string) => {
      if (policy.missing === 'refuse') {
        out.outcome = 'block';
        out.allowed = false;
        out.reasons.push(`${why} The policy refuses ${noun}s without a scan result.`);
      } else {
        out.outcome = 'warn';
        out.warnings.push(`${why} Allowed without a scan (the policy allows it with a warning).`);
      }
      return out;
    };
    if (!a.digest) return missing(a.kind === 'script-image' ? 'The image is named by a tag, not a digest, so no scan result can match it: pin it as <repository>@sha256:….' : `The ${noun} has no digest.`);
    const rows = (await this.db('security_scan_results').where({ tenant_id: tenantId, artefact_kind: a.kind, artefact_digest: a.digest }).orderBy('scanned_at', 'desc').orderBy('uploaded_at', 'desc')) as ResultRow[];
    if (!rows.length) return missing(`No scan result is attached to this ${noun} (${a.digest.slice(0, 19)}…).`);
    const maxAge = policy.maxAgeDays == null ? null : policy.maxAgeDays * 86_400_000;
    const latest = new Map<ScanFormat, ResultRow>();
    for (const r of rows) if (!latest.has(r.format)) latest.set(r.format, r);
    const fresh: ResultRow[] = [];
    for (const r of latest.values()) {
      const stale = maxAge != null && now - Number(r.scanned_at) > maxAge;
      out.results.push({ id: r.id, format: r.format, tool: r.tool, scannedAt: Number(r.scanned_at), uploadedAt: Number(r.uploaded_at), stale });
      if (stale) out.warnings.push(`The ${r.format} result from ${new Date(Number(r.scanned_at)).toISOString().slice(0, 10)} is older than ${policy.maxAgeDays} days and is not counted.`);
      else fresh.push(r);
    }
    if (!fresh.length) {
      out.outcome = 'block';
      out.allowed = false;
      out.reasons.push(`Every scan result for this ${noun} is older than ${policy.maxAgeDays} days: scan it again.`);
      return out;
    }
    const exceptions = ((await this.db('security_scan_exceptions').where({ tenant_id: tenantId, state: 'active' }).andWhere('expires_at', '>', now)) as ExceptionRow[]).filter((e) => (!e.artefact_kind || e.artefact_kind === a.kind) && (!e.artefact_digest || e.artefact_digest === a.digest));
    const exceptionFor = (f: Finding) => exceptions.find((e) => e.finding_id.toLowerCase() === f.id.toLowerCase() && (!e.package || e.package === f.package));
    const seen = new Set<string>();
    const findings: Finding[] = [];
    for (const r of fresh) {
      for (const f of json<Finding[]>(r.findings, [])) {
        const key = `${f.kind}|${f.id}|${f.package ?? ''}|${f.version ?? ''}|${f.licence ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push(f);
      }
    }
    const over: { sev: 'critical' | 'high'; limit: number | null; list: GateFinding[] }[] = [
      { sev: 'critical', limit: policy.maxCritical, list: [] },
      { sev: 'high', limit: policy.maxHigh, list: [] }
    ];
    const licenceBlocks: GateFinding[] = [];
    for (const f of findings) {
      if (counted(f)) {
        const bucket = over.find((o) => o.sev === f.severity);
        const ex = bucket ? exceptionFor(f) : undefined;
        if (ex) {
          out.excepted.push({ ...f, reason: `accepted until ${new Date(Number(ex.expires_at)).toISOString().slice(0, 10)}: ${ex.reason}`, exception: ex.id });
          continue;
        }
        counts[f.severity]++;
        if (bucket) bucket.list.push({ ...f, reason: `${f.severity} ${f.kind}` });
      }
      if (f.licence) {
        const hit = licenceDenied(f.licence, policy.licenceDeny);
        if (!hit) continue;
        const ex = exceptionFor(f) ?? exceptions.find((e) => e.finding_id.toLowerCase() === `licence:${hit}`.toLowerCase() && (!e.package || e.package === f.package));
        if (ex) out.excepted.push({ ...f, reason: `licence accepted until ${new Date(Number(ex.expires_at)).toISOString().slice(0, 10)}: ${ex.reason}`, exception: ex.id });
        else licenceBlocks.push({ ...f, reason: `licence ${hit} is on the deny-list` });
      }
    }
    for (const o of over) {
      if (o.limit == null || o.list.length <= o.limit) continue;
      out.reasons.push(`${o.list.length} ${o.sev} finding${o.list.length === 1 ? '' : 's'} (the policy allows ${o.limit}).`);
      out.blocking.push(...o.list);
    }
    if (licenceBlocks.length) {
      out.reasons.push(`${licenceBlocks.length} component${licenceBlocks.length === 1 ? '' : 's'} under a denied licence (${[...new Set(licenceBlocks.map((f) => f.licence))].slice(0, 5).join(', ')}).`);
      out.blocking.push(...licenceBlocks);
    }
    out.blocking = out.blocking.slice(0, 200);
    out.excepted = out.excepted.slice(0, 200);
    if (out.reasons.length) {
      out.outcome = 'block';
      out.allowed = false;
    } else if (out.warnings.length) out.outcome = 'warn';
    return out;
  }

  /**
   * The gate a promotion, a plugin enablement or upgrade and a script image setting ask: evaluates, writes
   * `security.gate.passed`, `security.gate.warned` or `security.gate.blocked`, and refuses (409) with the blocking
   * findings listed when the outcome is a block.
   */
  async gate(by: ScanActor, a: Artefact, where: GateWhere, label: Label = 'internal'): Promise<GateOutcome> {
    const g = await this.evaluate(by.tenantId, a);
    const action = g.outcome === 'block' ? 'security.gate.blocked' : g.outcome === 'warn' ? 'security.gate.warned' : 'security.gate.passed';
    await this.audit(by, action, { kind: a.kind, digest: a.digest, ref: a.ref ?? null, name: a.name ?? null }, { where, results: g.results.map((r) => r.id), counts: g.counts, reasons: g.reasons, warnings: g.warnings, blocking: g.blocking.slice(0, 20).map((f) => ({ id: f.id, severity: f.severity, package: f.package, licence: f.licence })), excepted: [...new Set(g.excepted.map((f) => f.exception))] }, label);
    if (!g.allowed) {
      const list = g.blocking.slice(0, 10).map((f) => (f.licence && f.kind === 'licence' ? `${f.package ?? f.id} (${f.licence})` : `${f.id}${f.package ? ` in ${f.package}${f.version ? ` ${f.version}` : ''}` : ''}`));
      throw new HttpProblem(409, 'Security gate refused', `The ${KIND_NOUN[a.kind]} ${a.name ?? a.digest ?? ''} did not pass the security gate: ${g.reasons.join(' ')}${list.length ? ` Blocking: ${list.join(', ')}${g.blocking.length > list.length ? ` and ${g.blocking.length - list.length} more` : ''}.` : ''}`, { extensions: { step: 'security-gate', gate: g } });
    }
    return g;
  }
}
