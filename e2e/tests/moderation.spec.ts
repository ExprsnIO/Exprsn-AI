import { test, expect, open, ready, expectLive, confirmDialog, toast, apiAs, settle } from './support/fixtures';
import { expectAccessible } from './support/a11y';
import { expectAxeClean } from './support/axe';
import { serverState } from './support/state';

// B-3405: Moderation is live. A queue made on the screen routes a member's report; the reviewer hides the reported
// message from the queue; the member appeals; the reviewer who hid it is refused (independence) and a second reviewer
// upholds the appeal from the screen, which restores the message.
test.describe('Moderation', () => {
  test('upholding an appeal from the screen restores the hidden object', async ({ page, as, watch }) => {
    test.setTimeout(120_000);
    // The reviewer who took the action may not claim its appeal: that refusal is part of the test.
    watch.allow.push(/POST \/api\/moderation\/appeals\/A-\d+\/review -> 403$/);
    const stamp = Date.now().toString(36);
    const queueName = `E2E reports ${stamp}`;

    await open(page, 'moderation');
    await expectLive(page);
    await expect(page.locator('#main h1')).toHaveText('Moderation');

    // A review queue for reports, made on the screen.
    await page.locator('[data-newqueue]').click();
    const modal = page.locator('#overlay .modal');
    await expect(modal).toBeVisible();
    await modal.locator('[data-qname]').fill(queueName);
    await modal.locator('[data-qkinds]').fill('report, reviewer');
    await modal.locator('[data-qsave]').click();
    await toast(page, `Queue ${queueName} created.`);
    await expect(page.locator('tr[data-queue]', { hasText: queueName })).toBeVisible();

    // The ML admin (a member too, cleared for the profile) writes a message and reports it; the report is routed to the new queue.
    const member = await apiAs('mladmin');
    const sent = await member.post('/api/chat', { content: `A message to moderate ${stamp}`, profile: 'general' });
    const report = await member.post('/api/moderation/reports', { type: 'message', id: sent.userMessageId, reason: 'Spam', note: `e2e ${stamp}` });
    expect(report.duplicate).toBe(false);

    // The reviewer finds it in the queue and hides the message.
    await page.reload();
    await ready(page, 'moderation');
    await page.locator('tr[data-queue]', { hasText: queueName }).click();
    await page.locator('tr[data-flag]', { hasText: report.flag.ref }).click();
    await expect(page.locator('aside.inspector')).toContainText(sent.userMessageId);
    await page.locator('[data-hide]').click();
    await confirmDialog(page, 'Hide');
    await toast(page, `${report.flag.ref} confirmed and the object hidden`);
    const view = async () => ((await member.get(`/api/conversations/${sent.conversationId}`)).messages as { id: string; state: string }[]).find((m) => m.id === sent.userMessageId)!;
    expect((await view()).state).toBe('hidden');

    // The owner appeals the action.
    const mine = await member.get('/api/moderation/mine');
    const action = (mine.actions as { id: string; objectId: string }[]).find((a) => a.objectId === sent.userMessageId)!;
    const appeal = await member.post('/api/moderation/appeals', { actionId: action.id, statement: `It was a quotation ${stamp}.` });

    // Whoever hid it may not review the appeal.
    await page.locator('[data-tab="appeals"]').click();
    await page.locator('tr[data-appeal]', { hasText: appeal.ref }).click();
    await expect(page.locator('aside.inspector')).toContainText(`It was a quotation ${stamp}.`);
    await page.locator('[data-review]').click();
    await expect(page.locator('#main .problem')).toContainText('Independence refused');

    // A second reviewer claims and upholds it from the screen; the message is restored.
    const other = await as('root2');
    await open(other, 'moderation');
    await other.locator('[data-tab="appeals"]').click();
    await other.locator('tr[data-appeal]', { hasText: appeal.ref }).click();
    await other.locator('[data-review]').click();
    await expect(other.locator('#toasts')).toContainText(`${appeal.ref} claimed.`);
    await other.locator('[data-decide="upheld"]').click();
    await confirmDialog(other, 'Uphold');
    await expect(other.locator('#main')).toContainText(`${appeal.ref} upheld.`);
    await expect(other.locator('#main')).toContainText('object restored');
    expect((await view()).state).not.toBe('hidden');
    await expect(other.locator('tr[data-appeal]', { hasText: appeal.ref })).toContainText('upheld');

    // The action shows as reversed on the Actions tab.
    await other.locator('[data-tab="actions"]').click();
    await expect(other.locator('tr[data-action]', { hasText: sent.userMessageId })).toContainText('reversed');
    await member.close();
  });

  // 1.6.0 (B-4701): a public form value the user-input guardrail holds waits in the moderation queue and is accepted
  // into a record from there.
  test('a held public form submission is accepted into a record from the queue', async ({ page }) => {
    test.setTimeout(120_000);
    const id = Date.now().toString(36);
    const api = await apiAs('root');
    const app = `held_${id}`;
    await api.post('/api/apps', { name: app, title: `Held ${id}`, workspaceId: serverState().workspace.id });
    await api.post(`/api/apps/${app}/entities`, { name: 'lead', label: 'internal', definition: { fields: [{ name: 'email', type: 'string', required: true, maxLength: 200 }, { name: 'note', type: 'string' }] } });
    await api.post(`/api/apps/${app}/forms`, { name: 'contact', title: `Contact ${id}`, entity: 'lead', definition: { fields: [{ field: 'email' }, { field: 'note' }] }, ratePerMinute: 100 });
    const pub = await api.post(`/api/apps/${app}/forms/contact/public`, { enabled: true });
    const set = await api.post('/api/admin/guardrails/sets', { name: `Held forms ${id}`, scope: 'tenant' });
    await api.put(`/api/admin/guardrails/sets/${set.id}/draft`, { rules: [{ id: `hold-${id}`, name: `Hold ${id}`, checkpoint: 'user-input', type: 'pattern', mechanism: { kind: 'pattern', pattern: `(?i)hold-me-${id}` }, action: 'require-approval', stage: 'enforce' }] });
    await api.post(`/api/admin/guardrails/sets/${set.id}/draft/publish`);
    const queue = await api.post('/api/moderation/queues', { name: `Held forms ${id}`, kinds: ['app-form-submission'], priority: 1, slaMinutes: 60, escalateTo: 'tenant' });
    const res = await api.ctx.post('/api/public/forms/submit', { data: { token: pub.token, values: { email: `x-${id}@example.test`, note: `Please hold-me-${id} for review` } } });
    expect(res.status()).toBe(202);

    await open(page, 'moderation');
    await page.locator('tr[data-queue]', { hasText: `Held forms ${id}` }).click();
    await page.locator('tr[data-flag]').first().click();
    const insp = page.locator('aside.inspector');
    await expect(insp).toContainText('Held submission');
    await expect(insp).toContainText(`Please hold-me-${id} for review`);
    await expect(insp).toContainText(`Contact ${id}`);
    await page.locator('[data-heldaccept]').click();
    await confirmDialog(page, 'Accept');
    await toast(page, /Accepted: record/);
    const accepted = (await api.get('/api/apps/held?state=accepted')).items as { form: { title: string }; recordId: string }[];
    const mine = accepted.find((h) => h.form.title === `Contact ${id}`)!;
    expect(mine.recordId).toBeTruthy();
    await expect(page.locator('tr[data-flag]')).toHaveCount(0);
    await api.del(`/api/moderation/queues/${queue.id}`);
    await api.close();
  });

  // The design states cover the queue and appeal views; the other tabs are checked here, with the data made above.
  test('every tab passes the WCAG checks and axe-core in Standard and Enhanced', async ({ page }) => {
    await open(page, 'moderation');
    for (const tab of ['queues', 'reports', 'appeals', 'actions', 'sanctions', 'providers', 'dead']) {
      await page.locator(`[data-tab="${tab}"]`).click();
      await settle(page);
      await expectAccessible(page, `moderation, ${tab}`);
      await expectAxeClean(page, 'aa', `moderation, ${tab}`);
      await page.evaluate(() => (window as unknown as { App: { setA11y(m: string): void } }).App.setA11y('aaa'));
      await expectAxeClean(page, 'aaa', `moderation, ${tab}, Enhanced`);
      await page.evaluate(() => (window as unknown as { App: { setA11y(m: string): void } }).App.setA11y('aa'));
    }
  });
});
