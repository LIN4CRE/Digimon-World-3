# Verification

Everything below was run in this repository. Where something could not be run, it says so and says why.

## Environment

| | |
|---|---|
| OS | Debian 12 (bookworm), Linux 6.1, x86-64 |
| CPU / RAM | 2 vCPU / 3 GB |
| Node.js | v22.22.3 |
| Browser | Chromium 153.0.8010.0, headless (`@sparticuz/chromium` 153.0.0 binary, AL2023 libraries) |
| GPU | none; WebGL2 is unavailable in this container, so the Canvas 2D presenter is what ran |
| Core | `@davidmaniliuc/substation` 0.1.0, `ps1.wasm` = 7,712,165 bytes |
| Disc images | none supplied. Fixtures are built by this repository's own ISO writer |

## Unit tests — 17/17

```
$ npm test
ok 1 - sector geometry: MSF round trips and raw user-data offsets
ok 2 - cue sheets parse tracks, indexes and warnings
ok 3 - SYSTEM.CNF and serials: SLES_039.36 is understood as a European disc
ok 4 - PS-EXE headers parse with the addresses a loader needs
ok 5 - an ISO written by the packer is read back with the same files
ok 6 - directories that only the path table knows about are still found
ok 7 - stage rules split a Digimon-World-3-shaped disc the way the profile says
ok 8 - a disc with no SYSTEM.CNF is reported, not silently accepted
ok 9 - a raw MODE2/2352 image is read at the right offset
ok 10 - chunk ranges are inclusive of both ends and clamped to the image
ok 11 - hydration order follows the stages, merges duplicates, and still covers the image
ok 12 - image tails the plan never mentions are still fetched
ok 13 - health reports the disc and the chunk size
ok 14 - the manifest is served with the runtime description
ok 15 - chunks carry a SHA-256 that matches the bytes they return
ok 16 - byte ranges come back as 206 with the right bytes
ok 17 - the shell is served and path traversal is refused
# pass 17   # fail 0
```

The disc tests are non-circular where it matters: the writer produces bytes, the reader parses them back, and the
assertions are about ISO 9660 structure (extents, path tables, the CD-XA offset at 24, the sync pattern) rather than
about the writer's own bookkeeping. Test 6 builds a disc whose `AAA/DAT`, `AAA/PRO` and `AAA/STR` directories are
deliberately missing from their parent's listing — the quirk that breaks generic extractors on the real
Digimon World 3 disc — and proves the analyser recovers them from the path table.

## Browser test — 12/12

```
$ CHROME_PATH=… npm run test:e2e
ok   the shell paints without waiting for JavaScript — 62ms to DOMContentLoaded
ok   the manifest is rendered — no serial in SYSTEM.CNF · ? · 5 files · 7.0 MiB payload · 3590 sectors @ 2048 B (MODE1/2048)
ok   the disc hydrated into IndexedDB — 8 chunks
ok   the service worker is registered
ok   the cold launch used the chunk endpoint — 8 chunk requests
ok   the cold launch finished — 0.20s
ok   no uncaught page errors on the cold path
ok   the warm launch downloads no disc chunks — 0 chunk requests
ok   the warm launch is not slower than the cold one — 0.08s vs 0.20s
ok   the shell says it is serving from cache — Ready in 0.0s
ok   pressing Play asks for a BIOS instead of failing silently
ok   the BIOS is stored locally, not uploaded
12/12 checks passed.
```

The 0.20 s is against a loopback server with 7 MiB of test data. It is **not** a claim about a 692 MB retail disc
over a home connection: hydration is that many bytes over that link. What the test does establish is the part that
depends on this code — staging, hashing, storage, and the fact that a second launch issues **zero** disc requests.

## Not verified, and why

| Item | State | Why |
|---|---|---|
| Booting a game in the browser | **not verified** | The core needs a 512 KiB BIOS. Sony's is copyrighted and cannot be obtained here. The MIT OpenBIOS exists but is not present in this sandbox (the `romdev-core-beetle-psx-hw` package mentions it as embedded; a scan of that wasm's 1,495 aligned 512 KiB windows and 66 licence-anchor-derived candidates found no image the core accepts). |
| WebGL2 presentation | **not verified** | This container has no GL stack: `getContext('webgl2')` returns null under every flag combination tried (`--use-angle=swiftshader`, `--use-angle=vulkan`, `--use-gl=swiftshader`). The Canvas 2D fallback is the path the tests exercised. |
| Digimon World 2003 itself | **not verified** | No disc image was supplied. The analyser is tested against a DW3-shaped fixture (overlay names, the path-table quirk, stage profile) rather than against the retail disc. |
| Frame rate / timing at 60 FPS | **not measured** | Needs a booted machine. The loop is a 60 Hz accumulator capped at three catch-up frames, with the audio ring buffer absorbing jitter; that is a design, not a measurement. |

### How to close those gaps on your machine

```bash
# 1. Does the machine boot your disc? (needs your BIOS, 512 KiB)
node tools/psxpress.mjs verify "/path/disc.cue" --bios /path/bios.bin --frames 900

# 2. Serve it and open the page; the first Play press asks for the BIOS.
node tools/psxpress.mjs serve "/path/disc.cue" --profile profiles/dw3-eu.json
```

`verify` prints `firstPictureFrame`, `firstPictureMilliseconds`, `nonBlackPixelsAtPeak`, the audio seconds produced
and the frames per second, and exits non-zero when nothing renders. Those numbers, from your hardware, are the
measurement this document is missing.

## Reproducing the environment

```bash
npm install                                 # core + wasm into web/cores
npm test                                    # 17 unit tests
npm install --no-save puppeteer-core
CHROME_PATH=/path/to/chrome npm run test:e2e
```

`tests/e2e/last-run.png` is a screenshot from the last run. The test exits 2 (not 0) when `CHROME_PATH` is missing, so
"no browser" can never look like a pass.
