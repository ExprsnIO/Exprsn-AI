import request from 'supertest';
import { localUser, type Harness } from './helpers.js';

/** Sprint 30 (B-31): DAV clients for tests: an app password made directly, requests with HTTP Basic. */

type Agent = (method: string, path: string) => request.Test;

export function davClient(h: Harness, username: string, password: string): Agent {
  return (method, path) => (request(h.app) as unknown as Record<string, (p: string) => request.Test>)[method.toLowerCase()]!(path).auth(username, password);
}

export async function davUser(h: Harness, name: string, o: { clearance?: 'public' | 'internal' | 'confidential'; roles?: string[]; scopes?: ('caldav' | 'carddav' | 'webdav')[]; email?: boolean } = {}) {
  const user = await localUser(h, name, o.roles ?? ['member'], o.clearance ?? 'internal');
  if (o.email !== false) await h.s.db('users').where({ id: user.id }).update({ email: `${name}@example.test` });
  const { password, row } = await h.s.dav.passwords.create({ tenantId: h.tenantId, userId: user.id, name: 'Test device', scopes: o.scopes ?? ['caldav', 'carddav', 'webdav'], ttlDays: null });
  return { user, password, row, dav: davClient(h, name, password) };
}

export const event = (uid: string, extra: string, comp = 'VEVENT') => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', `BEGIN:${comp}`, `UID:${uid}`, 'DTSTAMP:20261001T000000Z', ...extra.split('\n').filter(Boolean), `END:${comp}`, 'END:VCALENDAR', ''].join('\r\n');
export const card = (uid: string, fn: string, extra = '') => ['BEGIN:VCARD', 'VERSION:3.0', `UID:${uid}`, `FN:${fn}`, ...extra.split('\n').filter(Boolean), 'END:VCARD', ''].join('\r\n');

