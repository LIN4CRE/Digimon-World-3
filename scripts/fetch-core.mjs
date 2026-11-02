#!/usr/bin/env node
/**
 * Copies the PlayStation core out of node_modules into web/cores so the server
 * can hand it to the browser with an immutable cache header.
 *
 * The core is `@davidmaniliuc/substation` (GPL-3.0-only): a Zig PlayStation
 * emulator compiled to WASM, synchronous and DOM-free. `npm install` brings it
 * in; this script only moves files, so the repository does not vendor a binary
 * it cannot rebuild.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = path.join(root, 'node_modules/@davidmaniliuc/substation/dist');
const outDir = path.join(root, 'web/cores');

const files = [
  ['index.js', 'ps1-core.js'],
  ['ps1.wasm', 'ps1.wasm'],
];

await fs.mkdir(outDir, { recursive: true });
for (const [from, to] of files) {
  const source = path.join(packageDir, from);
  try {
    await fs.copyFile(source, path.join(outDir, to));
    const { size } = await fs.stat(path.join(outDir, to));
    console.log(`copied ${from} -> web/cores/${to} (${(size / 1048576).toFixed(2)} MiB)`);
  } catch (error) {
    console.error(`could not copy ${source}: ${error.message}`);
    console.error('run `npm install` first');
    process.exit(1);
  }
}

// Record what was copied: the manifest and the docs quote this.
const pkg = JSON.parse(await fs.readFile(path.join(root, 'node_modules/@davidmaniliuc/substation/package.json'), 'utf8'));
await fs.writeFile(
  path.join(outDir, 'CORE.json'),
  JSON.stringify({ name: pkg.name, version: pkg.version, license: pkg.license, repository: pkg.repository?.url }, null, 2),
);
console.log('wrote web/cores/CORE.json');
