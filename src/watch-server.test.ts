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
  method: string;
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
 *
 * `/props` is the one answer a caller can shape here, because what a server reports
 * about itself is what the preflight exists to refuse:
 * an empty `chatTemplate` is a server that will read a flat prompt, `nCtx: null` is
 * one that will not say how large its window is, and a small number is one that would
 * truncate the question. The same holds for the model it serves: by
 * default this fake stands for the model `makeWorld` gives the watch row — `'gate'` —
 * and `modelAlias: null` / `modelPath: null` is a server that names itself not at
 * all, which is a different reading from one that names another model.
 */
function fakeServer(
  options: {
    candidates?: unknown[];
    failTemplate?: boolean;
    chatTemplate?: string;
    nCtx?: number | null;
    modelAlias?: string | null;
    modelPath?: string | null;
  } = {},
): { fetch: Fetcher; calls: Call[] } {
  const tokenise = makeVocab();
  const calls: Call[] = [];
  const fetcher: Fetcher = async (url, init) => {
    const path = new URL(url).pathname;
    const body =
      init.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>);
    calls.push({ path, method: init.method, body });
    let payload: unknown;
    if (path === '/props') {
      const nCtx = options.nCtx === undefined ? 4096 : options.nCtx;
      const alias = options.modelAlias === undefined ? 'gate' : options.modelAlias;
      const modelPath = options.modelPath === undefined ? '/models/gate.gguf' : options.modelPath;
      payload = {
        chat_template: options.chatTemplate ?? TEMPLATE_HEAD,
        build_info: 'test build',
        ...(alias === null ? {} : { model_alias: alias }),
        ...(modelPath === null ? {} : { model_path: modelPath }),
        ...(nCtx === null ? {} : { default_generation_settings: { n_ctx: nCtx } }),
      };
    } else if (path === '/apply-template') {
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
  assert.equal(
    templates.length,
    2,
    'the question is rendered once to check the server can hold it, once to find the answer’s end',
  );
  assert.equal(tokenised.length, 4, 'the question, then the prompt and its two suffixes, once each');
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

test('a server that renders no chat template is refused, because a flat prompt scores below chance', async () => {
  // AUC 0.469, `act` 0/12 measured (`calibration/vision/remeasured.json`): the answer
  // still comes back as a distribution over the two options, which is why nothing
  // downstream can notice. It is refused on what the server says about itself.
  const world = makeWorld();
  const recorder = fakeServer({ candidates: ACTS, chatTemplate: '' });

  await assert.rejects(
    () =>
      watchOverServer(world.store, world.botA, serverOf(recorder), {
        window: 10,
        prompt: ARTIFACT,
      }),
    /renders no chat template/,
  );
  assert.deepEqual(
    recorder.calls.map((call) => call.path),
    ['/props'],
    'refused before a prompt is rendered on it, and long before an id is measured',
  );
});

test('a window too small for the question alone is refused rather than truncated', async () => {
  // llama-server keeps `n_keep = 0` tokens from the front when it shifts a context, so
  // the system line the measured shape begins with is the first thing to go and the
  // reading that comes back is still a number.
  const world = makeWorld();
  const recorder = fakeServer({ candidates: ACTS, nCtx: 3 });

  await assert.rejects(
    () =>
      watchOverServer(world.store, world.botA, serverOf(recorder), {
        window: 10,
        prompt: ARTIFACT,
      }),
    /allows 3 tokens per prompt[\s\S]*larger `-c`/,
  );
});

test('a server that will not say how large its window is is refused', async () => {
  const world = makeWorld();
  const recorder = fakeServer({ candidates: ACTS, nCtx: null });

  await assert.rejects(
    () =>
      watchOverServer(world.store, world.botA, serverOf(recorder), {
        window: 10,
        prompt: ARTIFACT,
      }),
    /default_generation_settings\.n_ctx/,
  );
});

test('the server is asked what it is before an id is measured on it', async () => {
  const world = makeWorld();
  const recorder = fakeServer({ candidates: ACTS });
  const judge = await watchOverServer(world.store, world.botA, serverOf(recorder), {
    window: 10,
    prompt: ARTIFACT,
  });

  const props = recorder.calls.find((call) => call.path === '/props');
  assert.equal(
    props?.method,
    'GET',
    'read rather than configured: a POST to /props is the other endpoint, and needs `--props`',
  );
  assert.equal(recorder.calls[0].path, '/props', 'the first thing asked of a server is what it is');

  const acting = await judge(await entriesOf(world));
  assert.equal(acting.length, 1, 'and a server that passes the check still judges');
  assert.equal(acting[0].verdict, 'act');
});

test('a window that fits the question but not its answer is refused, and one token more is enough', async () => {
  // The answer is read from the token after the prompt, so a window of exactly the
  // question's own cost overflows on the read. The boundary is pinned from the count
  // the transport itself asked for, rather than from a number copied out of it.
  const world = makeWorld();
  const probe = fakeServer({ candidates: ACTS });
  await watchOverServer(world.store, world.botA, serverOf(probe), {
    window: 10,
    prompt: ARTIFACT,
  });
  const question = probe.calls.find((call) => call.path === '/tokenize')?.body.content;
  const cost = (String(question).match(/\s+|[^\s]+/g) ?? []).length;
  assert.ok(cost > 1, 'the question is more than one token, or this test pins nothing');

  const exact = fakeServer({ candidates: ACTS, nCtx: cost });
  await assert.rejects(
    () =>
      watchOverServer(world.store, world.botA, serverOf(exact), {
        window: 10,
        prompt: ARTIFACT,
      }),
    /allows \d+ tokens per prompt/,
  );

  const justEnough = fakeServer({ candidates: ACTS, nCtx: cost + 1 });
  const judge = await watchOverServer(world.store, world.botA, serverOf(justEnough), {
    window: 10,
    prompt: ARTIFACT,
  });
  assert.equal(typeof judge, 'function', 'one token of room for the answer is room enough');
});

test('a window that is zero or fractional is refused rather than read as a number', async () => {
  const world = makeWorld();
  for (const nCtx of [0, 1.5]) {
    const recorder = fakeServer({ candidates: ACTS, nCtx });
    await assert.rejects(
      () =>
        watchOverServer(world.store, world.botA, serverOf(recorder), {
          window: 10,
          prompt: ARTIFACT,
        }),
      /default_generation_settings\.n_ctx/,
      `n_ctx ${nCtx} is not a window`,
    );
  }
});

test('a roster that names the model the server serves is accepted, by either of its names', async () => {
  // The server reports two strings for the same model — what it answers to and the
  // weights it loaded — and both are the model itself (`ServerShape`, measured on the
  // real binary). So a roster may name either, and a check that read only one would
  // refuse a correct roster half the time.
  for (const declared of ['gate', '/models/gate.gguf']) {
    const world = makeWorld();
    world.store.data.agents[world.agentA1].model = declared;
    const recorder = fakeServer({ candidates: ACTS });

    const judge = await watchOverServer(world.store, world.botA, serverOf(recorder), {
      window: 10,
      prompt: ARTIFACT,
    });
    assert.equal(typeof judge, 'function', `'${declared}' is this server's own name for itself`);
  }
});

test('a roster that names a model the server does not serve is refused, before anything is measured', async () => {
  // The claim the roster makes and the fact the server states, side by side. The cut
  // is calibrated against one model, so a judgement from another is not the same
  // measurement — and it would arrive looking exactly like one.
  const world = makeWorld();
  world.store.data.agents[world.agentA1].model = 'LFM2.5-VL-3B';
  const recorder = fakeServer({
    candidates: ACTS,
    modelAlias: 'qwen3',
    modelPath: '/models/qwen3-0.8b.gguf',
  });

  await assert.rejects(
    () =>
      watchOverServer(world.store, world.botA, serverOf(recorder), {
        window: 10,
        prompt: ARTIFACT,
      }),
    /the roster's watch row declares model 'LFM2\.5-VL-3B' but this server serves 'qwen3' \/ '\/models\/qwen3-0\.8b\.gguf'/,
  );
  // Refused on what the server already said about itself: `/props`, then the shape's
  // own template and window reading, and nothing that would produce a number.
  assert.deepEqual(
    recorder.calls.map((call) => call.path),
    ['/props', '/apply-template', '/tokenize'],
    'no answer is asked of a server serving another model',
  );
});

test('a roster row that names no model is not a claim, so nothing is compared', async () => {
  // `unset` is the roster's default and the shipped row's state: the file has no
  // standing to pick a model (checklist line 26), so it must not be read as one that
  // disagrees with whatever is in front of the port.
  const world = makeWorld();
  world.store.data.agents[world.agentA1].model = 'unset';
  const recorder = fakeServer({
    candidates: ACTS,
    modelAlias: 'qwen3',
    modelPath: '/models/qwen3-0.8b.gguf',
  });

  const judge = await watchOverServer(world.store, world.botA, serverOf(recorder), {
    window: 10,
    prompt: ARTIFACT,
  });
  assert.equal(typeof judge, 'function', 'no claim, nothing to confirm, nothing to refuse');
});

test('a server that names itself not at all cannot confirm a claim, so it is refused', async () => {
  // Silence is not agreement — the direction `visionOf` reads `modalities` in. A
  // server that cannot say which model it serves cannot confirm that it is the one
  // the roster named, and treating that as a pass is the silent lie this check exists
  // to stop.
  const world = makeWorld();
  const recorder = fakeServer({ candidates: ACTS, modelAlias: null, modelPath: null });

  await assert.rejects(
    () =>
      watchOverServer(world.store, world.botA, serverOf(recorder), {
        window: 10,
        prompt: ARTIFACT,
      }),
    /declares model 'gate' and this server names no model at all/,
  );
});
