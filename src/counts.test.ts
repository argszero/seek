/**
 * The counts the READMEs state are measured, not remembered.
 *
 * Four files describe this kernel by size — `README.md` and its Chinese twin say how
 * many TypeScript files, how many lines and how many tests, and `src/README.md` and
 * its twin say the test count again in their opening sentence. Nothing compared any of
 * them to the tree or to each other, and the cost was already being paid: four
 * consecutive contributions (#45, #46, #47, #48) each had to hand-edit all four sites
 * in the same commit, and the only thing keeping them true was whoever remembered.
 *
 * That is the same defect `src/docs.test.ts` was added for one layer out. There the two
 * halves of one *document* could drift; here two facts about one *tree* can — and the
 * drift is worse than cosmetic, because "**no interface**" sits in the same sentence.
 * A reader who finds the numbers stale has no reason to believe that part.
 *
 * **Three numbers, and all three are counted rather than trusted.**
 *
 * - Files: every `.ts` under `src/`. Every TypeScript file in this repository lives
 *   there (checked: `git ls-files '*.ts'` has nothing outside it), so the scope is the
 *   kernel and the count is the kernel's size.
 * - Lines: newlines, which is what `wc -l` reports, so a reader who checks by hand gets
 *   the same figure the test does.
 * - Tests: lines that begin with `test(` in a `*.test.ts` file. This is the one worth
 *   arguing about, because the obvious alternative — run the suite and read its summary
 *   — cannot be done from inside the suite: the child would run this file again, which
 *   would spawn a child of its own, without end. The declaration count is the honest
 *   substitute, and it was confirmed against reality before being trusted: it reads
 *   **307** on the tree whose runner reports **307 tests**, with no dynamically
 *   generated cases to make the two diverge.
 *
 * **What this file is measured against is itself.** It is a `.ts` file under `src/` and
 * it declares tests, so adding it moved every number it states — 45 files became 46 and
 * 307 tests became 309. The four sites were updated from this measurement in the same
 * commit rather than from arithmetic, which is the whole point: the guard cannot be
 * introduced without the thing it guards being made true.
 *
 * **What is deliberately not compared is prose arithmetic.** `docs/design/` and
 * `docs/design/` quote many figures (a 0.600 cut, an 0.840 AUC, 41 of 56 image cases),
 * and extracting "the documented number" from a sentence is the mistake `src/docs.test.ts`
 * records: the set of numbers in a document is noise. What is compared here is a fixed,
 * structured phrase in four files, and nothing else.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('.', import.meta.url));
const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** What the tree actually holds. */
interface Measured {
  readonly files: number;
  readonly lines: number;
  readonly tests: number;
}

/** What one document states. A document may state fewer than three. */
interface Stated {
  readonly file: string;
  readonly files?: number;
  readonly lines?: number;
  readonly tests: number;
}

/** Every newline in the string, which is the figure `wc -l` prints. */
function newlines(text: string): number {
  return text.split('\n').length - 1;
}

/** The kernel, measured: every `.ts` under `src/`, and the tests they declare. */
function measure(): Measured {
  const sources = readdirSync(SRC, { recursive: true })
    .map((entry) => String(entry))
    .filter((name) => name.endsWith('.ts'))
    .sort();

  let lines = 0;
  let tests = 0;
  for (const name of sources) {
    const text = readFileSync(join(SRC, name), 'utf8');
    lines += newlines(text);
    if (name.endsWith('.test.ts')) {
      // Anchored at column 0: this repository's convention is a top-level `test(` per
      // case, and an indented call would be a case nested inside another — which the
      // runner does not count as a test of its own either.
      tests += text.split('\n').filter((line) => line.startsWith('test(')).length;
    }
  }
  return { files: sources.length, lines, tests };
}

/**
 * The four documents that state a count, each with the sentence it states it in.
 *
 * A pattern that stops matching is a failure, not a skip: the count in `stated()` is
 * asserted below, so rewording one of these sentences turns this red rather than
 * quietly reducing the guard to three sites.
 */
const SITES: ReadonlyArray<{ file: string; pattern: RegExp; shape: 'all' | 'tests' }> = [
  {
    file: 'README.md',
    pattern: /\((\d+) TypeScript files, ~([\d,]+) lines, (\d+) tests\)/,
    shape: 'all',
  },
  {
    file: 'README.zh-CN.md',
    pattern: /（(\d+) 个 TypeScript 文件、约 ([\d,]+) 行、(\d+) 个测试）/,
    shape: 'all',
  },
  { file: 'src/README.md', pattern: /with (\d+) tests over them/, shape: 'tests' },
  { file: 'src/README.zh-CN.md', pattern: /(\d+) 个测试覆盖它们/, shape: 'tests' },
];

/** Read what each document says. */
function stated(): Stated[] {
  return SITES.map(({ file, pattern, shape }) => {
    const text = readFileSync(join(ROOT, file), 'utf8');
    const match = pattern.exec(text);
    if (match === null) {
      throw new Error(
        `${file} no longer states its count in the form this check reads — the sentence ` +
          'was reworded, so the count it carries is now unmeasured. Restore the shape or ' +
          'update the pattern beside it; do not delete the check',
      );
    }
    if (shape === 'tests') return { file, tests: Number(match[1]) };
    return {
      file,
      files: Number(match[1]),
      lines: Number(match[2].replace(/,/g, '')),
      tests: Number(match[3]),
    };
  });
}

test('every document that states a count states the same one, and the tree agrees', () => {
  const measured = measure();
  const read = stated();

  // Anti-vacuity, first form: four documents state a count, and a check that found one
  // would agree with itself.
  assert.equal(read.length, 4, 'all four documents were read');

  // The two root READMEs state all three numbers; the two under `src/` state the test
  // count alone. Every one of them has to agree with the tree, and with each other.
  for (const site of read) {
    assert.equal(
      site.tests,
      measured.tests,
      `${site.file} says ${site.tests} tests and the tree declares ${measured.tests}`,
    );
  }
  for (const site of read.filter((entry) => entry.files !== undefined)) {
    assert.equal(
      site.files,
      measured.files,
      `${site.file} says ${String(site.files)} TypeScript files and the tree holds ${measured.files}`,
    );
    assert.equal(
      site.lines,
      measured.lines,
      `${site.file} says ${String(site.lines)} lines and the tree holds ${measured.lines}`,
    );
  }

  // Anti-vacuity, second form: a walk that found an empty or truncated tree would make
  // every number agree at zero. The kernel is large and these floors say so.
  assert.ok(measured.files >= 30, `only ${measured.files} TypeScript files were walked`);
  assert.ok(measured.lines >= 10_000, `only ${measured.lines} lines were walked`);
  assert.ok(measured.tests >= 200, `only ${measured.tests} test declarations were found`);
});

test('the measurement counts the kernel, and the test declaration is what it says', () => {
  const measured = measure();

  // The lines are newlines, which is `wc -l`, so a reader checking by hand arrives at
  // the same figure rather than one differing by a trailing newline.
  const sample = readFileSync(join(SRC, 'i18n.ts'), 'utf8');
  assert.equal(newlines(sample), sample.split('\n').length - 1);

  // The declaration count has to be a count of cases the runner also counts. Every
  // `.test.ts` file sits directly in `src/`, and the tree is walked recursively, so a
  // nested test file would be walked — this pins that the two agree today, and that
  // the walk is not silently reaching outside the kernel.
  const testFiles = readdirSync(SRC, { recursive: true })
    .map((entry) => String(entry))
    .filter((name) => name.endsWith('.test.ts'));
  assert.ok(testFiles.length >= 15, `only ${testFiles.length} test files were walked`);
  assert.ok(
    measured.tests >= testFiles.length,
    'every test file declares at least one case',
  );

  // And nothing outside `src/` is being counted as the kernel.
  assert.ok(
    readdirSync(SRC, { recursive: true })
      .map((entry) => String(entry))
      .every((name) => !name.startsWith('node_modules')),
    'a dependency directory was walked as kernel source',
  );
});
