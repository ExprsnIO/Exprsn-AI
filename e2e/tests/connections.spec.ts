import { test, expect, open, expectLive, toast } from './support/fixtures';

test.describe('Connections', () => {
  test('shows the empty state, registers a PostgreSQL connection and tests it', async ({ page }) => {
    await open(page, 'connections');
    await expectLive(page);
    await expect(page.locator('#main h3', { hasText: 'No connections yet' }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Register a connection' }).click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-name]').fill('ledger-ro');
    // Nothing listens on port 9: the test step reports the server as unreachable instead of hanging.
    await modal.locator('[data-endpoint]').fill('127.0.0.1:9');
    await modal.locator('[data-db]').fill('ledger');
    await modal.locator('[data-label]').selectOption('confidential');
    await modal.locator('[data-user]').fill('ledger_ro');
    await modal.locator('[data-pass]').fill('not-a-real-password');
    await modal.locator('[data-doreg]').click();
    await toast(page, 'Connection registered');
    await expect(page.locator('#main h1')).toContainText('ledger-ro');
    await expect(page.locator('.conn-list')).toContainText('ledger-ro');

    await page.locator('[data-test]').click();
    await expect(page.locator('#main')).toContainText(/unreachable|could not reach|refused/i, { timeout: 20_000 });
  });

  // 1.9.0: Register and Settings are drawn from the engine catalogue (GET /api/admin/connections/engines).
  test('draws each engine\'s fields from the catalogue and saves its settings', async ({ page }) => {
    await open(page, 'connections');
    await expectLive(page);
    await page.locator('[data-register]').first().click();
    const modal = page.locator('#overlay .modal');
    const engine = modal.locator('[data-engine]');
    await expect(engine.locator('option')).toHaveText(['PostgreSQL', 'MySQL', 'SQL Server', 'Azure SQL', 'Oracle Database', 'Snowflake', 'BigQuery', 'Cloudflare D1', 'OpenSearch', 'MongoDB', 'Amazon DocumentDB', 'Azure Cosmos DB for MongoDB (vCore)', 'DigitalOcean Managed MongoDB', 'Amazon DynamoDB', 'Azure Cosmos DB for NoSQL', 'Redis', 'RabbitMQ', 'Prometheus', 'InfluxDB']);
    // 2.0.x: grouped by category, in catalogue order within each group.
    await expect(engine.locator('optgroup')).toHaveCount(4);

    // Snowflake: a key goes in a textarea, TLS is always on, and its settings show.
    await engine.selectOption('snowflake');
    await expect(modal.locator('textarea[data-pass]')).toBeVisible();
    await expect(modal.locator('[data-tls]')).toBeChecked();
    await expect(modal.locator('[data-tls]')).toBeDisabled();
    await expect(modal.locator('[data-opt="warehouse"]')).toBeVisible();
    await expect(modal.locator('[data-srcwrap]')).toBeHidden();

    // Azure SQL: the Entra tenant field shows only for a service principal.
    await engine.selectOption('azure-sql');
    await expect(modal.locator('input[type="password"][data-pass]')).toBeVisible();
    await expect(modal.locator('[data-opt="entraTenantId"]')).toBeHidden();
    await modal.locator('[data-opt="auth"]').selectOption('entra-service-principal');
    await expect(modal.locator('[data-opt="entraTenantId"]')).toBeVisible();
    await modal.locator('[data-opt="auth"]').selectOption('sql');

    await modal.locator('[data-name]').fill('sales-azure');
    await modal.locator('[data-endpoint]').fill('127.0.0.1:9');
    await modal.locator('[data-db]').fill('sales');
    await modal.locator('[data-user]').fill('reader');
    await modal.locator('[data-pass]').fill('not-a-real-password');
    await modal.locator('[data-opt="schema"]').fill('reporting');
    await modal.locator('[data-doreg]').click();
    await toast(page, 'Connection registered');
    await expect(page.locator('.conn-list')).toContainText('Azure SQL');

    await page.getByRole('tab', { name: 'Settings' }).click();
    await expect(page.locator('[data-optsform] [data-opt="schema"]')).toHaveValue('reporting');
    await expect(page.locator('[data-setting-tls]')).toBeDisabled();
    await page.locator('[data-optsform] [data-opt="applicationIntent"]').selectOption('ReadWrite');
    await page.locator('[data-save]').click();
    await toast(page, 'Settings saved');
    await page.getByRole('tab', { name: 'Settings' }).click();
    await expect(page.locator('[data-optsform] [data-opt="applicationIntent"]')).toHaveValue('ReadWrite');
  });
});
