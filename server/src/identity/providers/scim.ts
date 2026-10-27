import { json, type Db } from '../../db/knex.js';
import type { AuthResult, ExternalUser, IdentityProvider, Step } from './types.js';

/**
 * 1.6.0 (B-7201): a SCIM store in the chain. Its users and groups are pushed by an identity provider through
 * `/scim/v2` (`identity/scim/service.ts`); it takes no passwords (the chain moves on to the next store) and its users
 * sign in through the upstream stores its configuration names. `lookup` answers from what was pushed, so "Test a
 * login" and access reviews see the SCIM user, their groups and their manager.
 */
export class ScimProvider implements IdentityProvider {
  readonly kind = 'scim' as const;

  constructor(
    readonly id: string,
    readonly name: string,
    private readonly db: Db
  ) {}

  async authenticate(_username: string, _password: string, steps?: Step[]): Promise<AuthResult> {
    steps?.push({ title: 'SCIM store: takes no passwords; its users sign in through the stores it names', ok: true });
    return { status: 'not_found' };
  }

  async lookup(username: string, steps?: Step[]): Promise<ExternalUser | null> {
    const row = (await this.db('scim_users').where({ provider_id: this.id, user_name_lc: username.toLowerCase() }).first()) as { user_id: string; user_name: string; active: unknown; attributes: string } | undefined;
    if (!row) {
      steps?.push({ title: 'SCIM store: no such user', ok: false });
      return null;
    }
    const attrs = json<Record<string, unknown>>(row.attributes, {});
    const groups = ((await this.db('scim_group_members as m').join('scim_groups as g', 'g.id', 'm.group_id').where({ 'm.user_id': row.user_id, 'g.provider_id': this.id }).select('g.display_name')) as { display_name: string }[]).map((g) => g.display_name);
    const user = (await this.db('users').where({ id: row.user_id }).first('display_name', 'email')) as { display_name: string; email: string | null } | undefined;
    const enterprise = attrs['urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'] as { manager?: { value?: string } } | undefined;
    steps?.push({ title: `SCIM store: found ${row.user_name}`, ok: true, detail: `${row.active === false || row.active === 0 || row.active === '0' ? 'inactive' : 'active'}, ${groups.length} group${groups.length === 1 ? '' : 's'}` });
    return { externalId: row.user_id, username: row.user_name.toLowerCase(), displayName: user?.display_name ?? row.user_name, email: user?.email ?? null, groups, manager: enterprise?.manager?.value ?? null };
  }

  async test(steps: Step[]): Promise<boolean> {
    const users = (await this.db('scim_users').where({ provider_id: this.id }).count({ n: '*' }).first()) as { n: number | string } | undefined;
    const tokens = (await this.db('scim_tokens').where({ provider_id: this.id }).whereNull('revoked_at').count({ n: '*' }).first()) as { n: number | string } | undefined;
    steps.push({ title: 'SCIM store', ok: true, detail: `${Number(users?.n ?? 0)} users pushed, ${Number(tokens?.n ?? 0)} live token(s)` });
    return true;
  }

  async close(): Promise<void> {}
}
