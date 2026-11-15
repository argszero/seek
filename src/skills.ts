/**
 * A bot's skills: the directories filed under its own home, and what each one says it is.
 *
 * **A skill is a directory with a `SKILL.md` in it, and nothing else is one.** That is the
 * whole of the on-disk convention (`agentskills.io/specification`): `<home>/skills/<name>/`
 * holds the file, optionally beside `scripts/`, `references/` and `assets/`, and the two
 * facts the file's front matter has to carry are `name` and `description`. The description
 * is what a bot chooses by — it has to say what the skill does **and** when to use it,
 * because nothing else does the choosing: there is no keyword match on this side, and no
 * code here decides that a skill is relevant to a turn.
 *
 * **Why the scan and not a stored row.** `docs/design/data-model.md` rule 17 gives an
 * agent one home directory holding its persona, its skills and its memory, and
 * `agent-lifecycle.md` says the same. A row in the store would be a second copy of what
 * the directory already says — the defect rule 17 exists to forbid — so skills are read
 * off the disk when a turn is assembled, and filing one is filing a file.
 *
 * **The scan is tolerant in exactly two places, and skipping is the only other answer.**
 * A `name` that disagrees with its directory, or a description past the standard's 1024
 * characters, still loads: the skill is there and its file is right, so refusing it would
 * take a working instruction away over a naming detail. A missing or empty `description`,
 * or front matter this reader cannot parse at all, drops the skill — a skill with no
 * description is one no bot could ever choose, and offering it would be a name with
 * nothing behind it.
 *
 * **What is wrong with a directory that is not a skill is not reported here, and that is
 * deliberate rather than forgotten.** Nothing in `src/` prints — the kernel returns facts
 * and the layer that has a person in front of it decides what to say — so a `problems`
 * array here would be a field with no reader. A skill the scan drops is a skill the bot
 * is not told about, which is the standard's own answer; a channel that tells a person
 * which directory was dropped is a contribution of its own, and it belongs with the one
 * that puts skills on the disk in the first place.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Where under an agent's home its skills live. */
export const SKILLS_DIR = 'skills';

/** The file a skill directory has to hold to be a skill. */
export const SKILL_FILE = 'SKILL.md';

/** One skill, as the turn is told about it. */
export interface Skill {
  /**
   * The skill's name, which is also its directory's: `pdf-tools`.
   *
   * The directory is what `read` opens, so when the front matter disagrees with it the
   * directory wins and the skill still loads — a name is a label, and the file is the
   * thing. The front matter's `name` is held to the standard's characters
   * (`[a-z0-9-]`, no leading or trailing `-`, no `--`) by the standard, not by this
   * reader: a skill that has one wrong is still a skill.
   */
  name: string;
  /** What it does and when to use it, on one line: the only thing a bot chooses by. */
  description: string;
  /**
   * Where its own file sits, **relative to the agent's home**: `skills/pdf-tools/SKILL.md`.
   *
   * Relative because that is the only name `read` takes: every file call is bounded by
   * the home (`work-server.ts`, `outsideOf`), so an absolute path would be a name the
   * turn is told and then refused for giving back.
   */
  file: string;
}

/** What the scan returns: every skill it could load, and nothing about the ones it could not. */
export interface SkillScan {
  readonly skills: Skill[];
}

/** The facts of one skill as one line of the turn's prompt: what it is, and where it lives. */
export function skillLinesOf(scan: SkillScan): string | undefined {
  if (scan.skills.length === 0) return undefined;
  return scan.skills
    .map((skill) => `- name=${skill.name} description=${skill.description} file=${skill.file}`)
    .join('\n');
}

/**
 * Every skill filed under one agent's home, by name.
 *
 * `home` of `''` scans nothing: an agent with no directory on this machine has no skills,
 * which is the same answer an empty one gives. A home with no `skills/` under it is not an
 * error either — it is a bot nobody has filed a skill for, which is every bot today.
 */
export function scanSkills(home: string): SkillScan {
  if (home === '') return { skills: [] };

  let rows;
  try {
    rows = readdirSync(join(home, SKILLS_DIR), { withFileTypes: true });
  } catch {
    return { skills: [] };
  }

  const skills: Skill[] = [];
  for (const row of rows) {
    // `node_modules` and a dot directory are not somebody's skill: one is a dependency
    // tree that got filed here by mistake, and the other is this machine's own
    // bookkeeping. Neither is a name a bot should be offered.
    if (!row.isDirectory() || row.name.startsWith('.') || row.name === 'node_modules') continue;

    const file = `${SKILLS_DIR}/${row.name}/${SKILL_FILE}`;
    let text: string;
    try {
      text = readFileSync(join(home, SKILLS_DIR, row.name, SKILL_FILE), 'utf8');
    } catch {
      // A directory with no `SKILL.md` is not a skill. `assets/`, `scripts/` and
      // `references/` are the ones a skill carries, and none of them carries one of these.
      continue;
    }

    const description = descriptionOf(text);
    if (description === undefined) continue;
    skills.push({ name: row.name, description, file });
  }

  skills.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return { skills };
}

/**
 * The `description` of one `SKILL.md`, or `undefined` when the file cannot offer one.
 *
 * **Two ways to have none, and both mean the same thing.** A file with no front matter, or
 * with front matter this reader does not understand, has nothing to say about itself; so
 * does one whose `description` is empty or absent. Neither is a skill a bot could choose,
 * so both are `undefined` and the caller drops the skill.
 *
 * **This is not a YAML parser and does not pretend to be one.** It reads the front matter
 * block for one key, and the shapes it understands are the ones a `SKILL.md` is written in:
 * `description: something`, a quoted value, and a `>` or `|` block whose indented lines it
 * joins. A line it cannot read makes the whole block unreadable rather than being skipped,
 * because half a description is worse than none — a bot told `use this when` and not the
 * rest of the sentence chooses on a fragment. A YAML library would be the other answer, and
 * this kernel takes no dependency at all (`CONTRIBUTING.md`, `dependencies.test.ts`).
 */
function descriptionOf(text: string): string | undefined {
  const lines = text.split('\n');
  if (lines[0]?.replace(/\r$/, '').trim() !== '---') return undefined;

  const front: string[] = [];
  let closed = false;
  for (const line of lines.slice(1)) {
    if (line.replace(/\r$/, '').trim() === '---') {
      closed = true;
      break;
    }
    front.push(line);
  }
  if (!closed) return undefined;

  let found: string | undefined;
  for (let index = 0; index < front.length; index += 1) {
    const line = front[index];
    if (line.trim() === '' || /^\s/.test(line)) continue;
    const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (pair === null) return undefined;
    const [, key, rest] = pair;

    let value: string;
    if (rest === '>' || rest === '|' || /^[>|][+-]?$/.test(rest)) {
      // A block scalar: everything indented under it belongs to the value, and a `>`
      // folds its lines into one while `|` keeps them. Both end up one line here,
      // because a description is one line of a prompt.
      const block: string[] = [];
      while (index + 1 < front.length && (/^\s/.test(front[index + 1]) || front[index + 1].trim() === '')) {
        block.push(front[index + 1].trim());
        index += 1;
      }
      value = block.join(rest.startsWith('|') ? ' ' : ' ');
    } else {
      value = unquoted(rest);
    }
    if (key === 'description') found = value;
  }

  const description = (found ?? '').replace(/\s+/g, ' ').trim();
  return description === '' ? undefined : description;
}

/** A front-matter value without the quotes it may be wrapped in. */
function unquoted(value: string): string {
  const trimmed = value.trim();
  const quoted = /^(['"])([\s\S]*)\1$/.exec(trimmed);
  return quoted === null ? trimmed : quoted[2];
}
