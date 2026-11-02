/**
 * Durable storage for the platform.
 *
 * IndexedDB holds the things that must survive a reload and can be large:
 *   - disc chunks, keyed by disc id + chunk index, each with the SHA-256 the
 *     server reported, so a cached chunk is trusted only after it verifies;
 *   - the player's BIOS image and memory cards;
 *   - settings.
 *
 * Cache Storage holds the shell (HTML/CSS/JS/wasm) through the service worker.
 * The routines here never throw on quota: they report, and the caller decides.
 */

const DB_NAME = 'psxpress';
const DB_VERSION = 1;
const STORES = { chunks: 'chunks', blobs: 'blobs', saves: 'saves', meta: 'meta' };

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORES.chunks)) {
        const store = db.createObjectStore(STORES.chunks);
        store.createIndex('disc', 'discId', { sparse: true });
      }
      if (!db.objectStoreNames.contains(STORES.blobs)) db.createObjectStore(STORES.blobs);
      if (!db.objectStoreNames.contains(STORES.saves)) db.createObjectStore(STORES.saves);
      if (!db.objectStoreNames.contains(STORES.meta)) db.createObjectStore(STORES.meta);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB refused to open'));
    request.onblocked = () => reject(new Error('IndexedDB is blocked by another tab of PSXpress'));
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const objectStore = transaction.objectStore(store);
    let result;
    try {
      result = fn(objectStore);
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve(result?.result ?? result);
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

const request = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });

/** SHA-256 of a buffer, as lowercase hex. */
export async function sha256(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class DiscCache {
  constructor(discId, { chunkSize, imageBytes }) {
    this.discId = discId;
    this.chunkSize = chunkSize;
    this.imageBytes = imageBytes;
    this.chunkCount = Math.ceil(imageBytes / chunkSize);
    this.present = new Set();
    this.bytesStored = 0;
  }

  /** Reads the chunk index once so progress starts from what is on disk. */
  async init() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORES.chunks, 'readonly');
      const index = transaction.objectStore(STORES.chunks).index('disc');
      const cursorRequest = index.openKeyCursor(IDBKeyRange.only(this.discId));
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) {
          const [discId, chunkIndex] = String(cursor.primaryKey).split(':');
          if (discId === this.discId) this.present.add(Number(chunkIndex));
          cursor.continue();
          return;
        }
        this.bytesStored = this.present.size * this.chunkSize;
        resolve(this);
      };
      cursorRequest.onerror = () => reject(cursorRequest.error);
    });
  }

  has(index) {
    return this.present.has(index);
  }

  /** Returns the verified chunk, or null when it is missing or corrupt. */
  async get(index) {
    const row = await tx(STORES.chunks, 'readonly', (store) => request(store.get(`${this.discId}:${index}`)));
    if (!row) {
      this.present.delete(index);
      return null;
    }
    if (row.hash) {
      const actual = await sha256(row.data);
      if (actual !== row.hash) {
        await this.delete(index);
        return null;
      }
    }
    return row;
  }

  async put(index, data, hash) {
    try {
      await tx(STORES.chunks, 'readwrite', (store) =>
        store.put({ discId: this.discId, index, data, hash, bytes: data.byteLength, storedAt: Date.now() }, `${this.discId}:${index}`),
      );
      this.present.add(index);
      this.bytesStored += data.byteLength;
      return true;
    } catch (error) {
      return { error };
    }
  }

  async delete(index) {
    await tx(STORES.chunks, 'readwrite', (store) => store.delete(`${this.discId}:${index}`));
    this.present.delete(index);
  }

  /** Assembles the whole image in order. Rejects when a chunk is missing. */
  async assemble(onProgress) {
    const out = new Uint8Array(this.imageBytes);
    for (let i = 0; i < this.chunkCount; i++) {
      const row = await this.get(i);
      if (!row) throw new Error(`Chunk ${i} is missing from the cache`);
      out.set(new Uint8Array(row.data), i * this.chunkSize);
      if (onProgress && (i % 8 === 0 || i === this.chunkCount - 1)) onProgress((i + 1) / this.chunkCount);
    }
    return out;
  }

  async clear() {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORES.chunks, 'readwrite');
      const index = transaction.objectStore(STORES.chunks).index('disc');
      const cursorRequest = index.openCursor(IDBKeyRange.only(this.discId));
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
          return;
        }
        resolve();
      };
      cursorRequest.onerror = () => reject(cursorRequest.error);
    });
    this.present.clear();
    this.bytesStored = 0;
  }
}

/** Small key/value helpers for the BIOS, settings and saves. */
export const store = {
  async get(storeName, key) {
    return tx(storeName, 'readonly', (s) => request(s.get(key)));
  },
  async put(storeName, key, value) {
    return tx(storeName, 'readwrite', (s) => s.put(value, key));
  },
  async delete(storeName, key) {
    return tx(storeName, 'readwrite', (s) => s.delete(key));
  },
  async keys(storeName) {
    return tx(storeName, 'readonly', (s) => request(s.getAllKeys()));
  },
  async all(storeName) {
    return tx(storeName, 'readonly', (s) => request(s.getAll()));
  },
};

/** Asks the browser to keep our data out of automatic eviction. */
export async function requestPersistence() {
  if (!navigator.storage?.persist) return { persisted: false, reason: 'unsupported' };
  if (await navigator.storage.persisted()) return { persisted: true, reason: 'already' };
  const granted = await navigator.storage.persist();
  return { persisted: granted, reason: granted ? 'granted' : 'denied' };
}

/** `{ usage, quota }` in bytes, or null when the browser will not say. */
export async function storageEstimate() {
  if (!navigator.storage?.estimate) return null;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return { usage, quota };
}

/** Thrown when a write would exceed what the browser will give us. */
export async function hasRoomFor(bytes) {
  const estimate = await storageEstimate();
  if (!estimate || !estimate.quota) return true;
  return estimate.quota - estimate.usage > bytes * 1.1;
}
