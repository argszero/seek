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
 *. A tool's description is prompt text, so it is not a
 *    string literal in this file.
 * 2. **refuse a server that could not hold the smallest possible turn** —
 *    `requireChatShape` over the assembly with no description and no entries. Refused
 *    here rather than on the first tick, for the reason the watch seam gives: a
 *    runtime bound to a server that cannot answer runs happily and never speaks, and
 *    the only symptom is a silent bot.
 * 3. **refuse a roster that names one model while this server serves another** —
 * `requireServedModel` on the **work** row. The design recorded that
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

import { agentTurnsIn } from './chain.ts';
import type { AgentIdentity } from './identity.ts';
import {
  chatTurn,
  requireChatShape,
  requireDeclaredModel,
  type ChatTool,
  type DeclaredEndpoint,
  type LlamaServer,
  type ToolCall,
} from './llama.ts';
import {
  assembleCompactPrompt,
  assembleWorkPrompt,
  loadCompactArtifact,
  loadWorkArtifact,
  type CompactArtifact,
  type WorkArtifact,
  type WorkValues,
} from './prompts.ts';
import type { Summarise, SummariseInput } from './compact.ts';
import { requireServedModel } from './served.ts';
import type { SeekStore } from './store.ts';
import type { Decide, HandedEntry, TurnContext } from './turn.ts';
import type { Id, TokenUsage } from './types.ts';

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
  // part is skipped), no note about the room (that part is skipped with it), no
  // entries, no roster. A server that cannot hold it cannot serve a single turn,
  // whatever the first real one turns out to be.
  const smallest = assembleWorkPrompt(artifact, {
    bot: bot.name,
    description: '',
    position: '',
    personality: '',
    gender: '',
    room: ROOM_SAMPLE,
    roster: '',
    summary: '',
    entries: [],
  });
  // Which of the two kinds of endpoint this is decides what can be asked of it, and the
  // difference is stated rather than smoothed over. A `llama-server` reports its template and
  // its window through `/props`, and the smallest possible turn is measured against that
  // window before anything is bound. A hosted endpoint reports neither: it renders its own
  // template and owns its own window, so the only question it can answer is which model it
  // serves — and that is the one asked, once, so a typo in a model name is a sentence at
  // start-up rather than a turn that fails all afternoon.
  let declared: DeclaredEndpoint | null = null;
  if (typeof server.model === 'string' && server.model !== '') {
    declared = await requireDeclaredModel({ ...server, model: server.model });
    requireServedModel(store, botId, 'work', {
      // A hosted endpoint has no weights path to report, so the name it was asked for is
      // the whole of what it says about itself — and it is the endpoint's own list that said
      // it serves that name.
      modelAlias: declared.model,
      modelPath: '',
    });
  } else {
    const shape = await requireChatShape(
      server,
      { system: smallest.system, user: smallest.rest },
      'the smallest turn prompt',
    );
    requireServedModel(store, botId, 'work', shape);
  }

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

  return async (context: TurnContext): Promise<TokenUsage | void> => {
    const values = valuesOf(store, context);
    const assembled = assembleWorkPrompt(artifact, values);

    // A refusal rather than a truncation. This prompt is longer than the one measured
    // at bind time — it carries this turn's entries — and a prompt that overflows is
    // not shortened by llama-server: it shifts the context, keeps 0 leading tokens, and
    // drops the front, which is the system line saying how this agent may speak.
    //
    // **A hosted endpoint is asked nothing here, and the silence is the honest answer.**
    // The check is a token count, and the only tokeniser that counts this prompt correctly
    // is the endpoint's own — which it does not offer. A character estimate would be this
    // file making up a number and refusing a turn over it. What protects the turn instead
    // is that an endpoint answers an over-long prompt with an error rather than by
    // discarding the front of it, so the failure arrives as the endpoint's own words on the
    // turn that caused it instead of as a bot that quietly stopped making sense.
    if (declared === null) {
      await requireChatShape(
        server,
        { system: assembled.system, user: assembled.rest },
        "this turn's prompt",
      );
    }

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

    // What the server said this turn read and wrote, handed to `runTurn` to be written
    // on the ledger row — the one place a real cost enters the store. `undefined` when
    // the server reported no usage: this seam does not top the figure up, because the
    // half it would invent is the half nobody measured.
    return answer.usage ?? undefined;
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

  const args = parsed as { room?: unknown; text?: unknown; mentions?: unknown };
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
  //
  // **The names it asked to be answered by are resolved here, not stored as written.**
  // A message wakes a bot when it names that bot, replies to it or is direct
  // (`delivery.ts`), and nothing scans the text for an `@`: a model that wrote
  // `@小荷` in the body and no mention would have addressed nobody. So the names go
  // through the room's own membership, and a name that is not in the room is refused
  // rather than dropped — a mention aimed at nobody is a message the sender believed
  // was addressed.
  context.say(args.room, args.text, { ...replyOf(context), ...mentionsOf(store, args.mentions, context) });
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

/**
 * What this turn's parts are filled from, read off the store at the moment it runs.
 *
 * **What the model reads is the box, not the wake** (`docs/host-rulings.md`: "The work
 * agent is handed the whole box"). A turn woken by one message in a room that has been
 * talking for an hour is asked to continue that conversation, so the note and every
 * observation since it are rendered here, oldest first. The waking entries are a
 * fallback for the one shape with no box — a reminder, which is in no room (§12) — and
 * for a record that no longer holds the entries it was handed, which is the erased or
 * the never-stored: what woke the turn is then all there is to read, and it is still
 * read rather than answered from nothing.
 */
function valuesOf(store: SeekStore, context: TurnContext): WorkValues {
  const bot = context.identity.bot;
  const box = context.box;
  const readable =
    box !== undefined && box.entries.length > 0 ? box.entries : context.entries;
  return {
    bot: bot.name,
    description: bot.description ?? '',
    position: bot.position ?? '',
    personality: bot.personality ?? '',
    gender: bot.gender ?? '',
    room: context.roomId ?? '',
    roster: rosterOf(context.identity),
    others: othersOf(store, context, bot.id),
    turns: context.roomId === undefined ? undefined : turnsSincePerson(store, context.roomId),
    summary: box?.summary ?? '',
    entries: readable.map((entry) => entryOf(store, bot.name, entry)),
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
 * The other bots in this room, by name — the same list the judgement is given.
 *
 * `watch.ts` states why that line is load-bearing on its side: without it four bots read
 * one name as addressed to each of them. Here it answers a different question — *who can
 * I ask* — and a room where the bot is alone contributes nothing, so the part that quotes
 * it leaves the prompt rather than saying "the other bots in this room: ".
 */
/**
 * How long this room has been talking without the person, once it is worth saying.
 *
 * **A meeting ends by the clock, not by the topic running out.** Measured: a room of four
 * with a real question settled its plan in the first ten messages and then spent fifteen
 * more agreeing on the same three things — nobody was tired, because nothing in the prompt
 * said the room had been at it for a while. The count is the room's own record
 * (`chain.ts`), not a count of this turn's box: a note may have folded earlier messages
 * away, and the record still knows how long the run has been.
 *
 * Absent below the mark, because a room that has just started is not a room to be told to
 * wrap up. The number is the whole fact; what it means for the turn is the artifact's.
 */
const ROOM_HAS_BEEN_TALKING = 8;

function turnsSincePerson(store: SeekStore, roomId: Id): string | undefined {
  const turns = agentTurnsIn(store, roomId);
  return turns < ROOM_HAS_BEEN_TALKING ? undefined : String(turns);
}

function othersOf(store: SeekStore, context: TurnContext, botId: Id): string {
  if (context.roomId === undefined) return '';
  return store
    .botsIn(context.roomId)
    .filter((bot) => bot.id !== botId)
    .map((bot) => {
      const name = bot.name === '' ? bot.id : bot.name;
      // What each of them does, when the card says: a bot that is asked to name
      // somebody has to be able to tell which somebody, and a list of bare names makes
      // "@小荷, you take the database" as likely as the reverse. The position is the
      // card's own field and nothing is added to it.
      const position = (bot.position ?? '').trim();
      return position === '' ? name : `${name} (${position})`;
    })
    .join(', ');
}

/**
 * The names a `say` call asked to be answered by, resolved against this room.
 *
 * Three refusals, and each stands for a way the mention would otherwise be a lie:
 *
 * - **Not a list of names.** The schema says an array of strings; anything else is a
 *   call the runtime cannot read, and `run()`'s rule is that an unreadable call is an
 *   error rather than a shrug dressed as a quiet turn.
 * - **A turn with no room.** A reminder wakes a bot for its own work (§12); a mention
 *   names people in a room, so there is nothing to resolve against.
 * - **A name nobody here has.** Dropping it would post a message its sender believed was
 *   addressed to someone; the room's own names are listed in the refusal, because the
 *   fix is one word and the model can only make it if it is told which words exist.
 *
 * A leading `@` is stripped first: the answer is a name, and a model that formats it the
 * way the room reads (`@小荷`) meant the same person.
 */
function mentionsOf(
  store: SeekStore,
  raw: unknown,
  context: TurnContext,
): { mentions: { id: Id; name: string }[] } | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(
      `the model called say with mentions=${JSON.stringify(raw)}, which is not a list of ` +
        'names: the tool declares an array of the names in this room',
    );
  }
  if (context.roomId === undefined) {
    throw new Error(
      'the model named who should answer in a turn with no room: a mention resolves ' +
        'against the members of the room the message goes into, and this turn has none',
    );
  }
  const members = store
    .membershipsOf(context.roomId)
    .map((membership) => membership.principal_id)
    .map((id) => ({ id, name: nameOf(store, id) }));
  const out: { id: Id; name: string }[] = [];
  for (const one of raw) {
    const asked = typeof one === 'string' ? one.replace(/^@+/, '').trim() : '';
    const member = members.find((who) => who.name === asked || who.id === asked);
    if (member === undefined) {
      throw new Error(
        `the model named ${JSON.stringify(one)} in a say call and nobody by that name is in ` +
          `this room: a mention is who the message is addressed to, so an unmatched name ` +
          `would be a message aimed at nobody. The names here are ` +
          `${members.map((who) => who.name).join(', ')}`,
      );
    }
    if (!out.some((who) => who.id === member.id)) out.push(member);
  }
  return { mentions: out };
}

/** How the store names one principal: its own name, or its id when nobody named it. */
function nameOf(store: SeekStore, id: Id): string {
  const bot = store.data.bots[id];
  if (bot) return bot.name === '' ? bot.id : bot.name;
  const person = store.data.principals[id];
  if (person) return person.name === '' ? person.id : person.name;
  return id;
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

/**
 * The other thing the half that writes writes: the room's note.
 *
 * `compact.ts` owns *when* a delta has outgrown itself and how the note and its
 * consumed-to point land together; this is the writer it hands in (`Summarise`), bound
 * to the same server and the same bot as the turns, because `docs/host-rulings.md`
 * settles that only the half that can write keeps the box. The judgement reads the
 * note and never writes one.
 *
 * **No tool is offered.** A turn is offered `say` because a room is reached no other
 * way; the note is reached no other way either — it is a return value, not a call. A
 * model handed the turn's tool here would answer a note with `say`, and the note would
 * be a message.
 *
 * **An empty answer throws rather than becoming an empty note.** `RoomCompactor` turns
 * a throw into "this compaction did not run" and waits for the delta to grow before
 * trying again, which is the honest outcome: a note of nothing would consume the delta
 * and leave the later self with less than it had.
 */
export function digestOver(
  store: SeekStore,
  botId: Id,
  server: LlamaServer,
  options: { prompt?: CompactArtifact } = {},
): Summarise {
  const artifact = options.prompt ?? loadCompactArtifact();
  return async (input: SummariseInput): Promise<string> => {
    const botName = store.data.bots[botId]?.name ?? botId;
    const assembled = assembleCompactPrompt(artifact, {
      bot: botName,
      room: store.room(input.roomId)?.name ?? input.roomId,
      ...(input.previous === undefined ? {} : { previous: input.previous.body }),
      entries: input.delta.map((entry) => entryOf(store, botName, entry)),
    });

    const answer = await chatTurn(server, [
      { role: 'system', content: assembled.system },
      { role: 'user', content: assembled.rest },
    ]);

    const body = answer.content.trim();
    if (body === '') {
      throw new Error(
        `the note for room ${input.roomId} came back empty: a note of nothing would ` +
          `consume ${input.delta.length} observations and leave the bot knowing less than ` +
          'before it wrote one',
      );
    }
    return body;
  };
}
