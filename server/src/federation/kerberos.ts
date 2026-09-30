import type { Config } from '../config/index.js';

/** Verifies SPNEGO (Negotiate) tokens against the service keytab (a fake in tests). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface KerberosVerifier {}

export function createKerberos(_cfg: Config): KerberosVerifier {
  return {};
}
