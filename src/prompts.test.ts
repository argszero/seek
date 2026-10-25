import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { deliver } from './delivery.ts';
import { makeWorld, type World } from './fixtures.ts';
import {
  assemblePrompt,
  loadPromptArtifact,
  shippedPromptPath,
  skeletonOf,
  type PromptArtifact,
} from './prompts.ts';
import type { Id } from './types.ts';
import { watchAs, type Tokeniser, type WatchInput, type WatchReading } from './watch.ts';

const SYSTEM =
  'You are the ops bot of a payments team. Your job: catch incidents and answer ' +
  'questions the team asks. You stay quiet otherwise.';
const QUESTION = 'Do you need to do something about this message? Answer act or ignore.';

/** The dispatched stub tokeniser: one id per space-delimited chunk. */
function makeTokeniser(): Tokeniser {
  let next = 5000;
  const ids = new Map<string, number>();
  return {
    encode(text: string): number[] {
      const out: number[] = [];
      for (const chunk of text.match(/ ?[^ ]+/g) ?? []) {
        let id = ids.get(chunk);
        if (id === undefined) {
          id = next;
          next += 1;
          ids.set(chunk, id);
        }
        out.push(id);
      }
      return out;
    },
  };
}

function stub(answer: WatchReading) {
  const seen: WatchInput[] = [];
  return {
    seen,
    model: {
      read(input: WatchInput): WatchReading {
        seen.push(input);
        return answer;
      },
    },
  };
}

function say(world: World, texts: string[]): void {
  for (const text of texts) deliver(world.store, { roomId: world.room, senderId: world.me, text });
}

/** A second artifact, written somewhere else, so the text cannot be a literal. */
const PERMUTED: PromptArtifact = {
  version: 'test-v9',
  system: 'You watch one room.',
  afterSystem: '\n',
  parts: [
    { name: 'message', text: 'Message: {text}', after: '\n', when: 'always', each: 'observation' },
    { name: 'summary', text: 'Room memory: {summary}', after: '\n', when: 'summary' },
    {
      name: 'question',
      text: 'Does this room need you to act? Answer act or ignore.',
      after: ' ',
      when: 'always',
    },
  ],
  operatingPoint: { threshold: 0.75, measuredOn: 'not measured: a fixture' },
};

test('the shipped artifact is the shape that was measured', () => {
  const artifact = loadPromptArtifact();

  assert.equal(artifact.version, 'watch-v1');
  assert.equal(artifact.operatingPoint?.threshold, 0.6, 'the cut ships as a declared default');
  assert.match(artifact.operatingPoint?.measuredOn ?? '', /calibration\/measured\.json/);

  // Verbatim, and in this order: system, the room's memory, the message, the
  // question — the last of them followed by the space the option is appended at.
  assert.equal(
    assemblePrompt(artifact, { summary: 'a release is being arranged', texts: ['deploy is red'] }),
    `${SYSTEM}\n\nRoom memory: a release is being arranged\n\nMessage: deploy is red\n${QUESTION} `,
  );
  // No summary yet is a room whose first judgement is cold, not a room with an
  // empty memory: the part is skipped with its separator, not rendered blank.
  assert.equal(
    assemblePrompt(artifact, { texts: ['deploy is red'] }),
    `${SYSTEM}\n\nMessage: deploy is red\n${QUESTION} `,
  );
});

test('the mask is measured on an assembly that ends where every assembly ends', () => {
  const artifact = loadPromptArtifact();
  const skeleton = skeletonOf(artifact);

  assert.equal(skeleton.version, artifact.version);
  // The skeleton is the same text with nothing in the box. Its last character is
  // the one an option is appended after, so the ids read there are the ids a full
  // room reads its answer at.
  assert.equal(skeleton.text, `${SYSTEM}\n\n${QUESTION} `);
  const full = assemblePrompt(artifact, {
    summary: 'anything at all',
    texts: ['one', 'two', 'three'],
  });
  assert.ok(full.endsWith(skeleton.text.slice(-QUESTION.length - 1)), 'the same end, whatever the box holds');
});

test('a room message cannot write the front of its own prompt', () => {
  // One pass over the templates. A message that contained the other placeholder is
  // text, not a substitution site — otherwise a room could place a "memory" it
  // never had, or fill the question slot.
  const artifact = loadPromptArtifact();
  const text = assemblePrompt(artifact, {
    summary: 'quiet',
    texts: ['{summary} and {text} are what this line says'],
  });

  assert.ok(text.includes('Message: {summary} and {text} are what this line says\n'));
  assert.equal(text.match(/Room memory:/g)?.length, 1, 'the memory is rendered once, from the digest');
});

test('the order is the file\'s, all the way through the runtime', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seek-prompt-'));
  try {
    const path = join(directory, 'permuted.json');
    await writeFile(path, JSON.stringify(PERMUTED), 'utf8');
    const artifact = loadPromptArtifact(path);
    assert.equal(artifact.version, 'test-v9', 'the file decides the version too');

    const world = makeWorld();
    say(world, ['deploy is red']);
    const { model, seen } = stub({ probabilities: { act: 0.1, ignore: 0.9 } });
    // No `operatingPoint`: this artifact declares 0.75, and that is what applies.
    await watchAs(world.store, world.botA, model, {
      window: 10,
      prompt: artifact,
      tokeniser: makeTokeniser(),
    })(await world.store.drain(world.botA));

    const text = seen[0].prompt.text;
    assert.equal(seen[0].prompt.version, 'test-v9');
    assert.ok(
      text.indexOf('Message: deploy is red') < text.indexOf('Does this room need you to act?'),
      'the message comes before the question, as this file lists them',
    );
    assert.ok(text.startsWith('You watch one room.\n'), 'and the system block is its head');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an artifact the runtime cannot honour is refused, and says why', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seek-prompt-'));
  try {
    const cases: [string, unknown, RegExp][] = [
      [
        'a per-observation part with nothing after it',
        { ...PERMUTED, parts: [PERMUTED.parts[1], PERMUTED.parts[0]] },
        /repeats per observation/,
      ],
      [
        'a conditional last part',
        { ...PERMUTED, parts: [PERMUTED.parts[0], PERMUTED.parts[1]] },
        /is conditional/,
      ],
      [
        'a placeholder with nothing to fill it',
        {
          ...PERMUTED,
          parts: [
            { name: 'message', text: 'Message: {text}', after: '\n', when: 'always' },
            PERMUTED.parts[2],
          ],
        },
        /without `each: "observation"`/,
      ],
      [
        'a cut at an edge',
        { ...PERMUTED, operatingPoint: { threshold: 1 } },
        /strictly between 0 and 1/,
      ],
    ];

    for (const [label, value, expected] of cases) {
      const path = join(directory, `bad-${label.replace(/\W+/g, '-')}.json`);
      await writeFile(path, JSON.stringify(value), 'utf8');
      assert.throws(() => loadPromptArtifact(path), expected, label);
    }

    assert.throws(
      () => loadPromptArtifact(join(directory, 'absent.json')),
      /could not be read/,
      'a missing artifact is not a runtime with a built-in prompt',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the shipped file is the one the runtime loads by default', () => {
  const artifact = loadPromptArtifact();
  const shipped = shippedPromptPath();

  assert.match(shipped.pathname, /src\/prompts\/watch-v1\.json$/);
  assert.equal(loadPromptArtifact(shipped).version, artifact.version);
  assert.deepEqual(skeletonOf(artifact), skeletonOf(loadPromptArtifact(shipped)));
});

test('an artifact with no declared cut and no supplied one is refused, not guessed', async () => {
  const world = makeWorld();
  const undecided: PromptArtifact = {
    version: 'watch-v2',
    system: 'You watch one room.',
    afterSystem: '\n',
    parts: PERMUTED.parts,
  };
  say(world, ['one']);
  const { model } = stub({ probabilities: { act: 0.9, ignore: 0.1 } });

  await assert.rejects(
    async () =>
      watchAs(world.store, world.botA as Id, model, {
        window: 10,
        prompt: undecided,
        tokeniser: makeTokeniser(),
      })(await world.store.drain(world.botA)),
    /declares no operating point and none was supplied/,
    '0.5 would always fit, which is why it cannot be the fallback',
  );
});

test('the accuracy the artifact advertises is the one its record gives at that cut', () => {
  const artifact = loadPromptArtifact();
  const stated = artifact.operatingPoint?.measuredOn ?? '';

  // The sentence is the provenance of a threshold a verdict is read against, so the
  // figure inside it has to be one a reader can recompute — and it was not. It said
  // "100% at this cut" while the per-case record gives 20/24: the best cut's accuracy,
  // written down as this cut's. A provenance line nobody can check is the same defect
  // as a number with no set behind it, one layer up.
  const fraction = /(\d+)\/(\d+) correct at this cut/.exec(stated);
  assert.ok(
    fraction !== null,
    'the artifact states its accuracy at the cut in the form this check reads — a ' +
      'provenance sentence with no recomputable figure is a claim nobody can check',
  );

  interface Recorded {
    readonly cases: ReadonlyArray<{
      readonly label: string;
      readonly p_act_recorded: number;
      readonly p_act_server: number;
    }>;
  }
  const record = JSON.parse(
    readFileSync(new URL('../calibration/vision/server-transport.json', import.meta.url), 'utf8'),
  ) as Recorded;
  assert.ok(record.cases.length >= 24, 'the per-case record was read, not skipped');

  const cut = artifact.operatingPoint?.threshold ?? 0;
  const correct = (key: 'p_act_recorded' | 'p_act_server'): number =>
    record.cases.filter((entry) => (entry[key] >= cut) === (entry.label === 'act')).length;

  // The figure in the shipped sentence is the figure this cut earns, counted from the
  // cases rather than quoted from a summary of them.
  assert.equal(
    `${fraction[1]}/${fraction[2]}`,
    `${correct('p_act_recorded')}/${record.cases.length}`,
    'the shipped sentence and the per-case record disagree about this cut',
  );

  // Two readers agree, so the figure is the reading's and not one rig's arithmetic.
  assert.equal(
    correct('p_act_server'),
    correct('p_act_recorded'),
    'the server and the one-shot rig disagree about how many cases this cut gets right',
  );

  // The invariant that outlives the number: a cut scores every case exactly when it
  // lies inside the interval the two classes leave open. Stated as a relationship, so
  // the day the host moves the cut this test still means something — and so a "24/24"
  // claim is never accepted on a cut that cannot produce it.
  const acts = record.cases.filter((entry) => entry.label === 'act').map((e) => e.p_act_recorded);
  const ignores = record.cases
    .filter((entry) => entry.label !== 'act')
    .map((e) => e.p_act_recorded);
  const lowestAct = Math.min(...acts);
  const highestIgnore = Math.max(...ignores);
  assert.equal(
    correct('p_act_recorded') === record.cases.length,
    cut > highestIgnore && cut <= lowestAct,
    `a cut scores every case only inside (${highestIgnore}, ${lowestAct}]; this one is ${cut}`,
  );
});
