import { test, expect, open, expectLive, toast, confirmDialog, apiAs, settle, type Page } from './support/fixtures';
import { expectAccessible } from './support/a11y';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';

// B-4109: the chain tree in Runs. Three agents delegate down a chain (Chain planner → Chain broker → Chain clerk,
// each published by root and approved by root2); the clerk's write call (feed.post) is held three levels down. The
// fake model makes each agent's call from the "E2E-CALL" line in its system prompt (e2e/server.ts). The tree opens
// from the root run, passes axe-core and the in-page checker in light and dark and reflows at 320 and 640 px, and the
// held call is approved from the root. Then the registry's chain fields and used-by views, and a workflow whose
// delete is refused while a published agent lists it.

const BUDGETS = { steps: 10, tokens: 20_000, wallSeconds: 300, toolCalls: 4 };
const agent = (name: string, systemPrompt: string, def: Record<string, unknown> = {}) => ({ kind: 'agent', name, version: '1.0.0', description: `${name}: works on the September close task it is given and reports the result plainly.`, label: 'internal', definition: { profile: 'general', systemPrompt, tools: [], skills: [], budgets: BUDGETS, ...def }, purpose: 'Works on the September close.', examples: ['Close September'], category: 'Finance' });

let rootRun = '';
let workflowId = '';

async function checkTree(page: Page, where: string): Promise<void> {
  await expectAccessible(page, where);
  await expectAxeClean(page, 'aa', where);
  for (const width of [320, 640]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(250);
    expect(await reflowProblems(page), `${where} at ${width} px`).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test.describe('Runs: chains', () => {
  test.describe.configure({ mode: 'serial' });
  test.beforeAll(async () => {
    test.setTimeout(120_000);
    const author = await apiAs('root');
    const reviewer = await apiAs('root2');
    const publish = async (body: object) => {
      const e = await author.post('/api/admin/registry', body);
      await author.post(`/api/admin/registry/${e.id}/submit`);
      await reviewer.post(`/api/admin/registry/${e.id}/review`, { decision: 'approve', scope: 'tenant', workspaces: [] });
      return e;
    };
    await publish(agent('Chain clerk', 'You post notices. E2E-CALL feed_post {"body":"The September close is done."}', { tools: ['feed.post'] }));
    await publish(agent('Chain broker', 'You hand work on. E2E-CALL agent_Chain_clerk', { agents: ['Chain clerk'] }));
    await publish(agent('Chain planner', 'You plan the close. E2E-CALL agent_Chain_broker', { agents: ['Chain broker'] }));

    // A published workflow that a published agent lists: deleting it is refused.
    const w = await author.post('/api/workflows', { name: 'chain-close-notes', label: 'internal' });
    workflowId = w.id;
    const topic = { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] };
    await author.put(`/api/workflows/${w.id}/draft`, { graph: { nodes: [{ id: 'trigger', kind: 'trigger', title: 'Trigger', x: 20, y: 24, config: { source: 'api' }, output: topic }, { id: 'out', kind: 'transform', title: 'Shape the notes', x: 240, y: 24, config: { fields: { summary: 'Notes on {{input.topic}}' } } }], edges: [{ from: 'trigger', to: 'out' }], limits: {} } });
    await author.post(`/api/workflows/${w.id}/publish`);
    await publish(agent('Chain filer', 'You file the close notes.', { workflows: ['chain-close-notes'] }));

    const r = await author.post('/api/runs', { agent: 'Chain planner', input: 'Announce the September close.', label: 'internal' });
    rootRun = r.id;
    // The chain runs on the job workers until the clerk's write call is held.
    for (let i = 0; i < 120; i++) {
      const v = await author.get(`/api/runs/${rootRun}`);
      if ((v.held ?? []).length) break;
      await new Promise((x) => setTimeout(x, 500));
    }
    await author.close();
    await reviewer.close();
  });

  test('a three-level chain opens as a tree from its run, and the call held three levels down is approved from the root', async ({ page }) => {
    test.setTimeout(180_000);
    await open(page, `runs?run=${rootRun}`);
    await expectLive(page);
    const main = page.locator('#main');
    // The root run lists the held call with its path from the root.
    const held = main.locator('.notice', { hasText: 'Held down the chain' });
    await expect(held).toBeVisible();
    await expect(held).toContainText('feed.post');
    await expect(held.locator('.runs-path')).toContainText('Chain planner');
    await expect(held.locator('.runs-path')).toContainText('Chain clerk');
    await expect(main.getByText('Delegated and started')).toBeVisible();

    await main.getByRole('button', { name: 'Chain tree' }).first().click();
    const tree = main.locator('ul.runs-tree[aria-label="Chain tree"]');
    await expect(tree).toBeVisible();
    await settle(page);
    for (const name of ['Chain planner', 'Chain broker', 'Chain clerk']) await expect(tree.locator('.runs-node', { hasText: name }).first()).toBeVisible();
    // Three agent runs, one under another.
    await expect(tree.locator('.runs-node', { hasText: 'agent run' })).toHaveCount(3);
    await expect(tree.locator('.runs-tree .runs-tree .runs-node', { hasText: 'Chain clerk' }).first()).toBeVisible();
    // The held node is selected first; its inspector offers the decision.
    await expect(page.locator('.inspector')).toContainText('Held here');
    await expect(page.locator('.inspector')).toContainText('feed.post');
    await expect(tree.locator('.runs-node.held')).toContainText('Chain clerk');

    await page.emulateMedia({ colorScheme: 'light' });
    await checkTree(page, 'chain tree (light)');
    await page.emulateMedia({ colorScheme: 'dark' });
    await checkTree(page, 'chain tree (dark)');
    await page.emulateMedia({ colorScheme: 'light' });

    // Selecting a node shows its usage and how it can be replayed.
    await tree.locator('.runs-node', { hasText: 'Chain planner' }).first().click();
    await expect(page.locator('.inspector')).toContainText('with what it called');
    await expect(page.locator('.inspector').getByRole('button', { name: 'Replay from this node' })).toBeVisible();

    // Approve from the root: the chain resumes and every run finishes.
    await main.locator('.notice', { hasText: 'Held down the chain' }).getByRole('button', { name: 'Approve' }).click();
    await confirmDialog(page, 'Approve');
    await toast(page, 'Approved from the root');
    await expect(async () => {
      await main.getByRole('button', { name: 'Refresh chain' }).click();
      await expect(tree.locator('.runs-node').first()).toContainText('succeeded', { timeout: 2_000 });
    }).toPass({ timeout: 60_000 });
    await expect(main.locator('.notice', { hasText: 'Held down the chain' })).toHaveCount(0);
    await expect(main.getByText(/token total, [\d,]+, equals what the chain metered/)).toBeVisible();
    await expect(tree.locator('.runs-node', { hasText: 'agent run' }).filter({ hasText: 'succeeded' })).toHaveCount(3);

    // Back to the root run: its answer carries the delegates' answers.
    await main.getByRole('button', { name: /Back to run/ }).click();
    await expect(main.locator('.runs-list [data-run]').first()).toBeVisible();
  });

  test('the registry shows delegates and who uses an entry, and the editor sets an agent\'s chain fields', async ({ page }) => {
    await open(page, 'registry');
    await expectLive(page);
    await page.locator('[data-tab="agents"]').click();
    await page.locator('#main tr', { hasText: 'Chain broker' }).first().click();
    const insp = page.locator('.inspector');
    await expect(insp).toContainText('agent:Chain clerk');
    await expect(insp).toContainText('Chain references');

    // Used by: the clerk is what the broker delegates to.
    await page.locator('#main tr', { hasText: 'Chain clerk' }).first().click();
    await insp.getByRole('button', { name: 'Used by', exact: true }).click();
    const modal = page.locator('#overlay .modal');
    await expect(modal).toContainText('Used by: Chain clerk');
    await expect(modal.locator('tr', { hasText: 'Chain broker' })).toContainText('delegate');
    await modal.getByRole('button', { name: 'Close' }).click();

    // A draft agent with a delegate and an output schema, from the editor.
    await page.getByRole('button', { name: 'Submit entry' }).click();
    const form = page.locator('#overlay .modal');
    await form.locator('[data-kind]').selectOption('agent');
    await form.locator('[data-name]').fill('Chain reviewer');
    await form.locator('[data-version]').fill('0.1.0');
    await form.locator('[data-desc]').fill('Reviews the September close notice before it is posted and says what to change.');
    await form.locator('[data-label]').selectOption('internal');
    await form.locator('[data-profile]').fill('general');
    await form.locator('[data-delegates]').fill('Chain clerk');
    await form.locator('[data-workflows]').fill('chain-close-notes');
    await form.locator('[data-out]').fill('{ "type": "object", "properties": { "ok": { "type": "boolean" } }, "required": ["ok"] }');
    await form.getByRole('button', { name: 'Save draft and run checks' }).click();
    await toast(page, 'Draft Chain reviewer 0.1.0 saved');
    await expect(insp).toContainText('agent:Chain clerk');
    await expect(insp).toContainText('workflow:chain-close-notes');
    await expect(insp).toContainText('"required":["ok"]');
    await expect(insp.locator('.hstack', { hasText: 'Chain references' })).toBeVisible();
  });

  test('deleting a workflow a published agent lists is refused, naming the agent', async ({ page }) => {
    await open(page, `workflows?id=${workflowId}`);
    await expectLive(page);
    await page.locator('[data-tab="versions"]').click();
    await page.getByRole('button', { name: 'Delete workflow' }).click();
    const modal = page.locator('#overlay .modal');
    await expect(modal).toContainText('Delete refused');
    await expect(modal).toContainText('Chain filer');
    await expect(modal.getByRole('button', { name: 'Delete workflow' })).toBeDisabled();
    await modal.getByRole('button', { name: 'Cancel' }).click();
    await expect(modal).toHaveCount(0);
  });
});
