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
const WB_DB = path.join(HOME, ".workbuddy", "workbuddy.db");
const WB_SKILLS = path.join(HOME, ".workbuddy", "skills");
const WB_ROOT = path.join(HOME, "WorkBuddy");

function ensureDirs() {
  for (const d of [LIBRARY, LIB_MINE, LIB_WB, LIB_OUT, STATE_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
  if (!fs.existsSync(CRON_FILE)) fs.writeFileSync(CRON_FILE, "[]\n");
  if (!fs.existsSync(TASKS_FILE)) fs.writeFileSync(TASKS_FILE, "[]\n");
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
    `# AgentDesk 资料库 · 我的文档\n\n这里对应 WorkBuddy「我的文档」语义。\n\n- \`mine/\`：个人资料\n- \`workbuddy/\`：从本机 WorkBuddy 工作区导入/链接\n- \`outputs/\`：任务产物回写\n`,
    "utf8",
  );
}
importAllWorkBuddy();
startCronLoop();

const server = http.createServer((req, res) => {
  handle(req, res);
});
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[agentdesk-bridge] http://127.0.0.1:${PORT}`);
  console.log(`[agentdesk-bridge] library=${LIBRARY}`);
  audit("bridge.start", { port: PORT });
});
