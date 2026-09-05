"use strict";
// tests/daemon_client.test.js — unit test SeekDaemonClient against a mock WS server.
//
// Runs with `node --test` (no display / Electron needed): we spin up a real ws
// server, connect a SeekDaemonClient to it, and assert the CONTRACT flow
// (connect -> onState(true), send -> server sees JSON, bootstrap -> init sent,
// close -> onState(false) and no reconnect).

const { test } = require("node:test");
const assert = require("node:assert");
const { WebSocketServer } = require("ws");
const { SeekDaemonClient } = require("../daemon_client");

function startServer() {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const received = []; // every raw message the server got
  let socket = null;
  wss.on("connection", (s) => {
    socket = s;
    s.on("message", (raw) => {
      received.push(JSON.parse(raw.toString("utf8")));
      s.send(JSON.stringify({ type: "pong" }));
    });
  });
  return new Promise((resolve) => {
    wss.on("listening", () => {
      const port = wss.address().port;
      resolve({ wss, received, getSocket: () => socket });
    });
  });
}

test("connects, sends init/bootstrap, and closes cleanly", async () => {
  const { wss, received, getSocket } = await startServer();
  const port = wss.address().port;

  const states = [];
  let events = [];
  const client = new SeekDaemonClient({
    host: "127.0.0.1",
    port,
    onEvent: (m) => events.push(m),
    onState: (r) => states.push(r),
  });

  client.connect();
  // wait for the connection to open
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(getSocket(), "client connected to server");

  client.send({ type: "ping" });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(received.some((m) => m.type === "ping"), "server saw ping");
  assert.ok(events.some((m) => m.type === "pong"), "client got pong as event");

  client.bootstrap();
  await new Promise((r) => setTimeout(r, 50));
  const initSent = received.some((m) => m.type === "init");
  assert.ok(initSent, "bootstrap sent init");

  client.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(client.connected, false, "client closed");
  await closeServer(wss);
});

test("reconnects after an unexpected drop", async () => {
  const { wss } = await startServer();
  const port = wss.address().port;

  const states = [];
  const client = new SeekDaemonClient({
    host: "127.0.0.1", port,
    onEvent: () => {},
    onState: (r) => states.push(r),
  });
  client.connect();
  await new Promise((r) => setTimeout(r, 80));
  const beforeClose = states.filter((s) => s === true).length;
  assert.ok(beforeClose >= 1, "connected");

  // drop every connection so the client sees close -> schedules reconnect
  wss.clients.forEach((c) => c.terminate());
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(states.includes(false), "saw disconnected state");
  // close the client so its reconnect timer is cleared (avoids hanging the loop)
  client.close();
  await closeServer(wss);
});

test("client URI derives from host/port", () => {
  const c = new SeekDaemonClient({ host: "10.0.0.5", port: 9123 });
  assert.strictEqual(c.uri, "ws://10.0.0.5:9123");
});

/** Close a ws server (and all client sockets) without leaking the loop. */
async function closeServer(wss) {
  wss.clients.forEach((c) => c.terminate());
  await new Promise((resolve) => wss.close(resolve));
}
