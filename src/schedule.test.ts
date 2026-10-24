import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { makeWorld } from './fixtures.ts';
import { InboxLoop } from './inbox.ts';
import {
  addRow,
  cancelRow,
  fireDue,
  listRows,
  scheduleAdd,
  scheduleAs,
  scheduleCancel,
  scheduleList,
} from './schedule.ts';
import { SeekStore } from './store.ts';
import type { Observation } from './types.ts';

const NOON = '2026-10-24T12:00:00.000Z';
const MORNING = '2026-10-24T08:00:00.000Z';

test('a due row becomes one reminder delivery — and never a line in a room', () => {
  const world = makeWorld();
  const row = addRow(world.store, {
    botId: world.botA,
    when: MORNING,
    text: 'check the release thread',
    now: '2026-10-23T00:00:00.000Z',
  });

  const delivered = fireDue(world.store, NOON);
  assert.equal(delivered.length, 1);
  const entry = delivered[0];
  assert.ok(entry);

  // The entry the bot wakes on.
  assert.equal(entry.kind, 'reminder');
  assert.equal(entry.bot_id, world.botA);
  assert.equal(entry.text, 'check the release thread');
  assert.equal(entry.schedule_id, row.id);
  assert.equal(entry.delivered_at, NOON);
  // §12: no room, no message — a reminder reaches the inbox and stops there.
  assert.equal(entry.room_id, undefined);
  assert.equal(entry.message_id, undefined);

  // It is on the bot's queue and nowhere else.
  assert.deepEqual(world.store.inbox(world.botA), [entry]);
  assert.deepEqual(world.store.inbox(world.botB), []);

  // "A fired reminder is not displayed": firing wrote no message, so no room
  // gained a line and no transcript has anything to show.
  assert.deepEqual(world.store.data.messages, {});

  // The row is spent, and it says when.
  assert.equal(row.state, 'fired');
  assert.equal(row.fired_at, NOON);
});

test('a row that has not come due yet waits, and delivers nothing', () => {
  const world = makeWorld();
  const row = addRow(world.store, {
    botId: world.botA,
    when: '2026-10-25T00:00:00.000Z',
    text: 'tomorrow',
    now: MORNING,
  });

  assert.deepEqual(fireDue(world.store, NOON), []);
  assert.equal(row.state, 'pending');
  assert.equal(row.fired_at, undefined);
  assert.deepEqual(world.store.inbox(world.botA), []);
});

test('the text arrives exactly as it was written', () => {
  const world = makeWorld();
  // Summarised, translated or trimmed on the way out is the defect §12 names;
  // this is a note to a future self, so the bytes have to survive.
  const text = '记得看 release thread\n第二行  with  double  spaces  ';
  addRow(world.store, { botId: world.botA, when: MORNING, text, now: MORNING });

  const [entry] = fireDue(world.store, NOON);
  assert.ok(entry);
  assert.equal(entry.text, text);
  assert.equal(world.store.data.schedule[0]?.text, text);
});

test('firing is idempotent: a second pass delivers nothing', () => {
  const world = makeWorld();
  addRow(world.store, {
    botId: world.botA,
    when: MORNING,
    text: 'once',
    now: MORNING,
  });

  assert.equal(fireDue(world.store, NOON).length, 1);
  assert.deepEqual(fireDue(world.store, NOON), []);
  // A later clock does not resurrect it either.
  assert.deepEqual(fireDue(world.store, '2026-10-30T00:00:00.000Z'), []);
  assert.equal(world.store.inbox(world.botA).length, 1);
});

test('a row missed while the process was down fires once, on the next start', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seek-schedule-'));
  const path = join(directory, 'seek.json');
  try {
    const world = makeWorld();
    // The store has to own the path from the start: `makeWorld()` builds an
    // in-memory one, whose `save()` writes nothing.
    const store = new SeekStore(world.store.data, path);
    addRow(store, {
      botId: world.botA,
      when: MORNING,
      text: 'while you were out',
      now: MORNING,
    });
    await store.save();

    // The process was closed when it came due: nothing fired then. It fires on
    // the next start — an instant missed is not a reminder skipped.
    const reopened = await SeekStore.load(path);
    const delivered = fireDue(reopened, NOON);
    assert.equal(delivered.length, 1);
    await reopened.save();

    // And it does not fire again on the start after that.
    const later = await SeekStore.load(path);
    assert.deepEqual(fireDue(later, '2026-10-26T00:00:00.000Z'), []);
    assert.equal(later.inbox(world.botA).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('ten rows missed while the machine slept fire in time order, each its own delivery', () => {
  const world = makeWorld();
  // Written out of order on purpose: the comparator sorts, the author does not.
  const minutes = [7, 1, 9, 3, 5, 0, 8, 2, 6, 4];
  for (const minute of minutes) {
    addRow(world.store, {
      botId: world.botA,
      when: `2026-10-24T08:${String(minute).padStart(2, '0')}:00.000Z`,
      text: `row ${minute}`,
      now: MORNING,
    });
  }

  const delivered = fireDue(world.store, NOON);
  assert.equal(delivered.length, 10);
  assert.deepEqual(
    delivered.map((entry) => entry.text),
    ['row 0', 'row 1', 'row 2', 'row 3', 'row 4', 'row 5', 'row 6', 'row 7', 'row 8', 'row 9'],
  );
  // Ten deliveries, not one summary of ten.
  assert.equal(new Set(delivered.map((entry) => entry.id)).size, 10);
});

test('a cancelled row never fires, and its tombstone stays readable', () => {
  const world = makeWorld();
  const row = addRow(world.store, {
    botId: world.botA,
    when: MORNING,
    text: 'never mind',
    now: MORNING,
  });
  cancelRow(world.store, row.id);

  assert.deepEqual(fireDue(world.store, NOON), []);
  assert.equal(row.state, 'cancelled');
  // "I had planned this and dropped it" is information its author may want back.
  assert.deepEqual(
    listRows(world.store).map((own) => own.state),
    ['cancelled'],
  );
});

test('the state moves once, and never backwards', () => {
  const world = makeWorld();
  const row = addRow(world.store, {
    botId: world.botA,
    when: MORNING,
    text: 'already happened',
    now: MORNING,
  });
  fireDue(world.store, NOON);

  assert.throws(() => cancelRow(world.store, row.id), /never backwards/);
  assert.equal(row.state, 'fired');
});

test('one global calendar: nothing filters the table by bot, and each row fires for its own bot', () => {
  const world = makeWorld();
  addRow(world.store, {
    botId: world.botA,
    when: MORNING,
    text: 'for A',
    now: MORNING,
  });
  addRow(world.store, {
    botId: world.botB,
    when: MORNING,
    text: 'for B',
    now: MORNING,
  });

  // Every bot reads the whole table: a shared calendar, not a private one.
  assert.equal(listRows(world.store).length, 2);

  const delivered = fireDue(world.store, NOON);
  // Two rows written for the same instant have no order between them: the
  // tie-break is `created_at`, then the id, and both rows were written at the
  // same moment. What this asserts is that each one fired for its own bot.
  assert.deepEqual(
    delivered.map((entry) => `${entry.bot_id}: ${entry.text}`).sort(),
    [`${world.botA}: for A`, `${world.botB}: for B`].sort(),
  );
  assert.deepEqual(
    world.store.inbox(world.botB).map((entry) => entry.text),
    ['for B'],
  );
});

test('addRow refuses a row that could never mean what its author wrote', () => {
  const world = makeWorld();
  assert.throws(
    () =>
      addRow(world.store, {
        botId: 'ou_nobody',
        when: MORNING,
        text: 'to nobody',
      }),
    /unknown bot/,
  );
  assert.throws(
    () =>
      addRow(world.store, {
        botId: world.botA,
        when: 'not a time',
        text: 'when?',
      }),
    /not an instant/,
  );
  assert.throws(
    () => addRow(world.store, { botId: world.botA, when: MORNING, text: '' }),
    /no text/,
  );
  assert.equal(listRows(world.store).length, 0);
});

test('a fired reminder takes the fast-pass: the bot wakes, and nothing is asked', async () => {
  const world = makeWorld();
  addRow(world.store, {
    botId: world.botA,
    when: MORNING,
    text: 'you promised to look at this',
    now: MORNING,
  });
  fireDue(world.store, NOON);

  const woken: Observation[][] = [];
  const loop = new InboxLoop(
    world.store,
    (entries) => {
      woken.push(entries);
    },
    () => {
      // Stage 1 must never be reached: a reminder is a row-2 fast-pass.
      throw new Error('a reminder must not reach the watch agent');
    },
  );

  const result = await loop.tick(world.botA);
  assert.equal(result.woke, true);
  assert.equal(woken.length, 1);
  assert.equal(woken[0]?.[0]?.text, 'you promised to look at this');
  // Nothing was judged, so nothing was spent on a model.
  assert.deepEqual(result.settled?.judge, []);
  assert.equal(loop.turns, 1);
});

/** Give one agent the tool, as `agents.yml` eventually will — the list decides. */
function grant(world: ReturnType<typeof makeWorld>, agentId: string): void {
  const agent = world.store.data.agents[agentId];
  if (!agent) throw new Error(`no agent ${agentId} in this world`);
  agent.tools.push('schedule');
}

test('the tool has three verbs and nothing else', () => {
  const world = makeWorld();
  grant(world, world.agentA2);
  const tool = scheduleAs(world.store, world.botA, world.agentA2);

  // §12: list, add, cancel — no "run now", no recurrence, no priority. The
  // shape is pinned because a fourth verb is how the registry starts growing
  // siblings one exception at a time.
  assert.deepEqual(Object.keys(tool).sort(), ['add', 'cancel', 'list']);

  const row = tool.add(MORNING, 'check the release thread', { now: MORNING });
  // The ordinary case is the caller's own bot; the row still states which bot.
  assert.equal(row.bot_id, world.botA);
  // Which agent plans it is on the record, not just which bot it is for.
  assert.equal(row.created_by, world.agentA2);
  assert.equal(row.state, 'pending');
  assert.equal(row.created_at, MORNING);
  assert.deepEqual(
    tool.list().map((own) => own.id),
    [row.id],
  );

  tool.cancel(row.id);
  assert.equal(row.state, 'cancelled');
  // The tombstone stays readable, and the state never moves backwards.
  assert.deepEqual(
    tool.list().map((own) => own.state),
    ['cancelled'],
  );
  assert.throws(() => tool.cancel(row.id), /never backwards/);
});

test('the three verbs are plain functions too, judged by the caller they are given', () => {
  const world = makeWorld();
  grant(world, world.agentA2);
  const call = { botId: world.botA, agentId: world.agentA2 };

  const row = scheduleAdd(world.store, { ...call, when: MORNING, text: 'one row', now: MORNING });
  assert.equal(scheduleList(world.store, call).length, 1);
  assert.equal(scheduleCancel(world.store, { ...call, rowId: row.id }).state, 'cancelled');
  // A row nobody could ever read is refused before it exists.
  assert.throws(
    () => scheduleAdd(world.store, { ...call, when: 'not a time', text: 'when?' }),
    /not an instant/,
  );
  assert.throws(
    () => scheduleAdd(world.store, { ...call, when: MORNING, text: '' }),
    /no text/,
  );
  assert.equal(scheduleList(world.store, call).length, 1);
});

test("an agent whose tool list has no 'schedule' cannot use any verb", () => {
  const world = makeWorld();
  // The fixture's work agent was given `say` and not `schedule`: the tool list
  // is what decides, exactly as it does for speaking.
  const tool = scheduleAs(world.store, world.botA, world.agentA2);
  for (const verb of [
    () => tool.list(),
    () => tool.add(MORNING, 'should never arrive'),
    () => tool.cancel('sc_whatever'),
  ]) {
    assert.throws(verb, /is not in its tool list/);
  }
  assert.deepEqual(world.store.data.schedule, []);

  // The watch agent is a decision model that makes no tool call at all.
  assert.deepEqual(world.store.data.agents[world.agentA1]?.tools, []);
  assert.throws(
    () => scheduleAs(world.store, world.botA, world.agentA1).list(),
    /is not in its tool list/,
  );
});

test('an agent of another bot cannot keep this bot\'s calendar', () => {
  const world = makeWorld();
  grant(world, world.agentB1);

  assert.throws(
    () => scheduleAs(world.store, world.botA, world.agentB1).add(MORNING, 'borrowed calendar'),
    /does not work for bot/,
  );
  assert.throws(() => scheduleAs(world.store, world.botA, 'ag_nobody').list(), /unknown agent/);
  assert.deepEqual(world.store.data.schedule, []);
});

test('one shared calendar: a bot reads the rows another bot wrote', () => {
  const world = makeWorld();
  grant(world, world.agentA2);
  grant(world, world.agentB1);

  scheduleAs(world.store, world.botA, world.agentA2).add(MORNING, 'from A', { now: MORNING });

  // Nothing filters the table by bot: a bot sees what a peer planned, which is
  // what makes it a shared calendar rather than a private one.
  const readByB = scheduleAs(world.store, world.botB, world.agentB1).list();
  assert.deepEqual(
    readByB.map((own) => [own.bot_id, own.text, own.created_by]),
    [[world.botA, 'from A', world.agentA2]],
  );
});

test('a bot may leave a reminder for another bot, and it reaches that bot', () => {
  const world = makeWorld();
  grant(world, world.agentA2);
  const tool = scheduleAs(world.store, world.botA, world.agentA2);

  const row = tool.add(MORNING, 'for B, not for me', { forBot: world.botB, now: MORNING });
  assert.equal(row.bot_id, world.botB);
  assert.equal(row.created_by, world.agentA2);

  fireDue(world.store, NOON);
  assert.deepEqual(
    world.store.inbox(world.botB).map((entry) => entry.text),
    ['for B, not for me'],
  );
  assert.deepEqual(world.store.inbox(world.botA), []);

  // A target bot that does not exist is refused before anything is written.
  assert.throws(
    () => tool.add(MORNING, 'to nobody', { forBot: 'ou_nobody' }),
    /unknown bot/,
  );
  assert.equal(listRows(world.store).length, 1);
});

test('the row the tool writes is the reminder that fires, word for word', () => {
  const world = makeWorld();
  grant(world, world.agentA2);
  const text = '记得看 release thread\n第二行  with  double  spaces  ';
  const row = scheduleAs(world.store, world.botA, world.agentA2).add(MORNING, text, {
    now: MORNING,
  });

  // The write side and the read side meet: what the tool wrote is what the
  // comparator fires, and the text survives the whole trip untouched (§12 (d)).
  const [entry] = fireDue(world.store, NOON);
  assert.ok(entry);
  assert.equal(entry.kind, 'reminder');
  assert.equal(entry.text, text);
  assert.equal(entry.bot_id, world.botA);
  assert.equal(entry.schedule_id, row.id);
  assert.equal(entry.room_id, undefined);
  assert.equal(row.state, 'fired');
  assert.deepEqual(world.store.data.messages, {});
});
