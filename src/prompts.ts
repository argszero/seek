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
 * trailing space in `watch-v1.json`'s question: it is the boundary the option token
 * is appended at, not decoration. A prompt that ends mid-word lets a tokeniser
 * merge the option into the last token of the prompt, and then no id at the
 * prompt's own end is the option's (`watch.ts`, `bindOptions`).
 */

import { readFileSync } from 'node:fs';

/** A part's condition: always rendered, or only once the room has a summary. */
export type PartCondition = 'always' | 'summary';

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
  /** What follows the system block — `"\n\n"` in `watch-v1`. */
  afterSystem: string;
  /** The parts, in the order they are rendered. */
  parts: PromptPart[];
  /** The cut this version was calibrated at. Absent means no declared default. */
  operatingPoint?: DeclaredOperatingPoint;
}

/** What a part is filled from: the room's summary, and each delta entry's text. */
export interface PromptValues {
  /** The compaction's result, when the room has one. */
  summary?: string;
  /** The entries to render, **oldest first**. */
  texts: string[];
}

/** The shipped artifact's location, beside this module. */
export function shippedPromptPath(): URL {
  return new URL('./prompts/watch-v1.json', import.meta.url);
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
  const out: string[] = [artifact.system, artifact.afterSystem];
  for (const part of artifact.parts) {
    if (part.when === 'summary' && values.summary === undefined) continue;
    if (part.each === 'observation') {
      for (const text of values.texts) out.push(fill(part.text, { text }), part.after);
      continue;
    }
    out.push(fill(part.text, { summary: values.summary ?? '' }), part.after);
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
export function skeletonOf(artifact: PromptArtifact): { version: string; text: string } {
  return { version: artifact.version, text: assemblePrompt(artifact, { texts: [] }) };
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
    if (row.when !== 'always' && row.when !== 'summary') {
      return fail(`${where}.when must be "always" or "summary", got ${JSON.stringify(row.when)}`);
    }
    if (row.each !== undefined && row.each !== 'observation') {
      return fail(`${where}.each must be "observation" when present`);
    }

    const placeholders = [...row.text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
    for (const name of placeholders) {
      if (name === 'summary' && row.when !== 'summary') {
        return fail(`${where} fills {summary} but is rendered when there is no summary`);
      }
      if (name === 'text' && row.each !== 'observation') {
        return fail(`${where} fills {text} without \`each: "observation"\`, so it has nothing to fill from`);
      }
      if (name !== 'summary' && name !== 'text') {
        return fail(`${where} names {{{${name}}}}, which nothing here fills`);
      }
    }
    if (row.each === 'observation' && row.when === 'summary') {
      return fail(`${where} cannot be both per-observation and conditional on a summary`);
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

  // The end is where the answer is read, so it may not depend on the room: a part
  // that repeats per observation must be followed by one that never goes missing.
  const last = parts[parts.length - 1];
  if (last.each === 'observation') {
    return fail(
      `the last part (${JSON.stringify(last.name)}) repeats per observation, so the text ` +
        'would end wherever the last message ended and the mask ids would move with it — ' +
        'end the assembly with a part that is always present',
    );
  }
  if (last.when !== 'always') {
    return fail(
      `the last part (${JSON.stringify(last.name)}) is conditional, so a room without a ` +
        'summary would end the text somewhere else and the mask ids would move — ' +
        'the assembly must end with an unconditional part',
    );
  }

  const artifactOut: PromptArtifact = {
    version: artifact.version,
    system: artifact.system,
    afterSystem: artifact.afterSystem,
    parts,
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
  /** Its template, with `{bot}`, `{room}`, `{roster}`, `{sender}` or `{text}`. */
  text: string;
  /** What follows the part, verbatim. */
  after: string;
  /**
   * `always`, or the one optional fact this part is skipped without.
   *
   * A bot may have nothing on its card but its name, so a part that quotes a field
   * a person may have left empty has to name that field: the part then leaves the
   * prompt with the fact instead of asking a model about a blank.
   */
  when: 'always' | OptionalFact;
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
  /** The entries the turn was woken for, **oldest first**. */
  entries: { sender: string; text: string }[];
}

/**
 * The shipped turn artifact's location, beside this module.
 *
 * `work-v2.json` ships and `work-v1.json` stays beside it. A prompt is versioned
 * rather than edited in place, because `calibration/work/` measured v1 and a record
 * that quotes a prompt the tree has changed describes a run nobody can re-read —
 * `work-calibration.test.ts` holds that pair together. What v2 adds is the two parts
 * that quote a bot's card, and both are conditional: a bot whose card says nothing is
 * asked the v1 text byte for byte, which `prompts.test.ts` checks against v1 itself.
 */
export function shippedWorkPromptPath(): URL {
  return new URL('./prompts/work-v2.json', import.meta.url);
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
        out.push(fill(part.text, { ...facts, sender: entry.sender, text: entry.text }), part.after);
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
 * What the runtime needs a turn artifact to say.
 *
 * Every check here answers a way the file could ask something nobody fills: a
 * `{sender}` on a part that does not repeat has no sender to name, `{text}` outside
 * a per-entry part has no message to quote, and a placeholder no one here fills is
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
  if (!Array.isArray(artifact.parts) || artifact.parts.length === 0) {
    return fail('`parts` must be a non-empty array');
  }

  // The system block may name the bot and its own description, and nothing that
  // belongs to a turn: a system line that quoted a message would be the same text
  // for every room, which is the header `watch-v1` also refuses to let a room write.
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
    if (row.when !== 'always' && !isOptionalFact(row.when)) {
      return fail(
        `${where}.when must be "always" or one of ${OPTIONAL_FACTS.join(', ')}, ` +
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
    const dependsOn = placeholdersIn(row.text).filter(isOptionalFact);
    for (const name of dependsOn) {
      if (row.when !== name) {
        return fail(`${where} fills {${name}} but is rendered when the bot has none`);
      }
    }
    if (isOptionalFact(row.when) && !dependsOn.includes(row.when)) {
      return fail(
        `${where} is skipped without a ${row.when} and does not quote one, so nothing ` +
          'it says depends on it',
      );
    }

    for (const name of placeholdersIn(row.text)) {
      if (name === 'sender' || name === 'text') {
        if (row.each !== 'entry') {
          return fail(
            `${where} fills {${name}} without \`each: "entry"\`, so it has nothing to fill from`,
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
    parts,
    tools,
  };
}

/** Every `{name}` a template names, in order. */
function placeholdersIn(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
}
