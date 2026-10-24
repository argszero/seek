/**
 * The kernel as it stands: the sharded store, delivery into one inbox per bot,
 * and the loop that wakes a bot only when an entry arrived.
 *
 * The build checklist that this is the first slice of is `src/README.md`; what
 * each behaviour answers to is `docs/design/data-model.md` and
 * `docs/design/agent-lifecycle.md`.
 */

export { SeekStore, emptyData, newId } from './store.ts';
export type { SeekData } from './store.ts';
export { deliver, deriveHints, deriveKind } from './delivery.ts';
export type { Delivery, PostMessageInput } from './delivery.ts';
export { InboxLoop } from './inbox.ts';
export type { RunTurn, TickResult } from './inbox.ts';
export type * from './types.ts';
