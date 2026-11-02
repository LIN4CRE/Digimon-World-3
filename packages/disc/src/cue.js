/**
 * cue sheet parsing and disc image access.
 *
 * The platform reads the user's own dump. Nothing here contains game data;
 * it only describes where the data sits on the disc.
 */
import { sectorSizeOf, userOffsetOf, RAW_SECTOR } from './sector.js';

/** @typedef {{ number: number, mode: string, file: string, fileIndex: number, index01: number, data: boolean }} Track */

/**
 * Parses a cue sheet into tracks. Handles the shapes real dumps have:
 * one or several FILE lines, quoted or bare names, CRLF, and comments.
 * @param {string} text
 * @param {{ sourcePath?: string }} [options]
 * @returns {{ tracks: Track[], files: string[], warnings: string[] }}
 */
export function parseCue(text, options = {}) {
  const warnings = [];
  const tracks = [];
  const files = [];
  let currentFile = null;
  let currentFileIndex = -1;
  let pending = null;
  let trackCount = 0;

  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const m = line.match(/^(\w+)\s*(.*)$/i);
    if (!m) continue;
    const keyword = m[1].toUpperCase();
    const rest = m[2].trim();

    if (keyword === 'FILE') {
      const fm = rest.match(/^(?:"([^"]*)"|(\S+))\s+(\S+)\s*$/);
      if (!fm) {
        warnings.push(`Unparsed FILE line: ${line}`);
        continue;
      }
      currentFile = fm[1] !== undefined ? fm[1] : fm[2];
      files.push(currentFile);
      currentFileIndex++;
      if (!/^BINARY$/i.test(fm[3])) {
        warnings.push(`FILE type "${fm[3]}" is not BINARY; only BINARY images can be read`);
      }
      continue;
    }

    if (keyword === 'TRACK') {
      const tm = rest.match(/^(\d+)\s+(\S+)/);
      if (!tm) {
        warnings.push(`Unparsed TRACK line: ${line}`);
        continue;
      }
      trackCount++;
      pending = {
        number: Number(tm[1]),
        mode: tm[2].toUpperCase(),
        file: currentFile,
        fileIndex: currentFileIndex,
        index01: 0,
        data: !/^AUDIO$/i.test(tm[2]),
      };
      tracks.push(pending);
      continue;
    }

    if (keyword === 'INDEX') {
      const im = rest.match(/^(\d+)\s+(\d+:\d+:\d+)/);
      if (!im) continue;
      const idx = Number(im[1]);
      const [mm, ss, ff] = im[2].split(':').map(Number);
      const lba = mm * 60 * 75 + ss * 75 + ff;
      if (idx === 1) {
        if (!pending) {
          warnings.push('INDEX 01 without a TRACK');
          continue;
        }
        pending.index01 = lba;
      }
      continue;
    }
  }

  if (tracks.length === 0) warnings.push('The cue sheet has no tracks');
  return { tracks, files, warnings };
}

/**
 * A random-access view of a disc image. `readSectors` returns raw bytes on
 * demand from a file handle, so a 700 MB dump is never loaded into memory by
 * the analyser.
 */
export class DiscImage {
  /**
   * @param {object} init
   * @param {(lba: number, count: number) => Promise<Uint8Array>} init.readRaw
   * @param {number} init.sectorCount
   * @param {number} init.sectorSize
   * @param {string} init.mode
   * @param {string} [init.cueText]
   * @param {string} [init.source]
   * @param {import('./cue.js').Track[]} [init.tracks]
   * @param {string[]} [init.warnings]
   */
  constructor(init) {
    this.readRawAt = init.readRaw;
    this.sectorCount = init.sectorCount;
    this.sectorSize = init.sectorSize;
    this.mode = init.mode;
    this.cueText = init.cueText ?? null;
    this.source = init.source ?? null;
    this.tracks = init.tracks ?? [];
    this.warnings = init.warnings ?? [];
    this.userOffset = userOffsetOf(this.mode);
    this.cooked = this.sectorSize === 2048;
    /** Bytes of the image, physical. */
    this.byteLength = this.sectorCount * this.sectorSize;
  }

  /** The 2048 user bytes of one logical block. */
  async readBlock(lba) {
    const raw = await this.readRawAt(lba, 1);
    if (raw.length === 0) throw new Error(`Sector ${lba} is past the end of the image`);
    if (this.cooked) return raw.length >= 2048 ? raw.subarray(0, 2048) : raw;
    const slice = raw.subarray(this.userOffset, this.userOffset + 2048);
    if (slice.length < 2048) throw new Error(`Short sector at LBA ${lba}`);
    return slice;
  }

  /** `count` logical blocks as one contiguous 2048-byte-per-block buffer. */
  async readBlocks(lba, count) {
    const raw = await this.readRawAt(lba, count);
    if (this.cooked) return raw;
    const out = new Uint8Array(count * 2048);
    for (let i = 0; i < count; i++) {
      const start = i * this.sectorSize + this.userOffset;
      out.set(raw.subarray(start, start + 2048), i * 2048);
    }
    return out;
  }
}

/**
 * Opens a `.cue` (or a bare `.bin` / `.iso`) through the supplied reader.
 * @param {object} init
 * @param {string} init.path
 * @param {string} [init.cueText]  the cue sheet, when known
 * @param {(file: string, offset: number, length: number) => Promise<Uint8Array>} init.readFile
 * @param {number} init.fileSize   bytes of the data file
 */
export async function openDisc({ path, cueText, readFile, fileSize }) {
  const lowercase = path.toLowerCase();
  const isCue = lowercase.endsWith('.cue');
  let mode = null;
  let tracks = [];
  let warnings = [];
  let dataFile = path;
  let dataStart = 0;

  if (isCue) {
    const parsed = parseCue(cueText);
    tracks = parsed.tracks;
    warnings = parsed.warnings;
    const dataTracks = tracks.filter((t) => t.data);
    if (dataTracks.length === 0) throw new Error('The cue sheet has no data track');
    const track = dataTracks[0];
    mode = track.mode;
    if (parsed.files.length > 1) {
      warnings.push(
        `This cue sheet names ${parsed.files.length} files; only "${track.file}" is read. ` +
          'A single-track dump is what the streaming image loader supports.',
      );
    }
    dataFile = track.file ?? path;
    dataStart = track.index01 * (sectorSizeOf(mode) ?? RAW_SECTOR);
  } else if (lowercase.endsWith('.iso')) {
    mode = 'MODE1/2048';
    warnings.push('A 2048-byte .iso drops CD audio and some video audio; a .bin/.cue is preferred.');
  } else {
    mode = fileSize % RAW_SECTOR === 0 ? 'MODE2/2352' : 'MODE1/2048';
  }

  const sectorSize = sectorSizeOf(mode);
  if (!sectorSize) throw new Error(`Unsupported track mode: ${mode}`);
  const sectorCount = Math.floor((fileSize - dataStart) / sectorSize);

  const readRaw = async (lba, count) => {
    if (lba < 0) throw new Error(`Negative LBA ${lba}`);
    const start = dataStart + lba * sectorSize;
    const length = Math.min(count * sectorSize, fileSize - start);
    if (length <= 0) return new Uint8Array(0);
    return readFile(dataFile, start, length);
  };

  return new DiscImage({ readRaw, sectorCount, sectorSize, mode, cueText, source: path, tracks, warnings });
}
