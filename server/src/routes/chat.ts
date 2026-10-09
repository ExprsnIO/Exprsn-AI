import express, { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { clears, labelRank, LABELS, type Label } from '../authz/labels.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { badRequest, forbidden, HttpProblem, notFound } from '../http/problem.js';
import { KeyDestroyedError } from '../platform/datakeys.js';
import { attachmentView } from '../chat/attachments.js';
import { CalcError } from '../chat/calc.js';
import type { Services } from '../services.js';

const think = z.enum(['off', 'low', 'medium', 'high']).optional();
const id26 = z.string().length(26);

/**
 * Chat and compare. Everything is scoped to the caller's own conversations in their current workspace.
 * Generation is asynchronous: sending returns the new message ids at once and tokens arrive over the socket.
 */
export function chatRoutes(s: Services): Router {
  const r = Router();
  r.use(['/chat', '/conversations', '/compare', '/attachments', '/calculate'], noStore, requireAuth());
  const read = requirePermission(s, 'chat:read');
  const write = requirePermission(s, 'chat:write');
  const invoke = requirePermission(s, 'inference:invoke');
  const chat = s.chat;

  const wrap =
    <T>(fn: (req: Request) => Promise<T>) =>
    async (req: Request) => {
      try {
        return await fn(req);
      } catch (err) {
        if (err instanceof KeyDestroyedError) throw new HttpProblem(410, 'Gone', 'This tenant\'s key was destroyed; its conversations can no longer be read.');
        throw err;
      }
    };

  r.get('/chat/profiles', read, async (req, res) => {
    res.json(await chat.profilesFor(principalOf(req)));
  });

  r.get('/conversations', read, async (req, res) => {
    const q = parseBody(z.object({ kind: z.enum(['chat', 'compare']).optional(), archived: z.enum(['true', 'false']).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
    res.json(await wrap(() => chat.listConversations(principalOf(req), { kind: q.kind, archived: q.archived === 'true', limit: q.limit }))(req));
  });

  r.post('/conversations', write, async (req, res) => {
    const body = parseBody(z.object({ title: z.string().trim().max(200).nullable().default(null), label: z.enum(LABELS).optional() }), req.body);
    const c = await chat.createConversation(principalOf(req), body);
    res.status(201).json({ id: c.id, label: c.label, workspaceId: c.workspace_id });
  });

  r.get('/conversations/:id', read, async (req, res) => {
    res.json(await wrap(() => chat.view(principalOf(req), String(req.params.id)))(req));
  });

  r.patch('/conversations/:id', write, async (req, res) => {
    const body = parseBody(z.object({ title: z.string().trim().min(1).max(200).optional(), archived: z.boolean().optional(), label: z.enum(LABELS).optional(), headId: id26.optional() }).strict(), req.body);
    await wrap(() => chat.updateConversation(principalOf(req), String(req.params.id), body))(req);
    res.json({ ok: true });
  });

  r.delete('/conversations/:id', write, async (req, res) => {
    const p = principalOf(req);
    await chat.deleteConversation(p, String(req.params.id));
    await s.audit.append({ tenantId: p.tenantId, action: 'conversation.deleted', kind: 'admin', actor: actorFrom(p, ip(req)), target: { conversation: String(req.params.id) }, traceId: req.traceId });
    res.status(204).end();
  });

  const sendSchema = z.object({ content: z.string().trim().min(1).max(100_000), parentId: id26.nullable().optional(), profile: z.string().min(1).max(63), think, attachments: z.array(id26).max(10).default([]), label: z.enum(LABELS).optional() });

  r.post('/conversations/:id/messages', write, invoke, async (req, res) => {
    const body = parseBody(sendSchema, req.body);
    res.status(202).json(await wrap(() => chat.send(principalOf(req), String(req.params.id), body))(req));
  });

  /** Starts a conversation and sends its first message in one call. */
  r.post('/chat', write, invoke, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(sendSchema.omit({ parentId: true }), req.body);
    const c = await chat.createConversation(p, { label: body.label ?? (await chat.defaultLabel(p)) });
    const out = await wrap(() => chat.send(p, c.id, body))(req).catch(async (err) => {
      await chat.deleteConversation(p, c.id).catch(() => undefined);
      throw err;
    });
    res.status(202).json({ conversationId: c.id, ...out });
  });

  r.post('/conversations/:id/messages/:mid/regenerate', write, invoke, async (req, res) => {
    const body = parseBody(z.object({ profile: z.string().min(1).max(63).optional(), think }), req.body);
    res.status(202).json(await wrap(() => chat.regenerate(principalOf(req), String(req.params.id), String(req.params.mid), body))(req));
  });

  r.post('/conversations/:id/messages/:mid/edit', write, invoke, async (req, res) => {
    const body = parseBody(z.object({ content: z.string().trim().min(1).max(100_000), profile: z.string().min(1).max(63).optional(), think }), req.body);
    res.status(202).json(await wrap(() => chat.edit(principalOf(req), String(req.params.id), String(req.params.mid), body))(req));
  });

  r.post('/conversations/:id/messages/:mid/stop', write, async (req, res) => {
    res.json(await chat.stop(principalOf(req), String(req.params.id), String(req.params.mid)));
  });

  /** Continues an interrupted or stopped answer from its stored text (Sprint 12). */
  r.post('/conversations/:id/messages/:mid/continue', write, invoke, async (req, res) => {
    const body = parseBody(z.object({ profile: z.string().min(1).max(63).optional(), think }), req.body);
    res.status(202).json(await wrap(() => chat.continue(principalOf(req), String(req.params.id), String(req.params.mid), body))(req));
  });

  r.get('/conversations/:id/messages/:mid/stream', read, async (req, res) => {
    const q = parseBody(z.object({ after: z.coerce.number().int().min(0).default(0) }), req.query);
    res.json(await wrap(() => chat.resume(principalOf(req), String(req.params.id), String(req.params.mid), q.after))(req));
  });

  // ---------- 1.6.0, Sprint 39a (B-8001): versioned artifacts ----------

  /** The artifacts of a conversation (owner or share reader): one entry per name, with every version's render link. */
  // ---------- 1.7.0 (B-4001 to B-4009): agents, tools, skills and workflows from a conversation ----------
  const inv = () => s.chatInvocations;
  const agentsRun = requirePermission(s, 'agents:run');
  r.get('/conversations/:id/capabilities', read, async (req, res) => {
    res.json(await wrap(() => inv().capabilities(principalOf(req), String(req.params.id)))(req));
  });
  r.get('/conversations/:id/invocations', read, async (req, res) => {
    res.json(await wrap(() => inv().list(principalOf(req), String(req.params.id)))(req));
  });
  r.post('/conversations/:id/tool-calls', write, invoke, async (req, res) => {
    const body = parseBody(z.object({ name: z.string().trim().min(1).max(120), arguments: z.record(z.string(), z.unknown()).optional(), text: z.string().trim().min(1).max(4000).optional() }), req.body);
    res.status(202).json(await wrap(() => inv().callTool(principalOf(req), String(req.params.id), body))(req));
  });
  r.post('/conversations/:id/invocations/:iid/decide', write, async (req, res) => {
    // 1.7.0 (B-11703): a plan card may be approved with edited steps.
    const body = parseBody(z.object({ decision: z.enum(['approve', 'deny']), steps: z.array(z.object({ title: z.string().trim().min(1).max(200), tools: z.array(z.string().trim().min(1).max(120)).max(8).default([]), data: z.array(z.string().trim().max(200)).max(8).default([]) })).min(1).max(50).optional() }), req.body);
    res.json(await wrap(() => inv().decide(principalOf(req), String(req.params.id), String(req.params.iid), body.decision, body.steps))(req));
  });
  r.post('/conversations/:id/invocations/:iid/cancel', write, async (req, res) => {
    res.json(await wrap(() => inv().cancel(principalOf(req), String(req.params.id), String(req.params.iid)))(req));
  });
  r.post('/conversations/:id/agent-runs', write, agentsRun, async (req, res) => {
    const body = parseBody(z.object({ agent: z.string().trim().min(1).max(120), input: z.string().trim().min(1).max(20_000), includeTurns: z.boolean().optional() }), req.body);
    res.status(202).json(await wrap(() => inv().startAgent(principalOf(req), String(req.params.id), body))(req));
  });
  r.post('/conversations/:id/workflow-runs', write, agentsRun, async (req, res) => {
    const body = parseBody(z.object({ workflow: z.string().trim().min(1).max(200), input: z.record(z.string(), z.unknown()).default({}) }), req.body);
    res.status(202).json(await wrap(() => inv().startWorkflow(principalOf(req), String(req.params.id), body))(req));
  });
  r.put('/conversations/:id/skills', write, async (req, res) => {
    const body = parseBody(z.object({ name: z.string().trim().min(1).max(120), mode: z.enum(['sticky', 'once']).default('sticky') }), req.body);
    res.json(await wrap(() => inv().addSkill(principalOf(req), String(req.params.id), body))(req));
  });
  r.delete('/conversations/:id/skills/:name', write, async (req, res) => {
    res.json(await wrap(() => inv().removeSkill(principalOf(req), String(req.params.id), String(req.params.name)))(req));
  });

  r.get('/conversations/:id/artifacts', read, async (req, res) => {
    res.json({ artifacts: await wrap(() => s.chatArtifacts.list(principalOf(req), String(req.params.id)))(req) });
  });

  r.get('/conversations/:id/artifacts/:aid/versions/:n', read, async (req, res) => {
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || n < 1) throw badRequest('A version is a positive integer.');
    const out = await wrap(() => s.chatArtifacts.version(principalOf(req), String(req.params.id), String(req.params.aid), n))(req);
    res.json({ id: out.artifact.id, key: out.artifact.key, kind: out.artifact.kind, language: out.artifact.language, title: out.artifact.title, label: out.artifact.label, version: out.version.version, messageId: out.version.message_id, bytes: Number(out.version.bytes), sha256: out.version.sha256, createdAt: Number(out.version.created_at), content: out.content });
  });

  r.post('/compare', write, invoke, async (req, res) => {
    const body = parseBody(z.object({ prompt: z.string().trim().min(1).max(100_000), profiles: z.array(z.string().min(1).max(63)).min(2).max(4), think, label: z.enum(LABELS).optional() }), req.body);
    if (new Set(body.profiles).size !== body.profiles.length) throw badRequest('Pick each profile once.');
    res.status(202).json(await chat.compare(principalOf(req), body));
  });

  // ---------- attachments ----------

  /** Raw upload (the body is the file): quarantined, then scanned and classified by a job. */
  r.put('/attachments', write, express.raw({ type: () => true, limit: s.cfg.ATTACHMENT_MAX_BYTES }), async (req, res) => {
    const p = principalOf(req);
    const q = parseBody(z.object({ name: z.string().trim().min(1).max(255).regex(/^[^/\\\0]+$/), label: z.enum(LABELS).default('internal') }), req.query);
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!data.length) throw badRequest('The file is empty.');
    const label: Label = q.label;
    if (!clears(p.clearance, label)) throw forbidden('Above your clearance.', { step: 'clearance' });
    const ws = p.workspaceId ? await s.tenants.workspace(p.tenantId, p.workspaceId) : undefined;
    if (ws && labelRank(label) > labelRank(ws.label_ceiling)) throw forbidden(`This workspace's ceiling is ${ws.label_ceiling}.`, { step: 'zone' });
    const a = await s.attachments.upload({ tenantId: p.tenantId, workspaceId: p.workspaceId ?? null, userId: p.userId, name: q.name, declaredType: req.header('content-type') ?? null, label, data });
    res.status(202).json(attachmentView(a));
  });

  r.get('/attachments/:id', read, async (req, res) => {
    const p = principalOf(req);
    const a = await s.attachments.get(p.tenantId, String(req.params.id));
    if (!a || a.user_id !== p.userId) throw notFound('Attachment');
    res.json(attachmentView(a));
  });

  // ---------- exact calculation ----------

  r.post('/calculate', invoke, async (req, res) => {
    const body = parseBody(z.object({ expression: z.string().min(1).max(2000) }), req.body);
    try {
      res.json(await s.calc.evaluate(body.expression));
    } catch (err) {
      if (err instanceof CalcError) throw badRequest(err.message);
      throw err;
    }
  });

  return r;
}
