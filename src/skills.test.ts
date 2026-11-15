/**
 * A bot's skills are directories on the disk, and this file is what that means here.
 *
 * The format is not this repository's: `agentskills.io` says a skill is a directory under
 * the agent's home holding a `SKILL.md`, and that the front matter's two required facts are
 * `name` and `description`. So nothing about what a skill *is* can be tested as a decision
 * of ours — what is tested here are the two things that are: which directories the scan
 * counts as skills, and the single line the turn is told about one.
 *
 * The checks worth having are the three a reader would otherwise take on trust, because
 * each of them fails silently — the prompt still assembles, the turn still runs, and the bot
 * is simply told less than somebody filed: a directory holding no `SKILL.md` is not a skill,
 * a skill with no description is not offered (nothing could choose it), and a home with
 * nothing filed produces no section at all rather than a heading with no lines under it.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { scanSkills, skillLinesOf } from './skills.ts';

/**
 * A home of this test's own, holding exactly the files it is given, by name.
 *
 * A temporary directory rather than the fixture's `/tmp/seek/a/work`: skills are files, two
 * runs of this file would share them, and a test that reads another test's leftovers passes
 * for the wrong reason.
 */
function homeWith(files: Record<string, string>): string {
  const home = mkdtempSync(join(tmpdir(), 'seek-skills-'));
  for (const [name, text] of Object.entries(files)) {
    const file = join(home, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text, 'utf8');
  }
  return home;
}

test('a directory with a SKILL.md in it is a skill, and nothing else is', () => {
  const home = homeWith({
    'skills/pdf-tools/SKILL.md':
      '---\nname: pdf-tools\ndescription: Cuts and merges PDFs. Use it when a file is a PDF.\n---\n\n# PDF tools\n',
    // A directory a skill is allowed to carry, with no SKILL.md of its own.
    'skills/pdf-tools/references/spec.txt': 'a page the skill points at\n',
    // Three things filed beside it that are not skills, and each for its own reason.
    'skills/notes/README.md': 'a directory with no SKILL.md in it\n',
    'skills/.cache/SKILL.md': '---\ndescription: this machine, not this bot\n---\n',
    'notes.md': 'a file at the top of the home is not a directory at all\n',
  });
  try {
    assert.deepEqual(scanSkills(home).skills, [
      {
        name: 'pdf-tools',
        description: 'Cuts and merges PDFs. Use it when a file is a PDF.',
        file: 'skills/pdf-tools/SKILL.md',
      },
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a skill with no description is not offered, because nothing could choose it', () => {
  const home = homeWith({
    // Four ways to have no description, and one skill that has one.
    'skills/blank/SKILL.md': '---\nname: blank\ndescription: ""\n---\n',
    'skills/silent/SKILL.md': '---\nname: silent\n---\n',
    'skills/heading/SKILL.md': '# a skill file with no front matter at all\n',
    'skills/unclosed/SKILL.md': '---\nname: unclosed\ndescription: the block never closes\n',
    'skills/real/SKILL.md': '---\nname: real\ndescription: Does one thing. Use it when that thing happens.\n---\n',
  });
  try {
    assert.deepEqual(
      scanSkills(home).skills.map((skill) => skill.name),
      ['real'],
      'the description is what a bot chooses by, so a skill without one cannot be chosen',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the description is read off the front matter the way a SKILL.md writes one', () => {
  const home = homeWith({
    'skills/folded/SKILL.md': '---\nname: folded\ndescription: >\n  Folds\n  into one line.\n---\n',
    'skills/literal/SKILL.md': '---\nname: literal\ndescription: |\n  Keeps\n  its words.\n---\n',
    'skills/quoted/SKILL.md':
      '---\nname: quoted\ndescription: "Wrap it in quotes and it still reads"\n---\n',
    'skills/loose/SKILL.md': '---\nname: loose\ndescription: nothing around this one\n---\n',
  });
  try {
    // One line each, because a description is one line of a prompt: a block scalar is
    // folded rather than pasted with its indentation, which would be a prompt whose
    // sentence has line breaks in the middle of it.
    assert.deepEqual(
      scanSkills(home).skills.map((skill) => skill.description),
      ['Folds into one line.', 'Keeps its words.', 'nothing around this one', 'Wrap it in quotes and it still reads'],
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('each skill is one line naming what it is, what it does, and the file to open', () => {
  const home = homeWith({
    'skills/deploy/SKILL.md':
      '---\ndescription: Ships a build and checks it came up. Use it when a release is cut.\n---\n',
    'skills/pdf-tools/SKILL.md':
      '---\ndescription: Cuts and merges PDFs. Use it when a file is a PDF.\n---\n',
  });
  try {
    assert.equal(
      skillLinesOf(scanSkills(home)),
      '- name=deploy description=Ships a build and checks it came up. Use it when a ' +
        'release is cut. file=skills/deploy/SKILL.md\n' +
        '- name=pdf-tools description=Cuts and merges PDFs. Use it when a file is a PDF. ' +
        'file=skills/pdf-tools/SKILL.md',
      'name, description and the file, once each, in the order the artifact lists them',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a bot nobody filed a skill for has no section at all', () => {
  // A home with things in it and no `skills/` under it — which is every bot made by this
  // version — and a bot with no directory on this machine, which is the same answer.
  const bare = homeWith({ 'notes.md': 'a note the bot wrote itself\n' });
  try {
    assert.deepEqual(scanSkills(bare), { skills: [] });
    assert.equal(
      skillLinesOf(scanSkills(bare)),
      undefined,
      'a heading with no lines under it reads as a bot with skills whose names did not ' +
        'arrive, so the part leaves the prompt instead',
    );
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
  assert.deepEqual(scanSkills(''), { skills: [] });
});
