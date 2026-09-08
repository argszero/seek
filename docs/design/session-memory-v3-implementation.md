# seek 会话与记忆 v3 —— 实现方案

> 承接 v3 设计稿(`session-memory-v3-draft.md`)。本文档给出**落地到现有代码**(`backend/seekd/`)的具体实现方案。目标:**完全替换 jsonstore,重构成"每角色 seek.db + 记忆目录"模型**,并新增记忆专用工具。
>
> **状态:已落地**(全量后端测试 102 passed)。

## 落地清单(已完成)

- `seekd/store/transcript.py` —— 每角色 `seek.db`(SQLite `kv` + `transcript_entries` + 部分索引 `idx_transcript_window` 排除 tool-call)。`append/window/tail/query/count`。
- `seekd/store/memory.py` —— 记忆目录(`MEMORY.md` 索引 + 详情),`index_text/read_index/write_index/read_detail/write_detail/delete_detail/search`。
- `seekd/store/store.py` —— 层次化实体存储(替换 jsonstore):`character_dir/room/session_dir/character_session_dir/character_seek_db/character_session_memory/character_global_memory` + `save/get/list` + `ensure_member_dirs/append_shared_entry/get_session_messages/clear_session_transcripts`。
- `seekd/tools/memory_tool.py` —— `memory_read/write/search/delete`,构造时绑定角色上下文,只读写自己的两个记忆目录。
- `seekd/tools/transcript_tool.py` —— `transcript_query`,只查自己的 seek.db(只读)。
- `seekd/tools/registry.py` —— `default_tools/memory_tools/transcript_tool/member_tools`。
- `seekd/server/session_runner.py` —— 每条共享消息写入每个在场成员 seek.db;私有 tool-call 只写拥有者;agent 装配记忆+transcript 工具;system prompt 注入两记忆目录+两索引+窗口规则(`_inject_memory_context`)。
- `seekd/server/daemon.py` —— `_create_session` 建 member dirs;`_send_message`/`_trigger_task`/`_check_tasks` 写共享消息进 member seek.db;`_open_session` 从 seek.db 聚合消息;`_clear_session` 清 transcript。
- `seekd/core/seed.py` —— 种子会话建 member dirs。
- `seekd/core/models.py` —— `Session` 去掉 `messages` 字段。
- 测试:新增 `test_memory_tools.py`;重写 `test_store.py`/`test_session_runner.py`;改 `test_models.py`/`test_seed.py`/`test_daemon.py`。

## 一、目标存储模型(回顾)

```
~/.seek/
├── characters/<characterId>/
│   ├── character.json          # 角色身份(persona/描述/avatar/kind)
│   └── memory/                 # 全局记忆(辅助)
│       ├── MEMORY.md           # 索引(链接式)
│       └── <topic>.md          # 详情
└── rooms/<roomId>/sessions/<sessionId>/
    ├── session.json            # 会话元数据(id/roomId/name/workspace/时间戳)
    └── <characterId>/          # 每角色一个目录
        ├── seek.db             # 记录层(编排器自动写,角色只读)
        └── memory/             # 会话级记忆(主要)
            ├── MEMORY.md       # 索引(链接式)
            └── <topic>.md      # 详情
```

## 二、迁移 vs 重写

**完全替换 `SeekStore`**(决策 A,无历史包袱)。现有 `store/jsonstore.py` 将被新实现取代。

**新 store 拆分**:
- `seekd/store/store.py` —— 世界实体(Character/Room/Session/ScheduledTask)的路径化 + 读写,对齐现有接口(`get_character`/`list_rooms`/`save_session`/`append_message`…)。
- `seekd/store/transcript.py` —— 每个角色 `seek.db`(SQLite)的打开/建表/追加/窗口查询/工具调用记录。
- `seekd/store/memory.py` —— 记忆目录(MEMORY.md 索引 + 详情)的读写。
- `seekd/store/jsonstore.py` —— 删除或保留为兼容(决策 A:删除,测试同步改)。

## 三、文件路径接口

### `store.py`(世界实体)
| 方法 | 说明 |
|---|---|
| `character_dir(cid)` / `character_path(cid)` | `characters/<cid>/character.json` |
| `room_path(rid)` | `rooms/<rid>/room.json`(保留) |
| `session_dir(sid)` | `rooms/<sid.room_id>/sessions/<sid>`(需由 Session 回查 room_id) |
| `session_path(sid)` | 同 `session_dir/session.json` |
| `character_session_dir(sid, cid)` | `session_dir/<cid>/` |
| `character_seek_db(sid, cid)` | `session_dir/<cid>/seek.db` |
| `character_session_memory(sid, cid)` | `session_dir/<cid>/memory/` |
| `character_global_memory(cid)` | `characters/<cid>/memory/` |

**关键**:`session.json` 记 `room_id`;`store.session_dir(sid)` 需先 `get_session(sid)` 拿 `room_id` 再拼路径(或用 `rooms/<room_id>/sessions/<sid>`)。为保证 delete_session 能删整棵目录,session 目录 = `rooms/<room_id>/sessions/<sid>/`。

### `transcript.py`(`seek.db`)
```sql
CREATE TABLE IF NOT EXISTS transcript_entries (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  entry TEXT NOT NULL
) STRICT;
```
- `open(char_dir)` → 打开 SQLite(确保目录存在),建表。
- `append(entry: dict)` → INSERT(seq 自增)。
- `window(limit: int)` → 最近 N 条(排除 tool,`kind != 'tool-call'`)。
- `tail(limit)` → 最近 N 条(含 tool)。
- `query(**filters)` → 按 author/time/keyword/kind 过滤(供 transcript 查工具)。
- `close()`。

### `memory.py`(记忆目录)
- `index_path(dir)` → `dir/MEMORY.md`。
- `read_index(dir)` → 解析索引(每条一行 + 指向详情)。
- `append_index(dir, summary, detail_file)` → 追加一行。
- `read_detail(dir, topic)` → 读详情文件。
- `write_detail(dir, topic, content)` → 写/更新详情(可创建子目录)。
- `search(dir, keyword/topic)` → 翻索引找相关记忆。

## 四、模型层调整(`core/models.py`)

- **`Session`**:保留现有字段(`id/room_id/name/workspace/created_at/updated_at`),但**不再持有 `messages` 列表**——消息改由各角色 `seek.db` 存。`to_dict` 不导出 messages(或保留空数组占位,待 daemon 适配)。必要时加 `participants`(动态引用 room.member_ids,不加字段)。
- **`Message`**:保留现有形状,但 `seek.db` 里用更丰富的 entry(带 `author`/`kind`/`tool`)。转换逻辑放 `transcript.py`。

## 五、daemon 适配(`server/daemon.py`)

- **创建会话**`_create_session`:建 `session.json` + 对每个在场角色(member_ids 中 kind=virtual + 用户)建 `<cid>/` 目录(含 `seek.db` 初始建表 + `memory/MEMORY.md` 初始空索引)。
- **删除会话**`_delete_session`:删整个 `session_dir`(含所有角色 seek.db + memory)。
- **发消息**`_send_message`:
  1. 用户消息 → 对**每个在场角色**的 `seek.db` append 一条 `author:{id:'我',kind:'human'}` 的 send-message(共享消息)。
  2. 运行群聊回合 → 每个成员发言/工具 → 追加**到该成员自己的 seek.db**(自我 send-message) + **到其他所有在场角色的 seek.db 作为共享背景**(别人的 send-message)。
     - 工具:只追加**到该成员自己的 seek.db**(`tool-call`),**不写进别人的 db**(物理私密)。
- **broadcast 消息**:仍发 `message:new` 给前端(前端展示不变),但消费源从 session.messages 改为聚合。

## 六、工具装配(`agent/tool_loop.py` + `tools/`)

现有 `Agent.tools` 为空,需在 `session_runner`/`daemon` 装配自动工具 + 记忆工具。

- **自动工具**(保留):`default_tools()`(bash/read/write/edit/glob/grep)。
- **记忆工具(新增)**:`tools/memory_tool.py`(记忆读/记忆写/记忆查/记忆删)+ `tools/transcript_tool.py`(transcript 查)。

记忆工具需要**上下文**(当前角色 cid、当前会话 sid、两个记忆目录路径),通过**构造时注入**到工具实例(每个成员 turn 时用该成员上下文建工具):

```python
memory_tools = MemoryTools(
    character_id=member.id,
    session_id=session.id,
    store=self.store,   # 提供 memory 目录 + seek.db 路径
)
agent_tools = default_tools() + memory_tools.tools() + [transcript_tool]
agent = Agent(self.llm, tools=agent_tools, model=self.model_key)
```

**权限控制**:记忆工具内部校验「目标目录 = 当前角色的会话级/全局记忆目录」,防止越权读/写/删他人。transcript 工具同理(只查自己 seek.db,只读)。

## 七、记忆工具接口(草)

| 工具 | 参数 | 行为 | 权限 |
|---|---|---|---|
| `memory_read` | `scope(session/global)`, `topic?`, `detail?` | 读索引或详情 | 仅自己目录 |
| `memory_write` | `scope`, `topic`, `summary`, `content?` | 写详情+更新索引 | 仅自己目录 |
| `memory_search` | `query` | 检索索引找相关记忆 | 仅自己目录 |
| `memory_delete` | `scope`, `topic` | 删详情+移除索引行 | 仅自己目录 |
| `transcript_query` | `author?/time?/keyword?/kind?/limit?` | 查自己 seek.db | 仅自己 seek.db |

## 八、system prompt 注入(`orchestrator/group_chat.py`)

`build_group_member_system_prompt` 注入(按角色):
1. persona(character.json 全量)。
2. 两个记忆目录路径 + 记忆工具说明。
3. 会话窗口说明(送 LLM 只取最近窗口;seek.db 完整可回溯)。
4. 记忆索引(会话级 + 全局 MEMORY.md)**自动注入**。

需在 `_member_turn` 里把 `store` 传给 prompt 构建,或由 runner 预先生成注入。

## 九、测试改造

- `test_store.py`:改测新 store(世界实体 + transcript + memory)。
- `test_session_runner.py`:改测「每角色 seek.db」写入 + 权限。
- `test_group_chat.py`:补记忆/transcript 工具规格与注入。
- 新增 `test_transcript.py`、`test_memory.py`。
- 删除 jsonstore 相关断言,对齐新模型。

## 十、实施顺序(建议)

1. `transcript.py`(seek.db SQLite)+ 单测。
2. `memory.py`(记忆目录/索引)+ 单测。
3. 重写 `store.py`(世界实体路径化)+ 迁移 models。
4. 适配 daemon(创建/删除/发消息写入各角色 seek.db)。
5. 新增记忆/transcript 工具 + 装配 agent。
6. 注入 system prompt。
7. 全量测试 + CDP/E2E 验证。

## 十一、关键决策回顾(已确认)

- 每角色一个 `seek.db`,编排器自动写,角色**只读**。
- 记忆由角色自己用记忆工具读写,索引自动注入,详情/搜索自主。
- 工具私密**物理隔离**(别人的 tool-call 不进本角色 db)。
- 会话成员动态引用房间;窗口固定 N;workspace 会话共享。
- 会话级记忆跟会话一起删;全局记忆角色自主清理。
- **消息写入 = 实时写(A)**:每条消息(用户/成员发言/成员工具)立即追加到相应角色的 `seek.db`,不做延迟/按需同步。单机 daemon 串行写,量小,简单一致。
