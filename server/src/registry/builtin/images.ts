import type { Principal } from '../../authz/policy.js';
import { clears } from '../../authz/labels.js';
import type { Services } from '../../services.js';
import type { ToolCallContext } from '../dispatch.js';

/*
 * 1.7.0: the image built-ins (`image-catalog.ts`), as the caller through the images service. A picture is named by
 * its id, a gallery picture or one attached in chat; left out, the newest picture of the conversation the call comes
 * from (made there or attached there), and failing that the newest in the caller's gallery. Each result is a new
 * picture: the chat shows it (`web/js/screens/chat.js` draws a result's `image`) and its id is the next edit's source.
 *
 * Edits wait for their result (a few seconds) so the next call can build on it; generating and restyling return the
 * queued picture at once and the chat shows it when it is done.
 */

const EDIT_WAIT_MS = 30_000;
const SOURCE_WAIT_MS = 120_000;
const PICTURE = /^image\/(png|jpeg|webp)$/;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export class ImageToolRefused extends Error {}

type ImageView = Awaited<ReturnType<Services['images']['get']>>;

interface Candidate {
  id: string;
  kind: 'image' | 'attachment';
  name: string;
  state: string;
  width: number | null;
  height: number | null;
  createdAt: number;
  inConversation: boolean;
  url: string | null;
  note?: string | null;
}

/** The conversation a call comes from: a chat answer's message, or an agent run started in a conversation. */
async function conversationOf(s: Services, ctx: ToolCallContext): Promise<string | null> {
  const src = ctx.source;
  if (!src) return null;
  if (src.kind === 'message') {
    const m = (await s.db('messages').where({ id: src.id }).first('conversation_id', 'tenant_id')) as { conversation_id: string; tenant_id: string } | undefined;
    return m && m.tenant_id === ctx.principal.tenantId ? m.conversation_id : null;
  }
  if (src.kind === 'agent-run') {
    const r = (await s.db('agent_runs').where({ id: src.id, tenant_id: ctx.principal.tenantId }).first('conversation_id')) as { conversation_id: string | null } | undefined;
    return r?.conversation_id ?? null;
  }
  return null;
}

/** Pictures attached in the conversation by the caller, newest first. */
async function attachedIn(s: Services, p: Principal, conversationId: string, limit: number): Promise<Candidate[]> {
  const rows = (await s.db('messages').where({ conversation_id: conversationId, tenant_id: p.tenantId, role: 'user' }).whereNotNull('attachments').orderBy('created_at', 'desc').limit(50).select('attachments')) as { attachments: string }[];
  const ids = [...new Set(rows.flatMap((r) => (typeof r.attachments === 'string' ? (JSON.parse(r.attachments) as string[]) : (r.attachments as unknown as string[]))))];
  const out: Candidate[] = [];
  for (const id of ids) {
    const a = await s.attachments.get(p.tenantId, id);
    if (!a || a.user_id !== p.userId || a.state !== 'ready' || !PICTURE.test(a.type) || !clears(p.clearance, a.label)) continue;
    out.push({ id: a.id, kind: 'attachment', name: a.name, state: 'ready', width: null, height: null, createdAt: a.created_at, inConversation: true, url: null });
  }
  return out.sort((x, y) => y.createdAt - x.createdAt).slice(0, limit);
}

const fromView = (v: ImageView, inConversation: boolean): Candidate => ({ id: v.id, kind: 'image', name: v.edit ? `edit: ${v.edit}` : (v.prompt ?? '').slice(0, 80), state: v.state, width: v.width, height: v.height, createdAt: v.createdAt, inConversation, url: v.url, note: v.error });

async function candidates(s: Services, p: Principal, conversationId: string | null, limit: number): Promise<Candidate[]> {
  const here = conversationId ? [...(await s.images.inConversation(p, conversationId, limit)).map((v) => fromView(v, true)), ...(await attachedIn(s, p, conversationId, limit))] : [];
  const seen = new Set(here.map((c) => c.id));
  const gallery = (await s.images.list(p, limit)).filter((v) => !seen.has(v.id)).map((v) => fromView(v, false));
  return [...here.sort((x, y) => y.createdAt - x.createdAt), ...gallery].slice(0, limit);
}

/** The picture a call names, or the newest one the conversation has, or the newest in the gallery. */
async function sourceOf(s: Services, p: Principal, conversationId: string | null, arg: unknown): Promise<{ id: string; picked: boolean }> {
  // An id names the picture; a word such as "latest" (migration 075) means the newest, as when it is left out.
  if (typeof arg === 'string' && ULID.test(arg)) return { id: arg, picked: false };
  const list = (await candidates(s, p, conversationId, 12)).filter((c) => c.state === 'ready' || c.state === 'succeeded' || c.state === 'queued' || c.state === 'running');
  const first = list.find((c) => c.inConversation) ?? list[0];
  if (!first) throw new ImageToolRefused('There is no picture to work on: attach one, or make one with image_generate, or give an image id from image_list.');
  return { id: first.id, picked: true };
}

/** A gallery picture still being made is waited for, so an edit can follow a generate or a restyle in one turn. */
async function settled(s: Services, p: Principal, id: string): Promise<void> {
  const row = (await s.db('image_jobs').where({ tenant_id: p.tenantId, id }).first('state', 'user_id')) as { state: string; user_id: string } | undefined;
  if (row && row.user_id === p.userId && (row.state === 'queued' || row.state === 'running')) await s.images.waitFor(p, id, SOURCE_WAIT_MS);
}

const shown = (v: ImageView) => ({ id: v.id, state: v.state, stage: v.stage, width: v.width, height: v.height, url: v.url, backend: v.backendLabel, edit: v.edit, source: v.source, label: v.label, error: v.error });

/** Operations of the single-purpose tools, in the editor's shape. */
function opsOf(op: string, a: Record<string, unknown>): Record<string, unknown>[] {
  const pick = (...keys: string[]) => Object.fromEntries(keys.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
  switch (op) {
    case 'image_crop':
      return [{ op: 'crop', ...pick('x', 'y', 'width', 'height', 'aspect', 'anchor') }];
    case 'image_resize':
      return [{ op: 'resize', ...pick('width', 'height', 'scale', 'fit') }];
    case 'image_rotate': {
      const out: Record<string, unknown>[] = [];
      if (a.degrees !== undefined && Number(a.degrees) !== 0) out.push({ op: 'rotate', degrees: a.degrees });
      if (a.flip) out.push({ op: 'flip', direction: a.flip });
      if (!out.length) throw new ImageToolRefused('Give degrees to rotate by, or flip: horizontal or vertical.');
      return out;
    }
    case 'image_blur':
      return [{ op: 'blur', ...pick('radius', 'kind', 'angle', 'region', 'outside') }];
    case 'image_adjust': {
      const out: Record<string, unknown>[] = [];
      const adj = pick('brightness', 'contrast', 'saturation', 'sharpness', 'gamma', 'temperature', 'hue');
      if (Object.keys(adj).length) out.push({ op: 'adjust', ...adj });
      if (a.sharpen !== undefined) out.push({ op: 'sharpen', amount: a.sharpen });
      if (!out.length) throw new ImageToolRefused('Give at least one of brightness, contrast, saturation, sharpness, gamma, temperature, hue or sharpen.');
      return out;
    }
    case 'image_effect':
      return [{ op: 'effect', ...pick('name', 'strength') }];
    case 'image_style':
      return [{ op: 'style', ...pick('name', 'strength') }];
    default:
      return Array.isArray(a.ops) ? (a.ops as Record<string, unknown>[]) : [];
  }
}

export async function imageTool(s: Services, ctx: ToolCallContext, op: string, args: Record<string, unknown>): Promise<unknown> {
  const p = ctx.principal;
  const conversationId = await conversationOf(s, ctx);
  if (op === 'image_list') {
    const limit = Math.min(30, Math.max(1, Number(args.limit ?? 12)));
    const images = await candidates(s, p, conversationId, limit);
    const here = images.filter((i) => i.inConversation).length;
    return { images, summary: `Found ${images.length} picture${images.length === 1 ? '' : 's'}: ${here} in this conversation, ${images.length - here} in the gallery.` };
  }
  if (op === 'image_generate') {
    const out = await s.images.generateBest(p, { prompt: String(args.prompt ?? ''), ...(args.width != null ? { width: Number(args.width) } : {}), ...(args.height != null ? { height: Number(args.height) } : {}), label: ctx.label, conversationId });
    return { image: shown(out.image), model: out.backend.label, ...(out.redacted ? { redacted: true } : {}), note: `Queued on ${out.backend.label}; the picture appears in the chat when it is done.`, summary: `Queued a new ${out.image.width} x ${out.image.height} picture on ${out.backend.label}.` };
  }
  const src = await sourceOf(s, p, conversationId, args.image);
  await settled(s, p, src.id);
  if (op === 'image_restyle') {
    const out = await s.images.restyle(p, { source: src.id, prompt: String(args.prompt ?? ''), label: ctx.label, conversationId });
    return { image: shown(out.image), source: { id: src.id, picked: src.picked }, model: out.backend.label, note: `Queued on ${out.backend.label}; the redrawn picture appears in the chat when it is done.`, summary: `Queued a redrawn picture on ${out.backend.label}.` };
  }
  const queued = await s.images.edit(p, { source: src.id, ops: opsOf(op, args), label: ctx.label, conversationId });
  const done = await s.images.waitFor(p, queued.id, EDIT_WAIT_MS);
  if (done.state === 'failed' || done.state === 'withheld') throw new ImageToolRefused(done.error ?? `The edit was ${done.state}${done.stage ? `: ${done.stage}` : ''}.`);
  return { image: shown(done), source: { id: src.id, picked: src.picked }, ...(done.state !== 'succeeded' ? { note: 'Still being made; it appears in the chat when it is done.' } : {}), summary: `${done.state === 'succeeded' ? 'Made' : 'Is making'} a new picture, ${done.width} x ${done.height}, by ${done.edit ?? 'an edit'}.` };
}
