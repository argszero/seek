import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  chatTurn,
  llamaWatchModel,
  requireChatShape,
  requireDeclaredModel,
  requireWatchShape,
  type Fetcher,
  type LlamaServer,
} from './llama.ts';
import { declaredOptions, type OptionTokens } from './watch.ts';

/** One request the transport made, as the server saw it. */
interface Call {
  url: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A vocabulary that makes one word one token, so a cost is countable in a test. */
function makeVocab(): (content: string) => number[] {
  const ids = new Map<string, number>();
  let next = 100;
  return (content: string): number[] =>
    (content.match(/\s+|[^\s]+/g) ?? []).map((piece) => {
      const known = ids.get(piece);
      if (known !== undefined) return known;
      ids.set(piece, next);
      next += 1;
      return ids.get(piece) as number;
    });
}

const TEMPLATE_TAIL = '<|im_end|>\n<|im_start|>assistant\n';

/**
 * A server that answers by path and records what it was asked.
 *
 * A recorder rather than a live socket: what this file has to pin is the wire shape and the
 * refusals, and both are visible without a model. Every number quoted here as a claim about
 * llama.cpp was measured on the real binary first — the endpoint names, the two model names
 * in `/props`, `choice` being one half where the cut is 0.600, and `usage.output_tokens: 0`
 * on a decision.
 */
function fakeServer(
  handlers: Record<
    string,
    (body: Record<string, unknown>) => { ok?: false; status?: number; payload?: unknown }
  > = {},
): { fetch: Fetcher; calls: Call[] } {
  const tokenise = makeVocab();
  const calls: Call[] = [];
  const defaults: Record<string, (body: Record<string, unknown>) => { payload?: unknown }> = {
    '/props': () => ({
      payload: {
        chat_template: '<|im_start|>system\n{{ messages }}',
        build_info: 'b11946-test',
        model_alias: 'd1-2B',
        model_path: '/models/d1-2B-Q8_0.gguf',
        modalities: { vision: false, video: false, audio: false },
        default_generation_settings: { n_ctx: 8192 },
      },
    }),
    '/tokenize': (body) => ({ payload: { tokens: tokenise(String(body.content)) } }),
    '/apply-template': (body) => {
      const messages = body.messages as { role: string; content: string }[];
      const system = messages.find((one) => one.role === 'system')?.content ?? '';
      const user = messages.find((one) => one.role === 'user')?.content ?? '';
      return { payload: { prompt: `${system}\n\n${user}${TEMPLATE_TAIL}` } };
    },
    '/v1/systemone': () => ({
      payload: {
        answers: {
          respond: {
            type: 'choice',
            choice: 'act',
            probabilities: { act: 0.9026, ignore: 0.0974 },
            confidence: 0.9026,
          },
        },
        usage: { input_tokens: 81, output_tokens: 0 },
      },
    }),
    '/v1/chat/completions': () => ({
      payload: {
        choices: [{ message: { content: '', tool_calls: [] } }],
        usage: { prompt_tokens: 722, completion_tokens: 371 },
      },
    }),
    '/v1/models': () => ({ payload: { data: [{ id: 'deepseek-flash', context_window: 1048576 }] } }),
  };

  const fetcher: Fetcher = async (url, init) => {
    const path = new URL(url).pathname;
    const body =
      init.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>);
    calls.push({ url, path, method: init.method, headers: init.headers, body });
    const handler = handlers[path] ?? defaults[path];
    if (handler === undefined) {
      return { ok: false, status: 404, text: async () => 'no such route' };
    }
    const answer = handler(body);
    if (answer.ok === false) {
      return { ok: false, status: answer.status ?? 500, text: async () => 'refused' };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(answer.payload ?? {}) };
  };
  return { fetch: fetcher, calls };
}

function serverOf(recorder: { fetch: Fetcher }, extra: Partial<LlamaServer> = {}): LlamaServer {
  return { baseUrl: 'http://127.0.0.1:8080', fetch: recorder.fetch, ...extra };
}

const TOKENS: OptionTokens = declaredOptions();

/** A state and question in the shape `watch.ts` assembles, so a call is realistic. */
function ask(question = 'Should you respond to this?') {
  return {
    prompt: {
      version: 'test-v1',
      state: 'You are 小荷, one of the bots in this chat client.\n\n[2026-10-28] 邵安清: 来了',
      question: {
        instructions: question,
        criteria: {
          act: 'This message is for me — it asks me, or it is my job to handle it',
          ignore: 'This message is not for me — it is for someone else, or it is just chatter',
        },
      },
    },
    options: TOKENS,
  };
}

// ---------------------------------------------------------------------------
// The judgement: one forward pass, no text
// ---------------------------------------------------------------------------

test('a judgement is one call to the decision endpoint, carrying the state and the question', async () => {
  const recorder = fakeServer();
  const reading = await llamaWatchModel(serverOf(recorder)).read(ask());

  assert.deepEqual(
    recorder.calls.map((call) => call.path),
    ['/v1/systemone'],
    'one call, and not a completion with a sampled token after it',
  );
  const [call] = recorder.calls;
  assert.equal(call.method, 'POST');
  assert.equal(call.body.state, ask().prompt.state, 'the state travels verbatim');
  assert.deepEqual(call.body.questions, {
    respond: {
      type: 'choice',
      instructions: 'Should you respond to this?',
      criteria: ask().prompt.question.criteria,
    },
  });
  assert.deepEqual(reading.probabilities, { act: 0.9026, ignore: 0.0974 });
  assert.equal(reading.reason, undefined, 'a decision model writes no sentence, so none appears');
});

test('the probabilities are keyed by the option names the caller declared', async () => {
  const recorder = fakeServer({
    '/v1/systemone': () => ({
      payload: { answers: { respond: { probabilities: { respond: 0.8, silence: 0.2 } } } },
    }),
  });
  const input = ask();
  const reading = await llamaWatchModel(serverOf(recorder)).read({
    ...input,
    options: { act: 'respond', ignore: 'silence' },
  });

  assert.deepEqual(reading.probabilities, { respond: 0.8, silence: 0.2 });
});

test('a number that is not a probability is dropped, and the option left missing', async () => {
  // `watch.ts` reads a missing option as no answer at all. Dropping rather than throwing is
  // deliberate: a model that answered in a shape this file cannot read has still answered,
  // and the honest reading of that is "no answer that could be read".
  const cases: Record<string, unknown>[] = [
    { act: '0.9', ignore: 0.1 },
    { act: 1.4, ignore: 0.1 },
    { act: -0.2, ignore: 0.1 },
    { act: Number.NaN, ignore: 0.1 },
    { ignore: 0.1 },
  ];
  for (const probabilities of cases) {
    const recorder = fakeServer({
      '/v1/systemone': () => ({ payload: { answers: { respond: { probabilities } } } }),
    });
    const reading = await llamaWatchModel(serverOf(recorder)).read(ask());
    assert.equal(
      Object.hasOwn(reading.probabilities, 'act'),
      false,
      `${JSON.stringify(probabilities)} must not read as an act probability`,
    );
  }
});

test('an answer with no probabilities at all is an empty reading rather than an error', async () => {
  for (const payload of [{}, { answers: {} }, { answers: { respond: {} } }]) {
    const recorder = fakeServer({ '/v1/systemone': () => ({ payload }) });
    const reading = await llamaWatchModel(serverOf(recorder)).read(ask());
    assert.deepEqual(reading.probabilities, {}, JSON.stringify(payload));
  }
});

test('a transport failure throws, because a judgement that could not be asked is not an answer', async () => {
  const recorder = fakeServer({
    '/v1/systemone': () => ({ ok: false, status: 500, payload: undefined }),
  });
  await assert.rejects(
    () => llamaWatchModel(serverOf(recorder)).read(ask()),
    /answered 500 for \/v1\/systemone/,
  );
});

test('an answer that is not JSON throws rather than reading as no act', async () => {
  const fetcher: Fetcher = async (url) => {
    const path = new URL(url).pathname;
    return path === '/v1/systemone'
      ? { ok: true, status: 200, text: async () => 'not json at all' }
      : { ok: true, status: 200, text: async () => '{}' };
  };
  await assert.rejects(
    () => llamaWatchModel({ baseUrl: 'http://127.0.0.1:8080', fetch: fetcher }).read(ask()),
    /answered no JSON for \/v1\/systemone/,
  );
});

// ---------------------------------------------------------------------------
// The preflight the judgement needs, and the one it does not
// ---------------------------------------------------------------------------

test('a judgement’s preflight counts the state and never renders a template', async () => {
  const recorder = fakeServer();
  const shape = await requireWatchShape(serverOf(recorder), 'You are 小荷, one bot of this client.');

  assert.deepEqual(
    recorder.calls.map((call) => call.path),
    ['/props', '/tokenize'],
    'what the server is, then what the state costs',
  );
  assert.equal(recorder.calls[0].method, 'GET', '/props is registered for a GET');
  assert.equal(recorder.calls[1].body.content, 'You are 小荷, one bot of this client.');
  assert.equal(shape.nCtx, 8192);
  assert.equal(shape.buildInfo, 'b11946-test');
  assert.equal(shape.modelAlias, 'd1-2B');
  assert.equal(shape.modelPath, '/models/d1-2B-Q8_0.gguf');
});

test('a server with no chat template still passes the judgement’s preflight', async () => {
  // `/v1/systemone` applies the decision format internally, so the template is not this
  // half's business — asking for one would pass on the shipped model for a reason that has
  // nothing to do with the endpoint.
  const recorder = fakeServer({ '/props': () => ({ payload: { default_generation_settings: { n_ctx: 8192 } } }) });
  const shape = await requireWatchShape(serverOf(recorder), 'a state');
  assert.equal(shape.chatTemplate, '', 'absent is read as none, not as a guess');
});

test('a state larger than the window is refused, and the boundary is the token count', async () => {
  const probe = fakeServer();
  const state = 'one two three four';
  const spend = (state.match(/\s+|[^\s]+/g) ?? []).length;

  const exact = fakeServer({ '/props': () => ({ payload: { default_generation_settings: { n_ctx: spend } } }) });
  const shape = await requireWatchShape(serverOf(exact), state);
  assert.equal(shape.nCtx, spend, 'a state that exactly fits still fits: nothing is read after it');

  const small = fakeServer({ '/props': () => ({ payload: { default_generation_settings: { n_ctx: spend - 1 } } }) });
  await assert.rejects(
    () => requireWatchShape(serverOf(small), state),
    /allows \d+ tokens per prompt[\s\S]*larger `-c`/,
  );
  assert.ok(probe.calls.length === 0, 'and nothing of the probe above was needed');
});

test('a window that is missing, zero or fractional is refused rather than read as a number', async () => {
  for (const nCtx of [undefined, 0, 1.5, -1]) {
    const recorder = fakeServer({
      '/props': () => ({ payload: { chat_template: 'x', default_generation_settings: { n_ctx: nCtx } } }),
    });
    await assert.rejects(
      () => requireWatchShape(serverOf(recorder), 'a state'),
      /default_generation_settings\.n_ctx/,
      `n_ctx ${String(nCtx)} is not a window`,
    );
  }
});

test('a server with no chat template is refused for a generating turn, and asked once', async () => {
  // The half that writes is rendered through the server's template, so a server with none
  // reads a flat prompt and scores below chance — refused on what it says about itself,
  // before a token is counted.
  const recorder = fakeServer({ '/props': () => ({ payload: { default_generation_settings: { n_ctx: 8192 } } }) });
  await assert.rejects(
    () => requireChatShape(serverOf(recorder), { system: 's', user: 'u' }, 'the turn prompt'),
    /renders no chat template/,
  );
  assert.deepEqual(recorder.calls.map((call) => call.path), ['/props']);
});

test('a turn prompt that leaves no room to write is refused, on the templated bytes', async () => {
  const recorder = fakeServer();
  // Measured on the rendered prompt, not on the assembly: the template's own tail is what
  // the model is charged for, and the boundary here is `>=` rather than `>`.
  const rendered = await (async () => {
    const probe = fakeServer();
    const shape = await requireChatShape(
      serverOf(probe),
      { system: 'You are 小荷.', user: 'the batch failed' },
      'the turn prompt',
    );
    assert.equal(shape.nCtx, 8192);
    const counted = probe.calls.find((call) => call.path === '/tokenize');
    return String(counted?.body.content);
  })();
  const cost = (rendered.match(/\s+|[^\s]+/g) ?? []).length;
  assert.ok(rendered.endsWith(TEMPLATE_TAIL), 'counted after the template, where the model reads');
  assert.ok(cost > 1);

  const exact = fakeServer({ '/props': () => ({ payload: { chat_template: 'x', default_generation_settings: { n_ctx: cost } } }) });
  await assert.rejects(
    () => requireChatShape(serverOf(exact), { system: 'You are 小荷.', user: 'the batch failed' }, 'the turn prompt'),
    /no room left to write a single token/,
  );
  assert.ok(recorder.calls.length === 0);
});

// ---------------------------------------------------------------------------
// A hosted endpoint: which model it serves, per its own list
// ---------------------------------------------------------------------------

test('the declared model is confirmed against the endpoint’s own list, window and all', async () => {
  const recorder = fakeServer();
  const endpoint = await requireDeclaredModel(
    serverOf(recorder, { model: 'deepseek-flash', baseUrl: 'https://example.test/v1' }),
  );

  assert.deepEqual(recorder.calls.map((call) => call.path), ['/v1/models']);
  assert.equal(
    recorder.calls[0].url,
    'https://example.test/v1/models',
    'one trailing /v1 is trimmed, so a base_url with it addresses the same origin',
  );
  assert.deepEqual(endpoint, {
    model: 'deepseek-flash',
    served: ['deepseek-flash'],
    window: 1048576,
  });
});

test('a name the endpoint does not serve is refused with the names it does', async () => {
  const recorder = fakeServer();
  await assert.rejects(
    () => requireDeclaredModel(serverOf(recorder, { model: 'deepseek-flsh' })),
    /serves 'deepseek-flash' and not 'deepseek-flsh'/,
  );
});

test('an endpoint that answers no model list is refused, because a name it cannot confirm is not a name it may use', async () => {
  const recorder = fakeServer({ '/v1/models': () => ({ payload: {} }) });
  await assert.rejects(
    () => requireDeclaredModel(serverOf(recorder, { model: 'deepseek-flash' })),
    /answered no model list at \/v1\/models/,
  );
});

test('a model whose list entry declares no window does not get one invented', async () => {
  const recorder = fakeServer({
    '/v1/models': () => ({ payload: { data: [{ id: 'deepseek-flash' }] } }),
  });
  const endpoint = await requireDeclaredModel(serverOf(recorder, { model: 'deepseek-flash' }));
  assert.equal(endpoint.window, null, 'absent is absent, not a plausible number');
});

// ---------------------------------------------------------------------------
// The generating turn
// ---------------------------------------------------------------------------

test('a turn sends the model when the caller named one, and nothing when it did not', async () => {
  const named = fakeServer();
  await chatTurn(serverOf(named, { model: 'deepseek-flash' }), [
    { role: 'system', content: 'You are 小荷.' },
    { role: 'user', content: 'the batch failed' },
  ]);
  const [call] = named.calls;
  assert.equal(call.path, '/v1/chat/completions');
  assert.equal(call.body.model, 'deepseek-flash');
  assert.equal(call.body.temperature, 0, 'two runs of one prompt answer the same');
  assert.equal(call.body.tools, undefined, 'no tools, no tool_choice');
  assert.deepEqual(call.body.messages, [
    { role: 'system', content: 'You are 小荷.' },
    { role: 'user', content: 'the batch failed' },
  ]);

  const local = fakeServer();
  await chatTurn(serverOf(local), [{ role: 'user', content: 'hello' }]);
  assert.equal(
    Object.hasOwn(local.calls[0].body, 'model'),
    false,
    'a llama-server serves one model and is told nothing',
  );
});

test('tools travel in the OpenAI shape, with the choice left to the model', async () => {
  const recorder = fakeServer();
  await chatTurn(
    serverOf(recorder),
    [{ role: 'user', content: 'say hello' }],
    [{ name: 'say', description: 'post one message', parameters: { type: 'object' } }],
  );
  assert.deepEqual(recorder.calls[0].body.tools, [
    {
      type: 'function',
      function: {
        name: 'say',
        description: 'post one message',
        parameters: { type: 'object' },
      },
    },
  ]);
  assert.equal(recorder.calls[0].body.tool_choice, 'auto');
});

test('a turn reads both nestings of a tool call, because two builds have reported both', async () => {
  const recorder = fakeServer({
    '/v1/chat/completions': () => ({
      payload: {
        choices: [
          {
            message: {
              content: 'working on it',
              tool_calls: [
                { function: { name: 'say', arguments: '{"text":"hello"}' } },
                { name: 'say', arguments: { text: 'again' } },
              ],
            },
          },
        ],
      },
    }),
  });
  const turn = await chatTurn(serverOf(recorder), [{ role: 'user', content: 'go' }]);
  assert.equal(turn.content, 'working on it', "the model's own working record is kept, not sent");
  assert.deepEqual(turn.toolCalls, [
    { name: 'say', arguments: '{"text":"hello"}' },
    { name: 'say', arguments: '{"text":"again"}' },
  ]);
});

test('a turn that answered no choices is a request that arrived nowhere, and throws', async () => {
  const recorder = fakeServer({ '/v1/chat/completions': () => ({ payload: {} }) });
  await assert.rejects(
    () => chatTurn(serverOf(recorder), [{ role: 'user', content: 'go' }]),
    /answered no choices/,
  );
});

test('a tool call with no name is refused rather than skipped', async () => {
  const recorder = fakeServer({
    '/v1/chat/completions': () => ({
      payload: { choices: [{ message: { tool_calls: [{ arguments: '{}' }] } }] },
    }),
  });
  await assert.rejects(
    () => chatTurn(serverOf(recorder), [{ role: 'user', content: 'go' }]),
    /asked for a tool call with no name/,
  );
});

test('the usage the server reported is what a turn records, and half a report is none', async () => {
  const reported = fakeServer();
  const turn = await chatTurn(serverOf(reported), [{ role: 'user', content: 'go' }]);
  assert.deepEqual(turn.usage, { input_tokens: 722, output_tokens: 371 });

  for (const usage of [undefined, {}, { prompt_tokens: 12 }, { completion_tokens: 3 }]) {
    const recorder = fakeServer({
      '/v1/chat/completions': () => ({ payload: { choices: [{ message: { content: '' } }], usage } }),
    });
    const quiet = await chatTurn(serverOf(recorder), [{ role: 'user', content: 'go' }]);
    assert.equal(quiet.usage, null, `${JSON.stringify(usage)} is not a report of spend`);
  }
});

// ---------------------------------------------------------------------------
// What every request carries
// ---------------------------------------------------------------------------

test('a credential reaches every request, and a blank one is no credential at all', async () => {
  // Measured against the real binary rather than assumed: `llama-server --api-key KEY`
  // refuses a request with no `Authorization` header. A blank credential is worse than none:
  // the 401 it earns reads like a wrong key rather than a missing one.
  const cases: ReadonlyArray<{ said: string; key: string | undefined; sent: boolean }> = [
    { said: 'a key', key: 'sk-test-1234', sent: true },
    { said: 'an empty variable', key: '', sent: false },
    { said: 'a blank variable', key: '   ', sent: false },
    { said: 'no variable', key: undefined, sent: false },
  ];

  for (const { said, key, sent } of cases) {
    const recorder = fakeServer();
    const server = serverOf(recorder, key === undefined ? {} : { apiKey: key });
    await requireWatchShape(server, 'a state');
    await llamaWatchModel(server).read(ask());
    await chatTurn(server, [{ role: 'user', content: 'go' }]);

    // Anti-vacuity: a transport that made no call would satisfy every assertion below.
    assert.ok(recorder.calls.length >= 4, `${said}: the requests were made`);
    for (const call of recorder.calls) {
      assert.equal(
        call.headers['Content-Type'],
        'application/json',
        `${said}: ${call.path} is JSON`,
      );
      if (sent) {
        assert.equal(call.headers.Authorization, `Bearer ${key}`, `${said}: ${call.path} carries it`);
      } else {
        assert.equal(
          'Authorization' in call.headers,
          false,
          `${said}: ${call.path} carries no Authorization header at all`,
        );
      }
    }
  }
});
