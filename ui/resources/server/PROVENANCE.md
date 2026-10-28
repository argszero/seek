# The model server this app carries

`llama-server` is built from [llama.cpp](https://github.com/ggml-org/llama.cpp) and shipped in
the app's `Resources/server/`, so a downloaded app can answer on its own instead of asking a
person to start a server from a terminal first (issue #89 — nothing *in the kernel* starts or
supervises it, the app does).

## What it is

| | |
|---|---|
| upstream | `ggml-org/llama.cpp`, release **`b11946`** |
| commit | `8ca4060b7` |
| archive | `llama-b11946-macos-arm64.tar.gz`, 16,438,371 bytes, sha256 `d618da5e7bbb19077f086e6a7e1d77eab55b9bfd481f7531aadada86d13db9ed` |
| binary | `llama-server`, Mach-O 64-bit executable **arm64**, 49,984 bytes |
| libraries | ten `.dylib` files beside it, 26.2 MB together (see below) |
| licence | MIT — `LICENSE-llama.cpp` sits beside the binary and ships with it |
| self-report | `version: 0.7.0-dev (build 11946, commit 8ca4060b7)` |

## Why it is not one file any more

The previous binary in this directory was a single self-contained file (18,692,864 bytes,
`BUILD_SHARED_LIBS=OFF`). This one is upstream's own macOS release, and upstream builds with
shared libraries: `otool -L llama-server` reports `@rpath/libllama-server-impl.dylib`,
`@rpath/libllama-common.0.dylib`, `@rpath/libllama.0.dylib`, `@rpath/libmtmd.0.dylib` and the
six `libggml*` libraries, and the binary's only `LC_RPATH` entry is **`@loader_path`** — so the
libraries have to sit in the same directory as the executable, which is where they are.

**Ten files, and the list is measured rather than copied.** The archive carries twenty-odd
libraries, because it also carries every other tool upstream builds (`llama-cli`,
`llama-quantize`, `llama-bench`, …) and one `*-impl` library per tool. What is here is the
closure `otool -L` actually reaches from `llama-server` and the libraries it names:

| file | bytes |
|---|---|
| `libllama-server-impl.dylib` | 9,719,384 |
| `libllama-common.0.dylib` | 8,025,192 |
| `libggml-metal.0.dylib` | 5,620,936 |
| `libllama.0.dylib` | 3,654,016 |
| `libmtmd.0.dylib` | 1,600,096 |
| `libggml-cpu.0.dylib` | 941,200 |
| `libggml-base.0.dylib` | 751,896 |
| `libggml-rpc.0.dylib` | 242,800 |
| `libggml.0.dylib` | 60,016 |
| `libggml-blas.0.dylib` | 58,776 |

Every reference in that closure is a versioned name (`libggml.0.dylib`, not `libggml.dylib`),
so the unversioned spellings the archive also ships as copies were left out; the binary was run
from this directory after pruning, and it answers its version, which is the check that the
closure is complete rather than merely plausible.

**Two consequences, both of them the packager's rather than the kernel's.** A `.pkg` now has to
carry the directory and not one file, and **each library has to be signed** before a build can be
notarized — a signed executable that loads an unsigned dylib is refused on launch, which is what
`v0.1.8` and later must do and no released build has had to do yet.

## Why this build and not the last one

The judgement is one call to `/v1/systemone`, llama.cpp's endpoint for a **decision model**
(`src/llama.ts`). That endpoint does not exist in the `v0.7.0` tag this directory used to carry:
a server built from it answers `404 no such route`, which is what the shipped app did before
this swap. `b11946` is the first build used here that offers it, and it is what
`calibration/set4-d1.json` and `calibration/work/gate-d1.json` were measured against — so the
numbers those records state belong to this binary and to no other.

## The weights are not here

They arrive on a first run (`ui/electron/model-weights.js`) and live in
`~/Library/Application Support/Seek/weights/`:

| | |
|---|---|
| repository | `LiquidAI/d1-2B-GGUF` |
| file | `d1-2B-Q8_0.gguf` |
| bytes | 1,846,240,576 |
| sha256 | `073313d92b53b0ac8193db6e906cb3c78a98183d244b15b7b8f5426115c6738c` |

One file and no projector: this is a text decision model, and the real binary reports
`modalities.vision: false` on `/props`. A message carrying a picture is therefore refused by the
judgement rather than guessed at from its caption (`src/watch.ts`).
