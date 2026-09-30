import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { signV4 } from '../platform/blob.js';
import { INDEXABLE_EXT } from './extract.js';

const run = promisify(execFile);

/** One document a source offers. `version` lets a sync skip the fetch when nothing changed. */
export interface SourceItem {
  key: string;
  name: string;
  version: string | null;
  size: number;
  read(): Promise<Buffer>;
}

// ---------- S3 ----------

export interface S3Settings {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  pathStyle: boolean;
}

/** Parses `s3://bucket/prefix/`. */
export function parseS3(location: string): { bucket: string; prefix: string } | null {
  const m = /^s3:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])(?:\/(.*))?$/.exec(location.trim());
  return m ? { bucket: m[1]!, prefix: m[2] ?? '' } : null;
}

const xmlText = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");

/**
 * Lists and reads objects under a prefix with the platform's S3 credentials (ListObjectsV2 and GET, SigV4). Only
 * objects with an indexable extension and at most `maxBytes` are offered.
 */
export class S3Reader {
  constructor(private readonly o: S3Settings) {}

  private url(bucket: string, key: string, query: Record<string, string> = {}): URL {
    const base = new URL(this.o.endpoint);
    const u = this.o.pathStyle ? new URL(`${base.origin}/${bucket}/${key}`) : new URL(`${base.protocol}//${bucket}.${base.host}/${key}`);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u;
  }

  private async get(url: URL, signal?: AbortSignal): Promise<Response> {
    const headers = signV4({ method: 'GET', url, headers: {}, payloadHash: createHash('sha256').update('').digest('hex'), region: this.o.region, service: 's3', accessKeyId: this.o.accessKeyId, secretAccessKey: this.o.secretAccessKey, date: new Date() });
    delete headers.host;
    return fetch(url, { headers, signal: signal ?? AbortSignal.timeout(60_000) });
  }

  async list(bucket: string, prefix: string, maxBytes: number, signal?: AbortSignal): Promise<{ items: SourceItem[]; newest: string | null }> {
    const items: SourceItem[] = [];
    let newest: string | null = null;
    let token: string | undefined;
    do {
      const q: Record<string, string> = { 'list-type': '2', prefix };
      if (token) q['continuation-token'] = token;
      const res = await this.get(this.url(bucket, '', q), signal);
      if (!res.ok) throw new Error(`S3 list of s3://${bucket}/${prefix} failed: HTTP ${res.status}`);
      const xml = await res.text();
      for (const c of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const body = c[1]!;
        const key = xmlText(/<Key>([^<]*)<\/Key>/.exec(body)?.[1] ?? '');
        const size = Number(/<Size>(\d+)<\/Size>/.exec(body)?.[1] ?? 0);
        const etag = xmlText(/<ETag>([^<]*)<\/ETag>/.exec(body)?.[1] ?? '').replace(/"/g, '');
        const modified = /<LastModified>([^<]*)<\/LastModified>/.exec(body)?.[1] ?? null;
        if (!key || key.endsWith('/') || !INDEXABLE_EXT.test(key) || size > maxBytes) continue;
        if (modified && (!newest || modified > newest)) newest = modified;
        items.push({
          key,
          name: key.slice(prefix.length).replace(/^\/+/, '') || key,
          version: etag || modified,
          size,
          read: async () => {
            const r = await this.get(this.url(bucket, key.split('/').map(encodeURIComponent).join('/')), signal);
            if (!r.ok) throw new Error(`S3 GET ${key}: HTTP ${r.status}`);
            return Buffer.from(await r.arrayBuffer());
          }
        });
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? xmlText(/<NextContinuationToken>([^<]+)</.exec(xml)?.[1] ?? '') || undefined : undefined;
    } while (token);
    return { items, newest };
  }
}

// ---------- Git ----------

export interface GitCheckout {
  dir: string;
  commit: string;
  cleanup(): Promise<void>;
}

/** Fetches one revision of a repository into a temporary directory. */
export interface GitFetcher {
  checkout(url: string, ref: string | null, signal?: AbortSignal): Promise<GitCheckout>;
}

/** Accepts https:// (and file:// only when enabled, for tests and air-gapped mirrors on the same host). */
export function checkGitUrl(url: string, allowFile: boolean): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'Give the repository as an https:// URL.';
  }
  if (u.protocol === 'https:') return u.username || u.password ? 'Credentials in the URL are refused; use a repository the server may read.' : null;
  if (u.protocol === 'file:' && allowFile) return null;
  return 'Only https:// repositories are accepted.';
}

/**
 * The git command line: a shallow, single-branch clone with only the https protocol allowed (plus file when
 * enabled), no prompts, no hooks and no system or global configuration.
 */
export class CliGit implements GitFetcher {
  constructor(private readonly o: { allowFile: boolean; timeoutMs: number }) {}

  async checkout(url: string, ref: string | null, signal?: AbortSignal): Promise<GitCheckout> {
    const bad = checkGitUrl(url, this.o.allowFile);
    if (bad) throw new Error(bad);
    const dir = await mkdtemp(path.join(tmpdir(), 'exprsn-git-'));
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: dir };
    const protocols = ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', ...(this.o.allowFile ? ['-c', 'protocol.file.allow=always'] : []), '-c', 'core.hooksPath=/dev/null'];
    try {
      await run('git', [...protocols, 'clone', '--quiet', '--depth', '1', '--single-branch', '--no-tags', ...(ref ? ['--branch', ref] : []), '--', url, path.join(dir, 'repo')], { env, timeout: this.o.timeoutMs, maxBuffer: 1024 * 1024, ...(signal ? { signal } : {}) });
      const { stdout } = await run('git', ['-C', path.join(dir, 'repo'), 'rev-parse', 'HEAD'], { env, timeout: 30_000 });
      return { dir: path.join(dir, 'repo'), commit: stdout.trim(), cleanup: () => rm(dir, { recursive: true, force: true }) };
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      const msg = String((err as { stderr?: string }).stderr || (err as Error).message).trim().split('\n').pop() ?? 'git failed';
      throw new Error(`git clone failed: ${msg.slice(0, 300)}`, { cause: err });
    }
  }
}

/** Indexable files in a checkout (optionally under `sub`), skipping .git and anything larger than `maxBytes`. */
export async function gitItems(dir: string, sub: string, maxBytes: number): Promise<SourceItem[]> {
  const root = path.resolve(dir, sub.replace(/^\/+/, ''));
  if (!root.startsWith(path.resolve(dir))) throw new Error('The path leaves the repository.');
  const out: SourceItem[] = [];
  const walk = async (d: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === '.git') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && INDEXABLE_EXT.test(e.name)) {
        const st = await stat(full);
        if (st.size > maxBytes) continue;
        const rel = path.relative(dir, full).split(path.sep).join('/');
        const data = await readFile(full);
        out.push({ key: rel, name: rel, version: createHash('sha256').update(data).digest('hex'), size: st.size, read: async () => data });
      }
    }
  };
  await walk(root);
  return out.sort((a, b) => (a.key < b.key ? -1 : 1));
}
