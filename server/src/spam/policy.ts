import { z } from 'zod';
import { SURFACES, type Surface } from './signals.js';

/*
 * 1.9.0, Sprint 50 (B-159 to B-161): a tenant's spam and flood policy. Every field has a default, so a stored policy
 * keeps only what an admin changed and later defaults reach it. Every surface starts in `shadow`: scores only, no
 * action, until an admin switches it to `enforce`.
 */

export const MODES = ['off', 'shadow', 'enforce'] as const;
export type Mode = (typeof MODES)[number];

export const RESPONSE_KINDS = ['slow', 'hold', 'limit', 'case'] as const;
export type ResponseKind = (typeof RESPONSE_KINDS)[number];
export const LEVELS = ['none', ...RESPONSE_KINDS] as const;
export type Level = (typeof LEVELS)[number];
export const levelRank = (l: Level): number => LEVELS.indexOf(l);

const count = z.number().int().min(1).max(1_000_000);

export const surfaceSchema = z
  .object({
    mode: z.enum(MODES).default('shadow'),
    /** The rate window in seconds. */
    windowSeconds: z.number().int().min(10).max(86_400).default(600),
    /** At most this many events per window per account, per IP range and per tenant. */
    account: count.default(30),
    ip: count.default(120),
    tenant: count.default(5000)
  })
  .strict();
export type SurfacePolicy = z.infer<typeof surfaceSchema>;

/** Built-in thresholds per surface (the account, IP range and tenant counts in the default window of 10 minutes). */
const SURFACE_DEFAULTS: Record<Surface, Partial<SurfacePolicy>> = {
  post: { account: 20, ip: 60, tenant: 3000 },
  comment: { account: 40, ip: 120, tenant: 6000 },
  message: { account: 60, ip: 200, tenant: 10_000 },
  follow: { account: 50, ip: 150, tenant: 5000 },
  invite: { account: 30, ip: 90, tenant: 2000 },
  report: { account: 20, ip: 60, tenant: 2000 },
  signup: { account: 3, ip: 10, tenant: 200 },
  signin_failed: { account: 10, ip: 50, tenant: 1000 },
  firehose: { account: 120, ip: 1_000_000, tenant: 1_000_000 }
};

export const patternSchema = z
  .object({
    /** The window the pattern detectors look back over, in seconds. */
    windowSeconds: z.number().int().min(60).max(86_400).default(3600),
    /** Near-duplicates: SimHash fingerprints within this many bits. */
    hamming: z.number().int().min(0).max(24).default(12),
    /** The same (near-duplicate) text sent to this many different places by one account. */
    duplicateRecipients: count.default(5),
    /** This many links in the window. */
    linkBurst: count.default(15),
    /** This many links to domains first seen in the tenant in the last `newDomainHours`. */
    newDomains: count.default(4),
    newDomainHours: z.number().int().min(1).max(720).default(24),
    /** Mentions or hashtags in one text. */
    mentions: count.default(10),
    hashtags: count.default(10),
    /** An account younger than this making at least `newAccountEvents` writes in the window. */
    newAccountHours: z.number().int().min(1).max(720).default(24),
    newAccountEvents: count.default(15),
    /** This many different accounts sending near-duplicates of the same text in the window. */
    clusterAccounts: count.default(4)
  })
  .strict();
export type PatternPolicy = z.infer<typeof patternSchema>;

const responseBase = z
  .object({
    /** The score steps: from each one up, its response applies on an enforcing surface. */
    slowAt: z.number().int().min(1).max(100).default(40),
    holdAt: z.number().int().min(1).max(100).default(60),
    limitAt: z.number().int().min(1).max(100).default(75),
    caseAt: z.number().int().min(1).max(100).default(90),
    /** Slow mode: at least this many seconds between writes. */
    slowSeconds: z.number().int().min(5).max(3600).default(60),
    /** The temporary posting limit: at most this many writes an hour. */
    limitPerHour: z.number().int().min(0).max(1000).default(5),
    /** How long a slow mode, hold or limit lasts, in minutes. */
    durationMinutes: z.number().int().min(5).max(7 * 24 * 60).default(60),
    /** A score halves every this many minutes. */
    halfLifeMinutes: z.number().int().min(5).max(30 * 24 * 60).default(360)
  })
  .strict();
export const responseSchema = responseBase.refine((r) => r.slowAt <= r.holdAt && r.holdAt <= r.limitAt && r.limitAt <= r.caseAt, { message: 'The steps must rise: slowAt ≤ holdAt ≤ limitAt ≤ caseAt.' });
export type ResponsePolicy = z.infer<typeof responseSchema>;

const surfaceOverride = z
  .object({ mode: z.enum(MODES).optional(), windowSeconds: z.number().int().min(10).max(86_400).optional(), account: count.optional(), ip: count.optional(), tenant: count.optional() })
  .strict();

/** What an admin sends (and what is stored): any part may be left out. */
export const policyInput = z
  .object({
    enabled: z.boolean().optional(),
    surfaces: z.partialRecord(z.enum(SURFACES), surfaceOverride).optional(),
    patterns: patternSchema.partial().optional(),
    responses: responseBase.partial().optional(),
    allowList: z.array(z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'a user id')).max(500).optional()
  })
  .strict();
export type PolicyInput = z.infer<typeof policyInput>;

export interface Policy {
  enabled: boolean;
  surfaces: Record<Surface, SurfacePolicy>;
  patterns: PatternPolicy;
  responses: ResponsePolicy;
  allowList: string[];
}

/** The stored overrides over the defaults; invalid parts throw a ZodError (the route answers 400). */
export function resolvePolicy(stored: { enabled?: boolean; surfaces?: Partial<Record<Surface, Partial<SurfacePolicy>>>; patterns?: Partial<PatternPolicy>; responses?: Partial<ResponsePolicy>; allowList?: string[] } | null): Policy {
  const surfaces = {} as Record<Surface, SurfacePolicy>;
  for (const s of SURFACES) surfaces[s] = surfaceSchema.parse({ ...SURFACE_DEFAULTS[s], ...(stored?.surfaces?.[s] ?? {}) });
  return {
    enabled: stored?.enabled ?? false,
    surfaces,
    patterns: patternSchema.parse(stored?.patterns ?? {}),
    responses: responseSchema.parse(stored?.responses ?? {}),
    allowList: [...new Set(stored?.allowList ?? [])]
  };
}

/** The step a score reaches under the policy. */
export function levelFor(score: number, r: ResponsePolicy): Level {
  if (score >= r.caseAt) return 'case';
  if (score >= r.limitAt) return 'limit';
  if (score >= r.holdAt) return 'hold';
  if (score >= r.slowAt) return 'slow';
  return 'none';
}
