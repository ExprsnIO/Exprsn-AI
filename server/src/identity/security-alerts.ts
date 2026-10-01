import type { Logger } from 'pino';
import type { Notifications } from '../platform/notifications.js';

/**
 * Security notices to the account owner (console and email) when their credentials or sign-ins change. The notice
 * says what happened, when and from where; it never carries a secret (no key, code, token or password), only names
 * and prefixes that are already shown in Settings. Sprint 14 calls this for OAuth grant revocations.
 */
export type SecurityEvent =
  | 'password.changed'
  | 'password.reset'
  | 'password.reset_by_admin'
  | 'factor.added'
  | 'factor.removed'
  | 'factors.reset_by_admin'
  | 'recovery_codes.regenerated'
  | 'api_key.created'
  | 'api_key.revoked'
  | 'session.revoked'
  | 'sessions.revoked'
  | 'grant.added'
  | 'grant.revoked'
  | 'signin.new';

const TITLES: Record<SecurityEvent, string> = {
  'password.changed': 'Your password was changed',
  'password.reset': 'Your password was reset',
  'password.reset_by_admin': 'An administrator reset your password',
  'factor.added': 'A second factor was added',
  'factor.removed': 'A second factor was removed',
  'factors.reset_by_admin': 'An administrator removed your second factors',
  'recovery_codes.regenerated': 'New recovery codes were generated',
  'api_key.created': 'An API key was created',
  'api_key.revoked': 'An API key was revoked',
  'session.revoked': 'A session was signed out',
  'sessions.revoked': 'Your other sessions were signed out',
  'grant.added': 'An application can now act as you',
  'grant.revoked': 'An application lost access to your account',
  'signin.new': 'New sign-in to your account'
};

export interface SecurityAlertInput {
  tenantId: string;
  userId: string;
  event: SecurityEvent;
  /** A short, secret-free description (a key's name and prefix, a factor's label, a count). */
  detail?: string;
  ip?: string | null;
}

/** Notifies the user in the console and by email. Never throws: a failed notice is logged, the change stands. */
export async function securityAlert(deps: { notifications: Notifications; log: Logger }, input: SecurityAlertInput): Promise<void> {
  const title = TITLES[input.event];
  const time = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  const body = [input.detail, input.ip ? `From ${input.ip}.` : null, 'If this was not you, review Settings and tell an identity admin.'].filter(Boolean).join(' ');
  try {
    await deps.notifications.notify({
      tenantId: input.tenantId,
      userIds: [input.userId],
      kind: 'security',
      title,
      body,
      route: 'settings',
      label: 'internal',
      emailTemplate: { name: 'security-alert', vars: { event: title, time, from: input.ip ? ` from ${input.ip}` : '', detail: input.detail ?? '' } }
    });
  } catch (err) {
    deps.log.warn({ err: (err as Error).message, event: input.event }, 'security notice failed');
  }
}
