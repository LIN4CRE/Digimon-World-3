# Architecture

```
 disc image (yours)                browser
 ─────────────────                 ────────────────────────────────────────────────
 .cue/.bin/.iso
      │
      ▼
 packages/disc  ── analyse ──▶  manifest.json  ──▶  /api/manifest
   cue → tracks                       │
   sectors → logical blocks           │              web/js/loader.js
   ISO 9660 → files, path table       │                stage order, 4 workers,
   SYSTEM.CNF → boot exe              │                per-chunk SHA-256, retries
   PS-EXE → load addresses            │                      │
   profile → stages + extents         │                      ▼
      │                               │              web/js/cache.js
      ▼                               │                IndexedDB chunks,
 packages/server ── /api/disc/… ──────┘                quota, persistence
   chunk?index=     (1 MiB, hashed)
   range?start&end  (206)
   chunks           (all hashes)
                                      │                      │ assemble
                                      │                      ▼
                                      │              web/js/runtime.js
                                      │                Ps1Core (WASM)
                                      │                + Presenter (WebGL2 / 2D)
                                      │                + AudioWorklet ring buffer
                                      │                + Pad (keyboard/gamepad)
                                      │                      │
                                      │                      ▼
                                      │              web/js/saves.js → IndexedDB
                                      │                memory cards, states, backups
```

## Why the disc is served as chunks

The client must be able to (a) show real progress, (b) resume after a reload or a dropped connection, (c) prove that
what it cached is what the server has, and (d) never re-download an unchanged byte. Fixed 1 MiB chunks give all four
with no extra protocol: each response carries `x-chunk-hash`, the client stores the hash next to the bytes and
verifies on read, and the `chunks` endpoint lists every hash so a cache can be diffed without touching the image.

Byte ranges are also implemented (`/api/disc/range`) because a streaming core would need them; the current core takes
a whole image, so the client uses chunks.

## The staging model

`packages/disc/src/analyze.js` walks the ISO 9660 tree **and** the path tables, then assigns every file to a stage
through a profile's ordered regex rules. The result is:

- `stages[]` — human labels plus the files and byte counts in each;
- `hydration[]` — contiguous `(lba, sectors)` extents per stage, merged when neighbouring files sit next to each
  other, ordered by stage. This is what the client fetches, in order, four chunks at a time.

A generic profile gives `core → front end → first playable → remaining content`. DW3's profile
(`profiles/dw3-eu.json`) fills those stages from the roles the decompilation documents for each overlay.

## What the core costs, and what that means

`@davidmaniliuc/substation` is a Zig PlayStation emulator compiled to WASM. Its wrapper says it plainly: the disc is
copied into wasm memory, one disc per core, no disc swap. So:

- hydration must finish before `loadDisc` can run;
- peak memory is roughly *image + image* during the copy (692 MB → ~1.4 GB transiently);
- the first paint of the game cannot happen at 15% of the download, and the UI says so;
- a `.chd` is accepted by the core and is a third to a half the size of a `.bin`, which is the practical way to play
  a 700 MB disc in a browser today.

A core that reads sectors through a callback would remove the first two limits. The platform is already shaped for
that: `runtime.core.streaming` comes from the manifest, the hydration plan is extent-based, and the server speaks
byte ranges. Swapping the core is a change to `web/js/runtime.js` and the manifest, not to the loader or the cache.

## Caching layers

| Layer | Holds | Eviction |
|---|---|---|
| Service worker `Cache Storage` (`psxpress-v1`) | shell: HTML, CSS, JS, wasm | replaced wholesale when `VERSION` changes |
| IndexedDB `chunks` | disc chunks + their SHA-256 | explicit "clear cached downloads", or browser eviction |
| IndexedDB `meta` | BIOS, settings | never evicted while the browser keeps the origin |
| IndexedDB `saves` / `blobs` | memory cards, save states, five backups per slot | item-level |
| `navigator.storage.persist()` | marks the origin persistent | requested at boot, result shown in the footer |

The service worker never caches `/api/…`: a stale manifest would misdescribe the disc on disk.

## Failure behaviour

- A chunk that fails four times raises a named error with the chunk index and a Retry button; completed chunks stay
  cached, so the retry resumes.
- A write that hits the quota surfaces as `QUOTA` before the download starts (`hasRoomFor` checks
  `storage.estimate()` against the remaining chunk bytes); mid-write failures are reported per chunk.
- Without WebGL2 the presenter falls back to Canvas 2D; without either, the error names the browser limitation.
- Without a BIOS the Play button opens the BIOS dialog instead of failing at boot.
- A core that rejects the BIOS (`BAD_BIOS_SIZE`) reopens the dialog with the actual size it received.
