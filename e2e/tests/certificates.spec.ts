import { generateKeyPairSync } from 'node:crypto';
import { test, expect, open, expectLive, toast, apiAs, type Page } from './support/fixtures';
import { serverState } from './support/state';
import { buildCsr } from '../../server/src/ops/der.js';

/** A PEM PKCS#10 request for these DNS names (the first is the CN), with a fresh P-256 key. */
const csrPem = (domains: string[]): string => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const der = buildCsr(domains, privateKey);
  return `-----BEGIN CERTIFICATE REQUEST-----\n${der.toString('base64').replace(/.{1,64}/g, '$&\n')}-----END CERTIFICATE REQUEST-----\n`;
};

/** Clicks the dialog's primary button and answers the step-up check (B-106) when the server asks for a fresh sign-in. */
async function submitWithStepUp(page: Page, button: string, done: RegExp): Promise<void> {
  await page.locator('#overlay .modal').getByRole('button', { name: button, exact: true }).click();
  const stepUp = page.locator('#overlay .modal', { hasText: 'Confirm it is you' });
  const ok = page.locator('#toasts .toast').filter({ hasText: done }).first();
  await expect(stepUp.or(ok)).toBeVisible();
  if (await stepUp.isVisible()) {
    await stepUp.locator('[data-supw]').fill(serverState().password);
    await stepUp.getByRole('button', { name: 'Confirm' }).click();
    await expect(ok).toBeVisible();
  }
}

test.describe('Certificates', () => {
  test('issues a certificate from a CSR through the console, refuses a name outside the profile and revokes it', async ({ page, watch }) => {
    // The first try of a root or issuing CA answers 401 "Step-up required" when the sign-in is not recent; the screen
    // asks for the password and tries again. The refused CSR is 422 (step names) by design.
    watch.allow.push(/POST \/api\/pki\/issuers -> 401$/, /POST \/api\/pki\/issuers\/[0-9A-Z]+\/issue -> 422$/);
    const api = await apiAs('root');
    const tag = Date.now().toString(36);
    const host = `web-${tag}.e2e.internal`;
    const profile = `e2e-servers-${tag}`;

    await open(page, 'certificates');
    await expectLive(page);

    // The CA hierarchy: a platform root and this tenant's issuing CA, created from the screen when they are missing.
    await page.locator('[data-tab="issuers"]').click();
    const before = (await api.get('/api/pki/issuers')).issuers as { kind: string; state: string }[];
    if (!before.some((i) => i.kind === 'root' && i.state === 'active')) {
      await page.locator('[data-newroot]').click();
      await page.locator('#overlay .modal [data-incn]').fill('E2E Platform Root CA');
      await submitWithStepUp(page, 'Create root', /created \(201\)/);
    }
    if (!before.some((i) => i.kind === 'intermediate' && i.state === 'active')) {
      await page.locator('[data-newint]').click();
      await submitWithStepUp(page, 'Create issuing CA', /created \(201\)/);
    }
    await expect(page.locator('#main .pagehead')).toContainText(/issuing CA G\d+ active/);
    await expect(page.locator('#main tr[data-issuer]').filter({ hasText: 'intermediate' }).first()).toContainText('active');

    // A server profile that allows names under e2e.internal only.
    await page.locator('[data-tab="profiles"]').click();
    await page.locator('[data-newprofile]').click();
    const pm = page.locator('#overlay .modal');
    await pm.locator('[data-pname]').fill(profile);
    await pm.locator('[data-pkind]').selectOption('server');
    await pm.locator('[data-pmax]').fill('398');
    await pm.locator('[data-pdef]').fill('90');
    await pm.locator('[data-pdom]').fill('*.e2e.internal');
    await pm.getByRole('button', { name: 'Create', exact: true }).click();
    await toast(page, `Profile ${profile} created (201)`);
    await expect(page.locator('#main [data-profilecard]').filter({ hasText: profile })).toContainText('*.e2e.internal');

    // Issue from a CSR whose name the profile does not allow: refused with 422 (step names), nothing issued.
    await page.locator('[data-issue]').click();
    let im = page.locator('#overlay .modal');
    await im.locator('[data-iprofile]').selectOption({ label: `${profile} (server)` });
    await im.locator('[data-csr]').fill(csrPem(['api.contoso.example']));
    await im.getByRole('button', { name: 'Issue', exact: true }).click();
    await expect(page.locator('#main .problem')).toContainText(`Name refused by profile ${profile}`);
    await expect(page.locator('#main .problem')).toContainText('api.contoso.example');
    await page.locator('[data-clearproblem]').click();

    // Issue from a CSR the profile allows.
    await page.locator('[data-issue]').click();
    im = page.locator('#overlay .modal');
    await im.locator('[data-iprofile]').selectOption({ label: `${profile} (server)` });
    await im.locator('[data-csr]').fill(csrPem([host, `alt-${tag}.e2e.internal`]));
    await im.locator('[data-idays]').fill('30');
    await im.getByRole('button', { name: 'Issue', exact: true }).click();
    await toast(page, new RegExp(`${host.replace(/\./g, '\\.')} issued by .*\\(201\\)`));
    const row = page.locator('#main tr[data-cert]', { hasText: host });
    await expect(row).toContainText(profile);
    await expect(row).toContainText(`dns:alt-${tag}.e2e.internal`);
    // Thirty days is inside the 30-day notice window: the screen lists it as expiring.
    await expect(row).toContainText('expiring');
    await expect(page.locator('#main .inspector [data-selcert]')).toHaveText(host);

    // Revoke it from the inspector.
    await row.click();
    await page.locator('#main .inspector [data-revokecert]').click();
    const rm = page.locator('#overlay .modal');
    await expect(rm).toContainText(`Revoke ${host}`);
    await rm.locator('[data-reason]').selectOption('keyCompromise');
    await rm.getByRole('button', { name: 'Revoke', exact: true }).click();
    await toast(page, `${host} revoked (keyCompromise)`);
    await expect(row).toContainText('revoked');
    await expect(page.locator('#main .inspector')).toContainText('reason keyCompromise');
    await expect(page.locator('#main .inspector [data-revokecert]')).toHaveCount(0);

    // The server agrees, and the issuer's next CRL can be signed on demand.
    const certs = (await api.get('/api/pki/certificates?state=revoked')).certificates as { commonName: string; revocationReason: string }[];
    expect(certs.find((c) => c.commonName === host)?.revocationReason).toBe('keyCompromise');
    await page.locator('#main .pagehead [data-crl]').click();
    await toast(page, /pki\.crl job queued for .* \(202/);
    await api.close();
  });
});
