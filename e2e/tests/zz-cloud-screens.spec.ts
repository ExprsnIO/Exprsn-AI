import type { Page } from '@playwright/test';
import { test, expect, open, settle, ready, confirmDialog, toast, apiAs } from './support/fixtures';
import { expectAccessible } from './support/a11y';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';
import { serverState } from './support/state';

/*
 * 1.9.99-final, Sprint 62 (B-10706): the cloud screens live: Cloud accounts, Deployments, Cloud data and Cloud
 * compute. The e2e server seeds (e2e/cloud-seed.ts, through the real services against the DigitalOcean fake; nothing
 * reaches a cloud) the account do-lab and the deployments nw-lab (applied, one open drift finding, a managed
 * PostgreSQL), nw-staging (an open plan) and nw-old (applied, for the destroy), and the GPU pool gpu-cloud.
 *
 * Every design state of the four screens, applied through App.applyState, passes the WCAG checker and axe-core
 * (Standard and Enhanced, light and dark) and reflows at 320 and 640 px; then the primary flows: the wizard from spec
 * to a plan with its estimate, apply by hash with a recent sign-in, drift revert, a destroy whose protected database a
 * second cloud admin approves, a database snapshot, connecting a discovered database, and a GPU pool's scaling.
 *
 * The file runs after zones.spec.ts (which seeds the zones through the Zones screen and expects none before it): the
 * wizard's dry run needs zones, and this spec seeds the defaults itself only when it runs alone.
 */

type AppGlobal = { App: { setA11y(m: 'aa' | 'aaa' | null): void; applyState(i: number): void; closeOverlay(): void; screens: Record<string, { states?: unknown[] }>; state: { route: string; screenState: Record<string, unknown> }; render(): void } };
const ROUTES = ['cloud', 'deployments', 'cloud-data', 'cloud-compute'];

async function accessible(page: Page, where: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await expectAccessible(page, `${where} (${scheme})`);
    for (const mode of ['aa', 'aaa'] as const) {
      await page.evaluate((m) => (window as unknown as AppGlobal).App.setA11y(m), mode);
      await expectAxeClean(page, mode, `${where} (${scheme}, ${mode})`);
    }
    await page.evaluate(() => (window as unknown as AppGlobal).App.setA11y(null));
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
}

async function reflow(page: Page, where: string): Promise<void> {
  for (const width of [320, 640]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(250);
    expect.soft(await reflowProblems(page), `${where} at ${width} px`).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(150);
}

async function stepUpIfAsked(page: Page): Promise<void> {
  const dialog = page.locator('#overlay .modal', { hasText: 'Confirm it is you' });
  if (await dialog.isVisible({ timeout: 2500 }).catch(() => false)) {
    await dialog.locator('[data-supw]').fill(serverState().password);
    await dialog.locator('[data-sugo]').click();
  }
}

/** Opens a route with an empty screen state (a design state applied before must not leak into the next). */
async function fresh(page: Page, route: string): Promise<void> {
  await page.evaluate((r) => { const { App } = window as unknown as Partial<AppGlobal>; if (!App || !App.state) return; App.closeOverlay(); App.state.screenState[r] = {}; }, route);
  await open(page, route);
}

const deploymentId = async (name: string): Promise<string> => {
  const root = await apiAs('root');
  try {
    const d = ((await root.get('/api/admin/cloud/deployments')) as { deployments: { id: string; name: string }[] }).deployments.find((x) => x.name === name);
    expect(d, `the seeded deployment ${name}`).toBeTruthy();
    return d!.id;
  } finally {
    await root.close();
  }
};

/**
 * Confirms the password for the page's session through its own request context (the browser's cookies), not the page:
 * nothing re-renders, so a screen the test opens next keeps its state. Used before each test and for the second admin.
 */
async function stepUpSession(page: Page): Promise<void> {
  const csrf = await page.evaluate(() => (window as unknown as { App: { state: { csrf: string | null } } }).App.state.csrf);
  const res = await page.request.post(`${serverState().url}/api/me/step-up`, { headers: { 'x-csrf-token': csrf ?? '', origin: serverState().url }, data: { password: serverState().password } });
  expect(res.ok(), `step-up answered ${res.status()}`).toBe(true);
}

test.describe('Cloud screens', () => {
  test.beforeAll(async () => {
    // The wizard's dry run renders the firewalls from the zones (seeded by zones.spec.ts in a full run).
    const root = await apiAs('root');
    try {
      const z = (await root.get('/api/admin/zones')) as { zones?: unknown[] };
      if (!z.zones || !z.zones.length) await root.post('/api/admin/zones/seed');
    } finally {
      await root.close();
    }
  });

  // In a full run this spec starts ~45 minutes after the suite signed in, past the 5-minute recent sign-in window, so
  // apply, revert, destroy and snapshot answered 401 step-up (2026-10-21). Confirm the password first, as the
  // "Confirm it is you" dialog would.
  test.beforeEach(async ({ page }) => {
    // A neutral screen: each test opens its own screen afresh after this.
    await open(page, 'chat');
    await stepUpSession(page);
  });

  test('every design state of the four screens passes axe and the WCAG checker and reflows', async ({ page, watch }) => {
    test.setTimeout(1_200_000);
    watch.allow.push(/ -> 404$/, / -> 409$/);
    for (const route of ROUTES) {
      await test.step(route, async () => {
        await fresh(page, route);
        await accessible(page, route);
        await reflow(page, route);
        const n = await page.evaluate((r) => ((window as unknown as AppGlobal).App.screens[r]?.states ?? []).length, route);
        expect(n, `${route} has its board's states`).toBeGreaterThanOrEqual(7);
        for (let i = 0; i < n; i++) {
          await fresh(page, route);
          await page.evaluate((k) => (window as unknown as AppGlobal).App.applyState(k), i);
          await page.waitForTimeout(400);
          await settle(page);
          await page.waitForTimeout(300);
          await settle(page);
          await accessible(page, `${route}, state ${i}`);
          await reflow(page, `${route}, state ${i}`);
        }
      });
    }
  });

  test('deployments: the wizard plans from a spec with its estimate; a plan applies by hash with a recent sign-in', async ({ page }) => {
    test.setTimeout(300_000);
    const name = `e2e-wiz-${Date.now().toString(36).slice(-6)}`;
    await fresh(page, 'deployments');
    const main = page.locator('#main');
    await expect(main.locator('tr', { hasText: 'nw-lab' })).toBeVisible();
    await main.getByRole('button', { name: 'New deployment' }).first().click();
    await expect(main).toContainText('Step 1 of 6');
    await main.locator('[data-prov="digitalocean"]').click();
    await main.locator('[data-f="name"]').fill(name);
    await main.locator('[data-f="account"]').selectOption({ label: 'do-lab' });
    await expect(main.locator('[data-f="region"]')).toHaveValue('fra1');
    await accessible(page, 'Deployments › New, target');
    await reflow(page, 'Deployments › New, target');
    await main.getByRole('button', { name: 'Next' }).click();
    await main.locator('[data-shape="vm"]').click();
    await main.locator('[data-f="tarUrl"]').fill('https://releases.northwind-example.com/exprsn-ai-1.0.0.tar.gz');
    await main.locator('[data-f="tarSha"]').fill('a3f1c2d4e5b60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00');
    await main.locator('[data-f="keysAddr"]').fill('https://openbao.northwind-example.com:8200');
    await main.getByRole('button', { name: 'Next' }).click();
    await expect(main).toContainText('Step 3 of 6');
    await main.getByRole('button', { name: 'Next' }).click();
    await main.locator('[data-front="byo"]').click();
    await main.locator('[data-f="host"]').fill(`${name}.ai.northwind-example.com`);
    await main.getByRole('button', { name: 'Review' }).click();
    await expect(main).toContainText('Step 5 of 6');
    await expect(main).toContainText('The spec is valid', { timeout: 30_000 });
    await expect(main).toContainText('Cost estimate');
    await accessible(page, 'Deployments › New, review');
    await reflow(page, 'Deployments › New, review');
    await main.getByRole('button', { name: 'Create plan' }).click();
    await stepUpIfAsked(page);
    await toast(page, 'created and planned');
    await expect(main).toContainText('Plan hash');
    // DigitalOcean's Spaces bucket is not built yet: the plan says so and Apply stays disabled until it is resolved.
    await expect(main).toContainText('not built yet');
    await expect(main.locator('[data-wapply]')).toBeDisabled();
    await main.getByRole('button', { name: 'Cancel' }).last().click();

    // The open plan of nw-staging: the review, then apply by its hash after a fresh sign-in.
    const staging = await deploymentId('nw-staging');
    await page.goto(`/#/deployments?id=${staging}&tab=plan`);
    await ready(page, 'deployments');
    await expect(main).toContainText('Apply accepts only this hash', { timeout: 20_000 });
    await expect(main).toContainText('Field changes');
    await accessible(page, 'Deployments › plan review');
    await reflow(page, 'Deployments › plan review');
    if (await main.getByText('This plan expired').isVisible().catch(() => false)) {
      await main.getByRole('button', { name: 'Plan again' }).first().click();
      await toast(page, 'Plan made again');
    }
    await main.locator('[data-apply]').click();
    await confirmDialog(page, 'Apply');
    await stepUpIfAsked(page);
    await toast(page, 'Apply started for');
    await expect(main.getByRole('tab', { name: /Operations/ })).toHaveAttribute('aria-selected', 'true');
    await expect(main).toContainText(/create/, { timeout: 20_000 });
    const root = await apiAs('root');
    const events = (await root.get('/api/admin/audit?action=cloud.apply.started&limit=5').catch(() => [])) as { action: string }[];
    expect(Array.isArray(events)).toBe(true);
    await root.close();
  });

  test('deployments: drift is reverted from the finding', async ({ page }) => {
    test.setTimeout(180_000);
    const lab = await deploymentId('nw-lab');
    await page.goto(`/#/deployments?id=${lab}&tab=drift`);
    await ready(page, 'deployments');
    const main = page.locator('#main');
    await expect(main).toContainText('ingress', { timeout: 20_000 });
    await expect(main).toContainText('0.0.0.0/0');
    await expect(main).toContainText('Changed by');
    await accessible(page, 'Deployments › drift');
    await reflow(page, 'Deployments › drift');
    await main.getByRole('button', { name: 'Revert to desired' }).first().click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-dnote]').fill('SSH was opened by hand');
    await confirmDialog(page, 'Revert');
    await stepUpIfAsked(page);
    await toast(page, 'Revert planned and applying');
    await expect.poll(async () => {
      const r = await apiAs('root');
      try { return ((await r.get(`/api/admin/cloud/deployments/${lab}/drift`)) as { findings: { state: string }[] }).findings.some((f) => f.state === 'reverted'); } finally { await r.close(); }
    }, { timeout: 30_000 }).toBe(true);
  });

  test('deployments: a destroy waits for a second cloud admin to approve the protected database', async ({ page, as }) => {
    test.setTimeout(240_000);
    const old = await deploymentId('nw-old');
    await page.goto(`/#/deployments?id=${old}`);
    await ready(page, 'deployments');
    const main = page.locator('#main');
    await expect(main.getByRole('heading', { name: 'nw-old' })).toBeVisible({ timeout: 20_000 });
    await main.getByRole('button', { name: 'Destroy' }).click();
    const modal = page.locator('#overlay .modal', { hasText: 'Destroy nw-old' });
    await expect(modal).toContainText('Protected data');
    await accessible(page, 'Deployments › destroy dialog');
    await reflow(page, 'Deployments › destroy dialog');
    await expect(modal.locator('[data-do]')).toBeDisabled();
    await modal.locator('[data-dreason]').fill('Lab retired');
    await modal.locator('[data-typed]').fill('nw-old');
    await modal.locator('[data-do]').click();
    await stepUpIfAsked(page);
    await toast(page, 'Destroy proposed');
    const panel = main.locator('[data-destroy-panel]');
    await expect(panel).toContainText('db', { timeout: 30_000 });
    // The person who asked cannot approve it.
    await expect(panel.locator('[data-papprove]').first()).toBeDisabled();

    const second = await as('root2');
    await second.goto(`/#/deployments?id=${old}`);
    await ready(second, 'deployments');
    await stepUpSession(second);
    const p2 = second.locator('#main [data-destroy-panel]');
    await expect(p2.locator('[data-papprove]').first()).toBeEnabled({ timeout: 30_000 });
    await p2.locator('[data-papprove]').first().click();
    await confirmDialog(second, 'Approve');
    const d2 = second.locator('#overlay .modal', { hasText: 'Confirm it is you' });
    if (await d2.isVisible({ timeout: 2500 }).catch(() => false)) {
      await d2.locator('[data-supw]').fill(serverState().password);
      await d2.locator('[data-sugo]').click();
    }
    await expect(second.locator('#toasts')).toContainText(/Approved|snapshot/i, { timeout: 20_000 });
  });

  test('cloud data: a database snapshot, and a discovered database connected as a data connection', async ({ page }) => {
    test.setTimeout(180_000);
    // Connecting seals the database's admin password in the tenant vault: root needs a grant on that path (setup only).
    const api = await apiAs('root');
    const me = await api.get('/api/me');
    await api.post('/api/vault/policies', { subjectKind: 'user', subject: me.user.id, path: 'kv/connections/cloud', capabilities: ['*'], effect: 'allow', description: 'e2e cloud connect' });
    await api.close();
    await fresh(page, 'cloud-data');
    const main = page.locator('#main');
    const row = main.locator('tr', { hasText: 'nw-lab' }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    const insp = page.locator('aside.inspector');
    await expect(insp).toContainText('Snapshots');
    await expect(insp).toContainText('Deletion protection');
    await insp.getByRole('button', { name: 'Check extensions' }).click();
    await toast(page, 'available on');
    await insp.getByRole('button', { name: 'Take snapshot' }).click();
    await confirmDialog(page, 'Take snapshot');
    await stepUpIfAsked(page);
    await toast(page, 'Snapshot started');

    await main.getByRole('button', { name: 'Connect existing' }).click();
    const modal = page.locator('#overlay .modal', { hasText: 'Connect an existing cloud database' });
    await expect(modal).toContainText('finance-archive-pg', { timeout: 20_000 });
    await accessible(page, 'Cloud data › Connect existing');
    await reflow(page, 'Cloud data › Connect existing');
    await modal.locator('[data-cname]').fill(`finance-archive-${Date.now().toString(36).slice(-4)}`);
    await modal.locator('[data-cauth]').selectOption('password');
    await modal.getByRole('button', { name: 'Connect' }).click();
    await toast(page, 'Connected as data connection');
  });

  test('cloud compute: a GPU pool\'s scaling is saved and it scales', async ({ page }) => {
    test.setTimeout(180_000);
    await fresh(page, 'cloud-compute');
    const main = page.locator('#main');
    const row = main.locator('tr', { hasText: 'gpu-cloud' });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    const insp = page.locator('aside.inspector');
    await expect(insp).toContainText('gpu-h100x1-80gb');
    await insp.locator('[data-max]').fill('3');
    await insp.getByRole('button', { name: 'Save scaling' }).click();
    await confirmDialog(page, 'Apply');
    await toast(page, 'Scaling for gpu-cloud saved');
    await expect(row).toContainText('0 / 3 /');
    const zero = insp.getByRole('button', { name: 'Scale to zero now' });
    if (await zero.isEnabled()) {
      await zero.click();
      await confirmDialog(page, 'Scale to zero');
      await toast(page, 'scaled to zero');
    }
    await insp.getByRole('button', { name: 'Warm up' }).click();
    await confirmDialog(page, 'Warm up');
    await toast(page, 'A node is starting');
    await expect(main.locator('tr', { hasText: 'gpu-cloud' })).toContainText('0 / 3 / 1');
    await main.getByRole('button', { name: 'Add GPU node group' }).click();
    await expect(page.locator('#overlay .modal', { hasText: 'Add a GPU node group' })).toBeVisible();
    await accessible(page, 'Cloud compute › Add node group');
    await reflow(page, 'Cloud compute › Add node group');
    await page.locator('#overlay .modal [data-close]').first().click();
    await insp.getByRole('button', { name: 'Open in Pools' }).click();
    await ready(page, 'pools');
  });

  test('cloud accounts: the credential state, the issuer and the setup helper', async ({ page }) => {
    test.setTimeout(180_000);
    await fresh(page, 'cloud');
    const main = page.locator('#main');
    await main.locator('tr', { hasText: 'do-lab' }).click();
    const insp = page.locator('aside.inspector');
    await expect(insp).toContainText('Credential state', { timeout: 20_000 });
    await expect(insp).toContainText('a person, after a notice');
    await expect(main).toContainText('Federation issuer');
    await insp.getByRole('button', { name: 'Rotate credentials' }).click();
    const modal = page.locator('#overlay .modal', { hasText: 'Replace the secret of do-lab' });
    await expect(modal).toBeVisible();
    await accessible(page, 'Cloud accounts › Replace secret');
    await reflow(page, 'Cloud accounts › Replace secret');
    await modal.getByRole('button', { name: 'Cancel' }).click();
    await main.getByRole('button', { name: 'Check now' }).click();
    await stepUpIfAsked(page);
    await toast(page, 'Issuer checked');
    await insp.getByRole('button', { name: 'Discover data services' }).click();
    await ready(page, 'cloud-data');
    await expect(page.locator('#overlay .modal', { hasText: 'Connect an existing cloud database' })).toContainText('finance-archive-pg', { timeout: 20_000 });
  });
});
