import { test, expect, open, expectLive, toast, confirmDialog, apiAs } from './support/fixtures';

// B-3403: the Vault screen against the real vault API. The vault is default deny, so each test first gives root a grant
// on its own unique prefix (through the console in the policy test, through the API where the grant is only setup).

const uid = () => Math.random().toString(36).slice(2, 8);

async function grantRoot(path: string, capabilities: string[]): Promise<void> {
  const api = await apiAs('root');
  const me = await api.get('/api/me');
  await api.post('/api/vault/policies', { subjectKind: 'user', subject: me.user.id, path, capabilities, effect: 'allow', description: 'e2e' });
  await api.close();
}

test.describe('Vault', () => {
  test('adds an allow and a deny grant and explains the decision for each', async ({ page, watch }) => {
    const pre = `kv/e2e-pol-${uid()}`;
    await open(page, 'vault');
    await expectLive(page);
    await page.locator('[data-tab="policies"]').click();

    const addGrant = async (path: string, caps: string[], effect: 'allow' | 'deny', description: string) => {
      await page.locator('[data-newgrant]').click();
      const modal = page.locator('#overlay .modal');
      await expect(modal).toContainText('Add grant');
      await modal.locator('[data-gkind]').selectOption('user');
      // The subject defaults to the signed-in user (root).
      await modal.locator('[data-gpath]').fill(path);
      await modal.locator('[data-geffect]').selectOption(effect);
      await modal.locator('[data-gdesc]').fill(description);
      for (const c of ['list', 'read']) await modal.locator(`[data-gcap="${c}"]`).click(); // clear the defaults
      for (const c of caps) await modal.locator(`[data-gcap="${c}"]`).click();
      await modal.locator('[data-gsave]').click();
      await toast(page, 'Grant added. Audited vault.policy.created.');
      await expect(page.locator('#main tr[data-grant]', { hasText: description })).toContainText(path);
    };
    await addGrant(pre, ['list', 'read', 'write'], 'allow', `allow ${pre}`);
    await addGrant(`${pre}/locked`, ['read'], 'deny', `deny ${pre}`);

    // Explain: the deny on the exact path decides, however specific the allow.
    await page.locator('[data-expath]').fill(`${pre}/locked/db`);
    await page.locator('[data-excap]').selectOption('read');
    await page.locator('[data-explain]').click();
    const out = page.locator('#main [data-explain-out]');
    await expect(out).toContainText('Denied.');
    await expect(out).toContainText(`deny read on ${pre}/locked`);
    await expect(out.locator('.timeline')).toContainText('deciding');
    await expect(out.locator('.timeline')).toContainText(pre);

    // The allow decides for write elsewhere under the prefix; nothing matching is a default deny.
    await page.locator('[data-expath]').fill(`${pre}/app`);
    await page.locator('[data-excap]').selectOption('write');
    await page.locator('[data-explain]').click();
    await expect(out).toContainText('Allowed.');
    await expect(out).toContainText(`allow list, read, write on ${pre}`);
    await page.locator('[data-excap]').selectOption('destroy');
    await page.locator('[data-explain]').click();
    await expect(out).toContainText('Denied.');
    await expect(out).toContainText(`No vault policy grants destroy on ${pre}/app`);

    // Who can: the same answer for every user.
    await page.locator('[data-whopath]').fill(`${pre}/app`);
    await page.locator('[data-whocap]').selectOption('read');
    await page.locator('[data-who]').click();
    await expect(page.locator('#main .vault-pol')).toContainText('allowed');

    // Delete the deny grant: the path is allowed again.
    await page.locator('#main tr[data-grant]', { hasText: `deny ${pre}` }).locator('[data-delgrant]').click();
    await confirmDialog(page, 'Delete');
    await toast(page, 'Grant deleted.');
    await expect(page.locator('#main tr[data-grant]', { hasText: `deny ${pre}` })).toHaveCount(0);
    expect(watch.problems).toEqual([]);
  });

  test('writes, reveals, versions, soft-deletes, destroys and schedules a KV secret', async ({ page, watch }) => {
    const pre = `e2e-kv-${uid()}`;
    await grantRoot(`kv/${pre}`, ['*']);
    await open(page, 'vault');
    await page.locator('[data-newsecret]').click();
    let modal = page.locator('#overlay .modal');
    await modal.locator('[data-wpath]').fill(`kv/${pre}/db`);
    await modal.locator('[data-wk]').first().fill('password');
    await modal.locator('[data-wv]').first().fill('first-secret-value');
    await modal.locator('[data-wsave]').click();
    await toast(page, `kv/${pre}/db created, version 1.`);
    await expect(page.locator('#main h1')).toHaveText(`kv/${pre}/db`);

    // Reveal: confirmed, audited, masked until shown.
    await page.locator('#main [data-reveal="1"]').click();
    await confirmDialog(page, 'Reveal');
    await toast(page, 'Version 1 revealed.');
    await expect(page.locator('#main')).not.toContainText('first-secret-value');
    await page.locator('#main [data-show="password"]').click();
    await expect(page.locator('#main')).toContainText('first-secret-value');

    // Write version 2 keeping the revealed key; then a write with a stale cas is refused with 409.
    await page.locator('#main .pagehead [data-write]').click();
    modal = page.locator('#overlay .modal');
    await modal.locator('[data-wv]').first().fill('second-secret-value');
    await modal.locator('[data-wsave]').click();
    await toast(page, `kv/${pre}/db version 2 written.`);
    await expect(page.locator('#main tr[data-version="2"]')).toContainText('current');

    watch.allow.push(/PUT \/api\/vault\/kv\/data\/.* -> 409$/);
    await page.locator('#main .pagehead [data-write]').click();
    modal = page.locator('#overlay .modal');
    await modal.locator('[data-wk]').first().fill('password');
    await modal.locator('[data-wv]').first().fill('third');
    await modal.locator('[data-wcas]').fill('1');
    await modal.locator('[data-wsave]').click();
    await expect(page.locator('#main .problem')).toContainText('The write named cas 1 but the current version is 2.');
    await page.locator('#main [data-clearcas]').click();

    // Soft delete, undelete, destroy.
    await page.locator('#main [data-softdel="1"]').click();
    await confirmDialog(page, 'Delete');
    await toast(page, 'Version 1 deleted.');
    await expect(page.locator('#main tr[data-version="1"]')).toContainText('deleted');
    await page.locator('#main [data-undel="1"]').click();
    await toast(page, 'Version 1 undeleted');
    await page.locator('#main [data-destroy="1"]').click();
    await confirmDialog(page, 'Destroy');
    await toast(page, 'Version 1 destroyed.');
    await expect(page.locator('#main tr[data-version="1"]')).toContainText('destroyed');
    watch.allow.push(/GET \/api\/vault\/kv\/data\/.*version=1 -> 410$/);
    await page.locator('#main [data-reveal="1"]').click();
    await expect(page.locator('#main')).toContainText('Version 1 is destroyed.');

    // Rotation schedule and metadata.
    await page.locator('#main [data-rotation]').click();
    modal = page.locator('#overlay .modal');
    await modal.locator('[data-rdays]').fill('30');
    await modal.locator('[data-rsave]').click();
    await toast(page, 'Rotation every 30 days');
    await expect(page.locator('#main .panel', { hasText: 'Metadata' })).toContainText('every 30 d, due');
    await page.locator('#main [data-meta]').click();
    modal = page.locator('#overlay .modal');
    await modal.locator('[data-mmax]').fill('5');
    await modal.locator('[data-mcustom]').fill('owner-team=e2e');
    await modal.locator('[data-mcas]').click();
    await modal.locator('[data-msave]').click();
    await toast(page, 'Metadata saved.');
    const meta = page.locator('#main .panel', { hasText: 'Metadata' });
    await expect(meta).toContainText('owner-team');
    await expect(meta).toContainText('CAS required');

    await page.locator('#main [data-removepath]').click();
    await confirmDialog(page, 'Remove path');
    await toast(page, `kv/${pre}/db removed.`);
    await expect(page.locator(`#main [data-path="${pre}/db"]`)).toHaveCount(0);
  });

  test('creates, rotates, uses and configures a transit key', async ({ page }) => {
    const name = `e2e-key-${uid()}`;
    await grantRoot(`transit/${name}`, ['*']);
    await open(page, 'vault');
    await page.locator('[data-tab="transit"]').click();
    await page.locator('[data-newkey]').click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-kname]').fill(name);
    await modal.locator('[data-kcreate]').click();
    await toast(page, `Key ${name} created.`);
    await expect(page.locator(`#main tr[data-key="${name}"]`)).toContainText('v1');

    await page.locator('#main [data-rotatekey]').click();
    await confirmDialog(page, 'Rotate');
    await toast(page, `${name} rotated to v2.`);
    await expect(page.locator(`#main tr[data-key="${name}"]`)).toContainText('v2');

    // Try it: encrypt, then decrypt the ciphertext the drawer kept.
    await page.locator('#main [data-trykey]').click();
    const drawer = page.locator('#overlay .drawer');
    await drawer.locator('[data-tryrun]').click();
    await expect(drawer.locator('[data-tryout]')).toContainText('exai:v2:');
    await drawer.locator('[data-seg="decrypt"]').click();
    await drawer.locator('[data-tryrun]').click();
    await expect(drawer.locator('[data-tryout]')).toContainText('aGVsbG8gdmF1bHQ=');
    await page.keyboard.press('Escape');

    await page.locator('#main [data-configkey]').click();
    const cfg = page.locator('#overlay .modal');
    await cfg.locator('[data-cmin]').selectOption('2');
    await cfg.locator('[data-cdays]').fill('90');
    await cfg.locator('[data-cdel]').click();
    await cfg.locator('[data-csave]').click();
    await toast(page, 'Key configured.');
    await expect(page.locator(`#main tr[data-key="${name}"]`)).toContainText('every 90 d');
    await expect(page.locator(`#main tr[data-key="${name}"]`)).toContainText('allowed');

    await page.locator('#main [data-delkey]').click();
    await confirmDialog(page, 'Delete key');
    await toast(page, 'Key deleted.');
    await expect(page.locator(`#main tr[data-key="${name}"]`)).toHaveCount(0);
  });

  test('registers a database engine, adds and removes a role, disables it and deletes it', async ({ page }) => {
    const name = `e2e-pg-${uid()}`;
    await open(page, 'vault');
    await page.locator('[data-tab="leases"]').click();
    await page.locator('[data-newengine]').click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-ename]').fill(name);
    await modal.locator('[data-eendpoint]').fill('127.0.0.1:1');
    await modal.locator('[data-edb]').fill('ledger');
    await modal.locator('[data-epw]').fill('not-a-real-password');
    // No database runs in the suite, so the engine is saved without the login check.
    await modal.locator('[data-echeck]').click();
    await modal.locator('[data-esave]').click();
    await toast(page, `Engine ${name} registered.`);
    const row = page.locator(`#main tr[data-engine="${name}"]`);
    await expect(row).toContainText('active');
    await row.click();

    await page.locator('#main [data-newrole]').click();
    const role = page.locator('#overlay .modal');
    await role.locator('[data-rname]').fill('readonly');
    await role.locator('[data-rsave]').click();
    await toast(page, `Role readonly saved. Policy path database/${name}/readonly.`);
    await expect(page.locator('#main aside')).toContainText('readonly');

    // Test connection: the admin cannot log in, which the inspector reports.
    await page.locator('#main [data-testengine]').click();
    await expect(page.locator('#main aside')).toContainText('Last check failed');

    await page.locator('#main [data-delrole="readonly"]').click();
    await confirmDialog(page, 'Remove');
    await toast(page, 'Role removed.');
    await page.locator('#main [data-toggleengine]').click();
    await toast(page, `Engine ${name} disabled.`);
    await expect(row).toContainText('disabled');
    await page.locator('#main [data-delengine]').click();
    await confirmDialog(page, 'Delete engine');
    await toast(page, 'Engine removed.');
    await expect(row).toHaveCount(0);
  });
});
