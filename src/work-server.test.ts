import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { deliver } from './delivery.ts';
import { makeWorld, type World } from './fixtures.ts';
import type { Fetcher, LlamaServer } from './llama.ts';
import { loadWorkArtifact, type WorkArtifact } from './prompts.ts';
import { parseRoster } from './roster.ts';
import { runTurn } from './turn.ts';
import type { Id, Observation } from './types.ts';
import { workOverServer } from './work-server.ts';

// The shipped artifact, loaded rather than written out here: what this file has to
// pin is that *that* file is the one the runtime speaks through, and a copy pasted
// into a test would keep passing after the real file changed under it.
const ARTIFACT = loadWorkArtifact();

/** One request the transport made, as the server saw it. */
interface Call {
  path: string;
  method: string;
  body: Record<string, unknown>;
}

/**
 * A server that answers by path and records what it was asked.
 *
 * A recorder rather than a live socket, for the reason the watch test gives: what
 * needs pinning is which requests happen and in what order, and that is visible
 * without a model. Nothing here starts a process and nothing waits on one.
 *
 * `/v1/chat/completions` is the one answer a caller shapes — it *is* the model's
 * reply — so the generated text, the tool calls and the usage block are the three knobs
 * here. `/props` defaults to serving `big`, which is the model `makeWorld` puts on the
 * work row: the default has to be a server that *passes* the roster check, or every
 * other test here would be measuring the refusal.
 */
function fakeServer(
  options: {
    content?: string;
    toolCalls?: unknown[];
    /**
     * The `usage` block this server reports, left out by default.
     *
     * Absent is the interesting default: a real llama-server reports one, but a
     * recorder that always did would leave "a server that says nothing about spend"
     * untestable, and that is the case the kernel must not fill in with a zero.
     */
    usage?: unknown;
    nCtx?: number;
    modelAlias?: string | null;
    modelPath?: string | null;
  } = {},
): { fetch: Fetcher; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher: Fetcher = async (url, init) => {
    const path = new URL(url).pathname;
    const body =
      init.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>);
    calls.push({ path, method: init.method, body });
    let payload: unknown;
    if (path === '/props') {
      const alias = options.modelAlias === undefined ? 'big' : options.modelAlias;
      const modelPath =
        options.modelPath === undefined ? '/models/big.gguf' : options.modelPath;
      payload = {
        chat_template: '<|im_start|>system\n',
        build_info: 'test build',
        default_generation_settings: { n_ctx: options.nCtx ?? 4096 },
        ...(alias === null ? {} : { model_alias: alias }),
        ...(modelPath === null ? {} : { model_path: modelPath }),
      };
    } else if (path === '/apply-template') {
      const messages = body.messages as { role: string; content: string }[];
      const system = messages.find((m) => m.role === 'system')?.content ?? '';
      const user = messages.find((m) => m.role === 'user')?.content ?? '';
      payload = { prompt: `<|im_start|>system\n${system}<|im_end|>\n<|im_start|>user\n${user}` };
    } else if (path === '/tokenize') {
      // One token per whitespace piece, which is enough for a window check: what is
      // being pinned is that the check runs and refuses, not a tokeniser's arithmetic.
      payload = { tokens: String(body.content).split(/\s+/).filter(Boolean).map((_, i) => i) };
    } else if (path === '/v1/chat/completions') {
      payload = {
        choices: [
          {
            message: {
              content: options.content ?? '',
              ...(options.toolCalls === undefined ? {} : { tool_calls: options.toolCalls }),
            },
          },
        ],
        ...(options.usage === undefined ? {} : { usage: options.usage }),
      };
    } else {
      return { ok: false, status: 404, text: async () => 'no such route' };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
  return { fetch: fetcher, calls };
}

function serverOf(recorder: { fetch: Fetcher }): LlamaServer {
  // `artifact` is the *watch* artifact a server carries; stage 2 reads it for nothing.
  // The field is required by the type (`llama.ts`: it says where the watch assembly's
  // system line ends), and a turn never consults it.
  return {
    baseUrl: 'http://127.0.0.1:8080',
    artifact: {
      version: 'unused',
      system: 'unused',
      afterSystem: '',
      parts: [{ name: 'q', text: 'unused', after: ' ', when: 'always' }],
      operatingPoint: { threshold: 0.6, measuredOn: 'unused' },
    },
    fetch: recorder.fetch,
  };
}

/** A say call as a model writes one. */
function sayCall(room: Id, text: string): unknown {
  return { function: { name: 'say', arguments: JSON.stringify({ room, text }) } };
}

/** Standard normal form: a room with one message in it, and the entries it produced. */
async function entriesOf(world: World, text = 'the batch failed'): Promise<Observation[]> {
  deliver(world.store, { roomId: world.room, senderId: world.me, text });
  return world.store.drain(world.botA);
}

/** Run one turn of A's work agent with this decision, and report what it said. */
async function turnWith(world: World, decide: Awaited<ReturnType<typeof workOverServer>>, entries: Observation[]) {
  return runTurn(
    world.store,
    { agentId: world.agentA2, roomId: world.room, entries },
    decide,
  );
}

test('the tool call is what posts the message, and the model is the one who chose it', async () => {
  const world = makeWorld();
  const recorder = fakeServer({
    toolCalls: [sayCall(world.room, 'the batch failed on the retry queue')],
  });
  const decide = await workOverServer(world.store, world.botA, serverOf(recorder), {
    prompt: ARTIFACT,
  });

  const record = await turnWith(world, decide, await entriesOf(world));

  assert.equal(record.produced.length, 1, 'one call, one message');
  assert.equal(record.produced[0].text, 'the batch failed on the retry queue');
  assert.equal(record.produced[0].room_id, world.room);
  assert.equal(record.produced[0].agent_id, world.agentA2, 'it spoke as the work agent');

  // And the tools were declared to the model, out of the artifact rather than out of
  // this file: a turn that offered nothing could not have produced that call.
  const chat = recorder.calls.find((call) => call.path === '/v1/chat/completions');
  assert.ok(chat, 'the model was asked');
  const tools = chat.body.tools as { function: { name: string } }[];
  assert.deepEqual(
    tools.map((tool) => tool.function.name),
    ARTIFACT.tools.map((tool) => tool.name),
  );
});

test('a turn whose model calls nothing says nothing — silence is the default', async () => {
  const world = makeWorld();
  const recorder = fakeServer({ content: 'Nothing here needs me.' });
  const decide = await workOverServer(world.store, world.botA, serverOf(recorder), {
    prompt: ARTIFACT,
  });

  const record = await turnWith(world, decide, await entriesOf(world));

  assert.deepEqual(record.produced, [], 'a turn that says nothing is a finished turn');
});

test('the text the model wrote beside its call never reaches the room', async () => {
  const world = makeWorld();
  const recorder = fakeServer({
    // A model narrating what it is about to do, which is exactly the shape checklist
    // failure mode (a) is: output mistaken for a message.
    content: 'I will tell the room the batch failed.',
    toolCalls: [sayCall(world.room, 'the batch failed')],
  });
  const decide = await workOverServer(world.store, world.botA, serverOf(recorder), {
    prompt: ARTIFACT,
  });

  const record = await turnWith(world, decide, await entriesOf(world));

  assert.deepEqual(
    record.produced.map((message) => message.text),
    ['the batch failed'],
    'only the call posts, and only its own words',
  );
});

test('the prompt carries the entry and not the watch side’s verdict', async () => {
  const world = makeWorld();
  const entries = await entriesOf(world, 'the batch failed');
  // What stage 1 records on the entry it hands over (`agent-lifecycle.md` §4: the
  // reason stays on the record and never rides into this agent's context).
  entries[0].verdict = 'act';
  entries[0].reason = 'the room is asking for help';

  const recorder = fakeServer({});
  const decide = await workOverServer(world.store, world.botA, serverOf(recorder), {
    prompt: ARTIFACT,
  });
  await turnWith(world, decide, entries);

  const chat = recorder.calls.find((call) => call.path === '/v1/chat/completions');
  assert.ok(chat, 'the model was asked');
  const messages = chat.body.messages as { role: string; content: string }[];
  const asked = messages.map((message) => message.content).join('\n');

  assert.match(asked, /the batch failed/, 'the entry itself is handed over');
  assert.match(asked, /me: the batch failed/, 'and it is named by who said it');
  assert.doesNotMatch(asked, /the room is asking for help/, 'the reason stayed behind');
  assert.equal(
    messages[0].role,
    'system',
    'the artifact says where the system line ends, and it travels as one',
  );
});

test('a server serving another model is refused before the first turn', async () => {
  const world = makeWorld();
  const recorder = fakeServer({ modelAlias: 'qwen3', modelPath: '/models/qwen3-0.8b.gguf' });

  await assert.rejects(
    () => workOverServer(world.store, world.botA, serverOf(recorder), { prompt: ARTIFACT }),
    /the roster's work row declares model 'big' but this server serves 'qwen3'/,
    'the work row’s claim belongs to this server, and it is compared here',
  );
});

test('a prompt that offers a tool this runtime cannot execute is refused at bind', async () => {
  const world = makeWorld();
  const recorder = fakeServer({});
  const offering: WorkArtifact = {
    ...ARTIFACT,
    tools: [
      ...ARTIFACT.tools,
      { name: 'schedule', description: 'keep a promise', parameters: { type: 'object' } },
    ],
  };

  await assert.rejects(
    () => workOverServer(world.store, world.botA, serverOf(recorder), { prompt: offering }),
    /offers 'schedule' and this runtime can only execute 'say'/,
    'a model asked to call a tool nobody runs asks for something that cannot happen',
  );
});

test('a roster whose work row does not allow what the prompt offers is refused at bind', async () => {
  const world = makeWorld();
  const recorder = fakeServer({});
  // One word, in the file `README.md` invites a reader to edit afterwards: `say` taken
  // out of the row of the agent that is supposed to speak.
  world.store.data.agents[world.agentA2].tools = [];

  await assert.rejects(
    () => workOverServer(world.store, world.botA, serverOf(recorder), { prompt: ARTIFACT }),
    /the turn prompt offers 'say' and the roster's work row allows nothing/,
    'the prompt and the allowlist are two files, and the bind is the only place both are open',
  );
});

test('the roster this repository ships allows everything the prompt it ships offers', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const roster = parseRoster(
    readFileSync(join(root, 'seek-data', 'agents.yml'), 'utf8'),
    'seek-data/agents.yml',
  );
  const work = roster.find((row) => row.role === 'work');
  assert.ok(work, 'the shipped roster registers the row that answers');

  // The refusal above is only worth having if the tree it ships in passes it: a fix
  // that refused the default configuration would be a bot nobody can run.
  for (const tool of ARTIFACT.tools) {
    assert.ok(
      work.tools.includes(tool.name),
      `the shipped work row allows '${tool.name}', which ${'work-v1.json'} offers`,
    );
  }
});

test('a server whose window cannot hold even the smallest turn is refused at bind', async () => {
  const world = makeWorld();
  // Small enough that the smallest assembly — no description, no entries — already
  // fills it, which is the case where a turn has no room to write a single token.
  const recorder = fakeServer({ nCtx: 20 });

  await assert.rejects(
    () => workOverServer(world.store, world.botA, serverOf(recorder), { prompt: ARTIFACT }),
    /no room left to write a single token/,
  );
});

test('a call aimed at another room is refused rather than posted', async () => {
  const world = makeWorld();
  const elsewhere = 'oc_1111111111111111';
  world.store.data.rooms[elsewhere] = {
    id: elsewhere,
    name: 'elsewhere',
    chat_mode: 'group',
    created_at: '2026-10-24T00:00:00.000Z',
  };
  const recorder = fakeServer({ toolCalls: [sayCall(elsewhere, 'wrong room')] });
  const decide = await workOverServer(world.store, world.botA, serverOf(recorder), {
    prompt: ARTIFACT,
  });

  const entries = await entriesOf(world);
  await assert.rejects(
    () => turnWith(world, decide, entries),
    /this turn is about/,
    '§11.3 counts a bot’s turns per room, and a message aimed elsewhere is counted nowhere',
  );
  assert.equal(world.store.messagesOf(elsewhere).length, 0, 'and nothing was posted');
});

test('a call whose arguments are not JSON is refused with the model’s own bytes', async () => {
  const world = makeWorld();
  const recorder = fakeServer({
    toolCalls: [{ function: { name: 'say', arguments: '{"room": ' } }],
  });
  const decide = await workOverServer(world.store, world.botA, serverOf(recorder), {
    prompt: ARTIFACT,
  });

  const entries = await entriesOf(world);
  await assert.rejects(
    () => turnWith(world, decide, entries),
    /arguments that are not JSON/,
    'a call this runtime cannot read is not a call it may skip',
  );
});

test('the reply names the message it answers, when one message woke the turn', async () => {
  const world = makeWorld();
  const entries = await entriesOf(world);
  const recorder = fakeServer({ toolCalls: [sayCall(world.room, 'on it')] });
  const decide = await workOverServer(world.store, world.botA, serverOf(recorder), {
    prompt: ARTIFACT,
  });

  const record = await turnWith(world, decide, entries);

  assert.equal(record.produced.length, 1);
  assert.equal(
    record.produced[0].root_id,
    entries[0].message_id,
    '§11.4 decides “replies to one of its messages” on this link',
  );
});

/**
 * A turn carries what it spent, and the server that ran it is the only thing that knows.
 *
 * `docs/host-rulings.md` — "No spending cap" — asks for exactly this and nothing more:
 * the spend **recorded** and visible, never a limit a bot stops at. Until this pair
 * existed, every turn in every store recorded zero, so the ruling's half of the sentence
 * that the kernel could satisfy was the half nobody had implemented.
 */
test('a turn records the tokens the server reported for it', async () => {
  const world = makeWorld();
  const recorder = fakeServer({
    toolCalls: [sayCall(world.room, 'the batch failed on the retry queue')],
    usage: { prompt_tokens: 812, completion_tokens: 47, total_tokens: 859 },
  });
  const decide = await workOverServer(world.store, world.botA, serverOf(recorder), {
    prompt: ARTIFACT,
  });

  const record = await turnWith(world, decide, await entriesOf(world));

  assert.equal(record.turn.input_tokens, 812, 'what the request read, as the server read it');
  assert.equal(record.turn.output_tokens, 47, 'and what it wrote');
  // The row the store keeps is the one that carries the figure — a ledger that only told
  // the caller would leave every later reader, and the window, looking at zeros.
  assert.equal(world.store.data.turns[0].input_tokens, 812);
});

test('a server that reports no usage leaves the turn at zero rather than inventing a figure', async () => {
  const world = makeWorld();
  // Text and no `usage` block: the shape a build of llama-server without the field has.
  const recorder = fakeServer({ content: 'thinking about it' });
  const decide = await workOverServer(world.store, world.botA, serverOf(recorder), {
    prompt: ARTIFACT,
  });

  const record = await turnWith(world, decide, await entriesOf(world));

  // `0` is "nothing was reported". The alternative — counting the prompt here — would be
  // this repository measuring its own copy of it instead of the one the server read.
  assert.equal(record.turn.input_tokens, 0);
  assert.equal(record.turn.output_tokens, 0);
});

test('half a usage block is no report at all, and the half that is there is not believed', async () => {
  const world = makeWorld();
  const recorder = fakeServer({ usage: { prompt_tokens: 812 } });
  const decide = await workOverServer(world.store, world.botA, serverOf(recorder), {
    prompt: ARTIFACT,
  });

  const record = await turnWith(world, decide, await entriesOf(world));

  // A figure completed with a zero is a figure that looks measured and is not: 812 read
  // and 0 written is a claim about the answer nobody made.
  assert.equal(record.turn.input_tokens, 0);
  assert.equal(record.turn.output_tokens, 0);
});
