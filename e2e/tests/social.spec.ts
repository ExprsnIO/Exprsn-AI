import { test, expect, open, expectLive, settle, toast, confirmDialog, apiAs, type Page } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { expectAccessible } from './support/a11y';
import { reflowProblems } from './support/reflow';
import { serverState } from './support/state';

// 1.6.0 (B-4206 with its share of B-4207): Social and messaging, live. Policies for the feed, groups and messaging of
// every workspace, trending exclusions, calendar feed revocation (a revoked feed answers 404 on its next fetch), the
// legal-hold export under dual control (decision Q5: a second platform admin approves), realtime counts and contact
// rules. Each tab, its design states and its dialogs pass the WCAG checker and axe-core (Standard and Enhanced, light
// and dark) and reflow at 320 and 640 px.

type AppGlobal = { App: { setA11y(m: 'aa' | 'aaa' | null): void; applyState(i: number): void; closeOverlay(): void; screens: Record<string, { states?: unknown[] }>; state: { screenState: Record<string, unknown> }; render(): void } };

/** Sideways scrolling or anything sticking out of the open dialog or drawer. */
function dialogReflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const box = document.querySelector('#overlay > .modal, #overlay > .drawer') as HTMLElement | null;
    if (!box) return ['no dialog open'];
    const doc = document.scrollingElement!;
    if (doc.scrollWidth > window.innerWidth + 1) out.push(`the page scrolls sideways by ${doc.scrollWidth - window.innerWidth} px`);
    if (box.scrollWidth > box.clientWidth + 1) out.push(`the dialog scrolls sideways by ${box.scrollWidth - box.clientWidth} px`);
    const edge = Math.min(window.innerWidth, box.getBoundingClientRect().right);
    const scrollers = Array.from(box.querySelectorAll('*')).filter((el) => el instanceof HTMLElement && /(auto|scroll)/.test(getComputedStyle(el).overflowX) && el.scrollWidth > el.clientWidth + 1);
    for (const el of scrollers) if (!el.matches('.tablewrap,.codebox,pre,textarea,[data-scroll-x]')) out.push(`${el.tagName.toLowerCase()}.${(el as HTMLElement).className} scrolls sideways`);
    for (const el of Array.from(box.querySelectorAll('*'))) {
      if (!(el instanceof HTMLElement) || !el.getClientRects().length) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.right <= edge + 1 || scrollers.some((s) => s.contains(el))) continue;
      out.push(`${el.tagName.toLowerCase()}.${el.className} sticks out (${Math.round(r.right)} px of ${Math.round(edge)})`);
    }
    return [...new Set(out)].slice(0, 10);
  });
}

/** The in-page checker, then axe-core in Standard and Enhanced, light and dark. */
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
  await page.emulateMedia({ colorScheme: 'light' });
}

async function reflow(page: Page, where: string, dialog = false): Promise<void> {
  for (const width of [320, 640]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(200);
    expect.soft(dialog ? await dialogReflow(page) : await reflowProblems(page), `${where} at ${width} px`).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(100);
}

async function tab(page: Page, label: string): Promise<void> {
  // A reload that lands while the tab is clicked re-renders the page; click again until the tab is selected.
  await settle(page);
  await expect(async () => {
    await page.locator('.tabs [data-tab]', { hasText: label }).first().click();
    await expect(page.locator('.tabs [data-tab][aria-selected="true"]', { hasText: label })).toHaveCount(1, { timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  await settle(page);
}

/** Answers the step-up check (B-106) when the server asks for a fresh sign-in, then waits for the toast. */
async function stepUpIfAsked(page: Page, done: RegExp): Promise<void> {
  const stepUp = page.locator('#overlay .modal', { hasText: 'Confirm it is you' });
  const ok = page.locator('#toasts .toast').filter({ hasText: done }).first();
  await expect(stepUp.or(ok)).toBeVisible();
  if (await stepUp.isVisible()) {
    await stepUp.locator('[data-supw]').fill(serverState().password);
    await stepUp.getByRole('button', { name: 'Confirm' }).click();
    await expect(ok).toBeVisible();
  }
}

test.describe('Social and messaging', () => {
  test('feed policies, trending exclusions and the digest settings are backed by the server', async ({ page }) => {
    const root = await apiAs('root');
    const ws = serverState().workspace;
    await root.post('/api/feed/posts', { workspaceId: ws.id, body: 'Month-end close is done #monthendclose #vendorchatter' });
    await open(page, 'social');
    await expectLive(page);
    await expect(page.locator('#sidebar a[href="#/social"]')).toHaveCount(1);
    await expect(page.locator('#main h1')).toContainText('Social and messaging');
    const row = page.locator('tr', { hasText: ws.name }).first();
    await expect(row).toBeVisible();

    // Media off, then on again: each change is saved and shown.
    await row.locator('[data-media]').click();
    await toast(page, `Media off for ${ws.name}`);
    await expect(page.locator('tr', { hasText: ws.name }).first().locator('[data-media]')).toHaveAttribute('aria-checked', 'false');
    await page.locator('tr', { hasText: ws.name }).first().locator('[data-media]').click();
    await toast(page, `Media allowed for ${ws.name}`);
    await page.locator('tr', { hasText: ws.name }).first().locator('[data-maxmedia]').selectOption({ label: '50 MiB' });
    await toast(page, 'Max media size saved');
    expect((await root.get('/api/admin/social/feed')).workspaces.find((w: { id: string }) => w.id === ws.id)).toMatchObject({ feedMedia: true, feedMediaMaxBytes: 50 * 1048576 });

    // Trending: run now, then exclude a tag.
    await page.locator('[data-runtrending]').click();
    await toast(page, 'Trending job queued');
    await expect(page.locator('[data-exclude="vendorchatter"]')).toBeVisible({ timeout: 15_000 });
    await page.locator('[data-exclude="vendorchatter"]').click();
    await confirmDialog(page, 'Exclude');
    await toast(page, '#vendorchatter excluded from trending');
    await expect(page.locator('[data-include="vendorchatter"]')).toBeVisible();
    expect((await root.get('/api/feed/trending')).tags.map((t: { tag: string }) => t.tag)).not.toContain('vendorchatter');

    // The digest's day and size are saved per tenant.
    await page.locator('[data-dday]').selectOption({ label: 'Friday' });
    await toast(page, 'Digest day saved: Friday');
    await page.locator('[data-dtop]').selectOption('3');
    await toast(page, 'Digests list 3 posts');
    expect((await root.get('/api/admin/social/feed')).digest.settings).toMatchObject({ digestDay: 4, digestTop: 3 });

    await accessible(page, 'Social and messaging, Feed');
    await reflow(page, 'Social and messaging, Feed');
    await root.close();
  });

  test('a revoked calendar feed answers 404 on its next fetch; groups are transferred and archived from the screen', async ({ page, request }) => {
    const root = await apiAs('root');
    const ws = serverState().workspace;
    const g = await root.post('/api/groups', { workspaceId: ws.id, name: 'Board pack reviewers', visibility: 'private', joinMode: 'open' });
    const member = await apiAs('member');
    await member.post(`/api/groups/${g.id}/join`);
    const feed = await member.post('/api/calendar/feeds', { kind: 'group', targetId: g.id });
    const path = new URL(feed.url).pathname;
    expect((await request.get(path, { headers: { cookie: '' } })).status()).toBe(200);

    await open(page, 'social?tab=groups');
    await expectLive(page);
    await page.locator('tr[data-group]', { hasText: 'Board pack reviewers' }).click();
    await expect(page.locator('aside.inspector')).toContainText('Board pack reviewers');

    // B-4206 done when: revoke from the screen, the next fetch answers 404.
    await page.locator(`[data-revoke="${feed.id}"]`).click();
    await confirmDialog(page, 'Revoke');
    await toast(page, 'Feed revoked. The next fetch answers 404');
    expect((await request.get(path, { headers: { cookie: '' } })).status()).toBe(404);

    // Defaults per workspace.
    await page.locator(`[data-djoin="${ws.id}"]`).selectOption('open');
    await toast(page, 'Default join mode saved');

    // Transfer ownership to the member, then archive.
    await page.locator('[data-transfer]').click();
    const modal = page.locator('#overlay .modal');
    await expect(modal).toContainText('Transfer ownership of Board pack reviewers');
    await accessible(page, 'Transfer ownership dialog');
    await reflow(page, 'Transfer ownership dialog', true);
    await modal.locator('[data-dotransfer]').click();
    await toast(page, 'Ownership of Board pack reviewers transferred to Sam Rivera');
    await expect(page.locator('aside.inspector')).toContainText('Sam Rivera');
    await page.locator('[data-archive]').click();
    await confirmDialog(page, 'Archive');
    await toast(page, 'Board pack reviewers archived');
    await expect(page.locator('tr[data-group]', { hasText: 'Board pack reviewers' })).toContainText('archived');

    await accessible(page, 'Social and messaging, Groups and events');
    await reflow(page, 'Social and messaging, Groups and events');
    await root.close();
    await member.close();
  });

  test('a conversation is exported for a legal hold only after a second platform admin approves', async ({ page, as, watch }) => {
    // The first try answers 401 "Step-up required" when the sign-in is not recent; the screen asks and tries again.
    watch.allow.push(/POST \/api\/admin\/social\/exports(\/[0-9A-Z]+\/approve)? -> 401$/);
    const member = await apiAs('member');
    const root = await apiAs('root');
    const me = await root.get('/api/me');
    const conv = await member.post('/api/messaging/conversations', { kind: 'direct', userId: me.user.id });
    await member.post(`/api/messaging/conversations/${conv.id}/messages`, { body: 'Keep this for the audit file' });

    await open(page, 'social?tab=messaging');
    await expectLive(page);
    await accessible(page, 'Social and messaging, Messaging');
    await reflow(page, 'Social and messaging, Messaging');
    await page.locator('.page [data-export]').last().click();
    const drawer = page.locator('#overlay .drawer');
    await expect(drawer).toContainText('Export a conversation');
    await accessible(page, 'Export drawer');
    await reflow(page, 'Export drawer', true);
    await drawer.locator('[data-xreason]').fill('Case LH-2026-14: preservation notice from counsel');
    await drawer.locator('[data-xapprover]').selectOption({ label: 'Jon Lee' });
    await drawer.locator('[data-xsubmit]').click();
    await stepUpIfAsked(page, /Export request sent to Jon Lee/);
    await expect(page.locator('tr', { hasText: 'waiting for approval' }).first()).toBeVisible();

    // The second platform admin approves on their own screen.
    const p2 = await as('root2');
    await p2.goto('/#/social?tab=messaging');
    await settle(p2);
    await p2.locator('[data-xapprove]').first().click();
    await confirmDialog(p2, 'Approve');
    await stepUpIfAsked(p2, /Export approved/);

    // The requester gets the CSV once the job has run.
    await expect(async () => {
      await page.evaluate(() => { const A = (window as unknown as AppGlobal).App; A.state.screenState.social = { tab: 'messaging' }; A.render(); });
      await settle(page);
      await expect(page.locator('[data-xdownload]').first()).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 20_000 });
    const href = await page.locator('[data-xdownload]').first().getAttribute('href');
    const csv = await page.request.get(href!);
    expect(csv.status()).toBe(200);
    expect(await csv.text()).toContain('Keep this for the audit file');
    await member.close();
    await root.close();
  });

  test('realtime counts and relations; the design states pass the checks', async ({ page, watch }) => {
    watch.allow.push(/ -> 404$/);
    await open(page, 'social?tab=realtime');
    await expectLive(page);
    await expect(page.locator('table')).toContainText('conversation');
    await accessible(page, 'Social and messaging, Realtime');
    await reflow(page, 'Social and messaging, Realtime');
    await page.locator('[data-closerooms]').click();
    const modal = page.locator('#overlay .modal');
    await expect(modal).toContainText('Close a user\'s rooms');
    await accessible(page, 'Close rooms dialog');
    await reflow(page, 'Close rooms dialog', true);
    await modal.locator('[data-cuser]').selectOption({ label: 'Sam Rivera (member)' });
    await modal.locator('[data-doclose]').click();
    await toast(page, 'Rooms of Sam Rivera closed on every instance');

    await tab(page, 'Relations');
    const ws = serverState().workspace;
    await page.locator(`[data-rule="${ws.id}"]`).selectOption('contacts');
    await page.locator(`[data-applyrule="${ws.id}"]`).click();
    await confirmDialog(page, 'Apply');
    await toast(page, `Contact rule for ${ws.name} applied`);
    const root = await apiAs('root');
    expect((await root.get('/api/admin/social/relations')).rules.find((r: { workspaceId: string }) => r.workspaceId === ws.id).contactRule).toBe('contacts');
    await root.put(`/api/admin/social/policies/${ws.id}`, { contactRule: 'workspace' });
    await root.close();
    await accessible(page, 'Social and messaging, Relations');
    await reflow(page, 'Social and messaging, Relations');

    // Each design state, as the accessibility sweep applies them.
    const n = await page.evaluate(() => ((window as unknown as AppGlobal).App.screens.social?.states ?? []).length);
    expect(n).toBe(6); // 1.6.0 (B-4405) added "Category removed, groups uncategorised"
    for (let i = 0; i < n; i++) {
      await page.evaluate((k) => { const A = (window as unknown as AppGlobal).App; A.closeOverlay(); A.state.screenState.social = {}; A.render(); A.applyState(k); }, i);
      await page.waitForTimeout(250);
      await settle(page);
      await accessible(page, `Social and messaging, state ${i + 1}`);
      await reflow(page, `Social and messaging, state ${i + 1}`);
    }
  });

  test.describe('as a member', () => {
    test.use({ user: 'member' });
    test('a member does not see the screen', async ({ page }) => {
      await page.goto('/#/chat');
      await settle(page);
      await expect(page.locator('#sidebar a[href="#/social"]')).toHaveCount(0);
    });
  });
});
