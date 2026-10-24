/**
 * The kernel as it stands: the sharded store, delivery into one inbox per bot,
 * the loop that wakes a bot only when an entry arrived, and the assembled
 * process that starts it — one store, one loop per bot, one schedule comparator.
 *
 * The build checklist that this is the first slice of is `src/README.md`; what
 * each behaviour answers to is `docs/design/data-model.md` and
 * `docs/design/agent-lifecycle.md`.
 */

export { SeekStore, emptyData, newId } from './store.ts';
export type { SeekData } from './store.ts';
export { deliver, deriveHints, deriveKind } from './delivery.ts';
export type { Delivery, PostMessageInput } from './delivery.ts';
export { classify, gate } from './gate.ts';
export type { GateDecision, GateResult } from './gate.ts';
export {
  AGENT_TURN_CAP,
  DEPTH_CAP,
  agentTurnsIn,
  bumpAgentTurns,
  chainBlock,
  resetAgentTurns,
} from './chain.ts';
export type { ChainBlockReason } from './chain.ts';
export { InboxLoop } from './inbox.ts';
export type { Judge, RunTurn, TickResult } from './inbox.ts';
export { addRow, cancelRow, fireDue, listRows } from './schedule.ts';
export { scheduleAdd, scheduleAs, scheduleCancel, scheduleList } from './schedule.ts';
export type {
  AddRowInput,
  ScheduleAddInput,
  ScheduleAddOptions,
  ScheduleCall,
  ScheduleCancelInput,
  ScheduleTool,
} from './schedule.ts';
export { ScheduleComparator, msUntilDue, nextDueAt, wallTimers } from './comparator.ts';
export type { ComparatorOptions, Timers } from './comparator.ts';
export { say, sayAs } from './say.ts';
export type { SayInput, SayOptions, SayTool } from './say.ts';
export { makeTurn, runTurn } from './turn.ts';
export type { Decide, HandedEntry, TurnContext, TurnRecord, TurnSpec } from './turn.ts';
export { RoomCompactor, deltaFor, digestOf } from './compact.ts';
export type {
  CompactLines,
  CompactOptions,
  CompactOutcome,
  CompactSkip,
  Summarise,
  SummariseInput,
} from './compact.ts';
export { Kernel } from './kernel.ts';
export type { KernelFailure, KernelOptions } from './kernel.ts';
export type * from './types.ts';
