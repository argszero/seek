/**
 * Bots: the one write that adds a worker to a world.
 *
 * **A bot is not an agent, and this file creates no agent.** The roster
 * (`src/roster.ts`) is where agents come from, read from `agents.yml` beside the
 * store on every open, and a bot written here is a bot that has no workers until a
 * row names it — exactly the state a first run's seed leaves behind before the
 * roster is read (`src/main.ts`, `seedOneRoom`). The interface adds the rows, in
 * its own file, because the rows are a file that a person edits afterwards.
 *
 * **What it asks for is what the host named.** A bot's card is four things —
 * 姓名／性别／职位／性格 (`docs/host-rulings.md`, and the host's words of
 * 2026-10-26T20:18) — and this function takes them and writes them. Nothing here
 * picks a gender from a list, invents a position, or summarises a personality into
 * a sentence: a card is content, and content is what the caller wrote.
 *
 * **One thing is refused, and it is the only one that cannot be stored.** A bot
 * with no name would be a row in a member list that draws as the bot's own id —
 * `snapshotOf` already falls back to the id for a person with no name — and a
 * person who has just typed nothing has not asked for that. The three card fields
 * are all optional and none is refused, because "not said yet" is a state the
 * window draws (`null`, not missing) rather than a gap to fill in.
 */

import { newId } from './store.ts';
import type { SeekStore } from './store.ts';
import type { Bot } from './types.ts';

export interface CreateBotInput {
  /** Trimmed before it is stored; whitespace alone is no name. */
  name: string;
  /**
   * One of the short list the window offers — 女 / 男 / 其他 — stored as written.
   * `''` is allowed and means "declined to say", which is why the window's own
   * `未选` is not turned into a `null` here.
   */
  gender?: string;
  /** What the bot does in this organization. Short by nature; not a paragraph. */
  position?: string;
  /** How it talks and works. The host's own words, kept whole, newlines included. */
  personality?: string;
  /** Free text a bot may carry besides its card; the seed writes one. */
  description?: string;
}

/** A bot as it was written, so a caller can say which one it just made. */
export interface CreatedBot {
  bot: Bot;
}

/**
 * Write one bot.
 *
 * Synchronous for the same reason `createRoom()` is: the caller persists once,
 * with `await store.save()`, and a half-written bot is not a state anything else
 * has to handle.
 */
export function createBot(store: SeekStore, input: CreateBotInput): CreatedBot {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (name === '') {
    throw new Error(
      'a bot with no name: it would be drawn under its own id in every member list, ' +
        'and a row nobody can read is not a bot somebody asked for',
    );
  }

  const bot: Bot = { id: newId('ou'), name };
  // The three card fields, each written only when the caller said something — an
  // absent field and an empty one mean the same thing to the window (`null` either
  // way, `snapshot.js`), so a field nobody filled in is left out of the stored bot
  // rather than written as a blank that looks like an answer.
  const gender = textOf(input.gender);
  const position = textOf(input.position);
  const personality = textOf(input.personality);
  const description = textOf(input.description);
  // `gender === ''` is deliberately kept: the window offers `未选`, and a person who
  // chose it has answered a question with "I am not saying", which is not the same
  // as not being asked.
  if (input?.gender !== undefined) bot.gender = gender;
  if (position !== '') bot.position = position;
  if (personality !== '') bot.personality = personality;
  if (description !== '') bot.description = description;

  store.data.bots[bot.id] = bot;
  return { bot };
}

/** A stored field's text: trimmed, and `''` for anything that is not a string. */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
