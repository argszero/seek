/* ---------------------------------------------------------------------------
   Seek — renderer

   Plain DOM, no framework. The shell re-renders on every store change; the
   composer keeps its own draft, focus and caret so typing is not broken by an
   incoming message.

   Layout follows a conventional desktop messenger:
     rail (64) | conversation list (300) | message column (flex) | side panel
   --------------------------------------------------------------------------- */

;(function () {
  const S = window.Store
  const M = window.Model
  const icon = window.Icon.icon
  const $ = (id) => document.getElementById(id)

  const ui = {
    view: 'chat', // chat | contacts | groups | topics | settings
    chatId: null,
    contactId: null,
    side: null, // null | {kind:'info'} | {kind:'topics'} | {kind:'topic', rootId}
    search: '',
    stickBottom: true,
    // 点了「回复」之后正在引用的那条消息：{chatId, messageId}。发出去就清掉。
    quote: null,
    caret: 0,
    composerFocus: false,
    // 模型那两个输入框里「已经打了字还没按保存」的内容。
    // 卡片会因为别的原因重画（点读取列表、点测试连接都会），
    // 重画时若只认已经存下来的值，人正在打的字就被抹掉——
    // 所以打进去的字先落到这里，重画时优先读它。
    modelDraft: {}
  }

  // -------------------------------------------------------------------------
  // utilities
  // -------------------------------------------------------------------------

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  function pad2(n) {
    return n < 10 ? '0' + n : '' + n
  }

  // Attachment bodies are a JSON string on the message, the same shape the
  // open-platform API uses (image_key / file_key).
  function bodyJSON(msg) {
    try {
      return JSON.parse((msg && msg.body && msg.body.content) || '{}')
    } catch (err) {
      return {}
    }
  }

  function fmtSize(bytes) {
    const n = Number(bytes) || 0
    if (n < 1024) return n + ' B'
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB'
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
    return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB'
  }

  function fileUrl(key) {
    return 'seek-file://local/' + encodeURIComponent(key)
  }

  function isImageExt(name) {
    return /\.(png|jpe?g|gif|webp|bmp|svg|heic|avif)$/i.test(String(name || ''))
  }

  const WEEK = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

  function sameDay(a, b) {
    const x = new Date(a)
    const y = new Date(b)
    return (
      x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
    )
  }

  function clockTime(ts) {
    const d = new Date(ts)
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes())
  }

  function listTime(ts) {
    if (!ts) return ''
    const now = Date.now()
    const d = new Date(ts)
    if (sameDay(ts, now)) return clockTime(ts)
    const y = new Date(now)
    y.setDate(y.getDate() - 1)
    if (sameDay(ts, y.getTime())) return '昨天'
    if (now - ts < 7 * 86400000) return WEEK[d.getDay()]
    return d.getMonth() + 1 + '月' + d.getDate() + '日'
  }

  function dayLabel(ts) {
    const now = Date.now()
    if (sameDay(ts, now)) return '今天'
    const y = new Date(now)
    y.setDate(y.getDate() - 1)
    if (sameDay(ts, y.getTime())) return '昨天'
    const d = new Date(ts)
    const thisYear = new Date(now).getFullYear() === d.getFullYear()
    return (
      (thisYear ? '' : d.getFullYear() + '年') +
      (d.getMonth() + 1) +
      '月' +
      d.getDate() +
      '日 ' +
      WEEK[d.getDay()]
    )
  }

  function avatar(o, size) {
    const cls = 'avatar ' + (size || 'md') + (o && o.isGroup ? ' group' : '')
    return (
      '<div class="' +
      cls +
      '" style="background:' +
      esc((o && o.avatar_color) || '#8f959e') +
      '">' +
      esc((o && o.avatar_text) || '?') +
      '</div>'
    )
  }

  function chatAvatar(chat, size) {
    return avatar(
      {
        avatar_color: chat.avatar_color,
        avatar_text: chat.avatar_text,
        isGroup: chat.chat_mode !== 'p2p'
      },
      size || 'lg'
    )
  }

  function personAvatar(p, size) {
    return avatar({ avatar_color: p.avatar_color, avatar_text: p.avatar_text }, size || 'lg')
  }

  function senderAvatar(sender, size) {
    return avatar(
      {
        avatar_color: sender.avatar_color,
        avatar_text: sender.avatar_text || M.initialsOf(sender.name)
      },
      size || 'md'
    )
  }

  function toast(text) {
    const root = $('toastRoot')
    if (!root) return
    const node = document.createElement('div')
    node.className = 'toast'
    node.textContent = text
    root.appendChild(node)
    setTimeout(() => {
      node.style.transition = 'opacity .2s'
      node.style.opacity = '0'
      setTimeout(() => node.remove(), 220)
    }, 1800)
  }

  function infoRow(k, v, mono) {
    return (
      '<div class="info-row"><span class="k">' +
      esc(k) +
      '</span><span class="v' +
      (mono ? ' mono' : '') +
      '">' +
      esc(v) +
      '</span></div>'
    )
  }

  // -------------------------------------------------------------------------
  // modal
  // -------------------------------------------------------------------------

  function openModal(opts) {
    closeModal()
    const root = $('modalRoot')
    root.innerHTML =
      '<div class="modal-mask" data-mask="1">' +
      '<div class="modal" role="dialog">' +
      '<div class="modal-head"><div class="modal-title">' +
      esc(opts.title || '') +
      '</div><button class="icon-btn sm" data-role="close-modal">' +
      icon('close', 16) +
      '</button></div>' +
      '<div class="modal-body">' +
      (opts.body || '') +
      '</div>' +
      '<div class="modal-foot">' +
      (opts.footer || '<button class="btn" data-role="close-modal">关闭</button>') +
      '</div></div></div>'

    const mask = root.querySelector('[data-mask]')
    mask.addEventListener('mousedown', (e) => {
      if (e.target === mask) closeModal()
    })
    if (opts.onMount) opts.onMount(root)
    const first = root.querySelector('input,textarea')
    if (first) first.focus()
  }

  function closeModal() {
    const root = $('modalRoot')
    if (root) root.innerHTML = ''
  }

  function modalValue(name) {
    const el = $('modalRoot').querySelector('[name="' + name + '"]')
    return el ? el.value : ''
  }

  // -------------------------------------------------------------------------
  // navigation rail
  // -------------------------------------------------------------------------

  const RAIL = [
    { view: 'chat', icon: 'message', label: '消息' },
    { view: 'contacts', icon: 'contacts', label: '机器人' },
    { view: 'groups', icon: 'users', label: '群组' },
    { view: 'topics', icon: 'topic', label: '话题' }
  ]

  function renderRail() {
    const me = S.selfChatter()
    const unread = S.totalUnread()
    const dark = S.state.data.theme === 'dark'

    // 左上角头像只是个「这是谁」，不是按钮：不挂 data-role，点了什么都不发生。
    // 换组织走设置页，那里列着每个组织、切换按钮和复制路径。
    let html =
      '<div class="rail-avatar">' +
      avatar(me, 'sm') +
      '<span class="presence"></span></div>'

    RAIL.forEach((item) => {
      html +=
        '<button class="rail-btn' +
        (ui.view === item.view ? ' active' : '') +
        '" data-view="' +
        item.view +
        '" title="' +
        item.label +
        '">' +
        icon(item.icon, 22) +
        (item.view === 'chat' && unread
          ? '<span class="rail-badge">' + (unread > 99 ? '99+' : unread) + '</span>'
          : '') +
        '</button>'
    })

    html += '<div class="rail-spacer"></div>'
    html +=
      '<button class="rail-btn" data-role="toggle-theme" title="' +
      (dark ? '切换到浅色' : '切换到深色') +
      '">' +
      icon(dark ? 'sun' : 'moon', 20) +
      '</button>'
    html +=
      '<button class="rail-btn' +
      (ui.view === 'settings' ? ' active' : '') +
      '" data-view="settings" title="设置">' +
      icon('settings', 20) +
      '</button>'

    $('rail').innerHTML = html
  }

  // -------------------------------------------------------------------------
  // conversation list column
  // -------------------------------------------------------------------------

  function previewText(chat) {
    const m = S.lastMessage(chat.chat_id)
    if (!m) return '暂无消息'
    const me = S.org().open_id
    if (m.msg_type === 'system') return M.bodyText(m)
    const who = m.sender.id === me ? '我' : m.sender.name
    const body = M.bodyText(m).replace(/\n/g, ' ')
    return (chat.chat_mode === 'p2p' ? '' : who + '：') + body
  }

  function chatRow(chat, height) {
    const selected = ui.chatId === chat.chat_id && ui.view === 'chat'
    const last = S.lastMessage(chat.chat_id)
    const flags = []
    if (chat.is_pinned) flags.push('<span title="置顶">' + icon('pin', 12) + '</span>')
    if (chat.is_muted) flags.push('<span title="消息免打扰">' + icon('mute', 12) + '</span>')
    let badge = ''
    if (chat.unread_count) {
      badge = chat.is_muted
        ? '<span class="badge muted"></span>'
        : '<span class="badge">' + (chat.unread_count > 99 ? '99+' : chat.unread_count) + '</span>'
    }
    return (
      '<div class="chat-item' +
      (selected ? ' selected' : '') +
      '" data-chat="' +
      chat.chat_id +
      '"' +
      (height ? ' style="height:' + height + '"' : '') +
      '>' +
      chatAvatar(chat) +
      '<div class="chat-main">' +
      '<div class="chat-line"><span class="chat-name">' +
      esc(chat.name) +
      '</span><span class="chat-time">' +
      (last ? listTime(last.create_time) : '') +
      '</span></div>' +
      '<div class="chat-line"><span class="chat-preview">' +
      esc(previewText(chat)) +
      '</span><span class="chat-flags">' +
      flags.join('') +
      badge +
      '</span></div>' +
      '</div></div>'
    )
  }

  function renderList() {
    const col = $('listCol')
    const view = ui.view

    let html =
      '<div class="list-head"><div class="search-box">' +
      icon('search', 14) +
      '<input id="searchInput" placeholder="' +
      esc(view === 'contacts' ? '搜索机器人' : view === 'groups' ? '搜索群聊' : '搜索') +
      '" value="' +
      esc(ui.search) +
      '" /></div>'

    if (view === 'chat') {
      html += '<button class="icon-btn" data-role="new-chat" title="新建会话">' + icon('plus', 18) + '</button>'
    } else if (view === 'contacts') {
      html += '<button class="icon-btn" data-role="add-friend" title="添加机器人">' + icon('plus', 18) + '</button>'
    } else if (view === 'groups') {
      html += '<button class="icon-btn" data-role="new-group" title="新建群聊">' + icon('plus', 18) + '</button>'
    }
    html += '</div><div class="list-body">'

    const q = ui.search.trim().toLowerCase()

    if (view === 'chat') {
      if (q) {
        const res = S.search(q)
        html += '<div class="list-section-title">搜索结果</div>'
        if (!res.chats.length && !res.chatters.length && !res.messages.length) {
          html += '<div class="empty" style="padding:32px 12px">没有找到「' + esc(q) + '」</div>'
        }
        res.chats.forEach((c) => (html += chatRow(c)))
        res.chatters.forEach((p) => {
          html +=
            '<div class="chat-item" data-open-p2p="' +
            p.open_id +
            '" style="height:56px">' +
            personAvatar(p, 'md') +
            '<div class="chat-main"><div class="chat-line"><span class="chat-name">' +
            esc(p.name) +
            '</span></div><div class="chat-line"><span class="chat-preview">' +
            esc(subLineOf(p)) +
            '</span></div></div></div>'
        })
        res.messages.forEach((r) => {
          html +=
            '<div class="chat-item" data-search-hit="' +
            r.chat.chat_id +
            '" data-hit-msg="' +
            r.message.message_id +
            '" style="height:56px">' +
            '<div class="chat-main"><div class="chat-line"><span class="chat-name">' +
            esc(r.chat.name) +
            '</span><span class="chat-time">' +
            listTime(r.message.create_time) +
            '</span></div><div class="chat-line"><span class="chat-preview">' +
            esc(r.message.sender.name + '：' + M.bodyText(r.message)) +
            '</span></div></div></div>'
        })
      } else {
        const list = S.sortedChats().filter((c) => !c.is_archived)
        if (!list.length) {
          html +=
            '<div class="empty"><div class="empty-title">还没有会话</div><div>点右上角 + 开始一个</div></div>'
        }
        list.forEach((c) => (html += chatRow(c)))
      }
    } else if (view === 'contacts') {
      const list = S.friends().filter((p) => !q || p.name.toLowerCase().includes(q))
      html += '<div class="list-section-title">机器人<span>' + list.length + '</span></div>'
      list.forEach((p) => {
        const sel = ui.contactId === p.open_id ? ' selected' : ''
        html +=
          '<div class="chat-item' +
          sel +
          '" data-contact="' +
          p.open_id +
          '" style="height:56px">' +
          personAvatar(p, 'md') +
          '<div class="chat-main"><div class="chat-line"><span class="chat-name">' +
          esc(p.name) +
          '<span class="chip' + (p.is_bot ? '' : ' blue') + '">' +
          (p.is_bot ? '机器人' : '人') +
          '</span>' +
          '</span></div><div class="chat-line"><span class="chat-preview">' +
          esc(p.is_bot ? botLine(p) : p.department || '人') +
          '</span></div></div></div>'
      })
      if (!list.length) html += '<div class="empty" style="padding:32px 12px">这个组织里还没有机器人</div>'
    } else if (view === 'groups') {
      const list = S.groups().filter((c) => !q || c.name.toLowerCase().includes(q))
      html += '<div class="list-section-title">我加入的群<span>' + list.length + '</span></div>'
      list.forEach((c) => (html += chatRow(c)))
      if (!list.length) html += '<div class="empty" style="padding:32px 12px">还没有群聊</div>'
    } else if (view === 'topics') {
      const rows = []
      S.chats().forEach((c) => {
        S.topics(c.chat_id).forEach((t) => rows.push({ chat: c, t: t }))
      })
      rows.sort((a, b) => b.t.last_reply.create_time - a.t.last_reply.create_time)
      html += '<div class="list-section-title">全部话题<span>' + rows.length + '</span></div>'
      rows.forEach((r) => {
        html +=
          '<div class="chat-item" data-topic="' +
          r.chat.chat_id +
          ':' +
          r.t.root.message_id +
          '" style="height:64px">' +
          chatAvatar(r.chat, 'md') +
          '<div class="chat-main"><div class="chat-line"><span class="chat-name">' +
          esc(M.bodyText(r.t.root).slice(0, 24)) +
          '</span><span class="chat-time">' +
          listTime(r.t.last_reply.create_time) +
          '</span></div><div class="chat-line"><span class="chat-preview">' +
          esc(r.chat.name + ' · ' + r.t.reply_count + ' 条回复') +
          '</span></div></div></div>'
      })
      if (!rows.length) html += '<div class="empty" style="padding:32px 12px">还没有话题</div>'
    } else if (view === 'settings') {
      html +=
        '<div class="list-section-title">设置</div>' +
        '<div class="chat-item selected" style="height:44px"><div class="chat-main">' +
        '<div class="chat-line"><span class="chat-name">组织与偏好</span></div>' +
        '<div class="chat-line"><span class="chat-preview">本地存储 · 无服务端</span></div>' +
        '</div></div>'
    }

    html += '</div>'
    col.innerHTML = html
  }

  // -------------------------------------------------------------------------
  // message rendering
  // -------------------------------------------------------------------------

  const QUICK_EMOJI = ['👍', '✅', '😄', '🎉', '👀', '❤️']

  // 悬停条左边那个白方块里画的是「上次用过的那个表情」，和飞书一致；
  // 还没用过就画 😊。飞书那张截图里它显示 👍，正是因为它记住了上次的。
  let lastReaction = '👍'
  function lastReactionEmoji() {
    return lastReaction
  }
  const EMOJI_NAME = {
    '👍': 'THUMBSUP',
    '✅': 'OK',
    '😄': 'SMILE',
    '🎉': 'PARTY',
    '👀': 'EYES',
    '❤️': 'HEART'
  }
  const NAME_EMOJI = {}
  Object.keys(EMOJI_NAME).forEach((k) => {
    NAME_EMOJI[EMOJI_NAME[k]] = k
  })

  function emojiName(glyph) {
    return EMOJI_NAME[glyph] || glyph
  }
  function emojiGlyph(name) {
    return NAME_EMOJI[name] || name
  }

  function renderMessageBody(msg) {
    if (msg.msg_type === 'image') {
      const b = bodyJSON(msg)
      const key = b.file_key || b.image_key || ''
      if (!key) return '<div class="msg-text">[图片]</div>'
      return (
        '<div class="msg-image" data-open-image="' +
        esc(key) +
        '" data-name="' +
        esc(b.file_name || '图片') +
        '" title="' +
        esc(b.file_name || '图片') +
        '"><img src="' +
        esc(fileUrl(key)) +
        '" alt="' +
        esc(b.file_name || '图片') +
        '"></div>'
      )
    }

    if (msg.msg_type === 'file') {
      const b = bodyJSON(msg)
      const key = b.file_key || ''
      if (!key) return '<div class="msg-text">[文件]</div>'
      const name = b.file_name || '文件'
      const kind = name.indexOf('.') >= 0 ? name.split('.').pop().toUpperCase().slice(0, 5) : 'FILE'
      return (
        '<div class="msg-file" data-open-file="' +
        esc(key) +
        '" title="打开文件">' +
        '<div class="msg-file-icon">' +
        icon('file', 20) +
        '</div><div class="msg-file-meta">' +
        '<div class="msg-file-name">' +
        esc(name) +
        '</div><div class="msg-file-size">' +
        esc(fmtSize(b.file_size)) +
        ' · ' +
        esc(kind) +
        '</div></div></div>'
      )
    }

    const text = M.bodyText(msg)
    if (msg.msg_type === 'sticker' || /^\p{Extended_Pictographic}+$/u.test(text.trim())) {
      return '<div class="msg-text"><span class="emoji-big">' + esc(text) + '</span></div>'
    }
    let html = esc(text)
    html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>')
    html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    html = html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>')
    html = html.replace(/@([\u4e00-\u9fa5A-Za-z0-9_]+)/g, '<span class="mention">@$1</span>')
    return '<div class="msg-text">' + html + '</div>'
  }

  function renderMessageRow(msg, prev, chat) {
    if (msg.msg_type === 'system') {
      return '<div class="sys-msg">' + esc(M.bodyText(msg)) + '</div>'
    }
    const me = S.org().open_id
    const continuation =
      !!prev &&
      prev.msg_type !== 'system' &&
      prev.sender.id === msg.sender.id &&
      !msg.root_id &&
      !prev.root_id &&
      msg.create_time - prev.create_time < 5 * 60 * 1000

    const replyCount = S.replies(chat.chat_id, msg.message_id).length

    let html =
      '<div class="msg-row' +
      (continuation ? ' continuation' : '') +
      '" data-msg="' +
      msg.message_id +
      '">'
    html += '<div class="msg-avatar">' + senderAvatar(msg.sender) + '</div>'
    html += '<div class="msg-body"><div class="msg-content">'
    if (!continuation) {
      html +=
        '<div class="msg-head"><span class="msg-sender">' +
        esc(msg.sender.name) +
        (msg.sender.id === me ? '（我）' : '') +
        '</span><span class="msg-time">' +
        clockTime(msg.create_time) +
        '</span></div>'
    }
    if (msg.forwarded_from) {
      html +=
        '<div class="msg-forwarded">' +
        icon('forward', 12) +
        '<span>转发自 ' +
        esc(msg.forwarded_from.name) +
        '</span></div>'
    }
    if (msg.quoted) {
      html +=
        '<div class="msg-quote"><span class="msg-quote-name">' +
        esc(msg.quoted.name) +
        '</span><span class="msg-quote-text">' +
        esc(msg.quoted.text) +
        '</span></div>'
    }
    html += renderMessageBody(msg)

    // 悬停工具条紧贴这条消息的正文右沿，不钉在行的右端：短消息就在字后面，
    // 长消息在最长一行的后面。四格是宿主 2026-10-26T20:55 指明的
    // 回复 / 转发 / 话题 / 更多，前面单放一个表情方块。
    html += '<div class="msg-actions">'
    html +=
      '<button class="act-emoji" data-react-pick="' +
      msg.message_id +
      '" title="添加表情回复"><span>' +
      lastReactionEmoji() +
      '</span></button>'
    html += '<div class="act-seg">'
    html +=
      '<button data-quote-msg="' + msg.message_id + '" title="回复">' +
      icon('actReply', 16) +
      '</button>'
    html +=
      '<button data-forward-msg="' + msg.message_id + '" title="转发">' +
      icon('actForward', 16) +
      '</button>'
    html +=
      '<button data-open-topic="' + msg.message_id + '" title="话题">' +
      icon('actTopic', 16) +
      '</button>'
    html +=
      '<button data-msg-more="' + msg.message_id + '" title="更多">' +
      icon('actMore', 16) +
      '</button>'
    html += '</div></div></div>'

    if (msg.reactions && msg.reactions.length) {
      html += '<div class="msg-reactions">'
      msg.reactions.forEach((r) => {
        const mine = r.operators.indexOf(me) >= 0
        html +=
          '<button class="reaction' +
          (mine ? ' mine' : '') +
          '" data-react="' +
          msg.message_id +
          ':' +
          esc(r.emoji_type) +
          '">' +
          esc(emojiGlyph(r.emoji_type)) +
          ' <span>' +
          r.count +
          '</span></button>'
      })
      html += '</div>'
    }

    if (replyCount) {
      html +=
        '<button class="thread-replies" data-open-topic="' +
        msg.message_id +
        '">' +
        icon('topic', 13) +
        '<span>' +
        replyCount +
        ' 条回复</span></button>'
    }

    html += '</div></div>'
    return html
  }

  function renderMessages(chat) {
    const list = S.messages(chat.chat_id)
    if (!list.length) {
      return (
        '<div class="empty"><div class="empty-icon">' +
        icon('message', 40) +
        '</div><div class="empty-title">还没有消息</div><div>发一条打个招呼吧</div></div>'
      )
    }
    let html = ''
    let prev = null
    let lastDay = null
    list.forEach((m) => {
      if (!lastDay || !sameDay(lastDay, m.create_time)) {
        html += '<div class="day-divider">' + dayLabel(m.create_time) + '</div>'
        lastDay = m.create_time
        prev = null
      }
      html += renderMessageRow(m, prev, chat)
      prev = m
    })
    return html
  }

  // 机器人的副行／资料行：先看「职位」，老数据没有职位就看旧的描述，都没有才退回「机器人」。
  // 人不用这个，人看部门。
  function botLine(p) {
    if (!p) return ''
    return p.position || p.description || ''
  }

  function subLineOf(p) {
    if (!p) return ''
    return p.is_bot ? botLine(p) || '机器人' : p.department || '人'
  }

  function chatSubtitle(chat) {
    if (chat.chat_mode === 'p2p') {
      const p = S.chatter(chat.p2p_target_id)
      return subLineOf(p) || '人'
    }
    const bits = [chat.member_count + ' 人']
    if (chat.chat_mode === 'topic') bits.push('话题群')
    if (chat.chat_tag) bits.push(chat.chat_tag)
    return bits.join(' · ')
  }

  // -------------------------------------------------------------------------
  // message column
  // -------------------------------------------------------------------------

  function renderMain() {
    const col = $('mainCol')

    if (ui.view === 'contacts') return renderContactPane(col)
    if (ui.view === 'settings') return renderSettingsPane(col)
    if (ui.view === 'groups' && !ui.chatId) return renderGroupsPane(col)
    if (ui.view === 'topics' && !ui.chatId) return renderTopicsPane(col)

    const chat = ui.chatId ? S.chat(ui.chatId) : null
    if (!chat) {
      col.innerHTML =
        '<div class="empty"><div class="empty-icon">' +
        icon('message', 44) +
        '</div><div class="empty-title">选择一个会话</div><div>或者在左上角搜索</div></div>'
      return
    }

    const header =
      '<div class="chat-header"><div class="chat-header-main">' +
      '<div class="chat-header-title">' +
      esc(chat.name) +
      (chat.is_pinned ? icon('pin', 13) : '') +
      '</div><div class="chat-header-sub">' +
      esc(chatSubtitle(chat)) +
      '</div></div><div class="chat-header-actions">' +
      (chat.chat_mode !== 'p2p'
        ? '<button class="icon-btn" data-role="chat-members" title="成员">' + icon('users', 18) + '</button>'
        : '<button class="icon-btn" data-role="chat-info" title="资料">' + icon('contacts', 18) + '</button>') +
      '<button class="icon-btn" data-role="chat-topics" title="话题">' +
      icon('topic', 18) +
      '</button>' +
      '<button class="icon-btn" data-role="chat-info" title="会话信息">' +
      icon('info', 18) +
      '</button>' +
      '</div></div>'

    const body =
      '<div class="msg-list" id="msgList"><div class="msg-list-inner">' +
      renderMessages(chat) +
      '</div></div>'

    let quoteStrip = ''
    const q = ui.quote
    if (q && q.chatId === chat.chat_id) {
      const qm = S.message(q.chatId, q.messageId)
      if (qm) {
        quoteStrip =
          '<div class="composer-quote"><div class="composer-quote-main">' +
          '<span class="composer-quote-name">' +
          esc(qm.sender.name) +
          '</span><span class="composer-quote-text">' +
          esc(M.bodyText(qm).slice(0, 80)) +
          '</span></div><button class="composer-quote-x" data-quote-cancel="1" title="取消回复">' +
          icon('close', 14) +
          '</button></div>'
      }
    }

    const composer =
      '<div class="composer">' +
      quoteStrip +
      '<div class="composer-box">' +
      '<textarea class="composer-editor" id="composer" placeholder="' +
      esc('发送消息到 ' + chat.name) +
      '"></textarea>' +
      '<div class="composer-toolbar">' +
      '<button class="icon-btn sm" data-role="emoji" title="表情">' + icon('emoji', 17) + '</button>' +
      '<button class="icon-btn sm" data-role="image" title="图片">' + icon('image', 17) + '</button>' +
      '<button class="icon-btn sm" data-role="file" title="文件">' + icon('file', 17) + '</button>' +
      '<button class="icon-btn sm" data-role="mention" title="@ 成员">' + icon('at', 17) + '</button>' +
      '<div class="spacer"></div>' +
      '<button class="send-btn" data-role="send">发送</button>' +
      '</div></div>' +
      '<div class="composer-hint">Enter 发送 · Shift + Enter 换行（固定，不可改）</div></div>'

    col.innerHTML = header + body + composer

    const list = $('msgList')
    if (list) {
      list.addEventListener('scroll', () => {
        ui.stickBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60
      })
      if (ui.stickBottom) list.scrollTop = list.scrollHeight
      mountDropTarget(list, chat.chat_id)
    }
    mountDropTarget(col.querySelector('.composer'), chat.chat_id)
    mountComposer($('composer'), chat.chat_id)
  }

  // Dropping files anywhere on the message area or the composer sends them.
  function mountDropTarget(el, chatId) {
    if (!el) return
    let depth = 0
    el.addEventListener('dragenter', (e) => {
      e.preventDefault()
      depth += 1
      el.classList.add('drop-target')
    })
    el.addEventListener('dragover', (e) => {
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    })
    el.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1)
      if (!depth) el.classList.remove('drop-target')
    })
    el.addEventListener('drop', async (e) => {
      e.preventDefault()
      depth = 0
      el.classList.remove('drop-target')
      const api = window.seekHost
      if (!api || !api.ingest) return
      const dropped = Array.from((e.dataTransfer && e.dataTransfer.files) || [])
      if (!dropped.length) return
      const paths = dropped.map((f) => api.pathForFile(f)).filter(Boolean)
      if (!paths.length) return toast('无法读取拖入的文件')
      let items = []
      try {
        items = (await api.ingest(paths)) || []
      } catch (err) {
        return toast('添加文件失败：' + (err && err.message ? err.message : err))
      }
      if (!items.length) return
      flushComposerText(chatId)
      sendAttachments(items, { chatId: chatId })
    })
  }

  function autoGrow(ta) {
    ta.style.height = 'auto'
    ta.style.height = Math.min(260, Math.max(76, ta.scrollHeight)) + 'px'
  }

  function mountComposer(ta, chatId) {
    if (!ta) return
    ta.value = S.draft(chatId) || ''
    autoGrow(ta)
    ta.addEventListener('input', () => {
      S.setDraft(chatId, ta.value)
      ui.caret = ta.selectionStart
      autoGrow(ta)
    })
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        sendMessage(chatId, ta)
      }
    })
    ta.addEventListener('focus', () => {
      ui.composerFocus = true
    })
    ta.addEventListener('blur', () => {
      ui.composerFocus = false
    })
    // Pasting a picture (screenshot, copied image file) sends it as a message.
    ta.addEventListener('paste', async (e) => {
      const api = window.seekHost
      const cd = e.clipboardData
      if (!api || !cd) return
      const pasted = Array.from(cd.files || [])
      const paths = pasted.map((f) => api.pathForFile(f)).filter(Boolean)
      if (paths.length) {
        e.preventDefault()
        let items = []
        try {
          items = (await api.ingest(paths)) || []
        } catch (err) {}
        pasteAttachments(items)
        return
      }
      const looksLikeImage = pasted.some((f) => /^image\//.test(f.type || ''))
      if (!looksLikeImage) return
      e.preventDefault()
      let item = null
      try {
        item = await api.pasteImage()
      } catch (err) {}
      if (item) pasteAttachments([item])
      else toast('剪贴板里没有图片')
    })
    if (ui.composerFocus) {
      ta.focus()
      const pos = Math.min(ui.caret, ta.value.length)
      try {
        ta.setSelectionRange(pos, pos)
      } catch (err) {}
    }
  }

  function sendMessage(chatId, ta) {
    const text = (ta ? ta.value : '').trim()
    if (!text) return
    const opts = {}
    // 引用回复：把被引用那条的说话人和原话一起带出去，界面上画成一小块。
    const q = ui.quote
    if (q && q.chatId === chatId) {
      const qm = S.message(q.chatId, q.messageId)
      if (qm) {
        opts.quoted = {
          message_id: qm.message_id,
          name: qm.sender.name,
          text: M.bodyText(qm).slice(0, 160)
        }
      }
      ui.quote = null
    }
    S.sendMessage(chatId, text, opts)
    S.setDraft(chatId, '')
    if (ta) ta.value = ''
    ui.caret = 0
    ui.stickBottom = true
    render()
    const next = $('composer')
    if (next) next.focus()
  }

  // -------------------------------------------------------------------------
  // attachments — pick, drop or paste, then send as image / file messages
  // -------------------------------------------------------------------------

  function sendAttachments(files, opts) {
    const o = opts || {}
    const chatId = o.chatId || ui.chatId
    const rootId = o.rootId || ''
    if (!chatId || !files || !files.length) return 0
    let images = 0
    let others = 0
    files.forEach((f) => {
      if (!f || !f.file_key) return
      const asImage = f.is_image || isImageExt(f.file_name)
      if (asImage) images += 1
      else others += 1
      S.sendMessage(chatId, '', {
        rootId: rootId,
        msgType: asImage ? 'image' : 'file',
        content: JSON.stringify({
          image_key: asImage ? f.file_key : undefined,
          file_key: f.file_key,
          file_name: f.file_name,
          file_size: f.file_size,
          mime: f.mime
        })
      })
    })
    ui.stickBottom = true
    render()
    if (images && others) toast('已发送 ' + images + ' 张图片、' + others + ' 个文件')
    else if (images) toast(images === 1 ? '已发送图片' : '已发送 ' + images + ' 张图片')
    else if (others) toast(others === 1 ? '已发送文件' : '已发送 ' + others + ' 个文件')
    return images + others
  }

  // Anything typed before picking a file goes out first, as messengers do.
  function flushComposerText(chatId) {
    const ta = $('composer')
    const text = (ta ? ta.value : '').trim()
    if (!text || !chatId) return
    S.sendMessage(chatId, text)
    S.setDraft(chatId, '')
    if (ta) ta.value = ''
    ui.caret = 0
  }

  async function pickAttachments(kind) {
    const api = window.seekHost
    if (!api || !api.pick) return toast('当前环境不支持选择文件')
    const chatId = ui.chatId
    if (!chatId) return
    let files = []
    try {
      files = (await api.pick(kind)) || []
    } catch (err) {
      return toast('选择文件失败：' + (err && err.message ? err.message : err))
    }
    if (!files.length) return
    flushComposerText(chatId)
    sendAttachments(files, { chatId: chatId })
  }

  async function pasteAttachments(items) {
    const api = window.seekHost
    if (!api || !api.pasteImage) return
    if (!items || !items.length) return
    flushComposerText(ui.chatId)
    sendAttachments(items, { chatId: ui.chatId })
  }

  function openLightbox(key, name) {
    if (!key) return
    const wrap = document.createElement('div')
    wrap.className = 'lightbox'
    wrap.innerHTML =
      '<div class="lightbox-inner"><img src="' + esc(fileUrl(key)) + '" alt="' + esc(name || '') + '">' +
      '<div class="lightbox-bar"><span>' + esc(name || '图片') + '</span>' +
      '<button class="icon-btn sm" data-lightbox-close="1" title="关闭">' + icon('close', 16) + '</button></div></div>'
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap || (e.target.closest && e.target.closest('[data-lightbox-close]'))) {
        wrap.remove()
        document.removeEventListener('keydown', onKey)
      }
    })
    function onKey(e) {
      if (e.key === 'Escape') {
        wrap.remove()
        document.removeEventListener('keydown', onKey)
      }
    }
    document.addEventListener('keydown', onKey)
    document.body.appendChild(wrap)
  }

  // -------------------------------------------------------------------------
  // secondary panes
  // -------------------------------------------------------------------------

  function renderContactPane(col) {
    const p = ui.contactId ? S.chatter(ui.contactId) : null
    if (!p) {
      col.innerHTML =
        '<div class="empty"><div class="empty-icon">' +
        icon('contacts', 44) +
        '</div><div class="empty-title">机器人</div><div>从左侧挑一个，看它能做什么</div></div>'
      return
    }
    const chat = S.findP2P(p.open_id)
    col.innerHTML =
      '<div class="chat-header"><div class="chat-header-main">' +
      '<div class="chat-header-title">' +
      esc(p.name) +
      '</div><div class="chat-header-sub">' +
      esc(p.is_bot ? botLine(p) || '机器人' : p.department || '机器人') +
      '</div></div><div class="chat-header-actions">' +
      '<button class="btn sm primary" data-role="msg-contact">发消息</button>' +
      '</div></div>' +
      '<div class="pane"><div class="pane-pad">' +
      '<div style="display:flex;gap:16px;align-items:center;margin-bottom:20px">' +
      personAvatar(p, 'xxl') +
      '<div><div style="font-size:20px;font-weight:600">' +
      esc(p.name) +
      '</div><div style="color:var(--text-placeholder);font-size:12px">' +
      esc(p.is_bot ? '机器人' + (botLine(p) ? ' · ' + botLine(p) : '') : p.is_self ? '我 · 人' : '人') +
      '</div></div></div>' +
      (p.is_bot
        ? '<div class="card"><div class="card-body" style="padding:8px 16px">' +
          infoRow('类型', '机器人') +
          infoRow('性别', p.gender || '—') +
          infoRow('职位', p.position || p.description || '—') +
          infoRow('组织', S.org().name) +
          infoRow('它认得的我', (S.roster().me || {}).name || '—') +
          // 两行并一行：标签列只有 84px，「本组织的机器人」七个字会被折成两行。
          infoRow(
            '本组织',
            String(S.roster().humans.length) +
              ' 个人 · ' +
              String(S.roster().bots.length) +
              ' 个机器人'
          ) +
          infoRow('open_id', p.open_id, true) +
          '</div></div>' +
          // 性格是多行文本，单独一块画，不塞进一行一行对齐的资料表里。
          '<div class="card"><div class="card-body">' +
          '<div class="field-label">性格</div>' +
          '<div class="pane-desc" style="margin-top:6px;white-space:pre-wrap">' +
          esc(p.personality || '还没写。它会按默认的方式说话、做事。') +
          '</div></div></div>' +
          '<div class="card"><div class="card-body">' +
          '<div class="field-label">第一准则</div>' +
          '<div class="pane-desc" style="margin-top:6px">' +
          esc(M.FIRST_LAW) +
          '</div><div class="pane-desc" style="margin-top:8px">' +
          '它怎么认人：读这个组织的花名册，成员自己带着「人／机器人」这个类型，' +
          '它不靠名字去猜。' +
          '</div></div></div>'
        : '<div class="card"><div class="card-body" style="padding:8px 16px">' +
          infoRow('类型', p.is_self ? '我（人）' : '人') +
          infoRow('姓名', p.name) +
          infoRow('英文名', p.en_name || '—') +
          infoRow('部门', p.department || '—') +
          infoRow('城市', p.city || '—') +
          infoRow('邮箱', p.email || '—') +
          infoRow('手机', p.mobile || '—') +
          infoRow('工号', p.employee_no || '—') +
          infoRow('描述', p.description || '—') +
          infoRow('open_id', p.open_id, true) +
          '</div></div>') +
      '<div class="side-by-side">' +
      '<button class="btn primary" data-role="msg-contact">发消息</button>' +
      '<button class="btn danger" data-role="del-friend">移出这个组织</button>' +
      '</div>' +
      (chat ? '<div class="pane-desc" style="margin-top:12px">已有会话：' + esc(chat.name) + '</div>' : '') +
      '</div></div>'
  }

  function renderGroupsPane(col) {
    const list = S.groups()
    let html =
      '<div class="chat-header"><div class="chat-header-main">' +
      '<div class="chat-header-title">群组</div><div class="chat-header-sub">共 ' +
      list.length +
      ' 个</div></div><div class="chat-header-actions">' +
      '<button class="btn sm primary" data-role="new-group">新建群聊</button></div></div>' +
      '<div class="pane"><div class="pane-pad">'
    if (!list.length) {
      html += '<div class="empty" style="padding:60px 0"><div class="empty-title">还没有群聊</div></div>'
    }
    list.forEach((c) => {
      html +=
        '<div class="card"><div class="row-item" data-chat="' +
        c.chat_id +
        '">' +
        chatAvatar(c, 'lg') +
        '<div class="row-main"><div class="row-name">' +
        esc(c.name) +
        (c.chat_mode === 'topic' ? ' <span class="chip blue">话题群</span>' : '') +
        '</div><div class="row-sub">' +
        c.member_count +
        ' 人 · ' +
        esc(c.description || '暂无群介绍') +
        '</div></div><span class="chip">' +
        esc(listTime(c.update_time)) +
        '</span></div></div>'
    })
    html += '</div></div>'
    col.innerHTML = html
  }

  function renderTopicsPane(col) {
    const rows = []
    S.chats().forEach((c) => {
      S.topics(c.chat_id).forEach((t) => rows.push({ chat: c, t: t }))
    })
    rows.sort((a, b) => b.t.last_reply.create_time - a.t.last_reply.create_time)
    let html =
      '<div class="chat-header"><div class="chat-header-main">' +
      '<div class="chat-header-title">话题</div>' +
      '<div class="chat-header-sub">所有会话中的话题讨论</div></div></div>' +
      '<div class="pane"><div class="pane-pad">'
    if (!rows.length) {
      html +=
        '<div class="empty" style="padding:60px 0"><div class="empty-icon">' +
        icon('topic', 40) +
        '</div><div class="empty-title">还没有话题</div><div>在消息上点「回复」即可开一个话题</div></div>'
    }
    rows.forEach((r) => {
      html +=
        '<div class="card"><div class="row-item" data-topic="' +
        r.chat.chat_id +
        ':' +
        r.t.root.message_id +
        '">' +
        chatAvatar(r.chat, 'md') +
        '<div class="row-main"><div class="row-name">' +
        esc(M.bodyText(r.t.root)) +
        '</div><div class="row-sub">' +
        esc(r.chat.name) +
        ' · ' +
        r.t.reply_count +
        ' 条回复 · 最后 ' +
        esc(listTime(r.t.last_reply.create_time)) +
        '</div></div></div></div>'
    })
    html += '</div></div>'
    col.innerHTML = html
  }

  // 组织的一行，只有两列：左边组织名，右边两个按钮（切换 / 复制目录路径）。
  // 成员数、房间数、目录文字都不摆在这儿——要看就进这个组织里看。
  // 设置页和左上角头像弹出的组织菜单共用这一份，两处才长成一样。
  function orgRowHtml(a) {
    const active = a.org_id === S.state.data.currentOrgId
    return (
      '<div class="row-item" data-switch-org="' +
      a.org_id +
      '">' +
      '<div class="row-main"><div class="row-name">' +
      esc(a.name) +
      (active ? ' <span class="chip blue">当前</span>' : '') +
      '</div></div>' +
      (active ? '' : '<button class="btn sm" data-switch-org="' + a.org_id + '">切换</button>') +
      '<button class="icon-btn sm" data-copy-org="' +
      a.org_id +
      '" title="复制组织目录路径">' +
      icon('copy', 16) +
      '</button>' +
      '</div>'
    )
  }

  // 复制一个组织的目录路径。真产品里是这台机器上的绝对路径
  //（数据目录 + 组织目录名）；原型没有真实文件系统时退回到 seek-data/<dir>/。
  function copyOrgPath(orgId) {
    const org = S.state.data.orgs.find((o) => o.org_id === orgId)
    if (!org) return
    const dir = org.dir || org.org_id
    const withPath = (base) => {
      const full = base ? base.replace(/\/+$/, '') + '/' + dir + '/' : 'seek-data/' + dir + '/'
      writeClipboard(full).then((ok) => {
        toast(ok ? '已复制 ' + full : '复制失败：' + full)
      })
    }
    if (window.seekHost && window.seekHost.dataPath) {
      window.seekHost
        .dataPath()
        .then((base) => withPath(base))
        .catch(() => withPath(null))
      return
    }
    withPath(null)
  }

  // 写剪贴板：先走标准接口，被权限挡住就退回旧办法，避免按钮按下去什么都不发生。
  function writeClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(
        () => true,
        () => legacyCopy(text)
      )
    }
    return Promise.resolve(legacyCopy(text))
  }

  function legacyCopy(text) {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch (err) {
      return false
    }
  }

  function renderSettingsPane(col) {
    const dark = S.state.data.theme === 'dark'

    let html =
      '<div class="chat-header"><div class="chat-header-main">' +
      '<div class="chat-header-title">设置</div>' +
      '<div class="chat-header-sub">组织与偏好</div></div></div>' +
      '<div class="pane"><div class="pane-pad">'

    html +=
      '<h2 class="pane-title">组织</h2>' +
      '<div class="pane-desc">一个组织一个目录，里面住着一个我＋一堆机器人，别的组织看不见。' +
      '切组织只是换一个目录读写，不动任何文件；删组织会连目录一起删。</div>' +
      '<div class="pane-desc" style="margin-top:4px">机器人的第一准则：' +
      esc(M.FIRST_LAW) +
      '</div>'
    html += '<div class="card"><div class="card-body">'
    // 一行只有两列：左边组织名，右边两个按钮（切换 / 复制目录路径）。
    // 成员数、房间数、目录都不摆在这儿——要看得进这个组织里看。
    S.state.data.orgs.forEach((a) => {
      html += orgRowHtml(a)
    })
    html += '</div></div>'
    html +=
      '<div class="side-by-side" style="margin-bottom:20px">' +
      '<button class="btn" data-role="edit-org">改名字</button>' +
      '<button class="btn" data-role="new-org">新建组织</button>' +
      (S.state.data.orgs.length > 1
        ? '<button class="btn danger" data-role="del-org">删除组织</button>'
        : '') +
      '</div>'

    // ---- 模型 ------------------------------------------------------------
    // 这一块是新加的，原型里原本没有：原型是纯本地客户端，从来没有「模型」这回事。
    // 现在 seek 的两半都要模型——一半决定「这条消息要不要理」，一半决定「回什么」——
    // 所以设置页必须有个地方把这两半讲清楚，并且只让能改的那一半可改。
    const llm = S.llm()
    const keyHint = llm.keyTail
      ? '已存 · 尾号 ' + llm.keyTail + ' · ' + llm.keyLen + ' 位 · 要换就整串覆盖'
      : '还没存过 key'

    html += '<h2 class="pane-title">模型</h2>'
    html +=
      '<div class="pane-desc">seek 的两半各问一个模型：一半决定这条消息要不要理，一半决定回什么。' +
      '下面这两张卡片就是这两半，谁可改、谁不可改，卡片自己说。</div>'

    // 说话那半：可改
    html += '<div class="card"><div class="card-body">'
    html +=
      '<div class="row-item" style="cursor:default">' +
      '<div class="row-main"><div class="row-name">说话 · 写进房间的字</div>' +
      '<div class="row-sub">远端 · OpenAI 兼容的接口，你配哪家就用哪家</div></div></div>' +
      (llm.origin === 'emrg'
        ? '<div class="row-sub" style="margin:2px 0 12px">现在用的是这台机器上 EMRG 那份（~/.emrg/config.toml）。在这里按「保存」，就改成用这里的。</div>'
        : llm.origin === 'env'
          ? '<div class="row-sub" style="margin:2px 0 12px">现在用的是启动 Seek 时给的环境变量。这里的值改了也不会生效。</div>'
          : '<div class="row-sub" style="margin:2px 0 12px">现在用的是下面这三样。</div>')

    const draft = ui.modelDraft || {}
    const baseShown = draft.baseUrl === undefined ? llm.baseUrl : draft.baseUrl
    const nameShown = draft.model === undefined ? llm.model : draft.model
    html +=
      '<div class="field"><div class="field-label">地址</div>' +
      '<input class="field-input mono" id="modelBase" value="' +
      esc(baseShown) +
      '" placeholder="https://…/v1" /></div>'

    html +=
      '<div class="field"><div class="field-label">模型名</div>' +
      '<input class="field-input mono" id="modelName" value="' +
      esc(nameShown) +
      '" placeholder="例如 deepseek-flash" /></div>'

    html +=
      '<div class="field"><div class="field-label">API key</div>' +
      '<input class="field-input mono" id="modelKey" type="password" ' +
      'placeholder="' + esc(keyHint) + '" />' +
      '<div class="row-sub">key 只写进这台机器上的一个文件（权限 600），不会进日志、不会进房间，界面上也不再显示整串。</div></div>'

    html +=
      '<div class="side-by-side">' +
      '<button class="btn primary" data-role="save-model">保存</button></div>'
    html += '</div></div>'

    // 判断那半：不可改，只报告
    html += '<div class="card" style="margin-top:12px"><div class="card-body">'
    html +=
      '<div class="row-item" style="cursor:default">' +
      '<div class="row-main"><div class="row-name">判断 · 要不要理这条消息 ' +
      '<span class="chip blue">已就绪</span></div>' +
      '<div class="row-sub">本机 · 随包安装的小模型，不联网</div></div></div>'
    html +=
      '<div class="card-body" style="padding:4px 0 0">' +
      infoRow('模型', 'LFM2.5-VL-3B（随 Seek 安装）', false) +
      infoRow('权重', '2.18 GB · 已下载', false) +
      infoRow('运行于', '127.0.0.1 · 端口由 Seek 自己挑', true) +
      '</div>'
    html +=
      '<div class="row-sub" style="margin-top:8px">这一半不联网、不花钱，' +
      '也不接受配置：它只回答「理」还是「不理」，一个字的回复都不写。</div>'
    html += '</div></div>'

    html += '<h2 class="pane-title">外观</h2>'
    html +=
      '<div class="card"><div class="card-body">' +
      '<div class="row-item" data-role="toggle-theme"><div class="row-main">' +
      '<div class="row-name">深色模式</div><div class="row-sub">' +
      (dark ? '已开启' : '已关闭') +
      '</div></div><span class="chip' +
      (dark ? ' blue' : '') +
      '">' +
      (dark ? '开启' : '关闭') +
      '</span></div></div></div>'

    html +=
      '<h2 class="pane-title" style="margin-top:28px">关于 Seek</h2>' +
      '<div class="pane-desc">一个只属于这台机器的沟通客户端 · 无服务端 · 数据存于本机。' +
      '界面是一套常见的桌面聊天布局：左边列表、中间消息、右边详情；' +
      '数据模型按开放平台那套对象来定义。</div>'

    html += '</div></div>'
    col.innerHTML = html

  }

  // -------------------------------------------------------------------------
  // right panel
  // -------------------------------------------------------------------------

  function sideToggle(label, on, role) {
    return (
      '<div class="row-item" data-role="' +
      role +
      '"><div class="row-main"><div class="row-name">' +
      esc(label) +
      '</div></div><span class="chip' +
      (on ? ' blue' : '') +
      '">' +
      (on ? '已开启' : '已关闭') +
      '</span></div>'
    )
  }

  function renderSide() {
    const col = $('sideCol')
    if (!ui.side) {
      col.classList.add('hidden')
      col.innerHTML = ''
      return
    }
    col.classList.remove('hidden')

    const chat = ui.chatId ? S.chat(ui.chatId) : null
    if (!chat) {
      ui.side = null
      return renderSide()
    }

    if (ui.side.kind === 'info') {
      let html =
        '<div class="side-header"><div class="side-title">会话信息</div>' +
        '<button class="icon-btn sm" data-role="close-side">' +
        icon('close', 16) +
        '</button></div><div class="side-body">' +
        '<div class="info-hero">' +
        chatAvatar(chat, 'xxl') +
        '<div class="info-name">' +
        esc(chat.name) +
        '</div><div class="info-sub">' +
        esc(chatSubtitle(chat)) +
        '</div>' +
        (chat.chat_mode !== 'p2p'
          ? '<div class="side-by-side"><button class="btn sm" data-role="edit-chat">编辑</button>' +
            '<button class="btn sm" data-role="add-members">加人</button></div>'
          : '<div class="side-by-side"><button class="btn sm" data-role="msg-contact">发消息</button></div>') +
        '</div>'

      html += '<div class="info-section"><div class="info-section-title">设置</div>'
      html += sideToggle('置顶会话', chat.is_pinned, 'toggle-pin')
      html += sideToggle('消息免打扰', chat.is_muted, 'toggle-mute')
      html += infoRow('会话 ID', chat.chat_id, true)
      html += infoRow(
        '类型',
        chat.chat_mode === 'p2p' ? '单聊' : chat.chat_mode === 'topic' ? '话题群' : '群聊'
      )
      html += infoRow('创建时间', new Date(chat.create_time).toLocaleString('zh-CN'))
      html += '</div>'

      if (chat.chat_mode !== 'p2p') {
        html += '<div class="info-section"><div class="info-section-title">群公告</div>'
        html +=
          '<div style="white-space:pre-wrap;font-size:13px;line-height:20px;color:var(--text-caption);cursor:pointer" data-role="edit-chat">' +
          (chat.announcement
            ? esc(chat.announcement)
            : '<span style="color:var(--text-placeholder)">暂无公告，点击添加</span>') +
          '</div></div>'

        html +=
          '<div class="info-section"><div class="info-section-title">群成员<span>' +
          chat.member_count +
          '</span></div>'
        const me = S.org().open_id
        chat.member_ids.forEach((id) => {
          const p = S.chatter(id)
          if (!p) return
          html +=
            '<div class="member-item">' +
            personAvatar(p, 'sm') +
            '<div class="member-main"><div class="member-name">' +
            esc(p.name) +
            (id === chat.owner_id ? ' <span class="chip">群主</span>' : '') +
            '</div><div class="member-sub">' +
            esc(p.is_bot ? botLine(p) : p.department || '') +
            '</div></div>' +
            (id === me ? '<span class="chip">我</span>' : '') +
            '</div>'
        })
        html += '</div>'
        html +=
          '<div class="info-section"><button class="btn danger" style="width:100%" data-role="leave-chat">退出群聊</button></div>'
      } else {
        const p = S.chatter(chat.p2p_target_id)
        if (p) {
          html +=
            '<div class="info-section"><div class="info-section-title">对方</div>' +
            infoRow('姓名', p.name) +
            infoRow('部门', p.department || '—') +
            infoRow('邮箱', p.email || '—') +
            infoRow('open_id', p.open_id, true) +
            '</div>'
        }
      }
      html += '</div>'
      col.innerHTML = html
      return
    }

    if (ui.side.kind === 'topics') {
      const rows = S.topics(chat.chat_id)
      let html =
        '<div class="side-header"><div class="side-title">本会话的话题</div>' +
        '<button class="icon-btn sm" data-role="close-side">' +
        icon('close', 16) +
        '</button></div><div class="side-body"><div class="thread-list">'
      if (!rows.length) {
        html += '<div class="empty" style="padding:40px 12px"><div>还没有话题</div></div>'
      }
      rows.forEach((t) => {
        html +=
          '<div class="thread-item" data-open-topic="' +
          t.root.message_id +
          '"><div class="thread-item-title">' +
          esc(M.bodyText(t.root)) +
          '</div><div class="thread-item-sub">' +
          esc(t.root.sender.name) +
          ' · ' +
          t.reply_count +
          ' 条回复 · ' +
          esc(listTime(t.last_reply.create_time)) +
          '</div></div>'
      })
      html += '</div></div>'
      col.innerHTML = html
      return
    }

    // a single thread
    const root = S.message(chat.chat_id, ui.side.rootId)
    if (!root) {
      ui.side = null
      return renderSide()
    }
    const replies = S.replies(chat.chat_id, root.message_id)
    let html =
      '<div class="side-header"><div class="side-title">话题</div>' +
      '<button class="icon-btn sm" data-role="close-side">' +
      icon('close', 16) +
      '</button></div><div class="side-body">' +
      '<div class="thread-root"><div class="msg-head"><span class="msg-sender">' +
      esc(root.sender.name) +
      '</span><span class="msg-time">' +
      clockTime(root.create_time) +
      '</span></div>' +
      renderMessageBody(root) +
      '</div><div class="thread-list"><div class="info-section-title">' +
      replies.length +
      ' 条回复</div>'
    if (!replies.length) {
      html += '<div class="empty" style="padding:24px 8px"><div>还没有回复</div></div>'
    }
    let prev = null
    replies.forEach((m) => {
      if (prev && !sameDay(prev.create_time, m.create_time)) {
        html += '<div class="day-divider">' + dayLabel(m.create_time) + '</div>'
      }
      html += renderMessageRow(m, prev, chat)
      prev = m
    })
    html +=
      '</div></div><div class="composer" style="padding:12px 16px 16px">' +
      '<div class="composer-box">' +
      '<textarea class="composer-editor" id="topicComposer" style="min-height:60px" placeholder="回复话题…"></textarea>' +
      '<div class="composer-toolbar"><div class="spacer"></div>' +
      '<button class="send-btn" data-role="send-topic">回复</button></div></div></div>'

    col.innerHTML = html

    const ta = $('topicComposer')
    if (ta) {
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault()
          sendTopic(chat.chat_id, root.message_id, ta)
        }
      })
      ta.focus()
    }
    const sb = col.querySelector('.side-body')
    if (sb) sb.scrollTop = sb.scrollHeight
  }

  function sendTopic(chatId, rootId, ta) {
    const text = ta.value.trim()
    if (!text) return
    S.sendMessage(chatId, text, { rootId: rootId })
    ta.value = ''
    render()
  }

  // -------------------------------------------------------------------------
  // render
  // -------------------------------------------------------------------------

  function render() {
    document.documentElement.setAttribute('data-theme', S.state.data.theme === 'dark' ? 'dark' : 'light')
    renderRail()
    renderList()
    renderMain()
    renderSide()
  }

  // -------------------------------------------------------------------------
  // navigation
  // -------------------------------------------------------------------------

  function openChat(chatId) {
    ui.view = 'chat'
    ui.chatId = chatId
    ui.contactId = null
    ui.stickBottom = true
    ui.composerFocus = true
    ui.caret = 0
    S.markRead(chatId)
    render()
    const ta = $('composer')
    if (ta) ta.focus()
  }

  function openTopic(chatId, rootId) {
    ui.chatId = chatId
    ui.view = 'chat'
    ui.side = { kind: 'topic', rootId: rootId }
    S.markRead(chatId)
    render()
  }

  function openP2P(openId) {
    const c = S.ensureP2P(openId)
    if (c) openChat(c.chat_id)
  }

  function switchView(view) {
    ui.view = view
    ui.search = ''
    ui.side = null
    if (view === 'chat') {
      const alive = ui.chatId && S.chat(ui.chatId)
      if (!alive) {
        const sorted = S.sortedChats()
        ui.chatId = sorted.length ? sorted[0].chat_id : null
      }
      if (ui.chatId) S.markRead(ui.chatId)
    } else if (view === 'contacts') {
      ui.chatId = null
      const friends = S.friends()
      if (!ui.contactId || !S.chatter(ui.contactId)) {
        ui.contactId = friends.length ? friends[0].open_id : null
      }
    } else {
      ui.chatId = null
    }
    render()
  }

  // -------------------------------------------------------------------------
  // emoji picker
  // -------------------------------------------------------------------------

  const EMOJI_SET = [
    '😀', '😄', '😁', '😆', '😅', '😂', '🙂', '😉', '😊', '😍',
    '😘', '😜', '🤪', '🤔', '🤨', '😐', '😴', '😭', '😤', '😡',
    '👍', '👎', '👌', '✌️', '🙏', '👏', '💪', '👀', '🎉', '🎊',
    '❤️', '💔', '🔥', '✨', '⭐', '✅', '❌', '⚠️', '💡', '📌'
  ]

  function openEmojiPicker() {
    let body = '<div style="display:flex;flex-wrap:wrap;gap:4px;padding:4px 0">'
    EMOJI_SET.forEach((e) => {
      body +=
        '<button class="icon-btn" data-pick="' +
        esc(e) +
        '" style="font-size:20px;width:34px;height:34px">' +
        e +
        '</button>'
    })
    body += '</div>'
    openModal({
      title: '表情',
      body: body,
      onMount: (root) => {
        Array.prototype.forEach.call(root.querySelectorAll('[data-pick]'), (btn) => {
          btn.addEventListener('click', () => {
            insertIntoComposer(btn.getAttribute('data-pick'))
            closeModal()
          })
        })
      }
    })
  }

  function insertIntoComposer(text) {
    const ta = $('composer')
    if (!ta) return
    const pos = ta.selectionStart == null ? ta.value.length : ta.selectionStart
    ta.value = ta.value.slice(0, pos) + text + ta.value.slice(pos)
    if (ui.chatId) S.setDraft(ui.chatId, ta.value)
    ta.focus()
    const next = pos + text.length
    try {
      ta.setSelectionRange(next, next)
    } catch (err) {}
    autoGrow(ta)
  }

  // -------------------------------------------------------------------------
  // modals
  // -------------------------------------------------------------------------

  function modalNewChat() {
    const people = S.friends()
    let body = '<div class="field"><div class="field-label">挑一个机器人开始单聊</div><div class="pick-list">'
    people.forEach((p) => {
      body +=
        '<label class="check-row"><input type="radio" name="peer" value="' +
        p.open_id +
        '" /><span class="grow">' +
        esc(p.name) +
        '</span><span style="color:var(--text-placeholder);font-size:12px">' +
        esc(p.is_bot ? botLine(p) : p.department || '') +
        '</span></label>'
    })
    body += '</div></div>'
    openModal({
      title: '新建会话',
      body: body,
      footer:
        '<button class="btn" data-role="close-modal">取消</button>' +
        '<button class="btn" data-modal="goto-group">新建群聊</button>' +
        '<button class="btn primary" data-modal="create-p2p">开始聊天</button>',
      onMount: (root) => {
        root.querySelector('[data-modal="goto-group"]').addEventListener('click', modalNewGroup)
        root.querySelector('[data-modal="create-p2p"]').addEventListener('click', () => {
          const picked = root.querySelector('input[name="peer"]:checked')
          if (!picked) return toast('先挑一个机器人')
          closeModal()
          openP2P(picked.value)
        })
      }
    })
  }

  function modalNewGroup() {
    const people = S.friends()
    let body =
      '<div class="field"><div class="field-label">群名称</div>' +
      '<input class="field-input" name="name" placeholder="例如：产品设计组" /></div>' +
      '<div class="field"><div class="field-label">群类型</div>' +
      '<select class="field-input" name="mode">' +
      '<option value="group">普通群</option>' +
      '<option value="topic">话题群（每条消息是一个话题）</option></select></div>' +
      '<div class="field"><div class="field-label">群介绍</div>' +
      '<textarea class="field-input" name="description" placeholder="选填"></textarea></div>' +
      '<div class="field-label">选择成员</div><div class="pick-list">'
    people.forEach((p) => {
      body +=
        '<label class="check-row"><input type="checkbox" name="member" value="' +
        p.open_id +
        '" /><span class="grow">' +
        esc(p.name) +
        '</span><span style="color:var(--text-placeholder);font-size:12px">' +
        esc(p.is_bot ? botLine(p) : p.department || '') +
        '</span></label>'
    })
    body += '</div>'
    openModal({
      title: '新建群聊',
      body: body,
      footer:
        '<button class="btn" data-role="close-modal">取消</button>' +
        '<button class="btn primary" data-modal="create-group">创建</button>',
      onMount: (root) => {
        root.querySelector('[data-modal="create-group"]').addEventListener('click', () => {
          const name = modalValue('name').trim()
          if (!name) return toast('请输入群名称')
          const memberIds = Array.prototype.map.call(
            root.querySelectorAll('input[name="member"]:checked'),
            (i) => i.value
          )
          if (!memberIds.length) return toast('至少选一位成员')
          const mode = root.querySelector('select[name="mode"]').value
          const c = S.createGroup({
            name: name,
            memberIds: memberIds,
            chat_mode: mode,
            description: modalValue('description')
          })
          closeModal()
          openChat(c.chat_id)
          toast('群聊已创建')
        })
      }
    })
  }

  function modalAddFriend() {
    openModal({
      title: '往这个组织里加一个机器人',
      body:
        '<div class="field"><div class="field-label">姓名</div>' +
        '<input class="field-input" name="name" /></div>' +
        '<div class="field"><div class="field-label">性别</div>' +
        '<select class="field-input" name="gender">' +
        '<option value="">未选</option>' +
        '<option value="女">女</option>' +
        '<option value="男">男</option>' +
        '<option value="其他">其他</option>' +
        '</select></div>' +
        '<div class="field"><div class="field-label">职位</div>' +
        '<input class="field-input" name="position" placeholder="比如：接口与联调、排期与提醒" /></div>' +
        '<div class="field"><div class="field-label">性格</div>' +
        '<textarea class="field-input" name="personality" rows="6" style="min-height:96px" ' +
        'placeholder="它会怎么说话、怎么做事。可以写多行，比如：先给结论再给理由；改接口前列出谁会被影响。"></textarea></div>' +
        '<div class="pane-desc">它属于这个组织，别的组织看不见它。加进来的成员类型是「机器人」，' +
        '第一准则是 ' +
        esc(M.FIRST_LAW) +
        '</div>' +
        '<label class="check-row"><input type="checkbox" name="andChat" checked /><span class="grow">同时创建单聊会话</span></label>',
      footer:
        '<button class="btn" data-role="close-modal">取消</button>' +
        '<button class="btn primary" data-modal="create-friend">添加</button>',
      onMount: (root) => {
        root.querySelector('[data-modal="create-friend"]').addEventListener('click', () => {
          const name = modalValue('name').trim()
          if (!name) return toast('请输入姓名')
          const p = S.addFriend({
            name: name,
            gender: modalValue('gender'),
            position: modalValue('position').trim(),
            personality: modalValue('personality').trim(),
            andChat: root.querySelector('input[name="andChat"]').checked
          })
          closeModal()
          ui.view = 'contacts'
          ui.contactId = p.open_id
          render()
          toast('已加入 ' + name + '，类型是机器人')
        })
      }
    })
  }

  function modalEditChat() {
    const chat = S.chat(ui.chatId)
    if (!chat) return
    openModal({
      title: '编辑会话',
      body:
        '<div class="field"><div class="field-label">名称</div>' +
        '<input class="field-input" name="name" value="' + esc(chat.name) + '" /></div>' +
        '<div class="field"><div class="field-label">群介绍</div>' +
        '<textarea class="field-input" name="description">' + esc(chat.description) + '</textarea></div>' +
        '<div class="field"><div class="field-label">群公告</div>' +
        '<textarea class="field-input" name="announcement">' + esc(chat.announcement) + '</textarea></div>' +
        '<div class="field"><div class="field-label">会话标签</div>' +
        '<input class="field-input" name="chat_tag" value="' + esc(chat.chat_tag || '') + '" placeholder="选填，例如：外部群" /></div>',
      footer:
        '<button class="btn" data-role="close-modal">取消</button>' +
        '<button class="btn primary" data-modal="save-chat">保存</button>',
      onMount: (root) => {
        root.querySelector('[data-modal="save-chat"]').addEventListener('click', () => {
          const name = modalValue('name').trim() || chat.name
          S.updateChat(chat.chat_id, {
            name: name,
            avatar_text: M.initialsOf(name),
            description: modalValue('description'),
            announcement: modalValue('announcement'),
            chat_tag: modalValue('chat_tag').trim()
          })
          closeModal()
          toast('已保存')
        })
      }
    })
  }

  function modalAddMembers() {
    const chat = S.chat(ui.chatId)
    if (!chat) return
    const people = S.friends().filter((p) => chat.member_ids.indexOf(p.open_id) < 0)
    if (!people.length) return toast('这个组织的机器人都已经在群里')
    let body = '<div class="pick-list">'
    people.forEach((p) => {
      body +=
        '<label class="check-row"><input type="checkbox" name="member" value="' +
        p.open_id +
        '" /><span class="grow">' +
        esc(p.name) +
        '</span><span style="color:var(--text-placeholder);font-size:12px">' +
        esc(p.is_bot ? botLine(p) : p.department || '') +
        '</span></label>'
    })
    body += '</div>'
    openModal({
      title: '添加成员',
      body: body,
      footer:
        '<button class="btn" data-role="close-modal">取消</button>' +
        '<button class="btn primary" data-modal="do-add">添加</button>',
      onMount: (root) => {
        root.querySelector('[data-modal="do-add"]').addEventListener('click', () => {
          const ids = Array.prototype.map.call(
            root.querySelectorAll('input[name="member"]:checked'),
            (i) => i.value
          )
          if (!ids.length) return toast('没有选择成员')
          S.updateChat(chat.chat_id, { member_ids: chat.member_ids.concat(ids) })
          closeModal()
          toast('已添加 ' + ids.length + ' 位成员')
        })
      }
    })
  }

  // 组织名只是个标签：这里只改那一行文字，不碰任何数据、不碰房间里「我」的名字。
  function modalEditOrg() {
    const org = S.org()
    openModal({
      title: '改组织名字',
      body:
        '<div class="field"><div class="field-label">名字</div>' +
        '<input class="field-input" name="name" value="' + esc(org.name) + '" /></div>' +
        '<div class="pane-desc">名字只是这个目录的标签，摆在列表和左上角。改它不改这个组织里的' +
        '任何东西——不改消息、不改机器人，也不改「我」的名字。</div>' +
        infoRow('数据目录', 'seek-data/' + (org.dir || org.org_id) + '/', true),
      footer:
        '<button class="btn" data-role="close-modal">取消</button>' +
        '<button class="btn primary" data-modal="save-org">保存</button>',
      onMount: (root) => {
        root.querySelector('[data-modal="save-org"]').addEventListener('click', () => {
          const name = modalValue('name').trim()
          if (!name) return toast('名字不能为空')
          S.renameOrg(name)
          closeModal()
          toast('名字已改')
        })
      }
    })
  }

  function modalNewOrg() {
    openModal({
      title: '新建组织',
      body:
        '<div class="field"><div class="field-label">组织名字</div>' +
        '<input class="field-input" name="name" placeholder="比如：工作室" /></div>' +
        '<div class="pane-desc">只问一个名字。新组织落在自己的目录里（seek-data/org_…/），' +
        '里面从「一个我」开始，机器人你自己加；现有组织的数据一个字都不动。建好会切过去。</div>',
      footer:
        '<button class="btn" data-role="close-modal">取消</button>' +
        '<button class="btn primary" data-modal="create-org">创建</button>',
      onMount: (root) => {
        root.querySelector('[data-modal="create-org"]').addEventListener('click', () => {
          const name = modalValue('name').trim()
          if (!name) return toast('请输入名字')
          S.addOrg(name)
          closeModal()
          ui.chatId = null
          switchView('settings')
          toast('已新建组织，切过去了')
        })
      }
    })
  }

  // 删除组织会连目录一起删，是唯一毁数据的一步：先摆清楚删的是哪个目录、里面有多少东西。
  function modalDeleteOrg() {
    const org = S.org()
    const dir = org.dir || org.org_id
    const okCount = S.state.data.orgs.length > 1
    const chatList = S.chats()
    const msgCount = chatList.reduce((n, c) => n + S.messages(c.chat_id).length, 0)
    openModal({
      title: '删除组织「' + org.name + '」',
      body:
        '<div class="pane-desc" style="color:var(--R500)">' +
        '这一步会连目录一起删。删掉的东西不进废纸篓，也找不回来。</div>' +
        infoRow('会删掉的目录', 'seek-data/' + dir + '/', true) +
        infoRow('会一起没掉', chatList.length + ' 个房间 · ' + msgCount + ' 条消息 · 里面的我') +
        infoRow('别的组织', '不动') +
        '<div class="pane-desc">想留一份：先把 seek-data/' +
        esc(dir) +
        '/ 整个复制到别处，再回来删。</div>' +
        (okCount ? '' : '<div class="pane-desc">最后一个组织不能删。</div>'),
      footer:
        '<button class="btn" data-role="close-modal">不删了</button>' +
        (okCount
          ? '<button class="btn danger" data-modal="do-delete">连目录一起删</button>'
          : ''),
      onMount: (root) => {
        const btn = root.querySelector('[data-modal="do-delete"]')
        if (!btn) return
        btn.addEventListener('click', () => {
          const ok = S.removeOrg(org.org_id)
          closeModal()
          if (ok) {
            ui.chatId = null
            ui.contactId = null
            render()
            toast('已删除组织，seek-data/' + dir + '/ 也没了')
          } else {
            toast('至少保留一个组织')
          }
        })
      }
    })
  }

  // 表情回复面板：贴在「添加表情回复」按钮下面就地选，像飞书那样，不弹模态框。
  // 已经加过的那个会高亮，再点一次就是取消。
  function openReactPicker(chatId, messageId, anchorEl) {
    closeReactPicker()
    if (!anchorEl) return
    const msg = S.message(chatId, messageId)
    const me = S.org().open_id
    const mine = {}
    if (msg && msg.reactions) {
      msg.reactions.forEach((r) => {
        if (r.operators.indexOf(me) >= 0) mine[r.emoji_type] = true
      })
    }

    const panel = document.createElement('div')
    panel.className = 'react-pop'
    panel.id = 'reactPop'
    let html = ''
    EMOJI_SET.forEach((e) => {
      const name = emojiName(e)
      html +=
        '<button class="react-pick' +
        (mine[name] ? ' mine' : '') +
        '" data-react-now="' +
        esc(name) +
        '" title="' +
        esc(e) +
        '">' +
        esc(e) +
        '</button>'
    })
    panel.innerHTML = html
    document.body.appendChild(panel)

    // 贴在按钮右下：右边对齐按钮右沿，放不下就往窗口里收。
    const r = anchorEl.getBoundingClientRect()
    const w = panel.offsetWidth
    const h = panel.offsetHeight
    let left = r.right - w
    if (left < 8) left = 8
    if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8
    let top = r.bottom + 6
    if (top + h > window.innerHeight - 8) top = r.top - h - 6
    panel.style.left = Math.round(left) + 'px'
    panel.style.top = Math.round(top) + 'px'

    Array.prototype.forEach.call(panel.querySelectorAll('[data-react-now]'), (btn) => {
      btn.addEventListener('click', () => {
        const picked = btn.getAttribute('data-react-now')
        lastReaction = (btn.textContent || '').trim() || '😊'
        S.toggleReaction(chatId, messageId, picked)
        closeReactPicker()
      })
    })
  }

  function closeReactPicker() {
    const old = document.getElementById('reactPop')
    if (old) old.remove()
  }

  // 转发：挑一个会话，把这条消息原样投过去，并在那边标一行「转发自 X」。
  function modalForwardMessage(chatId, messageId) {
    const msg = S.message(chatId, messageId)
    if (!msg) return
    const others = S.sortedChats().filter((c) => c.chat_id !== chatId)
    if (!others.length) return toast('没有别的会话可以转发')
    let body = '<div class="field"><div class="field-label">转发到</div><div class="pick-list">'
    others.forEach((c) => {
      body +=
        '<label class="check-row"><input type="radio" name="fwd" value="' +
        c.chat_id +
        '" /><span class="grow">' +
        esc(c.name) +
        '</span><span style="color:var(--text-placeholder);font-size:12px">' +
        (c.chat_mode === 'p2p' ? '单聊' : c.member_count + ' 人') +
        '</span></label>'
    })
    body += '</div></div>'
    body +=
      '<div class="pane-desc">转发过去的是这条消息本身：文字、图片或文件都一样，' +
      '那边标「转发自 ' +
      esc(msg.sender.name) +
      '」，谁发的一目了然。</div>'
    openModal({
      title: '转发消息',
      body: body,
      footer:
        '<button class="btn" data-role="close-modal">取消</button>' +
        '<button class="btn primary" data-modal="do-fwd">转发</button>',
      onMount: (root) => {
        root.querySelector('[data-modal="do-fwd"]').addEventListener('click', () => {
          const picked = root.querySelector('input[name="fwd"]:checked')
          if (!picked) return toast('先挑一个会话')
          const target = picked.value
          S.sendMessage(target, '', {
            msgType: msg.msg_type,
            content: msg.body.content,
            forwardedFrom: { name: msg.sender.name, message_id: msg.message_id }
          })
          closeModal()
          const to = S.chat(target)
          toast('已转发到 ' + (to ? to.name : '那个会话'))
        })
      }
    })
  }

  function modalMessageMore(chatId, messageId) {
    const msg = S.message(chatId, messageId)
    if (!msg) return
    const me = S.org().open_id
    const isMine = msg.sender.id === me
    openModal({
      title: '消息操作',
      body:
        '<div class="pick-list" style="max-height:none">' +
        '<div class="row-item" data-modal="copy-msg"><div class="row-main"><div class="row-name">复制文本</div></div></div>' +
        '<div class="row-item" data-modal="topic-msg"><div class="row-main"><div class="row-name">在话题中回复</div></div></div>' +
        '<div class="row-item"><div class="row-main"><div class="row-name">添加表情回复</div>' +
        '<div style="display:flex;gap:4px;margin-top:6px">' +
        QUICK_EMOJI.map(
          (e) =>
            '<button class="icon-btn sm" data-modal-emoji="' +
            esc(e) +
            '" style="font-size:14px">' +
            e +
            '</button>'
        ).join('') +
        '</div></div></div>' +
        (isMine
          ? '<div class="row-item" data-modal="delete-msg"><div class="row-main">' +
            '<div class="row-name" style="color:var(--R500)">删除消息</div></div></div>'
          : '') +
        infoRow('message_id', msg.message_id, true) +
        infoRow('msg_type', msg.msg_type) +
        '</div>',
      onMount: (root) => {
        root.querySelector('[data-modal="copy-msg"]').addEventListener('click', () => {
          const text = M.bodyText(msg)
          if (navigator.clipboard) navigator.clipboard.writeText(text)
          closeModal()
          toast('已复制')
        })
        root.querySelector('[data-modal="topic-msg"]').addEventListener('click', () => {
          closeModal()
          openTopic(chatId, msg.root_id || msg.message_id)
        })
        Array.prototype.forEach.call(root.querySelectorAll('[data-modal-emoji]'), (btn) => {
          btn.addEventListener('click', () => {
            S.toggleReaction(chatId, messageId, emojiName(btn.getAttribute('data-modal-emoji')))
            closeModal()
          })
        })
        const del = root.querySelector('[data-modal="delete-msg"]')
        if (del) {
          del.addEventListener('click', () => {
            S.deleteMessage(chatId, messageId)
            closeModal()
            toast('已删除')
          })
        }
      }
    })
  }

  // -------------------------------------------------------------------------
  // event handling
  // -------------------------------------------------------------------------

  // 问「这一家有哪些模型」。两个按钮都用它：先说同一句话，再各自解释回话。
  // 回话有三种：HTTP 通了并给了 JSON、HTTP 通了但不是 JSON、根本没连上。
  // 三种都要能把话说出来——尤其是第三种，界面上必须有位置放它的原话。
  function onRole(role, el) {
    switch (role) {
      case 'close-modal':
        closeModal()
        break
      case 'close-side':
        ui.side = null
        render()
        break
      case 'toggle-theme':
        S.setTheme(S.state.data.theme === 'dark' ? 'light' : 'dark')
        break
      case 'save-model': {
        const base = (($('modelBase') || {}).value || '').trim()
        const name = (($('modelName') || {}).value || '').trim()
        const key = (($('modelKey') || {}).value || '').trim()
        if (!/^https?:\/\/./.test(base)) return toast('地址要 http:// 或 https:// 开头')
        if (!name) return toast('模型名还没填')
        const patch = { baseUrl: base, model: name, origin: 'own' }
        if (key) {
          patch.keyTail = key.slice(-4)
          patch.keyLen = key.length
        }
        ui.modelDraft = {}
        S.setLlm(patch)
        toast(key ? '已保存 · key 尾号 ' + key.slice(-4) : '已保存')
        break
      }
      case 'new-chat':
        modalNewChat()
        break
      case 'new-group':
        modalNewGroup()
        break
      case 'add-friend':
        modalAddFriend()
        break
      case 'chat-info':
      case 'chat-members':
        ui.side = { kind: 'info' }
        render()
        break
      case 'chat-topics':
        ui.side = { kind: 'topics' }
        render()
        break
      case 'send': {
        const ta = $('composer')
        if (ta) sendMessage(ui.chatId, ta)
        break
      }
      case 'send-topic': {
        const ta = $('topicComposer')
        const root = ui.side && ui.side.rootId
        if (ta && root) sendTopic(ui.chatId, root, ta)
        break
      }
      case 'emoji':
        openEmojiPicker()
        break
      case 'mention':
        insertIntoComposer('@')
        break
      case 'image':
        pickAttachments('image')
        break
      case 'file':
        pickAttachments('file')
        break
      case 'edit-chat':
        modalEditChat()
        break
      case 'add-members':
        modalAddMembers()
        break
      case 'leave-chat': {
        const chat = S.chat(ui.chatId)
        if (!chat) break
        S.deleteChat(chat.chat_id)
        ui.chatId = null
        ui.side = null
        render()
        toast('已退出群聊')
        break
      }
      case 'msg-contact': {
        const chat = ui.chatId ? S.chat(ui.chatId) : null
        const target = ui.view === 'contacts' && ui.contactId ? ui.contactId : chat && chat.p2p_target_id
        if (target) openP2P(target)
        break
      }
      case 'del-friend': {
        if (!ui.contactId) break
        S.removeFriend(ui.contactId)
        ui.contactId = null
        render()
        toast('已移出这个组织')
        break
      }
      case 'toggle-pin':
        S.togglePin(ui.chatId)
        break
      case 'toggle-mute':
        S.toggleMute(ui.chatId)
        break
      case 'edit-org':
        modalEditOrg()
        break
      case 'new-org':
        modalNewOrg()
        break
      case 'del-org':
        modalDeleteOrg()
        break
    }
  }

  document.addEventListener('click', (e) => {
    const target = e.target

    const viewBtn = target.closest && target.closest('[data-view]')
    if (viewBtn) {
      switchView(viewBtn.getAttribute('data-view'))
      return
    }

    const topicEl = target.closest && target.closest('[data-topic]')
    if (topicEl) {
      const parts = topicEl.getAttribute('data-topic').split(':')
      openTopic(parts[0], parts[1])
      return
    }

    const openTopicBtn = target.closest && target.closest('[data-open-topic]')
    if (openTopicBtn) {
      openTopic(ui.chatId, openTopicBtn.getAttribute('data-open-topic'))
      return
    }

    const reactPickBtn = target.closest && target.closest('[data-react-pick]')
    if (reactPickBtn) {
      openReactPicker(ui.chatId, reactPickBtn.getAttribute('data-react-pick'), reactPickBtn)
      return
    }

    const fwdBtn = target.closest && target.closest('[data-forward-msg]')
    if (fwdBtn) {
      closeReactPicker()
      modalForwardMessage(ui.chatId, fwdBtn.getAttribute('data-forward-msg'))
      return
    }

    // 点到面板外面就把表情面板收起来（点面板里面不算）。
    if (!target.closest || !target.closest('#reactPop')) closeReactPicker()

    const reactBtn = target.closest && target.closest('[data-react]')
    if (reactBtn) {
      const parts = reactBtn.getAttribute('data-react').split(':')
      S.toggleReaction(ui.chatId, parts[0], parts[1])
      return
    }

    // 「回复」＝引用回复：在输入框上面挂一条原话，发出去那条带引用块。
    // 「话题」才是开右边的话题面板；这两个在飞书是两件事，别混。
    const cancelQuote = target.closest && target.closest('[data-quote-cancel]')
    if (cancelQuote) {
      ui.quote = null
      render()
      const ta0 = $('composer')
      if (ta0) ta0.focus()
      return
    }

    const quoteBtn = target.closest && target.closest('[data-quote-msg]')
    if (quoteBtn) {
      closeReactPicker()
      ui.quote = { chatId: ui.chatId, messageId: quoteBtn.getAttribute('data-quote-msg') }
      render()
      const ta = $('composer')
      if (ta) ta.focus()
      return
    }

    const moreBtn = target.closest && target.closest('[data-msg-more]')
    if (moreBtn) {
      modalMessageMore(ui.chatId, moreBtn.getAttribute('data-msg-more'))
      return
    }

    const imageEl = target.closest && target.closest('[data-open-image]')
    if (imageEl) {
      openLightbox(imageEl.getAttribute('data-open-image'), imageEl.getAttribute('data-name'))
      return
    }

    const fileEl = target.closest && target.closest('[data-open-file]')
    if (fileEl) {
      const key = fileEl.getAttribute('data-open-file')
      const api = window.seekHost
      if (!api || !api.openFile) return
      api.openFile(key).then((res) => {
        if (res === 'missing') toast('文件已不在本地')
      })
      return
    }

    const copyEl = target.closest && target.closest('[data-copy-org]')
    if (copyEl) {
      copyOrgPath(copyEl.getAttribute('data-copy-org'))
      return
    }

    const switchRow = target.closest && target.closest('[data-switch-org]')
    if (switchRow) {
      S.switchOrg(switchRow.getAttribute('data-switch-org'))
      ui.chatId = null
      ui.contactId = null
      ui.side = null
      closeModal()
      switchView('chat')
      toast('已切换组织')
      return
    }

    const p2pEl = target.closest && target.closest('[data-open-p2p]')
    if (p2pEl) {
      openP2P(p2pEl.getAttribute('data-open-p2p'))
      return
    }

    const hitEl = target.closest && target.closest('[data-search-hit]')
    if (hitEl) {
      openChat(hitEl.getAttribute('data-search-hit'))
      return
    }

    const contactEl = target.closest && target.closest('[data-contact]')
    if (contactEl) {
      ui.view = 'contacts'
      ui.contactId = contactEl.getAttribute('data-contact')
      render()
      return
    }

    const chatEl = target.closest && target.closest('[data-chat]')
    if (chatEl) {
      openChat(chatEl.getAttribute('data-chat'))
      return
    }

    const roleEl = target.closest && target.closest('[data-role]')
    if (roleEl) {
      onRole(roleEl.getAttribute('data-role'), roleEl)
    }
  })

  document.addEventListener('input', (e) => {
    if (e.target && (e.target.id === 'modelBase' || e.target.id === 'modelName')) {
      ui.modelDraft[e.target.id === 'modelBase' ? 'baseUrl' : 'model'] = e.target.value
      return
    }
    if (e.target && e.target.id === 'searchInput') {
      ui.search = e.target.value
      renderList()
      const el = $('searchInput')
      if (el) {
        el.focus()
        try {
          el.setSelectionRange(el.value.length, el.value.length)
        } catch (err) {}
      }
    }
  })

  // 工具条要贴着消息站，但消息本身就顶到右边时后面没地方放——这时给它换到
  // 消息上方、右沿对齐（CSS 里的 .narrow）。只在真有鼠标移到行上时才算，
  // 算的时候看的是内容块的右沿，不是行的右沿。
  document.addEventListener('mouseover', (e) => {
    const row = e.target.closest && e.target.closest('.msg-row')
    if (!row) return
    const content = row.querySelector('.msg-content')
    if (!content) return
    const rowBox = row.getBoundingClientRect()
    const box = content.getBoundingClientRect()
    // 26 表情方块 + 2 间隔 + 98 药丸 + 6 外边距，再留 4px 喘气
    const narrow = box.right + 6 + 126 + 4 > rowBox.right
    if (narrow) row.classList.add('narrow')
    else row.classList.remove('narrow')
  })

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (document.getElementById('reactPop')) {
        closeReactPicker()
        return
      }
      if ($('modalRoot').innerHTML) {
        closeModal()
        return
      }
      if (ui.side) {
        ui.side = null
        render()
        return
      }
      if (ui.quote) {
        ui.quote = null
        render()
      }
    }
  })

  // -------------------------------------------------------------------------
  // boot
  // -------------------------------------------------------------------------

  async function boot() {
    await S.init()
    S.subscribe(() => render())
    render()
    if (!ui.chatId) {
      const sorted = S.sortedChats()
      if (sorted.length) {
        ui.chatId = sorted[0].chat_id
        S.markRead(ui.chatId)
        render()
      }
    }
    window.addEventListener('beforeunload', () => {
      S.flush()
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }

  window.SeekUI = { render: render, ui: ui }
})()
