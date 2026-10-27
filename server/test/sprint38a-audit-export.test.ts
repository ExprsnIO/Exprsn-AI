import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashEvent } from '../src/audit/chain.js';
import { verifyAuditExport } from '../src/audit/export-verify.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

const send = (c: Client, method: 'post' | 'put' | 'patch' | 'delete', url: string, body: object = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body);

/** Runs the export job and downloads the file. */
async function exportJsonl(h: Harness, c: Client, body: object = {}) {
  const req = (await send(c, 'post', '/api/admin/audit/exports/jsonl', body).expect(202)).body as { id: string; file: string; state: string; total: number; redacted: number };
  expect(req.state).toBe('queued');
  expect(req.file).toMatch(/^audit-.*\.jsonl$/);
  await h.s.jobs.runDue();
  const listed = ((await c.agent.get('/api/admin/exports').expect(200)).body as { id: string; state: string; kind: string; rows: number; omitted: number }[]).find((x) => x.id === req.id)!;
  expect(listed).toMatchObject({ state: 'ready', kind: 'audit-jsonl' });
  const dl = await c.agent.get(`/api/admin/exports/${req.id}/download`).expect(200);
  expect(dl.headers['content-type']).toMatch(/application\/x-ndjson/);
  return { req, listed, lines: dl.text.split('\n').filter(Boolean) };
}

describe('B-7501: JSONL audit exports with a chain proof', () => {
  let h: Harness;
  let admin: Client;

  beforeEach(async () => {
    h = await harness();
    await localUser(h, 'ta', ['tenant-admin'], 'restricted');
    admin = await loginAdmin(h, 'ta');
  });
  afterEach(async () => {
    await h.close();
  });

  it('exports a time window that verifies offline against the checkpoint signed at its end', async () => {
    // A few more events, then the window is everything so far.
    await localUser(h, 'mem', ['member'], 'internal');
    await login(h, 'mem');
    const to = Date.now();
    const { req, listed, lines } = await exportJsonl(h, admin, { to });
    const docs = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(docs[0]).toMatchObject({ type: 'header', tenant: h.tenantId, to, redacted: 0 });
    const events = docs.filter((d) => d.type === 'event');
    expect(events.length).toBe(req.total);
    expect(listed.rows).toBe(req.total);
    const proof = docs[docs.length - 1] as { type: string; checkpoint: { seq: number; hash: string; signature: string; key: string } };
    expect(proof.type).toBe('proof');
    expect(proof.checkpoint.seq).toBe(events[events.length - 1]!.seq);
    expect(proof.checkpoint.signature).toMatch(/.+/);

    // Every event's hash is recomputable from the file alone, and the end matches the checkpoint.
    expect(verifyAuditExport(lines)).toMatchObject({ status: 'verified', events: req.total, redacted: 0, checkpoint: { seq: proof.checkpoint.seq, hash: proof.checkpoint.hash } });
    // The checkpoint is a real one: the server's own verification counts it and the chain still verifies.
    const cps = await h.s.checkpoints.list(h.tenantId);
    expect(cps.some((c) => c.seq === proof.checkpoint.seq && c.hash === proof.checkpoint.hash)).toBe(true);
    expect((await h.s.checkpoints.verify(h.tenantId)).status).toBe('verified');

    // Tampering with one event breaks the proof at that sequence; dropping the proof leaves it unsigned.
    const i = lines.findIndex((l) => l.includes('"type":"event"')) + 1;
    const tampered = lines.slice();
    tampered[i] = tampered[i]!.replace('"action":"', '"action":"x.');
    expect(verifyAuditExport(tampered)).toMatchObject({ status: 'broken', brokenAt: { seq: (JSON.parse(lines[i]!) as { seq: number }).seq, reason: 'the hash does not cover the event' } });
    expect(verifyAuditExport(lines.slice(0, -1))).toMatchObject({ status: 'unsigned' });
    // A removed event breaks the sequence.
    expect(verifyAuditExport([...lines.slice(0, i), ...lines.slice(i + 1)]).status).toBe('broken');
    // The request and the download are on the chain.
    const actions = (await h.s.db('audit_events').where({ tenant_id: h.tenantId }).whereIn('action', ['audit.export.requested', 'export.downloaded'])).map((e) => String(e.action));
    expect(actions).toEqual(expect.arrayContaining(['audit.export.requested', 'export.downloaded']));
  });

  it('redacts events above the exporter\'s clearance to their hashes, and the window still verifies', async () => {
    await localUser(h, 'aud', ['auditor'], 'internal');
    const auditor = await loginAdmin(h, 'aud');
    // A restricted event the auditor may not read.
    await h.s.audit.append({ tenantId: h.tenantId, action: 'test.secret', kind: 'admin', actor: { service: 'test' }, label: 'restricted', detail: { secret: 'Nightingale' } });
    const { req, lines } = await exportJsonl(h, auditor);
    expect(req.redacted).toBeGreaterThan(0);
    const red = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((d) => d.type === 'event' && d.redacted === true);
    expect(red.length).toBe(req.redacted);
    expect(red[0]).not.toHaveProperty('detail');
    expect(lines.join('\n')).not.toContain('Nightingale');
    const r = verifyAuditExport(lines);
    expect(r).toMatchObject({ status: 'verified', redacted: req.redacted });
  });

  it('the verifier recomputes the same hash the chain uses', async () => {
    const e = await h.s.audit.append({ tenantId: h.tenantId, action: 'test.hash', kind: 'system', actor: { service: 'test' }, detail: { n: 1 } });
    const { hash: _h, ...rest } = e;
    expect(hashEvent(rest)).toBe(e.hash);
    expect(verifyAuditExport([{ type: 'header', events: 1, first: { seq: e.seq, prev_hash: e.prev_hash } }, { type: 'event', ...e }, { type: 'proof', algorithm: 'sha256-chain', checkpoint: { tenant: e.tenant_id, seq: e.seq, hash: e.hash, ts: 1, key: 'k', signature: 's', payload: JSON.stringify({ hash: e.hash, seq: e.seq, tenant: e.tenant_id, ts: 1 }) } }]).status).toBe('verified');
  });
});
