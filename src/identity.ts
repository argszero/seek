/**
 * Whose agent this is: the identity a bot pushes down to the agent its loop
 * calls.
 *
 * `docs/design/agent-lifecycle.md` §2, "An agent is told whose it is": every
 * agent's system prompt carries the bot it belongs to — its name, its avatar and
 * the card a person fills in when adding it (what it is, what it does here, how it
 * talks) — and the roster of that bot, each row including itself, with its
 * `role`, what it does and its home directory. The next sentence is the whole
 * reason this module has the shape it has: **"It is pushed, not stored: the
 * agent holds no copy of the bot's identity or of its siblings, so a rename or a
 * new row reaches every agent of that bot at once."** The design states
 * the same rule from the other side — one copy of the name, avatar and card lives
 * on the bot.
 *
 * So nothing here is cached and nothing here is written. `identityFor` reads the
 * store and returns fresh fields, and `turn.ts` calls it once per turn rather
 * than once per loop: a bot renamed between two turns of one session is seen
 * renamed by the second turn, which is the property the ruling asks for and the
 * one a copy taken at construction time would quietly lose.
 *
 * **Fields, not prose.** The design says what an agent is told and never what
 * the sentence looks like, and this module does not invent one: a prompt is a
 * versioned artifact rather than a string built at the call site (checklist line
 * 27, and `prompts.ts` says why — rewording alone moved one model's
 * discrimination from 0.09 to 0.77 and inverted it between Chinese and English).
 * What the runtime owes a prompt is the facts, so they are handed over as
 * fields. The design records that reading, with the word
 * that would change it.
 *
 * **"What it does" is the row's role and tools.** The roster carries no
 * per-agent prose: `roster.ts` refuses any field outside its documented subset,
 * so the only statement a row makes about what an agent does is its `role` and
 * the tools it may call. Both are handed over, and any prose on top of them
 * belongs to the prompt artifact.
 */

import type { SeekStore } from './store.ts';
import type { Id } from './types.ts';

/**
 * The bot, as its agents are told about it. One copy of this lives on the bot.
 *
 * Under `name` are the fields a person fills in when adding a bot (`types.ts`,
 * `Bot`): `gender`, `position` — what it does in this organization — and
 * `personality`, how it talks and works. `description` is the free text a bot was
 * written with before there was a card, and it is still carried: a bot made that way
 * has one.
 *
 * Each is absent rather than blank when nobody filled it in, and that is the same
 * fact either way to the window (`snapshot.js` reads both as `null`). What a turn is
 * told is the prompt artifact's decision, not this module's: the identity hands over
 * facts and `prompts.ts` decides which of them a sentence quotes.
 */
export interface BotIdentity {
  id: Id;
  name: string;
  avatar?: string;
  description?: string;
  gender?: string;
  position?: string;
  personality?: string;
}

/** One row of that bot's roster, as any of its agents sees it — itself included. */
export interface SiblingAgent {
  agentId: Id;
  /** `watch`, `work`, and whatever comes later. A role, never a name. */
  role: string;
  /** What it may do: the tools its roster row allows it to call. */
  tools: string[];
  /** The directory its sessions open in. */
  home: string;
  /** True for the agent being told — exactly one row, always. */
  self: boolean;
}

/** Everything one turn is told about whose it is. */
export interface AgentIdentity {
  bot: BotIdentity;
  /**
   * Every agent of this bot, itself included.
   *
   * A bot is not capped at two rows (`host-rulings.md`), so nothing here assumes
   * a count: the list is whatever the store holds for this bot, however many
   * that is.
   */
  roster: SiblingAgent[];
}

/**
 * Read the identity one agent is told at run time.
 *
 * Fails loudly rather than returning a partial answer: an unknown bot, an
 * unknown agent, and an agent that belongs to a different bot are all errors.
 * The last one is the failure worth naming — the identity is the bot's, and
 * handing one bot's identity to another bot's agent is exactly the mixing that
 * `data-model.md` rule 13 forbids.
 */
export function identityFor(
  store: SeekStore,
  botId: Id,
  agentId: Id,
): AgentIdentity {
  const bot = store.data.bots[botId];
  if (!bot) throw new Error(`unknown bot: ${botId}`);
  const agent = store.data.agents[agentId];
  if (!agent) throw new Error(`unknown agent: ${agentId}`);
  if (agent.bot_id !== botId) {
    throw new Error(
      `agent ${agentId} is not ${botId}'s: an identity is its own bot's, never another's`,
    );
  }

  return {
    bot: {
      id: bot.id,
      name: bot.name,
      avatar: bot.avatar,
      description: bot.description,
      gender: bot.gender,
      position: bot.position,
      personality: bot.personality,
    },
    // Copies, not the store's own objects: an agent is told whose it is, and a
    // caller that rewrote what it was told must not be rewriting the bot or a
    // sibling's tools through the answer. `tools` is copied for the same reason,
    // and `home` is a plain string.
    roster: store.agentsOf(botId).map((own) => ({
      agentId: own.id,
      role: own.role,
      tools: [...own.tools],
      home: own.home,
      self: own.id === agentId,
    })),
  };
}
