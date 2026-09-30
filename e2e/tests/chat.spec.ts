import { test, expect, open, expectLive, ready } from './support/fixtures';

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
});
