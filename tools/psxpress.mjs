#!/usr/bin/env node
/**
 * psxpress — analyse a disc, pack a homebrew executable into a bootable disc,
 * serve an instant-play browser build.
 *
 *   psxpress doctor
 *   psxpress analyze <disc.bin|disc.cue> [--json out.json] [--profile profiles/dw3-eu.json]
 *   psxpress pack <game.ps-exe> [--out builds/game] [--volume-id NAME]
 *   psxpress serve <disc.bin|disc.cue> [--port 8080] [--profile ...] [--dev]
 *
 * Everything a legal copy of a disc is needed for happens locally: the disc is
 * read from the path you pass and is never uploaded anywhere.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const { openDiscFile, openDiscBuffer, analyzeDisc, buildIso } = await import(path.join(ROOT, 'packages/disc/src/index.js'));
const { startServer } = await import(path.join(ROOT, 'packages/server/src/server.js'));

function usage(exitCode = 0) {
  console.log(`psxpress — instant-play PlayStation web platform

  doctor                                   check the toolchain and report what is missing
  analyze <disc.bin|disc.cue>              print a disc manifest (files, stages, boot exe)
  pack <game.ps-exe> [--out DIR]           build a bootable disc around a PS-EXE
  serve <disc.bin|disc.cue> [--port 8080]  serve a game to the browser
  verify <disc.bin|disc.cue> --bios <bios> boot the machine in Node and measure it

Options
  --profile <file>   a game profile (profiles/dw3-eu.json)
  --json <file>      write the manifest to a file
  --out <dir>        output directory for pack
  --volume-id <id>   volume label for pack (default: PSXPRESS)
  --port <n>         port for serve (default: 8080)
  --host <addr>      bind address (default: 0.0.0.0)
  --dev              disable client caching (for development)
  --bios <file>      a 512 KiB BIOS image for verify
  --frames <n>       frames to run in verify (default: 900)
`);
  process.exit(exitCode);
}

const args = process.argv.slice(2);
const command = args[0];
if (!command || command === '-h' || command === '--help') usage(0);

const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

function positional(count = 1) {
  const values = args.slice(1).filter((a) => !a.startsWith('--'));
  const filtered = [];
  for (let i = 0; i < values.length; i++) {
    if (args[i] && args[i].startsWith('--')) continue;
    filtered.push(values[i]);
  }
  if (!filtered.length) usage(1);
  return filtered.slice(0, count);
}

async function loadProfile() {
  const file = flag('profile');
  if (!file) return null;
  const text = await fs.readFile(path.resolve(file), 'utf8');
  return JSON.parse(text);
}

async function doctor() {
  const checks = [];
  const version = process.versions.node;
  checks.push({ name: 'Node.js', ok: Number(version.split('.')[0]) >= 18, detail: `v${version} (18 or newer needed)` });
  const webRoot = path.join(ROOT, 'web');
  for (const file of ['index.html', 'js/app.js', 'sw.js']) {
    const exists = await fs.stat(path.join(webRoot, file)).then(() => true).catch(() => false);
    checks.push({ name: `web/${file}`, ok: exists, detail: exists ? 'present' : 'missing' });
  }
  const corePath = path.join(ROOT, 'web/cores/ps1.wasm');
  const hasCore = await fs.stat(corePath).then(() => true).catch(() => false);
  checks.push({
    name: 'PS1 core (web/cores/ps1.wasm)',
    ok: hasCore,
    detail: hasCore ? 'present' : 'run: npm run fetch:core',
  });
  const bios = await fs.stat(path.join(ROOT, 'web/cores/bios.bin')).then(() => true).catch(() => false);
  checks.push({
    name: 'BIOS (web/cores/bios.bin)',
    ok: true,
    optional: true,
    detail: bios ? 'bundled with this checkout' : 'not present — the player supplies their own, or OpenBIOS (MIT)',
  });
  for (const check of checks) {
    const mark = check.ok ? 'ok  ' : check.optional ? 'note' : 'FAIL';
    console.log(`[${mark}] ${check.name}: ${check.detail}`);
  }
  const failed = checks.filter((c) => !c.ok && !c.optional).length;
  console.log(failed ? `\n${failed} check(s) failed.` : '\nAll required checks passed.');
  process.exit(failed ? 1 : 0);
}

async function analyze() {
  const [discPath] = positional();
  const profile = await loadProfile();
  const image = await openDiscFile(discPath);
  try {
    const manifest = await analyzeDisc(image, { profile });
    const out = flag('json');
    const text = JSON.stringify(manifest, null, 2);
    if (out) {
      await fs.writeFile(path.resolve(out), text);
      console.log(`Manifest written to ${out}`);
    } else {
      console.log(text);
    }
    const { game, summary, stages } = manifest;
    console.error(
      `\n${game.title ?? 'Unknown disc'} — ${game.serial ?? 'no serial'} (${game.region ?? 'unknown region'})\n` +
        `${summary.fileCount} files, ${(summary.payloadBytes / 1048576).toFixed(1)} MiB of payload, ` +
        `${manifest.disc.sectorCount} sectors @ ${manifest.disc.sectorSize} bytes\n` +
        stages.map((s) => `  stage ${s.index} ${s.id.padEnd(16)} ${(s.bytes / 1048576).toFixed(1)} MiB`).join('\n'),
    );
    for (const warning of manifest.warnings) console.error(`warning: ${warning}`);
  } finally {
    await image.close?.();
  }
}

async function pack() {
  const [exePath] = positional();
  const exe = new Uint8Array(await fs.readFile(exePath));
  if (String.fromCharCode(...exe.subarray(0, 8)) !== 'PS-X EXE') {
    console.error(`${exePath} is not a PS-EXE (missing the "PS-X EXE" header)`);
    process.exit(1);
  }
  const name = `${path.basename(exePath).replace(/\.(ps-exe|exe)$/i, '').toUpperCase()}.EXE`;
  const volumeId = (flag('volume-id', 'PSXPRESS') ?? 'PSXPRESS').toUpperCase();
  const cnf = Buffer.from(`BOOT = cdrom:\\${name};1\r\nTCB = 4\r\nEVENT = 10\r\nSTACK = 801FFF00\r\n`, 'latin1');
  const disc = buildIso({ volumeId, format: 'iso', files: [{ path: 'SYSTEM.CNF', data: cnf }, { path: name, data: exe }] });
  const outDir = path.resolve(flag('out', path.join(ROOT, 'builds', path.basename(exePath, path.extname(exePath)))));
  await fs.mkdir(outDir, { recursive: true });
  const binPath = path.join(outDir, `${volumeId}.bin`);
  const cuePath = path.join(outDir, `${volumeId}.cue`);
  await fs.writeFile(binPath, disc.image);
  await fs.writeFile(cuePath, disc.cue.replace(`${volumeId}.bin`, path.basename(binPath)));
  const manifest = await analyzeDisc(openDiscBuffer(disc.image, { mode: disc.mode, source: binPath }));
  await fs.writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`Wrote ${binPath} (${disc.image.length} bytes, ${disc.sectorCount} sectors)`);
  console.log(`Wrote ${cuePath}`);
  console.log(`Analyzed: ${manifest.summary.fileCount} files, boot exe ${manifest.game.exe?.path}`);
}

async function serve() {
  const [discPath] = positional();
  const profile = await loadProfile();
  const image = await openDiscFile(discPath);
  const manifest = await analyzeDisc(image, { profile });
  const discId = createHash('sha256')
    .update(`${image.sectorCount}:${image.sectorSize}:${manifest.game.serial ?? ''}`)
    .digest('hex')
    .slice(0, 16);
  const fullManifest = {
    ...manifest,
    disc: { ...manifest.disc, cueText: image.cueText ?? null },
    discId,
    runtime: {
      core: {
        name: 'ps1-wasm (substation)',
        wasm: '/cores/ps1.wasm',
        wrapper: '/cores/ps1-core.js',
        // The core copies the whole image into wasm memory, so it cannot boot
        // from a partially hydrated disc. The client still hydrates in stage
        // order and caches everything, which is what makes the second launch
        // instant; true sector streaming needs a core with a CD callback.
        streaming: false,
        streamingNote:
          'This core needs the complete image before it boots. The platform hydrates it in stage order and caches it, so later launches need no download.',
      },
      bios: { required: true, accepts: 'any 512 KiB PlayStation BIOS, or the MIT OpenBIOS', store: 'indexeddb' },
      video: 'webgl2',
      audio: 'audioworklet',
    },
  };
  const port = Number(flag('port', '8080'));
  const host = flag('host', '0.0.0.0');
  const { url } = await startServer({ image, manifest: fullManifest, port, host, dev: has('dev') });
  console.log(`\nPSXpress serving ${manifest.game.title ?? 'disc'} (${manifest.game.serial ?? 'no serial'})`);
  console.log(`  ${manifest.disc.sectorCount} sectors · ${(image.byteLength / 1048576).toFixed(1)} MiB image · disc id ${discId}`);
  console.log(`  ${url}`);
  console.log('\nOpen the URL, then (first run only) choose your BIOS image. Ctrl+C to stop.');
  process.on('SIGINT', async () => {
    await image.close?.();
    process.exit(0);
  });
}

/**
 * Boots the disc in Node with the same core the browser uses, and reports what
 * actually happened: which frame first showed a picture, how many frames ran,
 * how much audio came out and how long the machine took to get there. This is
 * the honest "does the game run" check; it needs a BIOS because the core has no
 * built-in HLE replacement.
 */
async function verify() {
  const [discPath] = positional();
  const biosPath = flag('bios');
  const frames = Number(flag('frames', '900'));
  if (!biosPath) {
    console.error('verify needs --bios <file>: a 512 KiB PlayStation BIOS image (your own, or the MIT OpenBIOS).');
    process.exit(2);
  }
  const bios = new Uint8Array(await fs.readFile(path.resolve(biosPath)));
  if (bios.byteLength !== 512 * 1024) {
    console.error(`That BIOS is ${bios.byteLength} bytes; a PlayStation BIOS image is exactly 524288.`);
    process.exit(2);
  }
  const coreDir = path.join(ROOT, 'node_modules/@davidmaniliuc/substation/dist');
  const { Ps1Core } = await import(path.join(coreDir, 'index.js'));
  const coreWasm = new Uint8Array(await fs.readFile(path.join(coreDir, 'ps1.wasm')));
  const image = await openDiscFile(discPath);
  try {
    const manifest = await analyzeDisc(image);
    const bytes = await image.readRawAt(0, image.sectorCount);
    const cue = image.cueText ?? `FILE "disc.bin" BINARY\n  TRACK 01 ${image.mode}\n    INDEX 01 00:00:00\n`;
    const t0 = performance.now();
    const core = await Ps1Core.create(coreWasm, { onLog: () => {} });
    core.setCpuEngine('cached');
    const biosInfo = core.loadBios(bios);
    core.loadDisc({ bin: bytes, cue });
    const tBoot = performance.now();
    let firstPictureFrame = null;
    let firstPictureAt = null;
    let nonBlackPeak = 0;
    let audioBytes = 0;
    for (let i = 0; i < frames; i++) {
      core.runFrame();
      const audio = core.readAudio();
      if (audio) audioBytes += audio.length;
      if (i % 10 === 0) {
        const frame = core.frame();
        let nonBlack = 0;
        for (let p = 0; p < frame.rgba.length; p += 4) if (frame.rgba[p] | frame.rgba[p + 1] | frame.rgba[p + 2]) nonBlack++;
        if (nonBlack > nonBlackPeak) nonBlackPeak = nonBlack;
        if (nonBlack > 0 && firstPictureFrame === null) {
          firstPictureFrame = i;
          firstPictureAt = performance.now();
        }
      }
    }
    const tEnd = performance.now();
    const report = {
      disc: discPath,
      game: { title: manifest.game.title, serial: manifest.game.serial, region: manifest.game.region },
      bios: biosInfo,
      machine: { pal: core.isPal, frames, framesPerSecond: Number(((frames * 1000) / (tEnd - tBoot)).toFixed(1)) },
      boot: {
        loadMilliseconds: Number((tBoot - t0).toFixed(1)),
        firstPictureFrame,
        firstPictureMilliseconds: firstPictureAt ? Number((firstPictureAt - tBoot).toFixed(1)) : null,
        nonBlackPixelsAtPeak: nonBlackPeak,
      },
      audio: { samples: audioBytes, seconds: Number((audioBytes / 2 / 44100).toFixed(2)) },
    };
    console.log(JSON.stringify(report, null, 2));
    const ran = firstPictureFrame !== null;
    console.error(
      ran
        ? `\nThe machine rendered its first picture at frame ${firstPictureFrame} (${report.boot.firstPictureMilliseconds}ms after load).`
        : '\nNo picture was rendered in the frames measured. Either the BIOS does not boot this disc, or the disc needs user input before drawing.',
    );
    process.exit(ran ? 0 : 1);
  } finally {
    await image.close?.();
  }
}

const commands = { doctor, analyze, pack, serve, verify };
if (!commands[command]) {
  console.error(`Unknown command: ${command}`);
  usage(1);
}
await commands[command]();
