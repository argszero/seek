/* ---------------------------------------------------------------------------
   Seek — icon set
   Line icons in the visual language of the Feishu desktop client:
   24x24 box, 1.6px stroke, round caps, currentColor.
   --------------------------------------------------------------------------- */

;(function () {
  const PATHS = {
    message:
      '<path d="M4 5.5h16a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H9.6l-4.1 2.7a.5.5 0 0 1-.8-.4V17.5H4A1.5 1.5 0 0 1 2.5 16V7A1.5 1.5 0 0 1 4 5.5Z"/>',
    contacts:
      '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.4 19.2c.5-3.1 2.8-5 5.6-5s5.1 1.9 5.6 5"/><path d="M16.6 7.2a2.6 2.6 0 1 1 0 5.2"/><path d="M17.2 14.4c1.9.4 3.2 1.9 3.5 4.2"/>',
    docs:
      '<path d="M6.5 3.5h7.6L19 8.4v11.1a1 1 0 0 1-1 1H6.5a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"/><path d="M13.8 3.7v4.9h4.9"/><path d="M8.8 12.5h6.4M8.8 16h4.6"/>',
    calendar:
      '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 9.5h17"/><path d="M8 3.5v3M16 3.5v3"/><path d="M7.5 13h2.2M7.5 16.5h2.2M14 13h2.5"/>',
    video:
      '<rect x="2.5" y="6.5" width="12.5" height="11" rx="2.2"/><path d="M15 11.2l5.2-3.1a.6.6 0 0 1 .9.5v6.8a.6.6 0 0 1-.9.5L15 12.8Z"/>',
    topic:
      '<path d="M4.5 4.8h15a1 1 0 0 1 1 1v9.2a1 1 0 0 1-1 1H12l-3.6 3v-3H4.5a1 1 0 0 1-1-1V5.8a1 1 0 0 1 1-1Z"/><path d="M7.6 8.4h8.8M7.6 11.8h5.6"/>',
    grid:
      '<rect x="3.6" y="3.6" width="7" height="7" rx="1.6"/><rect x="13.4" y="3.6" width="7" height="7" rx="1.6"/><rect x="3.6" y="13.4" width="7" height="7" rx="1.6"/><rect x="13.4" y="13.4" width="7" height="7" rx="1.6"/>',
    settings:
      '<path d="M3.6 7.2h9.2M18.4 7.2h2M3.6 16.8h3.2M12.4 16.8h8"/><circle cx="15.6" cy="7.2" r="2.2"/><circle cx="9.4" cy="16.8" r="2.2"/>',
    search:
      '<circle cx="11" cy="11" r="6.2"/><path d="M15.6 15.6l4 4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    pin:
      '<path d="M14.4 3.6l6 6-2.5.7-2.2 2.2.6 3.2-1.4 1.4-3.5-3.5-4.4 4.4-.8-.8 4.4-4.4L6.7 9l1.4-1.4 3.2.6 2.2-2.2.9-2.4Z"/>',
    mute:
      '<path d="M11 5.5 6.6 9H3.8v6h2.8L11 18.5V5.5Z"/><path d="M15.2 9.4l4.4 4.4M19.6 9.4l-4.4 4.4"/>',
    bell:
      '<path d="M12 3.6a5.6 5.6 0 0 1 5.6 5.6c0 4 1.2 5.2 1.2 5.2H5.2s1.2-1.2 1.2-5.2A5.6 5.6 0 0 1 12 3.6Z"/><path d="M10.2 18.2a2 2 0 0 0 3.6 0"/>',
    send: '<path d="M4.2 11.6 19.4 5.3a.5.5 0 0 1 .7.6l-5.4 13.5a.5.5 0 0 1-.9.1l-2.6-4.6-4.6-2.6a.5.5 0 0 1 0-.7Z"/><path d="M11.2 14.6 19.7 5.7"/>',
    emoji:
      '<circle cx="12" cy="12" r="8.4"/><path d="M8.6 14a3.8 3.8 0 0 0 6.8 0"/><circle cx="9.4" cy="9.9" r=".9" fill="currentColor" stroke="none"/><circle cx="14.6" cy="9.9" r=".9" fill="currentColor" stroke="none"/>',
    image:
      '<rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2"/><circle cx="8.6" cy="9.8" r="1.6"/><path d="M4.2 17.4 9.9 12l3.3 3.2 2.5-2.3 4 3.9"/>',
    file:
      '<path d="M7 3.6h6.6L18.6 8.6v11.8H7a1 1 0 0 1-1-1V4.6a1 1 0 0 1 1-1Z"/><path d="M13.3 3.8v5h5"/>',
    folder:
      '<path d="M3.6 7.2a1.6 1.6 0 0 1 1.6-1.6h4l1.8 2.2h8a1.6 1.6 0 0 1 1.6 1.6v8.4a1.6 1.6 0 0 1-1.6 1.6H5.2a1.6 1.6 0 0 1-1.6-1.6V7.2Z"/>',
    at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5.2a2.4 2.4 0 0 0 4.4 1.3A8.4 8.4 0 1 0 17.6 19"/>',
    reply:
      '<path d="M9.4 5.6 4.6 10.4l4.8 4.8"/><path d="M4.9 10.4h8.3a5.6 5.6 0 0 1 5.6 5.6v2.4"/>',
    more:
      '<circle cx="5.6" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="18.4" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
    moreV:
      '<circle cx="12" cy="5.6" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="18.4" r="1.5" fill="currentColor" stroke="none"/>',
    close: '<path d="M6.2 6.2l11.6 11.6M17.8 6.2 6.2 17.8"/>',
    check: '<path d="M4.8 12.6 9.5 17.3 19.2 7"/>',
    edit: '<path d="M4.4 19.6l.9-4.1L16.1 4.7a1.4 1.4 0 0 1 2 0l1.2 1.2a1.4 1.4 0 0 1 0 2L8.5 18.7l-4.1.9Z"/>',
    trash:
      '<path d="M4.8 6.8h14.4M9.6 6.8V4.6a1 1 0 0 1 1-1h2.8a1 1 0 0 1 1 1v2.2"/><path d="M6.6 6.8 7.5 19a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1l.9-12.2"/>',
    users:
      '<circle cx="9.4" cy="8.4" r="3.4"/><path d="M3.4 19.4c.5-3.3 3-5.3 6-5.3s5.5 2 6 5.3"/><path d="M16 5.4a3 3 0 0 1 0 6"/><path d="M17 14.4c2 .5 3.3 2.1 3.6 4.6"/>',
    link:
      '<path d="M10.2 13.8a3.6 3.6 0 0 1 0-5.1l2.4-2.4a3.6 3.6 0 0 1 5.1 5.1l-1.3 1.3"/><path d="M13.8 10.2a3.6 3.6 0 0 1 0 5.1l-2.4 2.4a3.6 3.6 0 0 1-5.1-5.1l1.3-1.3"/>',
    chevronRight: '<path d="M9.4 5.6 15.8 12l-6.4 6.4"/>',
    chevronDown: '<path d="M5.6 9.4 12 15.8l6.4-6.4"/>',
    chevronLeft: '<path d="M14.6 5.6 8.2 12l6.4 6.4"/>',
    sun:
      '<circle cx="12" cy="12" r="4"/><path d="M12 2.8v2.4M12 18.8v2.4M4.5 12H2.1M21.9 12h-2.4M6.7 6.7 5 5M19 19l-1.7-1.7M6.7 17.3 5 19M19 5l-1.7 1.7"/>',
    moon: '<path d="M20 14.4A8.4 8.4 0 0 1 9.6 4a8.4 8.4 0 1 0 10.4 10.4Z"/>',
    info:
      '<circle cx="12" cy="12" r="8.4"/><path d="M12 11v5.4"/><circle cx="12" cy="7.9" r=".95" fill="currentColor" stroke="none"/>',
    star:
      '<path d="m12 4.4 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4-3.9-3.8 5.4-.8L12 4.4Z"/>',
    hash: '<path d="M9.4 4 8 20M16 4l-1.4 16M4.6 9.2h15M4 14.8h15"/>',
    arrowLeft: '<path d="M19 12H5"/><path d="m11 6-6 6 6 6"/>',
    copy:
      '<rect x="8.4" y="8.4" width="11.2" height="11.2" rx="2"/><path d="M15.6 8.4V6.4a2 2 0 0 0-2-2H6.4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 2 2h2"/>',
    camera:
      '<rect x="3.4" y="6.8" width="17.2" height="12.4" rx="2.4"/><circle cx="12" cy="13" r="3.2"/><path d="M8.6 6.8 10 4.6h4l1.4 2.2"/>',
    forward:
      '<path d="M14.6 5.6l4.8 4.8-4.8 4.8"/><path d="M19.1 10.4H10.8a5.6 5.6 0 0 0-5.6 5.6v2.4"/>',
    moreH:
      '<circle cx="5.6" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="18.4" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
    logout:
      '<path d="M14.6 8.4V6a1.6 1.6 0 0 0-1.6-1.6H5.6A1.6 1.6 0 0 0 4 6v12a1.6 1.6 0 0 0 1.6 1.6H13a1.6 1.6 0 0 0 1.6-1.6v-2.4"/><path d="M19.8 12H9.4"/><path d="m16.6 8.8 3.2 3.2-3.2 3.2"/>',
    plusCircle:
      '<circle cx="12" cy="12" r="8.4"/><path d="M12 8v8M8 12h8"/>'
  }

  function icon(name, size) {
    const d = PATHS[name]
    if (!d) return ''
    const s = size || 20
    return (
      '<svg width="' +
      s +
      '" height="' +
      s +
      '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      d +
      '</svg>'
    )
  }

  window.Icon = { icon, has: (n) => !!PATHS[n], names: Object.keys(PATHS) }
})()
