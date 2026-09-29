# AgentDesk

本地私有化的 WorkBuddy 兼容壳：以 **OpenClaw** 为 Agent 运行时，自研 Web UI，优先保证 Skill / MCP / 资料目录资产可复用。

> 本项目**不是**腾讯 WorkBuddy 的复制品。UI、品牌与交互均为独立设计；兼容目标是开放资产格式（Agent Skills / OpenClaw）。

## 架构

```
浏览器 (AgentDesk Web)
        │  HTTP /v1/chat/completions  + 静态页
        ▼
OpenClaw Gateway (:18789)
        │
        ├─ skills.load.extraDirs → ~/.workbuddy/skills
        ├─ workspace → ~/.openclaw/workspace（可挂载资料库目录）
        └─ 模型 Provider（OpenAI 兼容 / 本地 Ollama 等）
```

## 快速开始

### 前置

- Windows 10/11
- 已安装 OpenClaw（`scripts/setup.ps1` 会检查；仓库亦可使用 `.tools` 便携 Node）
- 至少一个模型 API Key（或本地 Ollama）

### 一键配置

```powershell
.\scripts\setup.ps1
```

### 启动（Gateway + Bridge + Web）

```powershell
.\scripts\start.ps1
```

- Gateway：`http://127.0.0.1:18789`
- Bridge：`http://127.0.0.1:3090`（资料库 / 定时 / 审计）
- AgentDesk UI：`http://127.0.0.1:3080`

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

开发态 UI 默认连接 `http://127.0.0.1:18789`（需 Gateway 已启动）。

## 许可证

本仓库自研代码采用 MIT。OpenClaw 及其依赖遵循各自上游许可证。请勿使用腾讯 WorkBuddy 的商标、图标与闭源资源。
