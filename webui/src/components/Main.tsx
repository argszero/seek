// Main.tsx — 主区（房间头部 + 消息流 + 输入区）
import { activeSession, activeRoom } from "../seek/store";
import { escapeHtml } from "../seek/render";
import { Transcript } from "./Transcript";
import { Composer } from "./Composer";

interface MainProps {
  onOpenRightbar: (tab: "members" | "workbench") => void;
}

export function Main({ onOpenRightbar }: MainProps) {
  const sess = activeSession();
  const room = activeRoom();

  return (
    <main className="main">
      <header className="chat-header">
        <div className="chat-header__identity">
          <div className="chat-header__name" id="chat-header-name">
            {room ? escapeHtml(room.name) : "—"}
          </div>
          <div className="chat-header__meta" id="chat-header-signature">
            {sess ? escapeHtml(sess.name || sess.id) : "选择一个会话开始"}
          </div>
        </div>
        <div className="chat-header__controls">
          <button
            className="chat-header__control"
            onClick={() => onOpenRightbar("members")}
          >
            成员数 {room?.memberIds.length ?? 0}
          </button>
          {/* 工作台入口：右栏，随会话绑定（决策 decision-workbench-entry） */}
          <button
            className="chat-header__control"
            title="工作台"
            onClick={() => onOpenRightbar("workbench")}
          >
            ⚙ 工具
          </button>
        </div>
      </header>

      <Transcript />
      <Composer />
    </main>
  );
}
