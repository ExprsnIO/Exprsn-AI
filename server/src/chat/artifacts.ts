import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { Principal } from '../authz/policy.js';
import { clears, type Label } from '../authz/labels.js';
import { forbidden, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import type { AnswerEvent } from './context.js';

/*
 * 1.6.0, Sprint 39a (B-8001): versioned artifacts. When an answer finishes, every fenced block in it that is large
 * enough becomes (or updates) an artifact of the conversation: the fence's file name (` ```html index.html`,
 * ` ```ts title="app.ts"`) names it; a block with no name is `<language>-<n>`, the n-th unnamed block of that language
 * in the answer. A later answer that produces the same name with different content adds a version; the same content
 * adds none. Versions are sealed with the tenant key like the messages they come from, and carry the message id, so a
 * share reader sees the versions on the shared path and nothing from another branch or a withheld answer.
 *
 * HTML artifacts render in a sandboxed iframe whose URL is a short-lived capability (`rawToken`): the public route
 * serves the bytes with its own strict CSP and no session, so the rendered document cannot reach the console's
 * origin, cookies or API.
 */

export type ArtifactKind = 'code' | 'document' | 'html';

export interface ArtifactRow {
  id: string;
  tenant_id: string;
  conversation_id: string;
  key: string;
  kind: ArtifactKind;
  language: string | null;
  title: string;
  label: Label;
  versions: number;
  created_at: number;
  updated_at: number;
}

export interface VersionRow {
  id: string;
  artifact_id: string;
  tenant_id: string;
  conversation_id: string;
  message_id: string;
  version: number;
  content: string;
  sha256: string;
  bytes: number;
  created_at: number;
}

export interface ArtifactView {
  id: string;
  key: string;
  kind: ArtifactKind;
  language: string | null;
  title: string;
  label: Label;
  versions: { id: string; version: number; messageId: string; bytes: number; sha256: string; createdAt: number; rawUrl: string }[];
  createdAt: number;
  updatedAt: number;
}

export interface Extracted {
  key: string;
  kind: ArtifactKind;
  language: string | null;
  title: string;
  content: string;
}

const HTML = new Set(['html', 'htm', 'xhtml', 'svg']);
const DOCUMENT = new Set(['markdown', 'md', 'text', 'txt', 'plain', 'rst', 'adoc', 'asciidoc']);
const FENCE = /^(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n\1[ \t]*$/gm;
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** The fenced blocks of an answer, as artifacts: name, kind and content. Exported for tests. */
export function extractArtifacts(content: string, minChars: number, maxBytes: number): Extracted[] {
  const out: Extracted[] = [];
  const unnamed = new Map<string, number>();
  for (const m of content.matchAll(FENCE)) {
    const info = (m[2] ?? '').trim();
    const body = m[3] ?? '';
    if (body.trim().length < minChars || Buffer.byteLength(body, 'utf8') > maxBytes) continue;
    const words = info.split(/\s+/).filter(Boolean);
    const language = (words[0] ?? '').toLowerCase().replace(/[^a-z0-9+#.-]/g, '').slice(0, 40) || null;
    let name: string | null = null;
    const titled = info.match(/\b(?:title|filename|file|name)=(?:"([^"]+)"|'([^']+)'|(\S+))/i);
    if (titled) name = titled[1] ?? titled[2] ?? titled[3] ?? null;
    else {
      const candidate = words.slice(1).find((w) => /^[\w.@/-]+\.[A-Za-z0-9]{1,8}$/.test(w) && !w.includes('='));
      if (candidate) name = candidate;
    }
    const lang = language ?? 'text';
    const kind: ArtifactKind = HTML.has(lang) || (name != null && /\.(html?|svg)$/i.test(name)) ? 'html' : DOCUMENT.has(lang) || (name != null && /\.(md|markdown|txt|rst)$/i.test(name)) ? 'document' : 'code';
    let key: string;
    if (name) key = name.replace(/^\.?\//, '').slice(0, 200);
    else {
      const n = (unnamed.get(lang) ?? 0) + 1;
      unnamed.set(lang, n);
      key = `${lang}-${n}`;
    }
    const title = name ?? `${lang === 'text' ? 'Text' : lang} block ${unnamed.get(lang) ?? 1}`;
    if (!out.some((x) => x.key === key)) out.push({ key, kind, language, title: title.slice(0, 200), content: body });
  }
  return out;
}

export class ChatArtifacts {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  /** Called when an answer finishes: fenced blocks become artifacts or new versions of them. */
  async onAnswer(e: AnswerEvent): Promise<void> {
    if (e.state !== 'complete' && e.state !== 'stopped') return;
    const s = this.s();
    const m = (await this.db('messages').where({ id: e.messageId, tenant_id: e.tenantId }).first()) as { id: string; content: string | null; label: Label; state: string } | undefined;
    if (!m?.content || (m.state !== 'complete' && m.state !== 'stopped')) return;
    const text = await s.keys.open(e.tenantId, m.content, `content:${m.id}`);
    const found = extractArtifacts(text, s.cfg.CHAT_ARTIFACT_MIN_CHARS, s.cfg.CHAT_ARTIFACT_MAX_BYTES);
    if (!found.length) return;
    const now = Date.now();
    for (const a of found) {
      const existing = (await this.db('chat_artifacts').where({ conversation_id: e.conversationId, key: a.key }).first()) as ArtifactRow | undefined;
      const digest = sha(a.content);
      let artifact = existing;
      if (!artifact) {
        const count = (await this.db('chat_artifacts').where({ conversation_id: e.conversationId }).count({ n: '*' }).first()) as { n: number | string } | undefined;
        if (Number(count?.n ?? 0) >= 200) {
          s.log.warn({ conversation: e.conversationId }, 'artifact limit reached; the block stays in the answer only');
          continue;
        }
        artifact = { id: ulid(), tenant_id: e.tenantId, conversation_id: e.conversationId, key: a.key, kind: a.kind, language: a.language, title: a.title, label: m.label, versions: 0, created_at: now, updated_at: now };
        await this.db('chat_artifacts').insert(artifact);
      } else {
        const last = (await this.db('chat_artifact_versions').where({ artifact_id: artifact.id }).orderBy('version', 'desc').first()) as VersionRow | undefined;
        if (last && last.sha256 === digest) continue; // the same content again: no new version
      }
      const version = Number(artifact.versions) + 1;
      await this.db('chat_artifact_versions').insert({
        id: ulid(),
        artifact_id: artifact.id,
        tenant_id: e.tenantId,
        conversation_id: e.conversationId,
        message_id: m.id,
        version,
        content: await s.keys.seal(e.tenantId, a.content, `artifact:${artifact.id}:${version}`),
        sha256: digest,
        bytes: Buffer.byteLength(a.content, 'utf8'),
        created_at: now
      } satisfies VersionRow);
      const label = clears(m.label, artifact.label) ? m.label : artifact.label; // a high-water mark, like the conversation's
      await this.db('chat_artifacts').where({ id: artifact.id }).update({ versions: version, kind: a.kind, language: a.language, title: a.title, label, updated_at: now });
    }
    s.bus.publish('chat.artifacts', { tenantId: e.tenantId, userId: e.principal.userId, conversationId: e.conversationId, messageId: m.id });
  }

  // ---------- reading ----------

  /** A short-lived capability for the sandboxed render of one version: the iframe's URL needs no session. */
  async rawToken(versionId: string, ttlMs = this.s().cfg.CHAT_ARTIFACT_RAW_TTL_SECONDS * 1000): Promise<string> {
    const exp = Date.now() + ttlMs;
    const mac = await this.s().kms.hmac('chat-artifacts', `${versionId}.${exp}`);
    return `${versionId}.${exp}.${mac}`;
  }

  private async views(rows: ArtifactRow[], versions: VersionRow[], clearance: Label): Promise<ArtifactView[]> {
    const byArtifact = new Map<string, VersionRow[]>();
    for (const v of versions) byArtifact.set(v.artifact_id, [...(byArtifact.get(v.artifact_id) ?? []), v]);
    const out: ArtifactView[] = [];
    for (const a of rows) {
      if (!clears(clearance, a.label)) continue;
      const vs = (byArtifact.get(a.id) ?? []).sort((x, y) => x.version - y.version);
      if (!vs.length) continue;
      out.push({
        id: a.id,
        key: a.key,
        kind: a.kind,
        language: a.language,
        title: a.title,
        label: a.label,
        versions: await Promise.all(vs.map(async (v) => ({ id: v.id, version: v.version, messageId: v.message_id, bytes: Number(v.bytes), sha256: v.sha256, createdAt: Number(v.created_at), rawUrl: `/api/public/artifacts/${v.id}/raw?t=${encodeURIComponent(await this.rawToken(v.id))}` }))),
        createdAt: Number(a.created_at),
        updatedAt: Number(a.updated_at)
      });
    }
    return out;
  }

  /** The artifacts of a conversation, for its owner or a share reader; versions limited to the given messages when set. */
  async list(p: Principal, conversationId: string, o: { messageIds?: Set<string> } = {}): Promise<ArtifactView[]> {
    const { c } = await this.s().sharing.readable(p, conversationId);
    const rows = (await this.db('chat_artifacts').where({ conversation_id: c.id }).orderBy('created_at', 'asc')) as ArtifactRow[];
    let versions = (await this.db('chat_artifact_versions').where({ conversation_id: c.id })) as VersionRow[];
    if (o.messageIds) versions = versions.filter((v) => o.messageIds!.has(v.message_id));
    return this.views(rows, versions, p.clearance);
  }

  /** For a transcript (shares, links): the artifacts whose versions come from the shown messages. */
  async forTranscript(conversationId: string, messageIds: string[], clearance: Label): Promise<ArtifactView[]> {
    const shown = new Set(messageIds);
    const rows = (await this.db('chat_artifacts').where({ conversation_id: conversationId }).orderBy('created_at', 'asc')) as ArtifactRow[];
    const versions = ((await this.db('chat_artifact_versions').where({ conversation_id: conversationId })) as VersionRow[]).filter((v) => shown.has(v.message_id));
    return this.views(rows, versions, clearance);
  }

  /** One version's content, for the owner or a share reader. */
  async version(p: Principal, conversationId: string, artifactId: string, n: number): Promise<{ artifact: ArtifactRow; version: VersionRow; content: string }> {
    const { c } = await this.s().sharing.readable(p, conversationId);
    const artifact = (await this.db('chat_artifacts').where({ id: artifactId, conversation_id: c.id }).first()) as ArtifactRow | undefined;
    if (!artifact) throw notFound('Artifact');
    if (!clears(p.clearance, artifact.label)) throw forbidden('Above your clearance.', { step: 'clearance' });
    const version = (await this.db('chat_artifact_versions').where({ artifact_id: artifact.id, version: n }).first()) as VersionRow | undefined;
    if (!version) throw notFound('Artifact version');
    return { artifact, version, content: await this.s().keys.open(c.tenant_id, version.content, `artifact:${artifact.id}:${version.version}`) };
  }

  /** The bytes behind a raw token, for the public render route. Null when the token is wrong or stale. */
  async raw(token: string): Promise<{ artifact: ArtifactRow; version: VersionRow; content: string } | null> {
    const [versionId, expStr, mac] = token.split('.');
    if (!versionId || !expStr || !mac || !/^[0-9A-Z]{26}$/.test(versionId) || !/^\d{1,16}$/.test(expStr)) return null;
    if (Number(expStr) < Date.now()) return null;
    if (!(await this.s().kms.verifyHmac('chat-artifacts', `${versionId}.${expStr}`, mac))) return null;
    const version = (await this.db('chat_artifact_versions').where({ id: versionId }).first()) as VersionRow | undefined;
    if (!version) return null;
    const artifact = (await this.db('chat_artifacts').where({ id: version.artifact_id }).first()) as ArtifactRow | undefined;
    if (!artifact) return null;
    return { artifact, version, content: await this.s().keys.open(version.tenant_id, version.content, `artifact:${artifact.id}:${version.version}`) };
  }
}
