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
  // The add mark over the rail's navigation: a ring with a plus through it. This one is the
  // client's own `MoreAddOutlined` path, transcribed out of its DOM on 2026-10-27 rather than
  // redrawn — and it is the only glyph here that is **filled**: the ring and the arms are one
  // shape, so `fill="currentColor"` on the path overrides the frame's `fill="none"` below,
  // and `stroke="none"` keeps the 1.6px frame from outlining it a second time.
  add: [
    <path
      d="M11 11V8a1 1 0 1 1 2 0v3h3a1 1 0 1 1 0 2h-3v3a1 1 0 1 1-2 0v-3H8a1 1 0 1 1 0-2h3Zm1 10a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0 2C5.925 23 1 18.075 1 12S5.925 1 12 1s11 4.925 11 11-4.925 11-11 11Z"
      fill="currentColor"
      stroke="none"
    />,
  ],
  /**
   * The composer's three marks, transcribed out of the client's own toolbar on 2026-10-27 at
   * 18px: the `@` it draws for a mention, the framed mountains it draws for a picture, and the
   * solid arrow it sends with. Each is one `path`, filled for the same reason `add` is — these
   * are the client's filled glyphs, not strokes this file invented, and an outline redrawn
   * beside a filled original is a different picture.
   *
   * The arrow is the client's send button to the pixel (`21.696 13.354 …`), which is why it is
   * not a paper plane of our own: before this the box had the word "Send" in it, and a word is
   * the one thing the client's composer does not put there.
   */
  mention: [
    <path
      d="M18.75 16a3.622 3.622 0 0 1-2.637-1.156A5 5 0 1 1 17 12c0 1.105.784 2 1.75 2 1.512 0 1.776-2 1.776-2 .08-.548.138-.903.138-1.568C20.664 6.997 17.164 3 12 3s-8.98 3.836-8.98 9 3.816 9.01 8.98 9.01c1.807 0 3.487-.634 4.916-1.544a.823.823 0 0 1 .853-.028l.041.024.903.519a.41.41 0 0 1 .067.682A10.953 10.953 0 0 1 12 23C5.925 23 1 18.075 1 12S5.925 1 12 1s10.657 4.265 10.657 9.432c0 .256.014.522-.136 1.794C22.296 14.326 20.75 16 18.75 16ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"
      fill="currentColor"
      stroke="none"
    />,
  ],
  picture: [
    <path
      d="m10.141 17.988-4.275-.01a.3.3 0 0 1-.212-.512l4.133-4.133a.4.4 0 0 1 .566 0l1.907 1.907 5.057-5.057a.4.4 0 0 1 .683.283V17.7a.3.3 0 0 1-.3.3h-7.476a.301.301 0 0 1-.083-.012ZM4 22c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h16c1.1 0 2 .9 2 2v16c0 1.1-.9 2-2 2H4Zm0-2h16V4H4v16ZM6 6h3v3H6V6Z"
      fill="currentColor"
      stroke="none"
    />,
  ],
  send: [
    <path
      d="M21.696 13.354a1.541 1.541 0 0 0 0-2.707L3.762.937a1.515 1.515 0 0 0-1.512.03c-.469.28-.75.774-.75 1.323l1.979 7.728 8.413 1.232c.482 0 .871.335.871.75s-.39.75-.871.75a1932.6 1932.6 0 0 1-8.41 1.223L1.5 21.71c0 .548.281 1.043.75 1.324.469.279 1.034.29 1.512.03l17.934-9.71Z"
      fill="currentColor"
      stroke="none"
    />,
  ],
  /**
   * The client's smiley, for the slot that puts an emoji into the words being written.
   *
   * **Solid rather than outlined, because the three marks beside it are.** Feishu draws this
   * one as a 1.6px outline (`tmp/feishu-toolbar.png`, read 2026-10-27), and a row of one
   * outline beside three filled shapes reads as two icon sets accidentally placed together.
   * So the same face — a round head, two eyes, a smile — is drawn here as a disc with its
   * features cut out, which is the weight `mention`, `picture` and `send` already carry at
   * 18px. The features are inside the disc and rely on `fillRule="evenodd"` to become holes;
   * the frame on the `<path>` says so per shape, the way `add` does in `rail.mjs`.
   */
  emoji: [
    <path
      fillRule="evenodd"
      d="M12 2.4a9.6 9.6 0 1 1 0 19.2 9.6 9.6 0 0 1 0-19.2Zm-3.4 6.4a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm6.8 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm-8.05 5.55a4.9 4.9 0 0 0 9.3 0 .95.95 0 0 1 1.76.7 6.75 6.75 0 0 1-12.82 0 .95.95 0 0 1 1.76-.7Z"
      fill="currentColor"
      stroke="none"
    />,
  ],
  /**
   * The client's plus-in-a-circle, for the slot that attaches a file.
   *
   * The same shape and the same reason as the smiley above: a disc with a plus cut out of it,
   * rather than Feishu's outline. It means *add something to this message*, which is what the
   * slot does — a paperclip would say the narrower thing this build happens to do, and the
   * client's own mark for the slot says the wider one.
   */
  file: [
    <path
      fillRule="evenodd"
      d="M12 2.4a9.6 9.6 0 1 1 0 19.2 9.6 9.6 0 0 1 0-19.2Zm.05 4.6a1.05 1.05 0 0 1 1.05 1.05v2.9h2.9a1.05 1.05 0 1 1 0 2.1h-2.9v2.9a1.05 1.05 0 1 1-2.1 0v-2.9h-2.9a1.05 1.05 0 1 1 0-2.1h2.9v-2.9A1.05 1.05 0 0 1 12.05 7Z"
      fill="currentColor"
      stroke="none"
    />,
  ],
}

/**
 * One icon at one size.
 *
 * `aria-hidden` because the button that holds it carries the title (`renderRail()` in the
 * prototype sets `title` on the button, not on the glyph): a screen reader announcing
 * "message" beside "Messages" says the same thing twice.
 *
 * Stroked, not filled — the prototype's `icon()` paints these with
 * `fill="none" stroke="currentColor"`, which is what `1.6` refers to. The one exception is
 * `add`, whose ring-and-plus is a single filled shape (`fill="currentColor"` on the path
 * itself, which wins over the frame's `fill="none"`). A name this file does
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
