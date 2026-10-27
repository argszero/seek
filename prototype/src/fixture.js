/**
 * What the demo shows. **Invented, and only what the window reads.**
 *
 * Every field here is one the window actually asks for — the list was taken off
 * `ui/src/*.jsx` (`snap.me`, `snap.rooms`, `snap.people`, `snap.stage1`, `snap.stage2`,
 * `snap.storeRefusal`, `snap.firstLaw`, `snap.organizations`, `snap.currentOrganizationId`),
 * and each row carries the fields `ui/electron/snapshot.js` puts on it. Nothing is here
 * because a store would have it; a field the window never draws is a field this file would
 * have to keep true for nobody.
 *
 * **The point of the fixtures being this shape is that the prototype is not a second
 * implementation.** It renders `ui/src/App.jsx` — the same component tree the app ships —
 * so a screen cannot exist in one and not the other. What the fixture supplies is only the
 * data the kernel would have supplied.
 */

/**
 * The sentence the product puts above every instruction, **quoted rather than restated**.
 *
 * It is a copy of `ui/electron/law.js`'s own constant, and `ui/electron/prototype.test.mjs`
 * compares the two character for character — a second copy is a second place to drift, and
 * the only defence against that is an assertion that reads both.
 */
export const FIRST_LAW = '人大于机器人：机器人不得越过人，也不得替人做决定。'

/** Who the demo speaks as. The window draws `me` as a name, so it is one. */
export const ME = 'Lin'

/** And the id behind that name, which is what a message's `sender` carries. */
export const ME_ID = 'principal-me'

/** A fixed clock: every row is stamped, so two runs of the demo look the same. */
const at = (day, hour, minute) =>
  `2026-10-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:` +
  `${String(minute).padStart(2, '0')}:00.000Z`

/** The organizations the settings page lists. */
const ORGANIZATIONS = [
  { id: 'org-demo', name: 'Demo organization' },
  { id: 'org-second', name: 'Second organization' },
]

/** A bot, in the four things a person fills in plus the two the store adds. */
function bot(id, name, position, personality, description) {
  return {
    id,
    name,
    bot: true,
    kind: 'bot',
    description,
    gender: null,
    position,
    personality,
  }
}

const ECHO = bot('bot-echo', 'Echo', 'Repeats what it is given', 'Literal, brief', 'Replies to the demo.')
const NOVA = bot('bot-nova', 'Nova', 'Reads the design documents', 'Careful, cites its sources', 'Answers from docs/design.')
const ATLAS = bot('bot-atlas', 'Atlas', 'Keeps the ledger', 'Dry, exact', 'Counts what a room has spent.')

/** A room's spend, as the ledger holds it: turns and tokens, with nothing to compare against. */
function spend(turns, input, output, bots) {
  return { turns, input_tokens: input, output_tokens: output, bots }
}

/** A message, in every field the snapshot puts on one. */
function message(fields) {
  return {
    kind: 'text',
    media: null,
    mentions: [],
    reactions: [],
    quoted: null,
    forwardedFrom: null,
    rootId: null,
    depth: 0,
    ...fields,
    // A message that caused nothing roots its own chain, which is the kernel's own rule
    // (`src/delivery.ts`) and the reason the window groups a thread by `chain`.
    chain: fields.chain ?? fields.id,
  }
}

/**
 * The store, as the demo's own store.
 *
 * Four rooms on purpose, because they are four states the window has to draw: a group with a
 * thread in it, a two-person room, a room with nothing said in it yet, and a room carrying a
 * forward. A demo with one full room shows one screen.
 */
export function makeFixture() {
  return {
    me: ME,
    meId: ME_ID,
    firstLaw: FIRST_LAW,
    organizations: ORGANIZATIONS.map((one) => ({ ...one })),
    currentOrganizationId: 'org-demo',
    people: [ECHO, NOVA, ATLAS].map((one) => ({ ...one })),
    rooms: [
      {
        id: 'room-design',
        name: 'Design review',
        kind: 'group',
        // What a room says about itself, in the three texts a person may edit
        // (`Room.description`/`announcement`/`tag`). `createdAt` is the kernel's `created_at`,
        // which the snapshot renames once — the panel words the moment itself.
        description: 'How the window looks, decided together.',
        announcement: 'Read the rail ruling before changing a column width.',
        tag: 'Design',
        createdAt: at(20, 10, 0),
        spend: spend(6, 8_420, 1_310, [
          { id: NOVA.id, name: NOVA.name, turns: 4, input_tokens: 6_100, output_tokens: 900 },
          { id: ECHO.id, name: ECHO.name, turns: 2, input_tokens: 2_320, output_tokens: 410 },
        ]),
        members: [
          { id: ME_ID, name: ME, bot: false },
          { id: ECHO.id, name: ECHO.name, bot: true },
          { id: NOVA.id, name: NOVA.name, bot: true },
        ],
        messages: [
          message({
            id: 'm-1',
            sender: ME_ID,
            text: 'The conversation column is still two shades. Should it be one?',
            at: at(27, 9, 12),
            reactions: [{ emojiType: '👍', operators: [ECHO.id] }],
          }),
          message({
            id: 'm-2',
            sender: NOVA.id,
            text: 'One. The client separates its two middle columns with a gutter, not a colour.',
            at: at(27, 9, 14),
          }),
          message({
            id: 'm-3',
            sender: ME_ID,
            text: 'Then the seam goes and the gutter stays.',
            at: at(27, 9, 15),
            rootId: 'm-2',
            depth: 1,
            chain: 'm-2',
          }),
          message({
            id: 'm-4',
            sender: NOVA.id,
            text: 'Agreed — and the rail keeps its 156px, which is the words, not the icons.',
            at: at(27, 9, 16),
            rootId: 'm-2',
            depth: 2,
            chain: 'm-2',
          }),
          message({
            id: 'm-5',
            sender: ECHO.id,
            text: 'Recorded.',
            at: at(27, 9, 18),
            quoted: {
              messageId: 'm-1',
              name: ME,
              text: 'The conversation column is still two shades. Should it be one?',
            },
          }),
        ],
      },
      {
        id: 'room-echo',
        name: 'Echo',
        kind: 'p2p',
        // A direct message has no announcement and no tag — the panel draws the two only for a
        // room of more than two, because a notice nobody else will read is a notice about
        // nothing.
        description: null,
        announcement: null,
        tag: null,
        createdAt: at(22, 16, 30),
        spend: spend(2, 1_240, 260, [
          { id: ECHO.id, name: ECHO.name, turns: 2, input_tokens: 1_240, output_tokens: 260 },
        ]),
        members: [
          { id: ME_ID, name: ME, bot: false },
          { id: ECHO.id, name: ECHO.name, bot: true },
        ],
        messages: [
          message({ id: 'm-6', sender: ME_ID, text: 'Say this back to me.', at: at(26, 18, 4) }),
          message({ id: 'm-7', sender: ECHO.id, text: 'Say this back to me.', at: at(26, 18, 4) }),
          message({
            id: 'm-8',
            sender: ECHO.id,
            text: 'A room with one other member is a direct message, whatever its name says.',
            at: at(26, 18, 9),
            mentions: [{ id: ME_ID, name: ME }],
          }),
        ],
      },
      {
        id: 'room-empty',
        name: 'A room with nothing in it',
        kind: 'group',
        spend: spend(0, 0, 0, []),
        members: [
          { id: ME_ID, name: ME, bot: false },
          { id: ATLAS.id, name: ATLAS.name, bot: true },
        ],
        messages: [],
      },
      {
        id: 'room-ops',
        name: 'Operations',
        kind: 'group',
        spend: spend(1, 900, 120, [
          { id: ATLAS.id, name: ATLAS.name, turns: 1, input_tokens: 900, output_tokens: 120 },
        ]),
        members: [
          { id: ME_ID, name: ME, bot: false },
          { id: ATLAS.id, name: ATLAS.name, bot: true },
        ],
        messages: [
          message({
            id: 'm-9',
            sender: ATLAS.id,
            text: 'This one came from the other room.',
            at: at(25, 11, 30),
            forwardedFrom: { messageId: 'm-0', name: 'Design review' },
          }),
          message({
            id: 'm-10',
            sender: ME_ID,
            text: 'Then it can be quoted where it is needed.',
            at: at(25, 11, 34),
          }),
        ],
      },
    ],
    /**
     * The two status strips, saying nothing. `null` in each field is "nothing to report",
     * which is the state a healthy window is in — the strips are drawn from facts, and a
     * demo that opened showing a failure would be teaching the wrong screen.
     */
    stage1: { server: '127.0.0.1:8787', refusal: null, pending: null, weights: null },
    stage2: { server: '127.0.0.1:8787', refusal: null, pending: null, weights: null },
    storeRefusal: null,
  }
}
