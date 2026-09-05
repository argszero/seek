// Rightbar.tsx — 右栏（默认收起；成员列表 / 工作台 两个 tab）
import { useState, useEffect } from "react";
import { activeSession, activeRoom, findCharacter, useStore, addRoomMember, removeRoomMember, listTasks, triggerTask, listWorkspaceFiles, readWorkspaceFile, isMe } from "../seek/store";
import { avatarLabel, avatarStyleFor, escapeHtml } from "../seek/render";
import type { Session } from "../types";

interface RightbarProps {
  open: boolean;
  tab: "members" | "workbench";
  onTab: (t: "members" | "workbench") => void;
  width: number;
}

export function Rightbar({ open, tab, onTab, width }: RightbarProps) {
  const room = activeRoom();
  const sess = activeSession();
  const state = useStore();
  const members = room?.memberIds ?? [];
  const [inviting, setInviting] = useState(false);

  // 可邀请 = 所有角色 - 已在房间内的成员
  const inRoom = new Set(members);
  const invitable = state.world.characters.filter((c) => !inRoom.has(c.id));

  function invite(cid: string) {
    if (!room) return;
    addRoomMember(room.id, cid);
    setInviting(false);
  }

  function remove(cid: string) {
    if (!room) return;
    removeRoomMember(room.id, cid);
  }

  return (
    <aside className={"rightbar" + (open ? " rightbar--open" : "")}>
      <div className="rightbar__inner" style={{ width: `${width}px` }}>
        <div className="rightbar__tabs">
          <button
            className={"rightbar__tab" + (tab === "members" ? " rightbar__tab--active" : "")}
            onClick={() => onTab("members")}
          >
            成员
          </button>
          <button
            className={"rightbar__tab" + (tab === "workbench" ? " rightbar__tab--active" : "")}
            onClick={() => onTab("workbench")}
          >
            工作台
          </button>
        </div>

        {tab === "members" ? (
          <>
            <div className="rightbar__header">
              <span className="rightbar__count">成员 {members.length}</span>
              <button className="rightbar__invite" id="invite-btn" onClick={() => setInviting(true)}>
                ＋ 邀请
              </button>
            </div>

            {members.map((id) => {
              const ch = findCharacter(id);
              if (!ch) return null;
              const me = isMe(id);
              const name = me ? "我" : ch.name;
              return (
                <div className="member-row" key={id}>
                  <span className="member-row__avatar" style={avatarStyleFor(ch.avatar, name)}>
                    {avatarLabel(name, ch.avatar)}
                  </span>
                  <span className="member-row__name">{escapeHtml(name)}</span>
                  <span className="kind-badge">{me ? "我" : (ch.kind === "human" ? "人" : "虚拟")}</span>
                  {!me && (
                    <button
                      className="member-row__remove"
                      title="移除成员"
                      onClick={() => remove(id)}
                    >
                      ✕
                    </button>
                  )}
                </div>
              );
            })}

            {inviting && (
              <div className="invite-pop" id="invite-pop">
                <div className="invite-pop__title">邀请成员</div>
                {invitable.length === 0 && (
                  <div className="invite-pop__empty">没有可邀请的角色了。</div>
                )}
                {invitable.map((c) => (
                  <button
                    key={c.id}
                    className="invite-pop__item"
                    onClick={() => invite(c.id)}
                  >
                    <span className="invite-pop__avatar" style={avatarStyleFor(c.avatar, c.name)}>
                      {avatarLabel(c.name, c.avatar)}
                    </span>
                    <span className="invite-pop__name">{escapeHtml(c.name)}</span>
                    <span className="kind-badge">{c.kind === "human" ? "人" : "虚拟"}</span>
                  </button>
                ))}
                <button className="invite-pop__close" onClick={() => setInviting(false)}>取消</button>
              </div>
            )}
          </>
        ) : (
          <WorkbenchTab sess={sess} />
        )}
      </div>
    </aside>
  );
}

function WorkbenchTab({ sess }: { sess?: Session | null }) {
  const state = useStore();
  const [openFile, setOpenFile] = useState<string | null>(null);
  useEffect(() => { listTasks(); }, [sess?.id]);
  useEffect(() => { if (sess?.id) listWorkspaceFiles(sess.id); }, [sess?.id]);
  // 本会话的任务（task.id 即其关联 session.id）
  const mine = state.tasks.filter((t) => t.id === sess?.id || t.session?.id === sess?.id);
  // 本会话的工作区文件（top-level 列表）
  const files = sess?.id ? (state.workspaceFiles[sess.id] || []) : [];
  // 已打开文件的文本内容
  const body = sess && openFile
    ? (state.workspaceFileContent[`${sess.id}:${openFile}`] ?? "")
    : "";

  return (
    <div className="workbench">
      <div className="workbench__label">工作空间（会话级，锁定）</div>
      <div className="member-row">
        <span className="member-row__avatar">📁</span>
        <span className="member-row__name">{escapeHtml(sess?.workspace || "?")}</span>
      </div>
      <button className="rightbar__invite full" id="pick-ws">
        切换工作空间
      </button>
      <div className="workbench__label">工作区文件</div>
      {files.length === 0 ? (
        <div className="schedule__empty">工作区暂无文件。<br />模型可读写这里的文件作为上下文。</div>
      ) : (
        <ul className="ws-files">
          {files.map((f) => (
            <li key={f.name}>
              <button
                className={"ws-file" + (openFile === f.name ? " open" : "")}
                disabled={f.isDir}
                title={f.path}
                onClick={() => {
                  if (f.isDir) return;
                  if (openFile === f.name) { setOpenFile(null); return; }
                  setOpenFile(f.name);
                  if (sess) readWorkspaceFile(sess.id, f.name);
                }}
              >
                <span className="ws-file__icon">{f.isDir ? "📁" : "📄"}</span>
                <span className="ws-file__name">{escapeHtml(f.name)}</span>
                <span className="ws-file__size">
                  {f.isDir ? "" : formatSize(f.size)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {body !== "" && openFile && (
        <div className="ws-file-preview">
          <div className="ws-file-preview__head">
            <span>{escapeHtml(openFile)}</span>
            <button className="ws-file-preview__close" onClick={() => setOpenFile(null)}>×</button>
          </div>
          <pre className="ws-file-preview__body">{escapeHtml(body)}</pre>
        </div>
      )}
      <div className="workbench__label2">
        <span>⏱ 定时任务</span>
        <span style={{ fontWeight: 400 }}>随会话</span>
      </div>
      {mine.length === 0 ? (
        <div className="schedule__empty">
          本会话还没有定时任务。
          <br />
          定时任务 = 到点读取工作区 task_prompt.md，向会话注入一条消息。
        </div>
      ) : (
        mine.map((t) => (
          <div key={t.id} className="task-row">
            <span className={"task-status" + (t.enabled ? " on" : " off")}>
              {t.enabled ? "● 启用" : "○ 停用"}
            </span>
            <div className="task-meta">每 {t.interval} 秒</div>
            <div className="task-actions">
              <button className="schedule-card__btn" onClick={() => triggerTask(t.id)}>触发</button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function formatSize(size: number | null): string {
  if (size == null) return "";
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
  return `${(size / (1024 * 1024)).toFixed(1)}MB`;
}
