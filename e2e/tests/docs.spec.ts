import { test, expect, open, expectLive, toast, type Page } from './support/fixtures';
import { reflowProblems } from './support/reflow';

// The Docs portal (#/docs): documentation sites over knowledge bases. The reader is checked against mocked
// /api/docs/** answers, so the test does not depend on what knowledge the suite has published.

const KB = { id: 'kb-handbook', name: 'Handbook', label: 'internal' };
const SITE = { id: 'site-1', slug: 'handbook', title: 'Staff handbook', description: 'How we work.', bases: [KB], home: { kbId: KB.id, slug: 'intro' }, library: true, updatedAt: '2026-10-20T10:00:00Z', canManage: true };
const NAV = {
  site: SITE,
  sections: [{
    kb: KB, duties: { edit: true, approve: false, manage: false },
    pages: [
      { id: 'p1', slug: 'intro', title: 'Introduction', parentId: null, position: 0, children: 1, state: 'published', version: '1.1.0', updatedAt: '2026-10-20T10:00:00Z' },
      { id: 'p2', slug: 'intro/setup', title: 'Setting up', parentId: 'p1', position: 0, children: 0, state: 'published', version: '1.0.0', updatedAt: '2026-10-19T10:00:00Z' },
      { id: 'p3', slug: 'faq', title: 'Questions', parentId: null, position: 1, children: 0, state: 'in-review', version: '0.1.0', updatedAt: '2026-10-18T10:00:00Z' }
    ],
    library: { documents: 3, categories: [{ path: 'guides', depth: 0, documents: 2 }, { path: 'guides/admin', depth: 1, documents: 1 }] }
  }]
};
const link = (slug: string, text: string, missing = false) => `<a href="#/docs?site=handbook&amp;kb=${KB.id}&amp;page=${encodeURIComponent(slug)}" data-docs-kb="${KB.id}" data-docs-page="${slug}"${missing ? ' data-docs-missing=""' : ''}>${text}</a>`;
function pageOf(slug: string, version: string | null) {
  if (slug === 'intro/setup') {
    return { page: { id: 'p2', kbId: KB.id, kb: KB.name, slug, title: 'Setting up', version: '1.0.0', label: 'internal', state: 'published', updatedAt: '2026-10-19T10:00:00Z', approvedAt: null, approvedBy: null },
      html: '<p>Install the client.</p><h2 id="install">Install</h2><p>Run the installer.</p>', toc: [{ level: 2, id: 'install', text: 'Install' }],
      breadcrumbs: [{ slug: 'intro', title: 'Introduction' }, { slug, title: 'Setting up' }], children: [], links: [], backlinks: [{ slug: 'intro', title: 'Introduction' }],
      versions: [{ version: '1.0.0', number: 1, state: 'published', at: '2026-10-19T10:00:00Z', summary: 'First' }], canEdit: true };
  }
  const old = version === '1.0.0';
  return {
    page: { id: 'p1', kbId: KB.id, kb: KB.name, slug: 'intro', title: 'Introduction', version: old ? '1.0.0' : '1.1.0', label: 'internal', state: old ? 'superseded' : 'published', updatedAt: '2026-10-20T10:00:00Z', approvedAt: '2026-10-20T10:00:00Z', approvedBy: { name: 'Ada Curator' } },
    html: `<p>${old ? 'The old welcome.' : 'Welcome to the handbook.'}</p><h2 id="first-steps">First steps</h2><p>Read ${link('intro/setup', 'Setting up')} and ${link('gone', 'the retired page', true)}.</p>`
      + '<h3 id="commands">Commands</h3><pre><code>exprsn-ai migrate --check &amp;&amp; exprsn-ai admin:create --username someone --email someone@example.org --roles system-admin</code></pre>'
      + '<h2 id="reference">Reference</h2><table><thead><tr><th>Key</th><th>Meaning</th></tr></thead><tbody><tr><td>a</td><td>b</td></tr></tbody></table>'
      + '<p style="height:1200px">Long section.</p><h2 id="last">Last section</h2><p>The end.</p>',
    toc: [{ level: 2, id: 'first-steps', text: 'First steps' }, { level: 3, id: 'commands', text: 'Commands' }, { level: 2, id: 'reference', text: 'Reference' }, { level: 2, id: 'last', text: 'Last section' }],
    breadcrumbs: [{ slug: 'intro', title: 'Introduction' }],
    children: [{ slug: 'intro/setup', title: 'Setting up' }], links: [{ slug: 'intro/setup', title: 'Setting up' }], backlinks: [],
    versions: [{ version: '1.1.0', number: 2, state: 'published', at: '2026-10-20T10:00:00Z', summary: 'More' }, { version: '1.0.0', number: 1, state: 'superseded', at: '2026-10-01T10:00:00Z', summary: 'First' }],
    canEdit: true
  };
}

async function mockDocs(page: Page, calls: { method: string; url: URL; body: unknown }[]) {
  await page.route(/\/api\/docs\//, (route) => {
    const req = route.request();
    const url = new URL(req.url());
    calls.push({ method: req.method(), url, body: req.postDataJSON?.() ?? null });
    const p = url.pathname;
    if (p === '/api/docs/sites' && req.method() === 'GET') return route.fulfill({ json: [SITE] });
    if (p === '/api/docs/sites' && req.method() === 'POST') return route.fulfill({ status: 201, json: { ...SITE, id: 'site-2', ...(req.postDataJSON() as object) } });
    if (p === '/api/docs/sites/handbook/nav') return route.fulfill({ json: NAV });
    if (p === '/api/docs/sites/handbook/page') return route.fulfill({ json: pageOf(url.searchParams.get('slug') ?? 'intro', url.searchParams.get('version')) });
    if (p === '/api/docs/sites/handbook/search') {
      return route.fulfill({ json: { hits: [
        { kind: 'page', kbId: KB.id, slug: 'intro/setup', title: 'Setting up', heading: 'Install', snippet: 'Run the <installer>.' },
        { kind: 'document', kbId: KB.id, docId: 'd1', title: 'Admin guide', heading: 'Start', snippet: 'For administrators.' }
      ] } });
    }
    return route.fulfill({ status: 404, contentType: 'application/problem+json', body: JSON.stringify({ title: 'Not found', status: 404 }) });
  });
}

test.describe('Docs', () => {
  test('reads a site: tree, table of contents, internal links, versions and search', async ({ page }) => {
    const calls: { method: string; url: URL; body: unknown }[] = [];
    await mockDocs(page, calls);
    await open(page, 'docs?all=1');
    await expectLive(page);
    await page.getByRole('link', { name: 'Staff handbook' }).click();
    await expect(page.locator('#main .docs-titlebar h1')).toHaveText('Introduction');
    await expect(page.locator('#main .docs-meta')).toContainText('Approved by Ada Curator');
    // The tree: the home page is current; its child is behind a collapsed node.
    const tree = page.getByRole('navigation', { name: 'Pages of Staff handbook' });
    await expect(tree.getByRole('link', { name: 'Introduction' })).toHaveAttribute('aria-current', 'page');
    await expect(tree.getByRole('link', { name: 'Setting up' })).toHaveCount(0);
    await tree.getByRole('button', { name: 'Pages under Introduction' }).click();
    await expect(tree.getByRole('link', { name: 'Setting up' })).toBeVisible();
    await expect(tree.getByText('In review')).toBeVisible();

    // On this page: a click moves focus to the heading.
    await page.locator('#main .docs-toc').getByRole('button', { name: 'Last section' }).click();
    await expect(page.locator('#main .docs-article h2#last')).toBeFocused();

    // A link to a missing page only says so; an internal link opens the page.
    await page.locator('#main .docs-article').getByRole('link', { name: 'the retired page' }).click();
    await toast(page, 'That page does not exist or you cannot read it.');
    await page.locator('#main .docs-article').getByRole('link', { name: 'Setting up' }).click();
    await expect(page.locator('#main .docs-titlebar h1')).toHaveText('Setting up');
    await expect(page).toHaveURL(/kb=kb-handbook&page=intro%2Fsetup/);
    await expect(page.getByRole('navigation', { name: 'Where this page is in the site' })).toContainText('Introduction');

    // Back to the home page through the breadcrumb, then an earlier version.
    await page.getByRole('navigation', { name: 'Where this page is in the site' }).getByRole('link', { name: 'Introduction' }).click();
    await expect(page.locator('#main .docs-titlebar h1')).toHaveText('Introduction');
    await page.getByLabel('Version').selectOption('1.0.0');
    await expect(page.locator('#main .docs-article')).toContainText('The old welcome.');
    expect(calls.some((c) => c.url.pathname.endsWith('/page') && c.url.searchParams.get('version') === '1.0.0')).toBe(true);
    await expect(page.locator('#main')).toContainText('You are reading version 1.0.0; the current version is 1.1.0.');
    await page.getByRole('link', { name: 'Read the current version' }).click();
    await expect(page.locator('#main .docs-article')).toContainText('Welcome to the handbook.');

    // Search replaces the tree; Enter opens the first result.
    const box = page.getByRole('searchbox', { name: 'Search this site' });
    await box.fill('install');
    const results = page.getByRole('region', { name: 'Search results' });
    await expect(results).toContainText('2 results for');
    await expect(results).toContainText('Run the <installer>.');
    await expect(page.getByRole('navigation', { name: 'Pages of Staff handbook' })).toHaveCount(0);
    await box.press('Enter');
    await expect(page.locator('#main .docs-titlebar h1')).toHaveText('Setting up');
    await box.press('Escape');
    await expect(page.getByRole('navigation', { name: 'Pages of Staff handbook' })).toBeVisible();
  });

  test('a manager makes a site in the New site dialog', async ({ page }) => {
    const calls: { method: string; url: URL; body: unknown }[] = [];
    await mockDocs(page, calls);
    await page.route(/\/api\/knowledge\/bases$/, (route) => route.fulfill({ json: [{ id: 'kb-a', name: 'Alpha base', label: 'internal' }, { id: 'kb-b', name: 'Beta base', label: 'public' }] }));
    await page.route(/\/api\/knowledge\/bases\/kb-a\/references$/, (route) => route.fulfill({ json: [{ id: 'r1', slug: 'welcome', title: 'Welcome', version: '1.0.0', state: 'published' }, { id: 'r2', slug: 'draft', title: 'Draft only', version: null, state: 'draft' }] }));
    await open(page, 'docs?all=1');
    // The manage permission comes with the knowledge curator role; make sure this session shows the manager's view.
    await page.evaluate(() => { const A = (window as unknown as { App: { me: { permissions: string[] }; render(): void } }).App; if (!A.me.permissions.includes('docs:manage')) A.me.permissions.push('docs:manage'); A.render(); });
    await page.getByRole('button', { name: 'New site' }).click();
    const modal = page.locator('#overlay .modal');
    await modal.getByLabel('Title').fill('Engineering Notes');
    await expect(modal.getByLabel('Address')).toHaveValue('engineering-notes');
    await modal.getByLabel('Description').fill('For engineers.');
    await modal.getByRole('checkbox', { name: 'Alpha base' }).check();
    await expect(modal.getByLabel('Home page').locator('option', { hasText: 'Alpha base: Welcome' })).toHaveCount(1);
    await expect(modal.getByLabel('Home page').locator('option', { hasText: 'Draft only' })).toHaveCount(0);
    await modal.getByLabel('Home page').selectOption('kb-a|welcome');
    await modal.getByRole('checkbox', { name: /Include a Library/ }).check();
    await modal.getByRole('button', { name: 'Create site' }).click();
    await toast(page, 'Created Engineering Notes.');
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({ slug: 'engineering-notes', title: 'Engineering Notes', description: 'For engineers.', kbIds: ['kb-a'], library: true, home: { kbId: 'kb-a', slug: 'welcome' } });
  });

  test('the reader reflows at 320 and 640 px', async ({ page }) => {
    const calls: { method: string; url: URL; body: unknown }[] = [];
    await mockDocs(page, calls);
    for (const width of [320, 640]) {
      await page.setViewportSize({ width, height: 800 });
      await open(page, 'docs?site=handbook');
      await expect(page.locator('#main .docs-titlebar h1')).toHaveText('Introduction');
      await page.waitForTimeout(250);
      expect(await reflowProblems(page), `${width} px`).toEqual([]);
    }
  });
});
