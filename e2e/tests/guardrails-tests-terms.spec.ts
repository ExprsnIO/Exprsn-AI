import { test, expect, open, ready, settle, toast, confirmDialog, apiAs, type Page } from './support/fixtures';
import { expectAccessible } from './support/a11y';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';

// 1.9.0, Sprint 50 (B-155 to B-157): the Guardrails screen's Tests tab (cases, the run, the diff since the last run,
// the publish gate), its Term lists section (live test, CSV dry run) and the condition tree editor of a rule, used
// from the keyboard. Each view passes axe-core and the in-page checker in Standard and Enhanced, light and dark, and
// reflows at 320 and 640 px.

type AppGlobal = { App: { setA11y(m: string | null): void; closeOverlay(): void } };

async function checkAll(page: Page, where: string): Promise<void> {
  await settle(page);
  await expectAccessible(page, where);
  await expectAxeClean(page, 'aa', where);
  await page.evaluate(() => (window as unknown as AppGlobal).App.setA11y('aaa'));
  await expectAccessible(page, `${where}, Enhanced`);
  await expectAxeClean(page, 'aaa', `${where}, Enhanced`);
  await page.evaluate(() => (window as unknown as AppGlobal).App.setA11y('aa'));
}

async function reflow(page: Page, where: string): Promise<void> {
  for (const width of [320, 640]) {
    await page.setViewportSize({ width, height: 800 });
    await settle(page);
    await page.waitForTimeout(300);
    expect(await reflowProblems(page), `${where} at ${width} px`).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

/** A tenant set with a term-list rule and a condition-tree rule, and its list, made through the API. */
async function fixture(stamp: string) {
  const root = await apiAs('root');
  const list = await root.post('/api/admin/guardrails/term-lists', { name: `e2e-spam-${stamp}`, kind: 'deny', description: 'Spam words for the e2e suite', entries: [{ value: 'casino' }, { value: 'free money' }, { value: 'evil.example', match: 'domain' }] });
  const set = await root.post('/api/admin/guardrails/sets', { name: `E2E tests ${stamp}`, scope: 'tenant' });
  await root.put(`/api/admin/guardrails/sets/${set.id}/draft`, {
    rules: [
      { id: 'spam-terms', name: 'Spam terms', checkpoint: 'user-input', type: 'term list', mechanism: { kind: 'term-list', list: list.id, version: 'latest' }, action: 'block', stage: 'enforce', onError: 'closed', severity: 'medium', enabled: true },
      { id: 'new-links', name: 'Links from new accounts', checkpoint: 'user-input', type: 'conditions', mechanism: { kind: 'conditions', when: { all: [{ kind: 'pattern', pattern: 'https?://' }, { kind: 'context', field: 'newAccount', op: 'truthy' }] } }, action: 'flag', stage: 'shadow', onError: 'closed', severity: 'low', enabled: true }
    ]
  });
  return { root, list, set };
}

async function openSet(page: Page, name: string): Promise<void> {
  await open(page, 'guardrails');
  const option = await page.locator('[data-profile] option', { hasText: name }).first().getAttribute('value');
  await page.locator('[data-profile]').selectOption(option!);
  await expect(page.locator('[data-profile] option:checked')).toHaveText(new RegExp(name));
}

test.describe('Guardrails: rule-set tests, term lists and nested conditions', () => {
  test('cases gate publishing, the run shows what changed, a term list is tried, and a tree is edited by keyboard', async ({ page, watch }) => {
    test.setTimeout(180_000);
    watch.allow.push(/ -> 409$/);
    const stamp = Date.now().toString(36);
    const { root, set } = await fixture(stamp);
    await openSet(page, `E2E tests ${stamp}`);

    // Tests: two cases from the dialog, one of which fails.
    await page.locator('[data-tab="tests"]').click();
    await expect(page.locator('[data-tab="tests"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#main')).toContainText('No test cases yet');
    const add = async (name: string, text: string, expectWhat: string, rule: string) => {
      await page.locator('[data-gt-add]').click();
      const m = page.locator('#overlay .modal');
      await m.locator('[data-n]').fill(name);
      await m.locator('[data-x]').selectOption(expectWhat);
      await m.locator('[data-r]').selectOption(rule);
      await m.locator('[data-t]').fill(text);
      await m.locator('[data-ok]').click();
      await toast(page, 'Test case added');
    };
    await add('Casino is blocked', 'Win at the c4s1n0 tonight', 'block', 'spam-terms');
    await add('Plain note passes', 'Free money for everyone at the casino', 'pass', '');
    await page.locator('[data-gt-run]').click();
    await toast(page, /Ran 2 cases: 1 passed, 1 failing/);
    await expect(page.locator('#main')).toContainText('1 of 2 passed');
    await expect(page.locator('#main tr', { hasText: 'Plain note passes' })).toContainText('fails');

    // Publishing is refused while a case fails, and the screen stays on the tests.
    await page.locator('[data-publish]').click();
    await confirmDialog(page, 'Publish');
    await toast(page, /Rule-set tests failing/);
    await expect(page.locator('[data-tab="tests"]')).toHaveAttribute('aria-selected', 'true');
    expect((await root.get(`/api/admin/guardrails/sets/${set.id}`)).publishedVersion).toBeNull();

    // The failing case is fixed to expect a block; the next run shows it now passes.
    const fail = page.locator('#main tr', { hasText: 'Plain note passes' });
    await fail.locator('[data-gt-edit]').click();
    const m = page.locator('#overlay .modal');
    await m.locator('[data-n]').fill('Free money is blocked');
    await m.locator('[data-x]').selectOption('block');
    await m.locator('[data-r]').selectOption('spam-terms');
    await m.locator('[data-ok]').click();
    await toast(page, 'Test case saved');
    await page.locator('[data-gt-run]').click();
    await toast(page, /2 passed, 0 failing/);
    await expect(page.locator('#main')).toContainText('2 of 2 passed');
    await expect(page.locator('#main')).toContainText('Now passing: Free money is blocked');

    // Term lists: the live test marks the normalised matches; a CSV dry run reports duplicates and invalid rows.
    await page.locator('[data-tab="terms"]').click();
    const row = page.locator('#main tr', { hasText: `e2e-spam-${stamp}` });
    await row.click();
    await expect(page.locator('#main')).toContainText('Spam terms in');
    await page.locator('[data-gtl-sample]').fill('FR33 m0ney at login.evil.example');
    await page.locator('[data-gtl-test]').click();
    await expect(page.locator('#main mark.gtl-mark')).toHaveCount(2);
    await page.locator('[data-gtl-import]').click();
    const imp = page.locator('#overlay .modal');
    await imp.locator('[data-mode]').selectOption('append');
    await imp.locator('[data-csv]').fill('value,match\nCASINO,word\nlottery,word\nnot a domain,domain\n');
    await imp.locator('[data-check]').click();
    await expect(imp).toContainText('1 duplicate and 1 invalid row');
    await expect(imp.locator('[data-import]')).toBeDisabled();
    await imp.locator('[data-csv]').fill('value\nlottery\n');
    await imp.locator('[data-check]').click();
    await expect(imp.locator('[data-import]')).toBeEnabled();
    await imp.locator('[data-import]').click();
    await toast(page, /v2 imported with 4 entries/);

    // Rules: the condition tree, edited from the keyboard.
    await page.locator('[data-tab="rules"]').click();
    await page.locator('tr.row[data-rule="new-links"]').click();
    const tree = page.locator('[data-ce-root]');
    await expect(tree).toBeVisible();
    await tree.locator('[data-ce-add="leaf"][data-path="0"]').focus();
    await page.keyboard.press('Enter');
    await expect(tree.locator('[data-ce-leafkind]')).toHaveCount(3);
    await expect(page.locator('#main')).toContainText('unsaved edit');
    await tree.locator('[data-ce-move="up"][data-path="0.2"]').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-ce-move="up"][data-path="0.1"]')).toBeFocused();
    await tree.locator('[data-ce-kind][data-path="0"]').selectOption('any');
    await expect(page.locator('[data-testpane]')).toContainText('Would');
    await tree.locator('[data-ce-del][data-path="0.1"]').focus();
    await page.keyboard.press('Enter');
    await expect(tree.locator('[data-ce-leafkind]')).toHaveCount(2);
    await page.locator('[data-save]').click();
    await toast(page, 'Saved to');
    const saved = await root.get(`/api/admin/guardrails/sets/${set.id}`);
    expect(saved.draft.rules.find((r: { id: string }) => r.id === 'new-links').mechanism.when).toMatchObject({ any: [{ kind: 'pattern' }, { kind: 'context', field: 'newAccount' }] });
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`the Tests tab, Term lists and the condition editor pass the accessibility checks and reflow (${scheme})`, async ({ page }) => {
      test.setTimeout(240_000);
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      const stamp = `${scheme}${Date.now().toString(36)}`;
      const { root, set } = await fixture(stamp);
      await root.post(`/api/admin/guardrails/sets/${set.id}/tests`, { cases: [{ name: 'Casino is blocked', text: 'casino night', expect: 'block', ruleId: 'spam-terms' }, { name: 'Plain passes', text: 'free money', expect: 'pass' }] });
      await root.post(`/api/admin/guardrails/sets/${set.id}/tests/run`, {});
      await openSet(page, `E2E tests ${stamp}`);
      await page.locator('[data-tab="tests"]').click();
      await expect(page.locator('#main')).toContainText('1 of 2 passed');
      await checkAll(page, `guardrails tests (${scheme})`);
      await reflow(page, `guardrails tests (${scheme})`);
      await page.locator('[data-gt-add]').click();
      await expect(page.locator('#overlay .modal')).toBeVisible();
      await checkAll(page, `guardrails add case dialog (${scheme})`);
      await page.evaluate(() => (window as unknown as AppGlobal).App.closeOverlay());

      await page.locator('[data-tab="terms"]').click();
      await page.locator('#main tr', { hasText: `e2e-spam-${stamp}` }).click();
      await expect(page.locator('#main')).toContainText('Try it');
      await checkAll(page, `guardrails term lists (${scheme})`);
      await reflow(page, `guardrails term lists (${scheme})`);

      await page.locator('[data-tab="rules"]').click();
      await page.locator('tr.row[data-rule="new-links"]').click();
      await expect(page.locator('[data-ce-root]')).toBeVisible();
      await checkAll(page, `guardrails condition editor (${scheme})`);
      await reflow(page, `guardrails condition editor (${scheme})`);
      await page.reload();
      await ready(page, 'guardrails');
    });
  }
});
