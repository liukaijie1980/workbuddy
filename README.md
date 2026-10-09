# AgentDesk

本地私有化的 AI 工作台（AgentDesk）：以 **OpenClaw** 为运行时，自研 Web UI。

> **可完全独立运行，不依赖腾讯 WorkBuddy。**  
> WorkBuddy 仅作为可选兼容源：若本机已安装，可一键导入其 Skill / 工作区；未安装不影响聊天、资料库、定时任务。

> 本项目不是腾讯 WorkBuddy 的复制品。UI、品牌与交互均为独立设计；兼容目标是开放资产格式（Agent Skills / OpenClaw）。

## 架构

```
浏览器 (AgentDesk Web)
        │
        ▼
Bridge (:3090) ── 资料库 / 定时 / 审计（自有数据）
        │
OpenClaw Gateway (:18789)
        │
        ├─ workspace/skills（仓库自带 + 用户 Skill）
        ├─ 可选：~/.workbuddy/skills（仅当目录存在）
        └─ 模型 Provider（如移动云 GLM）
```

## 依赖关系

| 组件 | 是否必须 |
|------|----------|
| Node 24+ / 仓库 `.tools` 便携 Node | 必须 |
| OpenClaw | 必须（运行时） |
| 模型 API Key | 必须（对话） |
| 腾讯 WorkBuddy 安装 | **不需要**（可选导入） |

## 快速开始

### 前置

- Windows 10/11 或 Linux
- Node `>=24.16.0 <25` 或 `>=26.1.0`（OpenClaw 硬性要求；`node -v` 自检）
- OpenClaw（`setup` 脚本会检查 / 安装）
- 至少一个模型 API Key（或本地 Ollama）

### 一键配置

```powershell
# Windows
.\scripts\setup.ps1

# Linux
chmod +x scripts/*.sh
./scripts/setup.sh
```

### 启动（Gateway + Bridge + Web）

```powershell
# Windows
.\scripts\start.ps1

# Linux
./scripts/start.sh
```

- Gateway：`http://127.0.0.1:18789`（仅本机）
- Bridge：`http://127.0.0.1:3090`（仅本机；资料库 / 定时 / 审计）
- AgentDesk UI：`http://0.0.0.0:3080`（本机与局域网）
  - 本机：`http://127.0.0.1:3080`
  - 其他机器：`http://<本机局域网IP>:3080`（设置里 Gateway/Bridge 建议留空，走同源代理）

### 兼容性测试

```powershell
.\scripts\test-compat.ps1
```

## 阶段能力

| 阶段 | 内容 |
|------|------|
| P0 | OpenClaw 运行时、Skill 挂载、Chat Completions、Web 壳 |
| P1 | 本地资料库、WorkBuddy 工作区导入、「添加到任务」、产物回写目录 |
| P2 | 任务流 UI、定时任务、审计日志、WB 会话只读对照 |

## 兼容说明

| 资产 | 来源 | 策略 |
|------|------|------|
| 用户 Skill（`SKILL.md` 包） | `~/.workbuddy/skills` | `skills.load.extraDirs` + workspace 同步 |
| 市场/插件 Skill | WorkBuddy plugins 缓存 | 只读挂载可选；依赖腾讯 MCP 的不可用 |
| 资料库 | 本地目录树 | workspace / `library` 映射 |
| 腾讯内置能力（文档/支付等） | 云端 MCP | 私有壳不复现 |

详见 [docs/compatibility.md](docs/compatibility.md)。

## 开发

```powershell
cd apps/web
npm install
npm run dev
```

开发态 UI 默认走同源代理（`/v1` → Gateway、`/api` → Bridge）。Gateway 需已启动。

### 局域网访问

启动后其他机器打开 `http://<主机IP>:3080`。不要把 Gateway `:18789` 或 Bridge `:3090` 暴露到公网；模型 Key 写入仍限制本机 loopback。若 Windows 防火墙拦截，启动脚本会尝试放行 Private/Domain 入站 TCP 3080（需管理员权限）。Linux 需自行放行入站 TCP 3080（如 `ufw allow 3080/tcp`）。

### Linux：`git pull` 后源码部署

```bash
git pull
chmod +x scripts/*.sh
node -v                     # 须满足 >=24.16 <25 或 >=26.1
./scripts/setup.sh          # 首次或依赖/模板变更时
# 编辑 ~/.openclaw/openclaw.json，配置模型 provider 与 API Key
./scripts/start.sh          # 前台启动；Ctrl+C 会停掉 Gateway/Bridge/Web
```

若 `setup.sh` 报 Node 版本不够（常见于 Hermes 自带 Node 22）：

```bash
# 推荐 nvm 安装 Node 24
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.nvm/nvm.sh
nvm install 24
nvm use 24
hash -r
node -v && which node       # 确认不再是 ~/.hermes/node/bin/node
./scripts/setup.sh
```

仅代码更新、配置已就绪时：

```bash
git pull
cd apps/web && npm install && npm run build && cd ../..
./scripts/start.sh
```

## 许可证

本仓库自研代码采用 MIT。OpenClaw 及其依赖遵循各自上游许可证。请勿使用腾讯 WorkBuddy 的商标、图标与闭源资源。
