'use strict'

/**
 * The first law, which is the one rule this product puts above every instruction.
 *
 * **The words are the prototype's** (`prototype/src/js/model.js`, `FIRST_LAW`), and the
 * prototype is spec: the host ruled that what is in it is what gets fully implemented
 * (2026-10-26T19:45). The rule itself he stated in his own words — 第一准则 人大于机器人
 * (2026-10-26T20:12) — and the prototype's sentence is how that was already written down.
 *
 * It is kept here, in the app rather than in a component, because three screens quote it: the
 * form that adds a bot, the bot's own card, and the organization's. Three copies of a
 * sentence is three places to drift, and this one is not a label — it is the rule that says a
 * bot never walks over a person and never decides for one.
 *
 * It is drawn as it stands and is not translated. That is not an oversight about the
 * catalogue (`docs/design/i18n.md` §1): the sentence is a quotation of the rule the project
 * is built on, the way a licence's own words are quoted rather than localised.
 */
const FIRST_LAW = '人大于机器人：机器人不得越过人，也不得替人做决定。'

module.exports = { FIRST_LAW }
