// ChatView.tsx — 会话视图（左列表 + 主区 + 右栏），含分栏拖拽
import { useState } from "react";
import { Sidebar } from "./Sidebar";
import { Main } from "./Main";
import { Rightbar } from "./Rightbar";

export function ChatView({ onPlus }: { onPlus: () => void }) {
  const [rightbarOpen, setRightbarOpen] = useState(false);
  const [rightbarTab, setRightbarTab] = useState<"members" | "workbench">("members");

  // 分栏拖拽：左列表宽(sbw)、右栏宽(rbw)
  const [sbw, setSbw] = useState(260);
  const [rbw, setRbw] = useState(300);

  return (
    <div id="view-chat">
      {/* 左列 */}
      <Sidebar onPlus={onPlus} sbw={sbw} />
      <Resizer
        target="sbw"
        value={sbw}
        min={180}
        max={480}
        onChange={setSbw}
        invert={false}
      />

      {/* 主区 */}
      <Main
        onOpenRightbar={(tab: "members" | "workbench") => {
          setRightbarTab(tab);
          setRightbarOpen(true);
        }}
      />

      <Resizer
        target="rbw"
        value={rbw}
        min={200}
        max={560}
        onChange={setRbw}
        invert={true}
        onDragStart={() => setRightbarOpen(true)}
      />

      {/* 右栏 */}
      <Rightbar
        open={rightbarOpen}
        tab={rightbarTab}
        onTab={setRightbarTab}
        width={rbw}
      />
    </div>
  );
}

interface ResizerProps {
  target: "sbw" | "rbw";
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  invert: boolean;
  onDragStart?: () => void;
}

function Resizer({ target, value, min, max, onChange, invert, onDragStart }: ResizerProps) {
  function onMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = value;
    function move(ev: MouseEvent) {
      const dx = ev.clientX - startX;
      const next = invert ? startW - dx : startW + dx;
      onChange(Math.max(min, Math.min(max, next)));
    }
    function up() {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing");
    }
    document.body.classList.add("resizing");
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    onDragStart?.();
  }
  return (
    <div
      className="resizer"
      data-target={target}
      onMouseDown={onMouseDown}
      style={{ flex: "0 0 5px", width: "5px", cursor: "col-resize" }}
    />
  );
}
