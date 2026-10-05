import { request as pwRequest } from '@playwright/test';
import { test, expect, open, expectLive, apiAs, confirmDialog, toast, settle } from './support/fixtures';
import { serverState } from './support/state';

// B-3410: customer-service channels. The customer side goes through the public channel API (no session cookie), the
// reviewer side through the console.

async function customer(publicKey: string) {
  const ctx = await pwRequest.newContext({ baseURL: serverState().url });
  const start = await ctx.post('/api/public/channels/sessions', { data: { channel: publicKey, name: 'Anna Keller' } });
  expect(start.status(), await start.text()).toBe(201);
  const { token } = (await start.json()) as { token: string };
  const headers = { authorization: `Bearer ${token}` };
  return {
    send: async (text: string) => { const r = await ctx.post('/api/public/channels/session/messages', { data: { text }, headers }); expect(r.status(), await r.text()).toBe(201); return r.json(); },
    view: async () => { const r = await ctx.get('/api/public/channels/session', { headers }); expect(r.ok()).toBe(true); return r.json() as Promise<{ messages: { role: string; state: string; text: string | null }[] }>; },
    close: () => ctx.dispose()
  };
}

test.describe('Channels', () => {
  test('creates a chat channel from the console and shows its secret once', async ({ page }) => {
    const name = `Returns desk ${Date.now().toString(36)}`;
    await open(page, 'channels');
    await expectLive(page);
    await page.locator('[data-newchannel]').first().click();
    const modal = page.locator('#overlay .modal');
    await expect(modal).toBeVisible();
    await modal.locator('[data-nname]').fill(name);
    await modal.locator('[data-nlabel]').selectOption('internal');
    await modal.locator('[data-nreview]').selectOption('always');
    await modal.locator('[data-ncreate]').click();
    await toast(page, 'created. The secrets are shown once');
    await expect(page.locator('#main h1')).toHaveText(name);
    await expect(page.locator('[data-secret]')).not.toBeEmpty();
    await page.locator('[data-rotatedone]').click();
    await expect(page.locator('[data-secret]')).toHaveCount(0);
  });

  test('an edited held reply reaches the customer as edited', async ({ page }) => {
    const api = await apiAs('root');
    const name = `Billing chat ${Date.now().toString(36)}`;
    const ch = await api.post('/api/channels', { workspaceId: serverState().workspace.id, kind: 'chat', name, label: 'internal', target: { kind: 'profile', name: 'general' }, reviewMode: 'always' });
    await api.close();
    const cust = await customer(ch.publicKey);
    const sent = await cust.send('How much will I get back for order 88-0977?');
    expect(sent.reply.state).toBe('pending');
    expect((await cust.view()).messages.some((m) => m.state === 'pending' && m.text === null)).toBe(true);

    await open(page, `channels?channel=${ch.id}&tab=held`);
    await expectLive(page);
    const held = page.locator('[data-heldreply]');
    await expect(held).toHaveCount(1);
    await expect(held).toContainText('Fake answer to: How much will I get back');
    await held.locator('[data-held="edit"]').click();
    const modal = page.locator('#overlay .modal');
    await expect(modal).toBeVisible();
    const edited = 'A colleague confirms the refund amount by email within three working days.';
    await modal.locator('[data-etext]').fill(edited);
    await modal.locator('[data-esend]').click();
    await toast(page, 'edited and delivered');
    await expect(page.locator('[data-heldreply]')).toHaveCount(0);

    // The customer receives the reviewer's text, not the model's.
    const view = await cust.view();
    const reply = view.messages.filter((m) => m.role === 'assistant').pop()!;
    expect(reply.state).toBe('delivered');
    expect(reply.text).toBe(edited);
    await cust.close();

    // The transcript keeps the model's text as the original.
    await settle(page);
    await page.locator('#main a[data-opensession]').first().click();
    const transcript = page.locator('[data-transcript]');
    await expect(transcript).toContainText(edited);
    await expect(transcript).toContainText('Model wrote: Fake answer to: How much will I get back');

    // A person answers in the session, then closes it.
    await settle(page);
    await page.locator('[data-replydraft]').fill('Anything else I can help with?');
    await page.locator('[data-reply]').click();
    await toast(page, 'Answered as a person');
    await expect(page.locator('[data-transcript]')).toContainText('Anything else I can help with?');
    await page.locator('[data-closesession]').click();
    await confirmDialog(page, 'Close session');
    await toast(page, 'Session closed');
  });

  test('a new held reply arrives on the open screen without a reload', async ({ page }) => {
    const api = await apiAs('root');
    const ch = await api.post('/api/channels', { workspaceId: serverState().workspace.id, kind: 'chat', name: `Live desk ${Date.now().toString(36)}`, label: 'internal', target: { kind: 'profile', name: 'general' }, reviewMode: 'always' });
    await api.close();
    await open(page, `channels?channel=${ch.id}&tab=held`);
    await expect(page.locator('#main')).toContainText('Nothing held');
    const cust = await customer(ch.publicKey);
    await cust.send('Where is my parcel?');
    await expect(page.locator('[data-heldreply]')).toContainText('Fake answer to: Where is my parcel?');
    await cust.close();
    // Decided again, so the shared review queue holds only what the other specs expect (Flags confirms the seeded flag
    // and then reads the empty queue's decisions).
    const reviewer = await apiAs('root');
    const held = (await reviewer.get('/api/channels/held')) as { id: string; channelId: string }[];
    for (const h of held.filter((x) => x.channelId === ch.id)) await reviewer.post(`/api/channels/held/${h.id}/decide`, { decision: 'reject', reason: 'End-to-end cleanup' });
    await reviewer.close();
  });

  test('pauses and resumes a channel from its settings', async ({ page }) => {
    const api = await apiAs('root');
    const name = `Pause desk ${Date.now().toString(36)}`;
    const ch = await api.post('/api/channels', { workspaceId: serverState().workspace.id, kind: 'chat', name, label: 'internal', target: { kind: 'profile', name: 'general' } });
    await open(page, `channels?channel=${ch.id}&tab=settings`);
    await page.locator('[data-pause]').click();
    await confirmDialog(page, 'Pause');
    await toast(page, 'paused');
    expect((await api.get(`/api/channels/${ch.id}`)).state).toBe('paused');
    // A paused channel refuses new customer sessions.
    const anon = await pwRequest.newContext({ baseURL: serverState().url });
    expect((await anon.post('/api/public/channels/sessions', { data: { channel: ch.publicKey } })).status()).toBe(404);
    await page.locator('[data-resume]').first().click();
    await toast(page, 'is active again');
    expect((await anon.post('/api/public/channels/sessions', { data: { channel: ch.publicKey } })).status()).toBe(201);
    await anon.dispose();
    await api.close();
  });
});
