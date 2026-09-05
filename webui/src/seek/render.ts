// render.ts — UI 纯渲染辅助（头像 / markdown / 工具卡片）
// 移植并微调自 seek-prototype 的 render.js，适配 React + 真实后端结构。

import type { Avatar } from "../types";
import type { CSSProperties } from "react";

// ---- 头像色板 ----
const AVATAR_PALETTE = [
  "#448aff", "#00b8d4", "#00c853", "#ffab00", "#ff5252",
  "#e040fb", "#7c4dff", "#00bfa5", "#ff6d00", "#5d4037",
];

export function avatarColor(name: string): string {
  let s = 0;
  const str = String(name || "");
  for (let i = 0; i < str.length; i++) s = (s * 31 + str.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[s % AVATAR_PALETTE.length];
}

export function avatarLabel(name: string, avatar?: Avatar | null): string {
  if (avatar && typeof avatar === "object" && avatar.text) return avatar.text;
  const n = String(name || "?").trim();
  if (!n) return "?";
  return n.length <= 2 ? n : n.slice(0, 2);
}

export function avatarStyleFor(avatar: Avatar | null, name: string): CSSProperties {
  if (avatar && avatar.type === "image" && avatar.src) {
    return {
      backgroundImage: `url("${avatar.src}")`,
      backgroundSize: "cover",
      backgroundPosition: "center",
    };
  }
  // 无 avatar（或 letter）→ 按名字哈希定色，白字
  const bg = avatar?.bg || avatarColor(name);
  const fg = avatar?.fg || "#fff";
  return { background: bg, color: fg };
}

// ---- 状态点色 ----
export function dotClass(status: string): string {
  return (
    {
      idle: "dot--idle",
      active: "dot--active",
      think: "dot--active",
      typing: "dot--active",
      busy: "dot--idle",
    }[status] || "dot--idle"
  );
}

export function statusText(status: string, name: string): string {
  return (
    {
      think: `${name} 在想…`,
      typing: `${name} 正在输入…`,
      busy: `${name} 忙`,
      idle: "",
    }[status] || ""
  );
}

// ---- Markdown 渲染（轻量，移植自原型）----
export function renderMarkdown(text: string): string {
  if (text == null) return "";
  const blocks = splitBlocks(String(text));
  return blocks
    .map((b) => {
      switch (b.type) {
        case "code":
          return renderCodeBlock(b);
        case "table":
          return renderTable(b);
        case "hr":
          return "<div class='md'><hr></div>";
        case "h":
          return `<div class='md'><h${Math.min(b.level ?? 1, 4)}>${b.text ?? ""}</h${Math.min(b.level ?? 1, 4)}></div>`;
        case "quote":
          return `<div class='md'><blockquote>${inline(b.text ?? "")}</blockquote></div>`;
        case "list":
          return renderList(b);
        default:
          return `<div class='md'><p>${inline(b.text ?? "")}</p></div>`;
      }
    })
    .join("");
}

type Block = {
  type: string;
  text?: string;
  level?: number;
  lang?: string;
  items?: { ordered: boolean; text: string }[];
  rows?: string[][];
  headers?: string[];
};

function splitBlocks(text: string): Block[] {
  const lines = text.split(/\r?\n/);
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^```/);
    if (m) {
      const lang = line.slice(3).trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      i++;
      blocks.push({ type: "code", lang, text: code.join("\n") });
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }
    const tbl = tryParseTable(lines, i);
    if (tbl) {
      blocks.push({ type: "table", rows: tbl.rows, headers: tbl.headers });
      i = tbl.endIndex;
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      blocks.push({ type: "h", level: h[1].length, text: inline(h[2]) });
      i++;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        q.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push({ type: "quote", text: q.join(" ") });
      continue;
    }
    if (/^(\s*)([-*+]|\d+\.)\s+/.test(line)) {
      const lst: { ordered: boolean; text: string }[] = [];
      while (i < lines.length) {
        const m2 = lines[i].match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
        if (!m2) break;
        lst.push({ ordered: /^\d+\./.test(m2[2]), text: m2[3] });
        i++;
      }
      blocks.push({ type: "list", items: lst });
      continue;
    }
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^(#{1,4})\s+|```|^\s*>\s?|^(\s*)([-*+]|\d+\.)\s+/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push({ type: "p", text: para.join(" ") });
  }
  return blocks;
}

function tryParseTable(lines: string[], start: number) {
  if (start + 1 >= lines.length) return null;
  const head = lines[start];
  if (!/^\s*\|.*\|\s*$/.test(head)) return null;
  const sep = lines[start + 1];
  if (!/^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/.test(sep)) return null;
  const headers = splitTableRow(head);
  const rows: string[][] = [];
  let idx = start + 2;
  while (idx < lines.length && /^\s*\|.*\|\s*$/.test(lines[idx])) {
    rows.push(splitTableRow(lines[idx]));
    idx++;
  }
  return { rows, headers, endIndex: idx };
}

function splitTableRow(line: string): string[] {
  return line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
}

function renderCodeBlock(b: Block): string {
  return `<pre><code class="language-${b.lang || ""}">${escapeHtml(b.text || "")}</code><button class="md-pre__copy" data-copy>复制</button></pre>`;
}

function renderTable(b: Block): string {
  const h = `<thead><tr>${(b.headers || []).map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead>`;
  const r = (b.rows || [])
    .map((row) => `<tr>${row.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
    .join("");
  return `<div class="md"><table>${h}<tbody>${r}</tbody></table></div>`;
}

function renderList(b: Block): string {
  const tag = b.items?.[0]?.ordered ? "ol" : "ul";
  return `<div class="md"><${tag}>${(b.items || []).map((it) => `<li>${inline(it.text)}</li>`).join("")}</${tag}></div>`;
}

function inline(text: string): string {
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, (_: string, c: string) => `<code>${c}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  s = highlightMentions(s);
  return s;
}

function highlightMentions(s: string): string {
  return s.replace(/@([\u4e00-\u9fa5\w]+)/g, (_, name) => {
    const cls = name === "我" ? "mention mention--me" : "mention";
    return `<span class="${cls}">@${name}</span>`;
  });
}

export function escapeHtml(s: string | null | undefined): string {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c;
  });
}
