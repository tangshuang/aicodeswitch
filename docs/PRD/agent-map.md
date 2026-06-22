# Agent Map（任务可视化节点地图）PRD v1

> 状态：草案 v1 · 作者：Claude Code · 日期：2026-06-22
>
> 关联参考：`docs/REFER/claude-agent-sdk.md`、`docs/REFER/codex-sdk.md`（仅作工具事件结构参考，**不作为数据源**）

---

## 1. 背景与目标

### 1.1 问题陈述

用户在本地用 Claude Code 和 Codex 编程时，二者所有流量都经过 AICodeSwitch 代理。代理已经沉淀了完整的请求日志（含 `messages`、工具调用、响应、token），也有按 session 聚合的会话记录。但用户**无法一眼把握"此刻有哪些 Agent 在干活、它们各推进到哪一步"**：

- 现有 `SessionsPage` / `LogsPage` 是扁平表格，要点进每条记录才知道细节；
- 没有实时性，前端靠 10 秒轮询；
- `Session` 模型没有"进行中 / 已完成"概念，更没有"任务进度"语义。

### 1.2 目标

做一个**游戏化节点地图（Agent Map）**：把每个 Session 画成画布上的一个节点（"星球"），其工具活动（Read / Edit / Bash / Grep…）按时间顺序连成路径；节点状态由活跃度自动判定（进行中 / 空闲 / 已完成 / 异常）并实时刷新。让用户在一个界面里总览所有 Agent 的编程进度。

### 1.3 非目标

- ❌ **不驱动 / spawn 任何 Agent**（不做 ATO 编排，系统中也未实现）；
- ❌ **不依赖 Agent SDK / Codex SDK 作为数据源**——数据全部来自代理已有的流量日志；
- ❌ **不替换** `SessionsPage` / `LogsPage`（保留作详细视图，Agent Map 提供跳转入口）；
- ❌ 不做跨设备同步、不做节点图自动力导向重排。

---

## 2. 用户场景

- **场景 A（多窗口并行）**：开了多个 Claude Code 窗口并行改不同模块，想看哪个还活着、哪个卡住了——一眼扫画布上哪些节点在脉冲。
- **场景 B（后台长任务）**：Codex 在后台跑长任务，想瞟一眼它推进到第几步——点开节点看活动路径子图。
- **场景 C（事后回看）**：某个 Session 已完成，想回放它的完整工具活动路径——只读展开活动子图。

---

## 3. 核心概念与状态机

### 3.1 Session 状态（活跃度自动推断）

现有 `Session` 没有 status 字段（见 [`src/types/index.ts:416`](../../src/types/index.ts#L416)）。本 PRD 新增四态，全部由信号自动推断，**无需用户手动标记**：

| 状态 | 含义 | 判定规则（默认阈值可配） |
|---|---|---|
| `active` | 进行中 | 最近 **N=60s** 内有新请求 **或** 该 Session 当前有在途请求 |
| `idle` | 空闲 | 超过 N 秒无新请求，但近 **M=10min** 内有过活动 |
| `completed` | 已完成 | 超过 M 分钟无活动 **且** 末轮响应正常结束（非中断 / 非 5xx） |
| `error` | 异常 | 末次请求 5xx，或流式响应中断未正常收尾 |

**判定信号**：`lastRequestAt`、在途请求注册表（见 §5）、末条日志 `statusCode`、流式是否正常结束。

**状态迁移**：`active ⇄ idle`（来新请求回 active）、`idle → completed`（超 M 分钟，定时器扫）、`任意 → error`（末次失败）、`error → active`（下一次成功请求）。

### 3.2 ActivityEvent（活动事件）

从日志里抽出的细粒度节点，用于地图副标、活动路径子图、全局活动流：

```ts
interface ActivityEvent {
  id: string;
  ts: number;
  sessionId: string;
  agent: 'claude-code' | 'codex';
  kind: 'prompt' | 'thinking' | 'tool_use' | 'tool_result' | 'response' | 'error';
  toolName?: string;        // Read/Edit/Bash/Grep/WebFetch...
  summary: string;          // 一行摘要，如 "Edit auth.ts" / 用户提问前 80 字
  tokensDelta?: number;     // 本轮 token 增量
}
```

**产出方式**：后端从 `RequestLog.body.messages` + 响应解析出本轮新增事件。解析逻辑**复用** [`extractChatMessagesFromLogs`](../../src/ui/utils/session-chat-utils.tsx#L206)（已兼容 Claude / OpenAI / Responses / Gemini + 流式 / 非流式），将其从 UI 工具文件抽到前后端共享模块，不在 PRD 里新发明解析器。

---

## 4. 功能需求

### 4.1 地图总览视图（菜单入口「任务雷达」）

一张 SVG + React 节点画布，每个 Session = 一个主节点。

**节点视觉编码**：
- 形状 / 徽标区分 agent（Claude / Codex）；
- 颜色 + 光晕编码状态：`active` 脉冲发光、`idle` 常亮、`completed` 变暗、`error` 红色；
- 节点大小或副标显示工作量（请求数 / 工具调用数 / token）；
- 节点下方一行最近活动摘要（如 `📝 Edit auth.ts`）。

**布局**：初始按状态分区聚集（active 居中高亮、idle 外围、completed 边缘灰化）；支持拖拽重排，位置存 `localStorage`。**不做** GPU 加速 / 自动力导向重排。

**顶部全局指标条**：活跃 Session 数、近 1 分钟工具调用数、token 吞吐。

### 4.2 Session 详情（点开主节点）

展开该 Session 的**活动路径子图**：用户提问 → 思考 → 工具调用链 → 响应，按时间从左到右 / 从上到下连成有向图。

- 每个工具节点点击可展开 `input` / 结果（复用 `ToolChip` 折叠 chip 设计）；
- 侧栏：Session 元信息（标题、首 / 末请求时间、总 token、绑定 route、agent 类型）；
- 右上角"在 SessionsPage 打开"跳转旧详情页（向下兼容入口）。

### 4.3 实时活动流

- 任何 Session 有新请求 / 新工具调用时，对应节点实时脉冲 + 画布上弹出短暂活动气泡（toast 风）；
- 底部可折叠的"全局活动 feed"：按时间倒序滚动所有 Session 的细粒度事件（类似游戏战报）；
- 实现走新增 SSE 端点（见 §6）。

### 4.4 状态推断引擎（后端）

- 在 [`finalizeLog`](../../src/server/proxy-server.ts#L3993) 接入：每次请求结束 → 重算该 Session 状态 → 广播；
- 在 `proxyRequest` 入口 / 出口维护在途请求注册表（见 §5）；
- 定时器（每 15s）扫一遍 Session，把 `idle → completed` 的迁移推广播。

---

## 5. 数据模型扩展

### 5.1 `Session` 新增字段（[`src/types/index.ts:416`](../../src/types/index.ts#L416)）

```ts
status: 'active' | 'idle' | 'completed' | 'error';
statusReason?: string;          // 推断依据，便于调试 / UI tooltip
lastActivitySummary?: string;   // 最近一次工具 / 响应摘要，用于地图副标
lastToolName?: string;
lastStatusCode?: number;
// inFlightRequests 运行时态，可不持久化
```

**兼容**：旧 Session 缺字段时按 `lastRequestAt` 现场推断，不强制数据迁移。

### 5.2 新增类型

- `ActivityEvent`（见 §3.2）；
- `InFlightRequest` 注册表（内存 `Map<sessionId, Set<requestId>>`），入口注册 / `finally` 注销。

---

## 6. 技术架构

### 6.1 后端

**采集**（在 [`finalizeLog`](../../src/server/proxy-server.ts#L3993) 末尾新增 hook）：
1. 用现有 `body.messages` + 响应解析出本轮新增 ActivityEvent 列表（解析逻辑抽共享）；
2. 重算 Session 状态（活跃度规则）；
3. `agentMapBroadcaster.broadcast({ sessionId, status, events })`。

**在途注册表**：`proxyRequest` 入口 `inFlightRegistry.start(sessionId, requestId, summary)`、`finally` 块 `inFlightRegistry.end(requestId)`；用于 `active` 判定 + 节点显示"正在处理"。

**SSE 端点** `GET /api/agent-map/stream`（照抄 [`/api/rules/status/stream`](../../src/server/main.ts#L1611) 模式）：
- 建连先发 init 快照（所有 Session 当前状态 + 最近 N 条事件）；
- 后续 push `{type:'session-update'|'activity'|'status-change', ...}` + 3s 心跳。

**REST 端点**：
- `GET /api/agent-map/sessions`（带状态汇总）；
- `GET /api/agent-map/sessions/:id/events?since=`（增量活动事件，前端冷启动补数据）。

**AccessKey 会话合并**：当 AUTH 开启时，全局 `sessions.json` 可能为空（流量走 `key-sessions`）。Agent Map 默认聚合「全局 Session」；若 AUTH 开启则额外聚合各 key 的会话，节点上加 key 标识（复用 [`key-session-tracker.ts`](../../src/server/access-keys/key-session-tracker.ts) 读取接口）。

### 6.2 前端

- 新建 [`src/ui/pages/AgentMapPage.tsx`](../../src/ui/pages/AgentMapPage.tsx)，作为独立菜单页（菜单名"任务雷达"）；
- 子组件：
  - `SessionCanvas`（SVG 节点画布 + 拖拽 + 状态光晕动画，纯 SVG/CSS，**禁用 GPU 加速 CSS**，遵守 CLAUDE.md）；
  - `SessionNode`（主节点）；
  - `ActivityPathGraph`（Session 详情活动路径子图，复用 `ToolChip` 折叠思路）；
  - `ActivityFeed`（底部全局活动流）；
- 数据接入：`fetch('/api/agent-map/stream')` 手动读 SSE 流（带 `Access-Token` header，照抄 `getReader()` 方案）；冷启动先 `GET /sessions` + `/sessions/:id/events?since=` 补齐；
- 复用：`extractChatMessagesFromLogs`（下沉共享）、`api` client、`react-markdown`、`dayjs`；
- 视觉：CSS Variables 主题（明 / 暗），符合项目无 CSS 框架约定。

---

## 7. API 设计

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/agent-map/stream` | SSE 实时推送状态变更 + 活动（init 快照 + 增量 + 心跳） |
| GET | `/api/agent-map/sessions` | Session 列表（含 status 汇总） |
| GET | `/api/agent-map/sessions/:id/events?since=` | 某 Session 增量活动事件 |
| GET | `/api/agent-map/stats` | 全局指标（活跃数、吞吐等，可并进 stream init） |

---

## 8. 交互与视觉规范

- **配色**：`active` = 主色脉冲、`idle` = 次要色、`completed` = 灰阶、`error` = 红；
- **动效**：仅在 `active` 时脉冲（CSS `@keyframes` 改 `opacity` / `transform: scale`，不触发 GPU 合成层）；
- **节点路径**：贝塞尔曲线连线，工具节点小图标（📝 Edit / 📖 Read / 🔧 Bash / 🔍 Grep / 🌐 Web）；
- **空状态**：无 Session 时引导"启动 Claude Code / Codex 开始编程"；
- **响应式**：窄屏退化为列表视图。

---

## 9. 复用与改造清单

| 动作 | 文件 | 说明 |
|---|---|---|
| 改 | [`src/types/index.ts:416`](../../src/types/index.ts#L416) | `Session` 加 status 等字段 |
| 改 | [`src/server/proxy-server.ts:3993`](../../src/server/proxy-server.ts#L3993) | `finalizeLog` 接采集 + 在途注册表入口 / 出口 |
| 新 | `src/server/agent-map/` | broadcaster + in-flight registry + 路由 + 活动解析 |
| 抽共享 | [`src/ui/utils/session-chat-utils.tsx:206`](../../src/ui/utils/session-chat-utils.tsx#L206) | `extractChatMessagesFromLogs` 抽到前后端共用模块 |
| 仿 | [`src/server/main.ts:1611`](../../src/server/main.ts#L1611) | SSE 注册模式（`/api/rules/status/stream`） |
| 新 | `src/ui/pages/AgentMapPage.tsx` + 子组件 | 地图页面 |

---

## 10. 分阶段交付

- **P0（MVP）**：Session 状态推断 + `/api/agent-map/stream` SSE + 地图总览（节点 + 状态光晕）+ 全局活动 feed。不展开详情子图。
- **P1**：Session 活动路径子图（工具调用连线）+ 节点拖拽布局持久化。
- **P2**：AccessKey 会话聚合 + 全局指标条 + 回放模式（历史 Session 重放活动路径）。

---

## 11. 非目标 / 暂不做

- 不 spawn / 控制 Agent（不做 ATO）；
- 不替换 `SessionsPage` / `LogsPage`；
- 不做节点图自动力导向重排（GPU 成本 + 复杂度），用分区 + 拖拽；
- 不做跨设备同步。

---

## 12. 风险与对策

| 风险 | 对策 |
|---|---|
| 日志解析兼容性（Claude / OpenAI / Responses / Gemini + 流式 / 非流式） | 复用已验证的 `extractChatMessagesFromLogs`，不新发明解析器 |
| SSE 连接数 | 单机本地用，连接数可控；3s 心跳 |
| AUTH 模式数据源切换（全局 vs key-sessions） | 明确两套会话存储的聚合策略（见 §6.1） |
| 性能（活动事件膨胀） | 按 Session 滚动窗口保留（如最近 200 条），不全量推 |
