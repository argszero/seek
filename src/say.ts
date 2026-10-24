/**
 * The speaking tool: `say(room, text)` — and the only way into a room.
 *
 * `docs/design/agent-lifecycle.md` §4 states the whole delivery rule, and every
 * clause below exists to keep one of its consequences true:
 *
 * > **To say anything it must call the speaking tool** — `say(room, text)`,
 * > where a direct chat is a room like any other. Text it emits is its own
 * > working record, and it never becomes a message: nothing is posted on its
 * > behalf, and a turn that ends without that call has said nothing at all.
 *
 * So there is no path from a turn's output to a message. The runtime does not
 * post the agent's answer, a streamed fragment, or a summary of what it did;
 * the only writer is this function, called by the agent itself, naming the room
 * it is addressing. That is what makes a silent turn meaningful and "it said
 * nothing there" a readable fact rather than a guess about what a stream meant.
 *
 * Three refusals, each answering a way the rule would otherwise be broken:
 *
 * - **The room is named by the sender.** There is no default and no inferred
 *   room: (d) in the checklist is exactly "letting the runtime infer the room
 *   instead of taking it from the call".
 * - **A bot speaks in its own voice, through its own agent.** An agent belongs
 *   to one bot (`Agent.bot_id`), and the message carries `agent_id` so the room
 *   records which worker acted without showing it.
 * - **An agent that was not given the tool cannot speak.** Which tools an agent
 *   may use is ordinary per-agent configuration (`docs/host-rulings.md`, "the
 *   tool set is EMRG's"), and today one answer is "none": the watch agent is a
 *   decision model that makes no tool call at all.
 *
 * Empty text is refused rather than posted: a message nobody chose to finish is
 * the failure (b) names, and the way to say nothing is not to call this.
 */

import { deliver } from './delivery.ts';
import type { SeekStore } from './store.ts';
import type { Id, Message } from './types.ts';

export interface SayOptions {
  /** The message this one answers, when it answers one. */
  replyTo?: Id;
  /** An injectable clock, so a test does not depend on wall time. */
  now?: string;
}

export interface SayInput extends SayOptions {
  /** The bot whose voice this is. */
  botId: Id;
  /** Which agent of that bot is speaking. */
  agentId: Id;
  /** The room being addressed. Never inferred. */
  roomId: Id;
  text: string;
}

/**
 * The tool as a turn holds it.
 *
 * The bot and the agent are bound when the turn hands it over; the room and the
 * text are the agent's own, every time.
 */
export type SayTool = (
  roomId: Id,
  text: string,
  options?: SayOptions,
) => Message;

/**
 * Speak once, in one room.
 *
 * Synchronous like `deliver()`: the message and every recipient's entry land in
 * one uninterrupted step, and the caller persists once. The text is posted
 * exactly as given — this is not a place that rewrites what an agent chose to
 * say.
 */
export function say(store: SeekStore, input: SayInput): Message {
  const agent = store.data.agents[input.agentId];
  if (!agent) throw new Error(`unknown agent: ${input.agentId}`);
  if (agent.bot_id !== input.botId) {
    throw new Error(
      `agent ${input.agentId} does not work for bot ${input.botId}, so it cannot speak as it`,
    );
  }
  if (!agent.tools.includes('say')) {
    throw new Error(
      `agent ${input.agentId} (role ${agent.role}) cannot speak: 'say' is not in its tool list`,
    );
  }
  if (input.text.trim() === '') {
    throw new Error(
      'say() with no text: a turn that has nothing to say does not call the tool',
    );
  }

  const { message } = deliver(store, {
    roomId: input.roomId,
    senderId: input.botId,
    agentId: input.agentId,
    text: input.text,
    rootId: input.replyTo,
    now: input.now,
  });
  return message;
}

/**
 * Bind the tool to one bot's agent, as a turn hands it over.
 *
 * The room is still the caller's to name: binding what the agent *is* and
 * leaving what it *addresses* to the call is the whole shape of the tool.
 */
export function sayAs(
  store: SeekStore,
  botId: Id,
  agentId: Id,
  onProduced?: (message: Message) => void,
): SayTool {
  return (roomId, text, options) => {
    const message = say(store, { botId, agentId, roomId, text, ...options });
    onProduced?.(message);
    return message;
  };
}
