/*
 * Citations are not personal data: an ISBN that verifies passes the Luhn check as often as not, and the digit groups of
 * ISBNs, DOIs and catalogue numbers look like phone and identity numbers. Reference lists (Wikipedia articles) were
 * labelled confidential for them.
 */
import { describe, expect, it } from 'vitest';
import { classify } from '../src/chat/attachments.js';
import { citationSpans, withoutCitations } from '../src/guardrails/citations.js';
import { detectPii } from '../src/guardrails/detectors.js';

const refs = [
  'Routledge. ISBN 978-0-415-07310-3 . Retrieved 2024.',
  'Springer. ISBN 978-94-010-1689-6 . doi : 10.1007/978-94-010-1689-6_3',
  'Phronesis. ISSN 0556-8641 . S2CID 144901869 . PMID 12345678 .',
  'Mind. 1984. doi : 10.1111/j.2041-6962.1984.tb00387.x . JSTOR 2254521 . OCLC 976786',
].join('\n');

describe('Citations in text', () => {
  it('finds ISBNs and ISSNs only when their check digit verifies, DOIs and named catalogue numbers', () => {
    const found = citationSpans(refs).map(([a, b]) => refs.slice(a, b));
    expect(found).toEqual(expect.arrayContaining(['ISBN 978-0-415-07310-3', 'ISBN 978-94-010-1689-6', 'ISSN 0556-8641', 'S2CID 144901869', 'PMID 12345678', 'JSTOR 2254521', 'OCLC 976786', '10.1007/978-94-010-1689-6_3']));
    // A card number called an ISBN is still a card number: its digits are no ISBN.
    expect(citationSpans('ISBN 4111 1111 1111 1111')).toEqual([]);
    expect(citationSpans('ISSN 0556-8642')).toEqual([]);
    expect(withoutCitations(refs)).toHaveLength(refs.length);
  });

  it('keeps reference lists public and still labels real card and phone numbers', () => {
    expect(classify(refs)).toEqual({ label: 'public', detections: {} });
    expect(detectPii(refs)).toEqual([]);
    expect(classify(`${refs}\nCard 4111 1111 1111 1111`).label).toBe('confidential');
    expect(classify('ISBN 4111 1111 1111 1111').label).toBe('confidential');
    expect(classify(`${refs}\nCall 020 7946 0958`).label).toBe('internal');
    expect(detectPii(`${refs}\nCard 4111 1111 1111 1111`).map((d) => d.kind)).toEqual(['payment_card']);
    // An email address inside a DOI-like string is still found.
    expect(detectPii('doi 10.1000/x mail me@example.org').map((d) => d.kind)).toEqual(['email']);
  });

  it('keeps SEC EDGAR accession numbers and archive paths public', () => {
    // 0001781290-26-000003 passes the Luhn check as an 18-digit number
    const filing = 'Accession 0001781290-26-000003, https://www.sec.gov/Archives/edgar/data/1997038/000178129026000003/form3.html, https://www.sec.gov/ix?doc=/Archives/edgar/data/1997038/000178129026000003/form3.htm, Accession No. 000178129026000003';
    expect(classify(filing)).toEqual({ label: 'public', detections: {} });
    expect(detectPii(filing)).toEqual([]);
    expect(classify('card 4111 1111 1111 1111').label).toBe('confidential');
  });

  it('keeps securities and filing identifiers public, verified or named, and nothing that only looks like one', () => {
    const ids = 'ISIN US0378331005; CUSIP 037833100; LEI HWUPKR0MPOU8FGXBT394; CIK 0000320193; Commission File Number 001-36743; Film No. 261460643';
    expect(withoutCitations(ids).replace(/[^\d]/g, '')).toBe('');
    expect(classify(ids).label).toBe('public');
    expect(detectPii(ids).filter((d) => d.kind !== 'email')).toEqual([]);
    // a check digit that does not verify is not an identifier, and a label does not hide a card number
    expect(citationSpans('CUSIP 037833101')).toEqual([]);
    expect(citationSpans('ISIN US0378331006')).toEqual([]);
    expect(classify('CIK 4111111111111111').label).toBe('confidential');
    expect(classify('File No. 4111 1111 1111 1111').label).toBe('confidential');
  });
});
