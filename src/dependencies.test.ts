/**
 * The kernel declares no dependency, and reaches for nothing it would have to
 * install.
 *
 * `CONTRIBUTING.md` states the rule — *"No dependencies at all — no runtime
 * dependency and no dev dependency, so a clone runs without an install step"* —
 * and the README now promises a reader the same thing before they type a
 * command. What neither can do is notice the day it stops being true. A
 * `devDependencies` entry and an `import 'lodash'` both work on the machine of
 * whoever added them, because the package is already in their `node_modules`;
 * the first person to find out is a reader who clones and runs, and by then the
 * promise is broken exactly where a newcomer trusts it.
 *
 * So the rule is checked rather than stated. **Two facts, and one does not cover
 * the other**: what the manifest declares (a build step's dependency is never
 * imported), and what the source actually reaches for (a bare specifier can
 * resolve to nothing at all). Both are asserted below.
 *
 * **What is deliberately out of scope is `prototype/`.** It is the previous
 * version, it carries its own `package.json` and its own `node_modules`, and it
 * is not this kernel — which is why a specifier that climbs out of `src/` is
 * refused as firmly as a bare one. A relative path is not automatically innocent.
 *
 * Nothing here names a package: the rule is that there are none, and a list of
 * exceptions would be the first entry in the thing it guards.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/** This file's own directory, and the repository root beside it. */
const SRC = fileURLToPath(new URL('.', import.meta.url));
const ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * Every field a package can declare a dependency in.
 *
 * All six, because the rule is "no dependency" rather than "no `dependencies`":
 * a `devDependency` breaks the no-install promise for anyone who wants to run
 * the tests, and a `peerDependency` breaks it for the reader who installs this.
 */
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
  'bundledDependencies',
  'bundleDependencies',
] as const;

/**
 * The four statement shapes that carry a module specifier.
 *
 * **Anchored** (`^` with the `m` flag) because a plain search for `from '<path>'`
 * also matches prose: this tree contains the words *newest first*, and a regex
 * literal in `watch.ts` that happens to hold a `from`, and neither is an import.
 * **Bounded** (`[^;'"]*?` — no semicolon and no quote before the `from`) because
 * an unbounded `[\s\S]*?` runs out of an `export function` and into whatever
 * quotation appears a hundred lines below it, which is how a guard invents a
 * dependency nobody wrote. Both of those were measured on this tree, not guessed:
 * the naive form reports 291 specifiers, three of them prose.
 *
 * `export … from` is here because a re-export pulls a module in exactly as an
 * import does — `src/index.ts` is almost entirely re-exports, and a rule reading
 * only `import` would miss the busiest file in the kernel.
 */
const STATEMENTS = [
  /^import\b[^;'"]*?\bfrom\s*'([^']+)'/gm,
  /^export\b[^;'"]*?\bfrom\s*'([^']+)'/gm,
  /^import\s*'([^']+)'/gm,
  /\bimport\(\s*'([^']+)'/gm,
];

/** Every specifier one file's text carries, in the order it appears. */
function specifiersIn(text: string): string[] {
  const found: string[] = [];
  for (const statement of STATEMENTS) {
    for (const match of text.matchAll(statement)) found.push(match[1]);
  }
  return found;
}

/** Every `.ts` file under `src/`, recursively — tests included, since they ship too. */
function sources(): { file: string; text: string }[] {
  return readdirSync(SRC, { recursive: true })
    .map((entry) => String(entry))
    .filter((name) => name.endsWith('.ts'))
    .sort()
    .map((name) => ({ file: name, text: readFileSync(join(SRC, name), 'utf8') }));
}

test('the manifest declares no dependency of any kind', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  // Anti-vacuity: the file that was read is this package. A wrong path would
  // otherwise pass every assertion below by testing an empty object.
  assert.equal(manifest.name, 'seek');

  const declared = DEPENDENCY_FIELDS.filter((field) => {
    const value = manifest[field];
    if (value === undefined || value === null) return false;
    return Array.isArray(value) ? value.length > 0 : Object.keys(value as object).length > 0;
  });

  assert.deepEqual(
    declared,
    [],
    `a dependency was declared in ${declared.join(', ') || 'none'} — a clone is meant to run ` +
      'with no install step at all (CONTRIBUTING.md, "Code stage")',
  );
});

test('every module the kernel reaches for is a builtin or a sibling inside src', () => {
  const files = sources();
  // Anti-vacuity, first form: a scanner that read no files would agree with every
  // rule below, so the reading is asserted before the conclusion drawn from it.
  assert.ok(files.length > 20, `only ${files.length} source files were read`);

  const reached = files.flatMap(({ file, text }) =>
    specifiersIn(text).map((specifier) => ({ file, specifier })),
  );
  assert.ok(reached.length > 100, `only ${reached.length} specifiers were found`);

  const foreign = reached.filter(
    ({ specifier }) =>
      !specifier.startsWith('node:') &&
      !specifier.startsWith('./') &&
      !specifier.startsWith('../'),
  );
  assert.deepEqual(
    foreign,
    [],
    `these reach for something that would have to be installed: ` +
      foreign.map(({ file, specifier }) => `${specifier} (${file})`).join(', '),
  );

  // The one relative form that is not innocent: `../` leaves the kernel, and the
  // directory beside it is the prototype — which installs its own dependencies.
  const escaped = reached.filter(({ specifier }) => specifier.startsWith('../'));
  assert.deepEqual(
    escaped,
    [],
    `these climb out of src/: ` +
      escaped.map(({ file, specifier }) => `${specifier} (${file})`).join(', '),
  );

  // Anti-vacuity, second form: the two shapes easiest to miss, pinned where they
  // actually are. A tree of plain `import` lines would otherwise pass a scanner
  // that never read a re-export, and one that read re-exports but not builtins
  // would still pass the two rules above.
  const byFile = new Map<string, string[]>();
  for (const { file, specifier } of reached) {
    byFile.set(file, [...(byFile.get(file) ?? []), specifier]);
  }
  const barrel = byFile.get('index.ts') ?? [];
  assert.ok(barrel.length >= 10, `the re-export barrel was read (${barrel.length} specifiers)`);
  const fromMain = byFile.get('main.ts') ?? [];
  assert.ok(
    fromMain.some((specifier) => specifier.startsWith('node:')),
    'builtins are seen as well as siblings',
  );
});
