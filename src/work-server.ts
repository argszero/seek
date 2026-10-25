/**
 * Stage 2 wired to a server: what the bot actually says, as the loop's `Decide`.
 *
 * `turn.ts` finished the runtime and left exactly one value open — `Decide`, whose
 * doc comment says the real one "runs a model with the kernel's tools" — and this is
 * that value. `main.ts` already takes one (`MilestoneOptions.decide`), so nothing
 * above this file has to change to adopt it.
 *
 * **The two stages answer in different currencies, and that is the whole design.**
 * Stage 1 answers with a probability read off the end of a prompt, which is why
 * `watch-server.ts` measures a mask and refuses a cut it could not read. Stage 2
 * answers by **calling a tool**: `agent-lifecycle.md` §4 says the agent says something
 * by calling `say(room, text)`, that nothing is posted on its behalf, and that a turn
 * ending without that call has said nothing at all. So the failure this file exists to
 * prevent is the other one — **model output pasted into a room**, checklist failure
 * mode (a). Nothing below writes `content` anywhere. The text a model writes beside its
 * calls is its own working record, and `say()` is the only writer of a message
 * (`say.ts`, and the same rule the runtime half states in `turn.ts`).
 *
 * Five things happen before the first turn, and each is a refusal rather than a repair:
 *
 * 1. **settle the artifact** — the words, the split between the system line and the
 *    user turn, and the tools the model is offered are one file (`prompts.ts`,
 *    `docs/decisions.md` row 18). A tool's description is prompt text, so it is not a
 *    string literal in this file.
 * 2. **refuse a server that could not hold the smallest possible turn** —
 *    `requireChatShape` over the assembly with no description and no entries. Refused
 *    here rather than on the first tick, for the reason the watch seam gives: a
 *    runtime bound to a server that cannot answer runs happily and never speaks, and
 *    the only symptom is a silent bot.
 * 3. **refuse a roster that names one model while this server serves another** —
 *    `requireServedModel` on the **work** row. `docs/decisions.md` row 24 recorded that
 *    row as belonging to a different server, which is the fact that made the check
 *    role-aware; this is the server it belongs to.
 * 4. **refuse a file that offers a tool this runtime cannot execute.** A prompt
 *    offering `say` and a runtime that does not run it is a model asked for the
 *    impossible; the turn would produce a call nobody answers and a bot that looks
 *    broken without anything having failed.
 * 5. **refuse a roster whose work row does not allow what the prompt offers.** The
 *    tools the model is handed come from the artifact and the allowlist comes from
 *    `agents.yml` — two files, and nothing compared them. `say.ts` does refuse a call
 *    an agent's row forbids, but it refuses **at the call**, after the prompt has
 *    already told the model the tool is there. Bind is the one place both halves are
 *    open, so it is where they are held against each other.
 *
 * Then, on every turn, three steps in the order the design gives them: assemble from
 * the store (identity read **per turn**, so a rename reaches the next one), check the
 * assembled prompt still fits the window, and run one chat turn whose calls are
 * executed in the order the model asked for them.
 */

import type { AgentIdentity } from './identity.ts';
import {
  chatTurn,
  requireChatShape,
  type ChatTool,
  type LlamaServer,
  type ToolCall,
} from './llama.ts';
import {
  assembleWorkPrompt,
  loadWorkArtifact,
  type WorkArtifact,
  type WorkValues,
} from './prompts.ts';
import { requireServedModel } from './served.ts';
import type { SeekStore } from './store.ts';
import type { Decide, HandedEntry, TurnContext } from './turn.ts';
import type { Id } from './types.ts';

/**
 * The room a bind-time prompt is measured with: an id of the width the store mints.
 *
 * A turn's prompt names the room, and at bind time this bot has no room yet — the
 * first tick may be in one created afterwards. The sample is a fixed string rather
 * than a freshly minted id (`store.ts`'s `newId('oc')`) so that two runs measure the
 * same number: hex digits are not equally likely to be one token. Its width is the
 * width every room id has, which is what makes it the true cost of the *shortest*
 * turn prompt a bot could ever be given.
 */
const ROOM_SAMPLE = 'oc_0000000000000000';

/** What this seam can execute, by the name the artifact offers. */
const EXECUTABLE = new Set(['say']);

/** What the caller may say about the turn half; the rest is the artifact's. */
export interface WorkServerOptions {
  /** The turn prompt artifact. The shipped `work-v1.json` when absent. */
  prompt?: WorkArtifact;
}

/**
 * Bind stage 2 to one bot, over one server, and hand back the loop's `Decide`.
 *
 * Asynchronous only because two of the refusals need the server's answers: a model name
 * and a window are facts `/props` holds and this file does not. Every refusal happens
 * here rather than mid-turn, so a misconfiguration is one error at start-up instead of
 * a bot that quietly says nothing for an afternoon.
 *
 * The returned `Decide` holds the artifact and the tool list, and re-reads the store
 * per turn. Nothing of the bot's identity is captured, which is `identity.ts`'s
 * "pushed, not stored" seen from this side.
 */
export async function workOverServer(
  store: SeekStore,
  botId: Id,
  server: LlamaServer,
  options: WorkServerOptions = {},
): Promise<Decide> {
  const artifact = options.prompt ?? loadWorkArtifact();

  const unknown = artifact.tools.map((tool) => tool.name).filter((name) => !EXECUTABLE.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `the turn prompt offers ${unknown.map((name) => `'${name}'`).join(', ')} and this ` +
        `runtime can only execute ${[...EXECUTABLE].map((name) => `'${name}'`).join(', ')}: ` +
        'a model told to call a tool nobody runs would ask for something that cannot ' +
        'happen, and the turn would end with nothing said and nothing wrong',
    );
  }

  const bot = store.data.bots[botId];
  if (!bot) throw new Error(`unknown bot: ${botId}`);

  // The smallest turn this bot could ever be given: no description to render (that
  // part is skipped), no entries, no roster. A server that cannot hold it cannot serve
  // a single turn, whatever the first real one turns out to be.
  const smallest = assembleWorkPrompt(artifact, {
    bot: bot.name,
    description: '',
    room: ROOM_SAMPLE,
    roster: '',
    entries: [],
  });
  const shape = await requireChatShape(
    server,
    { system: smallest.system, user: smallest.rest },
    'the smallest turn prompt',
  );
  requireServedModel(store, botId, 'work', shape);

  // What the model is offered and what this bot's agent may call are two lines in two
  // files: the artifact names the tools, `agents.yml`'s work row allows them. Nothing
  // ever compared the pair, and the whole cost of that showed up on the other side of
  // the bind — a row edited to drop `say` (the README invites exactly that edit) left a
  // bot that opened, listed its rooms, answered the first thing said to it with a turn
  // error, and kept doing that for every message after. `say.ts` is not the place to
  // catch it: by the time it refuses, the prompt has already promised the model the tool
  // exists, which is the mis-description this refusal is for.
  //
  // A bot with no work row is nothing to compare against, and it never reaches here from
  // `main.ts` — `sceneOf` refuses a store whose bot has no one to answer before stage 2
  // is bound at all.
  const work = store.agentsOf(botId).find((agent) => agent.role === 'work');
  if (work) {
    const notAllowed = artifact.tools
      .map((tool) => tool.name)
      .filter((name) => !work.tools.includes(name));
    if (notAllowed.length > 0) {
      const allowed = work.tools.map((name) => `'${name}'`).join(', ') || 'nothing';
      throw new Error(
        `the turn prompt offers ${notAllowed.map((name) => `'${name}'`).join(', ')} and ` +
          `the roster's work row allows ${allowed}: a model told to call a tool its own ` +
          'row does not list asks for something that cannot happen, and the answer would ' +
          'arrive mid-turn, as a failed call, rather than here as a line to edit',
      );
    }
  }

  const tools: ChatTool[] = artifact.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));

  return async (context: TurnContext): Promise<void> => {
    const values = valuesOf(store, context);
    const assembled = assembleWorkPrompt(artifact, values);

    // A refusal rather than a truncation. This prompt is longer than the one measured
    // at bind time — it carries this turn's entries — and a prompt that overflows is
    // not shortened by llama-server: it shifts the context, keeps 0 leading tokens, and
    // drops the front, which is the system line saying how this agent may speak.
    await requireChatShape(
      server,
      { system: assembled.system, user: assembled.rest },
      "this turn's prompt",
    );

    const answer = await chatTurn(
      server,
      [
        { role: 'system', content: assembled.system },
        { role: 'user', content: assembled.rest },
      ],
      tools,
    );

    // `answer.content` is deliberately unread: it is the agent's working record, and
    // there is no path from it to a room (`say.ts`).
    for (const call of answer.toolCalls) run(store, context, call);
  };
}

/**
 * Do what one call asked, or refuse it by name.
 *
 * A call this runtime cannot read is **not** skipped. Skipping is how a turn that
 * wanted to speak ends silently while every check above still passes, and the same
 * argument as `llama.ts`'s nameless-call refusal applies: the model asked for
 * something, and the honest answer to an unreadable request is an error rather than a
 * shrug dressed as a quiet turn.
 */
function run(store: SeekStore, context: TurnContext, call: ToolCall): void {
  if (!EXECUTABLE.has(call.name)) {
    throw new Error(
      `the model called '${call.name}' and this runtime executes only ` +
        `${[...EXECUTABLE].map((name) => `'${name}'`).join(', ')}: the turn prompt and ` +
        'this seam disagree about what the agent may do, which is a bind-time error ' +
        'that arrived at a turn',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(call.arguments);
  } catch (error) {
    throw new Error(
      `the model called ${call.name} with arguments that are not JSON ` +
        `(${(error as Error).message}): ${call.arguments}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`the model called ${call.name} with ${call.arguments}, which names no arguments`);
  }

  const args = parsed as { room?: unknown; text?: unknown };
  if (typeof args.room !== 'string' || typeof args.text !== 'string') {
    throw new Error(
      `the model called ${call.name} without a room and a text, which are the two ` +
        `arguments the tool declares: ${call.arguments}`,
    );
  }

  // §4: the room is named by the caller, never inferred — and here it is checked
  // against the room this turn is *about*. A turn is one agent's work in one room
  // (`turn.ts`), and §11.3's cap counts a bot's consecutive turns per room. A message
  // the model aimed somewhere else would be counted against no room's run, so the cap
  // that stops two bots trading turns would not see it.
  if (context.roomId === undefined) {
    throw new Error(
      `the model called ${call.name} in a turn with no room: a reminder wakes the bot ` +
        'for its own work (§12) and is not a contribution to any room, so a message has ' +
        'no room to be counted against and this runtime will not pick one',
    );
  }
  if (args.room !== context.roomId) {
    throw new Error(
      `the model called ${call.name} for room ${args.room} but this turn is about ` +
        `${context.roomId}: one turn is one agent's work in one room, and a message ` +
        'into another would be counted against no room\'s run of bot turns (§11.3)',
    );
  }

  // The text goes to `say()` as the model wrote it. This is not a place that trims,
  // reformats or drops a message — including the empty one, which `say()` refuses.
  context.say(args.room, args.text, replyOf(context));
}

/**
 * The message this turn answers, when it answers one.
 *
 * A turn woken by one entry is answering that entry, and saying so is what makes a
 * reply a reply: a message that names its root is the shape §11.4's "replies to one of
 * its messages" is decided on, and a bot that answers a question without linking it
 * reads as a non sequitur to everyone else in the room. A turn woken by several
 * entries answers none of them in particular, and a turn woken by a reminder answers
 * nothing at all — so this is the root only when exactly one message woke the turn.
 */
function replyOf(context: TurnContext): { replyTo: Id } | undefined {
  const woken = context.entries.filter((entry) => entry.message_id !== undefined);
  if (woken.length !== 1 || context.entries.length !== 1) return undefined;
  const rootId = woken[0].message_id;
  return rootId === undefined ? undefined : { replyTo: rootId };
}

/** What this turn's parts are filled from, read off the store at the moment it runs. */
function valuesOf(store: SeekStore, context: TurnContext): WorkValues {
  const bot = context.identity.bot;
  return {
    bot: bot.name,
    description: bot.description ?? '',
    room: context.roomId ?? '',
    roster: rosterOf(context.identity),
    entries: context.entries.map((entry) => entryOf(store, bot.name, entry)),
  };
}

/**
 * The roster as one line per agent, serialised rather than phrased.
 *
 * `identity.ts` states the rule this follows: an agent is told the **facts** — role,
 * tools, home, and which row is itself — and "any prose on top of them belongs to the
 * prompt artifact". So this writes a machine shape and no sentence, and the words
 * around it live in `work-v1.json`. That is also what keeps it from drifting: a field
 * added to `SiblingAgent` shows up here or is deliberately left out, rather than being
 * lost in a sentence nobody re-reads.
 */
function rosterOf(identity: AgentIdentity): string {
  return identity.roster
    .map(
      (own) =>
        `- role=${own.role} tools=${own.tools.join(',') || 'none'} ` +
        `home=${own.home} self=${own.self}`,
    )
    .join('\n');
}

/**
 * One entry as `{sender, text}`.
 *
 * A reminder has no message behind it, and its `text` is the note itself, written by
 * the bot to its future self (§12) — so the sender is the bot, and the text is
 * delivered **verbatim**, which is the whole of what makes a reminder a note rather
 * than a fresh instruction.
 *
 * An entry that names a message reads the body off the stored message rather than
 * copying it onto the entry, which is `watch.ts`'s rule for the same reason: a verdict
 * is the only thing stage 1 writes, and the record keeps one copy of what was said. A
 * sender with no principal row is named by its own id, which is what a client shows for
 * a stranger; a message that is no longer there contributes an empty line, exactly as
 * the watch half treats a missing body.
 */
function entryOf(
  store: SeekStore,
  botName: string,
  entry: HandedEntry,
): { sender: string; text: string } {
  const messageId = entry.message_id;
  if (messageId === undefined) return { sender: botName, text: entry.text ?? '' };

  const message =
    entry.room_id === undefined
      ? undefined
      : store.messagesOf(entry.room_id).find((own) => own.id === messageId);
  if (!message) return { sender: '', text: '' };
  return {
    sender: store.principal(message.sender_id)?.name ?? message.sender_id,
    text: message.text,
  };
}
