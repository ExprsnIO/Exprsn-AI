import { zip } from '../platform/zip-writer.js';
import type { Block, ExportDoc, Run } from './export-doc.js';
import { fitImage, runsText } from './export-doc.js';
import { toPdf } from './export-pdf.js';

/*
 * The chat export formats beyond Markdown and JSON, each laid out from one `ExportDoc` (`export-doc.ts`):
 *
 * - `html`: one self-contained page; styles inline, pictures as data: URLs, a CSP that allows nothing else, and every
 *   piece of conversation text escaped, so a message cannot add markup or scripts.
 * - `txt`: plain text, headings underlined, tables in columns; pictures are named, not embedded.
 * - `rtf`: RTF 1.x with Unicode escapes, tables and PNG or JPEG pictures.
 * - `docx`: Office Open XML (WordprocessingML) and `odt`: OpenDocument text, both ZIP archives of XML written by
 *   `platform/zip-writer.ts`, with the pictures as members.
 * - `pdf`: `export-pdf.ts`, PDF 1.4 with the standard fonts.
 */

export const EXPORT_FORMATS = ['markdown', 'json', 'docx', 'odt', 'pdf', 'html', 'txt', 'rtf'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const FORMAT_INFO: Record<ExportFormat, { ext: string; type: string; text: boolean }> = {
  markdown: { ext: 'md', type: 'text/markdown; charset=utf-8', text: true },
  json: { ext: 'json', type: 'application/json; charset=utf-8', text: true },
  txt: { ext: 'txt', type: 'text/plain; charset=utf-8', text: true },
  html: { ext: 'html', type: 'text/html; charset=utf-8', text: false },
  rtf: { ext: 'rtf', type: 'application/rtf', text: false },
  docx: { ext: 'docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', text: false },
  odt: { ext: 'odt', type: 'application/vnd.oasis.opendocument.text', text: false },
  pdf: { ext: 'pdf', type: 'application/pdf', text: false }
};

/** Lays the document out in one of the rich formats. */
export function renderDoc(format: Exclude<ExportFormat, 'markdown' | 'json'>, doc: ExportDoc): Buffer {
  switch (format) {
    case 'html':
      return Buffer.from(toHtml(doc), 'utf8');
    case 'txt':
      return Buffer.from(toText(doc), 'utf8');
    case 'rtf':
      return Buffer.from(toRtf(doc), 'latin1');
    case 'docx':
      return toDocx(doc);
    case 'odt':
      return toOdt(doc);
    case 'pdf':
      return toPdf(doc);
  }
}

// ---------- shared ----------

/** Characters XML 1.0 does not allow, and unpaired surrogates. */
// eslint-disable-next-line no-control-regex
const XML_BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export const xml = (s: string): string => s.replace(XML_BAD, '�').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** Consecutive list items, so formats with real lists can open and close them. */
type Chunk = { kind: 'items'; items: Extract<Block, { kind: 'item' }>[] } | { kind: 'one'; block: Exclude<Block, { kind: 'item' }> };
function chunks(blocks: Block[]): Chunk[] {
  const out: Chunk[] = [];
  for (const b of blocks) {
    const last = out[out.length - 1];
    if (b.kind === 'item') {
      if (last && last.kind === 'items') last.items.push(b);
      else out.push({ kind: 'items', items: [b] });
    } else out.push({ kind: 'one', block: b });
  }
  return out;
}

const bullet = (b: Extract<Block, { kind: 'item' }>) => (b.ordered ? `${b.n}.` : ['•', '◦', '▪', '–'][b.level] ?? '•');

// ---------- HTML ----------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function htmlRuns(runs: Run[]): string {
  return runs
    .map((r) => {
      let h = esc(r.text);
      if (r.code) h = `<code>${h}</code>`;
      if (r.italic) h = `<em>${h}</em>`;
      if (r.bold) h = `<strong>${h}</strong>`;
      return h;
    })
    .join('');
}

const HTML_STYLE = [
  ':root{color-scheme:light dark;--fg:#1d1d1f;--muted:#5f6368;--line:#d0d4da;--panel:#f4f5f7;--accent:#2f5bd3;--bg:#ffffff}',
  '@media (prefers-color-scheme:dark){:root{--fg:#e8e8ea;--muted:#a3a7ad;--line:#3a3d42;--panel:#1f2124;--accent:#8fb0ff;--bg:#141517}}',
  'html{background:var(--bg);color:var(--fg)}body{margin:0;font:16px/1.55 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif}',
  'article{max-width:760px;margin:0 auto;padding:32px 20px 64px}h1{font-size:28px;line-height:1.25;margin:0 0 12px}',
  'h2{font-size:19px;margin:32px 0 2px;padding-top:16px;border-top:1px solid var(--line)}h3{font-size:17px;margin:18px 0 6px}h4{font-size:15px;margin:14px 0 4px}',
  'dl.meta{display:grid;grid-template-columns:max-content 1fr;gap:2px 14px;margin:0 0 8px;font-size:14px}dl.meta dt{color:var(--muted)}dl.meta dd{margin:0;overflow-wrap:anywhere}',
  'p{margin:0 0 10px;overflow-wrap:anywhere}p.muted{color:var(--muted);font-size:13px}blockquote{margin:0 0 10px;padding:6px 12px;border-left:3px solid var(--accent);background:var(--panel)}',
  'pre{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:10px 12px;overflow:auto;font-size:13px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere}',
  'code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.92em}p code,li code,td code{background:var(--panel);padding:0 3px;border-radius:3px}',
  'table{border-collapse:collapse;margin:0 0 12px;font-size:14px;display:block;overflow-x:auto}th,td{border:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}th{background:var(--panel)}',
  'ul,ol{margin:0 0 10px;padding-left:24px}figure{margin:0 0 12px}figure img{max-width:100%;height:auto;border:1px solid var(--line);border-radius:6px}figcaption{font-size:12px;color:var(--muted)}',
  'hr{border:0;border-top:1px solid var(--line);margin:16px 0}footer{margin-top:40px;font-size:12px;color:var(--muted)}',
  '@media print{h2{break-after:avoid}pre,figure,table{break-inside:avoid}}'
].join('');

function htmlItems(items: Extract<Block, { kind: 'item' }>[]): string {
  let h = '';
  const open: ('ul' | 'ol')[] = [];
  for (const it of items) {
    const tag = it.ordered ? 'ol' : 'ul';
    while (open.length > it.level + 1) h += `</li></${open.pop()}>`;
    if (open.length === it.level + 1 && open[it.level] !== tag) h += `</li></${open.pop()}>`;
    if (open.length === it.level + 1) h += '</li>';
    while (open.length < it.level + 1) {
      h += `<${tag}>`;
      open.push(tag);
    }
    h += `<li${it.ordered ? ` value="${it.n}"` : ''}>${htmlRuns(it.runs)}`;
  }
  while (open.length) h += `</li></${open.pop()}>`;
  return h;
}

function htmlBlock(b: Exclude<Block, { kind: 'item' }>): string {
  switch (b.kind) {
    case 'heading':
      return `<h${b.level}>${esc(b.text)}</h${b.level}>`;
    case 'para':
      return b.tone === 'quote' ? `<blockquote>${htmlRuns(b.runs)}</blockquote>` : `<p${b.tone === 'muted' ? ' class="muted"' : ''}>${htmlRuns(b.runs)}</p>`;
    case 'code':
      return `<pre><code>${esc(b.text)}</code></pre>`;
    case 'table':
      return `<table>${b.header ? `<thead><tr>${b.header.map((c) => `<th>${htmlRuns(c)}</th>`).join('')}</tr></thead>` : ''}<tbody>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${htmlRuns(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    case 'image': {
      const { w, h } = fitImage(b, 720 * 0.75, 2000);
      return `<figure><img src="data:${b.type};base64,${b.data.toString('base64')}" width="${Math.round(w / 0.75)}" height="${Math.round(h / 0.75)}" alt="${esc(b.alt)}"><figcaption>${esc(b.alt)}</figcaption></figure>`;
    }
    case 'rule':
      return '<hr>';
  }
}

export function toHtml(doc: ExportDoc): string {
  const body = chunks(doc.blocks)
    .map((c) => (c.kind === 'items' ? htmlItems(c.items) : htmlBlock(c.block)))
    .join('\n');
  return (
    '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">` +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<meta name="generator" content="Exprsn-AI"><meta name="author" content="${esc(doc.author)}">` +
    `<title>${esc(doc.title)}</title><style>${HTML_STYLE}</style></head>\n<body><article>\n` +
    `<h1>${esc(doc.title)}</h1>\n<dl class="meta">${doc.meta.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>\n` +
    body +
    `\n<footer>Exported from Exprsn-AI. Label: ${esc(doc.label)}.</footer>\n</article></body></html>\n`
  );
}

// ---------- plain text ----------

function textTable(b: Extract<Block, { kind: 'table' }>): string[] {
  const rows = [...(b.header ? [b.header] : []), ...b.rows].map((r) => r.map((c) => runsText(c).replace(/\s+/g, ' ')));
  const n = Math.max(...rows.map((r) => r.length));
  const w = Array.from({ length: n }, (_, i) => Math.min(40, Math.max(3, ...rows.map((r) => (r[i] ?? '').length))));
  const line = (r: string[]) => `| ${w.map((x, i) => (r[i] ?? '').slice(0, 40).padEnd(x)).join(' | ')} |`;
  const out = rows.map(line);
  if (b.header) out.splice(1, 0, `|${w.map((x) => '-'.repeat(x + 2)).join('|')}|`);
  return out;
}

export function toText(doc: ExportDoc): string {
  const out: string[] = [doc.title, '='.repeat(Math.min(78, Math.max(3, doc.title.length))), ''];
  const keyW = Math.max(...doc.meta.map(([k]) => k.length));
  for (const [k, v] of doc.meta) out.push(`${`${k}:`.padEnd(keyW + 2)}${v}`);
  out.push('');
  let prev: Block | null = null;
  for (const b of doc.blocks) {
    if (prev?.kind === 'item' && b.kind !== 'item') out.push('');
    prev = b;
    switch (b.kind) {
      case 'heading':
        if (b.level <= 2) out.push('', b.text, (b.level === 1 ? '=' : '-').repeat(Math.min(78, Math.max(3, b.text.length))));
        else out.push(b.text.toUpperCase());
        break;
      case 'para':
        out.push(b.tone === 'quote' ? `> ${runsText(b.runs)}` : runsText(b.runs), '');
        break;
      case 'item':
        out.push(`${'  '.repeat(b.level + 1)}${b.ordered ? `${b.n}.` : '-'} ${runsText(b.runs)}`);
        break;
      case 'code':
        out.push(...b.text.split('\n').map((l) => `    ${l}`), '');
        break;
      case 'table':
        out.push(...textTable(b), '');
        break;
      case 'image':
        out.push(`[Picture: ${b.alt}, ${b.width} x ${b.height}, embedded in the other formats]`, '');
        break;
      case 'rule':
        out.push('-'.repeat(40), '');
        break;
    }
  }
  out.push('', `Exported from Exprsn-AI. Label: ${doc.label}.`, '');
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

// ---------- RTF ----------

/** RTF text: control characters escaped, anything outside ASCII as \uN with a "?" fallback. */
export function rtfText(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '\\' || ch === '{' || ch === '}') out += `\\${ch}`;
    else if (ch === '\n') out += '\\line ';
    else if (ch === '\t') out += '\\tab ';
    else if (c < 0x20) continue;
    else if (c < 0x80) out += ch;
    else if (c < 0x10000) out += `\\u${c > 0x7fff ? c - 0x10000 : c}?`;
    else {
      const v = c - 0x10000;
      const hi = 0xd800 + (v >> 10);
      const lo = 0xdc00 + (v & 0x3ff);
      out += `\\u${hi - 0x10000}?\\u${lo - 0x10000}?`;
    }
  }
  return out;
}

const rtfRuns = (runs: Run[]) =>
  runs
    .map((r) => {
      const ctl = `${r.bold ? '\\b' : ''}${r.italic ? '\\i' : ''}${r.code ? '\\f1\\fs18' : ''}`;
      return `{${ctl ? `${ctl} ` : ''}${rtfText(r.text)}}`;
    })
    .join('');

function rtfBlock(b: Block): string {
  const TW = 9638; // A4 text width with 2 cm margins, in twips
  switch (b.kind) {
    case 'heading': {
      const size = [0, 40, 30, 26, 24][b.level];
      return `{\\pard\\keepn\\sb${b.level <= 2 ? 360 : 200}\\sa80\\b\\fs${size} ${rtfText(b.text)}\\par}\n`;
    }
    case 'para':
      if (b.tone === 'quote') return `{\\pard\\li360\\sa120\\i ${rtfRuns(b.runs)}\\par}\n`;
      return `{\\pard\\sa120${b.tone === 'muted' ? '\\cf1\\fs18' : ''} ${rtfRuns(b.runs)}\\par}\n`;
    case 'item':
      return `{\\pard\\fi-280\\li${400 + b.level * 360}\\sa40 ${rtfText(bullet(b))}\\tab ${rtfRuns(b.runs)}\\par}\n`;
    case 'code':
      return `{\\pard\\sa120\\cbpat2\\f1\\fs18 ${rtfText(b.text)}\\par}\n`;
    case 'table': {
      const rows = [...(b.header ? [b.header] : []), ...b.rows];
      const n = Math.max(1, ...rows.map((r) => r.length));
      const cw = Math.floor(TW / n);
      const cellDefs = Array.from({ length: n }, (_, i) => `\\clbrdrt\\brdrs\\brdrw10\\clbrdrl\\brdrs\\brdrw10\\clbrdrb\\brdrs\\brdrw10\\clbrdrr\\brdrs\\brdrw10\\cellx${cw * (i + 1)}`).join('');
      return (
        rows
          .map((r, ri) => `\\trowd\\trgaph80${cellDefs}\n${Array.from({ length: n }, (_, i) => `\\pard\\intbl${ri === 0 && b.header ? '\\b' : ''} ${rtfRuns(r[i] ?? [{ text: '' }])}\\b0\\cell`).join('')}\\row\n`)
          .join('') + '\\pard\\sa120\\par\n'
      );
    }
    case 'image': {
      const { w, h } = fitImage(b, TW / 20, 600);
      return `{\\pard\\sa120{\\pict${b.type === 'image/png' ? '\\pngblip' : '\\jpegblip'}\\picw${b.width}\\pich${b.height}\\picwgoal${Math.round(w * 20)}\\pichgoal${Math.round(h * 20)}\n${b.data.toString('hex').replace(/(.{128})/g, '$1\n')}}\\par}\n{\\pard\\sa120\\cf1\\fs18 ${rtfText(b.alt)}\\par}\n`;
    }
    case 'rule':
      return '{\\pard\\brdrb\\brdrs\\brdrw10\\sa120\\par}\n';
  }
}

export function toRtf(doc: ExportDoc): string {
  return (
    '{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1' +
    '{\\fonttbl{\\f0\\fswiss\\fcharset0 Helvetica;}{\\f1\\fmodern\\fcharset0 Courier New;}}' +
    '{\\colortbl;\\red95\\green99\\blue104;\\red244\\green245\\blue247;}' +
    `{\\info{\\title ${rtfText(doc.title)}}{\\author ${rtfText(doc.author)}}}` +
    '\\paperw11906\\paperh16838\\margl1134\\margr1134\\margt1134\\margb1134\\f0\\fs22\n' +
    `{\\pard\\sa200\\b\\fs44 ${rtfText(doc.title)}\\par}\n` +
    doc.meta.map(([k, v]) => `{\\pard\\sa20\\fs20{\\cf1 ${rtfText(k)}:}\\tab ${rtfText(v)}\\par}\n`).join('') +
    doc.blocks.map(rtfBlock).join('') +
    `{\\pard\\sb400\\cf1\\fs18 Exported from Exprsn-AI. Label: ${rtfText(doc.label)}.\\par}\n}`
  );
}

// ---------- Office Open XML (docx) ----------

const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

function wRuns(runs: Run[]): string {
  return runs
    .map((r) => {
      const pr = `${r.bold ? '<w:b/>' : ''}${r.italic ? '<w:i/>' : ''}${r.code ? '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/><w:sz w:val="19"/>' : ''}`;
      return r.text
        .split('\n')
        .map((part, i) => `<w:r>${pr ? `<w:rPr>${pr}</w:rPr>` : ''}${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${xml(part)}</w:t></w:r>`)
        .join('');
    })
    .join('');
}

const wPara = (style: string | null, inner: string, extra = '') => `<w:p>${style || extra ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${extra}</w:pPr>` : ''}${inner}</w:p>`;

function toDocx(doc: ExportDoc): Buffer {
  const media: { name: string; data: Buffer; rid: string }[] = [];
  const TEXT_W = 9638; // twips
  const body: string[] = [];
  body.push(wPara('Title', wRuns([{ text: doc.title }])));
  for (const [k, v] of doc.meta) body.push(wPara('Meta', `<w:r><w:rPr><w:color w:val="5F6368"/></w:rPr><w:t xml:space="preserve">${xml(k)}: </w:t></w:r>${wRuns([{ text: v }])}`));
  for (const b of doc.blocks) {
    switch (b.kind) {
      case 'heading':
        body.push(wPara(`Heading${b.level - 1 || 1}`, wRuns([{ text: b.text }])));
        break;
      case 'para':
        body.push(wPara(b.tone === 'quote' ? 'Quote' : b.tone === 'muted' ? 'Muted' : null, wRuns(b.runs)));
        break;
      case 'item':
        body.push(wPara('ListParagraph', `<w:r><w:t xml:space="preserve">${xml(bullet(b))}</w:t></w:r><w:r><w:tab/></w:r>${wRuns(b.runs)}`, `<w:ind w:left="${720 + b.level * 360}" w:hanging="360"/>`));
        break;
      case 'code':
        body.push(wPara('Code', wRuns([{ text: b.text }])));
        break;
      case 'table': {
        const rows = [...(b.header ? [b.header] : []), ...b.rows];
        const n = Math.max(1, ...rows.map((r) => r.length));
        const cw = Math.floor(TEXT_W / n);
        const border = (s: string) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="BFC3C8"/>`;
        body.push(
          `<w:tbl><w:tblPr><w:tblW w:w="${TEXT_W}" w:type="dxa"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders><w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
            `<w:tblGrid>${Array.from({ length: n }, () => `<w:gridCol w:w="${cw}"/>`).join('')}</w:tblGrid>` +
            rows
              .map(
                (r, ri) =>
                  `<w:tr>${ri === 0 && b.header ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${Array.from({ length: n }, (_, i) => `<w:tc><w:tcPr><w:tcW w:w="${cw}" w:type="dxa"/>${ri === 0 && b.header ? '<w:shd w:val="clear" w:color="auto" w:fill="F4F5F7"/>' : ''}</w:tcPr>${wPara('TableText', wRuns((r[i] ?? [{ text: '' }]).map((x) => (ri === 0 && b.header ? { ...x, bold: true } : x))))}</w:tc>`).join('')}</w:tr>`
              )
              .join('') +
            '</w:tbl>'
        );
        body.push(wPara(null, ''));
        break;
      }
      case 'image': {
        const i = media.length + 1;
        const ext = b.type === 'image/png' ? 'png' : 'jpeg';
        media.push({ name: `image${i}.${ext}`, data: b.data, rid: `rIdImg${i}` });
        const { w, h } = fitImage(b, 451, 600);
        const cx = Math.round(w * 12700);
        const cy = Math.round(h * 12700);
        body.push(
          wPara(
            'Picture',
            `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${i}" name="Picture ${i}" descr="${xml(b.alt)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
              `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${i}" name="image${i}.${ext}" descr="${xml(b.alt)}"/><pic:cNvPicPr/></pic:nvPicPr>` +
              `<pic:blipFill><a:blip r:embed="rIdImg${i}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
          )
        );
        body.push(wPara('Muted', wRuns([{ text: b.alt }])));
        break;
      }
      case 'rule':
        body.push(wPara(null, '', '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BFC3C8"/></w:pBdr>'));
        break;
    }
  }
  body.push(wPara('Muted', wRuns([{ text: `Exported from Exprsn-AI. Label: ${doc.label}.` }])));
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W_NS}><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const style = (id: string, name: string, ppr: string, rpr: string, extra = '') => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/>${extra}<w:pPr>${ppr}</w:pPr><w:rPr>${rpr}</w:rPr></w:style>`;
  const styles =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri" w:eastAsia="Calibri"/><w:sz w:val="22"/><w:lang w:val="en-GB"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    style('Title', 'Title', '<w:spacing w:after="200"/>', '<w:b/><w:sz w:val="44"/>', '<w:qFormat/>') +
    style('Heading1', 'heading 1', '<w:keepNext/><w:spacing w:before="360" w:after="40"/><w:pBdr><w:top w:val="single" w:sz="4" w:space="6" w:color="D0D4DA"/></w:pBdr><w:outlineLvl w:val="0"/>', '<w:b/><w:sz w:val="30"/>', '<w:next w:val="Normal"/><w:qFormat/>') +
    style('Heading2', 'heading 2', '<w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="1"/>', '<w:b/><w:sz w:val="26"/>', '<w:next w:val="Normal"/><w:qFormat/>') +
    style('Heading3', 'heading 3', '<w:keepNext/><w:spacing w:before="200" w:after="60"/><w:outlineLvl w:val="2"/>', '<w:b/><w:sz w:val="24"/>', '<w:next w:val="Normal"/><w:qFormat/>') +
    style('Meta', 'Meta', '<w:spacing w:after="20"/>', '<w:sz w:val="20"/>') +
    style('Muted', 'Muted', '<w:spacing w:after="80"/>', '<w:color w:val="5F6368"/><w:sz w:val="18"/>') +
    style('Quote', 'Quote', '<w:ind w:left="360"/><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="2F5BD3"/></w:pBdr>', '<w:i/>') +
    style('Code', 'Code', '<w:spacing w:after="120" w:line="240" w:lineRule="auto"/><w:shd w:val="clear" w:color="auto" w:fill="F4F5F7"/>', '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/><w:sz w:val="18"/>') +
    style('ListParagraph', 'List Paragraph', '<w:spacing w:after="40"/>', '') +
    style('TableText', 'Table Text', '<w:spacing w:before="40" w:after="40"/>', '<w:sz w:val="20"/>') +
    style('Picture', 'Picture', '<w:keepNext/><w:spacing w:after="40"/>', '') +
    '</w:styles>';
  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    media.map((m) => `<Relationship Id="${m.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name}"/>`).join('') +
    '</Relationships>';
  const types =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    '</Types>';
  const pkgRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
    '</Relationships>';
  const created = doc.createdAt.replace(/\.\d+Z$/, 'Z');
  const core =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${xml(doc.title)}</dc:title><dc:creator>${xml(doc.author)}</dc:creator><cp:keywords>${xml(doc.label)}</cp:keywords><dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${created}</dcterms:modified></cp:coreProperties>`;
  const app = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Exprsn-AI</Application></Properties>';
  return zip([
    { name: '[Content_Types].xml', data: types },
    { name: '_rels/.rels', data: pkgRels },
    { name: 'docProps/core.xml', data: core },
    { name: 'docProps/app.xml', data: app },
    { name: 'word/document.xml', data: document },
    { name: 'word/styles.xml', data: styles },
    { name: 'word/_rels/document.xml.rels', data: rels },
    ...media.map((m) => ({ name: `word/media/${m.name}`, data: m.data, store: true }))
  ]);
}

// ---------- OpenDocument text (odt) ----------

const ODF_NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:loext="urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0" office:version="1.3"';

/** ODF text: runs of spaces as text:s, tabs and line breaks as elements (ODF collapses white space otherwise). */
function odfText(s: string): string {
  return xml(s)
    .replace(/\t/g, '<text:tab/>')
    .replace(/\n/g, '<text:line-break/>')
    .replace(/ {2,}/g, (m) => ` <text:s text:c="${m.length - 1}"/>`)
    .replace(/^ /, '<text:s/>');
}

function odfRuns(runs: Run[]): string {
  return runs
    .map((r) => {
      const name = `T${r.bold ? 'b' : ''}${r.italic ? 'i' : ''}${r.code ? 'c' : ''}`;
      return name === 'T' ? odfText(r.text) : `<text:span text:style-name="${name}">${odfText(r.text)}</text:span>`;
    })
    .join('');
}

function toOdt(doc: ExportDoc): Buffer {
  const pictures: { name: string; data: Buffer; type: string }[] = [];
  const body: string[] = [];
  let tables = 0;
  body.push(`<text:p text:style-name="Title">${odfText(doc.title)}</text:p>`);
  for (const [k, v] of doc.meta) body.push(`<text:p text:style-name="Meta"><text:span text:style-name="Tm">${odfText(k)}:</text:span> ${odfText(v)}</text:p>`);
  for (const b of doc.blocks) {
    switch (b.kind) {
      case 'heading':
        body.push(`<text:h text:style-name="Heading_20_${b.level - 1 || 1}" text:outline-level="${b.level - 1 || 1}">${odfText(b.text)}</text:h>`);
        break;
      case 'para':
        body.push(`<text:p text:style-name="${b.tone === 'quote' ? 'Quote' : b.tone === 'muted' ? 'Muted' : 'Text_20_body'}">${odfRuns(b.runs)}</text:p>`);
        break;
      case 'item':
        body.push(`<text:p text:style-name="Item${Math.min(3, b.level)}">${odfText(bullet(b))}<text:tab/>${odfRuns(b.runs)}</text:p>`);
        break;
      case 'code':
        body.push(`<text:p text:style-name="Code">${odfText(b.text)}</text:p>`);
        break;
      case 'table': {
        tables++;
        const rows = [...(b.header ? [b.header] : []), ...b.rows];
        const n = Math.max(1, ...rows.map((r) => r.length));
        const row = (r: Run[][], head: boolean) => `<table:table-row>${Array.from({ length: n }, (_, i) => `<table:table-cell table:style-name="Cell" office:value-type="string"><text:p text:style-name="${head ? 'TableHead' : 'TableText'}">${odfRuns(r[i] ?? [{ text: '' }])}</text:p></table:table-cell>`).join('')}</table:table-row>`;
        body.push(
          `<table:table table:name="Table${tables}" table:style-name="Tbl"><table:table-column table:number-columns-repeated="${n}"/>` +
            (b.header ? `<table:table-header-rows>${row(b.header, true)}</table:table-header-rows>` : '') +
            b.rows.map((r) => row(r, false)).join('') +
            '</table:table>'
        );
        break;
      }
      case 'image': {
        const i = pictures.length + 1;
        const name = `Pictures/image${i}.${b.type === 'image/png' ? 'png' : 'jpg'}`;
        pictures.push({ name, data: b.data, type: b.type });
        const { w, h } = fitImage(b, 451, 600);
        body.push(
          `<text:p text:style-name="Text_20_body"><draw:frame draw:name="Picture${i}" text:anchor-type="as-char" svg:width="${(w / 72).toFixed(3)}in" svg:height="${(h / 72).toFixed(3)}in" draw:z-index="0"><draw:image xlink:href="${name}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/><svg:desc>${xml(b.alt)}</svg:desc></draw:frame></text:p>`,
          `<text:p text:style-name="Muted">${odfText(b.alt)}</text:p>`
        );
        break;
      }
      case 'rule':
        body.push('<text:p text:style-name="Rule"/>');
        break;
    }
  }
  body.push(`<text:p text:style-name="Muted">${odfText(`Exported from Exprsn-AI. Label: ${doc.label}.`)}</text:p>`);
  const span = (name: string, props: string) => `<style:style style:name="${name}" style:family="text"><style:text-properties ${props}/></style:style>`;
  const mono = 'style:font-name="Courier New" fo:font-family="\'Courier New\'" fo:font-size="9.5pt"';
  const auto =
    span('Tb', 'fo:font-weight="bold"') +
    span('Ti', 'fo:font-style="italic"') +
    span('Tc', mono) +
    span('Tbi', 'fo:font-weight="bold" fo:font-style="italic"') +
    span('Tbc', `fo:font-weight="bold" ${mono}`) +
    span('Tic', `fo:font-style="italic" ${mono}`) +
    span('Tbic', `fo:font-weight="bold" fo:font-style="italic" ${mono}`) +
    span('Tm', 'fo:color="#5f6368"') +
    '<style:style style:name="Tbl" style:family="table"><style:table-properties style:width="17cm" table:align="left" fo:margin-bottom="0.2cm"/></style:style>' +
    '<style:style style:name="Cell" style:family="table-cell"><style:table-cell-properties fo:padding="0.08cm" fo:border="0.5pt solid #bfc3c8"/></style:style>';
  const content = `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-content ${ODF_NS}><office:font-face-decls><style:font-face style:name="Liberation Sans" svg:font-family="'Liberation Sans'" style:font-family-generic="swiss"/><style:font-face style:name="Courier New" svg:font-family="'Courier New'" style:font-family-generic="modern" style:font-pitch="fixed"/></office:font-face-decls><office:automatic-styles>${auto}</office:automatic-styles><office:body><office:text>${body.join('')}</office:text></office:body></office:document-content>`;
  const pstyle = (name: string, display: string, ppr: string, tpr: string, extra = '') => `<style:style style:name="${name}" style:display-name="${display}" style:family="paragraph" style:parent-style-name="Standard"${extra}><style:paragraph-properties ${ppr}/><style:text-properties ${tpr}/></style:style>`;
  const styles =
    `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-styles ${ODF_NS}><office:font-face-decls><style:font-face style:name="Liberation Sans" svg:font-family="'Liberation Sans'" style:font-family-generic="swiss"/><style:font-face style:name="Courier New" svg:font-family="'Courier New'" style:font-family-generic="modern" style:font-pitch="fixed"/></office:font-face-decls><office:styles>` +
    '<style:default-style style:family="paragraph"><style:paragraph-properties fo:margin-bottom="0.2cm"/><style:text-properties style:font-name="Liberation Sans" fo:font-size="11pt" fo:language="en" fo:country="GB"/></style:default-style>' +
    '<style:style style:name="Standard" style:family="paragraph" style:class="text"/>' +
    pstyle('Text_20_body', 'Text body', 'fo:margin-bottom="0.2cm" fo:line-height="130%"', '') +
    pstyle('Title', 'Title', 'fo:margin-bottom="0.35cm"', 'fo:font-size="22pt" fo:font-weight="bold"') +
    pstyle('Heading_20_1', 'Heading 1', 'fo:margin-top="0.6cm" fo:margin-bottom="0.05cm" fo:border-top="0.5pt solid #d0d4da" fo:padding-top="0.15cm" fo:keep-with-next="always"', 'fo:font-size="15pt" fo:font-weight="bold"', ' style:default-outline-level="1"') +
    pstyle('Heading_20_2', 'Heading 2', 'fo:margin-top="0.4cm" fo:margin-bottom="0.1cm" fo:keep-with-next="always"', 'fo:font-size="13pt" fo:font-weight="bold"', ' style:default-outline-level="2"') +
    pstyle('Heading_20_3', 'Heading 3', 'fo:margin-top="0.3cm" fo:margin-bottom="0.1cm" fo:keep-with-next="always"', 'fo:font-size="12pt" fo:font-weight="bold"', ' style:default-outline-level="3"') +
    pstyle('Meta', 'Meta', 'fo:margin-bottom="0.03cm"', 'fo:font-size="10pt"') +
    pstyle('Muted', 'Muted', 'fo:margin-bottom="0.15cm"', 'fo:font-size="9pt" fo:color="#5f6368"') +
    pstyle('Quote', 'Quote', 'fo:margin-left="0.6cm" fo:padding-left="0.2cm" fo:border-left="1.5pt solid #2f5bd3"', 'fo:font-style="italic"') +
    pstyle('Code', 'Code', 'fo:background-color="#f4f5f7" fo:padding="0.15cm" fo:margin-bottom="0.2cm"', `style:font-name="Courier New" fo:font-size="9pt"`) +
    [0, 1, 2, 3].map((l) => pstyle(`Item${l}`, `List item ${l + 1}`, `fo:margin-left="${(1.2 + l * 0.6).toFixed(1)}cm" fo:text-indent="-0.6cm" fo:margin-bottom="0.07cm"`, '')).join('') +
    pstyle('TableText', 'Table text', 'fo:margin-bottom="0cm"', 'fo:font-size="10pt"') +
    pstyle('TableHead', 'Table heading', 'fo:margin-bottom="0cm"', 'fo:font-size="10pt" fo:font-weight="bold"') +
    pstyle('Rule', 'Rule', 'fo:border-bottom="0.5pt solid #bfc3c8" fo:margin-bottom="0.3cm"', '') +
    '</office:styles><office:automatic-styles><style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm" fo:margin-top="2cm" fo:margin-bottom="2cm" fo:margin-left="2cm" fo:margin-right="2cm"/></style:page-layout></office:automatic-styles>' +
    '<office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1"/></office:master-styles></office:document-styles>';
  const meta = `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-meta ${ODF_NS}><office:meta><dc:title>${xml(doc.title)}</dc:title><meta:initial-creator>${xml(doc.author)}</meta:initial-creator><meta:creation-date>${doc.createdAt.replace(/Z$/, '')}</meta:creation-date><meta:keyword>${xml(doc.label)}</meta:keyword><meta:generator>Exprsn-AI</meta:generator></office:meta></office:document-meta>`;
  const manifest =
    '<?xml version="1.0" encoding="UTF-8"?>\n<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">' +
    '<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="application/vnd.oasis.opendocument.text"/>' +
    '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>' +
    pictures.map((p) => `<manifest:file-entry manifest:full-path="${p.name}" manifest:media-type="${p.type}"/>`).join('') +
    '</manifest:manifest>';
  return zip([
    { name: 'mimetype', data: 'application/vnd.oasis.opendocument.text', store: true },
    { name: 'META-INF/manifest.xml', data: manifest },
    { name: 'content.xml', data: content },
    { name: 'styles.xml', data: styles },
    { name: 'meta.xml', data: meta },
    ...pictures.map((p) => ({ name: p.name, data: p.data, store: true }))
  ]);
}
