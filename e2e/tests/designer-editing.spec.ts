import { test, expect, open, expectLive, toast, confirmDialog, apiAs, type Page } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';
import { serverState } from './support/state';

/*
 * 1.8.0, Sprint 47: designer editing on the Workflows canvas (B-137: undo and redo, copy and paste also into another
 * workflow, duplicate, step comments, zoom and the minimap by keyboard, tags and favourites) and presence with the
 * soft edit lock in the designers (B-140: two browsers see each other, the first to change holds the lock, the other
 * is read-only and takes over; the holder is told and keeps unsaved changes on the device).
 */
const uniq = () => Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
const node = (page: Page, id: string) => page.locator(`.wf-node[data-node="${id}"]`);
const bar = (page: Page, slot = 'workflow') => page.locator(`#main [data-dp="${slot}"]`);
const zoomLabel = (page: Page) => page.locator('#main .wf-viewbar [aria-live="polite"]');

test.describe('Designer editing and presence (B-137, B-140)', () => {
  test('undo and redo, comments, copy and paste into another workflow, duplicate, zoom and the minimap by keyboard', async ({ page }) => {
    const id = uniq();
    const root = await apiAs('root');
    const a = await root.post('/api/workflows', { name: `copy-from-${id}`, label: 'internal' });
    const b = await root.post('/api/workflows', { name: `paste-into-${id}`, label: 'internal' });
    // Opened from the list (a deep link's ?id= would keep choosing it on every render).
    await open(page, 'workflows');
    await expectLive(page);
    await page.locator('[data-wf]').selectOption(a.id);
    await expect(page.locator('.wf-toolbar [data-wf]')).toHaveValue(a.id);
    await expect(bar(page)).toContainText('Only you have this open');

    // Undo and redo, by keyboard and by the buttons.
    await page.locator('.wf-palette [data-add="transform"]').click();
    await expect(node(page, 'transform1')).toHaveCount(1);
    await expect(bar(page)).toContainText('You are editing');
    await page.locator('.wf-canvas').focus();
    await page.keyboard.press('Control+z');
    await expect(node(page, 'transform1')).toHaveCount(0);
    await page.keyboard.press('Control+Shift+z');
    await expect(node(page, 'transform1')).toHaveCount(1);
    await page.locator('#main [data-wfundo]').click();
    await expect(node(page, 'transform1')).toHaveCount(0);
    await page.locator('#main [data-wfredo]').click();
    await expect(node(page, 'transform1')).toHaveCount(1);

    // A comment on the step, stamped by the server when the draft is saved.
    await node(page, 'transform1').click();
    await page.locator('.inspector [data-wfcomment]').fill('Keep these field names: the report reads them.');
    await page.locator('.inspector [data-wfcadd]').click();
    await toast(page, 'Comment added');
    await page.locator('.wf-toolbar [data-save]').click();
    await toast(page, /Draft saved as revision/);
    await expect(page.locator('.inspector .wf-comment')).toContainText('Mara Okafor');
    await expect(node(page, 'transform1').locator('.wf-cbadge')).toContainText('1');
    // Saving released the lock.
    await expect(bar(page)).toContainText('Only you have this open');

    // Zoom by keyboard on the canvas, and the minimap.
    await node(page, 'transform1').focus();
    await page.keyboard.press('-');
    await expect(zoomLabel(page)).toHaveText('90%');
    await page.keyboard.press('+');
    await expect(zoomLabel(page)).toHaveText('100%');
    await page.keyboard.press('+');
    await expect(zoomLabel(page)).toHaveText('110%');
    await page.keyboard.press('0');
    await expect(zoomLabel(page)).not.toHaveText('110%');
    const mm = page.locator('#main [data-wfminimap]');
    await expect(mm).toHaveAttribute('aria-label', /Minimap of 2 steps/);
    await mm.focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(mm).toBeFocused();
    await page.locator('#main [data-wfzoom1]').click();
    await expectAxeClean(page, 'aa', 'Workflows, designer editing');

    // Copy, then paste into the other workflow: new ids, references checked there.
    await node(page, 'transform1').click();
    await page.keyboard.press('Control+c');
    await toast(page, /Copied 1 step/);
    await page.locator('[data-wf]').selectOption(b.id);
    await expect(page.locator('.wf-toolbar [data-wf]')).toHaveValue(b.id);
    await expect(node(page, 'trigger')).toHaveCount(1);
    await page.locator('.wf-canvas').focus();
    await page.keyboard.press('Control+v');
    await toast(page, /Pasted 1 step with new ids/);
    await expect(node(page, 'transform1')).toHaveCount(1);
    await expect(page.locator('.inspector')).toContainText(`Pasted from copy-from-${id}`);
    // Duplicate, with the button.
    await page.locator('#main [data-wfdup]').click();
    await expect(node(page, 'transform2')).toHaveCount(1);
    await page.locator('.wf-toolbar [data-save]').click();
    await toast(page, /Draft saved as revision/);
    const saved = await root.get(`/api/workflows/${b.id}`);
    expect(saved.draft.nodes.map((n: { id: string }) => n.id)).toEqual(['trigger', 'transform1', 'transform2']);

    // The shortcuts list.
    await page.locator('#main [data-wfkeys]').click();
    await expect(page.locator('#overlay .modal')).toContainText('Undo the last change to the graph');
    await expectAxeClean(page, 'aa', 'Workflows, keyboard shortcuts');
    await page.locator('#overlay [data-close]').first().click();
  });

  test('tags and favourites filter the list, and the toolbar reflows at 320 and 640 px', async ({ page }) => {
    const id = uniq();
    const root = await apiAs('root');
    const a = await root.post('/api/workflows', { name: `tagged-${id}`, label: 'internal' });
    const b = await root.post('/api/workflows', { name: `plain-${id}`, label: 'internal' });
    await open(page, 'workflows');
    await expectLive(page);
    await page.locator('[data-wf]').selectOption(a.id);
    await expect(page.locator('.wf-toolbar [data-wf]')).toHaveValue(a.id);
    await page.locator('#main [data-wftags]').click();
    await page.locator('#overlay [data-tagsin]').fill(`fin-${id}, monthly`);
    await page.locator('#overlay [data-go]').click();
    await toast(page, 'Tags saved');
    await expect(page.locator('#main .wf-tags')).toContainText(`fin-${id}`);
    await page.locator('#main [data-wffav]').click();
    await toast(page, 'is in your favourites');
    await expect(page.locator('#main [data-wffav]')).toHaveAttribute('aria-pressed', 'true');

    // Open the other one, then filter: only the tagged one (and the open one) stay in the list.
    await page.locator('[data-wf]').selectOption(b.id);
    await expect(page.locator('#main [data-wffav]')).toHaveAttribute('aria-pressed', 'false');
    await page.locator('#main [data-wftagfilter]').selectOption(`fin-${id}`);
    const names = async () => (await page.locator('.wf-toolbar [data-wf] option').allTextContents()).map((t) => t.trim().split(/\s+/)[0]!).filter((t) => t.includes(id)).sort();
    await expect.poll(names).toEqual([`plain-${id}`, `tagged-${id}`]);
    await page.locator('#main [data-wftagfilter]').selectOption('');
    await page.locator('#main [data-wffavonly]').click();
    await expect.poll(async () => (await page.locator('.wf-toolbar [data-wf] option').allTextContents()).some((t) => t.startsWith(`tagged-${id}`))).toBe(true);
    await page.locator('[data-wf]').selectOption(a.id);
    await expect.poll(names).toEqual([`tagged-${id}`]);
    expect((await root.get('/api/workflows?favourites=true')).map((w: { name: string }) => w.name)).toContain(`tagged-${id}`);
    await expectAxeClean(page, 'aa', 'Workflows, tags and favourites');

    for (const width of [320, 640]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(() => reflowProblems(page), { message: `Workflows at ${width} px` }).toEqual([]);
    }
  });

  test('two browsers: presence, the edit lock, read-only controls and a takeover', async ({ page, as, watch }) => {
    // The holder's own save after the takeover is refused on purpose (checked through the API).
    watch.allow.push(/PUT \/api\/workflows\/[0-9A-Z]+\/draft -> 409$/);
    const id = uniq();
    const root = await apiAs('root');
    const w = await root.post('/api/workflows', { name: `shared-${id}`, label: 'internal' });
    await open(page, `workflows?id=${w.id}`);
    const other = await as('root2');
    await open(other, `workflows?id=${w.id}`);
    await expect(bar(page)).toContainText('Jon Lee');
    await expect(bar(other)).toContainText('Mara Okafor');

    // Mara changes something first: she holds the lock; Jon's designer is read-only.
    await page.locator('.wf-palette [data-add="calc"]').click();
    await expect(bar(page)).toContainText('You are editing');
    await expect(bar(other)).toContainText('Being edited by Mara Okafor');
    await expect(other.locator('.wf-palette [data-add="calc"]')).toBeDisabled();
    await expect(other.locator('.wf-toolbar [data-save]')).toBeDisabled();
    await expectAxeClean(other, 'aa', 'Workflows, read-only while someone else edits');
    // Jon takes over; Mara is told, and her unsaved step is kept on her device.
    await other.locator('#main [data-dp-take]').click();
    await confirmDialog(other, 'Take over');
    await expect(bar(other)).toContainText('You are editing');
    await toast(page, /Jon Lee took over editing/);
    await expect(bar(page)).toContainText('Being edited by Jon Lee');
    await expect(bar(page)).toContainText('kept on this device');
    await expect(page.locator('.wf-toolbar [data-save]')).toBeDisabled();
    const blocked = await root.ctx.put(`/api/workflows/${w.id}/draft`, { data: {}, headers: { 'x-csrf-token': (await (await root.ctx.get('/api/auth/session')).json()).csrf, origin: serverState().url } });
    expect(blocked.status()).toBe(409);
    expect((await blocked.json()).lock.name).toBe('Jon Lee');

    // Jon saves: the lock goes, and Mara may edit again (and restore her kept step).
    await other.locator('.wf-palette [data-add="wait"]').click();
    await other.locator('.wf-toolbar [data-save]').click();
    await toast(other, /Draft saved as revision/);
    await expect(bar(page)).not.toContainText('Being edited');
    await expect(page.locator('.wf-palette [data-add="calc"]')).toBeEnabled();
    await page.locator('#main [data-dp-discard]').click();
    await expect(bar(page)).not.toContainText('kept on this device');
  });

  test('the form editor shows who else designs the form and locks it for the first to change it', async ({ page, as }) => {
    const id = uniq();
    const root = await apiAs('root');
    const appName = `lockdesk_${id}`;
    await root.post('/api/apps', { name: appName, title: `Lock desk ${id}`, label: 'internal', workspaceId: serverState().workspace.id });
    await root.post(`/api/apps/${appName}/entities`, { name: 'ticket', title: 'Ticket', definition: { fields: [{ name: 'email', type: 'string', required: true, maxLength: 200 }, { name: 'note', type: 'string', maxLength: 500 }] } });
    await root.post(`/api/apps/${appName}/forms`, { name: 'intake', title: 'Intake', entity: 'ticket', definition: { fields: [{ field: 'email', required: true }] } });
    const openForms = async (p: Page) => {
      await open(p, 'apps');
      await p.locator('#main .leftpane [data-app]', { hasText: `Lock desk ${id}` }).click();
      await p.locator('#main [data-tab="forms"]').click();
      await expect(bar(p, 'app-form')).toBeVisible();
    };
    await openForms(page);
    const other = await as('root2');
    await openForms(other);
    await expect(bar(page, 'app-form')).toContainText('Jon Lee');
    await page.locator('#main [data-ftitle]').fill('Intake form');
    await expect(bar(other, 'app-form')).toContainText('Being edited by Mara Okafor');
    await expect(other.locator('#main [data-fsave]')).toHaveCount(0);
    await page.locator('#main [data-fsave]').click();
    await toast(page, 'Form saved');
    await expect(bar(other, 'app-form')).not.toContainText('Being edited');
    await expect(other.locator('#main [data-fsave]')).toHaveCount(1);
  });
});
