/* ---------------------------------------------------------------------------
   Seek — store
   One in-memory state tree, persisted to disk through the preload bridge.
   Every mutation goes through a method here so that saving stays in one place.
   --------------------------------------------------------------------------- */

;(function () {
  const M = window.Model

  const state = {
    data: null,
    listeners: [],
    saveTimer: null,
    ready: false
  }

  function subscribe(fn) {
    state.listeners.push(fn)
    return () => {
      state.listeners = state.listeners.filter((f) => f !== fn)
    }
  }

  function emit(reason) {
    state.listeners.forEach((fn) => {
      try {
        fn(reason)
      } catch (err) {
        console.error('[seek] listener failed', err)
      }
    })
  }

  function scheduleSave() {
    if (state.saveTimer) clearTimeout(state.saveTimer)
    state.saveTimer = setTimeout(flush, 250)
  }

  async function flush() {
    if (state.saveTimer) {
      clearTimeout(state.saveTimer)
      state.saveTimer = null
    }
    if (!state.data) return
    try {
      await window.seekHost.save(state.data)
    } catch (err) {
      console.error('[seek] save failed', err)
    }
  }

  function touch(reason) {
    scheduleSave()
    emit(reason)
  }

  // -------------------------------------------------------------------------
  // boot
  // -------------------------------------------------------------------------

  async function init() {
    let loaded = null
    try {
      loaded = await window.seekHost.load()
    } catch (err) {
      console.error('[seek] load failed', err)
    }
    if (!loaded || !loaded.orgs || !loaded.store) {
      loaded = M.createInitialState()
    }
    // forward-compatible defaults
    loaded.version = loaded.version || M.SCHEMA_VERSION
    loaded.theme = loaded.theme || 'light'
    loaded.llm = loaded.llm || Object.assign({}, LLM_DEFAULTS)
    // 老数据没有 dir：一个组织一个目录，缺了就按 org_id 补上
    loaded.orgs.forEach((a) => {
      if (!a.dir) a.dir = a.org_id
    })
    Object.keys(loaded.store || {}).forEach((id) => {
      const d = loaded.store[id]
      d.chatters = d.chatters || []
      d.chats = d.chats || []
      d.messages = d.messages || {}
      d.drafts = d.drafts || {}
      d.settings = d.settings || {}
    })
    if (!loaded.orgs.length) {
      const fresh = M.createInitialState()
      Object.assign(loaded, fresh)
    }
    if (!loaded.store[loaded.currentOrgId]) {
      loaded.currentOrgId = loaded.orgs[0].org_id
    }
    state.data = loaded
    state.ready = true
    await flush()
    emit('boot')
    return state.data
  }

  // -------------------------------------------------------------------------
  // selectors
  // -------------------------------------------------------------------------

  function org() {
    const d = state.data
    return d.orgs.find((a) => a.org_id === d.currentOrgId) || d.orgs[0]
  }

  function data() {
    return state.data.store[state.data.currentOrgId]
  }

  function selfChatter() {
    const current = org()
    return (
      data().chatters.find((c) => c.open_id === current.open_id) || {
        open_id: current.open_id,
        name: '我',
        avatar_color: M.colorFor(current.open_id),
        avatar_text: M.initialsOf('我')
      }
    )
  }

  function chats() {
    return data().chats.slice()
  }

  function chat(chatId) {
    return data().chats.find((c) => c.chat_id === chatId) || null
  }

  function chatter(openId) {
    const found = data().chatters.find((c) => c.open_id === openId)
    if (found) return found
    for (const c of chats()) {
      if (c.p2p_target_id === openId) {
        return { open_id: openId, name: c.name, avatar_color: c.avatar_color, avatar_text: c.avatar_text }
      }
    }
    return null
  }

  function messages(chatId) {
    const list = data().messages[chatId] || []
    return list
      .filter((m) => !m.deleted)
      .slice()
      .sort((a, b) => a.create_time - b.create_time)
  }

  function message(chatId, messageId) {
    return (data().messages[chatId] || []).find((m) => m.message_id === messageId) || null
  }

  function lastMessage(chatId) {
    const list = messages(chatId)
    return list.length ? list[list.length - 1] : null
  }

  // Root messages that own at least one reply — the "话题" list of a chat.
  function topics(chatId) {
    const all = messages(chatId)
    const counts = {}
    all.forEach((m) => {
      if (m.root_id) counts[m.root_id] = (counts[m.root_id] || 0) + 1
    })
    return all
      .filter((m) => !m.root_id && counts[m.message_id])
      .map((m) => {
        const replies = all.filter((r) => r.root_id === m.message_id)
        return {
          root: m,
          reply_count: replies.length,
          last_reply: replies[replies.length - 1]
        }
      })
      .sort((a, b) => b.last_reply.create_time - a.last_reply.create_time)
  }

  function replies(chatId, rootId) {
    return messages(chatId).filter((m) => m.root_id === rootId)
  }

  function sortedChats() {
    return chats().sort((a, b) => {
      if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1
      return b.update_time - a.update_time
    })
  }

  function friends() {
    return data()
      .chatters.filter((c) => c.is_friend && !c.is_self)
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  }

  // 这个组织的花名册：谁是「我」、谁是人、谁是机器人。
  // 机器人辨认人类靠的就是这一份——成员自己带着 kind，不靠名字猜。
  function roster() {
    const all = data().chatters.slice()
    const me = all.find((c) => c.is_self) || null
    const humans = all.filter((c) => !c.is_self && c.kind !== 'bot')
    const bots = all.filter((c) => c.kind === 'bot')
    return { me, humans, bots }
  }

  function groups() {
    return chats()
      .filter((c) => c.chat_mode === 'group' || c.chat_mode === 'topic')
      .sort((a, b) => b.update_time - a.update_time)
  }

  function totalUnread() {
    return chats().reduce((sum, c) => sum + (c.unread_count || 0), 0)
  }

  function findP2P(openId) {
    return chats().find((c) => c.chat_mode === 'p2p' && c.p2p_target_id === openId) || null
  }

  // -------------------------------------------------------------------------
  // mutations
  // -------------------------------------------------------------------------

  function nowMessage(patch) {
    return M.newMessage(patch)
  }

  function sendMessage(chatId, text, opts) {
    const o = opts || {}
    const body = String(text == null ? '' : text)
    if (!body.trim() && !o.msgType) return null
    const me = selfChatter()
    const list = data().messages[chatId] || (data().messages[chatId] = [])
    const msg = nowMessage({
      chat_id: chatId,
      root_id: o.rootId || '',
      parent_id: o.rootId || '',
      thread_id: o.rootId || '',
      msg_type: o.msgType || 'text',
      content: o.content || M.textBody(body),
      sender: {
        id: me.open_id,
        id_type: 'open_id',
        sender_type: 'user',
        name: me.name,
        avatar_color: me.avatar_color,
        avatar_text: me.avatar_text
      }
    })
    // 转发过来的消息记住它从谁那儿来，界面上标一行「转发自 X」。
    if (o.forwardedFrom) msg.forwarded_from = o.forwardedFrom
    // 引用回复：把被引用那条的说话人和原话一起存下，界面上画成一小块。
    if (o.quoted) msg.quoted = o.quoted
    list.push(msg)
    const c = chat(chatId)
    if (c) {
      c.update_time = msg.create_time
      c.unread_count = 0
      c.last_read_time = msg.create_time
    }
    touch('message')
    return msg
  }

  function receiveMessage(chatId, openId, text) {
    const c = chat(chatId)
    if (!c) return null
    const person = chatter(openId) || { name: '未知用户', avatar_color: '#8f959e', avatar_text: '?' }
    const list = data().messages[chatId] || (data().messages[chatId] = [])
    const msg = nowMessage({
      chat_id: chatId,
      content: M.textBody(text),
      sender: {
        id: openId,
        id_type: 'open_id',
        sender_type: 'user',
        name: person.name,
        avatar_color: person.avatar_color,
        avatar_text: person.avatar_text
      }
    })
    list.push(msg)
    c.update_time = msg.create_time
    c.unread_count = (c.unread_count || 0) + 1
    touch('message')
    return msg
  }

  function deleteMessage(chatId, messageId) {
    const m = message(chatId, messageId)
    if (!m) return
    m.deleted = true
    m.update_time = Date.now()
    touch('message')
  }

  function toggleReaction(chatId, messageId, emoji) {
    const m = message(chatId, messageId)
    if (!m) return
    const me = selfChatter().open_id
    m.reactions = m.reactions || []
    let r = m.reactions.find((x) => x.emoji_type === emoji)
    if (!r) {
      r = { emoji_type: emoji, count: 0, operators: [] }
      m.reactions.push(r)
    }
    const idx = r.operators.indexOf(me)
    if (idx >= 0) {
      r.operators.splice(idx, 1)
      r.count = Math.max(0, r.count - 1)
    } else {
      r.operators.push(me)
      r.count += 1
    }
    m.reactions = m.reactions.filter((x) => x.count > 0)
    touch('message')
  }

  function markRead(chatId) {
    const c = chat(chatId)
    if (!c || !c.unread_count) return
    c.unread_count = 0
    c.last_read_time = Date.now()
    touch('chat')
  }

  function togglePin(chatId) {
    const c = chat(chatId)
    if (!c) return
    c.is_pinned = !c.is_pinned
    touch('chat')
  }

  function toggleMute(chatId) {
    const c = chat(chatId)
    if (!c) return
    c.is_muted = !c.is_muted
    touch('chat')
  }

  function toggleArchive(chatId) {
    const c = chat(chatId)
    if (!c) return
    c.is_archived = !c.is_archived
    touch('chat')
  }

  function updateChat(chatId, patch) {
    const c = chat(chatId)
    if (!c) return
    Object.assign(c, patch)
    if (patch.member_ids) c.member_count = patch.member_ids.length
    c.update_time = Date.now()
    touch('chat')
  }

  function deleteChat(chatId) {
    const d = data()
    d.chats = d.chats.filter((c) => c.chat_id !== chatId)
    delete d.messages[chatId]
    touch('chat')
  }

  function ensureP2P(openId) {
    const existing = findP2P(openId)
    if (existing) return existing
    const person = chatter(openId)
    if (!person) return null
    const me = selfChatter()
    const c = M.newChat({
      name: person.name,
      chat_mode: 'p2p',
      p2p_target_id: openId,
      avatar_color: person.avatar_color || M.colorFor(person.name),
      avatar_text: person.avatar_text || M.initialsOf(person.name),
      member_ids: [me.open_id, openId]
    })
    data().chats.push(c)
    data().messages[c.chat_id] = []
    touch('chat')
    return c
  }

  // 往这个组织里加一个机器人。机器人有名字和「它负责什么」，没有部门、城市、邮箱。
  function addFriend(fields) {
    const person = M.newChatter({
      name: fields.name,
      gender: fields.gender,
      position: fields.position,
      personality: fields.personality,
      is_friend: true,
      kind: 'bot'
    })
    data().chatters.push(person)
    touch('chatter')
    if (fields.andChat !== false) ensureP2P(person.open_id)
    return person
  }

  function removeFriend(openId) {
    const d = data()
    d.chatters = d.chatters.map((c) =>
      c.open_id === openId ? Object.assign({}, c, { is_friend: false }) : c
    )
    touch('chatter')
  }

  function createGroup(fields) {
    const me = selfChatter()
    const memberIds = Array.from(new Set([me.open_id].concat(fields.memberIds || [])))
    const c = M.newChat({
      name: fields.name || '新群聊',
      chat_mode: fields.chat_mode === 'topic' ? 'topic' : 'group',
      chat_type: fields.chat_type || 'private',
      description: fields.description || '',
      owner_id: me.open_id,
      member_ids: memberIds
    })
    data().chats.push(c)
    data().messages[c.chat_id] = [
      M.newMessage({
        chat_id: c.chat_id,
        msg_type: 'system',
        content: M.textBody(
          me.name + ' 创建了群聊「' + c.name + '」，并邀请了 ' + (memberIds.length - 1) + ' 位成员'
        ),
        sender: { id: 'system', id_type: 'open_id', sender_type: 'system', name: 'system' }
      })
    ]
    touch('chat')
    return c
  }

  function setDraft(chatId, text) {
    const d = data()
    d.drafts = d.drafts || {}
    if (text) d.drafts[chatId] = text
    else delete d.drafts[chatId]
    scheduleSave()
  }

  function draft(chatId) {
    const d = data()
    return (d.drafts && d.drafts[chatId]) || ''
  }

  function setSetting(key, value) {
    data().settings[key] = value
    touch('settings')
  }

  function setting(key, fallback) {
    const s = data().settings || {}
    return s[key] === undefined ? fallback : s[key]
  }

  // -------------------------------------------------------------------------
  // 模型设置（机器级，不属于任何组织）
  //
  // 原型里原来没有这一块。现在「说话那半」要把请求发给哪家、用哪个模型、
  // 拿什么 key 换，都得有个地方记，而它和组织无关——换组织不该换模型。
  // key 只记「有没有」和尾号四位：界面上永远不再显示整串，
  // 要换就整串覆盖。这是设计的意图，不是原型的偷懒。
  // -------------------------------------------------------------------------

  const LLM_DEFAULTS = {
    baseUrl: 'https://atp-dev.shenbiai.net/v1',
    model: 'deepseek-flash',
    keyTail: '',      // 空＝没存过 key
    keyLen: 0,
    // 这三样到底是从哪儿读来的。这台机器上可能有三份说法：
    //   emrg   = EMRG 的 ~/.emrg/config.toml 里那份（用户装 Seek 之前就有的）
    //   own    = 就在设置页那张卡片里按过「保存」
    //   env    = 启动 Seek 时给的环境变量（改了也不会写回文件）
    // 界面上必须说清楚，否则人改了半天不知道改的是哪一份。
    origin: 'emrg'
  }

  function llm() {
    if (!state.data.llm) state.data.llm = Object.assign({}, LLM_DEFAULTS)
    const cur = state.data.llm
    Object.keys(LLM_DEFAULTS).forEach((k) => {
      if (cur[k] === undefined) cur[k] = LLM_DEFAULTS[k]
    })
    return cur
  }

  function setLlm(patch) {
    Object.assign(llm(), patch)
    touch('llm')
  }

  function setTheme(theme) {
    state.data.theme = theme
    if (window.seekHost && window.seekHost.setTheme) window.seekHost.setTheme(theme)
    touch('theme')
  }

  function switchOrg(orgId) {
    if (!state.data.store[orgId]) return
    state.data.currentOrgId = orgId
    touch('org')
  }

  // 组织名只是一个展示标签：改它只改这一行文字。
  // 它不同步到房间里「我」的名字，也不改这个组织里的任何一条数据。
  function renameOrg(name) {
    const next = String(name || '').trim()
    if (!next) return false
    org().name = next
    touch('org')
    return true
  }

  // 新建组织只问一个名字。名字是标签，数据从空白开始，
  // 落在自己的目录里（seek-data/<dir>/），和别的组织一个字都不共享。
  function addOrg(name) {
    const label = String(name || '').trim()
    if (!label) return null
    const orgId = M.uid('org')
    const self = M.newChatter({ name: '我', is_self: true })
    const org = {
      org_id: orgId,
      dir: orgId,
      open_id: self.open_id,
      name: label,
      created_at: Date.now()
    }
    state.data.orgs.push(org)
    state.data.store[orgId] = {
      chatters: [self],
      chats: [],
      messages: {},
      drafts: {},
      // Enter 发送、Shift+Enter 换行是固定的，不存成设置项
      settings: {}
    }
    state.data.currentOrgId = orgId
    touch('org')
    return org
  }

  // 删除组织＝连目录一起删：列表里那一行和 seek-data/<dir>/ 里的东西一起没掉，
  // 没有回收站，也找不回来。调用方必须先问过一遍。
  function removeOrg(orgId) {
    const d = state.data
    if (d.orgs.length <= 1) return false
    d.orgs = d.orgs.filter((a) => a.org_id !== orgId)
    delete d.store[orgId]
    if (d.currentOrgId === orgId) d.currentOrgId = d.orgs[0].org_id
    touch('org')
    return true
  }

  function search(query, scope) {
    const q = String(query || '').trim().toLowerCase()
    if (!q) return { chats: [], chatters: [], messages: [] }
    const out = { chats: [], chatters: [], messages: [] }
    if (scope !== 'message') {
      out.chats = chats().filter((c) => c.name.toLowerCase().includes(q))
      out.chatters = data()
        .chatters.filter((c) => !c.is_self && c.name.toLowerCase().includes(q))
    }
    const all = data().messages
    Object.keys(all).forEach((chatId) => {
      const c = chat(chatId)
      if (!c) return
      all[chatId].forEach((m) => {
        if (m.deleted || m.msg_type === 'system') return
        const t = M.bodyText(m)
        if (t.toLowerCase().includes(q)) out.messages.push({ chat: c, message: m })
      })
    })
    out.messages.sort((a, b) => b.message.create_time - a.message.create_time)
    out.messages = out.messages.slice(0, 50)
    return out
  }

  // -------------------------------------------------------------------------
  // export / import (plain JSON on disk, human readable)
  // -------------------------------------------------------------------------

  function exportJSON() {
    return JSON.stringify(state.data, null, 2)
  }

  window.Store = {
    init,
    flush,
    subscribe,
    emit,
    state,
    org,
    data,
    selfChatter,
    chats,
    sortedChats,
    chat,
    chatter,
    messages,
    message,
    lastMessage,
    topics,
    replies,
    friends,
    roster,
    groups,
    totalUnread,
    findP2P,
    sendMessage,
    receiveMessage,
    deleteMessage,
    toggleReaction,
    markRead,
    togglePin,
    toggleMute,
    toggleArchive,
    updateChat,
    deleteChat,
    ensureP2P,
    addFriend,
    removeFriend,
    createGroup,
    setDraft,
    draft,
    setSetting,
    setting,
    setTheme,
    llm,
    setLlm,
    switchOrg,
    renameOrg,
    addOrg,
    removeOrg,
    search,
    exportJSON
  }
})()
