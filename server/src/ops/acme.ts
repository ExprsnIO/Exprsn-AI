import type { Config } from '../config/index.js';

/** RFC 8555 ACME client used for platform certificates (a fake directory in tests). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AcmeClient {}

export function createAcme(_cfg: Config): AcmeClient {
  return {};
}
