import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';

import { deliver } from './delivery.ts';
import { makeWorld } from './fixtures.ts';
import {
  bindOverServer,
  llamaWatchModel,
  requireServerShape,
  strip,
  type Fetcher,
  type LlamaServer,
} from './llama.ts';
import type { PromptArtifact } from './prompts.ts';
import { watchAs, type OptionTokens, type WatchPrompt } from './watch.ts';

// The artifact the transport is bound to. Its head is what splits the system message
// from the user turn, and its trailing space is the boundary an option is appended
// at — the same two facts the shipped `watch-v1.json` states.
const ARTIFACT: PromptArtifact = {
  version: 'watch-v1',
  system: 'You watch one room of a payments team.',
  afterSystem: '\n\n',
  parts: [
    { name: 'summary', text: 'Room memory: {summary}', after: '\n\n', when: 'summary' },
    { name: 'message', text: 'Message: {text}', after: '\n', when: 'always', each: 'observation' },
    {
      name: 'question',
      text: 'Does this room need you to act? Answer act or ignore.',
      after: ' ',
      when: 'always',
    },
  ],
  operatingPoint: { threshold: 0.6, measuredOn: 'the suite' },
};

const TOKENS: OptionTokens = { act: 'act', ignore: 'ignore' };

/** One request the transport made, as the server saw it. */
interface Call {
  path: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/**
 * A server that answers by path and records what it was asked.
 *
 * A recorder rather than a live socket: what this file has to pin is the request
 * shape and the reading of the answer, and both are visible without a model. The
 * numbers themselves were measured against the real binary
 * (`calibration/vision/server-transport.json`), which no unit test can stand in for.
 */
function fakeServer(
  routes: Record<string, (body: Record<string, unknown>) => unknown>,
  options: { fail?: number; notJson?: boolean } = {},
): { fetch: Fetcher; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher: Fetcher = async (url, init) => {
    const path = new URL(url).pathname;
    // `/props` is read with a GET and carries no body, so the recorder has to accept
    // a request without one rather than parse `undefined`.
    const body =
      init.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>);
    calls.push({ path, body, headers: init.headers });
    const handler = routes[path];
    const payload = handler ? handler(body) : { error: 'no such route' };
    return {
      ok: options.fail === undefined,
      status: options.fail ?? (handler ? 200 : 404),
      text: async () =>
        options.notJson ? 'not json at all' : JSON.stringify(payload),
    };
  };
  return { fetch: fetcher, calls };
}

/**
 * A vocabulary that makes one word one token.
 *
 * Whitespace runs and words are separate pieces, so appending `act` to a text ending
 * in a newline yields exactly one new token — which is the property an option has to
 * have before it can carry a probability (§4).
 */
function makeVocab(options: { split?: Record<string, number> } = {}) {
  const ids = new Map<string, number>();
  let next = 100;
  const idOf = (piece: string): number => {
    const known = ids.get(piece);
    if (known !== undefined) return known;
    ids.set(piece, next);
    next += 1;
    return ids.get(piece) as number;
  };
  return (content: string): number[] => {
    const pieces = content.match(/\s+|[^\s]+/g) ?? [];
    const out: number[] = [];
    for (const piece of pieces) {
      const split = options.split?.[piece];
      if (split !== undefined) {
        for (let index = 0; index < split; index += 1) out.push(idOf(`${piece}#${index}`));
        continue;
      }
      out.push(idOf(piece));
    }
    return out;
  };
}

/** The template this fake model uses: a fixed head and tail, so the ends are stable. */
const TEMPLATE_HEAD = '<|im_start|>system\n';
const TEMPLATE_MID = '<|im_end|>\n<|im_start|>user\n';
const TEMPLATE_TAIL = '<|im_end|>\n<|im_start|>assistant\n';

function renderingServer(options: { split?: Record<string, number>; candidates?: unknown[] } = {}) {
  const tokenise = makeVocab(options.split ? { split: options.split } : {});
  return fakeServer({
    '/apply-template': (body) => {
      const messages = body.messages as { role: string; content: string }[];
      const system = messages.find((m) => m.role === 'system')?.content ?? '';
      const user = messages.find((m) => m.role === 'user')?.content ?? '';
      return { prompt: `${TEMPLATE_HEAD}${system}${TEMPLATE_MID}${user}${TEMPLATE_TAIL}` };
    },
    '/tokenize': (body) => ({ tokens: tokenise(String(body.content)) }),
    '/completion': () => ({
      completion_probabilities: [{ top_logprobs: options.candidates ?? [] }],
    }),
  });
}

/** A server plus the artifact it is bound to. */
function serverOf(recorder: { fetch: Fetcher }): LlamaServer {
  return { baseUrl: 'http://127.0.0.1:8080', artifact: ARTIFACT, fetch: recorder.fetch };
}

/** The prompt a judgement continues from, as the kernel would have assembled it. */
const PROMPT: WatchPrompt = {
  version: 'watch-v1',
  text: `${ARTIFACT.system}${ARTIFACT.afterSystem}Message: the batch failed\nDoes this room need you to act? Answer act or ignore. `,
};

const SKELETON: WatchPrompt = {
  version: 'watch-v1',
  text: `${ARTIFACT.system}${ARTIFACT.afterSystem}Does this room need you to act? Answer act or ignore. `,
};

test('the system line travels as a system message and the rest as a user turn', async () => {
  const recorder = renderingServer();
  const model = llamaWatchModel(serverOf(recorder));

  await model.read({
    prompt: PROMPT,
    state: { read: 1, total: 1, unread: 0, delta: [] } as never,
    options: TOKENS,
    mask: { act: { token: 'act', id: 1 }, ignore: { token: 'ignore', id: 2 } },
  });

  const templates = recorder.calls.filter((call) => call.path === '/apply-template');
  assert.equal(templates.length, 1);
  const messages = templates[0].body.messages as { role: string; content: string }[];
  assert.deepEqual(messages[0], { role: 'system', content: ARTIFACT.system });
  assert.deepEqual(messages[1], {
    role: 'user',
    content: 'Message: the batch failed\nDoes this room need you to act? Answer act or ignore. ',
  });
});

test('an assembly from another artifact is refused rather than read', async () => {
  const recorder = renderingServer();
  const model = llamaWatchModel(serverOf(recorder));

  await assert.rejects(
    () =>
      model.read({
        prompt: { version: 'watch-v1', text: 'a text nobody assembled from this artifact' },
        state: {} as never,
        options: TOKENS,
        mask: { act: { token: 'act', id: 1 }, ignore: { token: 'ignore', id: 2 } },
      }),
    /assembled from a different artifact/,
  );
  assert.equal(recorder.calls.length, 0, 'nothing is put to a model about a text it cannot place');
});

test('the reading sums every spelling of the option, which is how the cut was measured', async () => {
  // `Act` and `act` are two ids and one answer, and the recorded p_act adds both.
  // `Action` is a third id and a different word, so it must not be counted.
  const recorder = renderingServer({
    candidates: [
      { token: 'Act', logprob: Math.log(0.5) },
      { token: 'act', logprob: Math.log(0.25) },
      { token: 'Action', logprob: Math.log(0.1) },
      { token: 'Ignore', logprob: Math.log(0.08) },
      { token: 'ignore', logprob: Math.log(0.04) },
    ],
  });
  const model = llamaWatchModel(serverOf(recorder));

  const reading = await model.read({
    prompt: PROMPT,
    state: {} as never,
    options: TOKENS,
    mask: { act: { token: 'act', id: 1 }, ignore: { token: 'ignore', id: 2 } },
  });

  assert.equal(reading.probabilities.act.toFixed(6), '0.750000');
  assert.equal(reading.probabilities.ignore.toFixed(6), '0.120000');
  assert.equal(reading.reason, undefined, 'a decision model produces no sentence');
});

test('the probabilities are keyed by the option token the caller declared', async () => {
  // The kernel reads `probabilities[tokens.act]`, so a runtime that keyed these by
  // "act" and "ignore" regardless would return an unreadable answer to a caller
  // that declared other options — and count it as a confident no.
  const recorder = renderingServer({
    candidates: [
      { token: ' yes', logprob: Math.log(0.7) },
      { token: ' no', logprob: Math.log(0.3) },
    ],
  });
  const model = llamaWatchModel(serverOf(recorder));

  const reading = await model.read({
    prompt: PROMPT,
    state: {} as never,
    options: { act: 'yes', ignore: 'no' },
    mask: { act: { token: 'yes', id: 1 }, ignore: { token: 'no', id: 2 } },
  });

  assert.deepEqual(Object.keys(reading.probabilities).sort(), ['no', 'yes']);
  assert.equal(reading.probabilities.yes.toFixed(6), '0.700000');
});

test('an option the answer did not place is absent rather than zero', async () => {
  const recorder = renderingServer({ candidates: [{ token: 'Act', logprob: Math.log(0.9) }] });
  const model = llamaWatchModel(serverOf(recorder));

  const reading = await model.read({
    prompt: PROMPT,
    state: {} as never,
    options: TOKENS,
    mask: { act: { token: 'act', id: 1 }, ignore: { token: 'ignore', id: 2 } },
  });

  assert.equal('ignore' in reading.probabilities, false, 'unreadable is not a confident no');
  assert.equal(reading.probabilities.act.toFixed(6), '0.900000');
});

test('the completion is asked for with every sampler neutral and the front cached', async () => {
  const recorder = renderingServer();
  const model = llamaWatchModel({ ...serverOf(recorder), nProbs: 32 });

  await model.read({
    prompt: PROMPT,
    state: {} as never,
    options: TOKENS,
    mask: { act: { token: 'act', id: 1 }, ignore: { token: 'ignore', id: 2 } },
  });

  const body = recorder.calls.find((call) => call.path === '/completion')?.body;
  assert.ok(body);
  assert.equal(body.n_probs, 32, 'the depth the estimator sums over is the caller\'s');
  assert.equal(body.temperature, 1, 'the raw distribution, not a sampled one');
  assert.equal(body.top_k, 0, 'a truncated tail is a reading that under-reports');
  assert.equal(body.min_p, 0);
  assert.equal(body.cache_prompt, true, 'the resident context, at the transport level');
});

test('a transport failure throws, because a judgement that could not be asked is not an answer', async () => {
  const recorder = renderingServer();
  const failing = { ...serverOf(recorder), baseUrl: 'http://127.0.0.1:8080' };
  const server = { ...failing, fetch: fakeServer({}, { fail: 500 }).fetch };
  const model = llamaWatchModel(server);

  await assert.rejects(
    () =>
      model.read({
        prompt: PROMPT,
        state: {} as never,
        options: TOKENS,
        mask: { act: { token: 'act', id: 1 }, ignore: { token: 'ignore', id: 2 } },
      }),
    /answered 500 for \/apply-template/,
  );
});

test('an answer that is not JSON throws rather than reading as no act', async () => {
  const server = {
    ...serverOf(renderingServer()),
    fetch: fakeServer({}, { notJson: true }).fetch,
  };
  await assert.rejects(
    () =>
      llamaWatchModel(server).read({
        prompt: PROMPT,
        state: {} as never,
        options: TOKENS,
        mask: { act: { token: 'act', id: 1 }, ignore: { token: 'ignore', id: 2 } },
      }),
    /answered no JSON/,
  );
});

test('the mask is measured on the templated prompt, not on the assembly', async () => {
  const recorder = renderingServer();
  const mask = await bindOverServer(serverOf(recorder), SKELETON, TOKENS);

  // Whatever ids the fake vocabulary gave, they are distinct and they came from the
  // templated text: the tokenize calls carry the template's own tail, so an option
  // appended here is read where the model reads it, not where the assembly ends.
  assert.notEqual(mask.act.id, mask.ignore.id);
  assert.equal(mask.act.token, 'act');
  const tokenised = recorder.calls.filter((call) => call.path === '/tokenize');
  assert.equal(tokenised.length, 3, 'the prompt and its two suffixes, once each');
  for (const call of tokenised) {
    assert.ok(
      String(call.body.content).includes(TEMPLATE_TAIL),
      'the measurement is taken past the template, where the answer is read',
    );
  }
});

test('an option the server splits into several tokens is refused', async () => {
  const recorder = renderingServer({ split: { snooze: 3 } });
  await assert.rejects(
    () => bindOverServer(serverOf(recorder), SKELETON, { act: 'act', ignore: 'snooze' }),
    /takes 3 tokens at the prompt's end/,
  );
});

test('two options landing on one id are refused, because that is one answer', async () => {
  // A vocabulary that makes `act` and `ignore` the same piece: the tail is one token
  // either way, and a runtime that accepted it would read one answer under two names.
  const tokenise = (content: string): number[] =>
    content.match(/\s+|[^\s]+/g)?.map((piece) => (piece === 'act' || piece === 'ignore' ? 7 : 8)) ?? [];
  const recorder = fakeServer({
    '/apply-template': () => ({ prompt: 'a templated prompt\n' }),
    '/tokenize': (body) => ({ tokens: tokenise(String(body.content)) }),
  });
  await assert.rejects(
    () => bindOverServer(serverOf(recorder), SKELETON, TOKENS),
    /land on the same id/,
  );
});

test('a runtime given both a tokeniser and a mask refuses, because they can disagree', async () => {
  const world = makeWorld();
  const recorder = renderingServer();
  assert.throws(
    () =>
      watchAs(world.store, world.botA, llamaWatchModel(serverOf(recorder)), {
        window: 10,
        prompt: ARTIFACT,
        mask: { act: { token: 'act', id: 1 }, ignore: { token: 'ignore', id: 2 } },
        tokeniser: { encode: () => [1] },
      }),
    /both a tokeniser and a mask/,
  );
});

test('a supplied mask is held to the refusals a measured one is', async () => {
  const world = makeWorld();
  const recorder = renderingServer();
  assert.throws(
    () =>
      watchAs(world.store, world.botA, llamaWatchModel(serverOf(recorder)), {
        window: 10,
        prompt: ARTIFACT,
        mask: { act: { token: 'act', id: 7 }, ignore: { token: 'ignore', id: 7 } },
      }),
    /land on the same id/,
  );
  assert.throws(
    () =>
      watchAs(world.store, world.botA, llamaWatchModel(serverOf(recorder)), {
        window: 10,
        prompt: ARTIFACT,
        mask: { act: { token: 'act', id: 1.5 }, ignore: { token: 'ignore', id: 2 } },
      }),
    /must be a token id/,
  );
});

test('the transport drives a real verdict through the kernel\'s own seam', async () => {
  // End to end over the seam: the store, the box, the assembled prompt, the mask
  // measured over the server, and a verdict written onto the entry it judged.
  const world = makeWorld();
  deliver(world.store, { roomId: world.room, senderId: world.me, text: 'the settlement batch failed' });
  const entries = await world.store.drain(world.botA);
  assert.equal(entries.length, 1);

  const recorder = renderingServer({
    candidates: [
      { token: 'Act', logprob: Math.log(0.62) },
      { token: 'ignore', logprob: Math.log(0.31) },
    ],
  });
  const server = serverOf(recorder);
  const mask = await bindOverServer(server, SKELETON, TOKENS);
  const watch = watchAs(world.store, world.botA, llamaWatchModel(server), {
    window: 10,
    prompt: ARTIFACT,
    mask,
    optionTokens: TOKENS,
  });

  const acting = await watch(entries);

  assert.deepEqual(acting.map((entry) => entry.id), [entries[0].id], '0.62 clears the 0.600 cut');
  assert.equal(entries[0].verdict, 'act');
  assert.equal(watch.last?.unparsed, 0, 'both options were read, so nothing was unreadable');
});

test('a reading under the cut is a decided ignore, not an unreadable answer', async () => {
  const world = makeWorld();
  deliver(world.store, { roomId: world.room, senderId: world.me, text: 'thanks, all good' });
  const entries = await world.store.drain(world.botA);

  const recorder = renderingServer({
    candidates: [
      { token: 'Act', logprob: Math.log(0.1) },
      { token: 'ignore', logprob: Math.log(0.85) },
    ],
  });
  const server = serverOf(recorder);
  const watch = watchAs(world.store, world.botA, llamaWatchModel(server), {
    window: 10,
    prompt: ARTIFACT,
    mask: await bindOverServer(server, SKELETON, TOKENS),
    optionTokens: TOKENS,
  });

  const acting = await watch(entries);

  assert.deepEqual(acting, []);
  assert.equal(entries[0].verdict, 'ignore');
  assert.equal(watch.last?.ignored, 1);
  assert.equal(watch.last?.unparsed, 0);
});

test('the strip rule is the calibration\'s: letters and digits anywhere, lowercased', () => {
  assert.equal(strip(' Act'), 'act');
  assert.equal(strip('act'), 'act');
  assert.equal(strip('(act)'), 'act');
  assert.equal(strip('Action'), 'action');
  assert.equal(strip('!ignore.'), 'ignore');
});

/** A PNG header is enough to prove the bytes survive the trip; no decoder reads them. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

/** One picture as `box.ts` hands it over: a reference, never the bytes. */
const SHOT = {
  entryId: 'obs_1',
  messageId: 'msg_1',
  key: 'blob/shot.png',
  mime: 'image/png',
};

/**
 * The projector's own answer, which is not `undefined` by accident.
 *
 * `/props` reports `modalities` as an object of booleans; passing `null` here is the
 * server too old to report it, which has to be read the safe way round.
 */
const SEES = { vision: true, video: false, audio: false };

/** A server with a projector, answering the one endpoint that takes a picture. */
function pictureServer(
  options: { modalities?: unknown; candidates?: unknown[] } = {},
): { fetch: Fetcher; calls: Call[] } {
  return fakeServer({
    '/props': () => ({
      chat_template: 'a template',
      build_info: 'test',
      ...('modalities' in options
        ? { modalities: options.modalities }
        : { modalities: SEES }),
      default_generation_settings: { n_ctx: 4096 },
    }),
    '/v1/chat/completions': () => ({
      choices: [{ logprobs: { content: [{ top_logprobs: options.candidates ?? [] }] } }],
    }),
  });
}

/** The server, plus the loader `box.ts` makes necessary. */
function seeingServer(recorder: { fetch: Fetcher }, extra: Partial<LlamaServer> = {}): LlamaServer {
  return {
    ...serverOf(recorder),
    loadMedia: async () => PNG_BYTES,
    ...extra,
  };
}

/** A judgement whose box carries `media`, against the ordinary prompt. */
function askWith(model: ReturnType<typeof llamaWatchModel>, media: unknown[]) {
  return model.read({
    prompt: PROMPT,
    state: { read: 1, total: 1, unread: 0, delta: [], media } as never,
    options: TOKENS,
    mask: { act: { token: 'act', id: 1 }, ignore: { token: 'ignore', id: 2 } },
  });
}

test('a picture travels between the box text and the question, as a data URL', async () => {
  // The placement is the measured one: the replay put the message text first, the
  // image second and the question last, and read all 56 image cases to within 0.0011
  // of the recorded rig that way (`calibration/vision/server-transport-images.json`).
  const recorder = pictureServer();
  const model = llamaWatchModel(seeingServer(recorder));

  await askWith(model, [SHOT]);

  assert.equal(
    recorder.calls.filter((call) => call.path === '/completion').length,
    0,
    'a picture does not go through the endpoint that takes no projector',
  );
  const chat = recorder.calls.filter((call) => call.path === '/v1/chat/completions');
  assert.equal(chat.length, 1);

  const messages = chat[0].body.messages as { role: string; content: unknown }[];
  assert.deepEqual(messages[0], { role: 'system', content: ARTIFACT.system });

  const parts = messages[1].content as { type: string; text?: string; image_url?: { url: string } }[];
  assert.deepEqual(
    parts.map((part) => part.type),
    ['text', 'image_url', 'text'],
    'text, picture, question — in that order',
  );
  assert.equal(parts[0].text, 'Message: the batch failed\n');
  assert.equal(parts[2].text, 'Does this room need you to act? Answer act or ignore. ');

  const url = parts[1].image_url?.url ?? '';
  assert.ok(url.startsWith('data:image/png;base64,'), `expected a data URL, got ${url}`);
  assert.deepEqual(
    new Uint8Array(Buffer.from(url.slice('data:image/png;base64,'.length), 'base64')),
    PNG_BYTES,
    'the bytes the loader produced are the bytes the model is sent',
  );

  // Neutral samplers and `logprobs`, for the reason `/completion` gets them: the
  // estimator sums the raw softmax, so anything that truncates or reshapes it lies.
  const body = chat[0].body;
  assert.equal(body.max_tokens, 1);
  assert.equal(body.logprobs, true);
  assert.equal(body.top_logprobs, 64);
  assert.equal(body.cache_prompt, true);
  assert.equal(body.temperature, 1);
  assert.equal(body.top_k, 0);
  assert.equal(body.top_p, 1);
  assert.equal(body.min_p, 0);
  assert.equal(body.repeat_penalty, 1);
});

test('a picture reading is summed over the spellings of the option, as text is', async () => {
  const recorder = pictureServer({
    candidates: [
      { token: 'act', logprob: Math.log(0.6) },
      { token: ' Act', logprob: Math.log(0.3) },
      { token: 'ignore', logprob: Math.log(0.05) },
    ],
  });
  const model = llamaWatchModel(seeingServer(recorder));

  const reading = await askWith(model, [SHOT]);

  assert.ok(
    Math.abs((reading.probabilities[TOKENS.act] ?? 0) - 0.9) < 1e-9,
    'every candidate that spells the option counts, exactly as on the text path',
  );
  assert.ok(Math.abs((reading.probabilities[TOKENS.ignore] ?? 0) - 0.05) < 1e-9);
});

test('a picture with no way to read its bytes is refused, not judged from its caption', async () => {
  // `box.ts` keeps `key` opaque, so a transport with no loader cannot resolve one and
  // must not invent a path. The alternative is the defect row 22 was written for: a
  // verdict from the caption that looks like one reached with the picture present.
  const recorder = pictureServer();
  const model = llamaWatchModel(serverOf(recorder));

  await assert.rejects(
    () => askWith(model, [SHOT]),
    /carries a picture[\s\S]*image\/png[\s\S]*no way to read its bytes[\s\S]*loadMedia/,
  );
  assert.equal(recorder.calls.length, 0, 'nothing is asked about a picture that cannot travel');
});

test('a server with no projector is refused, and asked once rather than per judgement', async () => {
  // A server started without `--mmproj` reports `modalities.vision: false` and would
  // drop the image part on the way in, leaving a reading from the caption alone.
  const recorder = pictureServer({ modalities: { vision: false, video: false, audio: false } });
  const model = llamaWatchModel(seeingServer(recorder));

  await assert.rejects(() => askWith(model, [SHOT]), /reports no projector[\s\S]*modalities\.vision/);
  await assert.rejects(() => askWith(model, [SHOT]), /reports no projector/);

  assert.equal(
    recorder.calls.filter((call) => call.path === '/props').length,
    1,
    'whether a projector is loaded is a fact about the process, not about this tick',
  );
  assert.equal(
    recorder.calls.filter((call) => call.path === '/v1/chat/completions').length,
    0,
    'an image part into a server that cannot see is not a request worth making',
  );
});

test('a server too old to report its modalities is read as unable to see', async () => {
  const recorder = pictureServer({ modalities: undefined });
  const model = llamaWatchModel(seeingServer(recorder));

  await assert.rejects(() => askWith(model, [SHOT]), /reports no projector/);
});

test('two pictures are refused, because one per box is what was measured', async () => {
  // Every set in `calibration/vision/` holds one picture per box, so where a second
  // sits relative to the first was never replayed; dropping it would be the same
  // defect as dropping the only one.
  const recorder = pictureServer();
  const model = llamaWatchModel(seeingServer(recorder));

  await assert.rejects(
    () => askWith(model, [SHOT, { ...SHOT, key: 'blob/other.png' }]),
    /carries 2 pictures[\s\S]*measured on one per box/,
  );
  assert.equal(recorder.calls.length, 0);
});

test('a picture is refused when the turn did not come from this artifact', async () => {
  // The picture's place is the artifact's own last part, so a turn that does not end
  // with that part has no measured place for it — and guessing one would put the
  // image somewhere the replay never looked.
  const recorder = pictureServer();
  const model = llamaWatchModel(seeingServer(recorder));

  await assert.rejects(
    () =>
      model.read({
        prompt: {
          version: 'watch-v1',
          text: `${ARTIFACT.system}${ARTIFACT.afterSystem}Message: the batch failed\n`,
        },
        state: { read: 1, total: 1, unread: 0, delta: [], media: [SHOT] } as never,
        options: TOKENS,
        mask: { act: { token: 'act', id: 1 }, ignore: { token: 'ignore', id: 2 } },
      }),
    /different artifact[\s\S]*last part/,
  );
  assert.equal(recorder.calls.filter((call) => call.path === '/v1/chat/completions').length, 0);
});

test('a projector probe that failed once is asked again, not remembered as a no', async () => {
  // A server unreachable for one tick is not a server without a projector: caching
  // the failure would turn a blip into a permanent refusal of every picture.
  const answered = pictureServer({
    candidates: [
      { token: 'act', logprob: Math.log(0.9) },
      { token: 'ignore', logprob: Math.log(0.05) },
    ],
  });
  let probes = 0;
  const fetcher: Fetcher = async (url, init) => {
    if (new URL(url).pathname === '/props') {
      probes += 1;
      if (probes === 1) return { ok: false, status: 503, text: async () => 'not up yet' };
    }
    return answered.fetch(url, init);
  };
  const model = llamaWatchModel({
    ...serverOf({ fetch: fetcher }),
    loadMedia: async () => PNG_BYTES,
  });

  await assert.rejects(() => askWith(model, [SHOT]), /answered 503/);

  const reading = await askWith(model, [SHOT]);
  assert.ok((reading.probabilities[TOKENS.act] ?? 0) > 0.8, 'the second tick reads normally');
  assert.equal(probes, 2, 'the failed probe is not what the next judgement is told');
});

test('a box with no picture in it judges exactly as it did before', async () => {
  const recorder = renderingServer({ candidates: [
    { token: 'act', logprob: Math.log(0.9) },
    { token: 'ignore', logprob: Math.log(0.05) },
  ] });
  const model = llamaWatchModel(serverOf(recorder));

  const reading = await model.read({
    prompt: PROMPT,
    state: { read: 1, total: 1, unread: 0, delta: [], media: [] } as never,
    options: TOKENS,
    mask: { act: { token: 'act', id: 1 }, ignore: { token: 'ignore', id: 2 } },
  });

  assert.ok(
    (reading.probabilities[TOKENS.act] ?? 0) > 0.8,
    'the text-only path is untouched by the picture path',
  );
  assert.equal(recorder.calls.filter((call) => call.path === '/completion').length, 1);
  assert.equal(
    recorder.calls.filter((call) => call.path === '/v1/chat/completions').length,
    0,
    'a text-only judgement keeps the endpoint the text cut was measured through',
  );
  assert.equal(
    recorder.calls.filter((call) => call.path === '/props').length,
    0,
    'and pays for no projector probe it has no use for',
  );
});

test('the server shape records whether a projector is loaded', async () => {
  // `/props` reports `modalities: {vision, video, audio}`, and a server too old to
  // report it is read as unable to see — the safe way round, since nothing here can
  // send a picture anyway. The rest of the routes are present because the preflight
  // also renders the question and counts it against the window.
  const shapeOf = (modalities: unknown) => {
    const tokenise = makeVocab();
    return fakeServer({
      '/props': () => ({
        chat_template: 'a template',
        build_info: 'test',
        ...(modalities === undefined ? {} : { modalities }),
        default_generation_settings: { n_ctx: 4096 },
      }),
      '/apply-template': () => ({ prompt: `${TEMPLATE_HEAD}a question${TEMPLATE_TAIL}` }),
      '/tokenize': (body) => ({ tokens: tokenise(String(body.content)) }),
    });
  };

  const seen = await requireServerShape(
    serverOf(shapeOf({ vision: true, video: false, audio: false })),
    SKELETON,
  );
  assert.equal(seen.vision, true);
  assert.equal(seen.nCtx, 4096);
  assert.equal(seen.buildInfo, 'test');

  assert.equal(
    (await requireServerShape(serverOf(shapeOf({ vision: false })), SKELETON)).vision,
    false,
  );
  assert.equal(
    (await requireServerShape(serverOf(shapeOf(undefined)), SKELETON)).vision,
    false,
    'no modalities reported is read as no projector',
  );
});

test('a credential reaches every request, and a blank one is no credential at all', async () => {
  // Measured against the real binary rather than assumed: `llama-server --help` names
  // `--api-key KEY`, and a server started with it refuses a request that carries no
  // `Authorization` header. What this case pins is the other half — that the header goes
  // out on every call this file makes, `/props` included, and that a variable set to
  // nothing is absent rather than an empty `Bearer`. A blank credential is worse than
  // none: the 401 it earns reads like a wrong key rather than a missing one.
  const shapeOf = () =>
    fakeServer({
      '/props': () => ({
        chat_template: 'a template',
        build_info: 'test',
        default_generation_settings: { n_ctx: 4096 },
      }),
      '/apply-template': () => ({ prompt: `${TEMPLATE_HEAD}a question${TEMPLATE_TAIL}` }),
      '/tokenize': (body) => ({ tokens: makeVocab()(String(body.content)) }),
    });

  const cases: ReadonlyArray<{ said: string; key: string | undefined; sent: boolean }> = [
    { said: 'a key', key: 'sk-test-1234', sent: true },
    { said: 'an empty variable', key: '', sent: false },
    { said: 'a blank variable', key: '   ', sent: false },
    { said: 'no variable', key: undefined, sent: false },
  ];

  for (const { said, key, sent } of cases) {
    const recorder = shapeOf();
    const server: LlamaServer = {
      ...serverOf(recorder),
      ...(key === undefined ? {} : { apiKey: key }),
    };
    await requireServerShape(server, SKELETON);

    // Anti-vacuity: a preflight that made no call would satisfy every assertion below.
    assert.ok(recorder.calls.length > 0, `${said}: the preflight made a request`);
    for (const call of recorder.calls) {
      if (sent) {
        assert.equal(
          call.headers.Authorization,
          `Bearer ${key ?? ''}`,
          `${said}: ${call.path} carries the credential`,
        );
      } else {
        assert.equal(
          'Authorization' in call.headers,
          false,
          `${said}: ${call.path} carries no Authorization header at all`,
        );
      }
      assert.equal(call.headers['Content-Type'], 'application/json', `${said}: ${call.path} is JSON`);
    }
  }
});
