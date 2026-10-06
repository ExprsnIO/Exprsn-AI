import { z } from 'zod';

/*
 * Sprint 32c step configurations (B-3907, B-3908), kept out of graph.ts so the parallel Workflows 2 builders touch it
 * as little as possible. Pure zod: graph.ts imports this module, so nothing here may import graph.ts.
 */

const template = z.string().max(20_000);
const propName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/, 'Property names are letters, digits and _');
const ref = z.string().trim().min(1).max(63);

/** B-3907: the app form an approval asks the approver to fill in (by name or id); its answers become the output. */
export const approvalFormSchema = z.object({ app: ref, form: ref }).strict();
export type ApprovalForm = z.infer<typeof approvalFormSchema>;

/**
 * B-3908 `notify`: an in-app notice (and optionally an email) to people named by templates (user ids or usernames)
 * and to holders of roles. Only active users of the tenant cleared for the step's label are told; anyone else is
 * skipped and counted.
 */
export const notifyConfig = z
  .object({
    users: z.array(template.max(200)).max(50).default([]),
    roles: z.array(z.string().min(1).max(63)).max(10).default([]),
    title: template.min(1).max(1000),
    body: template.default(''),
    email: z.boolean().default(false),
    /** The console route the notice opens (defaults to the run). */
    route: z.string().regex(/^[a-z][a-z0-9-]{0,40}(\?[A-Za-z0-9=&_.-]{0,200})?$/).optional()
  })
  .strict()
  .refine((c) => c.users.length > 0 || c.roles.length > 0, 'Name at least one recipient: users or roles');

/** The event type a webhook step delivers (receivers route on it); always under `workflow.`. */
export const WEBHOOK_EVENT = /^workflow\.[a-z0-9][a-z0-9_.-]{0,59}$/;

/**
 * B-3908 `webhook`: one signed delivery to an endpoint on the tenant's allowed hosts. The body is the step's input,
 * or the fields given (templates). The URL takes no templates: it is fixed at save, where an endpoint the outbound host rules refuse is
 * refused with the step named.
 */
export const webhookConfig = z
  .object({
    url: z.string().min(1).max(2000),
    event: z.string().regex(WEBHOOK_EVENT, 'An event type under workflow., such as workflow.vendor.approved').default('workflow.webhook'),
    body: z.union([z.record(propName, template), template]).optional()
  })
  .strict();

export type NotifyConfig = z.infer<typeof notifyConfig>;
export type WebhookConfig = z.infer<typeof webhookConfig>;

const PLACEHOLDER = /\{\{[^}]*\}\}/g;

/** Why a webhook URL cannot be saved (scheme, a templated host, credentials), or null. The host rules come later. */
export function endpointProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.replace(PLACEHOLDER, 'x'));
  } catch {
    return 'the URL must be http:// or https://.';
  }
  if (!/^https?:$/.test(parsed.protocol)) return 'the URL must be http:// or https://.';
  if (/\{\{/.test(url)) return 'the URL is fixed (the endpoint is registered once); put run data in the body.';
  if (parsed.username || parsed.password) return 'credentials in the URL are not allowed.';
  return null;
}
