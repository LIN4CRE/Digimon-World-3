/**
 * Staged hydration of a disc image.
 *
 * The manifest splits the image into stages (core, front end, first playable,
 * everything else). This module fetches the chunks those stages need, in that
 * order, with:
 *   - a small worker pool (a few parallel requests, not hundreds),
 *   - per-chunk SHA-256 verification against the server's hash,
 *   - retries with backoff, and a hard failure that names the missing chunk,
 *   - resume: chunks already in IndexedDB are skipped, so a reload continues
 *     where it stopped and a warm launch downloads nothing,
 *   - real progress: bytes actually stored, not requests sent.
 */
import { DiscCache, hasRoomFor } from './cache.js';

const RETRIES = 3;
const PARALLEL = 4;

/** Chunk indices a byte range covers. */
export function chunksForRange(start, length, chunkSize, imageBytes) {
  const first = Math.floor(start / chunkSize);
  const last = Math.floor((Math.min(imageBytes, start + length) - 1) / chunkSize);
  const out = [];
  for (let i = first; i <= last; i++) out.push(i);
  return out;
}

/**
 * The order in which chunks should arrive: by stage, merging adjacent extents.
 * The analyser already did the sector arithmetic; this converts it to bytes.
 */
export function hydrationOrder(manifest) {
  const { chunkSize, imageBytes, hydration, disc } = manifest;
  const order = [];
  const seen = new Set();
  const sorted = [...hydration].sort((a, b) => a.stageIndex - b.stageIndex || a.lba - b.lba);
  for (const extent of sorted) {
    const startBytes = extent.lba * disc.sectorSize;
    const lengthBytes = extent.sectors * disc.sectorSize;
    for (const index of chunksForRange(startBytes, lengthBytes, chunkSize, imageBytes)) {
      if (seen.has(index)) continue;
      seen.add(index);
      order.push({ index, stageIndex: extent.stageIndex });
    }
  }
  // Anything the plan did not mention still has to exist for the image to be
  // complete (linker padding, the tail of the last sector).
  for (let i = 0; i < Math.ceil(imageBytes / chunkSize); i++) {
    if (!seen.has(i)) order.push({ index: i, stageIndex: 99 });
  }
  return order;
}

export class Hydration {
  /**
   * @param {object} options
   * @param {object} options.manifest
   * @param {(event: object) => void} options.onProgress
   * @param {AbortSignal} [options.signal]
   * @param {boolean} [options.offline] only use what is already cached
   */
  constructor({ manifest, onProgress = () => {}, signal, offline = false }) {
    this.manifest = manifest;
    this.onProgress = onProgress;
    this.signal = signal;
    this.offline = offline;
    this.cache = new DiscCache(manifest.discId, { chunkSize: manifest.chunkSize, imageBytes: manifest.imageBytes });
    this.order = hydrationOrder(manifest);
    this.state = new Map(); // chunk index -> 'missing' | 'pending' | 'done' | 'failed'
    this.startedAt = 0;
    this.bytesFetched = 0;
    this.requests = 0;
    this.failures = [];
  }

  get totalChunks() {
    return this.order.length;
  }

  /** Chunks that belong to stages up to and including `stageIndex`. */
  plan(stageIndex = 99) {
    return this.order.filter((entry) => entry.stageIndex <= stageIndex);
  }

  async init() {
    await this.cache.init();
    for (const entry of this.order) this.state.set(entry.index, this.cache.has(entry.index) ? 'done' : 'missing');
    this.emit({ phase: 'ready' });
    return this;
  }

  get complete() {
    return [...this.state.values()].every((s) => s === 'done');
  }

  get stageCompleteness() {
    const stages = this.manifest.stages.map((stage) => {
      const entries = this.order.filter((e) => e.stageIndex === stage.index);
      const done = entries.filter((e) => this.state.get(e.index) === 'done').length;
      return {
        index: stage.index,
        id: stage.id,
        label: stage.label,
        totalChunks: entries.length,
        doneChunks: done,
        fraction: entries.length ? done / entries.length : 1,
      };
    });
    return stages;
  }

  emit(extra = {}) {
    const done = [...this.state.values()].filter((s) => s === 'done').length;
    const elapsed = this.startedAt ? (performance.now() - this.startedAt) / 1000 : 0;
    const bytesDone = done * this.manifest.chunkSize;
    const rate = elapsed > 0 ? this.bytesFetched / elapsed : 0;
    const remaining = (this.totalChunks - done) * this.manifest.chunkSize;
    this.onProgress({
      chunksDone: done,
      chunksTotal: this.totalChunks,
      bytesDone: Math.min(bytesDone, this.manifest.imageBytes),
      bytesTotal: this.manifest.imageBytes,
      bytesFetched: this.bytesFetched,
      fraction: this.totalChunks ? done / this.totalChunks : 0,
      rate,
      etaSeconds: rate > 0 ? remaining / rate : null,
      stages: this.stageCompleteness,
      ...extra,
    });
  }

  /**
   * Fetches every chunk in `plan`, resolving when they are all stored.
   * @param {{ upToStage?: number }} [options]
   */
  async hydrateAll({ upToStage = 99 } = {}) {
    const wanted = this.plan(upToStage).filter((entry) => this.state.get(entry.index) !== 'done');
    if (wanted.length === 0) {
      this.emit({ phase: 'cached' });
      return { fetched: 0 };
    }
    if (this.offline) throw new Error(`${wanted.length} chunks are not cached and the browser is offline`);

    const neededBytes = wanted.length * this.manifest.chunkSize;
    if (!(await hasRoomFor(neededBytes))) {
      throw Object.assign(new Error('Not enough browser storage for this disc'), { code: 'QUOTA' });
    }

    this.startedAt = performance.now();
    this.emit({ phase: 'hydrating' });
    let cursor = 0;
    const workers = new Array(Math.min(PARALLEL, wanted.length)).fill(0).map(async () => {
      for (;;) {
        if (this.signal?.aborted) throw Object.assign(new Error('Hydration cancelled'), { code: 'ABORTED' });
        const position = cursor++;
        if (position >= wanted.length) return;
        const entry = wanted[position];
        this.state.set(entry.index, 'pending');
        await this.fetchChunk(entry.index, wanted.length);
      }
    });
    await Promise.all(workers);
    this.emit({ phase: 'complete' });
    return { fetched: this.bytesFetched };
  }

  async fetchChunk(index, stageTotal) {
    let lastError;
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      if (this.signal?.aborted) throw Object.assign(new Error('Hydration cancelled'), { code: 'ABORTED' });
      try {
        const response = await fetch(`/api/disc/chunk?index=${index}`, { signal: this.signal, cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status} for chunk ${index}`);
        const buffer = await response.arrayBuffer();
        const expected = response.headers.get('x-chunk-hash');
        const result = await this.cache.put(index, buffer, expected);
        if (result && result.error) throw Object.assign(result.error, { code: 'QUOTA' });
        this.bytesFetched += buffer.byteLength;
        this.requests++;
        this.state.set(index, 'done');
        this.emit({ phase: 'hydrating' });
        return;
      } catch (error) {
        if (error.code === 'QUOTA' || error.code === 'ABORTED') throw error;
        lastError = error;
        await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      }
    }
    this.state.set(index, 'failed');
    this.failures.push({ index, error: lastError });
    this.emit({ phase: 'error', error: `Chunk ${index} of ${stageTotal} could not be downloaded: ${lastError?.message}` });
    throw Object.assign(new Error(`Chunk ${index} failed after ${RETRIES} attempts`), { code: 'CHUNK_FAILED', index });
  }

  /** The assembled image, ready for the emulator. */
  async assemble(onProgress) {
    return this.cache.assemble(onProgress);
  }
}
