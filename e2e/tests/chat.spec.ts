import { test, expect, open, expectLive, ready, apiAs, toast } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { serverState } from './support/state';

test.describe('Chat', () => {
  test('sends a message and streams the answer from the fake Ollama', async ({ page }) => {
    await open(page, 'chat');
    await expectLive(page);
    await expect(page.getByText('No conversations yet')).toBeVisible();

    // Pick the General profile from the profile chip.
    await page.locator('[data-pick="profile"]').click();
    await page.locator('.ch-dd [data-prof="general"]').click();
    await expect(page.locator('[data-pick="profile"]')).toContainText('general · llama3.1:8b');

    await page.locator('#ch-composer').fill('What is the refund window?');
    await page.locator('#ch-composer').press('Enter');

    await expect(page.locator('.ch-msg.ch-user').last()).toContainText('What is the refund window?');
    const answer = page.locator('.ch-msg.ch-ai .ch-answer').last();
    await expect(answer).toContainText('Fake answer to: What is the refund window?', { timeout: 20_000 });
    await expect(page.locator('.ch-caret')).toHaveCount(0);

    // The conversation is kept: it is listed, and a reload opens it again with the answer.
    await expect(page.locator('[data-convo]').first()).toBeVisible();
    await page.reload();
    await ready(page, 'chat');
    await page.locator('[data-convo]').first().click();
    await expect(page.locator('.ch-msg.ch-ai .ch-answer').last()).toContainText('Fake answer to: What is the refund window?');
  });

  // 1.6.0, Sprint 39a (B-8001): the fenced blocks of an answer open as artifacts; a later turn that changes one adds
  // a version, the earlier one stays viewable, and the HTML renders in a sandboxed frame.
  test('opens an answer\'s artifacts in the side panel, with versions across turns', async ({ page }) => {
    await open(page, 'chat');
    await expectLive(page);
    await page.locator('[data-pick="profile"]').click();
    await page.locator('.ch-dd [data-prof="general"]').click();
    await page.locator('#ch-composer').fill('Make me an html page that says Hello');
    await page.locator('#ch-composer').press('Enter');
    await expect(page.locator('.ch-msg.ch-ai .ch-answer').last()).toContainText('Here is the page.', { timeout: 20_000 });
    await expect(page.locator('.ch-caret')).toHaveCount(0);

    // Chips under the answer and the list in the inspector.
    const chip = page.locator('.ch-arts [data-art]').filter({ hasText: 'index.html' }).first();
    await expect(chip).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.ch-art .alist [data-art]')).toHaveCount(2);
    await chip.click();
    const frame = page.frameLocator('.ch-art iframe[sandbox="allow-scripts"]');
    await expect(frame.locator('h1[data-greeting]')).toHaveText('Hello from the artifact');
    await expect(page.locator('.ch-art .ch-artmeta')).toContainText('version 1 of 1');
    await expectAxeClean(page, 'aa', 'chat with an artifact open');

    // The helper script is shown as text.
    await page.locator('.ch-art .alist [data-art]').filter({ hasText: 'js-1' }).click();
    await expect(page.locator('.ch-art pre[data-artbody]')).toContainText("export function greet(name)", { timeout: 10_000 });

    // A later turn changes the page: version 2, and version 1 stays viewable.
    await page.locator('#ch-composer').fill('Make the html page say Goodbye instead');
    await page.locator('#ch-composer').press('Enter');
    await expect(page.locator('.ch-msg.ch-ai .ch-answer').last()).toContainText('Here is the page.', { timeout: 20_000 });
    await expect(page.locator('.ch-caret')).toHaveCount(0);
    const chip2 = page.locator('.ch-arts [data-art][data-ver="2"]').filter({ hasText: 'index.html' });
    await expect(chip2).toBeVisible({ timeout: 10_000 });
    await chip2.click();
    await expect(frame.locator('h1[data-greeting]')).toHaveText('Goodbye from the artifact');
    await expect(page.locator('.ch-art .ch-artmeta')).toContainText('version 2 of 2');
    await page.locator('.ch-art [data-artprev]').click();
    await expect(frame.locator('h1[data-greeting]')).toHaveText('Hello from the artifact');
    await expect(page.locator('.ch-art .ch-artmeta')).toContainText('version 1 of 2');
    // The helper did not change: still one version.
    await expect(page.locator('.ch-art .alist [data-art]').filter({ hasText: 'js-1' })).toContainText('1 version');
  });

  // 1.7.0, Sprint 40a (B-4008): tools, agents, skills and workflows from the composer: "/" calls a tool whose result
  // is a tool turn, a write tool waits on an approval card, "+" adds a skill chip, "@" starts an agent run whose
  // answer is a turn attributed to the agent and links to Runs; axe-core and the reflow checks cover the cards.
  test.describe('tools, agents and skills from the composer', () => {
    test.beforeAll(async () => {
      const author = await apiAs('root');
      const reviewer = await apiAs('root2');
      // A published skill and agent (the registry's dual control), and the fake MCP server's write tool on the General profile.
      const skill = await author.post('/api/admin/registry', { kind: 'skill', name: 'Concise', version: '1.0.0', description: 'Answers in one sentence with the figure first and the source second.', label: 'internal', definition: { instructions: 'Answer in one sentence.', tools: [] } });
      await author.post(`/api/admin/registry/${skill.id}/submit`);
      await reviewer.post(`/api/admin/registry/${skill.id}/review`, { decision: 'approve', scope: 'tenant', workspaces: [] });
      const agent = await author.post('/api/admin/registry', { kind: 'agent', name: 'Concierge', version: '1.0.0', description: 'Answers questions about bookings and the travel policy for the finance team.', label: 'internal', definition: { profile: 'general', systemPrompt: 'You are the concierge.', tools: [], budgets: { steps: 6, tokens: 4000, wallSeconds: 60, toolCalls: 2 } } });
      await author.post(`/api/admin/registry/${agent.id}/submit`);
      await reviewer.post(`/api/admin/registry/${agent.id}/review`, { decision: 'approve', scope: 'tenant', workspaces: [] });
      const srv = (await author.post('/api/admin/mcp-servers', { name: 'crm', url: serverState().fakes.mcp })) as { id: string };
      await author.post(`/api/admin/mcp-servers/${srv.id}/tools/lookup_invoice/approve`, { sideEffect: 'read', confirm: 'never', label: 'internal' });
      await author.post(`/api/admin/mcp-servers/${srv.id}/tools/send_reminder/approve`, { sideEffect: 'write', confirm: 'always', label: 'internal' });
      await author.post(`/api/admin/mcp-servers/${srv.id}/bind`, { profileId: 'GENERAL'.padEnd(26, '0') });
      await author.close();
      await reviewer.close();
    });

    test('calls a tool, approves a write tool from its card, adds a skill chip and starts an agent from the composer', async ({ page }) => {
      await open(page, 'chat');
      await expectLive(page);
      await page.locator('[data-pick="profile"]').click();
      await page.locator('.ch-dd [data-prof="general"]').click();
      await page.locator('#ch-composer').fill('What is the refund window?');
      await page.locator('#ch-composer').press('Enter');
      await expect(page.locator('.ch-msg.ch-ai .ch-answer').last()).toContainText('Fake answer to:', { timeout: 20_000 });
      await expect(page.locator('.ch-caret')).toHaveCount(0);

      // "/" opens the picker (keyboard-first); a read tool runs at once and its result is a tool turn.
      const composer = page.locator('#ch-composer');
      await composer.fill('/');
      const picker = page.locator('#ch-picker');
      await expect(picker).toBeVisible();
      await expect(picker.locator('[data-pickitem]')).toHaveCount(2);
      await composer.fill('/look');
      await expect(picker.locator('[data-pickitem]')).toHaveCount(1);
      await expect(picker.locator('[data-pickitem]').first()).toContainText('crm.lookup_invoice');
      await composer.press('Enter');
      const modal = page.locator('#overlay .modal');
      await expect(modal).toContainText('Call crm.lookup_invoice');
      await modal.locator('[data-arg="number"]').fill('INV-7');
      await modal.locator('[data-go]').click();
      const turn = page.locator('.ch-msg.ch-turn .ch-card.done').first();
      await expect(turn).toContainText('crm.lookup_invoice', { timeout: 15_000 });
      await expect(turn).toContainText('INV-7');
      await expect(turn).toContainText('called by you');

      // A write tool waits on a card; approving it from the chat runs it, and the result is a turn.
      await composer.fill('/send');
      await expect(picker.locator('[data-pickitem]')).toHaveCount(1);
      await composer.press('Enter');
      await expect(modal).toContainText('Call crm.send_reminder');
      await expect(modal).toContainText('write tool waits for your approval');
      await modal.locator('[data-arg="to"]').fill('ap@fabrikam.example');
      await modal.locator('[data-go]').click();
      const card = page.locator('.ch-card.awaiting').first();
      await expect(card).toContainText('crm.send_reminder', { timeout: 15_000 });
      await expect(card).toContainText('runs only on your approval');
      await expectAxeClean(page, 'aa', 'chat with a tool turn and an approval card');
      await card.locator('[data-approve]').click();
      await toast(page, /ran as you/);
      await expect(page.locator('.ch-msg.ch-turn .ch-card.done').filter({ hasText: 'crm.send_reminder' })).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('.ch-card.awaiting')).toHaveCount(0);

      // "+" adds a skill chip; removing it clears it.
      await composer.fill('+');
      await expect(picker.locator('[data-pickitem]').filter({ hasText: 'Concise' })).toBeVisible();
      await picker.locator('[data-pickitem]').filter({ hasText: 'Concise' }).click();
      await toast(page, /Skill Concise added/);
      const chip = page.locator('.ch-skills [data-rmskill="Concise"]');
      await expect(chip).toBeVisible();
      await expect(chip).toContainText('sticky');
      await chip.click();
      await toast(page, /Skill removed/);
      await expect(page.locator('.ch-skills [data-rmskill]')).toHaveCount(0);

      // "@" starts an agent run bound to the conversation; its answer is a turn attributed to the agent, with a Runs link.
      await composer.fill('@');
      await expect(picker.locator('[data-pickitem]').filter({ hasText: 'Concierge' })).toBeVisible();
      await composer.press('Enter');
      await expect(composer).toHaveValue('@Concierge: ');
      await composer.type('Which hotels are within the Berlin rate cap?');
      await composer.press('Enter');
      await toast(page, /Run started for Concierge/);
      const agentTurn = page.locator('.ch-msg.ch-turn').filter({ hasText: 'Concierge' }).last();
      await expect(agentTurn).toContainText('agent', { timeout: 10_000 });
      await expect(agentTurn.locator('.ch-answer')).toContainText('Fake answer to:', { timeout: 30_000 });
      await expect(agentTurn.locator('.ch-card.done')).toBeVisible();
      await expect(agentTurn.locator('[data-gorun]')).toBeVisible();
      await expectAxeClean(page, 'aa', 'chat with an agent turn');
      // Runs links back to the conversation.
      await agentTurn.locator('[data-gorun]').click();
      await ready(page, 'runs');
      await expect(page.locator('#main')).toContainText('Started from a conversation', { timeout: 15_000 });
      await page.locator('#main [data-goconv]').click();
      await ready(page, 'chat');
      await expect(page.locator('.ch-msg.ch-turn').filter({ hasText: 'Concierge' }).last()).toBeVisible();
    });
  });
});
