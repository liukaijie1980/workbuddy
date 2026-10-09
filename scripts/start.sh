#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.local"
WEB_DIR="$REPO_ROOT/apps/web"
BRIDGE_JS="$REPO_ROOT/apps/bridge/src/server.mjs"
TOOLS_DIR="$REPO_ROOT/.tools"
mkdir -p "$TOOLS_DIR"

GW_OUT="$TOOLS_DIR/gateway.out.log"
GW_ERR="$TOOLS_DIR/gateway.err.log"
BRIDGE_OUT="$TOOLS_DIR/bridge.out.log"
BRIDGE_ERR="$TOOLS_DIR/bridge.err.log"

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a
  # Only KEY=VALUE lines; ignore comments/blank
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      export "${BASH_REMATCH[1]}=${BASH_REMATCH[2]}"
    fi
  done < "$ENV_FILE"
  set +a
fi

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

need_cmd node
need_cmd npm
need_cmd openclaw

stop_port() {
  local port="$1"
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${port}/tcp" >/dev/null 2>&1 || true
  elif command -v lsof >/dev/null 2>&1; then
    local pids
    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "${pids}" ]]; then
      # shellcheck disable=SC2086
      kill -9 $pids >/dev/null 2>&1 || true
    fi
  fi
  sleep 1
}

wait_port() {
  local port="$1"
  local seconds="${2:-90}"
  local i
  for ((i = 0; i < seconds; i += 2)); do
    if command -v ss >/dev/null 2>&1; then
      ss -ltn "sport = :$port" 2>/dev/null | grep -q LISTEN && return 0
    elif command -v lsof >/dev/null 2>&1; then
      lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && return 0
    else
      (echo >/dev/tcp/127.0.0.1/"$port") >/dev/null 2>&1 && return 0
    fi
    sleep 2
  done
  return 1
}

lan_ips() {
  if command -v hostname >/dev/null 2>&1; then
    hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | grep -v '^127\.' || true
  fi
}

if [[ ! -f "$WEB_DIR/dist/index.html" ]]; then
  echo "Web not built yet; running setup..."
  "$REPO_ROOT/scripts/setup.sh"
fi

stop_port 18789
stop_port 3090

echo "==> Starting OpenClaw Gateway"
: >"$GW_OUT"
: >"$GW_ERR"
nohup openclaw gateway run >"$GW_OUT" 2>"$GW_ERR" &
GW_PID=$!

if ! wait_port 18789 90; then
  echo "Gateway failed to listen on 18789" >&2
  tail -n 40 "$GW_ERR" "$GW_OUT" 2>/dev/null || true
  kill "$GW_PID" >/dev/null 2>&1 || true
  exit 1
fi
echo "Gateway listening on 127.0.0.1:18789 (pid $GW_PID)"

echo "==> Starting AgentDesk Bridge"
: >"$BRIDGE_OUT"
: >"$BRIDGE_ERR"
nohup node "$BRIDGE_JS" >"$BRIDGE_OUT" 2>"$BRIDGE_ERR" &
BRIDGE_PID=$!

if ! wait_port 3090 30; then
  echo "Bridge failed to listen on 3090" >&2
  tail -n 40 "$BRIDGE_ERR" 2>/dev/null || true
  kill "$GW_PID" "$BRIDGE_PID" >/dev/null 2>&1 || true
  exit 1
fi
echo "Bridge listening on 127.0.0.1:3090 (pid $BRIDGE_PID)"

echo "==> Starting AgentDesk Web (LAN-reachable on :3080)"
if [[ -n "${AGENTDESK_GATEWAY_TOKEN:-}" ]]; then
  echo "Gateway Token: $AGENTDESK_GATEWAY_TOKEN"
fi
echo "本机:     http://127.0.0.1:3080"
mapfile -t IPS < <(lan_ips)
if [[ ${#IPS[@]} -eq 0 ]]; then
  echo "局域网:   (未检测到 IPv4；其他机器可用本机 IP:3080 访问)"
else
  for ip in "${IPS[@]}"; do
    echo "局域网:   http://${ip}:3080"
  done
fi
echo "说明: Gateway/Bridge 仍只监听本机；其他机器只访问 :3080，由 Web 代理转发。"

cleanup() {
  kill "$GW_PID" "$BRIDGE_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

echo "==> Building Web (so latest UI changes are served)"
(
  cd "$WEB_DIR"
  npm run build
)
stop_port 3080
(
  cd "$WEB_DIR"
  npm run preview
)
