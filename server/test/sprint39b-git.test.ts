import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { audits, buildCrm, designer, env, ok, type C, type Env } from './sprint39b-helpers.js';

const run = promisify(execFile);
const git = (args: string[], cwd?: string) => run('git', ['-c', 'protocol.file.allow=always', ...args], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' } });

/*
 * 1.6.0, Sprint 39b, B-8204: a package pushed to a repository as one file per object, and read back from it on another
 * instance (here: under another name) as the same app; a file changed in the repository no longer verifies.
 * A bare repository on disk stands in for the remote (APPS_GIT_ALLOW_FILE).
 */
describe('B-8204: git export and import of a package', () => {
  let e: Env;
  let d: C;
  let dir: string;
  let remote: string;

  beforeEach(async () => {
    e = await env({ APPS_GIT_ALLOW_FILE: 'true' });
    d = await designer(e);
    await buildCrm(e, d);
    dir = await mkdtemp(path.join(tmpdir(), 'exprsn-apps-git-'));
    remote = path.join(dir, 'remote.git');
    await git(['init', '--quiet', '--bare', '--initial-branch=main', remote]);
  });
  afterEach(async () => {
    await e.h.close();
    await rm(dir, { recursive: true, force: true });
  });

  const url = () => `file://${remote}`;

  it('pushes the package as files, imports it back as the same app, and refuses a changed file', async () => {
    const created = (await d.post('/api/apps/crm/packages', { note: 'to git' }).expect(201)).body;
    const pushed = (await ok(d.post(`/api/apps/crm/packages/${created.id}/git`, { url: url(), ref: 'main', path: 'apps/crm', message: 'crm v1' }), 200)).body;
    expect(pushed).toMatchObject({ commit: expect.stringMatching(/^[0-9a-f]{40}$/), files: 8, path: 'apps/crm' });
    const tree = (await git(['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main'])).stdout.trim().split('\n').sort();
    expect(tree).toEqual(['apps/crm/app.json', 'apps/crm/entities/deal.json', 'apps/crm/entities/task.json', 'apps/crm/forms/new_deal.json', 'apps/crm/package.json', 'apps/crm/policies/001-Own_region.json', 'apps/crm/triggers/001-deal-record.json', 'apps/crm/workflows/on-update.json']);
    expect((await git(['--git-dir', remote, 'log', '-1', '--format=%s %an', 'main'])).stdout.trim()).toBe('crm v1 Exprsn-AI');
    expect((await audits(e, 'app.package.pushed')).length).toBe(1);

    // pushing the same package again makes no commit
    const again = (await d.post(`/api/apps/crm/packages/${created.id}/git`, { url: url(), ref: 'main', path: 'apps/crm' }).expect(200)).body;
    expect(again.commit).toBe(pushed.commit);

    // the other instance: imported under another name, the same design
    const imported = (await ok(d.post('/api/apps/packages/git-import', { url: url(), ref: 'main', path: 'apps/crm', name: 'crm_from_git' }), 201)).body;
    expect(imported).toMatchObject({ name: 'crm_from_git', commit: pushed.commit, report: { entities: { created: ['deal', 'task'] }, forms: { created: ['new_deal'] }, policies: { created: 1 }, triggers: { created: 1 } }, package: { source: 'git', version: 1 } });
    const copy = (await d.get('/api/apps/crm_from_git').expect(200)).body;
    expect(copy.entities.map((x: { name: string }) => x.name)).toEqual(['deal', 'task']);
    expect(copy.entities[0].definition.fields.map((f: { name: string }) => f.name)).toEqual(['title', 'amount', 'region', 'twice']);

    // a file edited in the repository: the signature no longer verifies, nothing is created
    const work = path.join(dir, 'work');
    await git(['clone', '--quiet', url(), work]);
    const file = path.join(work, 'apps/crm/entities/deal.json');
    await writeFile(file, (await readFile(file, 'utf8')).replace('"Deal"', '"Deals"'));
    await git(['-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '--quiet', '-am', 'edit'], work);
    await git(['push', '--quiet', 'origin', 'HEAD:main'], work);
    const refused = await d.post('/api/apps/packages/git-import', { url: url(), ref: 'main', path: 'apps/crm', name: 'crm_bad' }).expect(422);
    expect(refused.body.detail).toMatch(/signature does not verify/);
    await d.get('/api/apps/crm_bad').expect(404);
  });

  it('refuses repositories that are not https (or file when allowed), credentials in the URL, and paths that leave the tree', async () => {
    const created = (await d.post('/api/apps/crm/packages', {}).expect(201)).body;
    expect((await d.post(`/api/apps/crm/packages/${created.id}/git`, { url: 'http://example.com/x.git', path: 'apps/crm' }).expect(400)).body.detail).toMatch(/https/);
    expect((await d.post(`/api/apps/crm/packages/${created.id}/git`, { url: 'https://user:pw@example.com/x.git', path: 'apps/crm' }).expect(400)).body.detail).toMatch(/Credentials in the URL/);
    expect((await d.post(`/api/apps/crm/packages/${created.id}/git`, { url: url(), path: '../x' }).expect(400)).body.detail).toMatch(/leaves no directory/);
    expect((await d.post(`/api/apps/crm/packages/${created.id}/git`, { url: url(), path: 'apps/crm', credential: 'plain-token' }).expect(400)).body.detail).toMatch(/vault reference/);
    expect((await d.post('/api/apps/packages/git-import', { url: url(), ref: 'main', path: 'nothing/here' }).expect(400)).body.detail).toMatch(/No package at nothing\/here/);
  });
});
