import type Database from 'better-sqlite3';
import type { ConnectionSpec, DataDriver, QueryResult, RowMutation } from '../src/connections/drivers.js';
import { checkMutation } from '../src/connections/drivers.js';
import { localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

/** Clients in one workspace: a designer (apps:design), a member, and a designer who also manages connections. */
export function clients(h: Harness, wsId: string) {
  async function wrap(c: { agent: Client['agent']; csrf: string }) {
    const send = (method: 'post' | 'patch' | 'put' | 'delete', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
    await send('put', '/api/me/workspace', { workspaceId: wsId }).expect(200);
    return { ...c, post: (p: string, b?: object) => send('post', p, b), patch: (p: string, b?: object) => send('patch', p, b), put: (p: string, b?: object) => send('put', p, b), del: (p: string) => send('delete', p), get: (p: string) => c.agent.get(p) };
  }
  return {
    async member(name: string, clearance: 'internal' | 'confidential' | 'public' = 'internal') {
      const u = await localUser(h, name, ['member'], clearance);
      await h.s.tenants.addMember(wsId, u.id);
      return { user: u, ...(await wrap(await login(h, name))) };
    },
    async designer(name = 'dee', roles: string[] = ['workflow-admin', 'member']) {
      const u = await localUser(h, name, roles, 'confidential');
      await h.s.tenants.addMember(wsId, u.id);
      return { user: u, ...(await wrap(await loginAdmin(h, name))) };
    }
  };
}

/** A PostgreSQL stand-in on SQLite for the outside-table tests: reads rows and writes them (B-8501). */
export class SqliteTableDriver implements DataDriver {
  readonly mutations: RowMutation[] = [];
  constructor(
    private readonly db: Database.Database,
    readonly spec: ConnectionSpec
  ) {}

  async test() {
    if (this.spec.password !== 'right') throw new Error('password authentication failed');
    return { version: 'SQLite', readOnly: false, health: 'healthy' as const, detail: `Account ${this.spec.username} holds write grants.` };
  }

  async introspect() {
    const objs = this.db.prepare("select name, type from sqlite_master where type in ('table','view') and name not like 'sqlite_%' order by name").all() as { name: string; type: string }[];
    return objs.map((o) => ({ name: `public.${o.name}`, kind: o.type === 'view' ? ('view' as const) : ('table' as const), columns: (this.db.prepare(`pragma table_info("${o.name}")`).all() as { name: string; type: string }[]).map((c) => ({ name: c.name, type: c.type })) }));
  }

  private run(sql: string, params: unknown[], limit: number): QueryResult {
    const st = this.db.prepare(sql.replace(/public\./g, ''));
    const rows = st.raw(true).all(...params) as unknown[][];
    return { columns: st.columns().map((c) => c.name), rows: rows.slice(0, limit), capped: rows.length > limit, estimate: null };
  }

  async query(_c: unknown, text: string, opts: { limit: number }) {
    return this.run(`SELECT * FROM (${text.trim().replace(/;\s*$/, '')}) LIMIT ${opts.limit + 1}`, [], opts.limit);
  }

  async rows(object: string, opts: { watermarkColumn: string | null; after: string | null; limit: number }) {
    const wm = opts.watermarkColumn;
    return this.run(`SELECT * FROM ${object}${wm && opts.after != null ? ` WHERE ${wm} > ?` : ''}${wm ? ` ORDER BY ${wm}` : ''} LIMIT ${opts.limit + 1}`, wm && opts.after != null ? [opts.after] : [], opts.limit);
  }

  async mutate(object: string, op: RowMutation) {
    checkMutation(op);
    this.mutations.push(op);
    const table = object.replace(/^public\./, '');
    const cols = Object.keys(op.values);
    const norm = (v: unknown) => (typeof v === 'boolean' ? (v ? 1 : 0) : v);
    if (op.kind === 'insert') {
      const all = cols.includes(op.keyColumn) ? cols : [op.keyColumn, ...cols];
      const vals = all.map((k) => (k === op.keyColumn && !cols.includes(k) ? op.key : norm(op.values[k])));
      return { affected: this.db.prepare(`INSERT INTO "${table}" (${all.map((c) => `"${c}"`).join(', ')}) VALUES (${all.map(() => '?').join(', ')})`).run(...vals).changes };
    }
    if (op.kind === 'update') return { affected: this.db.prepare(`UPDATE "${table}" SET ${cols.map((c) => `"${c}" = ?`).join(', ')} WHERE "${op.keyColumn}" = ?`).run(...cols.map((c) => norm(op.values[c])), op.key).changes };
    return { affected: this.db.prepare(`DELETE FROM "${table}" WHERE "${op.keyColumn}" = ?`).run(op.key).changes };
  }
}
