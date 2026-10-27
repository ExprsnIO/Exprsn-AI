/**
 * Structure-aware chunking. The text is read as Markdown-style blocks: a heading starts a new section and always a
 * new chunk; paragraphs within a section are packed up to the target size; a paragraph longer than the target is
 * split at sentence ends, then at word boundaries. Consecutive chunks of one section share an overlap taken from the
 * end of the previous chunk. Sizes are in tokens, estimated as four characters each.
 */
export interface ChunkOptions {
  /** Target chunk size in tokens. */
  tokens: number;
  /** Tokens repeated from the end of the previous chunk of the same section. */
  overlap: number;
}

export interface TextChunk {
  text: string;
  /** The heading path, outermost first, joined with " > "; null before the first heading. */
  heading: string | null;
  tokens: number;
}

export const DEFAULT_CHUNKING: ChunkOptions = { tokens: 600, overlap: 80 };

export const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

interface Section {
  heading: string | null;
  paragraphs: string[];
}

function sections(text: string): Section[] {
  const out: Section[] = [];
  const stack: string[] = [];
  let cur: Section = { heading: null, paragraphs: [] };
  let para: string[] = [];
  const endPara = () => {
    const p = para.join('\n').trim();
    if (p) cur.paragraphs.push(p);
    para = [];
  };
  let fence = false;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = fence ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      endPara();
      if (cur.paragraphs.length || cur.heading) out.push(cur);
      const level = h[1]!.length;
      stack.length = level - 1;
      stack[level - 1] = h[2]!.trim();
      cur = { heading: stack.filter(Boolean).join(' > '), paragraphs: [] };
    } else if (!fence && !line.trim()) endPara();
    else para.push(line);
  }
  endPara();
  if (cur.paragraphs.length) out.push(cur);
  return out.filter((s) => s.paragraphs.length);
}

/** Splits text longer than `max` characters at sentence ends, then at spaces, then hard. */
function split(p: string, max: number): string[] {
  if (p.length <= max) return [p];
  const sentences = p.match(/[^.!?\n]+(?:[.!?]+|\n|$)\s*/g) ?? [p];
  const out: string[] = [];
  let cur = '';
  for (const s of sentences) {
    if (s.length > max) {
      if (cur) out.push(cur.trim());
      cur = '';
      for (let rest = s; rest.length; ) {
        let cut = rest.length <= max ? rest.length : rest.lastIndexOf(' ', max);
        if (cut <= max / 2) cut = Math.min(max, rest.length);
        out.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut);
      }
    } else if ((cur + s).length > max) {
      out.push(cur.trim());
      cur = s;
    } else cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

/** The last `chars` characters of a chunk, starting at a word boundary. */
function tail(text: string, chars: number): string {
  if (chars <= 0 || text.length <= chars) return chars <= 0 ? '' : text;
  const t = text.slice(text.length - chars);
  const sp = t.indexOf(' ');
  return (sp >= 0 && sp < chars / 2 ? t.slice(sp + 1) : t).trim();
}

export function chunkText(text: string, opts: ChunkOptions = DEFAULT_CHUNKING): TextChunk[] {
  const max = Math.max(200, opts.tokens * 4);
  const overlap = Math.min(Math.max(0, opts.overlap * 4), Math.floor(max / 2));
  const out: TextChunk[] = [];
  for (const sec of sections(text)) {
    const pieces = sec.paragraphs.flatMap((p) => split(p, max - overlap));
    let cur = '';
    let prev = '';
    const emit = () => {
      if (!cur.trim()) return;
      const body = (prev ? tail(prev, overlap) + '\n\n' : '') + cur.trim();
      out.push({ text: body, heading: sec.heading, tokens: estimateTokens(body) });
      prev = cur.trim();
      cur = '';
    };
    for (const piece of pieces) {
      if (cur && cur.length + piece.length + 2 > max - overlap) emit();
      cur += (cur ? '\n\n' : '') + piece;
    }
    emit();
  }
  return out;
}
