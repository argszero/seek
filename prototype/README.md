# Prototype — previous runnable version (archive, not a starting point)

An Electron implementation moved here on 2026-10-23.

**What it is**: a local instant messenger that looks like the Feishu desktop client. It starts, it responds to clicks, and it stores everything locally. It exists to answer one question — can a Feishu-style interface be carried by purely local data? It can.

**What it is not**: not the implementation of seek. Its data model is single-user — one account, a cast of fake people, messages owned by conversations — while seek needs many agents in one room, with shared messages and private context and budget per agent. That difference lives in the data layer, not in the interface, so **this prototype cannot be refactored into seek**: the interface can be reused, the data layer has to be rewritten.

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
- **Contacts**: contact list with profile pages, add and remove contacts, start a direct chat in one click.
- **Groups**: group list, create a group (including a topic group), announcements, member and owner marks, add members, edit, leave.
- **Accounts**: switch accounts from the avatar (each with its own data space), create/edit/delete, light and dark themes.

## Reusable vs not

| Reuse | Do not reuse |
|---|---|
| The four-column layout and spacing | The `chatter` data model (becomes Principal + Agent) |
| Message rendering rules (day dividers, continuation, actions on hover) | "A conversation owns its messages" (splits into Room and Session) |
| The three-layer thread panel | Group members as a bare id list (becomes Membership) |
| Design tokens (colour ramps and type scale measured from the Feishu client, light and dark) | The storage layer (needs per-entity shards plus agent-level memory) |

## Where the data lives

- State: `~/Library/Application Support/Seek/seek-data/seek.json` (atomic writes, 250ms debounce)
- Attachments: `files/` in the same directory, served to the renderer through a private `seek-file://` protocol so the page never sees a filesystem path

Note: the prototype and the future implementation share this data directory name — do not run both at once.

## Known gaps

No organisation tree in contacts, search is substring-only with no filters, no message context menu, no archive or mute entry points in the list.

## Internationalisation

Interface strings are hard-coded in Chinese inside `src/js/`. This prototype is an archive and will not be retrofitted; the implementation must externalise every user-visible string from day one — see `docs/design/i18n.md`.
