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
export {
  agentIdFor,
  applyRoster,
  parseRoster,
  readRoster,
  readRosterFor,
  rosterPath,
  ROSTER_FILE,
} from './roster.ts';
export type { AgentRow } from './roster.ts';
export { identityFor } from './identity.ts';
export type { AgentIdentity, BotIdentity, SiblingAgent } from './identity.ts';
export { addMember, createRoom } from './rooms.ts';
export type { AddMemberInput, CreateRoomInput, CreatedRoom, NewMember } from './rooms.ts';
export { deleteMessage, deleteRoom, deleteThread } from './erase.ts';
export type {
  DeleteMessageInput,
  DeleteRoomInput,
  DeleteThreadInput,
  DeletedRoom,
  DeletedThread,
  Erased,
} from './erase.ts';
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
export { assemblePrompt, loadPromptArtifact, shippedPromptPath, skeletonOf } from './prompts.ts';
export type { DeclaredOperatingPoint, PromptArtifact, PromptPart, PromptValues } from './prompts.ts';
export {
  catalogueFor,
  DEFAULT_LOCALE,
  joinList,
  loadCatalogue,
  locales,
  shippedCataloguePath,
  translator,
} from './i18n.ts';
export type { Catalogue, Message, Params, Translate } from './i18n.ts';
export { llamaWatchModel, bindOverServer, DEFAULT_N_PROBS, strip } from './llama.ts';
export type { Fetcher, LlamaServer, PictureRef, TurnMessage, TurnPart } from './llama.ts';
export { bindOptions, declaredOptions, watchAs } from './watch.ts';
export { watchOverServer } from './watch-server.ts';
export type { WatchServerOptions } from './watch-server.ts';
export type {
  BoundOption,
  OperatingPoint,
  OptionBinding,
  OptionTokens,
  Tokeniser,
  Watch,
  WatchInput,
  WatchJudge,
  WatchModel,
  WatchOptions,
  WatchOutcome,
  WatchPrompt,
  WatchReading,
} from './watch.ts';
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
export { Compactor, deltaFor, digestOf } from './compact.ts';
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
