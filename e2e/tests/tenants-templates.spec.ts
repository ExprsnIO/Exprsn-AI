import { test, expect, open, expectLive, settle, toast, type Page } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { expectAccessible } from './support/a11y';
import { serverState } from './support/state';

// 1.6.0 (B-4501): Create from template on the Tenants screen. A system admin picks a template, names the tenant and
// its first admin, and gets the tenant with its workspaces and the first admin's single-use enrolment link in one
// step. The dialogs pass the WCAG checker and axe-core (Standard and Enhanced, light and dark) and reflow at 320 and
// 640 px (B-4207's share for this dialog).

type AppGlobal = { App: { setA11y(m: 'aa' | 'aaa' | null): void } };

/** Sideways scrolling or anything sticking out of the open dialog. */
function dialogReflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const box = document.querySelector('#overlay > .modal, #overlay > .drawer') as HTMLElement | null;
    if (!box) return ['no dialog open'];
    const doc = document.scrollingElement!;
    if (doc.scrollWidth > window.innerWidth + 1) out.push(`the page scrolls sideways by ${doc.scrollWidth - window.innerWidth} px`);
    if (box.scrollWidth > box.clientWidth + 1) out.push(`the dialog scrolls sideways by ${box.scrollWidth - box.clientWidth} px`);
    const edge = Math.min(window.innerWidth, box.getBoundingClientRect().right);
    const scrollers = Array.from(box.querySelectorAll('*')).filter((el) => el instanceof HTMLElement && /(auto|scroll)/.test(getComputedStyle(el).overflowX) && el.scrollWidth > el.clientWidth + 1);
    for (const el of scrollers) if (!el.matches('.tablewrap,.codebox,pre,textarea,[data-scroll-x]')) out.push(`${el.tagName.toLowerCase()}.${(el as HTMLElement).className} scrolls sideways`);
    for (const el of Array.from(box.querySelectorAll('*'))) {
      if (!(el instanceof HTMLElement) || !el.getClientRects().length) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.right <= edge + 1 || scrollers.some((s) => s.contains(el))) continue;
      out.push(`${el.tagName.toLowerCase()}.${el.className} sticks out (${Math.round(r.right)} px of ${Math.round(edge)})`);
    }
    return [...new Set(out)].slice(0, 10);
  });
}

async function checkDialog(page: Page, where: string): Promise<void> {
  await expectAccessible(page, where);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const mode of ['aa', 'aaa'] as const) {
      await page.evaluate((m) => (window as unknown as AppGlobal).App.setA11y(m), mode);
      await expectAxeClean(page, mode, `${where} (${scheme}, ${mode})`);
    }
  }
  await page.evaluate(() => (window as unknown as AppGlobal).App.setA11y(null));
  await page.emulateMedia({ colorScheme: 'light' });
  for (const width of [320, 640]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(150);
    expect.soft(await dialogReflow(page), `${where} at ${width} px`).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test.describe('Tenants: create from a template', () => {
  test('a system admin creates a tenant from the team template and gets the enrolment link once', async ({ page }) => {
    await open(page, 'tenants');
    await expectLive(page);
    await page.locator('[data-fromtemplate]').click();
    const modal = page.locator('#overlay .modal');
    await expect(modal).toContainText('Create a tenant from a template');
    await expect(modal.locator('.tn-tpl')).toHaveCount(3);
    // The team template is picked first; picking another changes what will be made.
    await expect(modal.locator('input[data-tpl][value="team"]')).toBeChecked();
    await modal.locator('label.tn-tpl', { hasText: 'Enterprise' }).click();
    await expect(modal.locator('[data-tpldetail]')).toContainText('Finance');
    await modal.locator('label.tn-tpl', { hasText: 'Team' }).first().click();
    await expect(modal.locator('[data-tpldetail]')).toContainText('Projects');
    await checkDialog(page, 'Create from template');

    await modal.locator('[data-fslug]').fill('fabrikam');
    await modal.locator('[data-fname]').fill('Fabrikam');
    await modal.locator('[data-fuser]').fill('ada');
    await modal.locator('[data-fdisplay]').fill('Ada Brennan');
    await modal.locator('[data-femail]').fill('ada@fabrikam.example');
    await modal.locator('[data-fsave]').click();
    await toast(page, 'Tenant Fabrikam created from the team template');

    const done = page.locator('#overlay .modal');
    await expect(done).toContainText('Fabrikam is ready');
    await expect(done).toContainText('Team, Projects');
    await expect(done).toContainText('Contributor');
    await expect(done.locator('[data-enrollink]')).toContainText(/#\/signin\?reset=.+&tenant=fabrikam/);
    await checkDialog(page, 'Tenant created from a template');
    await done.locator('[data-close]').last().click();
    await settle(page);

    // The new tenant and its workspaces are in the tree, selected.
    await expect(page.locator('.leftpane')).toContainText('Fabrikam');
    await expect(page.locator('#main h1')).toContainText('Fabrikam');
  });

  test('a taken slug is refused in the dialog', async ({ page, watch }) => {
    watch.allow.push(/POST \/api\/admin\/tenants\/from-template -> 409/);
    await open(page, 'tenants');
    await page.locator('[data-fromtemplate]').click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('label.tn-tpl', { hasText: 'Personal' }).click();
    // The console's own tenant: its slug is always taken.
    await modal.locator('[data-fslug]').fill(serverState().tenant);
    await modal.locator('[data-fname]').fill('Taken');
    await modal.locator('[data-fuser]').fill('sam');
    await modal.locator('[data-fdisplay]').fill('Sam');
    await modal.locator('[data-fsave]').click();
    await expect(modal.locator('[data-err]')).toContainText('A tenant with that slug exists');
  });
});
