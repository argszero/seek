/**
 * The navigation rail: what it holds, in what order, and at what size.
 *
 * **Four rows, then two at the foot.** The column draws the avatar as *who this is*, these
 * four rows, a `flex: 1` spacer, and the theme toggle and settings past it.
 *
 * The list came from the prototype, and issue #138 deleted that copy of the window along with
 * the file that declared it; what stands behind it now is the client itself — a live Feishu
 * messenger read at a 1912×829 window on 2026-10-27, whose numbers `electron/rail.test.mjs`
 * carries in its own header — and the four destinations are the ones this product has. The
 * four, the order, the icons and the two at the foot are what that test holds `RAIL` and
 * `RAIL_TAIL` to, by reading this file, `App.jsx` and the stylesheet.
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
 * **16px, measured off the client itself** (2026-10-27), not the prototype's 22 and 20: the
 * reference draws every rail glyph at 16, 11px in from the row's left edge, with the word
 * starting 8px after it — which is why the row reads as a line of text with a mark beside it
 * rather than as an icon strip with a caption.
 */
export const NAV_ICON = 16
export const TAIL_ICON = 16

/**
 * What the add mark over the navigation offers: the three things this product can make, and
 * **nothing else**.
 *
 * The client's own menu is longer — 创建群组, 添加企业成员, 添加外部联系人, 创建文档, 加入会议
 * (measured 2026-10-27) — and the host cut it to the three this product actually has: what we
 * cannot make is not a row. Each row names the view that makes the thing, so pressing it both
 * *goes* there and opens that view's form; the icon is the glyph of the row you land on
 * (`users` for groups, `contacts` for the bots list, `settings` for the organization panel),
 * which is why no new picture was drawn for this menu.
 *
 * The client draws this panel in two groups with a line between them. These three are one kind
 * of thing — make a room, make a bot, make a world — so there is no line: a divider here would
 * be a boundary the rows do not have.
 */
export const ADD_MENU = [
  /**
   * **A room first, because it is the thing the front screen is a list of.** It has no `+` of
   * its own any more (宿主, 2026-10-27: 这里的加号和数字不需要了), and neither does any other
   * list: what this product makes is made from this one mark, and each row opens a card over
   * the window instead of a form wedged above the rows it adds to.
   */
  { view: 'chat', icon: 'message', label: 'ui.rail.add-room' },
  { view: 'groups', icon: 'users', label: 'ui.rail.add-group' },
  { view: 'contacts', icon: 'contacts', label: 'ui.rail.add-bot' },
  /**
   * **The one row that does not move the window.** The other two name the view that makes the
   * thing, so pressing them goes there and opens that view's form. An organization used to be
   * made that way too — the row switched to the settings page and opened a field at the foot of
   * its organization list — and the host cut that on 2026-10-27: 创建组织，不要跳转到 settings，
   * 和创建机器人一样，在当前窗口实现就行. Making a world is not a reason to leave the room you are
   * reading, so this row carries no `view`: it opens a form over whatever is on screen.
   */
  { makes: 'organization', icon: 'settings', label: 'ui.rail.add-organization' },
]

/** What the add mark itself says, for the hover title. */
export const ADD_TITLE = 'ui.rail.add'

/**
 * The two words the theme toggle wears, and they name the action rather than the state: a
 * button that said 深色 while the window was dark would be a label for the state it is
 * leaving. So the key is chosen by what the window is about to become, not by what it is.
 */
export const THEME_TO_DARK = 'ui.rail.theme-dark'
export const THEME_TO_LIGHT = 'ui.rail.theme-light'
