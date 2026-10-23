# seek 数据模型 v1（实体与关系）

> 宿主 2026-10-23 18:34：先把数据模型设计好——Agent、群、聊天、session、thread 等等，大的有哪几块、之间什么关系，先不管细节。
>
> 本文合并两条既有线：9 月定稿的实体关系（`~/.emrg/designs/seek-entity-relations-v1.md`：房间 ≠ 会话、不按人数分类、工作空间绑会话）
> 与 10-23 定下的长存活 Agent（`agent-lifecycle.md`：身份、观察、主循环、主动动作）。
> 冲突处在 §7 显式列出，由宿主拍板。

---

## 1. 一句话

**消息是共享的事实，上下文是私有的解释；房间里住着成员，成员背后是长期存活的 Agent。**

这句话定住了整个模型最难的一处：群里有五个 Agent，不代表有五份消息——只有一份消息日志，五份各自的看法。

---

## 2. 实体分四层

```
存在层   Principal（Human / Agent）——「谁」
空间层   Room + Membership        ——「在哪」
时间层   Session / Message / Thread ——「什么时候、说了什么」
执行层   Workspace / Turn / Observation / Memory ——「怎么干活、花了多少」
```

### 2.1 存在层

| 实体 | 是什么 | 关键点 |
|---|---|---|
| **Principal** | 一切能说话的主体，`kind = human \| agent` | 头像、名字、`description`（自我介绍，别人据此判断该不该找它） |
| **Human** | 你（v1 只有「我」一个） | 也是一种 Principal，没有特权 |
| **Agent** | 长期存活的机器人 | 比 Principal 多出：人设、能力、观察、记忆、状态、预算 —— **它不属于任何房间，房间是它出现的地方** |

> **关键区分**：Member 是 Agent 在某个房间里的**投影**，不是 Agent 本身。
> 飞书把 bot 做成「成员的一种」，够用；seek 不行，因为 Agent 有跨房间的生命、记忆和预算。

### 2.2 空间层

| 实体 | 是什么 | 关键点 |
|---|---|---|
| **Room** | 一群参与者聊天的地方 = 群 | 独立 id、成员可增删、**不按人数分类**；私聊只是「两个人的房间」，不是另一种类型；共享一份消息日志 |
| **Membership** | Room × Principal 的关系实体 | 必须独立存在，因为同一个人在不同房间身份不同：加入时间、角色（群主/成员）、已读位、免打扰、**是否被观察** |

### 2.3 时间层

| 实体 | 是什么 | 关键点 |
|---|---|---|
| **Message** | 不可变的共享事实 | 属于一个 Room；可属于一个 Thread；发件人 = Principal 或 system；类型 = 文字/图片/文件/**工具卡片**/系统提示 |
| **Thread** | 「话题」= 以某条消息为根的子消息树 | **不是新房间**（飞书式，不是 Slack/Discord 式）；话题里的人就是群里的人，不用重新邀请 |
| **Session** | 房间里的一段工作时段 | 有开始与结束、**绑定一个 Workspace**、可绑一个任务；是计费与「上次聊到哪」的单位 |

### 2.4 执行层

| 实体 | 是什么 | 关键点 |
|---|---|---|
| **Workspace** | 干活的地方 = 一个目录/项目 | 今天 EMRG 的 `cwd`；被 Session 绑定，被 Agent 使用 |
| **Turn** | Agent 的一次动作 | 由什么触发（哪条消息、哪次判定）、花了多少 token、调了哪些工具、产出了哪些消息 —— **成本与审计的原子单位** |
| **Observation** | Agent 的待观察条目 | 引用一条 Message + 零成本提示（是否 @ 我、有无问句、是否回我…）+ 判定结果（ignore/snooze/keep/act） |
| **Memory** | 三层记忆 | Agent 日记（跨房间长存）/ 房间摘要（每房间滚动）/ 会话记忆（= EMRG 今天的会话记忆） |

---

## 3. 关系图

```
                        Principal  (kind: human | agent)
                            │
              ┌─────────────┴──────────────┐
              │ Membership（房间投影）      │ 拥有
              ▼                            ├── Agent 的专属：人设 / 能力 / 预算
        ┌─────────── Room ───────────┐     ├── Observation ──▶ 引用 Message
        │   共享消息日志              │     ├── Memory（日记 / 房间摘要）
        └──┬──────────────────┬──────┘     └── Turn ──▶ 产出 Message
           │ 1:N              │ 1:N
           ▼                  ▼
       Session            Message ◀── root_id 自引用 ── Thread（视图）
           │                  ▲
           │ 绑定 1:1          │
           ▼                  │
       Workspace ──────────────┘（工具在 Workspace 里跑）
```

## 4. 基数与规则（必须成立的十条）

1. **Room 1 : N Message**。消息必属一个房间，不可跨房间。
2. **Message 0..1 : N Thread**。一条消息最多是一个话题的根；话题不跨房间。
3. **Room 1 : N Session**。会话不跨房间；一个房间可以有很多段。
4. **Session 1 : 1 Workspace**（选定锁定，9 月已定）；Workspace 1 : N Session。
5. **Principal N : M Room**，经 Membership 承载各自状态。
6. **Agent 1 : N Observation**，Observation N : 1 Message（同一条消息可进入多个 Agent 的观察）。
7. **Agent 1 : N Turn**；Turn 1 : N Message（一次动作可以说多句）。
8. **Agent 1 : 1 Memory 库**（含 N 个房间摘要 + 1 份日记）。
9. **Human 1 : 1 身份**（v1），预留多自我。
10. **一切 id 前缀沿用飞书**：`ou_` 主体、`oc_` 房间、`om_` 消息，Agent 加 `ag_`（可读性优先，不做通用 UUID）。

## 5. 三处容易搞错的

1. **「群」与「会话」不是同一个东西，但界面上都叫会话。**
   模型里 Room 是容器，Session 是容器里的一段时间；UI 文案不必暴露这个区分，但数据里必须有，否则「换工作空间」「算这次花了多少」无处安放。

2. **话题不是房间。**
   Slack 的话题是消息、Discord 的话题是频道；seek 取飞书式：**话题是消息树**。理由：话题里的人永远是原房间里的人，不需要重新拉人、重新配权限。

3. **私聊不是类型，是人数。**
   两个人的房间和五十个人的房间，逻辑一模一样。任何代码里出现 `if (chat_mode === 'p2p')` 做特殊分支，都是在把模型搞坏。

## 6. 与参考产品的对照（为什么这样切）

| 概念 | 飞书 | Slack / Discord | grok-bot | ADK | **seek** |
|---|---|---|---|---|---|
| 聊天容器 | chat（p2p/group/topic） | channel | Room | — | **Room**（不分类） |
| 话题 | thread（消息树） | Slack：消息；Discord：子频道 | — | `sub_agents` | **Thread（消息树）** |
| 一段时间 | 无 | 无 | turn 轮次 | **Session（事件序列）** | **Session** |
| 执行者 | bot（成员的一种） | bot | agent（成员） | **Agent（配置+行为）** | **Agent（长期存活）** |
| 共享 vs 私有 | 全共享 | 全共享 | 全共享 | 分得最清 | **消息共享，上下文私有** |

**seek 独有的两件事**：①Agent 是跨房间的长存实体，房间只是它出现的地方；②消息共享而上下文私有——这一条是「五个 Agent 在群里」能成立的前提。

## 7. 与既有决定的冲突（需宿主拍板）

| # | 冲突 | 9 月的选择 | 今天的现实 | 建议 |
|---|---|---|---|---|
| 1 | **左侧列表显示什么** | 打开中的「会话」列表 | 现在显示「房间」列表（飞书同款） | 见 `docs/decisions.md` 的未决项 |
| 2 | Session 是否对用户可见 | 是（新会话要选工作空间） | 完全不可见，没有这个概念 | 做成时间线里的一条分隔条（「新的一段 · 绑定 ~/Downloads/seek」），不单独占列表位 |
| 3 | 角色 kind | human \| virtual | 现在是纯 `chatter`，无 kind | 改成 `human \| agent`，与 Agent 实体对齐 |
| 4 | 工作空间绑谁 | 绑 Session | 尚无 | 沿用 9 月：绑 Session；Agent 另有一个「默认工作空间」 |
| 5 | 成员是否带快照 | 未定 | 未定 | 会话开始时的成员快照留在 Session 上（否则「谁在我进群前说的这话」无法回答） |

## 8. 数据落盘形态（一句话，不展开）

一个账号一份 `seek.json`（今天已有），拆成 `principals / rooms / memberships / sessions / messages[roomId] / observations[agentId] / turns / memories` 七块。
消息按房间分片，观察按 Agent 分片——这两块都会长得最快，必须能单独裁剪而不动别的。
