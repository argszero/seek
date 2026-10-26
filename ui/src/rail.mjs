/**
 * The navigation rail: what it holds, in what order, and at what size.
 *
 * **This is the prototype's list, not a list that resembles it.** `renderRail()` in
 * `prototype/src/js/app.js` declares
 *
 *     const RAIL = [
 *       { view: 'chat',     icon: 'message',  label: '消息' },
 *       { view: 'contacts', icon: 'contacts', label: '机器人' },
 *       { view: 'groups',   icon: 'users',    label: '群组' },
 *       { view: 'topics',   icon: 'topic',    label: '话题' }
 *     ]
 *
 * and then draws a theme toggle and a settings button at the foot of the column, past a
 * `flex: 1` spacer. The four, the order, the icons and the two at the foot are what
 * `electron/rail.test.mjs` holds `RAIL` and `RAIL_TAIL` to, by reading that file.
 *
 * **Why this lives in a `.mjs` rather than in `App.jsx`.** A `.jsx` file cannot be imported by
 * the suite, and a list that no test can read is a list that drifts back to whatever the
 * window happened to draw — which is exactly what it did: the rail carried a button per room
 * and no *messages* item at all, with a comment claiming it was the prototype's row. The data
 * is here so the claim can be checked without a browser.
 *
 * **The labels are catalogue keys, and the prototype's words are the test's**: every `label`
 * here resolves to the same word the prototype writes for that row — `消息` for the chat row,
 * and the three the window already carries for the rest. A rail word is a word a person
 * reads, so `docs/design/i18n.md` §1 puts it in the catalogue.
 */
export const RAIL = [
  { view: 'chat', icon: 'message', label: 'ui.rail.messages' },
  { view: 'contacts', icon: 'contacts', label: 'ui.contacts.title' },
  { view: 'groups', icon: 'users', label: 'ui.groups.title' },
  { view: 'topics', icon: 'topic', label: 'ui.topics.title' },
]

/** The foot of the column, past the spacer: settings, and the theme toggle beside it. */
export const RAIL_TAIL = { view: 'settings', icon: 'settings', label: 'ui.settings.title' }

/**
 * The two sizes `renderRail()` draws at: `icon(item.icon, 22)` for the four, `icon(…, 20)`
 * for the theme toggle and `icon('settings', 20)` for the last one.
 */
export const NAV_ICON = 22
export const TAIL_ICON = 20

/**
 * The two words the theme toggle wears, and they name the action rather than the state:
 * `renderRail()` titles the button `切换到深色` while the window is light. So the key is
 * chosen by what the window is about to become, not by what it is.
 */
export const THEME_TO_DARK = 'ui.rail.theme-dark'
export const THEME_TO_LIGHT = 'ui.rail.theme-light'
