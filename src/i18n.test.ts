import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { Timers } from './comparator.ts';
import {
  catalogueFor,
  DEFAULT_LOCALE,
  joinList,
  loadCatalogue,
  locales,
  shippedCataloguePath,
  translator,
  type Catalogue,
} from './i18n.ts';
import { format, main, parseArgv, type MilestoneRun } from './main.ts';

const STORE = '/tmp/seek-i18n/store.json';

/**
 * One run, built by hand: `format()` reads nothing but these fields, and a test
 * that needed a store to check a sentence would be testing the kernel again.
 *
 * The bot's line contains `{path}` on purpose — a message that happens to hold a
 * placeholder is the case where a two-pass fill would let a room write the
 * report.
 */
const RUN: MilestoneRun = {
  scene: {
    me: 'ou_me',
    other: 'ou_other',
    bot: 'ou_bot',
    watch: 'ag_watch',
    work: 'ag_work',
    room: 'oc_room',
  },
  transcript: [
    { senderId: 'ou_me', sender: 'me', text: 'the deploy is red', byBot: false },
    { senderId: 'ou_bot', sender: 'Echo', text: 'red, and {path} stays as it was', byBot: true },
  ],
  spoke: true,
  failures: [],
};

/** Timers a run never uses, but a test must not let a real one keep the process alive. */
function makeTimers(): Timers {
  return { set: (delayMs: number) => delayMs, clear: () => {} };
}

/**
 * A throwaway directory holding the roster a store needs.
 *
 * `agents.yml` sits beside every store (`src/roster.ts`), so a store a test hands
 * to `main` needs one too: without it the run has a bot and no agents, and the
 * command line is being measured rather than the roster.
 */
const ROSTER = `agents:
  - bot: Echo
    role: watch
    tools: []
  - bot: Echo
    role: work
    tools: [say]
`;

async function withDirectory(body: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'seek-i18n-'));
  try {
    await writeFile(join(directory, 'agents.yml'), ROSTER);
    await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('every shipped language carries the same keys, and says which one it is', () => {
  const base = loadCatalogue();
  assert.equal(base.locale, DEFAULT_LOCALE);
  assert.ok(locales().includes(DEFAULT_LOCALE), 'the base language is shipped');

  // Parity is the property that keeps a page from half-rendering in one language:
  // a key added to `en` and forgotten in `zh-CN` is a run that prints a raw key.
  for (const tag of locales()) {
    const catalogue = loadCatalogue(shippedCataloguePath(tag));
    assert.equal(catalogue.locale, tag, 'the file says which language it is');
    assert.deepEqual(
      Object.keys(catalogue.messages).sort(),
      Object.keys(base.messages).sort(),
      `${tag} does not carry the base key set`,
    );
  }
  assert.ok(locales().length >= 2, 'more than one language ships, or parity proves nothing');
});

test('a key nobody shipped, and a placeholder nobody filled, are both refused', () => {
  const t = translator(loadCatalogue());

  // Neither is rendered "as itself": a missing key printed into a paragraph is the
  // failure that survives review, because it reads like a placeholder someone will
  // get to.
  assert.throws(() => t('report.nothing-here'), /has no entry "report.nothing-here"/);
  assert.throws(() => t('report.store'), /names \{path\} and nothing filled it/);
});

test('a number goes through the locale, and a filled value is never re-scanned', () => {
  const t = translator(loadCatalogue());

  // `docs/design/i18n.md` §4: the number is a locale decision, not a `String(n)`.
  assert.equal(t('report.turns', { count: 1234 }), '1,234 turns threw.');
  // One pass: the message is text, not a substitution site.
  assert.equal(
    t('report.line', { sender: 'Echo', text: '{path} stays as it was' }),
    '  Echo: {path} stays as it was',
  );
});

test('the plural category comes from the locale, not from the count', () => {
  const en = translator(loadCatalogue(shippedCataloguePath('en')));
  const zh = translator(loadCatalogue(shippedCataloguePath('zh-CN')));

  assert.equal(en('report.spoke', { count: 1 }), 'the bot spoke: 1 message, unaddressed by anyone.');
  assert.equal(en('report.spoke', { count: 0 }), 'the bot spoke: 0 messages, unaddressed by anyone.');
  assert.equal(en('report.spoke', { count: 2 }), 'the bot spoke: 2 messages, unaddressed by anyone.');
  // Chinese carries one category, so the count changes the numeral and not the
  // sentence — the difference a `count === 1` branch could not express.
  assert.deepEqual(
    Object.keys(loadCatalogue(shippedCataloguePath('zh-CN')).messages['report.spoke'] as object),
    ['other'],
  );
  assert.equal(new Intl.PluralRules('zh-CN').select(1), 'other');
  assert.equal(new Intl.PluralRules('en').select(1), 'one');
  assert.equal(
    zh('report.spoke', { count: 1 }).replace('1', 'N'),
    zh('report.spoke', { count: 7 }).replace('7', 'N'),
    'one Chinese sentence, whatever the count',
  );
  assert.notEqual(en('report.spoke', { count: 1 }), en('report.spoke', { count: 2 }));
});

test('a plural entry needs a numeric count, and says so when it has none', () => {
  const t = translator(loadCatalogue());
  assert.throws(() => t('report.spoke'), /needs a numeric `count`/);
  assert.throws(() => t('report.spoke', { count: 'two' }), /needs a numeric `count`/);
});

test('a catalogue the renderer cannot honour is refused, and says why', async () => {
  await withDirectory(async (directory) => {
    const cases: [string, unknown, RegExp][] = [
      [
        'a plural entry with no other category',
        { locale: 'xx', messages: { 'report.spoke': { one: 'one message' } } },
        /has no `other` category/,
      ],
      [
        'a category that is not a plural category',
        { locale: 'xx', messages: { 'report.spoke': { '1': 'one', other: 'many' } } },
        /is not a plural category/,
      ],
      ['an empty template', { locale: 'xx', messages: { 'report.title': '' } }, /is an empty string/],
      [
        'an empty plural template',
        { locale: 'xx', messages: { 'report.spoke': { one: 'a message', other: '' } } },
        /must be a non-empty string/,
      ],
      ['no locale', { messages: { 'report.title': 'x' } }, /`locale` must be/],
      ['no messages', { locale: 'xx', messages: {} }, /`messages` is empty/],
    ];

    for (const [label, value, expected] of cases) {
      const path = join(directory, `${label.replace(/\W+/g, '-')}.json`);
      await writeFile(path, JSON.stringify(value), 'utf8');
      assert.throws(() => loadCatalogue(path), expected, label);
    }

    const notJson = join(directory, 'not-json.json');
    await writeFile(notJson, 'seek — the first milestone\n', 'utf8');
    assert.throws(() => loadCatalogue(notJson), /is not JSON/);

    assert.throws(
      () => loadCatalogue(join(directory, 'absent.json')),
      /could not be read/,
      'a missing catalogue is not a runtime with built-in words',
    );
  });
});

test('the words of the report come from the catalogue, line for line', () => {
  for (const tag of locales()) {
    const catalogue = loadCatalogue(shippedCataloguePath(tag));
    const t = translator(catalogue);
    const printed = format(RUN, STORE, catalogue);

    // Every entry the report may use, rendered for this run. A sentence added to
    // `format()` instead of to a file lands outside this set and fails here — which
    // is what "no user-visible literal in code" has to mean mechanically.
    const allowed = new Set<string>([
      t('report.title'),
      t('report.store', { path: STORE }),
      t('report.room', { room: RUN.scene.room }),
      ...RUN.transcript.map((line) => t('report.line', { sender: line.sender, text: line.text })),
      t('report.spoke', { count: 1 }),
      t('report.turns', { count: 0 }),
      ...t('report.stub').split('\n'),
    ]);

    for (const line of printed.split('\n')) {
      // A blank line carries no text, so there is nothing in it to translate.
      if (line === '') continue;
      assert.ok(allowed.has(line), `${tag}: ${JSON.stringify(line)} is not a catalogue entry`);
    }
  }
});

test('a language switch changes the chrome and leaves the content alone', () => {
  const en = format(RUN, STORE, loadCatalogue(shippedCataloguePath('en')));
  const zh = format(RUN, STORE, loadCatalogue(shippedCataloguePath('zh-CN')));

  // `docs/design/i18n.md` §2: content is never rewritten. What the person said and
  // what the bot said appear verbatim in both reports, and so does who said it.
  for (const line of RUN.transcript) {
    assert.ok(en.includes(line.text), `${JSON.stringify(line.text)} is untranslated in en`);
    assert.ok(zh.includes(line.text), `${JSON.stringify(line.text)} is untranslated in zh-CN`);
    assert.ok(zh.includes(line.sender), 'a display name is content too');
  }

  // Every other line differs: the run has 13 lines in both languages (title, store,
  // blank, room, two transcript lines, blank, spoken, turns, blank, three of stub).
  const enLines = en.split('\n');
  const zhLines = zh.split('\n');
  assert.equal(enLines.length, zhLines.length, 'the two catalogues shape the page the same way');
  for (const [index, line] of enLines.entries()) {
    if (index === 4 || index === 5) continue; // the transcript
    if (line === '') continue; // a blank line has no language
    assert.notEqual(line, zhLines[index], `line ${index} did not change language`);
  }
});

test('a catalogue written somewhere else is the report that ships', async () => {
  await withDirectory(async (directory) => {
    // A language this tree does not ship, in a directory it does not own: if the
    // report's words were in the code, nothing here could change them.
    const third: Catalogue = {
      locale: 'xx',
      messages: {
        'report.title': 'seek — run three',
        'report.store': 'disk {path}',
        'report.room': 'room {room}',
        'report.line': '  {sender} says {text}',
        'report.spoke': { other: '{count} words from the bot' },
        'report.silent': 'the bot was quiet',
        'report.turns': { other: '{count} failures' },
        'report.stub': 'no model was involved.',
      },
    };
    const path = join(directory, 'xx.json');
    await writeFile(path, JSON.stringify(third), 'utf8');

    const printed = format(RUN, STORE, loadCatalogue(path));
    assert.match(printed, /^seek — run three\n/);
    assert.match(printed, /disk \/tmp\/seek-i18n\/store\.json/);
    assert.match(printed, /room oc_room/);
    assert.match(printed, /  Echo says red, and \{path\} stays as it was/);
    assert.match(printed, /1 words from the bot/, 'the count is formatted for `xx` too');
    assert.match(printed, /0 failures/);
    assert.match(printed, /no model was involved\.\n$/);
  });
});

test('the report is finished text: it ends in one newline and names the store', () => {
  const printed = format(RUN, STORE, loadCatalogue());
  assert.equal(printed.endsWith('\n'), true);
  assert.equal(printed.endsWith('\n\n'), false);
  assert.ok(printed.includes(STORE));
});

test('the command line takes the language it is given, and a bare run stays English', async () => {
  await withDirectory(async (directory) => {
    const printed = async (argv: string[]): Promise<string> => {
      const chunks: string[] = [];
      const code = await main(argv, {
        timers: makeTimers(),
        out: (text) => chunks.push(text),
      });
      assert.equal(code, 0);
      return chunks.join('');
    };

    assert.match(await printed(['--lang', 'zh-CN', join(directory, 'zh.json')]), /^seek —— 第一个里程碑/);
    assert.match(await printed(['--lang=en', join(directory, 'en.json')]), /^seek — the first milestone/);
    assert.match(await printed([join(directory, 'bare.json')]), /^seek — the first milestone/);
  });
});

test('a language this tree does not ship is refused in the base one', async () => {
  await assert.rejects(
    async () => main(['--lang', 'de-DE'], { timers: makeTimers(), out: () => {} }),
    /no catalogue for de-DE: this tree ships en and zh-CN/,
    // There is no German catalogue to carry the refusal, so it is written in the
    // one language the refusal can be sure exists.
    'the refusal comes from the base language',
  );
  await assert.rejects(
    async () => main(['--lang', 'zh-cn'], { timers: makeTimers(), out: () => {} }),
    /no catalogue for zh-cn/,
    'a tag is matched exactly: a locale tag is an identifier, not a search term',
  );
});

test('a bad command line is refused rather than ignored', async () => {
  const cases: [string[], RegExp][] = [
    [['--nope'], /not a flag this harness knows: --nope/],
    [['--lang'], /--lang needs a value after it/],
    [['--lang='], /--lang needs a value after it/],
    [['--lang', '--nope'], /not a flag this harness knows: --nope/],
    [['--lang', 'en', '--lang', 'zh-CN'], /--lang was given twice/],
    [['one.json', 'two.json'], /two store paths were given \(one\.json and two\.json\)/],
  ];

  for (const [argv, expected] of cases) {
    await assert.rejects(
      async () => main(argv, { timers: makeTimers(), out: () => {} }),
      expected,
      argv.join(' '),
    );
  }
});

test('the arguments are read as a value, before anything is decided about them', () => {
  assert.deepEqual(parseArgv([]), {
    locale: DEFAULT_LOCALE,
    unknown: [],
    repeated: [],
    missingValue: [],
    paths: [],
  });
  assert.deepEqual(parseArgv(['--lang', 'zh-CN', 'a.json']), {
    locale: 'zh-CN',
    unknown: [],
    repeated: [],
    missingValue: [],
    paths: ['a.json'],
  });
  assert.deepEqual(parseArgv(['--lang=zh-CN']).locale, 'zh-CN');
  // A tag that does not exist is read here and refused in `main`: reading and
  // validating are two steps, and this one decides nothing.
  assert.equal(parseArgv(['--lang', 'de-DE']).locale, 'de-DE');
  assert.deepEqual(parseArgv(['--lang', '--nope']), {
    locale: DEFAULT_LOCALE,
    unknown: ['--nope'],
    repeated: [],
    missingValue: ['--lang'],
    paths: [],
  });
  assert.deepEqual(parseArgv(['--lang', 'en', '--lang', 'zh-CN']).repeated, ['--lang']);
});

test('the shipped base catalogue is the one the module loads by default', () => {
  assert.match(shippedCataloguePath().pathname, /src\/i18n\/en\.json$/);
  assert.equal(loadCatalogue(shippedCataloguePath()).locale, DEFAULT_LOCALE);
  // The fallback is the base language and nothing else: it exists to write a
  // refusal, not to render a page in a language nobody asked for.
  assert.equal(catalogueFor('de-DE').locale, DEFAULT_LOCALE);
  assert.equal(catalogueFor('zh-CN').locale, 'zh-CN');
});

test('a list of languages is joined the way the language joins lists', () => {
  assert.equal(joinList('en', ['en', 'zh-CN']), 'en and zh-CN');
  assert.notEqual(joinList('zh-CN', ['en', 'zh-CN']), joinList('en', ['en', 'zh-CN']));
  assert.ok(joinList('zh-CN', ['en', 'zh-CN']).includes('en'));
});
