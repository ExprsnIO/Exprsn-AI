import { test, expect, open, expectLive, toast, settle, apiAs, type Page } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';

/*
 * 1.8.0, Sprint 48: B-147 the plugin creator (a manifest written step by step, checked on the server, previewed with
 * the console's renderer and installed as a draft with nothing granted); B-148 Overview cards each admin arranges
 * (Move up and Move down, hide, density, reset); B-149 knowledge feedback on a reference and the page tree. Axe-clean
 * and reflowing at 320 and 640 px.
 */

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const modal = (page: Page) => page.locator('#overlay .modal');

/** Toasts fade out; axe reads a fading one as low contrast, so checks wait until they are gone. */
async function quiet(page: Page): Promise<void> {
  // A toast under the pointer stays; move the pointer off it.
  await page.mouse.move(1, 1);
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

test.describe('Sprint 48: plugin creator, Overview cards, knowledge feedback', () => {
  test('writes a plugin step by step, previews its surface and installs it as a draft with nothing granted', async ({ page }) => {
    const key = `notes-${uid()}`;
    await open(page, 'plugins?tab=install');
    await expectLive(page);
    await page.locator('#main [data-gocreator]').click();
    await expect(page.locator('#main h1')).toHaveText('Plugin creator');
    await settle(page);

    // 1. Basics: the key follows the name until edited.
    await page.locator('#main [data-w="basics.name"]').fill('Release notes');
    await page.locator('#main [data-w="basics.key"]').fill(key);
    await page.locator('#main [data-w="basics.description"]').fill('Shows release notes on the Overview.');
    await quiet(page);
    await expectAxeClean(page, 'aa', 'plugin creator, basics');
    await page.locator('#main [data-next]').click();

    // 2. Capabilities, with their help, required or optional.
    await expect(page.locator('#main')).toContainText('closed list');
    await page.locator('#main [data-cap="emit:log"]').check();
    await expect(page.locator('#main [data-capopt="emit:log"]')).toBeVisible();
    await page.locator('#main [data-capopt="emit:log"]').selectOption('optional');
    await quiet(page);
    await expectAxeClean(page, 'aa', 'plugin creator, capabilities');
    await page.locator('#main [data-next]').click();

    // 3. A dashboard surface with a text block; the preview is drawn by the console's renderer.
    await page.locator('#main [data-newslot]').selectOption('dashboard');
    await page.locator('#main [data-surfadd]').click();
    await page.locator('#main [data-w="surfaces.0.title"]').fill('Release notes');
    await page.locator('#main [data-w="surfaces.0.blocks.0.text"]').fill('The notes of the last release.');
    const preview = page.locator('#main [data-pcpreview] .psurf');
    await expect(preview).toContainText('Release notes · Release notes');
    await expect(preview).toContainText('The notes of the last release.');
    await quiet(page);
    await expectAxeClean(page, 'aa', 'plugin creator, surfaces');
    await reflow(page, 'plugin creator, surfaces');

    // An unsound surface: a kv block reading data it does not name is flagged on the server under step 3.
    await page.locator('#main [data-newblock]').selectOption('kv');
    await page.locator('#main [data-blkadd]').click();
    await expect(page.locator('#main .pc-step[data-step="3"]')).toContainText('to fix');
    await page.locator('#main [data-blkrm="1"]').click();
    await expect(page.locator('#main .pc-step[data-step="3"]')).not.toContainText('to fix');

    // 4. No handler: the plugin only adds a surface. 5. Review.
    await page.locator('#main [data-next]').click();
    await page.locator('#main [data-next]').click();
    await expect(page.locator('#main')).toContainText('Valid.');
    await quiet(page);
    await expectAxeClean(page, 'aa', 'plugin creator, review');
    await reflow(page, 'plugin creator, review');
    await page.locator('#main [data-save]').click();
    await toast(page, 'Draft saved');
    await expect(page.locator('#main [data-dl="bundle"]')).toBeEnabled();

    await page.locator('#main [data-install]').click();
    await expect(modal(page)).toContainText('no capability granted');
    await modal(page).locator('[data-go]').click();
    await toast(page, /installed, nothing granted/);
    await expect(page.locator('#main h1')).toContainText('Plugins and events');
    const root = await apiAs('root');
    const plugin = ((await root.get('/api/admin/plugins')).plugins as { key: string; state: string; granted: string[] }[]).find((p) => p.key === key)!;
    expect(plugin).toMatchObject({ state: 'installed', granted: [] });
    await root.del(`/api/admin/plugins/${key}`);
    await root.close();
  });

  test('arranges the Overview cards with Move up and Move down, hides one, goes compact and resets', async ({ page }) => {
    await open(page, 'overview');
    await expectLive(page);
    const cards = page.locator('#main [data-card]');
    await expect(cards.first()).toHaveAttribute('data-card', 'alerts');
    await page.locator('#main [data-cards]').click();
    const m = modal(page);
    await expect(m).toContainText('Customise your Overview');
    // Keyboard reorder: Move down on the first card, then focus follows it.
    await m.locator('[data-ovcdown="0"]').focus();
    await page.keyboard.press('Enter');
    await expect(m.locator('[data-ovcrow="1"]')).toContainText('Alerts');
    await expect(m.locator('[data-ovcdown="1"]')).toBeFocused();
    await m.locator('[data-ovcrow]').filter({ hasText: 'Scheduled work' }).locator('[data-ovcshow]').uncheck();
    await m.locator('[data-ovcdensity]').selectOption('compact');
    await quiet(page);
    await expectAxeClean(page, 'aa', 'Customise your Overview');
    await reflow(page, 'Customise your Overview');
    await m.locator('[data-ovcsave]').click();
    await toast(page, 'Your Overview layout is saved');
    await expect(cards.first()).toHaveAttribute('data-card', 'counters');
    await expect(page.locator('#main [data-card="schedules"]')).toHaveCount(0);
    await expect(page.locator('#main .page.ovc-compact')).toHaveCount(1);
    await quiet(page);
    await expectAxeClean(page, 'aa', 'Overview, compact');
    await reflow(page, 'Overview, compact');

    await page.locator('#main [data-cards]').click();
    await modal(page).locator('[data-ovcreset]').click();
    await toast(page, 'back to the default layout');
    await expect(cards.first()).toHaveAttribute('data-card', 'alerts');
    await expect(page.locator('#main [data-card="schedules"]')).toHaveCount(1);
  });

  test('asks "Was this helpful?" on a reference, shows it to the editors and draws the page tree', async ({ page }) => {
    const root = await apiAs('root');
    const name = `Handbook ${uid()}`;
    const kb = await root.post('/api/knowledge/bases', { name, label: 'public', embedModel: 'nomic-embed-text' });
    await root.patch(`/api/knowledge/bases/${kb.id}`, { status: 'published' });
    await root.patch(`/api/knowledge/bases/${kb.id}/review`, { fourEyes: false });
    const publish = async (slug: string, title: string, content: string) => {
      const rev = await root.post(`/api/knowledge/bases/${kb.id}/revisions`, { reference: slug, title, content, summary: 'First', submit: true });
      await root.post(`/api/knowledge/revisions/${rev.id}/decision`, { decision: 'approve' });
    };
    await publish('guide', 'Guide', '# Guide\n\nStart with [[guide/setup]].');
    await publish('guide/setup', 'Setting up', '# Setting up\n\nInstall the agent.');
    await expect.poll(async () => ((await root.get(`/api/knowledge/bases/${kb.id}/references`)) as { state: string }[]).filter((r) => r.state === 'published').length, { timeout: 30_000 }).toBe(2);
    const refs = (await root.get(`/api/knowledge/bases/${kb.id}/references`)) as { id: string; slug: string }[];
    const guide = refs.find((r) => r.slug === 'guide')!.id;
    const setup = refs.find((r) => r.slug === 'guide/setup')!.id;

    await open(page, `knowledge?kb=${kb.id}`);
    await expectLive(page);
    await page.locator('#main [data-tab="references"]').first().click();
    await settle(page);
    // The page tree: move Setting up under Guide from the tree's own controls.
    await expect(page.locator('#main .kbtree')).toContainText('Setting up');
    await page.locator(`#main [data-treemove="${setup}"]`).click();
    await modal(page).locator('[data-mvparent]').selectOption(guide);
    await modal(page).locator('[data-go]').click();
    await toast(page, 'Moved under Guide');
    await expect(page.locator('#main .kbtree .kbtree [data-ref]')).toHaveText('Setting up');
    await quiet(page);
    await expectAxeClean(page, 'aa', 'Knowledge, page tree');
    await reflow(page, 'Knowledge, page tree');

    // The drawer: breadcrumbs, a backlink from Guide, and the feedback widget.
    await page.locator(`#main [data-ref="${setup}"]`).click();
    const drawer = page.locator('#overlay .drawer');
    await expect(drawer.locator('nav[aria-label="Breadcrumbs"]')).toContainText('Guide');
    await expect(drawer).toContainText('Linked from');
    await expect(drawer.locator('[data-kbgo]').filter({ hasText: 'Guide' }).first()).toBeVisible();
    const fb = drawer.locator('[data-kbfb]');
    await expect(fb).toContainText('Was this helpful?');
    await fb.getByRole('button', { name: 'No' }).click();
    await toast(page, 'Thank you for the feedback');
    await fb.locator('[data-fbtext]').fill('Which hosts does it mean?');
    await fb.locator('[data-fbsend]').click();
    await toast(page, 'Your comment was sent');
    await expect(fb).toContainText('Which hosts does it mean?');
    await quiet(page);
    await expectAxeClean(page, 'aa', 'reference drawer with feedback');
    await reflow(page, 'reference drawer with feedback');
    await page.keyboard.press('Escape');

    // The Feedback tab: the editors' counts and the curation list.
    await page.locator('#main [data-tab="feedback"]').first().click();
    await settle(page);
    await expect(page.locator('#main')).toContainText('Curation list');
    await expect(page.locator('#main [data-fbitem]').first()).toContainText('Setting up');
    await quiet(page);
    await expectAxeClean(page, 'aa', 'Knowledge, Feedback');
    await reflow(page, 'Knowledge, Feedback');
    await root.close();
  });
});
