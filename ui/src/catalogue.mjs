/**
 * The words this window puts around what people and bots typed.
 *
 * `docs/design/i18n.md` §1: no user-visible string is written into code, and a literal in a
 * component file is a bug the same way a hard-coded colour is. §4 names the form of it that
 * survives review because it reads correctly in English and nowhere else — `"{n} replies"`,
 * and the comparison `count === 1` that usually comes with it.
 *
 * **The catalogue is read at run time, through `seek:catalogue`.** It is the same file the
 * kernel's own report is printed from (`src/i18n/<tag>.json`), so a language added by writing
 * a file reaches both surfaces without a code change — which is what `src/i18n.ts` promises,
 * and what a build-time import would quietly make false for the window.
 *
 * **Why this lookup is written twice.** `src/i18n.ts`'s `translator()` is the implementation
 * this one copies, and it cannot be imported here: that module reads its catalogue with
 * `node:fs`, and this file runs in the renderer, where there is no filesystem. So the rules
 * are restated rather than shared — the plural category from `Intl.PluralRules` for the
 * locale and never from `count === 1`, numbers through `Intl.NumberFormat`, and a missing key
 * thrown rather than drawn as itself — and `ui/electron/catalogue.test.mjs` holds the two to
 * the same answer for every shipped language, so the copy cannot drift in silence.
 */

/** The lookup, bound once by `bindCatalogue()`. */
let translate = null

/**
 * Bind this window to one catalogue.
 *
 * Called once, with what `seek:catalogue` answered. The words are the same for every render
 * afterwards, which is why this is module state rather than something passed down: a count is
 * drawn four components deep (`Line`), and a lookup threaded through the tree would be a prop
 * on every component in between — with a default, in practice, of the very literal this file
 * exists to remove.
 */
export function bindCatalogue(catalogue) {
  const plural = new Intl.PluralRules(catalogue.locale)
  const numbers = new Intl.NumberFormat(catalogue.locale)

  translate = (key, params = {}) => {
    const message = catalogue.messages[key]
    if (message === undefined) {
      throw new Error(
        `the ${catalogue.locale} catalogue has no entry ${JSON.stringify(key)} — every ` +
          'string a person reads is looked up by key, and a missing one is a bug rather ' +
          'than a key drawn in its place (docs/design/i18n.md §1)',
      )
    }
    const template =
      typeof message === 'string' ? message : pluralTemplate(message, key, plural, params)

    // One pass, and the filled values are not re-scanned: a room's message that happened to
    // contain `{path}` is text, not a substitution site.
    return template.replace(/\{(\w+)\}/g, (whole, name) => {
      const value = params[name]
      if (value === undefined) {
        throw new Error(
          `${catalogue.locale} ${JSON.stringify(key)} names {${name}} and nothing filled ` +
            'it — the catalogue and the call site disagree',
        )
      }
      return typeof value === 'number' ? numbers.format(value) : value
    })
  }
}

/** The plural category's own template. */
function pluralTemplate(message, key, plural, params) {
  const count = params.count
  if (typeof count !== 'number' || !Number.isFinite(count)) {
    throw new Error(
      `${JSON.stringify(key)} is a plural entry, so it needs a numeric \`count\`, got ` +
        `${String(count)} — "{n} replies" is the form that breaks in every language but ` +
        'English (docs/design/i18n.md §4)',
    )
  }
  // Never `count === 1`: English has two categories, Chinese one, Slavic several, and the
  // rule that picks between them is the locale's, not the count's.
  return message[plural.select(count)] ?? message.other
}

/** Whether a catalogue has arrived. Nothing is drawn before it has. */
export function catalogueBound() {
  return translate !== null
}

/**
 * One message by key.
 *
 * Before `bindCatalogue()`, this throws rather than falling back to the key or to an English
 * default: a window that drew `ui.members` where "3 members" belongs would look like a
 * placeholder somebody was going to get to, and this file's whole subject is that there is no
 * such thing here.
 */
export function t(key, params) {
  if (translate === null) {
    throw new Error(
      `no catalogue is bound yet, so ${JSON.stringify(key)} has no words — the window draws ` +
        'nothing until seek:catalogue has answered',
    )
  }
  return translate(key, params)
}
