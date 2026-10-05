import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { totp } from '../src/identity/totp.js';
import { fromGeneric, fromMailgunEvent, fromMailgunForm, midList, normalizeMid, parseRaw, replySubject, signGeneric, signMailgun, stripQuoted, verifyGeneric, verifyMailgun } from '../src/channels/email.js';
import type { ImapBatch, ImapCursor, ImapFetcher, ImapTarget } from '../src/channels/imap.js';
import { SESSION_OBJECT } from '../src/channels/service.js';
import { sessionKey, signIdentity, signSession, verifyIdentity, verifySession } from '../src/channels/tokens.js';
import { maskAddress } from '../src/identity/email-otp.js';
import { TOPICS } from '../src/platform/bus.js';
import { validateEvent } from '../src/events/catalogue.js';
import { FakeMail } from './fake-account.js';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, login, loginAdmin, PASSWORD, type Client, type Harness } from './helpers.js';
import { drain } from './retrieval-seed.js';
import { seedGateway } from './seed-gateway.js';

/*
 * Sprint 28a: customer-service channels (B-2301 to B-2304) and the email one-time-code factor (B-1806). The "done
 * when" of each item is a test below:
 *   B-2301 an anonymous customer gets answers within the channel's label;
 *   B-2302 an edited reply reaches the customer as edited;
 *   B-2303 a reply in the same thread joins the session (IMAP and webhooks);
 *   B-2304 a session older than the period is purged;
 *   B-1806 a sixth wrong code locks like a wrong TOTP.
 */

describe('channel tokens (B-2301)', () => {
  const key = sessionKey('s'.repeat(64));
  it('signs session tokens scoped to one session and refuses tampering and expiry', () => {
    const t = signSession(key, { tenantId: 'T', channelId: 'C', sessionId: 'S', exp: Date.now() + 60_000 });
    expect(verifySession(key, t)).toMatchObject({ tenantId: 'T', channelId: 'C', sessionId: 'S' });
    expect(verifySession(sessionKey('x'.repeat(64)), t)).toBeNull();
    const [head, mac] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ t: 'T', c: 'C', s: 'OTHER', e: Date.now() + 60_000 })).toString('base64url');
    expect(verifySession(key, `cst_${forged}.${mac}`)).toBeNull();
    // Changes the MAC's first character, which is always a different one (the last character of a base64url MAC carries
    // only 4 bits, and replacing it with a fixed letter left it unchanged one time in 16).
    expect(verifySession(key, `${head}.${mac![0] === 'A' ? 'B' : 'A'}${mac!.slice(1)}`)).toBeNull();
    expect(verifySession(key, signSession(key, { tenantId: 'T', channelId: 'C', sessionId: 'S', exp: Date.now() - 1 }))).toBeNull();
  });

  it('verifies identity assertions signed by the channel site', () => {
    const exp = Math.floor(Date.now() / 1000) + 600;
    const a = signIdentity('site-secret', { sub: 'cust-42', name: 'Ann', email: 'ann@customer.example', exp });
    expect(verifyIdentity('site-secret', a)).toEqual({ sub: 'cust-42', name: 'Ann', email: 'ann@customer.example' });
    expect(() => verifyIdentity('other', a)).toThrow(/does not verify/);
    expect(() => verifyIdentity('site-secret', signIdentity('site-secret', { sub: 'x', exp: exp - 1200 }))).toThrow(/expired/);
    expect(() => verifyIdentity('site-secret', signIdentity('site-secret', { sub: 'x', exp: exp + 3 * 86_400 }))).toThrow(/at most a day/);
  });
});

describe('channel email parsing (B-2303)', () => {
  it('reads threading headers and strips the quoted part', async () => {
    const m = await parseRaw('From: "Ann" <Ann@Customer.example>\r\nTo: help@shop.example\r\nSubject: Order 7\r\nMessage-ID: <m2@customer.example>\r\nIn-Reply-To: <abc@shop.example>\r\nReferences: <first@customer.example> <abc@shop.example>\r\n\r\nWhere is it?\r\n\r\nOn Mon, 5 Oct 2026, Shop wrote:\r\n> It ships today.\r\n');
    expect(m).toMatchObject({ kind: 'message', messageId: 'm2@customer.example', inReplyTo: 'abc@shop.example', references: ['first@customer.example', 'abc@shop.example'], from: { address: 'ann@customer.example', name: 'Ann' }, subject: 'Order 7', text: 'Where is it?', automatic: false });
    expect((await parseRaw('From: x@y.example\r\nAuto-Submitted: auto-replied\r\nSubject: Out of office\r\n\r\nAway'))!).toMatchObject({ automatic: true });
    expect(stripQuoted('> only quoted')).toBe('> only quoted');
    expect(midList('<a@b>  <c@d>')).toEqual(['a@b', 'c@d']);
    expect(normalizeMid(' <a b@c> ')).toBeNull();
    expect(replySubject('Re: Order 7')).toBe('Re: Order 7');
    expect(replySubject(null)).toBe('Re: your message');
  });

  it('reads delivery status reports as bounces', async () => {
    const dsn = ['From: MAILER-DAEMON@mx.example.net', 'To: help@shop.example', 'Subject: Undelivered', 'MIME-Version: 1.0', 'Content-Type: multipart/report; report-type=delivery-status; boundary="BB"', '', '--BB', 'Content-Type: text/plain', '', 'Could not deliver.', '--BB', 'Content-Type: message/delivery-status', '', 'Reporting-MTA: dns; mx.example.net', '', 'Final-Recipient: rfc822; gone@customer.example', 'Action: failed', 'Status: 5.1.1', 'Diagnostic-Code: smtp; 550 5.1.1 user unknown', '--BB', 'Content-Type: text/rfc822-headers', '', 'Message-ID: <out.1@shop.example>', '--BB--', ''].join('\r\n');
    expect(await parseRaw(dsn)).toEqual({ kind: 'bounce', reportId: null, messageId: 'out.1@shop.example', recipient: 'gone@customer.example', type: 'hard', status: '5.1.1', reason: 'smtp; 550 5.1.1 user unknown' });
  });

  it('takes the generic and Mailgun shapes and checks their signatures', async () => {
    const raw = Buffer.from('{"type":"message"}');
    const ts = String(Math.floor(Date.now() / 1000));
    expect(verifyGeneric('k', ts, signGeneric('k', ts, raw), raw, 300)).toBeNull();
    expect(verifyGeneric('k', ts, signGeneric('other', ts, raw), raw, 300)).toMatch(/does not verify/);
    expect(verifyGeneric('k', String(Number(ts) - 3600), signGeneric('k', String(Number(ts) - 3600), raw), raw, 300)).toMatch(/tolerance/);
    expect(verifyMailgun('mk', ts, 'token-1234567890', signMailgun('mk', ts, 'token-1234567890'), 300)).toBeNull();
    expect(verifyMailgun('mk', ts, 'token-1234567890', signMailgun('mk', ts, 'token-other-1234'), 300)).toMatch(/does not verify/);
    expect(await fromGeneric({ type: 'message', from: 'ann@customer.example', fromName: 'Ann', subject: 'Hi', text: 'Hello', messageId: '<g1@c>', references: ['<a@b>'] })).toMatchObject({ kind: 'message', from: { address: 'ann@customer.example', name: 'Ann' }, messageId: 'g1@c', references: ['a@b'] });
    expect(await fromGeneric({ type: 'bounce', recipient: 'X@Y.example', messageId: '<o@s>', kind: 'soft' })).toMatchObject({ kind: 'bounce', recipient: 'x@y.example', type: 'soft', messageId: 'o@s' });
    await expect(fromGeneric({ type: 'other' })).rejects.toThrow(/type must be/);
    expect(fromMailgunForm({ from: 'Ann <ann@customer.example>', subject: 'Hi', 'body-plain': 'Hello\n> old', 'Message-Id': '<mg1@c>', 'In-Reply-To': '<o@s>' })).toMatchObject({ messageId: 'mg1@c', inReplyTo: 'o@s', text: 'Hello' });
    expect(fromMailgunEvent({ 'event-data': { event: 'failed', severity: 'permanent', recipient: 'ann@customer.example', message: { headers: { 'message-id': 'o@s' } }, 'delivery-status': { code: 550, description: 'mailbox full' } } })).toMatchObject({ kind: 'bounce', type: 'hard', messageId: 'o@s', status: '550' });
    expect(fromMailgunEvent({ 'event-data': { event: 'delivered' } })).toBeNull();
    expect(maskAddress('ann.lee@customer.example')).toBe('a***@c***.example');
  });
});

/** An IMAP mailbox in memory: messages by UID; polls read above the cursor like the real fetcher. */
class FakeImap {
  messages: { uid: number; raw: string }[] = [];
  uidValidity = 7;
  logins: ImapTarget[] = [];
  next = 1;
  add(raw: string) {
    this.messages.push({ uid: this.next++, raw });
  }
  fetcher: ImapFetcher = async (t: ImapTarget, cursor: ImapCursor, max: number): Promise<ImapBatch> => {
    this.logins.push(t);
    const from = cursor.uidValidity === this.uidValidity ? cursor.lastUid : 0;
    const above = this.messages.filter((m) => m.uid > from);
    return { uidValidity: this.uidValidity, messages: above.slice(0, max).map((m) => ({ uid: m.uid, raw: Buffer.from(m.raw) })), more: above.length > max };
  };
}

describe('Sprint 28a: customer-service channels', () => {
  let h: Harness;
  let ollama: FakeOllama;
  let mail: FakeMail;
  let imap: FakeImap;
  let wsId: string;
  let events: { type: string; label: string; data: Record<string, unknown> }[];

  beforeEach(async () => {
    mail = new FakeMail();
    imap = new FakeImap();
    h = await harness({ SMTP_URL: '' }, { mail, channelIo: { imap: imap.fetcher } });
    ollama = await new FakeOllama().start();
    await seedGateway(h, ollama);
    wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Support', 'confidential')).id;
    events = [];
    h.s.bus.on<{ type: string; label: string; data: Record<string, unknown>; tenantId: string; id: string }>(TOPICS.integrationEvent, (e) => {
      if (!e.type.startsWith('channel.')) return;
      events.push(e);
      // Every emitted channel event matches its catalogue schema.
      expect(validateEvent({ id: e.id, type: e.type, tenant: e.tenantId, label: e.label, createdAt: new Date().toISOString(), data: e.data })).toEqual([]);
    });
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop().catch(() => undefined);
  });

  type C = Client & { post: (p: string, b?: object) => request.Test; patch: (p: string, b?: object) => request.Test; get: (p: string) => request.Test; del: (p: string) => request.Test };
  const wrap = (c: Client): C => ({
    ...c,
    post: (p, b = {}) => c.agent.post(p).set('x-csrf-token', c.csrf).send(b),
    patch: (p, b = {}) => c.agent.patch(p).set('x-csrf-token', c.csrf).send(b),
    del: (p) => c.agent.delete(p).set('x-csrf-token', c.csrf),
    get: (p) => c.agent.get(p)
  });
  const admin = async (name = 'ta', role = 'tenant-admin') => {
    await localUser(h, name, [role], 'confidential');
    return wrap(await loginAdmin(h, name));
  };
  const reviewer = async (name = 'rae', clearance: 'internal' | 'confidential' = 'confidential') => {
    const u = await localUser(h, name, ['flag-reviewer', 'member'], clearance);
    await h.s.tenants.addMember(wsId, u.id);
    return wrap(await login(h, name).then((l) => ({ agent: l.agent, csrf: l.csrf, cookie: l.cookie })));
  };
  const pub = () => request(h.app);
  const customer = (token: string) => ({
    send: (text: string) => pub().post('/api/public/channels/session/messages').set('authorization', `Bearer ${token}`).send({ text }),
    view: (after = 0) => pub().get(`/api/public/channels/session?after=${after}`).set('authorization', `Bearer ${token}`),
    escalate: (reason?: string) => pub().post('/api/public/channels/session/escalate').set('authorization', `Bearer ${token}`).send(reason ? { reason } : {}),
    close: () => pub().post('/api/public/channels/session/close').set('authorization', `Bearer ${token}`).send({})
  });
  const chatChannel = async (a: C, extra: Record<string, unknown> = {}) => (await a.post('/api/channels', { workspaceId: wsId, kind: 'chat', name: 'Web help', label: 'internal', target: { kind: 'profile', name: 'general' }, reviewMode: 'never', greeting: 'Hello, how can we help?', ...extra }).expect(201)).body as { id: string; publicKey: string; secrets: { identitySecret: string } };
  const audits = (action: string) => h.s.audit.list(h.tenantId, { action });

  it('B-2301: an anonymous customer gets answers within the channel\'s label', async () => {
    const a = await admin();
    // The binding is checked when it is saved: label against the workspace ceiling and the profile's label.
    const sec = await localUser(h, 'secret-ws', ['member'], 'internal');
    void sec;
    const low = (await h.s.tenants.createWorkspace(h.tenantId, 'Low', 'internal')).id;
    await a.post('/api/channels', { workspaceId: low, kind: 'chat', name: 'x', label: 'confidential', target: { kind: 'profile', name: 'general' } }).expect(403);
    await a.post('/api/channels', { workspaceId: wsId, kind: 'chat', name: 'x', label: 'restricted', target: { kind: 'profile', name: 'general' } }).expect(403);
    const missing = await a.post('/api/channels', { workspaceId: wsId, kind: 'chat', name: 'x', label: 'internal', target: { kind: 'profile', name: 'nope' } }).expect(422);
    expect(missing.body.step).toBe('target');
    await a.post('/api/channels', { workspaceId: wsId, kind: 'chat', name: 'x', label: 'internal', target: { kind: 'agent', name: 'nobody' } }).expect(422);

    const ch = await chatChannel(a);
    expect(ch.secrets.identitySecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await h.s.db('channels').where({ id: ch.id }).first();
    expect(row.identity_secret).not.toContain(ch.secrets.identitySecret);
    expect((await a.get(`/api/channels/${ch.id}`).expect(200)).body).not.toHaveProperty('secrets');

    ollama.reply = (msgs) => ({ content: `Answer to: ${msgs[msgs.length - 1]!.content}` });
    const start = (await pub().post('/api/public/channels/sessions').send({ channel: ch.publicKey }).expect(201)).body;
    expect(start.token).toMatch(/^cst_/);
    expect(start.headers).toBeUndefined();
    expect(start.messages).toEqual([expect.objectContaining({ role: 'notice', text: 'Hello, how can we help?' })]);
    const cu = customer(start.token);
    const sent = (await cu.send('Where is my parcel?').expect(201)).body;
    expect(sent.reply).toMatchObject({ role: 'assistant', state: 'delivered', text: 'Answer to: Where is my parcel?' });
    // The model saw the channel's guidance, the conversation, nothing else.
    const view = (await cu.view().expect(200)).body;
    expect(view.session).toMatchObject({ label: 'internal', state: 'open' });
    expect(view.messages.map((m: { role: string }) => m.role)).toEqual(['notice', 'customer', 'assistant']);
    // Sealed at rest; labelled with the channel's label.
    const stored = await h.s.db('channel_messages').where({ session_id: start.session.id }).orderBy('seq');
    expect(stored.every((m: { body: string; label: string }) => !m.body.includes('parcel') && m.label === 'internal')).toBe(true);
    // Metered to the channel's workspace.
    expect(await h.s.db('usage_records').where({ kind: 'channel', workspace_id: wsId }).first()).toBeTruthy();
    // The label is enforced at the pool: once no pool is cleared for it, the customer is told a person follows up.
    await h.s.gateway.repo.updatePool((await h.s.gateway.repo.pools())[0]!.id, { labelCeiling: 'public' });
    const soft = (await cu.send('And now?').expect(201)).body;
    expect(soft.reply).toMatchObject({ role: 'notice', state: 'delivered' });
    expect(soft.session.escalated).toBe(true);
    expect((await audits('channel.reply.failed')).length).toBe(1);

    // Token checks: a tampered token, another channel's view and a closed session are refused.
    await pub().get('/api/public/channels/session').set('authorization', `Bearer ${start.token.slice(0, -2)}xx`).expect(401);
    await pub().get('/api/public/channels/session').expect(401);
    await cu.close().expect(200);
    await cu.view().expect(401);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['channel.session.started', 'channel.message.received', 'channel.reply.sent', 'channel.session.escalated', 'channel.session.closed']));
  });

  it('B-2301: rate limits, identified customers and paused channels', async () => {
    const a = await admin();
    // Refused starts count too: four attempts an hour from this address.
    const ch = await chatChannel(a, { messagesPerMinute: 2, sessionsPerHour: 4, allowAnonymous: false });
    await pub().post('/api/public/channels/sessions').send({ channel: ch.publicKey }).expect(401);
    const exp = Math.floor(Date.now() / 1000) + 600;
    const identity = signIdentity(ch.secrets.identitySecret, { sub: 'cust-1', name: 'Ann', email: 'ann@customer.example', exp });
    await pub().post('/api/public/channels/sessions').send({ channel: ch.publicKey, identity: signIdentity('wrong', { sub: 'cust-1', exp }) }).expect(401);
    const s1 = (await pub().post('/api/public/channels/sessions').send({ channel: ch.publicKey, identity }).expect(201)).body;
    expect(s1.resumed).toBe(false);
    const cu = customer(s1.token);
    await cu.send('one').expect(201);
    await cu.send('two').expect(201);
    await cu.send('three').expect(429);
    // The same customer comes back to their open session.
    const s2 = (await pub().post('/api/public/channels/sessions').send({ channel: ch.publicKey, identity }).expect(201)).body;
    expect(s2).toMatchObject({ resumed: true, session: { id: s1.session.id } });
    await pub().post('/api/public/channels/sessions').send({ channel: ch.publicKey, identity }).expect(429);
    const r = (await reviewer()) as C;
    const list = (await r.get(`/api/channels/${ch.id}/sessions`).expect(200)).body;
    expect(list[0]).toMatchObject({ customer: { kind: 'identified', name: 'Ann', email: 'ann@customer.example', externalId: 'cust-1' } });
    // Pausing the channel ends its sessions' tokens for now.
    await a.patch(`/api/channels/${ch.id}`, { state: 'paused' }).expect(200);
    await cu.view().expect(401);
    await pub().post('/api/public/channels/sessions').send({ channel: ch.publicKey, identity }).expect(404);
    // Rotating the identity secret refuses assertions signed with the old one.
    await a.patch(`/api/channels/${ch.id}`, { state: 'active' }).expect(200);
    const rotated = (await a.post(`/api/channels/${ch.id}/secrets`, { which: 'identity' }).expect(200)).body;
    expect(rotated.identitySecret).toBeTruthy();
    expect((await audits('channel.secret.rotated')).length).toBe(1);
  });

  it('B-2302: an edited reply reaches the customer as edited', async () => {
    const a = await admin();
    const ch = await chatChannel(a, { reviewMode: 'escalated' });
    const r = await reviewer();
    ollama.reply = () => ({ content: 'Model draft: your refund is approved.' });
    const start = (await pub().post('/api/public/channels/sessions').send({ channel: ch.publicKey, name: 'Bo' }).expect(201)).body;
    const cu = customer(start.token);
    ollama.reply = () => ({ content: 'Let me check.' });
    expect((await cu.send('Can I get a refund?').expect(201)).body.reply.state).toBe('delivered');
    ollama.reply = () => ({ content: 'Model draft: your refund is approved.' });
    await cu.escalate('I want a person').expect(200);
    const held = (await cu.send('Please confirm the refund').expect(201)).body;
    expect(held.reply).toMatchObject({ state: 'pending', text: null });
    expect(events.some((e) => e.type === 'channel.reply.held')).toBe(true);

    // The reviewer sees it in the held queue and in the flag queue.
    const queue = (await r.get('/api/channels/held').expect(200)).body;
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ text: 'Model draft: your refund is approved.', channelName: 'Web help', flag: { state: 'open' } });
    const flagView = (await r.get(`/api/flags/${queue[0].flag.ref}`).expect(200)).body;
    expect(flagView.held).toMatchObject({ content: 'Model draft: your refund is approved.', state: 'held' });
    // Someone without channels:review cannot decide it.
    const m = await localUser(h, 'mo', ['member'], 'confidential');
    await h.s.tenants.addMember(wsId, m.id);
    const mo = wrap(await login(h, 'mo').then((l) => ({ agent: l.agent, csrf: l.csrf, cookie: l.cookie })));
    await mo.post(`/api/channels/held/${queue[0].id}/decide`, { decision: 'approve' }).expect(403);
    await r.post(`/api/channels/held/${queue[0].id}/decide`, { decision: 'edit' }).expect(400);

    const decided = (await r.post(`/api/channels/held/${queue[0].id}/decide`, { decision: 'edit', text: 'A colleague will confirm your refund by tomorrow.', reason: 'Not yet approved' }).expect(200)).body;
    expect(decided).toMatchObject({ state: 'delivered', edited: true, flag: { state: 'approved' } });
    const view = (await cu.view().expect(200)).body;
    const last = view.messages.at(-1);
    expect(last).toMatchObject({ role: 'assistant', state: 'delivered', text: 'A colleague will confirm your refund by tomorrow.' });
    expect(JSON.stringify(view)).not.toContain('Model draft');
    // The transcript keeps the model's text as the original.
    const t = (await r.get(`/api/channels/${ch.id}/sessions/${start.session.id}`).expect(200)).body;
    expect(t.transcript.at(-1)).toMatchObject({ text: 'A colleague will confirm your refund by tomorrow.', original: 'Model draft: your refund is approved.', flag: { state: 'approved' } });
    await r.post(`/api/channels/held/${queue[0].id}/decide`, { decision: 'approve' }).expect(409);
    expect((await audits('channel.reply.edited')).length).toBe(1);
    expect(events.find((e) => e.type === 'channel.reply.sent' && e.data.edited === true)).toBeTruthy();

    // A person answers in the escalated session.
    await r.post(`/api/channels/${ch.id}/sessions/${start.session.id}/messages`, { text: 'Hi Bo, this is Rae.' }).expect(201);
    expect((await cu.view(last.seq).expect(200)).body.messages).toEqual([expect.objectContaining({ role: 'agent', text: 'Hi Bo, this is Rae.' })]);
  });

  it('B-2302: every answer reviewed; rejecting withdraws it, the flag queue route approves', async () => {
    const a = await admin();
    const ch = await chatChannel(a, { reviewMode: 'always' });
    const r = await reviewer();
    ollama.reply = () => ({ content: 'Draft answer' });
    const start = (await pub().post('/api/public/channels/sessions').send({ channel: ch.publicKey }).expect(201)).body;
    const cu = customer(start.token);
    await cu.send('first').expect(201);
    await cu.send('second').expect(201);
    const queue = (await r.get('/api/channels/held').expect(200)).body as { id: string; flag: { ref: string } }[];
    expect(queue).toHaveLength(2);
    await r.post(`/api/channels/held/${queue[0]!.id}/decide`, { decision: 'reject', reason: 'Wrong' }).expect(200);
    // Through the flag queue's own decide route as well.
    await r.post(`/api/flags/${queue[1]!.flag.ref}/decide`, { decision: 'approved' }).expect(200);
    const msgs = (await cu.view().expect(200)).body.messages as { role: string; text: string | null; state: string }[];
    // In sequence order: the rejected answer to "first" is gone, its notice comes after the approved one.
    expect(msgs.map((m) => [m.role, m.text])).toEqual([
      ['notice', 'Hello, how can we help?'],
      ['customer', 'first'],
      ['customer', 'second'],
      ['assistant', 'Draft answer'],
      ['notice', 'A person from the team will follow up on this.']
    ]);
    expect((await audits('channel.hold.approved')).length).toBe(1);
    expect((await audits('channel.reply.rejected')).length).toBe(1);
  });

  it('B-2302: a guardrail that requires approval holds the answer', async () => {
    const a = await admin();
    const ch = await chatChannel(a);
    const r = await reviewer();
    const real = h.s.guardrails.check.bind(h.s.guardrails);
    h.s.guardrails.check = async (input) => (input.checkpoint === 'model-output' && /refund/.test(input.text) ? { action: 'require-approval', text: input.text, findings: [{ ruleId: 'r1', ruleName: 'Refund promises', action: 'require-approval', stage: 'enforce' }], reason: 'Refunds are reviewed.' } : real(input));
    ollama.reply = () => ({ content: 'You will get a refund.' });
    const start = (await pub().post('/api/public/channels/sessions').send({ channel: ch.publicKey }).expect(201)).body;
    expect((await customer(start.token).send('refund?').expect(201)).body.reply.state).toBe('pending');
    const queue = (await r.get('/api/channels/held').expect(200)).body;
    const f = await h.s.db('guard_flags').where({ id: queue[0].flag.id }).first();
    expect(f).toMatchObject({ kind: 'hold', checkpoint: 'model-output', rule_name: 'Refund promises', source_kind: 'channel-message' });
  });

  it('B-2303: a reply in the same thread joins the session (IMAP, outbox, bounces)', async () => {
    const a = await admin('root', 'system-admin');
    const taId = (await h.s.db('users').where({ username: 'root' }).first()).id;
    await a.agent.post('/api/vault/policies').set('x-csrf-token', a.csrf).send({ subjectKind: 'user', subject: taId, path: 'kv/mail/support', capabilities: ['write'], effect: 'allow' }).expect(201);
    await a.agent.put('/api/vault/kv/data/mail/support').set('x-csrf-token', a.csrf).send({ data: { password: 'imap-pw', mailgun: 'mg-key' } }).expect(201);
    const body = { workspaceId: wsId, kind: 'email', name: 'Mail help', label: 'internal', target: { kind: 'profile', name: 'general' }, reviewMode: 'never', email: { address: 'help@shop.example', fromName: 'Shop "help"', imap: { host: '127.0.0.1', user: 'help', passwordRef: 'vault:mail/support#password' }, mailgunKeyRef: 'vault:mail/support#mailgun' } };
    await a.post('/api/channels', body).expect(403); // no read grant on the vault path yet
    await a.agent.post('/api/vault/policies').set('x-csrf-token', a.csrf).send({ subjectKind: 'user', subject: taId, path: 'kv/mail', capabilities: ['read'], effect: 'allow' }).expect(201);
    await a.post('/api/channels', { ...body, email: { ...body.email, imap: { ...body.email.imap, passwordRef: 'plain-password' } } }).expect(400);
    const ch = (await a.post('/api/channels', body).expect(201)).body;
    expect(ch.secrets.webhookSecret).toBeTruthy();
    expect(ch.webhooks.generic).toContain(`/api/public/channels/${ch.publicKey}/email/generic`);

    ollama.reply = (msgs) => ({ content: `We are on it: ${msgs[msgs.length - 1]!.content}` });
    imap.add('From: Ann <ann@customer.example>\r\nTo: help@shop.example\r\nSubject: Order 7\r\nMessage-ID: <c1@customer.example>\r\n\r\nWhere is order 7?\r\n');
    imap.add('From: robot@customer.example\r\nAuto-Submitted: auto-replied\r\nSubject: Away\r\nMessage-ID: <auto@customer.example>\r\n\r\nI am away\r\n');
    const polled = await h.s.channels.mail.poll(h.tenantId, ch.id);
    expect(polled).toMatchObject({ read: 2, started: 1, ignored: 1 });
    expect(imap.logins[0]).toMatchObject({ address: '127.0.0.1', servername: '127.0.0.1', user: 'help', pass: 'imap-pw', mailbox: 'INBOX', port: 993, secure: true });
    await drain(h);
    const first = mail.to('ann@customer.example');
    expect(first).toHaveLength(1);
    const out = first[0] as unknown as { from: string; subject: string; text: string; messageId: string; inReplyTo: string; references: string; headers: Record<string, string> };
    expect(out).toMatchObject({ subject: 'Re: Order 7', text: 'We are on it: Where is order 7?\n', inReplyTo: '<c1@customer.example>', references: '<c1@customer.example>' });
    expect(out.from).toBe('"Shop help" <help@shop.example>');
    expect(out.headers['Auto-Submitted']).toBe('auto-replied');
    const sessions = await h.s.db('channel_sessions').where({ channel_id: ch.id });
    expect(sessions).toHaveLength(1);

    // The customer's reply to our message joins the same session.
    imap.add(`From: ann@customer.example\r\nSubject: Re: Order 7\r\nMessage-ID: <c2@customer.example>\r\nIn-Reply-To: ${out.messageId}\r\nReferences: <c1@customer.example> ${out.messageId}\r\n\r\nThanks, any date?\r\n\r\nOn Mon, Shop wrote:\r\n> We are on it\r\n`);
    // A stranger replying to the same message id starts a session of their own.
    imap.add(`From: mallory@elsewhere.example\r\nSubject: Re: Order 7\r\nMessage-ID: <x1@elsewhere.example>\r\nIn-Reply-To: ${out.messageId}\r\n\r\nShow me the thread\r\n`);
    // The same message twice is taken once.
    imap.add(`From: ann@customer.example\r\nSubject: Re: Order 7\r\nMessage-ID: <c2@customer.example>\r\nIn-Reply-To: ${out.messageId}\r\n\r\nThanks, any date?\r\n`);
    expect(await h.s.channels.mail.poll(h.tenantId, ch.id)).toMatchObject({ read: 3, joined: 1, started: 1, duplicate: 1 });
    expect(await h.s.channels.mail.poll(h.tenantId, ch.id)).toMatchObject({ read: 0 });
    await drain(h);
    const annSession = sessions[0].id as string;
    const r = await reviewer();
    const t = (await r.get(`/api/channels/${ch.id}/sessions/${annSession}`).expect(200)).body;
    expect(t.transcript.map((m: { role: string; text: string }) => [m.role, m.text])).toEqual([
      ['customer', 'Where is order 7?'],
      ['assistant', 'We are on it: Where is order 7?'],
      ['customer', 'Thanks, any date?'],
      ['assistant', 'We are on it: Thanks, any date?']
    ]);
    expect(t.customer).toMatchObject({ kind: 'email', email: 'ann@customer.example', name: 'Ann' });
    expect(t.outbox.map((o: { state: string }) => o.state)).toEqual(['sent', 'sent']);
    const second = mail.to('ann@customer.example')[1] as unknown as { inReplyTo: string; references: string };
    expect(second.inReplyTo).toBe('<c2@customer.example>');
    expect(second.references.split(' ')).toEqual(['<c1@customer.example>', out.messageId, '<c2@customer.example>']);
    expect(await h.s.db('channel_sessions').where({ channel_id: ch.id })).toHaveLength(2);

    // Bounces: a delivery report through IMAP marks the outbox row.
    imap.add(['From: MAILER-DAEMON@mx.customer.example', 'To: help@shop.example', 'Subject: Undelivered', 'Message-ID: <dsn1@mx.customer.example>', 'MIME-Version: 1.0', 'Content-Type: multipart/report; report-type=delivery-status; boundary="BB"', '', '--BB', 'Content-Type: message/delivery-status', '', 'Final-Recipient: rfc822; ann@customer.example', 'Action: failed', 'Status: 5.2.2', '--BB', 'Content-Type: text/rfc822-headers', '', `Message-ID: ${out.messageId}`, '--BB--', ''].join('\r\n'));
    expect(await h.s.channels.mail.poll(h.tenantId, ch.id)).toMatchObject({ bounce: 1 });
    const bounces = (await r.get(`/api/channels/${ch.id}/bounces`).expect(200)).body;
    expect(bounces[0]).toMatchObject({ kind: 'hard', status: '5.2.2', source: 'imap' });
    expect((await r.get(`/api/channels/${ch.id}/sessions/${annSession}`).expect(200)).body.outbox[0].state).toBe('bounced');

    // A new UIDVALIDITY reads from the start; Message-IDs keep it from taking anything twice.
    imap.uidValidity = 8;
    expect(await h.s.channels.mail.poll(h.tenantId, ch.id)).toMatchObject({ read: 6, started: 0, joined: 0, bounce: 0, duplicate: 5 });
    expect(await h.s.db('channel_bounces').where({ channel_id: ch.id })).toHaveLength(1);
  });

  it('B-2303: provider webhooks are signed per channel and thread like IMAP mail', async () => {
    const a = await admin('root', 'system-admin');
    const taId = (await h.s.db('users').where({ username: 'root' }).first()).id;
    await a.agent.post('/api/vault/policies').set('x-csrf-token', a.csrf).send({ subjectKind: 'user', subject: taId, path: 'kv/mail/hooks', capabilities: ['write'], effect: 'allow' }).expect(201);
    await a.agent.put('/api/vault/kv/data/mail/hooks').set('x-csrf-token', a.csrf).send({ data: { mailgun: 'mg-signing-key' } }).expect(201);
    await a.agent.post('/api/vault/policies').set('x-csrf-token', a.csrf).send({ subjectKind: 'user', subject: taId, path: 'kv/mail', capabilities: ['read'], effect: 'allow' }).expect(201);
    const ch = (await a.post('/api/channels', { workspaceId: wsId, kind: 'email', name: 'Hooks', label: 'internal', target: { kind: 'profile', name: 'general' }, reviewMode: 'never', email: { address: 'help@shop.example', mailgunKeyRef: 'vault:mail/hooks#mailgun' } }).expect(201)).body;
    const secret = ch.secrets.webhookSecret as string;
    const url = `/api/public/channels/${ch.publicKey}/email`;
    const generic = (payload: object, key = secret, ts = String(Math.floor(Date.now() / 1000))) => {
      const raw = JSON.stringify(payload);
      return pub().post(`${url}/generic`).set('content-type', 'application/json').set('x-exprsn-timestamp', ts).set('x-exprsn-signature', signGeneric(key, ts, raw)).send(raw);
    };
    await generic({ type: 'message', from: 'bo@customer.example', text: 'hi', messageId: '<w0@c>' }, 'wrong-secret').expect(401);
    await generic({ type: 'message', from: 'bo@customer.example', text: 'hi', messageId: '<w0@c>' }, secret, String(Math.floor(Date.now() / 1000) - 3600)).expect(401);
    const r1 = (await generic({ type: 'message', from: 'bo@customer.example', fromName: 'Bo', subject: 'Help', text: 'My login fails', messageId: '<w1@customer.example>' }).expect(200)).body;
    expect(r1).toMatchObject({ accepted: true, result: { action: 'started' } });
    await drain(h);
    const ours = (mail.to('bo@customer.example')[0] as unknown as { messageId: string }).messageId;
    // Mailgun's inbound route, form-encoded and signed with the Mailgun key.
    const ts = String(Math.floor(Date.now() / 1000));
    const token = 'tok-0123456789abcdef';
    const form = new URLSearchParams({ timestamp: ts, token, signature: signMailgun('mg-signing-key', ts, token), from: 'Bo <bo@customer.example>', subject: 'Re: Help', 'body-plain': 'Still failing', 'Message-Id': '<w2@customer.example>', 'In-Reply-To': ours, References: `<w1@customer.example> ${ours}` }).toString();
    const r2 = (await pub().post(`${url}/mailgun`).set('content-type', 'application/x-www-form-urlencoded').send(form).expect(200)).body;
    expect(r2.result).toMatchObject({ action: 'joined', session: r1.result.session });
    // A replayed Mailgun post is acknowledged and dropped.
    expect((await pub().post(`${url}/mailgun`).set('content-type', 'application/x-www-form-urlencoded').send(form).expect(200)).body.result.action).toBe('duplicate');
    const bad = new URLSearchParams({ timestamp: ts, token: 'tok-other-123456789', signature: signMailgun('nope', ts, 'tok-other-123456789'), from: 'bo@customer.example', 'body-plain': 'x' }).toString();
    await pub().post(`${url}/mailgun`).set('content-type', 'application/x-www-form-urlencoded').send(bad).expect(401);
    // A Mailgun bounce event names our Message-ID.
    const ets = String(Math.floor(Date.now() / 1000));
    const etoken = 'tok-event-1234567890';
    await pub().post(`${url}/mailgun`).set('content-type', 'application/json').send({ signature: { timestamp: ets, token: etoken, signature: signMailgun('mg-signing-key', ets, etoken) }, 'event-data': { event: 'failed', severity: 'permanent', recipient: 'bo@customer.example', message: { headers: { 'message-id': ours.slice(1, -1) } }, 'delivery-status': { code: 550, description: 'No such user' } } }).expect(200);
    const row = await h.s.db('channel_outbox').where({ header_id: ours }).first();
    expect(row.state).toBe('bounced');
    expect((await audits('channel.bounce.recorded')).length).toBe(1);
    // The generic bounce shape too.
    await generic({ type: 'bounce', recipient: 'bo@customer.example', kind: 'complaint' }).expect(200);
    expect(await h.s.db('channel_bounces').where({ channel_id: ch.id, kind: 'complaint' }).first()).toBeTruthy();
    // Unknown keys, chat channels and wrong providers answer 404 or 400.
    await pub().post('/api/public/channels/chn_AAAAAAAAAAAAAAAAAAAAAAAA/email/generic').send('{}').expect(404);
    await pub().post(`${url}/sendgrid`).send('{}').expect(400);
    await drain(h);
    expect(mail.to('bo@customer.example')).toHaveLength(2);
  });

  it('B-2304: a session older than the period is purged; transcripts export as CSV', async () => {
    const a = await admin();
    const ch = await chatChannel(a, { retentionDays: 30 });
    const keep = await chatChannel(a, { name: 'Forever', retentionDays: null });
    const r = await reviewer();
    ollama.reply = () => ({ content: '=SUM(A1) is how' });
    const old = (await pub().post('/api/public/channels/sessions').send({ channel: ch.publicKey }).expect(201)).body;
    const fresh = (await pub().post('/api/public/channels/sessions').send({ channel: ch.publicKey }).expect(201)).body;
    const forever = (await pub().post('/api/public/channels/sessions').send({ channel: keep.publicKey }).expect(201)).body;
    await customer(old.token).send('How do I add, "quickly"?').expect(201);
    await customer(fresh.token).send('Still here').expect(201);

    const csv = await r.get(`/api/channels/${ch.id}/sessions/${old.session.id}/transcript.csv`).expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    const lines = csv.text.trim().split('\r\n');
    expect(lines[0]).toBe('channel,session,seq,time,role,state,via,label,text,original');
    expect(lines[2]).toContain('"How do I add, ""quickly""?"');
    expect(lines[3]).toContain("'=SUM(A1) is how"); // formula injection defused
    expect((await audits('channel.transcript.exported')).length).toBe(1);

    // A whole channel as a job.
    const job = (await r.post(`/api/channels/${ch.id}/exports`, {}).expect(202)).body;
    await drain(h);
    const all = await r.get(`/api/channels/exports/${job.jobId}`).expect(200);
    expect(all.text.trim().split('\r\n')).toHaveLength(1 + 3 + 3);
    const other = await reviewer('ray');
    await other.get(`/api/channels/exports/${job.jobId}`).expect(404);

    // Age the first session (and the forever one) past 30 days.
    const past = Date.now() - 31 * 86_400_000;
    await h.s.db('channel_sessions').whereIn('id', [old.session.id, forever.session.id]).update({ last_activity_at: past });
    await a.post(`/api/channels/${ch.id}/purge`).expect(202);
    await drain(h);
    expect(await h.s.db('channel_sessions').where({ id: old.session.id }).first()).toBeUndefined();
    expect(await h.s.db('channel_messages').where({ session_id: old.session.id })).toEqual([]);
    expect(await h.s.db('channel_sessions').where({ id: fresh.session.id }).first()).toBeTruthy();
    expect(await h.s.db('channel_sessions').where({ id: forever.session.id }).first()).toBeTruthy();
    await customer(old.token).view().expect(401);
    expect((await audits('channel.session.purged'))[0]!.detail).toMatchObject({ sessions: 1, retentionDays: 30 });
    expect(events.find((e) => e.type === 'channel.session.purged')?.data).toMatchObject({ channel: ch.id, sessions: 1 });
  });

  it('channel sessions and messages are moderation objects; reviewers see only their workspaces and clearance', async () => {
    const a = await admin();
    const ch = await chatChannel(a);
    const conf = await chatChannel(a, { name: 'Secret', label: 'confidential' });
    const start = (await pub().post('/api/public/channels/sessions').send({ channel: ch.publicKey }).expect(201)).body;
    await customer(start.token).send('abusive words').expect(201);
    const handler = h.s.moderation.registry.get(SESSION_OBJECT)!;
    const o = (await handler.resolve(h.tenantId, start.session.id))!;
    expect(await handler.text!(o)).toContain('abusive words');
    expect(await handler.hide!(o)).toBe('open');
    await customer(start.token).view().expect(401);
    expect(await handler.restore!({ ...o, state: 'hidden' }, 'open')).toBe(true);
    await customer(start.token).view().expect(200);
    expect(h.s.moderation.registry.get('channel-message')).toBeTruthy();

    const low = await reviewer('ivy', 'internal');
    const listed = (await low.get('/api/channels').expect(200)).body.map((c: { id: string }) => c.id);
    expect(listed).toContain(ch.id);
    expect(listed).not.toContain(conf.id);
    await low.get(`/api/channels/${conf.id}/sessions`).expect(404);
    await low.post('/api/channels', { workspaceId: wsId, kind: 'chat', name: 'x', label: 'internal', target: { kind: 'profile', name: 'general' } }).expect(403);
    const outsider = await localUser(h, 'out', ['flag-reviewer', 'member'], 'confidential');
    void outsider;
    const out = wrap(await login(h, 'out').then((l) => ({ agent: l.agent, csrf: l.csrf, cookie: l.cookie })));
    await out.get(`/api/channels/${ch.id}`).expect(404);
    await a.del(`/api/channels/${ch.id}`).expect(200);
    await customer(start.token).view().expect(401);
  });
});

describe('Sprint 28a: email one-time codes (B-1806)', () => {
  let h: Harness;
  let mail: FakeMail;
  beforeEach(async () => {
    mail = new FakeMail();
    h = await harness({ MFA_EMAIL_SENDS_PER_HOUR: '3' }, { mail });
  });
  afterEach(async () => {
    await h.close();
  });

  const codeFrom = (text: string) => /is (\d{6})\./.exec(text)![1]!;
  /** The newest one-time code sent to an address. */
  const lastCode = async (address: string) => {
    await mail.next(address);
    const codes = mail.to(address).filter((m) => m.subject === 'Your Exprsn-AI one-time code');
    return codeFrom(codes.at(-1)!.text);
  };

  async function enrolled(name: string) {
    const u = await localUser(h, name, ['member']);
    await h.s.users.update(h.tenantId, u.id, { email: `${name}@example.test` });
    const l = await login(h, name);
    expect(l.res.body.stage).toBe('active');
    const begin = (await l.agent.post('/api/me/mfa/email').set('x-csrf-token', l.csrf).send({}).expect(201)).body;
    expect(begin.sentTo).toBe(`${name[0]}***@e***.test`);
    const m = await mail.next(`${name}@example.test`);
    expect(m.subject).toBe('Your Exprsn-AI one-time code');
    expect(m.subject).not.toMatch(/\d{6}/);
    await l.agent.post(`/api/me/mfa/email/${begin.id}/confirm`).set('x-csrf-token', l.csrf).send({ code: codeFrom(m.text) === '000000' ? '111111' : '000000' }).expect(400);
    await l.agent.post(`/api/me/mfa/email/${begin.id}/confirm`).set('x-csrf-token', l.csrf).send({ code: codeFrom(m.text) }).expect(201);
    const factors = (await l.agent.get('/api/me/mfa').expect(200)).body.factors;
    expect(factors).toEqual([expect.objectContaining({ kind: 'email' })]);
    expect((await h.s.db('mfa_factors').where({ user_id: u.id, kind: 'email' }).first()).secret).not.toContain('@');
    return u;
  }

  it('enrols, signs in with a code, and refuses a used or another session\'s code', async () => {
    const u = await enrolled('erin');
    const l = await login(h, 'erin');
    expect(l.res.body).toMatchObject({ stage: 'mfa', mfa: { methods: expect.arrayContaining(['email']) } });
    const sent = (await l.agent.post('/api/auth/mfa/email/send').set('x-csrf-token', l.csrf).send({}).expect(200)).body;
    expect(sent.sentTo).toBe('e***@e***.test');
    const code = await lastCode('erin@example.test');
    // Another pending session cannot use this session's code.
    const other = await login(h, 'erin');
    await other.agent.post('/api/auth/mfa/email').set('x-csrf-token', other.csrf).send({ code }).expect(401);
    const done = (await l.agent.post('/api/auth/mfa/email').set('x-csrf-token', l.csrf).send({ code }).expect(200)).body;
    expect(done).toMatchObject({ authenticated: true, stage: 'active' });
    expect((await h.s.audit.list(h.tenantId, { action: 'auth.mfa.verified' })).some((e) => JSON.stringify(e.target).includes('email code'))).toBe(true);
    const used = await h.s.db('mfa_email_codes').where({ user_id: u.id, purpose: 'signin' }).whereNotNull('used_at');
    expect(used.length).toBeGreaterThan(0);
    expect(used[0].code_hash).not.toBe(code);
  });

  it('a sixth wrong code locks like a wrong TOTP', async () => {
    await enrolled('finn');
    const lockout = async (path: string, before?: (agent: Client['agent'], csrf: string) => Promise<void>) => {
      const l = await login(h, 'finn');
      if (before) await before(l.agent, l.csrf);
      const statuses: number[] = [];
      const remaining: unknown[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await l.agent.post(path).set('x-csrf-token', l.csrf).send({ code: '000001' });
        statuses.push(res.status);
        remaining.push(res.body.attempts_remaining ?? res.body.detail);
      }
      return { statuses, remaining, agent: l.agent, csrf: l.csrf };
    };
    const email = await lockout('/api/auth/mfa/email', async (agent, csrf) => void (await agent.post('/api/auth/mfa/email/send').set('x-csrf-token', csrf).send({}).expect(200)));
    // A TOTP factor on another account, for the same sequence.
    await localUser(h, 'tina', ['member']);
    const t0 = await login(h, 'tina');
    const begin = (await t0.agent.post('/api/me/mfa/totp').set('x-csrf-token', t0.csrf).send({}).expect(201)).body;
    await t0.agent.post(`/api/me/mfa/totp/${begin.id}/confirm`).set('x-csrf-token', t0.csrf).send({ code: totp.generate(begin.secret) }).expect(201);
    const tl = await login(h, 'tina');
    const tStatuses: number[] = [];
    const tRemaining: unknown[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await tl.agent.post('/api/auth/mfa/totp').set('x-csrf-token', tl.csrf).send({ code: '000001' });
      tStatuses.push(res.status);
      tRemaining.push(res.body.attempts_remaining ?? res.body.detail);
    }
    expect(email.statuses).toEqual(tStatuses);
    expect(email.remaining).toEqual(tRemaining);
    expect(email.remaining.slice(0, 4)).toEqual([4, 3, 2, 1]);
    expect(email.remaining[4]).toMatch(/Too many wrong codes/);
    expect(email.statuses.slice(0, 4)).toEqual([401, 401, 401, 401]);
    expect(email.statuses[5]).toBe(401);
    // The pending session is gone: even the right code no longer works on it.
    const after = await email.agent.post('/api/auth/mfa/email/send').set('x-csrf-token', email.csrf).send({});
    expect(after.status).toBe(401);
    expect((await h.s.audit.list(h.tenantId, { action: 'auth.mfa.failed' })).filter((e) => JSON.stringify(e.target).includes('email code')).length).toBeGreaterThanOrEqual(5);
  });

  it('sends at most MFA_EMAIL_SENDS_PER_HOUR codes', async () => {
    await enrolled('gus'); // one send for the enrolment
    const l = await login(h, 'gus');
    await l.agent.post('/api/auth/mfa/email/send').set('x-csrf-token', l.csrf).send({}).expect(200);
    await l.agent.post('/api/auth/mfa/email/send').set('x-csrf-token', l.csrf).send({}).expect(200);
    await l.agent.post('/api/auth/mfa/email/send').set('x-csrf-token', l.csrf).send({}).expect(429);
    expect(PASSWORD).toBeTruthy();
  });
});
