import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAllowList } from '../src/mcp/hosts.js';
import { isPublicAddress } from '../src/platform/egress.js';
import { CONFIGS, graphSchema, graphVaultRefs, type WfGraph } from '../src/workflows/graph.js';
import { internalRequest, type HttpStepNet } from '../src/workflows/http.js';
import { literalSecret } from '../src/workflows/http-secrets.js';
import { failureIssues } from '../src/workflows/retry.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';

/*
 * 1.7.0, Sprint 41 (B-91): workflows calling listed public hosts.
 *   B-9101  HTTP steps reach public hosts on the tenant's list of allowed hosts, through the address guard; PATCH and
 *           DELETE; a host taken off the list fails the next step that calls it
 *   B-9102  every credential-bearing header, query parameter and body field is a vault reference
 */

const send = (c: Client, method: 'post' | 'put' | 'patch' | 'delete', url: string, body: object = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body);

/** "Public" hosts of the suite: names that resolve to public addresses, served by the local receiver. */
const PUBLIC: Record<string, string> = { 'api.partner.example': '93.184.216.34', 'other.partner.example': '93.184.216.35', 'mixed.partner.example': '93.184.216.36' };

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

describe('sprint 41: workflow HTTP steps to listed public hosts (B-9101, B-9102)', () => {
  let h: Harness;
  let root: Client;
  let rootId: string;
  let hook: Server;
  let port: number;
  let seen: Seen[];
  let net: HttpStepNet;

  beforeAll(async () => {
    hook = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        if (req.url?.startsWith('/moved')) {
          res.writeHead(302, { location: 'http://other.partner.example/elsewhere' }).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((r) => hook.listen(0, '127.0.0.1', r));
    port = (hook.address() as AddressInfo).port;
    net = {
      resolve: async (host) => {
        if (host === 'mixed.partner.example') return [{ address: PUBLIC[host]!, family: 4 }, { address: '10.0.0.9', family: 4 }];
        if (PUBLIC[host]) return [{ address: PUBLIC[host], family: 4 }];
        throw new Error('ENOTFOUND');
      },
      dial: (address) => (Object.values(PUBLIC).includes(address) ? { address: '127.0.0.1', family: 4 } : null)
    };
    // The operator narrows internal hosts to one name: a listed public host needs no entry there.
    h = await harness({ WORKFLOW_HTTP_ALLOW_LOOPBACK: 'true', WORKFLOW_HTTP_HOSTS: 'kb.internal' }, { workflowHttpNet: net });
    rootId = (await localUser(h, 'root', ['system-admin'], 'restricted')).id;
    root = await loginAdmin(h, 'root');
    await send(root, 'post', '/api/vault/policies', { subjectKind: 'user', subject: rootId, path: 'kv', capabilities: ['write', 'list', 'read'], effect: 'allow' }).expect(201);
    await send(root, 'put', '/api/vault/kv/data/apps/partner', { data: { key: 'partner-key-1', token: 'partner-token-1', pw: 'p&w "1"' } }).expect(201);
  });
  afterAll(async () => {
    await new Promise((r) => hook.close(r));
    await h.close();
  });
  beforeEach(() => {
    seen = [];
  });

  const graph = (config: Record<string, unknown>, extra: Record<string, unknown> = {}): WfGraph =>
    ({
      nodes: [
        { id: 'trigger', kind: 'trigger', title: 'Trigger', x: 0, y: 0, config: {} },
        { id: 'call', kind: 'http', title: 'Call partner', x: 0, y: 0, config, ...extra }
      ],
      edges: [{ from: 'trigger', to: 'call' }],
      limits: {}
    }) as unknown as WfGraph;

  let n = 0;
  const published = async (config: Record<string, unknown>) => {
    const w = (await send(root, 'post', '/api/workflows', { name: `partner-${++n}`, label: 'internal' }).expect(201)).body;
    await send(root, 'put', `/api/workflows/${w.id}/draft`, { graph: graph(config) }).expect(200);
    await send(root, 'post', `/api/workflows/${w.id}/publish`).expect(200);
    return w.id as string;
  };
  const run = async (id: string, input: Record<string, unknown> = {}) => {
    const r = (await send(root, 'post', `/api/workflows/${id}/runs`, { input }).expect(202)).body;
    await h.s.jobs.runDue();
    const done = (await root.agent.get(`/api/workflow-runs/${r.id}`).expect(200)).body;
    return { ...done, call: done.steps.find((s: { nodeId: string }) => s.nodeId === 'call') };
  };
  const allow = (hosts: string[]) => h.s.integrations.set(h.tenantId, { allowedHosts: hosts }, 'test');

  it('B-9101: tells public addresses from the ones no list admits', () => {
    expect(isPublicAddress('93.184.216.34')).toBe(true);
    expect(isPublicAddress('::ffff:8.8.8.8')).toBe(true);
    for (const a of ['10.0.0.1', '192.168.1.1', '127.0.0.1', '169.254.169.254', '169.254.10.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', 'fd00::1', '::1', 'fe80::1', 'fd00:ec2::254']) expect(isPublicAddress(a)).toBe(false);
  });

  it('B-9101: the guard admits a listed public host, by name or network, and nothing else outside', async () => {
    const base = { method: 'GET' as const, timeoutMs: 2000, allowLoopback: true, allowHosts: ['kb.internal'], net };
    const url = `http://api.partner.example:${port}/v1/items`;
    await expect(internalRequest({ ...base, url, tenantAllow: null })).rejects.toThrow(/^api\.partner\.example is a public host that is not on this tenant's list of allowed hosts/);
    await expect(internalRequest({ ...base, url, tenantAllow: parseAllowList('other.partner.example') })).rejects.toThrow(/api\.partner\.example is a public host that is not on this tenant's list/);
    expect((await internalRequest({ ...base, url, tenantAllow: parseAllowList('api.partner.example') })).status).toBe(200);
    expect((await internalRequest({ ...base, url, tenantAllow: parseAllowList('*.partner.example') })).status).toBe(200);
    expect((await internalRequest({ ...base, url, tenantAllow: parseAllowList('93.184.216.0/24') })).status).toBe(200);
    // The tenant's list never opens an internal host the operator's list does not name, nor metadata or link-local.
    await expect(internalRequest({ ...base, url: 'http://10.0.0.5/x', tenantAllow: parseAllowList('10.0.0.0/8') })).rejects.toThrow(/not on the list of hosts workflows may call/);
    await expect(internalRequest({ ...base, url: 'http://169.254.169.254/latest', tenantAllow: parseAllowList('169.254.169.254') })).rejects.toThrow(/never called/);
    await expect(internalRequest({ ...base, allowLoopback: false, url: `http://127.0.0.1:${port}/x`, tenantAllow: parseAllowList('127.0.0.1') })).rejects.toThrow(/never called/);
    // A name that answers with an internal and a public address is refused whatever the lists say.
    await expect(internalRequest({ ...base, url: `http://mixed.partner.example:${port}/x`, tenantAllow: parseAllowList('*.partner.example,10.0.0.0/8') })).rejects.toThrow(/both internal and public addresses/);
    // A redirect is not followed: the 3xx comes back, and the other host is never called.
    seen = [];
    const moved = await internalRequest({ ...base, url: `http://api.partner.example:${port}/moved`, tenantAllow: parseAllowList('api.partner.example') });
    expect(moved.status).toBe(302);
    expect(seen.map((s) => s.url)).toEqual(['/moved']);
  });

  it('B-9101: a step to a listed public API succeeds, an unlisted host is refused by name, and a host taken off the list fails the next step', async () => {
    const id = await published({ method: 'GET', url: `http://api.partner.example:${port}/v1/items` });
    await allow([]);
    const refused = await run(id);
    expect(refused.state).toBe('failed');
    expect(refused.call.error).toMatch(/api\.partner\.example is a public host that is not on this tenant's list of allowed hosts/);
    expect(seen).toHaveLength(0);

    await allow(['api.partner.example']);
    const ok = await run(id);
    expect(ok.state).toBe('succeeded');
    expect(ok.call.output).toMatchObject({ status: 200, body: { ok: true } });
    expect(seen).toHaveLength(1);

    const other = await run(await published({ method: 'GET', url: `http://other.partner.example:${port}/v1/items` }));
    expect(other.state).toBe('failed');
    expect(other.call.error).toMatch(/other\.partner\.example is a public host that is not on this tenant's list/);

    // Taken off the list: the very next step that calls it fails, with no restart in between.
    await allow(['unrelated.example']);
    const after = await run(id);
    expect(after.state).toBe('failed');
    expect(after.call.error).toMatch(/api\.partner\.example is a public host/);
    expect(seen).toHaveLength(1);
    await allow(['api.partner.example']);
  });

  it('B-9101: PATCH and DELETE are sent, count as writes, and a DELETE step with a retry policy warns', async () => {
    for (const method of ['PATCH', 'DELETE'] as const) {
      seen = [];
      const done = await run(await published({ method, url: `http://api.partner.example:${port}/v1/items/7`, ...(method === 'PATCH' ? { body: '{"name":"{{input.name}}"}', headers: { 'content-type': 'application/json' } } : {}) }), { name: 'seven' });
      expect(done.state).toBe('succeeded');
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ method, url: '/v1/items/7' });
      if (method === 'PATCH') expect(JSON.parse(seen[0]!.body)).toEqual({ name: 'seven' });
    }
    const retried = (method: string) => failureIssues(graphSchema.parse(graph({ method, url: 'http://api.partner.example/v1/items/7' }, { retry: { max: 2, delayMs: 1000, backoff: 'fixed' } }))).warnings.map((w) => w.message);
    expect(retried('DELETE')).toEqual(['Call partner writes to another system; a retry may send it again.']);
    expect(retried('PATCH')).toEqual(['Call partner writes to another system; a retry may send it again.']);
    expect(retried('GET')).toEqual([]);
    expect(CONFIGS.http.safeParse({ method: 'TRACE', url: 'http://api.partner.example/' }).success).toBe(false);
    expect(CONFIGS.http.safeParse({ method: 'DELETE', url: 'http://api.partner.example/', query: { 'bad name': 'x' } }).success).toBe(false);
    // The editor's publish check shows the warning for a DELETE step.
    const w = (await send(root, 'post', '/api/workflows', { name: 'cleanup', label: 'internal' }).expect(201)).body;
    await send(root, 'put', `/api/workflows/${w.id}/draft`, { graph: graph({ method: 'DELETE', url: `http://api.partner.example:${port}/v1/items/7` }, { retry: { max: 1, delayMs: 1000, backoff: 'fixed' } }) }).expect(200);
    const v = (await send(root, 'post', `/api/workflows/${w.id}/validate`).expect(200)).body;
    expect(JSON.stringify(v.warnings)).toMatch(/Call partner writes to another system; a retry may send it again/);
  });

  it('B-9102: names every literal credential and lets references and plain values through', () => {
    const why = (config: Record<string, unknown>) => literalSecret(graph(config));
    const url = 'https://api.partner.example/v1/items';
    expect(why({ url, headers: { 'X-Api-Key': 'abc123' } })).toMatch(/Call partner: the header X-Api-Key carries a credential and takes a vault reference/);
    expect(why({ url, headers: { 'X-Api-Key': '{{input.key}}' } })).toMatch(/the header X-Api-Key/);
    expect(why({ url, headers: { 'X-Auth-Token': 'abc' } })).toMatch(/the header X-Auth-Token/);
    expect(why({ url, headers: { Authorization: 'Bearer abc' } })).toMatch(/Authorization takes a vault reference/);
    expect(why({ url, headers: { 'X-Api-Key': 'vault:apps/partner#key', 'X-Request-Source': 'exprsn', Accept: 'application/json' } })).toBeNull();
    expect(why({ url, headers: { 'X-Trace': 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB' } })).toMatch(/the header X-Trace holds what looks like a token/);
    expect(why({ url: `${url}?api_key=abc&page=2` })).toMatch(/the query parameter api_key carries a credential. Take it out of the URL/);
    expect(why({ url: `${url}?page={{input.page}}` })).toBeNull();
    expect(why({ url, query: { api_key: 'abc' } })).toMatch(/the query parameter api_key carries a credential and takes a vault reference/);
    expect(why({ url, query: { access_token: '{{input.t}}' } })).toMatch(/the query parameter access_token/);
    expect(why({ url, query: { api_key: 'vault:apps/partner#key', page: '{{input.page}}', sort: 'name' } })).toBeNull();
    expect(why({ url, body: '{"name":"x","password":"hunter2"}' })).toMatch(/the body field password carries a credential/);
    expect(why({ url, body: '{"auth":{"client_secret":"s3"}}' })).toMatch(/the body field client_secret/);
    expect(why({ url, body: '{"token": {{steps.a.token}} }' })).toMatch(/the body field token/);
    expect(why({ url, body: '{"pin_token": 1234}' })).toMatch(/the body field pin_token/);
    expect(why({ url, body: '{"name":"x","password":"{vault:apps/partner#pw}","token":"Bearer {vault:apps/partner#token}","secret":null,"credentials":{"user":"svc"}}' })).toBeNull();
    expect(why({ url, body: 'grant_type=client_credentials&client_secret=abc' })).toMatch(/the body field client_secret/);
    expect(why({ url, body: 'grant_type=client_credentials&client_secret={vault:apps/partner#key}' })).toBeNull();
    expect(why({ url, body: '{{steps.shape}}' })).toBeNull();
    expect(why({ url, body: '{"note":"-----BEGIN RSA PRIVATE KEY-----"}' })).toMatch(/the body holds what looks like a private key/);
    expect(graphVaultRefs(graph({ url, headers: { 'X-Api-Key': 'vault:a/b#k' }, query: { api_key: 'vault:c/d#k' }, body: '{"password":"{vault:e/f#k}","t":"{vault:a/b#k}"}' }))).toEqual(['vault:a/b#k', 'vault:c/d#k', 'vault:e/f#k', 'vault:a/b#k']);
  });

  it('B-9102: saving a step with a literal X-Api-Key is refused, and the same header as a vault reference runs', async () => {
    await allow(['api.partner.example']);
    const url = `http://api.partner.example:${port}/v1/items`;
    const w = (await send(root, 'post', '/api/workflows', { name: 'keyed', label: 'internal' }).expect(201)).body;
    const literal = await send(root, 'put', `/api/workflows/${w.id}/draft`, { graph: graph({ method: 'GET', url, headers: { 'X-Api-Key': 'partner-key-1' } }) }).expect(400);
    expect(literal.body.detail).toMatch(/the header X-Api-Key carries a credential and takes a vault reference/);
    await send(root, 'put', `/api/workflows/${w.id}/draft`, { graph: graph({ method: 'GET', url: `${url}?api_key=partner-key-1` }) }).expect(400);
    await send(root, 'put', `/api/workflows/${w.id}/draft`, { graph: graph({ method: 'POST', url, body: '{"password":"hunter2"}' }) }).expect(400);
    // Creating a workflow with such a graph is refused the same way.
    await send(root, 'post', '/api/workflows', { name: 'keyed-2', label: 'internal', graph: graph({ method: 'GET', url, headers: { 'X-Api-Key': 'partner-key-1' } }) }).expect(400);

    const cfg = { method: 'POST', url: `${url}?page={{input.page}}`, headers: { 'X-Api-Key': 'vault:apps/partner#key', 'content-type': 'application/json' }, query: { access_token: 'vault:apps/partner#token', sort: '{{input.sort}}' }, body: '{"name":"{{input.name}}","password":"{vault:apps/partner#pw}"}' };
    await send(root, 'put', `/api/workflows/${w.id}/draft`, { graph: graph(cfg) }).expect(200);
    const stored = await h.s.db('workflows').where({ id: w.id }).first();
    expect(String(stored.draft)).not.toMatch(/partner-key-1|partner-token-1/);
    await send(root, 'post', `/api/workflows/${w.id}/publish`).expect(200);
    // Text from the run's input that looks like a reference is sent as text, never read from the vault.
    const done = await run(w.id, { page: 3, sort: 'a b', name: '{vault:apps/partner#token}' });
    expect(done.state).toBe('succeeded');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers['x-api-key']).toBe('partner-key-1');
    const sent = new URL(`http://x${seen[0]!.url}`);
    expect(Object.fromEntries(sent.searchParams)).toEqual({ page: '3', access_token: 'partner-token-1', sort: 'a b' });
    expect(JSON.parse(seen[0]!.body)).toEqual({ name: '{vault:apps/partner#token}', password: 'p&w "1"' });
    // The secrets are in the request only: not in the run, its steps or their detail.
    expect(JSON.stringify(done)).not.toMatch(/partner-key-1|partner-token-1|p&w/);
    expect(done.call.detail).toMatchObject({ status: 200, query: ['access_token', 'sort'] });
    expect(String(done.call.detail.url)).not.toMatch(/access_token/);
    const reads = await h.s.audit.list(h.tenantId, { action: 'vault.secret.read' });
    expect(reads.length).toBeGreaterThanOrEqual(3);

    // A form body takes its reference percent-encoded.
    seen = [];
    const form = await run(await published({ method: 'POST', url, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials&client_secret={vault:apps/partner#pw}' }));
    expect(form.state).toBe('succeeded');
    expect(seen[0]!.body).toBe('grant_type=client_credentials&client_secret=p%26w%20%221%22');

    // A reference the saver may not read is refused at save, wherever it sits.
    await localUser(h, 'maker', ['workflow-admin'], 'restricted');
    const maker = await loginAdmin(h, 'maker');
    const mine = (await send(maker, 'post', '/api/workflows', { name: 'mine', label: 'internal' }).expect(201)).body;
    const denied = await send(maker, 'put', `/api/workflows/${mine.id}/draft`, { graph: graph({ method: 'GET', url, query: { api_key: 'vault:apps/partner#key' } }) }).expect(403);
    expect(['role', 'vault-policy']).toContain(denied.body.step);
    await send(maker, 'put', `/api/workflows/${mine.id}/draft`, { graph: graph({ method: 'POST', url, body: '{"password":"{vault:apps/partner#pw}"}' }) }).expect(403);
  });

  it('B-9102: a version stored before the rule still loads and runs, and saving it again is refused', async () => {
    await allow(['api.partner.example']);
    const url = `http://api.partner.example:${port}/v1/legacy`;
    const id = await published({ method: 'GET', url });
    // What an earlier release accepted: a literal X- header, written straight to the stored version and draft.
    const old = JSON.stringify(graph({ method: 'GET', url, headers: { 'X-Api-Key': 'legacy-literal' } }));
    await h.s.db('workflow_versions').where({ workflow_id: id }).update({ graph: old });
    await h.s.db('workflows').where({ id }).update({ draft: old });
    const view = (await root.agent.get(`/api/workflows/${id}`).expect(200)).body;
    expect(JSON.stringify(view)).toContain('legacy-literal');
    const done = await run(id);
    expect(done.state).toBe('succeeded');
    expect(seen[0]!.headers['x-api-key']).toBe('legacy-literal');
    const again = await send(root, 'put', `/api/workflows/${id}/draft`, { graph: JSON.parse(old) }).expect(400);
    expect(again.body.detail).toMatch(/the header X-Api-Key carries a credential/);
    const republish = await send(root, 'post', `/api/workflows/${id}/publish`).expect(400);
    expect(republish.body.detail).toMatch(/the header X-Api-Key carries a credential/);
  });

  it('B-9102: a bundle names the references of headers, query and body, and an import rebinds them', async () => {
    await allow(['api.partner.example']);
    const url = `http://api.partner.example:${port}/v1/items`;
    const id = await published({ method: 'POST', url, headers: { 'X-Api-Key': 'vault:apps/partner#key' }, query: { access_token: 'vault:apps/partner#token' }, body: '{"password":"{vault:apps/partner#pw}"}' });
    const bundle = (await root.agent.get(`/api/workflows/${id}/bundle`).expect(200)).body;
    expect(bundle.references.vault).toEqual(['vault:apps/partner#key', 'vault:apps/partner#pw', 'vault:apps/partner#token']);
    await send(root, 'put', '/api/vault/kv/data/apps/partner2', { data: { key: 'second-key', token: 'second-token', pw: 'second-pw' } }).expect(201);
    const bindings = { tools: {}, profiles: {}, apps: {}, vault: { 'vault:apps/partner#key': 'vault:apps/partner2#key', 'vault:apps/partner#token': 'vault:apps/partner2#token', 'vault:apps/partner#pw': 'vault:apps/partner2#pw' } };
    const imported = (await send(root, 'post', '/api/workflows/import', { bundle, name: 'imported-partner', bindings }).expect(201)).body;
    const wid = imported.workflow?.id ?? imported.id;
    const draft = String((await h.s.db('workflows').where({ id: wid }).first()).draft);
    expect(draft).toContain('vault:apps/partner2#key');
    expect(draft).toContain('{vault:apps/partner2#pw}');
    expect(draft).toContain('vault:apps/partner2#token');
    expect(draft).not.toContain('apps/partner#');
  });
});
