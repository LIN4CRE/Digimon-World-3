/**
 * PlayStation executable and disc identification.
 *
 * Everything here is pure parsing of the user's own disc: no game data is
 * embedded, and nothing is decrypted — a PS1 disc is not encrypted.
 */

/** Regions by serial prefix. */
const SERIAL_PREFIX_REGION = {
  SLUS: 'US',
  SCUS: 'US',
  SLES: 'EU',
  SCES: 'EU',
  SLPS: 'JP',
  SCPS: 'JP',
  SLPM: 'JP',
  SCPM: 'JP',
  SLKA: 'KR',
  SLAS: 'AS',
};

/**
 * Normalises a disc serial. `SLES_039.36`, `SLES-03936` and `sles_039.36;1`
 * all become `SLES-03936`.
 */
export function normalizeSerial(raw) {
  if (!raw) return null;
  const m = String(raw)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .match(/^([A-Z]{4})(\d{5})$/);
  if (!m) return null;
  const [, prefix, digits] = m;
  if (!SERIAL_PREFIX_REGION[prefix]) return null;
  return `${prefix}-${digits}`;
}

export function regionOfSerial(serial) {
  if (!serial) return null;
  return SERIAL_PREFIX_REGION[serial.slice(0, 4)] ?? null;
}

/** The serial embedded in a boot path such as `cdrom:\SLES_039.36;1`. */
export function serialFromBootPath(bootPath) {
  const m = String(bootPath).toUpperCase().match(/([A-Z]{4})[_-]?(\d{3})\.?(\d{2})/);
  return m ? normalizeSerial(`${m[1]}${m[2]}${m[3]}`) : null;
}

/**
 * Parses `SYSTEM.CNF`, the text file at the root of every PlayStation disc
 * that tells the BIOS what to boot.
 */
export function parseSystemCnf(text) {
  const out = { raw: String(text), boot: null, stack: null, event: null, tcb: null, fields: {} };
  for (const line of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_]+)\s*=\s*(.+?)\s*$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2];
    out.fields[key] = value;
    if (key === 'boot') out.boot = value;
    else if (key === 'stack') out.stack = value;
    else if (key === 'event') out.event = parseInt(value, 16);
    else if (key === 'tcb') out.tcb = parseInt(value, 16);
  }
  out.bootFile = out.boot ? out.boot.replace(/^cdrom:?[\\/]*/i, '').replace(/;\d+$/, '') : null;
  out.serial = serialFromBootPath(out.boot ?? '');
  out.region = regionOfSerial(out.serial);
  return out;
}

export const PSX_EXE_MAGIC = 'PS-X EXE';

/**
 * Parses a PS-EXE header. Layout (little-endian):
 *   0x00 magic "PS-X EXE"      0x10 pc0        0x14 gp0
 *   0x18 text address          0x1C text size
 *   0x20 data address          0x24 data size
 *   0x28 bss address           0x2C bss size
 *   0x30 stack address         0x34 stack size
 */
export function parsePsxExe(bytes) {
  if (!bytes || bytes.length < 0x800) return null;
  const magic = String.fromCharCode(...bytes.subarray(0, 8));
  if (magic !== PSX_EXE_MAGIC) return null;
  const u32 = (o) => (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0;
  const textSize = u32(0x1c);
  return {
    magic,
    pc0: u32(0x10),
    gp0: u32(0x14),
    textAddress: u32(0x18),
    textSize,
    dataAddress: u32(0x20),
    dataSize: u32(0x24),
    bssAddress: u32(0x28),
    bssSize: u32(0x2c),
    stackAddress: u32(0x30),
    stackSize: u32(0x34),
    regionMarker: String.fromCharCode(...bytes.subarray(0x40, 0x50)).replace(/[^\x20-\x7e]/g, '').trim(),
    /** Bytes a loader has to copy: the 2048-byte header plus the text. */
    loadSize: 0x800 + textSize,
    entryPoint: u32(0x10),
    /** Does the header describe a file that is truncated on this disc? */
    declaresMoreThanPresent: false,
  };
}

/** A short, human title from the ISO volume id: `DIGIMON_WORLD_2003` -> `Digimon World 2003`. */
export function titleFromVolumeId(volumeId) {
  if (!volumeId) return null;
  const cleaned = String(volumeId).replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned
    .toLowerCase()
    .split(' ')
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

/** Guess the mode of a PS1 game from its file list; used for the analysis report. */
export function classifyLayout(files) {
  const has = (re) => files.some((f) => re.test(f.path));
  return {
    hasSystemCnf: has(/^SYSTEM\.CNF$/i),
    hasOverlays: has(/\.(PRO|OVL|BIN)$/i),
    hasStreamingMedia: has(/\.(STR|XA|XA;1)$/i),
    hasMovies: has(/\.(STR|MOV)$/i),
    hasCdda: false,
    directoryCount: new Set(files.filter((f) => f.isDirectory).map((f) => f.path)).size,
    fileCount: files.filter((f) => !f.isDirectory).length,
  };
}
