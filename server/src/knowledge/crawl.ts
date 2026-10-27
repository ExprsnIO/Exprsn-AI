import { createHash } from 'node:crypto';
import { fetch, type Dispatcher } from 'undici';
import type { SourceItem } from './sources.js';
import { imageType } from './images.js';

/*
 * Internal web sites as knowledge sources (B-1502). A crawl starts at one URL and never leaves its origin (scheme,
 * host and port): links, redirects and sitemap entries elsewhere are skipped. robots.txt is read first (RFC 9309:
 * the group for our user agent, else `*`; the longest matching rule wins, Allow on a tie; an unreachable robots.txt
 * stops the crawl, a missing one allows everything) and its Sitemap lines, or /sitemap.xml, add the pages a sitemap
 * lists. Pages are fetched breadth-first up to a link depth and a page count, each through the caller's dispatcher
 * (which checks every address it dials), with the validators of the stored copy (If-None-Match, If-Modified-Since):
 * a 304 keeps the document without downloading it again.
 *
 * With `media`, the images of the pages that were indexed (`<img>`) are offered as documents too, for the base's
 * vision profile to caption and read: PNG, JPEG, WebP and GIF, checked from their bytes, above a size that leaves out
 * icons, up to a count of their own. An image may be on the page's site or on another host the caller names (a
 * site's image host); every host's own robots.txt decides, and a host whose robots.txt cannot be read is left alone.
 */

export const CRAWLER_AGENT = 'ExprsnAI-Knowledge';

export interface CrawlPrevious {
  version: string | null;
  /** The stored body, for following the links of a page that answered 304. */
  body(): Promise<Buffer>;
}

export interface CrawlOptions {
  start: string;
  /** Link hops from the start page (a sitemap entry counts as one). */
  maxDepth: number;
  maxPages: number;
  /** Only paths under this prefix are fetched ('' for the whole site). */
  pathPrefix: string;
  sitemap: boolean;
  maxBytes: number;
  timeoutMs: number;
  dispatcher: Dispatcher;
  previous(url: string): Promise<CrawlPrevious | null>;
  signal?: AbortSignal;
  /** The longest pause between requests that a robots.txt Crawl-delay may ask for (ms). */
  maxDelayMs?: number;
  /** The images of the indexed pages become documents as well. */
  media?: CrawlMedia;
}

export interface CrawlMedia {
  /** At most this many images per crawl. */
  max: number;
  /** Smaller images (icons, spacers, tracking pixels) are skipped. */
  minBytes: number;
  /** Whether images may be fetched from this other host (the start page's own host always may). */
  allowed(hostname: string): boolean;
}

export interface CrawlResult {
  items: SourceItem[];
  skipped: { url: string; reason: string }[];
  /** URLs answered with 304 (unchanged). */
  unchanged: number;
  /** How many of the items are images. */
  images: number;
}

// ---------- robots.txt ----------

interface RobotsRule {
  allow: boolean;
  pattern: string;
}

export interface Robots {
  rules: RobotsRule[];
  sitemaps: string[];
  delayMs: number;
}

/** Parses robots.txt for one user agent token: its own group(s), else the `*` group(s). */
export function parseRobots(text: string, agent = CRAWLER_AGENT): Robots {
  const token = agent.toLowerCase();
  const groups: { agents: string[]; rules: RobotsRule[]; delay: number | null }[] = [];
  const sitemaps: string[] = [];
  let current: (typeof groups)[number] | null = null;
  let inAgents = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }
    if (key === 'user-agent') {
      if (!current || !inAgents) groups.push((current = { agents: [], rules: [], delay: null }));
      current.agents.push(value.toLowerCase());
      inAgents = true;
      continue;
    }
    inAgents = false;
    if (!current) continue;
    if (key === 'allow' || key === 'disallow') {
      // An empty Disallow allows everything; it adds no rule.
      if (value) current.rules.push({ allow: key === 'allow', pattern: value });
    } else if (key === 'crawl-delay' && /^\d+(\.\d+)?$/.test(value)) current.delay = Number(value) * 1000;
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && token.includes(a.replace(/\/.*$/, ''))));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes('*'));
  return { rules: chosen.flatMap((g) => g.rules), sitemaps, delayMs: Math.max(0, ...chosen.map((g) => g.delay ?? 0)) };
}

const ruleRegex = (pattern: string): RegExp => {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
};

/** Whether robots rules allow a path (with its query): the longest matching rule decides, Allow on a tie. */
export function robotsAllows(robots: Pick<Robots, 'rules'>, pathAndQuery: string): boolean {
  let best: RobotsRule | null = null;
  for (const r of robots.rules) {
    if (!ruleRegex(r.pattern).test(pathAndQuery)) continue;
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

// ---------- pages ----------

const TYPES: Record<string, string> = {
  'text/html': 'text/html',
  'application/xhtml+xml': 'text/html',
  'text/plain': 'text/plain',
  'text/markdown': 'text/markdown',
  'text/x-markdown': 'text/markdown',
  'text/csv': 'text/csv',
  'application/json': 'application/json',
  'application/pdf': 'application/pdf'
};

/** The links of an HTML page (a and area href), resolved against the page; rel=nofollow links are skipped. */
export function pageLinks(html: string, base: string): string[] {
  if (/<meta\s[^>]*name\s*=\s*["']?robots["']?[^>]*content\s*=\s*["'][^"']*nofollow/i.test(html)) return [];
  let baseUrl = base;
  const b = /<base\s[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(html);
  if (b) {
    try {
      baseUrl = new URL(b[1] ?? b[2] ?? b[3] ?? '', base).toString();
    } catch {
      // keep the page's own URL
    }
  }
  const out: string[] = [];
  for (const m of html.matchAll(/<(?:a|area)\s([^>]*)>/gi)) {
    const attrs = m[1]!;
    if (/\brel\s*=\s*["'][^"']*\bnofollow\b/i.test(attrs)) continue;
    const h = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const href = (h?.[1] ?? h?.[2] ?? h?.[3] ?? '').replace(/&amp;/g, '&').trim();
    if (!href || /^(javascript|mailto|tel|data):/i.test(href)) continue;
    try {
      out.push(new URL(href, baseUrl).toString());
    } catch {
      // not a URL
    }
  }
  return out;
}

/** The pictures of an HTML page (`img` src, or the lazy-loading `data-src`), resolved against the page. */
export function pageImages(html: string, base: string): string[] {
  if (/<meta\s[^>]*name\s*=\s*["']?robots["']?[^>]*content\s*=\s*["'][^"']*noimageindex/i.test(html)) return [];
  const out: string[] = [];
  for (const m of html.replace(/<!--[\s\S]*?-->/g, ' ').matchAll(/<img\s([^>]*)>/gi)) {
    const attrs = m[1]!;
    const pick = (name: string) => {
      const h = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs);
      return (h?.[1] ?? h?.[2] ?? h?.[3] ?? '').replace(/&amp;/g, '&').trim();
    };
    const first = pick('src');
    const src = first && !/^data:/i.test(first) ? first : pick('data-src');
    if (!src || /^(data|javascript|blob):/i.test(src)) continue;
    try {
      const u = new URL(src, base).toString();
      if (!out.includes(u)) out.push(u);
    } catch {
      // not a URL
    }
  }
  return out;
}

const IMAGE_ACCEPT = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

const noIndex = (html: string) => /<meta\s[^>]*name\s*=\s*["']?robots["']?[^>]*content\s*=\s*["'][^"']*noindex/i.test(html);

/** The validators of a stored version (`etag:<v>`, `modified:<v>`, joined by a new line). */
export function parseValidators(version: string | null): { etag: string | null; modified: string | null } {
  const out = { etag: null as string | null, modified: null as string | null };
  for (const part of (version ?? '').split('\n')) {
    if (part.startsWith('etag:')) out.etag = part.slice(5);
    else if (part.startsWith('modified:')) out.modified = part.slice(9);
  }
  return out;
}

const versionOf = (etag: string | null, modified: string | null, body: Buffer): string => {
  const v = [etag ? `etag:${etag}` : '', modified ? `modified:${modified}` : ''].filter(Boolean).join('\n');
  return (v || `sha256:${createHash('sha256').update(body).digest('hex')}`).slice(0, 200);
};

/** A URL without its fragment, or null when it is not http(s). */
const normal = (u: string): string | null => {
  try {
    const x = new URL(u);
    if (x.protocol !== 'http:' && x.protocol !== 'https:') return null;
    x.hash = '';
    return x.toString();
  } catch {
    return null;
  }
};

async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<Buffer | null> {
  if (!body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of body as unknown as AsyncIterable<Uint8Array>) {
    n += c.length;
    if (n > max) return null;
    chunks.push(Buffer.from(c));
  }
  return Buffer.concat(chunks);
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason as Error);
    }, { once: true });
  });

/** Crawls one site. Throws when the start page's site cannot be reached at all (robots.txt unreachable). */
export async function crawl(o: CrawlOptions): Promise<CrawlResult> {
  const start = new URL(o.start);
  const origin = start.origin;
  const prefix = o.pathPrefix ? (o.pathPrefix.startsWith('/') ? o.pathPrefix : `/${o.pathPrefix}`) : '';
  const skipped: CrawlResult['skipped'] = [];
  const items: SourceItem[] = [];
  let unchanged = 0;
  const signal = o.signal;

  const get = async (url: string, headers: Record<string, string> = {}) =>
    fetch(url, { headers: { 'user-agent': `${CRAWLER_AGENT}/1.0`, accept: 'text/html, text/plain, text/markdown, application/pdf, application/json;q=0.8, */*;q=0.1', ...headers }, redirect: 'manual', dispatcher: o.dispatcher, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(o.timeoutMs)]) : AbortSignal.timeout(o.timeoutMs) });

  // robots.txt: missing (4xx) allows everything; a server error or no answer stops the crawl.
  let robots: Robots = { rules: [], sitemaps: [], delayMs: 0 };
  const r = await get(`${origin}/robots.txt`).catch((err: unknown) => {
    throw new Error(`${origin} could not be reached: ${((err as Error).cause as Error | undefined)?.message ?? (err as Error).message}`, { cause: err });
  });
  if (r.status >= 500) {
    await r.body?.cancel().catch(() => undefined);
    throw new Error(`${origin}/robots.txt answered ${r.status}; the site is treated as closed to crawling until it answers.`);
  }
  if (r.status === 200) robots = parseRobots(((await readCapped(r.body, 512 * 1024)) ?? Buffer.alloc(0)).toString('utf8'));
  else await r.body?.cancel().catch(() => undefined);
  const delay = Math.min(robots.delayMs, o.maxDelayMs ?? 5000);

  const inScope = (u: string): string | null => {
    const x = new URL(u);
    if (x.origin !== origin) return 'it is on another site';
    if (prefix && !x.pathname.startsWith(prefix)) return `it is outside ${prefix}`;
    if (!robotsAllows(robots, x.pathname + x.search)) return 'robots.txt disallows it';
    return null;
  };

  const queue: { url: string; depth: number }[] = [];
  const queued = new Set<string>();
  const push = (u: string, depth: number) => {
    const n = normal(u);
    if (!n || queued.has(n)) return;
    queued.add(n);
    const why = inScope(n);
    if (why) {
      skipped.push({ url: n, reason: `skipped: ${why}` });
      return;
    }
    queue.push({ url: n, depth });
  };
  push(start.toString(), 0);

  // Sitemaps (same site only; an index may name up to five more).
  if (o.sitemap && o.maxDepth >= 1) {
    const maps = robots.sitemaps.map(normal).filter((x): x is string => !!x && new URL(x).origin === origin);
    if (!maps.length) maps.push(`${origin}/sitemap.xml`);
    const read = new Set<string>();
    while (maps.length && read.size < 6) {
      const m = maps.shift()!;
      if (read.has(m)) continue;
      read.add(m);
      const res = await get(m).catch(() => null);
      if (!res || res.status !== 200) {
        await res?.body?.cancel().catch(() => undefined);
        continue;
      }
      const xml = ((await readCapped(res.body, 5 * 1024 * 1024)) ?? Buffer.alloc(0)).toString('utf8');
      const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((x) => x[1]!.replace(/&amp;/g, '&'));
      if (/<sitemapindex[\s>]/i.test(xml)) {
        for (const l of locs) if (normal(l) && new URL(l).origin === origin) maps.push(normal(l)!);
      } else for (const l of locs) push(l, 1);
    }
  }

  const pictures: string[] = [];
  let pages = 0;
  while (queue.length && pages < o.maxPages) {
    if (signal?.aborted) throw signal.reason as Error;
    const { url, depth } = queue.shift()!;
    if (pages > 0 && delay) await sleep(delay, signal);
    const prev = await o.previous(url);
    const v = parseValidators(prev?.version ?? null);
    let res;
    try {
      res = await get(url, { ...(v.etag ? { 'if-none-match': v.etag } : {}), ...(v.modified ? { 'if-modified-since': v.modified } : {}) });
    } catch (err) {
      const e = err as Error & { cause?: Error };
      skipped.push({ url, reason: `failed: ${(e.cause ?? e).message}`.slice(0, 300) });
      continue;
    }
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      await res.body?.cancel().catch(() => undefined);
      const loc = res.headers.get('location');
      if (loc) push(new URL(loc, url).toString(), depth);
      continue;
    }
    let body: Buffer;
    let type: string;
    let version: string;
    if (res.status === 304 && prev) {
      await res.body?.cancel().catch(() => undefined);
      body = await prev.body();
      version = prev.version!;
      type = '';
      unchanged++;
    } else if (res.status === 200) {
      const ct = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      const t = TYPES[ct];
      if (!t) {
        await res.body?.cancel().catch(() => undefined);
        skipped.push({ url, reason: `skipped: ${ct || 'no'} content type` });
        continue;
      }
      const data = await readCapped(res.body, o.maxBytes);
      if (!data) {
        skipped.push({ url, reason: `skipped: larger than ${o.maxBytes} bytes` });
        continue;
      }
      body = data;
      type = t;
      version = versionOf(res.headers.get('etag'), res.headers.get('last-modified'), data);
    } else {
      await res.body?.cancel().catch(() => undefined);
      skipped.push({ url, reason: `failed: HTTP ${res.status}` });
      continue;
    }
    pages++;
    const isHtml = type === 'text/html' || (!type && /^\s*(<!doctype html|<html[\s>])/i.test(body.subarray(0, 512).toString('utf8')));
    const html = isHtml ? body.toString('utf8') : '';
    if (isHtml && depth < o.maxDepth) for (const l of pageLinks(html, url)) push(l, depth + 1);
    if (isHtml && noIndex(html)) {
      skipped.push({ url, reason: 'skipped: the page asks not to be indexed' });
      continue;
    }
    const u = new URL(url);
    items.push({ key: url, name: `${u.host}${u.pathname}${u.search}`.slice(0, 300), version, size: body.length, read: async () => body, ...(type ? { type } : {}) });
    if (isHtml && o.media) for (const p of pageImages(html, url)) if (normal(p) && !pictures.includes(normal(p)!)) pictures.push(normal(p)!);
  }
  for (const q of queue) skipped.push({ url: q.url, reason: `skipped: the page limit (${o.maxPages}) was reached` });

  // The images of the indexed pages. Another host answers for itself: its robots.txt is read once per crawl.
  let images = 0;
  if (o.media) {
    const media = o.media;
    const rules = new Map<string, Robots | null>([[origin, robots]]);
    const robotsOf = async (site: string): Promise<Robots | null> => {
      if (rules.has(site)) return rules.get(site)!;
      let found: Robots | null = null;
      const res = await get(`${site}/robots.txt`).catch(() => null);
      if (res?.status === 200) found = parseRobots(((await readCapped(res.body, 512 * 1024)) ?? Buffer.alloc(0)).toString('utf8'));
      else {
        await res?.body?.cancel().catch(() => undefined);
        // Missing allows everything; an error, a redirect or no answer leaves the host alone.
        if (res && res.status >= 400 && res.status < 500) found = { rules: [], sitemaps: [], delayMs: 0 };
      }
      rules.set(site, found);
      return found;
    };
    const mayFetch = async (u: string): Promise<string | null> => {
      const x = new URL(u);
      if (x.origin !== origin && !media.allowed(x.hostname)) return 'the image is on a host that is not allowed';
      const r = await robotsOf(x.origin);
      if (!r) return `${x.origin}/robots.txt could not be read`;
      return robotsAllows(r, x.pathname + x.search) ? null : 'robots.txt disallows it';
    };
    let fetched = 0;
    for (const first of pictures) {
      if (signal?.aborted) throw signal.reason as Error;
      if (images >= media.max) {
        skipped.push({ url: first, reason: `skipped: the image limit (${media.max}) was reached` });
        continue;
      }
      let url = first;
      let res: Awaited<ReturnType<typeof get>> | null = null;
      let prev: CrawlPrevious | null = null;
      let why: string | null = null;
      try {
        // A redirect is followed (three at most) only to where an image may be fetched from.
        for (let hop = 0; hop < 4; hop++) {
          why = await mayFetch(url);
          if (why) break;
          if (fetched++ > 0 && delay) await sleep(delay, signal);
          // The stored copy is kept under the address the page names, so only that one is asked conditionally.
          prev = hop === 0 ? await o.previous(first) : null;
          const v = parseValidators(prev?.version ?? null);
          res = await get(url, { accept: 'image/png, image/jpeg, image/webp, image/gif', ...(v.etag ? { 'if-none-match': v.etag } : {}), ...(v.modified ? { 'if-modified-since': v.modified } : {}) });
          const loc = res.status >= 300 && res.status < 400 && res.status !== 304 ? res.headers.get('location') : null;
          if (!loc) break;
          await res.body?.cancel().catch(() => undefined);
          res = null;
          const next = normal(new URL(loc, url).toString());
          if (!next || hop === 3) {
            why = 'it redirects too often';
            break;
          }
          url = next;
        }
      } catch (err) {
        const e = err as Error & { cause?: Error };
        if (signal?.aborted) throw signal.reason as Error;
        skipped.push({ url, reason: `failed: ${(e.cause ?? e).message}`.slice(0, 300) });
        continue;
      }
      if (why || !res) {
        skipped.push({ url, reason: `skipped: ${why ?? 'it redirects nowhere'}` });
        continue;
      }
      let body: Buffer;
      let version: string;
      if (res.status === 304 && prev) {
        await res.body?.cancel().catch(() => undefined);
        body = await prev.body();
        version = prev.version!;
        unchanged++;
      } else if (res.status === 200) {
        const ct = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
        if (!IMAGE_ACCEPT.includes(ct)) {
          await res.body?.cancel().catch(() => undefined);
          skipped.push({ url, reason: `skipped: ${ct || 'no'} content type` });
          continue;
        }
        const data = await readCapped(res.body, o.maxBytes);
        if (!data) {
          skipped.push({ url, reason: `skipped: larger than ${o.maxBytes} bytes` });
          continue;
        }
        if (data.length < media.minBytes) {
          skipped.push({ url, reason: `skipped: an image under ${media.minBytes} bytes` });
          continue;
        }
        body = data;
        version = versionOf(res.headers.get('etag'), res.headers.get('last-modified'), data);
      } else {
        await res.body?.cancel().catch(() => undefined);
        skipped.push({ url, reason: `failed: HTTP ${res.status}` });
        continue;
      }
      // What the bytes are decides, not the header.
      const type = imageType(body);
      if (!type || !IMAGE_ACCEPT.includes(type)) {
        skipped.push({ url, reason: 'skipped: not a PNG, JPEG, WebP or GIF image' });
        continue;
      }
      images++;
      const u = new URL(first);
      items.push({ key: first, name: `${u.host}${u.pathname}${u.search}`.slice(0, 300), version, size: body.length, read: async () => body, type });
    }
  }
  return { items, skipped, unchanged, images };
}
