import { test, expect, open, expectLive, ready } from './support/fixtures';
import { expectAxeClean } from './support/axe';

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
});
