import type { Provider } from './types.js';

/*
 * 1.9.99-final, Sprint 56 (B-100): the tags every resource Exprsn-AI creates carries, and that the generated cloud
 * policies are conditioned on: `exprsn:managed=true`, `exprsn:account`, `exprsn:deployment`, and where they apply
 * `exprsn:tenant`, `exprsn:workspace` and `exprsn:pool`. Adapters build them here and nowhere else.
 *
 * AWS and Azure take key/value tags. DigitalOcean tags are plain strings (letters, digits, `:`, `-`, `_`, at most 255
 * characters), so a tag is written `exprsn:account:<value>`. Cloudflare has no general resource tags: its adapter
 * names resources with `namePrefix` and keeps the tags in the journal.
 */

export const TAG_PREFIX = 'exprsn:';
export const TAG_KEYS = ['managed', 'account', 'deployment', 'tenant', 'workspace', 'pool'] as const;
export type TagKey = (typeof TAG_KEYS)[number];

export interface TagInput {
  /** The account's name (immutable, lower case). */
  account: string;
  deployment?: string | null;
  tenant?: string | null;
  workspace?: string | null;
  pool?: string | null;
}

const VALUE = /^[a-z0-9][a-z0-9._-]{0,62}$/i;

function clean(name: string, v: string): string {
  if (!VALUE.test(v)) throw new Error(`The ${name} tag value must be 1 to 63 letters, digits, dots, dashes or underscores.`);
  return v;
}

/** The `exprsn:*` tags as key/value pairs, in a fixed order. */
export function cloudTags(input: TagInput): Record<string, string> {
  const out: Record<string, string> = { [`${TAG_PREFIX}managed`]: 'true', [`${TAG_PREFIX}account`]: clean('account', input.account) };
  for (const k of ['deployment', 'tenant', 'workspace', 'pool'] as const) {
    const v = input[k];
    if (v) out[`${TAG_PREFIX}${k}`] = clean(k, v);
  }
  return out;
}

/** The tags in the provider's own form: key/value pairs (AWS, Azure) or strings (DigitalOcean); Cloudflare: none. */
export function providerTags(provider: Provider, input: TagInput): { pairs: Record<string, string>; strings: string[] } {
  const pairs = cloudTags(input);
  if (provider === 'digitalocean') return { pairs: {}, strings: Object.entries(pairs).map(([k, v]) => `${k}:${v}`) };
  if (provider === 'cloudflare') return { pairs: {}, strings: [] };
  return { pairs, strings: [] };
}

/** True when a resource's tags (pairs or DigitalOcean strings) say Exprsn-AI manages it for this account. */
export function isManagedBy(account: string, tags: Record<string, string> | readonly string[]): boolean {
  if (Array.isArray(tags)) return tags.includes(`${TAG_PREFIX}managed:true`) && tags.includes(`${TAG_PREFIX}account:${account}`);
  const t = tags as Record<string, string>;
  return t[`${TAG_PREFIX}managed`] === 'true' && t[`${TAG_PREFIX}account`] === account;
}

/** A name prefix for providers without tags (Cloudflare): `exprsn-<account>-`. */
export const namePrefix = (account: string): string => `exprsn-${clean('account', account)}-`;
