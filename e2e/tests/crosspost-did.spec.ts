import { test, expect, open, expectLive, settle, toast, apiAs, type Page } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { expectAccessible } from './support/a11y';
import { reflowProblems } from './support/reflow';
import { serverState } from './support/state';
import { totp, freshStep } from './support/totp';

// 1.7.0 (Sprint 43, B-11302, B-11403): the caller's own did:exprsn in Settings, and cross-posting public posts to the
// author's repo on this server's PDS from the Messages and feed screen. Both pass the WCAG checker and axe-core
// (Standard and Enhanced, light and dark) and reflow at 320 and 640 px.

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

/** Switches PDS hosting on for the tenant (a platform admin, after a step-up with the authenticator). */
async function hostingOn(): Promise<boolean> {
  const root = await apiAs('root');
  try {
    if ((await root.get('/api/admin/pds')).enabled) return true;
    for (let i = 0; i < 2; i++) {
      await freshStep(6000);
      try { await root.post('/api/me/step-up', { code: totp(serverState().totp.root!) }); break; } catch { await new Promise((r) => setTimeout(r, 31_000 - (Date.now() % 30_000))); }
    }
    const tenantId = (await root.get('/api/me')).tenant.id as string;
    await root.put(`/api/admin/pds/tenants/${tenantId}`, { enabled: true });
    return !!(await root.get('/api/admin/pds')).enabled;
  } catch {
    return false;
  } finally {
    await root.close();
  }
}

test.describe('did:exprsn and cross-posting (Sprint 43)', () => {
  test.use({ user: 'member' });

  test('Settings shows your did:exprsn and its DID document', async ({ page }) => {
    await open(page, 'settings?tab=accounts');
    await expectLive(page);
    const panel = page.locator('.panel', { hasText: 'Your did:exprsn' });
    await expect(panel).toContainText('did:exprsn:');
    await expect(panel).toContainText('the key stays in the signer');
    const show = panel.getByRole('button', { name: 'Show DID document' });
    await expect(show).toHaveAttribute('aria-expanded', 'false');
    await show.click();
    const again = page.locator('.panel', { hasText: 'Your did:exprsn' });
    await expect(again.getByRole('button', { name: 'Hide DID document' })).toHaveAttribute('aria-expanded', 'true');
    await expect(again.locator('.codebox')).toContainText('"id": "did:exprsn:');
    // Read again: the same DID, not a second one
    const member = await apiAs('member');
    const first = (await member.get('/api/me/atproto/exprsn-did')) as { did: string }[];
    expect((await member.get('/api/me/atproto/exprsn-did'))[0].did).toBe(first[0]!.did);
    await member.close();
    await settle(page);
    await accessible(page, 'settings: your did:exprsn with its document');
    await reflow(page, 'settings: your did:exprsn with its document');
  });

  test('the author cross-posts public posts and sees each post\'s status', async ({ page }) => {
    test.setTimeout(180_000);
    const member = await apiAs('member');
    const ws = serverState().workspace;
    let ready = (await member.get('/api/me/crosspost')).ready as boolean;
    if (!ready && (await hostingOn())) {
      const mine = await member.get('/api/me/pds');
      if (!mine.account) {
        await member.post('/api/me/step-up', { password: serverState().password });
        await member.post('/api/me/pds', { handle: `xp-${Date.now().toString(36).slice(-6)}` });
      }
      ready = (await member.get('/api/me/crosspost')).ready as boolean;
    }
    const seed = await member.post('/api/feed/posts', { workspaceId: ws.id, body: `Before the switch ${Date.now()}`, label: 'internal' });
    await open(page, `messages?post=${seed.id}`);
    await expect(page.locator(`article[data-post="${seed.id}"]`)).toBeVisible();
    await expectLive(page);
    const sw = page.getByRole('switch', { name: 'Cross-post my public posts' });
    if (!ready) {
      // no account on this server's PDS: the switch is not offered
      await expect(sw).toHaveCount(0);
      expect((await member.get('/api/me/crosspost')).ready).toBe(false);
      await accessible(page, 'messages: the feed without cross-posting');
      await member.close();
      return;
    }
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('#main')).toContainText('only posts marked Public and labelled public');
    await sw.click();
    await toast(page, 'cross-posted to your repo from now on');
    await expect(page.getByRole('switch', { name: 'Cross-post my public posts' })).toHaveAttribute('aria-checked', 'true');
    expect((await member.get('/api/me/crosspost')).enabled).toBe(true);

    // a post marked Public and labelled public, from the composer
    const text = `Out in the open ${Date.now()}`;
    await page.locator('[data-pdraft]').fill(text);
    await page.locator('[data-plabel]').selectOption('public');
    await page.locator('[data-pvis]').selectOption('public');
    await page.locator('button[data-post]').click();
    await toast(page, 'Published.');
    const meId = (await member.get('/api/me')).user.id as string;
    const pub = ((await member.get(`/api/feed/users/${meId}?limit=20`)).items as { id: string; body: string }[]).find((p) => p.body === text)!;
    expect(pub).toBeTruthy();
    await expect.poll(async () => (await member.get(`/api/feed/posts/${pub.id}/crosspost`)).state, { timeout: 30_000 }).toBe('written');
    const status = await member.get(`/api/feed/posts/${pub.id}/crosspost`);
    await page.reload();
    await open(page, `messages?post=${pub.id}`);
    const article = page.locator(`article[data-post="${pub.id}"]`);
    await expect(article).toContainText('cross-posted');
    await expect(article.locator('[title^="at://"]')).toHaveAttribute('title', status.uri);
    await settle(page);
    await accessible(page, 'messages: the feed with the cross-post switch and a status');
    await reflow(page, 'messages: the feed with the cross-post switch and a status');

    // switched off again, so later specs see the author's choice as it was
    await page.getByRole('switch', { name: 'Cross-post my public posts' }).click();
    await toast(page, 'Cross-posting is off');
    await member.close();
  });
});
