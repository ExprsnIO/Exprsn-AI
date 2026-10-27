import type { Config } from '../config/index.js';

export type KerberosResult =
  /** The token verified: `principal` is the client, e.g. `alice@CORP.EXAMPLE`; `responseToken` completes mutual authentication. */
  | { status: 'ok'; principal: string; responseToken?: string }
  /** The token did not verify (wrong service, expired ticket, replay, clock skew). */
  | { status: 'invalid'; message: string }
  /** No verifier is available (no keytab, no library). */
  | { status: 'unavailable'; message: string };

/** Verifies SPNEGO (Negotiate) tokens against the service keytab (a fake in tests). */
export interface KerberosVerifier {
  /** Whether Kerberos can be used at all, and why not. */
  status(): Promise<{ available: boolean; service: string | null; detail: string }>;
  /** Verifies one base64 SPNEGO/GSSAPI token from `Authorization: Negotiate <token>`. */
  verify(tokenB64: string): Promise<KerberosResult>;
}

/** Splits `alice@CORP.EXAMPLE` (or `CORP\alice`) into user and realm. */
export function splitPrincipal(principal: string): { user: string; realm: string | null } {
  const at = principal.lastIndexOf('@');
  if (at > 0) return { user: principal.slice(0, at), realm: principal.slice(at + 1).toUpperCase() };
  const bs = principal.indexOf('\\');
  if (bs > 0) return { user: principal.slice(bs + 1), realm: principal.slice(0, bs).toUpperCase() };
  return { user: principal, realm: null };
}

interface GssServer {
  step(challenge: string): Promise<string>;
  username?: string;
  response?: string;
  contextComplete?: boolean;
}
interface KerberosModule {
  initializeServer(service: string): Promise<GssServer>;
}

/**
 * Uses the optional `kerberos` npm module (MIT krb5 / Heimdal GSSAPI bindings) when it is installed. The keytab is
 * named by KERBEROS_KEYTAB (exported as KRB5_KTNAME for the GSSAPI library) and the service by KERBEROS_SERVICE
 * (`HTTP@ai.example.internal`). Without the module or the service name, Kerberos reports itself unavailable.
 */
export class GssapiKerberos implements KerberosVerifier {
  private mod: Promise<KerberosModule | null> | null = null;

  constructor(
    private readonly service: string | undefined,
    keytab: string | undefined
  ) {
    if (keytab) process.env.KRB5_KTNAME = keytab;
  }

  private load(): Promise<KerberosModule | null> {
    if (!this.mod) {
      const name = 'kerberos';
      this.mod = (import(name) as Promise<{ default?: KerberosModule; initializeServer?: KerberosModule['initializeServer'] }>)
        .then((m) => (typeof m.initializeServer === 'function' ? (m as KerberosModule) : (m.default ?? null)))
        .catch(() => null);
    }
    return this.mod;
  }

  async status() {
    if (!this.service) return { available: false, service: null, detail: 'KERBEROS_SERVICE is not set.' };
    const mod = await this.load();
    if (!mod) return { available: false, service: this.service, detail: 'The kerberos module is not installed on this server.' };
    return { available: true, service: this.service, detail: `Service ${this.service}, keytab ${process.env.KRB5_KTNAME ?? 'default'}` };
  }

  async verify(tokenB64: string): Promise<KerberosResult> {
    const st = await this.status();
    if (!st.available) return { status: 'unavailable', message: st.detail };
    const mod = (await this.load())!;
    try {
      const server = await mod.initializeServer(this.service!);
      const response = await server.step(tokenB64);
      if (!server.username) return { status: 'invalid', message: 'The ticket did not name a client.' };
      return { status: 'ok', principal: server.username, ...(response ? { responseToken: response } : {}) };
    } catch (err) {
      return { status: 'invalid', message: (err as Error).message.slice(0, 200) };
    }
  }
}

export function createKerberos(cfg: Config): KerberosVerifier {
  return new GssapiKerberos(cfg.KERBEROS_SERVICE, cfg.KERBEROS_KEYTAB);
}
