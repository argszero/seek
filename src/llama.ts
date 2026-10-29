/**
 * The two halves, reached over a local llama.cpp server.
 *
 * `watch.ts` declares `WatchModel` and `WatchTurn`'s shape is this file's; what sat between
 * them used to be nothing. Today there are two transports here, and they are deliberately
 * different kinds of thing.
 *
 * **The judgement is one forward pass and no text.** It asks `/v1/systemone` — llama.cpp's
 * endpoint for a decision model — with a `state` and a question whose answers are declared,
 * and the answer comes back as a calibrated probability per answer, with `output_tokens: 0`.
 * That is what a System One model is for, and it is what the model this app ships
 * (`d1-2B`) is: its own card says it *"returns calibrated answers in one forward pass,
 * without generating tokens"* and *"is not a chat model"*.
 *
 * **What this replaced, and why the replacement is not a preference.** The judgement used
 * to be a sentence ending in `Answer act or ignore` with one token sampled after it, read
 * back as a distribution summed over every token that spelled the option. That measured the
 * wrong thing three ways: `Act`, `Action` and `act` are three ids and one answer, `我` and
 * `I` took a third of the probability mass on a Chinese message, and — the one that silenced
 * a room — a bot could not tell whether it was the one being addressed, so in a room of four
 * a message naming one of them woke all four or none. A declared choice removes all three:
 * the answers are named, the answer is calibrated, and the state says who the bot is and who
 * else is in the room.
 *
 * **The picture path is gone with the model, and that is a loss.** `d1-2B` is text: the
 * endpoint takes a `state` string, and the server reports `modalities.vision: false`. The
 * previous model was a vision-language one and its images were a measured route
 * (`calibration/vision/`). A picture in a judgement's window is therefore neither read nor
 * sent: the state has no place to put bytes, so `watch.ts` counts it in
 * `WatchOutcome.unreadPictures` and judges the room on its words. Restoring it needs a
 * projector and a measured image route for this model; neither exists.
 *
 * **`/props` is not read for `modalities` here.** It was, into a `ServerShape.vision`
 * field whose comment claimed a box carrying a picture would be refused when it was false —
 * and nothing read the field, because that refusal belonged to a transport that no longer
 * has a picture route to refuse. A fact no caller acts on is not a fact this file should
 * report, so the field is gone rather than left claiming something.
 *
 * **The writing half is unchanged.** A turn is still one `/v1/chat/completions` call with
 * tools, and everything it checks about a server — a template in effect, a window big enough
 * for the prompt — is still checked, because a chat model fed a flat prompt scores below
 * chance and an over-long one is truncated silently.
 */

import { Buffer } from 'node:buffer';

import type { TokenUsage } from './types.ts';
import type { OptionTokens, WatchInput, WatchModel, WatchReading } from './watch.ts';

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

/** Where the model is. */
export interface LlamaServer {
  /** Origin of a running `llama-server`, e.g. `http://127.0.0.1:8080`. */
  baseUrl: string;
  /**
   * A credential this server asks for, sent as `Authorization: Bearer …`.
   *
   * `llama-server` takes one with `--api-key`, and a hosted endpoint that speaks the
   * same chat API refuses every request without one — so before this field this file
   * could speak only to a server that wanted no credential at all.
   *
   * Optional, and an empty or whitespace-only string is **not** a credential: it sends
   * no header. A request that goes out with `Bearer ` comes back a 401 that reads like
   * a wrong key rather than a missing one, and half a credential is worse than none.
   * The key itself is sent as given — it is the server's string, not ours to edit — and
   * no refusal in this file quotes it: what a refusal carries is the server's own
   * answer.
   */
  apiKey?: string;
  /**
   * The model this endpoint serves, named by the caller — and the one field that says which
   * kind of endpoint this is.
   *
   * `llama-server` answers `/props`, so its identity and its window are facts it reports.
   * A hosted OpenAI-compatible endpoint answers no `/props` at all: the chat call works and
   * the checks the writing half makes are simply not available. Its window and its name live
   * in `GET /v1/models` instead, per model, so the caller says which model it wants and this
   * file reads the rest from the server's own list — `requireDeclaredModel` is that read.
   *
   * **Absent means a `llama-server`**, and every check that asks `/props` stays exactly as
   * it was. Present means none of them run, because none of them can: there is no template
   * to read, no `/apply-template` to render through and no `/tokenize` to count with. What
   * replaces them is stated where each one is skipped, and nothing is faked to fill a gap.
   */
  model?: string;
  /** What to call instead of `globalThis.fetch`. A test's recorder. */
  fetch?: Fetcher;
}

/**
 * The judgement model: one forward pass, and the probabilities it answered with.
 *
 * **No generated text and no tool calls.** This is the half of the bot that cannot write
 * (§4), and a decision model produces no sentence: `reason` is never set, and a sentence
 * invented here would read exactly like evidence.
 *
 * **The question is asked as a question.** `questions` takes one named question of type
 * `choice` with a meaning per answer, and the reply carries a probability per answer key.
 * The key name (`respond`, below) is this file's; the keys *inside* `criteria` are the
 * option tokens `watch.ts` reads, so the artifact and the runtime have to agree on them and
 * do so through `declaredOptions`.
 *
 * **Measured, on a real server.** Two runs of the same judgement differ by `0.0000`, and a
 * judgement costs 45–61 ms including HTTP — against 175 ms for the token reading it
 * replaced, on a model a third the size.
 */
export function llamaWatchModel(server: LlamaServer): WatchModel {
  return {
    async read(input: WatchInput): Promise<WatchReading> {
      const question = input.prompt.question;
      const answer = (await postJson(server, '/v1/systemone', {
        state: input.prompt.state,
        questions: {
          respond: {
            type: 'choice',
            instructions: question.instructions,
            criteria: question.criteria,
          },
        },
      })) as { answers?: Record<string, { probabilities?: unknown }> } | null;
      const probabilities = answer?.answers?.respond?.probabilities;
      // No `reason`: see above. What the kernel does with an absent one is its
      // business (`watch.ts`, `reasonOf`).
      return { probabilities: probabilitiesOf(probabilities, input.options) };
    },
  };
}

/**
 * The probabilities the endpoint reported, held to the two options asked about.
 *
 * A number that is not a finite probability in [0, 1] is dropped rather than trusted, which
 * leaves the option missing — and `watch.ts` reads a missing option as no answer at all
 * (`probabilityOf`), which is §4's "unparseable counts as no act". Dropping rather than
 * throwing is deliberate: a model that answers with a shape this file does not understand
 * has still answered, and the honest reading of that is "no answer that could be read",
 * counted in `WatchOutcome.unparsed`, rather than an exception that ends a tick.
 */
function probabilitiesOf(
  values: unknown,
  tokens: OptionTokens,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof values !== 'object' || values === null) return out;
  const record = values as Record<string, unknown>;
  for (const token of [tokens.act, tokens.ignore]) {
    const value = record[token];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    if (value < 0 || value > 1) continue;
    out[token] = value;
  }
  return out;
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
 * Refuse a server that cannot answer this question at all.
 *
 * **One thing is checked: that the state fits.** `-c` defaults to the model's own size, so
 * a server started small is the ordinary way to get this wrong, and what a truncated
 * `state` does is not an error but a verdict — read off text the model only half saw.
 *
 * **The chat template is deliberately not checked here**, and that difference from the
 * writing half is the whole of why this is a second function. A generating turn is rendered
 * through the server's template, so a server with none would read a flat prompt and score
 * below chance — a real refusal, made in `requireChatShape`. A judgement is not rendered
 * through it at all: `/v1/systemone` takes a `state` string and templates it internally with
 * the decision format the model was trained on. Asking for a chat template here would pass
 * on the shipped model for a reason that has nothing to do with this endpoint, which is a
 * check that reads like evidence and is not.
 *
 * What is measured is the **skeleton** — the state with no summary and no entries — because
 * that is the smallest state every real judgement contains: a server that cannot hold it
 * cannot serve a single judgement, whatever the caller's own `window` is. That `window`
 * stays the caller's (`box.ts` makes it a budget in whatever unit they measure in, and says
 * so); this function does not convert it, and it does not start, stop or configure a server.
 */
export async function requireWatchShape(
  server: LlamaServer,
  state: string,
): Promise<ServerShape> {
  const shape = await propsOf(server);
  const spend = (await tokenise(server, state)).length;
  if (spend > shape.nCtx) {
    throw new Error(
      `this server allows ${shape.nCtx} tokens per prompt (${shape.buildInfo}) and the ` +
        `question alone costs ${spend}, so every judgement would overflow: llama-server ` +
        'keeps 0 leading tokens when it shifts a context, and the front it would discard ' +
        'is the line saying which bot is being asked. Start it with a larger `-c`',
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
 * (`box.ts` on `window`).
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

/** What a hosted endpoint says about the model it was asked for. */
export interface DeclaredEndpoint {
  /** The name the caller asked for, echoed so a refusal can quote what was wanted. */
  model: string;
  /** Every name the endpoint says it serves, for a refusal a person can act on. */
  served: string[];
  /**
   * The window the endpoint declares for this model, or `null` when it declares none.
   *
   * Reported rather than enforced. What the window is *for* in this file is the refusal
   * below `requireChatShape`: llama-server answers an over-long prompt by shifting its
   * context and keeping 0 leading tokens, which silently drops the system line, so the
   * prompt has to be counted before it is sent. A hosted endpoint answers an over-long
   * prompt with an error of its own, and it is the only one that can count its own
   * tokens — so the number is kept for whoever wants to say what it is, and nothing here
   * pretends to hold a budget with it.
   */
  window: number | null;
}

/**
 * Read what a hosted endpoint says about one model, and refuse an endpoint that does not
 * serve it.
 *
 * **This is the whole of what replaces `/props` for a generating turn**, and it is
 * deliberately smaller than what it replaces. `/props` was asked for three things: that a
 * template is in effect, how large the window is, and whether a projector is loaded. A
 * hosted endpoint is asked one thing here — is this name in your list — because the other
 * two are not facts a caller can act on: it renders with its own template (the caller's
 * `messages` are the whole input), and it refuses an over-long prompt in its own words
 * rather than truncating silently.
 *
 * **Why the name is checked at bind rather than discovered.** `GET /v1/models` answers a
 * list, and any entry would be a guess at which one the person meant. The failure a typo
 * produces is not a slow one — measured on the endpoint this was written against, a
 * request naming a model it does not serve comes back `503 "no usable key for that model"`,
 * which reads as a billing problem rather than as a wrong name (`/v1/models` lists far more
 * names than the config mentions, so the typo is easy). Refusing here turns that into one
 * sentence at start-up listing the names that do exist.
 */
export async function requireDeclaredModel(
  server: LlamaServer & { model: string },
): Promise<DeclaredEndpoint> {
  const answer = (await request(server, '/v1/models', 'GET')) as { data?: unknown } | null;
  const list = answer?.data;
  if (!Array.isArray(list)) {
    throw new Error(
      'this endpoint answered no model list at /v1/models, so whether it serves ' +
        `'${server.model}' cannot be told: which model writes the words is not something ` +
        'this app may assume, and a name it cannot confirm is not a name it may use',
    );
  }
  const served: string[] = [];
  for (const entry of list) {
    const id = (entry as { id?: unknown } | null)?.id;
    if (typeof id === 'string' && id !== '') served.push(id);
  }
  if (!served.includes(server.model)) {
    throw new Error(
      `this endpoint serves ${served.map((name) => `'${name}'`).join(', ') || 'no model'} ` +
        `and not '${server.model}': the name that writes the words is the one the endpoint ` +
        'lists, and asking for another comes back as that endpoint\'s own error rather than ' +
        'as a wrong name',
    );
  }

  const entry = list.find(
    (one) => (one as { id?: unknown } | null)?.id === server.model,
  ) as { context_window?: unknown } | null;
  const declared = entry?.context_window;
  const window =
    typeof declared === 'number' && Number.isInteger(declared) && declared > 0 ? declared : null;
  return { model: server.model, served, window };
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
 * stands behind (`box.ts` on `window`). A turn's
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
  // **Which model, when the caller named one.** A `llama-server` serves a single model and
  // is told nothing; a hosted endpoint serves many and answers a request that carries no
  // name with its own error rather than with a guess. The name sent is the one
  // `requireDeclaredModel` read off that endpoint's own `/v1/models`, so what is asked for
  // here is what was confirmed there — no second spelling, no default.
  if (server.model !== undefined) body.model = server.model;
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
 * The origin this transport's own paths hang off.
 *
 * Two forms arrive as `baseUrl` and both are legitimate. `llama-server` is named by its
 * origin — `SEEK_SERVER=http://127.0.0.1:8080` — and every path below carries its own
 * `/v1`. An OpenAI-compatible endpoint is named by its `base_url`, which the vendor's own
 * documentation writes with `/v1` on the end and which the host's own config carries
 * (`https://atp-dev.shenbiai.net/v1`). Appending a path to the second form doubles the
 * segment: measured against that endpoint, `GET /v1/v1/models` is a **404** while
 * `GET /v1/models` is a `200`.
 *
 * So one trailing `/v1` is trimmed here, and a trailing slash with it (`//v1/chat` is a
 * different path, and some hosts answer it with a redirect to a login page). Both forms
 * then address the same origin, which is what makes one setting usable by either.
 */
function originOf(server: LlamaServer): string {
  return server.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
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
  // An absent template is read as **none**, not as an unknown to be guessed at: the two
  // readers below use it differently, and both want the same fact. `requireChatShape`
  // refuses a server whose template is empty, because a generating turn read flat scores
  // below chance; `requireWatchShape` does not consult it at all, because a judgement is
  // never rendered through it.
  const chatTemplate = typeof props.chat_template === 'string' ? props.chat_template : '';
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
  };
}

/** One POST, refused loudly when it did not arrive. */
async function postJson(server: LlamaServer, path: string, body: unknown): Promise<unknown> {
  return request(server, path, 'POST', JSON.stringify(body));
}

/**
 * The headers one request carries: JSON, and the credential when there is one.
 *
 * Every request in this file goes through `request`, `/props` included, so this is the
 * one place a credential has to be attached — measured rather than assumed: the GET and
 * the two chat calls are the only calls the file makes.
 */
function headersOf(server: LlamaServer): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const key = server.apiKey;
  if (typeof key === 'string' && key.trim() !== '') {
    headers.Authorization = `Bearer ${key}`;
  }
  return headers;
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
  const fetcher = server.fetch ?? (globalThis.fetch as unknown as Fetcher);
  const response = await fetcher(`${originOf(server)}${path}`, {
    method,
    headers: headersOf(server),
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
