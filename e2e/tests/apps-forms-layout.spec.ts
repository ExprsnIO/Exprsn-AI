import { test, expect, open, expectLive, toast, apiAs, type Page } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { reflowProblems } from './support/reflow';
import { serverState } from './support/state';

/*
 * Follow-up 2 of the low-code port (docs/decisions/lowcode-port.md): form sections and wizard steps with condition
 * trees, edited on the Forms tab with a keyboard-operable tree builder, previewed live as a wizard, and filled in on the
 * public link page (/form#token=…) with accessible step navigation, per-step checks and a review step.
 */
const uniq = () => Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
const modal = (page: Page) => page.locator('#overlay .modal');

const ticket = {
  fields: [
    { name: 'email', type: 'string', required: true, maxLength: 200 },
    { name: 'kind', type: 'enum', options: [{ value: 'person' }, { value: 'company' }] },
    { name: 'company_name', type: 'string', maxLength: 120 },
    { name: 'note', type: 'string', maxLength: 500 }
  ]
};

async function setup(id: string) {
  const root = await apiAs('root');
  const appName = `desk_${id}`;
  await root.post('/api/apps', { name: appName, title: `Desk ${id}`, label: 'internal', workspaceId: serverState().workspace.id });
  await root.post(`/api/apps/${appName}/entities`, { name: 'ticket', title: 'Ticket', definition: ticket });
  await root.post(`/api/apps/${appName}/forms`, { name: 'intake', title: 'Intake', entity: 'ticket', definition: { fields: [{ field: 'email', required: true }, { field: 'kind' }, { field: 'company_name' }, { field: 'note' }] } });
  return { root, appName };
}

async function pickApp(page: Page, title: string): Promise<void> {
  await page.locator('#main .leftpane [data-app]', { hasText: title }).click();
  await expect(page.locator('#main .page h1, #main .page .pagehead').first()).toContainText(title);
}

/** The public page has no console shell: it must simply not scroll sideways nor stick out of the window. */
async function pageReflows(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const doc = document.scrollingElement!;
    if (doc.scrollWidth > window.innerWidth + 1) out.push(`the page scrolls sideways by ${doc.scrollWidth - window.innerWidth} px`);
    for (const el of Array.from(document.querySelectorAll('#embed *'))) {
      if (!(el instanceof HTMLElement) || !el.offsetParent) continue;
      const r = el.getBoundingClientRect();
      if (r.right > window.innerWidth + 1) out.push(`${el.tagName.toLowerCase()}.${el.className} sticks out by ${Math.round(r.right - window.innerWidth)} px`);
    }
    return out;
  });
}

test.describe('Apps: form sections, wizard steps and conditions', () => {
  test('lays a form out as a wizard with a step condition, previews it step by step, and the public page runs it', async ({ page }) => {
    const id = uniq();
    const { root, appName } = await setup(id);
    await open(page, 'apps');
    await expectLive(page);
    await pickApp(page, `Desk ${id}`);
    await page.locator('#main [data-tab="forms"]').click();
    await expect(page.locator('#main tr[data-form]')).toContainText('one list');

    // One list -> wizard: one step per section, then a second step that the company fields move to.
    await page.locator('#main [data-fl-mode] [data-seg="wizard"]').click();
    await expect(page.locator('#main .apf-step')).toHaveCount(1);
    await page.locator('#main [data-fl-tv="step1|title"]').fill('Who you are');
    await page.locator('#main [data-fl-tv="step1|title"]').press('Tab');
    await page.locator('#main [data-fl-addstep]').click();
    await expect(page.locator('#main .apf-step')).toHaveCount(2);
    await expect(page.locator('#main [data-fl-tv="step2|title"]')).toBeFocused();
    await page.locator('#main [data-fl-tv="step2|title"]').fill('Your company');
    await page.locator('#main [data-fl-tv="step2|title"]').press('Tab');
    await page.locator('#main [data-fl-sv="section1|title"]').fill('Company');
    await page.locator('#main [data-fl-sv="section1|title"]').press('Tab');
    await page.locator('#main [data-fl-fsec="company_name"]').selectOption('section1');
    await page.locator('#main [data-fl-fsec="note"]').selectOption('section1');
    await page.locator('#main [data-fl-review]').check();

    // The company step only for companies: a condition built with the keyboard in the tree builder.
    await page.locator('#main [data-fl-cond="step:step2"]').click();
    const m = modal(page);
    await expect(m).toContainText('Conditions for the step Your company');
    await expectAxeClean(page, 'aa', 'the condition builder');
    await m.locator('[data-cb-addg="visibleIf|"]').focus();
    await page.keyboard.press('Enter');
    await expect(m.locator('[data-cb-f="visibleIf|0"]')).toBeFocused();
    await m.locator('[data-cb-f="visibleIf|0"]').selectOption('kind');
    await m.locator('[data-cb-v="visibleIf|0"]').fill('company');
    await m.locator('[data-cb-g="visibleIf|"]').selectOption('any');
    await m.locator('[data-cb-add="visibleIf|"]').click();
    await m.locator('[data-cb-f="visibleIf|1"]').selectOption('email');
    await m.locator('[data-cb-o="visibleIf|1"]').selectOption('contains');
    await m.locator('[data-cb-v="visibleIf|1"]').fill('@corp.test');
    await m.locator('[data-cb-ok]').click();
    await expect(page.locator('#main .apf-step').nth(1)).toContainText('visible if any of (kind equals company; email contains @corp.test)');
    await page.locator('#main [data-fsave]').click();
    await toast(page, 'Form saved.');
    await expect(page.locator('#main tr[data-form]')).toContainText('wizard, 2 steps + review');
    const saved = await root.get(`/api/apps/${appName}/forms/intake`);
    expect(saved.definition.version).toBe(2);
    expect(saved.definition.layout.steps[1]).toMatchObject({ title: 'Your company', visibleIf: { any: [{ field: 'kind', op: 'eq', value: 'company' }, { field: 'email', op: 'contains', value: '@corp.test' }] } });

    // The live preview: step navigation with aria-current, a per-step check, the hidden step skipped, a review.
    const pv = page.locator('#main .apps-preview');
    await expect(pv.locator('[aria-current="step"]')).toContainText('Who you are');
    await expect(pv.locator('ol li')).toHaveCount(2); // the company step is hidden until its condition matches
    await pv.locator('[data-pvnext]').click();
    await expect(pv).toContainText('Fill in email first.');
    await expect(pv.locator('[data-fv="email"]')).toBeFocused();
    await pv.locator('[data-fv="email"]').fill('ana@example.test');
    await pv.locator('[data-fv="kind"]').selectOption('person');
    await pv.locator('[data-fv="kind"]').blur();
    await expect(pv.locator('ol li')).toHaveCount(2); // still hidden for a person at example.test
    await pv.locator('[data-pvnext]').click();
    await expect(pv.locator('[data-pvstep-h]')).toBeFocused();
    await expect(pv.locator('[data-pvstep-h]')).toHaveText('Review');
    await expect(pv.locator('dl')).toContainText('ana@example.test');
    await expectAxeClean(page, 'aa', 'the Forms tab with a wizard preview');
    for (const width of [320, 640]) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(250);
      expect(await reflowProblems(page), `Forms tab at ${width} px`).toEqual([]);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('#main [data-ftest]').click();
    await toast(page, /201: .*Audited app.form.submitted/);

    // The public link page: the token in the fragment, the wizard with its steps, focus on each step's heading.
    const { token } = await root.post(`/api/apps/${appName}/forms/intake/public`, { enabled: true });
    await root.close();
    await page.goto(`/form#token=${token}`);
    const pub = page.locator('#embed');
    await expect(pub.locator('h1')).toHaveText('Intake');
    await expect(pub.locator('nav[aria-label="Form steps"] [aria-current="step"]')).toContainText('Who you are');
    await expectAxeClean(page, 'aa', 'the public form page');
    // The company step is hidden until its condition matches, so the first step leads to the review.
    await pub.getByRole('button', { name: 'Review' }).click();
    await expect(pub.locator('[name="email"]')).toHaveAttribute('aria-invalid', 'true');
    await expect(pub.locator('[name="email"]')).toBeFocused();
    await expect(pub.locator('[role="status"]')).toContainText('Fill in email');
    await pub.locator('[name="email"]').fill('bo@corp.test');
    await pub.locator('[name="kind"]').selectOption('person');
    await pub.getByRole('button', { name: 'Next' }).click();
    // Reached through the email condition (any of): the company step shows, and its heading has focus.
    await expect(pub.locator('[data-step-h]')).toBeFocused();
    await expect(pub.locator('[data-step-h]')).toContainText('Your company');
    await expect(pub.locator('nav [aria-current="step"]')).toContainText('2. Your company');
    await expect(pub.locator('section h3')).toHaveText('Company');
    await pub.locator('[name="company_name"]').fill('Corp');
    for (const width of [320, 640]) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(150);
      expect(await pageReflows(page), `public form page at ${width} px`).toEqual([]);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await pub.getByRole('button', { name: 'Review' }).click();
    await expect(pub.locator('[data-step-h]')).toContainText('Review your answers');
    await expect(pub.locator('dl').first()).toContainText('bo@corp.test');
    await expect(pub.locator('dl').nth(1)).toContainText('Corp');
    await expect(pub.locator('dl').nth(1)).toContainText('not answered');
    await expectAxeClean(page, 'aa', 'the public form review step');
    // Back to a done step through the step list, then forward again.
    await pub.locator('nav button[data-goto="0"]').click();
    await expect(pub.locator('[data-step-h]')).toBeFocused();
    await expect(pub.locator('[name="email"]')).toHaveValue('bo@corp.test');
    await pub.getByRole('button', { name: 'Next' }).click();
    await pub.getByRole('button', { name: 'Review' }).click();
    await pub.getByRole('button', { name: 'Submit' }).click();
    await expect(pub).toContainText('Thank you. Your submission was received.');

    const check = await apiAs('root');
    const recs = await check.get(`/api/apps/${appName}/ticket?limit=10`);
    await check.close();
    expect(recs.records.map((r: { values: { email: string } }) => r.values.email)).toEqual(expect.arrayContaining(['ana@example.test', 'bo@corp.test']));
  });
});
