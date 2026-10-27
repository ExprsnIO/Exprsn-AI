import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isUniqueViolation } from '../audit/chain.js';
import type { Label } from '../authz/labels.js';
import type { Permission } from '../authz/permissions.js';
import { authorize, type Principal } from '../authz/policy.js';
import { loadPrincipal, workspacesFor } from '../http/middleware.js';
import { tooManyRequests } from '../http/problem.js';
import { Limiter } from '../platform/ratelimit.js';
import type { Services } from '../services.js';

/*
 * The signed, replay-safe incoming webhook shared by app flows (`apps/flow-hooks.ts`, migration 082) and workflows
 * (`workflows/hooks.ts`, B-130, migration 085). Each caller keeps its own rows, routes, audit actions and owner rules;
 * this module holds what must be the same for both:
 *
 * - The body is JSON, at most HOOK_MAX_BYTES. `X-Exprsn-Timestamp` is the sending time in Unix seconds and
 *   `X-Exprsn-Signature` is `sha256=<hex>`, the HMAC-SHA256 under the hook's secret of `<timestamp>.<raw body>`: the
 *   timestamp is signed with the body, so an old request cannot be sent again with a fresh time.
 * - A timestamp more than HOOK_WINDOW_SECONDS from now is refused; a signature seen before (kept in the shared
 *   `app_flow_hook_nonces` table for twice the window, keyed by the hook's id, across instances) is a replay.
 * - The secret is 32 random bytes, shown once when it is made or rotated, sealed under the tenant key with the
 *   caller's associated data. Rotating replaces it at once and forgets the signatures seen.
 * - Every request is rate-limited per hook (HOOK_RATE_PER_MINUTE, in the shared counter store) before anything else.
 * - The verified payload passes the `untrusted-content` and `user-input` checkpoints before a run exists; a redaction
 *   carries on only when the redacted text is still a JSON object.
 * - The owner (who turned the hook on) is loaded again for every request: active, holding what the caller asks,
 *   still in the workspace the run will live in.
 *
 * A refusal goes through the caller's `refuse`, which audits it in the caller's terms and throws the problem.
 */

export const HOOK_MAX_BYTES = 64 * 1024;
export const HOOK_WINDOW_SECONDS = 300;
export const HOOK_RATE_PER_MINUTE = 60;
export const SIGNATURE_HEADER = 'x-exprsn-signature';
export const TIMESTAMP_HEADER = 'x-exprsn-timestamp';
const NONCES = 'app_flow_hook_nonces';

/** The signature a sender puts in `X-Exprsn-Signature` (exported for clients and tests). */
export function signHook(secret: string, timestamp: number | string, body: string | Buffer): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex')}`;
}

/** A new hook secret (shown once, then sealed). */
export const newHookSecret = (): string => `whsec_${randomBytes(32).toString('base64url')}`;

/** The headers a sender sets, as the console and the status routes describe them. */
export const HOOK_SIGNING = {
  signature: 'X-Exprsn-Signature: sha256=HMAC-SHA256(secret, "<timestamp>.<body>")',
  timestamp: 'X-Exprsn-Timestamp: Unix seconds, within 5 minutes',
  maxBytes: HOOK_MAX_BYTES,
  ratePerMinute: HOOK_RATE_PER_MINUTE
} as const;

/** A shell example that signs and sends a body (the secret stays in an environment variable). */
export function curlExample(url: string): string {
  return [
    "body='{\"example\":true}'",
    'ts=$(date +%s)',
    'sig=$(printf \'%s.%s\' "$ts" "$body" | openssl dgst -sha256 -hmac "$EXPRSN_HOOK_SECRET" | sed \'s/^.* //\')',
    `curl -sS -X POST '${url}' \\`,
    "  -H 'Content-Type: application/json' \\",
    '  -H "X-Exprsn-Timestamp: $ts" \\',
    '  -H "X-Exprsn-Signature: sha256=$sig" \\',
    '  --data "$body"'
  ].join('\n');
}

/** What arrived, as the public route read it. */
export interface SignedRequest {
  raw: Buffer;
  signature: string | undefined;
  timestamp: string | undefined;
  ip: string | null;
  traceId?: string;
}

/** Audits a refusal in the caller's terms and throws the problem. */
export type Refuse = (status: number, title: string, reason: string, detail: string, label?: Label) => Promise<never>;

export class SignedHooks {
  private limiterCache: Limiter | null = null;

  constructor(
    private readonly s: () => Services,
    /** The counter namespace of this kind of hook (`app-flow-hook`, `workflow-hook`). */
    private readonly name: string
  ) {}

  private get limiter(): Limiter {
    return (this.limiterCache ??= new Limiter(this.s().counters, this.name, HOOK_RATE_PER_MINUTE, 60_000));
  }

  /** Counts a request against the hook's limit; 429 past it. */
  async limit(key: string): Promise<void> {
    const limit = await this.limiter.consume(key);
    if (!limit.allowed) throw tooManyRequests('Too many webhook requests for this hook; try again shortly.', limit.resetMs / 1000);
  }

  /** A new secret for a hook, sealed; the signatures seen under the old one are forgotten. */
  async make(tenantId: string, key: string, aad: string): Promise<{ secret: string; sealed: string; at: number }> {
    const secret = newHookSecret();
    const sealed = await this.s().keys.seal(tenantId, secret, aad);
    await this.forget(key);
    return { secret, sealed, at: Date.now() };
  }

  /** Forgets the signatures seen for a hook (its secret changed, or it is gone). */
  async forget(key: string): Promise<void> {
    await this.s().db(NONCES).where({ flow_id: key }).delete();
  }

  /**
   * Size, timestamp, signature and replay, then the body as a JSON object. `key` names the hook in the nonce table
   * (a flow or workflow id: both are ULIDs, so they never collide).
   */
  async verify(o: { key: string; tenantId: string; sealedSecret: string; aad: string }, req: SignedRequest, refuse: Refuse): Promise<Record<string, unknown>> {
    if (req.raw.length > HOOK_MAX_BYTES) await refuse(413, 'Payload too large', 'oversize', `A webhook body is at most ${HOOK_MAX_BYTES} bytes.`);
    const ts = /^\d{1,12}$/.test(req.timestamp ?? '') ? Number(req.timestamp) : NaN;
    if (!Number.isFinite(ts)) await refuse(401, 'Unauthorized', 'no timestamp', 'X-Exprsn-Timestamp (Unix seconds) is required.');
    if (Math.abs(Date.now() / 1000 - ts) > HOOK_WINDOW_SECONDS) await refuse(401, 'Unauthorized', 'stale timestamp', `The timestamp is more than ${HOOK_WINDOW_SECONDS / 60} minutes from the server's time.`);
    const secret = await this.s().keys.open(o.tenantId, o.sealedSecret, o.aad);
    const given = /^sha256=([0-9a-f]{64})$/i.exec((req.signature ?? '').trim());
    const expected = Buffer.from(signHook(secret, req.timestamp!, req.raw).slice(7), 'hex');
    if (!given || !timingSafeEqual(Buffer.from(given[1]!.toLowerCase(), 'hex'), expected)) await refuse(401, 'Unauthorized', 'bad signature', 'The X-Exprsn-Signature header does not verify.');
    // Replays: each signature is accepted once while its timestamp could still pass.
    const db = this.s().db;
    const now = Date.now();
    await db(NONCES).where('expires_at', '<', now).delete();
    try {
      await db(NONCES).insert({ flow_id: o.key, digest: createHash('sha256').update(expected).digest('hex'), expires_at: now + 2 * HOOK_WINDOW_SECONDS * 1000 });
    } catch (err) {
      if (isUniqueViolation(err)) await refuse(409, 'Replay', 'replay', 'This request was received before.');
      throw err;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(req.raw.toString('utf8'));
    } catch {
      return refuse(400, 'Invalid request', 'not json', 'The body is not JSON.');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) await refuse(400, 'Invalid request', 'not an object', 'The body is a JSON object.');
    return payload as Record<string, unknown>;
  }

  /**
   * The owner as a principal now, acting in `workspaceId`, or why the hook cannot start anything. `needs` are the
   * permissions the owner must still hold, each with the reason given when it is gone.
   */
  async owner(tenantId: string, ownerId: string | null | undefined, workspaceId: string | null, needs: readonly (readonly [Permission, string])[]): Promise<Principal | string> {
    if (!ownerId) return 'the hook has no owner';
    const s = this.s();
    const p = await loadPrincipal(s, tenantId, ownerId, {});
    if (!p) return 'the owner is disabled or no longer exists';
    for (const [perm, why] of needs) if (!authorize(p, perm).allow) return why;
    if (workspaceId) {
      if (!(await workspacesFor(s, p)).some((w) => w.id === workspaceId)) return "the owner is no longer a member of the workflow's workspace";
      p.workspaceId = workspaceId;
    } else p.workspaceId = null;
    return p;
  }

  /** The content rules before any step sees the payload: prompt injection first, then the user-input rules. */
  async screen(o: { tenantId: string; principal: Principal; label: Label; source: { kind: string; id: string }; meta: Record<string, unknown> }, payload: Record<string, unknown>, refuse: Refuse): Promise<Record<string, unknown>> {
    let text = JSON.stringify(payload);
    for (const checkpoint of ['untrusted-content', 'user-input'] as const) {
      const g = await this.s().guardrails.check({ tenantId: o.tenantId, workspaceId: o.principal.workspaceId ?? null, checkpoint, text, label: o.label, principal: o.principal, source: o.source, meta: o.meta });
      if (g.action === 'block' || g.action === 'require-approval') await refuse(422, 'Payload refused', `guardrail ${checkpoint}`, `The payload was refused by the content rules${g.reason ? `: ${g.reason}` : '.'}`, o.label);
      if (g.action === 'redact') {
        try {
          const redacted = JSON.parse(g.text) as unknown;
          if (!redacted || typeof redacted !== 'object' || Array.isArray(redacted)) throw new Error('not an object');
          text = g.text;
        } catch {
          await refuse(422, 'Payload refused', `guardrail ${checkpoint} redaction`, 'The content rules redact this payload in a way that leaves no JSON object.', o.label);
        }
      }
    }
    return JSON.parse(text) as Record<string, unknown>;
  }
}
