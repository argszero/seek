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

/** The instant formatter, bound once by the same call. `null` until a catalogue arrives. */
let stamps = null

/** The size formatter, bound by the same call. `null` until a catalogue arrives. */
let sizes = null

/** The list formatter, bound by the same call. `null` until a catalogue arrives. */
let lists = null

/**
 * The two halves of a *narrow* instant: a clock for something that happened today, and a day
 * for anything older. Bound by the same call; `null` until a catalogue arrives.
 *
 * The client's conversation list writes today's conversations as `10:23` and older ones as a
 * date, and neither form is a word: `Intl` writes both, so a language added by writing a file
 * needs nothing here. That is also why "yesterday" is not one of the shapes — it is a
 * translated word with plural forms behind it (§4), and no catalogue entry for it exists.
 */
let clocks = null
let days = null

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
  // A size is the same kind of fact as a count, and `docs/design/i18n.md` §4 names it in the
  // table of things that must never be concatenated at a call site. `Intl` writes `2.2 GB` in
  // English and in Chinese, `2,2 GB` in German and `2,2 Go` in French, so the unit costs no
  // catalogue key of its own — a key beside it would be a second place to get it wrong.
  sizes = new Intl.NumberFormat(catalogue.locale, {
    style: 'unit',
    unit: 'gigabyte',
    unitDisplay: 'short',
    // A size is read down a column of readings, so it keeps one decimal at every magnitude:
    // `0.0 GB` beside `2.2 GB`, never `0 GB` beside `2.2 GB`. That is also the form the line
    // already had before it moved here, so the move changes no number a person has seen.
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })
  // A date is the same kind of fact as a count: the shape of it is the locale's, not this
  // file's. Asking for a month, a day and a time is all this window has to say so far — a
  // relative "3 minutes ago" would need plural forms and translated words
  // (`docs/design/i18n.md` §4), and no catalogue entry for them exists yet.
  stamps = new Intl.DateTimeFormat(catalogue.locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
  // The narrow forms, for a list of conversations rather than for one message's own header:
  // the client writes a time for today and a date for anything older, and never both.
  clocks = new Intl.DateTimeFormat(catalogue.locale, { hour: '2-digit', minute: '2-digit' })
  days = new Intl.DateTimeFormat(catalogue.locale, { month: 'short', day: 'numeric' })
  // A list is the same kind of fact as a count, and §4 names the shape it takes when it is not:
  // `"A, B and C"` — the conjunction differs, so a `; ` or a `.join(', ')` at a call site is this
  // file's subject in the form that reads correctly in English and nowhere else. The kernel has
  // it too (`joinList` in `src/i18n.ts`), and the two are held to one answer per language in
  // `ui/electron/catalogue.test.mjs`.
  lists = new Intl.ListFormat(catalogue.locale, { style: 'long', type: 'conjunction' })

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

/**
 * One instant, in the form the catalogue's language writes it.
 *
 * `docs/design/i18n.md` §4: an absolute date is formatted per locale, and a relative word
 * ("yesterday", "3 minutes ago") is a translated word with plural forms behind it. Only the
 * first exists here, because only the first has no words of its own — `Intl.DateTimeFormat`
 * writes the month and the clock, so a language added by writing a file needs nothing from
 * this file. A stamp that is not a date draws nothing rather than the string `Invalid Date`:
 * the store writes ISO, and a message whose `created_at` cannot be read is a message with no
 * time to show, not a time to invent.
 */
export function when(iso) {
  if (stamps === null) {
    throw new Error(
      'no catalogue is bound yet, so an instant has no form — the window draws nothing ' +
        'until seek:catalogue has answered',
    )
  }
  if (typeof iso !== 'string' || iso === '') return ''
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  return stamps.format(at)
}

/**
 * The same instant as `when()`, in the narrow form a list of conversations uses: a clock when
 * it happened on the day the window is being read, a date when it did not.
 *
 * "Today" is decided by the local calendar, which is why it is compared field by field rather
 * than by subtracting hours: a conversation at 00:30 and one at 23:30 belong to different days
 * and the same 24 hours. A stamp that cannot be read draws nothing, for the reason `when()`
 * gives — an unreadable instant is not a time to invent.
 */
export function whenShort(iso) {
  if (clocks === null || days === null) {
    throw new Error(
      'no catalogue is bound yet, so an instant has no form — the window draws nothing ' +
        'until seek:catalogue has answered',
    )
  }
  if (typeof iso !== 'string' || iso === '') return ''
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const now = new Date()
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate()
  return sameDay ? clocks.format(at) : days.format(at)
}

/**
 * A byte count in the form this language writes a size.
 *
 * `docs/design/i18n.md` §4 puts a file size in this layer for two reasons, and both are the
 * shape of this function: the number's separators are the locale's, and the unit is written here
 * rather than concatenated at a call site. **One gigabyte is 1,000,000,000 bytes** — decimal,
 * which is how a download is quoted — and the choice is stated once, here, rather than left to
 * whichever call site drew first, because §4 asks for one and forbids switching mid-interface.
 *
 * The unit is not a catalogue key: `Intl` already knows the word in every language. Only the
 * frame the number sits in is the catalogue's business (`ui.weights.arriving-amount`).
 */
export function size(bytes) {
  if (sizes === null) {
    throw new Error(
      'no catalogue is bound yet, so a size has no form — the window draws nothing until ' +
        'seek:catalogue has answered',
    )
  }
  return sizes.format(Math.max(0, Number(bytes) || 0) / 1e9)
}

/**
 * Several items as one phrase in this language's own list convention.
 *
 * `docs/design/i18n.md` §4 names list joining as a formatting decision rather than a string
 * one: German writes `A, B und C` and Chinese `A、B和C`, so a call site that joins with `; ` or
 * `', '` has decided the language of its own separator. `Intl.ListFormat` decides it here
 * instead, once, from the locale — which is why a language added by writing a file needs
 * nothing from this file.
 *
 * The kernel's `joinList` is the same function, written there because that module cannot be
 * imported into the page; `ui/electron/catalogue.test.mjs` holds the two to one answer for every
 * language that ships.
 */
export function joinList(items) {
  if (lists === null) {
    throw new Error(
      'no catalogue is bound yet, so a list has no form — the window draws nothing until ' +
        'seek:catalogue has answered',
    )
  }
  return lists.format(items)
}

/**
 * Why the weights did not arrive, in this language.
 *
 * Three shapes (`weightsOf` in `ui/electron/snapshot.js` validates them), because there are
 * three different things to say and they do not carry the same kind of words:
 *
 * - `no-host` is entirely ours — a build with no address configured — so the whole sentence is
 *   a catalogue entry with the repository in it.
 * - `refused` is one host's own sentence. It is drawn exactly as it came: `docs/design/i18n.md`
 *   §2 forbids rewriting what a sender said, and a host that answered is a sender. Translating
 *   it would be this window putting words in somebody else's mouth.
 * - `hosts` is several of them, and only the frame and the joining are ours: §4 makes the list
 *   form the language's (`"A, B and C"`), so the pairs go through `joinList()` rather than a `; `.
 *
 * This lives here rather than in the component for the reason `size()` does: it is a pure
 * function of the catalogue, and a component cannot be imported by the suite that has to hold
 * it to what a person actually reads.
 */
export function weightsReason(weights) {
  if (weights.kind === 'no-host') return t('ui.weights.no-host', { repo: weights.repo })
  if (weights.kind === 'refused') return weights.words
  const each = weights.hosts.map((one) => t('ui.weights.host-said', { host: one.host, words: one.words }))
  return t('ui.weights.from-no-host', { hosts: joinList(each) })
}
