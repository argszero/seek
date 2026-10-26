/**
 * The identity a bot pushes down to the agent its loop calls
 * (`agent-lifecycle.md` §2, "An agent is told whose it is").
 *
 * What each case is for, in the section's own terms:
 *
 * - the bot's name, avatar and description reach the agent, and so does **every
 *   agent of that bot, itself included**, with its role, its home and what it
 *   may do;
 * - it is **pushed, not stored** — so a rename and a new row are seen by an agent
 *   that was already there, with nothing migrated, and neither the agent row nor
 *   anything else in the store gains a copy;
 * - a bot's identity never reaches another bot's agent, and the answer is a copy
 *   that cannot be written back through.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeWorld } from './fixtures.ts';
import { agentIdFor } from './roster.ts';
import { identityFor } from './identity.ts';
import { newId } from './store.ts';
import type { Agent } from './types.ts';

/** Bot A's agents by role, for assertions that do not depend on store order. */
function byRole(identity: ReturnType<typeof identityFor>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of identity.roster) out[row.role] = row.agentId;
  return out;
}

test('an agent is told whose it is: its bot, and every agent of that bot including itself', () => {
  const world = makeWorld();
  const identity = identityFor(world.store, world.botA, world.agentA2);

  assert.equal(identity.bot.id, world.botA);
  assert.equal(identity.bot.name, 'A');
  assert.equal(identity.bot.description, 'the bot');
  assert.equal(identity.bot.avatar, undefined, 'a bot with no avatar says so by having none');

  // Both rows of bot A, and only bot A's.
  assert.deepEqual(byRole(identity), {
    watch: world.agentA1,
    work: world.agentA2,
  });
  assert.equal(identity.roster.some((row) => row.agentId === world.agentB1), false);
});

test('each roster row carries its role, its home and what it may do — itself included, once', () => {
  const world = makeWorld();
  const identity = identityFor(world.store, world.botA, world.agentA2);

  const self = identity.roster.filter((row) => row.self);
  assert.equal(self.length, 1, 'exactly one row is the agent being told');
  assert.equal(self[0].agentId, world.agentA2);
  assert.equal(self[0].role, 'work');
  assert.equal(self[0].home, '/tmp/seek/a/work');

  const watch = identity.roster.find((row) => row.role === 'watch');
  assert.ok(watch, 'a bot’s other agent is part of its roster');
  assert.deepEqual(watch.tools, [], 'a watch agent that may call nothing says so');
  assert.equal(watch.self, false);
  assert.deepEqual(self[0].tools, ['say'], 'what the work agent may do is its allowlist');
});

test('it is pushed, not stored: a renamed bot is seen renamed by an agent already there', () => {
  const world = makeWorld();
  const before = identityFor(world.store, world.botA, world.agentA2);
  assert.equal(before.bot.name, 'A');

  world.store.data.bots[world.botA].name = 'Echo';
  const after = identityFor(world.store, world.botA, world.agentA2);

  assert.equal(after.bot.name, 'Echo', 'the rename reaches the agent with nothing migrated');
  // And nothing was written down: the agent row is a runnable, not a record of
  // whose it is (`data-model.md` rule 13 — model, prompt, tools, home, and no
  // identity of its own).
  const agent = world.store.data.agents[world.agentA2];
  assert.deepEqual(Object.keys(agent).sort(), [
    'bot_id',
    'home',
    'id',
    'model',
    'prompt',
    'role',
    'tools',
  ]);
});

test('a new roster row reaches an agent that was there first, with no migration', () => {
  const world = makeWorld();
  const before = identityFor(world.store, world.botA, world.agentA1);
  assert.equal(before.roster.length, 2);

  // A third role, as `agents.yml` would add one: the same derived id a rebuild
  // of the shard would land on (`roster.ts`, `agentIdFor`).
  const third: Agent = {
    id: agentIdFor(world.botA, 'digest'),
    bot_id: world.botA,
    role: 'digest',
    home: '/tmp/seek/a/digest',
    model: 'unset',
    prompt: 'unset',
    tools: ['schedule'],
  };
  world.store.data.agents[third.id] = third;

  const after = identityFor(world.store, world.botA, world.agentA1);
  assert.deepEqual(Object.keys(byRole(after)).sort(), ['digest', 'watch', 'work']);
  // The rows that were there first are untouched, and one of them is still the
  // agent being told.
  assert.equal(after.roster.filter((row) => row.self).length, 1);
  assert.equal(after.roster.find((row) => row.self)?.agentId, world.agentA1);
});

test('a bot is not capped at two agents, and nothing here assumes a count', () => {
  const world = makeWorld();
  const roles = ['digest', 'recall', 'relay'];
  for (const role of roles) {
    const id = agentIdFor(world.botB, role);
    world.store.data.agents[id] = {
      id,
      bot_id: world.botB,
      role,
      home: `/tmp/seek/b/${role}`,
      model: 'unset',
      prompt: 'unset',
      tools: [],
    };
  }

  const identity = identityFor(world.store, world.botB, world.agentB1);
  assert.deepEqual(Object.values(byRole(identity)).length, 4);
  assert.deepEqual(Object.keys(byRole(identity)).sort(), ['digest', 'recall', 'relay', 'work']);
});

test('a bot’s identity never reaches another bot’s agent', () => {
  const world = makeWorld();
  assert.throws(
    () => identityFor(world.store, world.botA, world.agentB1),
    /is not .*’s|is not .*'s/,
  );
});

test('an unknown bot or an unknown agent is an error, not an empty answer', () => {
  const world = makeWorld();
  assert.throws(() => identityFor(world.store, newId('ou'), world.agentA1), /unknown bot/);
  assert.throws(() => identityFor(world.store, world.botA, newId('ag')), /unknown agent/);
});

test('the answer is a copy: rewriting what it was told cannot rewrite the store', () => {
  const world = makeWorld();
  world.store.data.bots[world.botA].personality = 'the words as written';
  const identity = identityFor(world.store, world.botA, world.agentA2);

  identity.bot.name = 'rewritten';
  identity.bot.personality = 'rewritten';
  identity.roster.find((row) => row.role === 'work')?.tools.push('schedule');

  assert.equal(world.store.data.bots[world.botA].name, 'A');
  assert.equal(world.store.data.bots[world.botA].personality, 'the words as written');
  assert.deepEqual(world.store.data.agents[world.agentA2].tools, ['say']);

  // A second read is unaffected by what a caller did to the first.
  const fresh = identityFor(world.store, world.botA, world.agentA2);
  assert.equal(fresh.bot.name, 'A');
  assert.deepEqual(fresh.roster.find((row) => row.role === 'work')?.tools, ['say']);
});

test('the roster it is told is this bot’s own: two bots in one store never mix', () => {
  const world = makeWorld();
  const a = identityFor(world.store, world.botA, world.agentA1);
  const b = identityFor(world.store, world.botB, world.agentB1);

  assert.deepEqual(Object.keys(byRole(a)).sort(), ['watch', 'work']);
  assert.deepEqual(Object.keys(byRole(b)).sort(), ['work']);
  assert.equal(b.bot.id, world.botB);
  assert.equal(b.bot.description, undefined);
});

test('the card a person fills in reaches the agent: gender, position and personality', () => {
  const world = makeWorld();
  const bot = world.store.data.bots[world.botA];
  bot.gender = '女';
  bot.position = '接口与联调';
  bot.personality = '先给结论再给理由；\n改接口前列出谁会被影响。';

  const identity = identityFor(world.store, world.botA, world.agentA2);

  assert.equal(identity.bot.gender, '女');
  assert.equal(identity.bot.position, '接口与联调');
  // Verbatim, newlines included: a personality is what the person typed, not a
  // label this module recognised and rewrote.
  assert.equal(identity.bot.personality, '先给结论再给理由；\n改接口前列出谁会被影响。');
});

test('a card field nobody filled in reads as absent rather than as an empty answer', () => {
  const world = makeWorld();
  const identity = identityFor(world.store, world.botA, world.agentA2);

  // The store leaves the key out (`bots.ts`, `createBot`), and the identity hands on
  // that absence instead of inventing a blank: what a turn says about a bot whose
  // card nobody filled in is the prompt artifact's decision, and it needs to be able
  // to tell "not said" from "said nothing".
  assert.equal(identity.bot.position, undefined);
  assert.equal(identity.bot.personality, undefined);
  assert.equal(identity.bot.gender, undefined);
});
