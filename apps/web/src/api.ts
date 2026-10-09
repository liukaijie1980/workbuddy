export type ChatRole = "user" | "assistant" | "system";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type AgentDeskSettings = {
  gatewayBase: string;
  bridgeBase: string;
  token: string;
  conversationId: string;
};

export type LibraryNode = {
  type: "dir" | "file";
  name: string;
  path: string;
  size?: number;
  mtime?: string;
  children?: LibraryNode[];
};

export type CronJob = {
  id: string;
  name: string;
  prompt: string;
  everyMs: number;
  enabled: boolean;
  nextRunAt?: number | null;
  lastRunAt?: number | null;
  lastStatus?: string | null;
  lastError?: string | null;
  lastOutput?: string | null;
};

export type AuditEntry = {
  ts?: string;
  event?: string;
  [key: string]: unknown;
};

const SETTINGS_KEY = "agentdesk.settings.v2";

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

function isLoopbackBase(base: string): boolean {
  const raw = base.trim();
  if (!raw) return false;
  try {
    return isLoopbackHost(new URL(raw, "http://local.invalid").hostname);
  } catch {
    return /^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\])([:/]|$)/i.test(raw);
  }
}

/** Prefer same-origin proxy when UI is opened from another machine. */
function sanitizeSettingsForPage(settings: AgentDeskSettings): AgentDeskSettings {
  if (typeof window === "undefined" || isLoopbackHost(window.location.hostname)) {
    return settings;
  }
  const next = { ...settings };
  if (!next.gatewayBase.trim() || isLoopbackBase(next.gatewayBase)) next.gatewayBase = "";
  if (!next.bridgeBase.trim() || isLoopbackBase(next.bridgeBase)) next.bridgeBase = "";
  return next;
}

export function loadSettings(): AgentDeskSettings {
  let loaded: AgentDeskSettings | null = null;
  const raw = localStorage.getItem(SETTINGS_KEY);
  if (raw) {
    try {
      loaded = { ...defaultSettings(), ...JSON.parse(raw) };
    } catch {
      /* ignore */
    }
  }
  if (!loaded) {
    const v1 = localStorage.getItem("agentdesk.settings.v1");
    if (v1) {
      try {
        loaded = { ...defaultSettings(), ...JSON.parse(v1) };
      } catch {
        /* ignore */
      }
    }
  }
  return sanitizeSettingsForPage(loaded || defaultSettings());
}

export function saveSettings(settings: AgentDeskSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function defaultSettings(): AgentDeskSettings {
  return {
    gatewayBase: "",
    bridgeBase: "",
    token: "",
    conversationId: crypto.randomUUID(),
  };
}

function resolveBase(base: string): string {
  return base.trim().replace(/\/$/, "");
}

function authHeaders(token: string): HeadersInit {
  const t = token.trim();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

function formatHttpError(status: number, text: string, hint?: string) {
  const body = text.trim();
  if (body) return `${status}: ${body.slice(0, 300)}`;
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return `${status}: 上游无响应${hint ? `（${hint}）` : ""}。请确认 Gateway :18789 与 Bridge :3090 正在运行。`;
  }
  return `${status}: （空响应）`;
}

async function bridgeFetch(settings: AgentDeskSettings, path: string, init?: RequestInit) {
  const base = resolveBase(settings.bridgeBase);
  const url = `${base}${path}`;
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`无法连接 Bridge ${base || "(相对地址)"}：${msg}`);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(formatHttpError(res.status, text, "Bridge/代理"));
  }
  return res.json();
}

export async function probeGateway(settings: AgentDeskSettings): Promise<{
  ok: boolean;
  detail: string;
}> {
  const base = resolveBase(settings.gatewayBase);
  const url = `${base}/v1/models`;
  try {
    const res = await fetch(url, { headers: authHeaders(settings.token) });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, detail: `${res.status} ${text.slice(0, 180)}` };
    }
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    const ids = (data.data ?? []).map((m) => m.id).join(", ") || "(empty)";
    return { ok: true, detail: ids };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function probeBridge(settings: AgentDeskSettings): Promise<{
  ok: boolean;
  detail: string;
}> {
  try {
    const data = await bridgeFetch(settings, "/api/health");
    return { ok: Boolean(data?.ok), detail: data?.library || "ok" };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export type StreamEvent =
  | { kind: "delta"; text: string }
  | { kind: "status"; text: string };

export async function* streamChat(
  settings: AgentDeskSettings,
  messages: ChatMessage[],
  opts?: { signal?: AbortSignal; idleMs?: number; overallMs?: number },
): AsyncGenerator<StreamEvent> {
  const base = resolveBase(settings.gatewayBase);
  const idleMs = opts?.idleMs ?? 300_000;
  const overallMs = opts?.overallMs ?? 1_200_000;
  const signal = opts?.signal;

  yield { kind: "status", text: "正在连接 Gateway /v1/chat/completions…" };

  let res: Response;
  try {
    res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        ...authHeaders(settings.token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openclaw/default",
        stream: true,
        user: `conv:${settings.conversationId}`,
        messages,
      }),
      signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `无法连接 Gateway ${base || "(相对 /v1 → :18789)"}：${msg}。请重新运行 .\\scripts\\start.ps1`,
    );
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      formatHttpError(
        res.status,
        text,
        "常见原因：Gateway 未启动或已崩溃，代理把 ECONNREFUSED 转成了 500",
      ),
    );
  }
  if (!res.body) throw new Error("Gateway 未返回流式响应体");

  yield { kind: "status", text: "Gateway 已连接，等待模型与工具返回可见内容…" };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const startedAt = Date.now();
  let lastByteAt = Date.now();
  let announcedSilent = false;

  const readWithIdle = (): Promise<ReadableStreamReadResult<Uint8Array>> =>
    new Promise((resolve, reject) => {
      let settled = false;
      const timer = setInterval(() => {
        if (settled) return;
        const now = Date.now();
        if (signal?.aborted) {
          settled = true;
          clearInterval(timer);
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        if (now - startedAt > overallMs) {
          settled = true;
          clearInterval(timer);
          reject(new Error(`等待模型超时（>${Math.round(overallMs / 1000)}s）。可点取消后重试，或把问题拆短。`));
          return;
        }
        if (now - lastByteAt > idleMs) {
          settled = true;
          clearInterval(timer);
          reject(
            new Error(
              `超过 ${Math.round(idleMs / 1000)}s 没有新输出（常见于工具调用卡住）。已中断，请点取消后重试，或新开会话。`,
            ),
          );
        }
      }, 1000);

      reader
        .read()
        .then((result) => {
          if (settled) return;
          settled = true;
          clearInterval(timer);
          resolve(result);
        })
        .catch((err) => {
          if (settled) return;
          settled = true;
          clearInterval(timer);
          reject(err);
        });
    });

  try {
    while (true) {
      const { done, value } = await readWithIdle();
      if (done) break;
      lastByteAt = Date.now();
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n");
      buffer = chunks.pop() ?? "";

      for (const line of chunks) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") return;
        try {
          const json = JSON.parse(payload) as {
            choices?: Array<{
              delta?: {
                content?: string;
                tool_calls?: Array<{
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
              finish_reason?: string | null;
            }>;
            error?: { message?: string };
          };
          if (json.error?.message) throw new Error(json.error.message);
          const choice = json.choices?.[0];
          const delta = choice?.delta?.content;
          const toolCalls = choice?.delta?.tool_calls;
          if (toolCalls?.length) {
            for (const call of toolCalls) {
              const name = call?.function?.name?.trim();
              if (!name) continue;
              announcedSilent = false;
              yield { kind: "status", text: `模型决定调用工具 ${name}` };
            }
          }
          if (delta) {
            announcedSilent = false;
            yield { kind: "delta", text: delta };
          } else if (!announcedSilent && !toolCalls?.length) {
            announcedSilent = true;
            yield {
              kind: "status",
              text: "网关有事件但暂无可见文字（工具名见下方活动条；也可能在思考）",
            };
          }
        } catch (err) {
          if (err instanceof SyntaxError) continue;
          throw err;
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
}

export function libraryRawUrl(settings: AgentDeskSettings, relPath: string) {
  const base = resolveBase(settings.bridgeBase);
  return `${base}/api/library/raw?path=${encodeURIComponent(relPath)}`;
}

export async function fetchLibraryTree(settings: AgentDeskSettings) {
  return bridgeFetch(settings, "/api/library/tree") as Promise<{
    root: string;
    tree: LibraryNode[];
  }>;
}

export async function fetchLibraryFile(settings: AgentDeskSettings, relPath: string) {
  const q = encodeURIComponent(relPath);
  return bridgeFetch(settings, `/api/library/file?path=${q}`) as Promise<{
    path: string;
    abs?: string;
    size?: number;
    binary?: boolean;
    preview: string | null;
  }>;
}

export async function fetchSkillDetail(settings: AgentDeskSettings, name: string) {
  const q = encodeURIComponent(name);
  return bridgeFetch(settings, `/api/skills/detail?name=${q}`) as Promise<{
    name: string;
    source: string;
    path: string;
    body: string;
  }>;
}

export async function attachLibrary(
  settings: AgentDeskSettings,
  paths: string[],
  skill?: string,
): Promise<{ snippet: string; paths: string[] }> {
  return bridgeFetch(settings, "/api/library/attach", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths, skill }),
  });
}

export async function fetchSkillContract(
  settings: AgentDeskSettings,
  name: string,
): Promise<{ name: string; snippet: string; python?: string; files?: string[] }> {
  const q = encodeURIComponent(name);
  return bridgeFetch(settings, `/api/skills/contract?name=${q}`);
}

export async function matchSkillContract(
  settings: AgentDeskSettings,
  text: string,
  skill?: string,
): Promise<{ matched: boolean; name?: string; snippet?: string }> {
  return bridgeFetch(settings, "/api/skills/match", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, skill: skill || undefined }),
  });
}

export type UploadedLibraryFile = {
  path: string;
  name: string;
  size: number;
  abs?: string;
};

export async function fetchRuntimeActivity(
  settings: AgentDeskSettings,
  sinceIso: string,
): Promise<{ lines: Array<{ at?: string; text: string; key: string; detail?: string }> }> {
  const q = encodeURIComponent(sinceIso);
  return bridgeFetch(settings, `/api/runtime/activity?since=${q}`);
}

export async function uploadLibraryFiles(
  settings: AgentDeskSettings,
  files: File[],
): Promise<{ ok: boolean; files: UploadedLibraryFile[]; paths: string[] }> {
  if (!files.length) return { ok: true, files: [], paths: [] };
  const fd = new FormData();
  for (const f of files) fd.append("files", f, f.name);
  return bridgeFetch(settings, "/api/library/upload", {
    method: "POST",
    body: fd,
  });
}

export async function importWorkBuddy(settings: AgentDeskSettings) {
  return bridgeFetch(settings, "/api/workbuddy/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
}

export async function fetchCompat(settings: AgentDeskSettings) {
  return bridgeFetch(settings, "/api/compat/skills");
}

export async function fetchWbSessions(settings: AgentDeskSettings) {
  return bridgeFetch(settings, "/api/workbuddy/sessions") as Promise<{
    sessions: Array<{
      id: string;
      title: string;
      status: string;
      cwd: string;
      model: string;
      updated_at: number;
    }>;
  }>;
}

export type ConversationSummary = {
  id: string;
  title: string;
  updatedAt?: string;
  createdAt?: string;
  messageCount?: number;
  preview?: string;
};

export type Conversation = ConversationSummary & {
  messages: ChatMessage[];
};

export async function fetchConversations(settings: AgentDeskSettings) {
  return bridgeFetch(settings, "/api/conversations") as Promise<{
    conversations: ConversationSummary[];
  }>;
}

export async function fetchConversation(settings: AgentDeskSettings, id: string) {
  return bridgeFetch(
    settings,
    `/api/conversations/${encodeURIComponent(id)}`,
  ) as Promise<Conversation>;
}

export async function upsertConversation(
  settings: AgentDeskSettings,
  id: string,
  messages: ChatMessage[],
  title?: string,
) {
  return bridgeFetch(settings, `/api/conversations/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, title }),
  }) as Promise<Conversation>;
}

export async function deleteConversation(settings: AgentDeskSettings, id: string) {
  return bridgeFetch(settings, `/api/conversations/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function fetchCron(settings: AgentDeskSettings) {
  return bridgeFetch(settings, "/api/cron") as Promise<{ jobs: CronJob[] }>;
}

export async function createCron(
  settings: AgentDeskSettings,
  job: { name: string; prompt: string; everyMs: number },
) {
  return bridgeFetch(settings, "/api/cron", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(job),
  }) as Promise<CronJob>;
}

export async function runCronNow(settings: AgentDeskSettings, id: string) {
  return bridgeFetch(settings, `/api/cron/${id}/run`, { method: "POST" });
}

export async function deleteCron(settings: AgentDeskSettings, id: string) {
  return bridgeFetch(settings, `/api/cron/${id}`, { method: "DELETE" });
}

export async function fetchAudit(settings: AgentDeskSettings) {
  return bridgeFetch(settings, "/api/audit?limit=50") as Promise<{ entries: AuditEntry[] }>;
}

export async function createTask(
  settings: AgentDeskSettings,
  title: string,
  attachments: string[],
) {
  return bridgeFetch(settings, "/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      conversationId: settings.conversationId,
      attachments,
    }),
  });
}

export async function fetchLocalConfig(settings: AgentDeskSettings): Promise<{
  token?: string;
  gatewayUrl?: string;
  bridgeUrl?: string;
  model?: string;
}> {
  return bridgeFetch(settings, "/api/local-config");
}

export type CatalogModel = {
  id: string;
  name: string;
  ref: string;
  vision: boolean;
  reasoning?: boolean;
  contextWindow?: number | null;
};

export type CatalogProvider = {
  id: string;
  baseUrl: string;
  api: string;
  timeoutSeconds?: number | null;
  apiKeySet: boolean;
  apiKeyHint: string;
  models: CatalogModel[];
};

export type ModelsCatalog = {
  configPath: string;
  controlUi: string;
  primary: string;
  fallbacks: string[];
  providers: CatalogProvider[];
};

export async function fetchModelsConfig(settings: AgentDeskSettings): Promise<ModelsCatalog> {
  return bridgeFetch(settings, "/api/models-config");
}

export async function saveModelsConfig(
  settings: AgentDeskSettings,
  body: {
    primary?: string;
    fallbacks?: string[];
    provider?: {
      id: string;
      baseUrl: string;
      apiKey?: string;
      modelId: string;
      modelName?: string;
      vision?: boolean;
      timeoutSeconds?: number;
      setPrimary?: boolean;
      alias?: string;
    };
  },
): Promise<ModelsCatalog & { ok?: boolean }> {
  return bridgeFetch(settings, "/api/models-config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
