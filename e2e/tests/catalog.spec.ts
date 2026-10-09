import { test, expect, open, expectLive, apiAs, toast, ready, type Page } from './support/fixtures';
import { expectAccessible } from './support/a11y';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';

// 1.7.0, Sprint 41d (B-12301, B-12302): the catalogue. Root publishes a workflow with its catalogue fields and a
// confidential agent (root2 approves it). The member (clearance internal) gets one notice linking to the workflow's
// entry, sees it on the catalogue with its call and example, opens Chat with it filled in, and never sees the
// confidential agent; root does. axe-core, the in-page checker and the reflow checks at 320 and 640 px cover the page,
// and the member's notice choice is set in Settings.

const WORKFLOW = 'summarise-contract';
const graph = {
  nodes: [
    { id: 'trigger', kind: 'trigger', title: 'Trigger', x: 20, y: 24, config: { source: 'api' }, output: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    { id: 'shape', kind: 'transform', title: 'Shape', x: 230, y: 24, config: { fields: { summary: 'Summary of {{input.text}}' } } }
  ],
  edges: [{ from: 'trigger', to: 'shape' }],
  limits: {}
};

async function checkPage(page: Page, where: string): Promise<void> {
  await expectAccessible(page, where);
  await expectAxeClean(page, 'aa', where);
  for (const width of [320, 640]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(250);
    expect(await reflowProblems(page), `${where} at ${width} px`).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test.describe('Catalogue', () => {
  test.describe.configure({ mode: 'serial' });
  test.beforeAll(async () => {
    const root = await apiAs('root');
    const root2 = await apiAs('root2');
    const member = await apiAs('member');
    // Publish into the member's workspace.
    const ws = (await member.get('/api/me')).workspace as string;
    if ((await root.get('/api/me')).workspace !== ws) await root.put('/api/me/workspace', { workspaceId: ws });
    const w = await root.post('/api/workflows', { name: WORKFLOW, description: 'Summarises a contract: the parties, the term, the obligations and the risks.', label: 'internal' });
    await root.put(`/api/workflows/${w.id}/draft`, { graph });
    await root.put(`/api/workflows/${w.id}/discovery`, { purpose: 'Read a contract and get a one-page summary you can forward.', examples: ['Summarise this contract for me', 'What are the termination terms?'], category: 'Documents' });
    await root.post(`/api/workflows/${w.id}/publish`, {});
    const agent = await root.post('/api/admin/registry', { kind: 'agent', name: 'Deal desk', version: '1.0.0', description: 'Prices a deal against the rate card and lists the approvals it needs.', label: 'confidential', definition: { profile: 'general', systemPrompt: 'Be exact.', tools: [], budgets: { steps: 6, tokens: 4000, wallSeconds: 60, toolCalls: 2 } }, purpose: 'A price and the approvals a deal needs.', examples: ['Price this deal'], category: 'Finance' });
    await root.post(`/api/admin/registry/${agent.id}/submit`);
    await root2.post(`/api/admin/registry/${agent.id}/review`, { decision: 'approve', scope: 'tenant', workspaces: [] });
    await root.close();
    await root2.close();
    await member.close();
  });

  test.describe('as a member', () => {
    test.use({ user: 'member' });

    test('B-12301, B-12302: a member is notified once, sees the new workflow with its call, opens Chat with it filled in, and never an entry above their clearance', async ({ page }) => {
      // One notice for the workflow, linking to its entry; none for the confidential agent.
      const api = await apiAs('member');
      const titles = ((await api.get('/api/me/notifications')).items as { title: string; route: string }[]);
      await api.close();
      const notice = titles.filter((n) => n.title === `Workflow ${WORKFLOW} is now available to you`);
      expect(notice).toHaveLength(1);
      expect(notice[0]!.route).toBe(`catalog?entry=workflow%3A${WORKFLOW}`);
      expect(titles.map((n) => n.title)).not.toContain('Agent Deal desk is now available to you');

      // The notice's link opens the catalogue on the entry.
      await open(page, notice[0]!.route);
      await expectLive(page);
      await expect(page.getByRole('heading', { name: 'What you can do' })).toBeVisible();
      const card = page.locator(`.cat-card[data-entry="workflow:${WORKFLOW}"]`);
      await expect(card).toBeVisible();
      await expect(card).toContainText(`/${WORKFLOW}`);
      await expect(card).toContainText('"Summarise this contract for me"');
      await expect(card).toContainText('new');
      await expect(page.locator('section', { has: card }).getByRole('heading', { level: 2 })).toHaveText('Documents');
      const insp = page.locator('.cat-insp');
      await expect(insp).toContainText('Read a contract and get a one-page summary you can forward.');
      await expect(insp).toContainText('What are the termination terms?');
      // Above the member's clearance: not listed at all.
      await expect(page.locator('.cat-card[data-entry="agent:Deal desk"]')).toHaveCount(0);
      await expect(page.locator('#main')).not.toContainText('Deal desk');
      await checkPage(page, 'catalogue as a member');

      // Search and the kind filter.
      await page.locator('[data-search]').fill('termination');
      await expect(page.locator('.cat-card')).toHaveCount(1);
      await page.locator('[data-search]').fill('');
      await page.locator('[data-kind] [data-seg="agent"]').click();
      await expect(page.locator(`.cat-card[data-entry="workflow:${WORKFLOW}"]`)).toHaveCount(0);
      await page.locator('[data-kind] [data-seg="all"]').click();

      // Use in Chat: a new conversation with the composer holding the call and the example.
      await card.getByRole('button', { name: `Use ${WORKFLOW} in Chat` }).click();
      await ready(page, 'chat');
      await expect(page.locator('#ch-composer')).toHaveValue(`/${WORKFLOW} Summarise this contract for me`);
      await expect(page.locator('.ch-head .t')).toHaveText('New conversation');
    });

    test('B-12302: the member chooses a weekly digest for notices in Settings', async ({ page }) => {
      await open(page, 'settings');
      await expectLive(page);
      const group = page.getByRole('group', { name: 'Notices about new things you can use' });
      await expect(group).toBeVisible();
      await group.getByRole('button', { name: 'Weekly digest' }).click();
      await toast(page, 'Weekly digest on');
      await expect(page.locator('#main')).toContainText('One notice a week lists what was published');
      await page.reload();
      await ready(page, 'settings');
      await expect(page.getByRole('group', { name: 'Notices about new things you can use' }).getByRole('button', { name: 'Weekly digest' })).toHaveClass(/active/);
      await page.getByRole('group', { name: 'Notices about new things you can use' }).getByRole('button', { name: 'As they happen' }).click();
      await toast(page, 'Notices as they happen');
    });
  });

  test('B-12301: root (restricted clearance) sees the confidential agent; the embedding profile is not offered as a chat profile', async ({ page }) => {
    await open(page, 'catalog');
    await expectLive(page);
    await expect(page.locator('.cat-card[data-entry="agent:Deal desk"]')).toContainText('@Deal desk');
    await page.locator('.cat-card[data-entry="agent:Deal desk"] [data-open]').click();
    await expect(page.locator('.cat-insp')).toContainText('A price and the approvals a deal needs.');
    const sel = page.locator('#cat-profile');
    await expect(sel).toBeVisible();
    const options = await sel.locator('option').allTextContents();
    expect(options.length).toBeGreaterThan(0);
    // The embedding profile is not a chat profile and is not offered.
    expect(options).not.toContain('Embed');
    await checkPage(page, 'catalogue as root');
  });
});
