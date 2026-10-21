// smoke.spec.js — tool-specific checks for Video to GIF Converter. Fixture: tests/fixtures/sample-clip.mp4,
// a generated five second clip of a bouncing ball (see tests/tools/make-sample-clip.js). Playwright only.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const fixture = (name) => path.join(__dirname, 'fixtures', name);

async function loadClip(page) {
  await page.goto('./');
  await page.setInputFiles('#file-input', fixture('sample-clip.mp4'));
  await expect(page.locator('#editor')).toBeVisible();
  await expect(page.locator('#estimate')).toHaveAttribute('data-bytes', /\d+/);
}

async function makeGif(page) {
  await page.click('#make');
  await expect(page.locator('.gif-result')).toBeVisible({ timeout: 45_000 });
}

test.describe('Video to GIF Converter smoke', () => {
  test('loading sample-clip.mp4 shows a video preview with start and end sliders', async ({ page }) => {
    await page.goto('./');
    await expect(page.locator('#empty-state')).toContainText(/on this device/i);
    await loadClip(page);
    const video = page.locator('#preview');
    await expect(video).toBeVisible();
    const info = await video.evaluate((v) => ({ w: v.videoWidth, h: v.videoHeight, d: v.duration, ready: v.readyState }));
    expect(info.w).toBe(640);
    expect(info.h).toBe(360);
    expect(info.d).toBeCloseTo(5, 1);
    await expect(page.locator('#start-range')).toBeVisible();
    await expect(page.locator('#end-range')).toBeVisible();
    await expect(page.locator('#start-range')).toHaveValue('0');
    await expect(page.locator('#end-range')).toHaveValue('5');
    await expect(page.locator('#start')).toHaveValue('0');
    await expect(page.locator('#end')).toHaveValue('5');
    // Moving the start slider updates the numeric input and the frame count.
    await page.locator('#start-range').fill('2');
    await expect(page.locator('#start')).toHaveValue('2');
    await expect(page.locator('#estimate')).toHaveAttribute('data-frames', '30');
    await expect(page.locator('#file-info')).toContainText('sample-clip.mp4');
  });

  test('pressing Make GIF produces a downloadable .gif larger than 1 KB', async ({ page }) => {
    await loadClip(page);
    await makeGif(page);
    const button = page.locator('#download');
    await expect(button).toHaveText('Download sample-clip.gif');
    const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
    expect(download.suggestedFilename()).toBe('sample-clip.gif');
    const bytes = fs.readFileSync(await download.path());
    expect(bytes.length).toBeGreaterThan(1024);
    expect(bytes.subarray(0, 6).toString('latin1')).toBe('GIF89a');
    expect(bytes.readUInt16LE(6)).toBe(480); // logical screen width
    expect(bytes.readUInt16LE(8)).toBe(270);
    expect(bytes.includes(Buffer.from('NETSCAPE2.0'))).toBeTruthy(); // loops forever by default
    // The preview image really decodes as an animated GIF.
    const natural = await page.locator('#result-img').evaluate(async (img) => { await img.decode(); return [img.naturalWidth, img.naturalHeight]; });
    expect(natural).toEqual([480, 270]);
  });

  test('changing width to 320 and frame rate to 10 makes the estimated size smaller', async ({ page }) => {
    await loadClip(page);
    await page.selectOption('#width', '640');
    await page.selectOption('#fps', '15');
    const before = Number(await page.locator('#estimate').getAttribute('data-bytes'));
    await page.selectOption('#width', '320');
    await page.selectOption('#fps', '10');
    await expect.poll(async () => Number(await page.locator('#estimate').getAttribute('data-bytes'))).toBeLessThan(before);
    await expect(page.locator('#estimate')).toContainText('320×180');
    await expect(page.locator('#estimate')).toContainText('50 frames');
    // Also smaller than the defaults (480 px, 10 fps).
    await page.selectOption('#width', '480');
    const def = Number(await page.locator('#estimate').getAttribute('data-bytes'));
    await page.selectOption('#width', '320');
    expect(Number(await page.locator('#estimate').getAttribute('data-bytes'))).toBeLessThan(def);
  });

  test('the result shows frame count, dimensions and file size', async ({ page }) => {
    await loadClip(page);
    await page.selectOption('#width', '320');
    await page.selectOption('#fps', '8');
    await page.selectOption('#loop', '-1');
    await page.locator('#end').fill('2');
    await page.locator('#end').press('Enter'); // Enter starts the conversion
    await expect(page.locator('.gif-result')).toBeVisible({ timeout: 45_000 });
    await expect(page.locator('#result-frames')).toHaveText('16 at 8 fps');
    await expect(page.locator('#result-dims')).toHaveText('320×180 px');
    await expect(page.locator('#result-size')).toHaveText(/\d+(\.\d)? (KB|MB|B)/);
    const size = Number(await page.locator('#result-size').getAttribute('data-bytes'));
    expect(size).toBeGreaterThan(1024);
    await expect(page.locator('#result-length')).toContainText('plays once');
    await expect(page.locator('#result-note')).toContainText(/no audio/i);
    await expect(page.locator('#progress-text')).toHaveText('Done: 16 of 16 frames');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
    const bytes = fs.readFileSync(await download.path());
    expect(bytes.length).toBe(size);
    expect(bytes.includes(Buffer.from('NETSCAPE2.0'))).toBeFalsy(); // "play once" writes no loop block
  });

  test('a file that is not a video shows an error message', async ({ page }) => {
    await page.goto('./');
    await page.setInputFiles('#file-input', fixture('sample.txt'));
    await expect(page.locator('#results .alert--error')).toContainText('sample.txt is not a video');
    await expect(page.locator('#editor')).toBeHidden();
    // An audio file has no video track and is rejected too.
    await page.setInputFiles('#file-input', fixture('sample.wav'));
    await expect(page.locator('#results .alert--error')).toContainText('sample.wav is not a video');
    // A file that claims to be a video but cannot be decoded gets the codec hint.
    await page.setInputFiles('#file-input', { name: 'broken.mp4', mimeType: 'video/mp4', buffer: Buffer.from('not really a video file at all '.repeat(40)) });
    await expect(page.locator('#results .alert--error')).toContainText(/MP4 with H\.264/, { timeout: 20_000 });
    await expect(page.locator('#editor')).toBeHidden();
  });

  test('wrong files mixed with a video are rejected while the video still loads', async ({ page }) => {
    await page.goto('./');
    const files = [fixture('sample.png'), fixture('sample-clip.mp4')];
    await page.evaluate(() => { document.getElementById('file-input').multiple = true; });
    await page.setInputFiles('#file-input', files);
    await expect(page.locator('#results .alert--error')).toContainText('sample.png is not a video');
    await expect(page.locator('#editor')).toBeVisible();
  });

  test('space plays and pauses the preview', async ({ page }) => {
    await loadClip(page);
    await page.locator('#start-range').focus();
    await page.keyboard.press('Space');
    await expect.poll(() => page.locator('#preview').evaluate((v) => v.paused)).toBe(false);
    await page.keyboard.press('Space');
    await expect.poll(() => page.locator('#preview').evaluate((v) => v.paused)).toBe(true);
  });

  test('works at 390px wide', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loadClip(page);
    const noScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    expect(await noScroll()).toBeTruthy();
    await page.selectOption('#width', '320');
    await makeGif(page);
    expect(await noScroll()).toBeTruthy();
    const box = await page.locator('#download').boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    const img = await page.locator('#result-img').boundingBox();
    expect(img.x + img.width).toBeLessThanOrEqual(390);
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
    expect(download.suggestedFilename()).toBe('sample-clip.gif');
  });

  test('window.__demo shows a finished GIF from the bundled clip', async ({ page }) => {
    await page.goto('./');
    await page.evaluate(() => window.__demo());
    await expect(page.locator('.gif-result')).toBeVisible();
    await expect(page.locator('#result-dims')).toHaveText('320×180 px');
  });
});
