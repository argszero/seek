/**
 * Test support: one small world two bots share.
 *
 * Two agents behind bot A on purpose — the count is what catches a delivery
 * written per agent instead of per bot.
 */

import { emptyData, newId, SeekStore } from './store.ts';
import type { Id, MembershipRole } from './types.ts';

export interface World {
  store: SeekStore;
  /** The human. */
  me: Id;
  botA: Id;
  botB: Id;
  agentA1: Id;
  agentA2: Id;
  agentB1: Id;
  room: Id;
}

export function makeWorld(): World {
  const store = new SeekStore(emptyData());
  const at = '2026-10-24T00:00:00.000Z';

  const me = newId('ou');
  store.data.principals[me] = { id: me, kind: 'human', name: 'me' };

  const botA = newId('ou');
  store.data.bots[botA] = { id: botA, name: 'A', description: 'the bot' };
  const botB = newId('ou');
  store.data.bots[botB] = { id: botB, name: 'B' };

  const agentA1 = newId('ag');
  store.data.agents[agentA1] = {
    id: agentA1,
    bot_id: botA,
    role: 'watch',
    home: '/tmp/seek/a/watch',
    model: 'gate',
    prompt: 'v1',
    tools: [],
  };
  const agentA2 = newId('ag');
  store.data.agents[agentA2] = {
    id: agentA2,
    bot_id: botA,
    role: 'work',
    home: '/tmp/seek/a/work',
    model: 'big',
    prompt: 'v1',
    tools: ['say'],
  };
  const agentB1 = newId('ag');
  store.data.agents[agentB1] = {
    id: agentB1,
    bot_id: botB,
    role: 'work',
    home: '/tmp/seek/b/work',
    model: 'big',
    prompt: 'v1',
    tools: ['say'],
  };

  const room = newId('oc');
  store.data.rooms[room] = {
    id: room,
    name: 'room',
    chat_mode: 'group',
    created_at: at,
  };
  const members: { principal: Id; role: MembershipRole }[] = [
    { principal: me, role: 'owner' },
    { principal: botA, role: 'member' },
    { principal: botB, role: 'member' },
  ];
  for (const member of members) {
    const id = newId('mb');
    store.data.memberships[id] = {
      id,
      room_id: room,
      principal_id: member.principal,
      joined_at: at,
      role: member.role,
    };
  }

  return { store, me, botA, botB, agentA1, agentA2, agentB1, room };
}

/** A room with exactly two members: a human and one bot. */
export function makeDirectWorld(): World {
  const world = makeWorld();
  for (const [id, membership] of Object.entries(world.store.data.memberships)) {
    if (membership.principal_id === world.botB) {
      delete world.store.data.memberships[id];
    }
  }
  const id = newId('oc');
  world.store.data.rooms[id] = {
    id,
    chat_mode: 'p2p',
    created_at: '2026-10-24T00:00:00.000Z',
  };
  for (const principal of [world.me, world.botA]) {
    const own = newId('mb');
    world.store.data.memberships[own] = {
      id: own,
      room_id: id,
      principal_id: principal,
      joined_at: '2026-10-24T00:00:00.000Z',
      role: 'member',
    };
  }
  return { ...world, room: id };
}
