import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deliver } from './delivery.ts';
import { makeWorld, type World } from './fixtures.ts';
import type { Fetcher, LlamaServer } from './llama.ts';
import type { PromptArtifact } from './prompts.ts';
import { watchOverServer } from './watch-server.ts';

// The artifact this file binds to. Its head is what splits the system message from
// the user turn, its question is what the option ids are measured at, and its
// trailing space is the boundary the option is appended at — the three facts the
// shipped `watch-v1.json` states and the cut was measured with.
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

/** One request the transport made, as the server saw it. */
interface Call {
  path: string;
  body: Record<string, unknown>;
}

/** The template this fake model uses: a fixed head and tail, so the ends are stable. */
const TEMPLATE_HEAD = '<|im_start|>system\n';
const TEMPLATE_MID = '<|im_end|>\n<|im_start|>user\n';
const TEMPLATE_TAIL = '<|im_end|>\n<|im_start|>assistant\n';

/**
 * A vocabulary that makes one word one token.
 *
 * Whitespace runs and words are separate pieces, so appending `act` to a text ending
 * in a newline yields exactly one new token — the property an option must have before
 * it can carry a probability (§4). What is being pinned here is the *order* of the
 * three steps, not the numbers, which were measured against the real binary
 * (`calibration/vision/server-transport.json`).
 */
function makeVocab(): (content: string) => number[] {
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
    return pieces.map((piece) => idOf(piece));
  };
}

/**
 * A server that answers by path and records what it was asked.
 *
 * A recorder rather than a live socket: what this file has to pin is which requests
 * happen and in what order, and that is visible without a model. Nothing here starts
 * a process, and nothing waits on one.
 */
function fakeServer(
  options: { candidates?: unknown[]; failTemplate?: boolean } = {},
): { fetch: Fetcher; calls: Call[] } {
  const tokenise = makeVocab();
  const calls: Call[] = [];
  const fetcher: Fetcher = async (url, init) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ path, body });
    let payload: unknown;
    if (path === '/apply-template') {
      if (options.failTemplate) {
        return { ok: false, status: 500, text: async () => 'no model loaded' };
      }
      const messages = body.messages as { role: string; content: string }[];
      const system = messages.find((m) => m.role === 'system')?.content ?? '';
      const user = messages.find((m) => m.role === 'user')?.content ?? '';
      payload = { prompt: `${TEMPLATE_HEAD}${system}${TEMPLATE_MID}${user}${TEMPLATE_TAIL}` };
    } else if (path === '/tokenize') {
      payload = { tokens: tokenise(String(body.content)) };
    } else if (path === '/completion') {
      payload = { completion_probabilities: [{ top_logprobs: options.candidates ?? [] }] };
    } else {
      return { ok: false, status: 404, text: async () => 'no such route' };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
  return { fetch: fetcher, calls };
}

function serverOf(recorder: { fetch: Fetcher }, artifact: PromptArtifact = ARTIFACT): LlamaServer {
  return { baseUrl: 'http://127.0.0.1:8080', artifact, fetch: recorder.fetch };
}

/** The reading a fixed cut has to be compared against: one `act`, one `ignore`. */
const ACTS = [
  { token: 'act', logprob: Math.log(0.9) },
  { token: 'ignore', logprob: Math.log(0.05) },
];

/** Standard normal form: a room with a message in it, and the entries it produced. */
async function entriesOf(world: World) {
  deliver(world.store, { roomId: world.room, senderId: world.me, text: 'the batch failed' });
  return world.store.drain(world.botA);
}

test('the judge acts on an entry whose answer clears the artifact’s own cut', async () => {
  const world = makeWorld();
  const recorder = fakeServer({ candidates: ACTS });
  const judge = await watchOverServer(world.store, world.botA, serverOf(recorder), {
    window: 10,
    prompt: ARTIFACT,
  });

  const acting = await judge(await entriesOf(world));

  assert.equal(acting.length, 1, 'the one entry the rules could not settle, and it acts');
  assert.equal(acting[0].verdict, 'act');
});

test('an answer below the cut settles the entry as ignore rather than acting', async () => {
  // The cut is the artifact's 0.6, not a number this file or the caller invented:
  // 0.55 is under it, and the entry must not reach stage 2.
  const world = makeWorld();
  const recorder = fakeServer({
    candidates: [
      { token: 'act', logprob: Math.log(0.55) },
      { token: 'ignore', logprob: Math.log(0.3) },
    ],
  });
  const judge = await watchOverServer(world.store, world.botA, serverOf(recorder), {
    window: 10,
    prompt: ARTIFACT,
  });

  const acting = await judge(await entriesOf(world));

  assert.deepEqual(acting, []);
  assert.equal(judge.last?.ignored, 1);
});

test('the ids are measured at construction, past the template, before anything is asked', async () => {
  const world = makeWorld();
  const recorder = fakeServer({ candidates: ACTS });

  await watchOverServer(world.store, world.botA, serverOf(recorder), {
    window: 10,
    prompt: ARTIFACT,
  });

  const templates = recorder.calls.filter((call) => call.path === '/apply-template');
  const tokenised = recorder.calls.filter((call) => call.path === '/tokenize');
  assert.equal(templates.length, 1, 'the template is rendered once, to find the answer’s end');
  assert.equal(tokenised.length, 3, 'the prompt and its two suffixes, once each');
  assert.equal(
    recorder.calls.filter((call) => call.path === '/completion').length,
    0,
    'no judgement was asked for yet',
  );
  for (const call of tokenised) {
    assert.ok(
      String(call.body.content).includes(TEMPLATE_TAIL),
      'measured where the model reads, not where the assembly ends',
    );
  }
});

test('a judgement does not re-measure the ids it already knows', async () => {
  const world = makeWorld();
  const recorder = fakeServer({ candidates: ACTS });
  const judge = await watchOverServer(world.store, world.botA, serverOf(recorder), {
    window: 10,
    prompt: ARTIFACT,
  });
  const before = recorder.calls.filter((call) => call.path === '/tokenize').length;

  await judge(await entriesOf(world));

  assert.equal(
    recorder.calls.filter((call) => call.path === '/tokenize').length,
    before,
    'the binding is measured once, not per tick',
  );
  assert.equal(
    recorder.calls.filter((call) => call.path === '/completion').length,
    1,
    'one forward pass for the judgement',
  );
});

test('the declared tokens are what travel to the model', async () => {
  // Not cosmetic: the option ids are measured on the tokens this runtime declares,
  // so a mask taken for `act`/`ignore` and a question asking `yes`/`no` would look
  // like a model that never fires.
  const world = makeWorld();
  const recorder = fakeServer({
    candidates: [
      { token: 'yes', logprob: Math.log(0.9) },
      { token: 'no', logprob: Math.log(0.05) },
    ],
  });
  const judge = await watchOverServer(world.store, world.botA, serverOf(recorder), {
    window: 10,
    prompt: ARTIFACT,
    optionTokens: { act: 'yes', ignore: 'no' },
  });

  const acting = await judge(await entriesOf(world));

  assert.equal(acting.length, 1, 'the reading is looked up under the declared token');
});

test('an answer that cannot be read counts as no act, and is counted apart', async () => {
  // §4: unparseable is no act. What this pins is that the wiring hands the runtime a
  // real reading rather than a stub that could not tell the two apart.
  const world = makeWorld();
  const recorder = fakeServer({ candidates: [] });
  const judge = await watchOverServer(world.store, world.botA, serverOf(recorder), {
    window: 10,
    prompt: ARTIFACT,
  });

  const acting = await judge(await entriesOf(world));

  assert.deepEqual(acting, []);
  assert.equal(judge.last?.unparsed, 1, 'the room was asked and the answer could not be read');
});

test('a server bound to a different question is refused before a verdict is spent', async () => {
  // Two artifacts whose questions differ are two questions. Silently measuring the
  // mask under one and asking the other is the unreachable-option failure, whose only
  // symptom is a bot that never acts — so it is refused here, with nothing sent.
  const other: PromptArtifact = {
    ...ARTIFACT,
    parts: ARTIFACT.parts.map((part) =>
      part.name === 'question'
        ? { ...part, text: 'Is this about deployment? Answer act or ignore.' }
        : part,
    ),
  };
  const world = makeWorld();
  const recorder = fakeServer({ candidates: ACTS });

  await assert.rejects(
    () =>
      watchOverServer(world.store, world.botA, serverOf(recorder, other), {
        window: 10,
        prompt: ARTIFACT,
      }),
    /ask different questions/,
  );
  assert.equal(recorder.calls.length, 0, 'nothing is asked of a server bound to another question');
});

test('two options that are one token are refused, by the rule that already says so', async () => {
  const world = makeWorld();
  const recorder = fakeServer({ candidates: ACTS });

  await assert.rejects(
    () =>
      watchOverServer(world.store, world.botA, serverOf(recorder), {
        window: 10,
        prompt: ARTIFACT,
        optionTokens: { act: 'act', ignore: 'act' },
      }),
    /must be different tokens/,
  );
  assert.equal(recorder.calls.length, 0);
});

test('a transport failure surfaces at construction, so no half-built judge is handed over', async () => {
  const world = makeWorld();
  const recorder = fakeServer({ failTemplate: true });

  await assert.rejects(
    () =>
      watchOverServer(world.store, world.botA, serverOf(recorder), {
        window: 10,
        prompt: ARTIFACT,
      }),
    /answered 500 for \/apply-template/,
  );
});
