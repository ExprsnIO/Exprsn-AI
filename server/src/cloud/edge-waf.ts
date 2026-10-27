import type { Config } from '../config/index.js';

/*
 * 1.9.99-final, Sprint 61 (B-10903): the Cloudflare WAF and rate limits of a front door, rendered from the server's
 * own limits, and a small evaluator of the rules as Cloudflare would run them (the "simulated edge" the suite and the
 * preview use; nothing here calls Cloudflare).
 *
 * Phases (Cloudflare Rulesets API, one zone entrypoint each; rules this build owns carry a `ref` starting `exprsn-`,
 * and every other rule in the phase is kept where it was):
 *
 *   http_request_firewall_managed  the Cloudflare Managed Ruleset (the Free Managed Ruleset on the free plan) and,
 *                                  from Pro, the OWASP Core Ruleset, with the OWASP set skipped for model prompts
 *                                  (/v1 and the chat API carry code and SQL that it would flag)
 *   http_request_firewall_custom   TRACE, TRACK and CONNECT blocked; an optional allow-list for /api/admin
 *   http_ratelimit                 sign-in, /api/auth, /v1 and /api, mirroring the server's limiters (see below), as
 *                                  many as the plan allows, in that order
 *   http_request_cache_settings    no caching for /api, /v1, /socket.io/ and the streaming paths
 *   http_config_settings           /socket.io/ and the streaming paths exempt from the features that buffer or rewrite
 *                                  a response (email obfuscation, Rocket Loader, Mirage, HTTPS rewrites, server-side
 *                                  excludes), so a stream reaches the browser as it is written
 *
 * Mirroring: each edge limit counts per client address and Cloudflare data centre (`ip.src`, `cf.colo.id`) over the
 * longest period the plan allows that is not longer than the server's window, with the server's count, so the edge
 * never refuses what the server would allow, except sign-in, where the edge allows one attempt fewer than the
 * failed-sign-in throttle (LOCKOUT_MAX_ATTEMPTS) and blocks for the rest of the lockout window (or the plan's longest
 * block): a burst of guesses stops at the edge before the server's throttle has counted enough of them to lock the
 * account. The server's own limiters stay in force behind it.
 */

export type CfPlan = 'free' | 'pro' | 'business' | 'enterprise';

/** Rate limiting rules per plan, as this build records Cloudflare's availability table. */
export const RATE_LIMIT_PLANS: Record<CfPlan, { rules: number; periods: number[]; timeouts: number[] }> = {
  free: { rules: 1, periods: [10], timeouts: [10] },
  pro: { rules: 2, periods: [10, 60], timeouts: [10, 60, 600, 3600] },
  business: { rules: 5, periods: [10, 60, 120, 300, 600], timeouts: [10, 60, 120, 300, 600, 3600, 86400] },
  enterprise: { rules: 100, periods: [10, 60, 120, 300, 600, 3600], timeouts: [10, 60, 120, 300, 600, 3600, 86400] }
};

/** Cloudflare's managed rulesets (their published ids). */
export const MANAGED_RULESETS = {
  cloudflare: 'efb7b8c949ac4650a09736fc376e9aee',
  free: '77454fe2d30c4220b5701f6fdfb893ba',
  owasp: '4814384a9e5d4991b9815dcfc25d2f1f'
} as const;

/** Responses that stream: Server-Sent Events from /v1 and the chat API's catch-up, and the socket. */
export const STREAMING_PATHS: readonly string[] = ['/v1/chat/completions', '/v1/responses', '/v1/completions'];
export const SOCKET_PATH = '/socket.io/';
/** The password sign-in the failed-sign-in throttle counts (`routes/auth.ts`). */
export const SIGN_IN_PATH = '/api/auth/login';
/** Model prompts: the OWASP Core Ruleset is skipped for these bodies. */
export const PROMPT_PATHS: readonly string[] = ['/v1/', '/api/chat/', '/api/conversations/'];

/** The server's own limits the edge mirrors (`http/app.ts`, `openai/routes.ts`, the failed-sign-in throttle). */
export interface ServerLimits {
  /** `/api`, per person or address and minute (API_RATE_PER_MINUTE). */
  apiPerMinute: number;
  /** `/api/auth` changes (sign-in, MFA, password reset), per minute. */
  authPerMinute: number;
  /** `/v1`, per key and minute. */
  v1PerMinute: number;
  /** Failed sign-ins before an account locks, and the window (LOCKOUT_*). */
  lockoutMax: number;
  lockoutWindowS: number;
  lockoutDurationS: number;
}

export function serverLimits(cfg: Pick<Config, 'API_RATE_PER_MINUTE' | 'LOCKOUT_MAX_ATTEMPTS' | 'LOCKOUT_WINDOW_MINUTES' | 'LOCKOUT_DURATION_MINUTES'>): ServerLimits {
  return { apiPerMinute: cfg.API_RATE_PER_MINUTE, authPerMinute: 30, v1PerMinute: 600, lockoutMax: cfg.LOCKOUT_MAX_ATTEMPTS, lockoutWindowS: cfg.LOCKOUT_WINDOW_MINUTES * 60, lockoutDurationS: cfg.LOCKOUT_DURATION_MINUTES * 60 };
}

export interface CfRule {
  ref: string;
  description: string;
  expression: string;
  action: string;
  action_parameters?: Record<string, unknown>;
  ratelimit?: { characteristics: string[]; period: number; requests_per_period: number; mitigation_timeout: number };
  enabled: boolean;
}

export type WafPhase = 'http_request_firewall_managed' | 'http_request_firewall_custom' | 'http_ratelimit' | 'http_request_cache_settings' | 'http_config_settings';
export const WAF_PHASES: readonly WafPhase[] = ['http_request_firewall_managed', 'http_request_firewall_custom', 'http_ratelimit', 'http_request_cache_settings', 'http_config_settings'];

export interface WafRender {
  plan: CfPlan;
  phases: Record<WafPhase, CfRule[]>;
  /** How each server limit was mirrored, or why it was left to the server. */
  mirrored: { limit: string; server: string; edge: string | null; note: string | null }[];
  notes: string[];
}

export interface WafOptions {
  /** Addresses or ranges allowed to reach /api/admin (empty: no allow-list). */
  adminCidrs?: string[];
}

const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const startsWith = (p: string) => `starts_with(http.request.uri.path, ${q(p)})`;
const anyOf = (xs: string[]) => (xs.length === 1 ? xs[0]! : `(${xs.join(' or ')})`);
const streamingOrSocket = () => anyOf([startsWith(SOCKET_PATH), ...STREAMING_PATHS.map((p) => `http.request.uri.path eq ${q(p)}`)]);

/** The longest allowed period not longer than the window (or the shortest one). */
function periodFor(plan: CfPlan, windowS: number): number {
  const ps = RATE_LIMIT_PLANS[plan].periods;
  return [...ps].reverse().find((p) => p <= windowS) ?? ps[0]!;
}
function timeoutFor(plan: CfPlan, wantS: number): number {
  const ts = RATE_LIMIT_PLANS[plan].timeouts;
  return [...ts].reverse().find((t) => t <= wantS) ?? ts[0]!;
}

export function renderWaf(limits: ServerLimits, plan: CfPlan, o: WafOptions = {}): WafRender {
  const notes: string[] = [];
  const mirrored: WafRender['mirrored'] = [];
  const managed: CfRule[] = [];
  const owasp = plan !== 'free';
  if (owasp) managed.push({ ref: 'exprsn-skip-owasp-prompts', description: 'exprsn: model prompts carry code and SQL; skip the OWASP Core Ruleset for them', expression: `(http.request.method eq "POST" and ${anyOf(PROMPT_PATHS.map(startsWith))})`, action: 'skip', action_parameters: { rulesets: [MANAGED_RULESETS.owasp] }, enabled: true });
  managed.push({ ref: 'exprsn-managed', description: 'exprsn: Cloudflare managed ruleset', expression: 'true', action: 'execute', action_parameters: { id: plan === 'free' ? MANAGED_RULESETS.free : MANAGED_RULESETS.cloudflare }, enabled: true });
  if (owasp) managed.push({ ref: 'exprsn-owasp', description: 'exprsn: OWASP Core Ruleset', expression: 'true', action: 'execute', action_parameters: { id: MANAGED_RULESETS.owasp }, enabled: true });
  else notes.push('The free plan has the Free Managed Ruleset only; the OWASP Core Ruleset needs Pro or above.');

  const custom: CfRule[] = [{ ref: 'exprsn-block-methods', description: 'exprsn: methods the server never answers', expression: 'http.request.method in {"TRACE" "TRACK" "CONNECT"}', action: 'block', enabled: true }];
  if (o.adminCidrs?.length) custom.push({ ref: 'exprsn-admin-allow', description: 'exprsn: the admin API only from the allowed addresses', expression: `(starts_with(lower(http.request.uri.path), ${q('/api/admin/')}) and not ip.src in {${o.adminCidrs.join(' ')}})`, action: 'block', enabled: true });

  // Rate limits, in priority order; the plan decides how many are rendered.
  const p = RATE_LIMIT_PLANS[plan];
  const characteristics = ['ip.src', 'cf.colo.id'];
  const signInPeriod = periodFor(plan, limits.lockoutWindowS);
  const signInCount = Math.max(1, limits.lockoutMax - 1);
  const candidates: { rule: CfRule; limit: string; server: string }[] = [
    {
      limit: 'sign-in',
      server: `${limits.lockoutMax} failed sign-ins per ${limits.lockoutWindowS / 60} min lock the account (LOCKOUT_MAX_ATTEMPTS)`,
      rule: {
        ref: 'exprsn-rl-signin',
        description: 'exprsn: sign-in attempts, one fewer than the server throttle allows',
        expression: `(http.request.method eq "POST" and http.request.uri.path eq ${q(SIGN_IN_PATH)})`,
        action: 'block',
        ratelimit: { characteristics, period: signInPeriod, requests_per_period: signInCount, mitigation_timeout: timeoutFor(plan, Math.max(limits.lockoutWindowS, limits.lockoutDurationS)) },
        enabled: true
      }
    },
    {
      limit: '/api/auth',
      server: `${limits.authPerMinute} changes a minute`,
      rule: { ref: 'exprsn-rl-auth', description: 'exprsn: /api/auth changes, as the server limits them', expression: `(http.request.method ne "GET" and ${startsWith('/api/auth/')})`, action: 'block', ratelimit: { characteristics, period: periodFor(plan, 60), requests_per_period: limits.authPerMinute, mitigation_timeout: timeoutFor(plan, 60) }, enabled: true }
    },
    {
      limit: '/v1',
      server: `${limits.v1PerMinute} requests a minute per key`,
      rule: { ref: 'exprsn-rl-v1', description: 'exprsn: the OpenAI-compatible API, as the server limits it', expression: startsWith('/v1/'), action: 'block', ratelimit: { characteristics, period: periodFor(plan, 60), requests_per_period: limits.v1PerMinute, mitigation_timeout: timeoutFor(plan, 60) }, enabled: true }
    },
    {
      limit: '/api',
      server: `${limits.apiPerMinute} requests a minute (API_RATE_PER_MINUTE)`,
      rule: { ref: 'exprsn-rl-api', description: 'exprsn: the API, as the server limits it', expression: `(${startsWith('/api/')} and not ${startsWith('/api/public/')})`, action: 'block', ratelimit: { characteristics, period: periodFor(plan, 60), requests_per_period: limits.apiPerMinute, mitigation_timeout: timeoutFor(plan, 60) }, enabled: true }
    }
  ];
  const ratelimit: CfRule[] = [];
  for (const [i, c] of candidates.entries()) {
    if (i < p.rules) {
      ratelimit.push(c.rule);
      const r = c.rule.ratelimit!;
      mirrored.push({ limit: c.limit, server: c.server, edge: `${r.requests_per_period} per ${r.period} s, then blocked ${r.mitigation_timeout} s`, note: c.limit !== 'sign-in' && r.period < 60 ? `The ${plan} plan counts over ${r.period} s at most, so the edge allows the server's count per ${r.period} s and the server's limiter stays the one that refuses.` : null });
    } else mirrored.push({ limit: c.limit, server: c.server, edge: null, note: `The ${plan} plan allows ${p.rules} rate limiting rule${p.rules === 1 ? '' : 's'}; the server's own limiter covers this one.` });
  }

  const cache: CfRule[] = [{ ref: 'exprsn-no-cache', description: 'exprsn: never cache the API, the socket or streams', expression: anyOf([startsWith('/api/'), startsWith('/v1/'), streamingOrSocket()]), action: 'set_cache_settings', action_parameters: { cache: false }, enabled: true }];
  const config: CfRule[] = [{ ref: 'exprsn-stream-unbuffered', description: 'exprsn: the socket and streams pass unbuffered and unrewritten', expression: streamingOrSocket(), action: 'set_config', action_parameters: { email_obfuscation: false, rocket_loader: false, mirage: false, automatic_https_rewrites: false, server_side_excludes: false }, enabled: true }];

  return { plan, phases: { http_request_firewall_managed: managed, http_request_firewall_custom: custom, http_ratelimit: ratelimit, http_request_cache_settings: cache, http_config_settings: config }, mirrored, notes };
}

// ---------- the simulated edge ----------

/** One request as the edge sees it. */
export interface EdgeRequest {
  method: string;
  path: string;
  ip: string;
  /** Seconds (the simulation's clock). */
  at: number;
  colo?: string;
}

export interface EdgeDecision {
  request: EdgeRequest;
  /** `origin` when the request reaches the server. */
  outcome: 'origin' | 'blocked';
  /** The rule that blocked it. */
  rule: string | null;
  /** Whether the response would pass unbuffered (an `exprsn-stream-unbuffered` match). */
  unbuffered: boolean;
  cached: boolean;
}

/**
 * Runs requests through the given phases' rules in order: custom rules, then rate limits (a fixed window per rule
 * and characteristic, then a block for the mitigation timeout, as Cloudflare's rate limiting rules count), then the
 * cache and configuration rules for what passes. Managed rulesets are taken as passing (their content is
 * Cloudflare's).
 */
export function simulateEdge(phases: Partial<Record<WafPhase, CfRule[]>>, requests: EdgeRequest[]): EdgeDecision[] {
  const counters = new Map<string, { start: number; count: number; blockedUntil: number }>();
  const out: EdgeDecision[] = [];
  for (const req of requests) {
    const ctx = { method: req.method.toUpperCase(), path: req.path, ip: req.ip };
    let blocked: string | null = null;
    for (const r of phases.http_request_firewall_custom ?? []) {
      if (r.enabled && r.action === 'block' && evaluateExpression(r.expression, ctx)) {
        blocked = r.ref;
        break;
      }
    }
    if (!blocked) {
      for (const r of phases.http_ratelimit ?? []) {
        if (!r.enabled || !r.ratelimit || !evaluateExpression(r.expression, ctx)) continue;
        const key = `${r.ref}|${r.ratelimit.characteristics.map((c) => (c === 'ip.src' ? req.ip : c === 'cf.colo.id' ? (req.colo ?? 'AMS') : '')).join('|')}`;
        const c = counters.get(key) ?? { start: req.at, count: 0, blockedUntil: -1 };
        if (req.at < c.blockedUntil) {
          blocked = r.ref;
          counters.set(key, c);
          break;
        }
        if (req.at - c.start >= r.ratelimit.period) {
          c.start = req.at;
          c.count = 0;
        }
        c.count += 1;
        if (c.count > r.ratelimit.requests_per_period) {
          c.blockedUntil = req.at + r.ratelimit.mitigation_timeout;
          blocked = r.ref;
        }
        counters.set(key, c);
        if (blocked) break;
      }
    }
    const unbuffered = (phases.http_config_settings ?? []).some((r) => r.enabled && r.action === 'set_config' && r.action_parameters?.email_obfuscation === false && evaluateExpression(r.expression, ctx));
    const noCache = (phases.http_request_cache_settings ?? []).some((r) => r.enabled && r.action === 'set_cache_settings' && r.action_parameters?.cache === false && evaluateExpression(r.expression, ctx));
    out.push({ request: req, outcome: blocked ? 'blocked' : 'origin', rule: blocked, unbuffered, cached: !noCache });
  }
  return out;
}

// ---------- a small evaluator of Cloudflare's rules language (the subset this build writes) ----------

interface EvalCtx {
  method: string;
  path: string;
  ip: string;
}

type Tok = { t: 'str' | 'id' | 'op' | 'num'; v: string };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '"') {
      let s = '';
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\') i++;
        s += src[i++];
      }
      i++;
      out.push({ t: 'str', v: s });
      continue;
    }
    if ('(){},'.includes(ch)) {
      out.push({ t: 'op', v: ch });
      i++;
      continue;
    }
    const rest = src.slice(i);
    const addr = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F]*:[0-9a-fA-F:]*)(?:\/\d{1,3})?(?![A-Za-z0-9_.])/.exec(rest);
    const m = addr ?? /^[A-Za-z_][A-Za-z0-9_.]*/.exec(rest);
    if (!m) throw new Error(`Unexpected ${ch} at ${i} in the expression.`);
    out.push({ t: addr ? 'num' : 'id', v: m[0] });
    i += m[0].length;
  }
  return out;
}

/** Evaluates an expression of the rules language subset this build renders (fields, eq, ne, in, starts_with, and, or, not). */
export function evaluateExpression(expression: string, ctx: EvalCtx): boolean {
  const toks = lex(expression);
  let pos = 0;
  const peek = () => toks[pos];
  const take = (v?: string) => {
    const t = toks[pos++];
    if (!t || (v !== undefined && t.v !== v)) throw new Error(`Expected ${v ?? 'a token'} in ${expression}`);
    return t;
  };
  const field = (name: string): string => {
    if (name === 'http.request.uri.path') return ctx.path;
    if (name === 'http.request.method') return ctx.method;
    if (name === 'ip.src') return ctx.ip;
    throw new Error(`The simulated edge does not know the field ${name}.`);
  };
  const inSet = (value: string, items: string[], isIp: boolean): boolean => (isIp ? items.some((c) => cidrHas(c, value)) : items.includes(value));
  const primary = (): boolean => {
    const t = peek();
    if (!t) throw new Error('Unexpected end of expression.');
    if (t.v === '(') {
      take('(');
      const v = or();
      take(')');
      return v;
    }
    if (t.v === 'not') {
      take();
      return !primary();
    }
    if (t.v === 'true') {
      take();
      return true;
    }
    if (t.v === 'false') {
      take();
      return false;
    }
    if (t.v === 'starts_with') {
      take();
      take('(');
      // B-10803: `lower(field)`, as the admin allow-list renders it (the server routes paths case-insensitively).
      let f: string;
      if (peek()?.v === 'lower') {
        take();
        take('(');
        f = field(take().v).toLowerCase();
        take(')');
      } else f = field(take().v);
      take(',');
      const s = take().v;
      take(')');
      return f.startsWith(s);
    }
    const name = take().v;
    const op = take().v;
    if (op === 'eq' || op === 'ne') {
      const rhs = take().v;
      return op === 'eq' ? field(name) === rhs : field(name) !== rhs;
    }
    if (op === 'in') {
      take('{');
      const items: string[] = [];
      while (peek() && peek()!.v !== '}') items.push(take().v);
      take('}');
      return inSet(field(name), items, name === 'ip.src');
    }
    throw new Error(`The simulated edge does not know the operator ${op}.`);
  };
  const and = (): boolean => {
    let v = primary();
    while (peek()?.v === 'and') {
      take();
      const r = primary();
      v = v && r;
    }
    return v;
  };
  const or = (): boolean => {
    let v = and();
    while (peek()?.v === 'or') {
      take();
      const r = and();
      v = v || r;
    }
    return v;
  };
  const v = or();
  if (pos !== toks.length) throw new Error(`Unexpected ${toks[pos]!.v} in ${expression}`);
  return v;
}

function cidrHas(cidr: string, ip: string): boolean {
  const [net, len] = cidr.split('/');
  if (len === undefined) return net === ip;
  if (!net!.includes('.') || !ip.includes('.')) return false;
  const n = (a: string) => a.split('.').reduce((acc, x) => (acc << 8) + Number(x), 0) >>> 0;
  const bits = Number(len);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (n(net!) & mask) === (n(ip) & mask);
}
