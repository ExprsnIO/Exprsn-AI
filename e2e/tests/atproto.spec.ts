import { test, expect, open, settle, expectLive, toast, confirmDialog, apiAs, type Page } from './support/fixtures';
import { serverState } from './support/state';
import { expectAccessible } from './support/a11y';
import { expectAxeClean } from './support/axe';

// B-3406: the AT-Protocol screen. Done when rotating a key from the screen updates the DID document; also a PDS
// account action and a feed generator, each through the console against the real server.

/** Answers the step-up check (B-106) when the server asks for a fresh sign-in, then waits for `done`. */
async function maybeStepUp(page: Page, done: RegExp): Promise<void> {
  const stepUp = page.locator('#overlay .modal', { hasText: 'Confirm it is you' });
  const ok = page.locator('#toasts .toast').filter({ hasText: done }).first();
  await expect(stepUp.or(ok)).toBeVisible();
  if (await stepUp.isVisible()) {
    await stepUp.locator('[data-supw]').fill(serverState().password);
    await stepUp.getByRole('button', { name: 'Confirm' }).click();
    await expect(ok).toBeVisible();
  }
}

type Identity = { did: string; method: string; keys: { purpose: string; state: string; didKey: string }[] };
const activeLabelKey = (i: Identity) => i.keys.find((k) => k.purpose === 'label' && k.state === 'active')!.didKey;

test.describe('AT-Protocol', () => {
  test('rotating the label key from the screen updates the DID document', async ({ page }) => {
    const api = await apiAs('root');
    await open(page, 'atproto');
    await expectLive(page);
    await expect(page.locator('.tabs [data-tab="identity"]')).toHaveAttribute('aria-selected', 'true');

    // The tenant's own did:web identity, created from the screen when it has none yet.
    const info = await api.get('/api/atproto');
    if (!info.identity) {
      await page.locator('[data-createid]').click();
      const m = page.locator('#overlay .modal');
      await m.locator('[data-cm]').selectOption('web');
      await m.getByRole('button', { name: 'Create', exact: true }).click();
      await toast(page, /Identity created \(201\)/);
    }
    const before = (await api.get('/api/atproto/identity')) as Identity;
    expect(before.method).toBe('web');
    await expect(page.locator('#main [data-did]')).toHaveText(before.did);
    const oldKey = activeLabelKey(before);
    await expect(page.locator('#main [data-doc]')).toContainText(oldKey.replace('did:key:', ''));

    await page.locator('[data-rotate="label"]').click();
    await expect(page.locator('#overlay .modal')).toContainText(oldKey);
    await confirmDialog(page, 'Rotate');
    await toast(page, /Key rotated/);

    const after = (await api.get('/api/atproto/identity')) as Identity;
    const newKey = activeLabelKey(after);
    expect(newKey).not.toBe(oldKey);
    expect(after.keys.find((k) => k.didKey === oldKey)?.state).toBe('retired');
    // The screen shows the new document, and the public did:web document (no session) names the new key.
    await expect(page.locator('#main [data-doc]')).toContainText('Document updated');
    await expect(page.locator('#main [data-doc]')).toContainText(newKey.replace('did:key:', ''));
    await expect(page.locator('#main [data-doc]')).not.toContainText(oldKey.replace('did:key:', ''));
    const res = await page.request.get(`/atproto/${serverState().tenant.toLowerCase()}/did.json`, { headers: { cookie: '' } });
    expect(res.status()).toBe(200);
    const doc = (await res.json()) as { id: string; verificationMethod: { id: string; publicKeyMultibase: string }[] };
    expect(doc.id).toBe(after.did);
    expect(doc.verificationMethod.find((v) => v.id.endsWith('#atproto_label'))?.publicKeyMultibase).toBe(newKey.replace('did:key:', ''));
    await expect(page.locator('#main tr[data-key]').filter({ hasText: oldKey })).toContainText('retired');
    await api.close();
  });

  test('switches PDS hosting on, deactivates and activates a hosted account, and publishes a feed generator', async ({ page, watch }) => {
    // The hosting switch needs a recent sign-in: the first try may answer 401 "Step-up required".
    watch.allow.push(/PUT \/api\/admin\/pds\/tenants\/[0-9A-Z]+ -> 401$/);
    const root = await apiAs('root');
    const tag = Date.now().toString(36).slice(-6);
    await open(page, 'atproto');
    await page.locator('.tabs [data-tab="pds"]').click();

    // Hosting, switched on by a platform admin from the screen.
    const hosting = page.locator('#main [data-hosting]');
    if (!(await root.get('/api/admin/pds')).enabled) {
      await hosting.locator('[data-hostingswitch]').click();
      await confirmDialog(page, 'Enable');
      await maybeStepUp(page, /Hosting enabled/);
    }
    await expect(hosting).toContainText('hosting on');
    const domain = (await root.get('/api/admin/pds')).handleDomain as string;
    expect(domain).toMatch(/\.pds\.example\.test$/);

    // A member creates their own account (Settings' job); the admin acts on it here.
    const member = await apiAs('member');
    await member.post('/api/me/step-up', { password: serverState().password });
    const created = (await member.post('/api/me/pds', { handle: `sam-${tag}` })) as { id: string; did: string; handle: string };
    expect(created.handle).toBe(`sam-${tag}.${domain}`);
    await member.close();

    await open(page, 'atproto?tab=pds');
    const row = page.locator('#main tr[data-pds]', { hasText: created.handle });
    await expect(row).toContainText('active');
    await expect(row.getByRole('link', { name: 'Export CAR' })).toHaveAttribute('href', `/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(created.did)}`);
    await row.getByRole('button', { name: 'Deactivate' }).click();
    const dm = page.locator('#overlay .modal');
    await dm.locator('[data-dreason]').fill('End-to-end check of deactivation');
    await dm.getByRole('button', { name: 'Deactivate', exact: true }).click();
    await toast(page, `${created.handle} deactivated`);
    await expect(row).toContainText('deactivated');
    expect((await root.get(`/api/admin/pds/accounts/${created.id}`)).state).toBe('deactivated');
    await row.getByRole('button', { name: 'Activate' }).click();
    await toast(page, `${created.handle} activated`);
    await expect(row).toContainText('active');
    expect((await root.get(`/api/admin/pds/accounts/${created.id}`)).state).toBe('active');

    // A feed generator over the firehose index, then its record published into the hosted repo.
    const rkey = `audit-${tag}`;
    await page.locator('[data-feednew]').click();
    const fm = page.locator('#overlay .modal');
    await fm.locator('[data-fname]').fill(`Audit ${tag}`);
    await fm.locator('[data-frkey]').fill(rkey);
    await fm.locator('[data-fret]').selectOption('168');
    await fm.getByRole('button', { name: 'Create', exact: true }).click();
    await toast(page, new RegExp(`Feed Audit ${tag} created \\(201\\)`));
    const feedRow = page.locator('#main tr[data-feed]', { hasText: `Audit ${tag}` });
    await expect(feedRow).toContainText('keywords: audit, evidence');
    await expect(feedRow).toContainText('7 days');
    await expect(feedRow).toContainText('not published');

    await feedRow.getByRole('button', { name: 'Publish record' }).click();
    const pm = page.locator('#overlay .modal');
    await pm.locator('[data-pt]').selectOption({ label: `Hosted repo ${created.handle}` });
    await pm.getByRole('button', { name: 'Publish', exact: true }).click();
    await toast(page, /Record published \(201\)/);
    const uri = `at://${created.did}/app.bsky.feed.generator/${rkey}`;
    await expect(feedRow).toContainText(uri);
    const feeds = (await root.get('/api/atproto/feeds')) as { generator: { did: string }; feeds: { rkey: string; published: { uri: string } | null; record: { did: string } }[] };
    const feed = feeds.feeds.find((f) => f.rkey === rkey)!;
    expect(feed.published?.uri).toBe(uri);
    expect(feed.record.did).toBe(feeds.generator.did);
    await root.close();
  });

  // The design states cover identity, labelers, firehose and accounts; every tab is checked here with the data made
  // above (a label, a subscription when the endpoint resolves, the hosted account and the feed), and the invite drawer.
  test('every tab passes the WCAG checks and axe-core in Standard and Enhanced, light and dark', async ({ page }) => {
    const api = await apiAs('root');
    const tag = Date.now().toString(36).slice(-6);
    await api.post('/api/atproto/labels', { uri: `https://example.test/a11y/${tag}`, vals: ['!warn', 'spam'] });
    // Best effort: the endpoint is checked as a service URL when saved, which needs DNS.
    await api.post('/api/atproto/firehose', { name: `A11y ${tag}`, protocol: 'jetstream', endpoint: 'wss://jetstream2.us-east.bsky.network' }).catch(() => undefined);
    await api.close();
    const setA11y = (m: string) => page.evaluate((x) => (window as unknown as { App: { setA11y(m: string): void } }).App.setA11y(x), m);
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, 'atproto');
      for (const tab of ['identity', 'labels', 'labelers', 'firehose', 'accounts', 'pds']) {
        await page.locator(`.tabs [data-tab="${tab}"]`).click();
        await settle(page);
        await expectAccessible(page, `atproto, ${tab} (${scheme})`);
        await expectAxeClean(page, 'aa', `atproto, ${tab} (${scheme})`);
        await setA11y('aaa');
        await expectAxeClean(page, 'aaa', `atproto, ${tab} (${scheme}), Enhanced`);
        await setA11y('aa');
      }
      await page.locator('[data-invites]').click();
      await expect(page.locator('#overlay .drawer')).toContainText('Uses');
      await expectAccessible(page, `atproto, invite codes (${scheme})`);
      await expectAxeClean(page, 'aa', `atproto, invite codes (${scheme})`);
      await page.keyboard.press('Escape');
    }
  });
});
