/**
 * The service worker.
 *
 * Two layers of caching, deliberately separate:
 *   - this worker owns the *shell* (HTML, CSS, JS, the wasm core): precached on
 *     install, served cache-first with a background revalidate so an update
 *     lands on the next launch without ever blocking a start;
 *   - the page owns the *disc*, in IndexedDB, with content hashes and real
 *     progress (see js/loader.js). Disc chunks never pass through here.
 *
 * The API is never cached: it is the local server's view of the user's own
 * files, and a stale manifest would be a lie about what is on disk.
 */
const VERSION = 'psxpress-v1';
const SHELL = [
  '/',
  '/index.html',
  '/css/app.css',
  '/js/app.js',
  '/js/cache.js',
  '/js/loader.js',
  '/js/runtime.js',
  '/js/saves.js',
  '/js/core-constants.js',
  '/js/audio-worklet.js',
  '/js/ps1-core.js',
  '/manifest.webmanifest',
  '/assets/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      // addAll fails the whole install when one file 404s; add individually so
      // an optional file (the core wrapper, before `npm run fetch:core`) cannot
      // break offline play for everything else.
      await Promise.all(
        SHELL.map(async (url) => {
          try {
            await cache.add(new Request(url, { cache: 'reload' }));
          } catch (error) {
            console.warn('[sw] not cached:', url, error.message);
          }
        }),
      );
      self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key !== VERSION) await caches.delete(key);
      }
      await self.clients.claim();
      const clients = await self.clients.matchAll();
      for (const client of clients) client.postMessage({ type: 'version', version: VERSION });
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // never cache the server's view
  if (url.pathname.startsWith('/cores/') && url.pathname.endsWith('.wasm')) {
    event.respondWith(cacheFirst(request));
    return;
  }
  event.respondWith(staleWhileRevalidate(request));
});

async function cacheFirst(request) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  return hit ?? (await network) ?? new Response('Offline and not cached', { status: 503, statusText: 'Offline' });
}
