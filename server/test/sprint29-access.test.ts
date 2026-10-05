import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { OPENAPI_FILE } from './openapi-routes.js';
import type { AddressInfo } from 'node:net';
import { io as ioClient } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOPICS } from '../src/platform/bus.js';
import { attachRealtime } from '../src/realtime/socket.js';
import { canGrant, customRolesOf, isRole, permissionsFor, PERMISSIONS, rolesRequireMfa, setCustomRoles, type Permission } from '../src/authz/permissions.js';
import { explain, type Principal } from '../src/authz/policy.js';
import { loadPrincipal, workspacesFor } from '../src/http/middleware.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

/**
 * Sprint 29 (1.5.0), B-33: custom roles (B-3302), the role matrix over the API (B-3301), the effective-access matrix
 * (B-3303) and access reviews (B-3305). The route registry and docs/permissions.md are route-registry.test.ts.
 */

const send = (c: Client, method: 'post' | 'patch' | 'delete', url: string, body: unknown = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body as object);

describe('custom roles in the catalogue (B-3302)', () => {
  const T1 = 't1-tenant-000000000000000000';
  const T2 = 't2-tenant-000000000000000000';
  const role = { id: 'custom-01hzzzzzzzzzzzzzzzzzzzzzzz', tenantId: T1, name: 'Model reader', description: '', permissions: ['models:read', 'audit:read'] as Permission[], requiresMfa: true, grantableBy: ['tenant-admin'], version: 1 };

  afterAll(() => {
    setCustomRoles(T1, []);
  });

  it('resolves a custom role like a built-in one, only inside its tenant', () => {
    setCustomRoles(T1, [role]);
    expect(customRolesOf(T1).map((r) => r.id)).toEqual([role.id]);
    expect(isRole(role.id)).toBe(false); // input validated without a tenant never accepts a custom role
    expect(isRole(role.id, T1)).toBe(true);
    expect(isRole(role.id, T2)).toBe(false);
    expect([...permissionsFor([role.id], T1)].sort()).toEqual(['audit:read', 'models:read']);
    expect(permissionsFor([role.id], T2).size).toBe(0);
    expect(rolesRequireMfa([role.id], T1)).toBe(true);
    const p: Principal = { kind: 'user', userId: 'u', tenantId: T1, tenantSlug: 't1', username: 'u', displayName: 'U', roles: [role.id], clearance: 'internal', scopes: null, sessionId: null, apiKeyId: null, mfa: true };
    const out = explain(p, 'audit:read', { tenantId: T1 });
    expect(out.decision.allow).toBe(true);
    expect(out.steps[0]!.detail).toContain('Model reader');
    expect(explain({ ...p, tenantId: T2 }, 'audit:read', {}).decision).toMatchObject({ allow: false, step: 'role' });
  });

  it('lets a granter grant a custom role only with a grantableBy role and every permission it carries', () => {
    setCustomRoles(T1, [role, { ...role, id: 'custom-01hyyyyyyyyyyyyyyyyyyyyyyy', name: 'Wide', grantableBy: ['identity-admin'] }]);
    expect(canGrant(['tenant-admin'], role.id, T1)).toBe(true);
    expect(canGrant(['tenant-admin'], role.id)).toBe(false);
    expect(canGrant(['tenant-admin'], role.id, T2)).toBe(false);
    expect(canGrant(['identity-admin'], role.id, T1)).toBe(false); // not in grantableBy
    expect(canGrant(['identity-admin'], 'custom-01hyyyyyyyyyyyyyyyyyyyyyyy', T1)).toBe(false); // in it, but does not hold audit:read
    setCustomRoles(T1, []);
    expect(isRole(role.id, T1)).toBe(false);
  });
});

describe('Sprint 29: permission matrices, custom roles, effective access and access reviews', () => {
  let h: Harness;
  let ta: Client;
  let tb: Client;
  let taId: string;

  beforeAll(async () => {
    h = await harness();
    taId = (await localUser(h, 'ta', ['tenant-admin'], 'restricted')).id;
    await localUser(h, 'tb', ['tenant-admin'], 'restricted');
    ta = await loginAdmin(h, 'ta');
    tb = await loginAdmin(h, 'tb');
  });
  afterAll(async () => {
    await h.close();
  });

  const auditActions = async () => ((await h.s.db('audit_events').where({ tenant_id: h.tenantId }).orderBy('seq').select('action')) as { action: string }[]).map((r) => r.action);

  describe('custom roles (B-3302)', () => {
    it('refuses a tenant admin a role holding platform:manage', async () => {
      const res = await send(ta, 'post', '/api/authz/roles', { name: 'Platform helper', permissions: ['models:read', 'platform:manage'] }).expect(403);
      expect(res.body).toMatchObject({ step: 'role', permissions: ['platform:manage'] });
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(await h.s.db('custom_roles').where({ name: 'Platform helper' }).first()).toBeUndefined();
    });

    it('refuses unknown permissions, a second-factor requirement below the built-ins and a taken name', async () => {
      await send(ta, 'post', '/api/authz/roles', { name: 'Odd', permissions: ['models:fly'] }).expect(400);
      await send(ta, 'post', '/api/authz/roles', { name: 'Auditor lite', permissions: ['audit:read'], requiresMfa: false }).expect(400);
      await send(ta, 'post', '/api/authz/roles', { name: 'Tenant admin', permissions: ['models:read'] }).expect(409);
      await send(ta, 'post', '/api/authz/roles', { name: 'Odd', permissions: ['models:read'], grantableBy: ['nobody'] }).expect(400);
    });

    it('creates a member-level role at once and it works wherever a built-in role does', async () => {
      const created = (await send(ta, 'post', '/api/authz/roles', { name: 'Catalogue reader', description: 'Reads the model catalogue', permissions: ['files:read', 'models:read'], requiresMfa: false }).expect(201)).body;
      expect(created).toMatchObject({ pending: false, role: { builtIn: false, state: 'active', version: 1, permissions: ['models:read', 'files:read'], requiresMfa: false, grantableBy: ['system-admin', 'tenant-admin'] }, version: { version: 1, state: 'applied', dualControl: false } });
      const id = created.role.id as string;
      expect(id).toMatch(/^custom-[0-9a-z]{26}$/);

      const u = await localUser(h, 'cora', ['flag-reviewer'], 'internal');
      const cora = await login(h, 'cora');
      await cora.agent.get('/api/admin/models').expect(403);
      // Assignment through the users screen, as for a built-in role.
      expect((await ta.agent.get('/api/admin/roles').expect(200)).body.map((r: { id: string }) => r.id)).toContain(id);
      await send(ta, 'patch', `/api/admin/users/${u.id}`, { roles: ['flag-reviewer', id] }).expect(200);
      const again = await login(h, 'cora');
      await again.agent.get('/api/admin/models').expect(200);
      const me = (await again.agent.get('/api/me').expect(200)).body;
      expect(me.roles).toEqual(expect.arrayContaining([{ id, name: 'Catalogue reader' }]));
      expect(me.permissions).toEqual(expect.arrayContaining(['files:read', 'models:read']));
      // The explainer names it.
      const ex = (await send(ta, 'post', '/api/admin/authz/evaluate', { userId: u.id, action: 'models:read' }).expect(200)).body;
      expect(ex.decision.allow).toBe(true);
      expect(ex.steps[0].detail).toContain('Catalogue reader');
      // The matrix lists it, in JSON and CSV.
      const m = (await ta.agent.get('/api/authz/matrix').expect(200)).body;
      expect(m.roles.find((r: { id: string }) => r.id === id)).toMatchObject({ builtIn: false, version: 1, permissions: ['models:read', 'files:read'] });
      const csv = await ta.agent.get('/api/authz/matrix?format=csv').expect(200);
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.text.split('\r\n')[0]).toContain(id);
      // Retiring a role somebody holds is refused.
      await send(ta, 'delete', `/api/authz/roles/${id}`).expect(409);
      expect(await auditActions()).toContain('authz.role.created');
    });

    it('keeps a role holding an admin permission under dual control, versioned with a diff', async () => {
      const created = (await send(ta, 'post', '/api/authz/roles', { name: 'Usage auditor', permissions: ['usage:read'] }).expect(201)).body;
      expect(created).toMatchObject({ pending: true, role: { state: 'pending', version: null, pendingVersion: 1, requiresMfa: true }, version: { state: 'pending', dualControl: true } });
      const id = created.role.id as string;
      // Not in force yet.
      expect((await ta.agent.get('/api/authz/matrix').expect(200)).body.roles.some((r: { id: string }) => r.id === id)).toBe(false);
      const self = await send(ta, 'post', `/api/authz/roles/${id}/versions/1/approve`).expect(403);
      expect(self.body.step).toBe('dual-control');
      expect((await send(tb, 'post', `/api/authz/roles/${id}/versions/1/approve`, { note: 'checked' }).expect(200)).body).toMatchObject({ state: 'active', version: 1 });
      expect((await ta.agent.get('/api/authz/matrix').expect(200)).body.roles.some((r: { id: string }) => r.id === id)).toBe(true);

      // Version 2 waits; version 1 stays in force until approved.
      const v2 = (await send(ta, 'patch', `/api/authz/roles/${id}`, { permissions: ['usage:read', 'audit:read'], description: 'Usage and audit' }).expect(200)).body;
      expect(v2).toMatchObject({ pending: true, version: { version: 2, state: 'pending' }, role: { version: 1, permissions: ['usage:read'] } });
      await send(ta, 'patch', `/api/authz/roles/${id}`, { description: 'again' }).expect(409);
      const diff = (await ta.agent.get(`/api/authz/roles/${id}/diff?from=1&to=2`).expect(200)).body;
      expect(diff).toEqual({ from: 1, to: 2, permissions: { added: ['audit:read'], removed: [] }, grantableBy: { added: [], removed: [] }, fields: { description: { from: '', to: 'Usage and audit' } } });
      expect((await send(tb, 'post', `/api/authz/roles/${id}/versions/2/reject`, { note: 'not now' }).expect(200)).body).toMatchObject({ version: 2, state: 'rejected', note: 'not now' });
      // Its proposer withdraws a third; the detail lists every version.
      await send(ta, 'patch', `/api/authz/roles/${id}`, { permissions: ['usage:read', 'audit:read'] }).expect(200);
      expect((await send(ta, 'post', `/api/authz/roles/${id}/versions/3/reject`).expect(200)).body.state).toBe('withdrawn');
      const detail = (await ta.agent.get(`/api/authz/roles/${id}`).expect(200)).body;
      expect(detail.versions.map((v: { version: number; state: string }) => `${v.version}:${v.state}`)).toEqual(['3:withdrawn', '2:rejected', '1:applied']);
      expect((await ta.agent.get(`/api/authz/roles/${id}/versions/1`).expect(200)).body).toMatchObject({ version: 1, permissions: ['usage:read'], decidedBy: expect.any(String) });
      // Nobody holds it: it retires, and stops resolving.
      expect((await send(ta, 'delete', `/api/authz/roles/${id}`).expect(200)).body.state).toBe('retired');
      expect(isRole(id, h.tenantId)).toBe(false);
      expect((await ta.agent.get('/api/authz/roles').expect(200)).body.custom.some((r: { id: string }) => r.id === id)).toBe(false);
      expect((await ta.agent.get('/api/authz/roles?retired=true').expect(200)).body.custom.find((r: { id: string }) => r.id === id).state).toBe('retired');
      const actions = await auditActions();
      for (const a of ['authz.role.proposed', 'authz.role.approved', 'authz.role.rejected', 'authz.role.withdrawn', 'authz.role.retired']) expect(actions).toContain(a);
    });

    it('lets only holders of roles:manage near it, and a role never grants more than its granter holds', async () => {
      await localUser(h, 'ida', ['identity-admin'], 'internal');
      const ida = await loginAdmin(h, 'ida');
      await ida.agent.get('/api/authz/matrix').expect(403);
      await send(ida, 'post', '/api/authz/roles', { name: 'x', permissions: ['models:read'] }).expect(403);
      // A role the identity admin is named for but whose permissions they do not hold: they cannot grant it.
      const wide = (await send(ta, 'post', '/api/authz/roles', { name: 'Prompt keeper', permissions: ['prompts:manage'], grantableBy: ['identity-admin', 'tenant-admin'] }).expect(201)).body.role;
      await send(tb, 'post', `/api/authz/roles/${wide.id}/versions/1/approve`).expect(200);
      const target = await localUser(h, 'gus', ['member'], 'internal');
      const denied = await send(ida, 'patch', `/api/admin/users/${target.id}`, { roles: ['member', wide.id] }).expect(403);
      expect(denied.body.detail).toContain(wide.id);
      await send(ta, 'patch', `/api/admin/users/${target.id}`, { roles: ['member', wide.id] }).expect(200);
    });
  });

  describe('effective access (B-3303)', () => {
    it('gives, for every cell, the decision policy.explain gives for the same principal and resource', async () => {
      const s = h.s;
      const t = h.tenantId;
      // A non-trivial fixture: workspaces at three ceilings, built-in and custom roles, clearances from public up,
      // a disabled account, an API key whose scopes narrow its owner's roles, and a zone ceiling.
      const w1 = await s.tenants.createWorkspace(t, 'Ops internal', 'internal');
      const w2 = await s.tenants.createWorkspace(t, 'Finance', 'confidential');
      const w3 = await s.tenants.createWorkspace(t, 'Board', 'restricted', { visibility: 'tenant' });
      const custom = (await send(ta, 'post', '/api/authz/roles', { name: 'File reader', permissions: ['files:read', 'records:read'], requiresMfa: false }).expect(201)).body.role.id as string;
      const fx = {
        alma: await localUser(h, 'fx-alma', ['member'], 'internal'),
        bert: await localUser(h, 'fx-bert', ['knowledge-curator', 'member'], 'confidential'),
        cleo: await localUser(h, 'fx-cleo', [custom], 'public'),
        dina: await localUser(h, 'fx-dina', ['flag-reviewer'], 'restricted'),
        emil: await localUser(h, 'fx-emil', ['auditor', 'member'], 'confidential'),
        finn: await localUser(h, 'fx-finn', ['member'], 'confidential')
      };
      await s.users.setWorkspaceMemberships(fx.alma.id, 'direct', [w1.id]);
      await s.users.setWorkspaceMemberships(fx.bert.id, 'direct', [w1.id, w2.id]);
      await s.users.setWorkspaceMemberships(fx.emil.id, 'direct', [w2.id]);
      await s.users.update(t, fx.finn.id, { state: 'disabled' });
      const key = await s.apiKeys.create({ tenantId: t, userId: fx.emil.id, name: 'export bot', scopes: ['audit:read', 'chat:read'], ttlDays: 30 });
      const sys: Principal = { kind: 'user', userId: taId, tenantId: t, tenantSlug: 'default', username: 'ta', displayName: 'TA', roles: ['system-admin'], clearance: 'restricted', scopes: null, sessionId: null, apiKeyId: null, mfa: true };
      await s.zones.seedDefaults(sys);

      for (const query of ['q=fx-&keys=true&limit=100', 'q=fx-&keys=true&zone=inference&limit=100', 'q=fx-&keys=true&label=confidential&permissions=files:read,knowledge:manage,audit:read,flags:review&limit=100']) {
        const m = (await ta.agent.get(`/api/authz/access?${query}`).expect(200)).body;
        expect(m.workspaces.map((w: { id: string }) => w.id)).toEqual(expect.arrayContaining([w1.id, w2.id, w3.id]));
        expect(m.rows).toHaveLength(7); // six users and the key
        const zoneCeiling = query.includes('zone=') ? 'confidential' : undefined;
        expect(m.resource.zone?.ceiling ?? undefined).toBe(zoneCeiling);
        let cells = 0;
        for (const row of m.rows) {
          const key_ = row.subject.apiKeyId ? (await s.apiKeys.listForUser(row.subject.userId)).find((k) => k.id === row.subject.apiKeyId)! : null;
          const p = await loadPrincipal(s, t, row.subject.userId, key_ ? { apiKey: key_ } : {});
          expect(row.subject.active).toBe(!!p);
          const member = p ? new Set((await workspacesFor(s, p)).map((w) => w.id)) : new Set<string>();
          for (const w of [w1, w2, w3]) {
            const c = row.cells[w.id];
            expect(c.member, `${row.subject.username} in ${w.name}`).toBe(member.has(w.id));
            for (const perm of m.permissions as Permission[]) {
              const resource = { tenantId: t, label: query.includes('label=confidential') ? ('confidential' as const) : w.label_ceiling, ...(zoneCeiling ? { zoneCeiling: zoneCeiling as 'confidential' } : {}) };
              const want = p ? explain(p, perm, resource).decision : { allow: false, step: 'role' };
              expect(c.allow.includes(perm), `${row.subject.username} ${perm} ${w.name}`).toBe(want.allow);
              if (!want.allow) expect(c.deny[perm]).toBe(want.step);
              cells++;
            }
          }
        }
        expect(cells).toBeGreaterThanOrEqual(84);
      }

      // Spot checks of what the fixture is for: the key's scopes, clearance, a custom role and the zone ceiling.
      const full = (await ta.agent.get('/api/authz/access?q=fx-&keys=true&zone=inference&limit=100').expect(200)).body;
      const rowOf = (name: string, kind = 'user') => full.rows.find((r: { subject: { username: string; kind: string } }) => r.subject.username === name && r.subject.kind === kind);
      expect(rowOf('fx-emil', 'api_key').cells[w1.id].deny['usage:read']).toBe('scope');
      expect(rowOf('fx-emil').cells[w1.id].allow).toContain('usage:read');
      expect(rowOf('fx-cleo').cells[w1.id].deny['files:read']).toBe('clearance');
      expect(rowOf('fx-bert').cells[w2.id].allow).toContain('knowledge:manage');
      expect(rowOf('fx-dina').cells[w3.id].deny['flags:review']).toBe('zone');
      expect(rowOf('fx-finn').subject.active).toBe(false);

      // explain for one cell is policy.explain's, steps and all.
      const ex = (await ta.agent.get(`/api/authz/access/explain?userId=${fx.cleo.id}&workspaceId=${w1.id}&permission=files:read`).expect(200)).body;
      const cleo = (await loadPrincipal(s, t, fx.cleo.id, {}))!;
      expect(ex.decision).toEqual(explain(cleo, 'files:read', { tenantId: t, label: 'internal' }).decision);
      expect(ex.steps).toEqual(explain(cleo, 'files:read', { tenantId: t, label: 'internal' }).steps);
      expect(ex.workspace).toMatchObject({ id: w1.id, member: false, labelCeiling: 'internal' });
      const keyEx = (await ta.agent.get(`/api/authz/access/explain?userId=${fx.emil.id}&apiKeyId=${key.row.id}&workspaceId=${w2.id}&permission=usage:read&zone=inference`).expect(200)).body;
      expect(keyEx).toMatchObject({ subject: { kind: 'api_key', apiKeyId: key.row.id, scopes: ['audit:read', 'chat:read'] }, decision: { allow: false, step: 'scope' }, resource: { label: 'confidential', zoneCeiling: 'confidential' } });

      // Who can: holders of a granting role, each with the decision for the resource.
      const who = (await ta.agent.get(`/api/authz/who-can?permission=files:read&workspaceId=${w1.id}`).expect(200)).body;
      const names = Object.fromEntries(who.users.map((u: { username: string; decision: { allow: boolean; step: string | null }; member: boolean }) => [u.username, u]));
      expect(names['fx-alma']).toMatchObject({ decision: { allow: true }, member: true, grantedBy: ['member'] });
      expect(names['fx-cleo']).toMatchObject({ decision: { allow: false, step: 'clearance' }, grantedBy: [custom] });
      expect(names['fx-finn']).toMatchObject({ active: false, decision: { allow: false } });
      expect(names['ta']).toMatchObject({ decision: { allow: true }, member: true, grantedBy: ['tenant-admin'] });
      expect(who.roles).toEqual(expect.arrayContaining(['system-admin', 'tenant-admin', 'member', custom]));
      expect(who.roles).not.toContain('auditor');
      await ta.agent.get('/api/authz/who-can?permission=nope').expect(400);
      await ta.agent.get('/api/authz/access?zone=nowhere').expect(400);
    });
  });

  describe('access reviews (B-3305)', () => {
    it('takes away a revoked grant by the member’s next request, and records every decision', async () => {
      const s = h.s;
      const dana = await localUser(h, 'rv-dana', ['flag-reviewer', 'member'], 'confidential');
      await localUser(h, 'rv-owen', ['flag-reviewer'], 'internal');
      const ws = await s.tenants.createWorkspace(h.tenantId, 'Review room', 'internal');
      await s.users.setWorkspaceMemberships(dana.id, 'direct', [ws.id]);
      const reviewer = await localUser(h, 'rv-rita', ['member'], 'internal');
      const danaC = await login(h, 'rv-dana');
      await danaC.agent.get('/api/flags').expect(200);

      const created = (await send(ta, 'post', '/api/authz/reviews', { name: 'Q4 reviewers', kinds: ['role', 'workspace'], roles: ['flag-reviewer'], reviewerIds: [reviewer.id, dana.id], dueDays: 7 }).expect(201)).body;
      expect(created).toMatchObject({ state: 'open', scope: { kinds: ['role', 'workspace'], roles: ['flag-reviewer'] }, counts: { total: expect.any(Number), decided: 0 }, overdue: false });
      const rita = await login(h, 'rv-rita');
      // The reviewer sees the campaign; a member who is not one does not.
      expect((await rita.agent.get('/api/authz/reviews').expect(200)).body.map((r: { id: string }) => r.id)).toEqual([created.id]);
      const owenC = await login(h, 'rv-owen');
      await owenC.agent.get(`/api/authz/reviews/${created.id}`).expect(404);
      const detail = (await rita.agent.get(`/api/authz/reviews/${created.id}`).expect(200)).body;
      const item = (u: string, kind: string) => detail.items.find((i: { user: { username: string }; kind: string }) => i.user.username === u && i.kind === kind);
      expect(item('rv-dana', 'role')).toMatchObject({ grant: { id: 'flag-reviewer', name: 'Flag reviewer' }, decision: 'pending' });
      expect(item('rv-dana', 'workspace')).toMatchObject({ grant: { id: ws.id, name: 'Review room' } });
      expect(item('rv-owen', 'role')).toBeDefined();
      expect(detail.items.some((i: { grant: { id: string } }) => i.grant.id === 'member')).toBe(false); // only the roles in scope

      // Dana reviews too, but never her own grants.
      const danaReview = await send(danaC, 'post', `/api/authz/reviews/${created.id}/items/${item('rv-dana', 'role').id}/decision`, { decision: 'confirm' }).expect(403);
      expect(danaReview.body.step).toBe('self');

      await send(rita, 'post', `/api/authz/reviews/${created.id}/items/${item('rv-dana', 'role').id}/decision`, { decision: 'revoke', note: 'left the team' }).expect(200);
      // Gone on her next request, with the same session.
      await danaC.agent.get('/api/flags').expect(403);
      await send(rita, 'post', `/api/authz/reviews/${created.id}/items/${item('rv-dana', 'workspace').id}/decision`, { decision: 'revoke' }).expect(200);
      const danaP = (await loadPrincipal(s, h.tenantId, dana.id, {}))!;
      expect((await workspacesFor(s, danaP)).some((w) => w.id === ws.id)).toBe(false);
      await send(rita, 'post', `/api/authz/reviews/${created.id}/items/${item('rv-dana', 'role').id}/decision`, { decision: 'confirm' }).expect(409);

      // Deciding the rest closes the campaign.
      const rest = ((await rita.agent.get(`/api/authz/reviews/${created.id}?decision=pending`).expect(200)).body.items as { id: string; user: { username: string } }[]);
      for (const i of rest) await send(rita, 'post', `/api/authz/reviews/${created.id}/items/${i.id}/decision`, { decision: 'confirm' }).expect(200);
      const closed = (await rita.agent.get(`/api/authz/reviews/${created.id}`).expect(200)).body;
      expect(closed.state).toBe('closed');
      expect(closed.items.filter((i: { decision: string }) => i.decision === 'revoked')).toHaveLength(2);
      await owenC.agent.get('/api/flags').expect(200); // confirmed: kept
      const actions = await auditActions();
      for (const a of ['authz.review.created', 'authz.review.opened', 'authz.review.revoked', 'authz.review.confirmed', 'authz.review.closed']) expect(actions).toContain(a);
      const revoked = await s.db('audit_events').where({ tenant_id: h.tenantId, action: 'authz.review.revoked' }).first();
      expect(JSON.parse(revoked.target)).toMatchObject({ user: dana.id, kind: 'role', grant: 'flag-reviewer' });
      expect((await s.audit.verify(h.tenantId)).status).toBe('verified');
    });

    it('opens scheduled campaigns, escalates overdue ones once and schedules the next round', async () => {
      const s = h.s;
      const reviewer = await localUser(h, 'rv-sam', ['member'], 'internal');
      await localUser(h, 'rv-una', ['auditor'], 'internal');
      const opensAt = new Date(Date.now() + 3_600_000).toISOString();
      const r = (await send(ta, 'post', '/api/authz/reviews', { name: 'Auditors', kinds: ['role'], roles: ['auditor'], reviewerIds: [reviewer.id], opensAt, dueDays: 1, everyDays: 30 }).expect(201)).body;
      expect(r).toMatchObject({ state: 'scheduled', dueAt: null, everyDays: 30 });
      expect(await s.accessReviews.sweep(h.tenantId)).toEqual({ opened: 0, escalated: 0 });
      expect(await s.accessReviews.sweep(h.tenantId, Date.now() + 2 * 3_600_000)).toMatchObject({ opened: 1 });
      const open = await s.accessReviews.get(h.tenantId, r.id);
      expect(open.state).toBe('open');
      expect(open.items_total).toBeGreaterThan(0);
      const later = Date.now() + 3 * 86_400_000;
      expect(await s.accessReviews.sweep(h.tenantId, later)).toEqual({ opened: 0, escalated: 1 });
      expect(await s.accessReviews.sweep(h.tenantId, later + 1000)).toEqual({ opened: 0, escalated: 0 });
      expect((await ta.agent.get(`/api/authz/reviews/${r.id}`).expect(200)).body).toMatchObject({ state: 'open', escalatedAt: later });
      const notes = (await s.db('notifications').where({ user_id: taId, kind: 'authz.review.overdue' })) as unknown[];
      expect(notes).toHaveLength(1);
      const closed = (await send(ta, 'post', `/api/authz/reviews/${r.id}/close`).expect(200)).body;
      expect(closed).toMatchObject({ state: 'closed', nextId: expect.any(String) });
      const next = await s.accessReviews.get(h.tenantId, closed.nextId);
      expect(next).toMatchObject({ state: 'scheduled', name: 'Auditors', every_days: 30 });
      expect(next.opens_at).toBe(open.opened_at! + 30 * 86_400_000);
      expect((await s.db('access_review_items').where({ review_id: r.id }).select('decision')).every((i: { decision: string }) => i.decision === 'expired')).toBe(true);
      expect(await auditActions()).toEqual(expect.arrayContaining(['authz.review.escalated']));
      // Its creator must be able to grant the roles it covers.
      await localUser(h, 'rv-ian', ['identity-admin'], 'internal');
      const ian = await loginAdmin(h, 'rv-ian');
      await send(ian, 'post', '/api/authz/reviews', { name: 'x', roles: ['auditor'], reviewerIds: [reviewer.id] }).expect(403);
    });
  });

  it('answers as docs/openapi.json describes', async () => {
    type Doc = { components: Record<string, unknown>; paths: Record<string, Record<string, { responses: Record<string, { content: Record<string, { schema: unknown }> }> }>> };
    const doc = JSON.parse(readFileSync(OPENAPI_FILE, 'utf8')) as Doc;
    const ajv = new Ajv2020({ strict: false });
    const check = async (path: string, url: string) => {
      const schema = doc.paths[path]!.get!.responses['200']!.content['application/json']!.schema;
      const v = ajv.compile({ components: doc.components, ...(schema as object) });
      const body = (await ta.agent.get(url).expect(200)).body;
      expect(v(body), `${url}: ${JSON.stringify(v.errors)}`).toBe(true);
      return body;
    };
    await check('/api/authz/matrix', '/api/authz/matrix');
    const roles = await check('/api/authz/roles', '/api/authz/roles?retired=true');
    const id = roles.custom[0].id as string;
    await check('/api/authz/roles/{id}', `/api/authz/roles/${id}`);
    await check('/api/authz/roles/{id}/versions/{version}', `/api/authz/roles/${id}/versions/1`);
    const m = await check('/api/authz/access', '/api/authz/access?keys=true&zone=inference&limit=5');
    const row = m.rows[0];
    await check('/api/authz/access/explain', `/api/authz/access/explain?userId=${row.subject.userId}&workspaceId=${m.workspaces[0].id}&permission=chat:read`);
    await check('/api/authz/who-can', '/api/authz/who-can?permission=chat:read');
    const reviews = await check('/api/authz/reviews', '/api/authz/reviews');
    await check('/api/authz/reviews/{id}', `/api/authz/reviews/${reviews[0].id}`);
  });

  it('covers every permission in the matrix', async () => {
    const m = (await ta.agent.get('/api/authz/matrix').expect(200)).body;
    expect(m.permissions.map((p: { id: string }) => p.id)).toEqual([...PERMISSIONS]);
    expect(m.roles.find((r: { id: string }) => r.id === 'tenant-admin').permissions).toContain('roles:manage');
  });
});

describe('socket rooms after a revoke (B-3305)', () => {
  let h: Harness;
  let server: Server;
  let close: () => Promise<void>;
  beforeAll(async () => {
    h = await harness();
    server = createServer(h.app);
    close = attachRealtime(server, h.s).close;
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });
  afterAll(async () => {
    await close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await h.close();
  });

  it('leaves the permission rooms of a role that was taken away', async () => {
    const u = await localUser(h, 'sock-fay', ['flag-reviewer', 'member'], 'internal');
    const { cookie } = await login(h, 'sock-fay');
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const sock = ioClient(url, { path: '/socket.io', transports: ['websocket'], reconnection: false, extraHeaders: { cookie } });
    await new Promise((resolve) => sock.on('ready', resolve));
    const seen: unknown[] = [];
    sock.on('flags.changed', (d: unknown) => seen.push(d));
    const ping = async (n: number) => {
      h.s.bus.publish(TOPICS.poolState, { tenantId: h.tenantId, perm: 'flags:review', event: 'flags.changed', data: { n } });
      await new Promise((r) => setTimeout(r, 150));
    };
    await ping(1);
    expect(seen).toEqual([{ n: 1 }]);
    await h.s.users.setRoles(u.id, 'direct', ['member']);
    h.s.bus.publish(TOPICS.rolesChanged, { tenantId: h.tenantId, userIds: [u.id] });
    await new Promise((r) => setTimeout(r, 150));
    await ping(2);
    expect(seen).toEqual([{ n: 1 }]);
    expect(sock.connected).toBe(true);
    sock.close();
  });
});
