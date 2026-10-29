import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildBox } from './box.ts';
import { deliver } from './delivery.ts';
import { makeDirectWorld, makeWorld, type World } from './fixtures.ts';
import type { PromptArtifact } from './prompts.ts';
import { newId, SeekStore } from './store.ts';
import type { Id, MembershipRole, Observation } from './types.ts';
import {
  declaredOptions,
  watchAs,
  type Watch,
  type WatchInput,
  type WatchReading,
} from './watch.ts';

// A small artifact in the shape the shipped one has, with a cut of its own so a test
// can see the caller's number take effect. Nothing here is the shipped file: the one
// test that asserts what ships loads it through `watchAs`'s own default.
const ARTIFACT: PromptArtifact = {
  version: 'test-v1',
  system: 'You are {bot}.',
  afterSystem: '\n',
  parts: [
    { name: 'position', text: 'What you do here: {position}.', after: '\n', when: 'position' },
    { name: 'others', text: 'The other bots in this room: {others}.', after: '\n', when: 'others' },
    { name: 'room', text: '\nRoom: {room}', after: '\n', when: 'room' },
    { name: 'summary', text: 'Room memory: {summary}', after: '\n', when: 'summary' },
    { name: 'message', text: 'Message: {text}', after: '\n', when: 'always', each: 'observation' },
  ],
  question: {
    instructions: 'Should you respond to this?',
    criteria: {
      act: 'this one is for me',
      ignore: 'this one is not for me',
    },
  },
  operatingPoint: { threshold: 0.9 },
};

const POINT = { threshold: 0.9, promptVersion: 'test-v1' };

interface Stub {
  /** Every question put to the model, in the order it was asked. */
  seen: WatchInput[];
  model: { read(input: WatchInput): WatchReading };
}

/** A decision model that answers the same way every time, and remembers being asked. */
function stub(answer: WatchReading | ((input: WatchInput) => WatchReading)): Stub {
  const seen: WatchInput[] = [];
  return {
    seen,
    model: {
      read(input: WatchInput): WatchReading {
        seen.push(input);
        return typeof answer === 'function' ? answer(input) : answer;
      },
    },
  };
}

function say(world: World, texts: string[], roomId: Id = world.room): void {
  for (const text of texts) {
    deliver(world.store, { roomId, senderId: world.me, text });
  }
}

/** A second room the same bot is in, so one tick can hold two rooms. */
function addRoom(world: World): Id {
  const roomId = newId('oc');
  world.store.data.rooms[roomId] = {
    id: roomId,
    name: 'elsewhere',
    chat_mode: 'group',
    created_at: '2026-10-24T00:00:00.000Z',
  };
  const members: { principal: Id; role: MembershipRole }[] = [
    { principal: world.me, role: 'owner' },
    { principal: world.botA, role: 'member' },
  ];
  for (const member of members) {
    const id = newId('mb');
    world.store.data.memberships[id] = {
      id,
      room_id: roomId,
      principal_id: member.principal,
      joined_at: '2026-10-24T00:00:00.000Z',
      role: member.role,
    };
  }
  return roomId;
}

function bind(world: World, model: Stub['model'], threshold = POINT.threshold): Watch {
  return watchAs(world.store, world.botA, model, {
    window: 10,
    prompt: ARTIFACT,
    operatingPoint: { ...POINT, threshold },
  });
}

/**
 * A room digest, written the way a compaction writes one: a summary and the point it
 * consumed up to, together (`agent-lifecycle.md` §3).
 */
function summarise(world: World, body: string, consumedTo: Id, botId: Id = world.botA): void {
  const agent = world.store.agentsOf(botId).find((row) => row.role === 'work');
  assert.ok(agent, 'a room digest belongs to the bot work agent');
  world.store.memoriesOf(agent.id).push({
    id: newId('mm'),
    agent_id: agent.id,
    level: 'room_digest',
    room_id: world.room,
    body,
    consumed_to: consumedTo,
    updated_at: '2026-10-24T00:00:00.000Z',
  });
}

// ---------------------------------------------------------------------------
// The state: what the model is told before it is asked anything
// ---------------------------------------------------------------------------

test('the state holds every entry it was handed, oldest first', async () => {
  const world = makeWorld();
  say(world, ['one', 'two', 'three']);
  // The loop pops the whole queue before stage 0 or stage 1 sees anything.
  const entries = await world.store.drain(world.botA);
  assert.equal(entries.length, 3);

  const { model, seen } = stub({ probabilities: { act: 0.1, ignore: 0.9 } });
  const acting = await bind(world, model)(entries);

  assert.deepEqual(acting, [], 'a decided non-act opens no turn');
  assert.equal(seen.length, 1, 'one room, one question');

  const text = seen[0].prompt.state;
  assert.ok(text.includes('Message: one'), 'the drained entries are not forgotten');
  assert.ok(text.indexOf('Message: one') < text.indexOf('Message: two'), 'oldest first');
  assert.ok(text.indexOf('Message: two') < text.indexOf('Message: three'));
  assert.equal(
    text.match(/^Message: /gm)?.length,
    3,
    'one line per entry, so the newest arrival is the last thing read',
  );
});

test('a window that cannot hold everything judges only what it holds', async () => {
  const world = makeWorld();
  say(world, ['m0', 'm1', 'm2', 'm3', 'm4']);
  const entries = await world.store.drain(world.botA);

  const { model, seen } = stub({ probabilities: { act: 0.1, ignore: 0.9 } });
  await watchAs(world.store, world.botA, model, {
    window: 2,
    prompt: ARTIFACT,
    operatingPoint: POINT,
  })(entries);

  const text = seen[0].prompt.state;
  assert.ok(text.includes('Message: m4'), 'the newest is read');
  assert.ok(text.includes('Message: m3'));
  assert.equal(
    text.includes('Message: m2'),
    false,
    'and an entry beyond the window is not: the box never exceeds it',
  );
});

test('the state names the bot being asked, and the other bots in the room', async () => {
  // The defect this line closed: four bots in one room read the same words and every one
  // of them had to decide from the sentence alone whether it was the one addressed, so a
  // room either woke all four or none. Naming the asker and its neighbours is what makes
  // "is this for me" a question a model can answer — measured, and it is the line whose
  // absence collapses the two answers into one distribution (`watch-v3.json`).
  const world = makeWorld();
  world.store.data.bots[world.botA].position = 'the one who answers about servers';
  say(world, ['everyone, what should this app be?']);

  const { model, seen } = stub({ probabilities: { act: 0.7, ignore: 0.3 } });
  await bind(world, model)(await world.store.drain(world.botA));
  const state = seen[0].prompt.state;

  assert.ok(state.includes('You are A.'), 'the name a person gave it, in the head');
  assert.ok(state.includes('The other bots in this room: B.'));
  // The card's position is a line of its own, and only for a bot whose card says one.
  assert.ok(state.includes('What you do here: the one who answers about servers.'));
});

test('a bot whose card says nothing is asked the same question without its traces', async () => {
  const world = makeWorld();
  say(world, ['one']);
  const { model, seen } = stub({ probabilities: { act: 0.1, ignore: 0.9 } });
  await bind(world, model)(await world.store.drain(world.botA));

  const state = seen[0].prompt.state;
  assert.equal(state.includes('What you do here'), false, 'no empty sentence in the middle');
  assert.equal(
    state.includes('The other bots in this room: B.\nWhat you do here'),
    false,
    'and the lines that are absent do not leave their separators behind',
  );
});

test('a bot alone in the room is not told about bots that are not there', async () => {
  const world = makeDirectWorld();
  say(world, ['one']);
  const { model, seen } = stub({ probabilities: { act: 0.1, ignore: 0.9 } });
  await watchAs(world.store, world.botA, model, {
    window: 10,
    prompt: ARTIFACT,
    operatingPoint: POINT,
  })(await world.store.drain(world.botA));

  assert.equal(
    seen[0].prompt.state.includes('other bots'),
    false,
    'a room with nobody else in it says nothing rather than "none"',
  );
});

test('a bot nobody named is asked under its id', async () => {
  const world = makeWorld();
  world.store.data.bots[world.botA].name = '';
  say(world, ['one']);
  const { model, seen } = stub({ probabilities: { act: 0.1, ignore: 0.9 } });
  await bind(world, model)(await world.store.drain(world.botA));

  assert.ok(
    seen[0].prompt.state.startsWith(`You are ${world.botA}.`),
    'the id is what every other reading in the store calls a nameless bot',
  );
});

test('a room memory is rendered where the artifact puts it, from the digest', async () => {
  const world = makeWorld();
  say(world, ['one']);
  const first = await world.store.drain(world.botA);
  const { model: quiet } = stub({ probabilities: { act: 0.1, ignore: 0.9 } });
  await bind(world, quiet)(first);
  summarise(world, 'the room is arranging a release', first.at(-1)!.id);

  say(world, ['two']);
  const { model, seen } = stub({ probabilities: { act: 0.1, ignore: 0.9 } });
  await bind(world, model)(await world.store.drain(world.botA));

  const text = seen[0].prompt.state;
  assert.ok(
    text.includes('Room memory: the room is arranging a release\nMessage: two\n'),
    'the summary arrives in the text, in the order the file lists the parts',
  );
});

test('a picture it cannot read is counted, and the room is judged anyway', async () => {
  const world = makeWorld();
  deliver(world.store, {
    roomId: world.room,
    senderId: world.me,
    kind: 'image',
    text: '看这张',
    media: { key: 'blobs/screen.png', mime: 'image/png' },
  });
  const picture = await world.store.drain(world.botA);

  const { model, seen } = stub({ probabilities: { act: 0.99, ignore: 0.01 } });
  const judge = bind(world, model);

  assert.equal((await judge(picture)).length, 1, 'the verdict is reached, and opens its turn');
  assert.equal(seen.length, 1, 'the question is put: one unread picture does not end the room');
  assert.equal(
    judge.last?.unreadPictures,
    1,
    'and the picture it could not read is on the record rather than dropped in silence',
  );

  // The half a refusal took away: the picture stays in the box, so the plain message
  // posted after it was refused exactly as the picture was, and the room went mute for as
  // long as the picture stayed in the window.
  deliver(world.store, { roomId: world.room, senderId: world.me, text: 'and then words' });
  const later = await world.store.drain(world.botA);
  assert.equal((await judge(later)).length, 1, 'the room keeps answering after the picture');
  assert.equal(seen.length, 2, 'one question per room per tick, and this room is still asked');
  assert.equal(judge.last?.unreadPictures, 1, 'the picture is still in the window, and still counted');
});

// ---------------------------------------------------------------------------
// The cut
// ---------------------------------------------------------------------------

test("the operating point is the caller's: the same answer acts at 0.62 and does not at 0.93", async () => {
  async function decideAt(threshold: number) {
    const world = makeWorld();
    say(world, ['one']);
    const entries = await world.store.drain(world.botA);
    const { model } = stub({ probabilities: { act: 0.8, ignore: 0.2 } });
    const acting = await bind(world, model, threshold)(entries);
    return { acting, entry: entries[0] };
  }

  const loose = await decideAt(0.62);
  assert.equal(loose.acting.length, 1, '0.8 is above a cut of 0.62');
  assert.equal(loose.entry.verdict, 'act');

  const tight = await decideAt(0.93);
  assert.equal(tight.acting.length, 0, '0.8 is below a cut of 0.93');
  assert.equal(tight.entry.verdict, 'ignore', 'and not 0.5, which would have acted');
});

test('the cut is inclusive: a probability exactly at the operating point acts', async () => {
  const world = makeWorld();
  say(world, ['one']);
  const entries = await world.store.drain(world.botA);
  const { model } = stub({ probabilities: { act: 0.8, ignore: 0.2 } });
  const acting = await bind(world, model, 0.8)(entries);
  assert.equal(acting.length, 1);
});

test('a verdict lands on the entries that were judged and on nothing else', async () => {
  const world = makeWorld();
  const elsewhere = addRoom(world);
  say(world, ['here'], world.room);
  say(world, ['there'], elsewhere);
  const entries = await world.store.drain(world.botA);
  // One more arrives after the pop: nobody has asked about it yet.
  say(world, ['arrived while the tick was running'], world.room);
  const waiting = world.store.pending(world.botA).map((entry) => entry.id);
  assert.equal(waiting.length, 1);

  // Two rooms, two questions, told apart by what the state holds: this is one call per
  // room, so the model is handed one room's text at a time.
  const { model, seen } = stub((input) => ({
    probabilities: input.prompt.state.includes('Message: here')
      ? { act: 0.99, ignore: 0.01 }
      : { act: 0.01, ignore: 0.99 },
  }));
  const acting = await bind(world, model)(entries);

  assert.equal(seen.length, 2, 'one question per room, never one for the batch');
  assert.equal(acting.length, 1);
  assert.equal(acting[0].room_id, world.room);

  const [here, there] = entries;
  assert.equal(here.verdict, 'act');
  assert.equal(there.verdict, 'ignore');

  const queued = world.store.inbox(world.botA).find((entry) => entry.id === waiting[0]);
  assert.equal(queued?.verdict, undefined, 'an entry nobody judged keeps no verdict');
});

test('an answer that cannot be read is no act, and is never keep or snooze', async () => {
  const unreadable: unknown[] = [
    {},
    { probabilities: undefined },
    { probabilities: { act: 0.99 } },
    { probabilities: { ignore: 0.99 } },
    { probabilities: { act: Number.NaN, ignore: 0.1 } },
    { probabilities: { act: 1.4, ignore: 0.1 } },
    { probabilities: { act: '0.99', ignore: '0.01' } },
    { reason: 'I am not answering' },
  ];

  for (const answer of unreadable) {
    const world = makeWorld();
    say(world, ['one']);
    const entries = await world.store.drain(world.botA);
    const { model } = stub(answer as WatchReading);
    const watch = bind(world, model);
    const acting = await watch(entries);

    assert.deepEqual(acting, [], `${JSON.stringify(answer)} must not act`);
    assert.equal(entries[0].verdict, 'ignore', `${JSON.stringify(answer)} is no act (§4)`);
    assert.equal(watch.last?.unparsed, 1, 'and the runtime says it could not read it');
  }
});

test('a reason is written when one came back, and never invented', async () => {
  async function decideWith(answer: WatchReading) {
    const world = makeWorld();
    say(world, ['one']);
    const entries = await world.store.drain(world.botA);
    const { model } = stub(answer);
    await bind(world, model)(entries);
    return entries[0];
  }

  const withReason = await decideWith({
    probabilities: { act: 0.99, ignore: 0.01 },
    reason: 'they asked me by name',
  });
  assert.equal(withReason.verdict, 'act');
  assert.equal(withReason.reason, 'they asked me by name');

  const without = await decideWith({ probabilities: { act: 0.99, ignore: 0.01 } });
  assert.equal(without.reason, undefined, 'no reason came back, so none is written');
});

test('an entry with no room is left alone and counted, not judged against some room', async () => {
  const world = makeWorld();
  say(world, ['one']);
  const entries = await world.store.drain(world.botA);
  const reminder: Observation = {
    id: newId('ob'),
    bot_id: world.botA,
    kind: 'reminder',
    hints: { mentionsMe: false, repliesToMe: false, direct: false },
    text: 'note to my future self',
    delivered_at: '2026-10-24T00:00:00.000Z',
  };

  const { model, seen } = stub({ probabilities: { act: 0.99, ignore: 0.01 } });
  const watch = bind(world, model);
  const acting = await watch([...entries, reminder]);

  assert.equal(seen.length, 1, 'still one question, about the one room that has one');
  assert.equal(reminder.verdict, undefined, "a reminder is stage 0's, not stage 1's");
  assert.deepEqual(watch.last?.roomless, [reminder.id]);
  assert.deepEqual(acting, entries, 'and it does not ride along into the turn');
});

test('one save per call, however many rooms were asked about', async () => {
  const world = makeWorld();
  const elsewhere = addRoom(world);
  say(world, ['here'], world.room);
  say(world, ['there'], elsewhere);
  const entries = await world.store.drain(world.botA);

  let saves = 0;
  const save = world.store.save.bind(world.store);
  world.store.save = async () => {
    saves += 1;
    await save();
  };

  const { model, seen } = stub({ probabilities: { act: 0.99, ignore: 0.01 } });
  const acting = await bind(world, model)(entries);

  assert.equal(seen.length, 2);
  assert.equal(saves, 1, 'the verdicts of one judgement are one write');
  assert.deepEqual(
    acting.map((entry) => entry.id),
    entries.map((entry) => entry.id),
    'the entries come back in the order they arrived',
  );
});

test('a runtime wired to a cut measured on another question refuses to run', () => {
  const world = makeWorld();
  const { model } = stub({ probabilities: { act: 0.99, ignore: 0.01 } });
  const options = { window: 10, prompt: ARTIFACT };

  assert.throws(
    () =>
      watchAs(world.store, world.botA, model, {
        ...options,
        operatingPoint: { threshold: 0.9, promptVersion: 'watch-v0' },
      }),
    /calibrated against prompt "watch-v0"/,
    'a prompt edit moves what the number means',
  );
  assert.throws(
    () =>
      watchAs(world.store, world.botA, model, {
        ...options,
        operatingPoint: { threshold: 1, promptVersion: ARTIFACT.version },
      }),
    /strictly between 0 and 1/,
    'a cut of 1 acts on nothing and is not a cut',
  );
  assert.throws(
    () =>
      watchAs(world.store, world.botA, model, {
        ...options,
        operatingPoint: { threshold: Number.NaN, promptVersion: ARTIFACT.version },
      }),
    /numeric threshold/,
  );
  assert.throws(
    () =>
      watchAs(world.store, world.botA, model, {
        ...options,
        operatingPoint: POINT,
        optionTokens: { act: 'yes', ignore: 'yes' },
      }),
    /must be different tokens/,
  );
});

// ---------------------------------------------------------------------------
// The two options: named in the artifact, read by name off the answer
// ---------------------------------------------------------------------------

test('the two options the answer is read by are the ones the artifact describes', () => {
  assert.deepEqual(declaredOptions(), { act: 'act', ignore: 'ignore' });
  assert.deepEqual(declaredOptions({ act: 'respond' }), { act: 'respond', ignore: 'ignore' });
  assert.throws(() => declaredOptions({ act: '  ' }), /non-empty string/);
});

test('the declared option names travel to the model, and the answer is read by them', async () => {
  const world = makeWorld();
  say(world, ['one']);
  const entries = await world.store.drain(world.botA);
  // An artifact that asks with other words, from a file of its own: the names are the
  // artifact's, and the runtime reads the answer keyed by them and by nothing else.
  const renamed: PromptArtifact = {
    ...ARTIFACT,
    version: 'test-v2',
    question: {
      instructions: 'Is this for me?',
      criteria: { respond: 'yes, it is for me', silence: 'no, it is for someone else' },
    },
  };
  const { model, seen } = stub({ probabilities: { respond: 0.95, silence: 0.05 } });
  const acting = await watchAs(world.store, world.botA, model, {
    window: 10,
    prompt: renamed,
    optionTokens: { act: 'respond', ignore: 'silence' },
  })(entries);

  assert.deepEqual(seen[0].options, { act: 'respond', ignore: 'silence' });
  assert.deepEqual(seen[0].prompt.question, {
    instructions: 'Is this for me?',
    criteria: { respond: 'yes, it is for me', silence: 'no, it is for someone else' },
  });
  assert.equal(acting.length, 1, 'and a probability read under that name acts');
});

test('an artifact that cannot describe a declared option is refused before a tick', () => {
  const world = makeWorld();
  const { model } = stub({ probabilities: { act: 0.99, ignore: 0.01 } });
  assert.throws(
    () =>
      watchAs(world.store, world.botA, model, {
        window: 10,
        prompt: ARTIFACT,
        operatingPoint: POINT,
        optionTokens: { act: 'respond' },
      }),
    /no meaning for "respond"/,
    'an option the model cannot choose for a stated reason is not an option',
  );
});

// ---------------------------------------------------------------------------
// What a tick leaves on the record
// ---------------------------------------------------------------------------

test('a verdict a tick wrote survives a restart, and the next box reads it back', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seek-verdict-'));
  const path = join(directory, 'seek.json');
  try {
    // The same world, on a path: what the tick writes has somewhere to land.
    const seeded = makeWorld();
    const world: World = { ...seeded, store: new SeekStore(seeded.store.data, path) };
    say(world, ['anything I should look at?']);

    const { model } = stub({ probabilities: { act: 0.1, ignore: 0.9 } });
    const entries = await world.store.drain(world.botA);
    await bind(world, model)(entries);

    // Not "the object the tick returned": the entry it judged, read back off the
    // disk by a store that never saw it in memory.
    const reloaded = await SeekStore.load(path);
    const record = reloaded.inbox(world.botA);
    assert.equal(record.length, 1, 'the entry a tick judged is on the disk');
    assert.equal(record[0].id, entries[0].id);
    assert.equal(record[0].verdict, 'ignore', 'and the verdict is on it');
    assert.equal(record[0].state, 'consumed', 'marked as taken, not deleted');
    assert.equal(reloaded.pending(world.botA).length, 0, 'and nothing is waiting again');

    // The box's last-verdict part is still read off the record — which is the whole
    // reason the entry stayed: the tick used to destroy the only copy.
    const box = buildBox(reloaded, world.botA, world.room, { window: 10 });
    assert.equal(box.lastVerdict?.verdict, 'ignore');
    assert.equal(box.lastVerdict?.entryId, entries[0].id);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// ---- the prompt is a file, and the cut ships with it (src/README.md lines 26, 27) ----

test('no artifact and no cut given means the shipped file and its 0.600', async () => {
  async function decideAt(probability: number) {
    const world = makeWorld();
    say(world, ['deploy is red']);
    const entries = await world.store.drain(world.botA);
    const { model, seen } = stub({ probabilities: { act: probability, ignore: 1 - probability } });
    // Deliberately no `prompt` and no `operatingPoint`: what a caller who says
    // nothing gets is the shipped artifact and the cut measured against it.
    const acting = await watchAs(world.store, world.botA, model, { window: 10 })(entries);
    return { acting, asked: seen[0] };
  }

  const at = await decideAt(0.6);
  assert.equal(at.asked.prompt.version, 'watch-v3', 'the shipped version, not a literal in here');
  assert.equal(at.acting.length, 1, 'exactly at the shipped cut, and the cut is inclusive');

  // Verbatim apart from the timestamp, which is the entry's own: the head names the bot
  // this judgement is for, the neighbours in the room, the room, then the message.
  const stamped = /^\[(.+)\] me: deploy is red$/m.exec(at.asked.prompt.state);
  assert.ok(stamped !== null, 'the message line names who spoke and when');
  assert.equal(Number.isNaN(Date.parse(stamped[1])), false, 'the time is a real timestamp');
  assert.equal(
    at.asked.prompt.state.replace(stamped[0], '[<at>] me: deploy is red'),
    'You are A, one of the bots in this chat client.\n' +
      'The other bots in this room: B.\n' +
      '\nRoom: room\n' +
      '\n[<at>] me: deploy is red\n',
    'the shipped shape, with this bot named in its head and the room named',
  );

  const below = await decideAt(0.599);
  assert.equal(below.acting.length, 0, 'and a hair below it does not act');
});

test('the question is the artifact’s, and no caller can hand the judgement a second one', async () => {
  const world = makeWorld();
  say(world, ['deploy is red']);
  const entries = await world.store.drain(world.botA);
  const { model, seen } = stub({ probabilities: { act: 0.9, ignore: 0.1 } });

  // The box used to take a caller's question set and hand it to the model *beside* the
  // question the artifact already asks. Two questions then reach one forward pass and
  // only one of them was measured. The seam is gone, and this is the shape a caller
  // still arrives in: an extra property on an options object.
  const withQuestions = {
    window: 10,
    prompt: ARTIFACT,
    operatingPoint: POINT,
    questions: [{ name: 'act', options: ['act', 'ignore'] }],
  } as unknown as Parameters<typeof watchAs>[3];

  await watchAs(world.store, world.botA, model, withQuestions)(entries);

  assert.deepEqual(
    seen[0].prompt.question,
    {
      instructions: 'Should you respond to this?',
      criteria: { act: 'this one is for me', ignore: 'this one is not for me' },
    },
    'the only question asked is the artifact’s, criteria and all',
  );
  assert.deepEqual(
    seen[0].options,
    { act: 'act', ignore: 'ignore' },
    'and it is answered over the declared options, not an invented pair',
  );
  assert.equal(Object.hasOwn(seen[0], 'questions'), false, 'the state is told, never asked');
});
