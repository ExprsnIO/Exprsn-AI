import { test, expect, open, expectLive, toast, apiAs } from './support/fixtures';

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
    await page.getByRole('button', { name: 'Start a run' }).click();
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
