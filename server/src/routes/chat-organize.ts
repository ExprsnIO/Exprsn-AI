import type { Request, RequestHandler, Router } from 'express';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import type { Label } from '../authz/labels.js';
import { ip, parseBody, principalOf } from '../http/middleware.js';
import { ChatFolders } from '../chat/folders.js';
import { MessageGroups } from '../chat/message-groups.js';
import type { Services } from '../services.js';

const id26 = z.string().length(26);
const name = z.string().trim().min(1).max(100);

/**
 * Chat organisation (2026-10-15): the caller's conversation folders under `/api/chat/folders` and filing a
 * conversation with `PUT /api/conversations/:id/folder` (`chat:read` to list, `chat:write` to change), and a
 * conversation's message groups under `/api/conversations/:id/groups` (listed by anyone who may read the conversation,
 * changed by its owner). Mounted by `chatRoutes`, whose `requireAuth` and `noStore` cover these paths.
 */
export function chatOrganizeRoutes(s: Services, r: Router, read: RequestHandler, write: RequestHandler): void {
  const folders = new ChatFolders(() => s);
  const groups = new MessageGroups(() => s);

  const audit = (req: Request, action: string, target: Record<string, unknown>, label?: Label, detail?: Record<string, unknown>) => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip(req)), target, ...(label ? { label } : {}), ...(detail ? { detail } : {}), traceId: req.traceId });
  };

  // ---------- folders ----------

  r.get('/chat/folders', read, async (req, res) => {
    res.json(await folders.list(principalOf(req)));
  });

  r.post('/chat/folders', write, async (req, res) => {
    const body = parseBody(z.object({ name, parentId: id26.nullish() }).strict(), req.body);
    const f = await folders.create(principalOf(req), { name: body.name, parentId: body.parentId ?? null });
    await audit(req, 'chat.folder.created', { folder: f.id }, undefined, { parent: f.parentId, depth: f.depth });
    res.status(201).json(f);
  });

  r.patch('/chat/folders/:id', write, async (req, res) => {
    const body = parseBody(z.object({ name }).strict(), req.body);
    const f = await folders.rename(principalOf(req), parseBody(id26, req.params.id), body.name);
    await audit(req, 'chat.folder.renamed', { folder: f.id });
    res.json(f);
  });

  r.post('/chat/folders/:id/move', write, async (req, res) => {
    const body = parseBody(z.object({ parentId: id26.nullable().optional(), position: z.number().int().min(0).max(10_000).optional() }).strict(), req.body ?? {});
    const { folder, from } = await folders.move(principalOf(req), parseBody(id26, req.params.id), body);
    await audit(req, 'chat.folder.moved', { folder: folder.id }, undefined, { from, to: folder.parentId, position: folder.position });
    res.json(folder);
  });

  r.delete('/chat/folders/:id', write, async (req, res) => {
    const id = parseBody(id26, req.params.id);
    const out = await folders.remove(principalOf(req), id);
    await audit(req, 'chat.folder.deleted', { folder: id }, undefined, out);
    res.json(out);
  });

  r.put('/conversations/:id/folder', write, async (req, res) => {
    const body = parseBody(z.object({ folderId: id26.nullable() }).strict(), req.body);
    const { c, from } = await folders.file(principalOf(req), parseBody(id26, req.params.id), body.folderId);
    await audit(req, 'conversation.filed', { conversation: c.id, folder: body.folderId }, c.label, { from });
    res.json({ conversationId: c.id, folderId: body.folderId });
  });

  // ---------- message groups ----------

  const ids = z.array(id26).min(1).max(500);

  r.get('/conversations/:id/groups', read, async (req, res) => {
    res.json((await groups.list(principalOf(req), parseBody(id26, req.params.id))).groups);
  });

  r.post('/conversations/:id/groups', write, async (req, res) => {
    const body = parseBody(z.object({ name, messageIds: ids }).strict(), req.body);
    const { c, group } = await groups.create(principalOf(req), parseBody(id26, req.params.id), body);
    await audit(req, 'conversation.group.created', { conversation: c.id, group: group.id }, c.label, { messages: group.messageIds.length });
    res.status(201).json(group);
  });

  r.patch('/conversations/:id/groups/:gid', write, async (req, res) => {
    const body = parseBody(z.object({ name: name.optional(), messageIds: ids.optional() }).strict().refine((b) => b.name !== undefined || b.messageIds !== undefined, 'Give a name or messages.'), req.body);
    const { c, group } = await groups.update(principalOf(req), parseBody(id26, req.params.id), parseBody(id26, req.params.gid), body);
    await audit(req, 'conversation.group.updated', { conversation: c.id, group: group.id }, c.label, { renamed: body.name !== undefined, messages: group.messageIds.length });
    res.json(group);
  });

  r.delete('/conversations/:id/groups/:gid', write, async (req, res) => {
    const gid = parseBody(id26, req.params.gid);
    const c = await groups.remove(principalOf(req), parseBody(id26, req.params.id), gid);
    await audit(req, 'conversation.group.deleted', { conversation: c.id, group: gid }, c.label);
    res.status(204).end();
  });
}
