// bridge.ts — 桥适配层：统一 WebSocket 协议（WEBUI/GUI 复用）
//
// 设计决策 1：WEBUI 与 Electron GUI 共享同一套 UI。差异只在底层传输——
//   WEBUI → 浏览器原生 WebSocket 连 daemon
//   GUI   → Electron IPC（后续实现）
// 本层暴露一个统一的 `SeekBridge` 接口，UI 只依赖它，不关心传输为何。

import type { Character, Room, Session, Message, ScheduledTask, Model, SettingsData, ModelDetail, WorkspaceFileEntry } from "../types";

// ---- 从 daemon 收到的消息（后端 → 客户端）----
export type ServerEvent =
  | { type: "pong" }
  | { type: "world:init"; characters: Character[]; rooms: Room[]; sessions: Session[]; activeSessionId: string | null; model: string }
  | { type: "rooms"; rooms: Room[] }
  | { type: "characters"; characters: Character[] }
  | { type: "sessions"; sessions: Session[] }
  | { type: "session:messages"; sessionId: string; messages: Message[]; appendOnly: boolean }
  | { type: "session:created"; session: Session }
  | { type: "room:created"; room: Room }
  | { type: "room:updated"; room: Room }
  | { type: "character:created"; character: Character }
  | { type: "session:renamed"; sessionId: string; title: string }
  | { type: "session:cleared"; sessionId: string }
  | { type: "message:new"; sessionId: string; message: Message }
  | { type: "turn:start"; sessionId: string }
  | { type: "turn:cancelled"; sessionId: string }
  | { type: "turn:idle"; sessionId: string }
  | { type: "ok"; requestId?: string }
  | { type: "tasks"; tasks: ScheduledTask[] }
  | { type: "workspaceFiles"; sessionId: string; files: WorkspaceFileEntry[] }
  | { type: "workspaceFile"; sessionId: string; name: string; content: string }
  | { type: "models"; models: Model[]; current: string }
  | { type: "settings"; settings: SettingsData }
  | { type: "model:changed"; model: string; apiModel: string; contextWindow?: number | null }
  | { type: "error"; requestId?: string; message: string };

// ---- 客户端 → 后端请求 ----
export type ClientRequest =
  | { type: "ping" }
  | { type: "init" }
  | { type: "listRooms" }
  | { type: "listCharacters" }
  | { type: "listSessions"; roomId?: string }
  | { type: "createSession"; roomId: string; name?: string; workspace: string }
  | { type: "createRoom"; name?: string; memberIds?: string[]; description?: string }
  | { type: "createCharacter"; name: string; persona?: string; avatar?: Record<string, unknown> }
  | { type: "addRoomMember"; roomId: string; characterId: string }
  | { type: "removeRoomMember"; roomId: string; characterId: string }
  | { type: "openSession"; sessionId: string }
  | { type: "sendMessage"; sessionId: string; text: string; requestId: string }
  | { type: "renameSession"; sessionId: string; title: string }
  | { type: "clearSession"; sessionId: string }
  | { type: "switchModel"; modelKey: string }
  | { type: "listModels" }
  | { type: "getSettings" }
  | { type: "saveSettings"; apiKey?: string; baseUrl?: string; model?: string; modelDetails?: ModelDetail[] }
  | { type: "listTasks" }
  | { type: "triggerTask"; sessionId: string }
  | { type: "listWorkspaceFiles"; sessionId: string }
  | { type: "readWorkspaceFile"; sessionId: string; name: string }
  | { type: "cancel" };
export type RequestHandler = (ev: ServerEvent) => void;

export interface SeekBridge {
  /** 建立底层连接 */
  connect(): void;
  /** 发送一个请求（浏览器侧原生 WebSocket，无 requestId 回声机制，直接 fire-and-forget） */
  send(req: ClientRequest): void;
  /** 注册入站事件监听 */
  on(handler: RequestHandler): () => void;
  /** 断开连接 */
  close(): void;
  /** ready 状态 */
  isReady(): boolean;
  /** 连接状态变化回调 */
  onStateChange(cb: (ready: boolean) => void): () => void;
}

/** 基于把消息转发给 host 的桥接口：GUI(Electron) 走 IPC，浏览器走 WS。 */
export interface HostBridge {
  /** 向 daemon 发送一条请求（序列化为 JSON 后由 host 转发） */
  send(req: unknown): void;
  /** 订阅 host 转来的 daemon 事件（JSON 文本） */
  onMessage(cb: (raw: string) => void): () => void;
  /** 报告底层连接就绪状态 */
  onStateChange(cb: (ready: boolean) => void): () => void;
  /** 主动断开 */
  close?(): void;
}

/** 用任意 HostBridge 构造一个符合 SeekBridge 的适配器。 */
function adaptHostBridge(host: HostBridge): SeekBridge {
  let ready = false;
  const handlers = new Set<RequestHandler>();
  const stateCbs = new Set<(ready: boolean) => void>();

  function setReady(v: boolean) {
    if (ready === v) return;
    ready = v;
    stateCbs.forEach((cb) => cb(v));
  }

  const offMsg = host.onMessage((raw) => {
    let ev: ServerEvent;
    try {
      ev = JSON.parse(raw);
    } catch {
      return;
    }
    handlers.forEach((h) => h(ev));
  });
  const offState = host.onStateChange(setReady);

  return {
    connect() {
      // host 侧自行建连；这里仅同步初始状态。
    },
    send(req) {
      host.send(req);
    },
    on(h) {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    close() {
      offMsg();
      offState();
      host.close?.();
    },
    isReady: () => ready,
    onStateChange(cb) {
      stateCbs.add(cb);
      return () => stateCbs.delete(cb);
    },
  };
}

/**
 * GUI(Electron) 桥：renderer 通过 preload 暴露的全局 ``window.seekBridge`` 与
 * main 进程通信，main 再连 daemon（WebSocket）。renderer 零网络权限。
 */
export function createElectronBridge(): SeekBridge {
  const g = window as unknown as Record<string, unknown>;
  const bridge = g.seekBridge as HostBridge | undefined;
  if (!bridge) {
    // 无 Electron 桥（在纯浏览器里被误调）→ 退化为不可用但绝不崩溃。
    return adaptHostBridge({
      send() {},
      onMessage() { return () => {}; },
      onStateChange(cb) { cb(false); return () => {}; },
    });
  }
  return adaptHostBridge(bridge);
}

/** 唯一建桥入口：GUI(Electron) 用 IPC 桥，WEBUI 用 WebSocket 适配层。 */
export function createBridge(url = "ws://127.0.0.1:8123"): SeekBridge {
  const isElectron = typeof window !== "undefined" &&
    Boolean((window as unknown as Record<string, unknown>).seekBridge);
  return isElectron ? createElectronBridge() : createWebUiBridge(url);
}

/** WEBUI 用 WebSocket 适配层。 */
export function createWebUiBridge(url = "ws://127.0.0.1:8123"): SeekBridge {
  let ws: WebSocket | null = null;
  let ready = false;
  const handlers = new Set<RequestHandler>();
  const stateCbs = new Set<(ready: boolean) => void>();

  function setReady(v: boolean) {
    if (ready === v) return;
    ready = v;
    stateCbs.forEach((cb) => cb(v));
  }

  return {
    connect() {
      ws = new WebSocket(url);
      ws.onopen = () => setReady(true);
      ws.onclose = () => setReady(false);
      ws.onerror = () => setReady(false);
      ws.onmessage = (e: MessageEvent<string>) => {
        let ev: ServerEvent;
        try {
          ev = JSON.parse(String(e.data));
        } catch {
          return;
        }
        handlers.forEach((h) => h(ev));
      };
    },
    send(req) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(req));
      }
    },
    on(h) {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    close() {
      ws?.close();
      ws = null;
    },
    isReady: () => ready,
    onStateChange(cb) {
      stateCbs.add(cb);
      return () => stateCbs.delete(cb);
    },
  };
}
