import Database from 'better-sqlite3';
import { test, expect, open, expectLive, settle, toast, confirmDialog, apiAs, type Page } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { expectAccessible } from './support/a11y';
import { reflowProblems } from './support/reflow';
import { serverState } from './support/state';

// 1.9.0 (Sprint 53, B-174 to B-176): the Proposals tab of a group (list, a new proposal, voting, a secret ballot's
// receipt, results with the ranked-choice rounds and the published commitments) and the governance settings on the
// Overview. The views and their dialogs pass the WCAG checker and axe-core (Standard and Enhanced, light and dark) and
// reflow at 320 and 640 px. Voting time is ended in the server's database file rather than waited for.

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

/** Ends a proposal's voting time; the next read closes it. */
function endVoting(id: string): void {
  const file = serverState().dbFile;
  if (!file) throw new Error('the e2e server did not say where its database is');
  const db = new Database(file);
  try {
    db.prepare('UPDATE group_proposals SET closes_at = ? WHERE id = ?').run(Date.now() - 1, id);
  } finally {
    db.close();
  }
}

test.describe('Groups: proposals and voting (Sprint 53)', () => {
  test('an owner sets governance, proposes, opens voting and votes; the result is shown', async ({ page }) => {
    const name = `Commons ${Date.now()}`;
    const root = await apiAs('root');
    const member = await apiAs('member');
    const group = await root.post('/api/groups', { name, visibility: 'public', joinMode: 'open' });
    await member.post(`/api/groups/${group.id}/join`);

    // governance settings on the Overview
    await open(page, `groups?id=${group.id}`);
    await expectLive(page);
    await expect(page.locator('#main')).toContainText('Governance');
    await page.locator('[data-goveditsettings]').click();
    await page.locator('[data-gmin]').fill('1');
    await page.locator('[data-grules]').fill('Share the tools. Close the gate.');
    await accessible(page, 'groups: the governance dialog');
    await reflow(page, 'groups: the governance dialog');
    await page.locator('#overlay [data-gsave]').click();
    await toast(page, /Governance saved/);
    await settle(page);
    await accessible(page, 'groups: the Overview with governance');

    // a proposal drafted in the console
    await page.locator('[data-tab="proposals"]').click();
    await settle(page);
    await expect(page.locator('#main')).toContainText('Share the tools.');
    await page.locator('[data-govnew]').click();
    await page.locator('[data-ptitle]').fill('Buy a wheelbarrow');
    await page.locator('[data-pbody]').fill('The old one has a flat tyre.');
    await accessible(page, 'groups: the new proposal dialog');
    await reflow(page, 'groups: the new proposal dialog');
    await page.locator('#overlay [data-psave]').click();
    await toast(page, /Draft created/);
    await settle(page);
    await expect(page.locator('#main')).toContainText('Buy a wheelbarrow');
    await page.locator('[data-govopen]').click();
    await confirmDialog(page, 'Open voting');
    await toast(page, /Voting is open/);
    await settle(page);
    await page.locator('[data-govyn][value="yes"]').check();
    await accessible(page, 'groups: the Proposals tab while voting');
    await reflow(page, 'groups: the Proposals tab while voting');
    await page.locator('[data-govvote]').click();
    await toast(page, /Vote recorded/);
    const list = await root.get(`/api/groups/${group.id}/proposals`);
    const pr = list.proposals.find((x: { title: string }) => x.title === 'Buy a wheelbarrow');
    await member.post(`/api/group-proposals/${pr.id}/ballots`, { choice: 'no' });

    endVoting(pr.id);
    await open(page, `groups?id=${group.id}&tab=proposals&proposal=${pr.id}`);
    await expect(page.locator('#main')).toContainText('1 yes and 1 no: a tie does not pass.');
    await expect(page.locator('#main')).toContainText('Ballots');
    await accessible(page, 'groups: a closed public proposal');
    await reflow(page, 'groups: a closed public proposal');
    await root.close();
    await member.close();
  });

  test('a secret ranked vote gives a receipt that is found in the published commitments', async ({ page }) => {
    const name = `Colours ${Date.now()}`;
    const root = await apiAs('root');
    const member = await apiAs('member');
    const group = await root.post('/api/groups', { name, visibility: 'public', joinMode: 'open' });
    await member.post(`/api/groups/${group.id}/join`);
    const pr = await root.post(`/api/groups/${group.id}/proposals`, { kind: 'free', title: 'Paint the shed', method: 'ranked', options: ['Red', 'Green', 'Blue'], secret: true });
    await root.post(`/api/group-proposals/${pr.id}/open`, {});
    await member.post(`/api/group-proposals/${pr.id}/ballots`, { choice: ['o3', 'o2'] });

    await open(page, `groups?id=${group.id}&tab=proposals&proposal=${pr.id}`);
    await expectLive(page);
    await page.locator('[data-govrank="o2"]').selectOption('1');
    await page.locator('[data-govrank="o1"]').selectOption('2');
    await page.locator('[data-govvote]').click();
    await toast(page, /Keep your receipt/);
    await settle(page);
    await expect(page.locator('#main')).toContainText('Your receipt');
    await accessible(page, 'groups: a secret ballot with its receipt');
    await reflow(page, 'groups: a secret ballot with its receipt');

    endVoting(pr.id);
    await page.reload();
    await open(page, `groups?id=${group.id}&tab=proposals&proposal=${pr.id}`);
    await expect(page.locator('#main')).toContainText('Published commitments');
    await expect(page.locator('#main')).toContainText('yours');
    await page.locator('[data-govcheck]').click();
    await expect(page.locator('#main')).toContainText('Your commitment is in the published list with your choice');
    await expect(page.locator('#main')).toContainText('Round');
    await accessible(page, 'groups: a closed secret ranked vote');
    await reflow(page, 'groups: a closed secret ranked vote');
    await root.close();
    await member.close();
  });
});
