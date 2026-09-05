#!/usr/bin/env bash
# build-runtime.sh — assemble a self-contained seek runtime for packaging.
#
# Produces $DIST/runtime/ containing:
#   - the seek interpreter (self-contained CPython: bin + lib + libpython dylib)
#   - the seekd / seek / seek-tui entry points
#   - webui/dist (the browser bundle)
# The installer then wraps this into a platform package (macOS .pkg / Windows
# Inno Setup). Run this before make-installer.sh.
#
# The runtime is deliberately SELF-CONTAINED: it must not contain any symlink or
# absolute path pointing back to this dev machine (e.g. an external uv python
# cache). We build it from a standalone CPython base and overlay the venv
# site-packages, so it runs on a clean machine.
#
# Usage: bash packaging/build-runtime.sh
#   Pre-reqs: backend/.venv (uv sync) and webui/dist (npm run build).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist"
RUNTIME="$DIST/runtime"
VERSION="$(grep -m1 '^version' "$ROOT/backend/pyproject.toml" | sed -E 's/.*= *"([^"]+)".*/\1/')"
[[ -n "$VERSION" ]] || VERSION="0.1.0"

# A self-contained CPython base that already includes libpython dylib + stdlib.
# We treat the backend venv's interpreter as the source of truth; on this machine
# uv resolves it to a standalone distribution. We detach it from the venv by
# copying the WHOLE base (bin+lib+include+share) so the produced runtime owns its
# interpreter and never references a uv cache path.
# Find the venv's python: unix venvs use bin/python, Windows venvs use Scripts\python.exe.
PYTHON_BIN=""
for cand in "$ROOT/backend/.venv/bin/python" "$ROOT/backend/.venv/Scripts/python.exe"; do
  if [[ -x "$cand" ]]; then PYTHON_BIN="$cand"; break; fi
done
if [[ -z "$PYTHON_BIN" ]]; then
  echo "!! backend/.venv not found — run: cd backend && uv sync" >&2
  exit 1
fi

# Resolve the interpreter's real prefix (where bin/python lives + lib/python3.x).
# For a venv, sys.prefix points at the venv; the *base* interpreter lives under
# sys._base_executable. We use the base executable path to find a standalone base.
BASE_PY="$("$PYTHON_BIN" -c "import sys; print(getattr(sys, '_base_executable', sys.executable))" 2>/dev/null || echo "$PYTHON_BIN")"
if [[ ! -x "$BASE_PY" ]]; then
  echo "!! could not resolve a base interpreter from backend/.venv" >&2
  exit 1
fi
BASE_PREFIX="$(cd "$(dirname "$BASE_PY")/.." && pwd)"
PYVER="$(cd "$ROOT/backend/.venv" && "$PYTHON_BIN" -c "import sys; print('%d.%d' % (sys.version_info[0], sys.version_info[1]))")"

echo "==> assembling seek runtime v$VERSION (py $PYVER, base $BASE_PREFIX)"
rm -rf "$RUNTIME"
mkdir -p "$RUNTIME"

# ── version marker ─────────────────────────────────────────────
echo "$VERSION" > "$RUNTIME/version.txt"

# ── interpreter (self-contained base) ──────────────────────────
# Copy the base prefix with symlink de-reference (-L) so we never ship a link
# that points off-machine. Site-packages are merged in below.
echo "==> copying base interpreter $BASE_PREFIX"
cp -RL "$BASE_PREFIX" "$RUNTIME/python"

# ── site-packages: overlay the backend venv deps + seekd sources ─
# unix venv/python use lib/<pyver>/site-packages; Windows uses Lib/site-packages.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*|WINNT*) SPLIB="Lib" ;;
  *) SPLIB="lib" ;;
esac
SP="$RUNTIME/python/$SPLIB/python$PYVER/site-packages"
VENV_SP="$ROOT/backend/.venv/$SPLIB/python$PYVER/site-packages"
mkdir -p "$SP"
echo "==> overlaying backend venv site-packages"
cp -RL "$VENV_SP"/. "$SP/" 2>/dev/null || true

# Because seekd is installed editable in the dev venv, its `.pth` points back to
# this machine. Replace that with a real copy of the seekd package so the runtime
# is standalone.
rm -f "$SP"/_editable_impl_seekd.pth
echo "==> vendoring seekd package into runtime site-packages"
cp -R "$ROOT/backend/seekd" "$SP/seekd"
# The TUI is a separate package (seek_tui); vendor it too so the runtime ships a
# working terminal client.
if [[ -d "$ROOT/tui/seek_tui" ]]; then
  echo "   vendoring seek_tui package"
  cp -R "$ROOT/tui/seek_tui" "$SP/seek_tui"
fi

# ── entry points ────────────────────────────────────────────────
# Create runnable wrappers in runtime/bin that call `python -m seekd.__main__`.
# On Windows the standard library interpreter is python.exe (no `python3`), and
# sh shebang launchers are not executable, so we emit .cmd wrappers instead.
mkdir -p "$RUNTIME/bin"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*|WINNT*)
    PY="python.exe"
    mkdir -p "$RUNTIME/bin"
    cat > "$RUNTIME/bin/seekd.cmd" <<'EOF'
@echo off
rem seekd — start the seek daemon (self-contained runtime)
"%~dp0..\python\bin\python.exe" -m seekd.__main__ %*
EOF
    cat > "$RUNTIME/bin/seek.cmd" <<'EOF'
@echo off
rem seek — seek CLI (self-contained runtime)
"%~dp0..\python\bin\python.exe" -m seekd.__main__ %*
EOF
    cat > "$RUNTIME/bin/seek-tui.cmd" <<'EOF'
@echo off
rem seek-tui — terminal client
"%~dp0..\python\bin\python.exe" -m seek_tui.__main__ %*
EOF
    # Also emit sh launchers so Git-Bash / WSL users can run them too.
    cat > "$RUNTIME/bin/seekd" <<'EOF'
#!/usr/bin/env sh
exec "$(dirname "$0")/../python/bin/python3" -m seekd.__main__ "$@"
EOF
    cat > "$RUNTIME/bin/seek" <<'EOF'
#!/usr/bin/env sh
exec "$(dirname "$0")/../python/bin/python3" -m seekd.__main__ "$@"
EOF
    cat > "$RUNTIME/bin/seek-tui" <<'EOF'
#!/usr/bin/env sh
exec "$(dirname "$0")/../python/bin/python3" -m seek_tui.__main__ "$@"
EOF
    chmod +x "$RUNTIME/bin/seekd" "$RUNTIME/bin/seek" "$RUNTIME/bin/seek-tui"
    ;;
  *)
    cat > "$RUNTIME/bin/seekd" <<'EOF'
#!/usr/bin/env sh
# seekd — start the seek daemon (self-contained runtime).
# NOTE: seekd.__main__ is the console entrypoint `main_daemon`; running it via
# `python -m seekd.__main__` (no subcommand) is correct. Passing a subcommand
# would be treated as an unknown argparse arg and the daemon would fail to start.
exec "$(dirname "$0")/../python/bin/python3" -m seekd.__main__ "$@"
EOF
    cat > "$RUNTIME/bin/seek" <<'EOF'
#!/usr/bin/env sh
# seek — seek CLI (self-contained runtime).
# main_cli currently routes to main_daemon; `python -m seekd.__main__` is correct.
exec "$(dirname "$0")/../python/bin/python3" -m seekd.__main__ "$@"
EOF
    cat > "$RUNTIME/bin/seek-tui" <<'EOF'
#!/usr/bin/env sh
# seek-tui — terminal client
exec "$(dirname "$0")/../python/bin/python3" -m seek_tui.__main__ "$@"
EOF
    chmod +x "$RUNTIME/bin/seekd" "$RUNTIME/bin/seek" "$RUNTIME/bin/seek-tui"
    ;;
esac

# ── webui/dist (browser bundle) ─────────────────────────────────
if [[ -d "$ROOT/webui/dist" ]]; then
  echo "==> copying webui/dist"
  cp -R "$ROOT/webui/dist" "$RUNTIME/webui"
else
  echo "!! webui/dist not found — build first (cd webui && npm run build)" >&2
  exit 1
fi

# ── sanity: the runtime interpreter must run standalone ─────────
echo "==> smoking runtime interpreter (must run without dev machine)"
if "$RUNTIME/python/bin/python3" -c "import seekd, httpx, yaml, websockets; print('runtime OK')" >/dev/null 2>&1; then
  echo "   runtime imports OK"
else
  echo "!! runtime failed self-check" >&2
  "$RUNTIME/python/bin/python3" -c "import seekd, httpx, yaml, websockets" 2>&1 | head -5 || true
  exit 1
fi

echo "==> runtime assembled at $RUNTIME"
find "$RUNTIME" -maxdepth 2 -type f | head -20
echo "(done)"
