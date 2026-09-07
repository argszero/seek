// StatusBar.tsx — 输入框下方的状态栏（对齐 TUI status line）。
// 展示当前会话上下文：会话名 / 短 id / 模型 / 房间 / 消息数 / 工作路径。
import { activeSession, activeRoom, useStore } from "../seek/store";

function shortId(sid: string, n = 6): string {
  return sid ? sid.slice(0, n) : "";
}

export function StatusBar() {
  const state = useStore();
  const sess = activeSession();
  const room = activeRoom();
  const msgs = sess?.messages.length ?? 0;
  const title = sess?.name || shortId(sess?.id ?? "", 8);

  if (!sess) {
    return (
      <footer className="statusbar">
        <span className="statusbar__left">seek — 未选择会话</span>
        <span className="statusbar__right">＋ 新建或打开一个会话</span>
      </footer>
    );
  }
  return (
    <footer className="statusbar">
      <span className="statusbar__left" title={`会话 ${sess.id}`}>
        {title}
        <span className="statusbar__dim">· {shortId(sess.id)}</span>
        {state.world.model ? (
          <span className="statusbar__dim">· [{state.world.model}]</span>
        ) : null}
      </span>
      <span className="statusbar__center">
        {room ? `room ${room.name}` : ""}
      </span>
      <span className="statusbar__right">
        <span className="statusbar__dim">· {msgs} msgs</span>
        <span className="statusbar__ws" title={sess.workspace}>
          📁 {sess.workspace}
        </span>
      </span>
    </footer>
  );
}
