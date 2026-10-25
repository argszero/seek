/**
 * The watch model, reached over a local llama.cpp server.
 *
 * `watch.ts` declares `WatchModel` and says what it is for; `src/README.md` line 25
 * says which model ships, and that is a measurement. What sat between them was
 * nothing: the only implementation in the tree was the tests' stub, so the kernel's
 * most load-bearing decision had no execution behind it and `npm start` printed a
 * line about that. This file is the first real one.
 *
 * **Why a server and not a subprocess.** §4's resident context is not a nicety: a 3B
 * re-reading a full box costs about a millisecond a token, so a judgement has to pay
 * only for what arrived. That economy lives in the model's own KV cache, and a
 * process per judgement throws the cache away with the process. A server keeps it,
 * and `cache_prompt` is what tells it to reuse the shared front. The measurement
 * agrees: 24 text cases cost **109 ms** each through the server against **186 ms**
 * through the one-shot CLI rig, on the same model and the same machine.
 *
 * **What this file does not decide.** It does not start a server, download a model,
 * choose a quantisation, or name a path: those are packaging, and line 25 keeps the
 * choice of model measured rather than assumed. It takes a `baseUrl` and speaks the
 * three endpoints that shape was measured through.
 *
 * **It shows the model the picture, because the route was measured before it was
 * used.** The box carries its pictures in the delta (`BoxMedia`), and until this file
 * noticed them nothing read that field: a screenshot was judged from its caption and
 * the verdict looked exactly like one reached with the picture in front of the model.
 * `/completion` takes no projector, so the image figures had been taken on the
 * one-shot `llama-mtmd-cli` rig and were never replayed over HTTP — and an unmeasured
 * route is not a route this transport may quietly use. They have been replayed:
 * all **56** image cases were read through `/v1/chat/completions` to within
 * **0.0011** per case of the recorded rig, keeping the shipped cut's figures exactly
 * (41/56 at 0.600, `act` 13/28, `ignore` 28/28 — `remeasured.json`'s own numbers),
 * which is the condition `docs/decisions.md` row 22 set and row 23 records.
 *
 * **The picture's place is the measured one, and it is not "wherever".** It travels
 * between the box's text and the artifact's last part, because that is where the
 * replay put it: `calibration/vision/server-transport-images.json` records the shape
 * as the message text, then the image, then the question, rendered by the same
 * template. A picture anywhere else is a different prompt with the same question on
 * the end, and nothing in the tree measured what that reads.
 *
 * **The estimator is the calibration's, not a convenient one.** The shipped cut was
 * measured as the full next-token distribution summed over *every* token whose
 * decoded form strips to the option — `calibration/provenance.md`, and now
 * `docs/decisions.md` row 19. So the same case read the other way — one masked id —
 * would not be a different implementation of this cut, it would be a different cut.
 * The reading below is therefore the summed one, and `readingOf` is where that is
 * enforced rather than remembered.
 *
 * **The prompt shape is the measured one.** The assembled text begins with the
 * artifact's system line; the measurement sent that line as a chat *system* message
 * and the rest as a *user* turn, because a chat model fed one flat string scores
 * below chance (AUC 0.469, `act` 0/12 — `calibration/vision/remeasured.json`). So
 * this file splits at exactly that boundary and refuses a text that does not start
 * with it, rather than sending the assembly whole and reading a number from a
 * distribution nobody measured.
 *
 * **Equivalence, measured rather than argued.** All 24 text cases were replayed
 * through this transport and compared case by case with the CLI rig's recorded
 * reading (`calibration/vision/server-transport.json`): AUC **1.000**, 20/24 at the
 * shipped 0.600, `act` 8/12, `ignore` 12/12 — the recorded set exactly — with a
 * per-case difference of at most **0.0008**. The transport is a second reader of the
 * same quantity, which is what lets it keep the cut.
 */

import { Buffer } from 'node:buffer';

import type { BoxMedia } from './box.ts';
import type { PromptArtifact } from './prompts.ts';
import type { TokenUsage } from './types.ts';
import type {
  BoundOption,
  OptionBinding,
  OptionTokens,
  WatchInput,
  WatchModel,
  WatchPrompt,
  WatchReading,
} from './watch.ts';

/**
 * What this module needs from `fetch`: one request, and the text it answered.
 *
 * Structural rather than `typeof fetch`, so the seam is one method wide and a test
 * can stand a recorder in it without a DOM type in sight. `body` is optional because
 * `/props` is read with a GET, and a real `fetch` refuses a GET that carries a body
 * — even an empty one.
 */
export type Fetcher = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Where the model is, and which prompt's shape the assembly is being read in. */
export interface LlamaServer {
  /** Origin of a running `llama-server`, e.g. `http://127.0.0.1:8080`. */
  baseUrl: string;
  /**
   * The artifact the assembled text belongs to.
   *
   * Required, and not because the runtime wants the question again: the text handed
   * to `read` is the *whole* assembly, and the measured shape is that its first
   * part travels as a system message while the rest travels as a user turn. That
   * boundary is `system + afterSystem`, so the artifact is what says where it is —
   * the one thing a caller could otherwise guess at and get silently wrong.
   */
  artifact: PromptArtifact;
  /**
   * How many candidates of the next-token distribution to ask for.
   *
   * 64 by default, and the number matters only for the tail: the estimator sums
   * every token that spells the option, so a truncated distribution under-reports
   * it. At 64 the omitted mass is far below any cut in the measured plateaus, and
   * the replay above read the recorded value to within 0.0008 at this depth.
   */
  nProbs?: number;
  /**
   * The bytes behind a box picture, when the box carries one.
   *
   * `box.ts` keeps a picture's `key` opaque on purpose — *"how a client names a file
   * is its business"* — so this transport cannot resolve one, and must not guess a
   * path: a store's own layout is not something a chat template's reader knows. The
   * caller loads, this file encodes and sends.
   *
   * Optional, and its absence is a refusal rather than a silent text-only reading: a
   * box that carries a picture and a transport that cannot read its bytes used to
   * produce a verdict from the caption alone, which is the defect row 22 was written
   * for, one layer down.
   */
  loadMedia?: (media: BoxMedia) => Promise<Uint8Array>;
  /** What to call instead of `globalThis.fetch`. A test's recorder. */
  fetch?: Fetcher;
}

/** The default candidate depth. See `LlamaServer.nProbs`. */
export const DEFAULT_N_PROBS = 64;

/** A candidate token, as the server reports it. */
interface Candidate {
  token?: unknown;
  logprob?: unknown;
}

/**
 * The calibration's token rule: lowercase, keep letters and digits anywhere.
 *
 * Not "trim the ends" and not "the one token id the mask allows". The measured
 * quantity is the probability of *spelling* the option — `Act`, ` act` and `act`
 * are three ids and one answer, and the recorded numbers sum all of them
 * (`tmp/vision/scorer.cpp`'s `strip_punct`, kept here because the cut was taken
 * with it).
 */
export function strip(token: string): string {
  return token.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The watch model, as one forward pass over a local server.
 *
 * No generated text and no tool calls: this is the half of the bot that cannot
 * write (§4), and it answers by reading probabilities at the prompt's own end.
 * `reason` is therefore never set — a decision model produces no sentence, and a
 * sentence invented here would read exactly like evidence.
 */
export function llamaWatchModel(server: LlamaServer): WatchModel {
  const artifact = server.artifact;
  // Asked once per server: whether a projector is loaded is a fact about the process,
  // not about the judgement, and a room sent a screenshot a minute should not cost a
  // `/props` a minute.
  const canSee = visionProbe(server);
  return {
    async read(input: WatchInput): Promise<WatchReading> {
      const media = input.state?.media ?? [];
      const candidates =
        media.length === 0
          ? await completion(
              server,
              await applyTemplate(server, userTurn(artifact, input.prompt.text)),
            )
          : await readWithPictures(server, input, media, canSee);
      // No `reason`: see above. What the kernel does with an absent one is its
      // business (`watch.ts`, `reasonOf`).
      return { probabilities: readingOf(candidates, input.options) };
    },
  };
}

/**
 * One judgement with a picture in the box, read through the endpoint that takes one.
 *
 * Three things have to be true before a byte is sent, and each is asked rather than
 * assumed — the same discipline as `requireServerShape`, for the same reason: the
 * failure mode here is not an error, it is a number that looks like a verdict.
 *
 * 1. **The caller can produce the bytes.** `box.ts` keeps `key` opaque, so this file
 *    has no way to resolve one and will not invent a path. A box with a picture and
 *    no `loadMedia` is refused, because the alternative is the very thing row 22 was
 *    written for: `act` or `ignore` read off a caption while the reading looks like
 *    one the model reached with the picture in front of it.
 * 2. **The server has a projector.** `/props` `modalities.vision` is the server's own
 *    statement that an image part will be encoded rather than skipped, and a server
 *    started without `--mmproj` reports `false` (or reports nothing at all, which is
 *    read the same safe way round — `visionOf`). Sending anyway would be a data URL
 *    into a hole.
 * 3. **Exactly one picture.** The replay measured one per box, which is what every
 *    set in `calibration/vision/` holds. Where a second picture sits relative to the
 *    first was never replayed, and the placement is load-bearing (§ the header), so a
 *    second one is refused instead of guessed at.
 *
 * The route is `/v1/chat/completions` and not `/completion`: only the chat endpoint
 * takes content parts, and only it reaches the projector. That the two agree was
 * measured rather than hoped — for text they read the same distribution to
 * **0.0000**, and the image replay reproduced the rig through the chat endpoint.
 */
async function readWithPictures(
  server: LlamaServer,
  input: WatchInput,
  media: BoxMedia[],
  canSee: () => Promise<boolean>,
): Promise<Candidate[]> {
  const picture = onePicture(media);
  const load = server.loadMedia;
  if (load === undefined) {
    throw new Error(
      `this judgement's box carries a picture (${JSON.stringify(picture.mime)} at ` +
        `${JSON.stringify(picture.key)}) and this transport was given no way to read its ` +
        'bytes: box.ts keeps a picture key opaque, so the caller supplies a loader ' +
        '(LlamaServer.loadMedia) rather than have a file path guessed here. Judging the ' +
        'text alone would answer from the caption while looking like a verdict reached ' +
        'with the picture in front of the model (docs/decisions.md row 23)',
    );
  }
  if (!(await canSee())) {
    throw new Error(
      `this judgement's box carries a picture (${JSON.stringify(picture.mime)} at ` +
        `${JSON.stringify(picture.key)}) and this server reports no projector: /props ` +
        'modalities.vision is not true, so the image would be dropped on the way in and ' +
        'the reading would come from the caption alone. Start the server with an mmproj ' +
        '(`--mmproj`) so it can see (docs/decisions.md row 23)',
    );
  }
  const user = userTurn(server.artifact, input.prompt.text);
  const { front, question } = splitAtQuestion(server.artifact, user);
  const bytes = await load(picture);
  const parts: unknown[] = [];
  // The measured shape is text, picture, question. The leading text is omitted only
  // when the artifact leaves nothing before its last part, which the shipped one never
  // does — an empty part is not a shape anything was measured in.
  if (front.length > 0) parts.push({ type: 'text', text: front });
  parts.push({ type: 'image_url', image_url: { url: dataUriOf(picture, bytes) } });
  parts.push({ type: 'text', text: question });
  return chatCompletion(server, parts);
}

/**
 * The box's one picture, or a refusal naming what was not measured.
 *
 * `media.length === 0` never reaches here: the caller took the text path. So this is
 * the "two or more" case, and it says why rather than sending the first and dropping
 * the rest — a dropped picture is the same defect as a dropped box.
 */
function onePicture(media: BoxMedia[]): BoxMedia {
  if (media.length === 1) return media[0] as BoxMedia;
  throw new Error(
    `this judgement's box carries ${media.length} pictures and this transport was ` +
      'measured on one per box: where a second picture sits relative to the first was ' +
      'never replayed, and the placement is what the reading depends on ' +
      '(calibration/vision/server-transport-images.json; docs/decisions.md row 23)',
  );
}

/** The picture, as the `data:` URL the chat endpoint takes. */
function dataUriOf(media: BoxMedia, bytes: Uint8Array): string {
  return `data:${media.mime};base64,${Buffer.from(bytes).toString('base64')}`;
}

/**
 * The user turn, cut where the picture goes: before the artifact's last part.
 *
 * The last part is the question, and `assertArtifact` already guarantees it is
 * unconditional and not per-observation — so it is the one place in the assembly that
 * is present in every box, in the same words. That is what makes it the boundary: a
 * picture placed before a part that only sometimes exists would sit somewhere
 * different from one room to the next, and the placement is measured.
 *
 * Refuses rather than slicing hopefully, for the reason `userTurn` does: a turn that
 * does not end with its own artifact's last part was not assembled from that artifact.
 */
function splitAtQuestion(
  artifact: PromptArtifact,
  user: string,
): { front: string; question: string } {
  const last = artifact.parts[artifact.parts.length - 1];
  if (last === undefined) {
    throw new Error('this artifact has no parts, so there is no question to put a picture before');
  }
  const tail = last.text + last.after;
  if (!user.endsWith(tail)) {
    throw new Error(
      'this judgement was assembled from a different artifact: its user turn does not ' +
        `end with the artifact's last part (${JSON.stringify(last.name)}), so there is no ` +
        'measured place to put the picture, which travels between the box text and the ' +
        'question',
    );
  }
  return { front: user.slice(0, user.length - tail.length), question: tail };
}

/**
 * Whether this server has a projector loaded, asked once per server.
 *
 * A rejected probe is not remembered: a server that was unreachable for one tick may
 * be up for the next, and caching the failure would turn a blip into a permanent
 * refusal. `propsOf` is reused rather than a bare `modalities` read, so a
 * picture-bearing judgement also gets the window and template checks of row 21 — the
 * ones a box carrying an image is in more need of, not less.
 */
function visionProbe(server: LlamaServer): () => Promise<boolean> {
  let answer: Promise<boolean> | undefined;
  return () => {
    answer ??= propsOf(server).then(
      (shape) => shape.vision,
      (error: unknown) => {
        answer = undefined;
        throw error;
      },
    );
    return answer;
  };
}

/**
 * Measure the option ids on the prompt the model will actually see.
 *
 * The synchronous twin of this is `bindOptions` in `watch.ts`, and it cannot be
 * used here: a real tokeniser is behind HTTP, and `watchAs` binds at construction.
 * So the ids are measured first and handed in as a `mask` — which is the same
 * division `WatchInput.mask` already states, one step earlier.
 *
 * Everything `bindOptions` refuses is refused here for the same reason, and the
 * measurement is taken on the **templated** text rather than on the assembly: the
 * answer is read after the template's own tail (`<|im_start|>assistant\n` for the
 * model this was measured on), and an id measured on the assembly would name a
 * position the model never reads.
 */
export async function bindOverServer(
  server: LlamaServer,
  prompt: WatchPrompt,
  tokens: OptionTokens,
): Promise<OptionBinding> {
  const templated = await applyTemplate(server, userTurn(server.artifact, prompt.text));
  const prefix = await tokenise(server, templated);
  const act = await bindOne(server, templated, prefix, tokens.act);
  const ignore = await bindOne(server, templated, prefix, tokens.ignore);
  if (act.id === ignore.id) {
    throw new Error(
      `the two options land on the same id (${act.id}) at this prompt's end, so ` +
        `${JSON.stringify(tokens.act)} and ${JSON.stringify(tokens.ignore)} are one ` +
        'answer wearing two names',
    );
  }
  return { act, ignore };
}

/**
 * What the server says it is, from `/props`.
 *
 * Only the facts this file can act on: whether it will render a chat template at all,
 * how many tokens one prompt may spend, which build answered — the last so that a
 * refusal can be pasted into a report exactly as it stands — and, since a roster may
 * name the model it expects, **which model is actually serving**.
 *
 * The two model fields were measured against the real binary rather than assumed, on
 * a server started twice: with `--alias LFM2.5-VL-3B` it reports `model_alias` as
 * `LFM2.5-VL-3B` and `model_path` as the weights file; with no alias, `model_alias`
 * is the path, so the two agree. `/v1/models` reports the same string as its `id`
 * and in `aliases`, which is the second reader agreeing. Neither string is
 * normalised here: a comparison against them is exact, and anything softer is this
 * file guessing which model a caller meant.
 */
export interface ServerShape {
  /** The template the server renders, verbatim. Empty means it has none. */
  chatTemplate: string;
  /** The per-slot context window: what one prompt may spend, in tokens. */
  nCtx: number;
  /** The build that answered, e.g. `0.7.0-dev`. */
  buildInfo: string;
  /**
   * The name the server answers to: its `--alias` when it was given one, otherwise
   * the weights path. Empty means it named itself not at all.
   */
  modelAlias: string;
  /** The weights file it loaded, as the server reports it. */
  modelPath: string;
  /**
   * Whether a projector is loaded, so an image could be seen at all.
   *
   * Read from `/props` and acted on: a box that carries a picture is refused when this
   * is `false`, because the image part would be dropped on the way in and the reading
   * would come from the caption alone (`readWithPictures`, decisions row 23).
   */
  vision: boolean;
}

/**
 * Refuse a server that cannot be read the way the cut was measured.
 *
 * Three things were true of the server every number in `calibration/` was taken on,
 * and none of them is true by default, so each is asked for rather than assumed:
 *
 * 1. **It renders a chat template.** `calibration/vision/server-transport.json`
 *    records the first as `--jinja`. A server with no template in effect answers a
 *    flat prompt, and a chat model fed one flat string scores below chance — AUC
 *    0.469, `act` 0/12 (`calibration/vision/remeasured.json`). From here that is not
 *    a failure at all: a distribution over the two options still comes back, and it
 *    is the wrong one.
 * 2. **One prompt may spend at least what the question costs, plus the token the
 *    answer is read from.** `-c` defaults to the model's own size, so a server
 *    started small on a model that trains long is the ordinary way to get this
 *    wrong. On overflow llama-server's context shift keeps `n_keep = 0` tokens from
 *    the front, and the front is the artifact's system line — the boundary the
 *    measured shape is split at — so the box arrives truncated and the reading that
 *    comes back is still a number.
 * 3. **It says how large that window is.** A `/props` without a positive
 *    `default_generation_settings.n_ctx` is not a server this file can speak to, and
 *    assuming a window is how (2) happens in the first place.
 *
 * What is measured here is the **skeleton** — the question with no summary and no
 * entries — because that is the smallest text every real assembly contains: a server
 * that cannot hold it cannot serve a single judgement, whatever the caller's own
 * `window` is. That `window` stays the caller's (`box.ts` makes it a budget in
 * whatever unit they measure in, and says so); this function does not convert it,
 * and it does not start, stop or configure a server.
 */
export async function requireServerShape(
  server: LlamaServer,
  prompt: WatchPrompt,
): Promise<ServerShape> {
  const shape = await requireTemplate(server);
  const templated = await applyTemplate(server, userTurn(server.artifact, prompt.text));
  const spend = (await tokenise(server, templated)).length + 1;
  if (spend > shape.nCtx) {
    throw new Error(
      `this server allows ${shape.nCtx} tokens per prompt (${shape.buildInfo}) and the ` +
        `question alone costs ${spend} with the one token the answer is read from, so ` +
        'every judgement would overflow: llama-server keeps 0 leading tokens when it ' +
        'shifts a context, and the front it would discard is the system line the ' +
        'measured shape begins with. Start it with a larger `-c`',
    );
  }
  return shape;
}

/**
 * Refuse the shape neither half can be read from: a server with no template in effect.
 *
 * The one refusal stage 1 and stage 2 share verbatim, which is why it is here rather
 * than copied into each seam. A server that renders no template answers a flat prompt,
 * and a chat model fed one flat string is not the measurement anybody took — stage 1
 * scores below chance on it (`calibration/vision/remeasured.json`), and stage 2 would
 * be answering a prompt the artifact does not describe.
 */
async function requireTemplate(server: LlamaServer): Promise<ServerShape> {
  const shape = await propsOf(server);
  if (shape.chatTemplate.trim() === '') {
    throw new Error(
      "this server renders no chat template, so it would read a flat prompt: the " +
        'shipped cut was measured on the template\'s own output, and the same model ' +
        'read flat scores below chance (calibration/vision/remeasured.json). Start ' +
        "the server with the model's template in effect (`--jinja`)",
    );
  }
  return shape;
}

/**
 * Refuse a prompt that leaves the server no room to write anything.
 *
 * The window refusal a **generating** turn needs, stated for a prompt rather than for
 * a question. Two differences from `requireServerShape`, and both come from what a
 * turn is rather than from a looser check. Nothing is read off the end of the text, so
 * no trailing token is reserved. And the bar is `spend >= nCtx` rather than `> nCtx`: a
 * judgement that exactly fills the window has still been read, while a turn that
 * exactly fills it has not been answered — llama-server would shift the context to make
 * room, keep 0 leading tokens, and drop the front of the prompt, which for a turn is
 * the system line saying how this agent may speak at all.
 *
 * `about` names the prompt in the error, because this is called twice in a turn's life
 * — once on the smallest prompt a bot could ever have, and once on the one this turn is
 * actually given — and a refusal that did not say which could not be acted on.
 *
 * How much room a turn *should* have left is **not** decided here. That would be a
 * number, and a number chosen at a call site is a number no measurement stands behind
 * (`box.ts` on `window`, `docs/decisions.md` rows 12 and 21).
 */
export async function requireChatShape(
  server: LlamaServer,
  prompt: { system: string; user: string },
  about: string,
): Promise<ServerShape> {
  const shape = await requireTemplate(server);
  const templated = await renderTurn(server, prompt.system, prompt.user);
  const spend = (await tokenise(server, templated)).length;
  if (spend >= shape.nCtx) {
    throw new Error(
      `this server allows ${shape.nCtx} tokens per prompt (${shape.buildInfo}) and ` +
        `${about} alone costs ${spend}, so a turn would have no room left to write a ` +
        'single token: llama-server keeps 0 leading tokens when it shifts a context, ' +
        'and the front it would discard is the system line that says how this agent ' +
        'may speak. Start it with a larger `-c`',
    );
  }
  return shape;
}

/** One option, measured where the server will read it. */
async function bindOne(
  server: LlamaServer,
  templated: string,
  prefix: number[],
  token: string,
): Promise<BoundOption> {
  const whole = await tokenise(server, templated + token);
  for (let index = 0; index < prefix.length; index += 1) {
    if (whole[index] !== prefix[index]) {
      throw new Error(
        `the tokeniser rewrites the prompt's own encoding once ${JSON.stringify(token)} ` +
          `is appended (position ${index} becomes ${whole[index]}, was ${prefix[index]}), ` +
          "so no id at the prompt's end belongs to this option — end the prompt at a " +
          'boundary that survives the suffix',
      );
    }
  }
  const tail = whole.slice(prefix.length);
  if (tail.length === 0) {
    throw new Error(
      `${JSON.stringify(token)} adds no token past this prompt, so there is no id to ` +
        'read an answer from',
    );
  }
  if (tail.length !== 1) {
    throw new Error(
      `${JSON.stringify(token)} takes ${tail.length} tokens at the prompt's end, and an ` +
        'option that splits cannot carry a probability in one pass ' +
        '(agent-lifecycle.md §4)',
    );
  }
  return { token, id: tail[0] };
}

/**
 * The probabilities of the declared options, read the way the cut was measured.
 *
 * Keyed by the option's own token, because that is how the kernel looks them up
 * (`probabilityOf` reads `probabilities[tokens.act]`), and summed over every
 * candidate that spells it — see `strip`. A candidate list that does not hold an
 * option yields **no entry** for it rather than a zero: an option the reading could
 * not place is unreadable, and `watch.ts` counts an unreadable answer apart from a
 * confident "not about me".
 */
function readingOf(candidates: Candidate[], tokens: OptionTokens): Record<string, number> {
  const probabilities: Record<string, number> = {};
  for (const token of [tokens.act, tokens.ignore]) {
    const want = strip(token);
    const parts = candidates.filter(
      (candidate) => typeof candidate.token === 'string' && strip(candidate.token) === want,
    );
    if (parts.length === 0) continue;
    probabilities[token] = parts.reduce((total, candidate) => {
      const logprob = candidate.logprob;
      return total + (typeof logprob === 'number' && Number.isFinite(logprob) ? Math.exp(logprob) : 0);
    }, 0);
  }
  return probabilities;
}

/**
 * The user turn, split off the assembly's system line.
 *
 * Refuses rather than slicing hopefully: a text that does not begin with the
 * artifact's own head is a text assembled from a different artifact, and reading a
 * number off it would answer a question nobody measured.
 */
function userTurn(artifact: PromptArtifact, text: string): string {
  const head = artifact.system + artifact.afterSystem;
  if (!text.startsWith(head)) {
    throw new Error(
      'this judgement was assembled from a different artifact: its text does not begin ' +
        "with the artifact's system line and the separator after it, so the measured " +
        'split between the system message and the user turn cannot be found',
    );
  }
  return text.slice(head.length);
}

/** The prompt the model is actually given: the server's own chat template, rendered. */
async function applyTemplate(server: LlamaServer, user: string): Promise<string> {
  return renderTurn(server, server.artifact.system, user);
}

/**
 * One system line and one user turn, as the server's own template renders them.
 *
 * The system block is a **parameter** rather than `server.artifact.system`, because a
 * turn's system line belongs to a different artifact than the one a `LlamaServer`
 * carries: stage 2 is assembled from `work-v1.json`, and there is no second
 * `LlamaServer` type for it. What both halves need from this call is one thing — the
 * exact bytes the model will be charged for — and that is now here for both.
 */
async function renderTurn(
  server: LlamaServer,
  system: string,
  user: string,
): Promise<string> {
  const answer = await postJson(server, '/apply-template', {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
  const prompt = (answer as { prompt?: unknown }).prompt;
  if (typeof prompt !== 'string' || prompt.length === 0) {
    throw new Error('the server rendered no prompt for these messages');
  }
  return prompt;
}

/** The ids a piece of text becomes, in the model's own vocabulary. */
async function tokenise(server: LlamaServer, content: string): Promise<number[]> {
  const answer = await postJson(server, '/tokenize', { content });
  const tokens = (answer as { tokens?: unknown }).tokens;
  if (!Array.isArray(tokens) || tokens.some((id) => typeof id !== 'number')) {
    throw new Error('the server answered no token ids for this text');
  }
  return tokens as number[];
}

/**
 * One forward pass, and the candidates it read.
 *
 * Every sampler is neutral on purpose: the estimator is the raw next-token
 * distribution, so a temperature, a `top_k` or a `min_p` left at its default would
 * truncate the very tail this reading sums. `cache_prompt` is the resident context
 * (§4) at the transport level — the front of the box is the same string on the next
 * tick, so the server can resume over it instead of re-encoding it.
 */
async function completion(server: LlamaServer, prompt: string): Promise<Candidate[]> {
  const answer = (await postJson(server, '/completion', {
    prompt,
    n_predict: 1,
    n_probs: server.nProbs ?? DEFAULT_N_PROBS,
    temperature: 1,
    top_k: 0,
    top_p: 1,
    min_p: 0,
    repeat_penalty: 1,
    cache_prompt: true,
  })) as { completion_probabilities?: unknown };

  const readings = answer.completion_probabilities;
  if (!Array.isArray(readings) || readings.length === 0) return [];
  const first = readings[0] as { top_logprobs?: unknown } | null;
  const candidates = first?.top_logprobs;
  return Array.isArray(candidates) ? (candidates as Candidate[]) : [];
}

/**
 * One forward pass over content parts, and the candidates it read.
 *
 * The same estimator as `completion`, over the one endpoint that takes a picture. The
 * samplers are neutral for the same reason and `cache_prompt` is still the resident
 * front; the reply arrives shaped differently — `choices[0].logprobs.content[0]` holds
 * the candidates where `/completion` puts them at `completion_probabilities[0]` — but
 * both are the raw next-token distribution, and `readingOf` reads either.
 *
 * `logprobs` is what makes the server return the distribution rather than a sampled
 * token, and llama.cpp keeps it unsmoothed: `post_sampling_probs` is off unless asked
 * for, so what arrives is the raw softmax the cut was taken on, not a quantity a
 * temperature could have reshaped.
 */
async function chatCompletion(server: LlamaServer, parts: unknown[]): Promise<Candidate[]> {
  const answer = (await postJson(server, '/v1/chat/completions', {
    messages: [
      { role: 'system', content: server.artifact.system },
      { role: 'user', content: parts },
    ],
    max_tokens: 1,
    temperature: 1,
    top_k: 0,
    top_p: 1,
    min_p: 0,
    repeat_penalty: 1,
    logprobs: true,
    top_logprobs: server.nProbs ?? DEFAULT_N_PROBS,
    cache_prompt: true,
  })) as { choices?: unknown };

  const choices = answer.choices;
  if (!Array.isArray(choices) || choices.length === 0) return [];
  const content = (choices[0] as { logprobs?: { content?: unknown } } | null)?.logprobs
    ?.content;
  if (!Array.isArray(content) || content.length === 0) return [];
  const candidates = (content[0] as { top_logprobs?: unknown } | null)?.top_logprobs;
  return Array.isArray(candidates) ? (candidates as Candidate[]) : [];
}

/**
 * One tool a generating turn may call, in the shape llama-server's chat template speaks.
 *
 * A name, a sentence of description and a JSON Schema: this is the OpenAI tools shape,
 * and it is what the model is shown when it decides between answering and calling.
 */
export interface ChatTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments, as `tools[].function.parameters`. */
  parameters: unknown;
}

/** One call a model asked for. The arguments are the model's own bytes, unparsed. */
export interface ToolCall {
  name: string;
  /** Raw JSON as the model produced it — parsed by the caller, so a bad one is its sentence. */
  arguments: string;
}

/**
 * What a generating turn answered: the text it wrote, and the tools it asked for.
 *
 * Both are kept because they mean different things. `toolCalls` is the turn's work —
 * the only way anything reaches a room (`say.ts`) — while `content` is the agent's
 * own working record, which no code path may turn into a message. A turn with no
 * calls is a turn that said nothing, which is legal and needs no invention here.
 */
export interface ChatTurn {
  content: string;
  toolCalls: ToolCall[];
  /**
   * What the server says this request spent, or `null` when it said nothing.
   *
   * This is the only place a real figure can come from: the runtime does not count
   * tokens — it would have to tokenise the prompt a second time and would then disagree
   * with the server that actually read it — so what a turn records is what the server
   * reported here. `null` rather than `0` because a server that reports no usage has
   * said nothing about spend, and a zero written on its behalf would be a figure no
   * measurement stands behind (`docs/host-rulings.md`, "No spending cap": recorded, and
   * no more than that).
   */
  usage: TokenUsage | null;
}

/**
 * Ask the model for one generating turn.
 *
 * **No generation budget is passed, and that is deliberate.** `max_tokens`, a
 * temperature and the rest of the sampler are numbers, and the record this repository
 * keeps about numbers is that a value chosen at a call site is a value no measurement
 * stands behind (`box.ts` on `window`, `docs/decisions.md` rows 12 and 21). A turn's
 * length is bounded by the server's own window instead — and what a caller can and
 * cannot afford to read is not this function's to decide.
 *
 * **`temperature: 0` is not a sampler choice but a reading of one.** Every other
 * number here would be a guess about how the bot should sound; this one says the
 * answer does not change between two runs of the same prompt, which is what makes a
 * turn's test reproducible at all.
 *
 * The route is `/v1/chat/completions`, the same one the picture path takes and for the
 * same reason: only the chat endpoint takes roles, tools and content parts.
 */
export async function chatTurn(
  server: LlamaServer,
  messages: { role: 'system' | 'user'; content: string }[],
  tools: ChatTool[] = [],
): Promise<ChatTurn> {
  const body: Record<string, unknown> = { messages, temperature: 0 };
  if (tools.length > 0) {
    body.tools = tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
    body.tool_choice = 'auto';
  }

  const answer = (await postJson(server, '/v1/chat/completions', body)) as {
    choices?: unknown;
  };
  const choices = answer.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error(
      'the server answered no choices for a turn: a completion with nothing in it is ' +
        'not a silent turn, it is a request that arrived nowhere',
    );
  }
  const message = (choices[0] as { message?: unknown } | null)?.message as
    | { content?: unknown; tool_calls?: unknown }
    | null
    | undefined;

  const content = typeof message?.content === 'string' ? message.content : '';
  const raw = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  const toolCalls: ToolCall[] = [];
  for (const call of raw) {
    // Two shapes are accepted because llama-server has reported both: the OpenAI
    // nesting (`{function: {name, arguments}}`) and a flatter one. Refusing either
    // would make this transport depend on which build answered it.
    const nested = (call as { function?: { name?: unknown; arguments?: unknown } } | null)?.function;
    const flat = call as { name?: unknown; arguments?: unknown } | null;
    const name = typeof nested?.name === 'string' ? nested.name : flat?.name;
    if (typeof name !== 'string' || name === '') {
      throw new Error(
        'the model asked for a tool call with no name, so which tool it wanted cannot ' +
          'be told — a call this runtime cannot read is not a call it may skip',
      );
    }
    const args = nested?.arguments ?? flat?.arguments;
    toolCalls.push({
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
    });
  }

  return { content, toolCalls, usage: readUsage(answer) };
}

/**
 * The `usage` block llama-server reports, or `null` when it reported none.
 *
 * OpenAI's shape, which llama.cpp implements: `prompt_tokens` is what the request read
 * and `completion_tokens` what it wrote. Both are required — a block carrying one of
 * them is not half a report this file may complete with a zero, because the missing half
 * would then look like a measurement instead of an absence.
 *
 * Read off the parsed answer rather than from a second `/tokenize` round: the server
 * already counted these tokens when it ran the request, and counting them again here
 * would be this repository measuring its own copy of the prompt and disagreeing with the
 * one that was actually read.
 */
function readUsage(answer: unknown): TokenUsage | null {
  const usage = (answer as { usage?: unknown } | null)?.usage;
  if (typeof usage !== 'object' || usage === null) return null;
  const reported = usage as { prompt_tokens?: unknown; completion_tokens?: unknown };
  const input = reported.prompt_tokens;
  const output = reported.completion_tokens;
  if (typeof input !== 'number' || typeof output !== 'number') return null;
  return { input_tokens: input, output_tokens: output };
}

/**
 * `/props`, and the three fields this file reads out of it.
 *
 * A GET, and a separate function rather than a flag on `postJson`: the server
 * registers `/props` for a GET, while its POST is a different endpoint that refuses
 * unless the process was started with `--props`. Reading what a server *is* must not
 * depend on a flag whose only purpose is to change it.
 */
async function propsOf(server: LlamaServer): Promise<ServerShape> {
  const answer = (await request(server, '/props', 'GET')) as {
    chat_template?: unknown;
    build_info?: unknown;
    model_alias?: unknown;
    model_path?: unknown;
    modalities?: unknown;
    default_generation_settings?: { n_ctx?: unknown };
  } | null;
  const props = answer ?? {};
  const chatTemplate = props.chat_template;
  if (typeof chatTemplate !== 'string') {
    throw new Error(
      'the server answered no /props chat_template, so whether it renders a template ' +
        'cannot be told — and a prompt read flat scores below chance',
    );
  }
  const nCtx = props.default_generation_settings?.n_ctx;
  if (typeof nCtx !== 'number' || !Number.isInteger(nCtx) || nCtx <= 0) {
    throw new Error(
      'the server answered no usable /props default_generation_settings.n_ctx, so how ' +
        'much of a box it can hold is unknown — and assuming a window is how a box ' +
        'overflows one',
    );
  }
  return {
    chatTemplate,
    nCtx,
    buildInfo: typeof props.build_info === 'string' ? props.build_info : 'build unknown',
    // Both read as empty when absent, which is a server that named itself not at all —
    // not an unknown name that might match. A caller comparing a declared model
    // against these is asking the server to confirm it, and a server that cannot is
    // not a server that agreed.
    modelAlias: typeof props.model_alias === 'string' ? props.model_alias : '',
    modelPath: typeof props.model_path === 'string' ? props.model_path : '',
    // `/props` reports this as an object of booleans (`{vision, video, audio}`); a
    // server too old to report it is read as unable to see, which is the safe way
    // round: it refuses rather than claims a capability nobody confirmed.
    vision: visionOf(props.modalities),
  };
}

/** `modalities.vision`, read as a fact about the server rather than as a promise. */
function visionOf(modalities: unknown): boolean {
  if (typeof modalities !== 'object' || modalities === null) return false;
  return (modalities as { vision?: unknown }).vision === true;
}

/** One POST, refused loudly when it did not arrive. */
async function postJson(server: LlamaServer, path: string, body: unknown): Promise<unknown> {
  return request(server, path, 'POST', JSON.stringify(body));
}

/**
 * One request, refused loudly when it did not arrive.
 *
 * A transport failure throws: the kernel already treats a model that fell over as a
 * failed turn (`kernel.ts`), and a judgement that could not be *asked* is not the
 * same fact as an answer that could not be *read*. The second one is
 * `WatchOutcome.unparsed`, and it lives above this file.
 */
async function request(
  server: LlamaServer,
  path: string,
  method: string,
  body?: string,
): Promise<unknown> {
  const base = server.baseUrl.replace(/\/+$/, '');
  const fetcher = server.fetch ?? (globalThis.fetch as unknown as Fetcher);
  const response = await fetcher(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`the llama server answered ${response.status} for ${path}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`the llama server answered no JSON for ${path}: ${text.slice(0, 200)}`);
  }
}
