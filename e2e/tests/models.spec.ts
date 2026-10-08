import { test, expect, open, expectLive, confirmDialog, ready, apiAs, toast, type Page } from './support/fixtures';
import { expectAccessible } from './support/a11y';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';
import { serverState } from './support/state';

/** axe-core and the in-page checker on what is open, then the dialog's reflow at 320 px (WCAG 1.4.10). */
async function checkOverlay(page: Page, where: string): Promise<void> {
  await expectAccessible(page, where);
  await expectAxeClean(page, 'aa', where);
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 320, height: 800 });
  await page.waitForTimeout(150);
  const wide = await page.evaluate(() => {
    const ov = document.querySelector('#overlay');
    const box = ov?.querySelector(':scope > .modal, :scope > .drawer') as HTMLElement | null;
    if (!ov || !box) return ['nothing is open'];
    const out: string[] = [];
    if (document.scrollingElement!.scrollWidth > window.innerWidth + 1) out.push('the page scrolls sideways');
    if (box.scrollWidth > box.clientWidth + 1) out.push('the overlay scrolls sideways');
    for (const el of Array.from(box.querySelectorAll('*'))) {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width > 1 && r.right > Math.min(window.innerWidth, box.getBoundingClientRect().right) + 1 && !el.closest('.tablewrap,.codebox,pre')) out.push(`${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 30)}" sticks out`);
    }
    return [...new Set(out)].slice(0, 8);
  });
  expect.soft(wide, `reflow at 320 px on ${where}`).toEqual([]);
  await page.setViewportSize(size);
}

test.describe('Models', () => {
  test('requests an import, pulls and evaluates it, and a second admin approves it', async ({ page, as }) => {
    await open(page, 'models');
    await expectLive(page);
    await expect(page.locator('#main')).toContainText('5 of 5 models'); // 1.6.0: the e2e server also seeds llava:7b (knowledge images)

    await page.getByRole('button', { name: 'Request import' }).click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-f="name"]').fill('mistral:7b');
    await modal.locator('[data-f="label"]').selectOption('confidential');
    await modal.locator('[data-f="licence"]').fill('Apache 2.0');
    await modal.locator('[data-f="pool"]').selectOption({ index: 1 });
    await modal.locator('[data-f="notes"]').fill('A second general model for comparisons.');
    await modal.getByRole('button', { name: 'Send request' }).click();

    const row = page.locator('#main tr', { hasText: 'mistral:7b' });
    await expect(row).toBeVisible();
    await row.click();
    // The pull runs as a job on the fake Ollama; then the evaluation can start.
    await expect(page.locator('[data-evaluate]')).toBeEnabled({ timeout: 20_000 });
    await page.locator('[data-evaluate]').click();
    await confirmDialog(page, 'Run evaluation');
    await expect(row).toContainText('evaluated', { timeout: 20_000 });
    // Dual control: the requester cannot approve.
    await expect(page.locator('[data-approve]')).toBeDisabled();
    await expect(page.locator('#main')).toContainText('someone other than the requester must approve it');

    const second = await as('root2');
    await second.goto('/#/models');
    await ready(second, 'models');
    await second.locator('#main tr', { hasText: 'mistral:7b' }).click();
    await expect(second.locator('[data-approve]')).toBeEnabled();
    await second.locator('[data-approve]').click();
    await confirmDialog(second, 'Approve');
    await expect(second.locator('#main tr', { hasText: 'mistral:7b' })).toContainText('approved');
  });

  // B-4307: a Chat Completions server (Apple's fm serve on a Unix socket) registered from the Models screen, and its
  // on-device model registered from the import picker without a pull, evaluated and approved by a second admin.
  test('registers an fm serve socket and approves the model it holds', async ({ page, as }) => {
    const api = await apiAs('root');
    const pool = await api.post('/api/admin/pools', { name: 'apple-silicon', accelerator: 'metal', labelCeiling: 'confidential' });
    await api.close();
    await open(page, 'models');
    await expectLive(page);

    await page.getByRole('button', { name: 'Model servers' }).click();
    const drawer = page.locator('#overlay .drawer');
    await expect(drawer).toContainText('No model servers yet');
    await drawer.getByRole('button', { name: 'Register model server' }).click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-f="pool"]').selectOption(pool.id);
    await modal.locator('[data-f="iname"]').fill('mac-1-fm');
    await expect(modal.locator('[data-f="kind"]')).toHaveValue('openai');
    await expect(modal.locator('[data-f="transport"]')).toHaveValue('socket');
    await modal.locator('[data-f="socket"]').fill(serverState().fakes.fmSocket);
    await checkOverlay(page, 'models, register model server');
    await modal.getByRole('button', { name: 'Register', exact: true }).click();
    await toast(page, 'mac-1-fm registered and healthy');
    const servers = page.locator('#overlay .drawer');
    await expect(servers.locator('.md-srv', { hasText: 'mac-1-fm' })).toContainText('healthy');
    await expect(servers.locator('.md-srv', { hasText: 'mac-1-fm' })).toContainText('Unix socket on the server');
    await expect(servers.locator('.md-srv', { hasText: 'mac-1-fm' })).toContainText('pcc (unavailable)');
    await checkOverlay(page, 'models, model servers');
    await servers.getByRole('button', { name: 'Import a model' }).click();

    // The import picker lists what the server holds; Private Cloud Compute is listed and refused.
    const req = page.locator('#overlay .modal');
    await expect(req.locator('[data-src] [data-seg="server"]')).toHaveClass(/active/);
    await expect(req.locator('input[name="md-held"][value="0"]')).toBeChecked();
    await expect(req.locator('label', { hasText: 'pcc' }).locator('input')).toBeDisabled();
    await expect(req.locator('label', { hasText: 'pcc' })).toContainText('unavailable: PCC inference is not available');
    await req.locator('[data-f="hlabel"]').selectOption('confidential');
    await req.locator('[data-f="hlicence"]').fill('Apple Foundation Models terms');
    await checkOverlay(page, 'models, import picker held by a server');
    await req.getByRole('button', { name: 'Register model' }).click();
    await toast(page, 'registered from its server');

    const row = page.locator('#main tr', { hasText: /^\s*system/ });
    await expect(row).toBeVisible();
    await row.click();
    const inspector = page.locator('#main .inspector');
    await expect(inspector).toContainText('held by the server, no digest');
    await expect(inspector).toContainText('mac-1-fm');
    await expect(inspector).toContainText('Reported by the server');
    await expect(page.locator('[data-pull]')).toHaveCount(0);
    await page.locator('[data-evaluate]').click();
    await confirmDialog(page, 'Run evaluation');
    await expect(row).toContainText('evaluated', { timeout: 20_000 });
    await expect(inspector).toContainText('tools work');
    await expect(page.locator('[data-approve]')).toBeDisabled(); // dual control: root requested it

    const second = await as('root2');
    await second.goto('/#/models');
    await ready(second, 'models');
    await second.locator('#main tr', { hasText: /^\s*system/ }).click();
    await expect(second.locator('[data-approve]')).toBeEnabled();
    await second.locator('[data-approve]').click();
    const confirm = second.locator('#overlay .modal');
    await expect(confirm).toContainText('held by the server, no digest');
    await confirmDialog(second, 'Approve');
    await expect(second.locator('#main tr', { hasText: /^\s*system/ })).toContainText('approved');
    await second.locator('[data-card]').click();
    await expect(second.locator('#overlay .drawer')).toContainText('Registered from the server');
  });
});
