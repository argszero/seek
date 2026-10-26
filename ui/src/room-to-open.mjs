/**
 * Which room the chat half should be showing.
 *
 * **The window is made before the store is opened.** `start()` in `ui/electron/main.js`
 * creates the window first and only then awaits `openHostOrRefuse()`, on purpose: a first run
 * fetches 2.1 GB before a model exists, and a launch that showed nothing for that long is
 * indistinguishable from an app that did not start. The renderer's first `seek:snapshot` can
 * therefore land while there is no store at all, and that answer is a defined one —
 * `snapshotOf(null, …)` reports `rooms: []` and `error: 'the store is not open yet'`
 * (`ui/electron/snapshot.js`).
 *
 * **Adopting only on that first answer is what left the window empty.** Choosing the room to
 * open out of the boot snapshot alone means a snapshot with no rooms decides that nothing is
 * open, for the rest of the session: when the store opens, the same snapshot arrives again
 * through `seek:changed` carrying the rooms, and a handler that only replaced the snapshot
 * would leave the window listing its rooms with none of them open — no composer, no marked
 * rail row — until somebody clicked one (issue #120). So the rule below is applied to
 * **every** snapshot, not to the first.
 *
 * `current ??` is the whole of the second guarantee, and it is why this is safe to apply to
 * every arrival: only a `null` is ever filled, so a room a person has already opened is never
 * taken from them by a later snapshot — the kernel pushes one whenever a bot answers.
 *
 * A room with no `id` is no room to open: `rooms[0]?.id ?? null` keeps that from becoming an
 * `undefined` the chat half would then treat as a room it could not find.
 */
export function roomToOpen(current, rooms) {
  return current ?? rooms[0]?.id ?? null
}
