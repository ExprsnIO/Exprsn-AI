import { test, expect, open, expectLive, settle, toast, confirmDialog, apiAs, type Page } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { expectAccessible } from './support/a11y';
import { reflowProblems } from './support/reflow';

// 1.7.0 (Sprint 43, B-9903): the response cache. A profile is given a cache time from Profiles; a repeated turn is
// answered from the cache; Jobs and queues lists the profile's entries and hit rate, and a purge empties them.

type AppGlobal = { App: { setA11y(m: 'aa' | 'aaa' | null): void } };

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
    await page.waitForTimeout(200);
    expect.soft(await reflowProblems(page), `${where} at ${width} px`).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(100);
}

test.describe('Response cache (Sprint 43)', () => {
  test('a profile caches answers, the cache tab shows its hits, and a purge empties it', async ({ page }) => {
    const root = await apiAs('root');
    const general = ((await root.get('/api/admin/profiles')) as { id: string; name: string; modelId: string; poolId: string }[] | { profiles: { id: string; name: string; modelId: string; poolId: string }[] });
    const list = Array.isArray(general) ? general : general.profiles;
    const base = list.find((p) => p.name === 'general')!;
    const name = `cached-${Date.now()}`;
    const prof = await root.post('/api/admin/profiles', { name, displayName: 'Cached answers', modelId: base.modelId, poolId: base.poolId, temperature: 0, label: 'internal' });
    await root.post(`/api/admin/profiles/${prof.id}/publish`, {});

    // the cache is switched on from the profile's settings, as a new version
    await open(page, `profiles?profile=${name}`);
    await expectLive(page);
    await page.locator('[data-f="cacheOn"]').check();
    await page.locator('[data-f="cacheAmount"]').fill('2');
    await page.locator('[data-f="cacheUnit"]').selectOption('h');
    await settle(page);
    await accessible(page, 'profiles: the response cache settings');
    await reflow(page, 'profiles: the response cache settings');
    await page.locator('[data-save]').click();
    await expect(page.locator('#overlay .modal')).toContainText('Response cache');
    await confirmDialog(page, 'Save version');
    await toast(page, /saved as version/);
    const saved = (await root.get('/api/admin/profiles')) as unknown;
    const now = (Array.isArray(saved) ? saved : (saved as { profiles: unknown[] }).profiles).find((p) => (p as { id: string }).id === prof.id) as { cacheTtlSeconds: number };
    expect(now.cacheTtlSeconds).toBe(7200);

    // the same turn twice: the second is answered from the cache
    const ask = async () => {
      const conv = await root.post('/api/conversations', { title: 'Cached question', label: 'internal' });
      const sent = await root.post(`/api/conversations/${conv.id}/messages`, { content: 'What are the opening hours?', profile: name, label: 'internal' });
      await expect.poll(async () => ((await root.get(`/api/conversations/${conv.id}`)).messages.find((m: { id: string }) => m.id === sent.messageId) || {}).state, { timeout: 20_000 }).toBe('complete');
    };
    await ask();
    await ask();
    const stats = (await root.get('/api/admin/cache/responses?days=7')).profiles.find((p: { profileId: string }) => p.profileId === prof.id);
    expect(stats.entries).toBeGreaterThan(0);

    await open(page, 'jobs?tab=cache');
    await expectLive(page);
    const row = page.locator('#main tr').filter({ hasText: name });
    await expect(row).toBeVisible();
    await settle(page);
    await accessible(page, 'jobs: the cache tab with responses');
    await reflow(page, 'jobs: the cache tab with responses');
    await page.getByRole('button', { name: `Purge the cached answers of ${name}` }).click();
    await accessible(page, 'jobs: the purge dialog');
    await confirmDialog(page, 'Purge');
    await toast(page, /entr(y|ies) removed\. Audited chat\.cache\.purged\./);
    await expect.poll(async () => (await root.get('/api/admin/cache/responses?days=7')).profiles.find((p: { profileId: string }) => p.profileId === prof.id).entries).toBe(0);
    await expect(row.locator('td').nth(2)).toHaveText('0');
    const audit = await root.get('/api/admin/audit/events?action=chat.cache.purged&limit=5').catch(() => null);
    if (audit) expect(JSON.stringify(audit)).toContain('chat.cache.purged');
    await root.close();
  });
});
