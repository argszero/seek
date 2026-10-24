import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deliver } from './delivery.ts';
import { makeWorld } from './fixtures.ts';
import { bindOverServer, llamaWatchModel, strip, type Fetcher, type LlamaServer } from './llama.ts';
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
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ path, body });
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
