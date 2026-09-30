import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { URL } from "node:url";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";

const PORT = Number(process.env.AGENTDESK_BRIDGE_PORT || 3090);
const HOME = os.homedir();
const OPENCLAW = path.join(HOME, ".openclaw");
const WORKSPACE = path.join(OPENCLAW, "workspace");
const LIBRARY = path.join(WORKSPACE, "library");
const LIB_MINE = path.join(LIBRARY, "mine");
const LIB_WB = path.join(LIBRARY, "workbuddy");
const LIB_OUT = path.join(LIBRARY, "outputs");
const STATE_DIR = path.join(OPENCLAW, "agentdesk");
const CRON_FILE = path.join(STATE_DIR, "cron.json");
const AUDIT_FILE = path.join(STATE_DIR, "audit.jsonl");
const TASKS_FILE = path.join(STATE_DIR, "tasks.json");
const CONVERSATIONS_FILE = path.join(STATE_DIR, "conversations.json");
const WB_DB = path.join(HOME, ".workbuddy", "workbuddy.db");
const WB_SKILLS = path.join(HOME, ".workbuddy", "skills");
const WB_ROOT = path.join(HOME, "WorkBuddy");

function ensureDirs() {
  for (const d of [LIBRARY, LIB_MINE, LIB_WB, LIB_OUT, STATE_DIR, path.join(LIBRARY, "imports")]) {
    fs.mkdirSync(d, { recursive: true });
  }
  if (!fs.existsSync(CRON_FILE)) fs.writeFileSync(CRON_FILE, "[]\n");
  if (!fs.existsSync(TASKS_FILE)) fs.writeFileSync(TASKS_FILE, "[]\n");
  if (!fs.existsSync(CONVERSATIONS_FILE)) fs.writeFileSync(CONVERSATIONS_FILE, "[]\n");
  if (!fs.existsSync(AUDIT_FILE)) fs.writeFileSync(AUDIT_FILE, "");
}

function audit(event, detail = {}) {
  const row = {
    ts: new Date().toISOString(),
    event,
    ...detail,
  };
  fs.appendFileSync(AUDIT_FILE, JSON.stringify(row) + "\n", "utf8");
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function loadConversations() {
  const rows = readJson(CONVERSATIONS_FILE, []);
  return Array.isArray(rows) ? rows : [];
}

function saveConversations(rows) {
  writeJson(CONVERSATIONS_FILE, rows.slice(0, 200));
}

function conversationTitleFromMessages(messages, fallback = "新会话") {
  const firstUser = (messages || []).find((m) => m?.role === "user" && String(m.content || "").trim());
  if (!firstUser) return fallback;
  const t = String(firstUser.content).replace(/\s+/g, " ").trim();
  return t.slice(0, 48) || fallback;
}

function summarizeConversation(c) {
  return {
    id: c.id,
    title: c.title || "新会话",
    updatedAt: c.updatedAt,
    createdAt: c.createdAt,
    messageCount: Array.isArray(c.messages) ? c.messages.length : 0,
    preview: (() => {
      const msgs = c.messages || [];
      const last = [...msgs].reverse().find((m) => m?.content);
      return last ? String(last.content).replace(/\s+/g, " ").trim().slice(0, 80) : "";
    })(),
  };
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    ...headers,
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function readRawBody(req, limitBytes = 80 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limitBytes) {
      throw new Error(`payload too large (max ${Math.round(limitBytes / 1024 / 1024)}MB)`);
    }
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function sanitizeFilename(name) {
  const base = path.basename(String(name || "file")).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  return (base || "file").slice(0, 180);
}

function uniqueLibraryRel(relDir, filename) {
  const safe = sanitizeFilename(filename);
  let rel = path.posix.join(relDir, safe);
  if (!fs.existsSync(safeJoin(LIBRARY, rel))) return rel;
  const ext = path.extname(safe);
  const stem = path.basename(safe, ext);
  for (let i = 1; i < 1000; i++) {
    rel = path.posix.join(relDir, `${stem}-${i}${ext}`);
    if (!fs.existsSync(safeJoin(LIBRARY, rel))) return rel;
  }
  return path.posix.join(relDir, `${stem}-${Date.now()}${ext}`);
}

function parseMultipart(buffer, boundary) {
  const files = [];
  const delim = Buffer.from(`--${boundary}`);
  let pos = buffer.indexOf(delim);
  if (pos < 0) return files;
  pos += delim.length;
  while (pos < buffer.length) {
    if (buffer[pos] === 0x2d && buffer[pos + 1] === 0x2d) break;
    if (buffer[pos] === 0x0d && buffer[pos + 1] === 0x0a) pos += 2;
    const next = buffer.indexOf(delim, pos);
    if (next < 0) break;
    let partEnd = next;
    if (partEnd >= 2 && buffer[partEnd - 2] === 0x0d && buffer[partEnd - 1] === 0x0a) {
      partEnd -= 2;
    }
    const part = buffer.subarray(pos, partEnd);
    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd >= 0) {
      const header = part.subarray(0, headerEnd).toString("utf8");
      const body = part.subarray(headerEnd + 4);
      const fileMatch = /filename\*?=(?:UTF-8''|")([^";]+)"?/i.exec(header);
      let filename = fileMatch ? decodeURIComponent(fileMatch[1].replace(/"/g, "")) : "";
      if (!filename) {
        const plain = /filename="([^"]*)"/i.exec(header);
        filename = plain?.[1] || "";
      }
      if (filename) files.push({ filename, data: body });
    }
    pos = next + delim.length;
  }
  return files;
}

function safeJoin(root, rel) {
  const cleaned = String(rel || "").replace(/^[/\\]+/, "");
  const full = path.resolve(root, cleaned);
  if (!full.startsWith(path.resolve(root))) {
    throw new Error("path escape blocked");
  }
  return full;
}

function walkTree(root, rel = "", depth = 0, maxDepth = 4, pathPrefix = "") {
  const abs = path.join(root, rel);
  let entries = [];
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return [];
  }
  const nodes = [];
  for (const ent of entries) {
    if (ent.name.startsWith(".")) continue;
    const childRel = rel ? `${rel}/${ent.name}` : ent.name;
    const childAbs = path.join(abs, ent.name);
    const publicPath = (pathPrefix ? `${pathPrefix}/${childRel}` : childRel).replace(/\\/g, "/");
    let isDir = ent.isDirectory();
    if (!isDir) {
      try {
        // Windows junctions often appear as symlinks; follow to real type.
        isDir = fs.statSync(childAbs).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (isDir) {
      nodes.push({
        type: "dir",
        name: ent.name,
        path: publicPath,
        children: depth < maxDepth ? walkTree(root, childRel, depth + 1, maxDepth, pathPrefix) : [],
      });
    } else {
      try {
        const st = fs.statSync(childAbs);
        if (!st.isFile()) continue;
        nodes.push({
          type: "file",
          name: ent.name,
          path: publicPath,
          size: st.size,
          mtime: st.mtime.toISOString(),
        });
      } catch {
        /* skip */
      }
    }
  }
  return nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function listWorkBuddyWorkspaces() {
  const out = [];
  if (fs.existsSync(WB_DB)) {
    try {
      const db = new DatabaseSync(WB_DB, { readOnly: true });
      const rows = db.prepare("SELECT path, last_opened_at FROM workspaces ORDER BY last_opened_at DESC").all();
      for (const r of rows) {
        out.push({
          path: r.path,
          lastOpenedAt: r.last_opened_at,
          exists: fs.existsSync(r.path),
          name: path.basename(r.path),
        });
      }
    } catch (e) {
      out.push({ error: String(e.message || e) });
    }
  }
  if (fs.existsSync(WB_ROOT)) {
    for (const name of fs.readdirSync(WB_ROOT)) {
      if (name === "Claw") continue;
      const p = path.join(WB_ROOT, name);
      if (!fs.statSync(p).isDirectory()) continue;
      if (!out.some((x) => x.path === p)) {
        out.push({ path: p, lastOpenedAt: null, exists: true, name });
      }
    }
  }
  return out;
}

function linkWorkBuddyWorkspace(srcPath) {
  if (!fs.existsSync(srcPath) || !fs.statSync(srcPath).isDirectory()) {
    throw new Error(`workspace not found: ${srcPath}`);
  }
  const name = path.basename(srcPath);
  const dest = path.join(LIB_WB, name);
  fs.mkdirSync(LIB_WB, { recursive: true });
  if (fs.existsSync(dest)) {
    const st = fs.lstatSync(dest);
    if (st.isSymbolicLink() || st.isDirectory()) {
      return { linked: dest, reused: true };
    }
  }
  try {
    fs.symlinkSync(srcPath, dest, "junction");
  } catch {
    // fallback: shallow copy of outputs + top-level text files
    fs.mkdirSync(dest, { recursive: true });
    const outputs = path.join(srcPath, "outputs");
    if (fs.existsSync(outputs)) {
      fs.cpSync(outputs, path.join(dest, "outputs"), { recursive: true });
    }
    for (const f of fs.readdirSync(srcPath)) {
      const abs = path.join(srcPath, f);
      if (fs.statSync(abs).isFile() && /\.(md|txt|json|csv|html)$/i.test(f)) {
        fs.copyFileSync(abs, path.join(dest, f));
      }
    }
  }
  audit("library.import_workbuddy", { srcPath, dest });
  return { linked: dest, reused: false };
}

function importAllWorkBuddy() {
  const list = listWorkBuddyWorkspaces().filter((x) => x.exists && x.path);
  const results = [];
  for (const item of list) {
    try {
      results.push({ ...item, ...linkWorkBuddyWorkspace(item.path) });
    } catch (e) {
      results.push({ ...item, error: String(e.message || e) });
    }
  }
  return results;
}

function listSkillsCompat() {
  const wb = [];
  const oc = [];
  if (fs.existsSync(WB_SKILLS)) {
    for (const name of fs.readdirSync(WB_SKILLS)) {
      const skillMd = path.join(WB_SKILLS, name, "SKILL.md");
      if (fs.existsSync(skillMd)) {
        wb.push({ name, path: skillMd, source: "workbuddy-user" });
      }
    }
  }
  const ocSkills = path.join(WORKSPACE, "skills");
  if (fs.existsSync(ocSkills)) {
    for (const name of fs.readdirSync(ocSkills)) {
      const skillMd = path.join(ocSkills, name, "SKILL.md");
      if (fs.existsSync(skillMd)) {
        oc.push({ name, path: skillMd, source: "openclaw-workspace" });
      }
    }
  }
  const namesWb = new Set(wb.map((x) => x.name));
  const namesOc = new Set(oc.map((x) => x.name));
  const matched = [...namesWb].filter((n) => namesOc.has(n));
  const onlyWb = [...namesWb].filter((n) => !namesOc.has(n));
  const onlyOc = [...namesOc].filter((n) => !namesWb.has(n));
  return {
    workbuddyUserSkills: wb,
    openclawWorkspaceSkills: oc,
    matched,
    onlyInWorkBuddy: onlyWb,
    onlyInAgentDesk: onlyOc,
    libraryRoots: {
      mine: LIB_MINE,
      workbuddy: LIB_WB,
      outputs: LIB_OUT,
    },
  };
}

function listSessionsFromWorkBuddy(limit = 20) {
  if (!fs.existsSync(WB_DB)) return [];
  try {
    const db = new DatabaseSync(WB_DB, { readOnly: true });
    return db
      .prepare(
        `SELECT id, title, custom_title, status, cwd, model, created_at, updated_at, permission_mode
         FROM sessions
         WHERE deleted_at IS NULL
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(limit);
  } catch {
    return [];
  }
}

async function gatewayChat(prompt, conversationId) {
  const cfg = JSON.parse(fs.readFileSync(path.join(OPENCLAW, "openclaw.json"), "utf8"));
  const token = cfg?.gateway?.auth?.token;
  if (!token) throw new Error("gateway token missing");
  const res = await fetch("http://127.0.0.1:18789/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openclaw/default",
      stream: false,
      user: `conv:${conversationId || crypto.randomUUID()}`,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

// ---- cron runner ----
let cronTimer = null;
function loadCron() {
  return readJson(CRON_FILE, []);
}
function saveCron(jobs) {
  writeJson(CRON_FILE, jobs);
}
function dueJobs(now = Date.now()) {
  return loadCron().filter((j) => j.enabled && j.nextRunAt && j.nextRunAt <= now);
}
function scheduleNext(job, from = Date.now()) {
  const everyMs = Number(job.everyMs || 3600000);
  job.nextRunAt = from + everyMs;
  return job;
}
async function tickCron() {
  const jobs = loadCron();
  let changed = false;
  for (const job of jobs) {
    if (!job.enabled || !job.nextRunAt || job.nextRunAt > Date.now()) continue;
    job.lastRunAt = Date.now();
    job.lastStatus = "running";
    changed = true;
    saveCron(jobs);
    audit("cron.run.start", { id: job.id, name: job.name });
    try {
      const result = await gatewayChat(job.prompt, `cron:${job.id}`);
      const content = result?.choices?.[0]?.message?.content || "";
      const outName = `${job.id}-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
      const outPath = path.join(LIB_OUT, outName);
      await fsp.writeFile(
        outPath,
        `# Cron: ${job.name}\n\n${content}\n`,
        "utf8",
      );
      job.lastStatus = "ok";
      job.lastError = null;
      job.lastOutput = outPath;
      audit("cron.run.ok", { id: job.id, output: outPath });
    } catch (e) {
      job.lastStatus = "error";
      job.lastError = String(e.message || e);
      audit("cron.run.error", { id: job.id, error: job.lastError });
    }
    scheduleNext(job);
    changed = true;
  }
  if (changed) saveCron(jobs);
}

function startCronLoop() {
  if (cronTimer) return;
  cronTimer = setInterval(() => {
    tickCron().catch((e) => audit("cron.tick.error", { error: String(e.message || e) }));
  }, 15000);
}

function describeGatewayMessage(msg) {
  const text = String(msg || "");
  if (!text) return null;
  if (text.includes("[model-fetch] response")) {
    const model = /model=(\S+)/.exec(text)?.[1] || "模型";
    const ms = /elapsedMs=(\d+)/.exec(text)?.[1];
    return `正在请求模型 ${model}${ms ? `（本段 ${ms}ms）` : ""}`;
  }
  if (text.includes("[model-fetch] error")) {
    const message = /message=(.+)$/.exec(text)?.[1] || "模型请求失败";
    return `模型请求失败：${message}`;
  }
  if (text.includes("prep stages")) return "正在准备 Agent 运行环境";
  if (text.includes("tool-search")) return "正在装载可用工具";
  if (text.includes("post-tool")) return "工具步骤已结束，正在整理最终回答";
  if (text.includes("reasoning-only")) return "模型只有思考内容，正在重试可见回答";
  if (text.includes("incomplete turn")) return "本轮回答不完整，Gateway 正在补救";
  if (text.includes("Couldn't generate")) return "Agent 未能生成回答";
  if (text.includes("ClientDisconnect") || text.includes("disconnected")) return "上游连接已断开";
  if (text.includes("session-resource-loader")) return "正在加载会话资源";
  if (text.includes("memory_index") || text.includes("memory ")) return "正在处理记忆索引";
  return null;
}

function readFileTail(file, maxBytes = 180_000) {
  if (!fs.existsSync(file)) return "";
  const st = fs.statSync(file);
  const start = Math.max(0, st.size - maxBytes);
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function parseGatewayLogLine(raw) {
  const line = String(raw || "").trim();
  if (!line) return null;
  if (line.startsWith("{")) {
    try {
      const j = JSON.parse(line);
      const msg = typeof j["1"] === "string" ? j["1"] : typeof j["2"] === "string" ? j["2"] : "";
      const at = j?._meta?.date || "";
      return { at, msg };
    } catch {
      return null;
    }
  }
  const m = /^(\d{4}-\d{2}-\d{2}T\S+)\s+(.*)$/.exec(line);
  if (!m) return null;
  return { at: m[1], msg: m[2] };
}

function latestGatewayActivity(sinceMs) {
  const day = new Date().toISOString().slice(0, 10);
  const files = [
    path.join(os.tmpdir(), "openclaw", `openclaw-${day}.log`),
    path.resolve(process.cwd(), "..", "..", ".tools", "gateway.out.log"),
    path.resolve(process.cwd(), "..", "..", ".tools", "gateway.err.log"),
  ];
  const items = [];
  for (const file of files) {
    const raw = readFileTail(file);
    if (!raw) continue;
    for (const line of raw.split(/\r?\n/)) {
      const parsed = parseGatewayLogLine(line);
      if (!parsed?.msg) continue;
      const atMs = parsed.at ? Date.parse(parsed.at) : NaN;
      if (!Number.isFinite(atMs)) continue;
      if (Number.isFinite(sinceMs) && atMs + 1000 < sinceMs) continue;
      const text = describeGatewayMessage(parsed.msg);
      if (!text) continue;
      items.push({
        at: parsed.at,
        text,
        key: `${parsed.at}|${text}`,
      });
    }
  }
  const seen = new Set();
  const uniq = [];
  items.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  for (const item of items) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    uniq.push(item);
  }
  return uniq.slice(-8);
}

async function handle(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, "");

  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  const p = url.pathname;

  try {
    if (req.method === "GET" && p === "/api/health") {
      return send(res, 200, {
        ok: true,
        service: "agentdesk-bridge",
        library: LIBRARY,
        time: new Date().toISOString(),
      });
    }

    if (req.method === "GET" && p === "/api/runtime/activity") {
      const since = Date.parse(url.searchParams.get("since") || "");
      return send(res, 200, {
        lines: latestGatewayActivity(Number.isFinite(since) ? since : Date.now() - 120_000),
      });
    }

    if (req.method === "GET" && p === "/api/local-config") {
      // Loopback-only convenience for local UI; never expose remotely.
      const ra = req.socket.remoteAddress || "";
      const local = ra === "127.0.0.1" || ra === "::1" || ra === "::ffff:127.0.0.1";
      if (!local) return send(res, 403, { error: "loopback only" });
      let token = "";
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(OPENCLAW, "openclaw.json"), "utf8"));
        token = cfg?.gateway?.auth?.token || "";
      } catch {
        /* ignore */
      }
      return send(res, 200, {
        gatewayUrl: "http://127.0.0.1:18789",
        bridgeUrl: `http://127.0.0.1:${PORT}`,
        token,
        model: "openclaw/default",
      });
    }

    if (req.method === "GET" && p === "/api/library/tree") {
      return send(res, 200, {
        root: LIBRARY,
        tree: [
          { type: "dir", name: "mine", path: "mine", children: walkTree(LIB_MINE, "", 0, 4, "mine") },
          { type: "dir", name: "workbuddy", path: "workbuddy", children: walkTree(LIB_WB, "", 0, 3, "workbuddy") },
          { type: "dir", name: "outputs", path: "outputs", children: walkTree(LIB_OUT, "", 0, 4, "outputs") },
        ],
      });
    }

    if (req.method === "GET" && p === "/api/library/file") {
      const rel = url.searchParams.get("path") || "";
      const abs = safeJoin(LIBRARY, rel);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        return send(res, 404, { error: "not found" });
      }
      const st = fs.statSync(abs);
      const ext = path.extname(abs).toLowerCase();
      const textLike = [".md", ".txt", ".json", ".csv", ".html", ".js", ".ts", ".py", ".xml", ".yml", ".yaml", ".dxf"].includes(ext);
      if (!textLike || st.size > 512_000) {
        return send(res, 200, {
          path: rel,
          abs,
          size: st.size,
          binary: true,
          preview: null,
        });
      }
      const content = fs.readFileSync(abs, "utf8");
      return send(res, 200, {
        path: rel,
        abs,
        size: st.size,
        binary: false,
        preview: content.slice(0, 20000),
      });
    }

    if (req.method === "POST" && p === "/api/library/write") {
      const body = await readBody(req);
      const rel = body?.path;
      const content = body?.content ?? "";
      if (!rel) return send(res, 400, { error: "path required" });
      // only allow writes under mine/ or outputs/
      if (!String(rel).startsWith("mine/") && !String(rel).startsWith("outputs/")) {
        return send(res, 403, { error: "writes only allowed under mine/ or outputs/" });
      }
      const abs = safeJoin(LIBRARY, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf8");
      audit("library.write", { path: rel });
      return send(res, 200, { ok: true, path: rel, abs });
    }

    if (req.method === "POST" && p === "/api/library/upload") {
      const day = new Date().toISOString().slice(0, 10);
      const relDir = `mine/inbox/${day}`;
      const saved = [];
      const ctype = String(req.headers["content-type"] || "");
      if (ctype.includes("multipart/form-data")) {
        const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype);
        const boundary = (m?.[1] || m?.[2] || "").trim();
        if (!boundary) return send(res, 400, { error: "multipart boundary missing" });
        const raw = await readRawBody(req);
        const parts = parseMultipart(raw, boundary);
        if (!parts.length) return send(res, 400, { error: "no files in multipart body" });
        for (const part of parts) {
          const rel = uniqueLibraryRel(relDir, part.filename);
          const abs = safeJoin(LIBRARY, rel);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, part.data);
          saved.push({ path: rel, name: path.basename(rel), size: part.data.length, abs });
        }
      } else {
        const body = await readBody(req);
        const items = Array.isArray(body?.files) ? body.files : body?.name ? [body] : [];
        if (!items.length) return send(res, 400, { error: "files required" });
        for (const item of items) {
          const name = item?.name || item?.filename || "file";
          const b64 = item?.contentBase64 || item?.data;
          if (!b64) return send(res, 400, { error: `missing contentBase64 for ${name}` });
          const data = Buffer.from(String(b64), "base64");
          const rel = uniqueLibraryRel(relDir, name);
          const abs = safeJoin(LIBRARY, rel);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, data);
          saved.push({ path: rel, name: path.basename(rel), size: data.length, abs });
        }
      }
      audit("library.upload", { count: saved.length, paths: saved.map((f) => f.path) });
      return send(res, 200, { ok: true, files: saved, paths: saved.map((f) => f.path) });
    }

    if (req.method === "POST" && p === "/api/library/attach") {
      const body = await readBody(req);
      const paths = Array.isArray(body?.paths) ? body.paths : body?.path ? [body.path] : [];
      if (!paths.length) return send(res, 400, { error: "paths required" });
      const lines = ["[AgentDesk Library] 请优先读取并基于以下资料执行任务："];
      for (const rel of paths) {
        const abs = safeJoin(LIBRARY, rel);
        if (!fs.existsSync(abs)) {
          return send(res, 404, { error: `file not found: ${rel}` });
        }
        lines.push(`- \`${rel}\` → \`${abs}\``);
      }
      lines.push("", "完成后将产物写入 `library/outputs/`，并说明保存路径。");
      const snippet = lines.join("\n");
      audit("library.attach", { paths });
      return send(res, 200, { snippet, paths });
    }

    if (req.method === "GET" && p === "/api/workbuddy/workspaces") {
      return send(res, 200, { workspaces: listWorkBuddyWorkspaces() });
    }

    if (req.method === "POST" && p === "/api/workbuddy/import") {
      const body = await readBody(req);
      if (body?.path) {
        const r = linkWorkBuddyWorkspace(body.path);
        return send(res, 200, r);
      }
      return send(res, 200, { imported: importAllWorkBuddy() });
    }

    if (req.method === "GET" && p === "/api/workbuddy/sessions") {
      return send(res, 200, { sessions: listSessionsFromWorkBuddy(Number(url.searchParams.get("limit") || 20)) });
    }

    if (req.method === "GET" && p === "/api/compat/skills") {
      return send(res, 200, listSkillsCompat());
    }

    if (req.method === "GET" && p === "/api/skills/detail") {
      const name = String(url.searchParams.get("name") || "").trim();
      if (!name || name.includes("..") || name.includes("/") || name.includes("\\")) {
        return send(res, 400, { error: "invalid name" });
      }
      const candidates = [
        { source: "openclaw-workspace", file: path.join(WORKSPACE, "skills", name, "SKILL.md") },
        { source: "workbuddy-user", file: path.join(WB_SKILLS, name, "SKILL.md") },
      ];
      for (const c of candidates) {
        if (fs.existsSync(c.file)) {
          const body = fs.readFileSync(c.file, "utf8");
          return send(res, 200, {
            name,
            source: c.source,
            path: c.file,
            body: body.slice(0, 40000),
          });
        }
      }
      return send(res, 404, { error: "skill not found", name });
    }

    if (req.method === "GET" && p === "/api/tasks") {
      return send(res, 200, { tasks: readJson(TASKS_FILE, []) });
    }

    if (req.method === "POST" && p === "/api/tasks") {
      const body = await readBody(req);
      const tasks = readJson(TASKS_FILE, []);
      const task = {
        id: crypto.randomUUID(),
        title: body?.title || "untitled",
        conversationId: body?.conversationId || crypto.randomUUID(),
        attachments: body?.attachments || [],
        status: "open",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      tasks.unshift(task);
      writeJson(TASKS_FILE, tasks.slice(0, 200));
      audit("task.create", { id: task.id, title: task.title });
      return send(res, 200, task);
    }

    if (req.method === "GET" && p === "/api/conversations") {
      const list = loadConversations()
        .map(summarizeConversation)
        .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
      return send(res, 200, { conversations: list });
    }

    if (req.method === "POST" && p === "/api/conversations") {
      const body = await readBody(req);
      const now = new Date().toISOString();
      const messages = Array.isArray(body?.messages) ? body.messages : [];
      const row = {
        id: body?.id || crypto.randomUUID(),
        title: body?.title || conversationTitleFromMessages(messages),
        messages,
        createdAt: now,
        updatedAt: now,
      };
      const all = loadConversations().filter((c) => c.id !== row.id);
      all.unshift(row);
      saveConversations(all);
      audit("conversation.create", { id: row.id, title: row.title });
      return send(res, 200, row);
    }

    if (req.method === "GET" && p.startsWith("/api/conversations/")) {
      const id = decodeURIComponent(p.slice("/api/conversations/".length));
      const row = loadConversations().find((c) => c.id === id);
      if (!row) return send(res, 404, { error: "not found" });
      return send(res, 200, row);
    }

    if (req.method === "PUT" && p.startsWith("/api/conversations/")) {
      const id = decodeURIComponent(p.slice("/api/conversations/".length));
      const body = await readBody(req);
      const all = loadConversations();
      const idx = all.findIndex((c) => c.id === id);
      const now = new Date().toISOString();
      const messages = Array.isArray(body?.messages) ? body.messages : idx >= 0 ? all[idx].messages : [];
      const row = {
        id,
        title: body?.title || conversationTitleFromMessages(messages, idx >= 0 ? all[idx].title : "新会话"),
        messages,
        createdAt: idx >= 0 ? all[idx].createdAt : now,
        updatedAt: now,
      };
      if (idx >= 0) all.splice(idx, 1);
      all.unshift(row);
      saveConversations(all);
      audit("conversation.upsert", { id, messageCount: messages.length });
      return send(res, 200, row);
    }

    if (req.method === "DELETE" && p.startsWith("/api/conversations/")) {
      const id = decodeURIComponent(p.slice("/api/conversations/".length));
      const all = loadConversations().filter((c) => c.id !== id);
      saveConversations(all);
      audit("conversation.delete", { id });
      return send(res, 200, { ok: true });
    }

    if (req.method === "GET" && p === "/api/cron") {
      return send(res, 200, { jobs: loadCron() });
    }

    if (req.method === "POST" && p === "/api/cron") {
      const body = await readBody(req);
      if (!body?.name || !body?.prompt) return send(res, 400, { error: "name and prompt required" });
      const jobs = loadCron();
      const job = {
        id: crypto.randomUUID(),
        name: body.name,
        prompt: body.prompt,
        everyMs: Number(body.everyMs || 3600000),
        enabled: body.enabled !== false,
        createdAt: new Date().toISOString(),
        nextRunAt: Date.now() + Number(body.everyMs || 3600000),
        lastRunAt: null,
        lastStatus: null,
        lastError: null,
        lastOutput: null,
      };
      jobs.push(job);
      saveCron(jobs);
      audit("cron.create", { id: job.id, name: job.name });
      return send(res, 200, job);
    }

    if (req.method === "PUT" && p.startsWith("/api/cron/")) {
      const id = p.split("/").pop();
      const body = await readBody(req);
      const jobs = loadCron();
      const idx = jobs.findIndex((j) => j.id === id);
      if (idx < 0) return send(res, 404, { error: "not found" });
      jobs[idx] = { ...jobs[idx], ...body, id };
      saveCron(jobs);
      audit("cron.update", { id });
      return send(res, 200, jobs[idx]);
    }

    if (req.method === "DELETE" && p.startsWith("/api/cron/")) {
      const id = p.split("/").pop();
      const jobs = loadCron().filter((j) => j.id !== id);
      saveCron(jobs);
      audit("cron.delete", { id });
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && p.startsWith("/api/cron/") && p.endsWith("/run")) {
      const id = p.split("/")[3];
      const jobs = loadCron();
      const job = jobs.find((j) => j.id === id);
      if (!job) return send(res, 404, { error: "not found" });
      job.nextRunAt = Date.now();
      saveCron(jobs);
      await tickCron();
      return send(res, 200, loadCron().find((j) => j.id === id));
    }

    if (req.method === "GET" && p === "/api/audit") {
      const limit = Number(url.searchParams.get("limit") || 100);
      const lines = fs.readFileSync(AUDIT_FILE, "utf8").trim().split("\n").filter(Boolean);
      const rows = lines.slice(-limit).map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { raw: l };
        }
      });
      return send(res, 200, { entries: rows.reverse() });
    }

    return send(res, 404, { error: "not found", path: p });
  } catch (e) {
    audit("api.error", { path: p, error: String(e.message || e) });
    return send(res, 500, { error: String(e.message || e) });
  }
}

ensureDirs();
// seed a sample note if empty
if (!fs.existsSync(path.join(LIB_MINE, "README.md"))) {
  fs.writeFileSync(
    path.join(LIB_MINE, "README.md"),
    `# AgentDesk 资料库 · 我的文档

AgentDesk 可独立运行，不依赖腾讯 WorkBuddy。

- mine/：个人资料
- imports/：外部导入
- workbuddy/：可选，仅在导入本机 WorkBuddy 时使用
- outputs/：任务产物回写
`,
    "utf8",
  );
}
// WorkBuddy import is optional and on-demand (POST /api/workbuddy/import).
if (fs.existsSync(WB_DB) || fs.existsSync(WB_ROOT)) {
  console.log("[agentdesk-bridge] WorkBuddy detected; import available via API/UI");
} else {
  console.log("[agentdesk-bridge] standalone mode (no WorkBuddy install)");
}
startCronLoop();

const server = http.createServer((req, res) => {
  handle(req, res);
});
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[agentdesk-bridge] http://127.0.0.1:${PORT}`);
  console.log(`[agentdesk-bridge] library=${LIBRARY}`);
  audit("bridge.start", { port: PORT });
});
