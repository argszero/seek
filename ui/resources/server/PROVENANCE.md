# The model server this app carries

`llama-server` is built from [llama.cpp](https://github.com/ggml-org/llama.cpp) and shipped in
the app's `Resources/server/`, so a downloaded app can answer on its own instead of asking a
person to start a server from a terminal first (issue #89; `docs/decisions.md` row 20 — nothing
*in the kernel* starts or supervises it, the app does).

## What it is

| | |
|---|---|
| upstream | `ggml-org/llama.cpp`, tag **`v0.7.0`** |
| commit | `620d222` (`llama.cpp : bump version to 0.7.0`) |
| binary | `llama-server`, Mach-O 64-bit executable **arm64** |
| bytes | 18,692,864 |
| sha256 | `2967d3b9e80470a53c66a4b56b207afe73fda66c629f5f9fc86a72c6c6938baf` |
| licence | MIT — `LICENSE-llama.cpp` sits beside the binary and ships with it |
| self-report | `version: 0.7.0-dev (build 1, commit 620d222)` |

## How it was built

```sh
git clone --depth 1 ssh://git@ssh.github.com:443/ggml-org/llama.cpp
git fetch --depth 1 origin tag v0.7.0 && git checkout 620d222
cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
  -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_TOOLS=ON \
  -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON \
  -DLLAMA_OPENSSL=OFF -DCMAKE_OSX_DEPLOYMENT_TARGET=12.0
cmake --build build --target llama-server -j12
```

Four of those flags are load-bearing rather than taste, and each was measured on the produced
file rather than assumed:

- **`BUILD_SHARED_LIBS=OFF`** — one file, so there is no `@rpath` to rewrite and no dylib to
  keep beside it. `otool -L` then reports only `/System` and `/usr/lib` entries.
- **`LLAMA_OPENSSL=OFF`** — with it on (the default), the first build linked
  `/opt/homebrew/opt/openssl@4/lib/libssl.4.dylib`. A Homebrew path is not on a person's
  machine, so the app would have failed to launch its own server for everyone but the builder.
- **`CMAKE_OSX_DEPLOYMENT_TARGET=12.0`** — without it the binary carried `minos 26.0`, while
  `ui/package.json` declares `minimumSystemVersion: 12.0`; macOS would have refused to run it
  on anything older than the machine it was built on.
- **`GGML_METAL_EMBED_LIBRARY=ON`** — the Metal shaders are inside the binary, so nothing has
  to be read from a source tree at run time.

Two measurements stand behind the file being usable at all: `otool -L` reports eight
dependencies, all under `/System/Library` or `/usr/lib`, and the binary answers `/props` in
11.5 s on a cold start with `LFM2.5-VL-3B-Q4_0.gguf` loaded.

## Rebuilding it

The recipe above is complete: any machine with Xcode, `cmake` and a tag checkout reproduces
this. If the next llama.cpp release is wanted, the flags stay and only the tag changes — and
the three checks to repeat are `otool -L` (no Homebrew paths), `otool -l` (`minos` no higher
than the app's `minimumSystemVersion`), and a `/props` answer against the weights that ship.

The weights are **not** here: they arrive on a first run (`ui/electron/model-weights.js`) and
live in `~/Library/Application Support/Seek/weights/`.
