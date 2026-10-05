import { HttpProblem, tooManyRequests } from '../http/problem.js';
import { Limiter } from '../platform/ratelimit.js';
import type { Services } from '../services.js';

/*
 * Email one-time codes as a second factor (B-1806). The codes themselves live in `MfaService` (HMAC-stored, single use,
 * expiring after MFA_EMAIL_CODE_MINUTES); this is the sending side: each user is sent at most MFA_EMAIL_SENDS_PER_HOUR
 * codes (in the shared counters, so across instances), and the address is shown masked. Wrong codes are counted by the
 * callers in the same lockout as TOTP codes: the pending session's `mfa:` key at sign-in, the account key at enrolment.
 */

/** `r***@e***.com`: enough for the owner to recognise, little for anyone looking over their shoulder. */
export function maskAddress(address: string): string {
  const at = address.lastIndexOf('@');
  if (at < 1) return '***';
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${local[0]}***@${host[0] ?? ''}***${tld}`;
}

const limiters = new WeakMap<Services, Limiter>();
const limiterFor = (s: Services): Limiter => {
  let l = limiters.get(s);
  if (!l) limiters.set(s, (l = new Limiter(s.counters, 'mfa-email', s.cfg.MFA_EMAIL_SENDS_PER_HOUR, 3_600_000)));
  return l;
};

export const emailCodeTtlMs = (s: Services): number => s.cfg.MFA_EMAIL_CODE_MINUTES * 60_000;

/** Refuses with 503 when no SMTP is configured: an email factor cannot work without it. */
export function requireEmail(s: Services): void {
  if (!s.notifications.emailEnabled) throw new HttpProblem(503, 'Email unavailable', 'Email is not configured on this server (SMTP_URL), so email codes cannot be sent.');
}

/** Counts one send against the user's hourly allowance; 429 past it. */
export async function admitSend(s: Services, userId: string): Promise<void> {
  const l = await limiterFor(s).consume(userId);
  if (!l.allowed) throw tooManyRequests(`At most ${s.cfg.MFA_EMAIL_SENDS_PER_HOUR} codes are sent per hour. Use another factor or wait.`, l.resetMs / 1000);
}

/** Sends a code; 502 when the mail server refused it. */
export async function sendCode(s: Services, to: { address: string; name: string; username: string }, code: string, purpose: 'enrol' | 'signin'): Promise<void> {
  const ok = await s.notifications.sendTemplate(to.address, 'mfa-code', {
    name: to.name,
    username: to.username,
    code,
    minutes: s.cfg.MFA_EMAIL_CODE_MINUTES,
    purpose: purpose === 'enrol' ? 'Enter it in Settings to add this address as a second factor.' : 'Enter it on the sign-in page to finish signing in.'
  });
  if (!ok) throw new HttpProblem(502, 'Email not sent', 'The mail server did not accept the message. Try again, or use another factor.');
}
