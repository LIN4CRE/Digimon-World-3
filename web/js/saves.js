/**
 * Saves that never overwrite silently.
 *
 * Two kinds of state are kept:
 *   - memory cards (128 KiB), which is what the game itself writes and what a
 *     player expects to be able to export and take to another machine;
 *   - save states, an instant snapshot of the whole machine.
 *
 * Every write keeps the previous contents as a timestamped backup (a ring of
 * five), so a save that goes wrong cannot destroy the last good one.
 */
import { store, sha256 } from './cache.js';

const BACKUPS = 5;

const cardKey = (discId, slot) => `${discId}:card:${slot}`;
const stateKey = (discId, slot) => `${discId}:state:${slot}`;
const backupKey = (discId, kind, slot, at) => `${discId}:backup:${kind}:${slot}:${at}`;

async function rotateBackup(discId, kind, slot, existing) {
  if (!existing) return;
  await store.put('blobs', backupKey(discId, kind, slot, existing.updatedAt), existing);
  const prefix = `${discId}:backup:${kind}:${slot}:`;
  const keys = (await store.keys('blobs')).filter((k) => typeof k === 'string' && k.startsWith(prefix)).sort();
  for (const key of keys.slice(0, Math.max(0, keys.length - BACKUPS))) await store.delete('blobs', key);
}

export class Saves {
  constructor(discId) {
    this.discId = discId;
  }

  async listCards() {
    const out = [];
    for (const slot of [0, 1]) {
      const record = await store.get('saves', cardKey(this.discId, slot));
      out.push({
        slot,
        present: Boolean(record),
        updatedAt: record?.updatedAt ?? null,
        bytes: record?.bytes?.byteLength ?? 0,
        hash: record?.hash ?? null,
      });
    }
    return out;
  }

  /** Writes a card image, keeping the old one as a backup. */
  async writeCard(slot, bytes, { label = null } = {}) {
    const existing = await store.get('saves', cardKey(this.discId, slot));
    const hash = await sha256(bytes);
    if (existing && existing.hash === hash) return { written: false, reason: 'unchanged' };
    await rotateBackup(this.discId, 'card', slot, existing);
    await store.put('saves', cardKey(this.discId, slot), {
      bytes: bytes.slice(0),
      updatedAt: Date.now(),
      hash,
      label: label ?? existing?.label ?? null,
    });
    return { written: true, hash };
  }

  async readCard(slot) {
    const record = await store.get('saves', cardKey(this.discId, slot));
    return record ? new Uint8Array(record.bytes) : null;
  }

  async readState(slot) {
    const record = await store.get('saves', stateKey(this.discId, slot));
    return record ? new Uint8Array(record.bytes) : null;
  }

  async writeState(slot, bytes) {
    const existing = await store.get('saves', stateKey(this.discId, slot));
    await rotateBackup(this.discId, 'state', slot, existing);
    await store.put('saves', stateKey(this.discId, slot), { bytes: bytes.slice(0), updatedAt: Date.now() });
    return { written: true };
  }

  async backups() {
    const prefix = `${this.discId}:backup:`;
    const keys = (await store.keys('blobs')).filter((k) => typeof k === 'string' && k.startsWith(prefix));
    return keys
      .map((key) => {
        const [, , kind, slot, at] = key.split(':');
        return { key, kind, slot: Number(slot), at: Number(at) };
      })
      .sort((a, b) => b.at - a.at);
  }

  /** A `.mcr` file, exactly what every other PlayStation tool expects. */
  async exportCard(slot) {
    const bytes = await this.readCard(slot);
    if (!bytes) throw new Error(`Memory card slot ${slot} is empty`);
    return new Blob([bytes], { type: 'application/octet-stream' });
  }

  async importCard(slot, file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength !== 128 * 1024) {
      throw new Error(`That file is ${bytes.byteLength} bytes; a PlayStation memory card is 131072 bytes`);
    }
    return this.writeCard(slot, bytes, { label: file.name });
  }
}

/** Triggers a download in the browser. */
export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
