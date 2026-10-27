import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileFormula, FORMULA_FUNCTIONS, FormulaError, formulaCatalogue } from '../src/apps/formula.js';
import { FUNCTIONS, MAX_LIST, MAX_TEXT } from '../src/apps/formula-functions.js';
import { harness, localUser, loginAdmin, type Harness } from './helpers.js';
import { client } from './retrieval-seed.js';

/*
 * 1.8.0, Sprint 47 (B-141): the formula functions added to the safe evaluator, their parse-time checks and limits,
 * the catalogue the console's formula editor lists, and the functions from before 1.8.0 unchanged.
 */

const FIELDS = new Set(['amount', 'name', 'due', 'tags', 'start', 'end', 'n', 'item_count']);
const run = (src: string, values: Record<string, unknown> = {}) => compileFormula(src, FIELDS).evaluate(new Map(Object.entries(values)));
const refuse = (src: string, msg: RegExp) => expect(() => compileFormula(src, FIELDS)).toThrow(msg);

describe('B-141: text functions', () => {
  it('Proper, Substitute (with an instance), Find, Search, Rept', () => {
    expect(run("Proper('ADA lovelace-byron o''neil')")).toBe("Ada Lovelace-Byron O'neil");
    expect(run("Substitute('a-b-c-d', '-', '+')")).toBe('a+b+c+d');
    expect(run("Substitute('a-b-c-d', '-', '+', 2)")).toBe('a-b+c-d');
    expect(run("Substitute('a-b', '-', '+', 5)")).toBe('a-b');
    expect(run("Substitute('a-b', '', '+')")).toBe('a-b');
    expect(run("Find('b', 'abcb')")).toBe(2);
    expect(run("Find('B', 'abcb')")).toBe(0);
    expect(run("Find('b', 'abcb', 3)")).toBe(4);
    expect(run("Search('B', 'abcb')")).toBe(2);
    expect(run("Find('😀', 'a😀b')")).toBe(2); // positions count characters, not UTF-16 units
    expect(run("Rept('ab', 3)")).toBe('ababab');
    expect(run("Rept('ab', 0)")).toBe('');
    expect(run("Rept('x', -1)")).toBeNull();
  });

  it('Split gives a list, Join, Left, Right and Mid keep working, lists show as text at the end', () => {
    expect(run("Split('a,b,c')")).toBe('a, b, c');
    expect(run("Join(Split('a;b;c', ';'), ' / ')")).toBe('a / b / c');
    expect(run("Count(Split('abc', ''))")).toBe(3);
    expect(run("Join(Split(''))")).toBe('');
    expect(run("left('abcdef', 2) & right('abcdef', 2) & mid('abcdef', 3, 2)")).toBe('abefcd');
  });

  it('Text with a small format vocabulary for numbers and dates; Value; Char and Code printable only', () => {
    expect(run("text(1234.5, '#,##0.00')")).toBe('1,234.50');
    expect(run("text(-1234.567, '0.0')")).toBe('-1234.6');
    expect(run("text(0.256, '0.0%')")).toBe('25.6%');
    expect(run("text(1999, '$#,##0')")).toBe('$1,999');
    expect(run("text(2.5, '0')")).toBe('3');
    expect(run("text('2026-10-15', 'DDDD D MMMM YYYY')")).toBe('Thursday 15 October 2026');
    expect(run("text('2026-10-15T21:05:09Z', 'YYYY-MM-DD hh:mm:ss A')")).toBe('2026-10-15 09:05:09 PM');
    expect(run("text('2026-10-15T23:30:00Z', 'DD/MM HH:mm', 'Asia/Tokyo')")).toBe('16/10 08:30');
    expect(run("text('abc', '0.00')")).toBeNull();
    expect(run('text(12)')).toBe('12');
    expect(run("Value('1,250.50')")).toBe(1250.5);
    expect(run("Value('$12')")).toBe(12);
    expect(run("Value('15%')")).toBe(0.15);
    expect(run("Value('12abc')")).toBeNull();
    expect(run('Char(65) & Char(9731)')).toBe('A☃');
    expect(run('Char(7)')).toBeNull(); // a control character
    expect(run('Char(8238)')).toBeNull(); // RIGHT-TO-LEFT OVERRIDE, a format character
    expect(run('Char(55296)')).toBeNull(); // a lone surrogate
    expect(run("Code('A')")).toBe(65);
    expect(run("Code('')")).toBeNull();
  });
});

describe('B-141: logic functions', () => {
  it('Switch, IfError, Coalesce, IsBlank, IsNumeric, IsText', () => {
    expect(run("Switch(name, 'a', 1, 'b', 2, 0)", { name: 'b' })).toBe(2);
    expect(run("Switch(name, 'a', 1, 'b', 2, 0)", { name: 'z' })).toBe(0);
    expect(run("Switch(name, 'a', 1)", { name: 'z' })).toBeNull();
    expect(run("Switch(n, '3', 'three', 'other')", { n: 3 })).toBe('three'); // = rules: '3' equals 3
    expect(run('IfError(amount / 0, -1)', { amount: 5 })).toBe(-1);
    expect(run("IfError(Rept('x', 20000), 'too long')")).toBe('too long');
    expect(run('IfError(amount, 0)', { amount: 7 })).toBe(7);
    expect(run("coalesce(name, 'none')", { name: '' })).toBe('none');
    expect(run('isblank(tags)', { tags: [] })).toBe(true);
    expect(run("IsNumeric('42') and IsNumeric(4.5) and not IsNumeric('4x')")).toBe(true);
    expect(run("IsText('') and not IsText(4)")).toBe(true);
  });
});

describe('B-141: math functions', () => {
  it('Power, Sqrt, Exp, Ln, Log with a base, RoundUp, RoundDown, Mod, Sign, Abs, Clamp', () => {
    expect(run('Power(2, 10)')).toBe(1024);
    expect(run('Power(-8, 0.5)')).toBeNull();
    expect(run('Power(10, 400)')).toBeNull();
    expect(run('Sqrt(81)')).toBe(9);
    expect(run('Sqrt(-1)')).toBeNull();
    expect(run('round(Ln(Exp(2)), 10)')).toBe(2);
    expect(run('Ln(0)')).toBeNull();
    expect(run('Log(1000)')).toBe(3);
    expect(run('Log(8, 2)')).toBe(3);
    expect(run('Log(8, 1)')).toBeNull();
    expect(run('RoundUp(1.1, 1)')).toBe(1.1); // no floating-point surprise (1.1 * 10 is 11.000000000000002)
    expect(run('RoundUp(1.11, 1)')).toBe(1.2);
    expect(run('RoundUp(-1.11, 1)')).toBe(-1.2);
    expect(run('RoundDown(3.149, 2)')).toBe(3.14);
    expect(run('RoundDown(1234, -2)')).toBe(1200);
    expect(run('Mod(-7, 3)')).toBe(2);
    expect(run('-7 % 3')).toBe(-1); // the operator keeps its old meaning
    expect(run('Mod(5, 0)')).toBeNull();
    expect(run('Sign(-2) + Sign(0) + Sign(5)')).toBe(0);
    expect(run('abs(-3)')).toBe(3);
    expect(run('Clamp(5, 0, 3)')).toBe(3);
    expect(run('Clamp(5, 3, 0)')).toBeNull();
  });

  it('Min, Max, Sum and Average over lists, empty lists, blanks', () => {
    expect(run("max(Split('3,19,1'))")).toBe(19);
    expect(run("min(Split('3,19,1'), 0)")).toBe(0);
    expect(run("sum(Split('1.1,2.2'))")).toBe(3.3);
    expect(run("Average(Split('1,2,3,4'))")).toBe(2.5);
    expect(run('Average(List())')).toBeNull();
    expect(run('max(List())')).toBeNull();
    expect(run('sum(List())')).toBe(0);
    expect(run("Average(List(2, null, 4))")).toBe(3);
    expect(run("sum(Split('1,x'))")).toBeNull();
  });
});

describe('B-141: dates (UTC unless a zone is given)', () => {
  it('DateAdd in every unit, with month ends and a leap year', () => {
    expect(run("DateAdd('2026-01-31', 1, 'months')")).toBe('2026-02-28');
    expect(run("DateAdd('2024-01-31', 1, 'months')")).toBe('2024-02-29');
    expect(run("DateAdd('2024-02-29', 1, 'years')")).toBe('2025-02-28');
    expect(run("DateAdd('2024-02-29', 4, 'years')")).toBe('2028-02-29');
    expect(run("DateAdd('2026-11-30', 1, 'quarters')")).toBe('2027-02-28');
    expect(run("DateAdd('2026-03-31', -1, 'month')")).toBe('2026-02-28');
    expect(run("DateAdd('2026-12-28', 1, 'weeks')")).toBe('2027-01-04');
    expect(run("DateAdd('2026-10-15', -15, 'days')")).toBe('2026-09-30');
    expect(run("DateAdd('2026-10-15T10:00:00Z', 90, 'minutes')")).toBe('2026-10-15T11:30:00.000Z');
    expect(run("DateAdd('2026-10-15T10:00:00Z', 30, 'seconds')")).toBe('2026-10-15T10:00:30.000Z');
    expect(run("DateAdd('2026-10-15', 3, 'hours')")).toBe('2026-10-15T03:00:00.000Z');
    expect(run("DateAdd('9999-12-31', 1, 'days')")).toBeNull();
    expect(run("DateAdd('2026-01-01', 1, 'days') = add_days('2026-01-01', 1)")).toBe(true);
  });

  it('DST does not matter in UTC; a zone keeps the local wall clock across its change', () => {
    // Europe/Lisbon moves its clocks forward on 2026-03-29 at 01:00 UTC.
    expect(run("DateAdd('2026-03-28T12:00:00Z', 1, 'days')")).toBe('2026-03-29T12:00:00.000Z');
    expect(run("DateDiff('2026-03-28T12:00:00Z', '2026-03-29T12:00:00Z', 'hours')")).toBe(24);
    expect(run("DateAdd('2026-03-28T12:00:00Z', 1, 'days', 'Europe/Lisbon')")).toBe('2026-03-29T11:00:00.000Z');
    expect(run("Hour('2026-03-29T01:30:00Z')")).toBe(1);
    expect(run("Hour('2026-03-29T01:30:00Z', 'Europe/Lisbon')")).toBe(2);
    expect(run("Hour('2026-03-29T00:30:00Z', 'Europe/Lisbon')")).toBe(0);
  });

  it('DateDiff in every unit, negative when the end is earlier, month ends counted as complete', () => {
    expect(run("DateDiff('2026-01-31', '2026-02-28', 'months')")).toBe(1);
    expect(run("DateDiff('2026-01-30', '2026-02-27', 'months')")).toBe(0);
    expect(run("DateDiff('2024-02-29', '2025-02-28', 'years')")).toBe(1);
    expect(run("DateDiff('2024-01-01', '2025-01-01', 'days')")).toBe(366);
    expect(run("DateDiff('2026-01-01', '2026-12-31', 'weeks')")).toBe(52);
    expect(run("DateDiff('2026-01-01', '2026-01-07', 'weeks')")).toBe(0);
    expect(run("DateDiff('2026-01-15', '2026-10-15', 'quarters')")).toBe(3);
    expect(run("DateDiff('2026-03-01', '2026-01-01', 'months')")).toBe(-2);
    expect(run("DateDiff('2026-10-15T10:00:00Z', '2026-10-15T09:59:00Z', 'minutes')")).toBe(-1);
    expect(run("DateDiff('2026-10-15T10:00:00Z', '2026-10-16T09:00:00Z', 'days')")).toBe(0);
    expect(run("DateDiff('2026-10-15T00:00:00Z', '2026-10-15T00:00:59Z', 'seconds')")).toBe(59);
  });

  it('time parts, Weekday, WeekNum (ISO), EOMonth', () => {
    const at = { due: '2026-10-15T21:05:09Z' };
    expect([run('year(due)', at), run('month(due)', at), run('day(due)', at), run('Hour(due)', at), run('Minute(due)', at), run('Second(due)', at)]).toEqual([2026, 10, 15, 21, 5, 9]);
    expect(run("day(due, 'Asia/Tokyo')", at)).toBe(16);
    expect(run("day('2026-10-15', 'Asia/Tokyo')")).toBe(15); // a calendar date is the same date in every zone
    expect(run("Weekday('2026-10-15')")).toBe(5); // Thursday; 1 is Sunday
    expect(run("Weekday('2026-10-18')")).toBe(1);
    expect(run("WeekNum('2026-01-01')")).toBe(1);
    expect(run("WeekNum('2027-01-01')")).toBe(53);
    expect(run("WeekNum('2024-12-30')")).toBe(1);
    expect(run("EOMonth('2024-02-10')")).toBe('2024-02-29');
    expect(run("EOMonth('2026-02-10')")).toBe('2026-02-28');
    expect(run("EOMonth('2026-01-31', 1)")).toBe('2026-02-28');
    expect(run("EOMonth('2026-01-15', -2)")).toBe('2025-11-30');
  });

  it('NetWorkDays and WorkDay with and without holidays', () => {
    expect(run("NetWorkDays('2026-10-12', '2026-10-23')")).toBe(10);
    expect(run("NetWorkDays('2026-10-23', '2026-10-12')")).toBe(-10);
    expect(run("NetWorkDays('2026-10-17', '2026-10-18')")).toBe(0);
    expect(run("NetWorkDays('2026-12-21', '2026-12-31', Split('2026-12-25,2026-12-26,2026-12-25'))")).toBe(8);
    expect(run("WorkDay('2026-10-16', 1)")).toBe('2026-10-19');
    expect(run("WorkDay('2026-10-19', -1)")).toBe('2026-10-16');
    expect(run("WorkDay('2026-10-12', 10)")).toBe('2026-10-26');
    expect(run("WorkDay('2026-12-24', 1, List('2026-12-25'))")).toBe('2026-12-28');
    expect(run("WorkDay('2026-12-23', 3, List('2026-12-24', '2026-12-25', '2026-12-28'))")).toBe('2026-12-31');
    expect(run("WorkDay('2026-10-12', 0)")).toBe('2026-10-12');
    expect(run("WorkDay('2026-10-12', 1, List('not a date'))")).toBeNull();
  });
});

describe('B-141: lists', () => {
  it('Count, CountIf with a condition on item or a value, First, Last, Index, Sort, Unique, fields holding lists', () => {
    expect(run("Count(Split('a,,b'))")).toBe(2);
    expect(run('Count(tags)', { tags: ['x', 'y', ''] })).toBe(2);
    expect(run("CountIf(Split('10,55,90'), number(item) >= 50)")).toBe(2);
    expect(run("CountIf(tags, 'red')", { tags: ['red', 'blue', 'red'] })).toBe(2);
    expect(run("CountIf(List(), item > 1)")).toBe(0);
    expect(run("First(Split('x y z', ' ')) & Last(Split('x y z', ' '))")).toBe('xz');
    expect(run('First(List())')).toBeNull();
    expect(run("Index(Split('a,b,c'), 2) & Index(Split('a,b,c'), -1)")).toBe('bc');
    expect(run("Index(Split('a,b,c'), 9)")).toBeNull();
    expect(run("Join(Sort(List(3, 'b', 1, 'a', null, true)))")).toBe('1, 3, a, b, true, ');
    expect(run("Join(Sort(Split('b,a,c'), 'desc'))")).toBe('c, b, a');
    expect(run("Join(Unique(Split('a,b,a,c,b')))")).toBe('a, b, c');
    expect(run('Join(Unique(List(1, "1", 1)))')).toBe('1, 1');
    expect(run('tags', { tags: ['x', 'y'] })).toBe('x, y'); // a list as the result is text
    expect(run('tags', { tags: [{ a: 1 }] })).toBeNull(); // objects are not values
  });
});

describe('B-141: parse-time checks', () => {
  it('names the function, the argument and what it must be', () => {
    refuse("Power('x', 2)", /Power's first argument is a number; it is given 'x'\. Power\(base, exponent\)/);
    refuse("DateAdd('2026-01-01', 1, 'fortnights')", /DateAdd's third argument is one of seconds, minutes, hours, days, weeks, months, quarters, years/);
    refuse("DateAdd('15/10/2026', 1, 'days')", /DateAdd's first argument is a date/);
    refuse('Sort(5)', /Sort's first argument is a list; it is given 5/);
    refuse("Sort(Split('a'), 'up')", /Sort's second argument is one of asc, desc/);
    refuse("Join('abc')", /Join's first argument is a list; it is given 'abc'/);
    refuse("text(1, 'zz')", /text's second argument is a number format/);
    refuse("Year('2026-01-01', 'Mars/Base')", /year's second argument is a time zone/);
    refuse('Sqrt(upper(name))', /Sqrt's first argument is a number; it is given text/);
    refuse('Rept(Split(name), 2)', /Rept's first argument is text; it is given a list/);
    refuse('Power(1)', /Power takes 2 arguments: Power\(base, exponent\)/);
    refuse('Substitute(name)', /Substitute takes 3 to 4 arguments/);
    refuse('Nope(1)', /nope is not a formula function/);
    refuse('item > 1', /item is not a field this formula can read \(item is read only inside CountIf's condition\)/);
    refuse('constructor(1)', /constructor is not a formula function/);
    // Fields and functions whose kind is not known before they run pass the check.
    expect(() => compileFormula("Power(amount, 2) + DateDiff(start, end, 'days')", FIELDS)).not.toThrow();
    expect(() => compileFormula("Power('3', 2)", FIELDS)).not.toThrow();
  });

  it('names are case-insensitive, and the old functions keep accepting anything', () => {
    expect(run("PROPER('x') & proper('y') & Proper('z')")).toBe('XYZ');
    expect(() => compileFormula("round('x') & left(1, 'y')", FIELDS)).not.toThrow();
  });
});

describe('B-141: resource limits', () => {
  it('caps text, lists and work', () => {
    expect(run(`Rept('ab', ${MAX_TEXT / 2})`)?.toString().length).toBe(MAX_TEXT);
    expect(run(`Rept('ab', ${MAX_TEXT / 2 + 1})`)).toBeNull();
    expect(run("Substitute(Rept('a', 9000), 'a', 'bb')")).toBeNull();
    expect(run(`Count(Split(Rept('a', ${MAX_TEXT}), ''))`)).toBe(MAX_TEXT);
    expect(MAX_LIST).toBeGreaterThanOrEqual(MAX_TEXT);
    // Nesting counts calls inside calls, not precedence levels: five functions deep is fine.
    expect(run("Join(Sort(Unique(Split(Proper('b,a,b')))), '|')")).toBe('A|B');
    // Work in proportion to the input counts against the step budget: sorting lists over and over runs out.
    const heavy = Array.from({ length: 30 }, () => `Count(Sort(Split(Rept('ab,', 3000))))`).join(' + ');
    expect(run(heavy)).toBeNull();
    expect(run("WorkDay('2026-01-01', 100001)")).toBeNull();
    expect(run("DateAdd('2026-01-01', 1000000, 'days')")).toBeNull();
  });

  it('nothing reaches a global or a prototype', () => {
    for (const src of ['__proto__(1)', 'toString(1)', 'hasOwnProperty(1)', 'eval(1)', 'Function(1)', 'globalThis']) expect(() => compileFormula(src, FIELDS)).toThrow(FormulaError);
    expect(run('name', { name: 'a', __proto__: 'x' })).toBe('a');
  });
});

describe('the functions from before 1.8.0 behave as before', () => {
  it('gives the same answers', () => {
    const v = { amount: 1234.567, name: '  Ada  ', due: '2026-02-03', start: '2026-01-01', end: '2026-03-01' };
    const cases: [string, unknown][] = [
      ["if(amount > 1000, 'large', 'small')", 'large'],
      ['if(amount < 0, 1)', null],
      ["coalesce(null, '', 'x')", 'x'],
      ['isblank(null) and isblank(\'\') and not isblank(0)', true],
      ["concat(trim(name), '!', 3)", 'Ada!3'],
      ['upper(trim(name)) & lower(trim(name))', 'ADAada'],
      ['len(name)', 7],
      ["left('abc', 5) & '|' & right('abc', 0) & '|' & mid('abcdef', 0, 2) & '|' & mid('abcdef', 2, 2)", 'abc||ab|bc'],
      ["contains('Hello', 'ELL')", true],
      ["replace('a.b.c', '.', '-')", 'a-b-c'],
      ['round(amount, 2)', 1234.57],
      ['round(amount)', 1235],
      ['round(amount, 20)', 1234.567],
      ['floor(amount) + ceil(0.1)', 1235],
      ['min(3, 1, 2) + max(3, 1, 2)', 4],
      ['min(3, null)', null],
      ['sum(1, null, 2)', 3],
      ["sum(1, 'a')", null],
      ["number('12') + number(true)", 13],
      ["number('x')", null],
      ['text(1/3)', '0.3333333333'],
      ['year(due) * 100 + month(due)', 202602],
      ['day(due)', 3],
      ["add_days(due, 30)", '2026-03-05'],
      ['days_between(start, end)', 59],
      ['amount / 0', null],
      ["'3' = 3", true],
      ["'a' < 'b'", true],
      ['null > 1', null],
      ['not 0', true],
      ["'x' & null & 2", 'x2']
    ];
    for (const [src, want] of cases) expect([src, run(src, v)]).toEqual([src, want]);
    expect(run('today()')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(run('now()')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('keeps every old name callable and listed for the model drafts', () => {
    for (const n of ['if', 'coalesce', 'isblank', 'concat', 'upper', 'lower', 'trim', 'len', 'left', 'right', 'mid', 'contains', 'replace', 'round', 'floor', 'ceil', 'abs', 'min', 'max', 'sum', 'number', 'text', 'today', 'now', 'year', 'month', 'day', 'add_days', 'days_between']) {
      expect(FORMULA_FUNCTIONS).toContain(n);
    }
  });
});

describe('the catalogue and the editor routes', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(async () => {
    await h.close();
  });

  it('lists every function with a signature, a description and an example that compiles', () => {
    const cat = formulaCatalogue();
    expect(cat.length).toBe(FUNCTIONS.size);
    expect(cat.length).toBeGreaterThan(70);
    for (const f of cat) {
      expect(f.signature.toLowerCase().startsWith(f.call)).toBe(true);
      expect(f.description.length).toBeGreaterThan(10);
      expect(() => compileFormula(f.example, new Set(['amount', 'closed_on', 'due', 'created', 'start', 'end', 'opened', 'closed', 'hired', 'invoiced', 'ordered', 'tags', 'scores', 'name', 'path', 'code', 'company', 'rating', 'q1', 'q2', 'q3', 'q4', 'a', 'b', 'c', 'balance', 'years', 'area', 'growth', 'discount', 'hours', 'boxes', 'price', 'nickname', 'first', 'last', 'email', 'iban', 'notes', 'phone', 'quantity', 'net', 'tax', 'status', 'total', 'count']))).not.toThrow();
    }
    expect(cat.find((f) => f.name === 'DateAdd')).toMatchObject({ category: 'Dates', call: 'dateadd' });
  });

  it('serves the catalogue and checks an expression for designers and readers; refuses others', async () => {
    await localUser(h, 'dina', ['member', 'workflow-admin']);
    const c = await loginAdmin(h, 'dina');
    const designer = { get: (p: string) => c.agent.get(p), post: (p: string, b: object) => c.agent.post(p).set('x-csrf-token', c.csrf).send(b) };
    const got = (await designer.get('/api/apps/formula-functions').expect(200)).body;
    expect(got.functions.map((f: { name: string }) => f.name)).toEqual(expect.arrayContaining(['Proper', 'DateDiff', 'NetWorkDays', 'CountIf']));
    expect((await designer.post('/api/apps/formula-check', { expression: "Proper(name) & DateAdd(due, 1, 'months')", fields: ['name', 'due'] }).expect(200)).body).toEqual({ ok: true, refs: ['name', 'due'] });
    const bad = (await designer.post('/api/apps/formula-check', { expression: "Power('x', 2)", fields: [] }).expect(200)).body;
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/Power's first argument is a number/);
    expect((await designer.post('/api/apps/formula-check', { expression: 'x'.repeat(2002), fields: [] }).expect(400)).headers['content-type']).toMatch(/application\/problem\+json/);
    await designer.post('/api/apps/formula-check', { expression: 'x', fields: [], extra: 1 }).expect(400);
    const nobody = await client(h, 'nora', ['member']);
    const perms = (await nobody.get('/api/me').expect(200)).body.permissions as string[];
    await nobody.get('/api/apps/formula-functions').expect(perms.includes('records:read') || perms.includes('apps:design') ? 200 : 403);
  });
});
