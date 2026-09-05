// Nav.tsx — 最左 Nav 列（常驻 tab：世界 / 设置）
import type { View } from "./view";

interface NavProps {
  view: View;
  onView: (v: View) => void;
  connected: boolean;
}

export function Nav({ view, onView, connected }: NavProps) {
  return (
    <nav className="nav">
      <button
        className={"nav__btn" + (view === "chat" ? " nav__btn--active" : "")}
        id="nav-world"
        title="世界（会话）"
        onClick={() => onView("chat")}
      >
        💬
      </button>
      <button
        className={"nav__btn" + (view === "settings" ? " nav__btn--active" : "")}
        id="nav-settings"
        title="设置"
        onClick={() => onView("settings")}
      >
        ⚙️
      </button>
      <div className="nav__spacer"></div>
      <div
        className="nav__me"
        title={connected ? "已连接" : "未连接"}
      >
        <span className="nav__me-avatar" style={{ background: connected ? "#4caf50" : "#888", color: "#fff" }}>
          {connected ? "●" : "○"}
        </span>
      </div>
    </nav>
  );
}
