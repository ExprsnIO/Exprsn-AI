import { test, expect, open, expectLive, toast, confirmDialog, apiAs, type Page } from './support/fixtures';
import { serverState } from './support/state';

// B-3404: plugins and events. A declarative plugin is installed, enabled and granted through the console; revoking a
// grant on the screen makes the plugin's next action refused (403, plugin.action.refused), seen in the Runs view.

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/** A declarative plugin that writes a log line and an audit entry whenever any plugin is installed. */
const manifest = (key: string) => ({
  key,
  name: `Install watcher ${key.slice(-6)}`,
  version: '1.0.0',
  kind: 'declarative',
  publisher: 'e2e',
  events: ['plugin.*'],
  capabilities: ['read:events', 'emit:log', 'emit:audit'],
  optionalCapabilities: ['emit:audit'],
  actions: [
    { type: 'log', on: 'plugin.installed', with: { message: 'saw {{event.type}}' } },
    { type: 'audit', on: 'plugin.installed', with: { message: 'install noticed' } }
  ]
});

/**
 * Installs (through the API) a throwaway plugin, whose plugin.installed audit entry is the event the watcher acts on,
 * and removes it again.
 */
async function triggerEvent(): Promise<void> {
  const api = await apiAs('root');
  const key = `e2e-trigger-${uid()}`;
  const p = await api.post('/api/admin/plugins', { manifest: { key, name: 'Trigger', version: '1.0.0', kind: 'declarative', events: ['job.*'], capabilities: ['read:events', 'emit:log'], actions: [{ type: 'log', on: 'job.succeeded' }] } });
  const { csrf } = await api.get('/api/auth/session');
  const r = await api.ctx.delete(`/api/admin/plugins/${p.id}`, { headers: { 'x-csrf-token': csrf, origin: serverState().url } });
  expect(r.status()).toBe(204);
  await api.close();
}

async function installThroughConsole(page: Page, key: string): Promise<void> {
  await open(page, 'plugins');
  await expectLive(page);
  await page.locator('[data-goinstall]').click();
  await page.locator('[data-manifest]').fill(JSON.stringify(manifest(key), null, 2));
  await page.locator('[data-validate]').click();
  await expect(page.locator('#main')).toContainText('Valid.');
  await page.locator('[data-install]').click();
  await confirmDialog(page, 'Install');
  await toast(page, `${key} installed with 3 grants`);
  await expect(page.locator(`#main tr[data-key="${key}"]`)).toContainText('installed');
}

async function enable(page: Page, key: string): Promise<void> {
  await page.locator(`#main tr[data-key="${key}"]`).click();
  await page.locator('[data-enable]').click();
  await confirmDialog(page, 'Enable');
  await toast(page, `${key} enabled`);
  await expect(page.locator(`#main tr[data-key="${key}"]`)).toContainText('enabled');
}

/**
 * The Runs view for one plugin, refreshed until its newest invocation has finished and reads `expected`; returns that
 * row. (Other specs' installs are plugin.installed events too, so the number of runs is not fixed.)
 */
async function newestRun(page: Page, key: string, expected: RegExp) {
  await page.locator(`#main tr[data-key="${key}"]`).click();
  await page.locator('[data-runsfor]').click();
  const newest = page.locator(`#main tr[data-plugin-key="${key}"]`).first();
  await expect(async () => {
    await page.locator('[data-runsrefresh]').click();
    await expect(newest).toContainText(expected, { timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  return newest;
}

test.describe('Plugins and events', () => {
  test('revoking a grant on the screen makes the plugin\'s next action refused', async ({ page }) => {
    const key = `e2e-watch-${uid()}`;
    await installThroughConsole(page, key);
    await enable(page, key);

    // With every grant held, both actions run.
    await triggerEvent();
    let run = await newestRun(page, key, /succeeded/);
    await expect(run.locator('.pill', { hasText: /^audit$/ })).toBeVisible();
    await run.click();
    await expect(page.locator('.plugins-insp')).toContainText('saw plugin.installed');

    // Revoke emit:audit (optional, so the plugin stays enabled) on the screen.
    await page.locator('[data-openplugin]').first().click();
    await expect(page.locator('.plugins-insp')).toContainText(key);
    await page.locator('[data-grant="emit:audit"]').uncheck();
    await page.locator('[data-savegrants]').click();
    await expect(page.locator('#overlay .modal')).toContainText('Its next action that needs it is refused');
    await confirmDialog(page, 'Save grants');
    await toast(page, `Grants saved for ${key}`);
    await expect(page.locator(`#main tr[data-key="${key}"]`)).toContainText('enabled');
    await expect(page.locator('[data-actions]')).toContainText('refused when run');

    // The next event: the log action still runs, the audit action is refused.
    await triggerEvent();
    run = await newestRun(page, key, /audit refused \(403\)/);
    await expect(run).toContainText('failed');
    await expect(run.locator('.pill', { hasText: /^log$/ })).toBeVisible();
    await run.click();
    await expect(page.locator('.plugins-insp')).toContainText('not granted emit:audit');

    // The API agrees, and the refusal is audited.
    const api = await apiAs('root');
    const { invocations } = await api.get(`/api/admin/plugins/${key}/invocations?limit=1`);
    expect(invocations[0].outcome.actions).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'audit', ok: false, status: 403 })]));
    await api.close();
  });

  test('revoking a required grant disables the plugin, and enable is refused until it is granted again', async ({ page, watch }) => {
    watch.allow.push(/POST \/api\/admin\/plugins\/[^/]+\/enable -> 409$/);
    const key = `e2e-req-${uid()}`;
    await installThroughConsole(page, key);
    await enable(page, key);

    await page.locator('[data-grant="emit:log"]').uncheck();
    await page.locator('[data-savegrants]').click();
    await expect(page.locator('#overlay .modal')).toContainText('disables plugin');
    await confirmDialog(page, 'Save grants');
    await toast(page, 'It lost required emit:log and is disabled.');
    const row = page.locator(`#main tr[data-key="${key}"]`);
    await expect(row).toContainText('disabled');
    await expect(row).toContainText('missing emit:log');

    // A disabled plugin receives nothing: the next event adds no run.
    const api = await apiAs('root');
    const before = (await api.get(`/api/admin/plugins/${key}/invocations`)).invocations.length;
    await triggerEvent();
    await page.waitForTimeout(1500);
    expect((await api.get(`/api/admin/plugins/${key}/invocations`)).invocations.length).toBe(before);
    await api.close();

    // Enable is refused (409 with missing) and the screen says why; granting it again lets it enable.
    await page.locator('[data-tab="plugins"]').click();
    await row.click();
    await page.locator('[data-enable]').click();
    await confirmDialog(page, 'Enable');
    await expect(page.locator('#main .problem')).toContainText('missing: emit:log');
    await page.locator('[data-grant="emit:log"]').check();
    await page.locator('[data-savegrants]').click();
    await toast(page, `Grants saved for ${key}`);
    await enable(page, key);
    await expect(page.locator('.plugins-insp')).toContainText('grants');
  });

  test('lifecycle, manifest checks and the event catalogue', async ({ page, watch }) => {
    watch.allow.push(/POST \/api\/admin\/plugins\/validate -> 422$/);
    const key = `e2e-life-${uid()}`;
    await open(page, 'plugins');
    await page.locator('[data-tab="install"]').click();
    // A manifest naming a capability outside the vocabulary is refused with every problem.
    await page.locator('[data-manifest]').fill(JSON.stringify({ ...manifest(key), capabilities: ['read:events', 'call:shell'], optionalCapabilities: [], actions: [] }));
    await page.locator('[data-validate]').click();
    await expect(page.locator('#main .problem')).toContainText('call:shell');

    await installThroughConsole(page, key);
    await enable(page, key);
    const row = page.locator(`#main tr[data-key="${key}"]`);
    await page.locator('[data-disable]').click();
    await confirmDialog(page, 'Disable');
    await toast(page, `${key} disabled`);
    await expect(row).toContainText('disabled');

    await page.locator('[data-remove]').click();
    await page.locator('#overlay .modal [data-f="reason"]').fill('e2e cleanup');
    await confirmDialog(page, 'Remove');
    await toast(page, `${key} removed`);
    await expect(row).toContainText('removed');
    await expect(page.locator('.plugins-insp')).toContainText('e2e cleanup');

    await page.locator('[data-reinstall]').click();
    await confirmDialog(page, 'Reinstall');
    await toast(page, `${key} reinstalled`);
    await expect(row).toContainText('installed');
    await expect(page.locator('.plugins-insp')).toContainText('removed → installed');

    // The event catalogue from the server, with each type's data schema.
    await page.locator('[data-tab="catalogue"]').click();
    await page.locator('[data-catsearch]').fill('flag.created');
    await page.locator('#main tr[data-type="flag.created"]').click();
    await expect(page.locator('#main')).toContainText('Schema of flag.created');
    await expect(page.locator('#main .codebox, #main pre').first()).toContainText('properties');
  });
});
