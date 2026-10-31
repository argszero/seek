/**
 * The chain arbiter: what stops two bots talking to each other forever.
 *
 * `docs/design/agent-lifecycle.md` §11.3 states the wall, and §11.4 the wake
 * rule. §7 says why the ordinary anti-loop rules cannot hold here:
 *
 * > The anti-loop rules in §7 all assume somebody is in the room to notice. A
 * > two-agent room breaks that assumption, so a rate limit alone cannot hold
 * > it; something structural has to.
 *
 * There are exactly two bounds and no third:
 *
 * 1. **Depth — cap 4.** Every message carries `caused_by`, `chain` and `depth`
 *    (`delivery.ts` already writes them, data-model rule 11), and the depth is
 *    **read off the message data, never kept in a counter**: a counter has to be
 *    restored after a crash, and the one time it is restored wrong is the one
 *    time it matters.
 * 2. **The room's consecutive-agent-turn cap — 3.** This bounds a *burst*, which
 *    depth never did: a burst of short exchanges uses few hops. It lives on the
 *    `Room` and not on an agent, because no single agent can see how many times
 *    its peers just spoke — an agent-local counter would be an agent measuring
 *    itself and calling it a conversation.
 *
 * **This file owns the two counters and nothing else.** The other clause of
 * §11.4 — a bot message must @-mention, reply to, or be a direct message before
 * it wakes anyone — is not repeated here: it is already `gate.ts` row 2 against
 * row 3, where "another bot's broadcast" is exactly a bot message that addresses
 * nobody. Two readings of one rule is how they drift apart.
 *
 * **The block is a fact about the message, and the decision is taken when the
 * entry is settled.** `deliver()` records the reason on the entry (§11.4 says
 * the entry lands "marked `hints.chainBlocked = reason`"), and `gate()` asks
 * again at settle time, so an entry held while a burst was running is
 * reconsidered once the room moves on. That is what §11.4's "to be reconsidered
 * the next time a human touches the room" needs, and it is why this is a
 * function over the record rather than a stored decision.
 *
 * A human message is never blocked by any of this: the wall exists to stop one
 * bot answering another, not to make a bot deaf to a person.
 */

import type { SeekStore } from './store.ts';
import type { ChainBlockReason, Id, Message, Observation, Room } from './types.ts';

export type { ChainBlockReason };

/**
 * §11.3: at the cap the agent may end or escalate; it may not continue.
 *
 * `host-rulings.md`: "A chain's length and a room's burst are still bounded, but by two
 * numbers that are not the host's: they are the implementer's defaults". These are
 * those defaults, and they are twenty-four because of what twelve measured: a room of four
 * bots with a real question reached a workable plan in twelve messages, and the twelve was
 * the wall rather than the room — the last bot message was cut off mid-discussion, so what
 * ended the meeting was the limit and not the people in it. A wall is a backstop; the room
 * is supposed to end itself, and a backstop that arrives first hides whether it can.
 */
export const DEPTH_CAP = 24;

/**
 * §11.3: twenty-four bot turns in a row in one room, and further bot messages stop waking.
 *
 * Still bounded — a few bots trading remarks after a decision must not keep a room awake
 * all afternoon — and a person's next message resets the run. Twenty-four leaves a room of
 * four about six messages each to find a place to stop.
 */
export const AGENT_TURN_CAP = 24;

/**
 * Whether this entry is held back by the chain wall — and why.
 *
 * `undefined` means "not blocked", which covers the ordinary case as well as a
 * human's message and an entry that addresses nobody (that one is `gate.ts`'s
 * row 3, not this file's).
 */
export function chainBlock(
  store: SeekStore,
  botId: Id,
  entry: Observation,
): ChainBlockReason | undefined {
  const message = messageOf(store, entry);
  // A person is never the reason a bot goes deaf.
  if (!message) return undefined;
  if (!store.data.bots[message.sender_id]) return undefined;
  // Only a message that would otherwise wake it: §11.4's first clause is the
  // gate's, and blocking an entry nobody addressed would be a second copy.
  const addressed =
    entry.hints.mentionsMe || entry.hints.repliesToMe || entry.hints.direct;
  if (!addressed) return undefined;

  if (message.depth >= DEPTH_CAP) return 'depth';
  if (agentTurnsIn(store, message.room_id) >= AGENT_TURN_CAP) {
    return 'room_agent_turns';
  }
  return undefined;
}

/** The message behind an entry, or `undefined` for a reminder (which has no room). */
export function messageOf(
  store: SeekStore,
  entry: Observation,
): Message | undefined {
  if (!entry.room_id) return undefined;
  return store.messagesOf(entry.room_id).find((m) => m.id === entry.message_id);
}

/**
 * One bot turn has run in this room.
 *
 * Called when a turn ends, not when it starts: §11.3 says three bot turns in a
 * row and *further* messages stop waking bots, so the third turn's own words
 * must still reach the other side. Counting a turn that threw is deliberate —
 * it ran, and it may already have spoken.
 */
export function bumpAgentTurns(store: SeekStore, roomId: Id): void {
  const room = store.room(roomId);
  if (!room) return;
  room.consecutive_agent_turns = agentTurnsIn(store, roomId) + 1;
}

/**
 * A person said something here, so the burst is over.
 *
 * The depth of any one chain is untouched — that is the message's own fact and
 * nothing resets it — but the room's run of bot turns is what a human breaks.
 */
export function resetAgentTurns(store: SeekStore, roomId: Id): void {
  const room = store.room(roomId);
  if (!room) return;
  room.consecutive_agent_turns = 0;
}

/** The room's run of consecutive bot turns. Absent means none have run. */
export function agentTurnsIn(store: SeekStore, roomId: Id): number {
  const room: Room | undefined = store.room(roomId);
  return room?.consecutive_agent_turns ?? 0;
}
