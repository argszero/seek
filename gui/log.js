"use strict";
/**
 * gui/log.js — file logging for the seek GUI main process.
 *
 * When the GUI is launched from Finder/Launchpad there is no terminal, so every
 * console.* output and process-level crash lands in:
 *
 *     ~/.seek/logs/gui.log
 *
 * (or $SEEK_HOME/logs/gui.log when SEEK_HOME is set). installLogging() must be
 * called from main.js before anything else so even early bootstrap errors are
 * captured. It rewires console.log/info/warn/error to append a timestamped line
 * to the file AND still forward to the original console when one exists (dev).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

function dataRoot() {
  if (process.env.SEEK_HOME) return process.env.SEEK_HOME;
  return path.join(os.homedir(), ".seek");
}

function logFilePath() {
  return path.join(dataRoot(), "logs", "gui.log");
}

let _stream = null;

/** Append one line (timestamped) to the GUI log file. */
function writeLog(level, args) {
  if (!_stream) return;
  const ts = new Date().toISOString();
  const msg = args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return `${a.message}\n${a.stack || ""}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
  _stream.write(`[${ts}] ${level} ${msg}\n`);
}

/** Install file logging. Returns the log file path. */
function installLogging() {
  const file = logFilePath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    _stream = fs.createWriteStream(file, { flags: "a" });
  } catch (e) {
    // Logging must never take the app down; degrade to silent.
    // eslint-disable-next-line no-console
    console.error("[seek-gui] cannot open log file", file, e);
    return file;
  }

  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const levels = { log: "INFO", info: "INFO", warn: "WARN", error: "ERROR" };
  for (const k of Object.keys(orig)) {
    console[k] = (...args) => {
      writeLog(levels[k], args);
      if (typeof orig[k] === "function") orig[k](...args);
    };
  }

  // Process-level crashes land in the file too.
  process.on("uncaughtException", (err) => {
    writeLog("FATAL", [err]);
    // eslint-disable-next-line no-console
    console.error("[seek-gui] uncaughtException", err);
  });
  process.on("unhandledRejection", (reason) => {
    writeLog("ERROR", ["unhandledRejection", reason]);
  });

  writeLog("INFO", ["[seek-gui] logging installed at", file]);
  return file;
}

module.exports = { installLogging, logFilePath };
