import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildBox } from './box.ts';
import { deliver } from './delivery.ts';
import { makeWorld, type World } from './fixtures.ts';
import { skeletonOf, type PromptArtifact } from './prompts.ts';
import { newId, SeekStore } from './store.ts';
import type { Id, MembershipRole, Observation } from './types.ts';
import {
  bindOptions,
  watchAs,
  type Tokeniser,
  type Watch,
  type WatchInput,
  type WatchOptions,
  type WatchReading,
} from './watch.ts';

// The artifact the runtime assembles from, in the shape the shipped one has. The
// trailing space is not cosmetic: the two options are appended to the assembled
// text, so a prompt that ends mid-word lets the tokeniser merge the option into the
// prompt's last token — and then no id at "the prompt's own end" is the option's,
// which `bindOptions` refuses. A real prompt artifact ends at a boundary its suffix
// survives.
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
};
// What a mask is measured against: the same artifact with an empty box.
const PROMPT = skeletonOf(ARTIFACT);
const POINT = {
  threshold: 0.9,
  promptVersion: 'watch-v1',
  measuredOn: '76 hand-written cases, three disjoint sets',
};

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

/** The tokeniser the suite binds with, and what it was asked to encode. */
interface StubTokeniser extends Tokeniser {
  /** Every text encoded, in order — so a test can see the ids were not re-derived. */
  calls: string[];
}

/**
 * A tokeniser shaped like the hazard the design names.
 *
 * A word keeps the space in front of it, so `act` and ` act` are different ids —
 * that is the difference between masking the answer and masking a token the model
 * never reads. `ids` pins particular chunks; `split` makes a chunk cost more than
 * one token, which is what `snooze` did. Anything unlisted still gets an id of its
 * own, so the stub encodes whole sentences rather than only the words a test
 * happens to care about.
 */
function makeTokeniser(
  options: { ids?: Record<string, number>; split?: Record<string, number> } = {},
): StubTokeniser {
  const ids: Record<string, number> = options.ids ?? {};
  const split = options.split ?? {};
  const calls: string[] = [];
  let next = 5000;
  const idOf = (chunk: string): number => {
    const known = ids[chunk];
    if (known !== undefined) return known;
    const assigned = (ids[chunk] = next);
    next += 1;
    return assigned;
  };
  return {
    calls,
    encode(text: string): number[] {
      calls.push(text);
      const out: number[] = [];
      for (const chunk of text.match(/ ?[^ ]+/g) ?? []) {
        const pieces = split[chunk];
        if (pieces === undefined) out.push(idOf(chunk));
        else for (let index = 0; index < pieces; index += 1) out.push(idOf(`${chunk}#${index}`));
      }
      return out;
    },
  };
}

function bind(
  world: World,
  model: Stub['model'],
  threshold = POINT.threshold,
  tokeniser: Tokeniser = makeTokeniser(),
): Watch {
  return watchAs(world.store, world.botA, model, {
    window: 10,
    prompt: ARTIFACT,
    operatingPoint: { ...POINT, threshold },
    tokeniser,
  });
}

test('the box a judgement reads still holds the entries that woke it', async () => {
  const world = makeWorld();
  say(world, ['one', 'two', 'three']);
  // The loop pops the whole queue before stage 0 or stage 1 sees anything.
  const entries = await world.store.drain(world.botA);
  assert.equal(entries.length, 3);

  const { model, seen } = stub({ probabilities: { act: 0.1, ignore: 0.9 } });
  const watch = bind(world, model);
  const acting = await watch(entries);

  assert.deepEqual(acting, [], 'a decided non-act opens no turn');
  assert.equal(seen.length, 1, 'one room, one question');
  assert.equal(seen[0].state.total, 3, 'the drained entries are not forgotten');
  assert.deepEqual(
    seen[0].state.delta.map((entry) => entry.id),
    [entries[2].id, entries[1].id, entries[0].id],
    'newest first, and the newest is the line that woke the bot',
  );
});

test('the unread count reaches the model even when the box overflows', async () => {
  const world = makeWorld();
  say(world, ['m0', 'm1', 'm2', 'm3', 'm4']);
  const entries = await world.store.drain(world.botA);

  const { model, seen } = stub({ probabilities: { act: 0.1, ignore: 0.9 } });
  await watchAs(world.store, world.botA, model, {
    window: 2,
    prompt: ARTIFACT,
    operatingPoint: POINT,
    tokeniser: makeTokeniser(),
  })(entries);

  const state = seen[0].state;
  assert.equal(state.read, 2);
  assert.equal(state.total, 5);
  assert.equal(state.unread, 3, 'a judgement that could not read everything says so');
  assert.equal(state.read + state.unread, state.total);
});

test('the previous verdict arrives as a fact about the record, never as an instruction', async () => {
  const world = makeWorld();
  say(world, ['one', 'two', 'three']);
  // A previous judgement kept the oldest entry: `keep` takes no action and leaves
  // the line where it was, so it is still on the queue.
  const queued = world.store.inbox(world.botA);
  queued[0].verdict = 'keep';
  queued[0].reason = 'waiting for a reply';
  const entries = await world.store.drain(world.botA);

  const { model, seen } = stub({ probabilities: { act: 0.1, ignore: 0.9 } });
  await bind(world, model)(entries);

  const last = seen[0].state.lastVerdict;
  assert.deepEqual(
    last,
    {
      verdict: 'keep',
      entryId: entries[0].id,
      delivered_at: entries[0].delivered_at,
      reason: 'waiting for a reply',
    },
    'the record as it stands: what was decided, on which entry, when, and why',
  );
  assert.notEqual(typeof last, 'string', 'a sentence here would be the box arguing');
  assert.equal(seen[0].state.observationsSinceLastVerdict, 2, 'and how stale it is');
});

test('the operating point is the caller\'s: the same answer acts at 0.62 and does not at 0.93', async () => {
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

  const { model, seen } = stub((input) => ({
    probabilities:
      input.state.roomId === world.room
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
  assert.equal(reminder.verdict, undefined, 'a reminder is stage 0\'s, not stage 1\'s');
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
  const options = { window: 10, prompt: ARTIFACT, tokeniser: makeTokeniser() };

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
        operatingPoint: { threshold: 1, promptVersion: PROMPT.version },
      }),
    /strictly between 0 and 1/,
    'a cut of 1 acts on nothing and is not a cut',
  );
  assert.throws(
    () =>
      watchAs(world.store, world.botA, model, {
        ...options,
        operatingPoint: { threshold: Number.NaN, promptVersion: PROMPT.version },
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

// ---- where in the vocabulary the answer is read (agent-lifecycle.md §4, line 79) ----

test("the mask carries the id the option takes past the prompt, not the bare word's", async () => {
  const world = makeWorld();
  say(world, ['one']);
  const entries = await world.store.drain(world.botA);

  // The hazard, measured: a word after a space is a different id from the same word
  // on its own, and the mask has to be aimed at the position the answer is read from.
  const tokeniser = makeTokeniser({ ids: { act: 100, ' act': 101, ignore: 200, ' ignore': 201 } });
  const { model, seen } = stub({ probabilities: { act: 0.1, ignore: 0.9 } });
  await bind(world, model, POINT.threshold, tokeniser)(entries);

  assert.deepEqual(seen[0].mask.act, { token: 'act', id: 101 }, 'masking 100 leaves " act" unreachable');
  assert.deepEqual(seen[0].mask.ignore, { token: 'ignore', id: 201 });
});

test('the default pair binds without the caller declaring anything', async () => {
  const world = makeWorld();
  say(world, ['one']);
  const entries = await world.store.drain(world.botA);

  const { model, seen } = stub({ probabilities: { act: 0.2, ignore: 0.8 } });
  await bind(world, model)(entries);

  assert.equal(seen[0].mask.act.token, 'act');
  assert.equal(seen[0].mask.ignore.token, 'ignore');
  assert.notEqual(seen[0].mask.act.id, seen[0].mask.ignore.id, 'two answers, two ids');
});

test('the mask follows the options the caller declared, not the defaults', () => {
  const tokeniser = makeTokeniser({ ids: { ' yes': 11, ' no': 12, yes: 1, no: 2 } });
  const bound = bindOptions(tokeniser, PROMPT, { act: 'yes', ignore: 'no' });

  assert.deepEqual(bound.act, { token: 'yes', id: 11 });
  assert.deepEqual(bound.ignore, { token: 'no', id: 12 });
});

test('an option the tokeniser splits is refused, because it cannot carry a probability', () => {
  // `snooze` split into four pieces and had to be replaced; this is the check that
  // would have said so before a single verdict was spent on it.
  const tokeniser = makeTokeniser({ split: { ' snooze': 4 } });

  assert.throws(
    () => bindOptions(tokeniser, PROMPT, { act: 'act', ignore: 'snooze' }),
    /takes 4 tokens at the prompt's end/,
  );
});

test("a prompt whose own encoding the suffix rewrites is refused", () => {
  // No trailing space: appending the option merges it into the prompt's last token,
  // so nothing at "the prompt's own end" is the option. The prompt is what has to
  // change, and this is where it gets said.
  const midWord = { version: 'watch-v1', text: 'Answer act or ignore.' };

  assert.throws(
    () => bindOptions(makeTokeniser(), midWord, { act: 'act', ignore: 'ignore' }),
    /rewrites the prompt's own encoding/,
  );
});

test('an option that adds no token past the prompt has no id to read', () => {
  // A truncated context: the prompt fills it, so the option falls outside and there
  // is nothing to read an answer from.
  const truncated: Tokeniser = { encode: () => [1, 2, 3] };

  assert.throws(
    () => bindOptions(truncated, PROMPT, { act: 'act', ignore: 'ignore' }),
    /adds no token past this prompt/,
  );
});

test('two options that land on one id are refused, because they are one answer', () => {
  const tokeniser = makeTokeniser({ ids: { ' act': 7, ' ignore': 7 } });

  assert.throws(
    () => bindOptions(tokeniser, PROMPT, { act: 'act', ignore: 'ignore' }),
    /land on the same id \(7\)/,
  );
});

test('binding refuses a runtime that carries no tokeniser at all', () => {
  // The runtime refuses this before it ever gets here, so this is the guard on the
  // exported function rather than on the runtime: a caller that reaches for
  // `bindOptions` directly is told the same thing, and not left to a crash where the
  // ids would be read off a tokeniser that is not there.
  assert.throws(
    () => bindOptions(undefined as never, PROMPT, { act: 'act', ignore: 'ignore' }),
    /needs a tokeniser/,
  );
});

test('a runtime without a tokeniser refuses to run', () => {
  const world = makeWorld();
  const { model } = stub({ probabilities: { act: 0.9, ignore: 0.1 } });

  assert.throws(
    () =>
      watchAs(world.store, world.botA, model, {
        window: 10,
        prompt: ARTIFACT,
        operatingPoint: POINT,
      } as never),
    /needs a tokeniser/,
    'without one it cannot say where its own answer is read',
  );
});

test('the binding is measured once, not on every tick', async () => {
  const world = makeWorld();
  const tokeniser = makeTokeniser();
  const { model } = stub({ probabilities: { act: 0.1, ignore: 0.9 } });
  const watch = bind(world, model, POINT.threshold, tokeniser);

  assert.equal(tokeniser.calls.length, 3, 'the prompt and its two suffixes, once each');

  say(world, ['one']);
  await watch(await world.store.drain(world.botA));
  assert.equal(tokeniser.calls.length, 3, 'a tick encodes nothing: the ids are already known');

  say(world, ['two']);
  await watch(await world.store.drain(world.botA));
  assert.equal(tokeniser.calls.length, 3, 'and neither does the next one');
});

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

    // The box's last-verdict part is filled from the record — which is the whole
    // reason the entry stayed: before this, the tick destroyed the only copy.
    const box = buildBox(reloaded, world.botA, world.room, { window: 10 });
    assert.equal(box.lastVerdict?.verdict, 'ignore');
    assert.equal(box.lastVerdict?.entryId, entries[0].id);
    assert.equal(box.observationsSinceLastVerdict, 0, 'nothing has followed it');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a later tick reads the previous verdict, and how stale it is', async () => {
  const world = makeWorld();
  say(world, ['first']);
  const { model: quiet } = stub({ probabilities: { act: 0.1, ignore: 0.9 } });
  const first = await world.store.drain(world.botA);
  await bind(world, quiet)(first);

  // A second tick, over messages that arrived after the first was judged. The
  // earlier judgement is still the record's, and the box says how old it is.
  say(world, ['second', 'third']);
  const { seen, model } = stub({ probabilities: { act: 0.1, ignore: 0.9 } });
  await bind(world, model)(await world.store.drain(world.botA));

  const box = seen.at(-1)!.state;
  assert.equal(box.lastVerdict?.verdict, 'ignore', 'the verdict an earlier tick wrote');
  assert.equal(box.lastVerdict?.entryId, first[0].id);
  assert.equal(box.total, 3, 'the entry it judged, and the two that followed');
  assert.equal(
    box.observationsSinceLastVerdict,
    2,
    'counted off the record, so a stale verdict cannot read as fresh',
  );
});

/**
 * A room digest, written the way a compaction writes one: a summary and the point it
 * consumed up to, together (`agent-lifecycle.md` §3). The box reads the summary as
 * part of its front, so this is what must invalidate a resident head.
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

test('a judgement on an unchanged head reads only what arrived since the last one', async () => {
  const world = makeWorld();
  say(world, ['one', 'two', 'three']);
  const { model, seen } = stub({ probabilities: { act: 0.1, ignore: 0.9 } });
  const watch = bind(world, model);

  await watch(await world.store.drain(world.botA));
  assert.equal(seen[0].resident, undefined, 'nothing is resident before the first judgement');

  say(world, ['four']);
  await watch(await world.store.drain(world.botA));

  const warm = seen[1].resident;
  assert.ok(warm, 'the second judgement reads a head it has already read');
  assert.deepEqual(
    warm.entries,
    seen[0].state.delta.map((entry) => entry.id),
    'what it has read is the previous box, in that box own order',
  );

  // The property the design asks for: the judgement pays for the arrival, not for
  // the box. Everything the last judgement was handed is claimed as read, and the
  // only line that is not is the one that arrived since.
  const claimed = new Set(warm.entries);
  const before = new Set(seen[0].state.delta.map((entry) => entry.id));
  const arrived = seen[1].state.delta.filter((entry) => !before.has(entry.id));
  assert.equal(arrived.length, 1, 'one entry arrived since the last judgement');
  assert.ok(!claimed.has(arrived[0].id), 'and it is the one thing this judgement pays for');

  say(world, ['five']);
  await watch(await world.store.drain(world.botA));
  assert.equal(seen[2].resident?.key, warm.key, 'the head has not moved');
  assert.equal(seen[2].resident?.entries.length, 4, 'and everything the second read is now resident');
});

test('a compaction that rewrites the summary invalidates the head once', async () => {
  const world = makeWorld();
  say(world, ['one', 'two']);
  const { model, seen } = stub({ probabilities: { act: 0.1, ignore: 0.9 } });
  const watch = bind(world, model);

  const first = await world.store.drain(world.botA);
  await watch(first);
  assert.equal(seen[0].state.summary, undefined, 'there was no summary when it was read');

  // A compaction replaces the consumed entries with a summary, so the front of the
  // box is now text this model has never read.
  summarise(world, 'the room is arranging a release', first.at(-1)!.id);

  say(world, ['three']);
  await watch(await world.store.drain(world.botA));
  assert.equal(seen[1].resident, undefined, 'a new summary is a new head');
  assert.equal(seen[1].state.summary, 'the room is arranging a release');

  say(world, ['four']);
  await watch(await world.store.drain(world.botA));
  assert.ok(seen[2].resident, 'and the head under the new summary is warm from then on');
  assert.deepEqual(
    seen[2].resident?.entries,
    seen[1].state.delta.map((entry) => entry.id),
    'warm again over what the judgement after the compaction read',
  );
});

test('two rooms of one bot keep separate heads', async () => {
  const world = makeWorld();
  const elsewhere = addRoom(world);
  const { model, seen } = stub({ probabilities: { act: 0.1, ignore: 0.9 } });
  const watch = bind(world, model);

  say(world, ['here'], world.room);
  await watch(await world.store.drain(world.botA));
  assert.equal(seen[0].state.roomId, world.room);

  say(world, ['there'], elsewhere);
  await watch(await world.store.drain(world.botA));
  assert.equal(
    seen[1].resident,
    undefined,
    "a room's first judgement is cold beside a warm neighbour: a head is per (bot, room)",
  );
});

test('two bots in one room keep separate heads', async () => {
  const world = makeWorld();
  const options = {
    window: 10,
    prompt: ARTIFACT,
    operatingPoint: POINT,
    tokeniser: makeTokeniser(),
  };
  say(world, ['one']);
  const forA = stub({ probabilities: { act: 0.1, ignore: 0.9 } });
  await watchAs(world.store, world.botA, forA.model, options)(await world.store.drain(world.botA));
  assert.equal(forA.seen.length, 1);

  say(world, ['two']);
  const forB = stub({ probabilities: { act: 0.1, ignore: 0.9 } });
  await watchAs(world.store, world.botB, forB.model, options)(await world.store.drain(world.botB));
  assert.equal(
    forB.seen[0].resident,
    undefined,
    'a second bot in the same room has read nothing, whatever its neighbour has',
  );
});

test('a runtime built again reads its first judgement cold', async () => {
  const world = makeWorld();
  say(world, ['one', 'two']);
  const before = stub({ probabilities: { act: 0.1, ignore: 0.9 } });
  await bind(world, before.model)(await world.store.drain(world.botA));

  say(world, ['three']);
  const after = stub({ probabilities: { act: 0.1, ignore: 0.9 } });
  await bind(world, after.model)(await world.store.drain(world.botA));
  assert.equal(
    after.seen[0].resident,
    undefined,
    'a head is warm only in the process that read it: a restart has no cache to resume',
  );
});

test('an entry the window no longer holds is not claimed as read', async () => {
  const world = makeWorld();
  say(world, ['one', 'two', 'three']);
  const { model, seen } = stub({ probabilities: { act: 0.1, ignore: 0.9 } });
  const watch = watchAs(world.store, world.botA, model, {
    window: 2,
    prompt: ARTIFACT,
    operatingPoint: POINT,
    tokeniser: makeTokeniser(),
  });

  await watch(await world.store.drain(world.botA));
  assert.equal(seen[0].state.read, 2, 'the window holds two entries');

  say(world, ['four']);
  await watch(await world.store.drain(world.botA));
  const warm = seen[1].resident;
  assert.ok(warm, 'the head has not changed');
  assert.deepEqual(
    warm.entries,
    [seen[0].state.delta[0].id],
    'only what this box still holds can be claimed — the entry the window pushed out is not',
  );
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
    const acting = await watchAs(world.store, world.botA, model, {
      window: 10,
      tokeniser: makeTokeniser(),
    })(entries);
    return { acting, asked: seen[0] };
  }

  const at = await decideAt(0.6);
  assert.equal(at.asked.prompt.version, 'watch-v1', 'the shipped version, not a literal in here');
  assert.equal(
    at.asked.prompt.text,
    'You are the ops bot of a payments team. Your job: catch incidents and answer ' +
      'questions the team asks. You stay quiet otherwise.\n\nMessage: deploy is red\n' +
      'Do you need to do something about this message? Answer act or ignore. ',
    'the measured shape, assembled by the runtime from the file',
  );
  assert.equal(at.acting.length, 1, 'exactly at the shipped cut, and the cut is inclusive');

  const below = await decideAt(0.599);
  assert.equal(below.acting.length, 0, 'and a hair below it does not act');
});

test('the question is the artifact’s, and no caller can hand the judgement a second one', async () => {
  const world = makeWorld();
  say(world, ['deploy is red']);
  const entries = await world.store.drain(world.botA);
  const { model, seen } = stub({ probabilities: { act: 0.9, ignore: 0.1 } });

  // The box used to take a caller's question set and hand it to the model *beside*
  // the question the artifact already asks. Two questions then reach one forward
  // pass and only one of them was measured, which is the defect the design's
  // "the question put to the watch model is part of the contract" was written
  // against. The seam is gone, and this is the shape a caller still arrives in: an
  // extra property on an options object — which a JavaScript caller passes happily,
  // and which TypeScript would refuse.
  const withQuestions = {
    window: 10,
    prompt: ARTIFACT,
    operatingPoint: POINT,
    tokeniser: makeTokeniser(),
    questions: [{ name: 'act', options: ['act', 'ignore'] }],
  } as unknown as WatchOptions;

  await watchAs(world.store, world.botA, model, withQuestions)(entries);

  assert.equal('questions' in seen[0].state, false, 'the box is told, never asked');
  assert.ok(
    seen[0].prompt.text.endsWith('Does this room need you to act? Answer act or ignore. '),
    'the only question asked is the artifact’s last part, trailing space and all',
  );
  assert.deepEqual(
    seen[0].options,
    { act: 'act', ignore: 'ignore' },
    'and it is answered over the declared options, not an invented pair',
  );
});

test('the box is rendered oldest first, one line per entry', async () => {
  const world = makeWorld();
  say(world, ['one', 'two', 'three']);
  const { model, seen } = stub({ probabilities: { act: 0.1, ignore: 0.9 } });
  await bind(world, model)(await world.store.drain(world.botA));

  const text = seen[0].prompt.text;
  assert.ok(text.indexOf('Message: one') < text.indexOf('Message: two'), 'oldest first');
  assert.ok(text.indexOf('Message: two') < text.indexOf('Message: three'));
  assert.equal(
    text.match(/^Message: /gm)?.length,
    3,
    'one line per entry — an arrival appends a line rather than reflowing the box',
  );
  assert.ok(
    text.trimEnd().endsWith('Answer act or ignore.'),
    'and the question is still the last thing asked',
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

  const text = seen[0].prompt.text;
  assert.ok(
    text.includes('Room memory: the room is arranging a release\n\nMessage: two\n'),
    'the summary arrives in the text, in the order the file lists the parts',
  );
  assert.ok(text.endsWith('Answer act or ignore. '), 'and the continuation point has not moved');
});
