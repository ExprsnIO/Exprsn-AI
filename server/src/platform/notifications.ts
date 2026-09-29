import { ulid } from 'ulid';
import type { Logger } from 'pino';
import nodemailer, { type Transporter } from 'nodemailer';
import type { Db } from '../db/knex.js';
import type { Label } from '../authz/labels.js';
import { TOPICS, type Bus } from './bus.js';

export interface NotificationRow {
  id: string;
  tenant_id: string;
  user_id: string;
  kind: string;
  title: string;
  body: string | null;
  route: string | null;
  label: Label;
  created_at: number;
  read_at: number | null;
}

export interface NotifyInput {
  tenantId: string;
  userIds: string[];
  kind: string;
  title: string;
  body?: string;
  route?: string;
  label?: Label;
  /** Also send by email to users with an address (when SMTP is configured). */
  email?: boolean;
}

export const toClient = (n: NotificationRow) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, route: n.route, label: n.label, createdAt: Number(n.created_at), read: n.read_at != null });

/**
 * Notifications: stored per user, pushed to the user's sockets as they happen, and optionally emailed over SMTP.
 * Email carries only the title and a link, never the content of labelled data.
 */
export class Notifications {
  private readonly mail: Transporter | null;

  constructor(
    private readonly db: Db,
    private readonly bus: Bus,
    private readonly log: Logger,
    private readonly o: { smtpUrl?: string; from: string; publicUrl: string }
  ) {
    this.mail = o.smtpUrl ? nodemailer.createTransport(o.smtpUrl) : null;
  }

  get emailEnabled(): boolean {
    return this.mail !== null;
  }

  async notify(input: NotifyInput): Promise<NotificationRow[]> {
    const users = [...new Set(input.userIds)];
    if (!users.length) return [];
    const t = Date.now();
    const rows: NotificationRow[] = users.map((u) => ({
      id: ulid(),
      tenant_id: input.tenantId,
      user_id: u,
      kind: input.kind,
      title: input.title.slice(0, 200),
      body: input.body?.slice(0, 1000) ?? null,
      route: input.route ?? null,
      label: input.label ?? 'internal',
      created_at: t,
      read_at: null
    }));
    await this.db('notifications').insert(rows);
    for (const r of rows) this.bus.publish(TOPICS.notification, { userId: r.user_id, notification: toClient(r) });
    if (input.email && this.mail) void this.sendEmail(rows).catch((err: Error) => this.log.warn({ err: err.message }, 'notification email failed'));
    return rows;
  }

  private async sendEmail(rows: NotificationRow[]): Promise<void> {
    const users = (await this.db('users').whereIn('id', rows.map((r) => r.user_id)).whereNotNull('email').select('id', 'email')) as { id: string; email: string }[];
    const byId = new Map(users.map((u) => [u.id, u.email]));
    for (const r of rows) {
      const to = byId.get(r.user_id);
      if (!to) continue;
      const link = r.route ? `${this.o.publicUrl.replace(/\/$/, '')}/#/${r.route}` : this.o.publicUrl;
      await this.mail!.sendMail({ from: this.o.from, to, subject: r.title, text: `${r.title}\n\nOpen the console: ${link}\n` });
      await this.db('notifications').where({ id: r.id }).update({ emailed_at: Date.now() });
    }
  }

  async list(userId: string, limit = 50): Promise<NotificationRow[]> {
    return this.db('notifications').where({ user_id: userId }).orderBy('created_at', 'desc').limit(limit);
  }

  async markRead(userId: string, ids?: string[]): Promise<number> {
    const q = this.db('notifications').where({ user_id: userId, read_at: null });
    if (ids) q.whereIn('id', ids);
    return q.update({ read_at: Date.now() });
  }

  /** Users in a tenant holding any of the given roles and active. */
  async usersWithRoles(tenantId: string, roles: string[]): Promise<string[]> {
    const rows = await this.db('users as u').join('user_roles as r', 'r.user_id', 'u.id').where({ 'u.tenant_id': tenantId, 'u.state': 'active' }).whereIn('r.role', roles).distinct('u.id');
    return rows.map((r: { id: string }) => r.id);
  }
}
