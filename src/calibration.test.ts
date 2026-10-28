/**
 * The calibration record describes the runtime this tree actually runs, and nothing
 * checked that.
 *
 * `calibration/measured.json` is the persisted copy of the readings the shipped
 * prompt and its operating point rest on. Its own `_why_this_file_exists` says why it
 * matters: four of the scripts that produced those numbers print them and write no
 * file, so this record is the only copy. A record with one copy has no second reader,
 * which is the same shape as the count in the READMEs and the roster's `model` field
 * before it — a promise the project makes about itself that only a reader's attention
 * was guarding.
 *
 * **It had already gone stale, in two places, and one of them contradicted the same
 * file.** On 2026-10-25 `how_the_probability_was_read` still said *"the measurement
 * and the runtime do not read the same estimator today"*, named `bindOptions` as the
 * runtime's reader, and called the difference *"a stated open tension, not a settled
 * fact — the design carries it with the word that would change it"*. Three of
 * those four things were false at once: `src/llama.ts`'s `readingOf` sums every
 * candidate whose decoded form spells the option, `src/llama.test.ts` asserts that
 * sum, and the design settles the reading rather than carrying it as
 * open. And `what_was_not_measured` still led with *"vision: no image case was ever
 * run"* while `model.vision_projector`, eleven lines above it in the same object,
 * reported vision being measured — 56 English image cases and 12 Chinese, 41/56 at
 * the shipped cut.
 *
 * **What is compared is not prose, and it is not a pinned number.** A record cannot
 * be checked against a copy of itself, so the three checks below each lean on
 * something outside the sentence they are checking:
 *
 * 1. **The declaration, and where it points.** The record states the estimator its own
 *    numbers were taken under, in a field a machine reads — and, because that reading no
 *    longer ships, the record that replaced it. The pointer is followed and that file's
 *    `transport` is read, so "superseded" is a fact about a file rather than a word.
 * 2. **The implementation.** The reader this tree ships is read out of `src/llama.ts`:
 *    it holds the endpoint's probabilities to the two declared options and neither
 *    exponentiates a logprob nor sums over spellings. Every document that describes the
 *    estimator has to name the record that replaced this one, so that none of them still
 *    describes the summed reading as what ships.
 * 3. **The corpus.** The record may not call something unmeasured while the tree
 *    holds labelled cases for it. What counts as a set is structural, not verbal: a
 *    labelled case set carries a `labels` field and a `cases` array, while a replay
 *    or a summary of one carries `result` and no labels — so `server-transport.json`
 *    and `measured.json` are not counted as sets, and the sixty-eight cases in
 *    `cases.json`, `heldout.json`, `boundary.json` and `zh.json` are.
 *
 * What this file does not decide is whether the numbers themselves are right. It
 * cannot: they came from a model this repository does not ship and a run nothing here
 * re-executes. It decides only that the record says what the tree does.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** The record under test, and the two documents that describe the same estimator. */
const RECORD = 'calibration/measured.json';
const DESCRIBERS = [
  RECORD,
  'calibration/provenance.md',
  'calibration/provenance.zh-CN.md',
];

/** The directory whose labelled sets make "unmeasured" a claim about this tree. */
const VISION = 'calibration/vision';

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8');
}

interface MeasuredRecord {
  model: Record<string, string>;
  how_the_probability_was_read: Record<string, string>;
  what_was_not_measured: string[];
}

function record(): MeasuredRecord {
  const parsed = JSON.parse(read(RECORD)) as MeasuredRecord;
  assert.ok(
    parsed.how_the_probability_was_read && parsed.what_was_not_measured && parsed.model,
    `${RECORD} no longer holds the three blocks this check reads — a record that ` +
      'dropped them has stopped saying what its numbers rest on',
  );
  return parsed;
}

/**
 * One function's body, taken from the file that declares it.
 *
 * Read rather than imported because the claim is about what the shipped reader *is*,
 * and an import would only prove that some function exists under that name. The body
 * runs to the first line that is a closing brace in column zero, which is where a
 * top-level function in this tree ends.
 */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`\nfunction ${name}(`);
  assert.ok(
    start >= 0,
    `src/llama.ts declares no function ${name}, and the documents name it as the ` +
      'reader of the option probability — one of the two has to move',
  );
  const end = source.indexOf('\n}', start);
  assert.ok(end > start, `the body of ${name} could not be read out of src/llama.ts`);
  return source.slice(start, end);
}

/** How many labelled image cases the tree holds, counted structurally. */
function labelledImageCases(): { total: number; sets: string[] } {
  const sets: string[] = [];
  let total = 0;
  for (const name of readdirSync(join(ROOT, VISION)).sort()) {
    if (!name.endsWith('.json')) continue;
    const parsed = JSON.parse(read(join(VISION, name))) as {
      labels?: unknown;
      cases?: unknown;
    };
    if (parsed.labels === undefined || !Array.isArray(parsed.cases)) continue;
    sets.push(`${name} (${parsed.cases.length})`);
    total += parsed.cases.length;
  }
  return { total, sets };
}

test('the record names the reading it took, and the tree reads the endpoint that replaced it', () => {
  const how = record().how_the_probability_was_read;
  assert.equal(
    how.estimator,
    'summed_over_spellings',
    `${RECORD} must state which estimator its numbers were taken under, in a field a ` +
      'machine reads. The numbers in this file were summed over the spellings of an option, ' +
      'and calling them anything else would describe a measurement nobody took — this record ' +
      'is history and it is allowed to be history, but not to be mislabelled history',
  );

  // A record whose reading no longer ships has to name the one that does, and the file it
  // names has to exist: a pointer to nothing is the same defect as no pointer at all.
  assert.ok(
    typeof how.superseded_by === 'string' && how.superseded_by.length > 0,
    `${RECORD} describes a reading this tree no longer performs and names no record that ` +
      'replaced it, so a reader has nothing to follow to the numbers 0.600 rests on today',
  );
  const successor = JSON.parse(read(how.superseded_by)) as {
    transport?: string;
    threshold?: number;
  };
  assert.match(
    String(successor.transport),
    /\/v1\/systemone/,
    `${how.superseded_by} is the record this one points at, and it does not say its numbers ` +
      'came from /v1/systemone — the endpoint the runtime reads now',
  );

  // The implementation, read out of the file rather than asserted about it. The reader that
  // ships holds the endpoint's numbers to the two declared options. It does not exponentiate
  // a logprob and it does not accumulate over candidates, because the endpoint generates no
  // token for either to be done to — a body that does is the reading that was replaced.
  const body = functionBody(read('src/llama.ts'), 'probabilitiesOf');
  assert.doesNotMatch(
    body,
    /Math\.exp\(|reduce\(/,
    'the summing reader is gone from this tree, so a reader that still exponentiates ' +
      'logprobs or accumulates over spellings is the reading that was replaced, not the one ' +
      'that ships',
  );
  assert.match(
    body,
    /tokens\.act/,
    "the reader the tree ships holds the endpoint's probabilities to the declared options, " +
      'and this body does not mention them',
  );

  for (const file of DESCRIBERS) {
    assert.match(
      read(file),
      /set4-d1\.json/,
      `${file} describes the estimator without naming the record that replaced this one. A ` +
        'document that still describes the summed reading as what ships is telling a reader ' +
        'about a runtime this tree does not have',
    );
  }
});

test('the record may not call unmeasured what the tree holds labelled cases for', () => {
  const { total, sets } = labelledImageCases();
  assert.ok(
    total > 0,
    `no labelled case set was found under ${VISION}, so the check below would pass on ` +
      'nothing — the sets are what "measured" means here',
  );

  const measured = record();
  assert.match(
    measured.model.vision_projector ?? '',
    /measur/i,
    `${RECORD}'s model block has stopped recording that vision was measured, while ` +
      `${total} labelled image cases sit in ${sets.join(', ')}`,
  );

  const denied = measured.what_was_not_measured.filter((line) => /no image case/i.test(line));
  assert.deepEqual(
    denied,
    [],
    `${VISION} holds ${total} labelled image cases — ${sets.join(', ')} — and ` +
      `${RECORD} says ${JSON.stringify(denied[0] ?? '')}. A record whose model block ` +
      'reports a measurement and whose unmeasured list denies it is the same ' +
      'self-contradiction that stood in this file until 2026-10-25',
  );
});
