import { markdownToDoc } from '../files/documents/markdown.js';
import type { Block, ListItem, Run } from '../files/documents/model.js';
import { referenceSlug } from '../knowledge/revisions.js';

/*
 * 2.0.x Docs portal: a reference's Markdown as HTML the console can set with innerHTML.
 *
 * The Markdown is parsed by the file editor's parser (`markdownToDoc`), which keeps HTML as text, and every piece of
 * text is escaped here, so nothing in a page can become markup or script. Links keep http, https and mailto (the
 * parser's `safeHref`); links to other pages (`[[slug]]`, `[[slug|text]]`, `[[slug#part]]` and Markdown links whose
 * target is a bare slug, as `knowledge/tree.ts` reads them) are rewritten before parsing to a reserved `.invalid`
 * host and turned into the portal's own links afterwards, marked when the target is not a page the reader can see.
 * Headings get stable ids for the table of contents. YAML front matter (the system docs carry it) is left out.
 */

const INTERNAL = 'https://exprsn-docs.invalid/';

export interface TocEntry {
  level: number;
  id: string;
  text: string;
}

export interface RenderOptions {
  /** The portal link of a page by slug, and whether the reader can open it. */
  page(slug: string, part: string | null): { href: string; exists: boolean; kb?: string; slug?: string };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Front matter (`---` … `---` at the very top) is metadata, not part of the page. */
export function stripFrontMatter(md: string): { body: string; meta: Record<string, string> } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (!m) return { body: md, meta: {} };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, '');
  }
  return { body: md.slice(m[0].length), meta };
}

/** Page links in their parsable form: `[[slug|text]]` and bare-slug Markdown links become reserved-host links. */
function rewriteLinks(md: string): string {
  const target = (raw: string, part?: string) => {
    try {
      return `${INTERNAL}${encodeURIComponent(referenceSlug(raw))}${part ? `#${encodeURIComponent(part)}` : ''}`;
    } catch {
      return null;
    }
  };
  let out = md.replace(/\[\[([^\]|#\n]{1,200})(?:#([^\]|\n]{1,200}))?(?:\|([^\]\n]{1,300}))?\]\]/g, (whole, slug: string, part?: string, text?: string) => {
    const href = target(slug.trim(), part?.trim());
    return href ? `[${(text ?? slug).trim().replace(/[[\]]/g, '')}](${href})` : whole;
  });
  out = out.replace(/\]\(\s*<?([^)\s>]{1,240})>?((?:\s+"[^"\n]*")?)\s*\)/g, (whole, t: string, title: string) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('/') || t.startsWith('#') || t.includes('@') || t.startsWith('..')) return whole;
    const [path, part] = t.replace(/^\.\//, '').split('#', 2) as [string, string | undefined];
    const href = target(path.replace(/\.md$/i, ''), part);
    return href ? `](${href}${title})` : whole;
  });
  return out;
}

class Renderer {
  readonly toc: TocEntry[] = [];
  private readonly ids = new Set<string>();
  constructor(private readonly o: RenderOptions) {}

  private slugId(text: string): string {
    const base = text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'section';
    let id = base;
    for (let i = 2; this.ids.has(id); i++) id = `${base}-${i}`;
    this.ids.add(id);
    return id;
  }

  private link(href: string, inner: string): string {
    if (href.startsWith(INTERNAL)) {
      const rest = href.slice(INTERNAL.length);
      const [s, p] = rest.split('#', 2) as [string, string | undefined];
      const slug = decodeURIComponent(s);
      const part = p ? decodeURIComponent(p) : null;
      const l = this.o.page(slug, part);
      return `<a href="${esc(l.href)}" data-docs-page="${esc(l.slug ?? slug)}"${l.kb ? ` data-docs-kb="${esc(l.kb)}"` : ''}${part ? ` data-docs-part="${esc(part)}"` : ''}${l.exists ? '' : ' data-docs-missing="1" class="docs-missing"'}>${inner}</a>`;
    }
    return `<a href="${esc(href)}" rel="noopener noreferrer" target="_blank">${inner}</a>`;
  }

  runs(runs: Run[]): string {
    return runs
      .map((r) => {
        let h = esc(r.text).replace(/\n/g, '<br>');
        if (r.code) h = `<code>${h}</code>`;
        if (r.b) h = `<strong>${h}</strong>`;
        if (r.i) h = `<em>${h}</em>`;
        if (r.s) h = `<s>${h}</s>`;
        if (r.u) h = `<u>${h}</u>`;
        if (r.href) h = this.link(r.href, h);
        return h;
      })
      .join('');
  }

  private plain(runs: Run[]): string {
    return runs.map((r) => r.text).join('');
  }

  private list(ordered: boolean, items: ListItem[], start?: number): string {
    const tag = ordered ? 'ol' : 'ul';
    const tasks = items.some((i) => i.checked !== undefined);
    return `<${tag}${ordered && start && start !== 1 ? ` start="${start}"` : ''}${tasks ? ' class="docs-tasks"' : ''}>${items
      .map((i) => `<li>${i.checked !== undefined ? `<input type="checkbox" disabled${i.checked ? ' checked' : ''} aria-label="${i.checked ? 'Done' : 'Not done'}"> ` : ''}${this.runs(i.runs)}${i.children ? this.list(i.children.ordered, i.children.items) : ''}</li>`)
      .join('')}</${tag}>`;
  }

  block(b: Block): string {
    switch (b.type) {
      case 'heading': {
        const text = this.plain(b.runs);
        const id = this.slugId(text);
        this.toc.push({ level: b.level, id, text });
        return `<h${b.level} id="${id}">${this.runs(b.runs)}</h${b.level}>`;
      }
      case 'paragraph':
        return `<p>${this.runs(b.runs)}</p>`;
      case 'list':
        return this.list(b.ordered, b.items, b.start);
      case 'quote':
        return `<blockquote><p>${this.runs(b.runs)}</p></blockquote>`;
      case 'code':
        return `<pre class="docs-code"${b.lang ? ` data-lang="${esc(b.lang)}"` : ''}><code>${esc(b.text)}</code></pre>`;
      case 'table': {
        const [head, ...body] = b.header ? b.rows : [null, ...b.rows];
        const row = (cells: Run[][], tag: 'th' | 'td') => `<tr>${cells.map((c) => `<${tag}${tag === 'th' ? ' scope="col"' : ''}>${this.runs(c)}</${tag}>`).join('')}</tr>`;
        return `<div class="docs-table"><table>${head ? `<thead>${row(head, 'th')}</thead>` : ''}<tbody>${body.map((r) => row(r ?? [], 'td')).join('')}</tbody></table></div>`;
      }
      case 'hr':
        return '<hr>';
      default:
        return '';
    }
  }
}

/** A page's Markdown as safe HTML, its table of contents and its front matter. */
export function renderMarkdown(md: string, o: RenderOptions): { html: string; toc: TocEntry[]; meta: Record<string, string> } {
  const { body, meta } = stripFrontMatter(md);
  const doc = markdownToDoc(rewriteLinks(body));
  const r = new Renderer(o);
  const html = doc.blocks.map((b) => r.block(b)).join('\n');
  return { html, toc: r.toc, meta };
}

/** A library document's sections (extracted text, not Markdown) as safe HTML with its headings in the contents. */
export function renderSections(sections: { heading: string | null; text?: string; withheld?: string }[]): { html: string; toc: TocEntry[] } {
  const r = new Renderer({ page: () => ({ href: '#', exists: false }) });
  const parts: string[] = [];
  let last: string | null = null;
  for (const s of sections) {
    if (s.heading && s.heading !== last) {
      parts.push(r.block({ type: 'heading', level: 2, runs: [{ text: s.heading }] }));
      last = s.heading;
    }
    if (s.withheld) parts.push(`<p class="docs-withheld">${esc(s.withheld)}</p>`);
    else if (s.text) for (const para of s.text.split(/\n{2,}/)) if (para.trim()) parts.push(`<p>${esc(para.trim()).replace(/\n/g, '<br>')}</p>`);
  }
  return { html: parts.join('\n'), toc: r.toc };
}
