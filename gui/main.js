"use strict";
/**
 * main.js — seek GUI Electron 主进程。
 *
 * 职责：
 *   - 创建窗口，加载 webui/dist（React SPA，与 WEBUI 共享同一 UI）。
 *   - 连接 seekd daemon(WS 37291)，作为 renderer 与 daemon 之间的 IPC↔WS 转发桥。
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
const { installLogging } = require("./log");

// File logging FIRST — before anything can fail silently. Every console.* call
// (and process crash) from here on is appended to ~/.seek/logs/gui.log.
installLogging();

const DAEMON_HOST = process.env.SEEK_DAEMON_HOST || "127.0.0.1";
const DAEMON_PORT = Number(process.env.SEEK_DAEMON_PORT || 37291);
const WEBUI_PORT = Number(process.env.SEEK_WEBUI_PORT || 37292);

// 单实例锁（第二个实例退出并 focus 已有窗口）
if (!app.requestSingleInstanceLock()) {
  console.warn("[seek-gui] another instance already holds the lock — quitting");
  app.quit();
} else {
  main();
}

/** 找到可执行的 seekd 二进制路径（安装目录优先，再打包内/开发）。 */
function findSeekdBin() {
  if (process.env.SEEKDAEMON_BIN && fs.existsSync(process.env.SEEKDAEMON_BIN)) {
    return process.env.SEEKDAEMON_BIN;
  }
  const bases = [
    // 安装器放到用户级的 runtime（macOS: ~/.seek/install）
    path.join(os.homedir(), ".seek", "install", "bin", "seekd"),
    // 安装器放到 GUI 同级（Windows: {app}\seek-gui 的上级是 {app}\bin\seekd）
    path.resolve(process.resourcesPath || "", "..", "..", "bin", "seekd"),
    // 打包：Electron app 资源内的 runtime（若未来把 runtime 打进 app）
    path.join(process.resourcesPath || "", "runtime", "bin", "seekd"),
    path.join(process.resourcesPath || "", "app", "bin", "seekd"),
    // 开发：backend venv / 自包 venv console script
    path.join(__dirname, "..", "..", "backend", ".venv", "bin", "seekd"),
  ];
  // On Windows the runtime ships a .cmd wrapper; prefer it so we can spawn it.
  const exts = process.platform === "win32" ? ["", ".cmd", ".exe"] : [""];
  for (const base of bases) {
    for (const ext of exts) {
      const c = base + ext;
      if (fs.existsSync(c)) return c;
    }
  }
  return process.platform === "win32" ? "seekd.cmd" : "seekd"; // let PATH resolve
}

/** 找到 webui/dist（安装目录优先，再开发目录）。据此加载浏览器 UI。 */
function findWebuiDist() {
  if (process.env.SEEK_WEBUI_DIST && fs.existsSync(process.env.SEEK_WEBUI_DIST)) {
    return process.env.SEEK_WEBUI_DIST;
  }
  const candidates = [
    // 安装器放到用户级的 runtime（macOS: ~/.seek/install）
    path.join(os.homedir(), ".seek", "install", "webui"),
    // 安装器放到 GUI 同级（Windows: {app}\seek-gui 的上级是 {app}\webui）
    path.resolve(process.resourcesPath || "", "..", "..", "webui"),
    // 打包：Electron app 资源内（若未来把 webui 打进 app）
    path.join(process.resourcesPath || "", "webui"),
    path.join(process.resourcesPath || "", "app", "webui"),
    // 开发：webui/dist
    path.join(__dirname, "..", "webui", "dist"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "index.html"))) return c;
  }
  return path.join(__dirname, "..", "webui", "dist"); // fall back to dev
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
        console.log("[seek-gui] daemon state ->", r);
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
    const webuiDist = findWebuiDist();
    // eslint-disable-next-line no-console
    console.log(`[seek-gui] spawning daemon: ${bin}`);
    const args = ["--host", DAEMON_HOST, "--port", String(DAEMON_PORT),
                  "--webui-port", String(WEBUI_PORT)];
    if (webuiDist) args.push("--webui-dist", webuiDist);
    daemonProc = spawn(bin, args, {
      stdio: "ignore",
      detached: false,
      // On Windows the runtime ships a .cmd wrapper; spawn it via the shell.
      shell: process.platform === "win32",
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
    const dist = findWebuiDist();
    console.log("[seek-gui] createWindow, dist =", dist);
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
      console.log("[seek-gui] loaded", index);
    } else {
      // dist 未构建 → 加载一个占位提示（不崩溃）。
      console.warn("[seek-gui] webui dist missing at", index);
      win.loadURL("data:text/html;charset=utf-8," +
        encodeURIComponent("<h2>webui/dist 未构建</h2>" +
          "<p>请在 webui/ 目录运行 <code>npm run build</code> 后再启动 GUI。</p>"));
    }
    win.webContents.on("render-process-gone", (_e, details) => {
      console.error("[seek-gui] render process gone:", details && details.reason);
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
    console.log("[seek-gui] app ready");
    registerIpc();
    createWindow();
    ensureClient();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("second-instance", () => {
    console.log("[seek-gui] second instance — focusing existing window");
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.on("window-all-closed", () => {
    console.log("[seek-gui] all windows closed");
    if (client) client.close();
    if (daemonProc) {
      try { daemonProc.kill("SIGTERM"); } catch { /* ignore */ }
      daemonProc = null;
    }
    if (process.platform !== "darwin") app.quit();
  });
  // process-level crash handling (uncaughtException/unhandledRejection) is
  // installed once in ./log.js so the trace lands in ~/.seek/logs/gui.log.
}
