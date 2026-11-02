import { t } from './catalogue.mjs'

/**
 * What one bot is doing, drawn on its avatar.
 *
 * `docs/design/agent-lifecycle.md` §8 item 1: "a state dot: watching / working / asleep /
 * needy, as an avatar badge". The four words are the design's; the state itself is the
 * kernel's, derived at the snapshot (`ui/electron/snapshot.js`, `botStatesOf`) from which bots
 * are in a turn and which have a read waiting. Nothing in this file decides any of it.
 *
 * **Three of the four are drawn, and the fourth is not a missing drawing.** `needy` means
 * "waiting on your decision" and no part of the kernel asks a person for one and waits, so a
 * bot cannot be in that state and a dot for it would be a colour nothing can show. It is
 * absent here for the same reason a silent bot has no `reason` sentence: nothing writes one.
 *
 * **The state is said in words as well as in colour.** A dot alone is a reading only a person
 * who already knows the palette can take, and it is nothing at all to a screen reader; the
 * `title` is the word for it, in the language this window speaks.
 *
 * **No dot for a bot that is not here.** `activity` holds every bot the store still offers, so
 * an id with no entry is somebody who left — a message of theirs is still a message, and a dot
 * beside it would be reporting on a bot that no longer exists.
 *
 * The class is the state's own name, so a colour is the stylesheet's business and not this
 * file's (`shell.css`, `.state-dot`).
 */
export default function StateDot({ state }) {
  const key = WORDS[state]
  if (key === undefined) return null
  return <span className={`state-dot ${state}`} data-state={state} title={t(key)} />
}

/**
 * The catalogue key each state is drawn with.
 *
 * Written out one by one rather than built from the state name, because a key assembled at
 * runtime is a key no reader of this file can search for — and because `needy`, the state that
 * has no producer, has no key to reach that way either.
 */
const WORDS = {
  asleep: 'ui.chat.state.asleep',
  watching: 'ui.chat.state.watching',
  working: 'ui.chat.state.working',
}
