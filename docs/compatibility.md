# 兼容性说明

AgentDesk 以 OpenClaw 为运行时，目标是复用在 WorkBuddy 上调通的开放数字资产。

## Skill（P0）

WorkBuddy 用户 Skill 遵循 [Agent Skills](https://agentskills.io/specification) / OpenClaw 规范。

本机样例：`%USERPROFILE%\.workbuddy\skills\image-to-cad-dxf\`

加载：

1. `~/.openclaw/workspace/skills`（setup 同步）
2. `skills.load.extraDirs` → `~/.workbuddy/skills`

Bridge `GET /api/compat/skills` 对比两边用户 Skill 名称与哈希。

依赖腾讯云 MCP 的内置 Skill（微信支付、腾讯文档等）**不可完整复现**。

## 资料库（P1）

WorkBuddy 无公开跨产品资料库导出标准。本机实际资料落在：

- 工作区目录：`%USERPROFILE%\WorkBuddy\<timestamp>\`（`workbuddy.db.workspaces`）
- 会话元数据：`~/.workbuddy/workbuddy.db`（sessions）

AgentDesk 映射：

| 语义 | 路径 |
|------|------|
| 我的文档 | `~/.openclaw/workspace/library/mine` |
| WorkBuddy 工作区 | `library/workbuddy/*`（junction 链接） |
| 产物回写 | `library/outputs` |

操作：

- `POST /api/workbuddy/import` — 导入/链接全部 WB 工作区，并同步 `~/.workbuddy/skills` 到工作区
- `GET /api/skills/contract?name=` — 生成与 WorkBuddy 对齐的执行合同（技能原文、模板路径、指定 Python）
- `POST /api/skills/match` — 按技能名或 SKILL.md 里的触发语句，把同一份执行合同自动写进即将发送的消息
- `POST /api/library/attach` — 生成「添加到任务」提示块；可带 `skill` 把合同一并写入
- UI：Skills 里点「写入任务草稿」会把合同写入草稿；发送时若消息命中技能名或触发语句，也会自动套上同一份合同

执行合同时，模型必须从技能 `assets/` 模板改参数，不能从零重写依赖库 API。这样同一技能、同一资料才和 WorkBuddy 走同一条路径。

依赖腾讯云 MCP 的内置 Skill（微信支付、腾讯文档等）**不可完整复现**。

## 任务流 / 定时 / 审计（P2）

- 任务：`POST /api/tasks` + 会话 `conversationId`
- 定时：Bridge 内置 cron（`everyMs`），产物写入 `library/outputs`
- 审计：`~/.openclaw/agentdesk/audit.jsonl`
- WB 会话只读镜像：`GET /api/workbuddy/sessions`

## MCP

OpenClaw 原生 MCP；腾讯官方云端连接器不保证互通。

## 明确不兼容

- WorkBuddy 品牌 / 闭源 UI
- 企微 / QQ 遥控通道
- Credits 计费
- 腾讯文档 / 微信支付等云端专有 Skill

## 回归命令

```powershell
.\scripts\test-compat.ps1
```
