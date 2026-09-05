// store.ts — 客户端状态管理（轻量自研，无 Redux）
//
// 用 useSyncExternalStore 提供 React 订阅。管理：
//   - 世界状态（characters/rooms/sessions）
//   - 打开中的会话（用户手动维护，像浏览器 tab）
//   - 每个会话的常驻草稿
//   - WebSocket 连接状态
//   - 发送消息（乐观追加用户消息 + 接收 message:new）
//
// 注意：不使用假数据兜底。所有状态由真实 daemon 通过协议驱动。

import { useSyncExternalStore } from "react";
import type { WorldState, Message, Session, Character, Room, ScheduledTask, Model, SettingsData, WorkspaceFileEntry } from "../types";
import { createBridge } from "./bridge";
import type { SeekBridge, ServerEvent } from "./bridge";

export interface Draft {
  text: string;
}

interface StoreState {
  ready: boolean;
  connected: boolean;
  world: WorldState;
  openSessions: string[]; // 打开中的会话 id（手动维护，像 tab）
  activeSessionId: string | null;
  drafts: Record<string, Draft>; // sessionId → 草稿
  statusMap: Record<string, string>; // speakerId → think|typing|busy|idle（流式推导）
  composing: boolean; // 当前会话是否在生成中
  tasks: ScheduledTask[]; // 定时任务列表（listTasks 结果）
  models: Model[]; // 可用模型列表（listModels 结果）
  settings: SettingsData | null; // LLM 设置（getSettings 结果）
  workspaceFiles: Record<string, WorkspaceFileEntry[]>; // sessionId → 工作区文件列表
  workspaceFileContent: Record<string, string>; // `${sessionId}:${name}` → 文本内容
}

const emptyWorld: WorldState = {
  characters: [],
  rooms: [],
  sessions: [],
  activeSessionId: null,
  model: "",
};

// The built-in human 'you' is the current user's identity in the world (see
// seekd.core.seed). UI treats it as "me" (not a removable/editable peer).
export const ME_ID = "you";
export function isMe(id: string): boolean {
  return id === ME_ID;
}

let state: StoreState = {
  ready: false,
  connected: false,
  world: emptyWorld,
  openSessions: [],
  activeSessionId: null,
  drafts: {},
  statusMap: {},
  composing: false,
  tasks: [],
  models: [],
  settings: null,
  workspaceFiles: {},
  workspaceFileContent: {},
};

const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getState() {
  return state;
}

// ---- 派生查询（从 world 中查找）----
export function findCharacter(id: string): Character | undefined {
  return state.world.characters.find((c) => c.id === id);
}
export function findRoom(id: string): Room | undefined {
  return state.world.rooms.find((r) => r.id === id);
}
export function findSession(id: string): Session | undefined {
  return state.world.sessions.find((s) => s.id === id);
}
export function activeSession(): Session | undefined {
  return state.activeSessionId ? findSession(state.activeSessionId) : undefined;
}
export function activeRoom(): Room | undefined {
  const sess = activeSession();
  return sess ? findRoom(sess.roomId) : undefined;
}

export function useStore(): StoreState {
  return useSyncExternalStore(subscribe, getState);
}

// ---- 桥连接 ----
let bridge: SeekBridge | null = null;

export function initBridge(url?: string) {
  if (bridge) return;
  // 自动选择传输：Electron 环境（存在 window.seekBridge）走 IPC 桥，否则走 WebSocket。
  bridge = createBridge(url);
  bridge.on((ev) => handleEvent(ev));
  bridge.onStateChange((ready) => {
    state = { ...state, connected: ready };
    // 暴露到 window 供无头浏览器/CDP 验证连接状态
    (window as unknown as Record<string, unknown>).__seek_connected = ready;
    if (ready) {
      // 连接就绪后拉取全量世界状态
      bridge?.send({ type: "init" });
      bridge?.send({ type: "listCharacters" });
      bridge?.send({ type: "listRooms" });
      bridge?.send({ type: "listSessions" });
      bridge?.send({ type: "listTasks" });
      bridge?.send({ type: "listModels" });
      bridge?.send({ type: "getSettings" });
    }
    emit();
  });
  bridge.connect();
}

// ---- 事件处理 ----
function applyMessageToSession(sessionId: string, message: Message) {
  const sessions = state.world.sessions.map((s) =>
    s.id === sessionId ? { ...s, messages: [...s.messages, message], updatedAt: message.time } : s,
  );
  state = { ...state, world: { ...state.world, sessions } };
}

function setSessionMessages(sessionId: string, messages: Message[]) {
  const sessions = state.world.sessions.map((s) =>
    s.id === sessionId ? { ...s, messages } : s,
  );
  state = { ...state, world: { ...state.world, sessions } };
}

function handleEvent(ev: ServerEvent) {
  switch (ev.type) {
    case "world:init": {
      state = {
        ...state,
        world: {
          characters: ev.characters,
          rooms: ev.rooms,
          sessions: ev.sessions,
          activeSessionId: state.activeSessionId, // 保留已有
          model: ev.model || state.world.model,
        },
        ready: true,
      };
      emit();
      break;
    }
    case "characters":
      state = { ...state, world: { ...state.world, characters: ev.characters } };
      emit();
      break;
    case "rooms":
      state = { ...state, world: { ...state.world, rooms: ev.rooms } };
      emit();
      break;
    case "sessions":
      state = { ...state, world: { ...state.world, sessions: ev.sessions } };
      emit();
      break;
    case "session:messages": {
      setSessionMessages(ev.sessionId, ev.messages);
      emit();
      break;
    }
    case "session:created": {
      const exists = state.world.sessions.some((s) => s.id === ev.session.id);
      const sessions = exists
        ? state.world.sessions.map((s) => (s.id === ev.session.id ? ev.session : s))
        : [...state.world.sessions, ev.session];
      state = { ...state, world: { ...state.world, sessions } };
      emit();
      break;
    }
    case "room:created": {
      const exists = state.world.rooms.some((r) => r.id === ev.room.id);
      const rooms = exists
        ? state.world.rooms.map((r) => (r.id === ev.room.id ? ev.room : r))
        : [...state.world.rooms, ev.room];
      state = { ...state, world: { ...state.world, rooms } };
      emit();
      break;
    }
    case "room:updated": {
      const rooms = state.world.rooms.map((r) => (r.id === ev.room.id ? ev.room : r));
      state = { ...state, world: { ...state.world, rooms } };
      emit();
      break;
    }
    case "character:created": {
      const exists = state.world.characters.some((c) => c.id === ev.character.id);
      const characters = exists
        ? state.world.characters.map((c) => (c.id === ev.character.id ? ev.character : c))
        : [...state.world.characters, ev.character];
      state = { ...state, world: { ...state.world, characters } };
      emit();
      break;
    }
    case "session:renamed": {
      const sessions = state.world.sessions.map((s) =>
        s.id === ev.sessionId ? { ...s, name: ev.title } : s,
      );
      state = { ...state, world: { ...state.world, sessions } };
      emit();
      break;
    }
    case "session:cleared": {
      setSessionMessages(ev.sessionId, []);
      emit();
      break;
    }
    case "message:new": {
      applyMessageToSession(ev.sessionId, ev.message);
      // 说话者状态：流式推导（决定 D2）——发消息即 typing 即将结束，延迟对齐 member:idle
      if (isHumanSpeaker(ev.message.speaker)) {
        state = { ...state, statusMap: { ...state.statusMap, [ev.message.speaker]: "idle" } };
      }
      // 系统消息清空进行中
      if (ev.message.kind === "system") {
        state = { ...state, composing: false };
      }
      emit();
      break;
    }
    case "turn:start":
      state = { ...state, composing: true };
      emit();
      break;
    case "turn:cancelled":
      // A running group-chat turn was cancelled: clear composing + statuses.
      state = { ...state, composing: false };
      emit();
      break;
    case "turn:idle":
      // The group-chat turn finished (even with no replies): clear composing.
      state = { ...state, composing: false };
      emit();
      break;
    case "tasks": {
      state = { ...state, tasks: ev.tasks };
      emit();
      break;
    }
    case "workspaceFiles": {
      state = { ...state, workspaceFiles: { ...state.workspaceFiles, [ev.sessionId]: ev.files } };
      emit();
      break;
    }
    case "workspaceFile": {
      const key = `${ev.sessionId}:${ev.name}`;
      state = { ...state, workspaceFileContent: { ...state.workspaceFileContent, [key]: ev.content } };
      emit();
      break;
    }
    case "models": {
      state = { ...state, models: ev.models, world: { ...state.world, model: ev.current } };
      emit();
      break;
    }
    case "settings": {
      state = { ...state, settings: ev.settings };
      emit();
      break;
    }
    case "model:changed": {
      state = { ...state, world: { ...state.world, model: ev.model } };
      emit();
      break;
    }
    case "error":
      // 不崩溃；可留 toast 或 console
      console.warn("seek error:", ev.message);
      emit();
      break;
    default:
      break;
  }
}

function isHumanSpeaker(speaker: string) {
  const ch = findCharacter(speaker);
  // 用户发言（speaker 是自己 id 或 'user'）或虚拟人完成
  return speaker === "user" || ch?.kind === "human";
}

// ---- UI 操作 ----
export function sendMessage(sessionId: string, text: string) {
  if (!text.trim()) return;
  const requestId = crypto.randomUUID();
  // 不乐观追加：完全依赖 daemon 的 message:new（含 user + 虚拟回复）驱动 UI。
  // 乐观追加会与后端回播的用户消息重复，且违背"不造假数据"原则。
  state = { ...state, composing: true };
  emit();
  bridge?.send({ type: "sendMessage", sessionId, text, requestId });
}

export function cancelTurn() {
  // 取消当前正在运行的次（发送给 daemon，daemon 取消编排任务并广播 turn:cancelled）。
  bridge?.send({ type: "cancel" });
}

export function listTasks() {
  bridge?.send({ type: "listTasks" });
}

export function listModels() {
  bridge?.send({ type: "listModels" });
}

export function triggerTask(sessionId: string) {
  bridge?.send({ type: "triggerTask", sessionId });
}

export function listWorkspaceFiles(sessionId: string) {
  bridge?.send({ type: "listWorkspaceFiles", sessionId });
}

export function readWorkspaceFile(sessionId: string, name: string) {
  bridge?.send({ type: "readWorkspaceFile", sessionId, name });
}

export function openSession(sessionId: string) {
  if (!findSession(sessionId)) return;
  // 打开中的会话：若不在则加入
  if (!state.openSessions.includes(sessionId)) {
    state = { ...state, openSessions: [...state.openSessions, sessionId] };
  }
  state = { ...state, activeSessionId: sessionId };
  emit();
  // 请求该会话完整消息
  bridge?.send({ type: "openSession", sessionId });
}

export function createSession(roomId: string, name: string, workspace: string) {
  bridge?.send({ type: "createSession", roomId, name, workspace });
  // 等待 session:created 事件
}

export function createRoom(opts: { name?: string; memberIds?: string[]; description?: string }) {
  bridge?.send({ type: "createRoom", name: opts.name, memberIds: opts.memberIds, description: opts.description });
  // 等待 room:created 事件
}

export function createCharacter(opts: { name: string; persona?: string }) {
  bridge?.send({ type: "createCharacter", name: opts.name, persona: opts.persona });
  // 等待 character:created 事件
}

export function addRoomMember(roomId: string, characterId: string) {
  bridge?.send({ type: "addRoomMember", roomId, characterId });
  // 等待 room:updated 事件
}

export function removeRoomMember(roomId: string, characterId: string) {
  bridge?.send({ type: "removeRoomMember", roomId, characterId });
  // 等待 room:updated 事件
}

export function renameSession(sessionId: string, title: string) {
  bridge?.send({ type: "renameSession", sessionId, title });
}

export function clearSession(sessionId: string) {
  bridge?.send({ type: "clearSession", sessionId });
}

export function setModel(modelKey: string) {
  // 乐观更新本地 world.model 让 UI 即时反映；后端 switchModel 兜底持久化。
  state = { ...state, world: { ...state.world, model: modelKey } };
  emit();
  bridge?.send({ type: "switchModel", modelKey });
}

export function getSettings() {
  bridge?.send({ type: "getSettings" });
}

export function saveSettings(payload: {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  modelDetails?: SettingsData["modelDetails"];
}) {
  bridge?.send({ type: "saveSettings", ...payload });
}

export function closeSession(sessionId: string) {
  const idx = state.openSessions.indexOf(sessionId);
  if (idx < 0) return;
  const open = state.openSessions.filter((id) => id !== sessionId);
  let active = state.activeSessionId;
  if (active === sessionId) {
    active = open[0] ?? null;
  }
  state = { ...state, openSessions: open, activeSessionId: active };
  emit();
}

// ---- 草稿（每个会话常驻输入框）----
export function getDraft(sessionId: string): Draft {
  if (!state.drafts[sessionId]) state.drafts[sessionId] = { text: "" };
  return state.drafts[sessionId];
}
export function setDraft(sessionId: string, text: string) {
  state = { ...state, drafts: { ...state.drafts, [sessionId]: { text } } };
  emit();
}
