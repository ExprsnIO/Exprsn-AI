/*
 * 1.9.0, Sprint 50 (B-158 to B-161): what the spam and metrics suites share. `spamHarness` applies migrations 122 and
 * 123 itself, so the suites run whether or not the shared tree has registered them yet (both are idempotent).
 */
import * as m122 from '../src/db/migrations/122_spam_signals.js';
import * as m123 from '../src/db/migrations/123_spam_responses.js';
import type { Principal } from '../src/authz/policy.js';
import { loadPrincipal } from '../src/http/middleware.js';
import type { ServiceOverrides } from '../src/services.js';
import { harness, localUser, type Harness } from './helpers.js';

export async function spamHarness(overrides: Record<string, string> = {}, services: ServiceOverrides = {}): Promise<Harness> {
  const h = await harness(overrides, services);
  await m122.up(h.s.db);
  await m123.up(h.s.db);
  return h;
}

export async function person(h: Harness, username: string, roles: string[] = ['member']): Promise<{ id: string; p: Principal }> {
  const u = await localUser(h, username, roles);
  return { id: u.id, p: (await loadPrincipal(h.s, h.tenantId, u.id, {}))! };
}

/** A clock the tests move by hand. */
export function clock(start = Date.UTC(2026, 9, 18, 12, 0, 0)) {
  let t = start;
  return { now: () => t, set: (v: number) => void (t = v), add: (ms: number) => void (t += ms) };
}
