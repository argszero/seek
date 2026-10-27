import { useEffect } from 'react'
import { createPortal } from 'react-dom'

/**
 * A small form over the window: **the mask, the card, and the two answers.**
 *
 * **Four forms are this card**: making an organization, a group, a room and a bot. They were
 * four different shapes before — the organization's was a hand-drawn mask of its own, whose input
 * had no rule at all (measured at 153×21 with the browser's own border), and the other three were
 * forms wedged into the list column above the rows they add to. The host asked for one shape on
 * 2026-10-27 (创建机器人、创建群组，都使用弹窗吧), after approving the card the organization's form
 * had become; the organization's then came over to this component too, so the mask, the Escape
 * key and the two answers at the foot are written once. Each caller keeps its own fields, its own
 * refusal and its own write.
 *
 * **What this file owns and what it does not.** It owns the surface: the mask, the card, the
 * title, Escape, a press outside, and the two buttons on the last line. It owns nothing about
 * any form's fields or its write — each caller keeps its own state and its own refusal, because
 * those are the kernel's sentences about that one thing and not a property of being a dialog.
 *
 * **Why a portal.** The card has to sit over the whole window, and each of these dialogs is
 * rendered from inside a column (`.list-col`, `.main-col`) that scrolls. `position: fixed`
 * would still work there today, and would stop working the first time something above it gains
 * a transform — the kind of change nobody would connect to a dialog rendering in the wrong
 * place. `document.body` is the one parent that cannot move under it.
 */
export default function Dialog({
  /** The form's name in the DOM: `data-dialog="bot"` on the mask, `-submit` / `-cancel` below. */
  name,
  title,
  submit,
  cancel,
  busy = false,
  onSubmit,
  onClose,
  children,
}) {
  // Escape closes it, from anywhere in the card: the first field has focus, so a listener on
  // the mask alone would only hear the key after a click inside it. One press, one close, and
  // the listener goes when the card does.
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div
      className="dialog-mask"
      data-dialog={name}
      // A press on the mask closes it; a press that started inside the card and ended on the
      // mask — dragging across a selection of text, for instance — does not. `mousedown` rather
      // than `click` is what makes that distinction readable.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit()
        }}
      >
        <h3 className="dialog-title">{title}</h3>
        {children}
        <div className="dialog-actions">
          <button className="btn" type="button" onClick={onClose} data-dialog-cancel>
            {cancel}
          </button>
          <button className="btn primary" type="submit" disabled={busy} data-dialog-submit>
            {submit}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  )
}
