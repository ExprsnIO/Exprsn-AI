import { test, expect, open, expectLive, toast, apiAs } from './support/fixtures';
import { expectAxeClean } from './support/axe';

test.describe('Runs', () => {
  test.beforeAll(async () => {
    // A published agent to run: authored by root, approved by root2 (the registry's dual control).
    const author = await apiAs('root');
    const reviewer = await apiAs('root2');
    const e = await author.post('/api/admin/registry', { kind: 'agent', name: 'Travel desk', version: '1.0.0', description: 'Answers questions about travel bookings and the travel policy for the finance team.', label: 'internal', definition: { profile: 'general', systemPrompt: 'Be exact.', tools: ['calculate'], skills: [], budgets: { steps: 10, tokens: 10000, wallSeconds: 120, toolCalls: 4 } } });
    await author.post(`/api/admin/registry/${e.id}/submit`);
    await reviewer.post(`/api/admin/registry/${e.id}/review`, { decision: 'approve', scope: 'tenant', workspaces: [] });
    await author.close();
    await reviewer.close();
  });

  test('starts a run of a published agent and follows it to its answer', async ({ page }) => {
    await open(page, 'runs');
    await expectLive(page);
    // The left pane's Start (the empty state's "Start a run" is gone once the chain spec has started runs).
    await page.locator('#main [data-start]').first().click();
    const modal = page.locator('#overlay .modal');
    await expect(modal).toContainText('Start an agent run');
    await modal.locator('[data-agent]').selectOption({ label: 'Travel desk 1.0.0' });
    await modal.locator('[data-input]').fill('Which hotels are within the Berlin rate cap?');
    await modal.locator('[data-ok]').click();
    await toast(page, 'Run started');
    await expect(page.locator('#main').getByText('Fake answer to: Which hotels are within the Berlin rate cap?').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.runs-list [data-run]').first()).toContainText(/succeeded/);
  });
});

// 1.7.0, Sprint 41c (B-11703, B-11705, B-11708): a plan-first agent drafts its plan as its first step and waits; the
// owner approves it and the run follows it; its thinking level shows per step.
test.describe('plan-first runs', () => {
  test.beforeAll(async () => {
    const author = await apiAs('root');
    const reviewer = await apiAs('root2');
    // A published profile on the template model (the only one that thinks), ceiling medium, for an agent at low.
    const profiles = (await author.get('/api/admin/profiles')) as { id: string; name: string; poolId: string | null }[];
    if (!profiles.some((p) => p.name === 'thinker')) {
      const models = (await author.get('/api/admin/models')) as { id: string; name: string }[];
      const magistral = models.find((m) => m.name === 'magistral:24b')!;
      const general = profiles.find((p) => p.name === 'general')!;
      const p = (await author.post('/api/admin/profiles', { name: 'thinker', displayName: 'Thinker', description: 'Thinks before it answers.', modelId: magistral.id, poolId: general.poolId, label: 'internal', thinkDefault: 'low', thinkCeiling: 'medium', tools: ['calculate'] })) as { id: string };
      await author.post(`/api/admin/profiles/${p.id}/publish`, { status: 'published' });
    }
    const e = await author.post('/api/admin/registry', { kind: 'agent', name: 'Planner desk', version: '1.0.0', description: 'Plans before it acts: answers travel questions for the finance team after an approved plan.', label: 'internal', definition: { profile: 'thinker', systemPrompt: 'Be exact.', tools: ['calculate'], skills: [], planFirst: true, think: 'low', budgets: { steps: 10, tokens: 10000, wallSeconds: 120, toolCalls: 4 } } });
    await author.post(`/api/admin/registry/${e.id}/submit`);
    await reviewer.post(`/api/admin/registry/${e.id}/review`, { decision: 'approve', scope: 'tenant', workspaces: [] });
    await author.close();
    await reviewer.close();
  });

  test('B-11703, B-11705: a plan-first run waits on its plan, follows it once approved, and shows the thinking level per step', async ({ page }) => {
    await open(page, 'runs');
    await expectLive(page);
    await page.locator('#main [data-start]').first().click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-agent]').selectOption({ label: 'Planner desk 1.0.0' });
    await modal.locator('[data-input]').fill('What is the Berlin rate cap times three?');
    await modal.locator('[data-ok]').click();
    await toast(page, 'Run started');
    const plan = page.locator('.runs-card.waiting').first();
    await expect(plan).toContainText('Plan', { timeout: 30_000 });
    await expect(plan).toContainText('draft, waiting');
    await expect(page.locator('#main')).toContainText('Waiting for the plan to be approved');
    await plan.click();
    const inspector = page.locator('#main .inspector');
    await expect(inspector).toContainText('Work out the figure exactly');
    await expect(inspector).toContainText('calculate');
    await expect(inspector.locator('[data-planapprove]')).toBeVisible();
    await expectAxeClean(page, 'aa', 'runs with a plan awaiting approval');
    await inspector.locator('[data-planapprove]').click();
    await page.locator('#overlay .modal [data-ok]').click();
    await toast(page, /Plan approved/);
    await expect(page.locator('.runs-list [data-run]').first()).toContainText(/succeeded/, { timeout: 30_000 });
    // The run followed the plan: the calculation it named, then the answer.
    await expect(page.locator('.runs-card').filter({ hasText: 'calculate' }).first()).toBeVisible();
    await expect(page.locator('.runs-card').filter({ hasText: 'Answer' }).first()).toBeVisible();
    // The plan step is approved and a later thinking step carries its level.
    await expect(page.locator('.runs-card').filter({ hasText: 'draft, approved' }).first()).toBeVisible();
    const think = page.locator('.runs-card').filter({ hasText: 'low, ' }).first();
    await expect(think).toBeVisible();
    await think.click();
    await expect(inspector).toContainText('Thinking');
    await expect(inspector).toContainText('low');
    // The chain view: the run's node carries its thinking level and the approved plan as its step list.
    await page.locator('#main').getByRole('button', { name: 'Chain tree' }).first().click();
    const tree = page.locator('#main ul.runs-tree[aria-label="Chain tree"]');
    await expect(tree).toBeVisible();
    await tree.locator('.runs-node', { hasText: 'Planner desk' }).first().click();
    const node = page.locator('#main .inspector');
    await expect(node).toContainText('low level');
    await expect(node).toContainText('Work out the figure exactly');
    await expectAxeClean(page, 'aa', 'chain view with a node\'s thinking level and plan');
  });
});
