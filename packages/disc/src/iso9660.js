/**
 * ISO 9660 reader.
 *
 * PlayStation discs are ISO 9660 with two twists that generic tools trip on:
 *
 *  - A directory can exist as a *path table entry* whose directory record is
 *    missing from its parent's listing. Digimon World 3 does this with
 *    `AAA/DAT`, `AAA/PRO` and `AAA/STR`, which is why the decompilation ships
 *    its own extractor. We walk the directory tree *and* the path tables and
 *    merge the results, so those directories are visible.
 *  - Names carry `;1` version suffixes and a trailing dot, and every structural
 *    number is stored twice (little-endian and big-endian) so that a disc can
 *    be read on either kind of machine.
 */

const BLOCK = 2048;

const readU32LE = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const readU16LE = (b, o) => b[o] | (b[o + 1] << 8);
const readU32BE = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

/** ISO 9660 stores volume dates as 17 ASCII digits: YYYYMMDDHHMMSSccTZ. */
function parseVolumeDate(str) {
  if (!str || str.length < 16) return null;
  const digits = str.slice(0, 16);
  if (!/^\d+$/.test(digits)) return null;
  const [y, mo, d, h, mi, s] = [0, 4, 6, 8, 10, 12].map((i) => Number(digits.slice(i, i + 2)));
  return new Date(Date.UTC(1900 + y, mo - 1, d, h, mi, s)).toISOString();
}

/** Directory records store a 7-byte binary date with a GMT offset. */
function parseDirDate(b, o) {
  if (b[o] === 0) return null;
  const year = 1900 + b[o];
  const ms = Date.UTC(year, b[o + 1] - 1, b[o + 2], b[o + 3], b[o + 4], b[o + 5]);
  return new Date(ms - b[o + 6] * 15 * 60 * 1000).toISOString();
}

const decodeAscii = (b, start, end) => {
  let s = '';
  for (let i = start; i < end && b[i] !== 0; i++) s += String.fromCharCode(b[i]);
  return s.replace(/\s+$/, '');
};

/** "SLES_039.36;1" -> "SLES_039.36"; trailing dots and versions are noise. */
export function cleanName(name) {
  return String(name).replace(/;\d+$/, '').replace(/\.$/, '');
}

/** @returns {object|null} the primary volume descriptor, or null */
export function parsePvd(block) {
  if (!block || block.length < 2048) return null;
  if (block[0] !== 1 || String.fromCharCode(block[1], block[2], block[3], block[4], block[5]) !== 'CD001') return null;
  const rootRecord = parseDirectoryRecord(block, 156);
  return {
    type: block[0],
    version: block[6],
    systemId: decodeAscii(block, 8, 40),
    volumeId: decodeAscii(block, 40, 72),
    volumeSpaceSize: readU32LE(block, 80),
    volumeSetSize: readU16LE(block, 120),
    volumeSequenceNumber: readU16LE(block, 124),
    logicalBlockSize: readU16LE(block, 128),
    pathTableSize: readU32LE(block, 132),
    pathTableLba: readU32LE(block, 140),
    optionalPathTableLba: readU32LE(block, 148),
    rootRecord,
    volumeSetId: decodeAscii(block, 190, 318),
    publisherId: decodeAscii(block, 318, 446),
    dataPreparerId: decodeAscii(block, 446, 574),
    applicationId: decodeAscii(block, 574, 702),
    copyrightFileId: decodeAscii(block, 702, 739),
    creationDate: parseVolumeDate(decodeAscii(block, 813, 830)),
    modificationDate: parseVolumeDate(decodeAscii(block, 830, 847)),
  };
}

/**
 * Parses one ISO 9660 directory record at `offset`.
 * @returns {{ length: number, lba: number, size: number, flags: number, isDirectory: boolean, name: string, date: string|null, systemUse: Uint8Array } | null}
 */
export function parseDirectoryRecord(buf, offset) {
  const length = buf[offset];
  if (!length) return null;
  const flags = buf[offset + 25];
  const nameLength = buf[offset + 32];
  const nameBytes = buf.subarray(offset + 33, offset + 33 + nameLength);
  let name;
  if (nameLength === 1 && nameBytes[0] === 0) name = '.';
  else if (nameLength === 1 && nameBytes[0] === 1) name = '..';
  else name = decodeAscii(nameBytes, 0, nameBytes.length);
  const systemUseStart = offset + 33 + nameLength + (nameLength % 2 === 0 ? 1 : 0);
  return {
    length,
    lba: readU32LE(buf, offset + 2),
    lbaBigEndian: readU32BE(buf, offset + 6),
    size: readU32LE(buf, offset + 10),
    date: parseDirDate(buf, offset + 18),
    flags,
    isDirectory: (flags & 0x02) !== 0,
    multiExtent: (flags & 0x80) !== 0,
    name,
    cleanName: cleanName(name),
    systemUse: buf.subarray(systemUseStart, offset + length),
  };
}

/** Every record in one directory block-run; `.`/`..` are dropped. */
export function parseDirectoryBlocks(buffer, length) {
  const records = [];
  const limit = Math.min(length, buffer.length);
  for (let offset = 0; offset < limit; ) {
    const length = buffer[offset];
    if (length === 0) {
      // Records never straddle a block boundary: skip to the next one.
      const next = (Math.floor(offset / BLOCK) + 1) * BLOCK;
      if (next <= offset) break;
      offset = next;
      continue;
    }
    const record = parseDirectoryRecord(buffer, offset);
    if (record && record.name !== '.' && record.name !== '..') records.push(record);
    offset += length;
  }
  return records;
}

/**
 * Reads and parses the little-endian (and optionally big-endian) path tables.
 * The path table gives a directory's LBA without walking to it, which is how
 * we recover directories that their parent does not list.
 */
export function parsePathTable(buffer, size) {
  const entries = [];
  for (let offset = 0; offset < Math.min(size, buffer.length); ) {
    const nameLength = buffer[offset];
    if (nameLength === 0) break;
    const entry = {
      name: decodeAscii(buffer, offset + 8, offset + 8 + nameLength),
      lba: readU32LE(buffer, offset + 2),
      parentIndex: readU16LE(buffer, offset + 6),
      extentAttributeLength: buffer[offset + 1],
      index: entries.length + 1,
    };
    entry.cleanName = cleanName(entry.name);
    entries.push(entry);
    offset += 8 + nameLength + (nameLength % 2 === 0 ? 1 : 0);
  }
  return entries;
}

export const ISO_BLOCK = BLOCK;
export { readU32LE, readU32BE, readU16LE, parseVolumeDate, parseDirDate };
