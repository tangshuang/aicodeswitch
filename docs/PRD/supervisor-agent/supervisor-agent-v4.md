# Agent 团队编排系统 PRD v4（AICodeSwitch 嵌入式版）

> 本版本（v4）相对 v3.1 的关键转向：**ATO 不再是独立系统，而是 AICodeSwitch 的可选编排模块**。AICodeSwitch 是地基而非集成对象。问答机制放弃脆弱的 stdin 拦截，改用 **stdout 协议约定**；核心差异化聚焦"**两层混合路由**"。详细变更见 `supervisor-agent-v4-changelog.md`。

## 0. 阅读指南

### 0.1 文档概览

本 PRD 描述一个基于 **Loop Engineering** 最佳实践、并**深度内嵌于 AICodeSwitch** 的多 Agent 编排模块。它复用 AICodeSwitch 已有的代理网关、Token 统计、会话追踪、配额控制、路由系统，自身只实现编排核心（Ralph Loop 调度器 + 验证门控 + DAG + 子进程管理）。

**适合阅读的角色**：
- **产品经理/架构师**：第 1-4 章（项目概述、用户故事、架构、功能需求）
- **技术实施者**：第 5 章（技术规格）
- **决策者**：第 1 章（定位）、第 10 章（里程碑）
- **风险评估者**：第 11 章（风险、假设、参考资料）

### 0.2 核心创新点

| 创新点 | 传统做法 | ATO 做法 | 优势 |
|--------|---------|----------|------|
| **两层混合路由** | 单层模型路由（仅 task 级或仅请求级） | task 级（编排器定 routeId）+ 请求级（代理按 content-type 自动切模型）双层叠加 | 成本最优，竞品做不到 |
| **验证即出口** | Agent 自我报告"任务完成" | 外部验证脚本判断（测试/编译/检查） | 可靠性 ↑ 90% |
| **无状态运行** | Agent 长驻进程，通过多轮对话积累上下文 | 每次全新进程 + 全新上下文窗口，从磁盘读取状态 | 无上下文漂移 |
| **Ralph Loop** | 复杂的 Agent 间通信协议（消息队列/RPC） | 简单循环：选任务 → 启动 → 验证 → 下一轮 | 实现成本 ↓ 70% |
| **stdout 协议问答** | stdin 拦截 `AskUserQuestion`（脆弱、Codex 不支持） | 子 Agent 用 `«ATO_QUESTION»` 标记输出问题后退出，编排器下轮注入答案 | 跨工具统一、不依赖 headless 行为 |
| **Token 预算（复用）** | 无成本控制 | 复用 AICodeSwitch AccessKey 的 token limit → 429 硬停止 | 零新建计数器 |

### 0.3 关键设计决策

1. **为什么是厚路径（内嵌）而非独立 CLI？**
   独立 CLI（v3.1 的方案 B）要重做 UI/日志/统计。实地看代码，AICodeSwitch 已提供子进程自动走代理、Token 统计、会话隔离、配额硬停止、请求级路由——**这些全是 ATO 的刚需且现成**。内嵌把编排层做得很薄，复用红利最大。

2. **为什么厚路径还要 fork 隔离？**
   编排器跑子进程、执行验证脚本、可能崩溃，绝不能拖垮常驻的代理主服务（4567）。因此编排逻辑作为**独立 fork 子进程**，主进程只开 `/api/orchestrator/*` 指挥端口。崩溃可独立重启，代理流量零感知。这是"厚路径里的薄隔离"。

3. **为什么 stdout 协议而非 stdin 拦截？**
   Claude Code headless（`-p --output-format stream-json`）下 `AskUserQuestion` 行为不确定（高风险假设）；Codex 根本没有 stdin 交互。stdout 协议用 `«ATO_QUESTION»` 标记输出问题、退出、下轮注入答案，**一套协议覆盖两种适配器**，且天然契合 Ralph Loop"退出后重启"的模型。

4. **为什么是两层混合路由（核心差异化）？**
   单层路由竞品（Claude Code Agent Teams、claude-flow、AutoGen）要么只 task 级异构、要么没有请求级模型路由。ATO 叠加 task 级（routeId）+ 请求级（content-type 自动切模型），实现"成本在请求级自动分层"——这是只有内嵌 AICodeSwitch 才能做到的。

5. **为什么 Token 预算不新建计数器？**
   AICodeSwitch 的 `quota-checker.ts` 已实现"token 上限命中即 429 硬拒"。团队任务复用一个"团队预算 AccessKey"即可，不重新发明。

6. **为什么 MVP 收窄到"有测试的代码任务"？**
   验证脚本的"可写性"才是真瓶颈：重构/生成报告/探索性分析很难写出可靠验证脚本。MVP 打透"有测试的代码改动"甜蜜区，通用化留到后期。

---

## 1. 项目概述

### 1.1 项目名称

Agent Team Orchestrator (ATO) —— AICodeSwitch 的可选多 Agent 编排模块

### 1.2 项目目标

构建一个纯编排层的多 Agent 系统，**不包含任何 Agent 执行逻辑**，仅负责启动、监控、协调多个 CLI Agent 子进程来完成复杂任务。主 Agent 充当 Leader 角色，动态创建团队并调度任务。它**内嵌于 AICodeSwitch**，复用其网关/统计/会话/配额/路由能力。

**支持的 Agent 工具（适配器）**：
- **内置支持**：Claude Code、Codex（首批实现）
- **可扩展**：通过 Agent 适配器接口，可支持任意 CLI Agent 工具（OpenCode、KimiCode、Cursor CLI、Windsurf CLI 等，远期）

### 1.3 核心理念

- **编排即调度**：系统本身不执行 AI 推理、不调用工具
- **Agent 即进程**：每个子 Agent 是一个独立的 Claude Code / Codex 进程
- **通信即日志**：所有 Agent 通过结构化日志文件沟通，实现类群聊协作
- **主 Agent 驱动**：所有调度决策由主 Agent 完成
- **验证即出口（Loop Engineering）**：任务完成与否由外部验证（测试/编译/检查脚本）裁定
- **无状态运行 + 持久化环境**：每次 Agent 运行是无状态的，状态完全持久化在环境中
- **两层混合路由**：task 级（routeId）+ 请求级（content-type 自动切模型）

### 1.4 与 AICodeSwitch 的关系（核心定位）

**ATO 是 AICodeSwitch 的可选编排模块，AICodeSwitch 是地基而非集成对象。**

v3.1 把集成方案放在第 9 章当可选项（"先独立 CLI 验证，再迁移内嵌"）。v4 直接采用内嵌路径，因为 ATO 的绝大部分刚需 AICodeSwitch 已经提供：

| ATO 的刚需 | AICodeSwitch 现状 | 复用程度 |
|---|---|---|
| 子 Agent 流量经过代理 | 启动时已把 `ANTHROPIC_BASE_URL`/Codex `base_url` 写进本地配置，子进程自动继承走代理 | ✅ 零改动 |
| 每任务 Token 核算 | `usage-tracker.ts` + `performance-tracker.ts` | ✅ 现成 |
| 每任务会话历史 | `key-session-tracker.ts`（按 keyId+sessionId 隔离） | ✅ 现成 |
| 团队预算硬停止 | `quota-checker.ts` token limit → 429 | ✅ 现成 |
| 按 task 切上游/模型 | `x-aicodeswitch-content-type` header / AccessKey policy routeId | ✅ 现成 |
| 请求级模型异构 | `determineContentType`（thinking/background/long-context 自动切 Rule） | ✅ 现成 |

**真正需要 ATO 新写的核心只有 4 件**：Ralph Loop 调度器、验证脚本执行器、子进程管理、DAG 引擎。

---

## 2. 用户故事

| 编号 | 角色 | 需求描述 |
|------|------|----------|
| US-01 | 开发者 | 我希望输入一个复杂任务，系统自动分解为多个子任务 |
| US-02 | 开发者 | 我希望看到多个 Agent 以群聊形式实时展示工作进展 |
| US-03 | 开发者 | 我希望当某个子 Agent 遇到选择性问题时，主 Agent 能自动决策或请求我介入 |
| US-04 | 开发者 | 我希望整个执行过程可追溯，所有 Agent 的状态和产出都有记录 |
| US-05 | 开发者 | 我希望系统能自动处理任务依赖（如 B 等待 A 完成后才执行） |
| US-06 | 开发者 | 我希望系统支持断点续传（崩溃后从上次进度恢复） |
| US-07 | 开发者 | 我希望系统能自动识别和处理子 Agent 失控情况（死循环/频繁询问） |
| US-08 | 开发者 | 我希望关键决策需要人工确认，但简单问题能自动处理 |
| **US-09** | **开发者** | **我希望看到每个子任务的成本在两层模型上的分布（task 级总额 + thinking/background 等请求级分布）** |

---

## 3. 系统架构

### 3.1 整体架构图（v4 嵌入式 + fork 隔离）

```
┌─────────────────────────────────────────────────────────────────┐
│                        用户界面（AICodeSwitch Web UI）          │
│            TeamsPage(DAG可视化) / 会话页 / 性能面板              │
└───────────────────────────────┬─────────────────────────────────┘
                                │ /api/orchestrator/* (HTTP/SSE)
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│              AICodeSwitch 主进程（常驻，长稳态）                 │
│  - Express 代理网关（/v1/*, /claude-code/*, /codex/*）          │
│  - 路由/规则/格式转换/Token 统计/会话/配额                       │
│  - orchestrator 指挥端口（start/status/logs/stop）              │
└───────────────┬───────────────────────────────────┬─────────────┘
                │ child_process.fork（按需启停）    │ 子 Agent 流量经代理
                ▼                                   │
┌─────────────────────────────────────────┐         │
│        ATO 编排子进程（可独立崩溃/重启）│         │
│  - Ralph Loop 调度器                     │         │
│  - DAG 引擎 / 验证脚本执行器             │         │
│  - 子进程管理 / 失控熔断                  │         │
│  - stdout 协议问答处理                   │         │
└───────────────┬─────────────────────────┘         │
        ┌───────▼───────┐ ┌───────▼───────┐         │
        │  子 Agent 1   │ │  子 Agent 2   │ ────────┘
        │ (claude-code) │ │   (codex)     │
        └───────────────┘ └───────────────┘
```

**关键**：子 Agent 进程的 API 请求天然走 AICodeSwitch 代理（base_url 已被写入本地配置），因此所有流量自动获得路由能力、Token 统计、会话追踪、配额控制——**编排器无需为这些操心**。

### 3.2 模块划分

| 模块 | 职责 | 技术依赖 | v4 变化 |
|------|------|----------|---------|
| **Process Manager** | 启动/终止子进程，管理 stdio 流，资源限制 | Node.js `child_process` | 保留 |
| **Agent Adapter Registry** | 管理多种 CLI Agent 工具的适配器 | 插件式架构 | 保留（远期才扩第三方） |
| **Task Decomposer** | 调用主 Agent 将用户需求拆解为 DAG | Claude Code (stream-json) | 保留 |
| **DAG Validator** | 验证 DAG 有效性（循环依赖、资源冲突） | 自定义图算法 | 保留 |
| **Scheduler (Ralph Loop)** | 迭代式调度：选任务 → spawn → 验证 → 下一轮；含**问答轮次分支** | 自定义 DAG 引擎 + 验证门控 | 增强（问答分支） |
| **Verification Engine** | 执行任务验证脚本 | 可插拔的验证插件 | 保留 |
| **Question Handler** | 处理子 Agent 的 stdout 协议问题，分级决策（L0/L1/L2） | 自定义协议 | 改写（stdin→stdout） |
| **State Persistence** | 持久化任务状态，支持恢复 | JSON 文件 | 简化（砍 CRC32/快照轮转） |
| **Workspace Manager** | 工作目录策略（shared/isolated/hybrid）、文件锁 | `fs` + 自定义锁机制 | 保留 |
| **Circuit Breaker** | 检测并熔断失控子 Agent | 自定义异常检测 | 保留 |
| ~~Token Budget Tracker~~ | ~~追踪总 Token 消耗~~ | — | **删除（复用 AccessKey quota）** |
| ~~Logger（CRC32/轮转）~~ | ~~带校验的日志轮转~~ | — | **简化（直采 stdout，砍 CRC）** |

---

## 4. 核心功能需求

> 优先级标注相对 v4 MVP。被砍/降级的 v3.1 需求在 changelog 中说明。

### 4.1 团队创建与任务分解

| ID | 需求描述 | 优先级 |
|----|----------|--------|
| F-01 | 主 Agent 接收用户自然语言任务，调用 Claude Code 生成子任务列表 | P0 |
| F-02 | 子任务列表包含：id、description、dependencies、expectedOutput、verificationScript、**routeId**（v4 新增：引用 AICodeSwitch 现有 Route） | P0 |
| F-03 | 主 Agent 根据子任务列表为每个子任务创建一个子 Agent 进程 | P0 |
| F-04 | 子 Agent 进程的工作目录可配置（独立副本或共享目录） | P1 |
| F-23 | 主 Agent 支持加载预定义的子任务模板库 | P1 |
| F-24 | 任务分解后展示 DAG 可视化结果，用户可编辑后再执行 | P1 |
| F-25 | 主 Agent 验证 DAG 的有效性（检测循环依赖、资源冲突） | P0 |
| F-44 | 每个子任务必须声明 `verificationScript`（MVP 限定：编译/测试/lint/产出物存在性/schema） | P0 |
| F-45 | 支持验证脚本类型：shell 命令、可执行文件路径、内置检查器（compile-check/test-runner/lint-check） | P1 |
| **F-61** | **子任务的"上游策略"直接引用 AICodeSwitch 的 `routeId`，不重复定义上游**（厚路径去重） | P0 |

### 4.2 多 Agent 协作与群聊形式

| ID | 需求描述 | 优先级 |
|----|----------|--------|
| F-05 | 所有 Agent（主+子）通过追加日志文件的方式进行通信 | P0 |
| F-06 | 日志格式为 NDJSON，每条包含：timestamp、agentId、agentTool、type、content、**taskId**（v4：从 `x-ato-task-id` 透传） | P0 |
| F-07 | TeamsPage 实时显示日志流，不同 Agent 用不同颜色标识 | P1 |
| F-08 | 支持用户向特定 Agent 发送消息 | P2 |

### 4.3 进度追踪与记录

| ID | 需求描述 | 优先级 |
|----|----------|--------|
| F-09 | 日志文件记录每个 Agent 的：开始时间、当前进度、产出物路径、完成状态 | P0 |
| F-10 | 日志文件记录 Agent 之间的依赖和协作请求 | P0 |
| F-11 | 支持查看当前所有 Agent 状态快照 | P1 |
| F-12 | 支持导出完整执行报告（JSON / HTML） | P2 |
| F-30 | 支持从 `.team/state.json` 快速恢复状态 | P0 |
| ~~F-28~~ | ~~每 10 条日志生成一次状态快照~~ | 砍 |
| ~~F-29~~ | ~~日志行包含 CRC32 校验~~ | 砍 |

### 4.4 主 Agent 调度与决策（Ralph Loop 模式）

| ID | 需求描述 | 优先级 |
|----|----------|--------|
| F-13 | 主 Agent 实时采集子 Agent 的 stdout（**v4：直采 stdout，不用 fs.watch**） | P0 |
| F-14 | 主 Agent 维护任务 DAG，当依赖任务完成后自动启动下游任务 | P0 |
| F-46 | **Ralph Loop 调度模式**：每轮选择一个就绪任务 → spawn 全新子 Agent → 退出后执行验证 → 通过则完成，失败则重试 | P0 |
| F-47 | 子 Agent 每次运行都是全新进程 + 全新上下文窗口，从磁盘读取最新状态 | P0 |
| F-48 | 验证脚本执行：退出码 0 = 通过，非 0 = 失败；捕获 stdout/stderr 记录日志 | P0 |
| F-15 | 主 Agent 检测到子 Agent 发出的 stdout 协议问题，按 L0/L1/L2 自动答复或请求用户输入 | P0 |
| F-16 | 主 Agent 支持超时检测：任务运行超过阈值时标记失败并重新规划 | P1 |
| F-17 | 主 Agent 支持任务失败重试（可配置重试次数） | P1 |
| F-18 | 主 Agent 支持子 Agent 崩溃后的自动重启 | P2 |
| F-34 | 主 Agent 支持三种失败策略：abort / skip / replan | P1 |
| F-35 | 子任务支持返回"部分成功"状态 | P2 |
| F-36 | 重规划模式：失败时主 Agent 自动生成新的 DAG | P2 |
| F-37 | 问题分级：L0自动 / L1建议（倒计时确认）/ L2必须确认 | P0 |
| F-38 | 配置文件支持设置问题自动审批规则（如 L0/L1 全自动） | P1 |
| F-39 | 子任务支持可选的"审批阶段" | P2 |
| F-49 | **Token 预算控制（v4 复用）**：团队任务绑定一个"团队预算 AccessKey"，用其 token limit 实现全局预算硬停止（429） | P0 |
| F-50 | Token 预算可配置为：总量限制或单任务限制（单任务限制由编排器在 `.team/state.json` 软核算） | P1 |

### 4.5 子 Agent 通信协议（v4：stdout 协议）

| ID | 需求描述 | 优先级 |
|----|----------|--------|
| F-19 | 子 Agent 启动参数支持 `--output-format stream-json`（claude-code 适配器） | P0 |
| **F-20** | **子 Agent 在 context.md 指示下，遇到需外部决策的问题时输出 `«ATO_QUESTION»...«/ATO_QUESTION»` 标记块（JSON 体含 level/id/text/options），然后立即结束本次运行** | P0 |
| ~~F-21~~ | ~~子 Agent 监听 stdin 接收 answer~~（v4 改为下轮 context.md 注入，见 F-20a） | 改写 |
| **F-20a** | 编排器拿到答案后，重新 spawn 同一 task，把答案写入新 context.md 的 `## Prior Decisions` 段；子 Agent 据此继续 | P0 |
| F-22 | 子 Agent 在完成时输出 `result` 消息，包含产出物路径 | P0 |

**协议跨工具**：claude-code（stream-json，从 text 事件解析标记块）与 codex（纯文本，直接正则解析）共用同一 `«ATO_QUESTION»` 标记，一套协议覆盖两种适配器。

### 4.6 工作目录策略与资源隔离

| ID | 需求描述 | 优先级 |
|----|----------|--------|
| F-26 | 支持三种工作目录策略：shared / isolated / hybrid | P1 |
| F-27 | 在 shared 模式下自动管理文件锁 | P1 |
| F-31 | 子 Agent 运行时资源限制（CPU 时间/内存/输出大小） | P1 |
| F-32 | 主 Agent 检测子 Agent 失控行为（死循环/频繁询问/异常输出） | P1 |
| F-33 | 主 Agent 对失控子 Agent 执行熔断并记录详细原因 | P1 |

### 4.7 观测性与调试工具

| ID | 需求描述 | 优先级 |
|----|----------|--------|
| F-40 | TeamsPage 实时展示 DAG 执行进度（节点状态：灰/黄/绿/红，纯 CSS variables，不引图形库） | P1 |
| F-41 | 调试模式：输出所有子 Agent 的 stdin/stdout（`--debug` 启动） | P2 |
| F-42 | 支持暂停/恢复子 Agent | P3 |
| F-43 | 性能分析报告（复用 StatisticsPage 性能面板，按 task 维度筛选） | P2 |

### 4.8 Agent 适配器与可扩展性（远期）

| ID | 需求描述 | 优先级 |
|----|----------|--------|
| F-51 | 定义标准 Agent 适配器接口（`IAgentAdapter`） | P0 |
| F-52 | 实现 Claude Code 适配器（stream-json、stdout 协议、上下文文件） | P0 |
| F-53 | 实现 Codex 适配器（纯文本输出、stdout 协议） | P0 |
| F-54 | 提供通用适配器模板（`GenericCLIAdapter`） | P2（远期） |
| F-55 | Agent 适配器注册表（`AgentAdapterRegistry`） | P1 |
| F-56 | 子任务支持指定使用的 Agent 工具（taskAgentMapping） | P1 |
| F-57 | 启动时自动检测所有已注册 Agent 工具的可用性（健康检查） | P1 |
| ~~F-58~~ | ~~通过配置文件加载第三方适配器（插件式加载）~~ | 远期（移出 MVP） |

### 4.9 两层混合路由（v4 核心差异化）

| ID | 需求描述 | 优先级 |
|----|----------|--------|
| **F-62** | **Layer 1（task 级）**：DAG 生成时每个子任务绑定 `routeId`，引用 AICodeSwitch 现有 Route | P0 |
| **F-63** | **Layer 2（请求级，零代码复用）**：子 Agent 的每个请求由代理 `determineContentType` 按 thinking/background/long-context 自动切 Rule/模型 | P0（复用） |
| **F-64** | **high-iq 升级阀（复用）**：context.md 可指导子 Agent 用 `[!]`/`[x]` 前缀临时切到强模型规则（复用 `prepareHighIqRouting`） | P1 |
| **F-59** | **`x-ato-task-id` header 归因**：子 Agent 请求携带此 header，代理 `finalizeLog` 读它写入 `RequestLog`，实现 task 级成本归因（**唯一需动代理内核的小改动**） | P0 |
| **F-65** | **双层成本报表**：TeamsPage 展示"task 级总额 + 请求级模型分布"（task token 由 header 归因聚合，请求级分布复用 performance-tracker） | P2 |

### 4.10 嵌入式集成（v4 新增）

| ID | 需求描述 | 优先级 |
|----|----------|--------|
| **F-66** | ATO 编排逻辑作为独立 fork 子进程运行，主进程通过 `/api/orchestrator/*` 指挥（start/status/logs/stop） | P0 |
| **F-67** | 编排子进程崩溃可独立重启，代理主服务零感知 | P0 |
| **F-68** | spawn 子 Agent 前自检 `checkClaudeConfigStatus().isOverwritten === true`，否则报错提示用户先激活路由 | P0 |
| **F-60** | **配置态软锁**：团队任务运行期间 `AppConfig.atoActiveTeamCount > 0`，`restoreClaudeConfig`/`restoreCodexConfig` 入口拒绝恢复并提示 | P0 |

---

## 5. 技术规格

### 5.0 嵌入架构与 fork 隔离（v4 新增）

**进程拓扑**：
- AICodeSwitch 主进程（常驻）：保留现有代理 + UI API，新增 `/api/orchestrator/*` 指挥端点。
- ATO 编排子进程：`child_process.fork('src/server/orchestrator/index.js')`，按需启停。
- 通信：编排子进程通过 HTTP（localhost）回读主进程的统计/会话数据，主进程通过 `/api/orchestrator/*` 控制编排子进程。复用现有 ApiClient 模式，不新建 IPC 协议。

**指挥端口契约**（`/api/orchestrator/*`）：
- `POST /:teamId/start` — 启动团队任务
- `GET /:teamId/status` — 当前 DAG 状态快照
- `GET /:teamId/logs/stream` — SSE 实时日志流
- `POST /:teamId/stop` — 停止团队（先回收子 Agent，再退出）

**配置态软锁实现点**：
- `AppConfig` 新增 `atoActiveTeamCount`（团队任务启动 +1，结束 -1）。
- `restoreClaudeConfig`（`main.ts:641`）/`restoreCodexConfig`（`main.ts:736`）入口前置检查：`atoActiveTeamCount > 0` 时返回错误并提示"有团队任务运行中，无法恢复配置"。
- 编排子进程异常退出时，主进程负责兜底递减计数。

### 5.0.1 Agent 适配器接口（IAgentAdapter）

接口与 v3.1 基本一致，关键差异：**问答方法改为 stdout 协议解析**（不再有 `convertAnswer` 写 stdin）。

```typescript
interface IAgentAdapter {
  readonly name: string;              // "claude-code" | "codex" | ...
  readonly version: string;
  readonly supportedFeatures: {
    streamJson: boolean;              // stream-json 输出
    contextFile: boolean;             // 上下文文件
    workspaceIsolation: boolean;
    stdoutProtocol: boolean;          // v4：是否支持 «ATO_QUESTION» 协议（统一 true）
  };

  spawn(options: SpawnOptions): Promise<AgentProcess>;
  generateContextFile(task: Task, dependencies: TaskResult[], priorDecisions: Decision[]): Promise<string>;
  parseOutput(rawOutput: string): AgentOutput;   // 含解析 «ATO_QUESTION»
  checkHealth(): Promise<boolean>;
}
```

**内置适配器**：

| 适配器 | stream-json | stdout 协议 | 上下文格式 | 健康检查 |
|--------|------------|-----------|-----------|-----------|
| **Claude Code** | ✅ | ✅（解析 text 事件） | Markdown | `claude --version` |
| **Codex** | ❌（纯文本） | ✅（正则解析） | 纯文本 | `codex --version` |

适配器接口设计原则不变（面向接口、插件式、配置驱动、降级 fallback、隔离封装），第三方适配器市场为远期目标，MVP 只做两个内置适配器。

### 5.1 Loop Engineering 架构概述

继承 v3.1 的三大模式（Ralph Loop / Agent Loop PAOR / 验证门控），不再重复。v4 的关键补充：

**两层循环协同**：
- 子 Agent 内部跑 PAOR 循环（Claude Code / Codex 原生行为）
- 主 Agent 外部跑 Ralph Loop（选任务 → 启动 → 验证 → 下一轮）
- **v4 新增"问答轮次"**：子 Agent 退出时若留下未决 `«ATO_QUESTION»`，主 Agent 跳过验证、处理问答、重 spawn 同一 task——这是 Ralph Loop 的合法分支，不破坏无状态性。

### 5.2 通信协议

#### 5.2.1 日志文件格式（`.team/logs.jsonl`）

```json
{"timestamp":"...","agentId":"leader","type":"status","content":{"action":"started"}}
{"timestamp":"...","agentId":"sub-1","agentTool":"claude-code","taskId":"sub-1","type":"question","content":{"id":"q-3","level":"L2","text":"选重构方案？","options":["A","B"]}}
{"timestamp":"...","agentId":"leader","type":"answer","content":{"questionId":"q-3","choice":"A","decidedBy":"user"}}
{"timestamp":"...","agentId":"sub-1","agentTool":"claude-code","taskId":"sub-1","type":"result","content":{"artifacts":["artifacts/sub-1/report.json"]}}
```

**v4 变化**：
- 新增 `taskId`（从 `x-ato-task-id` 透传，用于双层归因）。
- **不再依赖 fs.watch**：编排器直采子进程 stdout，日志由编排子进程写入。
- **删除 CRC32 校验**：本地单用户工具过度工程化，损坏重放成本极低。

#### 5.2.2 stdout 问答协议（v4 核心）

子 Agent → 编排器（stdout，标记块）：
```
«ATO_QUESTION»{"id":"q-3","level":"L2","text":"选重构方案？","options":["A) class封装","B) 函数式模块"]}«/ATO_QUESTION»
```

- claude-code：标记块出现在 stream-json 的 `text` 事件内，编排器解析。
- codex：标记块出现在纯文本输出，编排器正则解析。
- **退出语义**：子 Agent 输出标记块后必须立即结束本次运行（context.md 强约束："输出问题后立即结束，不要自行猜测继续"）。

编排器 → 子 Agent（下轮 context.md 注入，非 stdin）：
```markdown
## Prior Decisions（来自此 task 之前的问答轮次）
- [q-3 L2] "选重构方案？" → 决策：A（class 封装）。决策者：user
```

**问题分级规则**（编排器侧实现，与 CLI 工具解耦）：

| 级别 | 触发条件 | 处理方式 |
|------|----------|----------|
| L0 | 格式选择、命名风格等无风险问题 | 编排器规则库/主 Agent 自动答复 |
| L1 | 重构方案、依赖版本等中风险问题 | 编排器给建议，倒计时 N 秒无用户响应自动采纳 |
| L2 | 删除文件、核心逻辑、外部 API 等高风险问题 | SSE 推到 UI，必须用户点选，无超时 |

### 5.3 主 Agent 调度核心逻辑（Ralph Loop + 问答分支）

```javascript
async ralphLoop() {
  while (true) {
    const readyTask = this.selectNextTask();           // 拓扑排序选就绪任务
    if (!readyTask) {
      if (this.allTasksCompleted()) break;
      await this.sleep(1000); continue;
    }

    // spawn 子 Agent 前自检配置态
    if (!await this.isConfigOverwritten()) {
      throw new Error('配置未被代理覆盖，请先激活路由');
    }

    const exitCode = await this.spawnFreshAgent(readyTask);

    // 问答分支：退出时若有未决 question，跳过验证，处理问答后重 spawn
    if (this.hasPendingQuestion(readyTask)) {
      await this.handleQuestion(readyTask);            // L0自动/L1倒计时/L2等用户
      readyTask.status = 'pending';                    // 重新排队，下轮带答案重 spawn
      continue;
    }

    // 正常分支：执行验证脚本
    const result = await this.runVerification(readyTask);
    if (result.success) {
      readyTask.status = 'completed';
      if (this.config.atomicCommits) await this.gitCommitOnSuccess(readyTask);  // 验证通过才 commit
    } else {
      readyTask.retryCount++;
      if (readyTask.retryCount >= this.config.retryCount) {
        readyTask.status = 'failed';
        if (this.config.atomicCommits) await this.gitResetToTaskStart(readyTask); // 失败 reset 到 task 起点
        await this.handleTaskFailure(readyTask);
      } else {
        readyTask.status = 'pending';
      }
    }
    await this.saveState();
  }
}
```

**v4 关键特性**：
1. **问答分支**：退出时检测未决 `«ATO_QUESTION»`，跳过验证、重 spawn（F-20a）。
2. **验证即出口**：`runVerification()` 执行外部脚本，exit 0 = 通过。
3. **配置态自检**：spawn 前 `isOverwritten` 检查（F-68）。
4. **原子提交顺序明确**：验证通过才 commit，失败 reset 到 task 起点（修正 v3.1 模糊处）。
5. **Token 预算复用**：不新建计数器，团队 AccessKey 的 token limit 在代理侧 429 硬停止（F-49）。

### 5.4 两层混合路由（v4 核心差异化）

**Layer 1（task 级，编排器决定）**：
- DAG 生成时，每个 task 绑定一个 `routeId`（引用 AICodeSwitch 现有 Route）。
- 子 Agent 的请求携带 `x-ato-task-id` header，并走该 task 绑定的 routeId 对应路由。

**Layer 2（请求级，代理自动决定，零代码复用）**：
- 子 Agent 进程发出的每个请求，AICodeSwitch 代理的 `determineContentType`（`proxy-server.ts:2330`）按 thinking/background/long-context 自动切 Rule/模型。
- 编排器零代码、零配置即拿到请求级模型分层。

**组合示例**：
```
task "实现 X 功能" → routeId: routeA
  routeA 内部规则：
    - thinking 请求 → Claude Sonnet（强模型）
    - background / count_tokens → Haiku（最便宜）
  结果：成本在请求级自动分层，task 无需感知
```

**high-iq 升级阀（复用，F-64）**：
- context.md 指导子 Agent："遇到特别难的部分，在消息里用 `[!]` 前缀临时切到强模型规则；用 `[x]` 取消"。
- 复用 AICodeSwitch 已有的 `prepareHighIqRouting`（`proxy-server.ts:2589`），不新增机制。

### 5.5 双层成本归因（v4 新增）

| 归因维度 | 来源 | 实现 |
|---|---|---|
| task 级成本 | 子 Agent 请求的 `x-ato-task-id` header | `finalizeLog`（`proxy-server.ts:4054`）读 header → 写 `RequestLog` → 编排器按 task 聚合到 `.team/state.json`（**唯一需动代理内核的小改动**） |
| 请求级模型分布 | 现有 performance-tracker 的 vendor→service→model 聚合 | 零改动复用 |

**组合报表（F-65，TeamsPage）**：
```
task-3：共 12k tokens
  ├─ thinking 规则（Sonnet）：8k
  ├─ background（Haiku）：3k
  └─ default（Sonnet）：1k
```
这是单层路由竞品给不出的成本视图，应作为产品演示亮点。

### 5.6 工作目录结构

```
project/
├── .team/
│   ├── logs.jsonl              # 团队日志（NDJSON，无 CRC）
│   ├── state.json              # 任务状态（恢复用）
│   ├── tasks/
│   │   └── sub-1/
│   │       ├── context.md      # 每次运行前重新生成（含 ## Prior Decisions 段）
│   │       ├── spec.md         # 任务规格（不变）
│   │       ├── verification.sh # 验证脚本
│   │       └── decisions.json  # 本 task 的历史问答
│   └── artifacts/              # 子 Agent 产出物
└── config/
    └── orchestrator.json       # 编排配置（不含上游定义，委托 Route）
```

**context.md 结构（v4）**：
```markdown
# Task: ${task.description}

## Prior Decisions（来自此 task 之前的问答轮次）
- [q-3 L2] "选重构方案？" → 决策：A。决策者：user

## Dependencies Completed
- **sub-0**: ${dep.summary}（Artifacts: ${dep.artifacts}）

## Your Goal
${task.expectedOutput}

## Verification
Your work will be verified by: `${task.verificationScript}`

## Routing Hint（可选）
如遇难题可用 [!] 前缀临时升级到强模型；[x] 取消。
```

### 5.7 配置文件示例（v4 精简）

```json
{
  "defaultAgent": "claude-code",
  "maxConcurrency": 1,
  "ralphLoopMode": true,
  "taskTimeout": 300,
  "retryCount": 2,
  "questionApprovalRules": {
    "autoL0": true,
    "autoL1TimeoutSeconds": 5,
    "forceL2Keywords": ["删除", "drop", "delete", "外部API"]
  },
  "workspaceStrategy": "hybrid",
  "enableFileLocking": true,
  "tokenBudget": {
    "teamAccessKeyId": "sk_...",      // v4：引用团队预算 AccessKey，复用其 token limit
    "perTaskSoftLimit": 50000          // 单任务软上限（编排器侧核算）
  },
  "verificationDefaults": { "timeout": 30000 },
  "subAgentLimits": {
    "maxCpuTimeSeconds": 300,
    "maxMemoryMB": 2048,
    "maxLogLineBytes": 10240,
    "maxConsecutiveIdenticalQuestions": 3
  },
  "failureStrategy": "replan",
  "atomicCommits": true,
  "agents": {
    "claude-code": { "enabled": true, "path": "claude", "priority": 1 },
    "codex": { "enabled": true, "path": "codex", "priority": 2 }
  },
  "logLevel": "info"
}
```

**v4 变化**：
- 删除 `agents.<name>.features` 上游重复定义（上游委托 Route，F-61）。
- 删除 `agents.<name>.adapterConfig`（第三方适配器远期）。
- `tokenBudget` 改为引用团队 AccessKey（F-49），不新建计数器。
- task→routeId 映射在 DAG 任务对象里（F-62），不在全局配置。

---

## 6. 非功能需求

| ID | 需求 | 指标 |
|----|------|------|
| N-01 | 可扩展性 | 支持同时运行最多 10 个子 Agent |
| N-02 | 容错性 | 主 Agent 崩溃后可从 `.team/state.json` 恢复；编排子进程崩溃不影响代理主服务 |
| N-03 | 可观测性 | 复用 AICodeSwitch 日志/指标/会话系统 |
| N-04 | 跨平台 | macOS / Linux / Windows WSL2 |
| N-05 | 响应延迟 | stdout 到调度响应 < 500ms |
| N-06 | v4 新增 | 代理主服务（4567）可用性不受编排模块影响（fork 隔离） |

---

## 7. 用户界面设计

### 7.1 TeamsPage 实时视图（群聊风格，复用现有 React 框架）

```
[10:30:00] 🧠 Leader: Agent 健康检查...
[10:30:00] ✅ claude-code: available
[10:30:00] ✅ codex: available

[10:30:10] 🔧 sub-1 (claude-code): 🚀 开始执行 (route: routeA)
[10:30:15] 🔧 sub-1 (claude-code): ❓ «选重构方案？» [L2]
[10:30:25] 🧠 Leader: 📢 答复 sub-1: 选择方案A (decidedBy: user)
[10:30:26] 🔧 sub-1 (claude-code): 🔄 带答案重新执行...
[10:30:36] ✅ sub-1 (claude-code): 验证通过 (npm test)
[10:30:36] 📝 sub-1: git commit "✅ sub-1 completed"

[10:30:37] 🔨 sub-2 (codex): 🚀 开始执行 (route: routeB)
[10:30:50] ✅ sub-2 (codex): 验证通过
```

- 复用现有主题/侧边栏/Toast/Confirm 组件，纯 CSS variables。
- DAG 节点状态用颜色（灰/黄/绿/红），不引图形库。
- 问答 L2 弹窗用现有 Confirm 组件。

### 7.2 命令/API

| 命令 / API | 说明 |
|------|------|
| `POST /api/orchestrator/teams`（或 UI"新建团队"） | 启动新团队任务 |
| `GET /api/orchestrator/:teamId/status` | 查看团队状态 |
| `GET /api/orchestrator/:teamId/logs/stream` | SSE 实时日志 |
| `POST /api/orchestrator/:teamId/stop` | 停止团队 |
| `POST /api/orchestrator/:teamId/resume` | 恢复中断的任务 |
| 子 Agent 会话历史 | 复用现有会话页（每个子 Agent 一个 sessionId） |
| 双层成本报表 | TeamsPage 内 task 详情面板 |

---

## 8. 异常处理

| 场景 | 处理方式 |
|------|----------|
| 子 Agent 进程崩溃 | 记录日志，根据配置决定是否重启（最多 `retryCount` 次） |
| 子 Agent 超时 | SIGTERM 终止，标记失败，按 `failureStrategy` 处理 |
| 子 Agent 失控（死循环） | 5 秒内输出超 100 行或 CPU 持续 > 95%，强制 SIGKILL |
| 子 Agent 失控（频繁询问） | 连续 3 次相同问题，自动答复默认选项并警告 |
| 子 Agent 失控（异常输出） | 单行日志超 10KB，截断并标记异常 |
| **配置态翻转竞态（v4 新增）** | 软锁 `atoActiveTeamCount > 0` 时，restore 入口拒绝；spawn 前自检 `isOverwritten` |
| **fork 编排子进程崩溃（v4 新增）** | 主进程检测后独立重启，代理主服务零感知；递减 atoActiveTeamCount 兜底 |
| 主 Agent 自身崩溃 | 重启后从 `.team/state.json` 恢复任务状态 |
| 用户中断 | 捕获信号，先 SIGTERM 所有子 Agent，等最多 5 秒后 SIGKILL，保存状态 |
| 任务依赖失败传播 | 按 `failureStrategy`：abort / skip / replan |
| 文件锁死锁 | 超时 10 秒后强制释放 |
| **atomic commit 失败处理（v4 明确）** | 验证通过才 commit；失败则 `git reset` 到 task 起点，不留脏 commit |

---

## 9. 与 AICodeSwitch 的复用映射

> v3.1 此章是"集成方案候选"，v4 改为已确定的复用映射表（见 1.4）。

**协同收益**：

| AICodeSwitch 能力 | 对 ATO 的价值 |
|-------------------|------------------|
| 路由规则（thinking/long-context/content-type） | 子 Agent 自动按请求内容选最优模型（Layer 2） |
| Route 系统 | task 直接引用 routeId 作为上游策略（Layer 1，F-61） |
| 会话追踪 | 每个子 Agent 的完整对话历史可追溯（复用会话页） |
| Token 统计 | 精确核算每个子任务的成本 + 双层归因（F-65） |
| AccessKey 配额 | 团队预算硬停止（F-49） |

---

## 10. 里程碑与交付计划

| 阶段 | 时间 | 交付物 | 关键验证点 |
|------|------|--------|-----------|
| **P0 - De-risk + 骨架** | 第1周 | **3 个 de-risk 实验** + fork 隔离骨架 + stdout 协议单向验证 + Claude Code 适配器 | ✅ ① Claude Code headless 下 AskUserQuestion 行为实测（同时验证 stdout 协议更稳）<br>✅ ② spawn 子进程走代理 + finalizeLog 能拿到 token usage<br>✅ ③ 验证脚本 exit code 可靠传递（fail/pass 各 5 次）<br>✅ ④ 适配器接口设计能支撑 Codex 接入 |
| **P1 - Ralph Loop 核心** | 第2-3周 | 任务分解 + DAG 验证 + Ralph Loop（含问答分支）+ 验证脚本执行引擎 + Codex 适配器 | ✅ 单个 Ralph Loop 完成 3 个串行任务<br>✅ 验证脚本正确判断成败<br>✅ stdout 协议问答闭环（问→退出→答→重 spawn）<br>✅ claude-code 与 codex 混用无冲突 |
| **P2 - 完整流程** | 第4周 | TeamsPage（DAG 可视化 + 实时日志）+ 断点续传 + 两层混合路由落地 + `x-ato-task-id` 归因 | ✅ 完整 5 任务 DAG 执行成功<br>✅ 双层成本报表可见<br>✅ 崩溃恢复成功 |
| **P3 - 生产级可靠性** | 第5周 | 失控熔断 + 配置态软锁 + 工作目录策略 + 错误恢复 | ✅ 注入失控 Agent 能正确熔断<br>✅ 团队运行中 restore 被软锁拒绝<br>✅ fork 编排子进程崩溃后独立恢复 |
| **P4 - 优化与扩展** | 第6-8周 | 性能调优 + 文档 + 示例项目 + 通用适配器模板（远期） | ✅ Token 统计准确（误差 < 5%）<br>✅ 至少 1 个第三方 Agent 工具适配器示例 |

**关键里程碑门控**：
- **P0 → P1**：3 个 de-risk 实验全部通过，且 stdout 协议被验证比 stdin 更稳。
- **P1 → P2**：Ralph Loop 稳定，单轮验证成功率 > 95%，两种工具混用无冲突，问答闭环可用。
- **P2 → P3**：两层混合路由落地，双层成本报表准确。
- **P3 → P4**：配置态软锁与 fork 隔离有效，主服务可用性不受影响。

---

## 11. 附录

### 11.1 与现有方案的对比

| 方案 | 定位 | ATO v4 差异化 |
|------|------|------------|
| OpenClaw | 完整 Agent 框架 | 纯编排，不执行逻辑 |
| LangGraph | 图状态机 | 使用真实 Claude Code 进程 |
| AutoGen | 多 Agent 对话 | 轻量级，无额外依赖 |
| Claude Code Agent Teams | Claude Code 内置多 Agent | ATO 跨工具 + **两层混合路由（请求级模型异构）** |
| claude-flow | 多 Agent 群体 | ATO 复用 AICodeSwitch 网关/统计/配额，编排层更薄 |

### 11.2 风险与缓解

| 风险 | 概率 | 缓解措施 |
|------|------|----------|
| Claude Code 输出格式变更 | 中 | 适配层隔离，格式解析集中在适配器 |
| **AskUserQuestion headless 行为不确定** | 高 | **v4 直接放弃 stdin 拦截，改 stdout 协议；P0 实测验证** |
| **验证脚本可写性（v4 调高）** | **高** | **MVP 收窄到"有测试的代码任务"；提供 3 个内置验证器；主 Agent 自动生成常见验证脚本** |
| **长 DAG 重复注入成本（v4 新增）** | 中 | P0 实测单 task 平均 token，与长驻模式对比；只注入必要上下文 |
| **配置写入竞态（v4 新增）** | 中 | 配置态软锁 + spawn 前自检 + 停服顺序（先回收子 Agent） |
| 子 Agent 资源占用过高 | 中 | 限制并发数、资源限制、工作目录隔离 |
| 子 Agent 间产出物格式不一致 | 中 | 强制声明 expectedOutput schema，主 Agent 校验 |
| Token 预算超支 | 中 | 复用 AccessKey token limit，90% 警告、100% 硬停止 |

### 11.3 待验证的关键技术假设

1. **Claude Code headless 下 AskUserQuestion 行为**：P0 实测；v4 已用 stdout 协议兜底，即使该假设不成立也能跑。
2. **stdout 协议闭环**：子 Agent 能否稳定遵守"输出标记块后立即退出"。
3. ~~**fs.watch 跨平台可靠性**~~：v4 删除（直采 stdout，不依赖 fs.watch）。
4. **子 Agent 上下文携带成本**：评估重复注入的 token 占用，与长驻模式对比（新增量化要求）。
5. **验证脚本的覆盖度**：MVP 限定甜蜜区（有测试的代码任务）。
6. **`x-ato-task-id` header 归因**：代理 `finalizeLog` 读 header 写日志的小改动可行。

### 11.4 术语表

| 术语 | 定义 |
|------|------|
| **Ralph Loop** | 迭代式 Agent 调度：原子任务 + 验证门控 + 全新上下文窗口 |
| **两层混合路由（v4）** | task 级（routeId）+ 请求级（content-type 自动切模型）双层路由 |
| **stdout 协议（v4）** | 子 Agent 用 `«ATO_QUESTION»` 标记输出问题、退出、下轮注入答案的问答协议 |
| **配置态软锁（v4）** | 团队运行期间 `atoActiveTeamCount > 0` 阻止配置 restore |
| **Verification Gate** | 外部验证（测试/编译/检查），决定任务是否完成 |
| **Stateless Run** | 每次 Agent 运行是全新进程 + 全新上下文 |
| **Hard Stop / Eval Gate / Circuit Breaker** | 语法级 / 功能级 / 行为级验证 |
| **Atomic Commit** | 验证通过才 commit，失败 reset 到 task 起点 |

### 11.5 参考资料

继承 v3.1 的 Loop Engineering 参考资料（Ralph Loop、Agent Loop PAOR、验证门控、状态管理、Guardrails）。新增：
- AICodeSwitch 代码库实地探索结论（见本仓库 `CLAUDE.md` 与本次头脑风暴纪要）。

---

**文档版本**: 4.0（AICodeSwitch 嵌入式版）
**最后更新**: 2026-06-17
**变更日志**: `supervisor-agent-v4-changelog.md`
**上一版本**: v3.1（Extensible Agent Adapter Edition），保留为历史参考
