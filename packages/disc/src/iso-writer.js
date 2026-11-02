/**
 * ISO 9660 writer.
 *
 * Used for two things:
 *  - packing a homebrew PS-EXE into a bootable disc (the "single-file game"
 *    path), so the browser platform can boot something without any retail
 *    game data;
 *  - producing the fixtures the test suite runs against.
 *
 * It writes a standards-conforming ISO 9660 image with path tables and
 * optional raw MODE2/2352 framing (sync, BCD address, CD-XA subheader, EDC
 * and ECC), because an emulator or a real console is strict about the framing
 * even when it is relaxed about the file system.
 */
import { RAW_SECTOR, stampRawSector } from './sector.js';

const BLOCK = 2048;
const padName = (s, n) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));

/* ── Reed-Solomon EDC/ECC, as defined by ECMA-130 ─────────────────────── */

const eccF = new Uint8Array(256);
const eccB = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  const j = ((i << 1) ^ (i & 0x80 ? 0x11d : 0)) & 0xff;
  eccF[i] = j;
  eccB[j] = i;
}

function computeEdc(data, start, length) {
  let edc = 0;
  for (let i = 0; i < length; i++) edc = ((edc >>> 8) ^ EDC_TABLE[(edc ^ data[start + i]) & 0xff]) >>> 0;
  return edc >>> 0;
}

const EDC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let edc = i;
  for (let j = 0; j < 8; j++) edc = (edc >>> 1) ^ (edc & 1 ? 0xd8018001 : 0);
  EDC_TABLE[i] = edc >>> 0;
}

function eccBlock(src, majorCount, minorCount, majorMult, minorInc, dest, destOffset) {
  const size = majorCount * minorCount;
  for (let major = 0; major < majorCount; major++) {
    let index = ((major >> 1) * majorMult + (major & 1)) | 0;
    let a = 0;
    let b = 0;
    for (let minor = 0; minor < minorCount; minor++) {
      const temp = src[index];
      index += minorInc;
      if (index >= size) index -= size;
      a ^= temp;
      b ^= temp;
      a = eccF[a];
    }
    a = eccB[(eccF[a] ^ b) & 0xff];
    dest[destOffset + major] = a;
    dest[destOffset + major + majorCount] = (a ^ b) & 0xff;
  }
}

/** Fills EDC, P and Q for one raw MODE2 Form 1 sector (header already stamped). */
export function finishMode2Form1Sector(raw) {
  const edc = computeEdc(raw, 16, 2056); // subheader + data
  raw[0x818] = edc & 0xff;
  raw[0x819] = (edc >>> 8) & 0xff;
  raw[0x81a] = (edc >>> 16) & 0xff;
  raw[0x81b] = (edc >>> 24) & 0xff;
  raw.fill(0, 0x81c, RAW_SECTOR);
  const src = raw.subarray(0x0c, 0x81c);
  const dest = raw.subarray(0x81c);
  eccBlock(src, 86, 24, 2, 86, dest, 0);
  eccBlock(src, 52, 43, 86, 88, dest, 172);
  return raw;
}

/* ── ISO 9660 structures ──────────────────────────────────────────────── */

const bothEndian32 = (buf, offset, value) => {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = (value >>> 16) & 0xff;
  buf[offset + 3] = (value >>> 24) & 0xff;
  buf[offset + 4] = (value >>> 24) & 0xff;
  buf[offset + 5] = (value >>> 16) & 0xff;
  buf[offset + 6] = (value >>> 8) & 0xff;
  buf[offset + 7] = value & 0xff;
};

const bothEndian16 = (buf, offset, value) => {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
};

function writeDirDate(buf, offset, date = new Date()) {
  buf[offset] = date.getUTCFullYear() - 1900;
  buf[offset + 1] = date.getUTCMonth() + 1;
  buf[offset + 2] = date.getUTCDate();
  buf[offset + 3] = date.getUTCHours();
  buf[offset + 4] = date.getUTCMinutes();
  buf[offset + 5] = date.getUTCSeconds();
  buf[offset + 6] = 0;
}

function writeVolumeDate(buf, offset, date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const s =
    String(date.getUTCFullYear()).padStart(4, '0') +
    p(date.getUTCMonth() + 1) +
    p(date.getUTCDate()) +
    p(date.getUTCHours()) +
    p(date.getUTCMinutes()) +
    p(date.getUTCSeconds()) +
    '00' +
    '0';
  for (let i = 0; i < 17; i++) buf[offset + i] = s.charCodeAt(i);
}

function directoryRecordLength(nameLength) {
  const base = 33 + nameLength;
  return base + (base % 2 === 0 ? 1 : 0);
}

/**
 * @param {object} opts
 * @param {string} opts.lba extent start
 * @param {number} opts.size bytes
 * @param {number} opts.flags 2 = directory
 * @param {string} opts.name raw ISO name (files carry `;1`)
 * @param {Date} [opts.date]
 * @param {string[]} [opts.pathTableOnly] directory paths to leave out of their
 *   parent's listing while keeping them in the path table (the quirk Digimon
 *   World 3 uses for AAA/DAT, AAA/PRO and AAA/STR); used by the fixtures
 * @returns {Uint8Array} one directory record
 */
function makeDirectoryRecord({ lba, size, flags, name, date }) {
  const nameBytes = new Uint8Array([...name].map((c) => c.charCodeAt(0) & 0xff));
  const length = directoryRecordLength(nameBytes.length);
  const rec = new Uint8Array(length);
  rec[0] = length;
  rec[1] = 0;
  bothEndian32(rec, 2, lba);
  bothEndian32(rec, 10, size);
  writeDirDate(rec, 18, date);
  rec[25] = flags;
  rec[26] = 0;
  rec[27] = 0;
  bothEndian16(rec, 28, 1);
  rec[32] = nameBytes.length;
  rec.set(nameBytes, 33);
  return rec;
}

/** Splits `a/b/c.txt` into a tree of directories with files at the leaves. */
function buildTree(files) {
  const root = { name: '', path: '', dirs: new Map(), files: [], parent: null };
  for (const file of files) {
    const parts = String(file.path).replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length === 0) throw new Error(`Invalid path: ${file.path}`);
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) {
        const dir = { name: part, path: node.path ? `${node.path}/${part}` : part, dirs: new Map(), files: [], parent: node };
        node.dirs.set(part, dir);
      }
      node = node.dirs.get(part);
    }
    node.files.push({ name: parts[parts.length - 1], path: String(file.path), data: file.data });
  }
  return root;
}

function flattenDirs(root) {
  const out = [root];
  const queue = [root];
  while (queue.length) {
    const node = queue.shift();
    for (const dir of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      out.push(dir);
      queue.push(dir);
    }
  }
  return out;
}

const isoName = (name, isDir) => (isDir ? name.toUpperCase() : `${name.toUpperCase()};1`);

/**
 * Builds an ISO 9660 image (2048-byte sectors) or a raw MODE2/2352 image.
 *
 * @param {object} opts
 * @param {{path: string, data: Uint8Array}[]} opts.files
 * @param {string} [opts.volumeId]
 * @param {'iso'|'bin'} [opts.format] 'iso' = MODE1/2048, 'bin' = MODE2/2352 with EDC/ECC
 * @param {Date} [opts.date]
 * @param {string[]} [opts.pathTableOnly] directory paths to leave out of their
 *   parent's listing while keeping them in the path table (the quirk Digimon
 *   World 3 uses for AAA/DAT, AAA/PRO and AAA/STR); used by the fixtures
 * @returns {{ image: Uint8Array, sectorSize: number, sectorCount: number, mode: string, cue: string, volumeId: string }}
 */
export function buildIso({ files, volumeId = 'PSXPRESS', format = 'iso', date = new Date(), pathTableOnly = [] }) {
  const tree = buildTree(files);
  const dirs = flattenDirs(tree);

  // Directory numbers: root is 1, then breadth-first. A child's parent number
  // must be lower than its own, which breadth-first order guarantees.
  dirs.forEach((d, i) => {
    d.number = i + 1;
  });

  let pathTableSize = 0;
  for (const dir of dirs) {
    const nameLength = dir === tree ? 1 : dir.name.length;
    pathTableSize += 8 + nameLength + (nameLength % 2 === 0 ? 1 : 0);
  }
  const pathTableSectors = Math.max(1, Math.ceil(pathTableSize / BLOCK));

  let nextLba = 16 + 1 + pathTableSectors * 2;
  for (const dir of dirs) {
    dir.entries = [...dir.dirs.values()].length + dir.files.length + 2;
    const bytes = dir.entries * 48 + 64;
    dir.size = Math.max(BLOCK, Math.ceil(bytes / BLOCK) * BLOCK);
    dir.lba = nextLba;
    nextLba += dir.size / BLOCK;
  }
  for (const dir of dirs) {
    for (const file of dir.files) {
      file.lba = nextLba;
      file.size = file.data.length;
      file.sectors = Math.ceil(Math.max(file.size, 1) / BLOCK);
      nextLba += file.sectors;
    }
  }
  const totalSectors = nextLba;

  const writeBlocks = (lba, bytes) => {
    const out = new Uint8Array(bytes);
    if (format === 'iso') return { lba, out };
    const raw = new Uint8Array(RAW_SECTOR * (out.length / BLOCK));
    for (let i = 0; i < out.length / BLOCK; i++) {
      const sector = raw.subarray(i * RAW_SECTOR, (i + 1) * RAW_SECTOR);
      stampRawSector(sector, lba + i, 2);
      // CD-XA subheader: data sector, Form 1.
      sector[0x10] = 0;
      sector[0x11] = 0;
      sector[0x12] = 0x08;
      sector[0x13] = 0;
      sector.set(out.subarray(i * BLOCK, (i + 1) * BLOCK), 0x18);
      finishMode2Form1Sector(sector);
    }
    return { lba, out: raw };
  };

  const sectorSize = format === 'iso' ? BLOCK : RAW_SECTOR;
  const image = new Uint8Array(totalSectors * sectorSize);
  const put = (lba, bytes) => image.set(bytes, lba * sectorSize);

  // 16: primary volume descriptor
  const pvd = new Uint8Array(BLOCK);
  pvd[0] = 1;
  pvd.set([0x43, 0x44, 0x30, 0x30, 0x31], 1); // CD001
  pvd[6] = 1;
  pvd.set(new TextEncoder().encode(padName('PLAYSTATION', 32)), 8);
  pvd.set(new TextEncoder().encode(padName(volumeId.toUpperCase(), 32)), 40);
  bothEndian32(pvd, 80, totalSectors);
  bothEndian16(pvd, 120, 1);
  bothEndian16(pvd, 124, 1);
  bothEndian16(pvd, 128, BLOCK);
  bothEndian32(pvd, 132, pathTableSize);
  pvd.set(u32le(18), 140);
  pvd.set(u32be(19), 148);
  const rootRecord = makeDirectoryRecord({
    lba: tree.lba,
    size: tree.size,
    flags: 2,
    name: '\0',
    date,
  });
  pvd.set(rootRecord, 156);
  pvd.set(new TextEncoder().encode(padName('PSXPRESS', 128)), 318);
  pvd.set(new TextEncoder().encode(padName('PSXPRESS', 128)), 446);
  pvd.set(new TextEncoder().encode(padName('PSXPRESS', 128)), 574);
  writeVolumeDate(pvd, 813, date);
  writeVolumeDate(pvd, 830, date);
  writeVolumeDate(pvd, 847, date);
  writeVolumeDate(pvd, 864, date);
  pvd[881] = 1;
  put(16, writeBlocks(16, pvd).out);

  // 17: volume descriptor set terminator
  const terminator = new Uint8Array(BLOCK);
  terminator[0] = 255;
  terminator.set([0x43, 0x44, 0x30, 0x30, 0x31], 1);
  terminator[6] = 1;
  put(17, writeBlocks(17, terminator).out);

  // 18/19: L and M path tables
  const lPath = new Uint8Array(pathTableSectors * BLOCK);
  const mPath = new Uint8Array(pathTableSectors * BLOCK);
  let offset = 0;
  for (const dir of dirs) {
    const nameBytes = dir === tree ? new Uint8Array([0]) : new TextEncoder().encode(dir.name.toUpperCase());
    lPath[offset] = nameBytes.length;
    lPath[offset + 1] = 0;
    lPath.set(u32le(dir.lba), offset + 2);
    lPath.set(u16le(dir.parent ? dir.parent.number : 1), offset + 6);
    lPath.set(nameBytes, offset + 8);
    mPath[offset] = nameBytes.length;
    mPath[offset + 1] = 0;
    mPath.set(u32be(dir.lba), offset + 2);
    mPath.set(u16be(dir.parent ? dir.parent.number : 1), offset + 6);
    mPath.set(nameBytes, offset + 8);
    offset += 8 + nameBytes.length + (nameBytes.length % 2 === 0 ? 1 : 0);
  }
  put(18, writeBlocks(18, lPath).out);
  put(19, writeBlocks(19, mPath).out);

  // directories
  for (const dir of dirs) {
    const buf = new Uint8Array(dir.size);
    let p = 0;
    const dot = makeDirectoryRecord({ lba: dir.lba, size: dir.size, flags: 2, name: '\0', date });
    const dotdot = makeDirectoryRecord({
      lba: (dir.parent ?? dir).lba,
      size: (dir.parent ?? dir).size,
      flags: 2,
      name: '\x01',
      date,
    });
    buf.set(dot, p);
    p += dot.length;
    buf.set(dotdot, p);
    p += dotdot.length;
    const hiddenDirs = new Set(pathTableOnly.map((p) => p.toUpperCase()));
    const children = [
      ...[...dir.dirs.values()]
        .filter((d) => !hiddenDirs.has(d.path.toUpperCase()))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((d) => ({ dir: d })),
      ...[...dir.files].sort((a, b) => a.name.localeCompare(b.name)).map((f) => ({ file: f })),
    ];
    for (const child of children) {
      const rec = child.dir
        ? makeDirectoryRecord({ lba: child.dir.lba, size: child.dir.size, flags: 2, name: isoName(child.dir.name, true), date })
        : makeDirectoryRecord({
            lba: child.file.lba,
            size: child.file.size,
            flags: 0,
            name: isoName(child.file.name, false),
            date,
          });
      if (p + rec.length > buf.length) throw new Error(`Directory ${dir.path || '/'} is full`);
      buf.set(rec, p);
      p += rec.length;
    }
    put(dir.lba, writeBlocks(dir.lba, buf).out);
  }

  // files
  for (const dir of dirs) {
    for (const file of dir.files) {
      const padded = new Uint8Array(file.sectors * BLOCK);
      padded.set(file.data, 0);
      put(file.lba, writeBlocks(file.lba, padded).out);
    }
  }

  // A raw image has a sync pattern on every sector, including the 150-sector
  // system area before the volume descriptor. Stamping the padding keeps the
  // image honest to a drive even though nothing reads those sectors.
  if (format !== 'iso') {
    for (let i = 0; i < totalSectors; i++) {
      const sector = image.subarray(i * RAW_SECTOR, (i + 1) * RAW_SECTOR);
      if (sector[1] !== 0xff) stampRawSector(sector, i, 2);
    }
  }

  const cue =
    `FILE "${volumeId}.bin" BINARY\n` +
    `  TRACK 01 ${format === 'iso' ? 'MODE1/2048' : 'MODE2/2352'}\n` +
    '    INDEX 01 00:00:00\n';

  return {
    image,
    sectorSize,
    sectorCount: totalSectors,
    mode: format === 'iso' ? 'MODE1/2048' : 'MODE2/2352',
    cue,
    volumeId,
  };
}

const u32le = (v) => Uint8Array.from([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
const u32be = (v) => Uint8Array.from([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
const u16le = (v) => Uint8Array.from([v & 0xff, (v >>> 8) & 0xff]);
const u16be = (v) => Uint8Array.from([(v >>> 8) & 0xff, v & 0xff]);
