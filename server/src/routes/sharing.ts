import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { clears, type Label } from '../authz/labels.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { exportView, shareView, type ShareRow } from '../chat/sharing.js';
import type { Services } from '../services.js';

const id26 = z.string().length(26);

/**
 * Conversation sharing and export (Sprint 13). The owner shares and revokes (`chat:write`); readers list and open
 * what is shared with them (`chat:read`). Exports are for anyone who can read the conversation, at their clearance.
 */
export function sharingRoutes(s: Services): Router {
  const r = Router();
  r.use(['/conversations/:id/shares', '/conversations/:id/share-targets', '/conversations/:id/exports', '/shared-conversations', '/shared-links', '/conversation-exports'], noStore, requireAuth());
  const read = requirePermission(s, 'chat:read');
  const write = requirePermission(s, 'chat:write');
  const sh = s.sharing;

  const audit = (req: Request, action: string, target: Record<string, unknown>, label: Label, detail?: Record<string, unknown>) => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip(req)), target, label, ...(detail ? { detail } : {}), traceId: req.traceId });
  };

  const describe = async (tenantId: string, x: ShareRow) => ({
    ...shareView(x, {
      userName: x.user_id ? ((await s.users.get(tenantId, x.user_id))?.display_name ?? null) : null,
      workspaceName: x.workspace_id ? ((await s.tenants.workspace(tenantId, x.workspace_id))?.name ?? null) : null
    })
  });

  r.get('/conversations/:id/shares', read, async (req, res) => {
    const p = principalOf(req);
    const list = await sh.list(p, parseBody(id26, req.params.id));
    res.json(await Promise.all(list.map((x) => describe(p.tenantId, x))));
  });

  /** People and workspaces of the tenant to share with, and whether each is cleared for the conversation's label. */
  r.get('/conversations/:id/share-targets', read, async (req, res) => {
    const p = principalOf(req);
    const c = await s.chat.conversation(p, parseBody(id26, req.params.id));
    const q = parseBody(z.object({ q: z.string().trim().max(100).default('') }), req.query).q.toLowerCase();
    const users = (await s.db('users').where({ tenant_id: p.tenantId, state: 'active' }).andWhereNot({ id: p.userId }).orderBy('display_name').limit(500).select('id', 'username', 'display_name', 'clearance')) as { id: string; username: string; display_name: string; clearance: Label }[];
    const workspaces = await s.tenants.workspaces(p.tenantId);
    res.json({
      label: c.label,
      users: users.filter((u) => !q || u.username.toLowerCase().includes(q) || u.display_name.toLowerCase().includes(q)).slice(0, 25).map((u) => ({ id: u.id, username: u.username, name: u.display_name, cleared: clears(u.clearance, c.label) })),
      workspaces: workspaces.filter((w) => !q || w.name.toLowerCase().includes(q)).slice(0, 25).map((w) => ({ id: w.id, name: w.name, labelCeiling: w.label_ceiling, cleared: clears(w.label_ceiling, c.label) }))
    });
  });

  r.post('/conversations/:id/shares', write, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('user'), userId: id26 }).strict(),
        z.object({ kind: z.literal('workspace'), workspaceId: id26 }).strict(),
        z.object({ kind: z.literal('link'), expiresInHours: z.number().int().min(1).max(30 * 24).default(7 * 24) }).strict()
      ]),
      req.body
    );
    const { share, token } = await sh.create(p, parseBody(id26, req.params.id), body);
    const c = await s.chat.conversation(p, share.conversation_id);
    await audit(req, 'conversation.shared', { conversation: c.id, share: share.id }, c.label, { kind: share.kind, user: share.user_id, workspace: share.workspace_id, expiresAt: share.expires_at });
    res.status(201).json({ ...(await describe(p.tenantId, share)), ...(token ? { token, url: `${s.cfg.PUBLIC_URL.replace(/\/$/, '')}/#/chat?shared=${encodeURIComponent(token)}` } : {}) });
  });

  r.delete('/conversations/:id/shares/:shareId', write, async (req, res) => {
    const p = principalOf(req);
    const x = await sh.revoke(p, parseBody(id26, req.params.id), parseBody(id26, req.params.shareId));
    const c = await s.chat.conversation(p, x.conversation_id);
    await audit(req, 'conversation.share.revoked', { conversation: c.id, share: x.id }, c.label, { kind: x.kind });
    res.status(204).end();
  });

  r.get('/shared-conversations', read, async (req, res) => {
    res.json(await sh.sharedWithMe(principalOf(req)));
  });

  r.get('/shared-conversations/:id', read, async (req, res) => {
    res.json({ ...(await sh.openShared(principalOf(req), parseBody(id26, req.params.id))), readOnly: true });
  });

  // The token travels in the body, never in a URL that proxies or logs could keep.
  r.post('/shared-links/open', read, async (req, res) => {
    const { token } = parseBody(z.object({ token: z.string().regex(/^exs_[A-Za-z0-9_-]{20,100}$/) }).strict(), req.body);
    const { transcript } = await sh.openLink(principalOf(req), token, ip(req));
    res.json({ ...transcript, readOnly: true });
  });

  r.post('/conversations/:id/exports', read, async (req, res) => {
    const p = principalOf(req);
    const { format } = parseBody(z.object({ format: z.enum(['markdown', 'json']).default('markdown') }).strict(), req.body ?? {});
    const x = await sh.requestExport(p, parseBody(id26, req.params.id), format);
    await audit(req, 'conversation.export.requested', { conversation: x.conversation_id, export: x.id }, x.label, { format });
    res.status(202).json(exportView(x));
  });

  r.get('/conversation-exports', read, async (req, res) => {
    const q = parseBody(z.object({ conversation: id26.optional() }), req.query);
    res.json((await sh.listExports(principalOf(req), q.conversation)).map(exportView));
  });

  r.get('/conversation-exports/:id', read, async (req, res) => {
    res.json(exportView(await sh.getExport(principalOf(req), parseBody(id26, req.params.id))));
  });

  r.get('/conversation-exports/:id/download', read, async (req, res) => {
    const { row, data } = await sh.download(principalOf(req), parseBody(id26, req.params.id));
    await audit(req, 'conversation.export.downloaded', { conversation: row.conversation_id, export: row.id }, row.label, { format: row.format, bytes: data.length });
    res.setHeader('Content-Type', row.format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${row.file}"`);
    res.send(data);
  });

  return r;
}
