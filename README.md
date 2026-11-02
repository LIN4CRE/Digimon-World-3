# PSXpress

An instant-play PlayStation web platform, plus the disc analysis that feeds it.

Point it at a PlayStation disc image **you own**, open a URL, and the game boots in the browser: the shell paints
immediately, the disc is hydrated in stages with real byte progress, every chunk is cached in IndexedDB and verified
against its SHA-256, the memory card survives reloads, and the second launch needs no network at all.

Built for **Digimon World 3 / Digimon World 2003** and for any other PlayStation disc that has a `SYSTEM.CNF` and a
`PS-X EXE` boot executable.

```bash
npm install                      # fetches the WASM core, copies it into web/cores
node tools/psxpress.mjs pack tests/fixtures/homebrew.ps-exe --out builds/homebrew
node tools/psxpress.mjs serve builds/homebrew/PSXPRESS.cue --port 8080
# open http://localhost:8080
```

For a retail disc:

```bash
node tools/psxpress.mjs analyze "/path/to/Digimon World 2003.cue" --profile profiles/dw3-eu.json
node tools/psxpress.mjs serve "/path/to/Digimon World 2003.cue" --profile profiles/dw3-eu.json
```

---

## What is actually built here

| Piece | State |
|---|---|
| ISO 9660 reader that also walks the **path table** (DW3's `AAA/DAT`, `AAA/PRO`, `AAA/STR` are only reachable that way) | working, 17 unit tests |
| cue/BIN reader, MODE1/2048 and MODE2/2352 with the correct 24-byte CD-XA data offset | working, tested |
| PS-X EXE + `SYSTEM.CNF` parsing, serial/region detection | working, tested |
| ISO 9660 **writer** (MODE1/2048 and raw MODE2/2352 with sync, subheader, EDC/ECC) | working; used by `pack`, the fixtures and the tests |
| Staged hydration plan (core → front end → first playable → rest) | working, tested |
| Zero-dependency HTTP server: manifest, byte ranges, content-hashed 1 MiB chunks | working, 5 HTTP tests |
| Browser shell: instant paint, real progress, stage list, error recovery, retry | working, verified in Chromium |
| IndexedDB chunk cache with SHA-256 verification, quota checks, persistent-storage request | working, verified in Chromium |
| Service worker: shell precache, offline launch, cache-first wasm, updates | working, verified in Chromium |
| Warm launch with **zero disc downloads** | verified: 0 chunk requests on reload |
| Memory cards: autosave, backups that never overwrite silently, `.mcr` import/export | implemented |
| WebGL2 presentation with integer scaling, and a Canvas 2D fallback | implemented; Canvas 2D path exercised in the headless test |
| Audio: AudioWorklet ring buffer with underrun counting | implemented |
| Gamepad + keyboard input, save states, fast-forward, pause | implemented |
| Emulator core: `@davidmaniliuc/substation` (Zig PS1 core compiled to WASM), loaded from npm | working |
| **Actual in-browser gameplay** | **blocked here — needs a BIOS image** (see below) |

## The one honest caveat

The PS1 core this platform uses copies the **whole disc image into WASM memory** before it can boot. That has two
consequences, and they are stated in the UI rather than hidden:

1. **First play needs the complete image.** The platform hydrates it in stage order (so the file for the title screen
   arrives before 250 stage programs and movies), reports real progress and ETA, and resumes after a reload — but it
   cannot boot at 15%. True sector-level streaming needs a core that reads the disc through a callback (libretro's CD
   interface, or a kernel with an async block device); the manifest carries `runtime.core.streaming: false` so a
   streaming core can be dropped in without changing the client.
2. **Memory.** A 692 MB Disc image is 692 MB in WASM plus the assembled buffer during `loadDisc`. That fits on a
   desktop with 8 GB+ of RAM and not on a small phone. A `.chd` (which the core also accepts) is a third to a half
   the size and is the recommended form for large discs.

And a third, which is not about this code: a PlayStation BIOS image is copyrighted. The player supplies their own, or
uses the MIT-licensed **OpenBIOS**. That is why the first Play press asks for a BIOS file instead of shipping one.

## Playing

- **Keyboard** — arrows, `X` cross, `Z` circle, `A` square, `S` triangle, `Enter` start, `Shift` select, `Q`/`W` L1/R1,
  `E`/`R` L2/R2.
- **Gamepad** — the first connected pad is read through the Gamepad API: d-pad or left stick, the four face buttons,
  shoulders and triggers, back and start.
- **In game** — `Esc` pause, `Tab` fast-forward while held, `F2`/`F3` save/load state, `F11` fullscreen.
- **Saves** — the emulated memory card is written automatically every 20 seconds (and when the page closes) into
  IndexedDB, keeping the five previous versions. Settings → *Export memory card* writes a standard 128 KiB `.mcr`
  that any other PlayStation tool can read.

## Repository layout

```
packages/disc/      cue, sectors, ISO 9660 (read + write), PS-EXE, analysis and stage planning
packages/server/    zero-dependency HTTP server: manifest, ranges, hashed chunks
web/                the browser shell: loader, cache, runtime, saves, input, service worker
web/cores/          the WASM core, copied from node_modules by scripts/fetch-core.mjs (not committed)
tools/psxpress.mjs  doctor · analyze · pack · serve · verify
profiles/           game profiles (stage rules) for DW3 EU/US and homebrew
tests/unit/         node:test suites for the disc, the loader and the server
tests/e2e/          Chromium test for the shell, cache, service worker and BIOS gate
docs/               architecture, verification, DW3, the BO1 assessment, legal
```

## Commands

```
psxpress doctor                          check the toolchain
psxpress analyze <disc> [--profile p]    print the manifest (files, extents, stages, hydration plan)
psxpress pack <game.ps-exe> [--out dir]  build a bootable disc around a PS-EXE
psxpress serve <disc> [--port 8080]      serve the game to a browser
psxpress verify <disc> --bios <bios>     boot it in Node and measure frames, audio, first picture
```

`verify` is the game-play check: it loads the same core the browser uses, boots your disc with your BIOS, runs a
configurable number of frames and reports which frame first rendered a picture, the peak non-black pixel count, the
audio produced and the frames per second. It exits non-zero when nothing renders.

## Tests

```bash
npm test                                     # 17 unit tests (disc, loader, HTTP server)
npm install --no-save puppeteer-core
CHROME_PATH=/path/to/chrome npm run test:e2e # 12 browser checks
```

Last run in this repository: **17/17 unit**, **12/12 browser**. Details, numbers and the environment are in
[`docs/VERIFICATION.md`](docs/VERIFICATION.md).

## Digimon World 3

[`docs/DW3.md`](docs/DW3.md) has the disc facts the analyser relies on (boot executables per region, the overlay
layout, the path-table quirk, the exact PAL dump hash the native port expects) and the three existing DW3 projects
worth using for a *native* Windows build: a matching decompilation (MIT), a native port built from it (MIT) and a
static recompilation (GPL-3.0). This repository does not contain any of their code or any game data.

## Black Ops 1 Zombies

The MisaDev4 repository is assessed in [`docs/BO1.md`](docs/BO1.md). Short version: it has **no licence file**, it is
Windows/MSVC/DirectX-only, and it needs your Black Ops installation. Nothing from it is copied or redistributed here,
and a WebAssembly build is not available: the blockers are listed with the evidence.

## Licence

GPL-3.0-only (`LICENSE`). The WASM core (`@davidmaniliuc/substation`) is GPL-3.0-only and is installed from npm, not
vendored. Third-party components and their licences are listed in [`docs/LEGAL.md`](docs/LEGAL.md).
