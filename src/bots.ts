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

export interface RemoveBotInput {
  botId: string;
  /** An injectable clock, so a test does not depend on wall time. */
  now?: string;
}

/** A bot as it now stands, and the memberships that went with it. */
export interface RemovedBot {
  bot: Bot;
  /** The rooms it was taken out of, so a caller can say what changed. */
  rooms: string[];
}

/**
 * Take a bot out of the organization — the prototype's 移出这个组织.
 *
 * **Two writes, and the second is the one that matters.** The bot is stamped
 * `removed_at`, and every membership it held is deleted: being in a room is what
 * wakes a bot (`botsIn`), so a stamped bot still holding memberships would keep
 * answering in rooms nobody meant it to be in any more.
 *
 * **The row stays.** Deleting it would leave every message it wrote naming a
 * principal the store has never heard of — `Message.sender_id` is a reference, not a
 * snapshot, and the room would draw its own history with a blank where a name was.
 * A stamp is enough to keep it out of the lists of who may be added (`snapshot.js`
 * filters it) while history stays readable. This is the same trade `Message` makes
 * when it says what it says once: the past is not rewritten, only the present.
 *
 * **A room may not be emptied by this.** If the bot is the only member of some room,
 * removing it would leave a room nobody can speak in — the state `removeMember`
 * refuses from the leaving side — so that is refused here too, in a sentence that
 * names the room. A bot alone in a room is rare (a room the roster made for it), and
 * refusing loudly is better than a room that silently stops working.
 *
 * The roster is not touched: `agents.yml` is a person's file, and this file has
 * never written it. The bot's agents stay there and are inert — an agent with no
 * membership in a room is delivered nothing.
 */
export function removeBot(store: SeekStore, input: RemoveBotInput): RemovedBot {
  const botId = typeof input?.botId === 'string' ? input.botId : '';
  const bot = store.data.bots[botId];
  if (!bot) {
    throw new Error(`unknown bot: ${botId}`);
  }
  if (bot.removed_at !== undefined) {
    throw new Error(
      `${bot.name} was already taken out of this organization on ${bot.removed_at}: ` +
        'a second stamp would move the moment it happened',
    );
  }

  const held = Object.values(store.data.memberships).filter(
    (membership) => membership.principal_id === botId,
  );
  for (const membership of held) {
    if (store.membershipsOf(membership.room_id).length === 1) {
      throw new Error(
        `${bot.name} is the only member of ${membership.room_id}, so taking it out would ` +
          'leave a room nobody can speak in: put somebody else in that room first, or ' +
          'leave it alone',
      );
    }
  }

  const now = input.now ?? new Date().toISOString();
  bot.removed_at = now;
  for (const membership of held) {
    delete store.data.memberships[membership.id];
  }
  return { bot, rooms: held.map((membership) => membership.room_id) };
}
