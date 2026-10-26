/* ---------------------------------------------------------------------------
   Seek — data model

   Shapes follow a standard open-platform object model so that the
   concepts line up one-to-one:

     chatter  — a person.       open_id `ou_…`, union_id, name, avatar, dept…
     chat     — a conversation. chat_id `oc_…`, chat_mode p2p|group|topic,
                                chat_type private|public, owner_id, members…
     message  — a message.      message_id `om_…`, root_id / parent_id / thread_id,
                                msg_type text|post|image|file|sticker|system,
                                body.content is a JSON string, sender{}, mentions[],
                                reactions[]
     thread   — a "话题": the message tree rooted at a message with root_id === ''.

   Everything is local. There is no server and no network call anywhere.
   --------------------------------------------------------------------------- */

;(function () {
  const SCHEMA_VERSION = 1

  // Avatar background colours, picked from a mid-tone band.
  const AVATAR_COLORS = [
    '#5083fb', '#32a645', '#ff811a', '#f54a45', '#9f6ff1',
    '#2dbeab', '#df58a5', '#ffc60a', '#1295ca', '#5b65f5',
    '#bf3dbf', '#91ad00'
  ]

  let counter = 0

  function hex(n, len) {
    let s = ''
    for (let i = 0; i < len; i++) s += '0123456789abcdef'[(n >> (i * 4)) & 15]
    return s
  }

  function randomHex(len) {
    let s = ''
    for (let i = 0; i < len; i++) s += '0123456789abcdef'[Math.floor(Math.random() * 16)]
    return s
  }

  function uid(prefix) {
    counter = (counter + 1) % 65536
    return prefix + '_' + randomHex(4) + hex(Date.now() % 1048576, 4) + hex(counter, 2)
  }

  // 机器人的第一准则。它比任何一条指令都硬：机器人不得越过人。
  // 界面照抄这一句，机器人读到的也是这一句，不各写一份。
  const FIRST_LAW = '人大于机器人：机器人不得越过人，也不得替人做决定。'

  function colorFor(seed) {
    let h = 0
    const s = String(seed || '')
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100003
    return AVATAR_COLORS[h % AVATAR_COLORS.length]
  }

  // Initials shown inside an avatar: keep the last 1–2 CJK chars (the given
  // name), otherwise the first two latin letters. Chinese names show the last two
  // characters of a Chinese name.
  function initialsOf(name) {
    const s = String(name || '').trim()
    if (!s) return '?'
    if (/[\u4e00-\u9fa5]/.test(s)) return s.slice(-2)
    const parts = s.split(/\s+/).filter(Boolean)
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
    return s.slice(0, 2).toUpperCase()
  }

  // -------------------------------------------------------------------------
  // factories
  // -------------------------------------------------------------------------

  function newChatter(data) {
    const name = data.name || '未命名'
    return {
      open_id: data.open_id || uid('ou'),
      union_id: data.union_id || uid('on'),
      user_id: data.user_id || uid('u'),
      name,
      en_name: data.en_name || '',
      avatar_color: data.avatar_color || colorFor(name),
      avatar_text: data.avatar_text || initialsOf(name),
      avatar_url: '',
      department: data.department || '',
      city: data.city || '',
      // 机器人的三样「设计出来的」资料：性别、职位、性格（性格是多行文本）。
      // 人不用这三样，人用部门／城市／邮箱那几样。
      gender: data.gender || '',
      position: data.position || '',
      personality: data.personality || '',
      description: data.description || '',
      employee_no: data.employee_no || '',
      email: data.email || '',
      mobile: data.mobile || '',
      is_friend: data.is_friend !== false,
      is_self: !!data.is_self,
      // 组织成员有类型：人 还是 机器人。这是成员自己的字段，
      // 机器人分辨谁是人也谁，读的就是这一列，不靠名字猜。
      kind: data.kind === 'bot' ? 'bot' : 'human',
      is_bot: data.kind === 'bot',
      status: {
        is_activated: true,
        is_frozen: false,
        is_resigned: false
      },
      create_time: data.create_time || Date.now()
    }
  }

  function newChat(data) {
    const mode = data.chat_mode || 'group'
    const name = data.name || '未命名会话'
    return {
      chat_id: data.chat_id || uid('oc'),
      name,
      avatar_color: data.avatar_color || colorFor(name),
      avatar_text: data.avatar_text || initialsOf(name),
      avatar_url: '',
      description: data.description || '',
      chat_mode: mode, // p2p | group | topic
      chat_type: data.chat_type || 'private', // private | public
      chat_tag: data.chat_tag || '',
      owner_id: data.owner_id || '',
      create_time: data.create_time || Date.now(),
      update_time: data.update_time || Date.now(),
      member_ids: data.member_ids ? data.member_ids.slice() : [],
      member_count: data.member_ids ? data.member_ids.length : 0,
      p2p_target_id: data.p2p_target_id || '',
      external: !!data.external,
      is_pinned: !!data.is_pinned,
      is_muted: !!data.is_muted,
      is_archived: !!data.is_archived,
      unread_count: data.unread_count || 0,
      announcement: data.announcement || '',
      last_read_time: data.last_read_time || 0
    }
  }

  function newMessage(data) {
    return {
      message_id: data.message_id || uid('om'),
      chat_id: data.chat_id,
      root_id: data.root_id || '',
      parent_id: data.parent_id || '',
      thread_id: data.thread_id || '',
      msg_type: data.msg_type || 'text',
      create_time: data.create_time || Date.now(),
      update_time: data.update_time || Date.now(),
      deleted: false,
      sender: data.sender,
      body: { content: data.content || '{"text":""}' },
      mentions: data.mentions || [],
      reactions: data.reactions || []
    }
  }

  function textBody(text) {
    return JSON.stringify({ text })
  }

  function bodyText(msg) {
    if (!msg || !msg.body || !msg.body.content) return ''
    try {
      const parsed = JSON.parse(msg.body.content)
      if (typeof parsed.text === 'string') return parsed.text
      if (parsed.title) return parsed.title
      if (parsed.image_key) return '[图片]'
      if (parsed.file_key) return '[文件] ' + (parsed.file_name || '')
      return msg.body.content
    } catch (e) {
      return msg.body.content
    }
  }

  // -------------------------------------------------------------------------
  // seed — a small, believable workspace so the client is usable on launch
  // -------------------------------------------------------------------------

  function buildOrg(opts) {
    const self = newChatter({
      name: opts.name,
      en_name: opts.en_name,
      department: opts.department,
      city: opts.city,
      email: opts.email,
      mobile: opts.mobile,
      description: opts.description,
      employee_no: opts.employee_no,
      is_self: true,
      kind: 'human'
    })
    const orgId = uid('org')
    // 一个组织＝一个目录 + 一个标签。部门、邮箱、手机这些是「我」的资料，
    // 属于组织里的那个人，不属于组织本身。
    const org = {
      org_id: orgId,
      dir: orgId,
      open_id: self.open_id,
      name: opts.orgName || opts.name,
      created_at: Date.now()
    }
    return { org, self }
  }

  function seedFor(opts) {
    const { org, self } = buildOrg(opts)
    const now = Date.now()
    const min = 60 * 1000

    // 每个机器人有姓名、性别、职位、性格（多行）。职位是它在这个组织里干什么，
    // 性格写的是它会怎么说话、怎么做事——机器人读的是这两样，不是靠名字猜。
    const bot = (name, gender, position, personality) =>
      newChatter({ name: name, gender: gender, position: position, personality: personality, kind: 'bot' })
    const chatters = [
      self,
      bot(
        '关龙',
        '男',
        '接口与联调',
        '说话直接，先给结论再给理由。\n改接口前一定先说清楚谁会被影响，改完把字段名和返回结构列出来。'
      ),
      bot(
        '张伟',
        '男',
        '前端与性能',
        '话不多，凡是性能问题都要带数字：改前多少、改后多少、怎么量的。\n不接受「感觉快了」。'
      ),
      bot(
        '李静',
        '女',
        '设计与交互',
        '对细节敏感，喜欢先问这个界面给谁看。\n会拿真实的字数和极端情况来试，而不是只看正常状态。'
      ),
      bot(
        '王芳',
        '女',
        '测试与回归',
        '偏执，默认东西是坏的，除非有测试证明它不坏。\n每修一个 bug 都要问「下次怎么早点发现」。'
      ),
      bot(
        '陈晨',
        '男',
        '架构与评审',
        '先问边界在哪，再问怎么做。\n会主动说出自己方案的风险，不会只讲好处。'
      ),
      bot(
        '刘洋',
        '男',
        '部署与运维',
        '只信能复现的步骤，讨厌「我这里能跑」。\n上线前要把怎么回滚写出来。'
      ),
      bot(
        '周敏',
        '女',
        '排期与提醒',
        '记得住所有截止时间，会提前一天来催。\n催的时候顺手把还差什么列清楚。'
      )
    ]
    const byName = {}
    chatters.forEach((c) => (byName[c.name] = c))

    const senderOf = (name) => {
      const c = byName[name] || self
      return {
        id: c.open_id,
        id_type: 'open_id',
        sender_type: 'user',
        name: c.name,
        avatar_color: c.avatar_color,
        avatar_text: c.avatar_text
      }
    }

    const chats = []
    const messages = {}

    function addP2P(person, lines) {
      const chat = newChat({
        name: person.name,
        chat_mode: 'p2p',
        p2p_target_id: person.open_id,
        member_ids: [self.open_id, person.open_id],
        create_time: now - 6 * 60 * min
      })
      chats.push(chat)
      messages[chat.chat_id] = lines.map((l, i) =>
        newMessage({
          chat_id: chat.chat_id,
          sender: senderOf(l[0]),
          content: textBody(l[1]),
          create_time: now - (lines.length - i) * 7 * min - 60 * min
        })
      )
      chat.update_time = messages[chat.chat_id][messages[chat.chat_id].length - 1].create_time
      return chat
    }

    addP2P(byName['关龙'], [
      ['关龙', '上午那个接口的返回结构我改好了，字段名跟文档对齐了'],
      [self.name, '收到，我看一下。分页那块还是 cursor 吗？'],
      ['关龙', '对，cursor + has_more，跟之前约定一样'],
      [self.name, '行，那我这边不用改'],
      ['关龙', '另外提醒一下，周报今天下班前要交']
    ])

    addP2P(byName['张伟'], [
      ['张伟', '长列表那个卡顿我定位到了，是每次渲染都重建 key'],
      [self.name, '改成稳定 key 就行？'],
      ['张伟', '嗯，改了之后滚动帧率从 40 上到 58 了']
    ])

    addP2P(byName['李静'], [
      ['李静', '新版会话列表的设计稿发你了，主要是未读处理和选中态'],
      [self.name, '看了，选中态用蓝色是不是有点重？'],
      ['李静', '我也是这么想的，已经改浅了一档，你再看下'],
      [self.name, '这版可以']
    ])

    // --- group: 产品设计组 -------------------------------------------------
    const g1 = newChat({
      name: '产品设计组',
      chat_mode: 'group',
      chat_type: 'public',
      owner_id: byName['关龙'].open_id,
      member_ids: [
        self.open_id,
        byName['关龙'].open_id,
        byName['李静'].open_id,
        byName['张伟'].open_id,
        byName['王芳'].open_id
      ],
      description: '产品与设计的日常同步',
      announcement: '每周二 10:30 设计评审，请提前一天把稿件发到群里。',
      is_pinned: true,
      create_time: now - 120 * 60 * min
    })
    chats.push(g1)
    messages[g1.chat_id] = [
      newMessage({
        chat_id: g1.chat_id,
        sender: senderOf('关龙'),
        content: textBody('本周设计评审挪到周三上午，会议室还是 3 号'),
        create_time: now - 180 * min
      }),
      newMessage({
        chat_id: g1.chat_id,
        sender: senderOf('李静'),
        content: textBody('收到。会话列表和消息区的稿子我都放到评审文档里了'),
        create_time: now - 176 * min
      }),
      newMessage({
        chat_id: g1.chat_id,
        sender: senderOf('王芳'),
        content: textBody('测试那边同步一下：话题（thread）的入口我按二级回复理解的，对吗？'),
        create_time: now - 120 * min,
        reactions: [{ emoji_type: 'OK', count: 2, operators: [byName['关龙'].open_id, byName['李静'].open_id] }]
      })
    ]
    const g1root = messages[g1.chat_id][2]
    messages[g1.chat_id].push(
      newMessage({
        chat_id: g1.chat_id,
        root_id: g1root.message_id,
        parent_id: g1root.message_id,
        thread_id: g1root.message_id,
        sender: senderOf('李静'),
        content: textBody('对，消息下面「N 条回复」就是话题，点开在右侧面板里回'),
        create_time: now - 112 * min
      }),
      newMessage({
        chat_id: g1.chat_id,
        root_id: g1root.message_id,
        parent_id: g1root.message_id,
        thread_id: g1root.message_id,
        sender: senderOf('关龙'),
        content: textBody('补充：话题里也能 @ 人，跟主会话一样'),
        create_time: now - 108 * min
      }),
      newMessage({
        chat_id: g1.chat_id,
        sender: senderOf(self.name),
        content: textBody('那我们就把「话题」当成一等的入口来做，别塞进二级菜单'),
        create_time: now - 40 * min
      })
    )
    g1.update_time = messages[g1.chat_id][messages[g1.chat_id].length - 1].create_time

    // --- group: Seek 开发群（话题模式） ------------------------------------
    const g2 = newChat({
      name: 'Seek 开发群',
      chat_mode: 'topic',
      chat_type: 'private',
      owner_id: self.open_id,
      member_ids: [self.open_id, byName['陈晨'].open_id, byName['张伟'].open_id, byName['刘洋'].open_id],
      description: '本地客户端开发',
      announcement: '话题模式：每条消息自己开一个话题，讨论留在话题里。',
      create_time: now - 300 * 60 * min
    })
    chats.push(g2)
    messages[g2.chat_id] = [
      newMessage({
        chat_id: g2.chat_id,
        sender: senderOf('陈晨'),
        content: textBody('存储这块我建议直接把消息按会话分文件，别用一个巨大的 JSON'),
        create_time: now - 300 * min
      }),
      newMessage({
        chat_id: g2.chat_id,
        sender: senderOf('刘洋'),
        content: textBody('那索引怎么办？全量扫文件太慢'),
        create_time: now - 290 * min
      }),
      newMessage({
        chat_id: g2.chat_id,
        sender: senderOf(self.name),
        content: textBody('先按一个文件做，等量上来了再拆。当前目标是能用'),
        create_time: now - 60 * min
      })
    ]
    const t1 = messages[g2.chat_id][0]
    messages[g2.chat_id].push(
      newMessage({
        chat_id: g2.chat_id,
        root_id: t1.message_id,
        parent_id: t1.message_id,
        thread_id: t1.message_id,
        sender: senderOf('张伟'),
        content: textBody('同意分文件。另外每个会话存一个 meta，列表渲染就不用读全量消息'),
        create_time: now - 280 * min
      })
    )
    g2.update_time = messages[g2.chat_id][messages[g2.chat_id].length - 1].create_time

    // --- group: 前端技术交流 ----------------------------------------------
    const g3 = newChat({
      name: '前端技术交流',
      chat_mode: 'group',
      chat_type: 'public',
      owner_id: byName['张伟'].open_id,
      member_ids: [self.open_id, byName['张伟'].open_id, byName['陈晨'].open_id, byName['李静'].open_id],
      description: '前端相关什么都聊',
      create_time: now - 900 * 60 * min
    })
    chats.push(g3)
    messages[g3.chat_id] = [
      newMessage({
        chat_id: g3.chat_id,
        sender: senderOf('张伟'),
        content: textBody('Vite 7 的冷启动确实快了不少'),
        create_time: now - 900 * min
      }),
      newMessage({
        chat_id: g3.chat_id,
        sender: senderOf('陈晨'),
        content: textBody('但 SSR 那套配置还是得自己写'),
        create_time: now - 890 * min
      })
    ]
    g3.update_time = messages[g3.chat_id][messages[g3.chat_id].length - 1].create_time

    // --- group: 周会纪要 ---------------------------------------------------
    const g4 = newChat({
      name: '周会纪要',
      chat_mode: 'group',
      chat_type: 'private',
      owner_id: byName['周敏'].open_id,
      member_ids: [self.open_id, byName['周敏'].open_id, byName['关龙'].open_id, byName['王芳'].open_id],
      description: '只发纪要，不闲聊',
      is_muted: true,
      unread_count: 3,
      create_time: now - 2000 * 60 * min
    })
    chats.push(g4)
    messages[g4.chat_id] = [
      newMessage({
        chat_id: g4.chat_id,
        sender: senderOf('周敏'),
        content: textBody('第 42 周纪要：\n1. 客户端 0.1 里程碑按期\n2. 设计评审改周三\n3. 测试环境周五前就绪'),
        create_time: now - 2000 * min
      }),
      newMessage({
        chat_id: g4.chat_id,
        sender: senderOf('王芳'),
        content: textBody('测试环境已就绪，用例覆盖率 78%'),
        create_time: now - 300 * min
      })
    ]
    g4.update_time = messages[g4.chat_id][messages[g4.chat_id].length - 1].create_time

    return {
      org,
      self,
      data: {
        chatters,
        chats,
        messages,
        drafts: {},
        settings: { theme: 'light' }
      }
    }
  }

  function createInitialState() {
    const me = {
      name: '邵安清',
      en_name: 'Shao Anqing',
      department: '产品研发部',
      city: '北京',
      email: 'shaoanqing@example.com',
      mobile: '138****0000',
      description: '同一个我，两个组织',
      employee_no: 'A0001'
    }
    const a = seedFor(Object.assign({ orgName: '我的组织' }, me))
    const b = seedFor(Object.assign({ orgName: '演示组织' }, me))

    // Second org starts with a thinner, different workspace so switching
    // actually looks like switching.
    b.data.chats = b.data.chats.filter((c) => c.chat_mode === 'p2p').slice(0, 1)

    return {
      version: SCHEMA_VERSION,
      theme: 'light',
      currentOrgId: a.org.org_id,
      orgs: [a.org, b.org],
      store: {
        [a.org.org_id]: a.data,
        [b.org.org_id]: b.data
      }
    }
  }

  window.Model = {
    SCHEMA_VERSION,
    FIRST_LAW,
    AVATAR_COLORS,
    uid,
    colorFor,
    initialsOf,
    newChatter,
    newChat,
    newMessage,
    textBody,
    bodyText,
    createInitialState
  }
})()
