import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env.local");

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!process.env[name]) process.env[name] = value;
  }
}

loadEnvFile(envFile);

const query = process.argv.slice(2).join(" ").trim();
if (!query) {
  console.error("usage: node scripts/bocha-search.mjs <query>");
  process.exit(2);
}

const key = process.env.BOCHA_API_KEY || "";
const base = (process.env.BOCHA_API_URL || "https://api.bochaai.com/v1").replace(/\/$/, "");
if (!key) {
  console.error("BOCHA_API_KEY is missing");
  process.exit(1);
}

const res = await fetch(`${base}/web-search`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    query,
    count: 8,
    summary: true,
    freshness: "noLimit",
  }),
});

const raw = await res.text();
if (!res.ok) {
  console.error(`bocha ${res.status}: ${raw.slice(0, 400)}`);
  process.exit(1);
}

let json;
try {
  json = JSON.parse(raw);
} catch {
  console.log(raw.slice(0, 4000));
  process.exit(0);
}

const pages = json?.data?.webPages?.value || json?.webPages?.value || [];
if (!pages.length) {
  console.log(JSON.stringify(json, null, 2).slice(0, 4000));
  process.exit(0);
}

for (const item of pages) {
  const title = item.name || item.title || "(no title)";
  const url = item.url || "";
  const snippet = (item.summary || item.snippet || "").replace(/\s+/g, " ").trim();
  console.log(`- ${title}`);
  if (url) console.log(`  ${url}`);
  if (snippet) console.log(`  ${snippet.slice(0, 400)}`);
}
