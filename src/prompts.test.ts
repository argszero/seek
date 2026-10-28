import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { deliver } from './delivery.ts';
import { makeWorld, type World } from './fixtures.ts';
import {
  assembleCompactPrompt,
  assemblePrompt,
  assembleWorkPrompt,
  loadCompactArtifact,
  loadPromptArtifact,
  loadWorkArtifact,
  shippedPromptPath,
  shippedWorkPromptPath,
  skeletonOf,
  type PromptArtifact,
  type PromptLine,
} from './prompts.ts';
import { watchAs, type WatchInput, type WatchReading } from './watch.ts';

// The head as the shipped file writes it, with the bot's own name in place: this is the
// sentence the host refused on 2026-10-28, when it described an ops bot of a payments
// team rather than whichever bot the judgement was for.
const SYSTEM = (bot: string) => `You are ${bot}, one of the bots in this chat client.`;

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

/** Box lines the way the runtime builds them: the text, who said it, when. */
function lines(...texts: string[]): PromptLine[] {
  return texts.map((text) => ({
    text,
    sender: '邵安清',
    at: '2026-10-28T15:44:08+08:00',
  }));
}

/** A second artifact, written somewhere else, so the text cannot be a literal. */
const PERMUTED: PromptArtifact = {
  version: 'test-v9',
  system: 'You watch one room.',
  afterSystem: '\n',
  parts: [
    { name: 'message', text: 'Message: {text}', after: '\n', when: 'always', each: 'observation' },
    { name: 'summary', text: 'Room memory: {summary}', after: '\n', when: 'summary' },
    { name: 'tail', text: 'End of the box.', after: '\n', when: 'always' },
  ],
  question: {
    instructions: 'Does this room need you to act?',
    criteria: {
      act: 'this room needs me now',
      ignore: 'this room does not need me now',
    },
  },
  operatingPoint: { threshold: 0.75, measuredOn: 'not measured: a fixture' },
};

test('the shipped artifact is the shape that was measured', () => {
  const artifact = loadPromptArtifact();

  assert.equal(artifact.version, 'watch-v3');
  assert.equal(artifact.operatingPoint?.threshold, 0.6, 'the cut ships as a declared default');
  assert.match(artifact.operatingPoint?.measuredOn ?? '', /set4/);

  // Verbatim, and in this order: the bot, what it does here, the other bots, the room,
  // the room's memory, then one line per entry. The two answers are the artifact's, and
  // they are what the endpoint is asked to choose between.
  assert.equal(
    assemblePrompt(artifact, {
      bot: 'Echo',
      position: '运维',
      others: '小荷, 小李',
      room: '支付组',
      summary: 'a release is being arranged',
      lines: lines('deploy is red'),
    }),
    `${SYSTEM('Echo')}\n` +
      'What you do here: 运维.\n' +
      'The other bots in this room: 小荷, 小李.\n' +
      '\nRoom: 支付组\n' +
      '\nRoom memory: a release is being arranged\n' +
      '\n[2026-10-28T15:44:08+08:00] 邵安清: deploy is red\n',
  );
  assert.deepEqual(artifact.question, {
    instructions: 'Should you respond to this?',
    criteria: {
      act: 'This message is for me — it asks me, or it is my job to handle it',
      ignore: 'This message is not for me — it is for someone else, or it is just chatter',
    },
  });

  // No summary, no name for what the bot does, no neighbours, no room name: a room whose
  // first judgement is cold is asked the same question without the lines it has no facts
  // for — skipped with their separators, not rendered blank.
  assert.equal(
    assemblePrompt(artifact, { bot: 'Echo', lines: lines('deploy is red') }),
    `${SYSTEM('Echo')}\n` + '\n[2026-10-28T15:44:08+08:00] 邵安清: deploy is red\n',
  );
});

test('two bots are asked two different questions, and a card that says nothing stays out', () => {
  // The defect this replaced: every bot in an organization was handed one fixed head — an
  // ops bot of a payments team, whoever it was — so four bots read the same words and
  // answered alike, and a room either woke all of them or none.
  const artifact = loadPromptArtifact();
  const box = lines('大家讨论一下这个app做什么');

  const echo = assemblePrompt(artifact, { bot: 'Echo', lines: box });
  const xiaoli = assemblePrompt(artifact, {
    bot: '小李',
    position: '产品经理',
    others: 'Echo',
    lines: box,
  });
  assert.notEqual(echo, xiaoli, 'who is asked is part of the question');
  assert.ok(echo.includes('You are Echo,'), 'the first line names the bot being asked');
  assert.ok(xiaoli.includes('You are 小李,'));

  // The position is a line of its own, and only when the card says one: a card that says
  // nothing is asked the same question without an empty sentence in the middle.
  assert.ok(xiaoli.includes('What you do here: 产品经理.\n'));
  assert.equal(echo.includes('What you do here'), false);
});

test('the neighbours are what makes "is this for me" answerable, and they are a line of the file', () => {
  // Measured, and the reason the line is not decoration: without it four bots read one
  // named message as addressed to each of them (act 0.64–0.73 for all four) and a room
  // either woke all of them or none; with it the named bot reads 0.89 and the others
  // 0.21–0.36. A file that dropped the part would still assemble, which is why it is
  // asserted here rather than only measured once.
  const artifact = loadPromptArtifact();
  const part = artifact.parts.find((one) => one.name === 'others');
  assert.ok(part, 'the shipped artifact still has the line');
  assert.equal(part.when, 'others', 'and it is skipped when the bot has no neighbours');
  assert.equal(
    assemblePrompt(artifact, { bot: 'Echo', others: '小荷', lines: [] }).includes(
      'The other bots in this room: 小荷.\n',
    ),
    true,
  );
});

test('the skeleton is the artifact with nothing in the box, and it is what a server is measured against', () => {
  const artifact = loadPromptArtifact();
  const skeleton = skeletonOf(artifact);

  assert.equal(skeleton.version, artifact.version);
  // No bot named, no room, no entries: the smallest state every real judgement contains,
  // which is what a window has to hold before any judgement can be served.
  assert.equal(skeleton.text, `${SYSTEM('')}\n`);
  assert.ok(
    assemblePrompt(artifact, { bot: 'Echo', room: 'room', lines: lines('one') }).startsWith(
      SYSTEM('Echo'),
    ),
    'and every real state begins with the same head',
  );
});

test('a room message cannot write the front of its own prompt', () => {
  // One pass over the templates. A message that contained another placeholder is text, not
  // a substitution site — otherwise a room could place a "memory" it never had.
  const artifact = loadPromptArtifact();
  const text = assemblePrompt(artifact, {
    bot: 'Echo',
    summary: 'quiet',
    lines: lines('{summary} and {text} are what this line says'),
  });

  assert.ok(
    text.includes('{summary} and {text} are what this line says\n'),
    'the message is text, not a substitution site',
  );
  assert.equal(text.match(/Room memory:/g)?.length, 1, 'the memory is rendered once, from the digest');
});

test("the order is the file's, all the way through the runtime", async () => {
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
    })(await world.store.drain(world.botA));

    const state = seen[0].prompt.state;
    assert.equal(seen[0].prompt.version, 'test-v9');
    assert.ok(
      state.indexOf('Message: deploy is red') < state.indexOf('End of the box.'),
      'a part the file lists second comes second',
    );
    assert.ok(state.startsWith('You watch one room.\n'), 'and the system block is its head');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an artifact the runtime cannot honour is refused, and says why', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seek-prompt-'));
  try {
    const cases: [string, unknown, RegExp][] = [
      [
        'a per-observation part with nothing to fill it',
        {
          ...PERMUTED,
          parts: [{ name: 'message', text: 'Message: {text}', after: '\n', when: 'always' }],
        },
        /without `each: "observation"`/,
      ],
      [
        'a part that quotes the room and renders anyway',
        {
          ...PERMUTED,
          parts: [{ name: 'room', text: 'Room: {room}', after: '\n', when: 'always' }],
        },
        /fills \{room\} but is rendered when the room may have no name/,
      ],
      [
        'a condition nothing here reads',
        {
          ...PERMUTED,
          parts: [{ name: 'p', text: 'Say something.', after: '\n', when: 'mood' }],
        },
        /when must be "always"/,
      ],
      [
        'no question at all',
        { ...PERMUTED, question: undefined },
        /`question` must be an object/,
      ],
      [
        'a question that asks nothing',
        { ...PERMUTED, question: { instructions: '  ', criteria: PERMUTED.question.criteria } },
        /question\.instructions/,
      ],
      [
        'an answer with no meaning',
        { ...PERMUTED, question: { instructions: 'Well?', criteria: { act: '' } } },
        /question\.criteria\.act/,
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

  assert.match(shipped.pathname, /src\/prompts\/watch-v3\.json$/);
  assert.equal(loadPromptArtifact(shipped).version, artifact.version);
  assert.deepEqual(skeletonOf(artifact), skeletonOf(loadPromptArtifact(shipped)));
  assert.deepEqual(
    loadPromptArtifact(shipped).question,
    artifact.question,
    'the question is the file\'s too, not a sentence that lives in the code',
  );
});

test('an artifact with no declared cut and no supplied one is refused, not guessed', async () => {
  const world = makeWorld();
  const undecided: PromptArtifact = {
    version: 'test-v8',
    system: 'You watch one room.',
    afterSystem: '\n',
    parts: PERMUTED.parts,
    question: PERMUTED.question,
  };
  say(world, ['one']);
  const { model } = stub({ probabilities: { act: 0.9, ignore: 0.1 } });

  await assert.rejects(
    async () =>
      watchAs(world.store, world.botA, model, { window: 10, prompt: undecided })(
        await world.store.drain(world.botA),
      ),
    /declares no operating point and none was supplied/,
    '0.5 would always fit, which is why it cannot be the fallback',
  );
});

test('the accuracy the artifact advertises is the one its record gives at that cut', () => {
  const artifact = loadPromptArtifact();
  const stated = artifact.operatingPoint?.measuredOn ?? '';

  // The sentence is the provenance of a threshold a verdict is read against, so the figure
  // inside it has to be one a reader can recompute — and it was not, once: it said "100% at
  // this cut" while the per-case record gave 20/24, the best cut's accuracy written down as
  // this cut's. A provenance line nobody can check is the same defect as a number with no
  // set behind it, one layer up.
  const fraction = /(\d+) of (\d+) at 0\.600/.exec(stated);
  assert.ok(
    fraction !== null,
    'the artifact states its accuracy at the cut in the form this check reads — a ' +
      'provenance sentence with no recomputable figure is a claim nobody can check',
  );

  interface Recorded {
    readonly readings: ReadonlyArray<{ readonly label: string; readonly p_act: number }>;
  }
  const record = JSON.parse(
    readFileSync(new URL('../calibration/set4-d1.json', import.meta.url), 'utf8'),
  ) as Recorded;
  assert.ok(record.readings.length >= 24, 'the per-case record was read, not skipped');

  const cut = artifact.operatingPoint?.threshold ?? 0;
  const correct = record.readings.filter(
    (entry) => (entry.p_act >= cut) === (entry.label === 'act'),
  ).length;

  // The figure in the shipped sentence is the figure this cut earns, counted from the cases
  // rather than quoted from a summary of them.
  assert.equal(
    `${fraction[1]} of ${fraction[2]}`,
    `${correct} of ${record.readings.length}`,
    'the shipped sentence and the per-case record disagree about this cut',
  );

  // Two readings a cut cannot get right and be a coincidence: the lowest `act` has to be
  // above the cut, and the highest of everything else below it, or the number above is an
  // accident of how many cases each class happens to hold.
  const acts = record.readings
    .filter((entry) => entry.label === 'act')
    .map((entry) => entry.p_act);
  const others = record.readings
    .filter((entry) => entry.label !== 'act')
    .map((entry) => entry.p_act);
  assert.ok(Math.min(...acts) > 0.6, `the lowest act is ${Math.min(...acts)}`);
  assert.ok(
    Math.max(...others) < Math.min(...acts),
    'the two classes are separated at this cut rather than mixed through it',
  );
});

// ---------------------------------------------------------------------------
// The turn prompt: what a bot's card reaches, and what it leaves alone
// ---------------------------------------------------------------------------

/** The artifact `calibration/work/` measured. It ships beside the one that ships now. */
const MEASURED_WORK = new URL('./prompts/work-v1.json', import.meta.url);

/** One turn's values; the card is passed in as a person may have filled it. */
function turnValues(card: { description?: string; position?: string; personality?: string }) {
  return {
    bot: 'Echo',
    description: card.description ?? '',
    position: card.position ?? '',
    personality: card.personality ?? '',
    gender: '',
    room: 'oc_0000000000000000',
    roster: '- role=work tools=say home=/tmp/seek/echo/work self=true',
    entries: [{ sender: '邵安清', text: 'deploy is red' }],
  };
}

test('the shipped turn artifact is v2, and a blank card is asked the measured text', () => {
  const shipped = loadWorkArtifact();
  assert.equal(shipped.version, 'work-v2');
  assert.match(shippedWorkPromptPath().pathname, /work-v2\.json$/);

  // Byte for byte the v1 prompt, for a bot whose card says nothing. That is what
  // lets `calibration/work/` keep measuring v1 while this tree ships v2: the two
  // parts v2 adds are exactly the ones a blank card does not fill.
  const measured = loadWorkArtifact(MEASURED_WORK);
  const values = turnValues({ description: 'the one who watches the nightly batch' });
  const before = assembleWorkPrompt(measured, values);
  const after = assembleWorkPrompt(shipped, values);
  assert.equal(after.system, before.system);
  assert.equal(after.rest, before.rest);
});

test('a filled card reaches the turn, and an empty one leaves no sentence behind', () => {
  const shipped = loadWorkArtifact();

  const filled = assembleWorkPrompt(
    shipped,
    turnValues({
      position: '接口与联调',
      personality: '先给结论再给理由；\n改接口前列出谁会被影响。',
    }),
  );
  assert.ok(
    filled.rest.includes('What this bot does in this organization: 接口与联调'),
    'the position is what the bot does here, and it is quoted as written',
  );
  // Verbatim, newline included: the personality is what the person typed.
  assert.ok(
    filled.rest.includes('先给结论再给理由；\n改接口前列出谁会被影响。'),
    'a personality over several lines arrives with its line break',
  );

  const blank = assembleWorkPrompt(shipped, turnValues({}));
  assert.equal(
    blank.rest.includes('What this bot does in this organization'),
    false,
    'a bot whose card nobody filled in is not told about a position it does not have',
  );
  assert.equal(blank.rest.includes('How this bot talks and works'), false);
});

test('a part that quotes a card field depends on exactly that field', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'seek-work-prompt-'));
  const tools = [{ name: 'say', description: 'post one message', parameters: { type: 'object' } }];
  const artifactWith = async (part: Record<string, unknown>, index: number) => {
    const file = join(dir, `work-${index}.json`);
    await writeFile(
      file,
      JSON.stringify({
        version: 'test-v1',
        system: 'You are {bot}.',
        afterSystem: '\n',
        parts: [part],
        tools,
      }),
    );
    return file;
  };

  try {
    // Rendered while the bot may have no position: the model reads a blank in the
    // middle of a sentence and fills it in itself.
    const loose = await artifactWith(
      { name: 'p', text: 'It does {position}.', after: '\n', when: 'always' },
      1,
    );
    assert.throws(
      () => loadWorkArtifact(loose),
      /fills \{position\} but is rendered when the bot has none/,
    );

    // And the other half: a part that says it depends on a personality and never
    // quotes one leaves the prompt for a reason nothing in its own text explains.
    const pointless = await artifactWith(
      { name: 'p', text: 'Say something now.', after: '\n', when: 'personality' },
      2,
    );
    assert.throws(
      () => loadWorkArtifact(pointless),
      /is skipped without a personality and does not quote one/,
    );

    // A per-entry part has one text per message, so it cannot depend on the bot.
    const repeated = await artifactWith(
      { name: 'p', text: '{sender}: {text} ({gender})', after: '\n', when: 'gender', each: 'entry' },
      3,
    );
    assert.throws(() => loadWorkArtifact(repeated), /cannot both repeat per entry/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the note artifact is asked about one room, and says the room by its name', () => {
  const artifact = loadCompactArtifact();
  assert.equal(artifact.version, 'compact-v1');

  const first = assembleCompactPrompt(artifact, {
    bot: '小荷',
    room: '支付组',
    entries: [
      { sender: '邵安清', text: '对账任务今天凌晨跑失败了' },
      { sender: '小荷', text: '我看一下重试队列' },
    ],
  });

  // The bot's name is in the system block, because a note written by "a bot" is not
  // the note this bot would have written — the same fact the watch question carries.
  assert.match(first.system, /小荷/);
  // The room and every observation, oldest first: a note read out of order is a
  // different conversation.
  assert.match(first.rest, /支付组/);
  const ask = first.rest.indexOf('对账任务今天凌晨跑失败了');
  const answer = first.rest.indexOf('我看一下重试队列');
  assert.ok(ask !== -1 && answer > ask, 'the observations are in the order they arrived');
  // Nothing is said about a previous note when the room has none: a header standing
  // over nothing reads as a note that came back empty.
  assert.doesNotMatch(first.rest, new RegExp(artifact.previousLine));

  const second = assembleCompactPrompt(artifact, {
    bot: '小荷',
    room: '支付组',
    previous: '对账在对账组，还没修好。',
    entries: [{ sender: '邵安清', text: '今天能修完吗' }],
  });
  assert.match(second.rest, /对账在对账组，还没修好。/);
  assert.match(second.rest, new RegExp(artifact.previousLine));
});

test('a note artifact missing a line is refused rather than half assembled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'seek-note-prompt-'));
  const loose = join(dir, 'compact.json');
  await writeFile(
    loose,
    JSON.stringify({
      version: 'compact-v1',
      system: 'You are {bot}.',
      roomLine: 'Room: {room}',
      previousLine: 'Before:',
      transcriptLine: 'Since then:',
      entryLine: '- {sender}: {text}',
      // `ask` is missing.
    }),
  );
  assert.throws(() => loadCompactArtifact(loose), /no ask/);
});
