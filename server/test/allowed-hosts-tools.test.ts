import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPrincipal } from '../src/http/middleware.js';
import { normaliseEntry } from '../src/registry/builtin/allowed-hosts.js';
import { harness, type Harness } from './helpers.js';
import { client } from './retrieval-seed.js';

type Client = Awaited<ReturnType<typeof client>>;

describe("The tenant's allowed hosts as built-in tools (migration 049)", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
  });
  afterEach(async () => {
    await h.close();
  });

  const caller = async (c: Client) => {
    const p = (await loadPrincipal(h.s, h.tenantId, c.user.id, {}))!;
    return async (name: string, args: Record<string, unknown>, approved = true) => {
      const { tools } = await h.s.tools.resolve(p, [name], 'internal');
      return h.s.tools.call({ principal: { ...p, mfa: true }, label: 'internal', approved, source: { kind: 'agent-run', id: 'R1' } }, tools[0]!, args);
    };
  };
  const hosts = async () => (await h.s.integrations.get(h.tenantId)).allowedHosts;

  it('reads what a person pastes as one entry', () => {
    expect(normaliseEntry('https://API.Example.com:8443/v1/items?x=1')).toMatchObject({ entry: 'api.example.com' });
    expect(normaliseEntry('https://api.example.com/v1').note).toMatch(/hosts, not paths or ports/);
    expect(normaliseEntry(' Example.COM. ').entry).toBe('example.com');
    expect(normaliseEntry('example.com:443/path').entry).toBe('example.com');
    expect(normaliseEntry('*.Example.com').entry).toBe('*.example.com');
    expect(normaliseEntry('203.0.113.0/24').entry).toBe('203.0.113.0/24');
    expect(normaliseEntry('[2001:db8::1]').entry).toBe('2001:db8::1');
    expect(normaliseEntry('bücher.example')).toMatchObject({ entry: 'xn--bcher-kva.example' });
    expect(normaliseEntry('bücher.example').note).toMatch(/ASCII form xn--bcher-kva\.example/);
    expect(() => normaliseEntry('api.*.example.com')).toThrow(/wildcard goes at the front/);
    expect(() => normaliseEntry('ftp://example.com/x')).toThrow(/not an http or https URL/);
    expect(() => normaliseEntry('  ')).toThrow(/Give a host/);
  });

  it('are seeded: check and list read, add and remove write', async () => {
    const rows = (await h.s.db('registry_entries').where({ impl: 'builtin' }).where('name', 'like', 'allowed_hosts.%').orderBy('name')) as { name: string; side_effect: string; status: string }[];
    expect(rows.map((r) => [r.name, r.side_effect, r.status])).toEqual([
      ['allowed_hosts.add', 'write', 'published'],
      ['allowed_hosts.check', 'read', 'published'],
      ['allowed_hosts.list', 'read', 'published'],
      ['allowed_hosts.remove', 'write', 'published']
    ]);
  });

  it('a tenant admin adds and removes hosts, with a reason, after approval, and the change is audited', async () => {
    const admin = await client(h, 'ada', ['tenant-admin'], 'confidential');
    const call = await caller(admin);
    expect(((await call('allowed_hosts.list', {})).result as { hosts: string[]; effects: string })).toMatchObject({ hosts: [] });
    expect(await call('allowed_hosts.add', { host: '203.0.113.7', reason: 'The reporting API of the supplier' }, false)).toMatchObject({ ok: false, needsApproval: true });
    expect(await hosts()).toEqual([]);
    expect((await call('allowed_hosts.add', { host: '203.0.113.7' })).ok).toBe(false);
    expect((await call('allowed_hosts.add', { host: '203.0.113.7', reason: 'x' })).error).toMatch(/Give a reason/);

    const first = (await call('allowed_hosts.add', { host: 'http://203.0.113.7:8080/api', reason: 'The reporting API of the supplier' })).result as { added: string[]; hosts: string[]; warnings: string[]; notes: string[]; note: string };
    expect(first).toMatchObject({ added: ['203.0.113.7'], hosts: ['203.0.113.7'] });
    expect(first.warnings[0]).toMatch(/first entry.*webhooks, workflow HTTP steps and mail channels.*No active webhook is affected/);
    expect(first.notes[0]).toMatch(/hosts, not paths or ports/);
    expect(first.note).toMatch(/now allowed for http_fetch/);

    const more = (await call('allowed_hosts.add', { hosts: ['203.0.113.0/24', '203.0.113.7'], reason: 'The whole range of the supplier' })).result as { added: string[]; already: string[]; hosts: string[]; warnings?: string[] };
    expect(more).toMatchObject({ added: ['203.0.113.0/24'], already: ['203.0.113.7'], hosts: ['203.0.113.7', '203.0.113.0/24'] });
    expect(more.warnings).toBeUndefined();
    expect(((await call('allowed_hosts.add', { host: '203.0.113.7', reason: 'Once more, the same' })).result as { added: string[]; note: string })).toMatchObject({ added: [], note: expect.stringMatching(/already on the list/) });

    const audited = (await h.s.db('audit_events').where({ action: 'tenant.hosts.updated' }).orderBy('seq', 'desc').first()) as { detail: string };
    expect(JSON.parse(audited.detail)).toMatchObject({ before: ['203.0.113.7'], after: ['203.0.113.7', '203.0.113.0/24'], added: ['203.0.113.0/24'], reason: 'The whole range of the supplier', via: 'tool' });

    // The list now admits the address for the request tools.
    const chk = await call('allowed_hosts.check', { target: 'http://203.0.113.7/x' });
    expect(chk.error).toBeUndefined();
    expect(chk.result as { allowed: boolean; reason: string }).toMatchObject({ allowed: true });
    expect(((await call('allowed_hosts.check', { target: '198.51.100.9' })).result as { allowed: boolean; toAllow: { entry: string }; webhooksAndWorkflowSteps: string })).toMatchObject({ allowed: false, toAllow: { entry: '198.51.100.9' }, webhooksAndWorkflowSteps: expect.stringMatching(/refused/) });

    expect(await call('allowed_hosts.remove', { host: '203.0.113.7', reason: 'No longer used by anything' }, false)).toMatchObject({ ok: false, needsApproval: true });
    expect(((await call('allowed_hosts.remove', { hosts: ['203.0.113.7', 'nothere.example.com'], reason: 'No longer used by anything' })).result as { removed: string[]; notOnList: string[]; hosts: string[] })).toMatchObject({ removed: ['203.0.113.7'], notOnList: ['nothere.example.com'], hosts: ['203.0.113.0/24'] });
    expect(((await call('allowed_hosts.remove', { host: '203.0.113.0/24', reason: 'The supplier is gone' })).result as { hosts: string[]; note: string })).toMatchObject({ hosts: [], note: expect.stringMatching(/list is now empty/) });
    expect(((await call('allowed_hosts.remove', { host: '203.0.113.0/24', reason: 'The supplier is gone' })).result as { removed: string[] }).removed).toEqual([]);
  });

  it('refuses entries that should not be on a tenant list, and changes nothing', async () => {
    const admin = await client(h, 'ada', ['tenant-admin'], 'confidential');
    const call = await caller(admin);
    const reason = 'Trying an entry that should be refused';
    for (const [host, why] of [
      ['10.1.2.3', /internal address/],
      ['127.0.0.1', /internal address/],
      ['169.254.169.254', /metadata address/],
      ['192.168.0.0/16', /internal address/],
      ['localhost', /single label/],
      ['intranet.local', /internal name.*SERVICE_ALLOWED_HOSTS/],
      ['*.com', /every site under \.com/],
      ['*.co.uk', /every site registered under \.co\.uk/],
      ['*.github.io', /every customer of github\.io/],
      ['*.herokuapp.com', /every customer of herokuapp\.com/],
      ['8.0.0.0/8', /very large network/],
      ['exa mple.com', /not a hostname/],
      ['api.*.example.com', /wildcard goes at the front/]
    ] as const) {
      const r = await call('allowed_hosts.add', { host, reason });
      expect(r.error, host).toMatch(why);
    }
    expect((await call('allowed_hosts.add', { hosts: ['203.0.113.9', '10.0.0.1'], reason })).error).toMatch(/Nothing was changed/);
    expect(await hosts()).toEqual([]);
    // One site of a shared hosting domain is fine; so is a domain with its subdomains.
    const ok = (await call('allowed_hosts.add', { host: '203.0.113.9', reason })).result as { added: string[] };
    expect(ok.added).toEqual(['203.0.113.9']);
  });

  it('includeSubdomains adds both entries, and a first entry names the webhooks it now refuses', async () => {
    const admin = await client(h, 'ada', ['tenant-admin'], 'confidential');
    const call = await caller(admin);
    const t = Date.now();
    await h.s.db('webhooks').insert({ id: 'W'.padEnd(26, '0'), tenant_id: h.tenantId, name: 'Billing events', url: 'https://hooks.partner.example/in', events: '["*"]', max_label: 'internal', secret_sealed: 'x', state: 'active', breaker: 'closed', failures: 0, created_by: admin.user.id, created_at: t, updated_at: t }).catch(async () => {
      // The table has more required columns than this test knows: fill them from its definition.
      const cols = await h.s.db('webhooks').columnInfo();
      const row: Record<string, unknown> = { id: 'W'.padEnd(26, '0'), tenant_id: h.tenantId, name: 'Billing events', url: 'https://hooks.partner.example/in', events: '["*"]', max_label: 'internal', secret_sealed: 'x', state: 'active' };
      for (const [k, c] of Object.entries(cols)) if (!(k in row) && !c.nullable && c.defaultValue == null) row[k] = /int|bigint|numeric/i.test(c.type) ? t : 'x';
      await h.s.db('webhooks').insert(row);
    });
    // example.invalid never resolves: the entry is added with a note, and its subdomains with a warning.
    const out = (await call('allowed_hosts.add', { host: 'docs.example.invalid', includeSubdomains: true, reason: 'Product documentation for the research agents' })).result as { added: string[]; warnings: string[]; notes: string[] };
    expect(out.added).toEqual(['docs.example.invalid', '*.docs.example.invalid']);
    expect(out.warnings.join(' ')).toMatch(/first entry.*Active webhooks that are now refused: Billing events \(hooks\.partner\.example\)/);
    expect(out.warnings.join(' ')).toMatch(/\*\.docs\.example\.invalid allows every subdomain/);
    expect(out.notes.join(' ')).toMatch(/does not resolve/);
    expect(((await call('allowed_hosts.check', { target: 'https://docs.example.invalid/guide' })).result as { allowed: boolean; resolves: boolean })).toMatchObject({ allowed: false, resolves: false });
  });

  it('checking is for anyone who may call tools; the list is the tenant admin\'s', async () => {
    const member = await client(h, 'mia', ['member'], 'internal');
    const call = await caller(member);
    const check = (await call('allowed_hosts.check', { target: 'https://198.51.100.20/data' })).result as { host: string; allowed: boolean; reason: string; toAllow: { entry: string; how: string } };
    expect(check).toMatchObject({ host: '198.51.100.20', allowed: false, toAllow: { entry: '198.51.100.20' } });
    expect(check.reason).toMatch(/not on this tenant's list of allowed hosts/);
    expect(check.toAllow.how).toMatch(/tenant admin/);
    expect(((await call('allowed_hosts.check', { target: '10.0.0.5' })).result as { allowed: boolean; toAllow: { how: string } }).toAllow.how).toMatch(/SERVICE_ALLOWED_HOSTS/);
    expect((await call('allowed_hosts.check', { target: '*.example.com' })).error).toMatch(/one host or URL/);
    expect((await call('allowed_hosts.list', {})).error).toMatch(/may not do this/);
    expect((await call('allowed_hosts.add', { host: '203.0.113.7', reason: 'I would like this host' })).error).toMatch(/may not do this/);
    expect((await call('allowed_hosts.remove', { host: '203.0.113.7', reason: 'I would like this gone' })).error).toMatch(/may not do this/);
    expect(await hosts()).toEqual([]);
  });
});
