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

export function loadSettings(): AgentDeskSettings {
  const raw = localStorage.getItem(SETTINGS_KEY);
  if (raw) {
    try {
      return { ...defaultSettings(), ...JSON.parse(raw) };
    } catch {
      /* ignore */
    }
  }
  // migrate v1
  const v1 = localStorage.getItem("agentdesk.settings.v1");
  if (v1) {
    try {
      return { ...defaultSettings(), ...JSON.parse(v1) };
    } catch {
      /* ignore */
    }
  }
  return defaultSettings();
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

async function bridgeFetch(settings: AgentDeskSettings, path: string, init?: RequestInit) {
  const base = resolveBase(settings.bridgeBase);
  const url = `${base}${path}`;
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text.slice(0, 300)}`);
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

export async function* streamChat(
  settings: AgentDeskSettings,
  messages: ChatMessage[],
  opts?: { signal?: AbortSignal; idleMs?: number; overallMs?: number },
): AsyncGenerator<string> {
  const base = resolveBase(settings.gatewayBase);
  const idleMs = opts?.idleMs ?? 120_000;
  const overallMs = opts?.overallMs ?? 600_000;
  const signal = opts?.signal;

  const res = await fetch(`${base}/v1/chat/completions`, {
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

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text.slice(0, 400)}`);
  }
  if (!res.body) throw new Error("Gateway 未返回流式响应体");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const startedAt = Date.now();
  let lastByteAt = Date.now();

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
            choices?: Array<{ delta?: { content?: string } }>;
            error?: { message?: string };
          };
          if (json.error?.message) throw new Error(json.error.message);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) yield delta;
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
): Promise<{ snippet: string; paths: string[] }> {
  return bridgeFetch(settings, "/api/library/attach", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths }),
  });
}

export type UploadedLibraryFile = {
  path: string;
  name: string;
  size: number;
  abs?: string;
};

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
}> {
  return bridgeFetch(settings, "/api/local-config");
}
