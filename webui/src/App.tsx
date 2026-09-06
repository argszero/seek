// App.tsx — WEBUI 根组件
// 布局：Nav(最左) | Sidebar(打开中的会话) | Main(房间头+消息流+输入) | Rightbar(默认收起)
// 状态由 store.ts (useSyncExternalStore) 驱动，桥接层在 initBridge()。

import { useEffect, useState } from "react";
import { useStore, initBridge } from "./seek/store";
import type { View } from "./components/view";
import { Nav } from "./components/Nav";
import { ChatView } from "./components/ChatView";
import { PlusMenu } from "./components/PlusMenu";
import { SettingsView } from "./components/SettingsView";

// 全局视图：聊天 | 设置（Nav tab 切换）

export default function App() {
  const state = useStore();
  const [view, setView] = useState<View>("chat");
  const [plusOpen, setPlusOpen] = useState(false);

  // 初始化桥接（连接 daemon 并拉取世界状态）
  useEffect(() => {
    initBridge("ws://127.0.0.1:37291");
  }, []);

  // 连接状态提示
  const connected = state.connected;

  return (
    <div id="app">
      <Nav
        view={view}
        onView={(v) => setView(v)}
        connected={connected}
      />
      <div id="app-body">
        {view === "chat" ? (
          <ChatView
            onPlus={() => setPlusOpen((o) => !o)}
          />
        ) : (
          <SettingsView />
        )}
      </div>
      <PlusMenu
        open={plusOpen}
        onClose={() => setPlusOpen(false)}
      />
    </div>
  );
}
