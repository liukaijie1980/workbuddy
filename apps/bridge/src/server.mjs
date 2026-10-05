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

function skillHash(file) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 12);
  } catch {
    return "";
  }
}

function syncWorkBuddySkills() {
  const destRoot = path.join(WORKSPACE, "skills");
  fs.mkdirSync(destRoot, { recursive: true });
  const synced = [];
  if (!fs.existsSync(WB_SKILLS)) return synced;
  for (const name of fs.readdirSync(WB_SKILLS)) {
    const src = path.join(WB_SKILLS, name);
    const skillMd = path.join(src, "SKILL.md");
    if (!fs.existsSync(skillMd) || !fs.statSync(src).isDirectory()) continue;
    const dest = path.join(destRoot, name);
    const destMd = path.join(dest, "SKILL.md");
    if (fs.existsSync(destMd) && skillHash(skillMd) === skillHash(destMd)) {
      synced.push({ name, action: "same" });
      continue;
    }
    fs.cpSync(src, dest, { recursive: true, force: true });
    synced.push({ name, action: "copied" });
    audit("skills.sync_workbuddy", { name });
  }
  return synced;
}

function resolveSkill(name) {
  const safe = String(name || "").trim();
  if (!safe || /[\\/]|\.\./.test(safe)) return null;
  const wbDir = path.join(WB_SKILLS, safe);
  const ocDir = path.join(WORKSPACE, "skills", safe);
  const dir = fs.existsSync(path.join(wbDir, "SKILL.md"))
    ? wbDir
    : fs.existsSync(path.join(ocDir, "SKILL.md"))
      ? ocDir
      : null;
  if (!dir) return null;
  return {
    name: safe,
    dir,
    source: dir === wbDir ? "workbuddy-user" : "openclaw-workspace",
    skillMd: path.join(dir, "SKILL.md"),
  };
}

function listSkillFiles(dir, prefix = "") {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const abs = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const st = fs.statSync(abs);
    if (st.isDirectory()) out.push(...listSkillFiles(abs, rel));
    else out.push(rel.replace(/\\/g, "/"));
  }
  return out;
}

function workbuddyPython(skillBody = "") {
  const mentioned = String(skillBody).match(/[A-Za-z]:[\\/](?:[^\\/\s`]+[\\/])*python\.exe/i);
  if (mentioned) {
    const abs = mentioned[0].replace(/\//g, "\\");
    if (fs.existsSync(abs)) return abs.replace(/\\/g, "/");
  }
  const versions = path.join(HOME, ".workbuddy", "binaries", "python", "versions");
  if (!fs.existsSync(versions)) return "";
  const exes = fs
    .readdirSync(versions)
    .map((version) => path.join(versions, version, "python.exe"))
    .filter((exe) => fs.existsSync(exe))
    .sort();
  return exes.length ? exes[exes.length - 1].replace(/\\/g, "/") : "";
}

function listSkillNames() {
  const names = new Set();
  for (const root of [WB_SKILLS, path.join(WORKSPACE, "skills")]) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      if (fs.existsSync(path.join(root, name, "SKILL.md"))) names.add(name);
    }
  }
  return [...names];
}

function skillTriggerPhrases(description) {
  const phrases = [];
  const re = /[「"“']([^」"”']{2,40})[」"”']/g;
  let match;
  while ((match = re.exec(description))) phrases.push(match[1]);
  return phrases;
}

function matchWorkBuddySkill(text, preferred) {
  syncWorkBuddySkills();
  const preferredName = String(preferred || "").trim();
  if (preferredName && resolveSkill(preferredName)) return buildSkillContract(preferredName);
  const raw = String(text || "");
  if (!raw.trim()) return null;
  let bestName = "";
  let bestScore = 0;
  let ties = 0;
  for (const name of listSkillNames()) {
    const skill = resolveSkill(name);
    if (!skill) continue;
    let score = raw.includes(name) ? 100 : 0;
    let body = "";
    try {
      body = fs.readFileSync(skill.skillMd, "utf8");
    } catch {
      continue;
    }
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body);
    const description = front ? /^description:\s*(.+)$/m.exec(front[1])?.[1] || "" : "";
    for (const phrase of skillTriggerPhrases(description)) {
      if (raw.includes(phrase)) score = Math.max(score, 90);
    }
    if (score > bestScore) {
      bestScore = score;
      bestName = name;
      ties = 1;
    } else if (score === bestScore && score > 0) {
      ties += 1;
    }
  }
  if (bestScore < 90 || !bestName || ties > 1) return null;
  return buildSkillContract(bestName);
}

function buildSkillContract(name) {
  syncWorkBuddySkills();
  const skill = resolveSkill(name);
  if (!skill) return null;
  const body = fs.readFileSync(skill.skillMd, "utf8");
  const files = listSkillFiles(skill.dir);
  const templates = files.filter((f) => /assets\/.+\.(py|js|mjs|ps1|sh)$/i.test(f));
  const py = workbuddyPython(body);
  const lines = [
    `[WorkBuddy Skill 合同] 必须按技能「${skill.name}」原文执行，目标是与 WorkBuddy 同一技能得到同类产物。`,
    "",
    "硬性规则：",
    "1. 先 Read 本技能 SKILL.md，再 Read 下面列出的模板脚本。禁止在未读模板前从零编写依赖库代码。",
    "2. 生成脚本时以模板为起点复制修改（改输入路径、尺寸参数、输出文件名）。禁止发明模板里没有的 API。",
    "3. 产物必须写入 library/outputs/，文件名与技能交付标准一致，并在回复里给出绝对路径。",
    "4. 技能要求的文件（如 DXF、PNG）没落盘之前，不要用纯文字分析结束任务。",
  ];
  if (py) {
    lines.push(`5. 运行 Python 必须使用：\`${py}\`。不要用 PATH 里别的 python。`);
  }
  lines.push(
    "",
    `技能目录：\`${skill.dir.replace(/\\/g, "/")}\``,
    "技能文件：",
    ...files.map((f) => `- \`${f}\``),
  );
  if (templates.length) {
    lines.push("", "必须先读取并作为唯一起点的模板：", ...templates.map((f) => `- \`${skill.dir.replace(/\\/g, "/")}/${f}\``));
  }
  lines.push("", "----- SKILL.md -----", body.trim().slice(0, 12000));
  return {
    name: skill.name,
    source: skill.source,
    dir: skill.dir,
    files,
    python: py,
    snippet: lines.join("\n"),
  };
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

function stripAnsi(text) {
  return String(text || "").replace(/\u001b\[[0-9;]*m/g, "");
}

function extractToolName(text) {
  const fromRaw = /raw_params=[\s\S]*"id"\s*:\s*"([a-zA-Z][a-zA-Z0-9_.:\-]{1,60})"/.exec(text)?.[1];
  const fromToolField =
    /"tool(?:Name|Id)"\s*:\s*"([a-zA-Z][a-zA-Z0-9_.:\-]{1,60})"/.exec(text)?.[1] ||
    /\btool(?:_call)?(?:\s+failed)?[:\s]+`?([a-zA-Z][a-zA-Z0-9_.:\-]{1,40})`?/.exec(text)?.[1] ||
    /\b(?:calling|invoke(?:d)?|running)\s+tool\s+[`"']?([a-zA-Z][a-zA-Z0-9_.:\-]{1,40})/.exec(text)?.[1];
  const raw = fromRaw || fromToolField;
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (["failed", "error", "call", "search", "cataloged", "args", "query"].includes(lower)) return null;
  return raw;
}

function shortPath(p) {
  const s = String(p || "").replace(/\\/g, "/");
  if (!s) return "";
  const parts = s.split("/").filter(Boolean);
  if (parts.length <= 2) return parts.join("/") || s;
  return parts.slice(-2).join("/");
}

function clipText(s, n = 72) {
  const t = String(s || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "";
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function clipBlock(s, n = 4000) {
  const t = String(s || "");
  if (!t) return "";
  if (t.length <= n) return t;
  return `${t.slice(0, n)}\n…(已截断 ${t.length - n} 字)`;
}

function extractContentParts(content) {
  const parts = { thinking: "", text: "", tools: [] };
  const walk = (node) => {
    if (node == null) return;
    if (typeof node === "string") {
      parts.text += node;
      return;
    }
    if (Array.isArray(node)) {
      for (const x of node) walk(x);
      return;
    }
    if (typeof node !== "object") return;
    const type = node.type || node.kind;
    if (type === "thinking" || type === "reasoning") {
      parts.thinking += node.thinking || node.text || node.content || "";
      return;
    }
    if (type === "text") {
      parts.text += typeof node.text === "string" ? node.text : node.content || "";
      return;
    }
    if (type === "toolCall" || type === "tool_use") {
      parts.tools.push({
        name: node.name || node.toolName || "tool",
        args: node.arguments || node.args || node.input || {},
      });
      return;
    }
    if (node.content) walk(node.content);
  };
  walk(content);
  return parts;
}

function stringifyArgs(args) {
  if (args == null) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

function formatIoDetail({ heading, thinking, text, tools, extra } = {}) {
  const blocks = [];
  if (heading) blocks.push(heading);
  if (String(thinking || "").trim()) blocks.push(`【思考】\n${clipBlock(thinking, 2500)}`);
  if (String(text || "").trim()) blocks.push(`【正文】\n${clipBlock(text, 3000)}`);
  for (const tool of tools || []) {
    const name = tool?.name || "tool";
    blocks.push(`【调用 ${name}】\n${clipBlock(stringifyArgs(tool.args), 3500)}`);
  }
  if (String(extra || "").trim()) blocks.push(String(extra).trim());
  return blocks.join("\n\n").trim();
}

function toolResultText(result) {
  if (result == null) return "";
  if (typeof result === "string") return result;
  const chunks = [];
  if (Array.isArray(result.content)) {
    for (const part of result.content) {
      if (typeof part === "string") chunks.push(part);
      else if (part && typeof part.text === "string") chunks.push(part.text);
    }
  }
  if (result.details?.aggregated) chunks.push(String(result.details.aggregated));
  if (chunks.length) return chunks.join("\n");
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

function activityAt(ev, createdAt) {
  if (typeof ev?.ts === "string" && ev.ts) return ev.ts;
  if (Number.isFinite(createdAt)) return new Date(createdAt).toISOString();
  return "";
}

function summarizeToolArgs(name, args) {
  if (!args || typeof args !== "object") return "";
  if (typeof args.title === "string" && args.title.trim()) return clipText(args.title, 64);
  if (typeof args.path === "string") return shortPath(args.path);
  if (typeof args.file_path === "string") return shortPath(args.file_path);
  if (typeof args.command === "string") return clipText(args.command, 88);
  if (typeof args.query === "string") return clipText(args.query, 72);
  if (typeof args.url === "string") return clipText(args.url, 72);
  if (typeof args.pattern === "string") return clipText(args.pattern, 64);
  if (name === "web_search" || name === "bocha_web_search") {
    return clipText(args.q || args.keyword || args.search || "", 72);
  }
  const keys = Object.keys(args).slice(0, 3);
  if (!keys.length) return "";
  try {
    return clipText(JSON.stringify(Object.fromEntries(keys.map((k) => [k, args[k]]))), 88);
  } catch {
    return "";
  }
}

function describeTrajectoryEvent(ev) {
  if (!ev || typeof ev !== "object") return null;
  const d = ev.data && typeof ev.data === "object" ? ev.data : {};
  const model = String(ev.modelId || "").trim();
  const type = String(ev.type || "");

  if (type === "prompt.submitted") {
    const prompt = String(d.prompt || "").trim();
    const msgs = Array.isArray(d.messages) ? d.messages : [];
    const msgBlocks = msgs.slice(-6).map((m) => {
      const p = extractContentParts(m?.content ?? m);
      const body = [p.thinking, p.text].filter((x) => String(x).trim()).join("\n");
      return `【${m?.role || "message"}】\n${clipBlock(body || stringifyArgs(m), 1600)}`;
    });
    const extra = msgBlocks.join("\n\n");
    const detail = formatIoDetail({
      heading: model ? `发给 ${model}` : "发给模型",
      text: prompt,
      extra,
    });
    const preview = clipText(prompt, 70);
    return {
      text: preview ? `发给模型${model ? ` ${model}` : ""}：${preview}` : `发给模型${model ? ` ${model}` : ""}`,
      detail: detail || prompt,
    };
  }

  if (type === "tool.call") {
    const name = String(d.name || "tool").trim() || "tool";
    const summary = summarizeToolArgs(name, d.args);
    return {
      text: summary ? `模型回复 · 调用 ${name}：${summary}` : `模型回复 · 调用 ${name}`,
      detail: formatIoDetail({ tools: [{ name, args: d.args }] }),
    };
  }

  if (type === "tool.result") {
    const name = String(d.name || "tool").trim() || "tool";
    const body = toolResultText(d.result);
    return {
      text: d.success === false ? `工具 ${name} 失败` : `工具 ${name} 已回传`,
      detail: clipBlock(body, 2500),
    };
  }

  if (type === "model.completed") {
    const snap = Array.isArray(d.messagesSnapshot) ? d.messagesSnapshot : [];
    const lastAsst = [...snap].reverse().find((m) => m?.role === "assistant");
    const parts = extractContentParts(lastAsst?.content);
    if (Array.isArray(d.assistantTexts) && d.assistantTexts.length && !String(parts.text).trim()) {
      parts.text = d.assistantTexts.filter(Boolean).join("\n");
    }
    const err = d.promptError ? `【中断】${d.promptError}` : "";
    const usage = d.usage
      ? `【用量】in ${d.usage.input ?? "?"} / out ${d.usage.output ?? "?"} / total ${d.usage.total ?? "?"}`
      : "";
    const detail = formatIoDetail({
      heading: model ? `来自 ${model}` : "模型回复",
      thinking: parts.thinking,
      text: parts.text,
      tools: parts.tools,
      extra: [err, usage].filter(Boolean).join("\n"),
    });
    if (d.promptError) {
      return { text: `模型中断：${clipText(d.promptError, 100)}`, detail };
    }
    const input = d.usage?.input;
    const output = d.usage?.output;
    const preview = clipText(parts.text || parts.thinking, 70);
    return {
      text: preview
        ? `模型回复：${preview}`
        : Number.isFinite(Number(input))
          ? `模型回复收束 · ${input}→${Number.isFinite(Number(output)) ? output : 0} tokens`
          : "模型回复收束",
      detail,
    };
  }

  if (type === "session.ended") return { text: "本轮 Agent 运行已结束", detail: "" };
  return null;
}

function latestTrajectoryActivity(sinceMs) {
  const dbPath = path.join(OPENCLAW, "agents", "main", "agent", "openclaw-agent.sqlite");
  if (!fs.existsSync(dbPath)) return [];
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return [];
  }
  try {
    const floor = Number.isFinite(sinceMs) ? Math.max(0, sinceMs - 1500) : Date.now() - 120_000;
    const rows = db
      .prepare(
        `SELECT created_at, event_json
         FROM trajectory_runtime_events
         WHERE created_at >= ?
           AND (
             instr(event_json, '"type":"tool.call"') > 0
             OR instr(event_json, '"type":"tool.result"') > 0
             OR instr(event_json, '"type":"prompt.submitted"') > 0
             OR instr(event_json, '"type":"model.completed"') > 0
             OR instr(event_json, '"type":"session.ended"') > 0
           )
         ORDER BY created_at ASC
         LIMIT 160`,
      )
      .all(floor);
    const items = [];
    for (const row of rows) {
      let ev;
      try {
        ev = JSON.parse(row.event_json);
      } catch {
        continue;
      }
      const described = describeTrajectoryEvent(ev);
      if (!described?.text) continue;
      const at = activityAt(ev, row.created_at);
      if (!at) continue;
      const atMs = Date.parse(at);
      if (Number.isFinite(sinceMs) && Number.isFinite(atMs) && atMs + 1000 < sinceMs) continue;
      items.push({
        at,
        text: described.text,
        detail: described.detail || "",
        key: `traj|${row.created_at}|${ev.type}|${described.text}`,
      });
    }
    return items;
  } catch {
    return [];
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

function latestTranscriptActivity(sinceMs) {
  const dbPath = path.join(OPENCLAW, "agents", "main", "agent", "openclaw-agent.sqlite");
  if (!fs.existsSync(dbPath)) return [];
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return [];
  }
  try {
    const floor = Number.isFinite(sinceMs) ? Math.max(0, sinceMs - 1500) : Date.now() - 120_000;
    const rows = db
      .prepare(
        `SELECT session_id, seq, created_at, event_json
         FROM transcript_events
         WHERE created_at >= ?
           AND event_json IS NOT NULL
           AND instr(event_json, '"role":"assistant"') > 0
         ORDER BY created_at ASC
         LIMIT 80`,
      )
      .all(floor);
    const items = [];
    for (const row of rows) {
      let ev;
      try {
        ev = JSON.parse(row.event_json);
      } catch {
        continue;
      }
      const msg = ev?.message;
      if (!msg || msg.role !== "assistant") continue;
      const parts = extractContentParts(msg.content);
      if (!String(parts.thinking).trim() && !String(parts.text).trim() && !parts.tools.length) continue;
      const at = typeof ev.timestamp === "string" && ev.timestamp ? ev.timestamp : activityAt(ev, row.created_at);
      const atMs = Date.parse(at);
      if (Number.isFinite(sinceMs) && Number.isFinite(atMs) && atMs + 1000 < sinceMs) continue;
      const preview = clipText(parts.text || parts.thinking || parts.tools.map((t) => t.name).join(", "), 70);
      const model = msg.model || msg.provider ? `${msg.provider || ""} ${msg.model || ""}`.trim() : "";
      items.push({
        at,
        text: preview ? `模型回复：${preview}` : "模型回复",
        detail: formatIoDetail({
          heading: model ? `来自 ${model}` : "模型回复",
          thinking: parts.thinking,
          text: parts.text,
          tools: parts.tools,
        }),
        key: `trans|${row.session_id}|${row.seq}`,
      });
    }
    return items;
  } catch {
    return [];
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

function describeGatewayMessage(msg, ctx = {}) {
  const text = stripAnsi(msg);
  if (!text) return null;

  const tool = extractToolName(text);
  if (tool && /tool_call failed|tool failed|failed:/.test(text)) {
    return `工具调用失败：${tool}`;
  }
  if (tool && /web_search is disabled|no provider is available/i.test(text)) {
    return `工具 ${tool} 不可用（未配置搜索 Provider）`;
  }
  if (tool) return `正在调用工具 ${tool}`;

  if (text.includes("[model-fetch] response")) {
    return null;
  }
  if (text.includes("[model-fetch] error")) {
    const message = /message=(.+)$/.exec(text)?.[1] || "模型请求失败";
    return `模型请求失败：${message}`;
  }
  if (/transient same-model retry/i.test(text)) {
    const n = /retry\s+(\d+\/\d+)/i.exec(text)?.[1];
    const reason = /reason=([^\s:]+)/i.exec(text)?.[1];
    return `模型瞬时失败，正在重试${n ? ` ${n}` : ""}${reason ? `（${reason}）` : ""}`;
  }
  if (/context-pressure|estimatedPromptTokens=(\d+)/.test(text)) {
    const tokens = /estimatedPromptTokens=(\d+)/.exec(text)?.[1];
    const budget = /promptBudgetBeforeReserve=(\d+)/.exec(text)?.[1];
    if (tokens && budget && Number(tokens) > Number(budget)) {
      return `上下文过长（约 ${tokens} tokens > 预算 ${budget}），正在压缩后继续`;
    }
    if (tokens) return `正在评估上下文压力（约 ${tokens} tokens）`;
  }
  if (text.includes("stopReason=length") || text.includes("truncated at the model's output token limit")) {
    return "模型输出触达长度上限，回答被截断";
  }
  if (text.includes("prep stages")) return "正在准备 Agent 运行环境";
  if (text.includes("tool-search")) {
    const n = /cataloged (\d+) tools/.exec(text)?.[1];
    return n ? `已装载 ${n} 个可用工具` : "正在装载可用工具";
  }
  if (text.includes("post-tool")) return "工具步骤已结束，正在整理最终回答";
  if (text.includes("reasoning-only")) return "模型只有思考内容，正在重试可见回答";
  if (text.includes("incomplete turn")) return "本轮回答不完整，Gateway 正在补救";
  if (text.includes("Couldn't generate")) return "Agent 未能生成回答";
  if (text.includes("ClientDisconnect") || text.includes("disconnected")) return null;
  if (text.includes("session-resource-loader")) return "正在加载会话资源";
  if (text.includes("memory_index") || text.includes("memory ")) return "正在处理记忆索引";
  return null;
}

function readFileTail(file, maxBytes = 240_000) {
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
  const line = stripAnsi(raw).trim();
  if (!line) return null;
  if (line.startsWith("{")) {
    try {
      const j = JSON.parse(line);
      const parts = [];
      for (const key of ["0", "1", "2", "msg", "message"]) {
        const v = j[key];
        if (typeof v === "string" && v.trim()) parts.push(v);
        else if (v && typeof v === "object") {
          try {
            parts.push(JSON.stringify(v));
          } catch {
            /* ignore */
          }
        }
      }
      const msg = parts.join(" ");
      const at = j?._meta?.date || "";
      return msg ? { at, msg } : null;
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
  const items = [...latestTrajectoryActivity(sinceMs), ...latestTranscriptActivity(sinceMs)];
  const logCtx = { modelRound: 0 };
  for (const file of files) {
    const raw = readFileTail(file);
    if (!raw) continue;
    let pending = null;
    const flush = () => {
      if (!pending?.msg) {
        pending = null;
        return;
      }
      const atMs = pending.at ? Date.parse(pending.at) : NaN;
      if (!Number.isFinite(atMs)) {
        pending = null;
        return;
      }
      if (Number.isFinite(sinceMs) && atMs + 1000 < sinceMs) {
        pending = null;
        return;
      }
      const text = describeGatewayMessage(pending.msg, logCtx);
      if (text) {
        items.push({
          at: pending.at,
          text,
          detail: "",
          key: `${pending.at}|${text}`,
        });
      }
      pending = null;
    };
    for (const line of raw.split(/\r?\n/)) {
      const parsed = parseGatewayLogLine(line);
      if (parsed?.msg) {
        flush();
        pending = { at: parsed.at, msg: parsed.msg };
        continue;
      }
      const cont = stripAnsi(line).trim();
      if (pending && cont) {
        pending.msg += `\n${cont}`;
      }
    }
    flush();
  }
  const seen = new Set();
  const uniq = [];
  items.sort((a, b) => {
    const am = Date.parse(a.at);
    const bm = Date.parse(b.at);
    if (Number.isFinite(am) && Number.isFinite(bm) && am !== bm) return am - bm;
    return String(a.at).localeCompare(String(b.at));
  });
  for (const item of items) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    uniq.push(item);
  }
  const rich = uniq.filter((item) => String(item.detail || "").trim());
  const status = uniq.filter((item) => {
    if (String(item.detail || "").trim()) return false;
    const t = String(item.text || "");
    if (/^已装载 \d+ 个可用工具$/.test(t)) return false;
    if (/^本轮 Agent 运行已结束$/.test(t)) return false;
    return true;
  });
  const merged = [...rich.slice(-40), ...status.slice(-8)];
  merged.sort((a, b) => {
    const am = Date.parse(a.at);
    const bm = Date.parse(b.at);
    if (Number.isFinite(am) && Number.isFinite(bm) && am !== bm) return am - bm;
    return String(a.at).localeCompare(String(b.at));
  });
  const seen2 = new Set();
  const out = [];
  for (const item of merged) {
    if (seen2.has(item.key)) continue;
    seen2.add(item.key);
    out.push(item);
  }
  return out.slice(-48);
}

function isLoopback(req) {
  const ra = req.socket.remoteAddress || "";
  return ra === "127.0.0.1" || ra === "::1" || ra === "::ffff:127.0.0.1";
}

function openclawConfigPath() {
  return path.join(OPENCLAW, "openclaw.json");
}

function maskSecret(value) {
  const s = String(value || "");
  if (!s) return "";
  if (s.length <= 8) return "••••";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function loadOpenclawCfg() {
  const file = openclawConfigPath();
  if (!fs.existsSync(file)) {
    throw new Error(`找不到 ${file}，请先运行 .\\scripts\\setup.ps1`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function saveOpenclawCfg(cfg) {
  const file = openclawConfigPath();
  const bak = `${file}.bak-agentdesk`;
  try {
    fs.copyFileSync(file, bak);
  } catch {
    /* ignore */
  }
  fs.writeFileSync(file, JSON.stringify(cfg, null, 4) + "\n", "utf8");
}

function readModelsCatalog() {
  const cfg = loadOpenclawCfg();
  const primary = String(cfg?.agents?.defaults?.model?.primary || "");
  const fallbacks = Array.isArray(cfg?.agents?.defaults?.model?.fallbacks)
    ? cfg.agents.defaults.model.fallbacks.map(String)
    : [];
  const providersIn = cfg?.models?.providers && typeof cfg.models.providers === "object" ? cfg.models.providers : {};
  const providers = Object.entries(providersIn).map(([id, p]) => {
    const models = Array.isArray(p?.models) ? p.models : [];
    return {
      id,
      baseUrl: String(p?.baseUrl || ""),
      api: String(p?.api || "openai-completions"),
      timeoutSeconds: Number.isFinite(Number(p?.timeoutSeconds)) ? Number(p.timeoutSeconds) : null,
      apiKeySet: Boolean(p?.apiKey),
      apiKeyHint: maskSecret(p?.apiKey),
      models: models.map((m) => {
        const mid = String(m?.id || "");
        const input = Array.isArray(m?.input) ? m.input.map(String) : ["text"];
        return {
          id: mid,
          name: String(m?.name || mid),
          ref: `${id}/${mid}`,
          vision: input.includes("image"),
          reasoning: Boolean(m?.reasoning),
          contextWindow: Number(m?.contextWindow) || null,
        };
      }),
    };
  });
  return {
    configPath: openclawConfigPath(),
    controlUi: "http://127.0.0.1:18789",
    primary,
    fallbacks,
    providers,
  };
}

function writeModelsCatalog(patch) {
  const cfg = loadOpenclawCfg();
  if (!cfg.agents) cfg.agents = {};
  if (!cfg.agents.defaults) cfg.agents.defaults = {};
  if (!cfg.agents.defaults.model || typeof cfg.agents.defaults.model !== "object") {
    cfg.agents.defaults.model = {};
  }
  if (!cfg.models) cfg.models = { mode: "merge", providers: {} };
  if (!cfg.models.providers || typeof cfg.models.providers !== "object") cfg.models.providers = {};

  const provider = patch.provider;
  if (provider && typeof provider === "object") {
    const pid = String(provider.id || "")
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, "");
    const modelId = String(provider.modelId || "").trim();
    const baseUrl = String(provider.baseUrl || "").trim().replace(/\/chat\/completions\/?$/i, "").replace(/\/$/, "");
    if (!pid) throw new Error("提供商 id 不能为空（如 dashscope）");
    if (!modelId) throw new Error("模型 id 不能为空（如 qwen3.6-flash）");
    if (!baseUrl) throw new Error("Base URL 不能为空（不要带 /chat/completions）");
    const existing = cfg.models.providers[pid] && typeof cfg.models.providers[pid] === "object" ? cfg.models.providers[pid] : {};
    const models = Array.isArray(existing.models) ? existing.models.slice() : [];
    const idx = models.findIndex((m) => String(m?.id) === modelId);
    const vision = Boolean(provider.vision);
    const row = {
      id: modelId,
      name: String(provider.modelName || modelId),
      reasoning: provider.reasoning !== false,
      input: vision ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: Number(provider.contextWindow) || 1000000,
      maxTokens: Number(provider.maxTokens) || 32768,
    };
    if (idx >= 0) models[idx] = { ...models[idx], ...row };
    else models.push(row);
    const next = {
      ...existing,
      baseUrl,
      api: String(provider.api || existing.api || "openai-completions"),
      timeoutSeconds: Number(provider.timeoutSeconds) || Number(existing.timeoutSeconds) || 420,
      models,
    };
    const newKey = String(provider.apiKey || "").trim();
    if (newKey) next.apiKey = newKey;
    else if (!existing.apiKey) throw new Error("该提供商还没有 API Key，请填写");
    cfg.models.providers[pid] = next;
    if (!cfg.agents.defaults.models) cfg.agents.defaults.models = {};
    const ref = `${pid}/${modelId}`;
    cfg.agents.defaults.models[ref] = {
      ...(cfg.agents.defaults.models[ref] || {}),
      alias: String(provider.alias || modelId),
    };
    if (provider.setPrimary !== false) {
      cfg.agents.defaults.model.primary = ref;
    }
  }

  if (typeof patch.primary === "string" && patch.primary.trim()) {
    cfg.agents.defaults.model.primary = patch.primary.trim();
  }
  if (Array.isArray(patch.fallbacks)) {
    cfg.agents.defaults.model.fallbacks = patch.fallbacks.map(String).filter(Boolean);
  }
  saveOpenclawCfg(cfg);
  return readModelsCatalog();
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

    if ((req.method === "GET" || req.method === "POST") && p === "/api/models-config") {
      if (!isLoopback(req)) return send(res, 403, { error: "loopback only" });
      if (req.method === "GET") return send(res, 200, readModelsCatalog());
      const body = await readBody(req);
      if (!body || typeof body !== "object") return send(res, 400, { error: "JSON body required" });
      try {
        const catalog = writeModelsCatalog(body);
        audit("models.config.save", {
          primary: catalog.primary,
          provider: body?.provider?.id || null,
        });
        return send(res, 200, { ok: true, ...catalog });
      } catch (err) {
        return send(res, 400, { error: String(err.message || err) });
      }
    }

    if (req.method === "GET" && p === "/api/local-config") {
      // Loopback-only convenience for local UI; never expose remotely.
      if (!isLoopback(req)) return send(res, 403, { error: "loopback only" });
      let token = "";
      let primary = "openclaw/default";
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(OPENCLAW, "openclaw.json"), "utf8"));
        token = cfg?.gateway?.auth?.token || "";
        primary = cfg?.agents?.defaults?.model?.primary || primary;
      } catch {
        /* ignore */
      }
      return send(res, 200, {
        gatewayUrl: "http://127.0.0.1:18789",
        bridgeUrl: `http://127.0.0.1:${PORT}`,
        token,
        model: primary,
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

    if (req.method === "GET" && p === "/api/library/raw") {
      const rel = String(url.searchParams.get("path") || "");
      if (!rel.startsWith("outputs/") && !rel.startsWith("mine/")) {
        return send(res, 403, { error: "raw only under outputs/ or mine/" });
      }
      const abs = safeJoin(LIBRARY, rel);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        return send(res, 404, { error: "not found" });
      }
      const ext = path.extname(abs).toLowerCase();
      const types = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".svg": "image/svg+xml",
        ".pdf": "application/pdf",
        ".dxf": "application/dxf",
      };
      const st = fs.statSync(abs);
      res.writeHead(200, {
        "Content-Type": types[ext] || "application/octet-stream",
        "Content-Length": st.size,
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache",
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`,
      });
      fs.createReadStream(abs).pipe(res);
      return;
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
      const skillName = String(body?.skill || "").trim();
      if (skillName) {
        const contract = buildSkillContract(skillName);
        if (contract?.snippet) {
          lines.push("", contract.snippet);
        }
      }
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
      return send(res, 200, { imported: importAllWorkBuddy(), skills: syncWorkBuddySkills() });
    }

    if (req.method === "GET" && p === "/api/workbuddy/sessions") {
      return send(res, 200, { sessions: listSessionsFromWorkBuddy(Number(url.searchParams.get("limit") || 20)) });
    }

    if (req.method === "GET" && p === "/api/compat/skills") {
      return send(res, 200, listSkillsCompat());
    }

    if (req.method === "GET" && p === "/api/skills/contract") {
      const name = String(url.searchParams.get("name") || "").trim();
      const contract = buildSkillContract(name);
      if (!contract) return send(res, 404, { error: "skill not found", name });
      return send(res, 200, contract);
    }

    if (req.method === "POST" && p === "/api/skills/match") {
      const body = await readBody(req);
      const contract = matchWorkBuddySkill(body?.text, body?.skill);
      if (!contract) return send(res, 200, { matched: false });
      return send(res, 200, { matched: true, ...contract });
    }

    if (req.method === "POST" && p === "/api/skills/sync") {
      return send(res, 200, { skills: syncWorkBuddySkills() });
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
try {
  syncWorkBuddySkills();
} catch {
  /* WorkBuddy skills are optional */
}
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
