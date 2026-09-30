import { test, expect, open, expectLive, toast } from './support/fixtures';

/** A file the fake ffprobe (server/test/sprint8-fakes.ts) understands: an MP4 header and the probe answer. */
function fakeMp4(): Buffer {
  const meta = { durationMs: 60_000, width: 1280, height: 720, streams: [{ type: 'video', codec: 'h264' }, { type: 'audio', codec: 'aac' }] };
  return Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'latin1'), Buffer.alloc(12), Buffer.from(`FAKEMEDIA${JSON.stringify(meta)}FAKEMEDIA`, 'latin1')]);
}

test.describe('Media', () => {
  test('uploads a video, waits for the probe and runs a preset to completion', async ({ page }) => {
    await open(page, 'media');
    await expectLive(page);
    await page.locator('[data-upload]').click();
    const modal = page.locator('#overlay .modal');
    await modal.locator('[data-file]').setInputFiles({ name: 'town-hall.mp4', mimeType: 'video/mp4', buffer: fakeMp4() });
    await modal.locator('[data-go]').click();
    await toast(page, 'town-hall.mp4 is in quarantine');

    // The probe job marks the asset ready; the preset buttons become usable.
    await expect(page.locator('[data-run]')).toBeEnabled({ timeout: 20_000 });
    await page.locator('[data-preset="clip-720p"]').click();
    await page.locator('[data-run]').click();
    const run = page.locator('#overlay .modal');
    await expect(run).toContainText('Run clip-720p on town-hall.mp4');
    await run.getByRole('button', { name: 'Queue job' }).click();
    await toast(page, 'on the media worker');
    await expect(page.locator('#main tr[data-job]').first()).toContainText('succeeded', { timeout: 20_000 });
  });
});
