/**
 * What a room is called on screen.
 *
 * **A room with no name is known by who is in it.** That is what the client does with its own
 * unnamed groups, measured on 2026-11-04 from a screenshot read by OCR rather than by eye: the
 * row's title was `邵安清，张杰，李玉峰` — the members, the reader among them, all of them, with
 * nothing else on the line. The same reading shows why this is a list and not a sentence: no
 * conjunction is written, so `joinNames()` rather than `joinList()` (`catalogue.mjs`).
 *
 * **This is the window's question, not the snapshot's.** `snapshotOf()` used to answer a
 * nameless room with `room.id`, which put `oc_f63ba78b67f84769` where a title is drawn — a
 * machine's identifier in the one place a person reads a name, and indistinguishable from a
 * room somebody had deliberately named that. It now answers `null`, the fact, and every screen
 * that draws a title asks here instead. The split is the same one `docs/host-rulings.md`
 * states for the window's sentences: the reading carries facts, the window words them — and a
 * list's punctuation is one of the words (`docs/design/i18n.md` §4), which is why the main
 * process must not be the one joining it.
 *
 * **The fallback chain is three deep and it ends.** A named room shows its name; an unnamed
 * room shows who is in it; a room with neither shows its id, because the kernel refuses a room
 * with no members and this is the shape of a store that predates that refusal — an id is
 * unhelpful and `undefined` is worse, and a title of `undefined` reaching `t()` is exactly the
 * fault that blanked the window on a first run (`#227`, 2026-11-03).
 *
 * One room has one title: the rail's row, the groups list, the chat header, the room panel and
 * the topics list all ask this function, so a room cannot be called one thing in a list and
 * another thing once it is open.
 */
import { joinNames } from './catalogue.mjs'

export function roomTitle(room) {
  if (typeof room?.name === 'string' && room.name !== '') return room.name
  const who = (room?.members ?? [])
    .map((member) => member?.name)
    .filter((name) => typeof name === 'string' && name !== '')
  if (who.length > 0) return joinNames(who)
  return String(room?.id ?? '')
}
