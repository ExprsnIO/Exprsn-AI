import { test, expect, open, expectLive, toast, confirmDialog, apiAs, settle, type Page } from './support/fixtures';
import { expectAccessible } from './support/a11y';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';
import { serverState } from './support/state';

// B-4008 (agents, tools and skills in chat): the composer's pickers and the cards of a conversation, end to end.
// An agent run started with "@" shows as a run card, appears in Runs with a link back, and its answer lands in the
// conversation; a tool call the tool-call guardrail holds shows as held and runs only after a reviewer other than the
// caller approves its flag; a skill added with "+" shows as a chip and is removed again. The caller is root (as in the
// Chat spec: the seeded profiles are cleared for it) and the reviewer root2; the agent, the skill and the guardrail
// rule are published by root and approved by root2 before the tests.

const AGENT = 'Ledger helper';
const SKILL = 'e2e-ledger-style';
// The rule holds exactly this calculation, so no other spec's tool call meets it.
const HELD_EXPRESSION = '4008 + 40';
// The conversations the tests start, deleted afterwards: this file runs before chat.spec.ts, which starts from an
// empty conversation list.
const made = new Set<string>();
const keep = (page: Page) => { const m = /^#\/chat\?id=([^&]+)/.exec(new URL(page.url()).hash); if (m) made.add(decodeURIComponent(m[1]!)); };

async function pickGeneral(page: Page): Promise<void> {
  await page.locator('[data-pick="profile"]').click();
  await page.locator('.ch-dd [data-prof="general"]').click();
  await expect(page.locator('[data-pick="profile"]')).toContainText('general');
  await settle(page);
}

/** The in-page checker, axe-core and reflow at 320 and 640 px, for what the page shows now. */
async function check(page: Page, where: string): Promise<void> {
  // A toast that is fading in or out is read at a blended colour: wait for the toasts to go.
  await expect(page.locator('#toasts .toast')).toHaveCount(0, { timeout: 20_000 });
  await expectAccessible(page, where);
  await expectAxeClean(page, 'aa', where);
  for (const width of [320, 640]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(250);
    expect(await reflowProblems(page), `${where} at ${width} px`).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test.describe('Chat: agents, tools and skills', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    const author = await apiAs('root');
    const reviewer = await apiAs('root2');
    // A retry runs this again on the same server: what is already there (409) is kept.
    const once = async (fn: () => Promise<void>) => { try { await fn(); } catch (err) { if (!/-> 409 /.test(String(err))) throw err; } };
    const publish = (body: object) => once(async () => {
      const e = await author.post('/api/admin/registry', body);
      await author.post(`/api/admin/registry/${e.id}/submit`);
      await reviewer.post(`/api/admin/registry/${e.id}/review`, { decision: 'approve', scope: 'tenant', workspaces: [] });
    });
    await publish({ kind: 'agent', name: AGENT, version: '1.0.0', description: 'Answers questions about the ledger and reports the result plainly.', label: 'internal', definition: { profile: 'general', systemPrompt: 'Be exact.', tools: [], skills: [], budgets: { steps: 10, tokens: 10_000, wallSeconds: 120, toolCalls: 4 } } });
    await publish({ kind: 'skill', name: SKILL, version: '1.0.0', description: 'Amounts in EUR net of VAT, dates written out in full.', label: 'internal', definition: { instructions: 'Write amounts in EUR net of VAT and dates in full.', tools: [] } });
    // A tool-call rule that holds one calculation for a reviewer. The set belongs to the workspace, so the tenant's own
    // set stays the one the Guardrails screen (and its design states) opens first.
    await once(async () => {
      const set = await author.post('/api/admin/guardrails/sets', { name: 'Chat tool holds (e2e)', scope: 'workspace', workspaceId: serverState().workspace.id });
      await author.put(`/api/admin/guardrails/sets/${set.id}/draft`, { rules: [{ id: 'hold-4008', name: 'Hold the 4008 calculation', checkpoint: 'tool-call', type: 'pattern', mechanism: { kind: 'pattern', pattern: '4008 \\+ 40' }, action: 'require-approval', stage: 'enforce', severity: 'medium' }] });
      await author.post(`/api/admin/guardrails/sets/${set.id}/draft/publish`);
    });
    await author.close();
    await reviewer.close();
  });

  test.afterAll(async () => {
    const owner = await apiAs('root');
    for (const id of made) await owner.del(`/api/conversations/${id}`).catch(() => undefined);
    await owner.close();
  });

  test('an agent run started with @ shows as a run card, appears in Runs with a link back, and its answer lands in the conversation', async ({ page }) => {
    test.setTimeout(120_000);
    await open(page, 'chat');
    await expectLive(page);
    await pickGeneral(page);
    const composer = page.locator('#ch-composer');

    // The picker is a list box the composer controls; typing narrows it, and it is worked from the keyboard.
    await composer.click();
    await composer.pressSequentially('@led');
    const list = page.locator('#ch-pk [role="listbox"]');
    await expect(list.getByRole('option', { name: /Ledger helper/ })).toHaveAttribute('aria-selected', 'true');
    await expect(composer).toHaveAttribute('aria-expanded', 'true');
    await expect(composer).toHaveAttribute('aria-controls', 'ch-pk');
    await expect(composer).toHaveAttribute('aria-activedescendant', 'ch-pko-0');
    await expectAccessible(page, 'chat with the agent picker open');
    await expectAxeClean(page, 'aa', 'chat with the agent picker open');
    // Esc closes it and leaves the text; typing on opens it again once the trigger is retyped.
    await composer.press('Escape');
    await expect(page.locator('#ch-pk')).toHaveCount(0);
    await expect(composer).not.toHaveAttribute('aria-expanded', 'true');
    await composer.fill('');
    await composer.pressSequentially('@led');
    await composer.press('Enter');
    await expect(page.locator('[data-region="caps"]')).toContainText(`To ${AGENT}`);
    await expect(composer).toBeFocused();

    await composer.pressSequentially('Which ledger accounts closed late in September?');
    await composer.press('Enter');
    await toast(page, 'Run started with ' + AGENT);
    const card = page.locator('[data-invcard]').last();
    await expect(card).toContainText(AGENT);
    keep(page);
    await expect(card).toContainText('agent run');
    // Steps stream in, then the answer is attributed to the agent.
    await expect(card.locator('.ch-answer')).toContainText('Fake answer to: Which ledger accounts closed late in September?', { timeout: 60_000 });
    await expect(card).toContainText(`Answer from ${AGENT}`);
    await expect(card.locator('.ch-steps li').first()).toBeVisible();
    await expect(card.locator('.pill', { hasText: /^done$/ }).first()).toBeVisible();
    // A message of an invocation offers neither Edit nor Regenerate (the server refuses both).
    await expect(page.locator('.ch-msg [data-edit]')).toHaveCount(0);
    await expect(page.locator('.ch-msg [data-regen]')).toHaveCount(0);
    await settle(page);
    await page.emulateMedia({ colorScheme: 'light' });
    await check(page, 'chat with a run card (light)');
    await page.emulateMedia({ colorScheme: 'dark' });
    await check(page, 'chat with a run card (dark)');
    await page.emulateMedia({ colorScheme: 'light' });

    // The run is in Runs, and links back to the conversation.
    const conversation = new URL(page.url()).hash;
    expect(conversation).toMatch(/^#\/chat\?id=/);
    await page.locator('[data-invcard]').last().getByRole('link', { name: 'Open in Runs' }).click();
    await expect(page.locator('#main')).toContainText(`, ${AGENT} 1.0.0`);
    await expect(page.locator('#main').getByText('Fake answer to: Which ledger accounts closed late in September?').first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole('link', { name: 'Open the conversation' }).click();
    await expect(page.locator('[data-invcard]').last()).toContainText(`Answer from ${AGENT}`);
    expect(new URL(page.url()).hash).toBe(conversation);

    // The conversation is kept: a reload shows the card and the answer again.
    await page.reload();
    await expect(page.locator('[data-invcard]').last().locator('.ch-answer')).toContainText('Fake answer to: Which ledger accounts closed late in September?');
  });

  test('a tool call the guardrail holds shows as held, and runs only after a reviewer approves the flag', async ({ page, as }) => {
    test.setTimeout(120_000);
    await open(page, 'chat');
    await expectLive(page);
    await page.locator('[data-new]').click();
    await pickGeneral(page);
    const composer = page.locator('#ch-composer');
    await composer.click();
    await composer.pressSequentially('/calc');
    const option = page.locator('#ch-pk').getByRole('option', { name: /calculate/ });
    await expect(option).toHaveAttribute('aria-selected', 'true');
    await expect(option).toContainText('read');
    await composer.press('Enter');

    // The form comes from the tool's input schema.
    const modal = page.locator('#overlay .modal');
    await expect(modal).toContainText('Call calculate');
    const field = modal.locator('[data-arg="expression"]');
    await expect(field).toBeFocused();
    await expect(modal.getByText('expression (required)')).toBeVisible();
    // A required field left empty is said so, and nothing is sent.
    await modal.locator('[data-fgo]').click();
    await expect(modal).toContainText('expression is required.');
    await expectAccessible(page, 'the tool form');
    await expectAxeClean(page, 'aa', 'the tool form');
    await page.setViewportSize({ width: 320, height: 800 });
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => { const m = document.querySelector('#overlay .modal') as HTMLElement; return m.scrollWidth <= m.clientWidth + 1 && document.scrollingElement!.scrollWidth <= window.innerWidth + 1 && m.getBoundingClientRect().right <= window.innerWidth + 1; }), 'the tool form fits 320 px').toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });
    await field.fill(HELD_EXPRESSION);
    await modal.locator('[data-fgo]').click();
    await expect(modal).toHaveCount(0);

    // Held: the card names the flag, shows the exact arguments and no result.
    const card = page.locator('[data-invcard]').last();
    await expect(card).toBeVisible();
    keep(page);
    await expect(card.locator('.pill', { hasText: 'held for review' })).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText('Held for review.');
    await expect(card.locator('.ch-args')).toContainText(HELD_EXPRESSION);
    await expect(card.locator('.ch-res')).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    const flag = (await card.locator('.ch-held .mono').first().innerText()).trim();
    expect(flag).toMatch(/^F-\d+$/);
    await settle(page);
    await check(page, 'chat with a held tool call');

    // A reviewer other than the caller approves it in the flag queue.
    const review = await as('root2');
    await open(review, `flags?id=${flag}`);
    await expect(review.locator('#main')).toContainText('Held tool call');
    await expect(review.locator('#main .flags-answer.mono')).toContainText(HELD_EXPRESSION);
    await review.getByRole('button', { name: 'Approve call' }).click();
    await confirmDialog(review);
    await toast(review, `${flag} approved`);

    // The caller's card follows without a reload: the call ran and its result is shown.
    await expect(card.locator('.pill', { hasText: /^done$/ })).toBeVisible({ timeout: 30_000 });
    await expect(card.locator('.ch-res')).toContainText('4048');
    await expect(card).toContainText('Approved by');
  });

  test('a skill added with + shows as a chip and is removed again', async ({ page }) => {
    await open(page, 'chat');
    await expectLive(page);
    await page.locator('[data-new]').click();
    await pickGeneral(page);
    const composer = page.locator('#ch-composer');
    // The "+ skill" button puts the trigger in the composer; the picker opens with the published skill.
    await page.locator('[data-trigger="+"]').click();
    await expect(composer).toBeFocused();
    await composer.pressSequentially('e2e-led');
    await expect(page.locator('#ch-pk').getByRole('option', { name: new RegExp(SKILL) })).toHaveAttribute('aria-selected', 'true');
    await expectAccessible(page, 'chat with the skill picker open');
    await expectAxeClean(page, 'aa', 'chat with the skill picker open');
    await composer.press('Enter');
    await toast(page, `${SKILL} added`);
    const chip = page.locator(`[data-region="caps"] [data-skill="${SKILL}"]`);
    await expect(chip).toContainText('sticky');
    await expect(composer).toBeFocused();
    // The conversation was made for the skill, and the chip is still there after a reload.
    expect(new URL(page.url()).hash).toMatch(/^#\/chat\?id=/);
    keep(page);
    await page.reload();
    await expect(chip).toContainText('sticky');
    await settle(page);
    await check(page, 'chat with a skill chip');

    // For the next turn only: Shift and Enter in the picker.
    await composer.click();
    await composer.pressSequentially('+e2e-led');
    await expect(page.locator('#ch-pk').getByRole('option', { name: new RegExp(SKILL) })).toContainText('on');
    await composer.press('Shift+Enter');
    await expect(chip).toContainText('next turn only');

    await chip.getByRole('button', { name: `Remove the skill ${SKILL}` }).click();
    await toast(page, `${SKILL} removed`);
    await expect(chip).toHaveCount(0);
    await page.reload();
    await expect(page.locator('[data-trigger="+"]')).toBeVisible();
    await expect(chip).toHaveCount(0);
  });
});
