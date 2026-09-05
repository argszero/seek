// SettingsView.tsx — 设置页（常驻非弹窗；Nav tab 切换）
import { useEffect, useState } from "react";
import { escapeHtml } from "../seek/render";
import type { ModelDetail } from "../types";
import {
  useStore,
  createCharacter,
  listTasks,
  triggerTask,
  setModel,
  saveSettings,
  getSettings,
} from "../seek/store";

type Tab = "model" | "appearance" | "language" | "tasks" | "roles" | "about";

export function SettingsView() {
  const [tab, setTab] = useState<Tab>("model");

  const tabs: { id: Tab; label: string }[] = [
    { id: "model", label: "模型服务" },
    { id: "appearance", label: "外观与主题" },
    { id: "language", label: "语言" },
    { id: "tasks", label: "定时任务" },
    { id: "roles", label: "角色管理" },
    { id: "about", label: "关于" },
  ];

  return (
    <div className="settings" id="settings">
      <div className="settings__nav">
        <div className="settings__nav-title">设置</div>
        {tabs.map((t) => (
          <button
            key={t.id}
            className={"settings__item" + (tab === t.id ? " settings__item--active" : "")}
            data-settings-tab={t.id}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="settings__main" id="settings-main">
        {tab === "model" && <ModelSettings />}
        {tab === "appearance" && <AppearanceSettings />}
        {tab === "language" && <LanguageSettings />}
        {tab === "tasks" && <TasksSettings />}
        {tab === "roles" && <RolesSettings />}
        {tab === "about" && <AboutSettings />}
      </div>
    </div>
  );
}

function AppearanceSettings() {
  return (
    <div>
      <h2 className="settings__h">外观</h2>
      <div className="settings-group">
        <div className="field">
          <label className="field__label">主题</label>
          <div className="theme-options">
            <button className="theme-option" data-theme-light="1">浅色</button>
            <button className="theme-option active" data-theme-dark="1">深色</button>
            <button className="theme-option" data-theme-system="1">跟随系统</button>
          </div>
        </div>
      </div>
      <div className="settings__hint">主题即点即生效（原型不落盘）。</div>
    </div>
  );
}

function LanguageSettings() {
  return (
    <div>
      <h2 className="settings__h">语言</h2>
      <div className="settings-group">
        <div className="field">
          <label className="field__label">界面语言</label>
          <div className="theme-options">
            <button className="theme-option">跟随系统</button>
            <button className="theme-option active">中文</button>
            <button className="theme-option">English</button>
          </div>
        </div>
      </div>
      <div className="settings__hint">原型仅记录语言偏好，不切换全站文案。</div>
    </div>
  );
}

function TasksSettings() {
  const state = useStore();
  useEffect(() => {
    // 进入定时任务 tab 时拉取最新任务列表
    listTasks();
  }, []);

  return (
    <div>
      <h2 className="settings__h">定时任务</h2>
      <p className="settings__placeholder">
        每个定时任务 = 一场普通会话 + schedule，到点读取该会话工作区{" "}
        <code>task_prompt.md</code> 注入消息。这里是所有会话定时任务的统一视图。
      </p>
      {state.tasks.length === 0 ? (
        <div className="schedule__empty">
          还没有任何定时任务。<br />在右栏「工作台」tab 里为某场会话新建一个。
        </div>
      ) : (
        <div>
          {state.tasks.map((t) => (
            <div key={t.id} className="task-row">
              <span className={"task-status" + (t.enabled ? " on" : " off")}>
                {t.enabled ? "● 启用" : "○ 停用"}
              </span>
              <div className="task-name">{escapeHtml(t.session?.name || t.id)}</div>
              <div className="task-meta">
                每 {t.interval} 秒
                {t.nextRun && <> · 下次 {escapeHtml(t.nextRun)}</>}
              </div>
              <div className="task-actions">
                <button
                  className="schedule-card__btn"
                  onClick={() => triggerTask(t.id)}
                >
                  触发
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RolesSettings() {
  const state = useStore();
  // 角色管理页只显示虚拟角色（决策：内置真人 you 不展示不可编辑）
  const virtuals = state.world.characters.filter((c) => c.kind !== "human");
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [name, setName] = useState("");
  const [persona, setPersona] = useState("");

  function toggleForm() {
    setShowForm((v) => !v);
    setName("");
    setPersona("");
  }

  function handleCreate() {
    const n = name.trim();
    if (!n || submitting) return;
    setSubmitting(true);
    createCharacter({ name: n, persona: persona.trim() || undefined });
    setName("");
    setPersona("");
    setShowForm(false);
    setSubmitting(false);
  }

  return (
    <div>
      <h2 className="settings__h">角色管理</h2>
      <div style={{ marginBottom: 16 }}>
        <button
          className="settings__btn"
          onClick={toggleForm}
        >
          {showForm ? "✕ 收起" : "＋ 新建角色"}
        </button>
      </div>

      {showForm && (
        <div className="settings-group">
          <div className="field">
            <label className="field__label">角色名</label>
            <input
              className="field__input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：小新"
            />
          </div>
          <div className="field">
            <label className="field__label">人设（可选）</label>
            <textarea
              className="field__input"
              style={{ minHeight: 64 }}
              value={persona}
              onChange={(e) => setPersona(e.target.value)}
              placeholder="给角色设定性格、背景、口头禅…"
            />
          </div>
          <button
            className="settings__btn settings__btn--primary"
            disabled={!name.trim()}
            onClick={handleCreate}
          >
            创建
          </button>
          <div className="settings__hint">
            新角色固定为虚拟人（kind = virtual），自动带字母头像；可在房间中作为成员加入。
          </div>
        </div>
      )}

      {virtuals.length === 0 ? (
        <div className="schedule__empty">暂无虚拟角色。</div>
      ) : (
        <div>
          {virtuals.map((c) => (
            <div key={c.id} className="role-card">
              <span className="role-card__avatar">{c.avatar?.type === "image" ? "🖼" : "🤖"}</span>
              <span className="role-card__body">
                <span className="role-card__name">{escapeHtml(c.name)}</span>
                <span className="role-card__sig">{c.persona ? escapeHtml(c.persona) : "无设定"}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AboutSettings() {
  return (
    <div>
      <h2 className="settings__h">关于</h2>
      <p className="settings__placeholder">Seek — AI-native IM。</p>
    </div>
  );
}

// ---- 模型服务（对齐 EMRG；读写真实 settings）----
function ModelSettings() {
  const state = useStore();
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  // modelDetails 来自 getSettings（后端 config.toml 的 [[llm.models]]），
  // 本地编辑后在「保存」时整体写回（增/改/删都通过重写此列表表达）。
  const [details, setDetails] = useState<ModelDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null); // 正在编辑的模型名
  const [draft, setDraft] = useState<ModelDetail>({ name: "", model: "", vision: false });

  // 连接就绪后拉取 settings；用 useEffect 在 settings 变化时同步本地状态。
  useEffect(() => {
    if (state.settings && state.settings.modelDetails) {
      setApiKey(state.settings.apiKey ?? "");
      setBaseUrl(state.settings.baseUrl ?? "");
      setDefaultModel(state.settings.model ?? "");
      setDetails(state.settings.modelDetails ?? []);
      setLoading(false);
    }
  }, [state.settings]);

  function setDefault(name: string) {
    // 真正发送 switchModel（modelKey = 模型 name）。
    setModel(name);
  }

  function removeDetail(name: string) {
    setDetails((d) => d.filter((x) => x.name !== name));
  }

  function startEdit(name: string) {
    const d = details.find((x) => x.name === name);
    if (!d) return;
    setEditing(name);
    setDraft({ ...d });
  }

  function handleSave() {
    // 保存写回 config.toml：直接从 DOM 读值（.value= 不触发 input → 读空）。
    const keyInput = document.querySelector<HTMLInputElement>("#model-api-key");
    const urlInput = document.querySelector<HTMLInputElement>("#model-base-url");
    const modelInput = document.querySelector<HTMLInputElement>("#model-default");
    saveSettings({
      apiKey: keyInput?.value ?? apiKey,
      baseUrl: urlInput?.value ?? baseUrl,
      model: modelInput?.value ?? defaultModel,
      modelDetails: details,
    });
    getSettings(); // 拉取刷新（后端会广播 model:changed）
  }

  return (
    <div>
      <h2 className="settings__h">模型服务</h2>
      <div className="settings-group">
        <div className="settings-group-title">可用模型（来自 config.toml）</div>
        <div className="model-list">
          {loading && <div className="model-list-empty">加载中…</div>}
          {!loading && details.length === 0 && (
            <div className="model-list-empty">暂无模型，点下方「＋添加模型」。</div>
          )}
          {details.map((m) => {
            const isDefault = m.name === defaultModel || m.name === state.world.model;
            return (
              <div key={m.name} className={"model-item" + (isDefault ? " default" : "")}>
                <button
                  className={"model-radio" + (isDefault ? " checked" : "")}
                  onClick={() => setDefault(m.name)}
                  title="设为默认"
                >
                  {isDefault ? "●" : "○"}
                </button>
                <span className="model-name">
                  {escapeHtml(m.name)}
                  {isDefault && <span className="model-badge">默认</span>}
                </span>
                {m.vision && <span className="model-vision">🖼 支持图片</span>}
                <span className="model-actions">
                  <button className="model-action-btn" onClick={() => startEdit(m.name)}>编辑</button>
                  {!isDefault && (
                    <button className="model-action-btn danger" onClick={() => removeDetail(m.name)}>删除</button>
                  )}
                </span>
              </div>
            );
          })}
        </div>

        {editing && (
          <div className="field" style={{ marginTop: 8 }}>
            <label className="field__label">编辑 {editing}（API 模型名）</label>
            <input
              className="field__input"
              data-model-draft="model"
              defaultValue={draft.model ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
            />
            <label className="field__label">contextWindow</label>
            <input
              className="field__input"
              type="number"
              data-model-draft="contextWindow"
              defaultValue={String(draft.contextWindow ?? "")}
              onChange={(e) => setDraft((d) => ({ ...d, contextWindow: Number(e.target.value) || null }))}
            />
            <label className="field__label">
              <input
                type="checkbox"
                checked={!!draft.vision}
                onChange={(e) => setDraft((d) => ({ ...d, vision: e.target.checked }))}
              /> 支持图片
            </label>
            <div className="model-actions" style={{ marginTop: 8 }}>
              <button
                className="model-action-btn"
                onClick={() => {
                  const clean = { ...draft, model: (draft.model || "").trim() };
                  setDetails((d) => d.map((x) => (x.name === editing ? clean : x)));
                  setEditing(null);
                }}
              >
                确认
              </button>
              <button className="model-action-btn" onClick={() => setEditing(null)}>取消</button>
            </div>
          </div>
        )}

        <div className="field" style={{ marginTop: 16 }}>
          <label className="field__label">API Key</label>
          <input
            id="model-api-key"
            className="field__input"
            type="password"
            defaultValue={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </div>
        <div className="field">
          <label className="field__label">接口地址</label>
          <input
            id="model-base-url"
            className="field__input"
            type="text"
            placeholder="https://api.deepseek.com"
            defaultValue={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </div>
        <div className="field">
          <label className="field__label">默认模型</label>
          <input
            id="model-default"
            className="field__input"
            type="text"
            defaultValue={defaultModel}
            onChange={(e) => setDefaultModel(e.target.value)}
          />
        </div>
        <div className="model-actions" style={{ marginTop: 8 }}>
          <button
            className="settings__btn"
            onClick={() => {
              setDetails((d) => {
                const name = draft.name || `model-${d.length + 1}`;
                setDraft({ name: "", model: "", vision: false });
                return [...d, { name, model: draft.model || "", vision: draft.vision }];
              });
            }}
          >
            ＋添加模型
          </button>
        </div>
        <div className="settings__hint">点左侧圆点设为默认（后端 switchModel 切 api 模型，下一条消息生效，重启恢复 config.toml 默认）。「保存」把上面的 API Key / 接口地址 / 模型列表写回 config.toml。</div>
      </div>
      <div className="settings-actions">
        <button className="settings__btn" onClick={handleSave}>保存</button>
      </div>
    </div>
  );
}
