/**
 * The watch prompt, as a versioned artifact on disk rather than a string built at
 * a call site (src/README.md line 27, and the prompt artifact's §"the question put to
 * the watch model").
 *
 * Why the prompt is a file and not a template literal in `watch.ts`: rewording
 * alone moved one model's discrimination on the same cases from 0.083 accuracy to
 * 0.771 AUC and inverted it between Chinese and English, so a prompt is something
 * that has a version, that an operating point is calibrated *against*, and that a
 * reader can compare to the case sets the number came from
 * (`calibration/provenance.md`). A literal in the source has none of that: an edit
 * to it moves who ships as correct without leaving a mark anywhere a reviewer
 * would look.
 *
 * **The file owns the order, and the runtime applies it.** The comment on line 19
 * of the checklist objects to *"a runtime that assembles a prompt for it instead
 * of handing it the room's box"* — the box must still be handed over, and it is
 * (`WatchInput.state`). What this file adds is that the runtime, and not the model,
 * decides where each part of that box sits in the text a judgement continues from.
 * Before this, `WatchInput` handed the prompt and the box over as two separate
 * things and left the interleaving to the model, which is a decision no version
 * can be pinned to and no measurement can cover: the ids read as the answer are
 * taken at the prompt's own end, so an ordering that lives in the model is an
 * ordering that moves the answer without moving the artifact.
 *
 * **Nothing here reads the box's other facts.** `read`/`total`/`unread`,
 * `lastVerdict`, `observationsSinceLastVerdict` and `whoSpoke` are box fields the
 * model is given (§3), and none of them is in the measured prompt: the 76 cases
 * were asked as summary + one message + the question, and putting unmeasured text
 * in front of a 3B to reach a cut that was measured without it is how a calibrated
 * number stops being one. They stay fields; what this file fixes is the text.
 *
 * **The last token is what the mask is measured against**, so the assembly always
 * ends with a part that cannot be absent — see `assertArtifact`, and note the
 * trailing space in the shipped artifact's question: it is the boundary the option token
 * is appended at, not decoration. A prompt that ends mid-word lets a tokeniser
 * merge the option into the last token of the prompt, and then no id at the
 * prompt's own end is the option's (`watch.ts`, `bindOptions`).
 */

import { readFileSync } from 'node:fs';

/**
 * A part's condition: always rendered, once the room has a summary, only for a bot
 * whose card says what it does here, or only for a room that has a name.
 *
 * `position` is `work-v2`'s rule on this side of the runtime: a part that quotes a
 * fact the bot may not have is skipped rather than rendered with a blank in it, and
 * a bot whose card is empty is asked the same question without that line. `room`
 * is the same rule applied to the room: a room may be nameless (`rooms.ts` — an
 * empty name is no name), and a nameless room is asked where the message went by
 * the line being absent rather than by a blank after a colon.
 *
 * `turns` is the fourth: how long this room has been talking without the person, present
 * only once it is long enough to matter. A part that quotes a count is skipped while the
 * count is nothing, so an opening exchange reads the short prompt and a room that has been
 * at it for a while is told so.
 */
export type PartCondition = 'always' | 'summary' | 'position' | 'room' | 'others' | 'turns';

/** One part of the assembly, in the order the file lists it. */
export interface PromptPart {
  /** The part's own name, for the error messages and for a reader of the file. */
  name: string;
  /** Its template, with `{summary}` or `{text}` where a box field goes. */
  text: string;
  /**
   * What follows the part, verbatim.
   *
   * A separator rather than a prefix on the next part, because the last part's
   * `after` is the boundary the option token is appended at — the one piece of
   * whitespace that decides whether the mask ids name the answer or the prompt.
   */
  after: string;
  /** `always`, or `summary` for a part that is skipped while there is no digest. */
  when: PartCondition;
  /**
   * `observation` makes the part repeat once per delta entry, oldest first.
   *
   * Oldest first and not the box's own newest-first order: `ResidentContext` says
   * the head runs prompt, summary, then the entries it has read, so an arrival can
   * only ever be appended to it (§4 "the box's tokens are kept warm"). Rendering
   * newest-first would put the new line at the front of everything already read,
   * which is a new head on every message and the end of warmth.
   */
  each?: 'observation';
}

/** The declared cut, and what it was measured on. */
export interface DeclaredOperatingPoint {
  /** Probability of `act` at or above which the bot acts. In (0, 1). */
  threshold: number;
  /** The labelled set and the reading, in the file, for a reader of the number. */
  measuredOn?: string;
}

/** One versioned prompt, as the file states it. */
export interface PromptArtifact {
  /** The identity the operating point names. */
  version: string;
  /** The head of the text: there are no chat roles here, only one continuation. */
  system: string;
  /** What follows the system block — `"\n\n"` in the shipped artifact. */
  afterSystem: string;
  /** The parts, in the order they are rendered. */
  parts: PromptPart[];
  /**
   * The one question, with its two answers.
   *
   * A decision model is handed a question whose answers it can only pick from, and
   * the answer comes back as a calibrated probability per key — so the keys are the
   * option tokens (`watch.ts`, `declaredOptions`) and the criteria are what each one
   * means in words. This replaced a sentence ending in "Answer act or ignore", which
   * was a question with no options: the model was free to begin with any token at
   * all, and `llama.ts` searched the distribution for a spelling of `act`.
   */
  question: PromptQuestion;
  /** The cut this version was calibrated at. Absent means no declared default. */
  operatingPoint?: DeclaredOperatingPoint;
}

/** The question put to a judgement: what is asked, and what each answer means. */
export interface PromptQuestion {
  /** What is being asked, as one sentence. */
  instructions: string;
  /** Per option token, what choosing it means. Both tokens must be here. */
  criteria: Record<string, string>;
}

/**
 * One line of the box, with the three facts a reader needs to place it.
 *
 * All four are on the record before this module sees them: the text is the
 * message's (`Observation` names a message; a reminder carries its own words),
 * the sender is `Message.sender_id` resolved through the store, and the time is
 * the entry's own `delivered_at`. A watch prompt that handed a model the text
 * alone made it judge a sentence with no idea who said it or when — which is how
 * four bots read `小荷，这个 bug 你来看一下` as ordinary chatter and all four
 * stayed quiet, while the work side had been naming its sender all along
 * (`work-v2.json`'s entry part).
 */
export interface PromptLine {
  /** The message's text, verbatim. */
  text: string;
  /** Whoever spoke it, by the name the store gives them; a reminder's author. */
  sender: string;
  /** When it landed, as the record timestamps it. */
  at: string;
}

/** What a part is filled from: the room, its summary, and each delta entry. */
export interface PromptValues {
  /** The compaction's result, when the room has one. */
  summary?: string;
  /**
   * The name of the room these entries came from, when it has one.
   *
   * Absent is a nameless room — `rooms.ts` treats an empty name as no name — and
   * never a caller that forgot: a part quoting the room is skipped without it,
   * the same way a part quoting a position is.
   */
  room?: string;
  /**
   * Which bot is being asked, by the name a person gave it.
   *
   * **Absent is a caller that has no bot to name** — `skeletonOf`, measuring where the
   * question ends — and never a bot without a name: a store names every bot, and a
   * judgement that did not say whose it was would be the same question put to every
   * bot in the organization, which is what made four bots answer alike.
   */
  bot?: string;
  /** What that bot does here, when its card says. */
  position?: string;
  /**
   * The other bots in the room, by name, comma-joined.
   *
   * **This line is what makes "is this for me" a question the model can answer.** Without
   * it a named message was read by every bot as addressed to it: four bots asked the same
   * `小荷，这个 bug 你来看一下` all answered `act`. With it, the named bot reads 0.89 and
   * the other three read 0.21–0.36. Absent when the bot is alone in the room, or when it is
   * not in it at all — the part is skipped rather than saying "none".
   */
  others?: string;
  /** The entries to render, **oldest first**. */
  lines: PromptLine[];
}

/** The shipped artifact's location, beside this module. */
export function shippedPromptPath(): URL {
  return new URL('./prompts/watch-v3.json', import.meta.url);
}

/**
 * Read one artifact off disk and check it says what this runtime needs.
 *
 * `source` defaults to the shipped file, and takes a path or URL so a test can
 * prove the text really comes from a file rather than from a literal in here: a
 * second artifact written to a temporary directory flows all the way through
 * `watchAs`, which no hard-coded string could do.
 *
 * It throws rather than falling back. A runtime that substituted a built-in
 * prompt when the file was missing or malformed would ship a prompt nobody
 * measured, wearing the version number of one that was measured.
 */
export function loadPromptArtifact(source: string | URL = shippedPromptPath()): PromptArtifact {
  let raw: string;
  try {
    raw = readFileSync(source, 'utf8');
  } catch (error) {
    throw new Error(
      `the watch prompt artifact could not be read from ${String(source)}: ` +
        `${(error as Error).message} — the prompt is a file, and a runtime with no ` +
        'artifact has no question it is allowed to ask (src/README.md line 27)',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `the watch prompt artifact at ${String(source)} is not JSON: ${(error as Error).message}`,
    );
  }
  return assertArtifact(parsed, String(source));
}

/**
 * The text a judgement continues from, assembled in the file's own order.
 *
 * One pass over the templates: a room message that happens to contain `{summary}`
 * is not a substitution site, and a message that contained a summary would
 * otherwise let a room write the front of its own prompt.
 */
export function assemblePrompt(artifact: PromptArtifact, values: PromptValues): string {
  // Who this judgement is for, or nothing at all. A head that names a placeholder
  // because nobody handed the name over would be read as part of the question, so
  // the two cases are refused here rather than filled blank: a caller that has no
  // name is `skeletonOf`, and it says so by passing one.
  if (artifact.system.includes('{bot}') && values.bot === undefined) {
    throw new Error(
      'the artifact names {bot} and no bot was given: a judgement about a bot is asked ' +
        'with its name, and a head reading "{bot}" is a placeholder the model would ' +
        'answer instead of a question',
    );
  }
  const out: string[] = [fill(artifact.system, { bot: values.bot ?? '' }), artifact.afterSystem];
  for (const part of artifact.parts) {
    if (part.when === 'summary' && values.summary === undefined) continue;
    if (part.when === 'position' && values.position === undefined) continue;
    if (part.when === 'room' && values.room === undefined) continue;
    if (part.when === 'others' && values.others === undefined) continue;
    if (part.each === 'observation') {
      for (const line of values.lines) {
        out.push(
          fill(part.text, { text: line.text, sender: line.sender, at: line.at }),
          part.after,
        );
      }
      continue;
    }
    out.push(
      fill(part.text, {
        summary: values.summary ?? '',
        position: values.position ?? '',
        room: values.room ?? '',
        others: values.others ?? '',
      }),
      part.after,
    );
  }
  return out.join('');
}

/**
 * The assembly a mask is measured against: no summary, no entries, the same end.
 *
 * `bindOptions` reads the option ids off `prompt.text + option`, so what it needs
 * is a text that ends exactly where every real assembly ends. That is the last
 * part, which `assertArtifact` keeps unconditional, so the skeleton and a room's
 * full box share their final token and the ids measured once hold for all of them.
 */
export function skeletonOf(artifact: PromptArtifact): {
  version: string;
  system: string;
  text: string;
} {
  // The name is empty here on purpose: the skeleton is the assembly with nothing
  // room-specific in it, and its job is to end where every real assembly ends. Who
  // the bot is changes the head of the text and never its last token, so the ids
  // measured once at this end hold for every bot asked the same question.
  return {
    version: artifact.version,
    system: systemOf(artifact, {}),
    text: assemblePrompt(artifact, { lines: [], bot: '' }),
  };
}

/**
 * The question to put, with its two answers, checked against the option tokens.
 *
 * The keys are the tokens the answer is read by (`watch.ts`, `declaredOptions`), so a
 * question that names an option the runtime does not read is refused here rather than
 * answered and dropped.
 */
export function questionOf(
  artifact: PromptArtifact,
  tokens: { act: string; ignore: string },
): PromptQuestion {
  const criteria = artifact.question.criteria;
  for (const token of [tokens.act, tokens.ignore]) {
    if (typeof criteria[token] !== 'string') {
      throw new Error(
        `${artifact.version} asks its question with no meaning for ${JSON.stringify(token)}: ` +
          'the two options the cut is applied to are the two the artifact must describe',
      );
    }
  }
  return {
    instructions: artifact.question.instructions,
    criteria: { [tokens.act]: criteria[tokens.act], [tokens.ignore]: criteria[tokens.ignore] },
  };
}

/**
 * The head of the assembly on its own: who is being asked, and what it does here.
 *
 * Apart from `assemblePrompt` because the server needs it apart — the chat template
 * takes the head as its system message and the rest as the user turn, and the split
 * is found by matching this line (`llama.ts`). Empty when the artifact's head names
 * no bot at all, which is what a template without a `{bot}` fills in.
 */
export function systemOf(artifact: PromptArtifact, values: { bot?: string }): string {
  return fill(artifact.system, { bot: values.bot ?? '' });
}

/** One template, filled in a single pass. */
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}

/**
 * What the runtime needs the file to say.
 *
 * The conditions are not stylistic. A part whose template names `{summary}` but
 * which is rendered when there is no summary asks the model about a memory that
 * does not exist; a per-observation part with nothing after it leaves the text
 * ending wherever the last message happened to end, which moves the mask ids from
 * message to message; and a placeholder nothing fills is rendered literally into
 * the prompt, where it reads as part of the question.
 */
function assertArtifact(value: unknown, source: string): PromptArtifact {
  const fail = (detail: string): never => {
    throw new Error(`${source} is not a watch prompt artifact: ${detail}`);
  };
  if (typeof value !== 'object' || value === null) return fail('it is not an object');
  const artifact = value as Partial<PromptArtifact>;

  if (typeof artifact.version !== 'string' || artifact.version.trim().length === 0) {
    return fail('`version` must be a non-empty string');
  }
  if (typeof artifact.system !== 'string') return fail('`system` must be a string');
  if (typeof artifact.afterSystem !== 'string') {
    return fail('`afterSystem` must be a string (use "" to join the system block directly)');
  }
  if (!Array.isArray(artifact.parts) || artifact.parts.length === 0) {
    return fail('`parts` must be a non-empty array');
  }

  // The head may name the bot and what it does here, and nothing else: who is being
  // asked is a fact about the bot, while a message or a summary in the head would be
  // the same text in every room — the header refuses to let a room write.
  for (const name of placeholdersIn(artifact.system)) {
    if (name !== 'bot') {
      return fail(
        `\`system\` names {{${name}}}, which belongs to the box rather than to the bot — ` +
          'the head is the same text in every room',
      );
    }
  }

  const parts: PromptPart[] = [];
  for (const [index, part] of artifact.parts.entries()) {
    const where = `parts[${index}]`;
    if (typeof part !== 'object' || part === null) return fail(`${where} is not an object`);
    const row = part as Partial<PromptPart>;
    if (typeof row.name !== 'string' || row.name.trim().length === 0) {
      return fail(`${where}.name must be a non-empty string`);
    }
    if (typeof row.text !== 'string' || row.text.length === 0) {
      return fail(`${where}.text must be a non-empty string`);
    }
    if (typeof row.after !== 'string') return fail(`${where}.after must be a string`);
    if (
      row.when !== 'always' &&
      row.when !== 'summary' &&
      row.when !== 'position' &&
      row.when !== 'room' &&
      row.when !== 'others' &&
      row.when !== 'turns'
    ) {
      return fail(
        `${where}.when must be "always", "summary", "position", "room", "others" or ` +
          `"turns", got ${JSON.stringify(row.when)}`,
      );
    }
    if (row.each !== undefined && row.each !== 'observation') {
      return fail(`${where}.each must be "observation" when present`);
    }

    const placeholders = [...row.text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
    for (const name of placeholders) {
      if (name === 'summary' && row.when !== 'summary') {
        return fail(`${where} fills {summary} but is rendered when there is no summary`);
      }
      if (name === 'position' && row.when !== 'position') {
        return fail(`${where} fills {position} but is rendered when the bot may have none`);
      }
      if (name === 'room' && row.when !== 'room') {
        return fail(`${where} fills {room} but is rendered when the room may have no name`);
      }
      if (name === 'others' && row.when !== 'others') {
        return fail(`${where} fills {others} but is rendered when the bot may be alone`);
      }
      if (name === 'turns' && row.when !== 'turns') {
        return fail(`${where} fills {turns} but is rendered when the room has only just begun`);
      }
      if ((name === 'text' || name === 'sender' || name === 'at') && row.each !== 'observation') {
        return fail(
          `${where} fills {{${name}}} without \`each: "observation"\`, so it has nothing ` +
            'to fill from',
        );
      }
      if (
        name !== 'summary' &&
        name !== 'text' &&
        name !== 'position' &&
        name !== 'room' &&
        name !== 'others' &&
        name !== 'sender' &&
        name !== 'at'
      ) {
        return fail(`${where} names {{{${name}}}}, which nothing here fills`);
      }
    }
    // The other half of that rule: a part that says it depends on a position and never
    // quotes one leaves the prompt for a reason nothing in its own text explains.
    if (row.when === 'position' && !placeholders.includes('position')) {
      return fail(
        `${where} is skipped without a position and does not quote one, so nothing it ` +
          'says depends on it',
      );
    }
    if (row.when === 'room' && !placeholders.includes('room')) {
      return fail(
        `${where} is skipped without a room name and does not quote one, so nothing it ` +
          'says depends on it',
      );
    }
    if (row.each === 'observation' && row.when !== 'always') {
      return fail(`${where} cannot both repeat per observation and be conditional`);
    }

    const normalised: PromptPart = {
      name: row.name,
      text: row.text,
      after: row.after,
      when: row.when,
    };
    if (row.each) normalised.each = row.each;
    parts.push(normalised);
  }

  // The question is checked as a question: one sentence, and a meaning for each of the two
  // answers. A missing criterion is an option the model cannot choose for a stated reason —
  // the endpoint would still return a probability for it, which is the shape of a verdict
  // with nothing behind it.
  const question = artifact.question as Partial<PromptQuestion> | undefined;
  if (typeof question !== 'object' || question === null) {
    return fail('`question` must be an object with `instructions` and `criteria`');
  }
  if (typeof question.instructions !== 'string' || question.instructions.trim().length === 0) {
    return fail('`question.instructions` must be a non-empty string');
  }
  const criteria = question.criteria as Record<string, unknown> | undefined;
  if (typeof criteria !== 'object' || criteria === null) {
    return fail('`question.criteria` must be an object mapping each option to its meaning');
  }
  const meanings: Record<string, string> = {};
  for (const [token, meaning] of Object.entries(criteria)) {
    if (typeof meaning !== 'string' || meaning.trim().length === 0) {
      return fail(`\`question.criteria.${token}\` must be a non-empty string`);
    }
    meanings[token] = meaning;
  }

  const artifactOut: PromptArtifact = {
    version: artifact.version,
    system: artifact.system,
    afterSystem: artifact.afterSystem,
    parts,
    question: { instructions: question.instructions, criteria: meanings },
  };
  if (artifact.operatingPoint !== undefined) {
    const point = artifact.operatingPoint as Partial<DeclaredOperatingPoint>;
    if (typeof point.threshold !== 'number' || !Number.isFinite(point.threshold)) {
      return fail('`operatingPoint.threshold` must be a number');
    }
    if (point.threshold <= 0 || point.threshold >= 1) {
      return fail(
        `\`operatingPoint.threshold\` must lie strictly between 0 and 1, got ${point.threshold} ` +
          '— the cut comes from a labelled set (src/README.md line 26), never from an edge',
      );
    }
    if (point.measuredOn !== undefined && typeof point.measuredOn !== 'string') {
      return fail('`operatingPoint.measuredOn` must be a string when present');
    }
    const declared: DeclaredOperatingPoint = { threshold: point.threshold };
    if (point.measuredOn !== undefined) declared.measuredOn = point.measuredOn;
    artifactOut.operatingPoint = declared;
  }
  return artifactOut;
}

/**
 * The turn's prompt: what the expensive half is asked when it wakes.
 *
 * A second artifact kind rather than a second `PromptArtifact`, and the difference
 * is the whole reason it exists as its own contract. The watch artifact ends where
 * an answer is **read** — its last part is unconditional because the option ids are
 * measured at the text's own end, and a room that ended it elsewhere would move the
 * mask (`assertArtifact`). Nothing is read at the end of a generation: the model
 * answers by calling a tool, in the middle of whatever it writes. So the rules that
 * keep the watch assembly's end fixed would be noise here, and what replaces them is
 * the rule this kind does have — every placeholder a part names must be one the
 * runtime actually fills, and a per-entry placeholder may only appear on the part
 * that repeats.
 *
 * It is a file for the same reason the watch prompt is: a reader can see what the
 * bot is told, and a change to it is a change to a versioned thing rather than an
 * edit inside `work-server.ts` that no reviewer would find. What it does **not**
 * carry is an operating point — there is no cut to calibrate against here, because
 * a turn is not a verdict. Saying that plainly is worth more than a field filled
 * with a number nobody measured.
 *
 * What the facts are, and what stays out: the identity arrives as `AgentIdentity`
 * (facts, not a sentence) and the entries arrive already stripped of
 * the watch side's verdict and reason (`turn.ts`, `handOver`). The one thing this
 * file adds to the record is the line §4 says opens such a turn — *"you decided to
 * say this yourself; nobody called you"* — and it belongs in the artifact for the
 * same reason every other sentence here does.
 */

/**
 * The facts about a bot that nobody had to fill in.
 *
 * `position` is what the bot does in this organization and `personality` is how it
 * talks and works (`types.ts`, `Bot`); `gender` is on the same card, and `description`
 * is the free text a bot was written with before the card existed. Every one of them
 * is optional on the store, so a part quoting one is skipped when the bot has none —
 * telling a model about a position nobody wrote down is a blank the model fills in
 * itself.
 *
 * `gender` is here and unused by the shipped artifact: a fact the store holds should
 * not be unreachable from a prompt, and which of them a sentence quotes is the
 * artifact's decision rather than this module's.
 */
export type OptionalFact = 'description' | 'gender' | 'position' | 'personality';

/** One part of a turn's prompt. */
export interface WorkPart {
  /** The part's own name, for the error messages and for a reader of the file. */
  name: string;
  /**
   * Its template, with `{bot}`, `{room}`, `{roster}`, or one of the per-entry names
   * `{sender}`, `{text}`, `{at}` and `{picture}`.
   */
  text: string;
  /** What follows the part, verbatim. */
  after: string;
  /**
   * `always`, `summary` for a part that is skipped while the room has no note, or the
   * one optional fact this part is skipped without.
   *
   * A bot may have nothing on its card but its name, so a part that quotes a field
   * a person may have left empty has to name that field: the part then leaves the
   * prompt with the fact instead of asking a model about a blank. A room may have no
   * note for the same reason (`compact.ts`: nothing has been compacted), and a part
   * that quotes the note names it the same way.
   */
  when: 'always' | 'summary' | OptionalFact;
  /**
   * `entry` repeats the part once per observation the turn was woken for.
   *
   * Oldest first, which is the order the store wrote them: a conversation read out
   * of order is a different conversation, and the entry that woke the turn belongs
   * nearest the question.
   */
  each?: 'entry';
}

/** One versioned turn prompt, as the file states it. */
export interface WorkArtifact {
  /** The identity this file is. `work-v1` is the shipped one. */
  version: string;
  /** The head of the text, before the parts. Filled with `{bot}`. */
  system: string;
  /** What follows the system block. */
  afterSystem: string;
  /**
   * What an entry line says when the message it stands for came with a picture.
   *
   * The words live in the file rather than in `work-server.ts` for the reason every
   * other word the model reads does: what a turn is told is a versioned artifact, so
   * the same sentence that a reader finds in `work-v6.json` is the sentence that
   * reached the model — nothing between the two invents phrasing.
   *
   * **In v6 this line was the picture's whole journey, and in v7 it is not.** v6 was
   * written when the turn was handed no picture at all, so the sentence said so: a
   * wordless picture arrived as `me:` before it, and a picture with a caption arrived as
   * its caption — measured on the request body, where `picture`, `image`, `media` and the
   * blob's own key appeared nowhere. The wiring behind `box.ts`'s `BoxMedia` now puts the
   * pictures themselves in the request, so v7's sentence describes a picture that
   * arrives, and covers the one that does not: a line with no image to match it is a
   * picture the turn cannot see. The judgement is unchanged and still refuses one, because
   * the model that ships declares `modalities.vision: false` (`docs/host-rulings.md`).
   * Absent on v1–v5, where an entry line carries no such fact.
   */
  pictureLine?: string;
  /** The parts, in the order they are rendered. */
  parts: WorkPart[];
  /**
   * The tools the turn is offered, as the model is shown them.
   *
   * Here rather than beside the transport, for the reason the rest of the prompt is
   * here: a tool's name, its description and its argument schema are text a model
   * reads, so they are prompt text — and prompt text is a versioned artifact rather
   * than a string built at a call site. Which tools the
   * runtime can actually *execute* is a different fact, and `work-server.ts` refuses
   * at bind time when the file offers one it does not know.
   *
   * At least one, because a turn offered no tool is a turn with no way to speak at
   * all — the shipped silence with a model bill attached.
   */
  tools: WorkToolDecl[];
}

/** One tool a turn is offered: the model's own view of what it may call. */
export interface WorkToolDecl {
  /** The name the model calls. `say` is the one the runtime executes today. */
  name: string;
  /** What the tool does, in the words the model reads. */
  description: string;
  /** JSON Schema for the arguments, as `tools[].function.parameters`. */
  parameters: Record<string, unknown>;
}

/** What a turn's parts are filled from: the bot, the room, and who said what. */
export interface WorkValues {
  /** The bot's display name. */
  bot: string;
  /** The bot's own words about itself, or the empty string when it has none. */
  description: string;
  /** What it does in this organization, or the empty string when nobody said. */
  position: string;
  /** How it talks and works, or the empty string. Free text, newlines included. */
  personality: string;
  /** What its card says it is, or the empty string — `''` is a stored answer. */
  gender: string;
  /** The room being addressed — the id the turn's `say` call has to name. */
  room: string;
  /** The bot's own agents, as facts rather than as prose (`identity.ts`). */
  roster: string;
  /**
   * The other bots in the room, named, or absent when this bot is alone in it.
   *
   * Absent rather than `''` for the reason `summary` is: the part that quotes them is
   * skipped without them, so a bot in a room by itself is never told about companions
   * it does not have. This is the line that makes a mention possible at all — a model
   * that does not know who is here cannot name anyone.
   */
  others?: string;
  /**
   * The note the bot wrote about this room last time, or the empty string.
   *
   * It is the box's first part (`box.ts`), and the reason a turn can carry a
   * conversation longer than its window: what has been compacted is not gone, it is
   * this line. Empty means nothing has been compacted — the part that quotes it then
   * leaves the prompt rather than quoting a blank.
   */
  summary: string;
  /**
   * Where this bot's uncompacted content is kept, as a place a model can be told.
   *
   * `docs/host-rulings.md`, "The observation box": what a note folds away is *"archived
   * by day"*, *"the location is told to the model"*, and the model *"may go and read
   * it"*. The directory and the days already in it are one value, because a place with
   * no list of days is a place a model can name and not read.
   */
  archive: string;
  /**
   * The index of the notes this bot wrote about rooms other than the one it is in now.
   *
   * The third of the three things `docs/host-rulings.md` hands a turn by default —
   * *"the latest compaction, the memory index and every observation after the latest
   * compaction"*. The compaction is `summary` and the observations are `entries`; this
   * is what was missing.
   *
   * **The note for the room being addressed is not in it.** That note is `summary`
   * above, and a bot woken in the room it is about would otherwise read the same
   * conclusion twice, which reads as emphasis rather than as one fact.
   *
   * Absent rather than `''` when there is nothing to index, for the reason `others` is:
   * a bot that has only ever worked in one room is not told about a list of notes it
   * does not have.
   */
  memories?: string;
  /**
   * How many bot messages in a row this room has had without the person — absent until
   * the room has been going long enough to be told.
   *
   * **A meeting ends by the clock, not by the topic running out.** Left alone, a room of
   * bots answers every point with another point and agrees on its three next steps three
   * times over: measured, a room of four with a real question produced twenty-five
   * messages and settled the same plan in the first ten. Nothing in the prompt said how
   * long they had been at it, because nothing told them. This is that fact and only that
   * fact — the count and what it means, no instruction beyond what the artifact says.
   */
  turns?: string;
  /**
   * The observations since that note, **oldest first**.
   *
   * Each carries when it landed, as the record timestamps it (`Observation.delivered_at`),
   * because `agent-lifecycle.md` line 201 says an observation carries "its room, who
   * spoke, **when** and what" and the half that answers was handed the other three. Two
   * messages a week apart arrived as two lines of the same shape, so a bot could not tell
   * a reply from an answer to something said seven days earlier — and `work-v5`'s own
   * parts ask it to say when it will know something works and when it looks again.
   *
   * The value is the stored stamp and never a phrase like "a week ago": that would need
   * a clock reading at assembly time, which is a separate question this artifact does
   * not answer (a `now` is not in the values, and the no-copy rule below is the same
   * rule — the record's own words rather than this module's).
   *
   * `picture` says the message carried one. A boolean rather than a sentence, because
   * the sentence is the artifact's `pictureLine`: this field reports the fact, the file
   * decides how to say it. Absent reads as no picture, which is what a caller that does
   * not report it — the calibration driver's rows — actually knows.
   */
  entries: { sender: string; text: string; at: string; picture?: boolean }[];
}

/**
 * The shipped turn artifact's location, beside this module.
 *
 * `work-v10.json` ships; `work-v1.json` through `work-v9.json` stay beside it. A prompt is
 * versioned rather than edited in place, because `calibration/work/` measured v1 and a
 * record that quotes a prompt the tree has changed describes a run nobody can re-read
 * — `work-calibration.test.ts` holds that pair together. What v2 added is the two parts
 * that quote a bot's card, both conditional: a bot whose card says nothing is asked the
 * v1 text byte for byte, which `prompts.test.ts` checks against v1 itself. What v3 adds
 * is the note the bot wrote about the room last time (`compact.ts`), conditional the
 * same way: a room with no note is asked the v2 text byte for byte, which the same test
 * checks against v2. What v5 adds is the arrival time on every entry line, in the shape
 * `watch-v3` already renders the same fact (`[{at}] {sender}: {text}`), so the half that
 * answers can tell a reply from an answer to something said last week. What v6 adds is
 * `pictureLine` and the `{picture}` site on that same entry line: a picture arrives at
 * the half that answers as words, and an entry with one stops being indistinguishable
 * from an entry with nothing in it. What v7 changes is that sentence alone, and it changes
 * because the fact under it changed: the turn now carries the box's pictures, so the line
 * says a picture is attached, and names the case where one is not — the same file, still
 * one `{picture}` site, still filled from the same fact (`entryOf`). What v8 adds is the
 * way back: `docs/host-rulings.md`, "The observation box" — the uncompacted content is
 * archived by day, its place is told to the model, and the model may go and read it. So
 * v8 has one new part saying where the archive is (`{archive}`, `archive.ts`) and one new
 * tool, `read(day)`, and no other part of the file moves.
 *
 * What v9 adds is the third thing `docs/host-rulings.md` hands a turn by default — *"the
 * latest compaction, the memory index and every observation after the latest
 * compaction"*. The compaction is v3's `{summary}` and the observations are v5's entry
 * lines; the index was the one of the three with no site. It is `{memories}`, one line
 * per note this bot wrote in a room other than the one it is being woken in — the note
 * for *this* room is the `{summary}` part above it, and a bot that has only ever worked
 * in one room is asked the v8 text byte for byte, which `prompts.test.ts` checks against
 * v8 itself. No other part of the file moves, and no tool is added: the index is a list
 * of what it already knows, not a second way to look something up.
 *
 * What v10 adds is two ways to look through the files the bot filed. v9 told a turn where
 * its archive is and gave it `read(day)` to open one; what it could not do was find a name
 * in it, or find which day a word was said on. `glob(pattern)` and `grep(pattern, path?)`
 * are both in the registry `docs/host-rulings.md`, "The tools" names — and both are bounded
 * to the agent's own home, which is the bound `read` already had, so neither is a new surface
 * a bot can reach the machine through. No part moves and neither existing tool changes: a
 * tool's description is prompt text, so the words about the two are in their own entries and
 * nowhere else.
 */
export function shippedWorkPromptPath(): URL {
  return new URL('./prompts/work-v10.json', import.meta.url);
}

/**
 * Read the turn artifact off disk and check it says what the runtime fills.
 *
 * Throws rather than falling back, exactly as `loadPromptArtifact` does: a runtime
 * that substituted a built-in prompt when the file was missing would be asking the
 * bot something nobody wrote down, under the version number of one that was.
 */
export function loadWorkArtifact(
  source: string | URL = shippedWorkPromptPath(),
): WorkArtifact {
  let raw: string;
  try {
    raw = readFileSync(source, 'utf8');
  } catch (error) {
    throw new Error(
      `the turn prompt artifact could not be read from ${String(source)}: ` +
        `${(error as Error).message} — the prompt is a file, and a turn with no ` +
        'artifact has nothing it is allowed to be asked',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `the turn prompt artifact at ${String(source)} is not JSON: ${(error as Error).message}`,
    );
  }
  return assertWorkArtifact(parsed, String(source));
}

/**
 * The turn's two halves, in the file's own order.
 *
 * Two strings rather than one, because a chat model takes messages and not a flat
 * prompt: the system block is what the template puts behind the system role, and
 * the rest is one user turn. The boundary is `system + afterSystem` — the artifact
 * says where it is, so no caller has to guess it (`llama.ts`, the watch path's
 * header, makes the same point about the same measurement).
 *
 * One pass over the templates, as in `assemblePrompt`: a room message that happens
 * to contain `{room}` is not a substitution site, and a participant must not be able
 * to write the front of the prompt they are quoted in.
 */
export function assembleWorkPrompt(
  artifact: WorkArtifact,
  values: WorkValues,
): { version: string; system: string; rest: string } {
  // Every fact the artifact's vocabulary permits, so a part and its substitution site
  // cannot disagree: a `when` the validator accepts and a `{name}` the assembly does
  // not fill would render the placeholder to the model whole, which is a sentence
  // naming a field rather than a sentence about the bot. Which of them a prompt
  // actually quotes is the artifact's decision — v2 quotes three of the card's four
  // fields and never the gender.
  const facts = {
    bot: values.bot,
    description: values.description,
    position: values.position,
    personality: values.personality,
    gender: values.gender,
    room: values.room,
    roster: values.roster,
    summary: values.summary,
    archive: values.archive,
    memories: values.memories ?? '',
    others: values.others ?? '',
    turns: values.turns ?? '',
  };

  // `afterSystem` opens the user turn rather than closing the system block: it is
  // where the file says the split is, and a split taken anywhere else would hand the
  // model a first message the artifact does not describe — the same boundary `llama.ts`
  // measures for the watch path.
  const out: string[] = [artifact.afterSystem];
  for (const part of artifact.parts) {
    // `!values[part.when]` rather than a comparison with the empty string: the
    // calibration driver is plain `.mjs` and hands over only the facts its rows have,
    // so a missing fact must read as absent. `fill` leaves an unknown placeholder
    // whole, and a part rendered with `{position}` in it tells the model about a
    // field by name.
    if (part.when !== 'always' && !values[part.when]) continue;
    if (part.each === 'entry') {
      for (const entry of values.entries) {
        out.push(
          fill(part.text, {
            ...facts,
            sender: entry.sender,
            text: entry.text,
            at: entry.at,
            // Always filled, with `''` for the entries that carry no picture: `fill`
            // leaves an unknown placeholder whole, so a site left out would print
            // `{picture}` at a model rather than say nothing.
            picture: entry.picture === true ? (artifact.pictureLine ?? '') : '',
          }),
          part.after,
        );
      }
      continue;
    }
    out.push(fill(part.text, facts), part.after);
  }

  return {
    version: artifact.version,
    system: fill(artifact.system, facts),
    rest: out.join(''),
  };
}

/** The placeholders a turn prompt may name, and what each one may appear on. */
const WORK_FACTS = [
  'bot',
  'description',
  'gender',
  'personality',
  'position',
  'room',
  'roster',
  'summary',
  'archive',
  'memories',
  'others',
  'turns',
] as const;

/** The four a bot may simply not have, in the order an error message lists them. */
const OPTIONAL_FACTS: readonly OptionalFact[] = [
  'description',
  'gender',
  'personality',
  'position',
];

/** True for a placeholder name that is one of the card's optional facts. */
function isOptionalFact(name: unknown): name is OptionalFact {
  return (OPTIONAL_FACTS as readonly unknown[]).includes(name);
}

/**
 * True for a placeholder the prompt may have to leave out: the card's four; the room's
 * note, since a room nothing has been compacted in has no note; the notes it wrote about
 * other rooms, since a bot that has worked in one room has none; the company it keeps in
 * this room; and how long the room has been going. Quoting a blank after a colon is the
 * same defect as quoting an empty position.
 */
function isSkippable(name: unknown): boolean {
  return (
    name === 'summary' ||
    name === 'memories' ||
    name === 'others' ||
    name === 'turns' ||
    isOptionalFact(name)
  );
}

/**
 * What the runtime needs a turn artifact to say.
 *
 * Every check here answers a way the file could ask something nobody fills: a
 * `{sender}` on a part that does not repeat has no sender to name, `{text}` outside
 * a per-entry part has no message to quote, `{at}` outside one has no arrival to
 * date, and a placeholder no one here fills is
 * rendered literally into the prompt, where it reads as part of the instruction.
 * `{description}` is the conditional case and gets the same treatment the watch
 * artifact gives `{summary}`: a part that names it must be skipped when there is
 * none, or the bot is told about a description it does not have.
 */
function assertWorkArtifact(value: unknown, source: string): WorkArtifact {
  const fail = (detail: string): never => {
    throw new Error(`${source} is not a turn prompt artifact: ${detail}`);
  };
  if (typeof value !== 'object' || value === null) return fail('it is not an object');
  const artifact = value as Partial<WorkArtifact>;

  if (typeof artifact.version !== 'string' || artifact.version.trim().length === 0) {
    return fail('`version` must be a non-empty string');
  }
  if (typeof artifact.system !== 'string' || artifact.system.trim().length === 0) {
    return fail('`system` must be a non-empty string');
  }
  if (typeof artifact.afterSystem !== 'string') {
    return fail('`afterSystem` must be a string (use "" to join the system block directly)');
  }
  if (
    artifact.pictureLine !== undefined &&
    (typeof artifact.pictureLine !== 'string' || artifact.pictureLine.trim() === '')
  ) {
    return fail('`pictureLine` must be a non-empty string when present, or be left out');
  }
  if (!Array.isArray(artifact.parts) || artifact.parts.length === 0) {
    return fail('`parts` must be a non-empty array');
  }

  // The system block may name the bot and its own description, and nothing that
  // belongs to a turn: a system line that quoted a message would be the same text
  // for every room, which is the header also refuses to let a room write.
  for (const name of placeholdersIn(artifact.system)) {
    if (name !== 'bot' && name !== 'description') {
      return fail(
        `\`system\` names {{${name}}}, which belongs to a turn rather than to the bot — ` +
          'the system line is the same text in every room',
      );
    }
  }

  const parts: WorkPart[] = [];
  for (const [index, part] of artifact.parts.entries()) {
    const where = `parts[${index}]`;
    if (typeof part !== 'object' || part === null) return fail(`${where} is not an object`);
    const row = part as Partial<WorkPart>;
    if (typeof row.name !== 'string' || row.name.trim().length === 0) {
      return fail(`${where}.name must be a non-empty string`);
    }
    if (typeof row.text !== 'string' || row.text.length === 0) {
      return fail(`${where}.text must be a non-empty string`);
    }
    if (typeof row.after !== 'string') return fail(`${where}.after must be a string`);
    if (row.when !== 'always' && !isSkippable(row.when)) {
      return fail(
        `${where}.when must be "always", "summary", or one of ${OPTIONAL_FACTS.join(', ')}, ` +
          `got ${JSON.stringify(row.when)}`,
      );
    }
    if (row.each !== undefined && row.each !== 'entry') {
      return fail(`${where}.each must be "entry" when present`);
    }
    if (row.each === 'entry' && row.when !== 'always') {
      return fail(
        `${where} cannot both repeat per entry and depend on a fact the bot may not have`,
      );
    }

    // Both halves of one rule. A part that quotes a fact the bot may not have and is
    // rendered anyway leaves a blank in the middle of a sentence; a part that says it
    // depends on a fact and never quotes it leaves the prompt for a reason nothing in
    // its own text explains.
    const dependsOn = placeholdersIn(row.text).filter(isSkippable);
    for (const name of dependsOn) {
      if (row.when !== name) {
        const who = name === 'summary' ? 'the room has none' : 'the bot has none';
        return fail(`${where} fills {${name}} but is rendered when ${who}`);
      }
    }
    if (isSkippable(row.when) && !dependsOn.includes(row.when)) {
      return fail(
        `${where} is skipped without a ${row.when} and does not quote one, so nothing ` +
          'it says depends on it',
      );
    }

    for (const name of placeholdersIn(row.text)) {
      if (name === 'sender' || name === 'text' || name === 'at' || name === 'picture') {
        if (row.each !== 'entry') {
          return fail(
            `${where} fills {${name}} without \`each: "entry"\`, so it has nothing to fill from`,
          );
        }
        // A per-entry fact with no word for it in the file is a site the assembly can
        // only fill with `''`: the entry would say nothing at all about the picture,
        // and nothing would fail. The word lives in `pictureLine` or nowhere.
        if (name === 'picture' && artifact.pictureLine === undefined) {
          return fail(
            `${where} fills {picture}, and this artifact declares no \`pictureLine\` to put ` +
              "there: the word for a picture is the file's to say",
          );
        }
        continue;
      }
      if (!(WORK_FACTS as readonly string[]).includes(name)) {
        return fail(`${where} names {${name}}, which nothing here fills`);
      }
    }

    const normalised: WorkPart = {
      name: row.name,
      text: row.text,
      after: row.after,
      when: row.when,
    };
    if (row.each) normalised.each = row.each;
    parts.push(normalised);
  }

  // The other half of the rule above: a picture line no part quotes is a sentence the
  // file wrote for a model that never reads it — the defect v6 exists to remove, put
  // back where nothing else would notice it.
  if (
    artifact.pictureLine !== undefined &&
    !parts.some((part) => placeholdersIn(part.text).includes('picture'))
  ) {
    return fail('the artifact declares `pictureLine` and no part says {picture} to put it in');
  }

  // A per-entry part with nothing after it would glue one message onto the next,
  // and the last entry onto whatever part follows — the text would still be a
  // prompt, and the model would still answer, so nothing else here would notice.
  const last = parts[parts.length - 1];
  if (last.each === 'entry') {
    return fail(
      `the last part (${JSON.stringify(last.name)}) repeats per entry, so the last ` +
        'message would run into the end of the prompt — end with a part that follows them',
    );
  }

  // A tool the file offers and the runtime cannot show is a tool the model will never
  // call; a tool with no name is one whose call could not be matched to anything.
  if (!Array.isArray(artifact.tools) || artifact.tools.length === 0) {
    return fail('`tools` must be a non-empty array: a turn offered no tool has no way to speak');
  }
  const tools: WorkToolDecl[] = [];
  const seen = new Set<string>();
  for (const [index, tool] of artifact.tools.entries()) {
    const where = `tools[${index}]`;
    if (typeof tool !== 'object' || tool === null) return fail(`${where} is not an object`);
    const row = tool as Partial<WorkToolDecl>;
    if (typeof row.name !== 'string' || row.name.trim() === '') {
      return fail(`${where}.name must be a non-empty string`);
    }
    if (seen.has(row.name)) return fail(`two tools are named ${JSON.stringify(row.name)}`);
    seen.add(row.name);
    if (typeof row.description !== 'string' || row.description.trim() === '') {
      return fail(`${where}.description must be a non-empty string: it is what the model reads`);
    }
    if (
      typeof row.parameters !== 'object' ||
      row.parameters === null ||
      Array.isArray(row.parameters)
    ) {
      return fail(`${where}.parameters must be a JSON Schema object`);
    }
    tools.push({ name: row.name, description: row.description, parameters: row.parameters });
  }

  return {
    version: artifact.version,
    system: artifact.system,
    afterSystem: artifact.afterSystem,
    ...(artifact.pictureLine === undefined ? {} : { pictureLine: artifact.pictureLine }),
    parts,
    tools,
  };
}

/** Every `{name}` a template names, in order. */
function placeholdersIn(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
}

/**
 * One versioned note prompt: what the work agent is asked when a room's delta has
 * outgrown itself (`compact.ts`, `RoomCompactor`).
 *
 * A second artifact rather than a variant of `work-v2`, because it answers a different
 * question. A turn's prompt tells the model that the only way into a room is a `say`
 * call and offers it the tool; the note is written for nobody in the room to read, it
 * offers no tool, and what it produces is a `Memory` row rather than a message. Folded
 * together, either one would have to say "except when" about the other's first line.
 */
export interface CompactArtifact {
  /** The identity this file is. `compact-v2` is the shipped one. */
  version: string;
  /** The head of the text, before the rest. Filled with `{bot}`. */
  system: string;
  /** `Room: {room}` — which conversation the note is about. */
  roomLine: string;
  /** What stands over the note written last time, when there is one. */
  previousLine: string;
  /** What stands over this delta, when there is one. */
  transcriptLine: string;
  /**
   * One observation, as `{at}`, `{sender}`, `{text}` and `{picture}`.
   *
   * The same four facts the turn's own entry line carries, for the same reasons: a note
   * that cannot tell a reply from an answer to something said a week earlier hands the
   * later self a room with no time in it, and an entry with a picture in it reads as an
   * empty message when the picture has no word of its own.
   */
  entryLine: string;
  /**
   * What the note says about a message that came with a picture it cannot see.
   *
   * Present only in an artifact whose entry line quotes `{picture}`, and the two are
   * checked together: a site with no sentence to fill it would say nothing at all.
   */
  pictureLine?: string;
  /** What the model is asked to do, after the observations. */
  ask: string;
}

/** What a note is written from: who writes it, about which room, from what. */
export interface CompactValues {
  /** The bot's display name. */
  bot: string;
  /** The room's name, or its id when nobody named it. */
  room: string;
  /** The note this one replaces, when the room already has one. */
  previous?: string;
  /**
   * The observations being folded in, **oldest first**.
   *
   * The same four facts the turn's entries carry — `entryOf` in `work-server.ts` hands
   * the same value to both halves, so the note is never written from less than the turn
   * was shown. `at` is the entry's own `delivered_at` and `picture` reports that the
   * message came with one; how either is said is the artifact's business.
   */
  entries: { sender: string; text: string; at: string; picture: boolean }[];
}

/**
 * The shipped note artifact's location, beside this module.
 *
 * `compact-v2.json` ships; `compact-v1.json` stays beside it. A prompt is versioned
 * rather than edited in place, for `shippedWorkPromptPath`'s reason: a note written by
 * v1 and a note written by v2 are different notes, and a record that quotes one is not
 * a description of the other. What v2 adds is the arrival time on every entry line and
 * the `{picture}` site with its `pictureLine` — the same two facts `work-v5` and
 * `work-v6` gave the half that answers, given to the half that writes the note the
 * answer is later read from. **This file still describes a picture it cannot see, and
 * that is still true of it**: nothing supplies the note's writer with bytes, so `work-v7`'s
 * sentence would be a claim this path cannot keep.
 */
export function shippedCompactPromptPath(): URL {
  return new URL('./prompts/compact-v2.json', import.meta.url);
}

/**
 * Read the note artifact off disk.
 *
 * Throws rather than falling back, for `loadWorkArtifact`'s reason: a built-in prompt
 * substituted behind a missing file is a question nobody wrote down, asked under the
 * version number of one that was. The caller is `compact.ts`, which turns a throw into
 * "this compaction did not run" and backs off rather than retrying every tick — so a
 * malformed file costs a room its notes, never its replies.
 */
export function loadCompactArtifact(
  source: string | URL = shippedCompactPromptPath(),
): CompactArtifact {
  let raw: string;
  try {
    raw = readFileSync(source, 'utf8');
  } catch (error) {
    throw new Error(
      `the note prompt artifact could not be read from ${String(source)}: ` +
        `${(error as Error).message} — the prompt is a file, and a note written without ` +
        'one is a note nobody asked for',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `the note prompt artifact at ${String(source)} is not JSON: ${(error as Error).message}`,
    );
  }
  const file = parsed as Partial<CompactArtifact>;
  const strings: (keyof CompactArtifact)[] = [
    'version',
    'system',
    'roomLine',
    'previousLine',
    'transcriptLine',
    'entryLine',
    'ask',
  ];
  for (const name of strings) {
    const value = file[name];
    if (typeof value !== 'string' || value === '') {
      throw new Error(
        `the note prompt artifact at ${String(source)} has no ${name}: every field here is ` +
          'a line the note is assembled from, and a missing one is a sentence the model ' +
          'never reads',
      );
    }
  }
  const pictureLine = file.pictureLine;
  if (
    pictureLine !== undefined &&
    (typeof pictureLine !== 'string' || pictureLine.trim() === '')
  ) {
    throw new Error(
      `the note prompt artifact at ${String(source)} has a \`pictureLine\` that is not a ` +
        'non-empty string: leave it out when the entry line has no {picture} to fill',
    );
  }

  // The entry line may quote the four per-entry facts and nothing else — a name nothing
  // fills would reach the model as `{thatword}`, which is how a prompt starts describing
  // its own plumbing instead of the room.
  const entrySites = placeholdersIn(file.entryLine as string);
  for (const name of entrySites) {
    if (name !== 'sender' && name !== 'text' && name !== 'at' && name !== 'picture') {
      throw new Error(
        `the note prompt artifact at ${String(source)} names {${name}} on its entry line, ` +
          'which nothing here fills',
      );
    }
  }

  // Both halves of one rule, as `assertWorkArtifact` holds them on a turn prompt: a
  // `{picture}` site with no sentence in the file can only be filled with `''`, so a
  // wordless picture would arrive at the note as an empty message again; and a sentence
  // no site quotes is one the file wrote for a model that never reads it.
  if (entrySites.includes('picture') && pictureLine === undefined) {
    throw new Error(
      `the note prompt artifact at ${String(source)} fills {picture} and declares no ` +
        "`pictureLine`: the word for a picture is the file's to say",
    );
  }
  if (pictureLine !== undefined && !entrySites.includes('picture')) {
    throw new Error(
      `the note prompt artifact at ${String(source)} declares \`pictureLine\` and its entry ` +
        'line says no {picture} to put it in',
    );
  }

  return {
    version: file.version as string,
    system: file.system as string,
    roomLine: file.roomLine as string,
    previousLine: file.previousLine as string,
    transcriptLine: file.transcriptLine as string,
    entryLine: file.entryLine as string,
    ...(pictureLine === undefined ? {} : { pictureLine }),
    ask: file.ask as string,
  };
}

/**
 * The note's two halves, in the file's own order.
 *
 * Two strings rather than one, because a chat model takes messages: the system block
 * describes who is writing, and the rest is one user turn holding the room, the old
 * note, this delta and the ask. One pass over the templates, as everywhere else —
 * a message that happens to contain `{room}` is not a substitution site.
 *
 * The old note is left out entire when the room has none, header included: a header
 * standing over nothing reads as a note that was written and came back empty.
 */
export function assembleCompactPrompt(
  artifact: CompactArtifact,
  values: CompactValues,
): { version: string; system: string; rest: string } {
  const out: string[] = [
    fill(artifact.roomLine, { room: values.room }),
    '\n\n',
  ];
  if (values.previous !== undefined && values.previous !== '') {
    out.push(artifact.previousLine, '\n', values.previous, '\n\n');
  }
  out.push(artifact.transcriptLine, '\n');
  for (const entry of values.entries) {
    out.push(
      fill(artifact.entryLine, {
        at: entry.at,
        sender: entry.sender,
        text: entry.text,
        // The fact is `entry.picture`; the sentence is the file's. An entry with no
        // picture fills nothing at all, so its line is byte for byte what v1 wrote.
        picture: entry.picture === true ? (artifact.pictureLine ?? '') : '',
      }),
      '\n',
    );
  }
  out.push('\n', artifact.ask);
  return {
    version: artifact.version,
    system: fill(artifact.system, { bot: values.bot }),
    rest: out.join(''),
  };
}
