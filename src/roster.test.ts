import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  agentIdFor,
  applyRoster,
  parseRoster,
  readRoster,
  rosterPath,
  ROSTER_FILE,
} from './roster.ts';
import { SeekStore } from './store.ts';

/** A store in memory, with a bot called Echo. */
function storeWithEcho(): { store: SeekStore; bot: string } {
  const store = new SeekStore();
  const bot = 'ou_echo';
  store.data.bots[bot] = { id: bot, name: 'Echo', description: 'the bot' };
  return { store, bot };
}

const TWO_ROWS = `agents:
  - bot: Echo
    role: watch
    tools: []
  - bot: Echo
    role: work
    tools: [say]
`;

test('the roster shipped with the tree parses: the watch row may call nothing, the work row may speak', async () => {
  // The file in the repository rather than a fixture: if the shipped roster
  // stops parsing, a fresh clone is a clone whose kernel has no agents.
  const shipped = fileURLToPath(new URL('../seek-data/agents.yml', import.meta.url));
  const rows = await readRoster(shipped);
  assert.ok(rows);
  assert.deepEqual(
    rows.map((row) => [row.bot, row.role, row.tools]),
    [
      ['Echo', 'watch', []],
      ['Echo', 'work', ['say']],
    ],
  );
});

test('the roster is read from beside the store, and nothing else is', () => {
  assert.equal(rosterPath('/data/seek.json'), join('/data', ROSTER_FILE));
  assert.equal(ROSTER_FILE, 'agents.yml');
});

test('a missing roster is undefined, and an empty one is no rows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'seek-roster-'));
  try {
    // The two answers are different and the caller has to be able to tell them
    // apart: no file says nothing about the store, no rows says the bot has no
    // agents.
    assert.equal(await readRoster(join(dir, 'agents.yml')), undefined);
    await writeFile(join(dir, 'agents.yml'), 'agents:\n');
    assert.deepEqual(await readRoster(join(dir, 'agents.yml')), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('comments, blank lines and quoted values survive the read', () => {
  const rows = parseRoster(`# the roster
agents:
  # a row about the room-reader

  - bot: Echo
    role: watch
    tools: []
    prompt: "keep # this hash"
`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].prompt, 'keep # this hash');
});

test('a field the subset does not know is an error naming the line, not a field dropped', () => {
  assert.throws(
    () =>
      parseRoster(`agents:
  - bot: Echo
    role: work
    tool: [say]
    tools: [say]
`),
    /agents\.yml:4: 'tool' is not a roster field \(bot, role, home, model, prompt, tools\)/,
  );
});

test('a row without tools is refused: a mute work agent must not look configured', () => {
  assert.throws(
    () =>
      parseRoster(`agents:
  - bot: Echo
    role: work
`),
    /agents\.yml:2: a row needs 'tools'/,
  );
});

test('a block list is refused by name, because the parser only reads the one-line form', () => {
  assert.throws(
    () =>
      parseRoster(`agents:
  - bot: Echo
    role: work
    tools:
      - say
`),
    /a list has to sit on one line — \[say, schedule\], or \[\] for none — not a block list/,
  );
});

test('tools given as a bare word is refused, rather than read as a one-letter list', () => {
  assert.throws(
    () =>
      parseRoster(`agents:
  - bot: Echo
    role: work
    tools: say
`),
    /'tools' takes a list on one line — \[say, schedule\], or \[\] for none — not 'say'/,
  );
});

test('a tab indent is refused rather than guessed at', () => {
  assert.throws(
    () => parseRoster('agents:\n\t- bot: Echo\n'),
    /agents\.yml:2: indent with spaces, not tabs/,
  );
});

test('the same tool twice in one row is refused', () => {
  assert.throws(
    () =>
      parseRoster(`agents:
  - bot: Echo
    role: work
    tools: [say, say]
`),
    /agents\.yml:2: 'tools' names 'say' twice/,
  );
});

test('the same field twice in one row is refused', () => {
  assert.throws(
    () =>
      parseRoster(`agents:
  - bot: Echo
    role: watch
    tools: []
    tools: [say]
`),
    /agents\.yml:5: 'tools' appears twice in one row/,
  );
});

test('the file has to open with its one top-level key', () => {
  assert.throws(() => parseRoster('- bot: Echo\n'), /agents\.yml:1: the file must start with 'agents:'/);
});

test('a bot is found by its name or by its id, and both land on the same agent', () => {
  const byName = storeWithEcho();
  applyRoster(byName.store, parseRoster(TWO_ROWS));

  const byId = storeWithEcho();
  applyRoster(byId.store, parseRoster(TWO_ROWS.replace('- bot: Echo', '- bot: ou_echo')));

  assert.deepEqual(
    Object.keys(byId.store.data.agents),
    Object.keys(byName.store.data.agents),
    'the same bot written two ways is the same bot',
  );
  assert.equal(byName.store.agentsOf(byName.bot).length, 2);
});

test('a name that fits two bots is refused, because the wrong bot answers in the wrong voice', () => {
  const store = new SeekStore();
  store.data.bots['ou_a'] = { id: 'ou_a', name: 'Echo' };
  store.data.bots['ou_b'] = { id: 'ou_b', name: 'Echo' };
  assert.throws(
    () => applyRoster(store, parseRoster(TWO_ROWS)),
    /'Echo' names 2 bots \(ou_a, ou_b\) — use the id/,
  );
});

test('a row for a bot this store does not have is refused, listing the ones it has', () => {
  const store = new SeekStore();
  store.data.bots['ou_a'] = { id: 'ou_a', name: 'Someone else' };
  assert.throws(
    () => applyRoster(store, parseRoster(TWO_ROWS)),
    /no bot is 'Echo' in this store — known bots: 'Someone else' \(ou_a\)/,
  );
});

test('a role declared twice for one bot is refused', () => {
  const { store } = storeWithEcho();
  assert.throws(
    () =>
      applyRoster(
        store,
        parseRoster(`agents:
  - bot: Echo
    role: work
    tools: [say]
  - bot: Echo
    role: work
    tools: [schedule]
`),
      ),
    /'work' is declared twice for bot ou_echo — a role is unique per bot/,
  );
});

test('an agent’s id is a function of its bot and its role, so a rebuild lands where it already was', () => {
  const { store, bot } = storeWithEcho();
  applyRoster(store, parseRoster(TWO_ROWS));
  const first = store.agentsOf(bot).map((agent) => `${agent.role}:${agent.id}`).sort();

  // The same roster again — every open rebuilds the shard, so this is the
  // ordinary path and not an edge case.
  applyRoster(store, parseRoster(TWO_ROWS));
  const second = store.agentsOf(bot).map((agent) => `${agent.role}:${agent.id}`).sort();

  assert.deepEqual(second, first);
  // Derived, not random: the shape is the store's own, and the value does not
  // move when the round does.
  assert.equal(agentIdFor(bot, 'work'), agentIdFor(bot, 'work'));
  assert.match(agentIdFor(bot, 'work'), /^ag_[0-9a-f]{16}$/);
  assert.notEqual(agentIdFor(bot, 'work'), agentIdFor(bot, 'watch'));
});

test('a third row is a third agent, and nothing has to be told about it', () => {
  const { store, bot } = storeWithEcho();
  const rows = parseRoster(`${TWO_ROWS}  - bot: Echo
    role: file
    tools: [read, glob]
`);
  applyRoster(store, rows);
  assert.deepEqual(
    store.agentsOf(bot).map((agent) => agent.role).sort(),
    ['file', 'watch', 'work'],
  );
});

test('the allowlist is whatever the row says, and it is the row’s own', () => {
  const { store, bot } = storeWithEcho();
  applyRoster(
    store,
    parseRoster(`agents:
  - bot: Echo
    role: work
    tools: [say, schedule]
  - bot: Echo
    role: watch
    tools: []
`),
  );
  const work = store.agentsOf(bot).find((agent) => agent.role === 'work');
  const watch = store.agentsOf(bot).find((agent) => agent.role === 'watch');
  assert.deepEqual(work?.tools, ['say', 'schedule']);
  assert.deepEqual(watch?.tools, []);
});

test('a home is derived beside the store unless the row names one', () => {
  const { store, bot } = storeWithEcho();
  applyRoster(
    store,
    parseRoster(`agents:
  - bot: Echo
    role: watch
    tools: []
  - bot: Echo
    role: work
    tools: [say]
    home: /elsewhere/work
`),
    '/data',
  );
  const watch = store.agentsOf(bot).find((agent) => agent.role === 'watch');
  const work = store.agentsOf(bot).find((agent) => agent.role === 'work');
  assert.equal(watch?.home, join('/data', 'agents', bot, 'watch'));
  assert.equal(work?.home, '/elsewhere/work');
});

test('the shard is rebuilt, not merged: a row taken out of the file is an agent that is gone', () => {
  const { store, bot } = storeWithEcho();
  applyRoster(store, parseRoster(TWO_ROWS));
  assert.equal(store.agentsOf(bot).length, 2);

  applyRoster(
    store,
    parseRoster(`agents:
  - bot: Echo
    role: work
    tools: [say]
`),
  );
  assert.deepEqual(
    store.agentsOf(bot).map((agent) => agent.role),
    ['work'],
  );
});

test('a row without a model is `unset`, which is not a choice the file made', () => {
  const { store, bot } = storeWithEcho();
  applyRoster(store, parseRoster(TWO_ROWS));
  for (const agent of store.agentsOf(bot)) {
    assert.equal(agent.model, 'unset');
    assert.equal(agent.prompt, 'unset');
  }
});
