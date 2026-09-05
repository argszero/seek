// Composer.tsx — 底部输入区（textarea + 发送/停止 + 草稿逻辑）
import { useState, useRef, useEffect } from "react";
import { useStore, activeSession, getDraft, setDraft, sendMessage, cancelTurn } from "../seek/store";

export function Composer() {
  const state = useStore();
  const sess = activeSession();
  const sid = sess?.id;
  const [text, setText] = useState("");
  const [attachments] = useState<{ type: string; name: string }[]>([]);
  const composing = state.composing;
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 切换会话时载入对应草稿
  useEffect(() => {
    if (sid) setText(getDraft(sid).text);
    else setText("");
  }, [sid]);

  if (!sess) {
    return (
      <div className="composer">
        <div className="composer__box-wrap" style={{ flex: 1, display: "flex", alignItems: "center" }}>
          <textarea className="composer__box" placeholder="选择一个会话开始输入" disabled />
        </div>
      </div>
    );
  }

  function onChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value;
    setText(v);
    setDraft(sid!, v); // 每次输入都写回草稿（会话常驻）
    textareaRef.current?.focus();
  }

  function onSend() {
    if (!text.trim() || composing) return;
    sendMessage(sid!, text);
    setText("");
    setDraft(sid!, "");
  }

  return (
    <>
      {attachments.length > 0 && (
        <div className="composer__pills">
          {attachments.map((a, i) => (
            <span className="composer__pill" key={i}>
              📎 {a.name}
              <span className="composer__pill-x">✕</span>
            </span>
          ))}
        </div>
      )}
      <div className="composer">
        <button className="composer__attach" title="添加附件">📎</button>
        <div className="composer__box-wrap" style={{ flex: 1, display: "flex", alignItems: "center" }}>
          <textarea
            ref={textareaRef}
            className="composer__box"
            placeholder="Ask anything, or drop a file…"
            value={text}
            onChange={onChange}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
          />
        </div>
        <button className="composer__send" onClick={onSend}>
          发送
        </button>
        <button className="composer__stop" style={{ display: composing ? "block" : "none" }} onClick={cancelTurn}>
          停止
        </button>
      </div>
    </>
  );
}
