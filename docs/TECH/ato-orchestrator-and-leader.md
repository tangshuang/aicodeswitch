# ATO 编排系统 + 主 Agent（Leader）实现技术文档

> 本文记录 AICodeSwitch 中「Agent Team Orchestrator (ATO)」与「主 Agent（Leader）对话子系统」的完整实现：架构、原理、技术细节、数据流、关键决策与调试指南。配套 PRD 见 `docs/PRD/supervisor-agent/supervisor-agent-v4.md`。
>
> 适用读者：维护本模块、调试行为、或在真实环境验证 CLI 契约的工程师。

---

## 0. 全景：我们在做什么

AICodeSwitch 是一个本地 AI 网关（代理 + 路由 + 配置生命周期管理）。在此之上，我们构建了两层能力：

1. **ATO 编排层**：一个 Ralph Loop 多 Agent 编排器。用户/主 Agent 下达一个复杂任务，系统把它拆成子任务 DAG，依次 spawn 真实的 `claude` / `codex` CLI 子进程去执行，每个子任务用**外部验证脚本**裁定成败（验证即出口），失败重试/换策略。
2. **主 Agent（Leader）对话层**：用户只面对一个聊天窗口，对话的另一端是一个 Claude Code（或 Codex）进程——即 Leader。Leader 通过一组内置 MCP 工具自主管理 ATO 团队/任务/路由/记忆，并对外用自然语言回复。Leader 还能**感知并裁决**子进程的权限请求。

核心设计哲学（来自 v4 PRD）：**编排即调度（不执行推理）、Agent 即进程、验证即出口、无状态运行 + 持久化环境、通信即日志**。

---

## 1. 系统架构

### 1.1 进程拓扑

```
┌──────────────────────────────────────────────────────────────┐
│              AICodeSwitch 主进程（常驻 Node/Express）          │
│  ┌────────────────────┐  ┌────────────────────────────────┐  │
│  │ 代理网关            │  │ 管理面 API（/api/*）            │  │
│  │ /claude-code/*      │  │  ├ /api/orchestrator/*（ATO）  │  │
│  │ /codex/*  /v1/*     │  │  └ /api/orchestrator/leader/*  │  │
│  │ 路由/规则/转换/统计  │  │      （Leader + 权限）          │  │
│  └────────────────────┘  └────────────────────────────────┘  │
│  │ OrchestratorManager        │ LeaderManager                 │
│  │  └ TeamScheduler            │  └ PermissionJudge           │
│  └────────────────────────────┘ └─────────────────────────────│
└───────────────┬──────────────────────────────┬───────────────┘
                │ child_process.spawn           │ 流量经代理
                ▼                                ▼
        ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
        │ Leader 进程   │  │ 子 Agent 进程│  │ ato-leader   │
        │ claude/codex  │  │ claude/codex │  │ MCP 子进程   │
        │ (cwd=workspace)│ │ (cwd=team ws)│  │ (stdio RPC)  │
        └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
               │ --permission-prompt-tool 时调用 MCP 工具
               └──────────────►（经 HTTP 回打本机 /api/orchestrator/leader/permission）
```

**关键点**：
- Leader 与子 Agent 都是**真实 CLI 进程**，AICodeSwitch 只负责 spawn + 流式转发，**不执行 AI 推理**。
- 子 Agent 的 API 请求**天然走代理**（AICodeSwitch 启动时已把 `ANTHROPIC_BASE_URL` / Codex `base_url` 写进本地配置），因此自动获得路由、Token 统计、会话追踪、配额控制——编排层零额外配置。
- ato-leader MCP server 是一个**独立 stdio 子进程**，由 claude/codex 经 `~/.claude.json` 的 `mcpServers['ato-leader']` 自动 spawn，经 HTTP 回打本机 API 实现跨进程解耦（无需共享内存）。

### 1.2 模块划分

| 层 | 目录 | 职责 |
|----|------|------|
| ATO 编排 | `src/server/orchestrator/` | 团队/任务/DAG/Ralph Loop/验证/适配器 |
| Leader 子系统 | `src/server/orchestrator/leader/` | 对话/记忆/流式 runner/MCP server/权限裁决 |
| 网关归因 | `src/server/proxy-server.ts` | `x-ato-task-id` header → 日志 tag |
| 配置生命周期 | `src/server/main.ts` | ato-leader MCP 注册、软锁、shutdown 清理 |
| 前端 | `src/ui/pages/HomePage.tsx` | Codex 风格聊天窗 + 权限待裁决面板 |
| 类型 | `src/types/index.ts` | ATO / Leader / 权限共享类型 |

---

## 2. ATO 编排模块（`orchestrator/`）

### 2.1 核心抽象

- **Task**：子任务（id / description / dependencies / expectedOutput / verificationScript / agentTool / routeId）。
- **TeamRun**：一次团队任务运行，含 tasks 表、results 表、logs、pendingQuestions、decisions、tokenBudget。
- **AgentAdapter（IAgentAdapter）**：封装 CLI 工具差异（启动参数、上下文格式、输出解析、健康检查）。
- **TeamScheduler**：单团队的 Ralph Loop 调度器。

文件：`types.ts`、`adapters.ts`、`scheduler.ts`、`manager.ts`、`routes.ts`、`index.ts`。

### 2.2 Ralph Loop（`scheduler.ts`）

主循环（伪代码）：

```
while not stopped:
  ready = selectNextTask()              # 拓扑序选「依赖已满足 + pending」的任务
  if not ready:
    if allTerminal: mark done; break
    else: return                        # 让出（等问答/运行中）
  if tokenBudget 耗尽: fail; break
  exitState = runOneTask(ready)
  if exitState == 'awaiting-question':  # 退出时留下未决 «ATO_QUESTION»
    status = 'awaiting-question'; return
  if exitState == 'stopped': break
```

**runOneTask 流程**：
1. 生成上下文文件 `.team/tasks/<id>/context.md`（含历史决策、依赖产出、验证脚本、问答协议说明）。
2. `adapter.spawn(...)` 启动全新 CLI 进程（无状态），注入 env（团队预算 AccessKey、`ATO_TASK_ID`）。
3. 收集 stdout。
4. **问答分支**：若 stdout 含 `«ATO_QUESTION»{...}«/ATO_QUESTION»` 标记块 → 上抛问题（pendingQuestions），任务转 `awaiting-question`，跳过验证，等待答案后重 spawn。
5. **正常分支**：`runVerification(script)` 执行验证脚本——exit 0 = 完成（可选原子 commit），非 0 = 重试/失败策略。
6. 失败策略：`abort`（停所有）/ `skip`（跳下游）/ `replan`（远期）。

**为什么 spawn 后才验证、不信任 Agent 自报**：LLM 会自信地给错误答案。外部验证脚本（测试/编译/grep 断言）是唯一可靠判据。这是 "Verification-Gated Exit"。

**为什么每次全新进程**：避免长驻进程累积上下文导致漂移（hallucination）。状态全持久化在磁盘（spec/state/context），每次从磁盘读取最新状态重建上下文——"Stateless Runs, Persistent Environment"。

### 2.3 适配器（`adapters.ts`）

```ts
ClaudeCodeAdapter.spawn:  claude --print --output-format stream-json   # stdin 喂 context.md
CodexAdapter.spawn:       codex exec                                    # stdin 喂 context.md，纯文本输出
```

- 两者共用 `«ATO_QUESTION»` 标记解析（`parseQuestionBlocks`），**一套问答协议覆盖两种工具**——这是放弃 stdin 拦截 AskUserQuestion 的核心收益。
- `runProcess`：通用 spawn 工具，超时强杀（Windows `taskkill` / Unix `SIGKILL`），粗略 token 估算 = (stdin+stdout 字符数)/4。
- 健康检查：`<cmd> --version`，exit 0 即可用。

> ⚠️ `claude -p <file>` 还是 stdin？实测 `claude --print` 读 stdin 作为 prompt，故用 stdin 喂 context 内容（`adapters.ts` 读 `contextFilePath` 写入 stdin）。`codex exec` 同理读 stdin。这些 CLI 签名需在真实环境核对。

### 2.4 通信协议

**日志 `.team/logs.jsonl`（NDJSON）**：每条 `{ts, agentId, agentTool, taskId, type, content}`。v4 删掉了 CRC32 校验与 fs.watch（直采 stdout），日志损坏重放成本极低。

**stdout 问答协议**：子 Agent 输出 `«ATO_QUESTION»{"id":"q-3","level":"L2","text":"...","options":["A","B"]}«/ATO_QUESTION»` 后立即退出；编排器下轮把答案写进 `context.md` 的 `## Prior Decisions` 段重 spawn。分级 L0（自动）/L1（倒计时）/L2（必须人工）由编排器侧判别，与 CLI 工具解耦。

**状态快照 `.team/state.json`**：任务状态机（pending/running/awaiting-question/completed/failed/skipped）+ 决策 + token 预算。

### 2.5 两层混合路由（核心差异化）

| 层 | 决策者 | 粒度 | 复用 |
|----|--------|------|------|
| Layer 1 task 级 | 编排器（DAG 生成时） | 每个子任务 | task → routeId（直接引用 AICodeSwitch 现有 Route） |
| Layer 2 请求级 | 代理（运行时自动） | 子 Agent 的每个请求 | `proxy-server.ts:determineContentType` 按 thinking/background/long-context 自动切 Rule/模型 |

组合效果：task 绑 routeA → routeA 内部 thinking 走 Sonnet、`count_tokens`/background 走 Haiku → **成本在请求级自动分层，编排器零配置**。这是单层路由竞品做不到的。

**high-iq 升级阀**：context.md 指导子 Agent 用 `[!]`/`[x]` 前缀临时切强模型规则，复用代理已有 `prepareHighIqRouting`。

### 2.6 Token 预算（复用，不自建）

团队绑定一个"团队预算 AccessKey"（`sk_`），复用 `quota-checker.ts` 的 token limit → 命中即 429 硬停止。编排器不自建计数器。task 级 token 仅做软估算（stdout 字符数）。

### 2.7 配置态软锁（`atoActiveTeamCount`）

- 团队启动 +1、结束 -1，存 `AppConfig.atoActiveTeamCount`。
- `/api/restore-config/*` 端点检测 `>0` 时拒绝恢复用户配置（409）——防止团队运行中配置被翻转，子 Agent 静默走错上游。
- spawn 前自检 `checkClaudeConfigStatus().isOverwritten`。
- 服务 shutdown 时先 `shutdownAll()` 回收子 Agent、复位计数，再恢复配置。

### 2.8 网关归因（`proxy-server.ts`）

`finalizeLog` 读取请求 header `x-ato-task-id` → 写入 `RequestLog.tags`（`ato:<taskId>`）。**这是唯一动代理内核的小改动**，其余全是复用。

### 2.9 ATO HTTP API（`routes.ts`）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/orchestrator/teams` | 创建并启动团队 |
| GET | `/api/orchestrator/teams` | 列出团队 |
| GET | `/api/orchestrator/teams/:id` | 团队状态 |
| GET | `/api/orchestrator/teams/:id/logs?since=` | 增量日志 |
| POST | `/api/orchestrator/teams/:id/stop` | 停止 |
| POST | `/api/orchestrator/teams/:id/questions/:qid/answer` | 回答子 Agent 上抛问题 |
| GET | `/api/orchestrator/adapters/check` | 适配器健康检查 |
| GET | `/api/orchestrator/routes` | 可用路由（供选 routeId） |

---

## 3. 主 Agent（Leader）子系统（`orchestrator/leader/`）

### 3.1 设计目标

用户只面对一个聊天窗口，对话端是 Leader（Claude Code / Codex）。Leader **自主**通过 MCP 工具管理团队/任务/路由/记忆；用户问"现在有哪些团队"时，Leader 查询后用自然语言回复，不再有操作面板。

### 3.2 目录与记忆结构（`~/.aicodeswitch/ato-leader/`）

```
ato-leader/
├── memory/
│   ├── conversation.jsonl   # 完整对话历史（NDJSON，重建上下文用）
│   ├── profile.md           # 长期记忆（用户画像/偏好/约定）
│   └── scratchpad.md        # 短期工作记忆（当前团队 id/阶段/TODO）
├── sessions/<id>/           # 会话事件归档
├── workspace/               # ← Leader 的固定 cwd（"家"），内种 CLAUDE.md
├── config.json              # { leaderTool, permission{...} }
└── teams-index.json         # 团队索引缓存
```

- **workspace**：Leader 启动 claude/codex 的固定 cwd，可在其中自由创建 notes/plans/skills。首次种入 `CLAUDE.md` 说明角色。
- **每次运行无状态**：从磁盘读 `profile.md` + `scratchpad.md` + 最近对话重建 prompt（符合 v4「memory on disk, not in prompt」）。

文件：`memory.ts`（`ensureLeaderDirs`/`loadConversation`/`appendConversation`/`readMemoryFile`/`writeMemoryFile`/`loadLeaderConfig`/`saveLeaderConfig`/`buildTranscript`）。

> Leader 的 cwd 以前是"启动 aicos 的 shell 目录"（非确定性，bug）。现已固定为 `workspace/`。注意：**workspace 不是沙箱**——claude/codex 原生工具仍可用绝对路径/bash 访问整机（见 §5 安全边界）。

### 3.3 流式 runner（`runner.ts`）

```ts
streamClaude: spawn('claude', ['--print','--output-format','stream-json', ...permFlags], {cwd, env, stdio:['pipe','pipe','pipe']})
streamCodex:  spawn('codex',  ['exec', ...], 同上)   # 纯文本流，无 stream-json/工具事件
streamLeader(tool, ...): 分派器
```

- **逐行解析 stream-json**：对 `assistant` 事件取 `message.content` 的 text 块，按**快照后缀 diff**提取增量（兼容快照式与增量式事件）；`tool_use`/`tool_result` → `onTool`；结束 → `onDone(fullText)`。
- **多轮不靠 `--resume`/`--input-format stream-json`**（未在本项目验证），而是 `conversation.jsonl` 重建 transcript 喂入 prompt。每轮无状态。
- 超时强杀；`isToolAvailable(tool)` 健康检查。

> ⚠️ stream-json 事件结构以真实环境为准，runner 的增量解析可能需按实测微调。

### 3.4 系统提示（`prompt.ts`）

核心是**决策是否动用团队**（这是 Leader 的灵魂）：
1. **直接回复**：简单询问/咨询/头脑风暴/闲聊 → 不建团队。
2. **创建新团队**：仅当有明确目标 + 可拆解多步 + 每步可客观验证。
3. **接入已有团队**：有进行中团队、用户追问进度/处理上抛问题时，查询后回复/答题，不重复建队。

原则写进提示词："宁可多聊两句确认，也不要为简单问题滥用团队——你是会**判断**的总管。"

### 3.5 LeaderManager（`manager.ts`）

- **单活跃会话**：一次只处理一条用户消息（`active` 标志），避免 claude 进程并发冲突。
- `sendMessage(text, sink)`：追加 user 消息 → `buildLeaderPrompt` → `streamLeader` → text delta 经 sink 回流 → 结束追加 assistant 消息。
- `sink` = `{text, tool, status, done, error}`，由路由层转成 SSE。
- 持有 `PermissionJudge` 实例（构造时传 `proxyBase`）。

### 3.6 ato-leader MCP server（`mcp-server.ts`）

**独立进程入口**（`node dist/server/orchestrator/leader/mcp-server.js`），stdio JSON-RPC，**无 SDK 依赖**（手写约 200 行）。处理 `initialize`/`tools/list`/`tools/call`，通知不回包。

工具：
- `ato_list_routes` / `ato_create_team` / `ato_list_teams` / `ato_get_team` / `ato_stop_team` / `ato_answer_question` / `ato_check_adapters` → 经 HTTP 调本机 `/api/orchestrator/*`（跨进程解耦）。
- `memory_read` / `memory_write`（profile/scratchpad）/ `conversation_recent` → 读写本地记忆。
- `permission_request` → 见 §5。

**注册**：`main.ts:ensureLeaderMcpRegistered(port)` 启动时写入 `~/.claude.json` 的 `mcpServers['ato-leader']`（`command:'node', args:[<dist>/mcp-server.js], env:{ATO_BASE, ATO_TOKEN}`）+ Codex `~/.codex/config.toml` 的 `[mcp_servers.ato-leader]`。故 Leader/子 Agent 启动时自动加载。

> 该 MCP 不进用户可见的 `mcps.json`（系统内置）。配置态 restore 会清掉它，下次启动重写。

### 3.7 Leader HTTP API（`routes.ts`）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/orchestrator/leader/message` | **SSE 流式**回复（`data:{type:'text'\|'tool'\|'status'\|'done'\|'error'}`） |
| GET | `/api/orchestrator/leader/history` | 对话历史 |
| GET | `/api/orchestrator/leader/status` | `{busy, available, leaderTool}` |
| GET/PUT | `/api/orchestrator/leader/config` | 主 Agent 工具（claude-code/codex） |
| POST | `/api/orchestrator/leader/reset` | 清空对话+工作记忆 |
| POST | `/api/orchestrator/leader/permission` | 权限裁决（同步阻塞，见 §5） |
| GET | `/api/orchestrator/leader/permissions/pending` | 待人类裁决列表 |
| POST | `/api/orchestrator/leader/permissions/:id/resolve` | 人类放行/拒绝 |
| GET | `/api/orchestrator/leader/permissions/stream` | SSE 推权限事件 |

---

## 4. 前端：Codex 风格聊天窗（`HomePage.tsx`）

- **极简布局**：无标题、无外围卡片，空状态仅一个居中输入框（`.leader-input-box`，浅色白/深色黑底），含 textarea + 主 Agent 选择器（ghost 下拉）+ 圆形 ↑ 发送按钮。有对话后消息流在上、输入框沉底。
- **流式接收**：项目首个 `fetch().body.getReader()` 消费者（`client.ts:atoLeaderMessage`）——按 `\n\n` 切 `data:{...}`，累加 delta 到当前 assistant 气泡，逐字渲染 + 思考光标。
- **主 Agent 切换**：顶栏下拉 Claude Code / Codex，PUT `/leader/config` 持久化到 `config.json`。
- **工具调用 chip**：assistant 消息里的 tool_use/tool_result 渲染为可折叠 chip。
- **权限待裁决面板**：订阅 `/permissions/stream`（EventSource），有 pending 时顶部出卡片（工具/参数/风险等级 + 放行/拒绝）。
- **菜单**：侧边栏首项"首页" → `/`；"路由管理"→ `/routes`（两按钮「局域网同步」「一键配置」在路由管理页右上角）。

---

## 5. 权限裁决 PermissionJudge（`leader/permission.ts`）

### 5.1 背景

此前 Leader/子 Agent 都以 `claude --print` 启动、不带权限参数，权限完全由全局 `permissions.defaultMode` 决定——要么 `default`（危险操作静默跳过）、要么放行（全自动无判断）。**不存在"claude 问、Leader 智能判断"的机制。**

### 5.2 机制：`--permission-prompt-tool`

经 Claude Code 官方文档确认：headless `default` 模式下，未被 allow 规则放行的工具调用会调用指定的 MCP 工具，传 `{tool_name, input}`，期望返回 `{behavior:"allow", updatedInput?}` 或 `{behavior:"deny", message}`；deny 的 message 作为 tool_result 喂回 claude（**agent 自己 adapt，不退出进程**）；该调用**同步阻塞、无硬超时**。

**文档出处**：
- `code.claude.com/docs/en/cli-reference.md`（`--permission-prompt-tool` flag）
- `agent-sdk/permissions.md`（五步评估：deny 规则 > ask 规则 > permission-mode > allow 规则 > canUseTool/permission-prompt-tool）
- `agent-sdk/user-input.md`（`canUseTool`/`PermissionResult`、deny 行为、无限阻塞）
- `channels-reference.md`（permission 字段）

### 5.3 流程

```
claude(leader/sub-agent) 要执行需权限的工具
  ─(default 模式, 未被 allow 规则放行)─▶ mcp__ato-leader__permission_request({tool_name,input})
        │ ato-leader MCP（子进程，5min 长超时 fetch）
        ▼ POST /api/orchestrator/leader/permission   （同步阻塞）
PermissionJudge.evaluate:
  1) 硬规则 deny 正则（rm -rf /、force push、curl|sh、drop table…）→ deny
  2) 硬规则 allow 正则（ls/cat/grep/git status/npm test/workspace 内写）→ allow
  3) LLM 危险度分析（经本机代理 /v1/messages 打一次上游，raw HTTP，不走 CLI、不递归）
     → {risk:low|medium|high, reason, alternative}
  4) 策略：low→allow；high→deny(message 含 alternative，claude 自动改策略)；
           medium→humanGateMedium? 上抛人类 : 自动放行；high+humanGateHigh→上抛人类
  5) 上抛人类：pending 队列 + SSE 推前端，await UI resolve（4min 兜底超时→deny）
  ◀── 返回 {behavior, updatedInput?/message}
claude 收到 allow 执行 / deny(message) 后 adapt
```

**关键**：
- spawn 加 flag：`runner.ts`（Leader）+ `adapters.ts`（子 Agent）都加 `--permission-mode default --permission-prompt-tool mcp__ato-leader__permission_request`（由 `permission.enabled` 门控）。
- LLM judge 是 **raw HTTP 到本机代理**，不是 claude CLI——**不会递归触发权限**。消耗 token，可绑便宜模型。
- "分析每个选项的危险程度"：headless 下 claude 不弹编号菜单，而是把单个待执行动作交给我们；我们的"选择选项"= {放行, 改写后放行, 拒绝+建议替代}；"中断后改变策略"= deny 时把建议写进 message，claude 读到后自行换方式。

### 5.4 配置（`ato-leader/config.json` 的 `permission`）

```json
{
  "enabled": true,
  "allowPatterns": ["^ls(\\s|$)", "^git\\s+(status|diff|log)", "^npm\\s+test", ...],
  "denyPatterns": ["rm\\s+-rf\\s+/(\\s|$)", "git\\s+push.*--force", "curl\\s+.*\\|\\s*(sh|bash)", ...],
  "humanGateMedium": false,
  "humanGateHigh": false
}
```

`enabled:false` 时 spawn 不带 permission flag，退回旧行为。

### 5.5 ⚠️ P0 待实测（关键不确定点）

官方文档**未给 `--permission-prompt-tool` 的端到端 JSON schema**，以下两点需 echo 实测定型：
1. **入参字段名**：是 `{tool_name, input}` 还是驼峰/带 `request_id`？——已做容错（`tool_name|toolName|name`、`input|arguments`）。
2. **返回形态**：MCP 协议标准把工具结果包成 `{content:[{type:'text', text: JSON}]}`，但 permission-prompt-tool 期望结构化 `{behavior,...}`。当前用标准包裹（text = `JSON.stringify({behavior,...})`），claude 应能从 text 解析 JSON。若实测要裸对象，需在 `mcp-server.ts` 的 `tools/call` 给 `permission_request` 走特殊返回路径。

**echo 验证法**：先实现一个 echo 版 permission_request（原样记录入参 + 分别试两种返回形态），跑一个会触发权限的简单任务，看哪种让 claude 正常放行，再定型。若都不通 → 回退 `--allowedTools/--disallowedTools` 声明式 + `default`（牺牲智能判断但稳）。

---

## 6. main.ts 接线（`src/server/main.ts`）

`start()` 内顺序：
1. dbManager 初始化、`syncConfigsOnServerStartup` 写本地配置。
2. `new ProxyServer`、AccessKey/Performance 模块初始化、`proxyServer.initialize()`。
3. `registerRoutes` + `proxyServer.registerProxyRoutes()`。
4. **ATO**：`new OrchestratorManager(...)` + `registerOrchestratorRoutes(...)`，启动时重置 `atoActiveTeamCount`。
5. **Leader**：`ensureLeaderDirs()` → `new LeaderManager(\`http://127.0.0.1:${port}\`)` → `registerLeaderRoutes(...)` → `ensureLeaderMcpRegistered(port)`（写 ato-leader MCP 到 .claude.json + codex config.toml）。
6. 静态资源/404/error 中间件。
7. `app.listen`。

`shutdown()`：先 `leaderManager.shutdownAll()` + `orchestratorManager.shutdownAll()` + 复位 `atoActiveTeamCount`，**再** restore 配置（先回收子 Agent，避免配置翻转）。

`/api/restore-config/*` 端点加软锁守卫（团队运行中 409）。

---

## 7. 关键技术决策与理由

| 决策 | 理由 |
|------|------|
| 厚路径（内嵌）+ 进程隔离（非 fork） | 复用 AICodeSwitch 网关/统计/会话/配额；子 Agent 本就是独立进程，崩溃不拖垮主服务 |
| stdout 协议问答（弃 stdin 拦截 AskUserQuestion） | headless 下 AskUserQuestion 行为不确定 + Codex 无 stdin；stdout 标记块一套协议覆盖两工具，契合无状态模型 |
| 两层混合路由 | 单层路由竞品做不到请求级模型异构；成本自动分层是核心差异化 |
| Token 预算复用 AccessKey quota | 不自建计数器，复用 429 硬停止 |
| task→routeId 引用现有 Route | 厚路径去重，不在 orchestrator 重复定义上游 |
| MCP 经 HTTP 调本机 API | 跨进程解耦，无需共享内存；OrchestratorManager 是进程内内存态 |
| Leader cwd 固定 workspace | 旧实现继承 shell 目录（非确定性）；固定"家"让 CLAUDE.md/记忆/计划有归宿 |
| 权限用 `--permission-prompt-tool` | 官方为 headless 设计的权限外委托机制；同步阻塞可在内部做 LLM 分析/等人类 |
| LLM judge 走代理 raw HTTP | 不走 CLI，不递归触发权限；快 |
| 砍 CRC32/fs.watch/适配器市场 | 本地单用户过度工程；直采 stdout 不需 fs.watch |

---

## 8. 已知限制与风险

- **CLI 签名以实测为准**：`claude --print --output-format stream-json`、`codex exec` 的事件结构/参数需真实环境核对（runner 解析、adapter 调用、问答协议退出语义）。
- **codex 无 `--permission-prompt-tool`**：权限裁决仅 claude-code 适配器生效；codex Leader/子 Agent 维持 defaultMode 行为。codex exec 是否在非交互下加载 `[mcp_servers]` 亦需确认。
- **`--permission-prompt-tool` 契约未实测**（见 §5.5）：入参字段名、返回形态需 echo 验证。
- **workspace 非沙箱**：claude/codex 原生工具（Read/Write/Edit/Bash）可用绝对路径访问整机（用户账户范围）。当前仅靠 PermissionJudge 做"是否执行"判断，未做文件系统级 jail。如需硬隔离，应额外写 `permissions.allow/deny` 规则到 settings.json。
- **AUTH 开启时**：MCP/judge 调本机需 `ATO_TOKEN`； leader 消息端点走管理面鉴权。
- **单活跃 Leader 会话**：一次只处理一条用户消息，并发被拒。
- **LLM judge 延迟**：每次权限裁决可能阻塞 claude 数秒（judge）/ 数分钟（等人类），属同步阻塞特性预期。

---

## 9. 调试指南

### 9.1 日志与状态文件
- ATO 团队：`<workspace>/.team/{logs.jsonl, state.json, tasks/<id>/context.md, decisions}`。
- Leader：`~/.aicodeswitch/ato-leader/{memory/conversation.jsonl, memory/profile.md, memory/scratchpad.md, workspace/CLAUDE.md, config.json}`。
- 服务日志：`~/.aicodeswitch/server.log`。

### 9.2 常见问题
| 现象 | 排查 |
|------|------|
| Leader 不回复 / "未检测到 claude CLI" | `atoLeaderStatus` 看 available；确认 claude/codex 已装且在 PATH |
| 子 Agent 流量没走代理 | `checkClaudeConfigStatus().isOverwritten`；配置态软锁是否生效；spawn 前 env 是否带 `ANTHROPIC_BASE_URL`（继承自 settings.json） |
| 权限请求没触发 judge | 确认 spawn args 含 `--permission-mode default`（`permission.enabled`）；该工具是否被 allow 规则提前放行（不会落到 judge） |
| deny 后 Agent 没改策略 | 检查 deny 的 message 是否含替代建议；stream-json 是否把 deny tool_result 正确喂回（runner 解析） |
| MCP 工具调不通 | `~/.claude.json` 是否有 `mcpServers['ato-leader']`；`ATO_BASE/ATO_TOKEN` env；mcp-server.js 是否在 dist 产出 |
| 团队运行中配置被恢复 | `atoActiveTeamCount` 软锁是否 >0；`/api/restore-config/*` 是否被绕过 |

### 9.3 echo 实测权限契约
```bash
# 临时把 permission_request 改成 echo（记录入参 + 返回固定 {behavior:"allow"}）
# 在 Leader 对话里让它跑一个会触发权限的命令（如写 workspace 外文件）
# 看 ~/.aicodeswitch/server.log 与 MCP 日志，确认 claude 实际传入字段名
# 再分别试「标准 text-content 包 JSON」与「裸对象」两种返回，看哪种让 claude 放行
```

### 9.4 手动验证清单
- [ ] Leader 对话"看看现在有哪些团队"→ 调 `ato_list_teams` → 自然语言回复
- [ ] 简单闲聊不建团队（看是否调 `ato_create_team`）
- [ ] `npm test`（allow 规则命中→直接放行）/ `rm -rf /tmp/x`（deny 或 judge high→拒绝，Agent adapt）
- [ ] 上抛人类时 UI 出卡片，点放行/拒绝后 claude 继续
- [ ] deny 后 claude 换方式继续，而非进程退出

---

## 10. 演进时间线

1. **PRD 头脑风暴 → v4 PRD**：从"独立系统+可选集成"转向"AICodeSwitch 嵌入式编排模块"；确定厚路径+fork 隔离、stdout 协议、两层路由。
2. **ATO 编排模块**：types/adapters/scheduler/manager/routes；Ralph Loop + 验证 + 问答 + 软锁；proxy 归因。
3. **首页 v1（操作面板）→ v2（聊天窗）**：移除操作面板，Leader 自主管理；菜单改名"首页"，两按钮迁回路由管理页。
4. **主 Agent 工具切换**：runner 支持 claude/codex，config.json 持久化，MCP 双写。
5. **Leader 固定"家"**：cwd 固定 `~/.aicodeswitch/ato-leader/workspace/` + 种 CLAUDE.md。
6. **权限裁决**：`--permission-prompt-tool` + PermissionJudge（硬规则 + LLM 分析 + 人类上抛）。

---

## 11. 文件索引

**后端**
- `src/server/orchestrator/types.ts` — Task/TeamRun/AgentAdapter/Decision 类型
- `src/server/orchestrator/adapters.ts` — ClaudeCodeAdapter/CodexAdapter/AgentAdapterRegistry/`«ATO_QUESTION»` 解析
- `src/server/orchestrator/scheduler.ts` — TeamScheduler（Ralph Loop + 问答分支 + 验证 + 失败策略）
- `src/server/orchestrator/manager.ts` — OrchestratorManager（团队生命周期 + 持久化 + 软锁）
- `src/server/orchestrator/routes.ts` — `/api/orchestrator/*`（ATO）
- `src/server/orchestrator/leader/memory.ts` — 目录/记忆/配置读写
- `src/server/orchestrator/leader/prompt.ts` — 系统提示（团队决策逻辑）
- `src/server/orchestrator/leader/runner.ts` — 流式 claude/codex spawn + stream-json 解析
- `src/server/orchestrator/leader/manager.ts` — LeaderManager（单会话 + 持 judge）
- `src/server/orchestrator/leader/mcp-server.ts` — stdio JSON-RPC MCP（ato_*/memory_*/permission_request）
- `src/server/orchestrator/leader/permission.ts` — PermissionJudge（规则 + LLM judge + pending 队列）
- `src/server/orchestrator/leader/routes.ts` — Leader + 权限 HTTP 端点
- `src/server/main.ts` — 接线（OrchestratorManager/LeaderManager/MCP 注册/软锁/shutdown）
- `src/server/proxy-server.ts` — `finalizeLog` 读 `x-ato-task-id` 打 tag

**前端**
- `src/ui/pages/HomePage.tsx` — Codex 风格聊天窗 + 权限待裁决面板
- `src/ui/pages/RoutesPage.tsx` — 两按钮「局域网同步」「一键配置」回归
- `src/ui/App.tsx` — 默认页 HomePage、菜单「首页」
- `src/ui/api/client.ts` — ATO/Leader/权限 API（含首个 `fetch().body.getReader()` 流式消费）
- `src/ui/styles/App.css` — `.leader-*` 极简聊天样式
- `src/types/index.ts` — ATO/Leader/权限共享类型

**PRD**
- `docs/PRD/supervisor-agent/supervisor-agent-v4.md` — 权威 PRD
- `docs/PRD/supervisor-agent/supervisor-agent-v4-changelog.md` — 相对 v3.1 变更

---

*文档版本：1.0 · 最后更新：2026-06-17 · 维护：ATO/Leader 模块*
