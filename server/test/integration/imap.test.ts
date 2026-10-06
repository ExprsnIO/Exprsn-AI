/*
 * B-3605 (Sprint 34): the email channel's IMAP adapter (B-2303) against a real IMAP server instead of the in-memory
 * fetcher of sprint28a-channels.test.ts. Runs when TEST_IMAP_URL is set:
 *
 *   TEST_IMAP_URL        imaps://<user>:<password>@<host>:<port>/<mailbox>   the channel's mailbox (implicit TLS)
 *   TEST_IMAP_SMTP_URL   smtp://<host>:<port>                                 where the test delivers mail to it
 *   NODE_EXTRA_CA_CERTS  the CA of the server's certificate (verified against the host name, as in production)
 *
 * `test/integration/greenmail.sh <dir>` starts GreenMail with a throwaway CA and prints the three; CI runs it in the
 * integration job. A message delivered to the mailbox by SMTP becomes a channel thread on the next poll (through the
 * `channels.imap-poll` job and imapflow), is answered through the outbox, and a reply in the thread joins the session;
 * the mailbox is opened read-only (nothing is marked seen), the cursor keeps the UID, and a wrong password is recorded on
 * the cursor and audited once.
 */
import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeMail } from '../fake-account.js';
import { FakeOllama } from '../fake-ollama.js';
import { harness, localUser, loginAdmin, type Harness } from '../helpers.js';
import { drain } from '../retrieval-seed.js';
import { seedGateway } from '../seed-gateway.js';

const imapUrl = process.env.TEST_IMAP_URL;
const smtpUrl = process.env.TEST_IMAP_SMTP_URL;

describe.skipIf(!imapUrl || !smtpUrl)('the IMAP channel adapter against a real IMAP server (B-3605)', () => {
  const u = new URL(imapUrl ?? 'imaps://x:y@localhost:3993/INBOX');
  const box = { host: u.hostname, port: Number(u.port || 993), user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password), mailbox: decodeURIComponent(u.pathname.slice(1)) || 'INBOX' };
  const address = box.user.includes('@') ? box.user : `${box.user}@shop.example`;
  let h: Harness;
  let ollama: FakeOllama;
  let mail: FakeMail;

  const deliver = async (msg: { from: string; subject: string; text: string; messageId: string; inReplyTo?: string; references?: string[] }) => {
    const s = new URL(smtpUrl!);
    const t = nodemailer.createTransport({ host: s.hostname, port: Number(s.port || 25), secure: false, ignoreTLS: true });
    try {
      await t.sendMail({ to: address, ...msg });
    } finally {
      t.close();
    }
  };
  /** What the mailbox holds now, read directly (not through the adapter). */
  const inspect = async () => {
    const c = new ImapFlow({ host: box.host, port: box.port, secure: true, auth: { user: box.user, pass: box.pass }, logger: false });
    await c.connect();
    try {
      const st = await c.status(box.mailbox, { messages: true, unseen: true });
      if (!st) throw new Error(`no mailbox ${box.mailbox}`);
      return { messages: st.messages ?? 0, unseen: st.unseen ?? 0 };
    } finally {
      await c.logout();
    }
  };
  /** Polls until the mailbox holds at least n messages (SMTP delivery is asynchronous on the server). */
  const delivered = async (n: number) => {
    for (let i = 0; i < 100; i++) {
      if ((await inspect()).messages >= n) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`the mailbox did not reach ${n} messages`);
  };

  beforeEach(async () => {
    mail = new FakeMail();
    h = await harness({ SMTP_URL: '' }, { mail });
    ollama = await new FakeOllama().start();
    await seedGateway(h, ollama);
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop().catch(() => undefined);
  });

  it('a message delivered to the mailbox becomes a channel thread; a reply in the thread joins it', async () => {
    const before = (await inspect()).messages;
    await localUser(h, 'root', ['system-admin'], 'confidential');
    const a = await loginAdmin(h, 'root');
    const post = (p: string, b: object) => a.agent.post(p).set('x-csrf-token', a.csrf).send(b);
    const rootId = (await h.s.db('users').where({ username: 'root' }).first()).id as string;
    await post('/api/vault/policies', { subjectKind: 'user', subject: rootId, path: 'kv/mail', capabilities: ['read', 'write'], effect: 'allow' }).expect(201);
    await a.agent.put('/api/vault/kv/data/mail/support').set('x-csrf-token', a.csrf).send({ data: { password: box.pass, wrong: 'not-the-password' } }).expect(201);
    const ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Support', 'internal')).id;
    const imap = { host: box.host, port: box.port, secure: true, user: box.user, passwordRef: 'vault:mail/support#password', mailbox: box.mailbox };
    const ch = (await post('/api/channels', { workspaceId: ws, kind: 'email', name: 'Mail help', label: 'internal', target: { kind: 'profile', name: 'general' }, reviewMode: 'never', email: { address, fromName: 'Shop', imap } }).expect(201)).body as { id: string };

    // Earlier runs against the same mailbox leave mail there: this run's customer and subject are its own.
    const poll = async () => {
      await h.s.jobs.enqueue({ tenantId: h.tenantId, type: 'channels.imap-poll', payload: { channelId: ch.id }, dedupeKey: `t:${randomUUID()}` });
      await drain(h);
      return h.s.db('channel_imap_cursors').where({ channel_id: ch.id }).first() as Promise<{ uid_validity: number; last_uid: number; last_error: string | null; polled_at: number }>;
    };
    // This run's sessions (the customer's address is sealed at rest; the review API opens it).
    const mine = async () => ((await a.agent.get(`/api/channels/${ch.id}/sessions`).expect(200)).body as { id: string; customer: { email?: string } }[]).filter((x) => x.customer.email === ann);
    const run = randomUUID().slice(0, 8);
    const ann = `ann-${run}@customer.example`;

    ollama.reply = (msgs) => ({ content: `We are on it: ${msgs[msgs.length - 1]!.content}` });
    await deliver({ from: `Ann <${ann}>`, subject: `Order ${run}`, text: 'Where is my order?\n', messageId: `<c1-${run}@customer.example>` });
    await delivered(before + 1);
    const c1 = await poll();
    expect(c1.last_error).toBeNull();
    expect(c1.uid_validity).toBeGreaterThan(0);
    const first = await mine();
    expect(first).toHaveLength(1);

    // The thread: the customer's message, the answer sent from the outbox with threading headers.
    const out = (await mail.next(ann, 0, 10_000)) as unknown as { subject: string; text: string; inReplyTo: string; messageId: string };
    expect(out).toMatchObject({ subject: `Re: Order ${run}`, inReplyTo: `<c1-${run}@customer.example>` });
    const r = await a.agent.get(`/api/channels/${ch.id}/sessions/${first[0]!.id}`).expect(200);
    expect(r.body.transcript.map((m: { role: string; text: string }) => [m.role, m.text])).toEqual([
      ['customer', 'Where is my order?'],
      ['assistant', 'We are on it: Where is my order?']
    ]);
    expect(r.body.customer).toMatchObject({ kind: 'email', email: ann, name: 'Ann' });

    // Read-only: the adapter marks nothing seen; the cursor holds the newest UID, so a second poll reads nothing.
    expect((await inspect()).unseen).toBeGreaterThanOrEqual(1);
    const again = await h.s.channels.mail.poll(h.tenantId, ch.id);
    expect(again).toMatchObject({ read: 0 });

    // The customer replies in the thread: it joins the same session.
    await deliver({ from: ann, subject: `Re: Order ${run}`, text: 'Thanks, any date?\n', messageId: `<c2-${run}@customer.example>`, inReplyTo: out.messageId, references: [`<c1-${run}@customer.example>`, out.messageId] });
    await delivered(before + 2);
    expect(await h.s.channels.mail.poll(h.tenantId, ch.id)).toMatchObject({ read: 1, joined: 1 });
    await drain(h);
    expect((await mine()).map((x) => x.id)).toEqual([first[0]!.id]);
    expect(mail.to(ann)).toHaveLength(2);
    expect((await poll()).last_uid).toBeGreaterThan(c1.last_uid);

    // A wrong password: the poll records the error on the cursor and audits it once, not on every tick.
    await a.agent.patch(`/api/channels/${ch.id}`).set('x-csrf-token', a.csrf).send({ email: { address, fromName: 'Shop', imap: { ...imap, passwordRef: 'vault:mail/support#wrong' } } }).expect(200);
    const failed = await poll();
    expect(failed.last_error).toBeTruthy();
    await poll();
    expect(await h.s.audit.list(h.tenantId, { action: 'channel.imap.failed' })).toHaveLength(1);
  });
});
