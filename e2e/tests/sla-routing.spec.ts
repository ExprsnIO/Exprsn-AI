import { test, expect, open, ready, expectLive, confirmDialog, toast, apiAs, settle } from './support/fixtures';
import { expectAccessible } from './support/a11y';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';
import { serverState } from './support/state';

// Sprint 46 (B-134): SLA timers and routing in the console. A flag policy made on Moderation's "SLA and routing" tab
// lists with its targets and statistics; a reported flag then shows its SLA badge on Flags and in the moderation queue,
// and the "Breaching soon" filter keeps it. Each view passes the accessibility checks and reflows at 320 and 640 px.
test.describe('SLA and routing', () => {
  test('a flag policy made on the screen times a reported flag, shown on Flags and Moderation', async ({ page }) => {
    test.setTimeout(150_000);
    const stamp = Date.now().toString(36);
    const name = `E2E SLA ${stamp}`;
    const root = await apiAs('root');

    await open(page, 'moderation?tab=sla');
    await expectLive(page);
    await expect(page.locator('[data-tab="sla"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#main')).toContainText('SLA policies');

    // The policy, made on the screen: a one-minute first response, warned at once, with business hours.
    await page.locator('[data-slanew]').click();
    const modal = page.locator('#overlay .modal');
    await expect(modal).toBeVisible();
    await modal.locator('[data-pname]').fill(name);
    await modal.locator('[data-pscope]').fill('*');
    await modal.locator('[data-pfr]').fill('1');
    await modal.locator('[data-pres]').fill('');
    await modal.locator('[data-pwarn]').fill('1');
    await modal.locator('[data-psave]').click();
    await toast(page, `Policy ${name} created.`);
    const row = page.locator('#main tr', { hasText: name });
    await expect(row).toBeVisible();
    await expect(row).toContainText('1 min');
    await expect(page.locator('#main')).toContainText('SLA statistics');
    await expect(page.locator('#main')).toContainText('Assignment routing');

    // Routing for the flag queue, saved on the screen.
    const rule = page.locator('[data-slart="flag"]');
    await rule.locator('[data-rmode]').selectOption('least-loaded');
    await rule.locator('[data-rsave="flag"]').click();
    await confirmDialog(page, 'Save');
    await toast(page, /Routing for Flags saved: least-loaded/);
    const rules = (await root.get('/api/sla/routing?type=flag')) as { items: { mode: string; scope: string }[] };
    expect(rules.items.find((r) => r.scope === '*')?.mode).toBe('least-loaded');
    // Back to manual, so other suites' flags stay where they are.
    await root.put('/api/sla/routing', { queueType: 'flag', mode: 'manual' });

    await expect(page.locator('#toasts .toast')).toHaveCount(0, { timeout: 20_000 });
    await page.reload();
    await ready(page, 'moderation');
    await settle(page);
    await expectAccessible(page, 'moderation, SLA and routing');
    await expectAxeClean(page, 'aa', 'moderation, SLA and routing');
    for (const width of [320, 640]) {
      await page.setViewportSize({ width, height: 800 });
      await settle(page);
      await page.waitForTimeout(400);
      expect(await reflowProblems(page), `moderation SLA and routing at ${width} px`).toEqual([]);
    }
    await page.setViewportSize({ width: 1440, height: 900 });

    // A report raises a flag the policy covers.
    const member = await apiAs('mladmin');
    const sent = await member.post('/api/chat', { content: `A message for the SLA ${stamp}`, profile: 'general' });
    const report = await member.post('/api/moderation/reports', { type: 'message', id: sent.userMessageId, reason: 'Spam', note: `e2e sla ${stamp}` });
    const ref = report.flag.ref as string;
    await page.waitForTimeout(1500);
    const items = (await root.get('/api/sla/items?type=flag&filter=breaching-soon')) as { items: { title: string; sla: { state: string } }[] };
    expect(items.items.find((i) => i.title === ref)?.sla.state).toMatch(/warning|breached/);

    // Flags: the badge on the flag, and the breaching-soon filter keeps it.
    await open(page, `flags?id=${ref}`);
    await expectLive(page);
    const item = page.locator(`[data-flag="${ref}"]`);
    await expect(item).toContainText(/SLA (due soon|breached)/);
    await page.locator('[data-slasoon]').click();
    await expect(page.locator('[data-slasoon]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(`[data-flag="${ref}"]`)).toBeVisible();
    await settle(page);
    await expectAccessible(page, 'flags, breaching soon');
    await expectAxeClean(page, 'aa', 'flags, breaching soon');
    for (const width of [320, 640]) {
      await page.setViewportSize({ width, height: 800 });
      await settle(page);
      await page.waitForTimeout(400);
      expect(await reflowProblems(page), `flags breaching soon at ${width} px`).toEqual([]);
    }
    await page.setViewportSize({ width: 1440, height: 900 });

    // Moderation's queue shows it too, with the same badge: in the queue its rules routed it to (other suites create
    // queues), or under Not routed when none matched.
    await open(page, 'moderation?tab=queues');
    await page.locator(`tr[data-queue="${(report.flag.queueId as string | null) ?? 'unrouted'}"]`).click();
    await expect(page.locator('tr[data-flag]', { hasText: ref })).toContainText(/SLA (due soon|breached)/);
    await page.locator('[data-flagsoon]').click();
    await expect(page.locator('tr[data-flag]', { hasText: ref })).toBeVisible();

    // The policy is deleted from the screen.
    await open(page, 'moderation?tab=sla');
    const pol = (await root.get('/api/sla/policies?type=flag')) as { items: { id: string; name: string }[] };
    const id = pol.items.find((p) => p.name === name)!.id;
    await page.locator(`[data-sladel="${id}"]`).click();
    await confirmDialog(page, 'Delete');
    await toast(page, `Policy ${name} deleted.`);
    await expect(page.locator('#main tr', { hasText: name })).toHaveCount(0);
  });
  test("a channel's SLA and routing tab sets a policy for its escalated sessions", async ({ page }) => {
    test.setTimeout(120_000);
    const stamp = Date.now().toString(36);
    const api = await apiAs('root');
    const ch = await api.post('/api/channels', { workspaceId: serverState().workspace.id, kind: 'chat', name: `SLA desk ${stamp}`, label: 'internal', target: { kind: 'profile', name: 'general' } });
    await open(page, `channels?channel=${ch.id}&tab=sla`);
    await expectLive(page);
    await expect(page.locator('#main')).toContainText('Assignment routing');
    await page.locator('[data-slanew]').click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-pname]').fill(`Desk ${stamp}`);
    await expect(modal.locator('[data-pscope]')).toHaveValue(ch.id);
    await modal.locator('[data-ptz]').fill('Europe/London');
    await modal.locator('[data-pday="mon"]').fill('09:00-17:00');
    await modal.locator('[data-phol]').fill('2026-12-25');
    await modal.locator('[data-psave]').click();
    await toast(page, `Policy Desk ${stamp} created.`);
    const row = page.locator('#main tr', { hasText: `Desk ${stamp}` });
    await expect(row).toContainText('Europe/London');
    await expect(row).toContainText(`SLA desk ${stamp}`);
    await expect(page.locator('#toasts .toast')).toHaveCount(0, { timeout: 20_000 });
    await settle(page);
    await expectAccessible(page, 'channels, SLA and routing');
    await expectAxeClean(page, 'aa', 'channels, SLA and routing');
    for (const width of [320, 640]) {
      await page.setViewportSize({ width, height: 800 });
      await settle(page);
      await page.waitForTimeout(400);
      expect(await reflowProblems(page), `channels SLA and routing at ${width} px`).toEqual([]);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    const pol = (await api.get('/api/sla/policies?type=channel-session')) as { items: { id: string; scope: string }[] };
    for (const p of pol.items.filter((x) => x.scope === ch.id)) await api.del(`/api/sla/policies/${p.id}`);
    await api.del(`/api/channels/${ch.id}`);
  });
});
