/**
 * A document and its Chinese twin say the same thing, and nothing checked that.
 *
 * `CONTRIBUTING.md` states the convention plainly: *"Both halves are the document.
 * When they disagree, that is a defect in the pair and is fixed at once, not a
 * hierarchy where one wins by default. So a change to an English file is not finished
 * until its Chinese twin is changed in the same commit."* Ten documents ship in both
 * languages. Until this file existed, no test read a single one of them — which is the
 * same shape as the dependency rule and the roster's `model` field before it: a
 * promise the project makes about itself that only a reader's attention was guarding.
 *
 * **It had already drifted.** On 2026-10-25 the specification of the watch half,
 * `docs/design/agent-lifecycle.md` §"The observation box", carried ten points in
 * English and six in Chinese. Three of the four missing ones appeared nowhere in the
 * Chinese file at all — *"Compaction is a runtime action, not a turn"*, *"The box
 * handed over always fits"*, *"The judgement is not asked whether to compact"* — and all
 * three describe behaviour that already ships (`box.ts` carries `unread` and the
 * eighty-of-three-hundred example; `compact.ts` says a judgement is never asked), so
 * the Chinese reader was being told less than the code does. The English was right and
 * the Chinese was stale, which is why they were restored rather than removed.
 *
 * **What is compared is structure, not prose.** Two things are counted per section:
 * that both halves have the same sections in the same order, and that each section
 * carries the same number of `- **` points. Prose cannot be compared by a machine, and
 * a translated length is expected to differ — the Chinese runs shorter, always, and
 * that is not a defect. A **missing point** is.
 *
 * The measurement that ruled out the obvious alternative is worth recording: comparing
 * the *set of numbers* appearing in each half does not work. Prose legitimately uses
 * different figures (`100`, `220`, `7500` all differed between correct twins), and the
 * check produced only noise. Section and point counts produced exactly one hit, and it
 * was a real one.
 *
 * **What this file does not decide is which documents are meant to have a twin.**
 * `NOTICE.md` and `prototype/README.md` have none, while `CONTRIBUTING.md` names only
 * one exception (`LICENSE`, because a translated licence is not the licence). Whether
 * those two should gain twins or the exception list should say more is the
 * repository's call, not a test's, so a document with no twin is not reported here —
 * only a pair that disagrees.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** The suffix `CONTRIBUTING.md` fixes for a twin: beside the original, never a tree. */
const TWIN_SUFFIX = '.zh-CN.md';

/** Directories that hold no document of this repository. */
const SKIP = new Set(['node_modules', '.git', '.emrg', 'dist']);

/** Every `.md` file in the repository, as a path relative to the root, sorted. */
function markdownFiles(): string[] {
  return readdirSync(ROOT, { recursive: true })
    .map((entry) => String(entry))
    .filter((name) => name.endsWith('.md'))
    .filter((name) => !name.split('/').some((part) => SKIP.has(part)))
    .sort();
}

/**
 * How many `- **` points each section of a document carries.
 *
 * One entry per `##`/`###` heading, in document order, so two documents are compared
 * position by position. A heading with no points counts as `0` rather than vanishing —
 * a section that lost its list entirely is exactly the drift this is for, and skipping
 * empty sections would hide it.
 */
function sectionsOf(text: string): number[] {
  const counts: number[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('## ') || line.startsWith('### ')) counts.push(0);
    else if (counts.length > 0 && line.startsWith('- **')) counts[counts.length - 1] += 1;
  }
  return counts;
}

test('every document and its Chinese twin carry the same sections and the same points', () => {
  const files = markdownFiles();
  const pairs = files
    .filter((name) => !name.endsWith(TWIN_SUFFIX))
    .map((name) => ({ en: name, zh: name.slice(0, -'.md'.length) + TWIN_SUFFIX }))
    .filter(({ zh }) => existsSync(join(ROOT, zh)));

  // Anti-vacuity, first form: a scan that found no pairs would agree with every rule
  // below without reading anything. The convention is stated for ten documents, so a
  // number far below that means the scan is broken, not that the repository shrank.
  assert.ok(pairs.length >= 8, `only ${pairs.length} document pairs were found`);

  const totalSections = pairs.reduce(
    (sum, { en }) => sum + sectionsOf(readFileSync(join(ROOT, en), 'utf8')).length,
    0,
  );
  assert.ok(totalSections >= 60, `only ${totalSections} sections were read across the pairs`);

  const drifting: string[] = [];
  for (const { en, zh } of pairs) {
    const english = sectionsOf(readFileSync(join(ROOT, en), 'utf8'));
    const chinese = sectionsOf(readFileSync(join(ROOT, zh), 'utf8'));

    if (english.length !== chinese.length) {
      drifting.push(
        `${en} has ${english.length} sections and ${zh} has ${chinese.length}`,
      );
      continue;
    }
    // Compared by position: the convention is that the two halves are one document, so
    // section 3 of one corresponds to section 3 of the other. A section inserted on one
    // side alone shifts everything after it and is reported here rather than guessed at.
    const points = english
      .map((count, index) => ({ count, twin: chinese[index], index }))
      .filter(({ count, twin }) => count !== twin);
    for (const { count, twin, index } of points) {
      drifting.push(
        `${en} §${index + 1} carries ${count} points and its twin carries ${twin}`,
      );
    }
  }

  assert.deepEqual(
    drifting,
    [],
    'a document and its Chinese twin have drifted apart — both halves are the ' +
      'document (CONTRIBUTING.md, "Language"), so fix the pair in one commit:\n' +
      drifting.map((line) => `  ${line}`).join('\n'),
  );
});

test('the twin convention is read from the tree, not from a list kept beside it', () => {
  // A list of pairs here would be a second place to forget. This pins that the scan is
  // the source: the documents the README tells a reader about are among the pairs found,
  // so a rename that broke discovery would fail here rather than pass quietly.
  const files = markdownFiles();
  for (const expected of [
    'README.md',
    'CONTRIBUTING.md',
    'docs/host-rulings.md',
    'src/README.md',
  ]) {
    assert.ok(files.includes(expected), `${expected} was not found by the scan`);
    const twin = expected.slice(0, -'.md'.length) + TWIN_SUFFIX;
    assert.ok(files.includes(twin), `${twin} was not found by the scan`);
  }
  // And the skip list is doing its job rather than swallowing the tree.
  assert.ok(
    files.every((name) => !name.startsWith('node_modules/')),
    'a dependency directory was scanned as documentation',
  );
  assert.ok(
    files.every((name) => relative(ROOT, join(ROOT, name)) === name),
    'scan paths are relative to the repository root',
  );
});
