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

# Platform switch: uv venvs put the interpreter in bin/ (unix) or Scripts/ (win).
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*|WINNT*)
    PLAT=win
    SPLIB="Lib"            # Windows stdlib/site-packages live under Lib/ (capital L)
    VENV_PY_REL="Scripts/python.exe"
    RV_PY="python/Scripts/python.exe"   # python exec path inside the runtime
    ;;
  *)
    PLAT=unix
    SPLIB="lib"
    VENV_PY_REL="bin/python"
    RV_PY="python/bin/python3"
    ;;
esac

# A self-contained CPython base that already includes libpython dylib + stdlib.
# We treat the backend venv's interpreter as the source of truth; on this machine
# uv resolves it to a standalone distribution. We detach it from the venv by
# copying the WHOLE base (bin+lib+include+share) so the produced runtime owns its
# interpreter and never references a uv cache path.
# Find the venv's python: unix venvs use bin/python, Windows venvs use Scripts\python.exe.
PYTHON_BIN="$ROOT/backend/.venv/$VENV_PY_REL"
if [[ ! -x "$PYTHON_BIN" ]]; then
  echo "!! backend/.venv not found — run: cd backend && uv sync" >&2
  exit 1
fi

# Resolve the interpreter's real prefix (where bin/python lives + lib/python3.x).
# For a venv, sys.prefix points at the venv; the *base* interpreter lives under
# sys._base_executable. We use the base executable path to find a standalone base.
# On Windows uv sometimes reports a managed dir rather than a version dir; fall
# back to the venv's own prefix for a self-contained copy.
WIN_BASE="$("$PYTHON_BIN" -c "import sys; print(getattr(sys, '_base_executable', sys.executable))" 2>/dev/null || echo "$PYTHON_BIN")"
if [[ "$PLAT" == "win" ]]; then
  # Windows: copy the venv itself (Scripts + Lib + pyvenv.cfg) so the runtime is
  # self-contained without relying on uv's managed base layout.
  BASE_PREFIX="$ROOT/backend/.venv"
else
  BASE_PREFIX="$(cd "$(dirname "$WIN_BASE")/.." && pwd)"
fi
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
# Locate a venv's real site-packages. Layout varies: uv unix venvs use
# lib/python3.x/site-packages; uv/CPython Windows venvs may use
# Lib/python3.x/site-packages or a bare Lib/site-packages — probe all.
find_venv_sp() {
  local vroot="$1"
  local cand
  for cand in \
      "$vroot/lib/python$PYVER/site-packages" \
      "$vroot/Lib/python$PYVER/site-packages" \
      "$vroot/lib/site-packages" \
      "$vroot/Lib/site-packages"; do
    if [[ -d "$cand" ]]; then echo "$cand"; return 0; fi
  done
  return 1
}

SP="$RUNTIME/python/$SPLIB/python$PYVER/site-packages"
VENV_SP="$(find_venv_sp "$ROOT/backend/.venv" || echo "")"
if [[ -z "$VENV_SP" ]]; then
  echo "!! backend venv site-packages not found under $ROOT/backend/.venv" >&2
  exit 1
fi
# The runtime target dir must mirror the venv's OWN site-packages location:
# Windows (uv) venvs keep site-packages directly under Lib/, unix under
# lib/python3.x/ — on Windows the whole venv is copied as the interpreter base,
# so overlaying into a guessed python3.x/ subdir would land OUTSIDE sys.path.
SP_REL="${VENV_SP#"$ROOT/backend/.venv/"}"
SP="$RUNTIME/python/$SP_REL"
mkdir -p "$SP"
echo "==> overlaying backend venv site-packages (from $VENV_SP)"
cp -RL "$VENV_SP"/. "$SP/" 2>/dev/null || true

# The TUI (seek_tui) lives in its own venv (tui/.venv) with its own deps
# (rich etc.) that the daemon itself does not need. Overlay that venv's
# site-packages too, otherwise the shipped TUI crashes on `import rich`.
# Both venvs resolve the same managed CPython (3.13), so a flat merge into one
# site-packages is safe; shared pins (websockets) resolve to the same version.
TUI_VENV_SP="$(find_venv_sp "$ROOT/tui/.venv" || echo "")"
if [[ -n "$TUI_VENV_SP" ]]; then
  echo "==> overlaying tui venv site-packages (rich + seek_tui deps) (from $TUI_VENV_SP)"
  cp -RL "$TUI_VENV_SP"/. "$SP/" 2>/dev/null || true
else
  echo "!! tui venv site-packages not found under $ROOT/tui/.venv — shipped TUI will lack rich (sanity check will catch it)" >&2
fi

# Drop EVERY editable-install .pth in the copied tree: seekd and seek_tui are
# installed editable in the dev venvs, so their .pth files point back to this
# machine (e.g. D:\a\seek\seek\backend on a Windows runner) and must never ship.
# The real packages are vendored below as plain directories.
find "$RUNTIME/python" -name '_editable_impl_*.pth' -delete 2>/dev/null || true
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
    cat > "$RUNTIME/bin/seekd.cmd" <<'EOF'
@echo off
rem seekd — start the seek daemon (self-contained runtime)
"%~dp0..\python\Scripts\python.exe" -m seekd.__main__ %*
EOF
    cat > "$RUNTIME/bin/seek.cmd" <<'EOF'
@echo off
rem seek — seek launcher. Starts the daemon in background if not running, waits
rem for WEBUI, then launches the TUI (or GUI with `seek --gui`).
"%~dp0..\python\Scripts\python.exe" -m seekd.launcher %*
EOF
    # Also emit sh launchers so Git-Bash / WSL users can run them too.
    cat > "$RUNTIME/bin/seekd" <<'EOF'
#!/usr/bin/env sh
exec "$(dirname "$0")/../python/Scripts/python.exe" -m seekd.__main__ "$@"
EOF
    cat > "$RUNTIME/bin/seek" <<'EOF'
#!/usr/bin/env sh
exec "$(dirname "$0")/../python/Scripts/python.exe" -m seekd.launcher "$@"
EOF
    chmod +x "$RUNTIME/bin/seekd" "$RUNTIME/bin/seek"
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
# seek — seek launcher. Makes sure the daemon is running (spawning it in the
# background on first use), waits for the WEBUI to be reachable, then launches
# the TUI client (or the GUI with `seek --gui`).
exec "$(dirname "$0")/../python/bin/python3" -m seekd.launcher "$@"
EOF
    chmod +x "$RUNTIME/bin/seekd" "$RUNTIME/bin/seek"
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
RUNTIME_OK=1
if ! "$RUNTIME/$RV_PY" -c "import seekd, httpx, yaml, websockets" >/dev/null 2>&1; then
  RUNTIME_OK=0
fi
# The TUI needs its own deps (rich) — smoke-import the app class to catch a
# missing rich / markdown-it-py etc. before this runtime ships in an installer.
if [[ -d "$SP/seek_tui" ]] && ! "$RUNTIME/$RV_PY" -c "from seek_tui.app import SeekApp" >/dev/null 2>&1; then
  RUNTIME_OK=0
fi
if (( RUNTIME_OK )); then
  echo "   runtime imports OK"
else
  echo "!! runtime failed self-check" >&2
  "$RUNTIME/$RV_PY" -c "import seekd, httpx, yaml, websockets" 2>&1 | head -5 || true
  if [[ -d "$SP/seek_tui" ]]; then
    "$RUNTIME/$RV_PY" -c "from seek_tui.app import SeekApp" 2>&1 | head -5 || true
  fi
  exit 1
fi

echo "==> runtime assembled at $RUNTIME"
find "$RUNTIME" -maxdepth 2 -type f | head -20
echo "(done)"
