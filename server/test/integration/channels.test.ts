/*
 * Sprint 28a (1.4.0), customer-service channels and email codes, against real databases. Each block runs when its
 * variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 030_channels; a chat channel answers an anonymous customer through the
 *                                  fake Ollama (sealed transcript); two instances add messages to one session at once
 *                                  (distinct sequence numbers); a held reply edited by a reviewer reaches the customer
 *                                  as edited; generic webhook mail starts a session, a reply in the thread joins it,
 *                                  the same message taken by two instances at once is taken once; the outbox sends
 *                                  with threading headers; a bounce report is recorded once; retention purges an old
 *                                  session; an email code is used once
 */
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { loadPrincipal } from '../../src/http/middleware.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices, type Services } from '../../src/services.js';
import { FakeMail } from '../fake-account.js';
import { FakeOllama } from '../fake-ollama.js';
import { testConfig, type Harness } from '../helpers.js';
import { seedGateway } from '../seed-gateway.js';

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`customer-service channels on ${d.name}`, () => {
    it('migrates 030_channels and runs chat and email channels, held replies, threading and retention', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url! });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const mail = new FakeMail();
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics(), { mail });
      const db2 = createDb(cfg);
      const s2 = createServices(cfg, db2, createLogger('silent', false), new Metrics(), { mail });
      const ollama = await new FakeOllama().start();
      const drain = async (x: Services) => {
        for (let i = 0; i < 20; i++) if (!(await x.jobs.runDue())) return;
      };
      try {
        for (const t of ['channels', 'channel_sessions', 'channel_messages', 'channel_threads', 'channel_outbox', 'channel_bounces', 'channel_imap_cursors', 'mfa_email_codes']) expect(await db.schema.hasTable(t), t).toBe(true);
        await bootstrap(s);
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        await seedGateway({ s, tenantId: tenant.id } as unknown as Harness, ollama);
        const ws = await s.tenants.createWorkspace(tenant.id, 'Support', 'confidential');
        const person = async (username: string, roles: string[]) => {
          const u = await s.users.create(tenant.id, { username, displayName: username.toUpperCase(), clearance: 'confidential' });
          await s.users.update(tenant.id, u.id, { clearance_direct: 'confidential' });
          await s.users.setRoles(u.id, 'direct', roles);
          await s.tenants.addMember(ws.id, u.id);
          const p = (await loadPrincipal(s, tenant.id, u.id, {}))!;
          p.workspaceId = ws.id;
          return { u, ctx: { p, ip: null } };
        };
        const admin = await person('ada', ['tenant-admin']);
        const rev = await person('rae', ['flag-reviewer', 'member']);

        // B-2301: an anonymous customer gets an answer at the channel's label, sealed at rest.
        ollama.reply = (msgs) => ({ content: `Answer: ${msgs[msgs.length - 1]!.content}` });
        const chat = await s.channels.create(admin.ctx, { workspaceId: ws.id, kind: 'chat', name: 'Web', label: 'internal', target: { kind: 'profile', name: 'general' }, reviewMode: 'escalated' });
        const start = await s.channels.startCustomer(chat.publicKey, {}, '10.0.0.1');
        const sent = await s.channels.customerSend(start.token, 'Where is my order?', '10.0.0.1');
        expect(sent.reply).toMatchObject({ state: 'delivered', text: 'Answer: Where is my order?' });
        const rows = await db('channel_messages').where({ session_id: start.session.id });
        expect(rows.every((r: { body: string; label: string }) => !String(r.body).includes('order') && r.label === 'internal')).toBe(true);

        // Two instances add messages to one session at the same moment: every message gets its own sequence number.
        const { sess } = await s.channels.customerAuth(start.token);
        await Promise.all(Array.from({ length: 6 }, (_, i) => (i % 2 ? s : s2).channels.addMessage(sess, { role: 'notice', state: 'delivered', via: 'web', text: `n${i}` })));
        const seqs = ((await db('channel_messages').where({ session_id: sess.id }).select('seq')) as { seq: number }[]).map((r) => Number(r.seq)).sort((a, b) => a - b);
        expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));

        // B-2302: an edited reply reaches the customer as edited.
        await s.channels.customerEscalate(start.token, 'a person please', null);
        const held = await s.channels.customerSend(start.token, 'Refund?', null);
        expect(held.reply).toMatchObject({ state: 'pending', text: null });
        const queue = await s.channels.heldQueue(rev.ctx.p);
        expect(queue).toHaveLength(1);
        await s.channels.decideHeld(rev.ctx, queue[0]!.id, { decision: 'edit', text: 'A colleague will reply today.' });
        const view = await s.channels.customerView((await s.channels.row(tenant.id, chat.id))!, sess, 0);
        expect(view.messages.at(-1)).toMatchObject({ role: 'assistant', text: 'A colleague will reply today.' });
        expect(await db('guard_flags').where({ id: queue[0]!.flag!.id }).first('state')).toMatchObject({ state: 'approved' });

        // B-2303: generic webhook mail, threading, a race on one message, the outbox and a bounce.
        const email = await s.channels.create(admin.ctx, { workspaceId: ws.id, kind: 'email', name: 'Mail', label: 'internal', target: { kind: 'profile', name: 'general' }, reviewMode: 'never', email: { address: 'help@shop.example', fromName: null, imap: null, smtp: null, mailgunKeyRef: null } });
        const c = (await s.channels.row(tenant.id, email.id))!;
        const first = await s.channels.mail.ingest(c, { kind: 'message', messageId: 'c1@customer.example', inReplyTo: null, references: [], from: { address: 'ann@customer.example', name: 'Ann' }, subject: 'Order', text: 'Where?', automatic: false }, 'generic');
        expect(first.action).toBe('started');
        await drain(s);
        const out = mail.to('ann@customer.example')[0] as unknown as { messageId: string; inReplyTo: string };
        expect(out.inReplyTo).toBe('<c1@customer.example>');
        const reply = { kind: 'message' as const, messageId: 'c2@customer.example', inReplyTo: out.messageId.slice(1, -1), references: ['c1@customer.example'], from: { address: 'ann@customer.example', name: null }, subject: 'Re: Order', text: 'Thanks', automatic: false };
        const [a, b] = await Promise.all([s.channels.mail.ingest(c, reply, 'generic'), s2.channels.mail.ingest((await s2.channels.row(tenant.id, email.id))!, reply, 'generic')]);
        expect([a.action, b.action].sort()).toEqual(['duplicate', 'joined']);
        expect(await db('channel_sessions').where({ channel_id: email.id })).toHaveLength(1);
        await drain(s);
        expect(mail.to('ann@customer.example')).toHaveLength(2);
        const bounce = { kind: 'bounce' as const, reportId: 'dsn-1@mx', messageId: out.messageId.slice(1, -1), recipient: 'ann@customer.example', type: 'hard' as const, status: '5.1.1', reason: null };
        await Promise.all([s.channels.mail.ingest(c, bounce, 'imap'), s2.channels.mail.ingest(c, bounce, 'imap')]);
        expect(await db('channel_bounces').where({ channel_id: email.id })).toHaveLength(1);
        expect((await db('channel_outbox').where({ header_id: out.messageId }).first()).state).toBe('bounced');

        // B-2304: a session older than the period is purged.
        await db('channel_sessions').where({ id: sess.id }).update({ last_activity_at: Date.now() - 40 * 86_400_000 });
        expect(await s.channels.purgeExpired(tenant.id)).toMatchObject({ sessions: 1 });
        expect(await db('channel_sessions').where({ id: sess.id }).first()).toBeUndefined();
        expect(await db('channel_messages').where({ session_id: sess.id })).toEqual([]);

        // B-1806: an email code is used once.
        await s.users.update(tenant.id, rev.u.id, { email: 'rae@example.test' });
        const enrol = await s.mfa.beginEmail(rev.u.id, 'rae@example.test', 'Email', 60_000);
        expect(await s.mfa.confirmEmail(rev.u.id, enrol.id, enrol.code === '000000' ? '111111' : '000000')).toBe(false);
        const [x, y] = await Promise.all([s.mfa.confirmEmail(rev.u.id, enrol.id, enrol.code), s2.mfa.confirmEmail(rev.u.id, enrol.id, enrol.code)]);
        expect([x, y].filter(Boolean)).toHaveLength(1);
      } finally {
        await ollama.stop();
        await s2.close();
        await s.close();
        await db2.destroy();
        await db.destroy();
      }
    });
  });
}
