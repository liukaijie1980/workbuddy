import { useEffect, useMemo, useState } from "react";
import {
  attachLibrary,
  createCron,
  createTask,
  deleteCron,
  fetchAudit,
  fetchCompat,
  fetchCron,
  fetchLibraryFile,
  fetchLibraryTree,
  fetchLocalConfig,
  fetchSkillDetail,
  fetchWbSessions,
  importWorkBuddy,
  loadSettings,
  probeBridge,
  probeGateway,
  runCronNow,
  saveSettings,
  streamChat,
  type AgentDeskSettings,
  type AuditEntry,
  type ChatMessage,
  type CronJob,
  type LibraryNode,
} from "./api";

type Tab = "library" | "skills" | "cron" | "sessions" | "audit" | "settings";

type WbSession = {
  id: string;
  title: string;
  status: string;
  cwd: string;
  model: string;
  updated_at: number;
};

type Focus =
  | {
      kind: "file";
      path: string;
      size?: number;
      binary?: boolean;
      preview: string | null;
      loading?: boolean;
    }
  | {
      kind: "skill";
      name: string;
      source?: string;
      body?: string;
      loading?: boolean;
    }
  | { kind: "cron"; job: CronJob }
  | { kind: "session"; session: WbSession }
  | { kind: "audit"; entry: AuditEntry };

function formatEvery(ms: number) {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${Math.round(ms / 3600000)}h`;
}

function LibraryTreeView({
  nodes,
  selected,
  focusPath,
  onToggle,
  onOpen,
}: {
  nodes: LibraryNode[];
  selected: Set<string>;
  focusPath?: string;
  onToggle: (path: string, type: string) => void;
  onOpen: (path: string, type: string) => void;
}) {
  return (
    <ul className="tree">
      {nodes.map((n) => (
        <li key={n.path}>
          {n.type === "file" ? (
            <button
              type="button"
              className={`tree-item ${selected.has(n.path) ? "on" : ""} ${focusPath === n.path ? "focus" : ""}`}
              onClick={() => onOpen(n.path, n.type)}
              onDoubleClick={() => onToggle(n.path, n.type)}
              title={`${n.path}\n单击预览 · 双击勾选`}
            >
              <span className="tree-mark">{selected.has(n.path) ? "[*]" : "[F]"}</span>
              <span>{n.name}</span>
            </button>
          ) : (
            <details open={n.path === "mine"}>
              <summary>
                <span className="tree-mark">[D]</span>
                {n.name}
                {n.children?.length ? ` (${n.children.length})` : ""}
              </summary>
              {n.children && n.children.length > 0 ? (
                <LibraryTreeView
                  nodes={n.children}
                  selected={selected}
                  focusPath={focusPath}
                  onToggle={onToggle}
                  onOpen={onOpen}
                />
              ) : (
                <div className="hint pad">空目录</div>
              )}
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}

function FocusPanel({
  focus,
  selectedCount,
  onClose,
  onUseSkill,
  onAttachFocus,
  onToggleSelect,
  isSelected,
}: {
  focus: Focus | null;
  selectedCount: number;
  onClose: () => void;
  onUseSkill: () => void;
  onAttachFocus: () => void;
  onToggleSelect: () => void;
  isSelected: boolean;
}) {
  if (!focus) {
    return (
      <div className="focus-panel empty-focus">
        <div>
          <strong>右侧联动区</strong>
          <p>在左侧点选资料文件、Skill、定时任务、会话或审计条目，这里会显示详情并可写入任务草稿。</p>
        </div>
      </div>
    );
  }

  return (
    <div className="focus-panel">
      <div className="focus-head">
        <div>
          <div className="focus-kind">{focus.kind}</div>
          <h2 className="focus-title">
            {focus.kind === "file" && focus.path}
            {focus.kind === "skill" && focus.name}
            {focus.kind === "cron" && focus.job.name}
            {focus.kind === "session" && (focus.session.title || focus.session.id.slice(0, 8))}
            {focus.kind === "audit" && String(focus.entry.event || "event")}
          </h2>
        </div>
        <button type="button" className="ghost" onClick={onClose}>
          关闭
        </button>
      </div>

      {focus.kind === "file" && (
        <>
          <div className="row gap">
            <button type="button" className="ghost" onClick={onToggleSelect}>
              {isSelected ? "取消勾选" : "勾选此文件"}
            </button>
            <button type="button" className="accent" onClick={onAttachFocus}>
              加入任务草稿
            </button>
            {selectedCount > 0 ? <span className="hint">已勾选 {selectedCount} 个</span> : null}
          </div>
          <p className="hint">
            {focus.loading
              ? "加载中…"
              : focus.binary
                ? `二进制/过大文件 · ${focus.size ?? "?"} bytes`
                : `预览 · ${focus.size ?? "?"} bytes`}
          </p>
          <pre className="focus-body">{focus.preview || (focus.loading ? "…" : "(无文本预览)")}</pre>
        </>
      )}

      {focus.kind === "skill" && (
        <>
          <div className="row gap">
            <button type="button" className="accent" onClick={onUseSkill}>
              写入任务草稿
            </button>
            <span className="hint">{focus.source || ""}</span>
          </div>
          <pre className="focus-body">{focus.loading ? "加载中…" : focus.body || "(空)"}</pre>
        </>
      )}

      {focus.kind === "cron" && (
        <pre className="focus-body">
          {`周期: 每 ${formatEvery(focus.job.everyMs)}\n状态: ${focus.job.lastStatus || "pending"}\n错误: ${focus.job.lastError || "-"}\n\nPrompt:\n${focus.job.prompt}\n\n最近输出:\n${focus.job.lastOutput || "(无)"}`}
        </pre>
      )}

      {focus.kind === "session" && (
        <pre className="focus-body">
          {`id: ${focus.session.id}\nstatus: ${focus.session.status}\nmodel: ${focus.session.model}\ncwd: ${focus.session.cwd}\nupdated: ${focus.session.updated_at}`}
        </pre>
      )}

      {focus.kind === "audit" && (
        <pre className="focus-body">{JSON.stringify(focus.entry, null, 2)}</pre>
      )}
    </div>
  );
}

export default function App() {
  const [settings, setSettings] = useState<AgentDeskSettings>(() => loadSettings());
  const [tab, setTab] = useState<Tab>("library");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [gatewayOk, setGatewayOk] = useState(false);
  const [bridgeOk, setBridgeOk] = useState(false);
  const [gatewayDetail, setGatewayDetail] = useState("未探测");
  const [bridgeDetail, setBridgeDetail] = useState("未探测");
  const [error, setError] = useState<string | null>(null);

  const [tree, setTree] = useState<LibraryNode[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<Focus | null>(null);
  const [compat, setCompat] = useState<{
    matched?: string[];
    onlyInWorkBuddy?: string[];
    openclawWorkspaceSkills?: Array<{ name: string; source?: string }>;
  } | null>(null);
  const [cronJobs, setCronJobs] = useState<CronJob[]>([]);
  const [cronName, setCronName] = useState("每日简报");
  const [cronPrompt, setCronPrompt] = useState("汇总 library/mine 中的要点，写入 library/outputs。");
  const [cronEveryMin, setCronEveryMin] = useState(60);
  const [sessions, setSessions] = useState<WbSession[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await fetchLocalConfig(settings);
        if (cancelled || !cfg?.token) return;
        setSettings((s) => {
          if (!s.token.trim() || s.token.trim() !== cfg.token) {
            return { ...s, token: cfg.token || s.token };
          }
          return s;
        });
      } catch {
        /* bridge may be down on first paint */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshHealth() {
    const g = await probeGateway(settings);
    setGatewayOk(g.ok);
    setGatewayDetail(g.detail);
    const b = await probeBridge(settings);
    setBridgeOk(b.ok);
    setBridgeDetail(b.detail);
  }

  async function refreshLibrary() {
    const data = await fetchLibraryTree(settings);
    setTree(data.tree || []);
  }

  async function refreshSideData() {
    try {
      await refreshLibrary();
    } catch {
      /* bridge may be down */
    }
    try {
      setCompat(await fetchCompat(settings));
    } catch {
      /* ignore */
    }
    try {
      const c = await fetchCron(settings);
      setCronJobs(c.jobs || []);
    } catch {
      /* ignore */
    }
    try {
      const s = await fetchWbSessions(settings);
      setSessions(s.sessions || []);
    } catch {
      /* ignore */
    }
    try {
      const a = await fetchAudit(settings);
      setAudit(a.entries || []);
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    void refreshHealth();
    void refreshSideData();
    const t = setInterval(() => void refreshHealth(), 15000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.gatewayBase, settings.bridgeBase, settings.token]);

  const canSend = useMemo(() => draft.trim().length > 0 && !busy, [draft, busy]);

  function toggleFile(path: string, type: string) {
    if (type !== "file") return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function openFile(path: string, type: string) {
    if (type !== "file") return;
    setFocus({ kind: "file", path, preview: null, loading: true });
    try {
      const data = await fetchLibraryFile(settings, path);
      setFocus({
        kind: "file",
        path: data.path || path,
        size: data.size,
        binary: data.binary,
        preview: data.preview,
        loading: false,
      });
    } catch (e) {
      setFocus({
        kind: "file",
        path,
        preview: String(e instanceof Error ? e.message : e),
        loading: false,
      });
    }
  }

  async function openSkill(name: string) {
    setFocus({ kind: "skill", name, loading: true });
    try {
      const data = await fetchSkillDetail(settings, name);
      setFocus({
        kind: "skill",
        name: data.name,
        source: data.source,
        body: data.body,
        loading: false,
      });
    } catch (e) {
      setFocus({
        kind: "skill",
        name,
        body: String(e instanceof Error ? e.message : e),
        loading: false,
      });
    }
  }

  function useFocusedSkill() {
    if (!focus || focus.kind !== "skill") return;
    const snippet = `请使用 Skill「${focus.name}」完成任务。\n\n（Skill 说明已在工作区 skills/${focus.name}/SKILL.md）`;
    setDraft((d) => (d ? `${snippet}\n\n${d}` : snippet));
  }

  async function attachPaths(paths: string[]) {
    if (!paths.length) return;
    const { snippet } = await attachLibrary(settings, paths);
    setDraft((d) => (d ? `${snippet}\n\n${d}` : `${snippet}\n\n请基于以上资料继续。`));
    await createTask(settings, `任务 · ${paths[0]}`, paths);
    setTab("library");
  }

  async function onAttachToTask() {
    await attachPaths([...selected]);
  }

  async function onAttachFocusFile() {
    if (!focus || focus.kind !== "file") return;
    await attachPaths([focus.path]);
  }

  async function onSend() {
    const content = draft.trim();
    if (!content || busy) return;
    setDraft("");
    setError(null);
    const nextMessages: ChatMessage[] = [...messages, { role: "user", content }];
    setMessages(nextMessages);
    setBusy(true);
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

    try {
      let assembled = "";
      for await (const chunk of streamChat(settings, nextMessages)) {
        assembled += chunk;
        const snapshot = assembled;
        setMessages((prev) => {
          const copy = [...prev];
          copy[copy.length - 1] = { role: "assistant", content: snapshot };
          return copy;
        });
      }
      setGatewayOk(true);
      void refreshSideData();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setMessages((prev) => prev.slice(0, -1));
      setGatewayOk(false);
      setGatewayDetail(message.slice(0, 160));
    } finally {
      setBusy(false);
    }
  }

  function newConversation() {
    setSettings((s) => ({ ...s, conversationId: crypto.randomUUID() }));
    setMessages([]);
    setSelected(new Set());
    setFocus(null);
    setError(null);
  }

  const skillNames = useMemo(() => {
    const fromCompat = compat?.openclawWorkspaceSkills?.map((s) => s.name) || [];
    if (fromCompat.length) return fromCompat;
    return ["hello-agentdesk", "image-to-cad-dxf"];
  }, [compat]);

  const focusFileSelected =
    focus?.kind === "file" ? selected.has(focus.path) : false;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">AgentDesk</div>
          <div className="brand-sub">P1 资料库 · P2 任务流</div>
        </div>
        <div className="status-group">
          <div className="status">
            <span className={`dot ${gatewayOk ? "ok" : ""}`} />
            <span>Gateway {gatewayOk ? "OK" : "DOWN"}</span>
          </div>
          <div className="status">
            <span className={`dot ${bridgeOk ? "ok" : ""}`} />
            <span>Bridge {bridgeOk ? "OK" : "DOWN"}</span>
          </div>
          <button type="button" className="ghost" onClick={newConversation}>
            新任务
          </button>
        </div>
      </header>

      <div className="shell three">
        <aside className="sidebar">
          <nav className="tabs">
            {(
              [
                ["library", "资料库"],
                ["skills", "Skills"],
                ["cron", "定时"],
                ["sessions", "WB会话"],
                ["audit", "审计"],
                ["settings", "设置"],
              ] as Array<[Tab, string]>
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={tab === id ? "on" : ""}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </nav>

          <div className="side-body">
            {tab === "library" && (
              <section>
                <div className="row">
                  <h2 className="panel-title">资料库</h2>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void refreshLibrary().catch((e) => setError(String(e)))}
                  >
                    刷新
                  </button>
                </div>
                <div className="row gap">
                  <button
                    type="button"
                    className="ghost"
                    onClick={() =>
                      void importWorkBuddy(settings)
                        .then(() => refreshLibrary())
                        .catch((e) => setError(String(e)))
                    }
                  >
                    导入 WorkBuddy
                  </button>
                  <button
                    type="button"
                    className="accent"
                    disabled={selected.size === 0}
                    onClick={() => void onAttachToTask().catch((e) => setError(String(e)))}
                  >
                    添加到任务 ({selected.size})
                  </button>
                </div>
                <p className="hint">单击文件 → 右侧预览；双击勾选；「添加到任务」写入草稿。</p>
                <LibraryTreeView
                  nodes={tree}
                  selected={selected}
                  focusPath={focus?.kind === "file" ? focus.path : undefined}
                  onToggle={toggleFile}
                  onOpen={(path, type) => void openFile(path, type)}
                />
              </section>
            )}

            {tab === "skills" && (
              <section>
                <h2 className="panel-title">兼容 Skills</h2>
                <p className="hint">
                  匹配 {compat?.matched?.length ?? 0} · 仅 WB{" "}
                  {compat?.onlyInWorkBuddy?.length ?? 0} · 点击查看并写入任务
                </p>
                <ul className="skill-list">
                  {skillNames.map((name) => (
                    <li key={name}>
                      <button
                        type="button"
                        className={`list-hit ${focus?.kind === "skill" && focus.name === name ? "on" : ""}`}
                        onClick={() => void openSkill(name)}
                      >
                        <strong>{name}</strong>
                        <span>
                          {compat?.matched?.includes(name)
                            ? "与 WorkBuddy 用户 Skill 匹配"
                            : "AgentDesk workspace"}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {tab === "cron" && (
              <section>
                <h2 className="panel-title">定时任务</h2>
                <div className="field">
                  <label>名称</label>
                  <input value={cronName} onChange={(e) => setCronName(e.target.value)} />
                </div>
                <div className="field">
                  <label>周期（分钟）</label>
                  <input
                    type="number"
                    min={1}
                    value={cronEveryMin}
                    onChange={(e) => setCronEveryMin(Number(e.target.value) || 60)}
                  />
                </div>
                <div className="field">
                  <label>Prompt</label>
                  <textarea
                    rows={4}
                    value={cronPrompt}
                    onChange={(e) => setCronPrompt(e.target.value)}
                  />
                </div>
                <button
                  type="button"
                  className="accent"
                  onClick={() =>
                    void createCron(settings, {
                      name: cronName,
                      prompt: cronPrompt,
                      everyMs: cronEveryMin * 60000,
                    })
                      .then(() => fetchCron(settings).then((c) => setCronJobs(c.jobs)))
                      .catch((e) => setError(String(e)))
                  }
                >
                  创建定时任务
                </button>
                <ul className="skill-list">
                  {cronJobs.map((j) => (
                    <li key={j.id}>
                      <button
                        type="button"
                        className={`list-hit ${focus?.kind === "cron" && focus.job.id === j.id ? "on" : ""}`}
                        onClick={() => setFocus({ kind: "cron", job: j })}
                      >
                        <strong>
                          {j.name} · 每 {formatEvery(j.everyMs)}
                        </strong>
                        <span>
                          {j.lastStatus || "pending"}
                          {j.lastError ? ` · ${j.lastError}` : ""}
                        </span>
                      </button>
                      <div className="row gap">
                        <button
                          type="button"
                          className="ghost"
                          onClick={() =>
                            void runCronNow(settings, j.id)
                              .then(() => fetchCron(settings).then((c) => setCronJobs(c.jobs)))
                              .catch((e) => setError(String(e)))
                          }
                        >
                          立即跑
                        </button>
                        <button
                          type="button"
                          className="ghost"
                          onClick={() =>
                            void deleteCron(settings, j.id)
                              .then(() => fetchCron(settings).then((c) => setCronJobs(c.jobs)))
                              .catch((e) => setError(String(e)))
                          }
                        >
                          删除
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {tab === "sessions" && (
              <section>
                <h2 className="panel-title">WorkBuddy 会话</h2>
                <p className="hint">只读镜像本机 workbuddy.db；点击在右侧查看详情。</p>
                <ul className="skill-list">
                  {sessions.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        className={`list-hit ${focus?.kind === "session" && focus.session.id === s.id ? "on" : ""}`}
                        onClick={() => setFocus({ kind: "session", session: s })}
                      >
                        <strong>{s.title || s.id.slice(0, 8)}</strong>
                        <span>
                          {s.status} · {s.model} · {s.cwd}
                        </span>
                      </button>
                    </li>
                  ))}
                  {sessions.length === 0 && (
                    <li>
                      <strong>无会话</strong>
                      <span>未检测到 WorkBuddy 数据库（独立模式正常）</span>
                    </li>
                  )}
                </ul>
              </section>
            )}

            {tab === "audit" && (
              <section>
                <h2 className="panel-title">审计</h2>
                <ul className="skill-list">
                  {audit.map((e, i) => (
                    <li key={`${e.ts}-${i}`}>
                      <button
                        type="button"
                        className={`list-hit ${focus?.kind === "audit" && focus.entry === e ? "on" : ""}`}
                        onClick={() => setFocus({ kind: "audit", entry: e })}
                      >
                        <strong>{String(e.event || "event")}</strong>
                        <span>
                          {e.ts} {JSON.stringify(e).slice(0, 120)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {tab === "settings" && (
              <section>
                <h2 className="panel-title">连接</h2>
                <div className="field">
                  <label>Gateway Base（空=同域 /v1）</label>
                  <input
                    value={settings.gatewayBase}
                    placeholder="http://127.0.0.1:18789"
                    onChange={(e) =>
                      setSettings((s) => ({ ...s, gatewayBase: e.target.value }))
                    }
                  />
                </div>
                <div className="field">
                  <label>Bridge Base（空=同域 /api）</label>
                  <input
                    value={settings.bridgeBase}
                    placeholder="http://127.0.0.1:3090"
                    onChange={(e) =>
                      setSettings((s) => ({ ...s, bridgeBase: e.target.value }))
                    }
                  />
                </div>
                <div className="field">
                  <label>Gateway Token</label>
                  <input
                    type="password"
                    value={settings.token}
                    onChange={(e) =>
                      setSettings((s) => ({ ...s, token: e.target.value }))
                    }
                  />
                </div>
                <p className="hint">
                  Gateway: {gatewayDetail}
                  <br />
                  Bridge: {bridgeDetail}
                </p>
              </section>
            )}
          </div>
        </aside>

        <main className="main">
          <FocusPanel
            focus={focus}
            selectedCount={selected.size}
            onClose={() => setFocus(null)}
            onUseSkill={useFocusedSkill}
            onAttachFocus={() => void onAttachFocusFile().catch((e) => setError(String(e)))}
            onToggleSelect={() => {
              if (focus?.kind === "file") toggleFile(focus.path, "file");
            }}
            isSelected={focusFileSelected}
          />

          <div className="messages">
            {messages.length === 0 ? (
              <div className="empty">
                <h1>资料进任务，产物回资料库。</h1>
                <p>
                  左侧点选对象会在上方联动区展示；勾选资料后可写入草稿并发送。
                </p>
              </div>
            ) : (
              messages.map((msg, index) => (
                <div key={`${msg.role}-${index}`} className={`bubble ${msg.role}`}>
                  {msg.content || (busy && index === messages.length - 1 ? "…" : "")}
                </div>
              ))
            )}
            {error ? <div className="bubble error">{error}</div> : null}
          </div>

          <div className="composer">
            <textarea
              value={draft}
              placeholder="描述任务… 左侧点选资料/Skill 后可写入草稿"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void onSend();
                }
              }}
            />
            <button type="button" disabled={!canSend} onClick={() => void onSend()}>
              {busy ? "执行中" : "发送"}
            </button>
          </div>
        </main>
      </div>
    </div>
  );
}
