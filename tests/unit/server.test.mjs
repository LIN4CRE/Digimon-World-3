import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildIso, openDiscBuffer, analyzeDisc } from '../../packages/disc/src/index.js';
import { startServer, CHUNK_SIZE } from '../../packages/server/src/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const exe = new Uint8Array(await fs.readFile(path.join(here, '../fixtures/homebrew.ps-exe')));

/** A disc big enough to span several chunks, so range math is exercised. */
function fixtureDisc() {
  const big = new Uint8Array(3 * 1024 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = i * 31 + 7;
  return buildIso({
    volumeId: 'SERVERTEST',
    format: 'iso',
    files: [
      { path: 'SYSTEM.CNF', data: new TextEncoder().encode('BOOT = cdrom:\\HOMEBREW.EXE;1\r\n') },
      { path: 'HOMEBREW.EXE', data: exe },
      { path: 'BIG.DAT', data: big },
    ],
  });
}

async function withServer(fn) {
  const disc = fixtureDisc();
  const image = openDiscBuffer(disc.image, { mode: disc.mode, source: 'fixture' });
  const manifest = { ...(await analyzeDisc(image)), discId: 'test-disc', chunkSize: CHUNK_SIZE, imageBytes: image.byteLength };
  const { server, url } = await startServer({ image, manifest, port: 0, host: '127.0.0.1' });
  try {
    return await fn({ url, image, manifest });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('health reports the disc and the chunk size', async () => {
  await withServer(async ({ url, image }) => {
    const response = await fetch(`${url}/api/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.chunkSize, CHUNK_SIZE);
    assert.equal(body.imageBytes, image.byteLength);
  });
});

test('the manifest is served with the runtime description', async () => {
  await withServer(async ({ url }) => {
    const body = await (await fetch(`${url}/api/manifest`)).json();
    assert.equal(body.discId, 'test-disc');
    assert.equal(body.game.exe.path, 'HOMEBREW.EXE');
    assert.ok(Array.isArray(body.hydration) && body.hydration.length > 0);
  });
});

test('chunks carry a SHA-256 that matches the bytes they return', async () => {
  await withServer(async ({ url, image }) => {
    for (const index of [0, 1, 3]) {
      const response = await fetch(`${url}/api/disc/chunk?index=${index}`);
      assert.equal(response.status, 200);
      const buffer = Buffer.from(await response.arrayBuffer());
      const hash = crypto.createHash('sha256').update(buffer).digest('hex');
      assert.equal(response.headers.get('x-chunk-hash'), hash, `chunk ${index} hash`);
      const start = index * CHUNK_SIZE;
      const expectedLength = Math.min(CHUNK_SIZE, image.byteLength - start);
      assert.equal(buffer.length, expectedLength);
    }
    const past = await fetch(`${url}/api/disc/chunk?index=9999`);
    assert.equal(past.status, 416);
    const bad = await fetch(`${url}/api/disc/chunk?index=nope`);
    assert.equal(bad.status, 400);
  });
});

test('byte ranges come back as 206 with the right bytes', async () => {
  await withServer(async ({ url, image }) => {
    const start = 1234;
    const end = 98765;
    const response = await fetch(`${url}/api/disc/range?start=${start}&end=${end}`);
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end - 1}/${image.byteLength}`);
    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(body.length, end - start);
    const full = await image.readBlocks(0, Math.ceil(image.byteLength / 2048));
    assert.deepEqual(new Uint8Array(body), new Uint8Array(full.subarray(start, end)));
  });
});

test('the shell is served and path traversal is refused', async () => {
  await withServer(async ({ url }) => {
    const index = await fetch(`${url}/`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /PSXpress/);
    const traversal = await fetch(`${url}/../../etc/passwd`);
    assert.ok([403, 404].includes(traversal.status), `traversal returned ${traversal.status}`);
    const missing = await fetch(`${url}/nope.js`);
    assert.equal(missing.status, 404);
  });
});
