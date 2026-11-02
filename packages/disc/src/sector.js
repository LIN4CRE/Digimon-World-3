/**
 * CD-ROM sector helpers.
 *
 * A PlayStation disc is stored either "raw" (2352 bytes per sector, i.e. a
 * `.bin` from a redump-style dumper, as MODE2/2352 or MODE1/2352) or cooked
 * (2048 bytes per sector, i.e. a plain `.iso`). Every layer above this module
 * works in *logical blocks*: block N is the 2048 bytes of user data of
 * sector N. That keeps ISO 9660 parsing independent of the physical layout.
 *
 * Layout of a raw sector:
 *   0x000  12  sync  00 FF FF FF FF FF FF FF FF FF FF 00
 *   0x00C   3  address (minutes, seconds, frames), BCD
 *   0x00F   1  mode (1 or 2)
 * MODE 1:
 *   0x010 2048 user data
 *   0x810    4 EDC
 *   0x814  276 zero
 *   0x928    4 ECC P
 *   0x92C  168 ECC Q
 * MODE 2 (XA, Form 1 unless the subheader says otherwise):
 *   0x010    8 subheader (file, channel, submode, coding, repeated)
 *   0x018 2048 user data (Form 1) / 2324 (Form 2)
 *   0x818    4 EDC
 *   0x81C  276 ECC P+Q (Form 1 only)
 */

export const RAW_SECTOR = 2352;
export const COOKED_SECTOR = 2048;
export const SYNC = Uint8Array.from([0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00]);

/** @typedef {'MODE1/2048'|'MODE1/2352'|'MODE2/2048'|'MODE2/2324'|'MODE2/2352'} TrackMode */

/** Bytes per sector for a track mode, or null when unknown. */
export function sectorSizeOf(mode) {
  switch (mode) {
    case 'MODE1/2048':
    case 'MODE2/2048':
      return 2048;
    case 'MODE1/2352':
    case 'MODE2/2352':
      return 2352;
    case 'MODE2/2324':
      return 2324;
    default:
      return null;
  }
}

/** The byte offset of the 2048-byte user payload inside a raw sector. */
export function userOffsetOf(mode) {
  // Mode 2 sectors carry an 8-byte CD-XA subheader after the 16-byte header,
  // so their 2048 user bytes start at 24, not 16.
  if (mode === 'MODE1/2352') return 16;
  if (mode === 'MODE2/2352') return 24;
  return 0;
}

/** True when the 12-byte sync pattern is where a raw sector should have it. */
export function hasSync(raw) {
  if (!raw || raw.length < SYNC.length) return false;
  for (let i = 0; i < SYNC.length; i++) if (raw[i] !== SYNC[i]) return false;
  return true;
}

/** True for an XA Form 2 sector (2324 bytes of payload, no ECC). */
export function isForm2(raw) {
  return raw.length >= 24 && raw[0x0f] === 2 && (raw[0x12] & 0x20) !== 0;
}

const BCD = (n) => ((Math.floor(n / 10) << 4) | (n % 10)) & 0xff;
const fromBCD = (n) => (n >> 4) * 10 + (n & 0x0f);

/** Milliseconds of disc time for a logical block (75 sectors = 1 second). */
export function lbaToMs(lba) {
  return Math.round((lba * 1000) / 75);
}

/** `mm:ss:ff` for a logical block, as cue sheets and CD players show it. */
export function lbaToMsf(lba) {
  const f = lba % 75;
  const s = Math.floor(lba / 75) % 60;
  const m = Math.floor(lba / 75 / 60);
  const bcd = (n) => String(n).padStart(2, '0');
  return `${bcd(m)}:${bcd(s)}:${bcd(f)}`;
}

/** The inverse of {@link lbaToMsf}. */
export function msfToLba(msf) {
  const [m, s, f] = String(msf).split(':').map(Number);
  return m * 60 * 75 + s * 75 + f;
}

/**
 * Applies the sync pattern, BCD address and mode byte to a raw sector in
 * place. Used by the ISO writer so the images it builds are real MODE2/2352
 * dumps that a console BIOS, an emulator and a dumper all agree on.
 */
export function stampRawSector(raw, lba, mode = 2) {
  raw.set(SYNC, 0);
  const f = lba % 75;
  const s = Math.floor(lba / 75) % 60;
  const m = Math.floor(lba / 75 / 60);
  raw[0x0c] = BCD(m);
  raw[0x0d] = BCD(s);
  raw[0x0e] = BCD(f);
  raw[0x0f] = mode;
  if (mode === 1) {
    raw.fill(0, 0x810);
  }
  return raw;
}

export { BCD, fromBCD };
