import { useEffect, useMemo, useState } from "react";
import {
  attachLibrary,
  createCron,
  createTask,
  deleteCron,
  fetchAudit,
  fetchCompat,
  fetchCron,
  fetchLibraryTree,
  fetchLocalConfig,
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

function formatEvery(ms: number) {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${Math.round(ms / 3600000)}h`;
}

function LibraryTreeView({
  nodes,
  selected,
  onToggle,
}: {
  nodes: LibraryNode[];
  selected: Set<string>;
  onToggle: (path: string, type: string) => void;
}) {
  return (
    <ul className="tree">
      {nodes.map((n) => (
        <li key={n.path}>
          {n.type === "file" ? (
            <button
              type="button"
              className={`tree-item ${selected.has(n.path) ? "on" : ""}`}
              onClick={() => onToggle(n.path, n.type)}
              title={n.path}
            >
              <span className="tree-mark">[F]</span>
              <span>{n.name}</span>
            </button>
          ) : (
            <details open={n.path === "mine" || n.path === "outputs"}>
              <summary>
                <span className="tree-mark">[D]</span>
                {n.name}
              </summary>
              {n.children && n.children.length > 0 ? (
                <LibraryTreeView nodes={n.children} selected={selected} onToggle={onToggle} />
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
  const [compat, setCompat] = useState<{
    matched?: string[];
    onlyInWorkBuddy?: string[];
    openclawWorkspaceSkills?: Array<{ name: string }>;
  } | null>(null);
  const [cronJobs, setCronJobs] = useState<CronJob[]>([]);
  const [cronName, setCronName] = useState("每日简报");
  const [cronPrompt, setCronPrompt] = useState("汇总 library/mine 中的要点，写入 library/outputs。");
  const [cronEveryMin, setCronEveryMin] = useState(60);
  const [sessions, setSessions] = useState<
    Array<{ id: string; title: string; status: string; cwd: string; model: string; updated_at: number }>
  >([]);
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
          // fill empty, or replace if current token fails later via health refresh
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

  async function onAttachToTask() {
    const paths = [...selected];
    if (!paths.length) return;
    const { snippet } = await attachLibrary(settings, paths);
    setDraft((d) => (d ? `${snippet}\n\n${d}` : `${snippet}\n\n请基于以上资料继续。`));
    await createTask(settings, `任务 · ${paths[0]}`, paths);
    setTab("library");
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
    setError(null);
  }

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
                <p className="hint">勾选文件后「添加到任务」，语义对齐 WorkBuddy 资料引用。</p>
                <LibraryTreeView nodes={tree} selected={selected} onToggle={toggleFile} />
              </section>
            )}

            {tab === "skills" && (
              <section>
                <h2 className="panel-title">兼容 Skills</h2>
                <p className="hint">
                  匹配 {compat?.matched?.length ?? 0} · 仅 WB{" "}
                  {compat?.onlyInWorkBuddy?.length ?? 0}
                </p>
                <ul className="skill-list">
                  {(compat?.openclawWorkspaceSkills || []).map((s) => (
                    <li key={s.name}>
                      <strong>{s.name}</strong>
                      <span>
                        {compat?.matched?.includes(s.name)
                          ? "与 WorkBuddy 用户 Skill 匹配"
                          : "AgentDesk workspace"}
                      </span>
                    </li>
                  ))}
                  {(compat?.matched || []).length === 0 && (
                    <li>
                      <strong>image-to-cad-dxf</strong>
                      <span>期望已同步；若为空请运行 setup</span>
                    </li>
                  )}
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
                      <strong>
                        {j.name} · 每 {formatEvery(j.everyMs)}
                      </strong>
                      <span>
                        {j.lastStatus || "pending"}
                        {j.lastError ? ` · ${j.lastError}` : ""}
                      </span>
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
                <p className="hint">只读镜像本机 workbuddy.db，用于兼容对照。</p>
                <ul className="skill-list">
                  {sessions.map((s) => (
                    <li key={s.id}>
                      <strong>{s.title || s.id.slice(0, 8)}</strong>
                      <span>
                        {s.status} · {s.model} · {s.cwd}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {tab === "audit" && (
              <section>
                <h2 className="panel-title">审计</h2>
                <ul className="skill-list">
                  {audit.map((e, i) => (
                    <li key={`${e.ts}-${i}`}>
                      <strong>{String(e.event || "event")}</strong>
                      <span>
                        {e.ts} {JSON.stringify(e).slice(0, 120)}
                      </span>
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
          <div className="messages">
            {messages.length === 0 ? (
              <div className="empty">
                <h1>资料进任务，产物回资料库。</h1>
                <p>
                  从左侧勾选 WorkBuddy 导入的文件 → 添加到任务 → 发送。Skill 与
                  OpenClaw/WorkBuddy 用户包兼容。
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
              placeholder="描述任务… 也可先在资料库勾选文件再「添加到任务」"
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
