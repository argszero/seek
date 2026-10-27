/**
 * Which messages are topics, and what one topic is called.
 *
 * **The rule is the kernel's answer, not a count kept beside it.** A thread is three facts a
 * message carries (`src/types.ts`, written by `deliver()`): `chain` is the root of the run,
 * `root_id` the message it answers, `depth` how many hops from the root. A message that caused
 * nothing roots its own chain — `chain === message.id` — so a topic is a message that is its
 * own chain's root **and** has something in that chain, which is the line the prototype's
 * `topics()` draws too: a message nobody answered is not a topic.
 *
 * **The count is the whole chain, and that is deliberately bigger than the prototype's.** Its
 * `topics()` counts the messages whose `root_id` is the root — one hop. This window's thread
 * panel groups by `chain` (`App.jsx`), so N counts every message whose `chain` is the root, the
 * root itself excluded. A row saying "3 replies" beside a panel listing four messages would be
 * that one answer given twice, and the count here would be the one to lose.
 *
 * **A topic whose root was taken back is not a topic.** Deleting a topic stamps the root and
 * every reply at one instant (`src/erase.ts`), so a rule that kept it would leave a row of
 * tombstones with a reply count and nothing to read. A *reply* taken back on its own under a
 * live root changes nothing here: the thread is still there.
 *
 * **Why this lives in a file of its own.** There is no harness for the renderer, so a rule
 * inside a component cannot be called by a test; `ui/electron/topics-of.test.mjs` imports this
 * one and calls it, and reads `Topics.jsx` to check that the view calls it too. The same
 * reason `room-to-open.mjs` exists.
 */

export function topicsOf(rooms) {
  const topics = []
  for (const room of rooms) {
    const messages = room.messages ?? []
    const inChain = new Map()
    for (const message of messages) {
      if (message.chain === message.id) continue
      const chain = inChain.get(message.chain)
      if (chain) chain.push(message)
      else inChain.set(message.chain, [message])
    }
    for (const message of messages) {
      // Only a root can be a topic: a reply's chain is somebody else's id.
      if (message.chain !== message.id) continue
      // A root the store has taken back roots nothing a person can read.
      if (message.deletedAt) continue
      const replies = inChain.get(message.id)
      // A message nobody answered is not a topic — the prototype's own `topics()` rule.
      if (!replies || replies.length === 0) continue
      topics.push({ room, root: message, replies })
    }
  }
  // Newest reply first. `created_at` is ISO, so comparing the strings is the order the store
  // wrote them in, whatever the machine's locale or its date parsing.
  return topics.sort((left, right) => {
    const one = String(left.replies.at(-1).at)
    const other = String(right.replies.at(-1).at)
    return one === other ? 0 : one < other ? 1 : -1
  })
}

/** A topic's identity: the room it is in and the message that roots it. */
export function topicKeyOf(topic) {
  return `${topic.room.id}:${topic.root.id}`
}
