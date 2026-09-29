import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GENESIS } from '../src/audit/chain.js';
import { canonicalJson } from '../src/crypto/index.js';
import { harness, type Harness } from './helpers.js';

describe('audit chain', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(() => h.close());

  it('canonicalises JSON independent of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe(canonicalJson({ a: { c: null, d: [1, { y: 2, z: 1 }] }, b: 1 }));
  });

  it('links events per tenant and verifies', async () => {
    const a = await h.s.audit.append({ tenantId: 't-a', action: 'x.one', kind: 'admin', actor: { user: 'u' } });
    const b = await h.s.audit.append({ tenantId: 't-a', action: 'x.two', kind: 'admin', actor: { user: 'u' } });
    const other = await h.s.audit.append({ tenantId: 't-b', action: 'x.one', kind: 'admin', actor: { user: 'u' } });
    expect(a.prev_hash).toBe(GENESIS);
    expect(b.prev_hash).toBe(a.hash);
    expect(b.seq).toBe(2);
    expect(other.seq).toBe(1);
    expect(await h.s.audit.verify('t-a')).toMatchObject({ status: 'verified', checked: 2, head: b.hash });
  });

  it('serialises concurrent appends without forking', async () => {
    await Promise.all(Array.from({ length: 25 }, (_, i) => h.s.audit.append({ tenantId: 't', action: `x.${i}`, kind: 'system', actor: {} })));
    expect(await h.s.audit.verify('t')).toMatchObject({ status: 'verified', checked: 25 });
  });

  it('detects an edited event', async () => {
    await h.s.audit.append({ tenantId: 't', action: 'user.disabled', kind: 'admin', actor: { user: 'u' } });
    const e = await h.s.audit.append({ tenantId: 't', action: 'guardrail.rule.updated', kind: 'admin', actor: { user: 'u' } });
    await h.s.audit.append({ tenantId: 't', action: 'x', kind: 'admin', actor: {} });
    await h.s.db('audit_events').where({ id: e.id }).update({ action: 'nothing.happened' });
    const r = await h.s.audit.verify('t');
    expect(r.status).toBe('broken');
    expect(r.brokenAt).toMatchObject({ seq: 2, reason: 'event content does not match its hash' });
  });

  it('detects a deleted event', async () => {
    await h.s.audit.append({ tenantId: 't', action: 'a', kind: 'admin', actor: {} });
    const e = await h.s.audit.append({ tenantId: 't', action: 'b', kind: 'admin', actor: {} });
    await h.s.audit.append({ tenantId: 't', action: 'c', kind: 'admin', actor: {} });
    await h.s.db('audit_events').where({ id: e.id }).delete();
    expect((await h.s.audit.verify('t')).brokenAt?.reason).toMatch(/sequence gap/);
  });
});
