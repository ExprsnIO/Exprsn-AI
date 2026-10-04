import { afterAll, expect } from 'vitest';
import { EventCatalogue, type EventEnvelope } from '../src/events/catalogue.js';

/*
 * B-2001: every event the code emits, in every test file, is checked against its catalogue schema. The catalogue
 * already counts a mismatch at run time; here a mismatch fails the file, so a schema that drifts from the code (or
 * code that drifts from the schema) cannot pass the suite. Types under `demo.` are the tests' own synthetic events,
 * raised by hand to exercise the webhook fan-out, and are not the code's.
 */
const violations: { type: string; problems: string[] }[] = [];
const check = EventCatalogue.prototype.check;
EventCatalogue.prototype.check = function (this: EventCatalogue, e: EventEnvelope): string[] {
  const problems = check.call(this, e);
  if (problems.length && !e.type.startsWith('demo.')) violations.push({ type: e.type, problems });
  return problems;
};

afterAll(() => {
  expect(violations, 'events that do not match their catalogue schema').toEqual([]);
});
