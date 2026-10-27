import { test, expect, open, expectLive, toast, confirmDialog } from './support/fixtures';
import type { Page } from '@playwright/test';

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/** Uploads a file through the Upload dialog of the folder on screen and waits until its scan has passed. */
async function upload(page: Page, name: string, text: string): Promise<void> {
  await page.locator('#main [data-upload]').first().click();
  const modal = page.locator('#overlay .modal');
  await modal.locator('[data-up-file]').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
  await expect(modal.locator('[data-up-name]')).toHaveValue(name);
  await modal.locator('[data-up-ok]').click();
  await toast(page, new RegExp(`202: ${name.replace(/\./g, '\\.')} version 1 quarantined`));
  const inspector = page.locator('#main aside.inspector');
  await expect(inspector).toContainText(name);
  // The file.scan job decides; the screen follows file.state (and polls while a version is pending).
  await expect(inspector.locator('[data-share]')).toBeEnabled({ timeout: 20_000 });
}

test.describe('Files', () => {
  test.use({ user: 'member' });

  test('a member uploads a file, creates a link with a download limit, and the link downloads within its limit only', async ({ page, watch }) => {
    const folder = `Close ${uid()}`;
    const name = `travel-${uid()}.txt`;
    await open(page, 'files');
    await expectLive(page);

    // A folder of its own, then the upload into it.
    await page.locator('#main .page [data-newfolder]').click();
    const nf = page.locator('#overlay .modal');
    await nf.locator('[data-nf-name]').fill(folder);
    await nf.locator('[data-nf-ok]').click();
    await toast(page, `Folder ${folder} created`);
    await page.locator('#main .page').getByRole('button', { name: folder }).click();
    await expect(page.locator('#main .files-crumbs')).toContainText(folder);
    await upload(page, name, 'Lisbon taxi 18.40 EUR\n');
    await expect(page.locator(`#main tr[data-file]`).filter({ hasText: name })).toContainText('ready');

    // A link with a limit of two downloads; the token is shown once.
    await page.locator('#main aside.inspector [data-share]').click();
    const share = page.locator('#overlay .modal');
    await share.locator('[data-sh-kind]').selectOption('link');
    await share.locator('[data-sh-hours]').fill('24');
    await share.locator('[data-sh-uses]').fill('2');
    await share.locator('[data-sh-ok]').click();
    await toast(page, 'Share created (201)');
    const created = page.locator('#overlay .modal');
    await expect(created).toContainText('Link created');
    const token = (await created.locator('[data-link-token]').innerText()).trim();
    expect(token).toMatch(/^exf_/);
    await created.getByRole('button', { name: 'Done' }).click();
    const row = page.locator('#main aside.inspector tr[data-share-row]').first();
    await expect(row).toContainText('0 of 2');
    await expect(row).toContainText('active');

    // Open the link from Shared with me: it downloads twice, and the third download is refused with a 404.
    await page.locator('#main [data-view="shared"]').click();
    await page.locator('#main [data-openlink]').click();
    const dlg = page.locator('#overlay .modal');
    await dlg.locator('[data-ol-token]').fill(token);
    await dlg.locator('[data-ol-check]').click();
    await expect(dlg).toContainText(name);
    await expect(dlg).toContainText('2 uses left');
    for (const left of ['1 use left', '0 uses left']) {
      const [file] = await Promise.all([page.waitForEvent('download'), dlg.locator('[data-ol-dl]').click()]);
      expect(file.suggestedFilename()).toBe(name);
      await expect(dlg).toContainText(left);
    }
    watch.allow.push(/POST \/api\/file-links\/download -> 404/);
    await dlg.locator('[data-ol-dl]').click();
    await expect(dlg.locator('.problem')).toContainText('Not found');
    await expect(dlg.locator('.problem')).toContainText('used up, expired or revoked');
    await dlg.getByRole('button', { name: 'Close' }).click();

    // The owner sees the link used up.
    await page.locator('#main [data-folder]').filter({ hasText: folder }).first().click();
    await page.locator('#main tr[data-file]').filter({ hasText: name }).click();
    const used = page.locator('#main aside.inspector tr[data-share-row]').first();
    await expect(used).toContainText('2 of 2');
    await expect(used).toContainText('used up');
  });

  test('versions restore through quarantine, tags find a file, and the trash gives it back', async ({ page }) => {
    const name = `notes-${uid()}.md`;
    const tag = `t${uid()}`;
    await open(page, 'files');
    await expectLive(page);
    await upload(page, name, '# Vendor notes\n\nFirst version.\n');

    // A second version, then version 1 restored as version 3.
    const inspector = page.locator('#main aside.inspector');
    await inspector.locator('[data-newversion]').click();
    const nv = page.locator('#overlay .modal');
    await nv.locator('[data-up-file]').setInputFiles({ name, mimeType: 'text/markdown', buffer: Buffer.from('# Vendor notes\n\nSecond version, longer.\n') });
    await nv.locator('[data-up-ok]').click();
    await toast(page, 'version 2 quarantined');
    await expect(inspector).toContainText('Versions, 2');
    await expect(inspector.locator('[data-restorever="1"]')).toBeVisible({ timeout: 20_000 });
    await inspector.locator('[data-restorever="1"]').click();
    await confirmDialog(page, 'Restore');
    await toast(page, '202: version 3 queued from v1');
    await expect(inspector).toContainText('Versions, 3');
    await expect(inspector).toContainText('restored from v1');
    await expect(inspector.locator('[data-restorever="2"]')).toBeVisible({ timeout: 20_000 });

    // Tags, then a search by tag.
    await inspector.locator('[data-edittags]').click();
    const tg = page.locator('#overlay .modal');
    await tg.locator('[data-tg]').fill(tag + ', vendors');
    await tg.locator('[data-tg-ok]').click();
    await toast(page, 'Tags saved');
    await inspector.locator(`[data-tag="${tag}"]`).click();
    await expect(page.locator('#main .toolbar')).toContainText(`tag: ${tag}`);
    await expect(page.locator('#main tr[data-file]')).toHaveCount(1);
    await expect(page.locator('#main tr[data-file]')).toContainText(name);
    await page.locator('#main [data-cleartag]').click();

    // To the trash and back.
    await page.locator('#main tr[data-file]').filter({ hasText: name }).click();
    await inspector.locator('[data-trashfile]').click();
    await confirmDialog(page, 'Trash');
    await toast(page, `${name} moved to the trash`);
    await expect(page.locator('#main tr[data-file]').filter({ hasText: name })).toHaveCount(0);
    await page.locator('#main [data-view="trash"]').click();
    const trashed = page.locator('#main tr[data-trash-row]').filter({ hasText: name });
    await expect(trashed).toBeVisible();
    await trashed.locator('[data-restore]').click();
    await confirmDialog(page, 'Restore');
    await toast(page, `${name} restored`);
    await expect(page.locator('#main tr[data-trash-row]').filter({ hasText: name })).toHaveCount(0);
    await page.locator('#main [data-folder=""]').first().click();
    await expect(page.locator('#main tr[data-file]').filter({ hasText: name })).toBeVisible();
  });
});
