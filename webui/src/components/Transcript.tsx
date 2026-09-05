// Transcript.tsx — 消息流（分块渲染：系统/工具/文本 + markdown）
import { useEffect, useRef } from "react";
import type { Message } from "../types";
import { useStore, findCharacter, activeSession } from "../seek/store";
import { avatarLabel, avatarStyleFor, dotClass, statusText, renderMarkdown, escapeHtml } from "../seek/render";
import { ToolBadge } from "./ToolBadge";

export function Transcript() {
  const state = useStore();
  const sess = activeSession();
  const trRef = useRef<HTMLDivElement>(null);

  const messages = sess?.messages ?? [];
  const statusMap = state.statusMap;

  // 新消息自动滚动到底部
  useEffect(() => {
    const tr = trRef.current;
    if (tr) tr.scrollTop = tr.scrollHeight;
  }, [messages.length]);

  if (!sess) {
    return (
      <div className="transcript" ref={trRef}>
        <div className="sys">从左侧「＋」新建会话，或点开一个会话</div>
      </div>
    );
  }

  return (
    <div className="transcript" ref={trRef}>
      {messages.length === 0 && <div className="sys">本会话还没有消息，说点什么吧。</div>}
      {messages.map((m) => (
        <MessageItem key={m.id} m={m} status={statusMap[m.speaker] || "idle"} />
      ))}
    </div>
  );
}

function MessageItem({ m, status }: { m: Message; status: string }) {
  if (m.kind === "system") {
    return <div className="sys">{escapeHtml(m.text)}</div>;
  }

  const me = m.speaker === "user";
  const sp = me
    ? { name: "我", avatar: null }
    : { name: findCharacter(m.speaker)?.name || m.speaker, avatar: findCharacter(m.speaker)?.avatar ?? null };
  const name = me ? "我" : sp.name;
  const label = avatarLabel(name, sp.avatar);
  const style = avatarStyleFor(sp.avatar, name);

  return (
    <div className="msg" data-msg={m.id}>
      <span
        className={"msg__avatar" + (me ? " msg__avatar--me" : "")}
        style={style}
      >
        {label}
        {!me && <span className={"dot " + dotClass(status)}></span>}
      </span>
      <div className="msg__content">
        <div className="msg__meta">
          <span className={"msg__name" + (me ? " msg__name--me" : "")}>{me ? "我" : escapeHtml(name)}</span>
          <span>{escapeHtml(m.time)}</span>
          {statusText(status, name) && <span className="msg__status">{statusText(status, name)}</span>}
        </div>
        {m.kind === "tool" ? (
          <ToolBadge msg={m} />
        ) : (
          <div
            className={"msg__bubble" + (me ? " msg__bubble--me" : "")}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }}
          />
        )}
      </div>
    </div>
  );
}
