"use strict";
/**
 * main.js — seek GUI Electron 主进程。
 *
 * 职责：
 *   - 创建窗口，加载 webui/dist（React SPA，与 WEBUI 共享同一 UI）。
 *   - 连接 seekd daemon(WS 8123)，作为 renderer 与 daemon 之间的 IPC↔WS 转发桥。
 *   - 安全：contextIsolation + nodeIntegration:false + sandbox（renderer 零网络权限）。
 *
 * renderer 通过 preload 暴露的 ``window.seekBridge`` 与 main 通信；main 经
 * SeekDaemonClient 与 daemon 通信。协议完全对齐 CONTRACT.md。
 */

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");
const { SeekDaemonClient } = require("./daemon_client");

const DAEMON_HOST = process.env.SEEK_DAEMON_HOST || "127.0.0.1";
const DAEMON_PORT = Number(process.env.SEEK_DAEMON_PORT || 8123);

// 单实例锁（第二个实例退出并 focus 已有窗口）
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

/** 找到可执行的 seekd 二进制路径（打包内优先，再 PATH）。 */
function findSeekdBin() {
  if (process.env.SEEKDAEMON_BIN && fs.existsSync(process.env.SEEKDAEMON_BIN)) {
    return process.env.SEEKDAEMON_BIN;
  }
  const candidates = [
    // 打包：Electron app 资源内的 runtime 入口
    path.join(process.resourcesPath || "", "runtime", "bin", "seekd"),
    path.join(process.resourcesPath || "", "app", "bin", "seekd"),
    // 安装器放到用户级的 runtime
    path.join(os.homedir(), ".seek", "install", "bin", "seekd"),
    // 开发：backend venv / 自包 venv console script
    path.join(__dirname, "..", "..", "backend", ".venv", "bin", "seekd"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return "seekd"; // let PATH resolve
}

function main() {
  let win = null;
  let client = null;
  let ready = false;
  let daemonProc = null;
  let spawnAttempted = false;

  // ── daemon 桥 ───────────────────────────────────────────
  function ensureClient() {
    if (client) return;
    client = new SeekDaemonClient({
      host: DAEMON_HOST,
      port: DAEMON_PORT,
      onEvent: (msg) => sendToRenderer(msg),
      onState: (r) => {
        ready = r;
        if (!r && !spawnAttempted) spawnDaemon();
        sendToRenderer({ type: "__state", ready: r });
      },
    });
    client.connect();
  }

  /** 若端口上没有 daemon，拉起一个随 GUI 生命周期运行的 seekd。 */
  function spawnDaemon() {
    if (daemonProc) return;
    spawnAttempted = true;
    const bin = findSeekdBin();
    // eslint-disable-next-line no-console
    console.log(`[seek-gui] spawning daemon: ${bin}`);
    daemonProc = spawn(bin, ["--host", DAEMON_HOST, "--port", String(DAEMON_PORT)], {
      stdio: "ignore",
      detached: false,
    });
    daemonProc.on("error", (e) => {
      // eslint-disable-next-line no-console
      console.error("[seek-gui] daemon spawn failed", e);
    });
    daemonProc.on("exit", (code) => {
      // eslint-disable-next-line no-console
      console.log("[seek-gui] daemon exited", code);
      daemonProc = null;
      spawnAttempted = false; // allow respawn on next reconnect
    });
  }

  function sendToRenderer(msg) {
    if (win && !win.isDestroyed()) {
      win.webContents.send("seek:event", msg);
    }
  }

  // ── 窗口 ────────────────────────────────────────────────
  function createWindow() {
    const dist = path.join(__dirname, "..", "webui", "dist");
    win = new BrowserWindow({
      width: 1200,
      height: 800,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, "preload.js"),
        backgroundThrottling: false,
      },
    });
    const index = path.join(dist, "index.html");
    if (fs.existsSync(index)) {
      win.loadFile(index);
    } else {
      // dist 未构建 → 加载一个占位提示（不崩溃）。
      win.loadURL("data:text/html;charset=utf-8," +
        encodeURIComponent("<h2>webui/dist 未构建</h2>" +
          "<p>请在 webui/ 目录运行 <code>npm run build</code> 后再启动 GUI。</p>"));
    }
    win.webContents.on("render-process-gone", () => {
      if (fs.existsSync(path.join(dist, "index.html"))) {
        win.loadFile(path.join(dist, "index.html"));
      }
    });
    win.on("closed", () => { win = null; });
  }

  // ── IPC（renderer ↔ main）───────────────────────────────
  function registerIpc() {
    ipcMain.on("seek:send", (_e, req) => {
      // renderer 发来的协议请求 → 转发给 daemon。
      ensureClient();
      if (client) client.send(req);
    });
    ipcMain.handle("seek:init", () => {
      ensureClient();
      if (client) client.bootstrap();
      return { ok: true };
    });
  }

  // ── 应用生命周期 ────────────────────────────────────────
  app.whenReady().then(() => {
    registerIpc();
    createWindow();
    ensureClient();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.on("window-all-closed", () => {
    if (client) client.close();
    if (daemonProc) {
      try { daemonProc.kill("SIGTERM"); } catch { /* ignore */ }
      daemonProc = null;
    }
    if (process.platform !== "darwin") app.quit();
  });

  process.on("uncaughtException", (e) => {
    // eslint-disable-next-line no-console
    console.error("[seek-gui] uncaughtException", e);
  });
}
