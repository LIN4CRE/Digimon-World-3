/**
 * Node-side disc access (the analyser CLI, the server's ingest step and the
 * tests). The browser never parses a disc: it receives the manifest.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { openDisc, DiscImage } from './cue.js';
import { RAW_SECTOR, COOKED_SECTOR } from './sector.js';
import { analyzeDisc } from './analyze.js';

/** Opens a `.cue` (preferred) or a bare `.bin` / `.iso`. */
export async function openDiscFile(filePath) {
  const absolute = path.resolve(filePath);
  const stat = await fs.stat(absolute);
  const isCue = absolute.toLowerCase().endsWith('.cue');
  const cueText = isCue ? await fs.readFile(absolute, 'utf8') : undefined;
  const baseDir = path.dirname(absolute);
  const handles = new Map();

  const readFile = async (file, offset, length) => {
    const resolved = path.isAbsolute(file) ? file : path.join(baseDir, file);
    let handle = handles.get(resolved);
    if (!handle) {
      handle = await fs.open(resolved, 'r');
      handles.set(resolved, handle);
    }
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
  };

  const dataFile = isCue ? (cueText.match(/FILE\s+(?:"([^"]+)"|(\S+))/i) ?? []) : null;
  const dataName = isCue && dataFile ? dataFile[1] ?? dataFile[2] : absolute;
  const dataPath = path.isAbsolute(dataName) ? dataName : path.join(baseDir, dataName);
  let dataSize;
  try {
    dataSize = (await fs.stat(dataPath)).size;
  } catch {
    dataSize = stat.size;
  }

  const image = await openDisc({ path: absolute, cueText, readFile, fileSize: dataSize });
  image.close = async () => {
    for (const handle of handles.values()) await handle.close();
    handles.clear();
  };
  return image;
}

/** Wraps an in-memory image (fixtures, tests, the homebrew packer). */
export function openDiscBuffer(bytes, { mode, source = '<memory>' } = {}) {
  const sectorSize = mode === 'MODE1/2048' ? COOKED_SECTOR : RAW_SECTOR;
  const sectorCount = Math.floor(bytes.length / sectorSize);
  return new DiscImage({
    readRaw: async (lba, count) => {
      const start = lba * sectorSize;
      const end = Math.min(bytes.length, start + count * sectorSize);
      return bytes.subarray(start, Math.max(start, end));
    },
    sectorCount,
    sectorSize,
    mode: mode ?? (bytes.length % RAW_SECTOR === 0 ? 'MODE2/2352' : 'MODE1/2048'),
    source,
  });
}

/** Analyses a disc file and returns the manifest object. */
export async function analyzeFile(filePath, options = {}) {
  const image = await openDiscFile(filePath);
  try {
    return await analyzeDisc(image, options);
  } finally {
    await image.close?.();
  }
}
