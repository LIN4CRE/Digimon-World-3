#!/usr/bin/env node
/**
 * Browser test for the parts of the promise that only a browser can prove:
 * the shell paints, the disc hydrates, IndexedDB keeps it, the service worker
 * takes over, and a second launch downloads nothing.
 *
 * Needs a Chromium binary and `puppeteer-core`:
 *
 *   npm install --no-save puppeteer-core
 *   CHROME_PATH=/path/to/chrome node tests/e2e/run.mjs
 *
 * Exit code is non-zero when a check fails.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

const { buildIso, openDiscBuffer, analyzeDisc } = await import(path.join(root, 'packages/disc/src/index.js'));
const { startServer } = await import(path.join(root, 'packages/server/src/server.js'));

const chromePath = process.env.CHROME_PATH;
if (!chromePath) {
  console.error('CHROME_PATH is not set; skipping the browser test (this is not a pass).');
  process.exit(2);
}
let puppeteer;
try {
  puppeteer = (await import('puppeteer-core')).default;
} catch {
  console.error('puppeteer-core is not installed: npm install --no-save puppeteer-core');
  process.exit(2);
}

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/* ── a disc to serve ───────────────────────────────────────────────────── */
const exe = new Uint8Array(await fs.readFile(path.join(root, 'tests/fixtures/homebrew.ps-exe')));
const payload = new Uint8Array(6 * 1024 * 1024).map((_, i) => (i * 2654435761) & 0xff);
const disc = buildIso({
  volumeId: 'E2ETEST',
  format: 'iso',
  files: [
    { path: 'SYSTEM.CNF', data: new TextEncoder().encode('BOOT = cdrom:\\HOMEBREW.EXE;1\r\n') },
    { path: 'HOMEBREW.EXE', data: exe },
    { path: 'AAA/PRO/STDWTITL.PRO', data: new Uint8Array(400_000).fill(3) },
    { path: 'AAA/PRO/FIELDSTG.PRO', data: new Uint8Array(600_000).fill(4) },
    { path: 'AAA/STR/BIG.STR', data: payload },
  ],
});
const image = openDiscBuffer(disc.image, { mode: disc.mode, source: 'e2e' });
const manifest = { ...(await analyzeDisc(image)), discId: 'e2e-disc', imageBytes: image.byteLength };
const { server, url, port } = await startServer({ image, manifest, port: 0, host: '127.0.0.1' });

const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'psxpress-e2e-'));
const launchOptions = {
  executablePath: chromePath,
  headless: true,
  userDataDir: profileDir,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
};

const browser = await puppeteer.launch(launchOptions);
try {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  const chunkRequests = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/disc/chunk')) chunkRequests.push(request.url());
  });

  /* ── cold launch ─────────────────────────────────────────────────────── */
  const coldStart = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const shellVisible = await page.evaluate(() => performance.now());
  check('the shell paints without waiting for JavaScript', shellVisible < 3000, `${Math.round(shellVisible)}ms to DOMContentLoaded`);

  await page.waitForFunction(() => document.querySelector('#play') && !document.querySelector('#play').disabled, { timeout: 60_000 });
  const coldSeconds = (Date.now() - coldStart) / 1000;
  const cold = await page.evaluate(async () => ({
    title: document.getElementById('game-title').textContent,
    sub: document.getElementById('game-sub').textContent,
    progress: document.getElementById('progress-text').textContent,
    play: document.getElementById('play').textContent,
    sw: Boolean(await navigator.serviceWorker.getRegistration()),
    chunks: await new Promise((resolve) => {
      const open = indexedDB.open('psxpress');
      open.onsuccess = () => {
        const request = open.result.transaction('chunks', 'readonly').objectStore('chunks').getAllKeys();
        request.onsuccess = () => resolve(request.result.length);
      };
      open.onerror = () => resolve(0);
    }),
  }));
  check('the manifest is rendered', cold.sub.includes('files'), cold.sub);
  check('the disc hydrated into IndexedDB', cold.chunks > 0, `${cold.chunks} chunks`);
  check('the service worker is registered', cold.sw);
  check('the cold launch used the chunk endpoint', chunkRequests.length > 0, `${chunkRequests.length} chunk requests`);
  check('the cold launch finished', coldSeconds < 60, `${coldSeconds.toFixed(2)}s`);
  check('no uncaught page errors on the cold path', consoleErrors.length === 0, consoleErrors.join('; '));

  /* ── warm launch ─────────────────────────────────────────────────────── */
  chunkRequests.length = 0;
  const warmStart = Date.now();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#play') && !document.querySelector('#play').disabled, { timeout: 30_000 });
  const warmSeconds = (Date.now() - warmStart) / 1000;
  check('the warm launch downloads no disc chunks', chunkRequests.length === 0, `${chunkRequests.length} chunk requests`);
  check('the warm launch is not slower than the cold one', warmSeconds <= coldSeconds, `${warmSeconds.toFixed(2)}s vs ${coldSeconds.toFixed(2)}s`);
  const warmText = await page.evaluate(() => document.getElementById('progress-text').textContent);
  check('the shell says it is serving from cache', /cached|Ready/i.test(warmText), warmText);

  /* ── the BIOS gate ───────────────────────────────────────────────────── */
  await page.click('#play');
  const dialogOpen = await page.evaluate(() => document.getElementById('bios-dialog').open);
  check('pressing Play asks for a BIOS instead of failing silently', dialogOpen);

  // A 512 KiB placeholder: this proves the storage path, not that the image is
  // a working BIOS (that requires a real one; see docs/VERIFICATION.md).
  const biosPath = path.join(profileDir, 'bios.bin');
  await fs.writeFile(biosPath, Buffer.alloc(512 * 1024, 0xff));
  const fileInput = await page.$('#bios-file');
  await fileInput.uploadFile(biosPath);
  await page.waitForFunction(() => !document.getElementById('bios-dialog').open, { timeout: 10_000 });
  const biosStored = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open('psxpress');
        open.onsuccess = () => {
          const request = open.result.transaction('meta', 'readonly').objectStore('meta').get('bios');
          request.onsuccess = () => resolve(Boolean(request.result?.bytes));
        };
      }),
  );
  check('the BIOS is stored locally, not uploaded', biosStored);

  await page.screenshot({ path: path.join(root, 'tests/e2e/last-run.png'), fullPage: false });
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(profileDir, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
