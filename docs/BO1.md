# Black Ops 1 Zombies engine modding — assessment

Repository inspected: `MisaDev4/bo1-zombies-decompiled` (C++, ~95 MB checkout, last push 2026-10-04, 315 stars).
Cloned read-only into a scratch directory. **No file from it is copied, modified or redistributed by this project.**

## What it is

Its README says it in one line: *"Decompiled engine code for Black Ops 1 Zombies, so mods can change the engine
itself, not just scripts and maps."* The tree matches that: `src/cgame`, `bgame`, `game_mp`, `game_sp`,
`client_mp`, `clientscript`, `gfx_d3d`, `physics`, `DW` (DemonWare), `live`, `binklib`, `mjpeg`, plus a `mods/`
directory with `_stack`, `horde`, `mapkit`, `nightmare`, `noperks`, `sandbox`, `zinfo`.

## Licence: none

- The GitHub repository metadata reports **no licence** (`license: null`), and there is **no `LICENSE` file at the
  repository root**.
- Four files whose names mention a licence exist, but they sit under third-party libraries; they say nothing about
  the engine source itself.
- No licence means the default applies: the author keeps all rights. It is **not** lawful to redistribute the source,
  publish forks of it, or ship modified builds. Local modification for personal use is a different question, but a
  public repository like this one must not carry it.

**Consequence for this project:** engine-level mods for BO1 cannot be delivered *here* as source or binaries. What
this repository can and does provide: a precise assessment, the build/verification steps, and a place to record
results once you have permission from the author (or you are working privately).

## Build requirements, as the tree actually states them

| Evidence | Meaning |
|---|---|
| `cmake_minimum_required(VERSION 3.16)`, `set(CMAKE_CXX_STANDARD 20)` | CMake + a C++20 compiler |
| `set(CMAKE_GENERATOR_PLATFORM "WIN32")` | the project is generated for **Windows** |
| `COMPILE_OPTIONS "/arch:IA32"` on `physics/phys_gjk.cpp` | an **MSVC-only** flag |
| `if (MSVC AND WIN32 AND NOT MSVC_VERSION VERSION_LESS 142)` | MSVC 2019+ is the supported compiler |
| defines `WIN32`, `_CONSOLE`, `BO1_MP`, `_WINSOCK_…` | Win32 + Winsock APIs |
| 17 files include `windows.h`; `src/gfx_d3d`, `src/binklib/dx9rad3d.cpp` | **Direct3D 9** rendering and Bink video |
| `src/DW`, `src/live` | DemonWare and Xbox LIVE/Steam platform code |
| `setup.ps1` | copies ~11 GB from *your* Black Ops install next to the build; states that `BlackOps.exe` is not copied |

So the development environment is: **Windows, Visual Studio 2022 (MSVC), CMake, your own legally installed
Call of Duty: Black Ops**, and about 11 GB of free space for the asset copy. Not Linux, not this container (which has
no MSVC, no DirectX headers and no C++20 toolchain set up for Win32 targets).

### Baseline test on Windows

```powershell
git clone https://github.com/MisaDev4/bo1-zombies-decompiled
cd bo1-zombies-decompiled
cmake -S . -B build -G "Visual Studio 17 2022" -A Win32 -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release
powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1 -GameDir "D:\Games\Call of Duty Black Ops"
# run from build\Release, load a Zombies map, record a baseline (rounds, spawn counts, timings)
```

Preserve that baseline before changing anything: it is the only way to tell a mod from a regression.

## WebAssembly port: the blockers, ranked

1. **Renderer.** `gfx_d3d` emits Direct3D 9 state and shaders. A browser build needs either a D3D9→WebGL2/WebGPU
   translation layer or a new renderer backend against the engine's own draw-list abstraction. This is the single
   largest piece of work; it is not a build-flag change.
2. **Platform layer.** Win32 threads, Winsock, file APIs, windowing and the Steam/LIVE presence code all need a
   POSIX/Emscripten or SDL backend.
3. **SEH and MSVC intrinsics.** The engine uses structured exception handling and MSVC-specific intrinsics in places;
   Emscripten has no SEH, and those sites need rewriting.
4. **Proprietary middleware.** Bink video and DemonWare are licensed binaries — they cannot be redistributed or
   recompiled for the browser.
5. **Assets.** The engine reads the game's own `.zone`/`.iwd` fastfiles; a browser build without a lawful, local
   asset pipeline would have nothing to load, and shipping those assets is not permitted.
6. **Licence.** With no licence file, even a hypothetical working port could not be published.

None of that is a statement that it is impossible — it is a statement about the size of the job and about what may
lawfully be distributed. This project does not claim a BO1 WebAssembly build, and no such build was attempted here.

## What would actually move this forward

1. Ask the repository author for an explicit licence (or work privately under their terms).
2. Get the engine building and playing on Windows first, with a recorded baseline.
3. Extract the rendering interface behind a backend-neutral header; that is the prerequisite for *any* alternative
   renderer, browser or otherwise.
4. Only then evaluate an Emscripten/SDL target with a WebGL2 backend for that interface.

Steps 1–3 can be done with the author's permission and a local checkout. Step 4 is a research project, not a switch.
