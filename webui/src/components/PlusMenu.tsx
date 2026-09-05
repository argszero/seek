// PlusMenu.tsx — "+" 主入口弹出菜单（新建会话/打开会话/新建房间）
import { useState, useEffect } from "react";
import { useStore, createSession, openSession, createRoom } from "../seek/store";
import { escapeHtml } from "../seek/render";

interface PlusMenuProps {
  open: boolean;
  onClose: () => void;
}

type Action = "new-session" | "open-session" | "new-room" | null;

export function PlusMenu({ open, onClose }: PlusMenuProps) {
  const [action, setAction] = useState<Action>(null);
  const state = useStore();
  const rooms = state.world.rooms;

  // 点击外部关闭：仅在顶层菜单（未进入子流程）时生效
  useEffect(() => {
    if (!open || action !== null) return;
    function onClick(e: MouseEvent) {
      const el = e.target as HTMLElement;
      if (!el.closest(".plus-menu") && !el.closest("#plus-btn")) onClose();
    }
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [open, action, onClose]);

  // 关闭菜单时重置子流程 action
  useEffect(() => {
    if (!open) setAction(null);
  }, [open]);

  if (!open) return null;

  // 子流程：新建会话 / 打开会话
  if (action === "new-session" || action === "open-session") {
    return (
      <SessionFlow
        mode={action}
        rooms={rooms}
        onBack={() => setAction(null)}
        onClose={onClose}
      />
    );
  }

  // 子流程：新建房间
  if (action === "new-room") {
    return (
      <RoomFlow
        onBack={() => setAction(null)}
        onClose={onClose}
      />
    );
  }

  return (
    <div className="plus-menu" id="plus-menu" onClick={(e) => e.stopPropagation()}>
      <button className="plus-menu__item" onClick={() => setAction("new-session")}>
        ＋ 新建会话
      </button>
      <button className="plus-menu__item" onClick={() => setAction("open-session")}>
        ＋ 打开会话
      </button>
      <button className="plus-menu__item" onClick={() => setAction("new-room")}>
        ＋ 新建房间
      </button>
    </div>
  );
}

function SessionFlow({
  mode,
  rooms,
  onBack,
  onClose,
}: {
  mode: "new-session" | "open-session";
  rooms: { id: string; name: string; memberIds: string[] }[];
  onBack: () => void;
  onClose: () => void;
}) {
  const [roomId, setRoomId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [workspace, setWorkspace] = useState("~/.seek/workspace/default");
  const state = useStore();

  // 该房间的会话
  const roomSessions = state.world.sessions.filter((s) => s.roomId === roomId);
  const roomName = rooms.find((r) => r.id === roomId)?.name || "";

  function handleCreate() {
    if (!roomId) return;
    const w = workspace.trim() || "~/.seek/workspace/default";
    createSession(roomId, name, w);
    onClose();
  }

  return (
    <div className="modal-overlay" id="modal-overlay">
      <div className="modal" id="modal-box">
        <div className="modal__head">
          <div className="modal__title">{mode === "new-session" ? "新建会话" : "打开会话"}</div>
          <button className="modal__close" onClick={onClose}>✕</button>
        </div>
        <div className="modal__body">
          {/* 步骤 1：选房间 */}
          <div className="modal__step">步骤 1/2 · 选择一个房间</div>
          <div className="pick-list" id="room-list">
            {rooms.map((r) => {
              const sessCount = state.world.sessions.filter((s) => s.roomId === r.id).length;
              return (
                <button
                  key={r.id}
                  className={"pick-item" + (roomId === r.id ? " pick-item--sel" : "")}
                  onClick={() => setRoomId(r.id)}
                >
                  <span className="pick-item__avatar">🏠</span>
                  <span className="pick-item__body">
                    <span className="pick-item__name">{escapeHtml(r.name)}</span>
                    <span className="pick-item__meta">
                      {r.memberIds.length} 成员 · {sessCount} 场会话
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          {/* 步骤 2：按模式不同 */}
          {roomId && (
            <>
              <div className="modal__step">步骤 2/2 · {mode === "new-session" ? "起名 & 选工作空间" : "选择要打开的历史会话"}</div>
              {mode === "new-session" ? (
                <>
                  <div className="field">
                    <label className="field__label">会话名（可选）</label>
                    <input
                      className="field__input"
                      placeholder={roomName ? roomName + " #1" : "会话名"}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label className="field__label">工作空间</label>
                    <input
                      className="field__input"
                      value={workspace}
                      onChange={(e) => setWorkspace(e.target.value)}
                    />
                  </div>
                </>
              ) : (
                <div className="pick-list">
                  {roomSessions.length === 0 && (
                    <div className="sidebar__empty">该房间还没有历史会话。</div>
                  )}
                  {roomSessions.map((s) => (
                    <button
                      key={s.id}
                      className="pick-item"
                      onClick={() => {
                        openSession(s.id);
                        onClose();
                      }}
                    >
                      <span className="pick-item__avatar">📄</span>
                      <span className="pick-item__body">
                        <span className="pick-item__name">{s.name || s.id}</span>
                        <span className="pick-item__meta">{s.messages.length} 条消息</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
        <div className="modal__foot">
          <button className="modal__btn modal__btn--ghost" onClick={onBack}>返回</button>
          {mode === "new-session" && (
            <button
              className="modal__btn modal__btn--primary"
              disabled={!roomId}
              onClick={handleCreate}
            >
              创建
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function RoomFlow({ onBack, onClose }: { onBack: () => void; onClose: () => void }) {
  const state = useStore();
  // G7/G9/G8：新建房间 = 挑成员（多选）→ 起名（可选，空则按成员名自动生成）。
  // 这里选「已有角色」作为成员（含内置 you）；G9 支持成员增删，故房间内成员可后续再调。
  const characters = state.world.characters;
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  const selNames = characters.filter((c) => selected.includes(c.id)).map((c) => c.name);
  const autoName = selNames.length > 2 ? selNames.slice(0, 2).join("、") : selNames.join("、");

  function toggle(id: string) {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  function handleCreate() {
    if (creating) return;
    setCreating(true);
    createRoom({ name: name.trim() || undefined, memberIds: selected });
    onClose();
  }

  return (
    <div className="modal-overlay" id="modal-overlay">
      <div className="modal" id="modal-box">
        <div className="modal__head">
          <div className="modal__title">新建房间</div>
          <button className="modal__close" onClick={onClose}>✕</button>
        </div>
        <div className="modal__body">
          <div className="modal__step">步骤 1/2 · 选择成员</div>
          <div className="pick-list" id="member-list">
            {characters.length === 0 && (
              <div className="sidebar__empty">还没有角色。可在「设置 → 角色管理」新建。</div>
            )}
            {characters.map((c) => (
              <button
                key={c.id}
                className={"pick-item" + (selected.includes(c.id) ? " pick-item--sel" : "")}
                onClick={() => toggle(c.id)}
              >
                <span className="pick-item__avatar">{c.kind === "human" ? "🙂" : "🤖"}</span>
                <span className="pick-item__body">
                  <span className="pick-item__name">{escapeHtml(c.name)}</span>
                  <span className="pick-item__meta">{c.kind === "human" ? "真人" : "虚拟角色"}</span>
                </span>
                <span className="pick-item__check">{selected.includes(c.id) ? "✓" : ""}</span>
              </button>
            ))}
          </div>

          <div className="modal__step">步骤 2/2 · 起名（可选）</div>
          <div className="field">
            <label className="field__label">房间名</label>
            <input
              className="field__input"
              placeholder={autoName || "新房间"}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          {selNames.length > 0 && (
            <div className="field__hint">留空将按成员自动命名：{escapeHtml(autoName)}</div>
          )}
        </div>
        <div className="modal__foot">
          <button className="modal__btn modal__btn--ghost" onClick={onBack}>返回</button>
          <button
            className="modal__btn modal__btn--primary"
            disabled={selected.length === 0}
            onClick={handleCreate}
          >
            创建
          </button>
        </div>
      </div>
    </div>
  );
}
