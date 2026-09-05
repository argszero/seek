# Contributing to seek

Thank you for your interest in contributing to **seek**! This document guides you
through the contribution process.

## How to contribute

1. **Open an issue** to discuss a bug, feature, or design change before writing
   code. The maintainers use issues to track the project's direction.
2. **Fork the repo** and create a feature branch.
3. **Write code** following the project conventions (below).
4. **Add tests** for your changes.
5. **Run the checks** (below) locally before opening a pull request.
6. **Open a pull request** with a clear description of what you changed and why.

## Development setup

The repo is a monorepo with four sub-projects:

```
backend/   Python daemon (seekd)  — requires Python >= 3.11 (uv-managed)
tui/       Python curses client   — requires Python >= 3.11 (uv-managed)
webui/     React + TS + Vite      — requires Node >= 22
gui/       Electron shell         — requires Node >= 22
```

Run each sub-project's own toolchain:

```sh
# backend
cd backend && uv sync && uv run pytest tests/

# tui
cd tui && uv sync && uv run pytest tests/

# webui
cd webui && npm ci && npm run build

# gui (syntax check)
cd gui && npm ci && node --check main.js
```

## Project conventions

- **Protocol authority:** any change that affects the wire format MUST update
  [`CONTRACT.md`](CONTRACT.md) — the single source of truth for the message
  contract. All clients and the backend align to it.
- **No circular deps:** no client imports backend code and vice versa. Every side
  implements its own representation of the protocol structures.
- **File size:** keep each file under ~800 lines; split by "what changes" rather
  than "what is built first".
- **No fake-data fallbacks.** The only hard fallback is "the program must not
  crash." Prefer honest handling (return an error) over inventing data.

## Commit style

Use conventional commits:

```
feat: add a new capability
fix: correct a bug
docs: update documentation
chore: maintenance
test: add tests
```

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
