import { ulid } from 'ulid';
import { actorFrom, isUniqueViolation } from '../audit/chain.js';
import { clears, isLabel, LABELS, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import { objectHash } from '../moderation/registry.js';
import type { Services } from '../services.js';
import type { HoldCtx, HoldRow } from './holds.js';

/*
 * Evidence retention and legal hold on cases and single objects (1.7.0, B-9502, B-9504).
 *
 * A case is a flag with the moderation actions taken from it and the appeals of those actions. An object that a
 * moderation action hid or took down is evidence while its case is open: the flag is still open, an appeal of the
 * action waits or is being reviewed, or the last decision (the action, the flag's decision, an appeal's) is younger
 * than MODERATION_EVIDENCE_DAYS, the time its owner has to appeal with the content still there. After that the object
 * falls back to its own retention. A reversed action ends the case for the object at once: it is visible again.
 *
 * A legal hold (compliance/holds.ts) may also name a case (its flag) or one object. The object of a held case, and a
 * held object, are kept whatever their state, until the hold is released.
 *
 * Every purge path asks `keptOf(tenant, type)` for the ids it must leave, and tells `recordSkip` what it left: that
 * writes one row and one audit entry per object, path and reason, however often the sweep runs. A user-facing hard
 * delete asks `assertDeletable`.
 */

export type KeptReason = 'evidence' | 'legal-hold';

export interface Kept {
  reason: KeptReason;
  /** The moderation action (evidence) or the legal hold. */
  ref: string;
}

export const EVIDENCE_EXPORT_JOB = 'compliance.evidence-export';
const MAX_KEPT = 20_000;
const EXPORT_MAX_TEXT = 2_000_000;

type ExportState = 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'ready' | 'failed';

interface ExportRow {
  id: string;
  tenant_id: string;
  hold_id: string;
  label: Label;
  reason: string;
  requested_by: string;
  approver_id: string;
  state: ExportState;
  decided_by: string | null;
  decided_at: number | null;
  note: string | null;
  job_id: string | null;
  file: string | null;
  blob_key: string | null;
  objects: number | null;
  error: string | null;
  downloaded_at: number | null;
  created_at: number;
  updated_at: number;
}

const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));
const exportFrom = (r: Record<string, unknown>): ExportRow => ({ ...(r as unknown as ExportRow), label: isLabel(r.label) ? r.label : 'restricted', decided_at: numOrNull(r.decided_at), objects: numOrNull(r.objects), downloaded_at: numOrNull(r.downloaded_at), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });

export class EvidenceService {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  registerJobs(): void {
    this.s().jobs.register(EVIDENCE_EXPORT_JOB, async (p) => this.exportJob(String(p.exportId ?? '')), { timeoutMs: 30 * 60_000 });
  }

  private get windowMs(): number {
    return this.s().cfg.MODERATION_EVIDENCE_DAYS * 86_400_000;
  }

  // ---------- what is kept ----------

  /** The applied actions of a tenant (on one type, when given) whose case is still open, by object id. */
  private async openCases(tenantId: string, type?: string): Promise<Map<string, Kept>> {
    const q = this.db('moderation_actions').where({ tenant_id: tenantId, state: 'applied', action: 'hide' });
    if (type) q.andWhere({ object_type: type });
    const actions = (await q.orderBy('created_at', 'desc').limit(MAX_KEPT).select('id', 'object_type', 'object_id', 'flag_id', 'created_at')) as { id: string; object_type: string; object_id: string; flag_id: string | null; created_at: unknown }[];
    const out = new Map<string, Kept>();
    if (!actions.length) return out;
    const flagIds = [...new Set(actions.map((a) => a.flag_id).filter((x): x is string => !!x))];
    const flags = new Map<string, { state: string; decided_at: unknown }>();
    for (let i = 0; i < flagIds.length; i += 500) for (const f of (await this.db('guard_flags').whereIn('id', flagIds.slice(i, i + 500)).select('id', 'state', 'decided_at')) as { id: string; state: string; decided_at: unknown }[]) flags.set(f.id, f);
    const appeals = new Map<string, { open: boolean; last: number }>();
    const ids = actions.map((a) => a.id);
    for (let i = 0; i < ids.length; i += 500) {
      for (const a of (await this.db('moderation_appeals').whereIn('action_id', ids.slice(i, i + 500)).select('action_id', 'state', 'decided_at', 'created_at')) as { action_id: string; state: string; decided_at: unknown; created_at: unknown }[]) {
        const cur = appeals.get(a.action_id) ?? { open: false, last: 0 };
        if (a.state === 'pending' || a.state === 'reviewing') cur.open = true;
        cur.last = Math.max(cur.last, Number(a.decided_at ?? a.created_at ?? 0));
        appeals.set(a.action_id, cur);
      }
    }
    const now = Date.now();
    for (const a of actions) {
      const f = a.flag_id ? flags.get(a.flag_id) : undefined;
      const ap = appeals.get(a.id);
      const last = Math.max(Number(a.created_at), Number(f?.decided_at ?? 0), ap?.last ?? 0);
      const open = f?.state === 'open' || !!ap?.open || now < last + this.windowMs;
      const key = type ? a.object_id : `${a.object_type}\n${a.object_id}`;
      if (open && !out.has(key)) out.set(key, { reason: 'evidence', ref: a.id });
    }
    return out;
  }

  /** The objects of one type under an active legal hold of scope `object` or `case`, by object id. */
  private async heldObjects(tenantId: string, type: string): Promise<Map<string, Kept>> {
    const out = new Map<string, Kept>();
    const holds = (await this.db('legal_holds').where({ tenant_id: tenantId, state: 'active' }).whereIn('scope', ['case', 'object']).select('id', 'scope', 'scope_id', 'object_type', 'object_id')) as { id: string; scope: string; scope_id: string; object_type: string | null; object_id: string | null }[];
    if (!holds.length) return out;
    for (const h of holds) if (h.scope === 'object' && h.object_type === type && h.object_id) out.set(h.object_id, { reason: 'legal-hold', ref: h.id });
    const cases = new Map(holds.filter((h) => h.scope === 'case').map((h) => [h.scope_id, h.id]));
    if (!cases.size) return out;
    const flagIds = [...cases.keys()];
    // A held case keeps the object its flag points at, and the object of every action taken from it.
    for (const f of (await this.db('guard_flags').where({ tenant_id: tenantId, source_kind: type }).whereIn('id', flagIds).select('id', 'source_id')) as { id: string; source_id: string | null }[]) {
      if (!f.source_id) continue;
      let id = f.source_id;
      if (id.startsWith('h:')) {
        const o = (await this.db('moderation_objects').where({ tenant_id: tenantId, object_hash: id.slice(2) }).first('object_id')) as { object_id: string } | undefined;
        if (!o) continue;
        id = o.object_id;
      }
      if (!out.has(id)) out.set(id, { reason: 'legal-hold', ref: cases.get(f.id)! });
    }
    for (const a of (await this.db('moderation_actions').where({ tenant_id: tenantId, object_type: type }).whereIn('flag_id', flagIds).select('object_id', 'flag_id')) as { object_id: string; flag_id: string }[]) {
      if (!out.has(a.object_id)) out.set(a.object_id, { reason: 'legal-hold', ref: cases.get(a.flag_id)! });
    }
    return out;
  }

  /** The ids of the objects of a type that no purge may delete now, with the reason. A legal hold comes first. */
  async keptOf(tenantId: string, type: string): Promise<Map<string, Kept>> {
    const out = await this.openCases(tenantId, type);
    for (const [id, k] of await this.heldObjects(tenantId, type)) out.set(id, k);
    return out;
  }

  async kept(tenantId: string, type: string, id: string): Promise<Kept | null> {
    return (await this.keptOf(tenantId, type)).get(id) ?? null;
  }

  /** The flags under an active legal hold of scope `case` (their content waits with them). */
  async heldFlags(tenantId: string): Promise<Map<string, string>> {
    const rows = (await this.db('legal_holds').where({ tenant_id: tenantId, state: 'active', scope: 'case' }).select('id', 'scope_id')) as { id: string; scope_id: string }[];
    return new Map(rows.map((r) => [r.scope_id, r.id]));
  }

  /** Whether the tenant has any active legal hold, of any scope (offboarding asks). */
  async anyHold(tenantId: string): Promise<number> {
    const r = ((await this.db('legal_holds').where({ tenant_id: tenantId, state: 'active' }).count({ n: '*' })) as Record<string, unknown>[])[0];
    return Number(r?.n ?? 0);
  }

  /**
   * Records that a purge path left an object alone. One row, and one audit entry, per object, path and case or hold:
   * the sweep that comes back every hour adds nothing. Returns whether this was the first time.
   */
  async recordSkip(tenantId: string, type: string, id: string, path: string, k: Kept): Promise<boolean> {
    const hash = objectHash(type, id);
    if (await this.db('retention_skips').where({ tenant_id: tenantId, object_hash: hash, path, ref: k.ref }).first('id')) return false;
    try {
      await this.db('retention_skips').insert({ id: ulid(), tenant_id: tenantId, object_hash: hash, object_type: type, object_id: id, path, reason: k.reason, ref: k.ref, created_at: Date.now() });
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
    await this.s().audit.append({ tenantId, action: 'retention.skipped', kind: 'system', actor: { service: path }, target: { object: type, id: id.slice(0, 200) }, detail: { path, reason: k.reason, [k.reason === 'evidence' ? 'action' : 'hold']: k.ref, why: k.reason === 'evidence' ? 'Kept as evidence until its moderation case and any appeal close.' : 'Kept under a legal hold.' } });
    return true;
  }

  /**
   * A user-facing hard delete of a kept object is refused and audited. The message does not say which of the two
   * reasons applies: the people concerned by a legal hold are not told of it.
   */
  async assertDeletable(p: Principal, type: string, ids: string[], ip: string | null = null, what = 'This'): Promise<void> {
    if (!ids.length) return;
    const kept = await this.keptOf(p.tenantId, type);
    const hit = ids.find((id) => kept.has(id));
    if (!hit) return;
    const k = kept.get(hit)!;
    await this.s().audit.append({ tenantId: p.tenantId, action: 'retention.delete.refused', kind: 'admin', actor: actorFrom(p, ip), target: { object: type, id: hit.slice(0, 200) }, detail: { reason: k.reason, [k.reason === 'evidence' ? 'action' : 'hold']: k.ref } });
    throw new HttpProblem(409, 'Conflict', `${what} is kept by a moderation or compliance decision and cannot be deleted now.`, { extensions: { step: 'retention' } });
  }

  // ---------- the export of a held case or object (B-9504, on B-4206's dual control) ----------

  private audit(ctx: HoldCtx, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>, label?: Label) {
    return this.s().audit.append({ tenantId: ctx.p.tenantId, action, kind: 'admin', actor: actorFrom(ctx.p, ctx.ip), target, ...(detail ? { detail } : {}), ...(label ? { label } : {}), traceId: ctx.traceId ?? null });
  }

  private async hold(tenantId: string, id: string): Promise<HoldRow & { object_type: string | null; object_id: string | null }> {
    const h = await this.db('legal_holds').where({ tenant_id: tenantId, id }).first();
    if (!h) throw notFound('Legal hold');
    return h as HoldRow & { object_type: string | null; object_id: string | null };
  }

  /** The objects a hold of scope `case` or `object` covers: type and id. */
  private async objectsOf(h: HoldRow & { object_type: string | null; object_id: string | null }): Promise<{ type: string; id: string }[]> {
    if (h.scope === 'object') return h.object_type && h.object_id ? [{ type: h.object_type, id: h.object_id }] : [];
    const out = new Map<string, { type: string; id: string }>();
    const f = (await this.db('guard_flags').where({ tenant_id: h.tenant_id, id: h.scope_id }).first('source_kind', 'source_id')) as { source_kind: string | null; source_id: string | null } | undefined;
    if (f?.source_kind && f.source_id) {
      let id: string | null = f.source_id;
      if (id.startsWith('h:')) id = ((await this.db('moderation_objects').where({ tenant_id: h.tenant_id, object_hash: id.slice(2) }).first('object_id')) as { object_id: string } | undefined)?.object_id ?? null;
      if (id) out.set(`${f.source_kind}\n${id}`, { type: f.source_kind, id });
    }
    for (const a of (await this.db('moderation_actions').where({ tenant_id: h.tenant_id, flag_id: h.scope_id }).select('object_type', 'object_id')) as { object_type: string; object_id: string }[]) out.set(`${a.object_type}\n${a.object_id}`, { type: a.object_type, id: a.object_id });
    return [...out.values()];
  }

  private async exportRow(tenantId: string, id: string): Promise<ExportRow> {
    const r = await this.db('evidence_exports').where({ tenant_id: tenantId, id }).first();
    if (!r) throw notFound('Export');
    return exportFrom(r);
  }

  private async exportView(x: ExportRow, p: Principal) {
    const mine = x.requested_by === p.userId;
    return { id: x.id, holdId: x.hold_id, label: x.label, reason: await this.s().keys.open(x.tenant_id, x.reason, `evidence-export:${x.id}`), requestedBy: x.requested_by, approverId: x.approver_id, decidedBy: x.decided_by, decidedAt: x.decided_at, note: x.note, state: x.state, jobId: x.job_id, file: x.state === 'ready' ? x.file : null, objects: x.objects, error: x.error, downloadedAt: x.downloaded_at, createdAt: x.created_at, mine, canDecide: x.state === 'pending' && !mine };
  }

  async exports(p: Principal) {
    const rows = ((await this.db('evidence_exports').where({ tenant_id: p.tenantId }).whereIn('label', LABELS.filter((l) => clears(p.clearance, l))).orderBy('created_at', 'desc').limit(100)) as Record<string, unknown>[]).map(exportFrom);
    return Promise.all(rows.map((x) => this.exportView(x, p)));
  }

  /** Asks to export what an active hold on a case or an object keeps. Nothing is read until another holder approves. */
  async requestExport(ctx: HoldCtx, input: { holdId: string; reason: string; approverId: string }) {
    const s = this.s();
    const p = ctx.p;
    const h = await this.hold(p.tenantId, input.holdId);
    if (h.scope !== 'case' && h.scope !== 'object') throw new HttpProblem(422, 'Not a case or object hold', 'This export is for a hold on a moderation case or a single object. Use a compliance export for a user or a workspace.', { extensions: { field: 'holdId' } });
    if (h.state !== 'active') throw conflict(`The hold is ${h.state}, not active.`);
    if (input.approverId === p.userId) throw forbidden('Dual control: you cannot approve your own request. Name another compliance manager.', { step: 'dual-control' });
    if (!(await s.legalHolds.approvers(p)).some((a) => a.userId === input.approverId)) throw new HttpProblem(422, 'Not an approver', 'The approver must be another holder of compliance:manage in this tenant.', { extensions: { field: 'approverId' } });
    if (await this.db('evidence_exports').where({ tenant_id: p.tenantId, hold_id: h.id, state: 'pending' }).first('id')) throw conflict('An export of this hold already waits for approval.');
    // The export is as sensitive as the most sensitive thing in it.
    let label: Label = 'internal';
    for (const o of await this.objectsOf(h)) {
      const got = await s.moderation.registry.get(o.type)?.resolve(p.tenantId, o.id).catch(() => null);
      if (got && LABELS.indexOf(got.label) > LABELS.indexOf(label)) label = got.label;
    }
    if (!clears(p.clearance, label)) throw forbidden(`What the hold keeps is labelled ${label}, above your clearance of ${p.clearance}.`, { step: 'clearance' });
    const id = ulid();
    const t = Date.now();
    await this.db('evidence_exports').insert({ id, tenant_id: p.tenantId, hold_id: h.id, label, reason: await s.keys.seal(p.tenantId, input.reason, `evidence-export:${id}`), requested_by: p.userId, approver_id: input.approverId, state: 'pending', decided_by: null, decided_at: null, note: null, job_id: null, file: null, blob_key: null, objects: null, error: null, downloaded_at: null, created_at: t, updated_at: t });
    await this.audit(ctx, 'evidence.export.requested', { export: id, hold: h.id, approver: input.approverId }, { reason: input.reason.slice(0, 500) }, label);
    await s.notifications.notify({ tenantId: p.tenantId, userIds: [input.approverId], kind: 'compliance', title: `${p.displayName} asks you to approve an export of held evidence`, body: input.reason.slice(0, 300), route: 'settings', label });
    return this.exportView(await this.exportRow(p.tenantId, id), p);
  }

  async decideExport(ctx: HoldCtx, id: string, decision: 'approved' | 'rejected', note: string | null) {
    const s = this.s();
    const p = ctx.p;
    const x = await this.exportRow(p.tenantId, id);
    if (!clears(p.clearance, x.label)) throw notFound('Export');
    if (x.requested_by === p.userId) throw forbidden('Dual control: you cannot approve your own request. Another compliance manager must decide it.', { step: 'dual-control' });
    if (x.state !== 'pending') throw conflict(`The request was already ${x.state}.`);
    const t = Date.now();
    const n = await this.db('evidence_exports').where({ id: x.id, state: 'pending' }).update({ state: decision, decided_by: p.userId, decided_at: t, note: note?.slice(0, 500) ?? null, updated_at: t });
    if (!n) throw conflict('The request was decided by someone else.');
    let jobId: string | null = null;
    if (decision === 'approved') {
      jobId = (await s.jobs.enqueue({ tenantId: p.tenantId, type: EVIDENCE_EXPORT_JOB, payload: { exportId: x.id }, createdBy: x.requested_by, dedupeKey: `${EVIDENCE_EXPORT_JOB}:${x.id}`, maxAttempts: 2 })).id;
      await this.db('evidence_exports').where({ id: x.id }).update({ job_id: jobId });
    }
    await this.audit(ctx, `evidence.export.${decision}`, { export: x.id, hold: x.hold_id, requestedBy: x.requested_by }, { note, ...(jobId ? { job: jobId } : {}) }, x.label);
    await s.notifications.notify({ tenantId: p.tenantId, userIds: [x.requested_by], kind: 'compliance', title: decision === 'approved' ? 'Your evidence export was approved; it is being written' : 'Your evidence export was rejected', body: note ?? '', route: 'settings', label: x.label });
    return this.exportView(await this.exportRow(p.tenantId, x.id), p);
  }

  async withdrawExport(ctx: HoldCtx, id: string) {
    const x = await this.exportRow(ctx.p.tenantId, id);
    if (x.requested_by !== ctx.p.userId) throw forbidden('Only the person who asked for an export can withdraw it.', { step: 'owner' });
    if (x.state !== 'pending') throw conflict(`The request was already ${x.state}.`);
    await this.db('evidence_exports').where({ id: x.id, state: 'pending' }).update({ state: 'withdrawn', updated_at: Date.now() });
    await this.audit(ctx, 'evidence.export.withdrawn', { export: x.id, hold: x.hold_id }, undefined, x.label);
    return this.exportView(await this.exportRow(ctx.p.tenantId, x.id), ctx.p);
  }

  /**
   * The approved export as a job: JSON Lines, sealed with the tenant key. One line for the hold, one per flag, action
   * and appeal of the case, and one per object with its state and the text its domain gives a check (a file's line
   * lists its versions with their hashes; the bytes stay in the store, kept by the hold).
   */
  async exportJob(id: string) {
    const s = this.s();
    const r = await this.db('evidence_exports').where({ id }).first();
    if (!r) return { skipped: 'gone' };
    const x = exportFrom(r);
    if (x.state === 'ready') return { objects: x.objects };
    if (x.state !== 'approved') return { skipped: x.state };
    try {
      const h = await this.hold(x.tenant_id, x.hold_id);
      const lines: Record<string, unknown>[] = [{ kind: 'hold', id: h.id, scope: h.scope, state: h.state, requestedBy: h.requested_by, decidedBy: h.decided_by, decidedAt: numOrNull(h.decided_at), exportedAt: Date.now() }];
      if (h.scope === 'case') {
        const f = await s.guard.flags.get(x.tenant_id, h.scope_id).catch(() => null);
        if (f) lines.push({ kind: 'flag', id: f.id, number: f.number, state: f.state, checkpoint: f.checkpoint, rule: f.rule_name, action: f.action, severity: f.severity, label: f.label, note: f.note, reason: f.reason, source: { kind: f.source_kind, id: f.source_id }, text: f.excerpt ? await s.keys.open(x.tenant_id, f.excerpt, `flag:${f.id}`).catch(() => null) : null, decidedBy: f.decided_by, decidedAt: f.decided_at, createdAt: f.created_at });
        const actions = (await this.db('moderation_actions').where({ tenant_id: x.tenant_id, flag_id: h.scope_id }).orderBy('created_at')) as Record<string, unknown>[];
        for (const a of actions) lines.push({ kind: 'action', id: a.id, object: { type: a.object_type, id: a.object_id }, action: a.action, state: a.state, source: a.source, prevState: a.prev_state, reason: a.reason, owner: a.owner_id, createdBy: a.created_by, createdAt: numOrNull(a.created_at), reversedBy: a.reversed_by, reversedAt: numOrNull(a.reversed_at) });
        const aids = actions.map((a) => String(a.id));
        if (aids.length) {
          for (const ap of (await this.db('moderation_appeals').where({ tenant_id: x.tenant_id }).whereIn('action_id', aids).orderBy('created_at')) as Record<string, unknown>[]) lines.push({ kind: 'appeal', id: ap.id, number: numOrNull(ap.number), action: ap.action_id, state: ap.state, user: ap.user_id, statement: await s.keys.open(x.tenant_id, String(ap.statement), `appeal:${String(ap.id)}`).catch(() => null), reviewer: ap.reviewer_id, decisionNote: ap.decision_note, createdAt: numOrNull(ap.created_at), decidedAt: numOrNull(ap.decided_at) });
        }
      }
      let objects = 0;
      for (const o of await this.objectsOf(h)) {
        const handler = s.moderation.registry.get(o.type);
        const got = handler ? await handler.resolve(x.tenant_id, o.id).catch(() => null) : null;
        const line: Record<string, unknown> = { kind: 'object', type: o.type, id: o.id, found: !!got, state: got?.state ?? null, label: got?.label ?? null, owner: got?.ownerId ?? null, workspace: got?.workspaceId ?? null };
        if (got && handler?.text) line.text = (await handler.text(got).catch(() => '')).slice(0, EXPORT_MAX_TEXT);
        if (o.type === 'file') line.versions = ((await this.db('file_versions').where({ tenant_id: x.tenant_id, file_id: o.id }).orderBy('number')) as Record<string, unknown>[]).map((v) => ({ number: Number(v.number), state: v.state, size: Number(v.size), sha256: v.sha256, type: v.type, label: v.label, createdBy: v.created_by, createdAt: numOrNull(v.created_at) }));
        lines.push(line);
        objects++;
      }
      const body = Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
      const key = `exports/${x.tenant_id}/evidence/${x.id}.sealed`;
      await s.blobs.put(key, Buffer.from(await s.keys.sealBytes(x.tenant_id, body, `evidence-export-file:${x.id}`), 'utf8'), 'application/octet-stream');
      const file = `evidence-${h.scope}-${h.id.slice(-8).toLowerCase()}-${new Date().toISOString().slice(0, 10)}.jsonl`;
      await this.db('evidence_exports').where({ id: x.id }).update({ state: 'ready', blob_key: key, file, objects, updated_at: Date.now() });
      await s.audit.append({ tenantId: x.tenant_id, action: 'evidence.exported', kind: 'admin', actor: { service: 'compliance' }, target: { export: x.id, hold: h.id }, label: x.label, detail: { requestedBy: x.requested_by, approvedBy: x.decided_by, objects, lines: lines.length } });
      await s.notifications.notify({ tenantId: x.tenant_id, userIds: [x.requested_by], kind: 'compliance', title: 'Your evidence export is ready', body: `${objects} object(s)`, route: 'settings', label: x.label });
      return { objects, lines: lines.length };
    } catch (err) {
      await this.db('evidence_exports').where({ id: x.id }).update({ state: 'failed', error: (err as Error).message.slice(0, 500), updated_at: Date.now() });
      throw err;
    }
  }

  /** The ready export, for the requester only. Audited. */
  async download(ctx: HoldCtx, id: string): Promise<{ file: string; data: Buffer }> {
    const s = this.s();
    const x = await this.exportRow(ctx.p.tenantId, id);
    if (x.requested_by !== ctx.p.userId || !clears(ctx.p.clearance, x.label)) throw notFound('Export');
    if (x.state !== 'ready' || !x.blob_key) throw conflict(`The export is ${x.state}.`);
    const sealed = await s.blobs.get(x.blob_key);
    if (!sealed) throw notFound('Export file');
    const data = await s.keys.openBytes(x.tenant_id, sealed.toString('utf8'), `evidence-export-file:${x.id}`);
    await this.db('evidence_exports').where({ id: x.id }).update({ downloaded_at: Date.now() });
    await this.audit(ctx, 'evidence.export.downloaded', { export: x.id, hold: x.hold_id }, { bytes: data.length }, x.label);
    return { file: x.file ?? `evidence-${x.id}.jsonl`, data };
  }
}
