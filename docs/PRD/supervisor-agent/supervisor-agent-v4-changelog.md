# Supervisor Agent PRD v4 升级说明

## 概述

PRD 从 v3.1 升级到 **v4.0（AICodeSwitch 嵌入式版）**。这次升级不是功能堆叠，而是**方向性重构**：基于对 AICodeSwitch 现有代码库的实地探索，重新认识了 ATO 与 AICodeSwitch 的关系，并据此收敛了架构、问答机制、差异化主线。

**核心转向**：
- **定位**：ATO 从"独立系统 + 可选集成"变为"AICodeSwitch 的可选编排模块"。AICodeSwitch 是地基，不是集成对象。
- **形态**：直接采用厚路径（内嵌），删去 v3.1"先独立 CLI（B）再迁移内嵌（A）"的迁移叙事。
- **问答**：放弃脆弱的 stdin 拦截 `AskUserQuestion`，改用 **stdout 协议约定**。
- **差异化**：把"**两层混合路由**"提升为核心卖点。
- **MVP**：收窄到"有测试的代码任务"甜蜜区。

---

## 🎯 核心目标

**从**："基于任意 CLI Agent 工具的多 Agent 协作编排系统（独立部署，后期集成 AICodeSwitch）"
**到**："**AICodeSwitch 的可选编排模块**，复用其网关/统计/会话/配额/路由能力，自身只实现编排核心"

---

## 🏗️ 关键架构变更

### 1. 厚路径 + fork 隔离（v4 核心架构）

v3.1 把集成方案（A 内置 / B 独立 CLI）当待选项。v4 基于代码探索直接选定**厚路径**，并用 **fork 隔离**解决其崩溃风险：

- ATO 编排逻辑作为**独立 fork 子进程**运行（`src/server/orchestrator/`）。
- AICodeSwitch 主进程只开 `/api/orchestrator/*` 指挥端口。
- 编排子进程崩溃可独立重启，代理主服务（4567）零感知。

**理由**：探索发现 ATO 的绝大部分刚需 AICodeSwitch 已提供（子进程自动走代理、Token 统计、会话隔离、配额硬停止、请求级路由），厚路径的复用红利最大；而 fork 隔离消除了"崩溃拖垮代理"的顾虑。

### 2. 问答机制：stdin → stdout 协议（v4 核心改写）

v3.1 押注 stdin 拦截 `AskUserQuestion`（风险"高"）。v4 改用 **stdout 协议约定**：

- 子 Agent 在 context.md 指示下，输出 `«ATO_QUESTION»{...}«/ATO_QUESTION»` 标记块后**立即退出**。
- 编排器解析后，把答案写入**下一轮** context.md 的 `## Prior Decisions` 段，重新 spawn 同一 task。
- **一套协议覆盖 claude-code（stream-json）和 codex（纯文本）两种适配器**——这是放弃 stdin 的核心收益。

**理由**：headless 下 AskUserQuestion 行为不确定；Codex 无 stdin；stdout 协议天然契合 Ralph Loop"退出后重启"的模型，且让 L0/L1/L2 分级落在编排器侧（与 CLI 工具解耦）。

### 3. 两层混合路由（v4 核心差异化）

v3.1 的 `taskAgentMapping` 只做 task 级异构。v4 提炼出**两层混合路由**作为核心卖点：

- **Layer 1（task 级）**：DAG 生成时每个 task 绑定 `routeId`（引用 AICodeSwitch 现有 Route）。
- **Layer 2（请求级，零代码复用）**：代理 `determineContentType` 按 thinking/background/long-context 自动切模型。
- 组合效果：成本在请求级自动分层，编排器零配置即拿到。
- **high-iq 升级阀（复用）**：子 Agent 用 `[!]`/`[x]` 前缀临时切强模型规则，复用现有 `prepareHighIqRouting`。

这是 Claude Code Agent Teams / claude-flow / AutoGen 都做不到的，应作为产品演示亮点。

---

## 📊 功能需求变更

### 新增需求

| ID | 描述 | 章节 |
|----|------|------|
| F-59 | `x-ato-task-id` header 归因（代理 finalizeLog 读 header 写日志） | 4.9 |
| F-60 | 配置态软锁（`atoActiveTeamCount`） | 4.10 |
| F-61 | task→routeId 直接引用现有 Route（厚路径去重） | 4.1 |
| F-62 | Layer 1 task 级路由（routeId 绑定） | 4.9 |
| F-63 | Layer 2 请求级路由（复用 determineContentType） | 4.9 |
| F-64 | high-iq 升级阀（复用 prepareHighIqRouting） | 4.9 |
| F-65 | 双层成本报表 | 4.9 |
| F-66 | fork 编排子进程 + `/api/orchestrator/*` 指挥端口 | 4.10 |
| F-67 | 编排子进程崩溃独立重启 | 4.10 |
| F-68 | spawn 前配置态自检 | 4.10 |
| US-09 | 查看每个子任务成本的两层模型分布 | 2 |

### 改写需求

| ID | v3.1 | v4 |
|----|------|------|
| F-20 | stdin 监听 AskUserQuestion | **stdout 协议**：输出 `«ATO_QUESTION»` 标记块后退出 |
| F-21 | stdin 接收 answer | **改写为 F-20a**：下轮 context.md 注入 `## Prior Decisions` |
| F-13 | fs.watch 监听日志 | **直采 stdout**（不依赖 fs.watch） |
| F-49 | 自建全局 Token 计数器 | **复用团队 AccessKey 的 token limit**（429 硬停止） |
| F-50 | 总量/单任务限制（自建） | 总量复用 AccessKey，单任务由编排器软核算 |

### 降级/砍除

| ID | v3.1 描述 | v4 处理 | 理由 |
|----|----------|---------|------|
| F-28 | 每 10 条日志状态快照 | **砍** | 本地单用户工具过度工程化 |
| F-29 | 日志行 CRC32 校验 | **砍** | 同上，损坏重放成本极低 |
| F-58 | 配置文件加载第三方适配器 | **移出 MVP（远期）** | 先死磕 claude-code + codex 两个内置适配器 |
| §11.6 | 适配器市场 / npm 发布 | **远期愿景** | MVP 不碰 |
| Token Budget Tracker 模块 | 自建计数器 | **删除模块** | 复用 AccessKey quota |
| Logger CRC/轮转 | 带校验日志 | **简化** | 直采 stdout |

---

## 🗺️ 里程碑变更

### P0 重构：De-risk 优先

v3.1 的 P0 是"基础进程管理 + 适配器 + 单 Agent 示例"。v4 改为**先跑 3 个 de-risk 实验**，把高风险假设先消掉：

1. **AskUserQuestion headless 行为实测**（同时验证 stdout 协议更稳）
2. **子进程走代理 + token 可统计**（验证复用基础设施）
3. **验证脚本 exit code 可靠性**

加上 fork 隔离骨架 + stdout 协议单向验证 + Claude Code 适配器。

### 后续阶段

- P1：Ralph Loop 核心，**新增问答分支验证**（问→退出→答→重 spawn 闭环）。
- P2：TeamsPage + 两层混合路由落地 + `x-ato-task-id` 归因。
- P3：失控熔断 + **配置态软锁** + fork 崩溃恢复。
- P4：删除"适配器市场"相关交付物，改为性能调优 + 文档 + 远期适配器示例。

---

## ⚠️ 风险与假设变更

### 风险调整

| 风险 | v3.1 | v4 |
|------|------|------|
| AskUserQuestion headless 行为 | 高（缓解弱） | 高，**但已用 stdout 协议兜底，P0 实测** |
| 验证脚本可靠性 | 中 | **验证脚本"可写性"调为高**，MVP 收窄甜蜜区 |
| — | — | **新增**：长 DAG 重复注入成本（无状态未必省钱） |
| — | — | **新增**：配置写入竞态（软锁 + 自检 + 停服顺序） |

### 假设调整

- **删除**：fs.watch 跨平台可靠性（v4 直采 stdout，不依赖 fs.watch）。
- **新增**：无状态重复注入成本 vs 长驻模式的量化对比（P0 实测）。
- **新增**：`x-ato-task-id` header 归因在代理内核的可行性（小改动）。

---

## 🔧 配置文件变更

| 配置项 | v3.1 | v4 |
|--------|------|------|
| `agents.<name>.features` | 上游能力定义 | **删除**（上游委托 Route） |
| `agents.<name>.adapterConfig` | 第三方适配器配置 | **删除**（远期） |
| `tokenBudget.total/perTask` | 自建计数器 | 改为 `tokenBudget.teamAccessKeyId`（复用 AccessKey）+ `perTaskSoftLimit` |
| `taskAgentMapping` | 全局配置 | 移到 DAG 任务对象（task.routeId） |

---

## 📊 对比总结

| 维度 | v3.1 | v4 |
|------|------|------|
| **定位** | 独立系统 + 可选集成 | AICodeSwitch 的可选编排模块 |
| **形态** | 先独立 CLI（B）再迁移内嵌（A） | 直接厚路径 + fork 隔离 |
| **问答机制** | stdin 拦截 AskUserQuestion | stdout 协议（`«ATO_QUESTION»`） |
| **差异化主线** | Agent 适配器可扩展 | **两层混合路由** |
| **Token 预算** | 自建计数器 | 复用 AccessKey quota |
| **MVP 任务域** | 通用 | 收窄到"有测试的代码任务" |
| **过度工程** | CRC32 / 适配器市场 / fs.watch | 砍除 |
| **配置态竞态** | 未提 | 软锁根治 |
| **atomic commit 顺序** | 模糊 | 验证通过才 commit，失败 reset |
| **核心新写** | 8+ 模块 | 4 件（调度器/验证器/进程管理/DAG） |

---

## 💡 实施建议

1. **P0 必须先跑 3 个 de-risk 实验**，任一关键假设崩了就调整设计。
2. **协议先行**：`.team/` 结构、`context.md` 格式、`«ATO_QUESTION»` 契约、`x-ato-task-id` header 先定死。
3. **唯一动代理内核的点**：`finalizeLog` 读 `x-ato-task-id` 写日志，其余全复用。
4. **MVP 死磕甜蜜区**：有测试的代码任务 + claude-code/codex 两个内置适配器。

---

**文档版本**: v4.0（AICodeSwitch 嵌入式版）
**升级时间**: 2026-06-17
**关键变化**: 从"独立系统+可选集成"到"AICodeSwitch 嵌入式编排模块"；问答 stdin→stdout；差异化聚焦两层混合路由
**向后兼容**: 与 v3.1 无运行时兼容关系（均为设计文档）；v3.1 保留为历史参考
