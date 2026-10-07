import { deflateSync } from 'node:zlib';
import { test, expect, open, expectLive, settle, toast, type Page } from './support/fixtures';
import { expectAxeClean } from './support/axe';
import { expectAccessible } from './support/a11y';
import { reflowProblems } from './support/reflow';

// 1.6.0 (B-8801 to B-8805): image documents in Knowledge and the vision engine on Classifiers. A curator names the
// vision profile and the published vision classifier on a base, uploads a receipt, finds it labelled, filters by its
// label, opens it, re-classifies it and finds it in the test search; the Classifiers screen offers the vision engine
// and tests an image. The screen, the image drawer and the settings dialog pass the WCAG checker and axe-core
// (Standard and Enhanced, light and dark) and reflow at 320 and 640 px. The server seeds the profile `vision`
// (llava:7b on the fake Ollama, which reads a picture's text chunks) and the published classifier Image kinds.

type AppGlobal = { App: { setA11y(m: 'aa' | 'aaa' | null): void } };

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/** A small PNG whose text chunks are what the fake vision model sees: caption, ocr and scores. */
function picture(text: Record<string, string>, size = 32): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) raw.set([(x * 8) & 0xff, (y * 8) & 0xff, 160], y * (size * 3 + 1) + 1 + x * 3);
  const texts = Object.entries(text).map(([k, v]) => chunk('tEXt', Buffer.concat([Buffer.from(k, 'latin1'), Buffer.from([0]), Buffer.from(v, 'latin1')])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), ...texts, chunk('IEND', Buffer.alloc(0))]);
}

const RECEIPT = picture({ caption: 'A taxi receipt from Lisbon with the fare and a card payment line', ocr: 'Cooperativa de Taxis de Lisboa Fare 42.00 EUR', scores: JSON.stringify({ receipt: 0.91, screenshot: 0.04 }) });

/** Sideways scrolling or anything sticking out of the open dialog or drawer. */
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

/** The WCAG checker and axe-core in both modes and schemes, then reflow at 320 and 640 px (the screen or a dialog). */
async function checkView(page: Page, where: string, dialog: boolean): Promise<void> {
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
    await page.waitForTimeout(200);
    expect.soft(dialog ? await dialogReflow(page) : await reflowProblems(page), `${where} at ${width} px`).toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(100);
}

test.describe('Knowledge: image documents and labels', () => {
  test('a curator names the vision profile and classifier, uploads a receipt and finds it by its label', async ({ page }) => {
    test.setTimeout(180_000);
    await open(page, 'knowledge');
    await expectLive(page);
    await page.locator('[data-newkb]').first().click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-name]').fill('Receipts KB');
    await modal.getByRole('button', { name: 'Create' }).click();
    await toast(page, 'Created Receipts KB as a draft');
    await expect(page.locator('#main h1')).toContainText('Receipts KB');

    // The image settings: the vision profile and the published vision classifier.
    await page.locator('[data-imagesettings]').click();
    const settings = page.locator('#overlay .modal');
    await expect(settings).toContainText('Image settings for Receipts KB');
    await settings.locator('[data-vision]').selectOption('vision');
    await settings.getByLabel(/Image kinds v1/).check();
    await checkView(page, 'Knowledge image settings', true);
    await settings.getByRole('button', { name: 'Save' }).click();
    await toast(page, 'Image settings saved for Receipts KB');

    // An uploaded receipt is described and labelled in the background.
    await page.locator('[data-addsource]').first().click();
    const drawer = page.locator('#overlay .drawer');
    await drawer.locator('[data-type]').selectOption('upload');
    await drawer.locator('[data-files]').setInputFiles({ name: 'taxi-receipt.png', mimeType: 'image/png', buffer: RECEIPT });
    await drawer.getByRole('button', { name: 'Add and sync' }).click();
    await toast(page, '1 file uploaded to quarantine');
    const row = page.locator('#main tr', { hasText: 'taxi-receipt.png' });
    await expect(row).toContainText('receipt 0.91', { timeout: 60_000 });
    await expect(row.locator('img.kb-thumb')).toHaveAttribute('alt', /taxi-receipt\.png|taxi receipt/i);
    await expect.poll(() => row.locator('img.kb-thumb').evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBeGreaterThan(0);

    // The label chips filter through the server.
    const chip = page.locator('#main [data-chip="receipt"]');
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
    await chip.click();
    await expect(page.locator('#main [data-chip="receipt"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#main tr', { hasText: 'taxi-receipt.png' })).toBeVisible();
    await settle(page);
    await checkView(page, 'Knowledge image documents', false);

    // The image document opens with its picture, caption, text, labels and scores.
    await page.locator('#main tr', { hasText: 'taxi-receipt.png' }).click();
    const doc = page.locator('#overlay .drawer');
    await expect(doc).toContainText('A taxi receipt from Lisbon with the fare and a card payment line');
    await expect(doc).toContainText('Text in the image');
    await expect(doc).toContainText('Fare 42.00 EUR');
    await expect(doc.locator('tr', { hasText: 'receipt' }).first()).toContainText('0.91');
    await expect(doc.locator('tr', { hasText: 'receipt' }).first()).toContainText('reached');
    await expect(doc.locator('img.kb-thumb')).toHaveAttribute('alt', 'A taxi receipt from Lisbon with the fare and a card payment line');
    await checkView(page, 'Knowledge image document', true);
    await doc.getByRole('button', { name: 'Re-classify' }).click();
    await toast(page, 'Re-classification queued for taxi-receipt.png');

    // The test search filters by the label and shows the image hit.
    await page.locator('#main [data-tab="test"]').click();
    await page.locator('#kb-sl').selectOption('receipt');
    await page.locator('#kb-q').fill('Lisbon taxi fare');
    await page.locator('#main [data-search]').click();
    const hit = page.locator('#main tr[data-chunk]').first();
    await expect(hit).toContainText('taxi-receipt.png');
    await expect(hit).toContainText('receipt 0.91');
    await hit.click();
    await expect(page.locator('#overlay .drawer')).toContainText('Text in the image (excerpt)');
    await page.locator('#overlay .drawer .btn[data-close]').click();
    await expect(page.locator('#overlay .drawer')).toHaveCount(0);
  });

  test('the Classifiers screen offers the vision engine and tests an image', async ({ page }) => {
    await open(page, 'classifiers');
    await expectLive(page);
    await page.locator('[data-new]').click();
    const modal = page.locator('#overlay .modal');
    await expect(modal.locator('[data-e] option[value="vision"]')).toHaveText('Vision model scoring images, high cost');
    await modal.getByRole('button', { name: 'Cancel' }).click();

    await page.locator('#main [data-cls]', { hasText: 'Image kinds' }).click();
    await expect(page.locator('#main h1')).toContainText('Image kinds');
    await page.locator('[data-test]').click();
    const test = page.locator('#overlay .modal');
    await expect(test).toContainText('Test an image: Image kinds');
    await test.locator('[data-testfile]').setInputFiles({ name: 'receipt.png', mimeType: 'image/png', buffer: RECEIPT });
    await test.locator('[data-classify]').click();
    await expect(test.locator('[data-testresult]')).toContainText('receipt · above threshold');
    await expect(test.locator('[data-testresult]')).toContainText('screenshot · below threshold');
    await checkView(page, 'Classifiers image test', true);
  });
});
