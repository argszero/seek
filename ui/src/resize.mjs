/**
 * Widening and narrowing the columns a person can grab.
 *
 * **Why this is not React state.** A column being dragged redraws on every pointer move, and a
 * state write per move re-renders the whole window — every message, every room — to move one
 * edge. The width is written to a custom property on the `.app` element instead, which is the
 * same token the grid's `grid-template-columns` already reads: dragging makes the edit a
 * stylesheet would make, and there is one number rather than two.
 *
 * **Why the arithmetic lives away from the DOM.** The bounds are the only part of a drag that
 * can be wrong in a way nobody notices — a column that can be dragged past the window's own
 * width leaves the other one with no room to draw its text, and that reads as a broken layout
 * rather than as a bound that was never applied. Keeping it as a pure function makes each bound
 * a reading instead of something only a pointer can reach.
 *
 * **Two directions, because the seams are on opposite sides of what they resize.** The list's
 * gutter sits to its right, so dragging right widens the list. The thread panel's gutter sits
 * to its *left*, so the same rightward drag narrows it. `dir` is that sign, and it is a property
 * of the seam rather than of the drag.
 */

/** Which column each seam resizes, and how far it may go. */
export const PANES = {
  /**
   * The navigation rail, whose seam sits to its right.
   *
   * Its floor is its own measured width: 156px is where Feishu's rail sits, and shrinking past
   * it would drop the words and leave the icons — the rail is the words, not the icons
   * (`docs/design/i18n.md`). So this pane can only grow, which is also what a navigation column
   * wants: nobody needs it narrower than the client's, and everybody with long labels in another
   * language needs it wider.
   */
  rail: {
    token: '--rail-w',
    column: '.rail',
    dir: 1,
    min: 156,
    max: 280,
    keep: 280,
  },
  /** The conversation list: rooms in the chat view, the roster in contacts, threads in topics. */
  list: {
    token: '--list-w',
    column: '.list-col',
    dir: 1,
    // 280 is where a conversation row's name and its time can still both be drawn; 640 is
    // where the room stops being the widest thing in the window.
    min: 280,
    max: 640,
    // What the column beside it may not go under — measured, not declared: the first version of
    // this compared the pane against the whole window, so a drag took the room to 124px and one
    // word per line while the list sat comfortably at 448 (measured in the prototype window,
    // 2026-10-27). A bound that does not look at the column it is protecting protects nothing.
    // 380 is the room's own floor (see `--room-min`): the width at which its name and its
    // messages stop wrapping a word to a line, swept in the window with the panel open.
    keep: 380,
  },
  /** The thread panel, which only exists while a thread is open. */
  side: {
    token: '--side-w',
    column: '.thread-col',
    dir: -1,
    min: 300,
    max: 640,
    // The column this seam protects is the room as well, so it is the same floor.
    keep: 380,
  },
}

/**
 * Where a drag lands, given what stands beside the seam and how wide the window is.
 *
 * `next` is the width the pointer is asking for, and `room` is what the seam stands on:
 * `{ beside, start }` — how wide the column that gives way is now, and how wide the dragged
 * column started. The ceiling is the pane's own maximum, or the dragged column plus whatever
 * slack the column beside it has above its floor, whichever is smaller: a seam may spend the
 * neighbour's slack and not a pixel more. So the same drag behaves on a 1912px window and on a
 * 1012px one, and a window that is already too narrow for the layout refuses to grow rather
 * than squeezing one word per line.
 *
 * When the pointer asks for less than the minimum, the minimum wins: a column pinned open is
 * better than a column collapsed to nothing, because a column of zero width has no edge left
 * to drag back.
 */
export function clampWidth(next, pane, room) {
  if (!Number.isFinite(next)) return pane.min
  const slack = Math.max(0, room.beside - pane.keep)
  const ceiling = Math.max(pane.min, Math.min(pane.max, room.start + slack))
  return Math.round(Math.min(ceiling, Math.max(pane.min, next)))
}

/**
 * Start dragging one seam. Returns the cleanup, so a caller can end a drag it started.
 *
 * Listeners go on the window rather than on the 6px column: the pointer leaves that column
 * almost immediately, and the drag has to end wherever the button is released — including
 * outside the window — so both come off on `pointerup` and on `pointercancel`.
 */
export function beginResize(event, paneName, root) {
  const pane = PANES[paneName]
  const app = root ?? event.currentTarget.closest('.app')
  if (!pane || !app) return () => {}

  const column = app.querySelector(pane.column)
  if (!column) return () => {}

  // Read once, at the start: what the seam is standing on. The neighbourhood is measured rather
  // than assumed, because the list is not a constant width and the room beside it is whatever
  // the window had left over.
  const beside = app.querySelector('.main-col')
  const room = {
    beside: beside ? beside.getBoundingClientRect().width : Infinity,
    start: column.getBoundingClientRect().width,
  }

  event.preventDefault()
  const startX = event.clientX

  const move = (moving) => {
    const wanted = room.start + (moving.clientX - startX) * pane.dir
    app.style.setProperty(pane.token, `${clampWidth(wanted, pane, room)}px`)
  }
  const stop = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', stop)
    window.removeEventListener('pointercancel', stop)
  }

  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', stop)
  window.addEventListener('pointercancel', stop)
  return stop
}
