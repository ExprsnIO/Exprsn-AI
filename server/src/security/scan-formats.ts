/*
 * 1.8.0, Sprint 48 (B-144): reading security scan reports into one shape.
 *
 * Three formats are read, each into normalised findings (severity, id, package, version, fixed version, licence,
 * path):
 *   - Trivy JSON (`trivy image|fs|config --format json`): `Results[].Vulnerabilities`, `Misconfigurations`, `Secrets`
 *     and `Licenses`; `Metadata.RepoDigests` names an image's digest.
 *   - SARIF 2.1.0 (any SAST tool): each `runs[].results[]`, its severity from the rule's `security-severity` (a CVSS
 *     score) when given, else from the result's or rule's `level`.
 *   - CycloneDX JSON (1.4 to 1.6): each component's licences (as `licence` findings) and the BOM's `vulnerabilities`.
 *
 * Only JSON is accepted, and the reader is defensive: a report is untrusted input. Strings are cut to fixed lengths,
 * at most MAX_FINDINGS findings are kept (the summary still counts all), and an unrecognised shape is refused.
 */

export const SCAN_FORMATS = ['trivy', 'sarif', 'cyclonedx'] as const;
export type ScanFormat = (typeof SCAN_FORMATS)[number];

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'unknown'] as const;
export type Severity = (typeof SEVERITIES)[number];

export type FindingKind = 'vulnerability' | 'sast' | 'misconfiguration' | 'secret' | 'licence';

export interface Finding {
  kind: FindingKind;
  severity: Severity;
  /** CVE or GHSA id, SARIF rule id, Trivy misconfiguration id, or `licence:<SPDX>`. */
  id: string;
  package: string | null;
  version: string | null;
  fixedVersion: string | null;
  licence: string | null;
  path: string | null;
  title: string | null;
}

export interface ParsedReport {
  format: ScanFormat;
  tool: string | null;
  toolVersion: string | null;
  /** When the scan ran, if the report says. */
  scannedAt: number | null;
  /** The artefact's digest, when the report names one (Trivy's RepoDigests, a CycloneDX component hash). */
  digest: string | null;
  artefactName: string | null;
  findings: Finding[];
  /** Counts over every finding, including those past MAX_FINDINGS. */
  summary: ScanSummary;
}

export interface ScanSummary {
  total: number;
  bySeverity: Record<Severity, number>;
  byKind: Partial<Record<FindingKind, number>>;
  licences: string[];
  truncated: boolean;
}

export class ScanFormatError extends Error {}

export const MAX_FINDINGS = 5000;

const cut = (v: unknown, n: number): string | null => {
  if (v === undefined || v === null) return null;
  // eslint-disable-next-line no-control-regex -- control characters in an untrusted report are removed
  const s = String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return s ? s.slice(0, n) : null;
};

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function severityOf(v: unknown): Severity {
  const s = String(v ?? '').toLowerCase();
  if (s === 'critical') return 'critical';
  if (s === 'high' || s === 'error') return 'high';
  if (s === 'medium' || s === 'moderate' || s === 'warning') return 'medium';
  if (s === 'low' || s === 'note' || s === 'info' || s === 'negligible') return 'low';
  return 'unknown';
}

/** A CVSS-style score (`security-severity` in SARIF) to a severity, as GitHub code scanning reads it. */
export function severityOfScore(score: number): Severity {
  if (!Number.isFinite(score) || score <= 0) return 'unknown';
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  return 'low';
}

const time = (v: unknown): number | null => {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

const DIGEST_RE = /sha256:[0-9a-f]{64}/;

function summarise(all: Finding[]): ScanSummary {
  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  const byKind: Partial<Record<FindingKind, number>> = {};
  const licences = new Set<string>();
  for (const f of all) {
    bySeverity[f.severity]++;
    byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
    if (f.licence) licences.add(f.licence);
  }
  return { total: all.length, bySeverity, byKind, licences: [...licences].sort().slice(0, 500), truncated: all.length > MAX_FINDINGS };
}

function finish(base: Omit<ParsedReport, 'findings' | 'summary'>, all: Finding[]): ParsedReport {
  return { ...base, findings: all.slice(0, MAX_FINDINGS), summary: summarise(all) };
}

const finding = (f: Partial<Finding> & Pick<Finding, 'kind' | 'severity' | 'id'>): Finding => ({ package: null, version: null, fixedVersion: null, licence: null, path: null, title: null, ...f });

// ---------- Trivy ----------

function parseTrivy(doc: Record<string, unknown>): ParsedReport {
  const meta = obj(doc.Metadata) ?? {};
  const digests = arr(meta.RepoDigests).map((d) => String(d));
  const digest = digests.map((d) => DIGEST_RE.exec(d)?.[0]).find(Boolean) ?? (typeof meta.ImageID === 'string' && DIGEST_RE.test(meta.ImageID) ? DIGEST_RE.exec(meta.ImageID)![0] : null);
  const all: Finding[] = [];
  for (const r of arr(doc.Results)) {
    const res = obj(r);
    if (!res) continue;
    const target = cut(res.Target, 300);
    for (const v of arr(res.Vulnerabilities)) {
      const x = obj(v);
      if (!x) continue;
      all.push(finding({ kind: 'vulnerability', severity: severityOf(x.Severity), id: cut(x.VulnerabilityID, 200) ?? 'unknown', package: cut(x.PkgName, 200), version: cut(x.InstalledVersion, 100), fixedVersion: cut(x.FixedVersion, 200), path: cut(x.PkgPath, 300) ?? target, title: cut(x.Title, 300) }));
    }
    for (const v of arr(res.Misconfigurations)) {
      const x = obj(v);
      if (!x) continue;
      all.push(finding({ kind: 'misconfiguration', severity: severityOf(x.Severity), id: cut(x.AVDID ?? x.ID, 200) ?? 'unknown', path: target, title: cut(x.Title, 300) }));
    }
    for (const v of arr(res.Secrets)) {
      const x = obj(v);
      if (!x) continue;
      // The secret's text (`Match`) is never read or kept.
      all.push(finding({ kind: 'secret', severity: severityOf(x.Severity), id: cut(x.RuleID, 200) ?? 'secret', path: target, title: cut(x.Title, 300) }));
    }
    for (const v of arr(res.Licenses)) {
      const x = obj(v);
      if (!x) continue;
      const name = cut(x.Name, 200);
      if (!name) continue;
      all.push(finding({ kind: 'licence', severity: severityOf(x.Severity), id: `licence:${name}`, package: cut(x.PkgName, 200), licence: name, path: cut(x.FilePath, 300) ?? target, title: cut(x.Category, 100) }));
    }
  }
  const created = time(doc.CreatedAt);
  return finish({ format: 'trivy', tool: 'Trivy', toolVersion: cut(obj(doc.Trivy)?.Version, 60), scannedAt: created, digest, artefactName: cut(doc.ArtifactName, 200) }, all);
}

// ---------- SARIF ----------

function parseSarif(doc: Record<string, unknown>): ParsedReport {
  const all: Finding[] = [];
  let tool: string | null = null;
  let toolVersion: string | null = null;
  let scannedAt: number | null = null;
  for (const r of arr(doc.runs)) {
    const run = obj(r);
    if (!run) continue;
    const driver = obj(obj(run.tool)?.driver) ?? {};
    tool ??= cut(driver.name, 100);
    toolVersion ??= cut(driver.semanticVersion ?? driver.version, 60);
    for (const inv of arr(run.invocations)) scannedAt ??= time(obj(inv)?.endTimeUtc) ?? time(obj(inv)?.startTimeUtc);
    const rules = new Map<string, Record<string, unknown>>();
    for (const rule of arr(driver.rules)) {
      const ro = obj(rule);
      if (ro && typeof ro.id === 'string') rules.set(ro.id, ro);
    }
    for (const res of arr(run.results)) {
      const x = obj(res);
      if (!x) continue;
      const ruleId = cut(x.ruleId ?? obj(x.rule)?.id, 200) ?? 'unknown';
      const rule = rules.get(ruleId) ?? null;
      const score = Number(obj(rule?.properties)?.['security-severity'] ?? obj(x.properties)?.['security-severity']);
      const level = x.level ?? obj(rule?.defaultConfiguration)?.level;
      const severity = Number.isFinite(score) && score > 0 ? severityOfScore(score) : severityOf(level ?? 'warning');
      const loc = obj(obj(arr(x.locations)[0])?.physicalLocation);
      const uri = cut(obj(loc?.artifactLocation)?.uri, 280);
      const line = obj(loc?.region)?.startLine;
      all.push(finding({ kind: 'sast', severity, id: ruleId, path: uri ? (typeof line === 'number' ? `${uri}:${line}` : uri) : null, title: cut(obj(x.message)?.text ?? obj(rule?.shortDescription)?.text, 300) }));
    }
  }
  return finish({ format: 'sarif', tool, toolVersion, scannedAt, digest: null, artefactName: null }, all);
}

// ---------- CycloneDX ----------

/** The SPDX ids (or names) a CycloneDX `licenses` array names, with expressions kept whole. */
function licencesOf(v: unknown): string[] {
  const out: string[] = [];
  for (const l of arr(v)) {
    const lo = obj(l);
    if (!lo) continue;
    if (typeof lo.expression === 'string') {
      const e = cut(lo.expression, 200);
      if (e) out.push(e);
      continue;
    }
    const lic = obj(lo.license);
    const name = cut(lic?.id ?? lic?.name, 200);
    if (name) out.push(name);
  }
  return out;
}

function parseCycloneDx(doc: Record<string, unknown>): ParsedReport {
  const meta = obj(doc.metadata) ?? {};
  const tools = meta.tools;
  const firstTool = Array.isArray(tools) ? obj(tools[0]) : obj(arr(obj(tools)?.components)[0]);
  const top = obj(meta.component);
  const all: Finding[] = [];
  const byRef = new Map<string, { name: string | null; version: string | null }>();
  const walk = (list: unknown, depth: number) => {
    if (depth > 8) return;
    for (const c of arr(list)) {
      const co = obj(c);
      if (!co) continue;
      const name = cut(co.group ? `${String(co.group)}/${String(co.name)}` : co.name, 200);
      const version = cut(co.version, 100);
      if (typeof co['bom-ref'] === 'string') byRef.set(co['bom-ref'], { name, version });
      for (const lic of licencesOf(co.licenses)) all.push(finding({ kind: 'licence', severity: 'unknown', id: `licence:${lic}`, package: name, version, licence: lic, path: cut(co.purl, 300) }));
      walk(co.components, depth + 1);
    }
  };
  walk(doc.components, 0);
  for (const v of arr(doc.vulnerabilities)) {
    const x = obj(v);
    if (!x) continue;
    const ratings = arr(x.ratings).map((r) => severityOf(obj(r)?.severity));
    const order: Severity[] = ['critical', 'high', 'medium', 'low', 'unknown'];
    const severity = order.find((s) => ratings.includes(s)) ?? 'unknown';
    const affects = arr(x.affects).map((a) => String(obj(a)?.ref ?? ''));
    const target = affects.map((r) => byRef.get(r)).find(Boolean) ?? null;
    const state = String(obj(x.analysis)?.state ?? '');
    // A vulnerability the producer's analysis marks not affected or resolved is not a finding.
    if (state === 'not_affected' || state === 'resolved' || state === 'false_positive') continue;
    // CycloneDX names a fixed version as an `unaffected` version of the affected component.
    const fixed = arr(x.affects).flatMap((a) => arr(obj(a)?.versions)).map((ver) => obj(ver)).find((ver) => ver?.status === 'unaffected');
    all.push(finding({ kind: 'vulnerability', severity, id: cut(x.id, 200) ?? 'unknown', package: target?.name ?? cut(affects[0], 200), version: target?.version ?? null, fixedVersion: cut(fixed?.version, 200), title: cut(x.description ?? x.detail, 300) }));
  }
  const hash = arr(top?.hashes).map((h) => obj(h)).find((h) => String(h?.alg).toUpperCase() === 'SHA-256');
  const digest = hash && typeof hash.content === 'string' && /^[0-9a-f]{64}$/.test(hash.content) ? `sha256:${hash.content}` : null;
  return finish({ format: 'cyclonedx', tool: cut(firstTool?.name, 100), toolVersion: cut(firstTool?.version, 60), scannedAt: time(meta.timestamp), digest, artefactName: cut(top?.name, 200) }, all);
}

/** Which format a parsed JSON document is, or null. */
export function detectFormat(doc: unknown): ScanFormat | null {
  const d = obj(doc);
  if (!d) return null;
  if (d.bomFormat === 'CycloneDX') return 'cyclonedx';
  if (typeof d.version === 'string' && Array.isArray(d.runs) && (d.$schema === undefined || String(d.$schema).includes('sarif'))) return 'sarif';
  if (Array.isArray(d.Results) || (typeof d.SchemaVersion === 'number' && 'ArtifactName' in d)) return 'trivy';
  return null;
}

/** Reads a report. `format` may be given; otherwise it is detected, and a mismatch is refused. */
export function parseReport(text: string, format?: ScanFormat): ParsedReport {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new ScanFormatError('The report is not JSON. Upload Trivy JSON, SARIF 2.1.0 or a CycloneDX JSON SBOM.');
  }
  const detected = detectFormat(doc);
  if (!detected) throw new ScanFormatError('The report is not Trivy JSON, SARIF 2.1.0 or a CycloneDX JSON SBOM.');
  if (format && format !== detected) throw new ScanFormatError(`The report reads as ${detected}, not ${format}.`);
  const d = doc as Record<string, unknown>;
  if (detected === 'sarif' && !String(d.version).startsWith('2.1')) throw new ScanFormatError(`SARIF ${String(d.version)} is not read; export SARIF 2.1.0.`);
  return detected === 'trivy' ? parseTrivy(d) : detected === 'sarif' ? parseSarif(d) : parseCycloneDx(d);
}

/**
 * Whether a licence (an SPDX id or an expression) is refused by the deny-list. `A OR B` is refused only when every
 * alternative is denied (the user may choose the other); `A AND B` and `A WITH exception` when any part is.
 */
export function licenceDenied(licence: string, deny: readonly string[]): string | null {
  if (!deny.length) return null;
  const denied = new Set(deny.map((d) => d.trim().toLowerCase()).filter(Boolean));
  const expr = licence.replace(/[()]/g, ' ').trim();
  const alternatives = expr.split(/\s+OR\s+/i);
  const hits: string[] = [];
  for (const alt of alternatives) {
    const parts = alt.split(/\s+(?:AND|WITH)\s+/i).map((p) => p.trim()).filter(Boolean);
    const hit = parts.find((p) => denied.has(p.toLowerCase()));
    if (!hit) return null;
    hits.push(hit);
  }
  return hits[0] ?? null;
}
