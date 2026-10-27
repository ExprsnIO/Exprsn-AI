import { describe, expect, it } from 'vitest';
import { docToMarkdown, docToText, markdownToDoc, validateDoc } from '../src/files/documents/markdown.js';
import { DOC_LIMITS, DocumentError, MIME, type RichDoc } from '../src/files/documents/model.js';
import { docToOdt, odtToDoc, parseXml } from '../src/files/documents/odt.js';
import { zip } from '../src/platform/zip-writer.js';

/*
 * Editable documents (2.0.0): Markdown and OpenDocument text to and from the RichDoc model.
 */

const SAMPLE: RichDoc = {
  blocks: [
    { type: 'heading', level: 1, runs: [{ text: 'Quarterly plan' }] },
    { type: 'paragraph', runs: [{ text: 'Plain, ' }, { text: 'bold', b: true }, { text: ', ' }, { text: 'italic', i: true }, { text: ', ' }, { text: 'both', b: true, i: true }, { text: ', ' }, { text: 'gone', s: true }, { text: ' and ' }, { text: 'code', code: true }, { text: '.' }] },
    { type: 'paragraph', runs: [{ text: 'See ' }, { text: 'the site', href: 'https://example.com/a?b=1' }, { text: ' or ' }, { text: 'mail', href: 'mailto:ann@example.com' }, { text: '.' }] },
    { type: 'paragraph', runs: [{ text: 'Stars * and _under_ and [brackets] and 1. not a list' }] },
    { type: 'list', ordered: false, items: [{ runs: [{ text: 'One' }] }, { runs: [{ text: 'Two' }], children: { ordered: true, items: [{ runs: [{ text: 'Two A' }] }, { runs: [{ text: 'Two B' }] }] } }] },
    { type: 'list', ordered: true, start: 3, items: [{ runs: [{ text: 'Third' }] }, { runs: [{ text: 'Fourth' }] }] },
    { type: 'list', ordered: false, items: [{ runs: [{ text: 'Done' }], checked: true }, { runs: [{ text: 'Open' }], checked: false }] },
    { type: 'quote', runs: [{ text: 'Quoted ' }, { text: 'words', i: true }] },
    { type: 'code', lang: 'ts', text: 'const a = `x`;\n\nconsole.log(a);' },
    { type: 'table', header: true, rows: [[[{ text: 'Name' }], [{ text: 'Value' }]], [[{ text: 'a | b' }], [{ text: '1', b: true }]]] },
    { type: 'hr' },
    { type: 'heading', level: 3, runs: [{ text: 'End' }] }
  ]
};

describe('Markdown to RichDoc', () => {
  it('reads headings, emphasis, links, lists, tasks, quotes, code, tables and rules', () => {
    const md = [
      '# Title #',
      '',
      'Setext two',
      '----------',
      '',
      'Text with **bold**, __bold too__, *it*, _it2_, ~~strike~~, `co de`, [link](https://x.org/p "title") and <https://auto.example>.',
      'Soft break continues.  ',
      'Hard break before this\\',
      'and this.',
      '',
      '- a',
      '  - nested',
      '- [x] task done',
      '- [ ] task open',
      '',
      '7. seven',
      '8. eight',
      '',
      '> quoted *line*',
      '>',
      '> second para',
      '',
      '```js',
      'let x = 1;',
      '```',
      '',
      '    indented code',
      '',
      '| A | B |',
      '|---|:-:|',
      '| 1 | 2 \\| 3 |',
      '',
      '***',
      '',
      '![alt text](https://img.example/a.png) \\*not em\\* &amp; &#65;'
    ].join('\n');
    const d = markdownToDoc(md);
    expect(d.blocks[0]).toEqual({ type: 'heading', level: 1, runs: [{ text: 'Title' }] });
    expect(d.blocks[1]).toEqual({ type: 'heading', level: 2, runs: [{ text: 'Setext two' }] });
    const p = d.blocks[2];
    expect(p?.type).toBe('paragraph');
    const runs = p?.type === 'paragraph' ? p.runs : [];
    expect(runs).toContainEqual({ text: 'bold', b: true });
    expect(runs).toContainEqual({ text: 'bold too', b: true });
    expect(runs).toContainEqual({ text: 'it', i: true });
    expect(runs).toContainEqual({ text: 'it2', i: true });
    expect(runs).toContainEqual({ text: 'strike', s: true });
    expect(runs).toContainEqual({ text: 'co de', code: true });
    expect(runs).toContainEqual({ text: 'link', href: 'https://x.org/p' });
    expect(runs).toContainEqual({ text: 'https://auto.example', href: 'https://auto.example' });
    const text = runs.map((r) => r.text).join('');
    expect(text).toContain('. Soft break continues.\nHard break before this\nand this.');
    expect(d.blocks[3]).toEqual({ type: 'list', ordered: false, items: [{ runs: [{ text: 'a' }], children: { ordered: false, items: [{ runs: [{ text: 'nested' }] }] } }, { runs: [{ text: 'task done' }], checked: true }, { runs: [{ text: 'task open' }], checked: false }] });
    expect(d.blocks[4]).toEqual({ type: 'list', ordered: true, start: 7, items: [{ runs: [{ text: 'seven' }] }, { runs: [{ text: 'eight' }] }] });
    expect(d.blocks[5]).toEqual({ type: 'quote', runs: [{ text: 'quoted ' }, { text: 'line', i: true }, { text: '\nsecond para' }] });
    expect(d.blocks[6]).toEqual({ type: 'code', lang: 'js', text: 'let x = 1;' });
    expect(d.blocks[7]).toEqual({ type: 'code', text: 'indented code' });
    expect(d.blocks[8]).toEqual({ type: 'table', header: true, rows: [[[{ text: 'A' }], [{ text: 'B' }]], [[{ text: '1' }], [{ text: '2 | 3' }]]] });
    expect(d.blocks[9]).toEqual({ type: 'hr' });
    expect(d.blocks[10]).toEqual({ type: 'paragraph', runs: [{ text: 'alt text', href: 'https://img.example/a.png' }, { text: ' *not em* & A' }] });
  });

  it('follows CommonMark for nested and adjacent emphasis', () => {
    expect(markdownToDoc('***x***').blocks[0]).toEqual({ type: 'paragraph', runs: [{ text: 'x', b: true, i: true }] });
    expect(markdownToDoc('**a*b***').blocks[0]).toEqual({ type: 'paragraph', runs: [{ text: 'a', b: true }, { text: 'b', b: true, i: true }] });
    expect(markdownToDoc('*a***b**').blocks[0]).toEqual({ type: 'paragraph', runs: [{ text: 'a', i: true }, { text: 'b', b: true }] });
    expect(markdownToDoc('snake_case_name and 2 * 3 * 4').blocks[0]).toEqual({ type: 'paragraph', runs: [{ text: 'snake_case_name and 2 * 3 * 4' }] });
    expect(markdownToDoc('**[bold link](https://a.b)**').blocks[0]).toEqual({ type: 'paragraph', runs: [{ text: 'bold link', b: true, href: 'https://a.b' }] });
  });

  it('drops unsafe links to plain text and keeps HTML as text', () => {
    const d = markdownToDoc('[click](javascript:alert(1)) <script>alert(1)</script> <b>x</b>\n\n<div onclick="x">block</div>');
    expect(d.blocks[0]).toEqual({ type: 'paragraph', runs: [{ text: 'click <script>alert(1)</script> <b>x</b>' }] });
    expect(d.blocks[1]).toEqual({ type: 'paragraph', runs: [{ text: '<div onclick="x">block</div>' }] });
    expect(JSON.stringify(d)).not.toContain('javascript');
  });

  it('round-trips a document through Markdown', () => {
    const md = docToMarkdown(SAMPLE);
    expect(markdownToDoc(md)).toEqual(SAMPLE);
    expect(docToMarkdown(markdownToDoc(md))).toBe(md);
    // Text that looks like Markdown stays text.
    const tricky: RichDoc = { blocks: [{ type: 'paragraph', runs: [{ text: '# not a heading\n- not a list\n> not a quote\n1) nor this\n    nor code &amp; <x> `tick` ~~no~~' }] }] };
    expect(markdownToDoc(docToMarkdown(tricky))).toEqual(tricky);
  });

  it('keeps consecutive lists apart and code with backtick fences intact', () => {
    const d: RichDoc = {
      blocks: [
        { type: 'list', ordered: false, items: [{ runs: [{ text: 'a' }] }] },
        { type: 'list', ordered: false, items: [{ runs: [{ text: 'b' }] }] },
        { type: 'list', ordered: true, items: [{ runs: [{ text: 'c' }] }] },
        { type: 'list', ordered: true, items: [{ runs: [{ text: 'd' }] }] },
        { type: 'code', text: 'has ``` inside\nand ```` too' }
      ]
    };
    expect(markdownToDoc(docToMarkdown(d))).toEqual(d);
  });

  it('enforces the limits', () => {
    expect(() => markdownToDoc('x'.repeat(DOC_LIMITS.maxChars + 1))).toThrow(DocumentError);
    expect(() => markdownToDoc(Array.from({ length: DOC_LIMITS.maxBlocks + 1 }, (_, i) => `p${i}`).join('\n\n'))).toThrow(DocumentError);
  });

  it('writes plain text', () => {
    const t = docToText(SAMPLE);
    expect(t).toContain('Quarterly plan');
    expect(t).toContain('- [x] Done');
    expect(t).toContain('  1. Two A');
    expect(t).toContain('Name\tValue');
  });
});

describe('validateDoc', () => {
  it('returns a clean copy of a valid document', () => {
    const out = validateDoc({ blocks: [{ type: 'paragraph', runs: [{ text: 'x', b: true, i: false, href: 'javascript:alert(1)', extra: 1 }] }, { type: 'code', text: 'y', lang: 'bad lang!' }] });
    expect(out).toEqual({ blocks: [{ type: 'paragraph', runs: [{ text: 'x', b: true }] }, { type: 'code', text: 'y' }] });
    expect(validateDoc(SAMPLE)).toEqual(SAMPLE);
  });

  it('refuses malformed documents', () => {
    const bad: unknown[] = [
      null,
      { blocks: 'x' },
      { blocks: [{ type: 'heading', level: 7, runs: [] }] },
      { blocks: [{ type: 'paragraph', runs: [{ text: 1 }] }] },
      { blocks: [{ type: 'paragraph', runs: [{ text: 'x', b: 'yes' }] }] },
      { blocks: [{ type: 'list', ordered: 'no', items: [] }] },
      { blocks: [{ type: 'table', header: true, rows: [['x']] }] },
      { blocks: [{ type: 'image' }] },
      { blocks: [{ type: 'paragraph', runs: [{ text: 'x'.repeat(DOC_LIMITS.maxChars + 1) }] }] }
    ];
    for (const b of bad) expect(() => validateDoc(b), JSON.stringify(b)?.slice(0, 80)).toThrow(DocumentError);
  });
});

/** The members of a zip as the central directory lists them, with each local header's method. */
function members(buf: Buffer): { name: string; method: number; offset: number }[] {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(p + 28);
    const offset = buf.readUInt32LE(p + 42);
    out.push({ name: buf.subarray(p + 46, p + 46 + nameLen).toString('utf8'), method: buf.readUInt16LE(offset + 8), offset });
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}

const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink"';

const odt = (content: string, extra: { name: string; data: string }[] = []) => zip([{ name: 'mimetype', data: MIME.odt, store: true }, { name: 'content.xml', data: content }, ...extra]);

describe('OpenDocument text', () => {
  it('writes a package with the mimetype first and stored', () => {
    const buf = docToOdt(SAMPLE, { title: 'Plan' });
    const m = members(buf);
    expect(m[0]).toEqual({ name: 'mimetype', method: 0, offset: 0 });
    expect(buf.subarray(30 + 8, 30 + 8 + MIME.odt.length).toString('latin1')).toBe(MIME.odt);
    expect(m.map((x) => x.name)).toEqual(['mimetype', 'content.xml', 'styles.xml', 'meta.xml', 'META-INF/manifest.xml']);
  });

  it('round-trips the supported features', () => {
    const { doc, notes } = odtToDoc(docToOdt(SAMPLE));
    expect(notes).toEqual([]);
    // A code block's language has no place in ODF.
    const expected: RichDoc = { blocks: SAMPLE.blocks.map((b) => (b.type === 'code' ? { type: 'code', text: b.text } : b)) };
    expect(doc).toEqual(expected);
  });

  it('keeps white space exactly', () => {
    const d: RichDoc = { blocks: [{ type: 'paragraph', runs: [{ text: ' lead  two   three\tTab\nline ' }, { text: ' x ', u: true }] }, { type: 'code', text: '  indented\n\n    more' }] };
    expect(odtToDoc(docToOdt(d)).doc).toEqual(d);
  });

  it('reads styles, spans, lists, tables and reports what it leaves out', () => {
    const styles = `<?xml version="1.0"?><office:document-styles ${NS}><office:font-face-decls><style:font-face style:name="Fira" style:font-pitch="fixed"/></office:font-face-decls><office:styles><style:style style:name="Quotations" style:family="paragraph"/><text:list-style style:name="Num"><text:list-level-style-number text:level="1"/><text:list-level-style-bullet text:level="2"/></text:list-style></office:styles></office:document-styles>`;
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${NS}>
  <office:automatic-styles>
    <style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>
    <style:style style:name="T2" style:family="text" style:parent-style-name="T1"><style:text-properties fo:font-style="italic" style:text-underline-style="solid"/></style:style>
    <style:style style:name="T3" style:family="text"><style:text-properties style:font-name="Fira"/></style:style>
    <style:style style:name="T4" style:family="text"><style:text-properties style:text-line-through-style="solid"/></style:style>
    <style:style style:name="P1" style:family="paragraph" style:parent-style-name="Quotations"/>
  </office:automatic-styles>
  <office:body><office:text>
    <text:sequence-decls/>
    <text:h text:outline-level="2">Head &amp; <text:span text:style-name="T1">bold</text:span></text:h>
    <text:p>  Some   <text:span text:style-name="T2">styled</text:span> <text:span text:style-name="T3">mono</text:span><text:s text:c="2"/><text:span text:style-name="T4">gone</text:span><text:tab/>x<text:line-break/>y <text:a xlink:href="https://ok.example">ok</text:a> <text:a xlink:href="javascript:bad()">bad</text:a><text:note><text:note-body><text:p>foot</text:p></text:note-body></text:note><draw:frame><draw:image/></draw:frame></text:p>
    <text:p text:style-name="P1">quote one</text:p>
    <text:p text:style-name="P1">quote two</text:p>
    <text:list text:style-name="Num">
      <text:list-item text:start-value="4"><text:p>four</text:p><text:list><text:list-item><text:p>bullet</text:p></text:list-item></text:list></text:list-item>
    </text:list>
    <text:section><text:p>in section</text:p></text:section>
    <table:table><table:table-column table:number-columns-repeated="3"/>
      <table:table-header-rows><table:table-row><table:table-cell><text:p>H1</text:p></table:table-cell><table:table-cell table:number-columns-spanned="2"><text:p>H2</text:p></table:table-cell><table:covered-table-cell/></table:table-row></table:table-header-rows>
      <table:table-row><table:table-cell><text:p>a</text:p><text:p>b</text:p></table:table-cell><table:table-cell table:number-columns-repeated="2"/></table:table-row>
      <table:table-row table:number-rows-repeated="500"><table:table-cell table:number-columns-repeated="1000"/></table:table-row>
    </table:table>
    <draw:frame><draw:text-box><text:p>boxed</text:p></draw:text-box></draw:frame>
  </office:text></office:body>
</office:document-content>`;
    const { doc, notes } = odtToDoc(odt(content, [{ name: 'styles.xml', data: styles }]));
    expect(doc.blocks[0]).toEqual({ type: 'heading', level: 2, runs: [{ text: 'Head & ' }, { text: 'bold', b: true }] });
    expect(doc.blocks[1]).toEqual({
      type: 'paragraph',
      runs: [{ text: 'Some ' }, { text: 'styled', b: true, i: true, u: true }, { text: ' ' }, { text: 'mono', code: true }, { text: '  ' }, { text: 'gone', s: true }, { text: '\tx\ny ' }, { text: 'ok', href: 'https://ok.example' }, { text: ' bad' }]
    });
    expect(doc.blocks[2]).toEqual({ type: 'quote', runs: [{ text: 'quote one\nquote two' }] });
    expect(doc.blocks[3]).toEqual({ type: 'list', ordered: true, start: 4, items: [{ runs: [{ text: 'four' }], children: { ordered: false, items: [{ runs: [{ text: 'bullet' }] }] } }] });
    expect(doc.blocks[4]).toEqual({ type: 'paragraph', runs: [{ text: 'in section' }] });
    expect(doc.blocks[5]).toEqual({ type: 'table', header: true, rows: [[[{ text: 'H1' }], [{ text: 'H2' }], []], [[{ text: 'a\nb' }], [], []]] });
    expect(doc.blocks).toHaveLength(6);
    expect(notes).toEqual(['1 image was left out: images are not edited here.', '1 text box or drawing was left out.', '1 footnote or endnote was left out.', '1 merged table cell becomes empty cells.']);
  });

  it('refuses DOCTYPEs, unknown entities, other packages and broken XML', () => {
    const doctype = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><office:document-content ${NS}/>`;
    expect(() => odtToDoc(odt(doctype))).toThrow(/DOCTYPE/);
    expect(() => parseXml('<a>&nbsp;</a>')).toThrow(DocumentError);
    expect(() => parseXml('<a><b></a>')).toThrow(DocumentError);
    expect(() => parseXml('<a>')).toThrow(DocumentError);
    expect(() => odtToDoc(zip([{ name: 'mimetype', data: MIME.ods, store: true }, { name: 'content.xml', data: '<x/>' }]))).toThrow(/not an OpenDocument text/);
    expect(() => odtToDoc(Buffer.from('not a zip'))).toThrow(DocumentError);
  });

  it('reads attributes with > in them and other prefixes for known namespaces', () => {
    const el = parseXml('<o:root xmlns:o="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:t="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><t:p t:style-name="a&gt;b">x &#x41;<![CDATA[<raw>]]></t:p></o:root>');
    expect(el.name).toBe('office:root');
    const p = el.children[0] as { name: string; attrs: Record<string, string>; children: unknown[] };
    expect(p.name).toBe('text:p');
    expect(p.attrs['text:style-name']).toBe('a>b');
    expect(p.children.join('')).toBe('x A<raw>');
  });
});
