# Changelog

All notable changes to **seek** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.6] - 2026-09-06

### Fixed

- **TUI crash on launch**: the terminal client nested a second `asyncio.run()` inside the one `curses.wrapper` already started, raising `RuntimeError: asyncio.run() cannot be called from a running event loop` and aborting `seek` on startup. The TUI now uses a single event loop for connecting to the daemon and rendering.
- **GUI showed as a shortcut, not an app**: the installer's real-copy step could `ditto` onto a symlink left by an older version in `~/Applications/seek.app`, leaving an inconsistent bundle. It now removes any prior `~/Applications/seek.app` before copying a clean, independent app so Launchpad reliably indexes the GUI.

## [0.1.5] - 2026-09-06

### Changed

- The installer now **copies** `seek.app` into `~/Applications` (real copy via `ditto`, not a symlink) so the GUI reliably appears in Launchpad and Finder — macOS does not index a symlinked `.app` there. The redundant `seek-gui` app copy that used to ship inside `~/.seek/install` is removed after the copy, leaving the runtime lean.
- The copied `~/Applications/seek.app` finds the runtime via the absolute `~/.seek/install/bin/seekd` and `~/.seek/install/webui` paths, so it keeps working without extra setup.

## [0.1.4] - 2026-09-06

### Added

- `seek` is now a smart launcher (not the daemon): it makes sure a `seekd` daemon is running (spawns one in the background on first use), waits for the embedded WEBUI server to be reachable, then opens the TUI (default) or the GUI (`seek --gui`).
- Dedicated ports that never collide with EMRG: daemon (WebSocket) **37291**, WEBUI (HTTP) **37292**. All clients (TUI / GUI / webui) now use these.
- Opening the GUI from Launchpad / Finder (`seek-gui/seek.app`) also auto-starts the daemon and serves the WEBUI.

### Changed

- `seek` no longer runs the daemon in the foreground. `seekd` is the daemon; `seek` launches the client.
- The `seek-tui` command is folded into `seek` (run `seek` for the TUI).
- `seekd` accepts `--webui-port` to expose the WEBUI on a separate configurable port.

## [0.1.3] - 2026-09-06

### Added

- Installer now adds `~/.seek/install/bin` to the user's `PATH` on install (so `seek` / `seek-tui` / `seekd` are on the command line with no manual setup).
- Installer now links `seek.app` into `~/Applications`, so the GUI shows up in Launchpad / Finder without root.

## [Unreleased]

### Added

- Initial public release scaffold.
