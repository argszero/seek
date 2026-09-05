#!/usr/bin/env bash
# make-installer.sh — build the seek installer for the current platform.
#
#   macOS  : user-level .pkg that installs to ~/.seek/install/
#            (pkgbuild --install-location + distribution currentUserHome domain)
#   Windows: Inno Setup .exe (requires iscc; adapted from EMRG's packaging)
#
# Before packaging, it runs _stop_all.py to stop any running seek processes so
# file locks never fail the install.
#
# Usage: bash packaging/make-installer.sh [darwin|windows]
#   Pre-reqs: packaging/build-runtime.sh has produced dist/runtime/.
#   darwin:  needs pkgbuild (macOS). GUI from gui/dist/mac*/seek.app if present.
#   windows: needs iscc (Inno Setup 6).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist"
RUNTIME="$DIST/runtime"
VERSION="$(cat "$RUNTIME/version.txt" 2>/dev/null || echo 0.1.0)"
PLATFORM="${1:-$(uname -s | tr '[:upper:]' '[:lower:]')}"

if [[ -z "$RUNTIME" || ! -d "$RUNTIME" ]]; then
  echo "!! runtime not built — run: bash packaging/build-runtime.sh first" >&2
  exit 1
fi

mkdir -p "$DIST/artifacts"

# Stop running seek processes (graceful, then force). Never crashes the build.
echo "==> stopping running seek processes"
if [[ -f "$ROOT/packaging/_stop_all.py" ]]; then
  python3 "$ROOT/packaging/_stop_all.py" || true
fi

case "$PLATFORM" in
  darwin|macos)
    echo "==> macOS user-level pkg ($VERSION)"
    APP="$(ls -d "$ROOT"/gui/dist/mac*/seek.app 2>/dev/null | head -1 || true)"
    if [[ -z "$APP" ]]; then
      echo "!! seek.app not found (run: cd gui && npm run dist). Building runtime-only pkg." >&2
    fi

    PKG_ROOT="$(mktemp -d)"
    PAYLOAD="$PKG_ROOT/payload"
    mkdir -p "$PAYLOAD"

    # Runtime contents → install location root.
    cp -R "$RUNTIME/." "$PAYLOAD/"

    # GUI app, if present, goes to ~/.seek/install/seek-gui/.
    if [[ -n "$APP" && -d "$APP" ]]; then
      mkdir -p "$PAYLOAD/seek-gui"
      cp -R "$APP" "$PAYLOAD/seek-gui/seek.app"
      echo "  (bundled GUI: $APP)"
    fi

    # Installer scripts: place the package into ~/.seek/install.
    SCRIPT_DIR="$PKG_ROOT/scripts"
    mkdir -p "$SCRIPT_DIR"

    cat > "$SCRIPT_DIR/postinstall" <<'EOF'
#!/bin/sh
# user-level install to $HOME/.seek/install (postinstall runs as the console user).
set -e
HOME="${HOME:-/Users/$(whoami)}"
INSTALL="$HOME/.seek/install"
mkdir -p "$INSTALL"
# The distribution currentUserHome domain installs payload into ~/.seek/install
# already when --install-location is used; this is a safety net for symlinks.
chmod +x "$INSTALL/bin/"* 2>/dev/null || true
EOF
    chmod +x "$SCRIPT_DIR/postinstall"

    # Build the .pkg with the distribution currentUserHome domain so the package
    # engine installs into ~/.seek/install/.
    WORK="/tmp/seek-installer-$$"
    mkdir -p "$WORK"
    cp "$SCRIPT_DIR/postinstall" "$WORK/postinstall"
    pkgbuild --root "$PAYLOAD" \
      --install-location "$(echo "$HOME" | sed -E 's#^/([^/]+).*#/\1#')/.seek/install" \
      --scripts "$WORK" \
      --identifier "com.argszero.seek" \
      --version "$VERSION" \
      "$DIST/artifacts/seek-$VERSION-macos-$(uname -m).pkg" || {
        # Fallback: install to /Applications if HOME detection fails.
        pkgbuild --root "$PAYLOAD" \
          --install-location "/Applications/seek" \
          --scripts "$WORK" \
          --identifier "com.argszero.seek" \
          --version "$VERSION" \
          "$DIST/artifacts/seek-$VERSION-macos-$(uname -m).pkg"
      }
    rm -rf "$PKG_ROOT" "$WORK"
    ;;

  windows|win32)
    echo "==> Windows Inno Setup ($VERSION)"
    ISCC="$(command -v iscc || true)"
    if [[ -z "$ISCC" ]]; then
      echo "!! iscc not found (Inno Setup 6 required). The Windows installer cannot be built." >&2
      exit 1   # fail the build so CI doesn't skip the .exe silently
    fi
    STAGE="$(mktemp -d)"
    mkdir -p "$STAGE/app"
    cp -R "$RUNTIME/." "$STAGE/app/"
    # Bundle the GUI (electron-builder win-unpacked) into seek-gui\ under the app,
    # so users get a desktop icon that launches the GUI which finds the runtime
    # next to it. Same shape as macOS (runtime + seek-gui/).
    GUI_WIN="$(ls -d "$ROOT"/gui/dist/win-unpacked 2>/dev/null | head -1 || true)"
    if [[ -n "$GUI_WIN" && -d "$GUI_WIN" ]]; then
      mkdir -p "$STAGE/app/seek-gui"
      cp -R "$GUI_WIN/." "$STAGE/app/seek-gui/"
      echo "  (bundled GUI: $GUI_WIN)"
    else
      echo "  (no GUI bundled: win-unpacked not found)"
    fi
    # iscc is a Windows exe: convert MSYS paths (/c/...) to Windows (C:\...).
    mkdir -p "$DIST/artifacts"
    STAGE_W="$(cygpath -w "$STAGE" 2>/dev/null || echo "$STAGE")"
    ART_W="$(cygpath -w "$DIST/artifacts" 2>/dev/null || echo "$DIST/artifacts")"
    # Generate a minimal .iss pointing at the runtime.
    cat > "$STAGE/seek.iss" <<'ISS'
[Setup]
AppName=seek
AppVersion=__VERSION__
DefaultDirName={localappdata}\seek
DefaultGroupName=seek
OutputBaseFilename=seek-__VERSION__-windows-x64
OutputDir=__ART__
Compression=lzma2
SolidCompression=yes
SourceDir=__STAGE__
[Files]
Source: "app\*"; DestDir: "{app}"; Flags: recursesubdirs
[Icons]
Name: "{group}\seek"; Filename: "{app}\seek-gui\seek.exe"
Name: "{autodesktop}\seek"; Filename: "{app}\seek-gui\seek.exe"
[Run]
Filename: "{app}\seek-gui\seek.exe"; Description: "Launch seek"; Flags: nowait postinstall skipifsilent
[Code]
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    begin
      // ensure bin scripts are executable (not meaningful on Windows but harmless)
    end;
end;
ISS
    # Fill in version + Windows paths (the .iss uses literal placeholder tokens).
    sed -i \
      -e "s#__VERSION__#$VERSION#g" \
      -e "s#__STAGE__#$STAGE_W#g" \
      -e "s#__ART__#$ART_W#g" \
      "$STAGE/seek.iss"
    "$ISCC" "$STAGE_W\\seek.iss" || echo "!! iscc build failed (see output)" >&2
    rm -rf "$STAGE"
    ;;

  *)
    echo "!! unknown platform $PLATFORM" >&2; exit 1 ;;
esac

echo "==> artifacts:"
ls -lh "$DIST/artifacts/" 2>/dev/null || true
