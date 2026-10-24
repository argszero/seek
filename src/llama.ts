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

import type { PromptArtifact } from './prompts.ts';
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
  return {
    async read(input: WatchInput): Promise<WatchReading> {
      const templated = await applyTemplate(server, userTurn(artifact, input.prompt.text));
      const candidates = await completion(server, templated);
      // No `reason`: see above. What the kernel does with an absent one is its
      // business (`watch.ts`, `reasonOf`).
      return { probabilities: readingOf(candidates, input.options) };
    },
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
 * Three facts, and only the ones this file can act on: whether it will render a chat
 * template at all, how many tokens one prompt may spend, and which build answered —
 * the last so that a refusal can be pasted into a report exactly as it stands.
 */
export interface ServerShape {
  /** The template the server renders, verbatim. Empty means it has none. */
  chatTemplate: string;
  /** The per-slot context window: what one prompt may spend, in tokens. */
  nCtx: number;
  /** The build that answered, e.g. `0.7.0-dev`. */
  buildInfo: string;
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
  const shape = await propsOf(server);
  if (shape.chatTemplate.trim() === '') {
    throw new Error(
      "this server renders no chat template, so it would read a flat prompt: the " +
        'shipped cut was measured on the template\'s own output, and the same model ' +
        'read flat scores below chance (calibration/vision/remeasured.json). Start ' +
        "the server with the model's template in effect (`--jinja`)",
    );
  }
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
  const answer = await postJson(server, '/apply-template', {
    messages: [
      { role: 'system', content: server.artifact.system },
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
  };
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
