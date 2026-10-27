/*
 * Bibliographic identifiers in text (ISBN, ISSN, DOI, catalogue numbers) and securities and filing identifiers (SEC
 * accession numbers, CIK, file and film numbers, ISIN, CUSIP, LEI): their digits are not personal data.
 * Used by the PII detectors and by the classifier that labels attachments, files and knowledge documents.
 */
/** ISBN-13 (978 or 979, weights 1 and 3) or ISBN-10 (weights 10 to 1, X for ten). */
const isbnValid = (raw: string): boolean => {
  const d = raw.replace(/[^\dX]/gi, '').toUpperCase();
  if (/^97[89]\d{10}$/.test(d)) return [...d].reduce((s, c, i) => s + Number(c) * (i % 2 ? 3 : 1), 0) % 10 === 0;
  if (/^\d{9}[\dX]$/.test(d)) return [...d].reduce((s, c, i) => s + (c === 'X' ? 10 : Number(c)) * (10 - i), 0) % 11 === 0;
  return false;
};

/** ISSN: seven digits and a check digit (weights 8 to 2, X for ten). */
const issnValid = (raw: string): boolean => {
  const d = raw.replace(/[^\dX]/gi, '').toUpperCase();
  return /^\d{7}[\dX]$/.test(d) && [...d].reduce((s, c, i) => s + (c === 'X' ? 10 : Number(c)) * (8 - i), 0) % 11 === 0;
};

/** Letters as numbers (A=10 … Z=35), as ISIN, CUSIP and LEI count them. */
const alnum = (c: string): number => (/\d/.test(c) ? Number(c) : c.charCodeAt(0) - 55);

/** ISIN: the characters as digits pass the Luhn check. */
const isinValid = (raw: string): boolean => {
  const digits = [...raw].map((c) => String(alnum(c))).join('');
  let sum = 0;
  for (let i = digits.length - 1, dbl = false; i >= 0; i--, dbl = !dbl) {
    let n = Number(digits[i]);
    if (dbl) n = n * 2 > 9 ? n * 2 - 9 : n * 2;
    sum += n;
  }
  return sum % 10 === 0;
};

/** CUSIP: eight characters and a check digit (every second value doubled, digits summed). */
const cusipValid = (raw: string): boolean => {
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    const c = raw[i]!;
    let v = c === '*' ? 36 : c === '@' ? 37 : c === '#' ? 38 : alnum(c);
    if (i % 2) v *= 2;
    sum += Math.floor(v / 10) + (v % 10);
  }
  return /\d/.test(raw[8]!) && (10 - (sum % 10)) % 10 === Number(raw[8]);
};

/** LEI (ISO 17442): the characters as digits are 1 modulo 97. */
const leiValid = (raw: string): boolean => {
  let r = 0;
  for (const c of raw) for (const d of String(alnum(c))) r = (r * 10 + Number(d)) % 97;
  return r === 1;
};

/**
 * Bibliographic identifiers: an ISBN or ISSN that says so and whose check digit verifies, a DOI (10.<registrant>/
 * <suffix>) and a number named by its catalogue (S2CID, PMID, OCLC, …). Their digit groups pass for card, phone and identifier numbers (reference lists, Wikipedia articles), so
 * a number inside one is not personal data. A number merely labelled "ISBN" without a valid check digit still counts.
 */
export function citationSpans(text: string): [number, number][] {
  const out: [number, number][] = [];
  const add = (re: RegExp, ok: (m: RegExpExecArray) => boolean) => {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) if (ok(m)) out.push([m.index, m.index + m[0].length]);
  };
  add(/\bISBN(?:-1[03])?:?\s*((?:\d[ -]?){9,12}[\dX])\b/gi, (m) => isbnValid(m[1]!));
  add(/\bE?ISSN:?\s*(\d{4}-?\d{3}[\dX])\b/gi, (m) => issnValid(m[1]!));
  add(/\b10\.\d{4,9}\/[^\s"<>]+/g, () => true);
  // Catalogue numbers named by their catalogue (Semantic Scholar, PubMed, WorldCat, JSTOR, arXiv and the like).
  add(/\b(?:S2CID|PMID|PMCID|PMC|OCLC|JSTOR|LCCN|OSTI|Zbl|arXiv|Bibcode|hdl)\s*:?\s*[A-Za-z0-9./:-]*\d[A-Za-z0-9./:-]*/g, () => true);
  // Securities and filing identifiers. Each is either labelled or verified by its own check digit, and none is long
  // enough to carry a card number, except the accession number, whose 10-2-6 shape cards are not written in.
  // SEC EDGAR accession numbers (filer id, year, sequence: 0001781290-26-000003), the same eighteen digits when labelled,
  // and the archive paths built from them: eighteen digits pass the Luhn check about one time in ten.
  add(/\b\d{10}-\d{2}-\d{6}\b/g, () => true);
  add(/\bAccession(?:\s+(?:No\.?|Number))?\s*[:#]?\s*\d{18}\b/gi, () => true);
  add(/\/Archives\/edgar\/data\/\d{1,10}\/\d{18}\b/g, () => true);
  // ISIN (US0378331005): two letters, nine characters and a Luhn check digit; it passes for an IBAN.
  add(/\b[A-Z]{2}[A-Z0-9]{9}\d\b/g, (m) => isinValid(m[0]));
  // CUSIP (037833100) and LEI (HWUPKR0MPOU8FGXBT394), named and verified; nine digits pass for a Dutch BSN.
  add(/\bCUSIP(?:\s+(?:No\.?|Number))?\s*[:#]?\s*([0-9A-Z*@#]{9})\b/gi, (m) => cusipValid(m[1]!.toUpperCase()));
  add(/\bLEI(?:\s+code)?\s*[:#]?\s*([0-9A-Z]{20})\b/gi, (m) => leiValid(m[1]!.toUpperCase()));
  // Named SEC numbers: a CIK (up to ten digits), a Commission file number (001-41768, 333-268213-01), a film number.
  add(/\bCIK(?:\s+(?:No\.?|Number))?\s*[:#]?\s*\d{1,10}\b/gi, () => true);
  add(/\b(?:Commission\s+)?File\s+(?:No\.?|Numbers?)\s*[:.#]?\s*\d{1,3}-\d{3,6}(?:-\d{2,3})?\b/gi, () => true);
  add(/\bFilm\s+(?:No\.?|Number)\s*[:.#]?\s*\d{8,11}\b/gi, () => true);
  return out;
}

/** The text with every citation blanked out (same length, so offsets still hold), for the counting classifier. */
export function withoutCitations(text: string): string {
  const spans = citationSpans(text);
  if (!spans.length) return text;
  let out = '';
  let at = 0;
  for (const [a, b] of spans.sort((x, y) => x[0] - y[0])) {
    if (a < at) continue;
    out += text.slice(at, a) + ' '.repeat(b - a);
    at = b;
  }
  return out + text.slice(at);
}
