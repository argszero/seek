/**
 * The watch prompt, as a versioned artifact on disk rather than a string built at
 * a call site (src/README.md line 27, `docs/decisions.md` §"the question put to
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
