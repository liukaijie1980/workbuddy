import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import {
  attachLibrary,
  createCron,
  createTask,
  deleteConversation,
  deleteCron,
  fetchAudit,
  fetchCompat,
  fetchConversation,
  fetchConversations,
  fetchCron,
  fetchLibraryFile,
  fetchLibraryTree,
  libraryRawUrl,
  fetchLocalConfig,
  fetchModelsConfig,
  fetchRuntimeActivity,
  fetchSkillContract,
  matchSkillContract,
  fetchSkillDetail,
  fetchWbSessions,
  importWorkBuddy,
  loadSettings,
  probeBridge,
  probeGateway,
  runCronNow,
  saveModelsConfig,
  saveSettings,
  streamChat,
  uploadLibraryFiles,
  upsertConversation,
  type AgentDeskSettings,
  type AuditEntry,
  type ChatMessage,
  type ConversationSummary,
  type CronJob,
  type LibraryNode,
  type ModelsCatalog,
  type UploadedLibraryFile,
} from "./api";

type Tab = "chats" | "library" | "skills" | "cron" | "wb" | "audit" | "settings";

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
      imageUrl?: string;
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

function collectDeliverables(nodes: LibraryNode[]): LibraryNode[] {
  const out: LibraryNode[] = [];
  const walk = (list: LibraryNode[]) => {
    for (const node of list) {
      if (node.type === "file" && node.path.startsWith("outputs/") && /\.(dxf|png|jpe?g|webp|gif|pdf|svg)$/i.test(node.name)) {
        out.push(node);
      }
      if (node.children?.length) walk(node.children);
    }
  };
  walk(nodes);
  return out.sort((a, b) => (b.mtime || "").localeCompare(a.mtime || "")).slice(0, 8);
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
            <details open={n.path === "mine" || n.path === "outputs"}>
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
          {focus.kind === "file" && focus.imageUrl ? (
            <img className="focus-preview" src={focus.imageUrl} alt={focus.path} />
          ) : null}
          <pre className="focus-body">{focus.preview || (focus.loading ? "…" : focus.imageUrl ? "" : "(无文本预览)")}</pre>
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

const MODEL_PRESETS = [
  {
    label: "阿里云 DashScope 视觉",
    id: "dashscope",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    modelId: "qwen3.6-flash",
    modelName: "qwen3.6-flash（视觉）",
    vision: true,
  },
  {
    label: "OpenAI 兼容接口",
    id: "openai",
    baseUrl: "https://api.openai.com/v1",
    modelId: "gpt-4.1",
    modelName: "gpt-4.1",
    vision: true,
  },
];

function ModelsSettings({
  settings,
  catalog,
  onReload,
}: {
  settings: AgentDeskSettings;
  catalog: ModelsCatalog | null;
  onReload: () => Promise<void>;
}) {
  const [id, setId] = useState("dashscope");
  const [baseUrl, setBaseUrl] = useState("https://dashscope.aliyuncs.com/compatible-mode/v1");
  const [modelId, setModelId] = useState("qwen3.6-flash");
  const [modelName, setModelName] = useState("qwen3.6-flash（视觉）");
  const [apiKey, setApiKey] = useState("");
  const [vision, setVision] = useState(true);
  const [setPrimary, setSetPrimary] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function applyPreset(preset: (typeof MODEL_PRESETS)[number]) {
    setId(preset.id);
    setBaseUrl(preset.baseUrl);
    setModelId(preset.modelId);
    setModelName(preset.modelName);
    setVision(preset.vision);
    setErr(null);
    setMsg(`已填入「${preset.label}」模板，补上 API Key 后保存。`);
  }

  async function save() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await saveModelsConfig(settings, {
        provider: {
          id,
          baseUrl,
          modelId,
          modelName,
          apiKey: apiKey.trim() || undefined,
          vision,
          setPrimary,
        },
      });
      setApiKey("");
      setMsg("已写入 ~/.openclaw/openclaw.json。网关通常会热加载，请新开会话后再试。");
      await onReload();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  async function makePrimary(ref: string) {
    setBusy(true);
    setErr(null);
    try {
      await saveModelsConfig(settings, { primary: ref });
      setMsg(`主模型已改为 ${ref}。请新开会话。`);
      await onReload();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="models-page">
      <h1>配置 LLM 模型</h1>
      <ol className="models-howto">
        <li>
          真正生效的文件是本机 <code>{catalog?.configPath || "~/.openclaw/openclaw.json"}</code>
          。AgentDesk 设置页会写进这个文件。
        </li>
        <li>
          需要三项：<strong>Base URL</strong>（不要带 <code>/chat/completions</code>）、
          <strong>模型 id</strong>、<strong>API Key</strong>。看图任务必须勾选「支持图片」。
        </li>
        <li>
          保存后网关会热加载。改模型后请点「新任务」，不要接着旧长对话跑。
        </li>
        <li>
          也可以打开 OpenClaw Control UI：
          <a href={catalog?.controlUi || "http://127.0.0.1:18789"} target="_blank" rel="noreferrer">
            {catalog?.controlUi || "http://127.0.0.1:18789"}
          </a>
          （用左侧 Gateway Token 登录）。
        </li>
      </ol>

      <p className="models-current">
        当前主模型：<strong>{catalog?.primary || "（未读取）"}</strong>
        {catalog?.fallbacks?.length ? ` · 回退 ${catalog.fallbacks.join(" → ")}` : ""}
      </p>

      <h2>已配置的提供商</h2>
      {catalog?.providers?.length ? (
        <ul className="models-providers">
          {catalog.providers.map((p) => (
            <li key={p.id}>
              <div className="models-provider-head">
                <strong>{p.id}</strong>
                <span>{p.baseUrl}</span>
                <span>{p.apiKeySet ? `Key ${p.apiKeyHint}` : "未填 Key"}</span>
              </div>
              <ul>
                {p.models.map((m) => (
                  <li key={m.ref}>
                    <code>{m.ref}</code>
                    {m.vision ? " · 视觉" : " · 仅文本"}
                    {catalog.primary === m.ref ? " · 主模型" : null}
                    {catalog.primary === m.ref ? null : (
                      <button type="button" className="ghost" disabled={busy} onClick={() => void makePrimary(m.ref)}>
                        设为主模型
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint">还没有提供商。用下面的模板添加。</p>
      )}

      <h2>添加 / 更新提供商</h2>
      <div className="models-presets">
        {MODEL_PRESETS.map((preset) => (
          <button key={preset.id} type="button" className="ghost" onClick={() => applyPreset(preset)}>
            {preset.label}
          </button>
        ))}
      </div>
      <div className="field">
        <label>提供商 id（写入 models.providers.&lt;id&gt;）</label>
        <input value={id} onChange={(e) => setId(e.target.value)} placeholder="dashscope" />
      </div>
      <div className="field">
        <label>Base URL</label>
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
        />
      </div>
      <div className="field">
        <label>模型 id</label>
        <input value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder="qwen3.6-flash" />
      </div>
      <div className="field">
        <label>显示名（可选）</label>
        <input value={modelName} onChange={(e) => setModelName(e.target.value)} />
      </div>
      <div className="field">
        <label>API Key（已有 Key 可留空不改）</label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-…"
          autoComplete="off"
        />
      </div>
      <label className="models-check">
        <input type="checkbox" checked={vision} onChange={(e) => setVision(e.target.checked)} />
        支持图片（看图 / CAD 从图纸生成必须勾选）
      </label>
      <label className="models-check">
        <input type="checkbox" checked={setPrimary} onChange={(e) => setSetPrimary(e.target.checked)} />
        保存后设为主模型
      </label>
      <div className="row">
        <button type="button" className="models-save" disabled={busy} onClick={() => void save()}>
          {busy ? "保存中…" : "保存到 openclaw.json"}
        </button>
      </div>
      {msg ? <p className="hint">{msg}</p> : null}
      {err ? <p className="models-err">{err}</p> : null}
    </div>
  );
}

export default function App() {
  const [settings, setSettings] = useState<AgentDeskSettings>(() => loadSettings());
  const [tab, setTab] = useState<Tab>("chats");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [statusHint, setStatusHint] = useState<string | null>(null);
  const [activity, setActivity] = useState<Array<{ id: string; at: string; text: string; detail?: string }>>([]);
  const [elapsedSec, setElapsedSec] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const busySinceRef = useRef<number>(0);
  const activitySinceRef = useRef<string>("");
  const seenActivityRef = useRef<Set<string>>(new Set());
  const [gatewayOk, setGatewayOk] = useState(false);
  const [bridgeOk, setBridgeOk] = useState(false);
  const [gatewayDetail, setGatewayDetail] = useState("未探测");
  const [bridgeDetail, setBridgeDetail] = useState("未探测");
  const [error, setError] = useState<string | null>(null);
  const [pinnedSkill, setPinnedSkill] = useState<string | null>(null);
  const [pendingFiles, setPendingFiles] = useState<UploadedLibraryFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [tree, setTree] = useState<LibraryNode[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<Focus | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
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
  const [modelCatalog, setModelCatalog] = useState<ModelsCatalog | null>(null);

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

  async function refreshModels() {
    try {
      setModelCatalog(await fetchModelsConfig(settings));
    } catch {
      /* bridge may be down */
    }
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
      const c = await fetchConversations(settings);
      setConversations(c.conversations || []);
    } catch {
      /* ignore */
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
    await refreshModels();
  }

  useEffect(() => {
    void refreshHealth();
    void refreshSideData();
    const t = setInterval(() => void refreshHealth(), 15000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.gatewayBase, settings.bridgeBase, settings.token]);

  // Prevent the browser from navigating / opening the dropped file as a new page.
  useEffect(() => {
    const isFileDrag = (e: DragEvent) =>
      !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");

    const blockNav = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
    };

    window.addEventListener("dragover", blockNav);
    window.addEventListener("drop", blockNav);
    return () => {
      window.removeEventListener("dragover", blockNav);
      window.removeEventListener("drop", blockNav);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!settings.conversationId) return;
      try {
        const row = await fetchConversation(settings, settings.conversationId);
        if (cancelled) return;
        if (row?.messages?.length) setMessages(row.messages);
      } catch {
        /* new conversation id not yet persisted */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canSend = useMemo(
    () => (draft.trim().length > 0 || pendingFiles.length > 0) && !busy && !uploading,
    [draft, busy, pendingFiles.length, uploading],
  );
  const deliverables = useMemo(() => collectDeliverables(tree), [tree]);

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
    const imageUrl = /\.(png|jpe?g|webp|gif)$/i.test(path) ? libraryRawUrl(settings, path) : undefined;
    setFocus({ kind: "file", path, preview: null, imageUrl, loading: true });
    try {
      const data = await fetchLibraryFile(settings, path);
      setFocus({
        kind: "file",
        path: data.path || path,
        size: data.size,
        binary: data.binary,
        preview: data.preview,
        imageUrl,
        loading: false,
      });
    } catch (e) {
      setFocus({
        kind: "file",
        path,
        preview: String(e instanceof Error ? e.message : e),
        imageUrl,
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

  async function useFocusedSkill() {
    if (!focus || focus.kind !== "skill") return;
    setPinnedSkill(focus.name);
    setError(null);
    try {
      const contract = await fetchSkillContract(settings, focus.name);
      const snippet = contract.snippet || `请使用 Skill「${focus.name}」完成任务。`;
      setDraft((d) => (d.includes(`[WorkBuddy Skill 合同]`) ? d : d ? `${snippet}\n\n${d}` : snippet));
      setTab("chats");
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
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

  async function ingestLocalFiles(fileList: FileList | File[]) {
    const files = [...fileList].filter((f) => f && f.size > 0);
    if (!files.length || uploading) return;
    setUploading(true);
    setError(null);
    busySinceRef.current = Date.now();
    setElapsedSec(0);
    pushActivity(`正在上传 ${files.length} 个文件到资料库…`);
    try {
      const result = await uploadLibraryFiles(settings, files);
      const uploaded = result.files || [];
      if (!uploaded.length) throw new Error("上传未返回文件");
      pushActivity(`上传完成：${uploaded.map((f) => f.name).join("、")}`);
      setPendingFiles((prev) => {
        const seen = new Set(prev.map((f) => f.path));
        const next = [...prev];
        for (const f of uploaded) {
          if (!seen.has(f.path)) next.push(f);
        }
        return next;
      });
      void refreshLibrary().catch(() => undefined);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setUploading(false);
    }
  }

  function pushActivity(text: string, detail?: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const extra = String(detail || "").trim();
    setActivity((prev) => {
      const last = prev[prev.length - 1];
      if (last?.text === trimmed && (last.detail || "") === extra) return prev;
      const at = new Date().toLocaleTimeString("zh-CN", { hour12: false });
      return [...prev, { id: `${Date.now()}-${prev.length}`, at, text: trimmed, detail: extra || undefined }].slice(-40);
    });
    setStatusHint(trimmed.split("\n")[0].slice(0, 96));
  }

  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => {
      setElapsedSec(Math.max(0, Math.round((Date.now() - busySinceRef.current) / 1000)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [busy, uploading]);

  useEffect(() => {
    let stop = false;
    const pull = async () => {
      try {
        const data = await fetchLibraryTree(settings);
        if (!stop) setTree(data.tree || []);
      } catch {
        /* library poll is best-effort */
      }
    };
    const timer = window.setInterval(() => void pull(), busy ? 2500 : 8000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [busy, settings]);

  useEffect(() => {
    if (!busy) return;
    let stop = false;
    const pull = async () => {
      try {
        const data = await fetchRuntimeActivity(
          settings,
          activitySinceRef.current || new Date().toISOString(),
        );
        if (stop) return;
        for (const line of data.lines || []) {
          if (!line?.text || seenActivityRef.current.has(line.key)) continue;
          seenActivityRef.current.add(line.key);
          pushActivity(line.text, line.detail);
        }
      } catch {
        /* activity feed is best-effort */
      }
    };
    void pull();
    const timer = window.setInterval(() => void pull(), 1200);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
    // pull uses latest settings captured when busy starts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  useEffect(() => {
    if (busy) return;
    if (!activitySinceRef.current) return;
    let stop = false;
    const pull = async () => {
      try {
        const data = await fetchRuntimeActivity(
          settings,
          activitySinceRef.current || new Date().toISOString(),
        );
        if (stop) return;
        for (const line of data.lines || []) {
          if (!line?.text || seenActivityRef.current.has(line.key)) continue;
          seenActivityRef.current.add(line.key);
          pushActivity(line.text, line.detail);
        }
      } catch {
        /* ignore */
      }
    };
    void pull();
    const timer = window.setTimeout(() => void pull(), 1600);
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  function removePendingFile(path: string) {
    setPendingFiles((prev) => prev.filter((f) => f.path !== path));
  }

  function isFileDragEvent(e: ReactDragEvent) {
    return Array.from(e.dataTransfer?.types || []).includes("Files");
  }

  function onComposerDragEnter(e: ReactDragEvent) {
    if (!isFileDragEvent(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }

  function onComposerDragOver(e: ReactDragEvent) {
    if (!isFileDragEvent(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    setDragOver(true);
  }

  function onComposerDragLeave(e: ReactDragEvent) {
    if (!isFileDragEvent(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const related = e.relatedTarget as Node | null;
    if (related && e.currentTarget.contains(related)) return;
    setDragOver(false);
  }

  function onComposerDrop(e: ReactDragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (e.dataTransfer?.files?.length) {
      void ingestLocalFiles(e.dataTransfer.files);
    }
  }

  async function onSend() {
    if (busy || uploading) return;
    let content = draft.trim();
    const attachPathsList = pendingFiles.map((f) => f.path);
    const skillMatch = /技能「([^」]+)」|Skill「([^」]+)」|\[WorkBuddy Skill 合同\].*技能「([^」]+)」/.exec(content);
    const skillName = pinnedSkill || skillMatch?.[1] || skillMatch?.[2] || skillMatch?.[3] || "";
    const restoreDraft = draft;
    const restorePending = pendingFiles;
    if (!content && !attachPathsList.length) return;

    setDraft("");
    setPendingFiles([]);
    setError(null);
    setActivity([]);
    seenActivityRef.current = new Set();
    activitySinceRef.current = new Date().toISOString();
    busySinceRef.current = Date.now();
    setElapsedSec(0);
    setBusy(true);

    if (attachPathsList.length) {
      pushActivity(`正在把 ${attachPathsList.length} 个附件挂到任务…`);
      try {
        const includeSkill = Boolean(skillName) && !content.includes("[WorkBuddy Skill 合同]");
        const { snippet } = await attachLibrary(
          settings,
          attachPathsList,
          includeSkill ? skillName : undefined,
        );
        await createTask(
          settings,
          `任务 · ${attachPathsList[0]}`,
          attachPathsList,
        );
        content = content
          ? `${snippet}\n\n${content}`
          : `${snippet}\n\n请基于以上资料继续。`;
        pushActivity("附件已写入任务，准备发送给模型");
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e));
        setDraft(restoreDraft);
        setPendingFiles(restorePending);
        setBusy(false);
        setStatusHint(null);
        return;
      }
    }

    if (!content.includes("[WorkBuddy Skill 合同]")) {
      try {
        const matched = await matchSkillContract(settings, content, skillName || undefined);
        if (matched.matched && matched.snippet) {
          content = content ? `${matched.snippet}\n\n${content}` : matched.snippet;
          if (matched.name) setPinnedSkill(matched.name);
          pushActivity(`已套用 WorkBuddy 技能合同：${matched.name}`);
        }
      } catch (e) {
        if (skillName) {
          setError(String(e instanceof Error ? e.message : e));
          setDraft(restoreDraft);
          setPendingFiles(restorePending);
          setBusy(false);
          setStatusHint(null);
          return;
        }
      }
    }

    const nextMessages: ChatMessage[] = [...messages, { role: "user", content }];
    setMessages(nextMessages);
    pushActivity("已提交对话，开始等待 Gateway");
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      let assembled = "";
      for await (const ev of streamChat(settings, nextMessages, { signal: ac.signal })) {
        if (ev.kind === "status") {
          pushActivity(ev.text);
          continue;
        }
        if (!assembled) pushActivity("模型开始输出可见文字");
        assembled += ev.text;
        const snapshot = assembled;
        setMessages((prev) => {
          const copy = [...prev];
          copy[copy.length - 1] = { role: "assistant", content: snapshot };
          return copy;
        });
      }
      if (!assembled.trim()) {
        throw new Error(
          "模型返回了空内容（常见于思考过程过长）。请再点发送，或在消息末尾加 /think off",
        );
      }
      const finalMessages: ChatMessage[] = [
        ...nextMessages,
        { role: "assistant", content: assembled },
      ];
      setMessages(finalMessages);
      try {
        await upsertConversation(settings, settings.conversationId, finalMessages);
      } catch (persistErr) {
        console.warn("persist conversation failed", persistErr);
      }
      setGatewayOk(true);
      void refreshSideData();
    } catch (err) {
      const aborted =
        (err instanceof DOMException && err.name === "AbortError") ||
        (err instanceof Error && /aborted|AbortError/i.test(err.message));
      const message = aborted
        ? "已取消本次请求。"
        : err instanceof Error
          ? err.message
          : String(err);
      setError(message);
      setMessages((prev) => {
        // drop empty assistant placeholder; keep user turn
        if (prev.length && prev[prev.length - 1]?.role === "assistant" && !prev[prev.length - 1]?.content) {
          return prev.slice(0, -1);
        }
        return prev;
      });
      if (!aborted) {
        setGatewayOk(false);
        setGatewayDetail(message.slice(0, 160));
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
      setStatusHint(null);
    }
  }

  function onCancel() {
    abortRef.current?.abort();
    pushActivity("用户取消，正在中断 Gateway 请求");
    setStatusHint("正在取消…");
  }

  async function openConversation(id: string) {
    if (busy) return;
    setError(null);
    setStatusHint(null);
    try {
      const row = await fetchConversation(settings, id);
      setSettings((s) => ({ ...s, conversationId: row.id }));
      setMessages(row.messages || []);
      setTab("chats");
      setFocus(null);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  async function removeConversation(id: string) {
    await deleteConversation(settings, id);
    if (settings.conversationId === id) {
      newConversation();
    }
    const c = await fetchConversations(settings);
    setConversations(c.conversations || []);
  }

  function newConversation() {
    setSettings((s) => ({ ...s, conversationId: crypto.randomUUID() }));
    setMessages([]);
    setSelected(new Set());
    setPendingFiles([]);
    setPinnedSkill(null);
    setFocus(null);
    setError(null);
    setTab("chats");
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
          <div className="brand-sub">
            {modelCatalog?.primary ? `主模型 ${modelCatalog.primary}` : "P1 资料库 · P2 任务流"}
          </div>
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
                ["chats", "会话"],
                ["library", "资料库"],
                ["skills", "Skills"],
                ["cron", "定时"],
                ["wb", "WB对照"],
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
            {tab === "chats" && (
              <section>
                <div className="row">
                  <h2 className="panel-title">AgentDesk 会话</h2>
                  <button type="button" className="ghost" onClick={newConversation}>
                    新建
                  </button>
                </div>
                <p className="hint">
                  这里是本系统 Web 聊天记录（会随发送更新）。不是腾讯 WorkBuddy 会话。
                </p>
                <ul className="skill-list">
                  {conversations.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        className={`list-hit ${settings.conversationId === c.id ? "on" : ""}`}
                        onClick={() => void openConversation(c.id)}
                      >
                        <strong>{c.title || c.id.slice(0, 8)}</strong>
                        <span>
                          {(c.messageCount ?? 0)} 条 · {c.updatedAt?.replace("T", " ").slice(0, 16) || ""}
                          {c.preview ? ` · ${c.preview}` : ""}
                        </span>
                      </button>
                      <div className="row gap">
                        <button
                          type="button"
                          className="ghost"
                          onClick={() =>
                            void removeConversation(c.id).catch((e) => setError(String(e)))
                          }
                        >
                          删除
                        </button>
                      </div>
                    </li>
                  ))}
                  {conversations.length === 0 && (
                    <li>
                      <strong>暂无会话</strong>
                      <span>发送一条消息后会出现在这里</span>
                    </li>
                  )}
                </ul>
              </section>
            )}

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
                <p className="hint">单击文件 → 右侧预览；双击勾选；「添加到任务」写入草稿。也可直接拖到下方输入框。</p>
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

            {tab === "wb" && (
              <section>
                <h2 className="panel-title">WorkBuddy 对照（只读）</h2>
                <p className="hint">
                  镜像本机 workbuddy.db，仅作兼容对照，不会写入 Web 聊天。本系统会话请看「会话」页。
                </p>
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
                      <strong>无 WB 会话</strong>
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
                  <br />
                  模型清单和 API Key 在右侧配置。
                </p>
              </section>
            )}
          </div>
        </aside>

        <main
          className={`main ${dragOver ? "file-dragover" : ""}`}
          onDragEnter={onComposerDragEnter}
          onDragOver={onComposerDragOver}
          onDragLeave={onComposerDragLeave}
          onDrop={onComposerDrop}
        >
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

          {tab === "settings" ? (
            <ModelsSettings settings={settings} catalog={modelCatalog} onReload={refreshModels} />
          ) : (
            <>
          <div className="messages">
            {messages.length === 0 ? (
              <div className="empty">
                <h1>资料进任务，产物回资料库。</h1>
                <p>
                  可直接拖拽 / 粘贴文件到会话区，或从左侧资料库勾选后添加。发送后 Agent
                  按路径读取资料。
                </p>
              </div>
            ) : (
              messages.map((msg, index) => (
                <div key={`${msg.role}-${index}`} className={`bubble ${msg.role}`}>
                  {msg.content ||
                    (busy && index === messages.length - 1
                      ? statusHint || "正在处理…"
                      : "")}
                </div>
              ))
            )}
            {error ? <div className="bubble error">{error}</div> : null}
          </div>

          {deliverables.length > 0 ? (
            <div className="deliverables">
              <div className="deliverables-title">产物</div>
              <div className="deliverables-row">
                {deliverables.map((file) => {
                  const image = /\.(png|jpe?g|webp|gif)$/i.test(file.name);
                  return (
                    <button
                      key={file.path}
                      type="button"
                      className="deliverable"
                      title={file.path}
                      onClick={() => void openFile(file.path, "file")}
                    >
                      {image ? (
                        <img src={libraryRawUrl(settings, file.path)} alt="" />
                      ) : (
                        <span className="deliverable-ext">{file.name.split(".").pop()?.toUpperCase()}</span>
                      )}
                      <span className="deliverable-name">{file.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {dragOver ? (
            <div className="main-drop-hint">松开以上传并附加到任务</div>
          ) : null}

          <div className={`composer ${dragOver ? "dragover" : ""}`}>
            {(busy || uploading || activity.length > 0) && (
              <div className="activity-bar" role="status" aria-live="polite">
                <div className="activity-head">
                  {busy || uploading ? <span className="activity-dot" /> : null}
                  <strong>
                    {busy || uploading
                      ? statusHint || (uploading ? "正在上传…" : "正在处理…")
                      : "本轮请求 / 回复（调试）"}
                  </strong>
                  {(busy || uploading) && <span className="activity-time">{elapsedSec}s</span>}
                  {busy || uploading ? (
                    <button type="button" className="activity-cancel" onClick={onCancel}>
                      取消
                    </button>
                  ) : (
                    <button type="button" className="activity-cancel" onClick={() => setActivity([])}>
                      关闭
                    </button>
                  )}
                </div>
                {activity.length > 0 ? (
                  <ol className="activity-log">
                    {activity.map((line, idx) => (
                      <li key={line.id}>
                        <time>{line.at}</time>
                        {line.detail ? (
                          <details open={idx >= activity.length - 2}>
                            <summary>{line.text}</summary>
                            <pre>{line.detail}</pre>
                          </details>
                        ) : (
                          <span>{line.text}</span>
                        )}
                      </li>
                    ))}
                  </ol>
                ) : null}
              </div>
            )}
            {pendingFiles.length > 0 || pinnedSkill ? (
              <div className="composer-attachments">
                {pinnedSkill ? (
                  <span className="attach-chip" title="本次发送会按 WorkBuddy 技能合同执行">
                    <span className="attach-chip-name">Skill {pinnedSkill}</span>
                    <button
                      type="button"
                      className="attach-chip-x"
                      aria-label="取消技能"
                      onClick={() => setPinnedSkill(null)}
                    >
                      ×
                    </button>
                  </span>
                ) : null}
                {pendingFiles.map((f) => (
                  <span key={f.path} className="attach-chip" title={f.path}>
                    <span className="attach-chip-name">{f.name}</span>
                    <button
                      type="button"
                      className="attach-chip-x"
                      aria-label={`移除 ${f.name}`}
                      onClick={() => removePendingFile(f.path)}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            <div className="composer-row">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  const list = e.target.files;
                  if (list?.length) void ingestLocalFiles(list);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                className="composer-attach"
                disabled={busy || uploading}
                title="添加文件（图片、文档等）"
                onClick={() => fileInputRef.current?.click()}
              >
                {uploading ? "…" : "+"}
              </button>
              <textarea
                value={draft}
                placeholder="描述任务… 也可拖拽/粘贴文件，或点 + 选择"
                disabled={busy}
                onChange={(e) => setDraft(e.target.value)}
                onDragEnter={onComposerDragEnter}
                onDragOver={onComposerDragOver}
                onDrop={onComposerDrop}
                onPaste={(e) => {
                  const items = e.clipboardData?.files;
                  if (items && items.length > 0) {
                    e.preventDefault();
                    void ingestLocalFiles(items);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void onSend();
                  }
                }}
              />
              <button type="button" disabled={!canSend} onClick={() => void onSend()}>
                {busy ? "执行中" : uploading ? "上传中" : "发送"}
              </button>
              {busy ? (
                <button type="button" className="composer-cancel" onClick={onCancel}>
                  取消
                </button>
              ) : null}
            </div>
          </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
