import { createHash, createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ulid } from 'ulid';
import { z } from 'zod';
import { fetch as undiciFetch } from 'undici';
import { json } from '../db/knex.js';
import { isUniqueViolation } from '../audit/chain.js';
import { badRequest, conflict, HttpProblem, notFound } from '../http/problem.js';
import { checkUrl, guardedAgent, parseAllowList } from '../mcp/hosts.js';
import type { Services } from '../services.js';
import { audit, notifyAdmins, shortFingerprint, type OpsActor } from './common.js';
import { KIND_NOUN, MIRROR_KINDS, type MirrorKind } from './mirrors.js';
import { tarStream, TarError, type StreamEntry } from './tar.js';
import type { ByteSource } from '../platform/blob.js';

const run = promisify(execFile);

export const STEP_TITLES = [
  'Transfer received',
  'Signature verified against the offline key',
  'Digest matched the manifest',
  'SBOM and vulnerability scan',
  'Licence check',
  'Staging deploy',
  'Promoted to internal mirrors'
] as const;

export type StepState = 'waiting' | 'running' | 'passed' | 'failed' | 'skipped';
export interface Step {
  state: StepState;
  detail: string | null;
  at: number | null;
}

export type BundleState = 'awaiting transfer' | 'verifying' | 'ready to promote' | 'promoting' | 'in production' | 'rejected';

export interface BundleRow {
  id: string;
  name: string;
  state: BundleState;
  expedited: boolean;
  ticket: string | null;
  transfer: string;
  contents: string | null;
  size: number | null;
  digest: string | null;
  blob_key: string | null;
  manifest_id: string | null;
  signer_fingerprint: string | null;
  signer_key_id: string | null;
  steps: Step[];
  report: BundleReport | null;
  error: string | null;
  job_id: string | null;
  created_by: string | null;
  created_at: number;
  received_at: number | null;
  verified_at: number | null;
  promoted_by: string | null;
  promoted_at: number | null;
  updated_at: number;
}

export interface Finding {
  id: string;
  severity: string;
  package: string;
  version: string | null;
}

export interface BundleReport {
  files?: number;
  byMirror?: Partial<Record<MirrorKind, number>>;
  components?: number;
  scanner?: string | null;
  findings?: Finding[];
  blocking?: number;
  licences?: Record<string, number>;
  licenceProblems?: { component: string; licence: string | null }[];
  staging?: string | null;
  promotedTo?: string[];
  kindsWithoutMirror?: MirrorKind[];
}

export interface SignerKeyRow {
  id: string;
  name: string;
  algorithm: 'ed25519' | 'ecdsa-p256-sha256';
  fingerprint: string;
  public_key_pem: string;
  state: 'active' | 'revoked';
  created_by: string | null;
  created_at: number;
  revoked_by: string | null;
  revoked_at: number | null;
  revoke_reason: string | null;
}

/** A CycloneDX SBOM as carried in the manifest; only the fields the checks use are typed. */
const component = z.looseObject({
  name: z.string().max(400),
  version: z.string().max(200).optional(),
  purl: z.string().max(1000).optional(),
  licenses: z.array(z.looseObject({ license: z.looseObject({ id: z.string().max(200).optional(), name: z.string().max(400).optional() }).optional(), expression: z.string().max(1000).optional() })).optional()
});
export type SbomComponent = z.infer<typeof component>;

export const manifestSchema = z.object({
  format: z.literal('exprsn-bundle/1'),
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/),
  created: z.string().max(40).optional(),
  contents: z.string().max(500).optional(),
  files: z.array(z.object({ path: z.string().min(1).max(400), sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().min(0), mirror: z.enum(MIRROR_KINDS) }).strict()).max(200_000),
  sbom: z.looseObject({ bomFormat: z.literal('CycloneDX'), specVersion: z.string().max(10), components: z.array(component).max(200_000).default([]) })
});
export type BundleManifest = z.infer<typeof manifestSchema>;

const signatureSchema = z.object({ algorithm: z.enum(['ed25519', 'ecdsa-p256-sha256']), key: z.string().regex(/^[a-f0-9]{64}$/), signature: z.string().max(400) });

/** The SBOM and vulnerability scan. Trivy when PLATFORM_TRIVY_BIN is set; tests plug in a fake. */
export interface BundleScanner {
  readonly name: string;
  scan(sbom: BundleManifest['sbom'], signal: AbortSignal): Promise<{ findings: Finding[] }>;
}

/** The staging deploy (Compose and Helm on kind, or whatever the site runs). */
export interface StagingHook {
  readonly name: string;
  deploy(input: { bundle: string; digest: string; contents: string; files: { path: string; sha256: string; mirror: string }[] }, signal: AbortSignal): Promise<{ ok: boolean; detail: string }>;
}

export class TrivyScanner implements BundleScanner {
  readonly name = 'trivy';
  constructor(
    private readonly bin: string,
    private readonly cacheDir?: string
  ) {}

  async scan(sbom: BundleManifest['sbom'], signal: AbortSignal): Promise<{ findings: Finding[] }> {
    const dir = await mkdtemp(path.join(tmpdir(), 'exprsn-sbom-'));
    try {
      const file = path.join(dir, 'sbom.cdx.json');
      await writeFile(file, JSON.stringify(sbom), { mode: 0o600 });
      const args = ['sbom', '--format', 'json', '--quiet', '--offline-scan', '--skip-db-update', ...(this.cacheDir ? ['--cache-dir', this.cacheDir] : []), file];
      const { stdout } = await run(this.bin, args, { signal, maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60_000 });
      const out = JSON.parse(stdout) as { Results?: { Vulnerabilities?: { VulnerabilityID: string; PkgName: string; InstalledVersion?: string; Severity: string }[] }[] };
      return { findings: (out.Results ?? []).flatMap((r) => (r.Vulnerabilities ?? []).map((v) => ({ id: v.VulnerabilityID, severity: v.Severity.toUpperCase(), package: v.PkgName, version: v.InstalledVersion ?? null }))) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/** POSTs the bundle's manifest to an internal staging service and expects `{ ok, detail }` back. */
export class HttpStaging implements StagingHook {
  readonly name: string;
  constructor(
    private readonly url: string,
    private readonly allowedHosts: string,
    private readonly timeoutMs: number
  ) {
    this.name = `staging at ${new URL(url).host}`;
  }

  async deploy(input: Parameters<StagingHook['deploy']>[0], signal: AbortSignal): Promise<{ ok: boolean; detail: string }> {
    const allow = parseAllowList(this.allowedHosts);
    await checkUrl(this.url, allow);
    const agent = guardedAgent(allow, this.timeoutMs);
    try {
      const res = await undiciFetch(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), dispatcher: agent, signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) });
      const text = await res.text();
      let body: { ok?: boolean; detail?: string } = {};
      try {
        body = JSON.parse(text) as typeof body;
      } catch {
        body = {};
      }
      if (!res.ok) return { ok: false, detail: `The staging service answered ${res.status}${body.detail ? `: ${body.detail}` : ''}` };
      return { ok: body.ok === true, detail: String(body.detail ?? (body.ok ? 'Staging deploy passed' : 'Staging deploy failed')).slice(0, 500) };
    } finally {
      await agent.close().catch(() => undefined);
    }
  }
}

const SEVERITY_RANK: Record<string, number> = { UNKNOWN: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

/** Evaluates an SPDX licence expression (AND, OR, WITH, parentheses) against an allow-list of ids. */
export function licenceAllowed(expr: string, allow: Set<string>): boolean {
  const tokens = expr.replace(/\(/g, ' ( ').replace(/\)/g, ' ) ').split(/\s+/).filter(Boolean);
  let i = 0;
  const atom = (): boolean => {
    const t = tokens[i++];
    if (t === undefined) throw new Error('unexpected end');
    if (t === '(') {
      const v = or();
      if (tokens[i++] !== ')') throw new Error('missing )');
      return v;
    }
    if (tokens[i]?.toUpperCase() === 'WITH') i += 2; // exceptions only widen what a licence allows
    return allow.has(t.replace(/\+$/, '').toLowerCase());
  };
  const and = (): boolean => {
    let v = atom();
    while (tokens[i]?.toUpperCase() === 'AND') {
      i++;
      v = atom() && v;
    }
    return v;
  };
  const or = (): boolean => {
    let v = and();
    while (tokens[i]?.toUpperCase() === 'OR') {
      i++;
      v = and() || v;
    }
    return v;
  };
  try {
    const v = or();
    return i === tokens.length && v;
  } catch {
    return false;
  }
}

/** Every licence a component declares (CycloneDX `licenses`: ids, names or expressions). */
export const componentLicences = (c: SbomComponent): string[] => (c.licenses ?? []).map((l) => l.expression ?? l.license?.id ?? l.license?.name ?? '').filter(Boolean);

export function summarizeContents(files: BundleManifest['files']): string {
  const counts = new Map<MirrorKind, number>();
  for (const f of files) counts.set(f.mirror, (counts.get(f.mirror) ?? 0) + 1);
  return MIRROR_KINDS.filter((k) => counts.has(k)).map((k) => {
    const n = counts.get(k)!;
    return k === 'trivy' ? 'Trivy DB' : `${n} ${KIND_NOUN[k][n === 1 ? 0 : 1]}`;
  }).join(', ') || 'empty';
}

const freshSteps = (): Step[] => STEP_TITLES.map(() => ({ state: 'waiting', detail: null, at: null }));

const fromRow = (r: Record<string, unknown>): BundleRow => ({
  ...(r as unknown as BundleRow),
  expedited: Boolean(r.expedited),
  size: r.size == null ? null : Number(r.size),
  steps: json<Step[]>(r.steps, freshSteps()),
  report: json<BundleReport | null>(r.report, null),
  created_at: Number(r.created_at),
  received_at: r.received_at == null ? null : Number(r.received_at),
  verified_at: r.verified_at == null ? null : Number(r.verified_at),
  promoted_at: r.promoted_at == null ? null : Number(r.promoted_at),
  updated_at: Number(r.updated_at)
});

const keyFromRow = (r: Record<string, unknown>): SignerKeyRow => ({ ...(r as unknown as SignerKeyRow), created_at: Number(r.created_at), revoked_at: r.revoked_at == null ? null : Number(r.revoked_at) });

/** sha256 of the SPKI DER, hex. */
export const keyFingerprint = (k: KeyObject): string => createHash('sha256').update((k.type === 'public' ? k : createPublicKey(k)).export({ type: 'spki', format: 'der' })).digest('hex');

class StepFailure extends Error {}

/**
 * Signed import bundles. A bundle is a tar whose first two entries are `manifest.json` and `manifest.sig` (a
 * detached Ed25519 or ECDSA P-256 signature over the manifest bytes, naming the signer's key fingerprint), followed
 * by `files/<path>` entries listed in the manifest with their sha256. Verification runs as a job, one step at a
 * time; a bundle whose signature fails is rejected before anything past the first two entries is read, and nothing
 * is written anywhere until an admin promotes a verified bundle.
 */
export class BundleService {
  private scannerOverride: BundleScanner | null | undefined;
  private stagingOverride: StagingHook | null | undefined;

  constructor(private readonly s: () => Services) {}

  /** The scanner: Trivy when PLATFORM_TRIVY_BIN is set. Replaceable (tests). */
  get scanner(): BundleScanner | null {
    if (this.scannerOverride !== undefined) return this.scannerOverride;
    const cfg = this.s().cfg;
    return (this.scannerOverride = cfg.PLATFORM_TRIVY_BIN ? new TrivyScanner(cfg.PLATFORM_TRIVY_BIN, cfg.PLATFORM_TRIVY_CACHE_DIR) : null);
  }

  set scanner(v: BundleScanner | null) {
    this.scannerOverride = v;
  }

  /** The staging hook: PLATFORM_STAGING_URL when set. Replaceable (tests). */
  get staging(): StagingHook | null {
    if (this.stagingOverride !== undefined) return this.stagingOverride;
    const cfg = this.s().cfg;
    return (this.stagingOverride = cfg.PLATFORM_STAGING_URL ? new HttpStaging(cfg.PLATFORM_STAGING_URL, cfg.PLATFORM_ALLOWED_HOSTS, cfg.PLATFORM_STAGING_TIMEOUT_MS) : null);
  }

  set staging(v: StagingHook | null) {
    this.stagingOverride = v;
  }

  // ---------- signer keys ----------

  async keys(): Promise<SignerKeyRow[]> {
    return (await this.s().db('platform_signer_keys').orderBy('created_at', 'desc')).map(keyFromRow);
  }

  async addKey(by: OpsActor, input: { name: string; publicKeyPem: string }): Promise<SignerKeyRow> {
    let key: KeyObject;
    try {
      key = createPublicKey(input.publicKeyPem);
    } catch {
      throw badRequest('The public key is not a PEM public key.', { field: 'publicKeyPem' });
    }
    let algorithm: SignerKeyRow['algorithm'];
    if (key.asymmetricKeyType === 'ed25519') algorithm = 'ed25519';
    else if (key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1') algorithm = 'ecdsa-p256-sha256';
    else throw badRequest('Signer keys must be Ed25519 or ECDSA P-256.', { field: 'publicKeyPem' });
    const row = { id: ulid(), name: input.name, algorithm, fingerprint: keyFingerprint(key), public_key_pem: key.export({ type: 'spki', format: 'pem' }).toString(), state: 'active', created_by: by.userId, created_at: Date.now() };
    try {
      await this.s().db('platform_signer_keys').insert(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('That key is already registered.');
      throw err;
    }
    await audit(this.s(), by, 'platform.signer.added', { key: row.id, name: row.name }, { algorithm, fingerprint: row.fingerprint }, 'admin');
    return keyFromRow(row);
  }

  async revokeKey(by: OpsActor, id: string, reason: string): Promise<SignerKeyRow> {
    const k = (await this.s().db('platform_signer_keys').where({ id }).first()) as Record<string, unknown> | undefined;
    if (!k) throw notFound('Signer key');
    if (k.state === 'revoked') throw conflict('The key is already revoked.');
    await this.s().db('platform_signer_keys').where({ id }).update({ state: 'revoked', revoked_by: by.userId, revoked_at: Date.now(), revoke_reason: reason });
    await audit(this.s(), by, 'platform.signer.revoked', { key: id, name: String(k.name) }, { fingerprint: k.fingerprint, reason }, 'admin');
    return keyFromRow((await this.s().db('platform_signer_keys').where({ id }).first()) as Record<string, unknown>);
  }

  // ---------- bundles ----------

  async list(): Promise<BundleRow[]> {
    return (await this.s().db('platform_bundles').orderBy('created_at', 'desc').limit(500)).map(fromRow);
  }

  async get(id: string): Promise<BundleRow> {
    const r = await this.s().db('platform_bundles').where({ id }).first();
    if (!r) throw notFound('Bundle');
    return fromRow(r);
  }

  private async patch(id: string, u: Record<string, unknown>): Promise<void> {
    const out: Record<string, unknown> = { ...u, updated_at: Date.now() };
    if (out.steps) out.steps = JSON.stringify(out.steps);
    if (out.report) out.report = JSON.stringify(out.report);
    await this.s().db('platform_bundles').where({ id }).update(out);
  }

  /** Opens an import (the expedited path starts here) and waits for its transfer. */
  async create(by: OpsActor, input: { name: string; transfer: string; contents?: string | null; expedited: boolean; ticket?: string | null }): Promise<BundleRow> {
    const t = Date.now();
    const row = { id: ulid(), name: input.name, state: 'awaiting transfer', expedited: input.expedited, ticket: input.ticket ?? null, transfer: input.transfer, contents: input.contents || null, steps: JSON.stringify(freshSteps()), created_by: by.userId, created_at: t, updated_at: t };
    try {
      await this.s().db('platform_bundles').insert(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`A bundle named ${input.name} exists.`);
      throw err;
    }
    await audit(this.s(), by, input.expedited ? 'platform.bundle.expedited' : 'platform.bundle.opened', { bundle: row.id, name: row.name }, { transfer: row.transfer, ticket: row.ticket, contents: row.contents }, 'admin');
    return this.get(row.id);
  }

  /**
   * Stores the transferred file for a bundle and queues its verification. The transfer is streamed into the blob
   * store (never held in memory), hashed on the way, and refused past `maxBytes`.
   */
  async receive(by: OpsActor, id: string, source: ByteSource | Buffer, maxBytes = this.s().cfg.PLATFORM_BUNDLE_MAX_BYTES): Promise<BundleRow> {
    const b = await this.get(id);
    if (b.state !== 'awaiting transfer' && b.state !== 'rejected') throw conflict(`The bundle is ${b.state}; a transfer is only accepted while it is awaiting one or after a rejection.`);
    const key = `platform/bundles/${b.id}/transfer.tar`;
    const hash = createHash('sha256');
    let size = 0;
    const tooBig = () => new HttpProblem(413, 'Payload too large', `The bundle is above the cap of ${(maxBytes / 1e6).toFixed(0)} MB (PLATFORM_BUNDLE_MAX_BYTES).`, { extensions: { cap: 'size', max: maxBytes } });
    const input: ByteSource = Buffer.isBuffer(source) ? (async function* () { yield source; })() : source;
    const hashed = async function* () {
      for await (const c of input) {
        size += c.length;
        if (size > maxBytes) throw tooBig();
        hash.update(c);
        yield c;
      }
    };
    await this.s().blobs.putStream(key, hashed(), 'application/x-tar');
    if (!size) {
      await this.s().blobs.delete(key);
      throw badRequest('The transfer is empty.');
    }
    const digest = 'sha256:' + hash.digest('hex');
    const steps = freshSteps();
    steps[0] = { state: 'passed', detail: `${size} bytes, ${digest.slice(0, 19)}…`, at: Date.now() };
    await this.patch(id, { blob_key: key, size, digest, received_at: Date.now(), state: 'verifying', steps, error: null, report: null, signer_fingerprint: null, signer_key_id: null, manifest_id: null });
    await audit(this.s(), by, 'platform.bundle.received', { bundle: id, name: b.name }, { size, digest, transfer: b.transfer }, 'admin');
    return this.verify(by, id, true);
  }

  /** The stored transfer as a stream, hashed as it is read: `digest()` is valid once the stream is consumed. */
  private async open(b: BundleRow): Promise<{ source: AsyncGenerator<Buffer>; digest: () => string; size: number }> {
    const got = b.blob_key ? await this.s().blobs.getStream(b.blob_key) : null;
    if (!got) throw new StepFailure('The transferred file is missing from the blob store.');
    const hash = createHash('sha256');
    const source = (async function* () {
      for await (const c of got.stream as AsyncIterable<Buffer>) {
        hash.update(c);
        yield c;
      }
    })();
    let d: string | null = null;
    return { source, size: got.size, digest: () => (d ??= 'sha256:' + hash.digest('hex')) };
  }

  /** Queues the verification pipeline. */
  async verify(by: OpsActor, id: string, justReceived = false): Promise<BundleRow> {
    const b = await this.get(id);
    if (!b.blob_key) throw conflict('The bundle has no transfer yet.');
    if (b.state === 'promoting' || b.state === 'in production') throw conflict(`The bundle is ${b.state}.`);
    if (b.state === 'verifying' && !justReceived && b.job_id) {
      const j = await this.s().jobs.get(by.tenantId, b.job_id);
      if (j && (j.state === 'queued' || j.state === 'running')) throw conflict('Verification is already running.');
    }
    const job = await this.s().jobs.enqueue({ tenantId: by.tenantId, type: 'ops.bundle.verify', payload: { bundleId: id }, createdBy: by.userId, maxAttempts: 1 });
    await this.patch(id, { state: 'verifying', job_id: job.id, ...(justReceived ? {} : { steps: freshSteps(), error: null }) });
    if (!justReceived) await audit(this.s(), by, 'platform.bundle.verify.requested', { bundle: id, name: b.name }, { job: job.id }, 'admin');
    return this.get(id);
  }

  /** The first two entries (manifest.json and manifest.sig), buffered; the rest of the archive is left in `rest`. */
  private async manifestParts(source: AsyncIterable<Buffer>): Promise<{ manifest: Buffer; sig: Buffer; rest: AsyncGenerator<StreamEntry> }> {
    const it = tarStream(source);
    let manifest: Buffer | null = null;
    let sig: Buffer | null = null;
    for (let i = 0; i < 2; i++) {
      const n = await it.next();
      if (n.done) break;
      if (n.value.path === 'manifest.json') manifest = await n.value.buffer(256 * 1024 * 1024);
      else if (n.value.path === 'manifest.sig') sig = await n.value.buffer(64 * 1024);
    }
    if (!manifest || !sig) throw new StepFailure('The bundle must start with manifest.json and manifest.sig.');
    return { manifest, sig, rest: it };
  }

  /** Step 2: the detached signature against the registered offline keys. */
  private async checkSignature(manifest: Buffer, sigBytes: Buffer): Promise<{ key: SignerKeyRow; detail: string; fingerprint: string }> {
    let sig: z.infer<typeof signatureSchema>;
    try {
      sig = signatureSchema.parse(JSON.parse(sigBytes.toString('utf8')));
    } catch {
      throw Object.assign(new StepFailure('manifest.sig is not a signature record ({ algorithm, key, signature }).'), { fingerprint: null });
    }
    const active = (await this.keys()).filter((k) => k.state === 'active');
    const expected = active.map((k) => k.name).join(', ') || 'no trusted keys are registered';
    const key = (await this.keys()).find((k) => k.fingerprint === sig.key);
    if (!key) throw Object.assign(new StepFailure(`Expected ${expected}. Got unknown key ${shortFingerprint(sig.key)}.`), { fingerprint: sig.key });
    if (key.state === 'revoked') throw Object.assign(new StepFailure(`Signed by ${key.name} (${shortFingerprint(sig.key)}), which was revoked${key.revoke_reason ? `: ${key.revoke_reason}` : ''}. Expected ${expected}.`), { fingerprint: sig.key });
    if (key.algorithm !== sig.algorithm) throw Object.assign(new StepFailure(`The signature claims ${sig.algorithm} but ${key.name} is an ${key.algorithm} key.`), { fingerprint: sig.key });
    const ok = verifySignature(key.algorithm === 'ed25519' ? null : 'sha256', manifest, createPublicKey(key.public_key_pem), Buffer.from(sig.signature, 'base64'));
    if (!ok) throw Object.assign(new StepFailure(`The signature does not verify against ${key.name} (${shortFingerprint(sig.key)}).`), { fingerprint: sig.key });
    return { key, fingerprint: sig.key, detail: `Signed by ${key.name} (${key.algorithm}, ${shortFingerprint(sig.key)})` };
  }

  /** The verification job: steps 1 to 6. Returns the final state. */
  async runVerify(bundleId: string, by: OpsActor, progress: (pct: number, msg: string) => Promise<void>, signal: AbortSignal): Promise<{ state: BundleState; failedAt?: number; reason?: string }> {
    const s = this.s();
    const b = await this.get(bundleId);
    const steps = b.steps.map((x, i) => (i === 0 && x.state === 'passed' ? x : { state: 'waiting' as StepState, detail: null, at: null }));
    const report: BundleReport = {};
    let current = 0;
    const save = (extra: Record<string, unknown> = {}) => this.patch(bundleId, { steps, report, ...extra });
    const begin = async (i: number) => {
      current = i;
      steps[i] = { state: 'running', detail: null, at: Date.now() };
      await save();
      await progress(Math.round((i * 100) / 6), STEP_TITLES[i]!);
    };
    const pass = (i: number, detail: string, state: StepState = 'passed') => {
      steps[i] = { state, detail, at: Date.now() };
    };
    try {
      // 1. Transfer received: the stored file is the one that arrived (one streamed pass over it).
      await begin(0);
      const first = await this.open(b);
      for await (const _ of first.source) {
        void _;
        if (signal.aborted) throw signal.reason as Error;
      }
      const digest = first.digest();
      if (b.digest && digest !== b.digest) throw new StepFailure(`The stored transfer changed since it was received (${digest.slice(0, 19)}… is not ${b.digest.slice(0, 19)}…).`);
      pass(0, `${first.size} bytes, ${digest.slice(0, 19)}…`);

      // 2. Signature. Only the first two entries are read before this passes.
      await begin(1);
      const second = await this.open(b);
      const parts = await this.manifestParts(second.source);
      const sig = await this.checkSignature(parts.manifest, parts.sig);
      pass(1, sig.detail);
      await save({ signer_fingerprint: sig.fingerprint, signer_key_id: sig.key.id });

      // 3. Digests: every file listed, none extra, every sha256 and size as the manifest says. Streamed entry by entry.
      await begin(2);
      let manifest: BundleManifest;
      try {
        manifest = manifestSchema.parse(JSON.parse(parts.manifest.toString('utf8')));
      } catch (err) {
        throw new StepFailure(`The manifest is not valid: ${(err as Error).message.slice(0, 300)}`);
      }
      const expected = new Map(manifest.files.map((f) => [f.path, f]));
      if (expected.size !== manifest.files.length) throw new StepFailure('The manifest lists a path twice.');
      const problems: string[] = [];
      const seen = new Set<string>();
      for await (const e of parts.rest) {
        if (signal.aborted) throw signal.reason as Error;
        if (!e.path.startsWith('files/')) {
          problems.push(`unexpected entry ${e.path}`);
          continue;
        }
        const p = e.path.slice('files/'.length);
        const f = expected.get(p);
        if (!f) {
          problems.push(`${p} is not in the manifest`);
          continue;
        }
        seen.add(p);
        const eh = createHash('sha256');
        for await (const c of e.body()) eh.update(c);
        const h = eh.digest('hex');
        if (h !== f.sha256 || e.size !== f.size) problems.push(`${p}: sha256 ${h.slice(0, 12)}… does not match ${f.sha256.slice(0, 12)}…`);
      }
      if (second.digest() !== digest) throw new StepFailure('The stored transfer changed while it was being verified.');
      for (const p of expected.keys()) if (!seen.has(p)) problems.push(`${p} is missing`);
      if (problems.length) throw new StepFailure(`${problems.length} ${problems.length === 1 ? 'problem' : 'problems'}: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? '; …' : ''}`);
      const byMirror: Partial<Record<MirrorKind, number>> = {};
      for (const f of manifest.files) byMirror[f.mirror] = (byMirror[f.mirror] ?? 0) + 1;
      Object.assign(report, { files: manifest.files.length, byMirror });
      pass(2, `${manifest.files.length} files matched`);
      const contents = b.contents && b.contents !== 'awaiting manifest' ? b.contents : manifest.contents ?? summarizeContents(manifest.files);
      await save({ manifest_id: manifest.id, contents });

      // 4. SBOM and vulnerability scan.
      await begin(3);
      const components = manifest.sbom.components;
      report.components = components.length;
      report.scanner = this.scanner?.name ?? null;
      if (this.scanner) {
        const { findings } = await this.scanner.scan(manifest.sbom, signal);
        const bar = SEVERITY_RANK[s.cfg.PLATFORM_SCAN_FAIL_SEVERITY]!;
        const blocking = findings.filter((f) => (SEVERITY_RANK[f.severity] ?? 0) >= bar);
        report.findings = findings.slice(0, 200);
        report.blocking = blocking.length;
        if (blocking.length) throw new StepFailure(`${blocking.length} ${s.cfg.PLATFORM_SCAN_FAIL_SEVERITY} or worse: ${blocking.slice(0, 5).map((f) => `${f.id} in ${f.package}`).join(', ')}`);
        pass(3, `${components.length} components, ${findings.length} findings below ${s.cfg.PLATFORM_SCAN_FAIL_SEVERITY} (${this.scanner.name})`);
      } else if (s.cfg.PLATFORM_BUNDLE_REQUIRE_CHECKS) {
        throw new StepFailure('A vulnerability scan is required (PLATFORM_BUNDLE_REQUIRE_CHECKS) but no scanner is configured (PLATFORM_TRIVY_BIN).');
      } else {
        pass(3, `No scanner is configured (PLATFORM_TRIVY_BIN), so no vulnerability scan ran. The SBOM lists ${components.length} components.`, 'skipped');
      }

      // 5. Licences against the allow-list.
      await begin(4);
      const allow = new Set(s.cfg.PLATFORM_LICENCE_ALLOW.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
      const licences: Record<string, number> = {};
      const bad: { component: string; licence: string | null }[] = [];
      for (const c of components) {
        const ls = componentLicences(c);
        const label = `${c.name}${c.version ? '@' + c.version : ''}`;
        if (!ls.length) bad.push({ component: label, licence: null });
        for (const l of ls) {
          licences[l] = (licences[l] ?? 0) + 1;
          if (!licenceAllowed(l, allow)) bad.push({ component: label, licence: l });
        }
      }
      report.licences = licences;
      report.licenceProblems = bad.slice(0, 100);
      if (bad.length) throw new StepFailure(`${bad.length} ${bad.length === 1 ? 'component has a licence' : 'components have licences'} outside the allow-list: ${bad.slice(0, 5).map((x) => `${x.component} (${x.licence ?? 'none declared'})`).join(', ')}`);
      pass(4, Object.keys(licences).length ? Object.entries(licences).map(([k, n]) => `${k} ${n}`).join(', ') : 'No components to check');

      // 6. Staging deploy.
      await begin(5);
      if (this.staging) {
        const r = await this.staging.deploy({ bundle: b.name, digest, contents, files: manifest.files.map((f) => ({ path: f.path, sha256: f.sha256, mirror: f.mirror })) }, signal);
        report.staging = r.detail;
        if (!r.ok) throw new StepFailure(r.detail);
        pass(5, r.detail);
      } else if (s.cfg.PLATFORM_BUNDLE_REQUIRE_CHECKS) {
        report.staging = null;
        throw new StepFailure('A staging deploy is required (PLATFORM_BUNDLE_REQUIRE_CHECKS) but no staging hook is configured (PLATFORM_STAGING_URL).');
      } else {
        report.staging = null;
        pass(5, 'No staging hook is configured (PLATFORM_STAGING_URL), so no staging deploy ran.', 'skipped');
      }
      steps[6] = { state: 'waiting', detail: 'Waiting for a platform admin.', at: null };
      await save({ state: 'ready to promote', verified_at: Date.now(), error: null });
      await audit(s, by, 'platform.bundle.verified', { bundle: bundleId, name: b.name }, { digest, signer: sig.key.name, fingerprint: sig.fingerprint, files: report.files, components: report.components, findings: report.findings?.length ?? null, skipped: steps.flatMap((x, i) => (x.state === 'skipped' ? [STEP_TITLES[i]] : [])) });
      await progress(100, 'Ready to promote');
      return { state: 'ready to promote' };
    } catch (err) {
      const reason = err instanceof StepFailure || err instanceof TarError ? err.message : `Step failed: ${(err as Error).message}`;
      steps[current] = { state: 'failed', detail: reason.slice(0, 1000), at: Date.now() };
      const fingerprint = (err as { fingerprint?: string | null }).fingerprint;
      await save({ state: 'rejected', error: reason.slice(0, 1000), ...(fingerprint ? { signer_fingerprint: fingerprint } : {}) });
      await audit(s, by, 'platform.bundle.rejected', { bundle: bundleId, name: b.name }, { step: current + 1, title: STEP_TITLES[current], reason: reason.slice(0, 1000), ...(fingerprint ? { fingerprint } : {}) });
      await notifyAdmins(s, { kind: 'platform.bundle.rejected', title: `Import bundle ${b.name} was rejected`, body: `${STEP_TITLES[current]}: ${reason.slice(0, 300)}` });
      return { state: 'rejected', failedAt: current + 1, reason };
    }
  }

  async promote(by: OpsActor, id: string): Promise<BundleRow> {
    const b = await this.get(id);
    if (b.state !== 'ready to promote') throw conflict(`Only a verified bundle can be promoted; this one is ${b.state}.`);
    this.assertChecksRan(b);
    const job = await this.s().jobs.enqueue({ tenantId: by.tenantId, type: 'ops.bundle.promote', payload: { bundleId: id }, createdBy: by.userId, maxAttempts: 1 });
    const steps = b.steps.slice();
    steps[6] = { state: 'running', detail: null, at: Date.now() };
    await this.patch(id, { state: 'promoting', job_id: job.id, steps, promoted_by: by.userId });
    await audit(this.s(), by, 'platform.bundle.promote.requested', { bundle: id, name: b.name }, { job: job.id }, 'admin');
    return this.get(id);
  }

  /** With PLATFORM_BUNDLE_REQUIRE_CHECKS, a bundle verified while the scan or staging step was skipped cannot be promoted. */
  private assertChecksRan(b: BundleRow): void {
    if (!this.s().cfg.PLATFORM_BUNDLE_REQUIRE_CHECKS) return;
    const skipped = [3, 5].filter((i) => b.steps[i]?.state !== 'passed').map((i) => STEP_TITLES[i]);
    if (skipped.length) throw conflict(`The scan and staging steps are required (PLATFORM_BUNDLE_REQUIRE_CHECKS), and this bundle did not pass: ${skipped.join(', ')}. Verify it again once they are configured.`);
  }

  /** The promotion job: checks the digest and signature again, then writes each file into its mirror's store. */
  async runPromote(bundleId: string, by: OpsActor, progress: (pct: number, msg: string) => Promise<void>): Promise<{ promotedTo: string[]; pushJob?: string }> {
    const s = this.s();
    const b = await this.get(bundleId);
    const steps = b.steps.slice();
    try {
      this.assertChecksRan(b);
      // One streamed pass: the signature is checked on the first two entries, each file is written to its mirror's
      // store while its sha256 is computed, and the whole transfer's digest is compared at the end.
      const src = await this.open(b);
      const parts = await this.manifestParts(src.source);
      await this.checkSignature(parts.manifest, parts.sig);
      const manifest = manifestSchema.parse(JSON.parse(parts.manifest.toString('utf8')));
      const byPath = new Map(manifest.files.map((f) => [f.path, f]));
      const index = new Map<MirrorKind, { path: string; sha256: string; size: number }[]>();
      let n = 0;
      for await (const e of parts.rest) {
        const f = byPath.get(e.path.slice('files/'.length));
        if (!f) continue;
        // Content-addressed: the same artifact from two bundles is stored once.
        const key = `mirrors/${f.mirror}/sha256/${f.sha256}`;
        const eh = createHash('sha256');
        const body = e.body();
        await s.blobs.putStream(key, (async function* () {
          for await (const c of body) {
            eh.update(c);
            yield c;
          }
        })());
        if (eh.digest('hex') !== f.sha256) {
          await s.blobs.delete(key).catch(() => undefined);
          throw new StepFailure(`${f.path} changed after verification.`);
        }
        index.set(f.mirror, [...(index.get(f.mirror) ?? []), { path: f.path, sha256: f.sha256, size: f.size }]);
        if (++n % 50 === 0) await progress(Math.round((n * 90) / manifest.files.length), `${n} of ${manifest.files.length} files written`);
      }
      if (src.digest() !== b.digest) throw new StepFailure('The stored transfer changed after verification.');
      const at = Date.now();
      const promotedTo: string[] = [];
      const without: MirrorKind[] = [];
      for (const [kind, files] of index) {
        await s.blobs.put(`mirrors/${kind}/index/${b.name}.json`, Buffer.from(JSON.stringify({ bundle: b.name, digest: b.digest, promotedAt: at, files }, null, 2)), 'application/json');
        const names = await s.ops.mirrors.promoted(kind, b.name, at);
        if (names.length) promotedTo.push(...names);
        else without.push(kind);
      }
      steps[6] = { state: 'passed', detail: promotedTo.length ? `Written to ${promotedTo.join(', ')}${without.length ? `; no mirror is registered for ${without.join(', ')}` : ''}` : `Written to the mirror store; no mirror is registered for ${without.join(', ')}`, at };
      await this.patch(bundleId, { state: 'in production', steps, promoted_at: at, report: { ...(b.report ?? {}), promotedTo, kindsWithoutMirror: without } });
      await audit(s, by, 'platform.bundle.promoted', { bundle: bundleId, name: b.name }, { digest: b.digest, files: n, mirrors: promotedTo, kindsWithoutMirror: without });
      // Sprint 18 (B-909): mirrors with a push target get the files through their registry's API.
      const push = await s.ops.push.request(by, bundleId).catch((err: Error) => (s.log.warn({ err, bundle: bundleId }, 'could not queue the registry push'), null));
      return { promotedTo, ...(push ? { pushJob: push.jobId } : {}) };
    } catch (err) {
      const reason = (err as Error).message.slice(0, 1000);
      steps[6] = { state: 'failed', detail: reason, at: Date.now() };
      await this.patch(bundleId, { state: 'ready to promote', steps, error: reason });
      await audit(s, by, 'platform.bundle.promote.failed', { bundle: bundleId, name: b.name }, { reason });
      throw err;
    }
  }

  /** Removes a quarantined (or never transferred) bundle's files. The rejection stays in the audit chain. */
  async remove(by: OpsActor, id: string): Promise<void> {
    const b = await this.get(id);
    if (b.state !== 'rejected' && b.state !== 'awaiting transfer') throw new HttpProblem(409, 'Conflict', `Only rejected bundles and bundles still awaiting their transfer can be deleted; this one is ${b.state}.`);
    if (b.blob_key) await this.s().blobs.delete(b.blob_key);
    await this.s().db('platform_bundles').where({ id }).delete();
    const expectedKeys = (await this.keys()).filter((k) => k.state === 'active').map((k) => ({ name: k.name, fingerprint: k.fingerprint }));
    await audit(this.s(), by, 'platform.bundle.deleted', { bundle: id, name: b.name }, { state: b.state, digest: b.digest, reason: b.error, actualSigner: b.signer_fingerprint, expectedSigners: expectedKeys }, 'admin');
  }
}
