# Changelog

All notable changes to **seek** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.8] - 2026-09-06

### Fixed

- **Virtual members never replied to messages** (regression present since the
  first public release): the daemon's `_run_turn` guard read
  `if self._turn_cancel: return` — `_turn_cancel` is an `asyncio.Event`
  instance, and an event object is always truthy, so every group-chat turn
  returned at the very first line without ever invoking the session runner.
  A `sendMessage` therefore showed `turn:start` followed instantly by
  `turn:idle` and no virtual character ever spoke, with no error surfaced.
  The guard now tests `.is_set()` (skip only when a cancel signal was raised
  before the task ran). A regression test wires a fake session runner and
  asserts `handle_user_message` is invoked and the reply is broadcast
  (`tests/test_daemon.py::test_send_message_with_runner_runs_turn`).

## [0.1.7] - 2026-09-06

### Added

- **File logging for every component** — no more silent failures:
  - daemon (WebSocket) + embedded WEBUI → `~/.seek/logs/seekd.log` (HTTP request lines under the `seekd.webui` logger), created even when the daemon is spawned detached with stdio discarded
  - launcher (`seek`) → `~/.seek/logs/launcher.log` (daemon probe/spawn/readiness)
  - GUI (Electron main process) → `~/.seek/logs/gui.log` — every `console.*` output, lifecycle event, render-process crash and uncaught exception lands here even when launched from Finder/Launchpad with no terminal
  - TUI → `<launching-directory>/.seek/logs/tui.log` — the directory the user ran `seek` from is the session's working directory, so the log travels with the project
  - All files rotate at 1 MB × 3 backups.

### Fixed

- **TUI still crashed on launch** (regression in 0.1.6): `curses.wrapper` always calls its callback as `func(stdscr, …)`, but the 0.1.6 fix declared the callback as `func(client, scr)` — so the curses window object was passed where the client was expected, failing with `'_curses.window' object has no attribute 'connect'`. The callback now captures the client by closure and receives only `stdscr`, eliminating the argument-order coupling. Regression tests (`tui/tests/test_main.py`) pin the wiring.

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
