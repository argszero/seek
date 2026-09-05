"use strict";
/**
 * daemon_client.js — GUImain 进程侧：连接 seekd daemon 的 WebSocket 客户端。
 *
 * 职责：连 daemon(WS 8123)，按其 CONTRACT.md 协议收发。renderer 通过 IPC 发来请求，
 * main 转发给 daemon；daemon 的事件（message:new / turn:* / models ...）经本模块
 * 转发回 renderer。GUI 与 WEBUI 共享同一协议，只是传输层不同。
 */

const WebSocket = require("ws");
const { EventEmitter } = require("events");

const RECONNECT_MS = 1500;

class SeekDaemonClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.host
   * @param {number} opts.port
   * @param {(msg: object) => void} opts.onEvent  收到 daemon 事件（非应答）回调
   * @param {(ready: boolean) => void} opts.onState 连接状态变化回调
   */
  constructor({ host = "127.0.0.1", port = 8123, onEvent, onState }) {
    super();
    this.host = host;
    this.port = port;
    this.onEvent = onEvent;
    this.onState = onState;
    this.ws = null;
    this.connected = false;
    this._closing = false;
    this._reconnectTimer = null;
  }

  get uri() {
    return `ws://${this.host}:${this.port}`;
  }

  /** 建连（断开后自动重连）。 */
  connect() {
    this._closing = false;
    this._open();
  }

  _open() {
    this.ws = new WebSocket(this.uri);
    this.ws.on("open", () => {
      if (this._closing) return;
      this.connected = true;
      this.onState?.(true);
    });
    this.ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }
      this.onEvent?.(msg);
    });
    this.ws.on("close", () => {
      this.connected = false;
      this.onState?.(false);
      if (!this._closing) this._scheduleReconnect();
    });
    this.ws.on("error", () => {
      // WebSocket error 后面会跟 close；这里只标记断开。
      if (this.connected) {
        this.connected = false;
        this.onState?.(false);
      }
    });
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this._closing) this._open();
    }, RECONNECT_MS);
  }

  /** 发送一条协议请求（type + fields），转发给 daemon。 */
  send(req) {
    if (this.ws && this.connected) {
      this.ws.send(JSON.stringify(req));
    }
  }

  ping() {
    this.send({ type: "ping" });
  }

  /** 建连后先拉一次全量世界状态。 */
  bootstrap() {
    this.send({ type: "init" });
    this.send({ type: "listRooms" });
    this.send({ type: "listCharacters" });
    this.send({ type: "listSessions" });
    this.send({ type: "listTasks" });
    this.send({ type: "listModels" });
  }

  close() {
    this._closing = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }
}

module.exports = { SeekDaemonClient, RECONNECT_MS };
