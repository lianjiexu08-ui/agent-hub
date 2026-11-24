# Agent Hub

AI 驱动的多智能体研发协作平台。人只负责**提出和确认需求**、**验收最终成果**，中间的理解、计划、编码、测试、评审、合并都由智能体完成。

- **以项目为工作空间**：一个项目绑定一个 GitHub 仓库（Token 认证），工作项与 Issue 双向同步
- **固定的交付生命周期**：需求理解 → 计划 → 执行 → 测试 → 评审
  - 测试不通过回到「执行」修复，同一轮最多修 3 次
  - 评审不通过把教训沉淀为项目知识，重新理解需求开始新一轮，最多 3 轮
  - 需求不够具体（质量评分 < 60）时暂停，向人提问，确认后继续
- **管家**（首页）：多轮对话讨论需求、拆分任务、调整优先级、汇总进展
- **项目负责人**：每个项目一个，可设为 关闭 / 按需 / 持续迭代；负责分诊、流转、审核、合并策略，持续迭代模式下会主动提出改进项
- **任务中心**：所有项目共用同一批智能体，按五个阶段排队展示，完成后离开队列进入「待审核」
- **测试板块**：基于 [DevEye](#浏览器验收deveye) 的浏览器验收 + 单元测试 / 检查 / 健康检查；排队执行，不冲突的用例并行
- **Hotfix**：创建即进入执行，跳过需求门禁，测试通过后由 AI 验收并合并
- **自动化**：哨兵巡检（阶段超时、心跳、卡住自动重启 / 改派 / 上报）+ cron 定时任务
- **运行底座**：内置（Claude API 工具循环）、Claude Code CLI、Codex CLI、Gemini CLI、pi
- **治理**：每日 / 单工作项预算熔断，受保护路径不自动合并，密钥只存在服务端，通知渠道（站内、飞书、企业微信、Slack、Webhook）

## 快速开始

需要 Node.js 24+（直接运行 TypeScript，无需构建）。

```bash
npm install

# 演示模式：模型回复由脚本生成，其余全部是真实的服务端逻辑，不需要 API Key
npm run demo            # 打开 http://127.0.0.1:18790
npm run demo:lan        # 同上，但监听 0.0.0.0，便于从内网访问（未设置 HUB_TOKEN 时仅供演示）

# 正式运行
npm start               # 在「设置 → 模型服务」里填 Anthropic API Key，在「集成」里填 GitHub Token
```

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `18790` | HTTP 端口 |
| `HOST` | `127.0.0.1` | 监听地址；部署到服务器时改为 `0.0.0.0` 并务必设置 `HUB_TOKEN` |
| `HUB_TOKEN` | 无 | 访问令牌。设置后所有 API 需 `Authorization: Bearer <token>`（网页右下角「令牌」处填写） |
| `HUB_DATA` | `./data` | 数据目录：SQLite 数据库、仓库工作区 |
| `HUB_DB` | `$HUB_DATA/agent-hub.db` | 数据库路径 |
| `HUB_SIMULATE` | 无 | 设为 `1` 进入演示模式（脚本化模型 + 模拟 GitHub） |
| `HUB_SEED` | `./agents.seed.json` | 首次启动时导入的智能体 |
| `HUB_MAX_CONCURRENCY` | `4` | 同时运行的智能体任务数 |
| `HUB_MAX_DEPTH` / `HUB_MAX_HOPS` | `4` / `3` | 委派深度、消息总线跳数上限 |

模型 API Key 与 GitHub Token 在网页「设置」中填写，保存在服务端数据库，接口只返回掩码。

## 部署到服务器

```bash
HOST=0.0.0.0 HUB_TOKEN=$(openssl rand -hex 24) HUB_DATA=/var/lib/agent-hub npm start
```

- 在前面放一层 HTTPS 反向代理（Caddy / Nginx），SSE 接口 `/events` 需关闭缓冲
- 智能体会在服务器上 clone 仓库、修改代码、执行命令：请用独立的低权限用户运行，GitHub Token 只授予目标仓库的权限
- 使用 CLI 底座时，需要在服务器上安装并登录对应 CLI（`claude`、`codex`、`gemini`、`pi`），「设置 → 运行底座」会自动检测

## 架构

```
public/index.html      单页前端（无构建），通过 /api/state 拉快照、/api/rpc 修改、/events SSE 刷新
src/index.ts           启动与组装
src/server.ts          HTTP 路由、鉴权、SSE、供 CLI 智能体回调的 /internal 接口
src/api.ts             状态快照与 RPC 白名单
src/runtime.ts         智能体运行时：工具循环、委派、消息总线、取消、心跳、费用
src/work.ts            项目 / 工作项 / 生命周期 / PR / 负责人 / 哨兵动作
src/qa.ts              测试板块：用例生成、队列与冲突调度、DevEye 浏览器验收
src/automation.ts      哨兵与 cron 定时任务
src/assistant.ts       管家对话与「用 AI 创建智能体」
src/cli.ts, mcp-task.ts  CLI 底座：启动外部 CLI，并通过 MCP 桥把 Hub 工具暴露给它
src/github.ts, workspace.ts  GitHub REST 客户端；git worktree 工作区（每个工作项一个分支）
src/settings.ts        模型、密钥、预算、护栏、通知、技能、项目知识
src/mcp.ts             把 Hub 作为 MCP 服务提供给 Claude Code 等客户端
```

数据存在 SQLite（`node:sqlite`，WAL 模式）。

### 优先级

工作项优先级为 0 无 · 1 紧急 · 2 高 · 3 中 · 4 低。调度统一按 **紧急 → 高 → 中 → 低 → 无**：
运行槽位、测试队列、项目负责人分诊与失败重试、任务中心与测试板块的展示顺序都遵循这一规则。

### 生命周期是怎么驱动的

执行工作项的智能体有一个 `report_phase` 工具。每完成一个阶段就调用它汇报，服务端据此推进状态：

- 汇报「需求理解」时做质量评分，不足则阻塞在工具调用上，等人确认需求后返回
- 汇报「执行」完成后自动提交 PR，并把验收任务放进测试队列，工具调用等待验收结果后告诉智能体下一步
- 智能体提前结束对话时，运行时会提醒它继续，直到走完评审

### 浏览器验收（DevEye）

服务器上安装了 DevEye 的 `deveye` 命令（浏览器自动化 CLI）时，测试智能体通过受限的 `browser` 工具（只允许 navigate / snapshot / click / type / wait / console 等子命令）打开页面、定位元素并逐条汇报用例结果。未安装时只运行非浏览器用例。

## 作为 MCP 服务使用

```bash
claude mcp add agent-hub -e HUB_URL=http://127.0.0.1:18790 -e HUB_TOKEN=<token> -- node /path/to/agent-hub/src/mcp.ts
```

提供 `hub_*` 工具：列出智能体、提交任务、查询结果等。

## 开发

```bash
npm test          # 运行时与工作项生命周期的集成测试（脚本化模型，不访问网络）
npm run typecheck
```

## 许可

MIT
