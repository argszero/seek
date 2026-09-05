// render.test.ts — pure-function unit tests for seek/render.ts
import { describe, it, expect } from "vitest";
import type { Avatar } from "../types";
import {
  avatarColor,
  avatarLabel,
  avatarStyleFor,
  dotClass,
  statusText,
  escapeHtml,
  renderMarkdown,
} from "./render";

function letterAvatar(p?: Partial<Avatar>): Avatar {
  return { type: "letter", text: "", bg: "", fg: "", src: "", ...p };
}
function imageAvatar(p?: Partial<Avatar>): Avatar {
  return { type: "image", text: "", bg: "", fg: "", src: "", ...p };
}

describe("avatarColor", () => {
  it("is deterministic and in the palette", () => {
    const c = avatarColor("小明");
    expect(avatarColor("小明")).toBe(c);
    expect(c).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
  it("handles empty name without crashing", () => {
    const c = avatarColor("");
    expect(c).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
});

describe("avatarLabel", () => {
  it("prefers a provided avatar text", () => {
    expect(avatarLabel("小明", letterAvatar({ text: "X" }))).toBe("X");
  });
  it("takes first 2 chars of a long name", () => {
    expect(avatarLabel("张三丰")).toBe("张三");
  });
  it("keeps a short name as-is", () => {
    expect(avatarLabel("a")).toBe("a");
  });
  it("falls back to '?' on empty", () => {
    expect(avatarLabel("")).toBe("?");
  });
});

describe("avatarStyleFor", () => {
  it("uses background-image for an image avatar", () => {
    const s = avatarStyleFor(imageAvatar({ src: "http://x/y.png" }), "小");
    expect(s.backgroundImage).toContain("http://x/y.png");
  });
  it("uses bg by name hash for a letter avatar (no bg given)", () => {
    const s = avatarStyleFor(letterAvatar(), "小");
    expect(s.background).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(s.color).toBe("#fff");
  });
  it("respects explicit bg/fg on a letter avatar", () => {
    const s = avatarStyleFor(letterAvatar({ bg: "#112233", fg: "#aa" }), "小");
    expect(s.background).toBe("#112233");
    expect(s.color).toBe("#aa");
  });
});

describe("dotClass", () => {
  it("maps statuses to dot classes", () => {
    expect(dotClass("idle")).toBe("dot--idle");
    expect(dotClass("typing")).toBe("dot--active");
    expect(dotClass("think")).toBe("dot--active");
    expect(dotClass("busy")).toBe("dot--idle");
  });
  it("falls back to idle for unknown", () => {
    expect(dotClass("nope")).toBe("dot--idle");
  });
});

describe("statusText", () => {
  it("renders per-status text with the name", () => {
    expect(statusText("typing", "小明")).toBe("小明 正在输入…");
    expect(statusText("think", "小明")).toBe("小明 在想…");
    expect(statusText("busy", "小明")).toBe("小明 忙");
    expect(statusText("idle", "小明")).toBe("");
  });
  it("returns empty for unknown", () => {
    expect(statusText("garbage", "小")).toBe("");
  });
});

describe("escapeHtml", () => {
  it("escapes <>&\"'", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  });
});

describe("renderMarkdown", () => {
  it("wraps paragraphs in md divs", () => {
    expect(renderMarkdown("hello")).toContain("hello");
  });
  it("handles null/undefined as empty", () => {
    expect(renderMarkdown(null as unknown as string)).toBe("");
    expect(renderMarkdown(undefined as unknown as string)).toBe("");
  });
  it("renders quoted text", () => {
    const out = renderMarkdown("> 引用");
    expect(out).toContain("引用");
  });
});
