/**
 * `agents.yml` — the roster, read.
 *
 * `host-rulings.md` §"Bot and agent as two objects" settles what the file *is*:
 * `agents.yml` registers **agents**, not bots, each bot is the grouping, a bot
 * may hold more than two rows and nothing caps it. What the ruling does not
 * spell out is the file's shape or when it is read, so both are recorded in
 * `docs/decisions.md` as defaults (rows 14 and 15) rather than invented here.
 *
 * **The file is the roster, and the store's `agents` shard is derived from it.**
 * The ruling gives the reason for keeping identity off the agent — *"a rename or
 * a new row reaches all of them at once"* — and a roster read only once could
 * not do that: a row added to the file would need a migration to be seen. So the
 * file is read every time a store is opened and the shard is rebuilt from it.
 * That is only safe because an agent's id is **derived from its bot and its
 * role** rather than drawn at random: a rebuilt row lands on the id it had
 * before, so the sessions, memories and turns already keyed by it are still its
 * own. See `agentIdFor`.
 *
 * **The parser is hand-written and deliberately narrow.** `CONTRIBUTING.md`
 * allows no dependency at all, so there is no YAML library to lean on, and a
 * permissive half-parser would be worse than none: a key it did not understand
 * would be dropped without a word, and the roster would quietly mean something
 * other than what it says. What is accepted is exactly the subset below, and
 * anything outside it throws with the file and the line. The subset:
 *
 * ```yaml
 * agents:                # the one top-level key
 *   - bot: Echo          # the bot's id, or its name when that is unambiguous
 *     role: watch        # required, unique per bot
 *     tools: []          # required, `[]` is a real answer
 *     model: unset       # optional
 *     prompt: unset      # optional
 *     home: /some/dir    # optional; `agents/<bot>/<role>` beside the store
 * ```
 *
 * Blank lines and whole-line `#` comments are skipped anywhere. Lists are the
 * one-line flow form (`[say, schedule]`) and nothing else. Indentation is two
 * spaces for `- ` and four for a field: tabs are a YAML error and are refused as
 * one here, because silently accepting them would make this file's meaning
 * depend on the editor that wrote it.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { SeekStore } from './store.ts';
import type { Agent, Id } from './types.ts';

/** The roster's file name, beside the store it belongs to. */
export const ROSTER_FILE = 'agents.yml';

/** Where the file sits when nothing else says: next to the store. */
export function rosterPath(storePath: string): string {
  return join(dirname(storePath), ROSTER_FILE);
}

/** One row of the roster: one agent, and the bot it works behind. */
export interface AgentRow {
  /** The bot it belongs to — its id, or its name when that names exactly one bot. */
  bot: string;
  /** Its role under that bot: `watch`, `work`, and whatever comes later. */
  role: string;
  /** Its workspace. Absent means `agents/<bot>/<role>` beside the store. */
  home?: string;
  /** Its model. Absent means `unset` — choosing one is a measurement (line 26). */
  model?: string;
  /** The persona it runs under. Absent means `unset`. */
  prompt?: string;
  /**
   * The tools it may call — the per-agent allowlist of checklist line 13.
   *
   * Required rather than defaulted: a work agent that forgot `say` could not
   * reach a room at all, and a roster that let it look configured while it was
   * mute is the one failure this field exists to make visible.
   */
  tools: string[];
}

/** The fields a row may carry, in the order they are documented. */
const FIELDS = ['bot', 'role', 'home', 'model', 'prompt', 'tools'] as const;

/** The fields a row must carry. */
const REQUIRED = ['bot', 'role', 'tools'] as const;

/**
 * Read the roster out of a file, or `undefined` when there is no file.
 *
 * `undefined` and `[]` are two different answers and the caller must keep them
 * apart: a missing roster says nothing about the store, while a roster with no
 * rows says the bot has no agents.
 */
export async function readRoster(path: string): Promise<AgentRow[] | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return undefined;
    throw error;
  }
  return parseRoster(raw, path);
}

/** Read the roster that belongs to a store, or `undefined` for an in-memory one. */
export async function readRosterFor(store: SeekStore): Promise<AgentRow[] | undefined> {
  if (!store.path) return undefined;
  return readRoster(rosterPath(store.path));
}

/**
 * An agent's id, as a function of the bot it serves and the role it fills.
 *
 * Derived rather than random, which is what lets the `agents` shard be rebuilt
 * from the roster on every open: the same row lands on the same id, so the
 * sessions, memories and turns already persisted under that id still belong to
 * it. The shape matches `newId`'s (`ag_` and sixteen hex characters) so a
 * stored id gives no hint of which way it was made.
 */
export function agentIdFor(botId: Id, role: string): Id {
  const digest = createHash('sha256').update(`${botId}\u0000${role}`).digest('hex');
  return `ag_${digest.slice(0, 16)}`;
}

/**
 * Parse the roster's text.
 *
 * Throws, with `<source>:<line>: <problem>`, on anything this subset does not
 * cover. The source is named in every error because the file is edited by hand
 * and a message that does not say where is a message that gets the wrong line
 * fixed.
 */
export function parseRoster(text: string, source = ROSTER_FILE): AgentRow[] {
  const rows: AgentRow[] = [];
  let current: { fields: Map<string, string>; line: number } | undefined;
  let sawHeader = false;

  const finish = (): void => {
    if (!current) return;
    rows.push(rowFrom(current.fields, current.line, source));
    current = undefined;
  };

  const lines = text.split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const line = index + 1;
    const fail = (problem: string): never => {
      throw new Error(`${source}:${line}: ${problem}`);
    };

    const trimmed = raw.trim();
    // A whole-line comment and a blank line say nothing and are skipped at any
    // indent. A trailing comment is deliberately *not* stripped: `#` is an
    // ordinary character in a prompt or a path, and guessing where a value ends
    // is the permissiveness this parser refuses.
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (/^[ ]*\t/.test(raw) || raw.startsWith('\t')) {
      fail('indent with spaces, not tabs');
    }

    if (!sawHeader) {
      if (raw !== 'agents:') fail(`the file must start with 'agents:' on its own line, found '${trimmed}'`);
      sawHeader = true;
      continue;
    }

    if (raw.startsWith('  - ')) {
      finish();
      current = { fields: new Map(), line };
      const rest = raw.slice(4);
      if (rest.trim() === '') fail('a row needs at least a bot and a role');
      assign(current.fields, rest, line, source);
      continue;
    }
    if (raw.startsWith('    ') && current) {
      const field = raw.slice(4);
      if (field.trimStart().startsWith('- ')) {
        fail('a list has to sit on one line — [say, schedule], or [] for none — not a block list');
      }
      assign(current.fields, field, line, source);
      continue;
    }
    fail(`expected '  - ' to open a row or four spaces to continue one, found '${trimmed}'`);
  }
  finish();

  if (!sawHeader) throw new Error(`${source}:1: the file must start with 'agents:'`);
  return rows;
}

/** Read one `key: value` into the row being built, refusing what is not a field. */
function assign(fields: Map<string, string>, content: string, line: number, source: string): void {
  const fail = (problem: string): never => {
    throw new Error(`${source}:${line}: ${problem}`);
  };
  const colon = content.indexOf(':');
  if (colon < 0) fail(`expected 'key: value', found '${content.trim()}'`);
  const key = content.slice(0, colon).trim();
  const value = content.slice(colon + 1).trim();
  if (!(FIELDS as readonly string[]).includes(key)) {
    fail(`'${key}' is not a roster field (${FIELDS.join(', ')})`);
  }
  if (fields.has(key)) fail(`'${key}' appears twice in one row`);
  fields.set(key, value);
}

/** Turn one row's fields into an `AgentRow`, or throw naming what is missing. */
function rowFrom(fields: Map<string, string>, line: number, source: string): AgentRow {
  const fail = (problem: string): never => {
    throw new Error(`${source}:${line}: ${problem}`);
  };
  for (const key of REQUIRED) {
    if (!fields.has(key)) fail(`a row needs '${key}'`);
  }
  const row: AgentRow = {
    bot: scalar(fields.get('bot') as string, fail),
    role: scalar(fields.get('role') as string, fail),
    tools: list(fields.get('tools') as string, fail),
  };
  if (row.bot === '') fail(`'bot' is empty`);
  if (row.role === '') fail(`'role' is empty`);
  for (const key of ['home', 'model', 'prompt'] as const) {
    const value = fields.get(key);
    if (value === undefined) continue;
    const read = scalar(value, fail);
    if (read === '') fail(`'${key}' is empty`);
    row[key] = read;
  }
  return row;
}

/** A single value: bare, or quoted with matching quotes. */
function scalar(value: string, fail: (problem: string) => never): string {
  if (value.startsWith('"') || value.startsWith("'")) {
    const quote = value[0];
    if (value.length < 2 || !value.endsWith(quote)) {
      fail(`unbalanced ${quote === '"' ? 'double' : 'single'} quote in '${value}'`);
    }
    return value.slice(1, -1);
  }
  return value;
}

/** The one-line flow list: `[]`, or `[a, b]`. */
function list(value: string, fail: (problem: string) => never): string[] {
  if (!value.startsWith('[') || !value.endsWith(']')) {
    fail(`'tools' takes a list on one line — [say, schedule], or [] for none — not '${value}'`);
  }
  const inner = value.slice(1, -1).trim();
  if (inner === '') return [];
  const items = inner.split(',').map((part) => scalar(part.trim(), fail));
  for (const item of items) {
    if (item === '') fail(`'tools' has an empty entry: [${inner}]`);
  }
  const repeated = items.find((item, at) => items.indexOf(item) !== at);
  if (repeated !== undefined) fail(`'tools' names '${repeated}' twice`);
  return items;
}

/**
 * Resolve a row's `bot` against the store.
 *
 * The id first, then the name: an id is what the store keys on, and a name is
 * what a person writes. A name that matches more than one bot is refused rather
 * than guessed, because the wrong bot's roster is a bot that answers in the
 * wrong voice and nothing would say so.
 */
function botFor(store: SeekStore, key: string): Id {
  if (store.data.bots[key]) return key;
  const named = Object.values(store.data.bots).filter((bot) => bot.name === key);
  if (named.length === 1) return named[0].id;
  if (named.length === 0) {
    const known = Object.values(store.data.bots)
      .map((bot) => `'${bot.name}' (${bot.id})`)
      .join(', ');
    throw new Error(
      `agents.yml: no bot is '${key}' in this store — known bots: ${known || 'none'}`,
    );
  }
  throw new Error(
    `agents.yml: '${key}' names ${named.length} bots (${named.map((bot) => bot.id).join(', ')}) — use the id`,
  );
}

/**
 * Rebuild the store's `agents` shard from the roster.
 *
 * **The whole shard, not a merge.** The roster is what the agents are, so a row
 * removed from the file is an agent that no longer exists, and a merge would
 * leave it running with no line to change. The ids it keeps are `agentIdFor`'s,
 * which is why the rebuild does not orphan anything a row still declares.
 *
 * Returns the agents it wrote, so a caller can report what the roster came to
 * without reading the shard back.
 */
export function applyRoster(
  store: SeekStore,
  rows: AgentRow[],
  where = dirname(store.path ?? '.'),
): Agent[] {
  const agents: Record<Id, Agent> = {};
  for (const row of rows) {
    const botId = botFor(store, row.bot);
    const id = agentIdFor(botId, row.role);
    if (agents[id]) {
      throw new Error(
        `agents.yml: '${row.role}' is declared twice for bot ${botId} — a role is unique per bot`,
      );
    }
    agents[id] = {
      id,
      bot_id: botId,
      role: row.role,
      home: row.home ?? join(where, 'agents', botId, row.role),
      model: row.model ?? 'unset',
      prompt: row.prompt ?? 'unset',
      tools: [...row.tools],
    };
  }
  store.data.agents = agents;
  return Object.values(agents);
}
