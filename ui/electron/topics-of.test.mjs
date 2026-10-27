/**
 * What counts as a topic, and the fact that the view asks this rule rather than keeping one.
 *
 * There is no harness for the renderer, so this file is two things, the way
 * `room-to-open.test.mjs` is: the rule, imported and called, and the wiring, read as text. A
 * correct rule nobody calls fixes nothing; a call to a broken rule fixes nothing either.
 *
 * The case that made the rule a file is a deleted topic: `deleteThread()` stamps the root and
 * every reply at one instant (`src/erase.ts`), and a list that kept it would show a row of
 * tombstones with a reply count and nothing to read.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { topicKeyOf, topicsOf } from '../src/topics-of.mjs'

const VIEW = readFileSync(join(import.meta.dirname, '..', 'src', 'Topics.jsx'), 'utf8')

/** One room with the messages given, in the shape the snapshot hands the view. */
function roomOf(messages, id = 'oc_one') {
  return { id, name: 'a room', messages }
}

/** A root and its replies, as `deliver()` writes them. */
function root(id, extra = {}) {
  return { id, chain: id, rootId: null, at: '2026-10-27T10:00:00.000Z', ...extra }
}

function reply(id, rootId, at) {
  return { id, chain: rootId, rootId, at }
}

test('a root with a reply is a topic, and the count is the whole chain', () => {
  const rooms = [
    roomOf([
      root('om_a'),
      reply('om_b', 'om_a', '2026-10-27T10:01:00.000Z'),
      reply('om_c', 'om_a', '2026-10-27T10:02:00.000Z'),
    ]),
  ]
  const topics = topicsOf(rooms)
  assert.equal(topics.length, 1)
  assert.equal(topics[0].root.id, 'om_a')
  assert.equal(topics[0].replies.length, 2)
  assert.equal(topicKeyOf(topics[0]), 'oc_one:om_a')
})

test('a message nobody answered is not a topic', () => {
  assert.deepEqual(topicsOf([roomOf([root('om_a')])]), [])
})

test('a root that was taken back is not a topic, even with replies under it', () => {
  const takenBack = root('om_a', { deletedAt: '2026-10-27T10:05:00.000Z' })
  const rooms = [roomOf([takenBack, reply('om_b', 'om_a', '2026-10-27T10:01:00.000Z')])]
  assert.deepEqual(topicsOf(rooms), [])
})

test('a reply taken back on its own leaves the topic listed, because the thread is still there', () => {
  const rooms = [
    roomOf([
      root('om_a'),
      reply('om_b', 'om_a', '2026-10-27T10:01:00.000Z'),
      { ...reply('om_c', 'om_a', '2026-10-27T10:02:00.000Z'), deletedAt: '2026-10-27T10:03:00.000Z' },
    ]),
  ]
  const topics = topicsOf(rooms)
  assert.equal(topics.length, 1)
  assert.equal(topics[0].replies.length, 2)
})

test('the view asks this rule, and keeps no copy of it', () => {
  assert.match(VIEW, /import \{ topicKeyOf as keyOf, topicsOf \} from '\.\/topics-of\.mjs'/)
  assert.match(VIEW, /const topics = topicsOf\(rooms\)/)
  assert.doesNotMatch(VIEW, /function topicsOf\(/)
  assert.doesNotMatch(VIEW, /function keyOf\(/)
})
