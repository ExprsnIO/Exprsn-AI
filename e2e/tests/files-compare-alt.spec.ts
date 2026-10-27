import { test, expect, open, expectLive, toast, apiAs, type Page } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';
import { serverState } from './support/state';

/*
 * 1.8.0, Sprint 47: B-142 a file's two versions compared (one column and side by side), an image's alt text written
 * from a model's suggestion and found by search; B-141 the entity designer's formula editor listing the new functions,
 * inserting one at the cursor and showing the server's check. Axe-clean and reflowing at 320 and 640 px.
 */

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const modal = (page: Page) => page.locator('#overlay .modal');

/** A tiny PNG (1x1, grey) with a tEXt chunk: the e2e vision fake would read a caption from it if it reached it. */
const PNG = Buffer.concat([
  Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010800000000376ef924', 'hex'),
  (() => {
    const data = Buffer.from('caption\0A secret caption', 'latin1');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from('tEXt', 'latin1'), data]);
    let c = 0xffffffff;
    for (const b of body) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, body, crc]);
  })(),
  Buffer.from('0000000a49444154789c636000000002000154a24f5d0000000049454e44ae426082', 'hex')
]);

async function quiet(page: Page): Promise<void> {
  await expect(page.locator('.toast')).toHaveCount(0, { timeout: 15_000 });
}

async function reflow(page: Page, where: string): Promise<void> {
  for (const width of [320, 640]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(250);
    expect(await reflowProblems(page), `${where} at ${width} px`).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

/** Uploads through the Upload dialog and waits until the scan has passed. */
async function upload(page: Page, name: string, data: Buffer, mimeType: string): Promise<void> {
  await page.locator('#main [data-upload]').first().click();
  const m = modal(page);
  await m.locator('[data-up-file]').setInputFiles({ name, mimeType, buffer: data });
  await expect(m.locator('[data-up-name]')).toHaveValue(name);
  await m.locator('[data-up-ok]').click();
  await toast(page, new RegExp(`202: ${name.replace(/\./g, '\\.')} version 1 quarantined`));
  await expect(page.locator('#main aside.inspector [data-share]')).toBeEnabled({ timeout: 20_000 });
}

test.describe('Files: version compare and alt text', () => {
  test.use({ user: 'member' });

  test('compares two versions of a file in one column and side by side', async ({ page }) => {
    const name = `terms-${uid()}.md`;
    await open(page, 'files');
    await expectLive(page);
    await upload(page, name, Buffer.from('# Terms\n\nPayment within 30 days.\nDelivery in May.\n'), 'text/markdown');
    const inspector = page.locator('#main aside.inspector');
    await inspector.locator('[data-newversion]').click();
    const nv = modal(page);
    await nv.locator('[data-up-file]').setInputFiles({ name, mimeType: 'text/markdown', buffer: Buffer.from('# Terms\n\nPayment within 14 days.\nDelivery in May.\nPrices in EUR.\n') });
    await nv.locator('[data-up-ok]').click();
    await toast(page, 'version 2 quarantined');
    await expect(inspector.locator('[data-compare]')).toBeVisible({ timeout: 20_000 });

    await inspector.locator('[data-compare]').click();
    const m = modal(page);
    await expect(m).toContainText('Compare versions of ' + name);
    const out = m.locator('[data-cmp-out]');
    await expect(out).toContainText('2 lines added, 1 removed');
    await expect(out.locator('.files-dl.del')).toContainText('- Payment within 30 days.');
    await expect(out.locator('.files-dl.add').first()).toContainText('+ Payment within 14 days.');
    await expect(out).toContainText('+ Prices in EUR.');
    await m.locator('[data-cmp-mode]').selectOption('split');
    await expect(out.locator('.files-split')).toContainText('Version 1');
    await expect(out.locator('.files-split .del')).toContainText('Payment within 30 days.');
    await expect(out.locator('.files-split .add').first()).toContainText('Payment within 14 days.');
    // the same version twice is not compared
    await m.locator('[data-cmp-from]').selectOption('2');
    await m.locator('[data-cmp-go]').click();
    await expect(out).toContainText('Choose two different versions.');
    await m.locator('[data-cmp-from]').selectOption('1');
    await m.locator('[data-cmp-go]').click();
    await expect(out.locator('.files-split')).toBeVisible();
    await quiet(page);
    await expectAxeClean(page, 'aa', 'Files, version compare');
    await reflow(page, 'files: version compare');
    await m.getByRole('button', { name: 'Close' }).click();
  });
});

// As root: the e2e vision profile is labelled confidential, above the member's clearance, so only root is offered it.
test.describe('Files: alt text', () => {
  test('writes alt text from a suggestion, shows it as the image alt, and search finds it', async ({ page }) => {
    const name = `bike-${uid()}.png`;
    const words = `bicycle${uid()}`;
    await open(page, 'files');
    await upload(page, name, PNG, 'image/png');
    const inspector = page.locator('#main aside.inspector');
    await expect(inspector).toContainText('Alt text and description');
    await expect(inspector.locator('[data-alt-text]')).toContainText('No alt text yet');
    await expect(inspector).toContainText('without its EXIF, GPS and other metadata');
    await expect(inspector.locator('[data-dlorig]')).toBeVisible();

    await inspector.locator('[data-editalt]').click();
    const m = modal(page);
    await expect(m.locator('[data-alt-suggest]')).toBeEnabled({ timeout: 15_000 });
    await m.locator('[data-alt-profile]').selectOption('vision');
    await m.locator('[data-alt-suggest]').click();
    // The model saw the picture without its text chunk, so it could not read the caption hidden in it.
    await expect(m.locator('[data-alt-sugg]')).toContainText('Suggestion');
    await expect(m.locator('[data-alt-sugtext]')).not.toContainText('secret');
    await m.locator('[data-alt-use]').click();
    await expect(m.locator('[data-alt-in]')).not.toHaveValue('');
    await m.locator('[data-alt-in]').fill(`A red ${words} against a white wall`);
    await m.locator('[data-desc-in]').fill('For the spring catalogue.');
    await quiet(page);
    await expectAxeClean(page, 'aa', 'Files, alt text');
    await reflow(page, 'files: alt text');
    await m.locator('[data-alt-ok]').click();
    await toast(page, 'Alt text saved. Audited file.alt.updated and file.description.updated.');
    await expect(inspector.locator('[data-alt-text]')).toContainText(`A red ${words} against a white wall`);
    await expect(inspector).toContainText('For the spring catalogue.');
    const pv = inspector.locator('.files-preview img');
    if (await pv.count()) await expect(pv).toHaveAttribute('alt', `A red ${words} against a white wall`);

    await page.locator('#main [data-search]').fill(words);
    await expect(page.locator('#main tr[data-file], #main .files-card[data-file]')).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator('#main tr[data-file], #main .files-card[data-file]').first()).toContainText(name);
  });
});

test.describe('Apps: the formula editor lists the formula functions', () => {
  test('lists, filters and inserts functions, and shows the server check', async ({ page }) => {
    const id = uid();
    const appName = `fx_${id}`;
    const root = await apiAs('root');
    await root.post('/api/apps', { name: appName, title: `Formulas ${id}`, label: 'internal', workspaceId: serverState().workspace.id });
    await root.post(`/api/apps/${appName}/entities`, { name: 'task', title: 'Task', definition: { fields: [{ name: 'title', type: 'string', maxLength: 200 }, { name: 'due', type: 'date' }] } });
    try {
      await open(page, 'apps');
      await page.locator('#main .leftpane [data-app]', { hasText: `Formulas ${id}` }).click();
      await page.locator('#main [data-addfield]').click();
      const m = modal(page);
      await m.locator('[data-ff="name"]').fill('due_label');
      await m.locator('[data-ff="type"]').selectOption('formula');
      const list = m.locator('[data-fcat-list]');
      await expect(list.locator('[data-fcat-item="networkdays"]')).toContainText('NetWorkDays(start, end, [holidays])');
      await expect(list.locator('[data-fcat-item="proper"]')).toBeVisible();
      await m.locator('[data-fcat-q]').fill('working days');
      await expect(list.locator('[data-fcat-item="workday"]')).toBeVisible();
      await expect(list.locator('[data-fcat-item="proper"]')).toHaveCount(0);
      await m.locator('[data-fcat-q]').fill('dateadd');
      await list.getByRole('button', { name: 'Insert DateAdd' }).click();
      const ex = m.locator('[data-ff="expression"]');
      await expect(ex).toHaveValue('DateAdd(');
      await ex.fill("text(DateAdd(due, 1, 'months'), 'D MMMM YYYY') & ' ' & Proper(title)");
      await expect(m.locator('[data-fcheck]')).toContainText('Looks right');
      await expect(m.locator('[data-fcheck-server]')).toContainText('The server reads it: it uses due, title');
      await ex.fill("DateAdd(due, 1, 'fortnights')");
      await expect(m.locator('[data-fcheck-server]')).toContainText("DateAdd's third argument is one of seconds");
      await ex.fill("Proper(title) & ' ' & text(DateAdd(due, 1, 'months'), 'YYYY-MM-DD')");
      await expect(m.locator('[data-fcheck-server]')).toContainText('The server reads it');
      await quiet(page);
      await expectAxeClean(page, 'aa', 'Apps, the formula editor');
      await reflow(page, 'apps: the formula editor');
      await m.locator('[data-ff-ok]').click();
      await toast(page, 'Field due_label added.');
      await expect(page.locator('#main tr[data-field="due_label"]')).toContainText('formula');
    } finally {
      await root.del(`/api/apps/${appName}`).catch(() => undefined);
      await root.close();
    }
  });
});
