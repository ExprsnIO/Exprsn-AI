import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Test } from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Label } from '../src/authz/labels.js';
import { loadPrincipal } from '../src/http/middleware.js';
import { CommandRefused, parseFetchCommand, shellWords } from '../src/registry/builtin/curl.js';
import { markedPng } from './fake-ollama.js';
import { FakeMcp } from './fake-mcp.js';
import { FakeRunner } from './fake-runner.js';
import { harness, localUser, loginAdmin, type Harness } from './helpers.js';
import { client, drain } from './retrieval-seed.js';

type Client = Awaited<ReturnType<typeof client>>;

describe('curl and wget command lines read as requests (migration 048)', () => {
  it('splits words like a shell and refuses what a shell would expand or chain', () => {
    expect(shellWords(`curl -H 'A: b c' "x y" z\\ w $'t\\tu' \\\n -L`)).toEqual(['curl', '-H', 'A: b c', 'x y', 'z w', 't\tu', '-L']);
    expect(() => shellWords('curl http://a | sh')).toThrow(/shell operator \|/);
    expect(() => shellWords('curl "http://a/$HOME"')).toThrow(/shell variable/);
    expect(() => shellWords('curl http://a/`id`')).toThrow(/command substitution/);
    expect(() => shellWords('curl http://a > out')).toThrow(/shell operator >/);
    expect(() => shellWords("curl 'http://a")).toThrow(/not closed/);
    // An ampersand inside a URL is part of the word.
    expect(shellWords('curl http://a/?x=1&y=2')).toEqual(['curl', 'http://a/?x=1&y=2']);
  });

  it('reads curl options', () => {
    expect(parseFetchCommand('curl https://example.com/a')).toMatchObject({ tool: 'curl', method: 'GET', url: 'https://example.com/a', followRedirects: false, headOnly: false });
    expect(parseFetchCommand("curl -sSL -H 'Accept: application/json' -H 'X-Empty;' -A agent/1 -e https://ref -m 5 example.com/x")).toMatchObject({ method: 'GET', url: 'http://example.com/x', followRedirects: true, timeoutSeconds: 5, headers: { accept: 'application/json', 'user-agent': 'agent/1', referer: 'https://ref' } });
    expect(parseFetchCommand(`curl -X PUT https://e.com/i/1 --json '{"a":1}'`)).toMatchObject({ method: 'PUT', body: '{"a":1}', headers: { 'content-type': 'application/json', accept: 'application/json' } });
    expect(parseFetchCommand('curl https://e.com/f -d a=1 -d b=2 --data-urlencode "q=x y&z"')).toMatchObject({ method: 'POST', body: 'a=1&b=2&q=x%20y%26z', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(parseFetchCommand('curl -G https://e.com/s?x=1 -d q=tea')).toMatchObject({ method: 'GET', url: 'https://e.com/s?x=1&q=tea' });
    expect(parseFetchCommand('curl -I https://e.com/')).toMatchObject({ method: 'HEAD', headOnly: true });
    expect(parseFetchCommand('curl -u ada:secret --oauth2-bearer T https://e.com/').headers.authorization).toBe('Bearer T');
    expect(parseFetchCommand('curl -u ada:secret https://e.com/').headers.authorization).toBe(`Basic ${Buffer.from('ada:secret').toString('base64')}`);
    expect(parseFetchCommand('curl -LO https://e.com/files/report%202026.pdf')).toMatchObject({ output: 'report 2026.pdf', followRedirects: true });
    expect(parseFetchCommand('curl -o /tmp/out.bin https://e.com/x').output).toBe('out.bin');
    expect(parseFetchCommand('curl --request=DELETE --url=https://e.com/i/2 --max-redirs 2 --retry 3')).toMatchObject({ method: 'DELETE', maxRedirects: 2, notes: ['--retry has no effect here.'] });
    for (const [cmd, why] of [
      ['curl -k https://e.com', /certificate check/],
      ['curl -F file=@a.png https://e.com', /multipart form/],
      ['curl -T a.txt https://e.com', /uploads a file from disk/],
      ['curl -d @body.json https://e.com', /reads a file from disk/],
      ['curl -x http://proxy:3128 https://e.com', /proxy/],
      ['curl --resolve e.com:443:10.0.0.1 https://e.com', /outbound address guard/],
      ['curl -b cookies.txt https://e.com', /cookies from a file/],
      ['curl https://a.com https://b.com', /2 URLs/],
      ['curl -s', /no URL/],
      ['curl --frobnicate https://e.com', /not supported here/],
      ['rm -rf /', /only curl and wget/]
    ] as const) expect(() => parseFetchCommand(cmd), cmd).toThrow(why);
    expect(() => parseFetchCommand('curl -k https://e.com')).toThrow(CommandRefused);
  });

  it('reads wget options', () => {
    expect(parseFetchCommand('wget -q https://e.com/pub/data.csv')).toMatchObject({ tool: 'wget', method: 'GET', followRedirects: true, output: 'data.csv' });
    expect(parseFetchCommand('wget -nv -O out.json --header="Accept: application/json" -U agent/1 -T 9 https://e.com/api')).toMatchObject({ output: 'out.json', timeoutSeconds: 9, headers: { accept: 'application/json', 'user-agent': 'agent/1' } });
    expect(parseFetchCommand('wget --post-data "a=1" https://e.com/f')).toMatchObject({ method: 'POST', body: 'a=1' });
    expect(parseFetchCommand(`wget --method=PATCH --body-data='{"a":2}' --header 'Content-Type: application/json' https://e.com/i`)).toMatchObject({ method: 'PATCH', body: '{"a":2}' });
    expect(parseFetchCommand('wget --spider --max-redirect=0 https://e.com/x')).toMatchObject({ method: 'HEAD', headOnly: true, followRedirects: false });
    expect(parseFetchCommand('wget --user ada --password s https://e.com/').headers.authorization).toBe(`Basic ${Buffer.from('ada:s').toString('base64')}`);
    expect(() => parseFetchCommand('wget -r https://e.com/')).toThrow(/whole site/);
    expect(() => parseFetchCommand('wget --no-check-certificate https://e.com/')).toThrow(/certificate check/);
    expect(() => parseFetchCommand('wget -i urls.txt')).toThrow(/reads URLs from a file/);
  });
});

const PNG = markedPng({ caption: 'A chart', ocr: 'Q3' });

/** A small site: pages, a redirect chain, an echo and a binary file. */
class Site {
  server!: Server;
  port = 0;
  seen: { method: string; url: string; headers: IncomingMessage['headers']; body: string }[] = [];
  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        this.seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
        const send = (status: number, headers: Record<string, string>, data: string | Buffer = '') => {
          res.writeHead(status, headers);
          res.end(req.method === 'HEAD' ? undefined : data);
        };
        const path = (req.url ?? '').split('?')[0];
        if (path === '/page') send(200, { 'content-type': 'text/html; charset=utf-8', etag: '"p1"' }, '<html><head><title>T</title><script>x()</script></head><body><h1>Tea</h1><p>Green and black.</p></body></html>');
        else if (path === '/long') send(200, { 'content-type': 'text/plain' }, 'line of text\n'.repeat(400));
        else if (path === '/json') send(200, { 'content-type': 'application/json' }, '{"ok":true}');
        else if (path === '/hop1') send(302, { location: '/hop2' });
        else if (path === '/hop2') send(301, { location: '/json' });
        else if (path === '/loop') send(302, { location: '/loop' });
        else if (path === '/out') send(302, { location: 'http://169.254.169.254/latest/meta-data/' });
        else if (path === '/echo') send(200, { 'content-type': 'application/json' }, JSON.stringify({ method: req.method, body, type: req.headers['content-type'] ?? null, auth: req.headers.authorization ?? null }));
        else if (path === '/see-other') send(303, { location: '/echo' });
        else if (path === '/data.bin') send(200, { 'content-type': 'image/png', 'content-disposition': 'attachment; filename="chart.png"' }, PNG);
        else if (path === '/notes.txt') send(200, { 'content-type': 'text/plain' }, 'error one\nok\nerror two\n');
        else send(404, { 'content-type': 'text/plain' }, 'nothing here');
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }
  url(path: string): string {
    return `http://127.0.0.1:${this.port}${path}`;
  }
  stop(): Promise<void> {
    return new Promise((r) => this.server.close(() => r()));
  }
}

describe('The built-ins for requests and for script tools on files (migration 048)', () => {
  let h: Harness;
  let site: Site;
  let runner: FakeRunner;
  type Admin = Awaited<ReturnType<typeof loginAdmin>> & { post: (path: string, body?: object) => Test };
  let admins: { w: Admin; ta: Admin } | null;

  beforeEach(async () => {
    admins = null;
    site = await new Site().start();
    h = await harness({ OLLAMA_POLL_MS: '600000', SERVICE_ALLOWED_HOSTS: '127.0.0.1' });
    runner = new FakeRunner();
    h.s.scripts.runner = runner;
  });
  afterEach(async () => {
    await h.close();
    await site.stop();
  });

  const caller = async (c: Client) => {
    const p = (await loadPrincipal(h.s, h.tenantId, c.user.id, {}))!;
    return async (name: string, args: Record<string, unknown>, opts: { label?: Label; approved?: boolean } = {}) => {
      const label = opts.label ?? 'internal';
      const { tools } = await h.s.tools.resolve(p, [name], label);
      if (!tools[0]) return { ok: false, error: `${name} is not offered at ${label}`, result: undefined } as { ok: boolean; error?: string; result?: unknown; needsApproval?: boolean };
      return h.s.tools.call({ principal: p, label, approved: opts.approved ?? true, source: { kind: 'agent-run', id: 'R1' } }, tools[0], args);
    };
  };

  async function setup() {
    const member = await client(h, 'mia', ['member'], 'confidential');
    const ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Research', 'confidential')).id;
    await h.s.tenants.addMember(ws, member.user.id);
    const put = async (name: string, data: Buffer, label: Label = 'internal') => {
      const r = await member.agent.put(`/api/files/uploads?${new URLSearchParams({ name, workspace: ws, label }).toString()}`).set('x-csrf-token', member.csrf).set('content-type', 'application/octet-stream').send(data).expect(202);
      await drain(h);
      return (r.body as { id: string }).id;
    };
    const content = async (id: string) => {
      const p = (await loadPrincipal(h.s, h.tenantId, member.user.id, {}))!;
      const got = await h.s.files.content(p, id);
      const parts: Buffer[] = [];
      for await (const part of got.stream) parts.push(part);
      return { name: got.file.name, version: got.version.number, label: got.version.label, folder: got.file.folder_id, data: Buffer.concat(parts) };
    };
    return { member, ws, put, content, call: await caller(member) };
  }

  /** Publishes a script tool whose (fake) sandbox answers from `runner.handler`. */
  async function publish(scriptName: string, toolName: string, label: Label = 'internal') {
    const user = async (name: string, roles: string[]) => {
      await localUser(h, name, roles, 'confidential');
      const c = await loginAdmin(h, name);
      return { ...c, post: (path: string, body: object = {}) => c.agent.post(path).set('x-csrf-token', c.csrf).send(body) };
    };
    admins ??= { w: await user('wf', ['workflow-admin']), ta: await user('ta', ['tool-admin']) };
    const { w, ta } = admins;
    const before = runner.handler;
    runner.handler = () => ({ stdout: '{}' });
    const sc = (await w.post('/api/scripts', { name: scriptName, language: 'python', source: 'import json\nprint(json.dumps({}))', label }).expect(201)).body as { id: string };
    await w.post(`/api/scripts/${sc.id}/run`, { stdin: '{}' }).expect(202);
    await h.s.jobs.runDue();
    const entry = (await w.post(`/api/scripts/${sc.id}/promote`, { toolName, description: `The script tool ${toolName}, standing in for the real one in this test of the built-ins.`, sideEffect: 'read', label, inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }).expect(201)).body as { id: string };
    await ta.post(`/api/admin/registry/${entry.id}/review`, { decision: 'approve' }).expect(200);
    runner.handler = before;
  }

  it('are seeded: reads and writes, the requests capped at internal', async () => {
    const rows = (await h.s.db('registry_entries').where({ impl: 'builtin' }).whereIn('name', ['http_fetch', 'http_request', 'http_download', 'files.run_tool', 'files.apply_tool', 'files.save', 'files.extract']).orderBy('name')) as { name: string; side_effect: string; status: string; label: string }[];
    expect(rows.map((r) => [r.name, r.side_effect, r.label, r.status])).toEqual([
      ['files.apply_tool', 'write', 'restricted', 'published'],
      ['files.extract', 'write', 'restricted', 'published'],
      ['files.run_tool', 'read', 'restricted', 'published'],
      ['files.save', 'write', 'restricted', 'published'],
      ['http_download', 'write', 'internal', 'published'],
      ['http_fetch', 'read', 'internal', 'published'],
      ['http_request', 'write', 'internal', 'published']
    ]);
  });

  it('http_fetch: pages as text, parts, JSON, headers, redirects, curl and wget commands', async () => {
    const { call } = await setup();
    const page = (await call('http_fetch', { url: site.url('/page') })).result as Record<string, unknown>;
    expect(page).toMatchObject({ status: 200, ok: true, contentType: 'text/html', format: 'text from html', headers: { etag: '"p1"' }, next: null });
    expect(String(page.content)).toContain('Green and black.');
    expect(String(page.content)).not.toContain('x()');
    expect(String(((await call('http_fetch', { url: site.url('/page'), as: 'raw' })).result as { content: string }).content)).toContain('<h1>Tea</h1>');

    const part = (await call('http_fetch', { url: site.url('/long'), maxChars: 260 })).result as { content: string; total: number; next: number; note: string };
    expect(part).toMatchObject({ total: 5200, next: 260 });
    expect(part.note).toMatch(/from 260/);
    expect(((await call('http_fetch', { url: site.url('/long'), from: 5190, maxChars: 260 })).result as { content: string; next: null }).content).toBe('e of text\n');

    // Redirects are followed and each hop is named; curl without -L leaves them, as curl does.
    const hop = (await call('http_fetch', { url: site.url('/hop1') })).result as Record<string, unknown>;
    expect(hop).toMatchObject({ status: 200, format: 'json', content: '{"ok":true}', redirects: [{ status: 302, to: site.url('/hop2') }, { status: 301, to: site.url('/json') }] });
    const noL = (await call('http_fetch', { command: `curl -s ${site.url('/hop1')}` })).result as Record<string, unknown>;
    expect(noL).toMatchObject({ status: 302, ok: false, headers: { location: '/hop2' } });
    expect(String(noL.note)).toMatch(/not followed/);
    expect(((await call('http_fetch', { command: `curl -sL -H 'X-Trace: t1' ${site.url('/hop1')}` })).result as { status: number }).status).toBe(200);
    expect(site.seen.at(-1)!.headers['x-trace']).toBe('t1');
    expect(((await call('http_fetch', { command: `wget -q -O - ${site.url('/hop1')}` })).result as { content: string }).content).toBe('{"ok":true}');
    expect((await call('http_fetch', { url: site.url('/loop') })).error).toMatch(/More than 5 redirects/);

    const head = (await call('http_fetch', { command: `curl -I ${site.url('/page')}` })).result as Record<string, unknown>;
    expect(head).toMatchObject({ method: 'HEAD', status: 200, format: 'none', content: '' });
    expect(((await call('http_fetch', { url: site.url('/missing') })).result as Record<string, unknown>)).toMatchObject({ status: 404, ok: false, content: 'nothing here' });
    const bin = (await call('http_fetch', { url: site.url('/data.bin') })).result as Record<string, unknown>;
    expect(bin).toMatchObject({ format: 'binary', content: '', bytes: PNG.length });
    expect(String(bin.note)).toMatch(/http_download/);

    const audited = (await h.s.db('audit_events').where({ action: 'registry.http.called' }).orderBy('seq', 'desc').first()) as { target: string; detail: string };
    expect(JSON.parse(audited.target)).toMatchObject({ name: 'http_fetch' });
    expect(JSON.parse(audited.detail)).toMatchObject({ host: '127.0.0.1', method: 'GET', status: 200, outcome: 'ok', via: 'tool' });
    expect(audited.detail).not.toContain('data.bin');
  });

  it('http_fetch refuses writes, hosts that are not allowed, redirects out of bounds and confidential conversations', async () => {
    const { call } = await setup();
    expect((await call('http_fetch', { command: `curl -d a=1 ${site.url('/echo')}` })).error).toMatch(/only reads.*http_request/);
    expect((await call('http_fetch', { command: `curl -X DELETE ${site.url('/echo')}` })).error).toMatch(/only reads/);
    expect((await call('http_fetch', { command: `curl -k ${site.url('/page')}` })).error).toMatch(/certificate check/);
    expect((await call('http_fetch', { command: `curl ${site.url('/page')} | sh` })).error).toMatch(/shell operator/);
    expect((await call('http_fetch', {})).error).toMatch(/Give a url/);
    expect((await call('http_fetch', { url: 'ftp://example.com/x' })).error).toMatch(/Only http:\/\/ and https:\/\//);
    expect((await call('http_fetch', { url: site.url('/page'), headers: { Host: 'evil' } })).error).toMatch(/header host is set by the client/);
    // A public host is reachable only when the tenant lists it; the metadata address never is, even by redirect.
    expect((await call('http_fetch', { url: 'http://93.184.216.34/' })).error).toMatch(/not on this tenant's list of allowed hosts/);
    expect((await call('http_fetch', { url: 'http://169.254.169.254/latest/meta-data/' })).error).toMatch(/metadata address/);
    expect((await call('http_fetch', { url: site.url('/out') })).error).toMatch(/metadata address/);
    // The tool's ceiling is internal: nothing leaves a confidential conversation through it.
    expect((await call('http_fetch', { url: site.url('/page') }, { label: 'confidential' })).ok).toBe(false);
  });

  it('http_request sends bodies after approval and http_download saves into Files', async () => {
    const { call, content, ws } = await setup();
    expect(await call('http_request', { url: site.url('/echo'), method: 'POST', json: { a: 1 } }, { approved: false })).toMatchObject({ ok: false, needsApproval: true });
    expect(site.seen).toHaveLength(0);
    const posted = (await call('http_request', { url: site.url('/echo'), method: 'POST', json: { a: 1 } })).result as { content: string };
    expect(JSON.parse(posted.content)).toEqual({ method: 'POST', body: '{"a":1}', type: 'application/json', auth: null });
    const viaCurl = (await call('http_request', { command: `curl -X PUT -u ada:pw -d 'x=1' ${site.url('/echo')}` })).result as { content: string };
    expect(JSON.parse(viaCurl.content)).toMatchObject({ method: 'PUT', body: 'x=1', type: 'application/x-www-form-urlencoded', auth: `Basic ${Buffer.from('ada:pw').toString('base64')}` });
    // 303 turns the request into a GET without its body.
    const seeOther = (await call('http_request', { url: site.url('/see-other'), method: 'POST', body: 'secret' })).result as { content: string };
    expect(JSON.parse(seeOther.content)).toMatchObject({ method: 'GET', body: '' });
    expect((await call('http_request', { url: site.url('/echo'), method: 'GET', body: 'x' })).error).toMatch(/carries no body/);

    expect(await call('http_download', { url: site.url('/data.bin') }, { approved: false })).toMatchObject({ ok: false, needsApproval: true });
    expect((await call('http_download', { url: site.url('/data.bin') })).error).toMatch(/Choose a workspace first/);
    const dl = await call('http_download', { url: site.url('/data.bin'), workspaceId: ws });
    expect(dl.error).toBeUndefined();
    const saved = dl.result as { file: string; name: string; size: number; state: string };
    expect(saved).toMatchObject({ name: 'chart.png', size: PNG.length });
    await drain(h);
    expect((await content(saved.file)).data.equals(PNG)).toBe(true);
    const named = (await call('http_download', { command: `wget -O notes-copy.txt ${site.url('/notes.txt')}`, workspaceId: ws })).result as { file: string; name: string };
    expect(named.name).toBe('notes-copy.txt');
    expect((await call('http_download', { url: site.url('/missing'), workspaceId: ws })).error).toMatch(/answered 404; nothing was saved/);
    expect((await call('http_download', { command: `wget -O notes-copy.txt ${site.url('/notes.txt')}`, workspaceId: ws })).error).toMatch(/already in this folder/);
  });

  it('files.run_tool puts a file into a script tool and files.apply_tool saves the product', async () => {
    const { put, call, content } = await setup();
    const log = await put('app.log', Buffer.from('error one\nok\nerror two\n'));
    expect((await call('files.run_tool', { fileId: log, tool: 'unix_pipeline', arguments: { pipeline: 'grep -c error' } })).error).toMatch(/unix_pipeline is not a script tool published in this tenant/);
    await publish('unix-pipeline', 'unix_pipeline');
    await publish('xcode-project', 'xcode_project');
    await publish('archive-tool', 'archive_tool');
    await publish('apply-patch', 'apply_patch');

    let seen: Record<string, unknown> = {};
    runner.handler = (req) => {
      seen = JSON.parse(req.stdin ?? '{}') as Record<string, unknown>;
      return { stdout: JSON.stringify({ stdout: '2\n', exit_status: 0 }) };
    };
    const other = await put('b.log', Buffer.from('error three\n'));
    const grep = (await call('files.run_tool', { fileId: log, tool: 'unix_pipeline', arguments: { pipeline: 'grep -c error', input: 'ignored' }, moreFileIds: [other] })).result as Record<string, unknown>;
    expect(grep).toMatchObject({ file: { name: 'app.log', version: 1 }, tool: 'unix_pipeline', result: { stdout: '2\n', exit_status: 0 } });
    expect(seen).toMatchObject({ pipeline: 'grep -c error', input: 'error one\nok\nerror two\n', files: { 'app.log': 'error one\nok\nerror two\n', 'b.log': 'error three\n' } });

    // A product that is a whole file is left out of a read and saved by the write.
    const project = await put('project.pbxproj', Buffer.from('// !$*UTF8*$!\n{ objects = {}; }\n'));
    const changed = `// !$*UTF8*$!\n{ objects = { /* ${'x'.repeat(9000)} */ }; }\n`;
    runner.handler = (req) => {
      seen = JSON.parse(req.stdin ?? '{}') as Record<string, unknown>;
      return { stdout: JSON.stringify({ action: seen.action, changed: true, added: [{ object: 'PBXShellScriptBuildPhase' }], pbxproj: changed }) };
    };
    const inspect = (await call('files.run_tool', { fileId: project, tool: 'xcode_project', arguments: { action: 'add_run_script', target: 'App', script: 'echo hi' } })).result as { result: Record<string, unknown>; note: string };
    expect(seen).toMatchObject({ action: 'add_run_script', pbxproj: '// !$*UTF8*$!\n{ objects = {}; }\n' });
    expect(inspect.result).toEqual({ action: 'add_run_script', changed: true, added: [{ object: 'PBXShellScriptBuildPhase' }] });
    expect(inspect.note).toMatch(/pbxproj.*files\.apply_tool/);
    expect(await call('files.apply_tool', { fileId: project, tool: 'xcode_project', arguments: { action: 'add_run_script' } }, { approved: false })).toMatchObject({ ok: false, needsApproval: true });
    const applied = (await call('files.apply_tool', { fileId: project, tool: 'xcode_project', arguments: { action: 'add_run_script', target: 'App', script: 'echo hi' } })).result as { saved: { version: number; new: boolean; previousVersion: number }; result: Record<string, unknown> };
    expect(applied.saved).toMatchObject({ version: 2, new: false, previousVersion: 1 });
    expect(applied.result).not.toHaveProperty('pbxproj');
    await drain(h);
    expect((await content(project)).data.toString('utf8')).toBe(changed);

    // An error or a rejected change saves nothing.
    runner.handler = () => ({ stdout: '{"error": "no target named App"}' });
    expect((await call('files.apply_tool', { fileId: project, tool: 'xcode_project', arguments: { action: 'add_run_script' } })).error).toMatch(/no target named App; nothing was saved/);
    runner.handler = () => ({ stdout: JSON.stringify({ result: 'half', rejected: [{ hunk: 2, reason: 'context not found' }] }) });
    expect((await call('files.apply_tool', { fileId: log, tool: 'apply_patch', arguments: { patch: '@@' } })).error).toMatch(/could not apply 1 part.*nothing was saved/);
    expect((await content(project)).version).toBe(2);

    // With saveAs the product is a new file beside the source: a pipeline's output, an archive made from files.
    runner.handler = () => ({ stdout: JSON.stringify({ stdout: 'error one\nerror two\n', exit_status: 0 }) });
    const out = (await call('files.apply_tool', { fileId: log, tool: 'unix_pipeline', arguments: { pipeline: 'grep error' }, saveAs: 'errors.txt' })).result as { saved: { file: string; name: string; new: boolean } };
    expect(out.saved).toMatchObject({ name: 'errors.txt', new: true });
    runner.handler = (req) => {
      seen = JSON.parse(req.stdin ?? '{}') as Record<string, unknown>;
      return { stdout: JSON.stringify({ format: 'tar.gz', name: 'archive.tar.gz', data_base64: Buffer.from('TARBYTES').toString('base64'), members: 2 }) };
    };
    const tar = (await call('files.apply_tool', { fileId: log, tool: 'archive_tool', arguments: { action: 'create', format: 'tar.gz' }, moreFileIds: [other] })).result as { saved: { file: string; name: string } };
    expect(seen).toMatchObject({ action: 'create', files: [{ name: 'app.log', base64: Buffer.from('error one\nok\nerror two\n').toString('base64') }, { name: 'b.log' }] });
    expect(seen).not.toHaveProperty('data_base64');
    expect(tar.saved.name).toBe('archive.tar.gz');
    await drain(h);
    expect((await content(tar.saved.file)).data.toString('utf8')).toBe('TARBYTES');

    // The tool's ceiling is internal: a confidential file is not handed to it.
    const secret = await put('secret.log', Buffer.from('error\n'), 'confidential');
    expect((await call('files.run_tool', { fileId: secret, tool: 'unix_pipeline', arguments: { pipeline: 'cat' } }, { label: 'confidential' })).error).toMatch(/cleared for internal content; secret.log is confidential/);
  });

  it('files.run_tool and files.apply_tool hand a file to a read-only MCP tool in BRIDGES: the document converter', async () => {
    const { put, call, content } = await setup();
    const mcp = await new FakeMcp().start();
    try {
      let seen: Record<string, unknown> = {};
      const odt = Buffer.alloc(12_000, 7);
      mcp.tools = [
        {
          name: 'convert_document', description: 'Converts a document.', annotations: { readOnlyHint: true },
          run: (a) => {
            seen = a;
            return a.to === 'md'
              ? { name: 'report.md', to: 'md', encoding: 'text', content: '# Report\n', engine: ['pandoc'] }
              : { name: 'report.odt', to: 'odt', encoding: 'base64', content: odt.toString('base64'), engine: ['libreoffice'] };
          }
        },
        { name: 'convert_inspect', description: 'Inspects a document.', run: () => ({ format: 'docx' }) }
      ];
      await localUser(h, 'mt', ['tool-admin'], 'confidential');
      const ta = await loginAdmin(h, 'mt');
      const post = (path: string, body: object = {}) => ta.agent.post(path).set('x-csrf-token', ta.csrf).send(body);
      const reg = (await post('/api/admin/mcp-servers', { name: 'exprsn-convert', url: mcp.url }).expect(201)).body as { id: string };
      await post(`/api/admin/mcp-servers/${reg.id}/tools/convert_document/approve`, { sideEffect: 'read', confirm: 'never', label: 'internal' }).expect(200);
      // a bridged MCP tool must be a read: what it makes is saved by files.apply_tool, never by the tool
      await post(`/api/admin/mcp-servers/${reg.id}/tools/convert_inspect/approve`, { sideEffect: 'write', confirm: 'always', label: 'internal' }).expect(200);

      const rtf = Buffer.from('{\\rtf1\\ansi Report\\par}');
      const file = await put('report.rtf', rtf);
      const first = await call('files.run_tool', { fileId: file, tool: 'exprsn-convert.convert_document', arguments: { to: 'md' } });
      expect(first.error).toBeUndefined();
      const md = first.result as { result: Record<string, unknown> };
      expect(seen).toMatchObject({ to: 'md', name: 'report.rtf', base64: rtf.toString('base64') });
      expect(md.result).toMatchObject({ name: 'report.md', encoding: 'text', content: '# Report\n' });

      // a binary product is left out of a read, and saved under the name the converter gives it
      const binary = (await call('files.run_tool', { fileId: file, tool: 'exprsn-convert.convert_document', arguments: { to: 'odt' } })).result as { result: Record<string, unknown>; note: string };
      expect(binary.result).not.toHaveProperty('content');
      expect(binary.note).toMatch(/content.*files\.apply_tool/);
      const saved = (await call('files.apply_tool', { fileId: file, tool: 'exprsn-convert.convert_document', arguments: { to: 'odt' } })).result as { saved: { file: string; name: string; new: boolean } };
      expect(saved.saved).toMatchObject({ name: 'report.odt', new: true });
      const text = (await call('files.apply_tool', { fileId: file, tool: 'exprsn-convert.convert_document', arguments: { to: 'md' } })).result as { saved: { file: string; name: string } };
      expect(text.saved.name).toBe('report.md');
      await drain(h);
      expect((await content(saved.saved.file)).data.equals(odt)).toBe(true);
      expect((await content(text.saved.file)).data.toString('utf8')).toBe('# Report\n');
      expect((await content(file)).version).toBe(1);

      expect((await call('files.run_tool', { fileId: file, tool: 'exprsn-convert.convert_inspect' })).error).toMatch(/only read tools work on files here/);
    } finally {
      await mcp.stop();
    }
  });

  it('files.save creates a file and files.extract unpacks an archive into a folder', async () => {
    const { put, call, content, ws } = await setup();
    expect(await call('files.save', { name: 'report.md', content: '# Report' }, { approved: false })).toMatchObject({ ok: false, needsApproval: true });
    const report = (await call('files.save', { name: 'dir/report.md', content: '# Report\n', workspaceId: ws })).result as { file: string; name: string; label: string };
    expect(report).toMatchObject({ name: 'dir report.md', label: 'internal' });
    await drain(h);
    expect((await content(report.file)).data.toString('utf8')).toBe('# Report\n');
    const bin = (await call('files.save', { name: 'b.bin', content: Buffer.from([1, 2, 0]).toString('base64'), encoding: 'base64', workspaceId: ws })).result as { file: string; size: number };
    expect(bin.size).toBe(3);
    expect((await call('files.save', { name: 'empty.txt', content: '' })).error).toMatch(/empty/);

    const archive = await put('bundle.tar.gz', Buffer.from('not really a tar'));
    expect((await call('files.extract', { fileId: archive })).error).toMatch(/archive_tool is not a script tool published/);
    await publish('archive-tool', 'archive_tool');
    const calls: Record<string, unknown>[] = [];
    runner.handler = (req) => {
      const a = JSON.parse(req.stdin ?? '{}') as { action: string; members?: string[] };
      calls.push(a);
      if (a.action === 'list') return { stdout: JSON.stringify({ members: [{ path: 'docs', type: 'directory', size: 0 }, { path: 'docs/a.md', type: 'file', size: 4 }, { path: 'docs/big.bin', type: 'file', size: 900_000 }, { path: 'link', type: 'symlink', size: 0 }] }) };
      if (a.members?.[0] === 'docs/a.md') return { stdout: JSON.stringify({ files: [{ path: 'docs/a.md', base64: Buffer.from('# A\n').toString('base64'), encoding: 'base64' }] }) };
      return { stdout: JSON.stringify({ files: [{ path: 'docs/big.bin', skipped: 'over the max_bytes budget' }] }) };
    };
    const out = (await call('files.extract', { fileId: archive })).result as { folder: { id: string; name: string; created: boolean }; saved: { path: string; file: string; name: string }[]; skipped: { path: string; reason: string }[] };
    expect(out.folder).toMatchObject({ name: 'bundle', created: true });
    expect(out.saved.map((x) => [x.path, x.name])).toEqual([['docs/a.md', 'docs - a.md']]);
    expect(out.skipped).toEqual([{ path: 'docs/big.bin', reason: 'over the max_bytes budget' }]);
    expect(calls.map((c) => c.action)).toEqual(['list', 'extract', 'extract']);
    await drain(h);
    const a = await content(out.saved[0]!.file);
    expect(a.data.toString('utf8')).toBe('# A\n');
    expect(a.folder).toBe(out.folder.id);
    runner.handler = () => ({ stdout: '{"error": "this is a 7z archive, which this tool does not read"}' });
    expect((await call('files.extract', { fileId: archive })).error).toMatch(/bundle\.tar\.gz: this is a 7z archive/);
  });
});
