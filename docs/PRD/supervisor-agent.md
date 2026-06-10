以下是根据我们讨论内容整理的 PRD 文档，已保存为 Markdown 文件供您下载。

```md
# Agent 团队编排系统 PRD

## 1. 项目概述

### 1.1 项目名称
Agent Team Orchestrator (ATO) —— 基于 Claude Code / Codex 的多 Agent 协作编排系统

### 1.2 项目目标
构建一个纯编排层的多 Agent 系统，**不包含任何 Agent 执行逻辑**，仅负责启动、监控、协调多个 Claude Code / Codex 子 Agent 来完成复杂任务。主 Agent 充当 Leader 角色，动态创建团队并调度任务。

### 1.3 核心理念
- **编排即调度**：系统本身不执行 AI 推理、不调用工具
- **Agent 即进程**：每个子 Agent 是一个独立的 Claude Code / Codex 进程
- **通信即日志**：所有 Agent 通过结构化日志文件沟通，实现类群聊协作
- **主 Agent 驱动**：所有调度决策由主 Agent 完成

---

## 2. 用户故事

| 编号 | 角色 | 需求描述 |
|------|------|----------|
| US-01 | 开发者 | 我希望输入一个复杂任务（如“分析代码质量并生成报告”），系统自动分解为多个子任务 |
| US-02 | 开发者 | 我希望看到多个 Agent 以群聊形式实时展示工作进展 |
| US-03 | 开发者 | 我希望当某个子 Agent 遇到选择性问题时，主 Agent 能自动决策或请求我介入 |
| US-04 | 开发者 | 我希望整个执行过程可追溯，所有 Agent 的状态和产出都有记录 |
| US-05 | 开发者 | 我希望系统能自动处理任务依赖（如 B 等待 A 完成后才执行） |
| US-06 | 开发者 | 我希望系统支持断点续传（崩溃后从上次进度恢复） |

---

## 3. 系统架构

### 3.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                        用户界面 (CLI / Web)                      │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      主 Agent (Leader)                          │
│  - 任务分解（调用 Claude Code 生成子任务 DAG）                    │
│  - 子进程管理（启动/停止/监控所有子 Agent）                       │
│  - 调度决策（依赖管理、问题应答、超时处理）                       │
│  - 日志聚合（写入团队日志文件）                                  │
└───────────────┬───────────────┬───────────────┬─────────────────┘
                │               │               │
        ┌───────▼───────┐ ┌───────▼───────┐ ┌───────▼───────┐
        │  子 Agent 1   │ │  子 Agent 2   │ │  子 Agent 3   │
        │ (Claude Code) │ │ (Claude Code) │ │   (Codex)     │
        └───────────────┘ └───────────────┘ └───────────────┘
```

### 3.2 模块划分

| 模块 | 职责 | 技术依赖 |
|------|------|----------|
| **Process Manager** | 启动/终止子进程，管理 stdio 流 | Node.js `child_process` |
| **Task Decomposer** | 调用主 Agent 将用户需求拆解为 DAG | Claude Code (stream-json) |
| **Scheduler** | 拓扑排序执行任务，控制并发 | 自定义 DAG 引擎 |
| **Logger** | 追加/读取团队日志文件 | `fs.createWriteStream` + `fs.watch` |
| **Question Handler** | 处理子 Agent 的询问，决策或转发给用户 | 自定义 JSON 协议 |
| **State Persistence** | 持久化任务状态，支持恢复 | SQLite / JSON 文件 |

---

## 4. 核心功能需求

### 4.1 团队创建与任务分解

| ID | 需求描述 | 优先级 |
|----|----------|--------|
| F-01 | 主 Agent 接收用户自然语言任务，调用 Claude Code 生成子任务列表 | P0 |
| F-02 | 子任务列表包含：id、description、dependencies（依赖关系）、expectedOutput | P0 |
| F-03 | 主 Agent 根据子任务列表为每个子任务创建一个子 Agent 进程 | P0 |
| F-04 | 子 Agent 进程的工作目录可配置（独立副本或共享目录） | P1 |

### 4.2 多 Agent 协作与群聊形式

| ID | 需求描述 | 优先级 |
|----|----------|--------|
| F-05 | 所有 Agent（主+子）通过追加日志文件的方式进行通信 | P0 |
| F-06 | 日志格式为 NDJSON，每条包含：timestamp、agentId、type、content | P0 |
| F-07 | 系统提供 CLI 界面实时显示日志流，不同 Agent 用不同颜色标识 | P1 |
| F-08 | 支持用户向特定 Agent 发送消息（通过日志注入特殊条目） | P2 |

### 4.3 进度追踪与记录

| ID | 需求描述 | 优先级 |
|----|----------|--------|
| F-09 | 日志文件记录每个 Agent 的：开始时间、当前进度、产出物路径、完成状态 | P0 |
| F-10 | 日志文件记录 Agent 之间的依赖和协作请求 | P0 |
| F-11 | 支持通过命令查看当前所有 Agent 状态快照 | P1 |
| F-12 | 支持导出完整执行报告（JSON / HTML） | P2 |

### 4.4 主 Agent 调度与决策

| ID | 需求描述 | 优先级 |
|----|----------|--------|
| F-13 | 主 Agent 通过 `fs.watch` 监听日志文件变化，实时响应 | P0 |
| F-14 | 主 Agent 维护任务 DAG，当依赖任务完成后自动启动下游任务 | P0 |
| F-15 | 主 Agent 检测到子 Agent 发出的询问（type=question），按规则自动答复或请求用户输入 | P0 |
| F-16 | 主 Agent 支持超时检测：任务运行超过阈值时标记失败并重新规划 | P1 |
| F-17 | 主 Agent 支持任务失败重试（可配置重试次数） | P1 |
| F-18 | 主 Agent 支持子 Agent 崩溃后的自动重启 | P2 |

### 4.5 子 Agent 通信协议

| ID | 需求描述 | 优先级 |
|----|----------|--------|
| F-19 | 子 Agent 启动参数支持 `--output-format stream-json` | P0 |
| F-20 | 子 Agent 包装脚本能够捕获 Claude Code 的 `AskUserQuestion` 并转换为 `question` 消息 | P0 |
| F-21 | 子 Agent 监听 stdin，接收 `answer` 消息并转发给 Claude Code | P0 |
| F-22 | 子 Agent 在完成时输出 `result` 消息，包含产出物路径 | P0 |

---

## 5. 技术规格

### 5.1 通信协议

#### 5.1.1 日志文件格式 (`.team/logs.jsonl`)

```json
{"timestamp":"2025-01-15T10:30:00.000Z","agentId":"leader","type":"status","content":{"action":"started","description":"开始任务分解"}}
{"timestamp":"2025-01-15T10:30:05.000Z","agentId":"leader","type":"decision","content":{"action":"create_team","subtasks":["sub-1","sub-2"]}}
{"timestamp":"2025-01-15T10:30:10.000Z","agentId":"sub-1","type":"status","content":{"action":"progress","description":"分析代码库","progress":30}}
{"timestamp":"2025-01-15T10:30:15.000Z","agentId":"sub-1","type":"question","content":{"text":"选择重构方案？","options":["A","B"]}}
{"timestamp":"2025-01-15T10:30:16.000Z","agentId":"leader","type":"answer","content":{"questionId":"q-123","choice":"A"}}
{"timestamp":"2025-01-15T10:30:20.000Z","agentId":"sub-1","type":"result","content":{"artifacts":["artifacts/sub-1/report.json"]}}
```

#### 5.1.2 子 Agent 询问协议

```json
// 子 Agent → 主 Agent (stdout)
{
  "type": "question",
  "id": "q-<uuid>",
  "content": {
    "text": "问题描述",
    "options": ["选项1", "选项2"],
    "context": { "taskId": "sub-1", "currentFile": "src/main.js" }
  }
}

// 主 Agent → 子 Agent (stdin)
{
  "type": "answer",
  "questionId": "q-<uuid>",
  "choice": "选项1"
}
```

### 5.2 子 Agent 包装脚本模板

```javascript
// subagent-wrapper.js
import { spawn } from 'child_process';
import readline from 'readline';

const claude = spawn('claude', ['--output-format', 'stream-json'], {
  stdio: ['pipe', 'pipe', 'inherit']
});

// 接收主 Agent 的答复
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'answer') {
    claude.stdin.write(JSON.stringify({
      type: "tool_result",
      tool_use_id: msg.questionId,
      content: msg.choice
    }) + '\n');
  }
});

// 转发 Claude Code 的询问
claude.stdout.on('data', (chunk) => {
  const lines = chunk.toString().split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const output = JSON.parse(line);
      if (output.type === 'tool_use' && output.name === 'AskUserQuestion') {
        process.stdout.write(JSON.stringify({
          type: "question",
          id: output.id,
          content: output.input
        }) + '\n');
      } else {
        process.stdout.write(line + '\n');
      }
    } catch(e) {
      process.stdout.write(line + '\n');
    }
  }
});
```

### 5.3 主 Agent 调度核心逻辑

```javascript
class LeaderAgent {
  constructor() {
    this.tasks = new Map();        // taskId -> TaskState
    this.subprocesses = new Map(); // taskId -> ChildProcess
    this.logWatcher = null;
  }

  async start(userPrompt) {
    // 1. 任务分解
    const dag = await this.decompose(userPrompt);

    // 2. 初始化任务状态
    for (const task of dag.tasks) {
      this.tasks.set(task.id, { ...task, status: 'pending' });
    }

    // 3. 启动日志监听
    this.watchLogs();

    // 4. 开始调度
    this.schedule();
  }

  watchLogs() {
    fs.watch('.team/logs.jsonl', (eventType) => {
      if (eventType === 'change') {
        this.processNewLogs();
      }
    });
  }

  async processNewLogs() {
    const newLines = await this.readNewLines();
    for (const log of newLines) {
      if (log.type === 'question') {
        await this.handleQuestion(log);
      }
      if (log.type === 'result') {
        this.markTaskCompleted(log.agentId, log.content.artifacts);
        this.schedule(); // 触发调度，启动下游任务
      }
    }
  }

  async handleQuestion(questionLog) {
    const choice = await this.decide(questionLog);
    const proc = this.subprocesses.get(questionLog.agentId);
    proc.stdin.write(JSON.stringify({
      type: "answer",
      questionId: questionLog.id,
      choice: choice
    }) + '\n');
  }

  schedule() {
    const readyTasks = this.getReadyTasks(); // 依赖已满足且状态为 pending
    for (const task of readyTasks) {
      this.startSubAgent(task);
    }
  }
}
```

### 5.4 工作目录结构

```
project/
├── .team/
│   ├── logs.jsonl          # 团队日志
│   ├── state.db            # SQLite 持久化（可选）
│   └── artifacts/          # 子 Agent 产出物
│       ├── sub-1/
│       ├── sub-2/
│       └── ...
├── workspace/              # 共享工作区（代码文件等）
└── config/
    └── orchestrator.json   # 配置文件
```

### 5.5 配置文件示例

```json
{
  "maxConcurrency": 3,
  "taskTimeout": 300,
  "retryCount": 2,
  "autoApproveQuestions": false,
  "claudePath": "claude",
  "codexPath": "codex",
  "logLevel": "info"
}
```

---

## 6. 非功能需求

| ID | 需求 | 指标 |
|----|------|------|
| N-01 | 可扩展性 | 支持同时运行最多 10 个子 Agent |
| N-02 | 容错性 | 主 Agent 崩溃后可从日志恢复状态 |
| N-03 | 可观测性 | 提供日志、指标（如任务执行时间） |
| N-04 | 跨平台 | 支持 macOS / Linux / Windows WSL2 |
| N-05 | 响应延迟 | 日志变化到调度响应 < 500ms |

---

## 7. 用户界面设计

### 7.1 CLI 实时视图（群聊风格）

```
[10:30:00] 🧠 Leader: 开始任务分解...
[10:30:05] 🧠 Leader: 已创建团队 - 子任务: sub-1, sub-2

[10:30:10] 🔧 sub-1: 正在分析代码库... (30%)
[10:30:12] 🔨 sub-2: 等待依赖 sub-1...

[10:30:15] 🔧 sub-1: ❓ 选择重构方案？ [A) class封装 | B) 函数式模块]
[10:30:16] 🧠 Leader: 📢 答复 sub-1: 选择方案A

[10:30:20] 🔧 sub-1: ✅ 完成！产出: artifacts/sub-1/report.json
[10:30:21] 🔨 sub-2: 🚀 开始执行...
```

### 7.2 命令列表

| 命令 | 说明 |
|------|------|
| `ato run "任务描述"` | 启动新任务 |
| `ato status` | 查看当前所有 Agent 状态 |
| `ato logs [agentId]` | 查看日志（可选过滤 Agent）|
| `ato resume` | 恢复上次中断的任务 |
| `ato stop` | 停止所有 Agent |

---

## 8. 异常处理

| 场景 | 处理方式 |
|------|----------|
| 子 Agent 进程崩溃 | 主 Agent 记录日志，根据配置决定是否重启 |
| 子 Agent 超时 | 主 Agent 终止进程，标记失败，重新规划 |
| 日志文件写入冲突 | 使用排他锁或消息队列（如 p-queue）|
| 主 Agent 自身崩溃 | 重启后读取日志文件，重建任务状态 |
| 用户中断 (Ctrl+C) | 主 Agent 发送 SIGTERM 给所有子 Agent，保存状态 |

---

## 9. 里程碑与交付计划

| 阶段 | 时间 | 交付物 |
|------|------|--------|
| P0 - 原型 | 第1周 | 基础进程管理 + 日志追加 + 单个子 Agent 示例 |
| P1 - 核心 | 第2-3周 | 任务分解 + DAG 调度 + 问答协议 + CLI 实时视图 |
| P2 - 完善 | 第4周 | 断点续传 + 配置文件 + 错误恢复 |
| P3 - 优化 | 第5周 | 性能调优 + 文档 + 示例项目 |

---

## 10. 附录

### 10.1 与现有方案的对比

| 方案 | 定位 | ATO 差异化 |
|------|------|------------|
| OpenClaw | 完整 Agent 框架 | 纯编排，不执行逻辑 |
| LangGraph | 图状态机 | 使用真实 Claude Code 进程 |
| AutoGen | 多 Agent 对话 | 轻量级，无额外依赖 |

### 10.2 风险与缓解

| 风险 | 概率 | 缓解措施 |
|------|------|----------|
| Claude Code 输出格式变更 | 中 | 使用稳定版本的 CLI，适配层隔离 |
| 子 Agent 资源占用过高 | 中 | 限制并发数，支持工作目录隔离 |
| 日志文件过大 | 低 | 支持日志轮转（按大小或时间）|

---

**文档版本**: 1.0
**最后更新**: 2025-01-15
**负责人**: [待填写]
```

您可以复制上述 Markdown 内容保存为 `PRD-Agent-Team-Orchestrator.md` 文件。如需进一步调整格式或补充细节，请随时告知！