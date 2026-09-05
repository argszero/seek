// Sidebar.tsx — 左列：打开中的会话列表（用户手动维护，像 tab）
import { useState } from "react";
import { useStore, findSession, findRoom, openSession, closeSession } from "../seek/store";
import { escapeHtml } from "../seek/render";

interface SidebarProps {
  onPlus: () => void;
  sbw: number;
}

function lastPreview(text: string, kind: string, cmd?: string): string {
  if (kind === "tool") return "🛠 运行了命令 " + (cmd || "");
  return text || "";
}

export function Sidebar({ onPlus, sbw }: SidebarProps) {
  const state = useStore();
  const [search, setSearch] = useState("");

  const q = search.trim().toLowerCase();
  const open = state.openSessions;
  const filtered = q
    ? open.filter((id) => {
        const s = findSession(id);
        if (!s) return false;
        const roomName = findRoom(s.roomId)?.name || "";
        return ((s.name || id) + " " + roomName).toLowerCase().includes(q);
      })
    : open;

  const html = filtered.length ? filtered : (q ? "无匹配会话" : "没有打开中的会话");
  const empty = typeof html === "string";

  return (
    <aside className="sidebar" style={{ flex: `0 0 ${sbw}px`, width: `${sbw}px` }}>
      <input
        className="sidebar__search"
        placeholder="搜索会话…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="sidebar__section">打开中</div>
      <div className="sidebar__list">
        {empty ? (
          <div className="sidebar__empty">{html}</div>
        ) : (
          filtered.map((sid) => {
            const sess = findSession(sid);
            if (!sess) return null;
            const name = sess.name || sid;
            const last = sess.messages[sess.messages.length - 1];
            const preview = last ? lastPreview(last.text, last.kind, last.cmd) : "无消息";
            const time = last ? last.time : "";
            const active = sid === state.activeSessionId;
            return (
              <div
                key={sid}
                className={"session-item" + (active ? " session-item--active" : "")}
                data-session={sid}
                onClick={() => openSession(sid)}
              >
                <span className="session-item__avatar">
                  📄
                  <span className="session-item__dot dot--active"></span>
                </span>
                <span className="session-item__body">
                  <span className="session-item__name">{escapeHtml(name)}</span>
                  <span className="session-item__preview">{escapeHtml(preview)}</span>
                </span>
                <span className="session-item__trailing">
                  <span>{escapeHtml(time)}</span>
                  <button
                    className="session-item__close"
                    title="关闭会话"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeSession(sid);
                    }}
                  >
                    ✕
                  </button>
                </span>
              </div>
            );
          })
        )}
      </div>
      <div className="sidebar__actions">
        <button className="sidebar__plus" id="plus-btn" title="主入口" onClick={onPlus}>
          ＋
        </button>
      </div>
    </aside>
  );
}
