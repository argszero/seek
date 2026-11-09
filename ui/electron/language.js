/**
 * Which language this window speaks, and what a save of one is allowed to be.
 *
 * **The rule this implements was written before the window existed.** `docs/design/i18n.md` §2
 * puts the interface's language in a table beside the content's and gives them opposite
 * answers: the chrome is the application's, and changing it is "a setting; takes effect
 * immediately", while what people and agents typed is "never rewritten, never
 * auto-translated". The kernel has read its own catalogue out of `src/i18n/<tag>.json` by key
 * since the milestone and `catalogueFor()` has answered any shipped tag; the window bound one
 * before its first frame. It bound `DEFAULT_LOCALE` every time, because nothing ever asked a
 * person which one they read — the main process's own comment said "this handler is where that
 * choice will land" and the choice had no home. This is the home, beside the palette and the
 * endpoint in `settings.json`.
 *
 * **A tag this tree does not ship is not a language this window has.** The list comes from
 * `locales()` in `src/i18n.ts`, which reads the directory rather than a constant — so a
 * language added by writing a file is one a person can pick with no code change, which is the
 * promise `src/i18n.ts` makes in its own header. A file that names `de`, or a hand-edit that
 * names `en-GB`, is answered with the default rather than passed on to be drawn: the same rule
 * `seek:theme` follows for a colour this window does not have.
 *
 * **Why this is a module and not four lines inside a handler.** It is the whole of the decision
 * and it does no I/O — the caller reads the file and the directory, and this says what the pair
 * means. That is what lets the rule be measured without a settings file, a window or a
 * catalogue, which are the three things a test would otherwise have to fake, and a rule that
 * needs three fakes is one nobody writes a test for.
 */

/**
 * The tag to speak: the one saved when this tree ships it, the fallback otherwise.
 *
 * `saved` is whatever the file held — a string, a number, an object, or nothing at all —
 * because a settings file is a person's to edit with a text editor, and this is read during
 * start-up before a window exists. Nothing here throws.
 */
function languageOf(saved, shipped, fallback) {
  return typeof saved === 'string' && shipped.includes(saved) ? saved : fallback
}

/**
 * What a save of `tag` is refused with, or `null` when it may go through.
 *
 * A sentence rather than a boolean, because the caller writes it to stderr: a refusal a person
 * never sees has to leave a reader enough to fix it, and the list of what this build does ship
 * is exactly that. It names the tags, never the file they were read from.
 */
function refusalToSave(tag, shipped) {
  if (typeof tag === 'string' && shipped.includes(tag)) return null
  return `not a language this window has: ${String(tag)} — it ships ${shipped.join(', ')}`
}

module.exports = { languageOf, refusalToSave }
