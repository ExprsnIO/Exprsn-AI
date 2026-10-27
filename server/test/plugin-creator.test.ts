import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { manifestSchema as bundleManifestSchema } from '../src/ops/bundles.js';
import { tarEntries } from '../src/ops/tar.js';
import { buildManifest, checkWizard, handlerSkeleton, stepOf, type Wizard } from '../src/plugins/drafts.js';
import { validateManifest } from '../src/plugins/manifest.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';

/*
 * 1.8.0, Sprint 48 (B-147): the plugin creator. Every wizard output is a manifest that passes `validateManifest`
 * (and so `surfaceProblems`); a capability outside the vocabulary or an unsound surface is refused on the server; a
 * draft is its author's, is saved, and installs as a plugin that still needs its grants and enable.
 */

const basics = (key: string) => ({ name: `Plugin ${key}`, key, description: 'Written by the wizard', version: '0.1.0' });

/** One wizard per kind of output the creator offers. */
const WIZARDS: Record<string, Wizard> = {
  actions: { basics: basics('flag-notes'), capabilities: ['read:events', 'emit:log', 'emit:notification'], optional: ['emit:notification'], events: ['flag.*'], handler: { type: 'actions', actions: [{ type: 'log', on: 'flag.created', with: { message: 'Flag {{event.data.flag}}' } }, { type: 'notify', with: { title: 'A flag', roles: ['tenant-admin'] } }] } },
  surfaces: {
    basics: basics('deal-panel'),
    capabilities: ['read:records'],
    surfaces: [
      { id: 'about', slot: 'settings', title: 'About', blocks: [{ type: 'text', text: 'Shows a deal beside it.' }] },
      { id: 'deal', slot: 'record', title: 'Deal', app: 'crm', entity: 'deal', capabilities: ['read:records'], data: { deal: { api: 'records.read', with: { app: 'crm', entity: 'deal', id: '{{context.record}}' } } }, blocks: [{ type: 'kv', data: 'deal', items: [{ label: 'Title', path: 'record.values.title' }] }] },
      { id: 'card', slot: 'dashboard', title: 'Deals', capabilities: ['read:records'], data: { list: { api: 'records.read', with: { app: 'crm', entity: 'deal', limit: 5 } } }, blocks: [{ type: 'table', data: 'list', rows: 'records', columns: [{ label: 'Title', path: 'values.title' }] }] }
    ],
    handler: { type: 'none' }
  },
  webhook: { basics: basics('job-relay'), capabilities: ['read:events', 'call:webhook'], events: ['job.failed'], handler: { type: 'webhook', url: 'https://hooks.example.com/exprsn' } },
  script: { basics: basics('record-script'), capabilities: ['read:records', 'emit:log', 'emit:flag'], events: ['record.updated'], handler: { type: 'script', language: 'javascript', entry: 'onRecord' } },
  python: { basics: basics('record-py'), capabilities: ['read:records'], events: ['record.created'], handler: { type: 'script', language: 'python' } }
};

describe('plugin creator (Sprint 48, B-147)', () => {
  let h: Harness;
  let admin: Client & { send: (m: 'post' | 'put' | 'delete', p: string, b?: object) => ReturnType<Client['agent']['post']> };

  beforeEach(async () => {
    h = await harness();
    await localUser(h, 'pa', ['tenant-admin'], 'confidential');
    const c = await loginAdmin(h, 'pa');
    admin = { ...c, send: (m, p, b = {}) => c.agent[m](p).set('x-csrf-token', c.csrf).send(b) };
  });
  afterEach(async () => {
    await h.close();
  });

  it('every wizard output validates, the script ones with a sandbox handler skeleton', async () => {
    for (const [name, w] of Object.entries(WIZARDS)) {
      const c = checkWizard(w);
      expect(c.problems, name).toEqual([]);
      expect(c.valid, name).toBe(true);
      const m = validateManifest(c.manifest);
      expect(m.key).toBe(w.basics!.key);
      // and the server says the same
      const r = (await admin.send('post', '/api/admin/plugin-drafts/check', { wizard: w }).expect(200)).body as { valid: boolean; manifest: { kind: string } };
      expect(r.valid, name).toBe(true);
    }
    const js = buildManifest(WIZARDS.script!) as { kind: string; script: { entry: string; language: string; source: string } };
    expect(js.kind).toBe('script');
    expect(js.script.entry).toBe('onRecord');
    expect(js.script.source).toContain('async function onRecord(event, platform)');
    expect(js.script.source).toContain("platform.log('Received '");
    expect(js.script.source).toMatch(/flag \(emit:flag\)/);
    const py = buildManifest(WIZARDS.python!) as { script: { entry: string; source: string } };
    expect(py.script.entry).toBe('handle');
    expect(py.script.source).toContain('def handle(event, platform):');
    // Without emit:log the skeleton only says how to get it.
    expect(py.script.source).not.toContain('platform.log("Received');
    expect(handlerSkeleton({ name: 'X', key: 'x', events: [], capabilities: [], language: 'javascript', entry: 'go' })).toContain('none: the plugin asks for no capability that has a call');
    expect(buildManifest(WIZARDS.actions!)).toMatchObject({ kind: 'declarative', optionalCapabilities: ['emit:notification'], actions: [{ type: 'log', on: 'flag.created' }, { type: 'notify' }] });
  });

  it('refuses a capability outside the vocabulary and an unsound surface, naming the step', async () => {
    const badCap = { ...WIZARDS.actions!, capabilities: ['read:events', 'emit:log', 'emit:notification', 'read:everything'] };
    const c1 = (await admin.send('post', '/api/admin/plugin-drafts/check', { wizard: badCap }).expect(200)).body as { valid: boolean; problems: { step: number; message: string }[] };
    expect(c1.valid).toBe(false);
    expect(c1.problems).toContainEqual({ step: 2, message: expect.stringMatching(/not in the capability vocabulary: read:everything/) });

    // A surface whose call needs a capability it does not declare, and a block reading data it does not name.
    const badUi = { ...WIZARDS.surfaces!, surfaces: [{ id: 'deal', slot: 'record', title: 'Deal', capabilities: [], data: { deal: { api: 'records.read', with: { id: '{{context.file}}' } } }, blocks: [{ type: 'kv', data: 'other', items: [{ label: 'T', path: 'x' }] }] }] };
    const c2 = (await admin.send('post', '/api/admin/plugin-drafts/check', { wizard: badUi }).expect(200)).body as { valid: boolean; problems: { step: number; message: string }[] };
    expect(c2.valid).toBe(false);
    expect(c2.problems.every((x) => x.step === 3)).toBe(true);
    expect(c2.problems.map((x) => x.message).join('\n')).toMatch(/needs read:records, which the surface does not declare/);
    expect(c2.problems.map((x) => x.message).join('\n')).toMatch(/not something the record slot provides/);
    expect(c2.problems.map((x) => x.message).join('\n')).toMatch(/not under data/);
    // A block type the renderer does not have.
    const html = { ...WIZARDS.surfaces!, surfaces: [{ id: 'x', slot: 'settings', title: 'X', blocks: [{ type: 'html', html: '<script>' }] }] };
    expect(((await admin.send('post', '/api/admin/plugin-drafts/check', { wizard: html }).expect(200)).body as { valid: boolean }).valid).toBe(false);
    // An unknown field of the wizard itself is a 400.
    await admin.send('post', '/api/admin/plugin-drafts/check', { wizard: { ...WIZARDS.actions!, code: 'x' } }).expect(400);
    // A script that reaches the network is refused like any script plugin.
    const net = { ...WIZARDS.script!, handler: { type: 'script' as const, entry: 'onRecord', source: "import http from 'node:http';\nasync function onRecord() {}" } };
    expect(checkWizard(net).problems.map((x) => x.message).join('\n')).toMatch(/handlers have no network/);
    expect(stepOf('events: x is not in the event catalogue')).toBe(4);

    // Saved as a draft, an invalid one does not install or download (422 with every problem).
    const d = (await admin.send('post', '/api/admin/plugin-drafts', { wizard: badCap }).expect(201)).body as { id: string; valid: boolean };
    expect(d.valid).toBe(false);
    const refused = await admin.send('post', `/api/admin/plugin-drafts/${d.id}/install`, { maxLabel: 'internal' }).expect(422);
    expect(refused.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(refused.body.errors.join(' ')).toMatch(/read:everything/);
    await admin.agent.get(`/api/admin/plugin-drafts/${d.id}/download`).expect(422);
    expect(await h.s.db('plugins').where({ tenant_id: h.tenantId }).count({ n: '*' }).first()).toMatchObject({ n: 0 });
  });

  it('saves a draft per user, installs it as a draft that still needs grants and enable, and downloads an unsigned bundle', async () => {
    const created = (await admin.send('post', '/api/admin/plugin-drafts', { wizard: { basics: { name: 'Flag notes' } } }).expect(201)).body as { id: string; step: number; valid: boolean; name: string };
    expect(created).toMatchObject({ step: 1, valid: false, name: 'Flag notes' });
    const saved = (await admin.send('put', `/api/admin/plugin-drafts/${created.id}`, { wizard: WIZARDS.actions, step: 5 }).expect(200)).body as { step: number; valid: boolean; key: string; manifest: { key: string } };
    expect(saved).toMatchObject({ step: 5, valid: true, key: 'flag-notes' });
    expect(((await admin.agent.get('/api/admin/plugin-drafts').expect(200)).body as { drafts: { id: string }[] }).drafts.map((x) => x.id)).toEqual([created.id]);

    // Another admin of the tenant neither lists nor opens it; a member cannot reach the creator at all.
    await localUser(h, 'pb', ['tenant-admin'], 'confidential');
    const other = await loginAdmin(h, 'pb');
    expect(((await other.agent.get('/api/admin/plugin-drafts').expect(200)).body as { drafts: unknown[] }).drafts).toEqual([]);
    await other.agent.get(`/api/admin/plugin-drafts/${created.id}`).expect(404);
    await other.agent.put(`/api/admin/plugin-drafts/${created.id}`).set('x-csrf-token', other.csrf).send({ step: 2 }).expect(404);
    await localUser(h, 'mem', ['member'], 'internal');
    const { login } = await import('./helpers.js');
    const member = await login(h, 'mem');
    await member.agent.get('/api/admin/plugin-drafts').expect(403);

    // The download: an unsigned import bundle (manifest.json listing files/plugins/<key>.json), or the plugin file.
    const tar = await admin.agent.get(`/api/admin/plugin-drafts/${created.id}/download`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(tar.headers['content-disposition']).toMatch(/attachment; filename="plugin-flag-notes-0\.1\.0\.unsigned\.tar"/);
    const buf = tar.body as Buffer;
    const entries = [...tarEntries(buf)].map((e) => ({ path: e.path, data: buf.subarray(e.offset, e.offset + e.size) }));
    expect(entries.map((e) => e.path)).toEqual(['manifest.json', 'files/plugins/flag-notes.json']);
    const bm = bundleManifestSchema.parse(JSON.parse(entries[0]!.data.toString('utf8')));
    expect(bm.files).toMatchObject([{ path: 'plugins/flag-notes.json', mirror: 'plugins', size: entries[1]!.data.length }]);
    expect(validateManifest(JSON.parse(entries[1]!.data.toString('utf8'))).key).toBe('flag-notes');
    const file = (await admin.agent.get(`/api/admin/plugin-drafts/${created.id}/download?format=manifest`).expect(200)).body as { key: string };
    expect(file.key).toBe('flag-notes');

    // Installed as a draft: state installed, nothing granted, enable refused until the grants are made.
    const plugin = (await admin.send('post', `/api/admin/plugin-drafts/${created.id}/install`, { maxLabel: 'internal' }).expect(201)).body as { id: string; state: string; granted: string[]; missing: string[] };
    expect(plugin).toMatchObject({ state: 'installed', granted: [] });
    expect(plugin.missing.sort()).toEqual(['emit:log', 'read:events']);
    const blocked = await admin.send('post', `/api/admin/plugins/${plugin.id}/enable`, {}).expect(409);
    expect(blocked.body.missing.sort()).toEqual(['emit:log', 'read:events']);
    await admin.send('put', `/api/admin/plugins/${plugin.id}/grants`, { grants: ['read:events', 'emit:log'] }).expect(200);
    expect(((await admin.send('post', `/api/admin/plugins/${plugin.id}/enable`, {}).expect(200)).body as { state: string }).state).toBe('enabled');
    expect((await admin.agent.get(`/api/admin/plugin-drafts/${created.id}`).expect(200)).body.pluginId).toBe(plugin.id);
    // Installing again is the install's own conflict.
    await admin.send('post', `/api/admin/plugin-drafts/${created.id}/install`, { maxLabel: 'internal' }).expect(409);

    // A script plugin follows the signing policy (PLUGINS_REQUIRE_SIGNED=scripts): it is downloaded and signed, not installed inline.
    const script = (await admin.send('post', '/api/admin/plugin-drafts', { wizard: WIZARDS.script }).expect(201)).body as { id: string; valid: boolean };
    expect(script.valid).toBe(true);
    const unsigned = await admin.send('post', `/api/admin/plugin-drafts/${script.id}/install`, { maxLabel: 'internal' }).expect(409);
    expect(unsigned.body.detail).toMatch(/signed import bundle/);

    await admin.send('delete', `/api/admin/plugin-drafts/${script.id}`).expect(204);
    await admin.agent.get(`/api/admin/plugin-drafts/${script.id}`).expect(404);

    const actions = ((await h.s.audit.list(h.tenantId, { limit: 200 })) as { action: string }[]).map((e) => e.action).filter((a) => a.startsWith('plugin.draft.'));
    expect(new Set(actions)).toEqual(new Set(['plugin.draft.created', 'plugin.draft.saved', 'plugin.draft.exported', 'plugin.draft.installed', 'plugin.draft.deleted']));
  });

  it('offers the vocabulary with plain-language help and the optional and required split', async () => {
    const v = (await admin.agent.get('/api/admin/plugin-drafts/vocabulary').expect(200)).body as { capabilities: { name: string; risk: string; help: string; calls: string[] }[]; optionalHelp: string; slots: { id: string }[]; blocks: { type: string }[]; handlers: { type: string }[]; signing: { policy: string } };
    expect(v.capabilities.map((c) => c.name)).toContain('call:webhook');
    expect(v.capabilities.find((c) => c.name === 'call:webhook')!.help).toMatch(/High risk/);
    expect(v.capabilities.find((c) => c.name === 'emit:flag')!.calls).toEqual(['flag']);
    expect(v.optionalHelp).toMatch(/Required capabilities/);
    expect(v.slots.map((s) => s.id)).toEqual(['settings', 'record', 'conversation', 'file', 'dashboard']);
    expect(v.blocks.map((b) => b.type)).toEqual(['text', 'kv', 'table', 'action']);
    expect(v.handlers.map((x) => x.type)).toEqual(['none', 'actions', 'webhook', 'script']);
    expect(v.signing.policy).toBe('scripts');
  });
});
