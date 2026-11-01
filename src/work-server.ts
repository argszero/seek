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

import { archiveDays, archivePlaceOf, readArchiveDay } from './archive.ts';
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
  type TurnMessage,
  type TurnPart,
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

/**
 * What this seam can execute, by the name the artifact offers.
 *
 * Two, and the second is the one the ruling asks for: `docs/host-rulings.md`, "The
 * observation box" — the uncompacted content "is archived by day", the model is told
 * where, and it "may go and read it". A tool named in the artifact and absent here is
 * refused at bind (§ below), so this set and `work-v9.json` are held against each other
 * before the first turn.
 */
const EXECUTABLE = new Set(['say', 'read']);

/**
 * How many times one turn may look something up before it has to answer.
 *
 * A look is a second generation request with the same box in it, so an unbounded loop is
 * an unbounded bill and a bot that never speaks. Three is enough for the shape the ruling
 * describes — read a day, notice the day before it, read that — and a turn that asks a
 * fourth time is refused rather than quietly left unanswered, because a model left
 * mid-look is a turn whose last words were never read by anybody.
 */
const LOOK_ROUNDS = 3;

/** The archive place a bind-time measurement uses, before this bot has a home to read. */
const ARCHIVE_SAMPLE = '/tmp/seek/agents/work/archive (nothing filed yet)';

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
    archive: ARCHIVE_SAMPLE,
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
    const pictures = picturesOf(context);

    // The request this turn opens with, and then what it opens *after* a look. A turn
    // that looks nothing up sends exactly this and nothing else, so every prompt
    // measured before this seam carried a tool an answer could come back for is the
    // same request it was measured as.
    const opening: TurnMessage[] = [
      { role: 'system', content: assembled.system },
      {
        role: 'user',
        // A turn whose box holds no picture sends the string it sent before, byte for
        // byte: parts exist to say where a picture goes, and a request with no picture
        // has nothing to say with them.
        content:
          pictures.length === 0
            ? assembled.rest
            : [{ type: 'text', text: assembled.rest }, ...pictures],
      },
    ];

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
    // The window is checked on the opening request, which is the one whose size this
    // file assembled. A later round carries that plus a day of archive, and it is bounded
    // where the archive is read (`ARCHIVE_READ_LIMIT`) rather than guessed at here: a
    // character estimate of an endpoint's tokeniser is the kind of number this repository
    // refuses to make up.
    if (declared === null) {
      await requireChatShape(
        server,
        { system: assembled.system, user: assembled.rest },
        "this turn's prompt",
      );
    }

    let messages = opening;
    // What the server said this turn read and wrote, handed to `runTurn` to be written
    // on the ledger row — the one place a real cost enters the store. `undefined` when
    // the server reported no usage: this seam does not top the figure up, because the
    // half it would invent is the half nobody measured. A turn that looked something up
    // is two or more requests, and the row is the whole of what they cost, so they are
    // added rather than the last one reported.
    let spent: TokenUsage | null = null;

    for (let round = 0; ; round += 1) {
      const answer = await chatTurn(server, messages, tools);
      if (answer.usage !== null) spent = add(spent, answer.usage);

      // `answer.content` is deliberately unread: it is the agent's working record, and
      // there is no path from it to a room (`say.ts`).
      const looked: { call: ToolCall; text: string }[] = [];
      for (const call of answer.toolCalls) {
        const text = run(store, context, call);
        // `say` answers with nothing: it has already done what it was asked, and a turn
        // that only spoke is finished. Anything that answers with words is a look, and a
        // look is only worth making if the model is asked again with the answer in hand.
        if (text !== undefined) looked.push({ call, text });
      }
      if (looked.length === 0) break;

      if (round === LOOK_ROUNDS) {
        throw new Error(
          `the model asked to look something up ${LOOK_ROUNDS + 1} times in one turn ` +
            `(${looked.map((one) => one.call.name).join(', ')} again, after ${LOOK_ROUNDS} ` +
            'answers): each look is another request carrying the whole box, so a turn ' +
            'that keeps looking never answers, and this one is ended rather than left ' +
            'mid-look with words nobody read',
        );
      }

      // The answer goes back as the endpoint's own two shapes: the assistant message the
      // calls are continued from — carrying only the calls whose answers are about to be
      // sent, because the endpoint matches them one for one — and one `tool` message per
      // answer, named by the call it belongs to.
      messages = [
        ...messages,
        {
          role: 'assistant',
          content: answer.content,
          toolCalls: looked.map((one) => one.call),
        },
        ...looked.map((one, index) => ({
          role: 'tool' as const,
          toolCallId: one.call.id ?? `call_${round}_${index}`,
          content: one.text,
        })),
      ];
    }

    return spent ?? undefined;
  };
}

/** Two requests' usage as one figure, for a turn that looked something up. */
function add(sofar: TokenUsage | null, more: TokenUsage): TokenUsage {
  if (sofar === null) return { ...more };
  return {
    input_tokens: sofar.input_tokens + more.input_tokens,
    output_tokens: sofar.output_tokens + more.output_tokens,
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
function run(store: SeekStore, context: TurnContext, call: ToolCall): string | undefined {
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

  // `read` answers with words and answers nothing else: it posts no message, so it is
  // the one call whose result is handed back to the model rather than into a room.
  if (call.name === 'read') return look(store, context, parsed as { day?: unknown });

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
  // Nothing to hand back: the message is the answer, and the model already knows what it
  // asked for. A turn that only spoke ends here, which is what makes loop one request.
  return undefined;
}

/**
 * `read(day)`: one day of what a note folded away, in the agent's own words.
 *
 * **The day is a name, not a path.** `archive.ts` builds the file from a `YYYY-MM-DD`
 * it has checked, so nothing a model writes in this call can reach outside the bot's own
 * archive — the surface a bot can read is the surface the runtime files for it, and there
 * is no second one.
 *
 * **Two different answers to two different problems.** A `day` argument that is not a day
 * is a call this runtime cannot read, and an unreadable call is an error (the same rule as
 * `say`'s). A day this bot simply has nothing filed for is not an error: it is an answer,
 * and it is the answer that lets the model correct itself — it is told which days do exist
 * and asks again. A throw there would end the turn over a wrong guess about a date.
 */
function look(store: SeekStore, context: TurnContext, args: { day?: unknown }): string {
  const agent = store.data.agents[context.agentId];
  const home = agent?.home ?? '';
  const days = archiveDays(home);
  const day = typeof args.day === 'string' ? args.day.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error(
      `the model called read with day=${JSON.stringify(args.day)}, which is not a day: the ` +
        'tool declares YYYY-MM-DD, and a name this runtime cannot read is not a day it may ' +
        `answer with a guess. The days this bot has filed are ` +
        `${days.join(', ') || 'none yet'}`,
    );
  }
  const text = readArchiveDay(home, day);
  if (text !== null) return text;
  return (
    `this bot has nothing filed for ${day}. ` +
    (days.length === 0
      ? 'Nothing has been filed at all yet: a day is written when a note folds a room\'s ' +
        'messages away, and no note has been written for it so far.'
      : `The days it has are ${days.join(', ')}.`)
  );
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
 * The pictures this turn's transcript is about, as parts for its one user message.
 *
 * **This is the half `work-v6` could only describe.** A room's pictures reach the box
 * (`box.ts`, `BoxMedia`) and, from here, reach the model as images — the sentence the
 * artifact writes over each such line is now an account of a picture that arrives rather
 * than a note that one did not. The list is the box's own, in the box's order, so it lines
 * up with the entry lines that carry `{picture}` one for one.
 *
 * **Taken from the box only when the box is what was read.** `valuesOf` answers from the
 * box's entries, and falls back to the waking entries for a reminder or for entries the
 * record no longer holds; those wakings never came with a media list, so this hands over
 * nothing rather than a picture the transcript no longer has a line for.
 *
 * **Which of them travel is not decided here.** A picture is only in a request if its
 * bytes were read and if the request could hold them, and both of those live in
 * `messagesWithPictures` — the one layer that has the bytes.
 */
function picturesOf(context: TurnContext): TurnPart[] {
  const box = context.box;
  if (box === undefined || box.entries.length === 0) return [];
  return box.media.map((picture) => ({
    type: 'picture',
    picture: { key: picture.key, mime: picture.mime },
  }));
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
    archive: archivePlaceOf(store.data.agents[context.agentId]?.home ?? ''),
    memories: memoriesOf(store, context),
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

/** How many of the bot's other notes a turn is told about, newest first. */
const MEMORIES_IN_INDEX = 10;

/** How much of a note the index quotes, in characters. */
const MEMORY_LINE_CHARS = 120;

/**
 * The index of what this bot wrote down about the rooms it is not in right now.
 *
 * The third of the three things `docs/host-rulings.md` hands a turn by default — *"the
 * latest compaction, the memory index and every observation after the latest
 * compaction"*. Two of them were already fact: the compaction is `summary` (the box's
 * note for this room) and the observations are the entry lines. This is the index, and
 * what it answers is *what am I in the middle of somewhere else* — a bot woken in one
 * room while a decision it took part in sits in another.
 *
 * **The room being addressed is left out on purpose.** Its note is the part above this
 * one, quoted in full; listing it here as well would read as emphasis rather than as one
 * fact, and it is the same sentence twice. So a bot that has only ever worked in one
 * room has no index at all, and the part that quotes one leaves the prompt: the ruling's
 * three things are then two, and both of them are the ones that carry content.
 *
 * **One line each, and a bounded one.** A note is a compaction's whole body, which is not
 * a thing to put in a prompt beside the note for this room: what a turn gets is where
 * each note is about, when it was written and how it starts. The list is capped and says
 * so when it is, because a silently truncated list reads as a complete one — the failure
 * `src/README.md` names for the box and this is the same rule one layer up.
 *
 * Machine-shaped rather than phrased, as `rosterOf` is: the words around a row belong to
 * the artifact, and a key=value row does not have to be re-read when the sentence is
 * reworded. `first=` runs to the end of the line, so the free text is last.
 */
function memoriesOf(store: SeekStore, context: TurnContext): string | undefined {
  const rows = store
    .memoriesOf(context.agentId)
    .filter((row) => !(row.level === 'room_digest' && row.room_id === context.roomId))
    // Newest first, and the id breaks a tie so two notes written in the same instant do
    // not change places between two turns that read the same record.
    .sort((a, b) => {
      if (a.updated_at !== b.updated_at) return a.updated_at < b.updated_at ? 1 : -1;
      return b.id.localeCompare(a.id);
    });
  if (rows.length === 0) return undefined;

  const shown = rows.slice(0, MEMORIES_IN_INDEX);
  const lines = shown.map((row) => {
    const place = row.room_id === undefined ? '' : ` room=${roomNameOf(store, row.room_id)}`;
    return `-${place} level=${row.level} at=${row.updated_at} first=${startOf(row.body)}`;
  });
  if (shown.length < rows.length) {
    lines.unshift(`showing=${shown.length} of ${rows.length}, newest first`);
  }
  return lines.join('\n');
}

/** How the store names a room: the name somebody gave it, or its id when nobody did. */
function roomNameOf(store: SeekStore, roomId: Id): string {
  const name = store.data.rooms[roomId]?.name?.trim() ?? '';
  return name === '' ? roomId : name;
}

/**
 * How a note starts: its first line that says something, on one line and cut short.
 *
 * A compaction writes a paragraph, and a digest for another room is quoted for what it is
 * about rather than for what it says. The cut is marked, because a line that stops
 * mid-sentence without saying so reads as the whole of the note.
 */
function startOf(body: string): string {
  const line = body
    .split('\n')
    .map((one) => one.trim())
    .find((one) => one.length > 0) ?? '';
  const tidy = line.replace(/\s+/g, ' ');
  return tidy.length <= MEMORY_LINE_CHARS ? tidy : `${tidy.slice(0, MEMORY_LINE_CHARS)}…`;
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
 * One entry as `{sender, text, at}`.
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
 *
 * `at` is the entry's own `delivered_at`, and it is the one fact here that does not
 * come off the message: the entry is stamped when it reaches this bot, so a reminder,
 * a message and a message whose body has been erased all carry the time they arrived
 * even when nothing else about them survives. It is handed over as the record writes
 * it — never rephrased as "a week ago", which would need a clock reading here and is
 * the separate question `agent-lifecycle.md` leaves open.
 */
function entryOf(
  store: SeekStore,
  botName: string,
  entry: HandedEntry,
): { sender: string; text: string; at: string; picture: boolean } {
  const at = entry.delivered_at;
  const messageId = entry.message_id;
  if (messageId === undefined) {
    return { sender: botName, text: entry.text ?? '', at, picture: false };
  }

  const message =
    entry.room_id === undefined
      ? undefined
      : store.messagesOf(entry.room_id).find((own) => own.id === messageId);
  if (!message) return { sender: '', text: '', at, picture: false };
  return {
    sender: store.principal(message.sender_id)?.name ?? message.sender_id,
    text: message.text,
    at,
    // The one fact about a message that has no text of its own. A picture is carried
    // as `Message.media` (`types.ts`), which `box.ts` hands to the judgement and which
    // the half that answers was never told about: measured on the request body before
    // `work-v6`, a message containing only a picture reached the prompt as `me:` and
    // could be told apart from an empty message by nothing at all. The words for it
    // are the artifact's `pictureLine` — this is the fact, not the sentence.
    picture: message.media !== undefined,
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
