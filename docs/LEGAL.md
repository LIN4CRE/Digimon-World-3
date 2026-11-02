# Legal and security notes

## This repository contains no game data

No PlayStation disc image, no extracted asset, no BIOS, no Black Ops file. The analyser reads the disc at the path you
give it, in place, and writes only a JSON manifest describing the layout (names, extents, sizes, boot addresses).
The server streams bytes from your own file to your own browser over localhost.

The only binary in the tests is `tests/fixtures/homebrew.ps-exe` (8,800 bytes): a PS-X EXE built **from**
`romdevtools`' MIT-licensed `examples/ps1/sprite_move/main.c`, compiled here with the `romdev-mips-elf-gcc` WASM
toolchain. It contains no third-party game code and boots to a bouncing rectangle.

## The BIOS

The emulator core needs a 512 KiB PlayStation BIOS image. Sony's is copyrighted; it is not in this repository and the
platform never downloads one. You either:

- select a dump of a console you own (stored in IndexedDB on your machine, never uploaded), or
- put the MIT-licensed **OpenBIOS** from [PCSX-Redux](https://github.com/grumpycoders/pcsx-redux) at
  `web/cores/bios.bin`.

The server never uploads the BIOS anywhere; the only network requests it makes are to the origin you opened.

## Third-party components

| Component | Where it comes from | Licence | Redistributed here? |
|---|---|---|---|
| `@davidmaniliuc/substation` (PS1 core, `ps1.wasm`) | npm | **GPL-3.0-only** | No — installed by `npm install`, copied into `web/cores/` locally |
| `romdevtools` PS1 example used for the fixture | npm (`romdevtools`) | MIT (romdev's own code) | Only the *compiled* 8.8 KB homebrew executable |
| `romdev-toolchain-mips-gcc` | npm | GPL/LGPL/MIT mix (bundled compilers) | No — used at build time only |
| `@sparticuz/chromium` (used to run the browser test here) | npm | Apache-2.0 packaging of Chromium | No |

Because the core is GPL-3.0-only and is loaded as part of the running application, this project as a whole is
**GPL-3.0-only** (`LICENSE`).

## Projects assessed but not reused

| Project | Licence | Used here |
|---|---|---|
| `ReGame-Labs/dw3_decomp` | MIT | Facts only (overlay roles, disc layout) |
| `gascarcella/dw2003recomp` | MIT | Facts only (supported dump hash, port status) |
| `ArmDucks/DigimonWorld3-Recomp` | GPL-3.0 | Facts only (supported release, platforms) |
| `MisaDev4/bo1-zombies-decompiled` | **none** | Read-only assessment; no code, no binaries |

Facts are not code: quoting a repository's documentation to describe a disc layout is not copying its source.

## What this project will not do

- Download ROMs, ISO images, BIOS files or game assets from anywhere.
- Bypass copy protection or DRM. (A PlayStation CD is not encrypted; there is nothing to bypass to read one.)
- Upload your disc or BIOS to any external service.
- Claim a port or a mod works without having run it.

## Security

- The server binds `0.0.0.0` so a container preview can reach it; it serves only the `web/` tree (with traversal
  refused, tested) plus the parsed manifest and read-only ranges of the disc you passed. There is no upload endpoint
  and no write path.
- The service worker never caches `/api/` responses and only serves same-origin requests.
- The WASM core is loaded from the local origin with `application/wasm`; no third-party script runs in the page.
