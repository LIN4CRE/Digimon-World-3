# Development progress

One repository, three threads of work. This file is the running record; `docs/VERIFICATION.md` holds the numbers.

## 2026-11-02

### Research (complete)

- Inspected the three named repositories: `morluto/rea` (MIT, agent-oriented RE tooling), `RetroPortingToolKit/psxrecomp`
  (NOASSERTION), `MisaDev4/bo1-zombies-decompiled` (**no licence**).
- Found and inspected the real Digimon World 3 ecosystem:
  `ReGame-Labs/dw3_decomp` (MIT, matching decomp, EU/US/JP), `gascarcella/dw2003recomp` (MIT, decomp + native port),
  `ArmDucks/DigimonWorld3-Recomp` (GPL-3.0, static recompilation of the USA release), plus `markisha64/ddw3` (no
  licence), `Jack-The-Gamer/DigimonWorldsReCompiled` (Apache-2.0), `Feerdus95/dw3-native-port` (MIT).
- Confirmed the disc facts the platform depends on: boot executables per region, the `AAA/PRO` overlay set, and the
  path-table-only `AAA/DAT` / `AAA/PRO` / `AAA/STR` directories.
- Confirmed the environment cannot build a native port (no CMake/Clang/Rust/SDL2) and cannot boot a PS1 machine
  (no BIOS image obtainable).

### Platform (built and tested)

- `packages/disc`: cue/BIN reader, sector arithmetic (MODE1/2048, MODE1/2352, MODE2/2352 with the 24-byte CD-XA
  offset), ISO 9660 reader with path-table merge, PS-X EXE and `SYSTEM.CNF` parsing, stage planner, hydration planner,
  and an ISO 9660 **writer** that emits both cooked and raw (EDC/ECC) images.
- `packages/server`: zero-dependency HTTP server — manifest, 1 MiB content-hashed chunks, byte ranges, static shell
  with ETags and immutable wasm caching, traversal refused.
- `web/`: the shell (instant paint), staged hydration with per-chunk SHA-256 and resume, IndexedDB chunk cache with
  quota checks and persistence requests, service worker with offline launch, WebGL2 presenter with a Canvas 2D
  fallback, AudioWorklet ring buffer, keyboard/gamepad input, memory cards with backups and `.mcr` export/import,
  save states, fast-forward, pause.
- `tools/psxpress.mjs`: `doctor`, `analyze`, `pack`, `serve`, `verify`.
- `profiles/`: DW3 EU, DW3 US, homebrew.

### Verification

- 17/17 unit tests (`npm test`).
- 12/12 browser checks in headless Chromium 153 (`npm run test:e2e`), including: shell painted in 62 ms,
  7 MiB hydrated into IndexedDB, service worker registered, **0 disc requests on the warm launch**, BIOS stored
  locally rather than uploaded.
- Built a real PS-X EXE with the MIT `romdev` example + the WASM MIPS toolchain, packed it into a bootable disc with
  this repository's own ISO writer, and analysed it back.

### Blocked, with evidence

- **In-browser gameplay**: the core needs a 512 KiB BIOS. Sony's is proprietary; the MIT OpenBIOS is not present in
  this sandbox (scanning the beetle wasm's 1,495 aligned 512 KiB windows and 66 licence-anchor candidates produced no
  image the core accepts). `psxpress verify --bios <file>` is the one-command check that closes this on a machine with
  a BIOS.
- **WebGL2 path**: this container has no GL stack under any flag combination; the Canvas 2D fallback is what the
  browser test exercised.
- **DW3 on the real disc**: no image was supplied; the analyser is tested against a DW3-shaped fixture instead.
- **BO1**: no licence in the source repository → no code taken, no build attempted, no WebAssembly claim made. See
  `docs/BO1.md`.

## Next

1. Run `psxpress verify` with a real BIOS and a real disc; record first-picture frame and FPS in `docs/VERIFICATION.md`.
2. Tune `profiles/dw3-eu.json` `first-playable` against the actual first stage the game loads.
3. Evaluate a streaming core (libretro CD interface) so `runtime.core.streaming` can become `true`; the loader and
   chunk API already support it.
4. If the BO1 author grants a licence, return to `docs/BO1.md` step 2 (a Windows baseline build).
