# 🧭 seek

<p align="center">
  <strong>一款即时通讯软件，你在这里和真人聊天——也和会干活的 AI 角色聊天。</strong>
</p>

<p align="center">
  <img alt="Python" src="https://img.shields.io/badge/Python-3.13-blue.svg">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-React-blue.svg">
  <img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg">
  <img alt="CI" src="https://github.com/argszero/seek/actions/workflows/test.yml/badge.svg">
</p>

<p align="center">
  <a href="README.md">🇬🇧 English</a> | <b>🇨🇳 中文</b>
</p>

---

**如果你的群聊里住着「有脑子」的角色——而且它们真的会干活，会怎样？**

打开 `seek`，你走进的房间里有面孔、有性格、有主见、还有真的把事做完能力的角色。有的是你认识的真人，有的是你亲手带「活」的 AI——给它名字、面孔、说话方式。它们不只是回复你，它们会**思考、争论、行动**：跑代码、读文件、改东西，并且直接在聊天里把活儿展示出来。

> *"I Seek You —— IM 最初的精神。像 ICQ 那样打字，像你认识的角色那样有型。"*

它不是「带聊天框的开发工具」，而是**带 AI 灵魂的聊天软件**——QQ 的心智，DeepSeek 的内核。

---

## ✨ 为什么你会喜欢它

**一句话卖点**：`seek` 是那个群聊里塞满有真性格、真工具的 AI 角色的聊天软件——所以「聊工作」和「干活」在同一个地方发生。

| 是什么 | 意味着什么 |
|---|---|
| 🧑 **真人与 AI 并肩** | 每个房间都是群。你、朋友、AI 角色都是平等的成员——大家都是同一场对话里的角色。 |
| 🗣️ **有面孔、有性格的角色** | AI 不是空白盒子，而是一个你定义的角色：名字、面孔、人设、说话方式。把它带「活」，看它有主见、会斗嘴。 |
| 🛠️ **说得到，也做得到** | 角色跑代码、读文件、改东西时，会在消息流里显示成可折叠的卡片——像朋友甩给你一张截图，而不是单独的「工作台」。 |
| 🍳 **装得下一段生活的房间** | 每个房间是随时间延续的群聊。每段会话绑定一个工作区——真正干活发生的舞台。 |
| ⚡ **一个应用，四种打开方式** | Python daemon 后端 + TUI + 浏览器 UI + 桌面应用——都通过一个协议连到同一个世界。 |
| 🌍 **100% 开源** | MIT，无围墙花园、无厂商锁定。国际化——英文默认，中文版可用。 |

---

## 心智模型（三层）

```
世界      (你 + 你认识的角色)       — 谁在这里，跟谁聊
房间      (房间 = 一个群聊)          — 对话在哪里发生
消息      (一次「谁说了什么」)       — 消息流
```

每条消息都有说话者、时间、形态（文本 / 图片 / 工具卡 / 系统）。说话与做事都折进消息里。

---

## 架构

`seek` 是一个 monorepo——三个前端通过单一 WebSocket 协议连到一个后端。前端不 import 后端代码，纯靠协议契约通信。

```
seek/
├── backend/     # Python daemon (seekd) — 唯一后端。WebSocket IPC + 群聊编排 + agent + 内嵌 WEBUI 静态服务器
├── tui/         # TUI 客户端 (Python curses) — 独立；未来可由 Rust 基于同一协议替换
├── webui/       # WEBUI 客户端 (React + TypeScript + Vite) — 跑在浏览器
├── gui/         # GUI 客户端 (Electron) — 加载 webui/dist 的外壳
├── packaging/   # 安装器 (Inno Setup .exe / macOS .pkg) + stop_all
└── docs/        # 设计文档
```

协议契约在 [`CONTRACT.md`](CONTRACT.md)——每个客户端必须对齐的 WebSocket 消息格式的权威定义。

---

## 状态

`seek` 处于早期开发。脚手架、产品心智模型、架构决策已定，核心闭环端到端可用。历史见 [changelog](CHANGELOG.md)，完整产品心智与实体关系见[设计文档](docs/designs/)。

## 安装

安装器为 Windows 和 macOS 构建，随每个 GitHub release 发布。安装器在替换文件前会停止正在运行的 `seek` 进程，因此升级不会因文件锁定而失败。

## 贡献

欢迎贡献。请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 了解环境搭建、约定和提交 PR 前要跑的检查。所有人都应遵守[行为准则](CODE_OF_CONDUCT.md)。

## 安全

如果你认为自己发现了漏洞，请看 [SECURITY.md](SECURITY.md) 并**私密**报告。不要为安全问题开公开 issue。

## 许可证

[MIT](LICENSE) — © 2026 argszero
