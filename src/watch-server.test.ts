import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deliver } from './delivery.ts';
import { makeWorld, type World } from './fixtures.ts';
import type { Fetcher, LlamaServer } from './llama.ts';
import type { PromptArtifact } from './prompts.ts';
import { watchOverServer } from './watch-server.ts';

// The artifact this file binds to: a small one in the shipped shape, with a cut of its
// own so a test can see which number was applied. What is being pinned here is the
// *order* of the steps and the wire shape, not the numbers — those were measured against
// the real binary (`calibration/set4-d1.json`).
const ARTIFACT: PromptArtifact = {
  version: 'test-v1',
  system: 'You are {bot}, one of the bots in this chat client.',
  afterSystem: '\n',
  parts: [
    { name: 'message', text: '\n[{at}] {sender}: {text}', after: '\n', when: 'always', each: 'observation' },
  ],
  question: {
    instructions: 'Should you respond to this?',
    criteria: {
      act: 'This message is for me — it asks me, or it is my job to handle it',
      ignore: 'This message is not for me — it is for someone else, or it is just chatter',
    },
  },
  operatingPoint: { threshold: 0.6, measuredOn: 'the suite' },
};

/** One request the transport made, as the server saw it. */
interface Call {
  path: string;
  method: string;
  body: Record<string, unknown>;
}

/**
 * A vocabulary that makes one word one token, so a skeleton costs a countable number of
 * tokens and a test can put a window just under it.
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
  return (content: string): number[] => (content.match(/\s+|[^\s]+/g) ?? []).map(idOf);
}

/**
 * A decision model that answers by path and records what it was asked.
 *
 * A recorder rather than a live socket: what this file has to pin is which requests
 * happen and in what order, and that is visible without a model. Nothing here starts a
 * process, and nothing waits on one.
 *
 * `/props` is the one answer a caller can shape, because what a server reports about
 * itself is what the preflight exists to refuse: `nCtx: null` is a server that will not
 * say how large its window is, and a small number is one that would truncate the state.
 * The same holds for the model it serves: by default this fake stands for the model
 * `makeWorld` gives the watch row — `'gate'` — and `modelAlias: null` / `modelPath: null`
 * is a server that names itself not at all, which is a different reading from one that
 * names another model.
 */
function fakeServer(
  options: {
    probabilities?: Record<string, number>;
    choice?: string;
    nCtx?: number | null;
    chatTemplate?: string;
    modelAlias?: string | null;
    modelPath?: string | null;
    failTokenise?: boolean;
    answer?: unknown;
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
        chat_template: options.chatTemplate ?? '<|im_start|>…',
        build_info: 'test build',
        ...(alias === null ? {} : { model_alias: alias }),
        ...(modelPath === null ? {} : { model_path: modelPath }),
        ...(nCtx === null ? {} : { default_generation_settings: { n_ctx: nCtx } }),
      };
    } else if (path === '/tokenize') {
      if (options.failTokenise) return { ok: false, status: 500, text: async () => 'no model' };
      payload = { tokens: tokenise(String(body.content)) };
    } else if (path === '/v1/systemone') {
      payload =
        options.answer ??
        {
          answers: {
            respond: {
              type: 'choice',
              choice: options.choice ?? 'act',
              probabilities: options.probabilities ?? { act: 0.9, ignore: 0.1 },
              confidence: 0.9,
            },
          },
          usage: { input_tokens: 81, output_tokens: 0 },
        };
    } else {
      return { ok: false, status: 404, text: async () => 'no such route' };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
  return { fetch: fetcher, calls };
}

function serverOf(recorder: { fetch: Fetcher }): LlamaServer {
  return { baseUrl: 'http://127.0.0.1:8080', fetch: recorder.fetch };
}

/** Standard normal form: a room with a message in it, and the entries it produced. */
async function entriesOf(world: World) {
  deliver(world.store, { roomId: world.room, senderId: world.me, text: 'the batch failed' });
  return world.store.drain(world.botA);
}

const PATHS = (recorder: { calls: Call[] }) => recorder.calls.map((call) => call.path);

test('the judge acts on an entry whose answer clears the artifact’s own cut', async () => {
  const world = makeWorld();
  const recorder = fakeServer({ probabilities: { act: 0.9, ignore: 0.1 } });
  const judge = await watchOverServer(world.store, world.botA, serverOf(recorder), {
    window: 10,
    prompt: ARTIFACT,
  });

  const acting = await judge(await entriesOf(world));

  assert.equal(acting.length, 1, 'the one entry the rules could not settle, and it acts');
  assert.equal(acting[0].verdict, 'act');
});

test('an answer below the cut settles the entry as ignore rather than acting', async () => {
  // The cut is the artifact's 0.6, not a number this file or the caller invented: 0.55
  // is under it, and the entry must not reach stage 2.
  const world = makeWorld();
  const recorder = fakeServer({ probabilities: { act: 0.55, ignore: 0.3 } });
  const judge = await watchOverServer(world.store, world.botA, serverOf(recorder), {
    window: 10,
    prompt: ARTIFACT,
  });

  const acting = await judge(await entriesOf(world));

  assert.deepEqual(acting, []);
  assert.equal(judge.last?.ignored, 1);
});

test('the probability is what is read, not the choice the endpoint labels the answer', async () => {
  // The endpoint also returns `choice`, and it is `act` exactly when the act probability is
  // at least one half. The cut is 0.600, not one half — measured: reading the probability
  // gets 23 of 24 on set4 where reading the label gets 20, and the shipped model answers
  // 0.700 on the one case the label would have called. So a body saying `choice: 'act'`
  // over `{act: 0.55}` must settle as ignore, or the cut is decoration.
  const world = makeWorld();
  const recorder = fakeServer({ probabilities: { act: 0.55, ignore: 0.45 }, choice: 'act' });
  const judge = await watchOverServer(world.store, world.botA, serverOf(recorder), {
    window: 10,
    prompt: ARTIFACT,
  });

  const acting = await judge(await entriesOf(world));
  assert.deepEqual(acting, [], '0.55 is below 0.600 whatever the label says');
});

test('the request is the endpoint’s own shape, and it carries the artifact’s question', async () => {
  // The wire shape is the contract with llama.cpp: `state`, then one named question of
  // type `choice` with a meaning per answer. Its keys inside `criteria` are the option
  // names the runtime reads the answer by, which is why the artifact and this file have
  // to agree on them (`questionOf`).
  const world = makeWorld();
  const recorder = fakeServer({ probabilities: { act: 0.2, ignore: 0.8 } });
  const judge = await watchOverServer(world.store, world.botA, serverOf(recorder), {
    window: 10,
    prompt: ARTIFACT,
  });
  await judge(await entriesOf(world));

  const asked = recorder.calls.find((call) => call.path === '/v1/systemone');
  assert.ok(asked, 'the judgement was one call to the decision endpoint');
  assert.equal(asked.method, 'POST');
  assert.deepEqual(Object.keys(asked.body).sort(), ['questions', 'state']);
  assert.equal(typeof asked.body.state, 'string');
  assert.deepEqual(asked.body.questions, {
    respond: {
      type: 'choice',
      instructions: 'Should you respond to this?',
      criteria: {
        act: 'This message is for me — it asks me, or it is my job to handle it',
        ignore: 'This message is not for me — it is for someone else, or it is just chatter',
      },
    },
  });
  // And the state is the assembled one: the bot named, the message read.
  assert.match(String(asked.body.state), /^You are A, one of the bots in this chat client\./);
  assert.match(String(asked.body.state), /the batch failed/);
});

test('the declared tokens are what travel to the model, and the answer is read by them', async () => {
  const world = makeWorld();
  const renamed: PromptArtifact = {
    ...ARTIFACT,
    question: {
      instructions: 'Is this for me?',
      criteria: { respond: 'yes, it is for me', silence: 'no, it is for someone else' },
    },
  };
  const recorder = fakeServer({ probabilities: { respond: 0.95, silence: 0.05 } });
  const judge = await watchOverServer(world.store, world.botA, serverOf(recorder), {
    window: 10,
    prompt: renamed,
    optionTokens: { act: 'respond', ignore: 'silence' },
  });

  const acting = await judge(await entriesOf(world));

  assert.equal(acting.length, 1, 'the reading is looked up under the declared token');
  const asked = recorder.calls.find((call) => call.path === '/v1/systemone');
  assert.deepEqual(Object.keys((asked?.body.questions as Record<string, { criteria: object }>)
    .respond.criteria), ['respond', 'silence']);
});

test('an answer that cannot be read counts as no act, and is counted apart', async () => {
  // §4: unparseable is no act. What this pins is that the wiring hands the runtime a real
  // reading rather than a stub that could not tell the two apart.
  const world = makeWorld();
  const recorder = fakeServer({ answer: { answers: { respond: { probabilities: {} } } } });
  const judge = await watchOverServer(world.store, world.botA, serverOf(recorder), {
    window: 10,
    prompt: ARTIFACT,
  });

  const acting = await judge(await entriesOf(world));

  assert.deepEqual(acting, []);
  assert.equal(judge.last?.unparsed, 1, 'the room was asked and the answer could not be read');
});

test('an endpoint that answers nothing at all is read as no answer, not as a verdict', async () => {
  const world = makeWorld();
  const recorder = fakeServer({ answer: { answers: {} } });
  const judge = await watchOverServer(world.store, world.botA, serverOf(recorder), {
    window: 10,
    prompt: ARTIFACT,
  });

  const acting = await judge(await entriesOf(world));
  assert.deepEqual(acting, []);
  assert.equal(judge.last?.unparsed, 1);
});

test('two options that are one name are refused, by the rule that already says so', async () => {
  const world = makeWorld();
  const recorder = fakeServer();
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
  const recorder = fakeServer({ failTokenise: true });

  await assert.rejects(
    () =>
      watchOverServer(world.store, world.botA, serverOf(recorder), {
        window: 10,
        prompt: ARTIFACT,
      }),
    /answered 500 for \/tokenize/,
  );
});

test('a judgement does not need a chat template, because no template renders it', async () => {
  // The half that generates is rendered through the server's template and refuses one with
  // none (`requireChatShape`). A judgement is not: `/v1/systemone` takes a `state` string
  // and applies the decision format the model was trained on. Refusing a template here
  // would pass on the shipped model for a reason that has nothing to do with this endpoint,
  // which is a check that reads like evidence and is not.
  const world = makeWorld();
  const recorder = fakeServer({ chatTemplate: '', probabilities: { act: 0.9, ignore: 0.1 } });

  const judge = await watchOverServer(world.store, world.botA, serverOf(recorder), {
    window: 10,
    prompt: ARTIFACT,
  });
  const acting = await judge(await entriesOf(world));
  assert.equal(acting.length, 1, 'and it judges all the same');
});

test('a window too small for the state alone is refused rather than truncated', async () => {
  // llama-server keeps `n_keep = 0` tokens from the front when it shifts a context, so the
  // line saying which bot is being asked is the first thing to go — and the reading that
  // comes back is still a number.
  const world = makeWorld();
  const recorder = fakeServer({ nCtx: 3 });

  await assert.rejects(
    () =>
      watchOverServer(world.store, world.botA, serverOf(recorder), {
        window: 10,
        prompt: ARTIFACT,
      }),
    /allows 3 tokens per prompt[\s\S]*larger `-c`/,
  );
});

test('a window that exactly holds the state is enough, because nothing is read after it', async () => {
  // The boundary the judgement half has and the generating half does not: a turn needs one
  // token left to write its first token in, while an answer here is a probability over
  // declared options and consumes no token at all.
  const world = makeWorld();
  const probe = fakeServer();
  await watchOverServer(world.store, world.botA, serverOf(probe), {
    window: 10,
    prompt: ARTIFACT,
  });
  const state = String(probe.calls.find((call) => call.path === '/tokenize')?.body.content);
  const cost = (state.match(/\s+|[^\s]+/g) ?? []).length;
  assert.ok(cost > 1, 'the state is more than one token, or this test pins nothing');

  const exact = fakeServer({ nCtx: cost });
  const judge = await watchOverServer(world.store, world.botA, serverOf(exact), {
    window: 10,
    prompt: ARTIFACT,
  });
  assert.equal(typeof judge, 'function', 'a state that exactly fits still fits');
});

test('a server that will not say how large its window is is refused', async () => {
  const world = makeWorld();
  for (const nCtx of [null, 0, 1.5]) {
    const recorder = fakeServer({ nCtx });
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

test('the server is asked what it is before the state is counted on it', async () => {
  const world = makeWorld();
  const recorder = fakeServer();
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
  assert.deepEqual(
    PATHS(recorder),
    ['/props', '/tokenize'],
    'the server is asked what it is first, then the smallest state is counted on it',
  );

  const acting = await judge(await entriesOf(world));
  assert.equal(acting.length, 1, 'and a server that passes the check still judges');
  assert.equal(PATHS(recorder).at(-1), '/v1/systemone', 'one call per judgement, and only one');
});

test('a judgement is measured once at construction, not re-measured per tick', async () => {
  const world = makeWorld();
  const recorder = fakeServer();
  const judge = await watchOverServer(world.store, world.botA, serverOf(recorder), {
    window: 10,
    prompt: ARTIFACT,
  });
  const before = recorder.calls.length;

  await judge(await entriesOf(world));
  deliver(world.store, { roomId: world.room, senderId: world.me, text: 'and again' });
  await judge(await world.store.drain(world.botA));

  assert.deepEqual(
    PATHS(recorder).slice(before),
    ['/v1/systemone', '/v1/systemone'],
    'the preflight is not repeated: a tick costs one forward pass and nothing else',
  );
});

test('a roster that names the model the server serves is accepted, by either of its names', async () => {
  // The server reports two strings for the same model — what it answers to and the weights
  // it loaded — and both are the model itself (`ServerShape`, measured on the real binary).
  // So a roster may name either, and a check that read only one would refuse a correct
  // roster half the time.
  for (const declared of ['gate', '/models/gate.gguf']) {
    const world = makeWorld();
    world.store.data.agents[world.agentA1].model = declared;
    const recorder = fakeServer();

    const judge = await watchOverServer(world.store, world.botA, serverOf(recorder), {
      window: 10,
      prompt: ARTIFACT,
    });
    assert.equal(typeof judge, 'function', `'${declared}' is this server's own name for itself`);
  }
});

test('a roster that names a model the server does not serve is refused, before anything is asked', async () => {
  // The claim the roster makes and the fact the server states, side by side. The cut is
  // calibrated against one model, so a judgement from another is not the same measurement —
  // and it would arrive looking exactly like one.
  const world = makeWorld();
  world.store.data.agents[world.agentA1].model = 'd1-2B';
  const recorder = fakeServer({
    modelAlias: 'qwen3',
    modelPath: '/models/qwen3-0.8b.gguf',
  });

  await assert.rejects(
    () =>
      watchOverServer(world.store, world.botA, serverOf(recorder), {
        window: 10,
        prompt: ARTIFACT,
      }),
    /the roster's watch row declares model 'd1-2B' but this server serves 'qwen3' \/ '\/models\/qwen3-0\.8b\.gguf'/,
  );
  assert.deepEqual(
    PATHS(recorder),
    ['/props', '/tokenize'],
    'no judgement is asked of a server serving another model',
  );
});

test('a roster row that names no model is not a claim, so nothing is compared', async () => {
  // `unset` is the roster's default and the shipped row's state: the file has no standing
  // to pick a model (checklist line 26), so it must not be read as one that disagrees with
  // whatever is in front of the port.
  const world = makeWorld();
  world.store.data.agents[world.agentA1].model = 'unset';
  const recorder = fakeServer({
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
  // Silence is not agreement: an absent name is an absent answer, never the roster's. A
  // server that cannot say which model it serves cannot confirm that it is the one the
  // roster named, and treating that as a pass is the silent lie this check exists to stop.
  const world = makeWorld();
  const recorder = fakeServer({ modelAlias: null, modelPath: null });

  await assert.rejects(
    () =>
      watchOverServer(world.store, world.botA, serverOf(recorder), {
        window: 10,
        prompt: ARTIFACT,
      }),
    /declares model 'gate' and this server names no model at all/,
  );
});
