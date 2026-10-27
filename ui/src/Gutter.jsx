/**
 * The seam between two columns, drawn as space a pointer can grab.
 *
 * **It is its own grid column, not a border on either neighbour** — moving a border repaints an
 * edge, moving a column moves the edge. The client this window copies separates its columns with
 * space rather than with a line, so the seam has no colour of its own; the hairline beside the
 * list belongs to the list.
 *
 * **Every two-column view draws one.** It used to exist only in the chat view, which left the
 * roster and the topics list pinned at `--list-w` with no way to widen them — the grid still
 * reserved a 6px track there, so the column beside it started 6px early and the gap was dead
 * space. The same seam now sits between the list and the detail column in every view that has
 * both, and beside the thread panel.
 */
import { beginResize } from './resize.mjs'

export default function Gutter({ pane }) {
  return (
    <div
      className="gutter"
      role="separator"
      aria-orientation="vertical"
      data-gutter={pane}
      onPointerDown={(event) => beginResize(event, pane)}
    />
  )
}
