import { z } from 'zod';
import { LABELS } from '../authz/labels.js';
import { CHAT_MODES } from './chats.js';
import { POST_KINDS } from './posts.js';

/*
 * The query and filter schemas of the chat and post searches (B-171, B-172), shared by their routes and by saved
 * searches (B-173), so a saved search is read exactly as the same search typed into the box would be.
 */

export const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
export const query = z.string().trim().min(1).max(500);
const DAY = 86_400_000;

/** A time as epoch milliseconds or an ISO date or date-time; a bare date as `before` means the end of that day. */
export const when = (end: boolean) =>
  z
    .string()
    .trim()
    .max(40)
    .transform((v, ctx) => {
      const t = /^\d{1,16}$/.test(v) ? Number(v) : Date.parse(v);
      if (!Number.isFinite(t)) {
        ctx.addIssue({ code: 'custom', message: 'Give a date (2026-10-18), a date and time, or epoch milliseconds.' });
        return z.NEVER;
      }
      return end && /^\d{4}-\d{2}-\d{2}$/.test(v) ? t + DAY - 1 : t;
    });

export const listOf = <T extends string>(values: readonly [T, ...T[]]) =>
  z
    .union([z.string(), z.array(z.string()).max(20)])
    .transform((v) => (Array.isArray(v) ? v : v.split(',')).map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.enum(values)).max(20));

export const paging = { limit: z.coerce.number().int().min(1).max(100).optional(), offset: z.coerce.number().int().min(0).max(10_000).optional() };

/** The filters of the chat search. */
export const chatFilters = {
  from: id26.optional(),
  conversation: id26.optional(),
  group: id26.optional(),
  workspace: id26.optional(),
  after: when(false).optional(),
  before: when(true).optional(),
  has: listOf(['file', 'link'] as const).optional(),
  label: z.enum(LABELS).optional(),
  mode: z.enum(CHAT_MODES).optional()
};

/** The filters of the post search. */
export const postFilters = {
  author: id26.optional(),
  tag: z.string().trim().min(1).max(65).optional(),
  group: id26.optional(),
  workspace: id26.optional(),
  list: id26.optional(),
  after: when(false).optional(),
  before: when(true).optional(),
  kind: z.enum(POST_KINDS).optional()
};

export const chatQuery = z.object({ q: query, ...chatFilters, ...paging });
export const postQuery = z.object({ q: query, ...postFilters, ...paging });
