# Prototype — previous runnable version (archive, not a starting point)

An Electron implementation moved here on 2026-10-23.

**What it is**: a local instant messenger in the layout of a conventional desktop chat client. It starts, it responds to clicks, and it stores everything locally. It exists to answer one question — can that kind of interface be carried by purely local data? It can.

**What it is not**: not the implementation of seek. Its data model is thin — an organization holds one me and a cast of bots, messages are owned by conversations — while seek needs many agents in one room, with shared messages and private context and budget per agent. That difference lives in the data layer, not in the interface, so **this prototype cannot be refactored into seek**: the interface can be reused, the data layer has to be rewritten.

## Run it

```bash
cd prototype
npm install     # first time only
npm start
```

`npm start` holds the terminal until the window closes. To avoid that:

```bash
open node_modules/electron/dist/Electron.app --args "$PWD"
```

## What it covers

- **Messages**: four-column layout (64px nav, conversation list, message column, right-hand thread panel); sending; Enter to send, Shift+Enter for a newline; day dividers; consecutive messages from one sender collapse their avatar; "N replies"; emoji reactions; copy and delete; draft retention; unread dots; pinning.
- **Attachments**: image and file messages — pick from the toolbar, drop onto the message area or the composer, or paste an image; click an image for a lightbox, click a file card to open it with the system application.
- **Threads**: any message opens a thread panel on the right (root message, replies, reply composer); also a per-conversation thread list and a global thread overview.
- **Bots**: the organization's cast, with a profile page each — what it is responsible for, which organization it belongs to, who it recognizes as the human, and the first law it is held to. Add one to the organization, remove one, start a direct chat in one click.
- **Groups**: group list, create a group (including a topic group), announcements, member and owner marks, add members, edit, leave.
- **Organizations**: an organization is a directory — one me and a cast of bots inside it, and nothing visible to another organization. Switch from the avatar, create one with a name, rename it, delete it (which deletes its directory); switching reads the other directory and moves no file. Light and dark themes.
- **Member types**: every member carries its own type, `human` or `bot`. A bot tells people from bots by reading that column, never by guessing at a name. The first law, held above every other instruction, is that a person outranks a bot: a bot does not override a person and does not decide for one.

## Reusable vs not

| Reuse | Do not reuse |
|---|---|
| The four-column layout and spacing | The `chatter` data model (becomes Principal + Agent) |
| Message rendering rules (day dividers, continuation, actions on hover) | "A conversation owns its messages" (splits into Room and Session) |
| The three-layer thread panel | Group members as a bare id list (becomes Membership) |
| Design tokens (colour ramps and type scale, light and dark) | The storage layer (needs per-entity shards plus agent-level memory) |

## Where the data lives

- State: `~/Library/Application Support/Seek/seek-data/seek.json` (atomic writes, 250ms debounce)
- Attachments: `files/` in the same directory, served to the renderer through a private `seek-file://` protocol so the page never sees a filesystem path

Note: the prototype and the future implementation share this data directory name — do not run both at once.

## Known gaps

No organisation tree in contacts, search is substring-only with no filters, no message context menu, no archive or mute entry points in the list.

## Internationalisation

Interface strings are hard-coded in Chinese inside `src/js/`. This prototype is an archive and will not be retrofitted; the implementation must externalise every user-visible string from day one — see `docs/design/i18n.md`.
