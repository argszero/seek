# seek 会话与记忆设计(v3 draft,待宿主纠正)

> 状态:草稿,基于宿主多次纠正后的当前理解。此为讨论载体,非定稿。

## 一、定位

- seek 与 grok 定位一致 = **多 agent 系统**:每个 virtual 角色是独立 agent(persona/工具/说话/私有工具历史独立)。TUI 单聊是 UI 层简化,底层支持一房间多 agent 并行推理。
- seek 与 grok 差异:**有房间(成员容器)+ 房间下有会话(一场真实对话)**。grok 是「房间=会话=agent」三位一体。

## 二、记忆归属(核心)

**记忆跟着 Character 走,每个角色独立一套;每个角色在「某场会话」里有一个视角隔离的目录。** 每个角色两类记忆:

1. **会话级记忆(主要)**:某角色在**某场具体会话**里的记忆。粒度 = `角色 × 会话`。
2. **全局记忆(辅助)**:某角色**跨会话**的长期认知,内容三块:
   - 对自己的认知(我是谁)
   - 对其他角色(虚拟数字人 + 真人)的认知
   - 对「自己参与过哪些房间/哪些会话」的认知

虚拟人和用户(you)都有自己的记忆,各角色独立,互不混淆。

**记忆的组织范式**:记忆是一个**目录** = 一个**索引文件**(MEMORY.md)+ 若干**可能有目录结构的详情文件**。这与 EMRG 的记忆方式(索引 + 详情 .md)一致。

**记忆读写主体 = 角色自己(Agent)**:每个角色知道自己的**两个记忆目录**(会话级 + 全局)在哪,并被提供**记忆专用读写查工具**;我们只规定记忆的**原则与格式**(目录位置、MEMORY.md 索引 + 详情文件结构),**不写死何时读/何时写**——由角色自主决定如何使用这些工具。

## 三、目录拓扑

```
~/.seek/                              # SEEK_HOME
├── characters/<characterId>/        # ⭐每个角色一个目录
│   ├── character.json                #   角色身份(persona/描述/avatar/kind)
│   └── memory/                       #   全局记忆(辅助):该角色跨会话长期认知
│       ├── MEMORY.md                 #   索引
│       └── <topic>.md                #   详情文件(self/others/participation…)
├── rooms/<roomId>/room.json         # 房间成员容器(id/name/memberIds/desc)
├── rooms/<roomId>/sessions/<sessionId>/
│   ├── session.json                 # 会话元数据(id/roomId/name/workspace/时间戳)
│   └── <characterId>/               # ⭐每个成员角色一个目录(角色视角隔离)
│       ├── seek.db                  #   该角色视角的数据库(SQLite,含该角色的历史+私有工具)
│       └── memory/                  #   该角色在本场会话的记忆
│           ├── MEMORY.md            #   索引
│           └── <topic>.md           #   详情文件(可再分目录)
```

归属逻辑:
- **身份**在 `characters/<characterId>/character.json`(人设,不是记忆)。
- **全局记忆(辅助)**在 `characters/<characterId>/memory/`(跨会话)。
- **会话级记忆(主要)**在 `rooms/<roomId>/sessions/<sid>/<characterId>/memory/`(一场会话)。
- **每角色一个 `seek.db`**:该角色**视角**的数据库(历史 + 私有工具,见第五节)。

## 四、seek.db(每角色一个,SQLite)

在每个角色目录 `<characterId>/` 下,`seek.db` 是**该角色视角**的 SQLite。

**核心语义**:每个角色有一份**自己的**会话记录(= 一份视角 transcript)。它包含:
- 该角色**自己**发过的 `send-message`(自己的历史)。
- 该角色**自己**的 `tool-call`(私有工具)。
- **本会话的共享消息**(会话内全体成员的 `send-message`,如 everyone 的发言——这是角色看到的最完整对话上下文)。

也就是说,`seek.db` 记录这一切:该角色看到的所有**共享消息**(全体成员 send-message)+ 该角色**自己的历史** + 该角色**自己的私有工具**。

**多 agent 工具私密**因此是**物理隔离**的:别人的 `tool-call` 根本不写入这个角色的 `seek.db`(只把别人的 `send-message` 共享消息写进来),无需应用层按 viewer_id 过滤。这与 grok「每 agent 一个 store.db」同构。

`seek.db` schema:

```sql
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS transcript_entries (
  seq   INTEGER PRIMARY KEY,
  id    TEXT NOT NULL UNIQUE,
  entry TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_transcript_window
  ON transcript_entries(seq, entry)
  WHERE json_extract(entry, '$.kind') != 'tool-call';
```

entry JSON(该角色视角;身份在 `author`)。**命名约定:用户这个角色统一用「我」**(id 与 name 均为 "我",不用 "you"/"你"):

```json
{"id":"...","kind":"send-message","author":{"id":"a1","name":"a1","kind":"virtual"},
 "message":{"type":"text","content":"..."},"timestampMs":1736300000000}

{"id":"...","kind":"send-message","author":{"id":"我","name":"我","kind":"human"},
 "message":{"type":"text","content":"..."},"timestampMs":1736300005000}

{"id":"...","kind":"tool-call","author":{"id":"a2","name":"a2","kind":"virtual"},
 "tool":{"name":"bash","input":"$ ...","output":"...","status":"success"},
 "timestampMs":1736300006000}
```

- `kind`:`send-message`(发言)/`tool-call`(工具,归属 author)/`user-attachment`/`turn-ended`。
- 该角色不把自己以外角色的 `tool-call` 写进自己的 `seek.db`(物理私密)。

### 会话窗口(在送 LLM 的 context,不在 seek.db)

`seek.db` 里的 transcript **不会被截断**,完整保留。**截断发生在「发送请求给 LLM」之前**——当把我们组装给 LLM 的上下文时(把历史窗口 + 记忆 + 本轮拼成 prompt),为了让 context 不超预算,会**只取最近的窗口**(如最近 N 条 transcript、加载记忆的某部分)。这是 context window 的现实约束。

**关键**:`seek.db`(存储层)是完整的、可靠的长期记录;但**每次送 LLM 只看最近窗口**,所以**想不起旧信息时,得靠记忆或 transcript 回溯工具去查**。记忆(memory 目录)是「提炼过的、随时可注入的」认知;`seek.db` 是「完整的、可回溯的」记录。

**角色策略**:角色**应该知道截断发生在组装 context 时、以及截断(窗口)规则**,从而做出更好的记忆决策——当它判断某条信息重要(结论、决定、关键事实、要长期用的东西)时,应**主动用记忆工具写入 memory**,这样即使某次送 LLM 的窗口没包含它,记忆也能被读取到。临时信息可以靠最近窗口。system prompt 会明确告知:「送给我看的上下文只取最近窗口,完整历史在你的 seek.db 里可回溯;重要信息请写入你的记忆;何时写由你根据规则判断。」

## 五、会话级记忆(主要)

`rooms/<roomId>/sessions/<sid>/<characterId>/memory/` —— 角色 X 在这**一场会话**里记住的事。

每个角色目录下的 `memory/` 是一个「记忆目录」:

```
memory/
├── MEMORY.md        # 索引:每条一行,链接到详情
└── <topic>.md       # 详情文件(可能有目录结构)
```

- **索引 MEMORY.md**:每条一行简短摘要(≤512 字符),链接到详情文件。
- **详情**:按主题拆分(如 `goals.md`/`decisions.md`/`facts.md`,或按日期/来源子目录)——拆分粒度由 LLM 自主决定。
- 一个角色在这场会话里,记住的事都是从这个角色**视角**(自己发的消息 + 自己私有工具)提炼,别人说的话只作为共享背景。
- 该会话级记忆的**索引**在角色发言时自动注入其 system prompt;详情由角色按需读。

## 六、全局记忆(辅助)

`characters/<characterId>/memory/` —— 角色 X 跨会话的长期认知,同样是一个「记忆目录」(索引 + 详情):

```
characters/<characterId>/memory/
├── MEMORY.md        # 索引
└── <topic>.md       # 详情文件,按主题分
```

主题:对自己(self)、对其他角色(others)、对参与过的房间/会话(participation)。
- **self** — 对自己的认知(我是谁/我的角色/我的偏好)。
- **others** — 对其他角色的认知(他们是谁/性格/关系)。
- **participation** — 参与过的哪些房间/哪些会话。
- 详情文件可有子目录结构(如 `others/<characterId>.md` 按角色拆)。

## 七、记忆读写主体与原则(核心)

**记忆的读写主体 = 角色自己(Agent);我们只规定原则和格式,不写死何时读/写。**

- 每个角色的 system prompt 会**明确告知它的两个记忆目录**:
  1. 会话级记忆目录:`rooms/<roomId>/sessions/<sid>/<characterId>/memory/`
  2. 全局记忆目录:`characters/<characterId>/memory/`
- **两类记忆的索引(MEMORY.md)都会自动注入到 system prompt**;是否读详情、是否搜索记忆,由 LLM 自主决定。
- 角色还**知道怎么用 `seek.db`**,并被提供**专门查询/检索它里面特定信息的工具**(见第八节 transcript 工具)。
- 角色**知道「送 LLM 的上下文只取最近窗口」以及窗口规则**(见第四节「会话窗口」),从而能采用更好的记忆写入策略——把重要信息主动写进 memory,以便即使窗口没包含也能查到。
- 给角色提供**记忆专用读写查工具** + **transcript 查询工具**(都不是通用文件 Read/Write 工具)。
- 角色**自主决定什么时候用、用哪个工具、读写什么记忆、写到哪个目录下的哪个详情文件**。
- 记忆**只注入索引,不注入详情**;是否读详情/搜索,由角色自己决定。

**记忆可见性(隔离)**:角色只能读**自己的**两个记忆目录(会话级 + 全局),读不到其他角色的记忆——记忆互相隔离,各角色视角私密。

**为什么这样设计**:记忆是角色自己的认知资产,应由角色自己管理。我们只约定「记忆长什么样(格式)+ 放哪里(原则)+ 有哪些工具(读写查)」,至于**何时读、何时写、写哪些**,交给角色根据当下情境判断——比编排器一刀切提炼更贴合角色个性,也符合「只规定原则和格式,不做工程化死板调度」。

## 八、记忆工具(专有,不混入通用文件工具)

给角色专用工具,分两类:记忆类 + transcript 类。

**记忆工具(针对两个 memory 目录)**:
1. **记忆读**:读取指定记忆目录/主题的索引或详情。
2. **记忆写**:把某条记忆写入指定记忆目录(会话级 → 本场;全局 → characters/<id>/memory/)下的某个详情文件。
3. **记忆查/搜索**:按关键词/主题检索记忆索引(MEMORY.md),找到相关记忆再挑详情读。
4. **记忆删/合并**:删除/合并/去重某条记忆(可选)。

**transcript 工具(针对 seek.db)**:
5. **transcript 查**:查询/检索自己 `seek.db` 里的特定信息——按作者、时间、关键词、kind 等过滤,取历史窗口或全文搜索。角色知道怎么用 `seek.db`,需要回溯「之前谁说过什么」「我之前做过什么」时用它。

> **重要**:读记忆详情/搜索**只走记忆专用工具**(记忆读/记忆查),transcript 只走 transcript 工具;两者**都不混用通用文件工具(Read/Shell)去直接翻记忆目录或 seek.db**。记忆/transcript 是角色自己的认知资产,用专用工具访问更语义化、更贴合"认知资产"心智,且能强制权限隔离(角色只能访问自己的记忆)。

## 九、每轮上下文组装

某角色(a1)要发言时,上下文 =
**system: a1 的 persona(character.json,全量自动注入) + 两个记忆目录的路径说明 + 两记忆索引自动注入(MEMORY.md,只注索引不注详情) + 记忆工具描述 + seek.db(transcript)查询工具描述 + 会话窗口说明**「送给我看的上下文只取最近窗口,完整历史在你的 seek.db 里可回溯;重要信息请写入你的记忆;何时读详情记忆、何时写记忆、何时用 transcript 工具回溯,由你按窗口规则决定」
**+ 历史窗口: a1 的 seek.db 最近 N 条**
**+ 本轮新消息 + 群聊编排(平权轮转/@定向/pass)**

> **注入规则**:`character.json`(persona)全量自动注入;记忆**只注入索引(MEMORY.md)**,详情不注入。记忆详情是否读、搜索与否,由角色自主决定。系统只保证:记忆目录路径明确、格式规范、工具可用、窗口规则在 system prompt 中讲清。

## 十、已确认的决策

以下决策已由宿主确认:

1. **全局记忆的参与记录(participation)**:靠角色自己用记忆工具提炼,**不自动维护**。
2. **记忆目录索引/详情拆分粒度**:由 **LLM 自主决定**怎么组织(按 topic、日期或来源皆可),不硬性规定。
3. **角色记忆读权限**:角色只能读**自己的**两个记忆目录(会话级 + 全局),读不到其他角色的记忆——记忆隔离。
4. **注入规则**:
   - **`character.json`(persona)全量自动注入** system prompt。
   - **记忆只注入索引(MEMORY.md)**(会话级 + 全局两个索引都自动注入);详情不注入,是否读详情/搜索由 LLM 自主决定。
5. **persona 与 self 的关系**:persona(character.json)是固定人设(不可变),与全局记忆 self 分开、互补,都注入;self 是角色自己维护的可变记忆。
6. **记忆索引注入位置**:两类记忆索引都注入到 system prompt。
7. **读记忆详情/搜索只走记忆专用工具**(记忆读/记忆查);transcript 只走 transcript 工具;均不混用通用文件工具(Read/Shell)直接翻记忆目录或 seek.db。
8. **记忆写只能写自己的两个记忆目录**,通过参数区分写「会话级」还是「全局」。
9. **全局记忆 self 初始空白**:角色创建时 self 为空,完全靠自己的经历/记忆工具自己写;persona(character.json)是唯一预设的「自我认知」,与 self 分开、互补。
10. **全局记忆涵盖「世界/剧情长期事实」**:与具体房间/会话无关的长期事实(如「用户在做一个项目」「世界的某个设定」)也算全局记忆,可单独一块或并入 self/others/participation,由 LLM 自主组织。
11. **会话级记忆生命周期 = 会话**:会话被删时,里面各角色的会话级记忆(含 `seek.db`、`memory/`)一并删除,不清入全局记忆。
12. **全局记忆清理靠角色自主**:角色用记忆工具删/合并,系统不干预、不做自动合成/压缩。
13. **记忆来源边界**:
    - 角色可把「共享消息(别人说的话)」写进自己的记忆(作对他人的认知来源,如 others)。
    - 角色可把「**自己**的私有工具产出/结果」写进自己的记忆(自己的经历)。
    - 但别人的**私有工具**既看不到也写不进去(私密,不进入自己的记忆)。
14. **记忆写入无硬限制**:系统不设记忆数量/大小上限,也不拦写入;角色自主决定写多少,后果自负。
15. **记忆索引为链接式 A**:`MEMORY.md` 每条一行摘要 + 指向某详情文件(如 `- 用户在做 seek 项目 → facts/seek.md`);不是内联完整记忆。
16. **角色可自主建详情文件/子目录**:角色写记忆时可新建详情文件、建子目录来组织记忆,完全自由(延续「拆分粒度由 LLM 自主决定」)。
17. **workspace 整场会话共享一个**:所有成员角色看到同一份工作区文件,不是每角色一个。
18. **历史窗口固定统一 N**:所有角色、所有会话送 LLM 时用同一个最近 N 条窗口值(如对齐 grok 的 24),不可按角色/会话单独调。
19. **会话成员动态引用房间**:会话不冻结自己的成员列表,直接用房间当前 `memberIds`;房间加/减人后,所有会话里都会反映该成员变动。

## 十一、待确认点(请宿主继续回答)

- (无当前待确认项,待新的问题提出)
