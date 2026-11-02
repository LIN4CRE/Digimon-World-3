import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildIso,
  openDiscBuffer,
  analyzeDisc,
  parseCue,
  parsePsxExe,
  parseSystemCnf,
  normalizeSerial,
  serialFromBootPath,
  lbaToMsf,
  msfToLba,
  userOffsetOf,
} from '../../packages/disc/src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureExe = new Uint8Array(await fs.readFile(path.join(here, '../fixtures/homebrew.ps-exe')));

const build = (files, options = {}) => {
  const disc = buildIso({ volumeId: 'TESTDISC', format: 'iso', files, ...options });
  const image = openDiscBuffer(disc.image, { mode: disc.mode, source: 'fixture' });
  return { disc, image };
};

test('sector geometry: MSF round trips and raw user-data offsets', () => {
  assert.equal(msfToLba(lbaToMsf(0)), 0);
  assert.equal(msfToLba(lbaToMsf(1234)), 1234);
  assert.equal(userOffsetOf('MODE1/2352'), 16);
  assert.equal(userOffsetOf('MODE2/2352'), 24);
  assert.equal(userOffsetOf('MODE1/2048'), 0);
});

test('cue sheets parse tracks, indexes and warnings', () => {
  const cue = parseCue(
    'REM dumped by hand\r\nFILE "game.bin" BINARY\r\n  TRACK 01 MODE2/2352\r\n    INDEX 01 00:00:00\r\n',
  );
  assert.equal(cue.tracks.length, 1);
  assert.equal(cue.tracks[0].mode, 'MODE2/2352');
  assert.equal(cue.tracks[0].file, 'game.bin');
  assert.equal(cue.tracks[0].data, true);
  assert.deepEqual(cue.warnings, []);

  const multi = parseCue('FILE "a.bin" BINARY\n TRACK 01 MODE2/2352\n INDEX 01 00:00:00\nFILE "b.bin" BINARY\n TRACK 02 AUDIO\n INDEX 01 00:00:00\n');
  assert.equal(multi.tracks.length, 2);
  assert.equal(multi.tracks[1].data, false);
  assert.deepEqual(multi.files, ['a.bin', 'b.bin']);
});

test('SYSTEM.CNF and serials: SLES_039.36 is understood as a European disc', () => {
  const cnf = parseSystemCnf('BOOT = cdrom:\\SLES_039.36;1\r\nTCB = 4\r\nEVENT = 10\r\nSTACK = 801FFF00\r\n');
  assert.equal(cnf.bootFile, 'SLES_039.36');
  assert.equal(cnf.serial, 'SLES-03936');
  assert.equal(cnf.region, 'EU');
  assert.equal(cnf.stack, '801FFF00');
  assert.equal(serialFromBootPath('cdrom:\\SLUS_014.36;1'), 'SLUS-01436');
  assert.equal(normalizeSerial('sles_039.36'), 'SLES-03936');
  assert.equal(normalizeSerial('nonsense'), null);
});

test('PS-EXE headers parse with the addresses a loader needs', () => {
  const exe = parsePsxExe(fixtureExe);
  assert.equal(exe.magic, 'PS-X EXE');
  assert.equal(exe.entryPoint, 0x80010000);
  assert.equal(exe.textAddress, 0x80010000);
  assert.ok(exe.textSize > 0);
  assert.equal(exe.loadSize, 0x800 + exe.textSize);
  assert.equal(parsePsxExe(new Uint8Array(4096)), null);
});

test('an ISO written by the packer is read back with the same files', async () => {
  const { disc, image } = build([
    { path: 'SYSTEM.CNF', data: new TextEncoder().encode('BOOT = cdrom:\\HOMEBREW.EXE;1\r\n') },
    { path: 'HOMEBREW.EXE', data: fixtureExe },
    { path: 'AAA/DAT/ITEM.DAT', data: new Uint8Array(5000).fill(7) },
    { path: 'AAA/STR/OPENING.STR', data: new Uint8Array(70000).fill(9) },
    { path: 'README.TXT', data: new TextEncoder().encode('hello world') },
  ]);
  const manifest = await analyzeDisc(image);
  const paths = manifest.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ['AAA', 'AAA/DAT', 'AAA/DAT/ITEM.DAT', 'AAA/STR', 'AAA/STR/OPENING.STR', 'HOMEBREW.EXE', 'README.TXT', 'SYSTEM.CNF']);
  assert.equal(manifest.summary.fileCount, 5);
  assert.equal(manifest.game.exe.path, 'HOMEBREW.EXE');
  assert.equal(manifest.game.exe.entryPoint, 0x80010000);
  assert.equal(manifest.disc.sectorCount, disc.sectorCount);

  const readme = manifest.files.find((f) => f.path === 'README.TXT');
  const bytes = await image.readBlocks(readme.lba, 1);
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 11)), 'hello world');
});

test('directories that only the path table knows about are still found', async () => {
  const { image } = build(
    [
      { path: 'SYSTEM.CNF', data: new TextEncoder().encode('BOOT = cdrom:\\HOMEBREW.EXE;1\r\n') },
      { path: 'HOMEBREW.EXE', data: fixtureExe },
      { path: 'AAA/DAT/ITEM.DAT', data: new Uint8Array(3000).fill(1) },
      { path: 'AAA/PRO/FIELDSTG.PRO', data: new Uint8Array(4000).fill(2) },
      { path: 'AAA/STR/OPENING.STR', data: new Uint8Array(5000).fill(3) },
    ],
    { pathTableOnly: ['AAA/DAT', 'AAA/PRO', 'AAA/STR'] },
  );
  const manifest = await analyzeDisc(image);
  const hidden = manifest.files.filter((f) => f.viaPathTable).map((f) => f.path).sort();
  assert.deepEqual(hidden, ['AAA/DAT', 'AAA/PRO', 'AAA/STR']);
  // Their contents are reachable too, which is the part that matters.
  assert.ok(manifest.files.some((f) => f.path === 'AAA/PRO/FIELDSTG.PRO'));
  assert.ok(manifest.files.some((f) => f.path === 'AAA/DAT/ITEM.DAT'));
});

test('stage rules split a Digimon-World-3-shaped disc the way the profile says', async () => {
  const profile = {
    stages: [
      { id: 'core', label: 'Core runtime' },
      { id: 'frontend', label: 'Front end' },
      { id: 'first-playable', label: 'First playable' },
      { id: 'content', label: 'Remaining content' },
    ],
    stageRules: [
      { match: '^(SYSTEM\\.CNF|SLES_039\\.36)$', stage: 'core' },
      { match: '^AAA/PRO/STDWTITL\\.PRO$', stage: 'frontend' },
      { match: '^AAA/PRO/(FIELDSTG|CNTY_SEL|WSTAG0)\\w*\\.PRO$', stage: 'first-playable' },
    ],
  };
  const { image } = build(
    [
      { path: 'SYSTEM.CNF', data: new TextEncoder().encode('BOOT = cdrom:\\SLES_039.36;1\r\n') },
      { path: 'SLES_039.36', data: fixtureExe },
      { path: 'AAA/PRO/STDWTITL.PRO', data: new Uint8Array(1000).fill(1) },
      { path: 'AAA/PRO/FIELDSTG.PRO', data: new Uint8Array(2000).fill(2) },
      { path: 'AAA/PRO/WSTAG001.PRO', data: new Uint8Array(3000).fill(3) },
      { path: 'AAA/PRO/CARDGAME.PRO', data: new Uint8Array(4000).fill(4) },
      { path: 'AAA/STR/MOVIE.STR', data: new Uint8Array(9000).fill(5) },
    ],
    { pathTableOnly: ['AAA/PRO', 'AAA/STR'] },
  );
  const manifest = await analyzeDisc(image, { profile });
  assert.equal(manifest.game.serial, 'SLES-03936');
  assert.equal(manifest.game.region, 'EU');
  const stageOf = (p) => manifest.files.find((f) => f.path === p)?.stage;
  assert.equal(stageOf('SLES_039.36'), 'core');
  assert.equal(stageOf('AAA/PRO/STDWTITL.PRO'), 'frontend');
  assert.equal(stageOf('AAA/PRO/FIELDSTG.PRO'), 'first-playable');
  assert.equal(stageOf('AAA/PRO/WSTAG001.PRO'), 'first-playable');
  assert.equal(stageOf('AAA/PRO/CARDGAME.PRO'), 'content');
  assert.equal(stageOf('AAA/STR/MOVIE.STR'), 'content');

  // The hydration plan must be ordered by stage and cover every file.
  const order = manifest.hydration.map((h) => h.stageIndex);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  const covered = new Set(manifest.hydration.flatMap((h) => h.paths));
  assert.equal(covered.size, manifest.summary.fileCount);
  assert.ok(manifest.hydration.every((h) => h.sectors > 0 && h.lba >= 0));
});

test('a disc with no SYSTEM.CNF is reported, not silently accepted', async () => {
  const { image } = build([{ path: 'README.TXT', data: new TextEncoder().encode('no boot file') }]);
  const manifest = await analyzeDisc(image);
  assert.equal(manifest.game.systemCnf, null);
  assert.ok(manifest.warnings.some((w) => w.includes('No SYSTEM.CNF')));
});

test('a raw MODE2/2352 image is read at the right offset', async () => {
  const raw = buildIso({
    volumeId: 'RAWTEST',
    format: 'bin',
    files: [
      { path: 'SYSTEM.CNF', data: new TextEncoder().encode('BOOT = cdrom:\\HOMEBREW.EXE;1\r\n') },
      { path: 'HOMEBREW.EXE', data: fixtureExe },
    ],
  });
  assert.equal(raw.sectorSize, 2352);
  assert.equal(raw.cue.includes('MODE2/2352'), true);
  const image = openDiscBuffer(raw.image, { mode: 'MODE2/2352' });
  const manifest = await analyzeDisc(image);
  assert.equal(manifest.game.exe.path, 'HOMEBREW.EXE');
  assert.equal(manifest.disc.mode, 'MODE2/2352');
  // The sync pattern and the CD-XA subheader must be where a real drive puts them.
  const sector = raw.image.subarray(16 * 2352, 17 * 2352);
  assert.equal(sector[0], 0x00);
  assert.equal(sector[1], 0xff);
  assert.equal(sector[15], 2);
  assert.equal(sector[0x12], 0x08);
});
