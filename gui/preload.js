"use strict";
/**
 * preload.js — contextBridge：renderer ↔ main 安全 IPC 桥。
 *
 * 暴露给 renderer 的 ``window.seekBridge`` 实现 bridge.ts 的 HostBridge 接口：
 *   - send(req)        发送协议请求到 main（转发给 daemon）
 *   - onMessage(cb)    订阅 main 转发来的 daemon 事件
 *   - onStateChange(cb)订阅连接状态变化
 *   - close()          断开
 *
 * renderer 零网络权限（sandbox + contextIsolation），所有通信经此白名单 API。
 */

const { contextBridge, ipcRenderer } = require("electron");

const api = {
  send: (req) => ipcRenderer.send("seek:send", req),
  onMessage: (cb) => {
    const listener = (_e, msg) => cb(JSON.stringify(msg));
    ipcRenderer.on("seek:event", listener);
    return () => ipcRenderer.removeListener("seek:event", listener);
  },
  onStateChange: (cb) => {
    const listener = (_e, msg) => {
      if (msg && msg.type === "__state") cb(Boolean(msg.ready));
    };
    ipcRenderer.on("seek:event", listener);
    return () => ipcRenderer.removeListener("seek:event", listener);
  },
  init: () => ipcRenderer.invoke("seek:init"),
  close: () => ipcRenderer.removeAllListeners("seek:event"),
};

contextBridge.exposeInMainWorld("seekBridge", api);
