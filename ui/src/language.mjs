/**
 * Changing the window's language, in one place.
 *
 * `docs/design/i18n.md` §2 gives the interface's language two properties and both are load
 * bearing here: it is **a setting**, and it **takes effect immediately** rather than at the next
 * launch. Everything needed for that already exists — the main process keeps the tag in
 * `settings.json` beside the palette and answers `seek:catalogue` for whichever one is saved,
 * and `catalogue.mjs` binds the lookup — so what was missing was the order to do it in.
 *
 * **The order, and why it is not tidiness.** Save the tag, take the catalogue the main process
 * now answers with, bind it, and only then say on `<html>` which language the page is in. `t()`
 * refuses to answer before a catalogue is bound (its own docstring argues why: an English
 * default or a printed key looks like a placeholder somebody meant to finish), so a window that
 * repainted between the save and the bind would throw on every string on the screen at once.
 *
 * **A save that did not go through changes nothing.** A person left on the language the file
 * refused is still reading the words they were reading — the rule the theme toggle follows, and
 * for the same reason: what fails is the memory of it, and the main process logs that. The
 * answer is handed back so the page can say so itself, in its own words.
 *
 * **Why the window's own store of words is not read from `App.jsx`.** The window reads its
 * catalogue once, before its first frame, and `electron/catalogue.test.mjs` holds that: `App`
 * may never fetch or bind a catalogue of its own, because a second reader free to arrive at a
 * different moment than the boot's is the disagreement that test exists to prevent. This module
 * is the one exception, and it is the exception the spec asks for — so it is written here, as a
 * file with one exported function, rather than as three lines inside a component where the next
 * reader of `App.jsx` would find them without the reason attached.
 */
import { bindCatalogue } from './catalogue.mjs'

/**
 * Ask the host for another language, and make the window speak it.
 *
 * Answers what the main process answered — `{ok: true, locale}` or `{ok: false, error}` — so the
 * caller decides what to say. The `ok !== true` test rather than a falsy one is deliberate: an
 * absent answer (a bridge that was not there) must not read as a success and repaint nothing.
 */
export async function switchLanguage(tag) {
  const answer = await window.seekHost.saveLanguage(tag)
  if (!answer || answer.ok !== true) return answer
  bindCatalogue(await window.seekHost.catalogue())
  document.documentElement.setAttribute('lang', answer.locale)
  return answer
}

/**
 * One language's name, in the language the window is currently reading.
 *
 * A name is the one thing on the switch that the catalogue cannot carry: the list is whatever
 * `src/i18n/` holds, so a language nobody wrote a key for still has to be named in the list.
 * `Intl.DisplayNames` answers it — `Chinese (China)` when the window reads English and
 * `中文（中国）` when it reads Chinese — which is the same rule §4 states for every other
 * locale-sensitive value: the formatter knows, and a table written here would be a second one
 * that goes stale the moment a file is added.
 *
 * Falls back to the tag itself, which is an identifier (§7) and stays readable either way.
 */
export function languageName(tag, inLocale) {
  try {
    return new Intl.DisplayNames([inLocale ?? tag], { type: 'language' }).of(tag) ?? tag
  } catch {
    return tag
  }
}
