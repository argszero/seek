// ToolBadge.tsx — 工具消息卡片（一行可点击链接，点击展开 body：输出+复制/重跑）
// 移植自 seek-prototype render(). 工具状态默认折叠（decision-tool-status-collapsed）
import { useState } from "react";
import type { Message } from "../types";
import { escapeHtml } from "../seek/render";

export function ToolBadge({ msg }: { msg: Message }) {
  const [open, setOpen] = useState(false);

  const badge =
    msg.status === "success" ? (
      <span className="tool__badge badge--success">成功 {msg.ms}</span>
    ) : msg.status === "fail" ? (
      <span className="tool__badge badge--fail">失败</span>
    ) : (
      <span className="tool__badge badge--running">运行中…</span>
    );

  return (
    <div className={"tool" + (open ? " tool--open" : " tool--collapsed")} data-tool={msg.id}>
      <span className="tool__link" onClick={() => setOpen(!open)}>
        <span className="tool__caret">▸</span> 🛠 {escapeHtml(msg.cmd || "")} {badge}
      </span>
      <div className="tool__body">
        <div className="tool__body-toolbar">
          <button className="tool__copy">复制</button>
          <button className="tool__copy">重跑</button>
        </div>
        {msg.status === "fail" && (
          <div className="tool__err">{escapeHtml(msg.cmd || "")} 失败</div>
        )}
        <pre>{escapeHtml(msg.output || "（输出占位）")}</pre>
      </div>
    </div>
  );
}
