import type { Db } from '../../db/knex.js';
import { burnPasswordCheck, verifyPassword } from '../passwords.js';
import { timed, type AuthResult, type ExternalUser, type IdentityProvider, type Step } from './types.js';

/**
 * Accounts held in the application database itself: the bootstrap administrator and break-glass accounts.
 * The external id is our own user id, so the link is exact.
 */
export class LocalProvider implements IdentityProvider {
  readonly kind = 'local' as const;

  constructor(
    readonly id: string,
    readonly name: string,
    private readonly db: Db,
    private readonly tenantId: string
  ) {}

  private async find(username: string) {
    return (await this.db('users as u')
      .join('local_credentials as c', 'c.user_id', 'u.id')
      .where({ 'u.tenant_id': this.tenantId, 'u.username': username.toLowerCase() })
      .first('u.id', 'u.username', 'u.display_name', 'u.email', 'u.state', 'c.password_hash')) as
      | { id: string; username: string; display_name: string; email: string | null; state: string; password_hash: string }
      | undefined;
  }

  private toUser(row: { id: string; username: string; display_name: string; email: string | null }): ExternalUser {
    return { externalId: row.id, username: row.username, displayName: row.display_name, email: row.email, groups: [] };
  }

  async authenticate(username: string, password: string, steps?: Step[]): Promise<AuthResult> {
    if (!password) return { status: 'invalid' };
    const row = await timed(steps, 'Look up local account', () => this.find(username), (r) => (r ? 'found' : 'not found'));
    if (!row) return { status: 'not_found' };
    const ok = await timed(steps, 'Verify argon2id hash', () => verifyPassword(row.password_hash, password), (v) => (v ? 'match' : 'no match'));
    if (!ok) return { status: 'invalid' };
    if (row.state !== 'active') return { status: 'disabled' };
    return { status: 'ok', user: this.toUser(row) };
  }

  async lookup(username: string): Promise<ExternalUser | null> {
    const row = await this.find(username);
    return row ? this.toUser(row) : null;
  }

  async test(steps: Step[]): Promise<boolean> {
    await timed(steps, 'Application database reachable', () => this.db.raw('select 1'));
    return true;
  }

  async close(): Promise<void> {}

  /** Used when a chain finds no user anywhere, so the response time does not reveal it. */
  static burn = burnPasswordCheck;
}
