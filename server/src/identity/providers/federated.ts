import type { ProviderRow } from '../../repos/providers.js';
import type { AuthResult, ExternalUser, IdentityProvider, Step } from './types.js';

/** Checks an upstream provider's reachability and configuration (set by the federation service). */
export type FederatedTester = (row: ProviderRow, steps: Step[]) => Promise<boolean>;

/**
 * An upstream OIDC or SAML identity provider in the chain. Sign-in is a browser redirect handled by the federation
 * routes, so it never takes a password (the chain passes to the next store) and has no directory to look users up in.
 */
export class FederatedProvider implements IdentityProvider {
  readonly kind: 'oidc' | 'saml' | 'atproto' | 'github';
  readonly id: string;
  readonly name: string;

  constructor(
    private readonly row: ProviderRow,
    private readonly tester: FederatedTester | null
  ) {
    this.kind = row.kind as 'oidc' | 'saml' | 'atproto' | 'github';
    this.id = row.id;
    this.name = row.name;
  }

  async authenticate(_username: string, _password: string, steps?: Step[]): Promise<AuthResult> {
    steps?.push({ title: 'Upstream provider: signs in by redirect, not by password', ok: true });
    return { status: 'not_found' };
  }

  async lookup(): Promise<ExternalUser | null> {
    return null;
  }

  async test(steps: Step[]): Promise<boolean> {
    if (!this.tester) {
      steps.push({ title: 'Upstream checks', ok: false, detail: 'The federation service is not running.' });
      return false;
    }
    return this.tester(this.row, steps);
  }

  async close(): Promise<void> {}
}
