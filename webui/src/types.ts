// types.ts — 协议层类型定义（对齐 CONTRACT.md §2 实体）
// 注意：真实 seekd 的 characters/rooms/sessions 都是 **数组**（不是 mock 的对象映射）

export type Kind = "human" | "virtual";

export interface Avatar {
  type: "letter" | "image";
  text: string;
  bg: string;
  fg: string;
  src: string;
}

export interface SpeakStrategy {
  maxPerTurn: number;
  allowPass: boolean;
  maxLen: number;
}

export interface Character {
  id: string;
  kind: Kind;
  name: string;
  persona: string;
  avatar: Avatar | null;
  agentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Room {
  id: string;
  name: string;
  description: string;
  memberIds: string[];
  createdAt: string;
}

export type MessageKind = "text" | "tool" | "image" | "system";

export interface Message {
  id: string;
  speaker: string; // character id, 'system', or user's id ('user')
  time: string;
  kind: MessageKind;
  text: string;
  // tool only:
  cmd?: string;
  status?: "success" | "fail" | "running";
  ms?: string;
  output?: string;
}

export interface Session {
  id: string;
  roomId: string;
  name: string;
  workspace: string;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
}

// ---- 世界状态 ----
export interface WorldState {
  characters: Character[];
  rooms: Room[];
  sessions: Session[];
  activeSessionId: string | null;
  model: string;
}

// ---- 定时任务（CONTRACT §2/§3 listTasks）----
// 每个任务 = 一场普通会话 + schedule。task 记录 schedule 元数据，读取的是关联 session。
export interface ScheduledTask {
  id: string;          // 会话 id
  enabled: boolean;
  interval: number;    // 秒
  lastRun: string;
  nextRun: string;
  session: Session | null;  // 关联会话（listTasks 附带）
  roomId: string | null;
}

// ---- 模型（CONTRACT §2/§3 listModels）----
export interface Model {
  name: string;
  contextWindow?: number | null;
  vision?: boolean;
}

// ---- LLM 设置（CONTRACT §2/§3 getSettings/saveSettings）----
export interface ModelDetail {
  name: string;
  model?: string;
  contextWindow?: number | null;
  vision?: boolean;
}

export interface SettingsData {
  apiKey: string;
  baseUrl: string;
  model: string;
  currentModel: string;
  modelDetails: ModelDetail[];
}

// ---- 消息发送附件（预留，暂未用）----
export interface Attachment {
  type: "text" | "image";
  name: string;
}

// ---- 工作区文件（workbench「工作区文件」tab）----
export interface WorkspaceFileEntry {
  name: string;
  path: string;
  size: number | null;
  isDir: boolean;
}
