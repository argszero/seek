/**
 * The catalogue: every string a person reads is looked up by key, and no such
 * string is written into the code that renders it (src/README.md line 19,
 * `docs/design/i18n.md` §1 — "a literal in a component file is a bug, the same
 * way a hard-coded colour is a bug").
 *
 * Why this exists before there is a screen: the milestone's stdout is already a
 * surface a person reads, and `docs/design/i18n.md` states the cost of
 * retrofitting plainly — the prototype carries ~7,900 CJK characters inline in
 * `src/js/`, which is why it will never be translated. The mechanism has to be
 * standing before the first screen so that the first screen has nothing to
 * hard-code; a rule added afterwards is a rewrite.
 *
 * **Two things are not chrome, and both must stay out of here.**
 *
 * - **Content** — what a person or an agent typed, including the seeded words
 *   this harness puts in a room (`SAID`, `STUB_REPLY` in `main.ts`). A message is
 *   data; translating it behind the speaker's back is the trust violation
 *   `docs/design/i18n.md` §2 names, and in a product where agents speak it would
 *   also erase what an agent actually said. So a message renders through
 *   `report.line`, and the `{sender}` / `{text}` handed to it are passed through
 *   untouched — which is also why filling is one pass: a message containing
 *   `{path}` is text, not a substitution site.
 * - **Diagnostics** — the kernel's `throw`s (`unknown room`, `no 'work' agent`).
 *   §7 keeps those English on purpose: they are log lines and contract breaches,
 *   not rendered states, and a UI that later wants to show one renders its own
 *   entry from here.
 *
 * **The catalogue is a file, not a table in this module.** Same shape as
 * `src/prompts/`: `src/i18n/<tag>.json` beside this file, read at run time, and
 * `format()` in `main.ts` takes any catalogue — so a language added by writing a
 * file needs no code change, and a test proves the words really come from disk by
 * writing a third one to a temporary directory and rendering the report with it.
 *
 * Plural handling is the trap `docs/design/i18n.md` §4 calls out: `"{n} replies"`
 * breaks in almost every language except English, so a plural entry is a map of
 * ICU categories and the category comes from `Intl.PluralRules` for the locale —
 * never from the count, and never from `n === 1`. Chinese carries one category
 * (`other`) and English two, which is exactly the difference that makes the
 * count-comparison wrong rather than merely inelegant.
 */

import { readFileSync, readdirSync } from 'node:fs';

/** One message: a template, or one template per ICU plural category. */
export type Message = string | Readonly<Record<string, string>>;

/** What one language ships. */
export interface Catalogue {
  /** The tag the file is named after — `en`, `zh-CN`. */
  readonly locale: string;
  /** Key to message. Keys are namespaced by surface: `report.*`, `cli.*`. */
  readonly messages: Readonly<Record<string, Message>>;
}

/** What a template may be filled from: a string goes through, a number is formatted. */
export type Params = Readonly<Record<string, string | number>>;

/** A lookup bound to one catalogue. */
export type Translate = (key: string, params?: Params) => string;

/** The language a run speaks unless it is told otherwise (docs/decisions.md row 13). */
export const DEFAULT_LOCALE = 'en';

/** The categories `Intl.PluralRules` may select — anything else is a typo in a file. */
const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'];

/** Where the catalogues live, beside this module. */
export function catalogueDir(): URL {
  return new URL('./i18n/', import.meta.url);
}

/** One language's file. A tag this tree does not ship resolves to a path that is not there. */
export function shippedCataloguePath(locale: string = DEFAULT_LOCALE): URL {
  return new URL(`./i18n/${locale}.json`, import.meta.url);
}

/**
 * The languages this tree ships, read off the directory.
 *
 * Read rather than listed: a language added by writing a file must appear in
 * `--lang`'s refusals and in the parity check without anyone editing a constant.
 */
export function locales(): string[] {
  return readdirSync(catalogueDir())
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();
}

/**
 * Read one catalogue and check it says what a renderer needs.
 *
 * It throws rather than falling back per key. A missing key rendered as itself
 * (`report.spoke` in a paragraph) is the failure mode that survives review,
 * because it looks like a placeholder someone will get to.
 */
export function loadCatalogue(source: string | URL = shippedCataloguePath()): Catalogue {
  let raw: string;
  try {
    raw = readFileSync(source, 'utf8');
  } catch (error) {
    throw new Error(
      `the message catalogue could not be read from ${String(source)}: ` +
        `${(error as Error).message} — the words a person reads are a file, not ` +
        'a table in the code that prints them (src/README.md line 19)',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `the message catalogue at ${String(source)} is not JSON: ${(error as Error).message}`,
    );
  }
  return assertCatalogue(parsed, String(source));
}

/**
 * The catalogue for `locale`, or the base one when this tree does not ship it.
 *
 * The fallback exists for one job: an unsupported tag has no catalogue to carry
 * its own refusal, so the refusal is written in the base language. It is never
 * used to render a page in a language the user did not ask for — a caller that
 * wants that has to refuse first (see `main`'s argument check).
 */
export function catalogueFor(locale: string): Catalogue {
  return locales().includes(locale) ? loadCatalogue(shippedCataloguePath(locale)) : loadCatalogue();
}

/** What ships, as one phrase in `locale`'s own list convention. */
export function joinList(locale: string, items: readonly string[]): string {
  return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(items);
}

/**
 * Bind a lookup to one catalogue.
 *
 * Three refusals, all of them loud, because each is a bug that would otherwise
 * print: a key nobody shipped, a plural entry with no count, and a placeholder
 * with nothing to fill it.
 */
export function translator(catalogue: Catalogue): Translate {
  const plural = new Intl.PluralRules(catalogue.locale);
  const numbers = new Intl.NumberFormat(catalogue.locale);

  return (key, params = {}) => {
    const message = catalogue.messages[key];
    if (message === undefined) {
      throw new Error(
        `the ${catalogue.locale} catalogue has no entry ${JSON.stringify(key)} — every ` +
          'user-visible string is looked up by key, and a missing one is a bug rather ' +
          'than a rendered key (src/README.md line 19)',
      );
    }
    const template =
      typeof message === 'string'
        ? message
        : pluralTemplate(message, key, catalogue.locale, plural, params);

    // One pass, and the filled values are not re-scanned: a room's message that
    // happened to contain `{path}` is text, not a substitution site.
    return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
      const value = params[name];
      if (value === undefined) {
        throw new Error(
          `${catalogue.locale} ${JSON.stringify(key)} names {${name}} and nothing ` +
            `filled it — the catalogue and the call site disagree, and the rendered ` +
            'placeholder would read as part of the sentence',
        );
      }
      return typeof value === 'number' ? numbers.format(value) : value;
    });
  };
}

/** The plural category's own template. */
function pluralTemplate(
  message: Readonly<Record<string, string>>,
  key: string,
  locale: string,
  plural: Intl.PluralRules,
  params: Params,
): string {
  const count = params.count;
  if (typeof count !== 'number' || !Number.isFinite(count)) {
    throw new Error(
      `${locale} ${JSON.stringify(key)} is a plural entry, so it needs a numeric ` +
        `\`count\`, got ${String(count)} — "{n} messages" is the form that breaks in ` +
        'every language but English (docs/design/i18n.md §4)',
    );
  }
  // Never `count === 1`: English has two categories, Chinese one, Slavic several,
  // and the rule that picks between them is the locale's, not the count's.
  return message[plural.select(count)] ?? message.other;
}

/**
 * What a renderer needs the file to say.
 *
 * A plural entry without `other` renders nothing for the counts it did not list,
 * which is silent output loss; a category outside ICU's six is a typo that would
 * never be selected; and an empty template deletes a line without saying so.
 */
function assertCatalogue(value: unknown, source: string): Catalogue {
  const fail = (detail: string): never => {
    throw new Error(`${source} is not a message catalogue: ${detail}`);
  };
  if (typeof value !== 'object' || value === null) return fail('it is not an object');
  const catalogue = value as Partial<Catalogue>;

  if (typeof catalogue.locale !== 'string' || catalogue.locale.trim().length === 0) {
    return fail('`locale` must be a non-empty string');
  }
  if (
    typeof catalogue.messages !== 'object' ||
    catalogue.messages === null ||
    Array.isArray(catalogue.messages)
  ) {
    return fail('`messages` must be an object');
  }

  const entries = Object.entries(catalogue.messages);
  if (entries.length === 0) return fail('`messages` is empty');

  for (const [key, message] of entries) {
    if (key.trim().length === 0) return fail('an entry has an empty key');
    if (typeof message === 'string') {
      if (message.length === 0) return fail(`${JSON.stringify(key)} is an empty string`);
      continue;
    }
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      return fail(`${JSON.stringify(key)} is neither a string nor a map of plural categories`);
    }
    for (const [category, template] of Object.entries(message)) {
      if (!PLURAL_CATEGORIES.includes(category)) {
        return fail(
          `${JSON.stringify(key)} lists ${JSON.stringify(category)}, which is not a plural ` +
            `category — the six are ${PLURAL_CATEGORIES.join(', ')}`,
        );
      }
      if (typeof template !== 'string' || template.length === 0) {
        return fail(`${JSON.stringify(key)}.${category} must be a non-empty string`);
      }
    }
    if (typeof (message as Record<string, unknown>).other !== 'string') {
      return fail(
        `${JSON.stringify(key)} has no \`other\` category, so every count it did not ` +
          'list would render nothing at all',
      );
    }
  }

  return { locale: catalogue.locale, messages: catalogue.messages };
}
