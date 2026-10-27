/**
 * The rail's icons, and they are the prototype's own shapes rather than a set drawn here.
 *
 * `docs/host-rulings.md` §Design precedes code: the earlier build in `prototype/` is the
 * spec, and the host restated it on 2026-10-27 about this column by name — the avatar, the
 * navigation, the icons and their positions all come from there. `prototype/src/js/icons.js`
 * holds those shapes; each entry below is one `PATHS` entry from it, transcribed with the
 * same element and the same attributes.
 *
 * **Transcribed rather than approximated, because a test compares the two.** A hand-drawn
 * glyph looks close enough in a screenshot and is a different icon; `electron/rail.test.mjs`
 * reads `PATHS` out of the prototype and requires the markup here to equal it once
 * whitespace is normalised. That is why every icon is a list of elements: one entry, one
 * entry in the prototype, and the comparison has a fixed shape to walk.
 *
 * The frame is the prototype's too — a 24×24 box, 1.6px stroke, round caps, `currentColor`
 * (`icon()` at `prototype/src/js/icons.js`). Sizes are not decided here: the rail passes
 * 22px for the navigation and 20px for the two at its foot, as `renderRail()` does.
 */
const ICONS = {
  message: [
    <path
      d="M4 5.5h16a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H9.6l-4.1 2.7a.5.5 0 0 1-.8-.4V17.5H4A1.5 1.5 0 0 1 2.5 16V7A1.5 1.5 0 0 1 4 5.5Z"
    />,
  ],
  contacts: [
    <circle cx="9" cy="8.5" r="3.2" />,
    <path d="M3.4 19.2c.5-3.1 2.8-5 5.6-5s5.1 1.9 5.6 5" />,
    <path d="M16.6 7.2a2.6 2.6 0 1 1 0 5.2" />,
    <path d="M17.2 14.4c1.9.4 3.2 1.9 3.5 4.2" />,
  ],
  users: [
    <circle cx="9.4" cy="8.4" r="3.4" />,
    <path d="M3.4 19.4c.5-3.3 3-5.3 6-5.3s5.5 2 6 5.3" />,
    <path d="M16 5.4a3 3 0 0 1 0 6" />,
    <path d="M17 14.4c2 .5 3.3 2.1 3.6 4.6" />,
  ],
  topic: [
    <path d="M4.5 4.8h15a1 1 0 0 1 1 1v9.2a1 1 0 0 1-1 1H12l-3.6 3v-3H4.5a1 1 0 0 1-1-1V5.8a1 1 0 0 1 1-1Z" />,
    <path d="M7.6 8.4h8.8M7.6 11.8h5.6" />,
  ],
  sun: [
    <circle cx="12" cy="12" r="4" />,
    <path d="M12 2.8v2.4M12 18.8v2.4M4.5 12H2.1M21.9 12h-2.4M6.7 6.7 5 5M19 19l-1.7-1.7M6.7 17.3 5 19M19 5l-1.7 1.7" />,
  ],
  moon: [<path d="M20 14.4A8.4 8.4 0 0 1 9.6 4a8.4 8.4 0 1 0 10.4 10.4Z" />],
  settings: [
    <path d="M3.6 7.2h9.2M18.4 7.2h2M3.6 16.8h3.2M12.4 16.8h8" />,
    <circle cx="15.6" cy="7.2" r="2.2" />,
    <circle cx="9.4" cy="16.8" r="2.2" />,
  ],
}

/**
 * One icon at one size.
 *
 * `aria-hidden` because the button that holds it carries the title (`renderRail()` in the
 * prototype sets `title` on the button, not on the glyph): a screen reader announcing
 * "message" beside "Messages" says the same thing twice.
 *
 * Stroked, not filled — the prototype's `icon()` paints every one of these seven with
 * `fill="none" stroke="currentColor"`, which is what `1.6` refers to. A name this file does
 * not carry draws nothing rather than a box, the way `icon()` returns `''` for one it has
 * never heard of.
 */
export default function Icon({ name, size = 20 }) {
  const shapes = ICONS[name]
  if (!shapes) return null
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {shapes}
    </svg>
  )
}
