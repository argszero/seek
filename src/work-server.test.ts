import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { deliver } from './delivery.ts';
import { makeWorld, type World } from './fixtures.ts';
import type { Fetcher, LlamaServer } from './llama.ts';
import { loadCompactArtifact, loadWorkArtifact, type WorkArtifact } from './prompts.ts';
import { parseRoster } from './roster.ts';
import { runTurn } from './turn.ts';
import type { Id, Observation } from './types.ts';
import { digestOver, workOverServer } from './work-server.ts';

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
    /**
     * What the model answers, request after request, when one answer is not enough.
     *
     * A turn that looks something up is two requests — the read, and then the one that
     * carries its answer back — so the answers have to change between them, and a
     * recorder with one fixed answer could not tell the second request from the first.
     * Once the list runs out the last entry repeats.
     */
    answers?: { content?: string; toolCalls?: unknown[] }[];
    nCtx?: number;
    modelAlias?: string | null;
    modelPath?: string | null;
    /**
     * Whether this server says it can see a picture, in `/props` `modalities.vision`.
     *
     * False by default, because that is what the bundled server says: it is started without
     * an `--mmproj`, so an image part would be dropped on the way in and the transport
     * refuses one rather than sending it into a hole. A test that wants the picture to
     * travel has to stand up a server that claims a projector, exactly as a person would.
     */
    vision?: boolean;
  } = {},
): { fetch: Fetcher; calls: Call[] } {
  const calls: Call[] = [];
  let asked = 0;
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
        modalities: { vision: options.vision === true },
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
      const scripted = options.answers;
      const answer =
        scripted === undefined
          ? options
          : scripted[Math.min(asked, scripted.length - 1)];
      asked += 1;
      payload = {
        choices: [
          {
            message: {
              content: answer.content ?? '',
              ...(answer.toolCalls === undefined ? {} : { tool_calls: answer.toolCalls }),
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

/**
 * An endpoint of the other kind: no `/props`, no `/apply-template`, no `/tokenize`, and a
 * `GET /v1/models` that says which models it serves.
 *
 * Every route it does not have answers `404`, and the calls are recorded — so "this file
 * never asked for a template" is a reading rather than a promise. That is the whole point
 * of the helper: what a hosted endpoint cannot answer is as much of the contract as what it
 * can.
 */
function hostedServer(
  options: {
    serves?: { id: string; context_window?: unknown }[];
    content?: string;
    toolCalls?: unknown[];
    usage?: unknown;
  } = {},
): { fetch: Fetcher; calls: Call[] } {
  const calls: Call[] = [];
  // `big` by default because that is the model `makeWorld` puts on the work row: a default
  // that failed the roster check would make every test here measure the refusal instead of
  // the thing it names.
  const serves = options.serves ?? [{ id: 'big', context_window: 131072 }];
  const fetcher: Fetcher = async (url, init) => {
    const path = new URL(url).pathname;
    const body =
      init.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>);
    calls.push({ path, method: init.method, body });
    let payload: unknown;
    if (path === '/v1/models') {
      payload = { object: 'list', data: serves.map((one) => ({ object: 'model', ...one })) };
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

/** The same seam, addressed by an endpoint instead of a `llama-server`. */
function hostedOf(recorder: { fetch: Fetcher }, model = 'big', baseUrl = 'https://models.test'): LlamaServer {
  return { ...serverOf(recorder), baseUrl, model };
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

test('the request says when each entry arrived, so a week apart does not read as one shape', async () => {
  const world = makeWorld();
  // The clock is injected rather than waited on: two observations a week apart is the
  // measurement issue #173 was opened with, and nothing here needs a real week.
  const week = '2026-10-24T02:00:00.000Z';
  const today = '2026-10-31T02:00:00.000Z';
  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'the deploy is red',
    now: week,
  });
  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'it is green again',
    now: today,
  });
  const entries = await world.store.drain(world.botA);

  const recorder = fakeServer({});
  const decide = await workOverServer(world.store, world.botA, serverOf(recorder), {
    prompt: ARTIFACT,
  });
  await turnWith(world, decide, entries);

  const chat = recorder.calls.find((call) => call.path === '/v1/chat/completions');
  assert.ok(chat, 'the model was asked');
  const asked = JSON.stringify(chat.body);

  // The judgement criterion the issue was opened with, read the way a reader of the
  // request reads it: nothing but the body, and the room's own two messages must not
  // arrive as two lines of the same shape.
  assert.ok(asked.includes(week), 'the older message is dated where it landed');
  assert.ok(asked.includes(today), 'and so is the newer one');
  const lineOf = (said: string): string | undefined =>
    (chat.body.messages as { content: string }[])
      .map((message) => message.content)
      .join('\n')
      .split('\n')
      .find((line) => line.includes(said));
  assert.equal(lineOf('the deploy is red'), `[${week}] me: the deploy is red`);
  assert.equal(lineOf('it is green again'), `[${today}] me: it is green again`);
});

/**
 * A picture, as the half that answers receives it.
 *
 * Issue #172 measured the first half of this: a message whose whole content was a picture
 * arrived at the prompt as `me:` — the same line an empty message makes — and searching the
 * body for `picture`, `image`, `media` or the blob's own key found nothing. `work-v6` then
 * gave it words. What it did not have was the picture: `TurnBox` handed the turn entries and
 * not their media, so the bytes stopped one layer before the half that writes (issue #179).
 *
 * This is the reading that says the whole distance is travelled — the loader is asked for
 * the picture the box holds, and the request carries it — and that the words are still
 * there, because an image somewhere in a request does not say which message it came with.
 */
test('a picture reaches the turn as an image, and the words still say which line it came with', async () => {
  const world = makeWorld();
  const media = { key: 'blobs/screen.png', mime: 'image/png' };
  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    kind: 'image',
    text: '',
    media,
  });
  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'and this one is only words',
  });
  const entries = await world.store.drain(world.botA);

  const recorder = fakeServer({ vision: true });
  const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
  const loaded: string[] = [];
  const decide = await workOverServer(
    world.store,
    world.botA,
    {
      ...serverOf(recorder),
      loadMedia: async (picture) => {
        loaded.push(picture.key);
        return bytes;
      },
    },
    { prompt: ARTIFACT },
  );
  await turnWith(world, decide, entries);

  const chat = recorder.calls.find((call) => call.path === '/v1/chat/completions');
  assert.ok(chat, 'the model was asked');
  const sent = chat.body.messages as { role: string; content: unknown }[];
  const user = sent.find((message) => message.role === 'user');
  assert.ok(user, 'the turn asked one user message');

  // The box's picture, asked for by the reference the box holds and nothing else — the
  // transport names a key and a mime because a key is all the kernel keeps (`box.ts`).
  assert.deepEqual(loaded, [media.key], 'the loader was asked for the picture the box holds');

  const parts = user.content as {
    type: string;
    text?: string;
    image_url?: { url: string };
  }[];
  assert.ok(Array.isArray(parts), 'a turn carrying a picture sends parts, not a string');
  const images = parts.filter((part) => part.type === 'image_url');
  assert.equal(images.length, 1, 'exactly one picture rode this request');
  assert.equal(
    images[0]?.image_url?.url,
    `data:${media.mime};base64,${Buffer.from(bytes).toString('base64')}`,
    'the picture is the bytes the loader handed over, in the form the endpoint takes',
  );

  // The text half, unchanged: the artifact's own sentence on the line the picture came
  // with, and the blob's key nowhere in what the model reads.
  const pictureLine = ARTIFACT.pictureLine;
  assert.ok(pictureLine, 'the shipped artifact says what a picture is, in its own words');
  const text = parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n');
  assert.ok(text.includes(pictureLine.trim()), 'the body says a picture came with a message');
  const said = text.split('\n').find((line) => line.includes(pictureLine.trim()));
  assert.ok(said, 'the picture has a line of its own');
  assert.match(said, /^\[\S+\] me: +\S/, 'nothing was consolidated away, and the line is not blank');
  assert.equal(JSON.stringify(chat.body).includes(media.key), false, 'the blob key is not part of what the model reads');

  const plain = text.split('\n').find((line) => line.includes('and this one is only words'));
  assert.match(String(plain), /^\[\S+\] me: and this one is only words$/);
});

/**
 * The other direction: a turn with nothing to place sends exactly what it sent before.
 *
 * Parts exist to say where a picture goes, so a box with no picture must not acquire a
 * one-part list of its own — and the loader must not be asked for bytes, because a caller
 * that reads a disk per turn for no reason is a cost nobody measured.
 */
test('a turn whose box holds no picture sends the string it sent before', async () => {
  const world = makeWorld();
  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'this one is only words',
  });
  const entries = await world.store.drain(world.botA);

  const recorder = fakeServer({});
  let askedForBytes = 0;
  const decide = await workOverServer(
    world.store,
    world.botA,
    {
      ...serverOf(recorder),
      loadMedia: async () => {
        askedForBytes += 1;
        return null;
      },
    },
    { prompt: ARTIFACT },
  );
  await turnWith(world, decide, entries);

  const chat = recorder.calls.find((call) => call.path === '/v1/chat/completions');
  assert.ok(chat, 'the model was asked');
  const user = (chat.body.messages as { role: string; content: unknown }[]).find(
    (message) => message.role === 'user',
  );
  assert.ok(user, 'the turn asked one user message');
  assert.equal(typeof user.content, 'string', 'no picture in the box, so no parts');
  assert.equal(askedForBytes, 0, 'and the loader was never asked for a byte');
});

/**
 * The same two facts, at the half that writes the room's note.
 *
 * Issue #177, on the request body the note was written from: a picture that came with no
 * words arrived as `- me: ` — the line an empty message makes — and two messages a week
 * apart arrived as two lines of the same shape, with neither stamp in the body at all.
 * The note is where that reading gets expensive: it is stored, and `box.ts` hands it back
 * as the room's summary, so every later turn reads those two messages only as the note
 * describes them.
 */
test('the note is written from when each message landed, and from the picture that came with one', async () => {
  const world = makeWorld();
  const week = '2026-10-24T02:00:00.000Z';
  const today = '2026-10-31T02:00:00.000Z';
  const media = { key: 'blobs/screen.png', mime: 'image/png' };
  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'the deploy is red',
    now: week,
  });
  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    kind: 'image',
    text: '',
    media,
    now: week,
  });
  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'it is green again',
    now: today,
  });
  const entries = await world.store.drain(world.botA);

  const recorder = fakeServer({ content: 'the deploy went red and came back green.' });
  const digest = digestOver(world.store, world.botA, serverOf(recorder));
  await digest({
    botId: world.botA,
    agentId: world.agentA2,
    roomId: world.room,
    delta: entries,
    previous: undefined,
  });

  const chat = recorder.calls.find((call) => call.path === '/v1/chat/completions');
  assert.ok(chat, 'the model was asked');
  const asked = JSON.stringify(chat.body);
  const lines = (chat.body.messages as { content: string }[])
    .map((message) => message.content)
    .join('\n')
    .split('\n');
  const lineOf = (said: string): string | undefined =>
    lines.find((line) => line.includes(said));

  // Both moments, and not the same shape twice: a note that cannot tell them apart is
  // the note every later turn reads instead of the messages themselves.
  assert.equal(lineOf('the deploy is red'), `- [${week}] me: the deploy is red`);
  assert.equal(lineOf('it is green again'), `- [${today}] me: it is green again`);

  // The picture, in the same three readings #176 took of a turn: the body says one came,
  // the line it says so on is not blank, and the blob's key stayed home.
  const pictureLine = loadCompactArtifact().pictureLine;
  assert.ok(pictureLine, 'the shipped note artifact says what a picture is, in its own words');
  assert.ok(asked.includes(pictureLine.trim()), 'the note is told a picture came with a message');
  const said = lines.find((line) => line.includes(pictureLine.trim()));
  assert.match(
    String(said),
    /^- \[\S+\] me: +\S/,
    'nothing was consolidated away, and the line is not blank',
  );
  assert.equal(asked.includes(media.key), false, 'the blob key is not part of what the model reads');
});

/**
 * The clock: a room that has been at it for a while is told so, and a fresh one is not.
 *
 * This is the number that was missing when a room of four settled its plan in ten messages
 * and then spent fifteen more agreeing on the same three things — nobody was tired, because
 * nothing said how long they had been going. The count is the room's own
 * (`Room.consecutive_agent_turns`), and what it means is the artifact's to say.
 */
test('a room that has been talking a while is told how long, and a fresh one is not', async () => {
  const world = makeWorld();
  const recorder = fakeServer({});
  const decide = await workOverServer(world.store, world.botA, serverOf(recorder), {
    prompt: ARTIFACT,
  });

  const askedOf = () => {
    const chat = recorder.calls.filter((call) => call.path === '/v1/chat/completions').at(-1);
    assert.ok(chat, 'the model was asked');
    const messages = chat.body.messages as { role: string; content: string }[];
    return messages.map((message) => message.content).join('\n');
  };

  await turnWith(world, decide, await entriesOf(world, 'the batch failed'));
  assert.doesNotMatch(askedOf(), /bot messages in a row/, 'a room just started is not told to wrap up');

  // A person's message resets the run, so the count is set after the delivery and before
  // the turn that reads it — the same order a live room produces.
  const later = await entriesOf(world, 'still going');
  world.store.data.rooms[world.room].consecutive_agent_turns = 8;
  await turnWith(world, decide, later);
  assert.match(askedOf(), /8 bot messages in a row/, 'and a long one is told how long');
});

test('what the model reads is the room’s box: the note, and the message before the one that woke it', async () => {
  const world = makeWorld();
  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    text: 'the deploy is red',
    now: '2026-10-24T00:30:00.000Z',
  });
  const entries = await entriesOf(world, 'the retry queue failed twice');
  assert.equal(entries.length, 2);

  // The note a compaction would have written about this room. It accounts for nothing
  // yet, so both messages are still in the delta — what this test is about is that the
  // earlier one reaches the model at all.
  world.store.memoriesOf(world.agentA2).push({
    id: 'mm_note',
    agent_id: world.agentA2,
    level: 'room_digest',
    room_id: world.room,
    body: 'the deploy has been red since last night, cause unknown',
    updated_at: '2026-10-24T00:10:00.000Z',
  });

  const recorder = fakeServer({ content: 'nothing worth adding' });
  const decide = await workOverServer(world.store, world.botA, serverOf(recorder), {
    prompt: ARTIFACT,
  });
  // Woken by the second message only — that is the whole of what `entries` is.
  await turnWith(world, decide, [entries[1]]);

  const chat = recorder.calls.find((call) => call.path === '/v1/chat/completions');
  assert.ok(chat, 'the model was asked');
  const asked = (chat.body.messages as { role: string; content: string }[])
    .map((message) => message.content)
    .join('\n');

  assert.match(asked, /the deploy has been red since last night/, 'the note is handed over');
  assert.match(asked, /the deploy is red/, 'and so is the message that did not wake it');
  assert.ok(
    asked.indexOf('the deploy is red') < asked.indexOf('the retry queue failed twice'),
    'the box is read oldest first, so the newest message sits nearest the question',
  );
});

test('what the bot wrote in other rooms reaches the turn, and this room’s note is not said twice', async () => {
  const world = makeWorld();
  const elsewhere = 'oc_the_design_room';
  world.store.data.rooms[elsewhere] = {
    id: elsewhere,
    name: 'the design room',
    chat_mode: 'group',
    created_at: '2026-10-20T00:00:00.000Z',
  };
  world.store.memoriesOf(world.agentA2).push(
    {
      id: 'mm_here',
      agent_id: world.agentA2,
      level: 'room_digest',
      room_id: world.room,
      body: 'the deploy has been red since last night, cause unknown',
      updated_at: '2026-10-24T00:10:00.000Z',
    },
    {
      id: 'mm_there',
      agent_id: world.agentA2,
      level: 'room_digest',
      room_id: elsewhere,
      body: 'the migration is blocked on the key rotation\n\nnobody has asked ops yet',
      updated_at: '2026-10-24T00:20:00.000Z',
    },
  );

  const recorder = fakeServer({ content: 'nothing worth adding' });
  const decide = await workOverServer(world.store, world.botA, serverOf(recorder), {
    prompt: ARTIFACT,
  });
  await turnWith(world, decide, await entriesOf(world, 'the retry queue failed twice'));

  const chat = recorder.calls.filter((call) => call.path === '/v1/chat/completions').at(-1);
  assert.ok(chat, 'the model was asked');
  const asked = (chat.body.messages as { role: string; content: string }[])
    .map((message) => message.content)
    .join('\n');

  // The ruling's third item, from the store to the request body: `docs/host-rulings.md`,
  // "The observation box" — *"the latest compaction, the memory index and every
  // observation after the latest compaction"*. The other room's note is one line: where
  // it is, when it was written, and how it starts — never the whole paragraph, which is
  // what a compaction wrote and what this turn has no room for.
  assert.ok(
    asked.includes(
      '- room=the design room level=room_digest at=2026-10-24T00:20:00.000Z ' +
        'first=the migration is blocked on the key rotation',
    ),
    'the note it wrote in another room is in the turn, as one line',
  );
  assert.doesNotMatch(
    asked,
    /nobody has asked ops yet/,
    'and only as one line: the paragraph behind it is not quoted into a prompt',
  );

  // The note for the room this turn is in has its own part, quoted in full. Listing it
  // in the index as well would say the same thing twice, which reads as emphasis.
  assert.equal(
    asked.split('the deploy has been red since last night').length - 1,
    1,
    'the note about this room is said once',
  );

  // The record is the store's, and reading a turn must not reorder it: the index is
  // sorted for the reader, not written back.
  assert.deepEqual(
    world.store.memoriesOf(world.agentA2).map((row) => row.id),
    ['mm_here', 'mm_there'],
    'the store keeps its own order',
  );
});

test('the index is ten lines and says so when there are more, newest first', async () => {
  const world = makeWorld();
  // Twelve notes in other rooms, oldest written first, so the store's own order and the
  // index's order disagree and the assertion can tell which one it read.
  for (let n = 0; n < 12; n += 1) {
    world.store.memoriesOf(world.agentA2).push({
      id: `mm_${n}`,
      agent_id: world.agentA2,
      level: 'room_digest',
      room_id: `oc_room_${n}`,
      body: `the note numbered ${n}.`,
      updated_at: `2026-10-${String(n + 1).padStart(2, '0')}T00:00:00.000Z`,
    });
  }

  const recorder = fakeServer({ content: 'nothing worth adding' });
  const decide = await workOverServer(world.store, world.botA, serverOf(recorder), {
    prompt: ARTIFACT,
  });
  await turnWith(world, decide, await entriesOf(world));

  const chat = recorder.calls.filter((call) => call.path === '/v1/chat/completions').at(-1);
  assert.ok(chat, 'the model was asked');
  const asked = (chat.body.messages as { role: string; content: string }[])
    .map((message) => message.content)
    .join('\n');

  // **Bounded, and it says so.** A list silently cut at ten reads as a list of ten, and
  // a prompt that grows with every room the bot has worked in is the cost this cap
  // exists to stop. The count is the artifact's to explain; the shape is this value's.
  assert.match(asked, /showing=10 of 12, newest first/);
  assert.ok(asked.includes('first=the note numbered 11.'), 'the newest note is in it');
  assert.equal(
    asked.includes('the note numbered 0.') || asked.includes('first=the note numbered 1.'),
    false,
    'and the two oldest are the ones left out',
  );
  assert.ok(
    asked.indexOf('the note numbered 11.') < asked.indexOf('the note numbered 10.') &&
      asked.indexOf('the note numbered 10.') < asked.indexOf('the note numbered 9.'),
    'newest first, which is the store order read backwards',
  );
  // A room nobody named is named by its id, as every other list here does.
  assert.ok(asked.includes('room=oc_room_11 level=room_digest'), 'a nameless room keeps its id');
});

test('the card a person filled in is quoted in the turn the model reads', async () => {
  const world = makeWorld();
  const bot = world.store.data.bots[world.botA];
  bot.position = '接口与联调';
  bot.personality = '先给结论再给理由；\n改接口前列出谁会被影响。';

  const recorder = fakeServer({ content: 'nothing worth adding' });
  const decide = await workOverServer(world.store, world.botA, serverOf(recorder), {
    prompt: ARTIFACT,
  });
  await turnWith(world, decide, await entriesOf(world));

  const chat = recorder.calls.find((call) => call.path === '/v1/chat/completions');
  assert.ok(chat, 'the model was asked');
  const asked = (chat.body.messages as { role: string; content: string }[])
    .map((message) => message.content)
    .join('\n');

  // From the store to the body the server receives, in one reading: `identityFor` hands
  // the card over as fields and `valuesOf` fills the parts from them, so either of those
  // two seams can drop a field while both halves' own tests stay green.
  assert.match(asked, /What this bot does in this organization: 接口与联调/);
  assert.ok(
    asked.includes('先给结论再给理由；\n改接口前列出谁会被影响。'),
    'the personality reaches the model as the person typed it, its line break included',
  );
  // The failure this rules out is silent: `fill` leaves an unknown placeholder whole, so
  // a fact the assembly does not carry arrives as the field's name in a sentence.
  assert.doesNotMatch(asked, /\{(position|personality|gender)\}/, 'no placeholder left whole');
});

test('a bot whose card nobody filled in is told nothing about a position', async () => {
  const world = makeWorld();
  const recorder = fakeServer({ content: 'nothing worth adding' });
  const decide = await workOverServer(world.store, world.botA, serverOf(recorder), {
    prompt: ARTIFACT,
  });
  await turnWith(world, decide, await entriesOf(world));

  const chat = recorder.calls.find((call) => call.path === '/v1/chat/completions');
  assert.ok(chat, 'the model was asked');
  const asked = (chat.body.messages as { role: string; content: string }[])
    .map((message) => message.content)
    .join('\n');
  assert.doesNotMatch(asked, /What this bot does in this organization/);
  assert.doesNotMatch(asked, /How this bot talks and works/);
});

test('a hosted endpoint is asked only what it can answer, and the words still arrive through say', async () => {
  const world = makeWorld();
  const recorder = hostedServer({
    toolCalls: [sayCall(world.room, 'the retry queue is what failed')],
    usage: { prompt_tokens: 640, completion_tokens: 22 },
  });

  const decide = await workOverServer(world.store, world.botA, hostedOf(recorder), { prompt: ARTIFACT });
  const record = await turnWith(world, decide, await entriesOf(world));

  // The three endpoints the cut was measured through are not there, and this is the reading
  // that says so: the bind would have thrown on any of them, so their absence is the point.
  const paths = recorder.calls.map((call) => call.path);
  assert.deepEqual(
    [...new Set(paths)],
    ['/v1/models', '/v1/chat/completions'],
    'the model list, then the chat call — and nothing else',
  );
  assert.equal(paths.filter((one) => one === '/v1/models').length, 1, 'the list is read once, at bind');

  assert.deepEqual(
    record.produced.map((message) => message.text),
    ['the retry queue is what failed'],
    'the model called say, so the message is posted with its own words',
  );
  // The spend the endpoint reported is what the turn records, and it is the endpoint's
  // figure rather than one this file counted.
  assert.equal(record.turn.input_tokens, 640, 'the spend the endpoint reported, not one counted here');
  assert.equal(record.turn.output_tokens, 22);
});

test('a hosted endpoint that does not serve the named model is refused at bind, with the names it does serve', async () => {
  const world = makeWorld();
  const recorder = hostedServer({
    serves: [{ id: 'hosted-large' }, { id: 'hosted-small' }],
  });

  await assert.rejects(
    () => workOverServer(world.store, world.botA, hostedOf(recorder, 'hosted-larg'), { prompt: ARTIFACT }),
    (error: Error) => {
      assert.match(error.message, /'hosted-larg'/i, 'the name that was asked for');
      assert.match(error.message, /'hosted-large', 'hosted-small'/, 'and the names that exist');
      return true;
    },
  );
});

test('a roster row claiming another model is refused by a hosted endpoint too', async () => {
  const world = makeWorld();
  const recorder = hostedServer({ serves: [{ id: 'hosted-large' }] });

  // `makeWorld` puts 'big' on the work row; the endpoint serves 'hosted-large'.
  await assert.rejects(
    () => workOverServer(world.store, world.botA, hostedOf(recorder), { prompt: ARTIFACT }),
    /serves 'hosted-large'|declares model 'big'/i,
  );
});

test('a base_url written the way OpenAI writes it addresses the same origin', async () => {
  const world = makeWorld();
  const recorder = hostedServer({ serves: [{ id: 'big' }] });

  // `.../v1` on the end must not become `/v1/v1/models`: measured against the real endpoint,
  // that path is a 404 while `/v1/models` is a 200. The recorder answers by pathname, so a
  // doubled segment would simply not match and the bind would throw.
  await workOverServer(world.store, world.botA, hostedOf(recorder, 'big', 'https://models.test/v1'), {
    prompt: ARTIFACT,
  });

  assert.deepEqual(recorder.calls.map((call) => call.path), ['/v1/models'], 'no doubled /v1');
});

test('a hosted endpoint that declares no window is still bound, and nothing pretends to enforce one', async () => {
  const world = makeWorld();
  const recorder = hostedServer({ serves: [{ id: 'big' }] });

  // No `context_window` at all. The bind must not turn that into a refusal, because there is
  // no budget it could hold the turn to: the endpoint counts its own tokens and refuses its
  // own over-long prompts. What it must also not do is pretend — nothing is written into a
  // window field, and the turn proceeds.
  const decide = await workOverServer(world.store, world.botA, hostedOf(recorder), { prompt: ARTIFACT });
  assert.equal(typeof decide, 'function');
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
    /offers 'schedule' and this runtime can only execute 'say', 'read', 'glob', 'grep', 'write', 'edit'/,
    'a model asked to call a tool nobody runs asks for something that cannot happen',
  );
});

/**
 * A bot's home holding one filed day, and the day it is filed under.
 *
 * A temporary directory of this test's own rather than the fixture's `/tmp/seek/a/work`:
 * the archive is files, two runs of this file would share them, and a test that reads
 * another test's leftovers passes for the wrong reason.
 */
function archiveOf(lines: string[], day = '2026-10-30'): { home: string; day: string } {
  const home = mkdtempSync(join(tmpdir(), 'seek-look-'));
  mkdirSync(join(home, 'archive'), { recursive: true });
  writeFileSync(
    join(home, 'archive', `${day}.jsonl`),
    lines
      .map((line) =>
        JSON.stringify({
          at: `${day}T02:00:00.000Z`,
          room: 'oc_room',
          sender: '邵安清',
          text: line,
        }),
      )
      .join('\n') + '\n',
    'utf8',
  );
  return { home, day };
}

/** A read call as a model writes one. */
function readCall(day: string): unknown {
  return { id: 'call_1', function: { name: 'read', arguments: JSON.stringify({ day }) } };
}

test('a read comes back into the turn, and what is said afterwards is a second request', async () => {
  const world = makeWorld();
  const filed = archiveOf(['the retry queue was at 40 yesterday', 'nobody has looked since']);
  world.store.data.agents[world.agentA2].home = filed.home;

  const recorder = fakeServer({
    answers: [
      { toolCalls: [readCall(filed.day)] },
      { toolCalls: [sayCall(world.room, 'yesterday it was at 40')] },
    ],
  });
  const decide = await workOverServer(world.store, world.botA, serverOf(recorder), {
    prompt: ARTIFACT,
  });

  const record = await turnWith(world, decide, await entriesOf(world));

  // What the room got is the second answer: the model read first, and then spoke.
  assert.equal(record.produced.length, 1);
  assert.equal(record.produced[0].text, 'yesterday it was at 40');

  const chats = recorder.calls.filter((call) => call.path === '/v1/chat/completions');
  assert.equal(chats.length, 2, 'a look is one request and the answer to it is another');

  // The second request carries the answer, in the endpoint's own two shapes: the
  // assistant message the call continues from, and the tool message that answers it.
  const sent = chats[1].body.messages as {
    role: string;
    content: unknown;
    tool_calls?: { id: string; function: { name: string } }[];
    tool_call_id?: string;
  }[];
  const assistant = sent.at(-2);
  assert.equal(assistant?.role, 'assistant');
  assert.deepEqual(
    assistant?.tool_calls?.map((one) => [one.id, one.function.name]),
    [['call_1', 'read']],
    'the call is named by the id the endpoint gave it, or the answer cannot be matched',
  );
  const tool = sent.at(-1);
  assert.equal(tool?.role, 'tool');
  assert.equal(tool?.tool_call_id, 'call_1');
  assert.equal(
    tool?.content,
    '[2026-10-30T02:00:00.000Z] 邵安清: the retry queue was at 40 yesterday\n' +
      '[2026-10-30T02:00:00.000Z] 邵安清: nobody has looked since',
    'the day arrives in the shape the transcript already uses',
  );
});

test('the turn is told where the archive is, so a read has a day to name', async () => {
  const world = makeWorld();
  const filed = archiveOf(['the retry queue was at 40 yesterday']);
  world.store.data.agents[world.agentA2].home = filed.home;

  const recorder = fakeServer({ content: '' });
  const decide = await workOverServer(world.store, world.botA, serverOf(recorder), {
    prompt: ARTIFACT,
  });
  await turnWith(world, decide, await entriesOf(world));

  const chat = recorder.calls.find((call) => call.path === '/v1/chat/completions');
  const user = (chat?.body.messages as { role: string; content: string }[]).find(
    (message) => message.role === 'user',
  );
  assert.ok(String(user?.content).includes(`${filed.home}/archive`), 'the place is named');
  assert.ok(String(user?.content).includes(filed.day), 'and the days already filed');
});

test('a day with nothing filed is answered in words, so the model can ask again', async () => {
  const world = makeWorld();
  const filed = archiveOf(['the retry queue was at 40 yesterday']);
  world.store.data.agents[world.agentA2].home = filed.home;

  const recorder = fakeServer({
    answers: [
      { toolCalls: [readCall('2026-10-28')] },
      { toolCalls: [sayCall(world.room, 'nothing filed for that day, so I am going on the note')] },
    ],
  });
  const decide = await workOverServer(world.store, world.botA, serverOf(recorder), {
    prompt: ARTIFACT,
  });

  const record = await turnWith(world, decide, await entriesOf(world));

  assert.equal(record.produced.length, 1, 'the turn carried on rather than ending on a wrong date');
  const tool = (
    recorder.calls.filter((call) => call.path === '/v1/chat/completions')[1].body
      .messages as { role: string; content: string }[]
  ).at(-1);
  assert.equal(tool?.role, 'tool');
  assert.match(String(tool?.content), /nothing filed for 2026-10-28/);
  assert.match(String(tool?.content), new RegExp(filed.day), 'and which days do exist');
});

test('a read that names no day is refused rather than answered with a guess', async () => {
  const world = makeWorld();
  const filed = archiveOf(['one line']);
  world.store.data.agents[world.agentA2].home = filed.home;

  const recorder = fakeServer({
    toolCalls: [{ function: { name: 'read', arguments: JSON.stringify({ day: 'yesterday' }) } }],
  });
  const decide = await workOverServer(world.store, world.botA, serverOf(recorder), {
    prompt: ARTIFACT,
  });

  const woke = await entriesOf(world);
  await assert.rejects(
    () => turnWith(world, decide, woke),
    /called read with day="yesterday", which is not a day/,
    'a name this runtime cannot read is not a day it may answer with a guess',
  );
});

test('a tool this runtime does not execute is still refused at the call', async () => {
  const world = makeWorld();
  const recorder = fakeServer({
    toolCalls: [{ function: { name: 'delete', arguments: JSON.stringify({ room: world.room }) } }],
  });
  const decide = await workOverServer(world.store, world.botA, serverOf(recorder), {
    prompt: ARTIFACT,
  });

  const woke = await entriesOf(world);
  await assert.rejects(
    () => turnWith(world, decide, woke),
    /the model called 'delete' and this runtime executes only 'say', 'read', 'glob', 'grep', 'write', 'edit'/,
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
    /the turn prompt offers 'say', 'read', 'glob', 'grep', 'write', 'edit' and the roster's work row allows nothing/,
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
      `the shipped work row allows '${tool.name}', which work-v3.json offers`,
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

test('the note is written by the same server that speaks, and offers no tool', async () => {
  const world = makeWorld();
  const recorder = fakeServer({ content: '对账还坏着；小荷在看重试队列。' });
  const entries = await entriesOf(world, 'the batch failed at 03:00');

  const digest = digestOver(world.store, world.botA, serverOf(recorder));
  const body = await digest({
    botId: world.botA,
    agentId: world.agentA2,
    roomId: world.room,
    delta: entries,
    previous: undefined,
  });

  assert.equal(body, '对账还坏着；小荷在看重试队列。');

  const chat = recorder.calls.filter((call) => call.path === '/v1/chat/completions');
  assert.equal(chat.length, 1);

  // **No tool.** A turn is offered `say` because a room is reached no other way; the
  // note is a return value, and a model handed the turn's tool here would answer a note
  // with `say` — which is a message, and the note would be one behind the reader's back.
  assert.equal(chat[0].body.tools, undefined);
  const messages = chat[0].body.messages as { role: string; content: string }[];
  const system = messages.find((one) => one.role === 'system')?.content ?? '';
  const rest = messages.find((one) => one.role === 'user')?.content ?? '';
  // Who is writing, and about which room: both by name, because the note is this bot's
  // and this room's (`docs/host-rulings.md`, "One box per bot").
  assert.match(system, new RegExp(world.store.data.bots[world.botA]?.name ?? 'A'));
  assert.match(rest, new RegExp(world.store.room(world.room)?.name ?? world.room));
  // The observation it was asked about is in the prompt, quoted.
  assert.match(rest, /the batch failed at 03:00/);
});

test('a note that comes back empty is refused, and says what it would have cost', async () => {
  const world = makeWorld();
  // A model that answers nothing is not a model that says nothing: a note of nothing
  // would consume the delta it was written from and leave the bot knowing less.
  const recorder = fakeServer({ content: '   \n' });
  const entries = await entriesOf(world, 'the batch failed at 03:00');

  const digest = digestOver(world.store, world.botA, serverOf(recorder));
  await assert.rejects(
    () =>
      digest({
        botId: world.botA,
        agentId: world.agentA2,
        roomId: world.room,
        delta: entries,
        previous: undefined,
      }),
    /came back empty/,
  );
});


/** A glob call as a model writes one. */
function globCall(pattern: string): unknown {
  return { id: 'call_2', function: { name: 'glob', arguments: JSON.stringify({ pattern }) } };
}

/** A grep call as a model writes one. */
function grepCall(args: { pattern: string; path?: string }): unknown {
  return { id: 'call_3', function: { name: 'grep', arguments: JSON.stringify(args) } };
}

/**
 * The answer the runtime handed back for the lookup that opened the turn.
 *
 * Read off the second request rather than off `run`'s return value, because the second
 * request is what the model actually gets to see: a lookup whose answer never reaches it
 * is a tool that cost a request and bought nothing.
 */
function lookupAnswer(recorder: { calls: Call[] }): string {
  const chats = recorder.calls.filter((call) => call.path === '/v1/chat/completions');
  assert.equal(chats.length, 2, 'a lookup is one request and the answer to it is another');
  const tool =
    (chats[1].body.messages as { role: string; content: string }[]).at(-1);
  assert.equal(tool?.role, 'tool');
  return String(tool?.content);
}

test('glob answers with the names this bot filed, and the answer is in the next request', async () => {
  const world = makeWorld();
  const filed = archiveOf(['the retry queue was at 40 yesterday']);
  world.store.data.agents[world.agentA2].home = filed.home;

  const recorder = fakeServer({
    answers: [{ toolCalls: [globCall('archive/*.jsonl')] }, { content: 'found it' }],
  });
  const decide = await workOverServer(world.store, world.botA, serverOf(recorder), {
    prompt: ARTIFACT,
  });
  await turnWith(world, decide, await entriesOf(world));

  assert.equal(
    lookupAnswer(recorder),
    `archive/${filed.day}.jsonl`,
    'the name it filed, relative to the directory the lookup is bounded to',
  );
});

test('grep names the file and the line a word is on', async () => {
  const world = makeWorld();
  const filed = archiveOf(['the retry queue was at 40 yesterday', 'nobody has looked since']);
  world.store.data.agents[world.agentA2].home = filed.home;

  const recorder = fakeServer({
    answers: [
      { toolCalls: [grepCall({ pattern: 'nobody has looked' })] },
      { content: 'the second line' },
    ],
  });
  const decide = await workOverServer(world.store, world.botA, serverOf(recorder), {
    prompt: ARTIFACT,
  });
  await turnWith(world, decide, await entriesOf(world));

  const answer = lookupAnswer(recorder);
  assert.match(
    answer,
    new RegExp(`^archive/${filed.day}\\.jsonl:2: `),
    'where it is: the file, and the line inside it',
  );
  assert.ok(answer.includes('nobody has looked since'), 'and the line itself');
  assert.equal(answer.split('\n').length, 1, 'one line matched, so one line comes back');
});

test('grep quotes the line a reader is handed, not the row the file stores', async () => {
  const world = makeWorld();
  const filed = archiveOf(['the retry queue was at 40 yesterday']);
  world.store.data.agents[world.agentA2].home = filed.home;

  const recorder = fakeServer({
    answers: [{ toolCalls: [grepCall({ pattern: 'retry queue' })] }, { content: 'at 40' }],
  });
  const decide = await workOverServer(world.store, world.botA, serverOf(recorder), {
    prompt: ARTIFACT,
  });
  await turnWith(world, decide, await entriesOf(world));

  // Exactly what `read` hands back for that day, with where it is put in front of it — a word
  // found and a day read describe the same facts in the same shape.
  assert.equal(
    lookupAnswer(recorder),
    `archive/${filed.day}.jsonl:1: [${filed.day}T02:00:00.000Z] 邵安清: the retry queue was at 40 yesterday`,
  );
});

test('a message longer than a quoted line is cut where a reader can see it was cut', async () => {
  const world = makeWorld();
  const long =
    'the retry queue was at 40 and the on-call said the paging rule had been changed twice ' +
    'in one week and nobody had written down which version was live, so we agreed to pin the ' +
    'version we had and revisit the whole rule after this release rather than guess again';
  assert.ok(long.length > 240, 'the message outruns the quote, which is the point of it');
  const filed = archiveOf([long]);
  world.store.data.agents[world.agentA2].home = filed.home;

  const recorder = fakeServer({
    answers: [{ toolCalls: [grepCall({ pattern: 'retry queue' })] }, { content: 'at 40' }],
  });
  const decide = await workOverServer(world.store, world.botA, serverOf(recorder), {
    prompt: ARTIFACT,
  });
  await turnWith(world, decide, await entriesOf(world));

  // The stored row cut at 240 characters landed inside `"text":"…"`, so what came back was
  // neither the message nor anything a reader could parse. A cut in a rendered line is a cut
  // of the message itself, and the mark says that it was made.
  const answer = lookupAnswer(recorder);
  assert.ok(!answer.includes('"text":'), 'no field of the stored row is quoted');
  assert.ok(answer.includes('邵安清: the retry queue was at 40'), 'and what it says is there');
  assert.ok(answer.endsWith('…'), 'the cut is marked rather than left to look complete');
});

test('grep searches the line it shows, not the fields the row stores', async () => {
  const world = makeWorld();
  const filed = archiveOf(['the retry queue was at 40 yesterday']);
  world.store.data.agents[world.agentA2].home = filed.home;

  // A phrase the rendered line carries and the stored row does not: `[at] sender: text` is
  // one string, while the row spells the same two facts as `"sender":"…","text":"…"`.
  const rendered = fakeServer({
    answers: [{ toolCalls: [grepCall({ pattern: '邵安清: the retry queue' })] }, { content: 'yes' }],
  });
  const decide = await workOverServer(world.store, world.botA, serverOf(rendered), {
    prompt: ARTIFACT,
  });
  await turnWith(world, decide, await entriesOf(world));
  assert.ok(
    lookupAnswer(rendered).startsWith(`archive/${filed.day}.jsonl:1: `),
    'a phrase that only the line a reader sees has is still found',
  );

  // And the other direction, which is the false positive this rule removes: `oc_room` is a
  // value in the stored row and in nothing the reader is handed, so a search that reads the
  // row would answer every line in the file for it.
  const stored = fakeServer({
    answers: [{ toolCalls: [grepCall({ pattern: 'oc_room' })] }, { content: 'nothing' }],
  });
  const over = await workOverServer(world.store, world.botA, serverOf(stored), {
    prompt: ARTIFACT,
  });
  await turnWith(world, over, await entriesOf(world));
  assert.match(
    lookupAnswer(stored),
    /nothing in this bot's own directory matches "oc_room"/,
    "a field's value is not a line, so it is not a match",
  );
});

test('a file that is not the archive is quoted as it is written', async () => {
  const world = makeWorld();
  const filed = archiveOf(['the retry queue was at 40 yesterday']);
  writeFileSync(join(filed.home, 'notes.txt'), 'the retry queue again\n', 'utf8');
  world.store.data.agents[world.agentA2].home = filed.home;

  const recorder = fakeServer({
    answers: [{ toolCalls: [grepCall({ pattern: 'retry queue' })] }, { content: 'twice' }],
  });
  const decide = await workOverServer(world.store, world.botA, serverOf(recorder), {
    prompt: ARTIFACT,
  });
  await turnWith(world, decide, await entriesOf(world));

  const answer = lookupAnswer(recorder);
  assert.ok(
    answer.split('\n').includes('notes.txt:1: the retry queue again'),
    'a file this reader did not write is answered about as it stands, not dropped',
  );
});

test('a lookup that names a place outside the bot own directory is answered in words', async () => {
  const world = makeWorld();
  const filed = archiveOf(['the retry queue was at 40 yesterday']);
  world.store.data.agents[world.agentA2].home = filed.home;

  const recorder = fakeServer({
    answers: [
      { toolCalls: [grepCall({ pattern: 'root', path: '../../etc' })] },
      { content: 'that is outside' },
    ],
  });
  const decide = await workOverServer(world.store, world.botA, serverOf(recorder), {
    prompt: ARTIFACT,
  });
  const record = await turnWith(world, decide, await entriesOf(world));

  assert.equal(record.produced.length, 0, 'a refused lookup is not a reason to end the turn');
  const answer = lookupAnswer(recorder);
  assert.match(answer, /can only look inside its own directory/, 'the bound, in words');
  assert.ok(answer.includes('"../../etc"'), 'and the name it would not resolve');
});

test('a glob that matches nothing answers with what is there instead of nothing', async () => {
  const world = makeWorld();
  const filed = archiveOf(['the retry queue was at 40 yesterday']);
  world.store.data.agents[world.agentA2].home = filed.home;

  const recorder = fakeServer({
    answers: [{ toolCalls: [globCall('notes/*.txt')] }, { content: 'no notes then' }],
  });
  const decide = await workOverServer(world.store, world.botA, serverOf(recorder), {
    prompt: ARTIFACT,
  });
  await turnWith(world, decide, await entriesOf(world));

  const answer = lookupAnswer(recorder);
  assert.match(answer, /nothing in this bot's own directory matches "notes\/\*\.txt"/);
  assert.ok(answer.includes(`archive/${filed.day}.jsonl`), 'and what it does have');
});

/**
 * **The two calls that keep something, and the one bound they share with the four that read.**
 *
 * `docs/host-rulings.md`, "The tools": the work agent's tools are the kernel's registry, and
 * `write` and `edit` are two of them. Through v10 a bot could look and nothing else, which is
 * not the agent that sentence describes — it could read what a note folded away and had no
 * way to keep a conclusion of its own. These are the tests that the capability is real: the
 * bytes land on the disk under the bot's own home, the answer comes back into the turn, and
 * a name that leaves that home is refused in words rather than resolved.
 */

/** A write call as a model writes one. */
function writeCall(path: string, text: string): unknown {
  return { id: 'call_4', function: { name: 'write', arguments: JSON.stringify({ path, text }) } };
}

/** An edit call as a model writes one. */
function editCall(path: string, find: string, replace: string): unknown {
  return {
    id: 'call_5',
    function: { name: 'edit', arguments: JSON.stringify({ path, find, replace }) },
  };
}

/** A home of this bot's own, empty to begin with: no archive, nothing filed. */
function homeOfBot(): string {
  return mkdtempSync(join(tmpdir(), 'seek-write-'));
}

test('write keeps a file under the bot own directory, and the answer is in the next request', async () => {
  const world = makeWorld();
  const home = homeOfBot();
  world.store.data.agents[world.agentA2].home = home;

  const recorder = fakeServer({
    answers: [
      { toolCalls: [writeCall('notes/retry.md', 'the queue was at 40\n')] },
      { toolCalls: [sayCall(world.room, 'written down')] },
    ],
  });
  const decide = await workOverServer(world.store, world.botA, serverOf(recorder), {
    prompt: ARTIFACT,
  });
  const record = await turnWith(world, decide, await entriesOf(world));

  assert.equal(
    readFileSync(join(home, 'notes', 'retry.md'), 'utf8'),
    'the queue was at 40\n',
    'the bytes are on the disk, under the home and at the name it gave',
  );
  assert.equal(
    lookupAnswer(recorder),
    'wrote notes/retry.md: 20 bytes, 1 line.',
    'and the model is told what it did, in the words the runtime chose',
  );
  assert.equal(record.produced.length, 1, 'a write does not end the turn: the bot went on to speak');
});

test('a write that names a place outside the bot own directory is refused, and nothing is written', async () => {
  const world = makeWorld();
  const home = homeOfBot();
  world.store.data.agents[world.agentA2].home = home;

  // A name nobody else can be holding: the parent of a `mkdtemp` is the shared temporary
  // directory, so a fixed name here would make this test's assertion depend on whether some
  // earlier run — or some earlier mutation of the refusal itself — left that file behind.
  const escaped = `escape-${process.pid}-${Date.now()}.md`;
  const recorder = fakeServer({
    answers: [{ toolCalls: [writeCall(`../${escaped}`, 'out of bounds')] }, { content: 'understood' }],
  });
  const decide = await workOverServer(world.store, world.botA, serverOf(recorder), {
    prompt: ARTIFACT,
  });
  const record = await turnWith(world, decide, await entriesOf(world));

  const answer = lookupAnswer(recorder);
  assert.match(answer, /can only write inside its own directory/, 'the bound, in words');
  assert.ok(answer.includes(`"../${escaped}"`), 'and the name it would not resolve');
  assert.equal(
    existsSync(join(home, '..', escaped)),
    false,
    'the refusal is the whole answer: no byte was written outside the home',
  );
  assert.equal(
    existsSync(join(home, escaped)),
    false,
    'and the name was not quietly re-rooted inside it either, which would be a different file',
  );
  assert.equal(record.produced.length, 0, 'a refused write is not a reason to end the turn');
});

test('edit changes the one place it names, and the file on the disk is what changed', async () => {
  const world = makeWorld();
  const home = homeOfBot();
  writeFileSync(join(home, 'notes.md'), '# plan\nretry queue at 40\n', 'utf8');
  world.store.data.agents[world.agentA2].home = home;

  const recorder = fakeServer({
    answers: [{ toolCalls: [editCall('notes.md', 'at 40', 'at 12')] }, { content: 'fixed' }],
  });
  const decide = await workOverServer(world.store, world.botA, serverOf(recorder), {
    prompt: ARTIFACT,
  });
  await turnWith(world, decide, await entriesOf(world));

  assert.equal(
    readFileSync(join(home, 'notes.md'), 'utf8'),
    '# plan\nretry queue at 12\n',
    'the one occurrence is replaced and the rest of the file is as it was',
  );
  assert.match(
    lookupAnswer(recorder),
    /^edited notes\.md: replaced 1 occurrence of "at 40" with "at 12"\./,
    'the model is told which text went and what took its place',
  );
});

test('an edit whose text occurs twice changes nothing, and says how many there are', async () => {
  const world = makeWorld();
  const home = homeOfBot();
  const before = 'queue at 40\nand the batch at 40 as well\n';
  writeFileSync(join(home, 'notes.md'), before, 'utf8');
  world.store.data.agents[world.agentA2].home = home;

  const recorder = fakeServer({
    answers: [{ toolCalls: [editCall('notes.md', 'at 40', 'at 12')] }, { content: 'two of them' }],
  });
  const decide = await workOverServer(world.store, world.botA, serverOf(recorder), {
    prompt: ARTIFACT,
  });
  await turnWith(world, decide, await entriesOf(world));

  // Replacing both would change a part of the file the model did not name, and there is no
  // reading of "replace this" that means "replace every one of them".
  assert.equal(readFileSync(join(home, 'notes.md'), 'utf8'), before, 'not one byte moved');
  const answer = lookupAnswer(recorder);
  assert.match(answer, /occurs 2 times in "notes\.md", so nothing was changed/);
  assert.match(answer, /Give more of the words around it/, 'and what to do about it');
});

test('an edit that has nothing to change says so rather than ending the turn', async () => {
  const world = makeWorld();
  const home = homeOfBot();
  world.store.data.agents[world.agentA2].home = home;
  writeFileSync(join(home, 'notes.md'), 'queue at 40\n', 'utf8');

  // No such file.
  const missing = fakeServer({
    answers: [{ toolCalls: [editCall('absent.md', 'anything', 'nothing')] }, { content: 'no file' }],
  });
  const decide = await workOverServer(world.store, world.botA, serverOf(missing), {
    prompt: ARTIFACT,
  });
  const record = await turnWith(world, decide, await entriesOf(world));

  assert.match(lookupAnswer(missing), /has no file "absent\.md" to change/);
  assert.equal(existsSync(join(home, 'absent.md')), false, 'and it does not make one');
  assert.equal(record.produced.length, 0, 'the turn goes on either way');

  // The file is there and the words are not, which is the other way to have nothing to do.
  const wrongWords = fakeServer({
    answers: [{ toolCalls: [editCall('notes.md', 'at 12', 'at 7')] }, { content: 'not there' }],
  });
  const second = await workOverServer(world.store, world.botA, serverOf(wrongWords), {
    prompt: ARTIFACT,
  });
  await turnWith(world, second, await entriesOf(world));

  assert.match(lookupAnswer(wrongWords), /nothing in "notes\.md" is "at 12", so nothing was changed/);
  assert.equal(
    readFileSync(join(home, 'notes.md'), 'utf8'),
    'queue at 40\n',
    'the file is what it was',
  );
});
