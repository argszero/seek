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

    # ── Pre-sign the payload's mach-o binaries (developer-cert requirement) ──
    # Apple notarization requires EVERY mach-o executable/dylib/.so inside the
    # .pkg to carry a valid Developer ID signature. The bundled Python runtime
    # ships unsigned .dylib/.so (from the standalone CPython + pip wheels) that
    # would otherwise fail notarization with "The binary is not signed with a
    # valid Developer ID certificate" (status=Invalid). We sign each unsigned
    # mach-o under $PAYLOAD/python with the Developer ID Application identity,
    # reusing the same identity the .app was signed with. seek-gui/ is EXCLUDED
    # — electron-builder already signed it (helpers/frameworks must keep their
    # original signatures).
    # Only runs when a Developer ID Application identity is available; signature
    # identity is auto-detected from the keychain search list (unix only).
    if [[ "$(uname -s)" != "MINGW"* && "$(uname -s)" != "MSYS"* && "$(uname -s)" != "CYGWIN"* ]]; then
      APP_SHA="$(security find-identity -v -p codesigning 2>/dev/null | grep 'Developer ID Application' | head -1 | sed -E 's/.*\) *([A-F0-9]+) .*/\1/')"
      if [[ -n "$APP_SHA" ]]; then
        echo "==> pre-signing runtime mach-o binaries with $APP_SHA"
        SIGNED=0; SKIPPED=0; FAIL=0
        # Entitlements for hardened-runtime executables: disable library validation
        # so Python can dlopen its own pip wheels/dylibs under hardened runtime
        # (without it, hardened runtime's library validation breaks extension load).
        ENTITLEMENTS="$PKG_ROOT/python.entitlements"
        cat > "$ENTITLEMENTS" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
  <key>com.apple.security.cs.allow-dyld-environment-variables</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
</dict>
</plist>
PLIST
        # Use the default/first keychain in the search list so codesign finds the
        # Developer ID Application. In CI this is /tmp/ci.keychain (set by the
        # import step). If auto-detect yields empty, codesign falls back to its
        # default search list (may still find the identity).
        DEFAULT_KEYCHAIN="$(security default-keychain 2>/dev/null | awk -F'"' '{print $2}' | head -1)"
        KC_ARG=""
        [[ -n "$DEFAULT_KEYCHAIN" ]] && KC_ARG="--keychain $DEFAULT_KEYCHAIN"
        # Collect file list into a temp file (portable; avoids process substitution
        # which is bash-only and broken under `sh`). Paths with newlines are rare in
        # a package payload; NUL-delimited list preserved via tr for safety.
        FILELIST="$(mktemp)"
        find "$PAYLOAD/python" -type f -print0 2>/dev/null | tr '\0' '\n' > "$FILELIST"
        while IFS= read -r F; do
          [[ -n "$F" ]] || continue
          # Only Mach-O files need signing; plain text/scripts are untouched.
          FT="$(file "$F" 2>/dev/null)"
          if ! echo "$FT" | grep -q 'Mach-O'; then continue; fi
          # Already Developer-ID-signed (e.g. a vendored binary) → leave untouched.
          if codesign -dv "$F" 2>/dev/null | grep -q 'Authority=Developer ID Application'; then
            SKIPPED=$((SKIPPED+1)); continue
          fi
          # Executables MUST have hardened runtime for Apple notarization
          # ("The executable does not have the hardened runtime enabled.").
          # Runtime dylib/.so (bundle/shared lib) must NOT get hardened runtime —
          # it would enable library validation and break Python dlopen of its own
          # unsigned-ish extension reloading. Sign them plainly (Developer ID only).
          RUNTIME_OPT=""
          if echo "$FT" | grep -qiE 'executable'; then
            RUNTIME_OPT="--options runtime --entitlements $ENTITLEMENTS"
          fi
          if codesign --force $RUNTIME_OPT --sign "$APP_SHA" $KC_ARG "$F" >/dev/null 2>&1; then
            SIGNED=$((SIGNED+1))
          else
            echo "  (warn) failed to sign: $F" >&2
            FAIL=$((FAIL+1))
          fi
        done < "$FILELIST"
        rm -f "$FILELIST"
        echo "   signed=$SIGNED skipped=$SKIPPED failed=$FAIL"
      else
        echo "  (skip pre-sign: no Developer ID Application identity found)"
      fi
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

    # Build a user-level .pkg that installs to ~/.seek/install/.
    #
    # Correct user-level install requires a DISTRIBUTION with <domains
    # enable_currentUserHome="true"> so the payload is relocated to the installing
    # user's HOME. A bare pkgbuild component would install to the literal (absolute)
    # install-location instead. Two-stage build:
    #   1) pkgbuild  → component.pkg with a ROOT-RELATIVE install-location
    #      (/.seek/install). currentUserHome relocation turns that into
    #      $HOME/.seek/install at install time.
    #   2) productbuild → wraps the component into a distribution that declares
    #      enable_currentUserHome="true" (and localSystem as a fallback).
    # We sign the PRODUCT (final.pkg), not the component.
    # ⚠️ Do NOT use `echo "$HOME" | sed -E 's#^/([^/]+).*#/\1#'` — that strips the
    # username (turns /Users/argszero → /Users, yielding the bogus path
    # /Users/.seek/install). Use the root-relative /.seek/install.
    WORK="/tmp/seek-installer-$$"
    mkdir -p "$WORK"
    cp "$SCRIPT_DIR/postinstall" "$WORK/postinstall"
    COMPONENT="$WORK/component.pkg"
    pkgbuild --root "$PAYLOAD" \
      --install-location "/.seek/install" \
      --scripts "$WORK" \
      --identifier "com.argszero.seek" \
      --version "$VERSION" \
      "$COMPONENT" || {
        # Fallback: install to /Applications if something is wrong.
        pkgbuild --root "$PAYLOAD" \
          --install-location "/Applications/seek" \
          --scripts "$WORK" \
          --identifier "com.argszero.seek" \
          --version "$VERSION" \
          "$COMPONENT"
      }

    # Wrap into a user-level distribution (currentUserHome) so it installs into
    # the current user's ~/.seek/install/.
    # ⚠️ Must SYNTHESIZE the distribution from the component (productbuild
    # --synthesize) so the <pkg-ref> matches the component's real id; a hand-
    # written distribution silently produces an EMPTY product (13K, no payload).
    # Then inject <domains enable_currentUserHome="true"> so the payload is
    # relocated to the installing user's $HOME at install time.
    productbuild --synthesize --package "$COMPONENT" "$WORK/distribution.xml" >/dev/null 2>&1
    sed -i '' 's#<installer-gui-script\([^>]*\)>#<installer-gui-script\1>\
    <domains enable_anywhere="false" enable_currentUserHome="true" enable_localSystem="true"/>#' \
      "$WORK/distribution.xml"
    PKG="$DIST/artifacts/seek-$VERSION-macos-$(uname -m).pkg"
    productbuild --distribution "$WORK/distribution.xml" \
      --package-path "$WORK" \
      "$PKG"
    rm -rf "$PKG_ROOT" "$WORK"

    # ── Sign the .pkg (Developer ID Installer) + notarize + staple ──
    # Only when a signing identity is available on this runner (CI injects it via
    # MACOS_SIGNING_P12_BASE64 / PASSWORD + the App ID / notary secrets). Local
    # builds without certs skip everything defensively so dev flow is unchanged.
    # The p12 we feed in (signing-installer.p12, sha256:AB9EDC..) carries BOTH the
    # Developer ID Application and Developer ID Installer identities, so productsign
    # picks the Installer up automatically from the same keychain.
    SIGNING_ID="${MACOS_SIGNING_IDENTITY:-}"
    if [[ -z "$SIGNING_ID" ]]; then
      SIGNING_ID="$(security find-identity -v -p codesigning 2>/dev/null | grep 'Developer ID Application' | head -1 | sed -E 's/.*"([^"]+)".*/\1/')"
    fi
    if [[ -n "$SIGNING_ID" ]]; then
      echo "==> signing pkg with: $SIGNING_ID"
      # productsign 需要 Developer ID Installer 身份（不是 Application 身份）——
      # ⚠️ 必须用无 policy 的 `find-identity -v`（不能用 -p codesigning）：codesigning
      # policy 只把 Application 标记 valid、会过滤掉 Installer，导致 "Could not find
      # appropriate signing identity" (EMRG 实测 + 本地复现确认)。Installer 身份只在
      # 无 policy 下可见、且需 keychain 在用户搜索列表（list-keychains -d user -s）。
      # 单 p12 方案下 sign pkg 用的 Installer 身份已在同一 keychain，自动检测即可命中；
      # 优先用 CI 注入的 MACOS_INSTALLER_IDENTITY 以备将来显式指定（当前未设置）。
      INSTALLER_ID="${MACOS_INSTALLER_IDENTITY:-}"
      if [[ -z "$INSTALLER_ID" ]]; then
        INSTALLER_ID="$(security find-identity -v 2>/dev/null | grep 'Developer ID Installer' | head -1 | sed -E 's/.*"([^"]+)".*/\1/')"
      fi
      if [[ -n "$INSTALLER_ID" ]]; then
        productsign --sign "$INSTALLER_ID" "$PKG" "$PKG.signed"
        mv "$PKG.signed" "$PKG"
        pkgutil --check-signature "$PKG"
      else
        echo "  (skip pkg signing: no Developer ID Installer identity found)"
      fi

      # Notarize + staple (needs the App ID / notary secrets).
      if [[ -n "${APPLE_ID:-}" && -n "${MACOS_NOTARY_APP_PASSWORD:-}" && -n "${MACOS_NOTARY_TEAM_ID:-}" ]]; then
        echo "==> notarizing pkg"
        NOTARY_OUT="$(xcrun notarytool submit "$PKG" \
          --apple-id "$APPLE_ID" \
          --password "$MACOS_NOTARY_APP_PASSWORD" \
          --team-id "$MACOS_NOTARY_TEAM_ID" \
          --wait --timeout 20m --output-format json 2>&1)"
        echo "$NOTARY_OUT"
        STATUS="$(printf '%s' "$NOTARY_OUT" \
          | python3 -c "import sys,json;print(json.load(sys.stdin).get('status',''))" 2>/dev/null || true)"
        if [[ "$STATUS" != "Accepted" ]]; then
          echo "!! notarization did not pass (status=$STATUS)" >&2
          echo "$NOTARY_OUT" >&2
          # 导出 Apple 公证的详细失败原因（Invalid 通常指包内某组件签名/hardened runtime 问题）。
          # notarytool log 需要同套 notary 凭据；失败时打印明文日志便于 CI 内定位,不阻断后续重跑。
          LOG_ID="$(printf '%s' "$NOTARY_OUT" \
            | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))" 2>/dev/null || true)"
          if [[ -n "$LOG_ID" ]]; then
            echo "==> notarytool log for submission $LOG_ID" >&2
            xcrun notarytool log "$LOG_ID" \
              --apple-id "$APPLE_ID" \
              --password "$MACOS_NOTARY_APP_PASSWORD" \
              --team-id "$MACOS_NOTARY_TEAM_ID" 2>&1 >&2 || echo "(log fetch failed)" >&2
          fi
          exit 1
        fi
        echo "==> stapling ticket"
        xcrun stapler staple "$PKG"
        xcrun stapler validate "$PKG"
        spctl -a -vv --type install "$PKG"
      fi
    else
      echo "  (skip pkg signing: no Developer ID Application identity found)"
    fi
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
    # Use forward-slash (mixed) paths via cygpath -m — Inno Setup accepts them,
    # and forward slashes aren't mangled by sed backslash escapes below.
    mkdir -p "$DIST/artifacts"
    STAGE_W="$(cygpath -m "$STAGE" 2>/dev/null || echo "$STAGE")"
    ART_W="$(cygpath -m "$DIST/artifacts" 2>/dev/null || echo "$DIST/artifacts")"
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
    "$ISCC" "$STAGE_W/seek.iss" || echo "!! iscc build failed (see output)" >&2
    rm -rf "$STAGE"
    ;;

  *)
    echo "!! unknown platform $PLATFORM" >&2; exit 1 ;;
esac

echo "==> artifacts:"
ls -lh "$DIST/artifacts/" 2>/dev/null || true
