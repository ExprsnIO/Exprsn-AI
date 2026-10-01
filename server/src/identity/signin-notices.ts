import { isIP } from 'node:net';
import { parseCookie } from 'cookie';
import type { Request, Response } from 'express';
import { hmac, randomToken, safeEqual, sha256 } from '../crypto/index.js';
import type { Services } from '../services.js';
import { securityAlert } from './security-alerts.js';

/** How long a browser keeps its device cookie (the longest lifetime browsers honour). */
const DEVICE_DAYS = 400;
/** Devices and networks not seen for this long are forgotten, so an old one counts as new again. */
const FORGET_DAYS = 400;

export const deviceCookieName = (secure: boolean): string => (secure ? '__Host-exai_device' : 'exai_device');

/** The network a sign-in came from: the /24 of an IPv4 address or the /48 of an IPv6 address. */
export function networkOf(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1] ?? ip;
  if (isIP(v4) === 4) return `${v4.split('.').slice(0, 3).join('.')}.0/24`;
  if (isIP(ip) !== 6) return null;
  // Expand :: so the first three groups are exact.
  const [head, tail] = ip.toLowerCase().split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${groups.slice(0, 3).map((g) => (g || '0').replace(/^0+(?=.)/, '')).join(':')}::/48`;
}

/** A short, secret-free description of the browser from its user agent. */
export function browserOf(ua: string | undefined): string {
  if (!ua) return 'an unknown browser';
  const name = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl|python|node|Go-http/i.test(ua) ? 'a script' : 'a browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null;
  return os ? `${name} on ${os}` : name;
}

/**
 * New sign-in notices (B-801, ASVS 2.2.3). Each browser gets a long-lived signed device cookie (a random id and its
 * HMAC; not a credential). A sign-in from a browser or a network (/24, /48) the account has not used before sends a
 * security notice. The very first sign-in of an account has nothing to compare with and records its device and
 * network without a notice. Only digests of the user, the device id and the network are stored.
 */
export class SignInNotices {
  constructor(private readonly s: () => Services) {}

  private sign(id: string): string {
    return hmac(this.s().cfg.SESSION_SECRET, `device:${id}`).slice(0, 32);
  }

  /** The device id carried by the request's cookie, when its signature is valid. */
  deviceOf(req: Request): string | null {
    const raw = req.headers.cookie ? parseCookie(req.headers.cookie)[deviceCookieName(this.s().cfg.COOKIE_SECURE)] : undefined;
    const m = raw ? /^([A-Za-z0-9_-]{32})\.([0-9a-f]{32})$/.exec(raw) : null;
    return m && safeEqual(m[2]!, this.sign(m[1]!)) ? m[1]! : null;
  }

  private setDevice(res: Response, id: string): void {
    const secure = this.s().cfg.COOKIE_SECURE;
    // SameSite=None (with Secure) so the cookie also arrives on cross-site SAML posts back from an identity provider.
    res.cookie(deviceCookieName(secure), `${id}.${this.sign(id)}`, { httpOnly: true, secure, sameSite: secure ? 'none' : 'lax', path: '/', maxAge: DEVICE_DAYS * 24 * 3600_000 });
  }

  private key(userId: string, kind: 'device' | 'network', value: string): string {
    return sha256(`${userId}\n${kind}\n${value}`);
  }

  /** Records `kind` for the user; true when it was already known (and not forgotten). */
  private async seen(tenantId: string, userId: string, kind: 'device' | 'network', value: string): Promise<boolean> {
    const db = this.s().db;
    const id = this.key(userId, kind, value);
    const t = Date.now();
    const row = (await db('signin_history').where({ id }).first('last_seen_at')) as { last_seen_at: number } | undefined;
    if (row) {
      await db('signin_history').where({ id }).update({ last_seen_at: t });
      return t - Number(row.last_seen_at) < FORGET_DAYS * 24 * 3600_000;
    }
    try {
      await db('signin_history').insert({ id, tenant_id: tenantId, user_id: userId, kind, first_seen_at: t, last_seen_at: t });
    } catch {
      return true; // a parallel sign-in from the same place recorded it first
    }
    return false;
  }

  /**
   * Called once a sign-in's first factor (password, upstream IdP or Kerberos) has succeeded. Sets the device cookie
   * when the browser has none, and notifies the account owner when the device or the network is new.
   */
  async check(req: Request, res: Response, input: { tenantId: string; userId: string; method: string; ip: string | null }): Promise<{ newDevice: boolean; newNetwork: boolean; notified: boolean }> {
    const s = this.s();
    let device = this.deviceOf(req);
    if (!device) {
      device = randomToken(24);
      this.setDevice(res, device);
    }
    const history = !!(await s.db('signin_history').where({ user_id: input.userId }).first('id'));
    const knownDevice = await this.seen(input.tenantId, input.userId, 'device', device);
    const net = networkOf(input.ip);
    const knownNetwork = net ? await this.seen(input.tenantId, input.userId, 'network', net) : true;
    const out = { newDevice: !knownDevice, newNetwork: !knownNetwork, notified: false };
    if (!history || (knownDevice && knownNetwork) || !s.cfg.SIGNIN_NOTICES) return out;
    const what = out.newDevice && out.newNetwork ? 'a new browser on a new network' : out.newDevice ? 'a new browser' : 'a new network';
    await securityAlert(s, { tenantId: input.tenantId, userId: input.userId, event: 'signin.new', detail: `Signed in with ${input.method} from ${what} (${browserOf(req.header('user-agent'))}).`, ip: input.ip });
    await s.audit.append({ tenantId: input.tenantId, action: 'auth.login.new_context', kind: 'auth', actor: { user: input.userId, ip: input.ip }, target: { user: input.userId }, detail: { newDevice: out.newDevice, newNetwork: out.newNetwork, network: net }, ...(req.traceId ? { traceId: req.traceId } : {}) });
    out.notified = true;
    return out;
  }

  /** Forgets devices and networks not seen for a long time. */
  async purge(): Promise<number> {
    return this.s().db('signin_history').where('last_seen_at', '<', Date.now() - FORGET_DAYS * 24 * 3600_000).delete();
  }
}
