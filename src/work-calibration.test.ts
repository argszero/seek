/**
 * The work-model record is a table and a pile of raw readings, and the table is a summary
 * of the readings — the exact shape this project keeps finding broken.
 *
 * `calibration/work/provenance.md` states three counts per model and calls them measured.
 * The numbers behind them sit beside it in `measured.json` as per-case rows, and the two
 * are written by the same script, so nothing in the tree notices when a later edit moves
 * one and not the other. That is the failure `src/calibration.test.ts` was written for one
 * directory up: a record that can drift from its source while still reading like a
 * measurement.
 *
 * Five checks, each leaning on something outside the sentence it checks:
 *
 * 1. **The table against its readings.** Every count is re-derived from the per-case rows
 *    and compared. A table that says `6/6` over rows that hold five calls fails here.
 * 2. **The cases against the rows.** The nine labelled cases in `cases.json` must be
 *    exactly the cases every row was measured on — same labels, same texts, same count.
 *    Dropping a case from a row while the table still divides by six is the quiet way to
 *    make a model look better than it is.
 * 3. **The record against the artifact it claims to have measured.** The record quotes the
 *    shipped `ask` and the artifact's part names, and says it changed nothing. Read the
 *    artifact instead of believing the quote: an edit to `src/prompts/work-v1.json` makes
 *    the record describe a prompt that is no longer the one that ships.
 * 4. **The prose table against the record.** `provenance.md` and its Chinese twin each
 *    restate the table as Markdown, cell for cell. Both are compared against `measured.json`
 *    here, because the first two copies of that table were written by hand and one of them
 *    kept stating the timings of a run that had already been repeated.
 * 5. **The measured files against their bytes.** Every model in the record carries the
 *    SHA-256 and size of the file it was run on.
 *
 * What this does not decide is whether the models were any good. It cannot re-run them —
 * they are 1–2 GB of weights this repository does not ship. It decides only that the
 * table, the rows and the artifact still agree with each other.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

const CASES = 'calibration/work/cases.json';
const RECORD = 'calibration/work/measured.json';
const ARTIFACT = 'src/prompts/work-v1.json';

/** The record's own two restatements of the table, English and Chinese. */
const PROSE = ['calibration/work/provenance.md', 'calibration/work/provenance.zh-CN.md'];

interface Case {
  label: string;
  text: string;
}

interface Row {
  want: 'speak' | 'quiet';
  text: string;
  reps: number;
  outcomes: string[];
  stable: boolean;
  said: boolean;
  prose: boolean;
  silent: boolean;
}

interface Reading {
  model: string;
  file: string;
  rows: Row[];
}

interface TableRow {
  model: string;
  delivered: number;
  proseOnly: number;
  silentWhenShouldSpeak: number;
  stayedQuiet: number;
  spokeWhenShouldNot: number;
  proseWhenShouldBeQuiet: number;
  reps: number;
  unstableCases: number;
  medianMs: number;
}

interface Record {
  table: TableRow[];
  readings: Record<string, Reading>;
  files: Record<string, { bytes: number; sha256: string }>;
  prompt: { artifact: string; modified: boolean; parts: string[]; ask: string };
}

function read<T>(relative: string): T {
  return JSON.parse(readFileSync(join(ROOT, relative), 'utf8')) as T;
}

const cases = read<{ labels: Record<string, string>; cases: Case[] }>(CASES);
const record = read<Record>(RECORD);

/** The counts the table claims, re-derived from the rows it summarises. */
function derive(rows: Row[]): Record<string, number> {
  const speak = rows.filter((row) => row.want === 'speak');
  const quiet = rows.filter((row) => row.want === 'quiet');
  return {
    delivered: speak.filter((row) => row.said).length,
    proseOnly: speak.filter((row) => row.prose).length,
    silentWhenShouldSpeak: speak.filter((row) => row.silent).length,
    stayedQuiet: quiet.filter((row) => row.silent).length,
    spokeWhenShouldNot: quiet.filter((row) => row.said).length,
    proseWhenShouldBeQuiet: quiet.filter((row) => row.prose).length,
    unstableCases: rows.filter((row) => !row.stable).length,
  };
}

test('the table is what its own per-case readings say', () => {
  assert.ok(Array.isArray(record.table) && record.table.length > 0, `${RECORD} holds no table`);
  for (const row of record.table) {
    const reading = record.readings[row.model];
    assert.ok(
      reading,
      `${RECORD}'s table names ${row.model} and holds no readings under that name — a row ` +
        'with nothing behind it is a number, not a measurement',
    );
    const derived = derive(reading.rows);
    for (const [field, value] of Object.entries(derived)) {
      assert.equal(
        row[field as keyof TableRow],
        value,
        `${row.model}'s table row says ${field}=${row[field as keyof TableRow]} and its own ` +
          `per-case rows give ${value}. One of them was edited and the other was not`,
      );
    }
    assert.equal(
      row.reps,
      reading.rows[0]?.reps,
      `${row.model}'s table row claims ${row.reps} repeat(s) per case and its rows recorded ` +
        `${reading.rows[0]?.reps ?? 'none'}`,
    );
    for (const caseRow of reading.rows) {
      assert.equal(
        caseRow.outcomes.length,
        caseRow.reps,
        `the row for ${JSON.stringify(caseRow.text)} says ${caseRow.reps} repeat(s) and ` +
          `recorded ${caseRow.outcomes.length} outcome(s)`,
      );
    }
  }
});

test('every row was measured on exactly the labelled cases, labels included', () => {
  const declared = cases.cases
    .map((one) => `${one.label}\u0000${one.text}`)
    .sort();
  assert.equal(
    declared.length,
    cases.cases.length,
    `${CASES} holds the same case twice, so a count over it is not a count of cases`,
  );
  for (const label of new Set(cases.cases.map((one) => one.label))) {
    assert.ok(
      Object.hasOwn(cases.labels, label),
      `${CASES} uses the label ${JSON.stringify(label)} and its labels block does not define it`,
    );
  }
  assert.ok(
    cases.cases.some((one) => one.label === 'speak') &&
      cases.cases.some((one) => one.label === 'quiet'),
    `${CASES} has to carry both directions — a set that only wants speech scores a model ` +
      'that never stops talking at full marks',
  );

  for (const [model, reading] of Object.entries(record.readings)) {
    const measured = reading.rows.map((row) => `${row.want}\u0000${row.text}`).sort();
    assert.deepEqual(
      measured,
      declared,
      `${model} was not measured on the declared cases: the rows and ${CASES} differ. A ` +
        'case dropped from a row while the table still divides by six makes the model look ' +
        'better than the run did',
    );
  }
});

test('the record describes the prompt this tree ships, not one it used to ship', () => {
  assert.equal(record.prompt.artifact, ARTIFACT, `${RECORD} points at another artifact`);
  assert.equal(
    record.prompt.modified,
    false,
    `${RECORD} no longer states that the artifact was sent unmodified, which is the only ` +
      'reason the rows differ in one variable',
  );

  const artifact = read<{ parts: { name: string; text: string }[]; tools: { name: string }[] }>(
    ARTIFACT,
  );
  assert.deepEqual(
    record.prompt.parts,
    artifact.parts.map((part) => part.name),
    `${ARTIFACT}'s parts have moved since it was measured, so the rows describe a prompt ` +
      'that is no longer the one that ships — re-measure, do not re-word the record',
  );
  const ask = artifact.parts.find((part) => part.name === 'ask');
  assert.ok(ask, `${ARTIFACT} has no ask part, so the record's quoted ask cannot be checked`);
  assert.equal(
    record.prompt.ask,
    ask.text,
    `${ARTIFACT}'s ask is not the one ${RECORD} quotes. The record is a measurement of a ` +
      'specific prompt; editing the prompt retires the measurement',
  );
});

test('every measured file is identified by its bytes', () => {
  for (const reading of Object.values(record.readings)) {
    const name = reading.file.split('/').pop() ?? reading.file;
    const file = record.files[name];
    assert.ok(
      file,
      `${reading.model} was measured on ${name}, and ${RECORD}'s files block does not name ` +
        'it — a reader can then neither confirm they measured the same weights nor notice ' +
        'that the row was taken on a different quantisation',
    );
    assert.match(
      file.sha256,
      /^[0-9a-f]{64}$/,
      `${name} is identified by ${JSON.stringify(file.sha256)}, which is not a SHA-256`,
    );
    assert.ok(
      Number.isInteger(file.bytes) && file.bytes > 0,
      `${name} carries ${JSON.stringify(file.bytes)} bytes, which is not a size — the two ` +
        'figures are what make "a different file" detectable at all',
    );
  }
});

test('the prose tables say what the record says, cell for cell', () => {
  const fields = [
    'delivered',
    'proseOnly',
    'silentWhenShouldSpeak',
    'stayedQuiet',
    'spokeWhenShouldNot',
    'proseWhenShouldBeQuiet',
  ] as const;
  const speak = cases.cases.filter((one) => one.label === 'speak').length;
  const quiet = cases.cases.filter((one) => one.label === 'quiet').length;
  const denominators = [speak, speak, speak, quiet, quiet, quiet];

  for (const relative of PROSE) {
    const text = readFileSync(join(ROOT, relative), 'utf8');
    const seen = new Set<string>();
    for (const line of text.split('\n')) {
      if (!line.startsWith('|')) continue;
      const cells = line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim());
      if (cells.length !== 8) continue;
      const median = /^(\d+)\s*ms$/.exec(cells[7] ?? '');
      if (!median) continue;

      const named = /`([^`]+)`/.exec(cells[0] ?? '');
      assert.ok(
        named,
        `${relative} has a results row that names no model file: ${JSON.stringify(line)}`,
      );
      const model = named[1] as string;
      const row = record.table.find((one) => one.model === model);
      assert.ok(
        row,
        `${relative} tabulates ${model}, and ${RECORD}'s table does not carry that model — ` +
          'one of the two lists a run the other has never heard of',
      );
      seen.add(model);

      fields.forEach((field, index) => {
        const cell = (cells[index + 1] ?? '').replaceAll('*', '');
        const fraction = /^(\d+)\/(\d+)$/.exec(cell);
        assert.ok(
          fraction,
          `${relative}: ${model}'s ${field} cell reads ${JSON.stringify(cell)}, which is not a ` +
            'fraction — a cell a reader cannot divide is a cell this check cannot read either',
        );
        assert.equal(
          Number(fraction[1]),
          row[field],
          `${relative}: ${model}'s ${field} column says ${fraction[1]} and ${RECORD} says ` +
            `${row[field]}. The prose and the record were edited apart`,
        );
        assert.equal(
          Number(fraction[2]),
          denominators[index],
          `${relative}: ${model}'s ${field} column divides by ${fraction[2]} and ${CASES} holds ` +
            `${denominators[index]} case(s) with that label — the denominator is how a row ` +
            'quietly stops being a count of the whole set',
        );
      });

      assert.equal(
        Number(median[1]),
        row.medianMs,
        `${relative}: ${model}'s median reads ${median[1]} ms and ${RECORD} records ` +
          `${row.medianMs} ms — the timing of a run that was repeated cannot stay in the prose`,
      );
    }

    assert.ok(
      seen.size > 0,
      `${relative} carries no results row this check can read, so it now states measurements ` +
        'nothing verifies',
    );
    for (const row of record.table) {
      assert.ok(
        seen.has(row.model),
        `${relative} does not tabulate ${row.model}, which ${RECORD} measured — a twin record ` +
          'missing a row reads as a model that was never tried',
      );
    }
  }
});
