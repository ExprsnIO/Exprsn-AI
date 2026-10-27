import { createHmac } from 'node:crypto';
import { test, expect, open, expectLive, toast, confirmDialog, type Page } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';
import { serverState } from './support/state';

/*
 * 1.8.0, Sprint 46: the webhook trigger of a workflow (B-130) from the trigger step's inspector (make the secret,
 * shown once; enable; a signed POST starts a run and shows in Recent deliveries; rotate), and the Retention tab
 * (B-135: a workflow override, the tenant policy, a dry-run count). Axe-clean and reflowing at 320 and 640 px.
 */

const cfg = (page: Page, key: string) => page.locator(`.inspector [data-c="${key}"]`);

async function reflow(page: Page, where: string): Promise<void> {
  for (const width of [320, 640]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(250);
    expect(await reflowProblems(page), `${where} at ${width} px`).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test.describe('Workflows: webhook trigger and retention', () => {
  test('B-130: makes a secret, enables the hook, a signed POST starts a run; rotation shows a new secret once', async ({ page, request, watch }) => {
    // The old secret is refused on purpose after the rotation.
    watch.allow.push(/POST \/hooks\/workflows\/.* -> 401$/);
    await open(page, 'workflows');
    await expectLive(page);
    const first = page.locator('[data-new]').first();
    if (await first.count()) await first.click();
    else await page.locator('[data-wf]').selectOption('__new');
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-name]').fill('hook-intake');
    await modal.locator('[data-desc]').fill('Files what a partner system posts');
    await modal.locator('[data-go]').click();
    await toast(page, 'hook-intake created as a draft with a manual trigger');

    await page.locator('.wf-node[data-node="trigger"]').click();
    await cfg(page, 'source').selectOption('webhook');
    await expect(page.locator('.wf-node[data-node="trigger"]')).toContainText('signed webhook');
    await page.locator('.wf-toolbar [data-publish]').click();
    await confirmDialog(page, 'Publish');
    await toast(page, 'hook-intake v1 published');

    const insp = page.locator('.inspector');
    await insp.locator('[data-wfhook-refresh]').click();
    await expect(insp).toContainText('Webhook');
    await expect(insp).toContainText('not made yet');
    await expect(insp.locator('[data-wfhook-toggle]')).toBeDisabled();

    await insp.locator('[data-wfhook-rotate]').click();
    const secretBox = page.locator('#overlay .modal [data-wfhook-secret]');
    await expect(secretBox).toBeVisible();
    const secret = (await secretBox.textContent())!.trim();
    expect(secret).toMatch(/^whsec_/);
    await expectAxeClean(page, 'aa', 'the webhook secret dialog');
    await page.locator('#overlay .modal [data-close]').first().click();

    await insp.locator('[data-wfhook-toggle]').click();
    await confirmDialog(page, 'Enable');
    await toast(page, 'Webhook on. Runs start as you.');
    await expect(insp).toContainText('on, taking requests');

    // A signed POST from outside the console.
    const url = (await insp.locator('[data-wfhook-url]').textContent())!.trim();
    const path = new URL(url).pathname;
    const send = (key: string, title: string) => {
      const body = JSON.stringify({ title });
      const ts = Math.floor(Date.now() / 1000);
      const sig = `sha256=${createHmac('sha256', key).update(`${ts}.`).update(body).digest('hex')}`;
      return request.post(`${serverState().url}${path}`, { headers: { 'content-type': 'application/json', 'x-exprsn-timestamp': String(ts), 'x-exprsn-signature': sig }, data: body });
    };
    const res = await send(secret, 'Partner order 7');
    expect(res.status()).toBe(202);
    await insp.locator('[data-wfhook-refresh]').click();
    await expect(insp).toContainText('1 accepted');
    await expect(insp.locator('table')).toContainText('accepted');
    await insp.locator('summary').click();
    await expect(insp).toContainText('X-Exprsn-Signature');
    await expectAxeClean(page, 'aa', 'the webhook panel of the trigger step');
    await reflow(page, 'the webhook panel');

    // Rotation: the old secret stops at once.
    await insp.locator('[data-wfhook-rotate]').click();
    await confirmDialog(page, 'Rotate secret');
    const second = (await page.locator('#overlay .modal [data-wfhook-secret]').textContent())!.trim();
    expect(second).not.toBe(secret);
    await page.locator('#overlay .modal [data-close]').first().click();
    expect((await send(secret, 'Old secret')).status()).toBe(401);
    expect((await send(second, 'New secret')).status()).toBe(202);
  });

  test('B-135: the Retention tab saves an override and counts what a prune would remove', async ({ page }) => {
    await open(page, 'workflows');
    await expectLive(page);
    await page.locator('[data-wf]').selectOption({ label: 'hook-intake v1 published' });
    await page.locator('.wf-lower [data-tab="retention"]').click();
    const lower = page.locator('.wf-lower');
    await expect(lower).toContainText('This workflow');
    await expect(lower).toContainText('Tenant policy');
    await lower.locator('[data-wfret-wf="runDays"]').fill('30');
    await lower.locator('[data-wfret-savewf]').click();
    await toast(page, 'Retention override saved for hook-intake.');
    await expect(lower.locator('[data-wfret-wf="runDays"]')).toHaveValue('30');
    await lower.locator('[data-wfret-dry="wf"]').click();
    await toast(page, /A prune would remove 0 runs/);
    await expectAxeClean(page, 'aa', 'the Retention tab');
    await reflow(page, 'the Retention tab');
  });
});
