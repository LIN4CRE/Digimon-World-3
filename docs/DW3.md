# Digimon World 3 / Digimon World 2003

## The disc

| Release | Executable | Serial |
|---|---|---|
| Europe — *Digimon World 2003* | `SLES_039.36` | SLES-03936 |
| USA — *Digimon World 3* | `SLUS_014.36` | SLUS-01436 |
| Japan — *…Aratanaru Bouken no Tobira* | `SLPS_034.46` | SLPS-03446 |

The European release is the one the matching decompilation and the native port target. The USA release is what the
static recompilation targets. `dw2003recomp`'s README pins the PAL dump exactly: raw `.bin` + `.cue`, MODE2/2352,
one track, **692,146,560 bytes**, SHA-1 `457cb233349ba841e03b33d8060f8fbcadd45cb3`. A 2048-byte `.iso` conversion is
not equivalent — it drops the audio sectors inside the movies.

## What the analyser expects to find

- `SYSTEM.CNF` at the root, naming the boot executable.
- The executable (a `PS-X EXE`: 2048-byte header, load address `0x80010000`, entry at `pc0`).
- `AAA/PRO/*.PRO` — the overlays, loaded right after the executable's `.bss`.
- `AAA/DAT` and `AAA/STR` — data and streamed media.
- **`AAA/DAT`, `AAA/PRO` and `AAA/STR` are only reachable through the ISO 9660 path table.** Their directory records
  are missing from their parent's listing, which is why generic ISO tools (and `dumpsxiso`) do not see them and why the
  decompilation ships its own extractor. `packages/disc/src/analyze.js` walks the tree *and* the path tables and
  merges them; files found that way are marked `viaPathTable: true` in the manifest.

Overlays and what they run, per the decompilation's `docs/binaries.md`:

| Overlay | Role |
|---|---|
| `STDWTITL` | title screen, opening movies, notice screen |
| `CNTY_SEL` | country select |
| `FIELDSTG` | field mode — walking around the map |
| `FIGHTSTG`, `WFIGHTMN`, `WFIGHTTS` | battles and their sub-overlays |
| `CARDGAME`, `STCRDABM`, `STCRDDEK`, `STCRDSHP` | card battles, album, decks, packs |
| `STSTATUS`, `STITSHOP`, `STGTRAIN`, `STGMCARD`, `STGDGLAB`, `STDGNAME`, `STPLNMET`, `STFGTREP` | menus, shops, training, saves, digivolution |
| `STAGSLCT`, `SHOCKTST`, `SOUNDTST` | debug menus |
| `WSTAG###` (238 of them) | the stages, loaded on top of `FIELDSTG` |

## The profile

`profiles/dw3-eu.json` turns those roles into stage rules:

- **core** — `SYSTEM.CNF` and `SLES_039.36`
- **front end** — title screen, name entry, debug stage select
- **first playable** — the field engine, country select, the status/shop/training/menu overlays, and `WSTAG000`–`WSTAG009`
- **everything else** — the other ~228 stages, movies and data

The first-playable set is a **hypothesis**, not a measurement: which `WSTAG` the game loads first depends on the
save and the story state. Check it against your disc:

```bash
node tools/psxpress.mjs analyze "disc.cue" --profile profiles/dw3-eu.json
```

The command prints the stage split and every rule that matched nothing, so a wrong guess is visible rather than
silent. Editing the file and re-running is the intended tuning loop.

## Playing it in the browser

```bash
node tools/psxpress.mjs serve "Digimon World 2003.cue" --profile profiles/dw3-eu.json
```

Expectations to set correctly:

- The image is 692 MB. The core needs all of it in WASM memory before it boots. First launch = download; second
  launch = IndexedDB, no network.
- Peak memory is roughly twice the image while it is copied into WASM. A `.chd` is accepted by the core and is a
  third to a half the size — convert your own dump if memory is tight.
- A BIOS is required. Use your own image, or the MIT OpenBIOS.

## If you want a genuine native Windows build

Three real projects exist. I inspected them; none of their code is in this repository.

| Project | Licence | What it is | State |
|---|---|---|---|
| [`ReGame-Labs/dw3_decomp`](https://github.com/ReGame-Labs/dw3_decomp) | MIT | matching decompilation, C that rebuilds the EU/US/JP executables byte-identically | active, tracks all three regions |
| [`gascarcella/dw2003recomp`](https://github.com/gascarcella/dw2003recomp) | MIT | the decompilation plus a native PC port reading your disc at runtime; launcher, mods | Linux x86-64 AppImage today, Windows stated as in progress |
| [`ArmDucks/DigimonWorld3-Recomp`](https://github.com/ArmDucks/DigimonWorld3-Recomp) | GPL-3.0 | static recompilation of the USA release; own runtime for GPU/SPU/GTE/CD; widescreen, HD backgrounds, gamepad | beta, builds for Windows/Linux/macOS |

For a Windows executable today, `ArmDucks/DigimonWorld3-Recomp` is the one that already claims Windows support; for a
source-level modding base, `dw2003recomp` (MIT) is the friendliest licence. Building either needs a C/C++ toolchain and
their own documented steps — this container has neither CMake nor SDL2, so they were not built here.

## What this repository adds

The decompilations tell you how the game *works*; PSXpress gives you a way to *run the disc* without an install, with
honest staging, a verified cache, and saves that survive a reload. The two are complementary: a native port is the
right answer for a permanent Windows build, and this platform is the right answer for "open a URL and play".
