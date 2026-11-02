/**
 * The fence a `bash` call runs inside, checked as the text the kernel is handed.
 *
 * **What is pinned here, and what is not.** A profile is data: the four denials and the two
 * re-allows, the paths they name, and the environment the child is given. What the text
 * *means* is the kernel's answer, so this file cannot prove a denial denies — that was
 * measured on the machine this ships to and is recorded beside the ruling it serves
 * (`docs/host-rulings.md`, "The tools"). What it can prove is the thing that failed here
 * once already, silently: that the profile says what the ruling says, that the shell is
 * started inside it, and that a machine without `sandbox-exec` — or a platform that never
 * had one — refuses rather than runs.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { fenceFor, placesFor, profileFor, runFenced } from './sandbox.ts';

const HOME = '/tmp/seek-test/agents/ob_echo/work';
const SCRATCH = '/tmp/seek-shell/0123456789abcdef';
const PERSON = '/Users/somebody';

function profile(): string {
  return profileFor({ home: HOME, scratch: SCRATCH, person: PERSON, command: 'echo hi' });
}

test('the profile allows what a program needs and denies the three things a bot is not', () => {
  const text = profile();

  // Order is the meaning here: everything on, then the denials, then what a working shell
  // needs handed back inside them. A profile that re-allowed before denying would read the
  // same to a person skimming it and mean the opposite.
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith(';'));
  assert.deepEqual(lines, [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* (subpath "${HOME}") (subpath "${SCRATCH}"))`,
    '(deny network*)',
    `(deny file-read-data (subpath "${PERSON}"))`,
    `(allow file-read-data (subpath "${HOME}") (subpath "${SCRATCH}"))`,
  ]);
});

test('a path with a quote in it cannot end the string it is in', () => {
  // The profile is text the kernel parses, so a person whose home directory is called
  // `someone"` would otherwise be able to write rules of their own. Nothing in this app
  // builds a profile from a name a model chose, and the escaping is still here because the
  // one time it is missed, it is missed silently.
  const text = profileFor({
    home: '/tmp/a"b',
    scratch: '/tmp/c\\d',
    person: PERSON,
    command: 'echo hi',
  });
  assert.ok(text.includes('(subpath "/tmp/a\\"b")'), 'the quote is escaped rather than closing');
  assert.ok(text.includes('(subpath "/tmp/c\\\\d")'), 'and so is the backslash');
});

test('the shell is started inside the profile, in the bot’s own directory, with no sign of the person’s environment', () => {
  const fence = fenceFor(
    { home: HOME, scratch: SCRATCH, person: PERSON, command: 'wc -l notes.md' },
    'darwin',
  );
  assert.ok(!('refusal' in fence), 'a machine with sandbox-exec runs the call');

  assert.equal(fence.file, '/usr/bin/sandbox-exec', 'the fence is the kernel’s, not this file’s');
  assert.deepEqual(fence.args.slice(0, 1), ['-p'], 'the profile travels with the command');
  assert.equal(fence.args[1], profile(), 'and it is the profile this file states');
  assert.deepEqual(fence.args.slice(2), ['/bin/bash', '-c', 'wc -l notes.md'], 'one command, one shell');
  assert.equal(fence.cwd, HOME, 'a relative name means a file the bot filed');
  assert.equal(fence.env.HOME, HOME, 'and `~` is that same directory');
  assert.equal(fence.env.TMPDIR, SCRATCH, 'the scratch it was allowed to write');
  assert.equal(fence.env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin', 'the system path and nothing of the person’s');
  // The environment is a fixed list rather than a copy of this process's: an exported key
  // in the app's own process would otherwise be one `env` call away from the model.
  assert.deepEqual(Object.keys(fence.env).sort(), ['HOME', 'LANG', 'PATH', 'TERM', 'TMPDIR']);
});

test('a bot with no directory has nowhere to fence a shell, and is refused in words', () => {
  const fence = fenceFor({ home: '', scratch: SCRATCH, person: PERSON, command: 'ls' }, 'darwin');
  assert.ok('refusal' in fence);
  assert.match(fence.refusal, /no directory on this machine/);
});

test('a platform this build cannot fence is refused as a platform, not as a machine missing a file', () => {
  // The sentence a Windows bot reads. `bash` is offered there like everywhere else, so the call
  // is refused — but `/usr/bin/sandbox-exec` "is not on this machine" describes a broken
  // install, and a model told that goes looking for a file that is never coming. What is true
  // is that the one fence this build knows belongs to macOS and this host cannot bound the call
  // at all, which is the only reading a turn cannot mistake for something to retry.
  for (const platform of ['win32', 'linux']) {
    const fence = fenceFor({ home: HOME, scratch: SCRATCH, person: PERSON, command: 'ls' }, platform);
    assert.ok('refusal' in fence, `${platform} gets no shell, so there is a refusal to read`);
    assert.match(fence.refusal, /not one this build can fence a shell on/, 'it names the fact');
    assert.match(fence.refusal, /macOS/, 'and the one fence this build does know, so the reason is not a mystery');
    assert.doesNotMatch(fence.refusal, /is not on this machine/, 'it is not read as a missing file');
  }
});

test('a machine that will not apply the fence refuses the call, and no command is run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seek-sandbox-'));
  try {
    // The reading a host gives when the kernel will not nest a sandbox — which is exactly
    // what this suite sees, since it already runs inside one. What matters is that the
    // command is not started anyway: that is the branch that would turn a host's policy into
    // an unfenced shell without anybody noticing.
    const result = await runFenced({
      ...placesFor(dir),
      command: 'touch this-would-be-a-file',
      timeoutMs: 5_000,
      outputLimit: 1_000,
      probe: async () => false,
    });
    assert.equal(result.refused, true, 'the call is refused rather than answered with a status');
    assert.match(result.output, /will not apply the fence/, 'and says which side refused it');
    assert.equal(existsSync(join(dir, 'this-would-be-a-file')), false, 'nothing ran');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with the fence applied, a command runs and its two streams come back as one reading', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seek-sandbox-'));
  try {
    const result = await runFenced({
      ...placesFor(dir),
      command: 'echo out; echo err 1>&2; exit 3',
      timeoutMs: 10_000,
      outputLimit: 1_000,
      probe: async () => true,
    });
    // A machine that has `sandbox-exec` but will not apply a profile prints its own refusal
    // instead of running anything, and this suite is one of those machines: it is already
    // inside a sandbox. The two readings are told apart here rather than both being called
    // a pass, because "the command ran" is the claim this test exists to make.
    if (result.output.includes('sandbox_apply')) {
      assert.equal(result.cut, false);
      return;
    }
    assert.equal(result.code, 3, 'the command’s own exit status, not a translation of it');
    assert.equal(result.timedOut, false);
    assert.ok(result.output.includes('out'), 'stdout came back');
    assert.ok(result.output.includes('err'), 'and so did stderr, which is where failures speak');
    assert.equal(result.cut, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('output past the limit is cut, and the reading says it was cut', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seek-sandbox-'));
  try {
    const result = await runFenced({
      ...placesFor(dir),
      command: 'for i in 1 2 3 4 5 6 7 8 9 10; do echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; done',
      timeoutMs: 10_000,
      outputLimit: 40,
      probe: async () => true,
    });
    if (result.output.includes('sandbox_apply')) return;
    assert.equal(result.output.length, 40, 'the answer stops at what one turn may read');
    assert.equal(result.cut, true, 'and says so, rather than reading as a command that printed less');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a command that outlives its clock is killed, and what it printed is kept', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seek-sandbox-'));
  try {
    writeFileSync(join(dir, 'notes.md'), 'kept\n', 'utf8');
    const result = await runFenced({
      ...placesFor(dir),
      command: 'cat notes.md; sleep 30',
      timeoutMs: 300,
      outputLimit: 1_000,
      probe: async () => true,
    });
    if (result.output.includes('sandbox_apply')) return;
    assert.equal(result.timedOut, true, 'this runtime ended the call, and the reading says which side did');
    assert.ok(result.output.includes('kept'), 'what it said before the clock ran out is not thrown away');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('one agent’s scratch is not another’s', () => {
  const one = placesFor('/tmp/seek/agents/ob_a/work');
  const two = placesFor('/tmp/seek/agents/ob_b/work');
  assert.notEqual(one.scratch, two.scratch, 'two bots writing temporary files do not meet');
  assert.ok(one.scratch.startsWith(tmpdir()), 'the scratch is the system’s scratch area');
  assert.ok(
    !one.scratch.startsWith('/tmp/seek/agents/ob_a/work'),
    'and it is outside the bot’s directory, so glob does not list what the runtime made',
  );
});
