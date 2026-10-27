import { test, expect, open, expectLive, confirmDialog, toast, apiAs, settle } from './support/fixtures';
import { expectAccessible } from './support/a11y';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';

// B-9404: a message the user-input guardrail holds shows to its sender as held, with Withdraw; the Moderation queue
// shows it with the conversation around it; a reviewer accepts it there and the sender's view changes without a reload.
test.describe('Held messages', () => {
  test('a reviewer accepts a held message from the queue and the sender sees it delivered live', async ({ page, as }) => {
    test.setTimeout(150_000);
    const id = Date.now().toString(36);
    const root = await apiAs('root');
    const member = await apiAs('member');
    const people = (await member.get('/api/social/people')) as { userId: string; username: string }[];
    const ines = people.find((p) => p.username === 'ops')!;
    expect(ines).toBeTruthy();

    // A rule that holds one phrase, and a review queue for what it holds.
    const set = await root.post('/api/admin/guardrails/sets', { name: `Held messages ${id}`, scope: 'tenant' });
    await root.put(`/api/admin/guardrails/sets/${set.id}/draft`, { rules: [{ id: `holdmsg-${id}`, name: `Hold ${id}`, checkpoint: 'user-input', type: 'pattern', mechanism: { kind: 'pattern', pattern: `(?i)hold-msg-${id}` }, action: 'require-approval', stage: 'enforce' }] });
    await root.post(`/api/admin/guardrails/sets/${set.id}/draft/publish`);
    const queue = await root.post('/api/moderation/queues', { name: `Held messages ${id}`, kinds: ['held-write'], priority: 1, slaMinutes: 60, escalateTo: 'tenant' });
    const conv = await member.post('/api/messaging/conversations', { kind: 'direct', userId: ines.userId });
    await member.post(`/api/messaging/conversations/${conv.id}/messages`, { body: `Lunch at noon ${id}` });

    // The sender writes from the console: the message is held, and only they see it.
    const sender = await as('member');
    await open(sender, `messages?convo=${conv.id}`);
    await expectLive(sender);
    await sender.locator('[data-draft]').fill(`Please hold-msg-${id} for me`);
    await sender.locator('[data-send]').click();
    await toast(sender, /Held for review \(202\)/);
    const heldMsg = sender.locator('.messages-held', { hasText: `Please hold-msg-${id} for me` });
    await expect(heldMsg).toBeVisible();
    await expect(heldMsg).toContainText('held for review');
    await expect(heldMsg.locator('[data-heldwithdraw]')).toBeVisible();
    // A toast that is fading in or out is read at a blended colour: wait for the toasts to go.
    await expect(sender.locator('#toasts .toast')).toHaveCount(0, { timeout: 20_000 });
    await settle(sender);
    await expectAccessible(sender, 'messages, a held message');
    await expectAxeClean(sender, 'aa', 'messages, a held message');
    for (const width of [320, 640]) {
      await sender.setViewportSize({ width, height: 800 });
      await settle(sender);
      expect(await reflowProblems(sender), `messages with a held message at ${width} px`).toEqual([]);
    }
    await sender.setViewportSize({ width: 1280, height: 800 });
    // The other member does not get it.
    const ops = await apiAs('ops');
    const seen = (await ops.get(`/api/messaging/conversations/${conv.id}/messages`)) as { body: string }[];
    expect(seen.map((m) => m.body)).toEqual([`Lunch at noon ${id}`]);

    // The reviewer finds it in the queue, with the conversation before it, and accepts it.
    await open(page, 'moderation');
    await expectLive(page);
    await page.locator('tr[data-queue]', { hasText: `Held messages ${id}` }).click();
    await page.locator('tr[data-flag]').first().click();
    const insp = page.locator('aside.inspector');
    await expect(insp).toContainText('Held message');
    await expect(insp).toContainText(`Please hold-msg-${id} for me`);
    await expect(insp).toContainText('A direct conversation between');
    await expect(insp).toContainText(`Lunch at noon ${id}`);
    await expect(page.locator('#toasts .toast')).toHaveCount(0, { timeout: 20_000 });
    await settle(page);
    await expectAccessible(page, 'moderation, a held message');
    await expectAxeClean(page, 'aa', 'moderation, a held message');
    for (const width of [320, 640]) {
      await page.setViewportSize({ width, height: 800 });
      await settle(page);
      expect(await reflowProblems(page), `moderation with a held message at ${width} px`).toEqual([]);
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.locator('[data-hwaccept]').click();
    await confirmDialog(page, 'Accept and deliver');
    await toast(page, /Delivered\./);
    await expect(page.locator('tr[data-flag]')).toHaveCount(0);

    // The sender's view updates by itself: the message is no longer held.
    await expect(sender.locator('.messages-held')).toHaveCount(0);
    await expect(sender.locator('.messages-msg', { hasText: `Please hold-msg-${id} for me` })).toBeVisible();
    const after = (await ops.get(`/api/messaging/conversations/${conv.id}/messages`)) as { body: string }[];
    expect(after.filter((m) => m.body === `Please hold-msg-${id} for me`)).toHaveLength(1);

    // A second one is withdrawn by its sender: it goes, and so does its flag.
    await sender.locator('[data-draft]').fill(`Another hold-msg-${id}`);
    await sender.locator('[data-send]').click();
    await toast(sender, /Held for review \(202\)/);
    await sender.locator('.messages-held [data-heldwithdraw]').click();
    await confirmDialog(sender, 'Withdraw');
    await toast(sender, /Withdrawn\./);
    await expect(sender.locator('.messages-held')).toHaveCount(0);
    const waiting = ((await root.get('/api/moderation/held')).items as { scopeId: string }[]).filter((h) => h.scopeId === conv.id);
    expect(waiting).toEqual([]);

    await root.del(`/api/moderation/queues/${queue.id}`);
    await root.close();
    await member.close();
    await ops.close();
  });
});
