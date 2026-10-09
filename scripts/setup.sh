#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$REPO_ROOT/config/openclaw.template.json"
OPENCLAW_DIR="${HOME}/.openclaw"
CONFIG_PATH="$OPENCLAW_DIR/openclaw.json"
WORKSPACE_SKILLS="$OPENCLAW_DIR/workspace/skills"
ENV_FILE="$REPO_ROOT/.env.local"
REPO_SKILLS="$REPO_ROOT/skills"
WB_SKILLS="${HOME}/.workbuddy/skills"

echo "==> AgentDesk setup (Linux)"

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

need_cmd node
need_cmd npm
need_cmd python3

# OpenClaw requires: Node >=24.16.0 <25 || >=26.1.0
node_ok="$(node -e '
const [maj, min] = process.versions.node.split(".").map(Number);
const ok = (maj === 24 && min >= 16) || maj >= 26;
process.stdout.write(ok ? "1" : "0");
')"
if [[ "$node_ok" != "1" ]]; then
  echo "OpenClaw needs Node >=24.16.0 (<25) or >=26.1.0; found $(node -v) at $(command -v node)" >&2
  echo "" >&2
  echo "Upgrade Node, then re-run ./scripts/setup.sh. Examples:" >&2
  echo "  # nvm" >&2
  echo "  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash" >&2
  echo "  source ~/.nvm/nvm.sh && nvm install 24 && nvm use 24" >&2
  echo "" >&2
  echo "  # NodeSource (Debian/Ubuntu)" >&2
  echo "  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -" >&2
  echo "  sudo apt-get install -y nodejs" >&2
  echo "" >&2
  echo "  # fnm" >&2
  echo "  curl -fsSL https://fnm.vercel.app/install | bash" >&2
  echo "  fnm install 24 && fnm use 24" >&2
  echo "" >&2
  echo "If PATH still points at Hermes/old Node, put the new node first:" >&2
  echo "  export PATH=\"\$HOME/.nvm/versions/node/\$(ls \$HOME/.nvm/versions/node | tail -1)/bin:\$PATH\"" >&2
  echo "  hash -r && node -v && which node" >&2
  exit 1
fi
echo "Node: $(node -v) ($(command -v node))"

if ! command -v openclaw >/dev/null 2>&1; then
  echo "OpenClaw CLI not found. Installing globally..."
  npm install -g openclaw@latest
fi
echo "OpenClaw: $(command -v openclaw)"

mkdir -p "$OPENCLAW_DIR" "$WORKSPACE_SKILLS" \
  "$OPENCLAW_DIR/workspace/library/mine" \
  "$OPENCLAW_DIR/workspace/library/imports" \
  "$OPENCLAW_DIR/workspace/library/outputs" \
  "$OPENCLAW_DIR/workspace/library/workbuddy"

TOKEN="$(openssl rand -hex 32 2>/dev/null || python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
)"
if [[ -f "$CONFIG_PATH" ]]; then
  EXISTING="$(python3 - <<PY
import json
try:
  cfg=json.load(open("$CONFIG_PATH", encoding="utf-8"))
  print(cfg.get("gateway",{}).get("auth",{}).get("token") or "")
except Exception:
  print("")
PY
)"
  if [[ -n "$EXISTING" ]]; then
    TOKEN="$EXISTING"
    echo "Keeping existing gateway token"
  fi
fi

python3 - <<PY
import json
from pathlib import Path
template = json.loads(Path(r"$TEMPLATE").read_text(encoding="utf-8"))
template["gateway"]["auth"]["token"] = "$TOKEN"
extra = []
repo_skills = Path(r"$REPO_SKILLS")
if repo_skills.is_dir():
    extra.append(str(repo_skills.resolve()).replace("\\\\", "/"))
wb = Path(r"$WB_SKILLS")
if wb.is_dir():
    extra.append("~/.workbuddy/skills")
    print("Optional: detected WorkBuddy skills at", wb)
else:
    print("Standalone mode: WorkBuddy not required / not found")
template.setdefault("skills", {}).setdefault("load", {})["extraDirs"] = extra
Path(r"$CONFIG_PATH").write_text(json.dumps(template, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print("Wrote", r"$CONFIG_PATH")
PY

if [[ -d "$REPO_SKILLS" ]]; then
  for d in "$REPO_SKILLS"/*/; do
    [[ -d "$d" ]] || continue
    name="$(basename "$d")"
    rm -rf "$WORKSPACE_SKILLS/$name"
    cp -a "$d" "$WORKSPACE_SKILLS/$name"
    echo "Synced repo skill $name -> $WORKSPACE_SKILLS/$name"
  done
fi

if [[ -d "$WB_SKILLS/image-to-cad-dxf" && ! -d "$WORKSPACE_SKILLS/image-to-cad-dxf" ]]; then
  cp -a "$WB_SKILLS/image-to-cad-dxf" "$WORKSPACE_SKILLS/image-to-cad-dxf"
  echo "Optional import: image-to-cad-dxf from WorkBuddy"
fi

AGENTS_MD="$OPENCLAW_DIR/workspace/AGENTS.md"
LIB_HINT='

## AgentDesk Library

AgentDesk runs standalone (OpenClaw + local Web). WorkBuddy is optional.

- library/mine — personal docs
- library/imports — optional imported external workspaces (including WorkBuddy)
- library/workbuddy — optional WorkBuddy links (compat)
- library/outputs — write task artifacts here
'
if [[ -f "$AGENTS_MD" ]]; then
  if ! grep -q "AgentDesk Library" "$AGENTS_MD"; then
    printf '%s\n' "$LIB_HINT" >> "$AGENTS_MD"
  fi
else
  printf '# AGENTS.md\n%s\n' "$LIB_HINT" > "$AGENTS_MD"
fi

cat > "$ENV_FILE" <<EOF
AGENTDESK_GATEWAY_URL=http://127.0.0.1:18789
AGENTDESK_GATEWAY_TOKEN=$TOKEN
AGENTDESK_BRIDGE_URL=http://127.0.0.1:3090
EOF
echo "Wrote $ENV_FILE"

(
  cd "$REPO_ROOT/apps/web"
  if [[ ! -d node_modules ]]; then
    npm install
  fi
  npm run build
)

echo
echo "Next steps:"
echo "  1. Configure model providers in ~/.openclaw/openclaw.json (or Control UI)"
echo "  2. Start:           ./scripts/start.sh"
echo "  3. Open http://127.0.0.1:3080 (or http://<LAN-IP>:3080) and paste token:"
echo "     $TOKEN"
