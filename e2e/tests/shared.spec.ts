import { request as pwRequest } from '@playwright/test';
import { test, expect, ready } from './support/fixtures';
import { authFile, serverState } from './support/state';

/**
 * Sprint 16: an anonymous share link opens a public conversation on a signed-out, read-only page. The link is made
 * through the API as the tenant's admin (seeding); the page under test is the console's.
 */
async function anonymousLink(): Promise<{ url: string; question: string }> {
  const base = serverState().url;
  const ctx = await pwRequest.newContext({ baseURL: base, storageState: authFile('root') });
  const session = await (await ctx.get('/api/auth/session')).json();
  const headers = { 'x-csrf-token': session.csrf as string, origin: base };
  const ok = async (r: Awaited<ReturnType<typeof ctx.get>>) => {
    if (!r.ok()) throw new Error(`${r.url()} -> ${r.status()} ${await r.text()}`);
    return r.status() === 204 ? null : r.json();
  };
  const me = await ok(await ctx.get('/api/me'));
  await ok(await ctx.put(`/api/admin/tenants/${me.tenant.id}/sharing`, { data: { anonymousLinks: true }, headers }));
  const conv = await ok(await ctx.post('/api/conversations', { data: { title: 'Opening hours', label: 'public' }, headers }));
  const question = 'When does the front desk open?';
  const sent = await ok(await ctx.post(`/api/conversations/${conv.id}/messages`, { data: { content: question, profile: 'general', label: 'public' }, headers }));
  await expect.poll(async () => ((await ok(await ctx.get(`/api/conversations/${conv.id}`))).messages.find((m: { id: string }) => m.id === sent.messageId) || {}).state, { timeout: 20_000 }).toBe('complete');
  const share = await ok(await ctx.post(`/api/conversations/${conv.id}/shares`, { data: { kind: 'link', expiresInHours: 24, anonymous: true }, headers }));
  await ctx.dispose();
  return { url: new URL(share.url).hash, question };
}

test.describe('Shared conversation, signed out', () => {
  test.use({ user: null });

  test('an anonymous link opens the public conversation read-only, without the console shell', async ({ page }) => {
    const { url, question } = await anonymousLink();
    await page.goto('/' + url);
    await ready(page, 'shared');
    await expect(page.getByRole('heading', { name: 'Opening hours' })).toBeVisible();
    await expect(page.locator('.sh-q')).toContainText(question);
    await expect(page.locator('.sh-a')).toContainText('Fake answer to: ' + question);
    await expect(page.getByText('read only')).toBeVisible();
    // The token is taken out of the address bar at once, and nothing signs the visitor in.
    expect(await page.evaluate(() => location.hash)).toBe('#/shared');
    await expect(page.locator('#sidebar a')).toHaveCount(0);
    expect((await page.context().cookies()).filter((c) => /exai_sid/.test(c.name))).toEqual([]);
  });
});
