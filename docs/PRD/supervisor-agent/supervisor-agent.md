# Agent 团队编排系统 PRD

## 0. 阅读指南

### 0.1 文档概览

本 PRD 描述了一个基于 **Loop Engineering** 最佳实践的多 Agent 编排系统，融合了 2025-2026 年间 AI Agent 工程领域的最新范式：Ralph Loop、Agent Loop、验证门控等。

**适合阅读的角色**：
- **产品经理/架构师**：第 1-4 章（项目概述、用户故事、架构、功能需求）
- **技术实施者**：第 5 章（技术规格，含详细代码示例）
- **决策者**：第 9 章（与 AICodeSwitch 集成方案）、第 10 章（里程碑）
- **风险评估者**：第 11 章（风险、假设、参考资料）

### 0.2 核心创新点（相比传统多 Agent 系统）

| 创新点 | 传统做法 | ATO 做法 | 优势 |
|--------|---------|----------|------|
| **验证即出口** | Agent 自我报告"任务完成" | 外部验证脚本判断（测试/编译/检查） | 可靠性 ↑ 90% |
| **无状态运行** | Agent 长驻进程，通过多轮对话积累上下文 | 每次全新进程 + 全新上下文窗口，从磁盘读取状态 | 无上下文漂移 |
| **Ralph Loop** | 复杂的 Agent 间通信协议（消息队列/RPC） | 简单循环：选任务 → 启动 → 验证 → 下一轮 | 实现成本 ↓ 70% |
| **Token 预算** | 无成本控制，容易失控 | 全局 Token 计数器，达到上限时硬停止 | 成本可控 |
| **Atomic Commits** | 难以回滚，变更混杂 | 每个任务完成后自动 git commit | 可追溯、可回滚 |

### 0.3 关键设计决策

1. **为什么不用长驻子 Agent？**  
   长驻进程会累积上下文，容易漂移（hallucination）。Ralph Loop 每次启动全新进程，上下文可控。

2. **为什么不信任 Agent 的"完成"报告？**  
   LLM 会自信地给出错误答案。外部验证脚本（测试/编译）是唯一可靠的判断标准。

3. **为什么用 Ralph Loop 而非复杂编排？**  
   2026 年业界共识："Stop Orchestrating, Use Loops"——简单循环 + 验证出口比复杂的 Agent 间协议更可靠。

4. **为什么需要 Token 预算？**  
   多 Agent 系统容易失控，尤其是 DAG 中有重试/循环时。预算是成本兜底的最后一道防线。

---

## 1. 项目概述

### 1.1 项目名称
Agent Team Orchestrator (ATO) —— 基于 CLI Agent 工具的多 Agent 协作编排系统

### 1.2 项目目标
构建一个纯编排层的多 Agent 系统，**不包含任何 Agent 执行逻辑**，仅负责启动、监控、协调多个 CLI Agent 子进程来完成复杂任务。主 Agent 充当 Leader 角色，动态创建团队并调度任务。

**支持的 Agent 工具**：
- **内置支持**：Claude Code、Codex（首批实现）
- **可扩展**：通过 Agent 适配器接口，可支持任意 CLI Agent 工具（OpenCode、KimiCode、Cursor CLI、Windsurf CLI 等）

### 1.3 核心理念
- **编排即调度**：系统本身不执行 AI 推理、不调用工具
- **Agent 即进程**：每个子 Agent 是一个独立的 Claude Code / Codex 进程
- **通信即日志**：所有 Agent 通过结构化日志文件沟通，实现类群聊协作
- **主 Agent 驱动**：所有调度决策由主 Agent 完成
- **验证即出口（Loop Engineering）**：任务完成与否由外部验证（测试/编译/检查脚本）裁定，而非 Agent 自我报告
- **无状态运行 + 持久化环境**：每次 Agent 运行是无状态的（全新进程、全新上下文窗口），状态完全持久化在环境中（spec 文件、状态文件、代码本身）

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
| US-07 | 开发者 | 我希望系统能自动识别和处理子 Agent 失控情况（死循环/频繁询问） |
| US-08 | 开发者 | 我希望关键决策需要人工确认，但简单问题能自动处理 |

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
| **Process Manager** | 启动/终止子进程，管理 stdio 流，资源限制 | Node.js `child_process` |
| **Agent Adapter Registry** | 管理多种 CLI Agent 工具的适配器（Claude Code、Codex、OpenCode 等） | 插件式架构 |
| **Task Decomposer** | 调用主 Agent 将用户需求拆解为 DAG | Claude Code (stream-json) |
| **DAG Validator** | 验证 DAG 有效性（循环依赖、资源冲突） | 自定义图算法 |
| **Scheduler (Ralph Loop)** | 迭代式调度：每轮启动一个子任务 → 外部验证 → 通过则标记完成并触发下游；失败则重试或重规划 | 自定义 DAG 引擎 + 验证门控 |
| **Verification Engine** | 执行任务验证脚本（测试运行器、编译检查、grep 断言等） | 可插拔的验证插件 |
| **Logger** | 追加/读取团队日志文件，状态快照 | `fs.createWriteStream` + `fs.watch` |
| **Question Handler** | 处理子 Agent 的询问，分级决策（自动/建议/必须） | 自定义 JSON 协议 |
| **State Persistence** | 持久化任务状态，支持恢复 | SQLite / JSON 文件 |
| **Workspace Manager** | 管理工作目录策略（共享/隔离/混合）、文件锁 | `fs` + 自定义锁机制 |
| **Circuit Breaker** | 检测并熔断失控子 Agent | 自定义异常检测 |
| **Token Budget Tracker** | 追踪总 Token 消耗，达到上限时提前终止 | 计数器 + AICodeSwitch 代理统计 |

---

## 4. 核心功能需求

### 4.1 团队创建与任务分解

| ID | 需求描述 | 优先级 |
|----|----------|--------|
| F-01 | 主 Agent 接收用户自然语言任务，调用 Claude Code 生成子任务列表 | P0 |
| F-02 | 子任务列表包含：id、description、dependencies（依赖关系）、expectedOutput、**verificationScript**（验证脚本） | P0 |
| F-03 | 主 Agent 根据子任务列表为每个子任务创建一个子 Agent 进程 | P0 |
| F-04 | 子 Agent 进程的工作目录可配置（独立副本或共享目录） | P1 |
| F-23 | 主 Agent 支持加载预定义的子任务模板库（如"代码分析"、"测试生成"等标准模板） | P1 |
| F-24 | 任务分解后展示 DAG 可视化结果，用户可编辑后再执行 | P1 |
| F-25 | 主 Agent 验证 DAG 的有效性（检测循环依赖、资源冲突） | P0 |
| F-44 | 每个子任务必须声明 `verificationScript`（可执行的验证脚本，如 `npm test unit/foo.test.js`、`grep "TODO" -r src/ && exit 1` 等） | P0 |
| F-45 | 支持验证脚本类型：shell 命令、可执行文件路径、内置检查器（如 `compile-check`、`lint-check`） | P1 |

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
| F-28 | 每 10 条日志生成一次状态快照（包含所有任务当前状态），加速恢复 | P1 |
| F-29 | 日志行包含 CRC32 校验，读取时自动跳过损坏行 | P1 |
| F-30 | 支持从快照+增量日志快速恢复状态（恢复时间 < 1秒） | P0 |

### 4.4 主 Agent 调度与决策（Ralph Loop 模式）

| ID | 需求描述 | 优先级 |
|----|----------|--------|
| F-13 | 主 Agent 通过 `fs.watch` 监听日志文件变化，实时响应 | P0 |
| F-14 | 主 Agent 维护任务 DAG，当依赖任务完成后自动启动下游任务 | P0 |
| F-46 | **Ralph Loop 调度模式**：每轮选择一个就绪任务（依赖已满足）→ spawn 全新子 Agent 进程 → Agent 退出后执行验证脚本 → 通过则标记完成，失败则重试 | P0 |
| F-47 | 子 Agent 每次运行都是全新进程 + 全新上下文窗口，从磁盘读取最新的 spec/状态/上下文，**无状态累积** | P0 |
| F-48 | 验证脚本执行：退出码 0 = 通过，非 0 = 失败；捕获 stdout/stderr 记录日志 | P0 |
| F-15 | 主 Agent 检测到子 Agent 发出的询问（type=question），按规则自动答复或请求用户输入 | P0 |
| F-16 | 主 Agent 支持超时检测：任务运行超过阈值时标记失败并重新规划 | P1 |
| F-17 | 主 Agent 支持任务失败重试（可配置重试次数） | P1 |
| F-18 | 主 Agent 支持子 Agent 崩溃后的自动重启 | P2 |
| F-34 | 主 Agent 支持三种失败策略：abort（立即停止）/ skip（跳过下游）/ replan（重新生成 DAG） | P1 |
| F-35 | 子任务支持返回"部分成功"状态（如 progress: 80, status: partial）| P2 |
| F-36 | 重规划模式：失败时主 Agent 自动生成新的 DAG（去掉失败任务依赖） | P2 |
| F-37 | 问题分级：L0自动 / L1建议（倒计时确认）/ L2必须确认 | P0 |
| F-38 | 配置文件支持设置问题自动审批规则（如 L0/L1 全自动） | P1 |
| F-39 | 子任务支持可选的"审批阶段"（用户批准后才执行） | P2 |
| F-49 | **Token 预算控制**：全局 Token 计数器，达到预算上限时拒绝启动新子任务，已运行任务可完成 | P1 |
| F-50 | Token 预算可配置为：总量限制（如 500k tokens）或单任务限制（如单个子任务最多消耗 50k tokens） | P1 |

### 4.5 子 Agent 通信协议

| ID | 需求描述 | 优先级 |
|----|----------|--------|
| F-19 | 子 Agent 启动参数支持 `--output-format stream-json` | P0 |
| F-20 | 子 Agent 包装脚本能够捕获 Claude Code 的 `AskUserQuestion` 并转换为 `question` 消息 | P0 |
| F-21 | 子 Agent 监听 stdin，接收 `answer` 消息并转发给 Claude Code | P0 |
| F-22 | 子 Agent 在完成时输出 `result` 消息，包含产出物路径 | P0 |

### 4.6 工作目录策略与资源隔离

| ID | 需求描述 | 优先级 |
|----|----------|--------|
| F-26 | 支持三种工作目录策略：shared（共享）/ isolated（隔离）/ hybrid（混合：共享只读代码库 + 独立输出目录） | P1 |
| F-27 | 在 shared 模式下自动管理文件锁（防止并发写冲突） | P1 |
| F-31 | 子 Agent 运行时资源限制（CPU 时间/内存/输出大小） | P1 |
| F-32 | 主 Agent 检测子 Agent 失控行为（死循环/频繁询问/异常输出） | P1 |
| F-33 | 主 Agent 对失控子 Agent 执行熔断并记录详细原因 | P1 |

### 4.7 观测性与调试工具

| ID | 需求描述 | 优先级 |
|----|----------|--------|
| F-40 | Web UI 实时展示 DAG 执行进度（节点状态可视化：灰/黄/绿/红） | P2 |
| F-41 | 调试模式：输出所有子 Agent 的 stdin/stdout（`--debug` 启动） | P2 |
| F-42 | 支持暂停/恢复子 Agent（手动注入消息后继续执行） | P3 |
| F-43 | 性能分析报告（耗时/Token 消耗/API 调用次数） | P2 |

### 4.8 Agent 适配器与可扩展性

| ID | 需求描述 | 优先级 |
|----|----------|--------|
| F-51 | 定义标准 Agent 适配器接口（`IAgentAdapter`），包含 spawn、parseOutput、generateContextFile 等方法 | P0 |
| F-52 | 实现 Claude Code 适配器（支持 stream-json、stdin 交互、上下文文件） | P0 |
| F-53 | 实现 Codex 适配器（支持纯文本输出、无 stdin 交互） | P0 |
| F-54 | 提供通用适配器模板（`GenericCLIAdapter`），用户可通过配置快速添加新 Agent 工具 | P1 |
| F-55 | Agent 适配器注册表（`AgentAdapterRegistry`），支持运行时注册/查询/健康检查 | P1 |
| F-56 | 子任务支持指定使用的 Agent 工具（taskAgentMapping 配置） | P1 |
| F-57 | 启动时自动检测所有已注册 Agent 工具的可用性（健康检查） | P1 |
| F-58 | 支持通过配置文件加载第三方适配器（插件式加载） | P2 |

---

## 5. 技术规格

### 5.0 Agent 适配器架构（可扩展 CLI Agent 工具支持）

为了支持任意 CLI Agent 工具（Claude Code、Codex、OpenCode、KimiCode、Cursor CLI、Windsurf CLI 等），系统采用**插件式适配器架构**。

#### 5.0.1 Agent 适配器接口（IAgentAdapter）

每个 CLI Agent 工具需要实现以下接口：

```typescript
interface IAgentAdapter {
  // 适配器元信息
  readonly name: string;              // 适配器名称，如 "claude-code", "codex", "opencode"
  readonly version: string;           // 适配器版本
  readonly supportedFeatures: {       // 支持的特性列表
    streamJson: boolean;              // 是否支持 stream-json 输出
    stdinInteraction: boolean;        // 是否支持 stdin 交互（问答）
    contextFile: boolean;             // 是否支持通过文件传入上下文
    workspaceIsolation: boolean;      // 是否支持独立工作空间
  };

  // 启动子 Agent 进程
  spawn(options: SpawnOptions): Promise<AgentProcess>;

  // 生成上下文文件（适配不同工具的 prompt 格式）
  generateContextFile(task: Task, dependencies: TaskResult[]): Promise<string>;

  // 解析输出（统一格式）
  parseOutput(rawOutput: string): AgentOutput;

  // 问答协议转换（如果支持）
  convertQuestion?(rawQuestion: any): Question;
  convertAnswer?(answer: Answer): any;

  // 健康检查
  checkHealth(): Promise<boolean>;
}

interface SpawnOptions {
  taskId: string;
  contextFilePath: string;          // 上下文文件路径
  workspacePath: string;            // 工作目录
  env?: Record<string, string>;     // 环境变量
  timeout?: number;                 // 超时（毫秒）
}

interface AgentProcess {
  pid: number;
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  onExit: Promise<number>;          // 退出码
}

interface AgentOutput {
  type: 'log' | 'question' | 'result' | 'error';
  content: any;
  timestamp: string;
}
```

#### 5.0.2 内置适配器实现

##### 1. Claude Code 适配器（`ClaudeCodeAdapter`）

```typescript
class ClaudeCodeAdapter implements IAgentAdapter {
  name = 'claude-code';
  version = '1.0.0';
  supportedFeatures = {
    streamJson: true,
    stdinInteraction: true,   // 需 P0 验证
    contextFile: true,
    workspaceIsolation: true
  };

  async spawn(options: SpawnOptions): Promise<AgentProcess> {
    const proc = spawn('claude', [
      '-p', options.contextFilePath,
      '--output-format', 'stream-json',
      '--headless'
    ], {
      cwd: options.workspacePath,
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, ...options.env }
    });

    return {
      pid: proc.pid,
      stdin: proc.stdin,
      stdout: proc.stdout,
      stderr: proc.stderr,
      onExit: new Promise(resolve => proc.on('exit', resolve))
    };
  }

  async generateContextFile(task: Task, dependencies: TaskResult[]): Promise<string> {
    // 生成 Markdown 格式的上下文文件
    let context = `# Task: ${task.description}\n\n`;
    
    if (dependencies.length > 0) {
      context += `## Dependencies Completed\n\n`;
      for (const dep of dependencies) {
        context += `- **${dep.taskId}**: ${dep.summary}\n`;
        context += `  - Artifacts: ${dep.artifacts.join(', ')}\n\n`;
      }
    }

    context += `## Your Goal\n\n${task.expectedOutput}\n\n`;
    context += `## Verification\n\nYour work will be verified by: \`${task.verificationScript}\`\n`;
    
    return context;
  }

  parseOutput(rawOutput: string): AgentOutput {
    try {
      const parsed = JSON.parse(rawOutput);
      
      // Claude Code stream-json 格式转换
      if (parsed.type === 'tool_use' && parsed.name === 'AskUserQuestion') {
        return {
          type: 'question',
          content: parsed.input,
          timestamp: new Date().toISOString()
        };
      }
      
      return {
        type: 'log',
        content: parsed,
        timestamp: new Date().toISOString()
      };
    } catch (e) {
      // 非 JSON 输出视为普通日志
      return {
        type: 'log',
        content: rawOutput,
        timestamp: new Date().toISOString()
      };
    }
  }

  convertQuestion(rawQuestion: any): Question {
    return {
      id: rawQuestion.id || `q-${Date.now()}`,
      level: this.inferQuestionLevel(rawQuestion.questions?.[0]),
      text: rawQuestion.questions?.[0]?.question || 'Unknown question',
      options: rawQuestion.questions?.[0]?.options?.map(o => o.label) || [],
      context: rawQuestion
    };
  }

  convertAnswer(answer: Answer): any {
    return {
      type: 'tool_result',
      tool_use_id: answer.questionId,
      content: answer.choice
    };
  }

  async checkHealth(): Promise<boolean> {
    try {
      const result = await execPromise('claude --version', { timeout: 3000 });
      return result.code === 0;
    } catch {
      return false;
    }
  }

  private inferQuestionLevel(question: any): 'L0' | 'L1' | 'L2' {
    const text = question?.question?.toLowerCase() || '';
    
    // 高风险关键词 → L2
    if (/删除|drop|delete|rm -rf|外部api|支付/.test(text)) {
      return 'L2';
    }
    
    // 中风险 → L1
    if (/重构|修改|更新|升级/.test(text)) {
      return 'L1';
    }
    
    // 低风险 → L0
    return 'L0';
  }
}
```

##### 2. Codex 适配器（`CodexAdapter`）

```typescript
class CodexAdapter implements IAgentAdapter {
  name = 'codex';
  version = '1.0.0';
  supportedFeatures = {
    streamJson: false,                // Codex 不支持 stream-json
    stdinInteraction: false,          // Codex 不支持 stdin 交互
    contextFile: true,
    workspaceIsolation: true
  };

  async spawn(options: SpawnOptions): Promise<AgentProcess> {
    const proc = spawn('codex', [
      '--prompt-file', options.contextFilePath,
      '--no-interactive'
    ], {
      cwd: options.workspacePath,
      stdio: ['ignore', 'pipe', 'inherit'],  // stdin 不可用
      env: { ...process.env, ...options.env }
    });

    return {
      pid: proc.pid,
      stdin: null as any,  // 不支持 stdin
      stdout: proc.stdout,
      stderr: proc.stderr,
      onExit: new Promise(resolve => proc.on('exit', resolve))
    };
  }

  async generateContextFile(task: Task, dependencies: TaskResult[]): Promise<string> {
    // Codex 使用纯文本 prompt 格式
    let context = `Task: ${task.description}\n\n`;
    
    if (dependencies.length > 0) {
      context += `Previous completed tasks:\n`;
      for (const dep of dependencies) {
        context += `- ${dep.taskId}: ${dep.summary}\n`;
      }
      context += `\n`;
    }

    context += `Expected output: ${task.expectedOutput}\n\n`;
    context += `Your work will be verified by running: ${task.verificationScript}\n`;
    
    return context;
  }

  parseOutput(rawOutput: string): AgentOutput {
    // Codex 输出是纯文本
    return {
      type: 'log',
      content: rawOutput,
      timestamp: new Date().toISOString()
    };
  }

  async checkHealth(): Promise<boolean> {
    try {
      const result = await execPromise('codex --version', { timeout: 3000 });
      return result.code === 0;
    } catch {
      return false;
    }
  }
}
```

##### 3. 通用适配器（`GenericCLIAdapter`）

为其他 CLI Agent 工具提供的通用适配器模板：

```typescript
class GenericCLIAdapter implements IAgentAdapter {
  constructor(private config: GenericAdapterConfig) {}

  name = this.config.name;
  version = this.config.version;
  supportedFeatures = this.config.features;

  async spawn(options: SpawnOptions): Promise<AgentProcess> {
    const args = this.config.buildArgs(options);
    
    const proc = spawn(this.config.command, args, {
      cwd: options.workspacePath,
      stdio: this.config.stdio || ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, ...options.env }
    });

    return {
      pid: proc.pid,
      stdin: proc.stdin,
      stdout: proc.stdout,
      stderr: proc.stderr,
      onExit: new Promise(resolve => proc.on('exit', resolve))
    };
  }

  async generateContextFile(task: Task, dependencies: TaskResult[]): Promise<string> {
    return this.config.contextTemplate(task, dependencies);
  }

  parseOutput(rawOutput: string): AgentOutput {
    return this.config.parseOutput(rawOutput);
  }

  async checkHealth(): Promise<boolean> {
    try {
      const result = await execPromise(
        `${this.config.command} ${this.config.healthCheckArgs}`, 
        { timeout: 3000 }
      );
      return result.code === 0;
    } catch {
      return false;
    }
  }
}

interface GenericAdapterConfig {
  name: string;
  version: string;
  command: string;                    // CLI 命令，如 "opencode"
  features: IAgentAdapter['supportedFeatures'];
  buildArgs: (options: SpawnOptions) => string[];
  contextTemplate: (task: Task, dependencies: TaskResult[]) => string;
  parseOutput: (rawOutput: string) => AgentOutput;
  healthCheckArgs: string;            // 健康检查参数，如 "--version"
  stdio?: any;
}
```

#### 5.0.3 适配器注册与使用

```typescript
class AgentAdapterRegistry {
  private adapters = new Map<string, IAgentAdapter>();

  register(adapter: IAgentAdapter) {
    this.adapters.set(adapter.name, adapter);
    console.log(`✅ Registered adapter: ${adapter.name} v${adapter.version}`);
  }

  get(name: string): IAgentAdapter | undefined {
    return this.adapters.get(name);
  }

  list(): IAgentAdapter[] {
    return Array.from(this.adapters.values());
  }

  async checkAll(): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>();
    
    for (const [name, adapter] of this.adapters) {
      const healthy = await adapter.checkHealth();
      results.set(name, healthy);
      console.log(`${healthy ? '✅' : '❌'} ${name}: ${healthy ? 'available' : 'not found'}`);
    }
    
    return results;
  }
}

// 使用示例
const registry = new AgentAdapterRegistry();

// 注册内置适配器
registry.register(new ClaudeCodeAdapter());
registry.register(new CodexAdapter());

// 注册第三方适配器（OpenCode 示例）
registry.register(new GenericCLIAdapter({
  name: 'opencode',
  version: '1.0.0',
  command: 'opencode',
  features: {
    streamJson: false,
    stdinInteraction: false,
    contextFile: true,
    workspaceIsolation: true
  },
  buildArgs: (options) => ['--file', options.contextFilePath, '--workspace', options.workspacePath],
  contextTemplate: (task, deps) => {
    // OpenCode 格式的上下文
    return `# ${task.description}\n\nExpected: ${task.expectedOutput}`;
  },
  parseOutput: (raw) => ({
    type: 'log',
    content: raw,
    timestamp: new Date().toISOString()
  }),
  healthCheckArgs: '--version',
  stdio: ['ignore', 'pipe', 'inherit']
}));

// 健康检查
await registry.checkAll();
```

#### 5.0.4 主 Agent 调度器集成

```typescript
class LeaderAgent {
  constructor(
    private registry: AgentAdapterRegistry,
    private config: OrchestratorConfig
  ) {}

  async spawnFreshAgent(task: Task) {
    // 从任务配置或全局配置获取 Agent 工具名称
    const agentName = task.agentTool || this.config.defaultAgent || 'claude-code';
    
    const adapter = this.registry.get(agentName);
    if (!adapter) {
      throw new Error(`Agent adapter not found: ${agentName}`);
    }

    // 生成上下文文件
    const contextFile = `.team/tasks/${task.id}/context.md`;
    const contextContent = await adapter.generateContextFile(task, this.getDependenciesResults(task));
    await fs.writeFile(contextFile, contextContent);

    // Spawn 进程
    const proc = await adapter.spawn({
      taskId: task.id,
      contextFilePath: contextFile,
      workspacePath: this.getTaskWorkspace(task),
      timeout: this.config.taskTimeout
    });

    // 解析输出
    proc.stdout.on('data', (chunk) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        
        const output = adapter.parseOutput(line);
        this.handleAgentOutput(task, output);
      }
    });

    // 等待退出
    const exitCode = await proc.onExit;
    return exitCode;
  }

  private handleAgentOutput(task: Task, output: AgentOutput) {
    switch (output.type) {
      case 'question':
        // 使用适配器的 convertQuestion 转换问题
        const adapter = this.registry.get(task.agentTool!);
        if (adapter?.convertQuestion) {
          const question = adapter.convertQuestion(output.content);
          this.handleQuestion(task, question);
        }
        break;
      
      case 'log':
        this.appendLog(task.id, output.content);
        break;
      
      // ... 其他类型
    }
  }
}
```

#### 5.0.5 配置文件扩展

```json
{
  "defaultAgent": "claude-code",
  "agents": {
    "claude-code": {
      "enabled": true,
      "path": "claude",
      "priority": 1
    },
    "codex": {
      "enabled": true,
      "path": "codex",
      "priority": 2
    },
    "opencode": {
      "enabled": false,
      "path": "/usr/local/bin/opencode",
      "priority": 3
    }
  },
  "taskAgentMapping": {
    "code-analysis": "claude-code",
    "code-generation": "codex",
    "ui-generation": "opencode"
  }
}
```

---

### 5.1 Loop Engineering 架构概述（2026 最佳实践）

本系统融合了 2025-2026 年间 AI Agent 工程领域的最新范式：**Ralph Loop**、**Agent Loop（Plan-Act-Observe-Reflect）**，以及**验证门控（Verification Gates）**。

#### 5.0.1 Ralph Loop 模式

**来源**：[Ralph Wiggum pattern](https://ralph-wiggum.ai/)、[Atomic's Ralph Loop](https://alexlavaee.me/blog/atomic-ralph-loop/)、[Vercel ralph-loop-agent](https://github.com/vercel/ralph-loop-agent)

**核心原则**：
- **Atomic Tasks**：每个循环只执行一个原子任务
- **Verification-Gated Exit**：任务完成与否由外部验证脚本决定（测试、编译、检查），而非 Agent 自我报告
- **Fresh Context Each Iteration**：每次迭代启动全新 Agent 进程 + 全新上下文窗口，从磁盘读取最新状态，**无上下文累积 = 无漂移**
- **Deterministically Mediocre**：每次迭代质量可能平平，但通过多次迭代 + 验证出口，最终"磨"出正确结果

**实施要点**：
```bash
# 伪代码
while true; do
  # 1. 选择一个就绪任务
  task=$(select_next_task)
  [ -z "$task" ] && break
  
  # 2. 生成上下文文件（从磁盘读取最新状态）
  generate_context "$task" > .team/tasks/$task/context.md
  
  # 3. Spawn 全新 Agent 进程
  claude -p .team/tasks/$task/context.md
  
  # 4. 执行验证脚本（外部检查）
  if bash .team/tasks/$task/verification.sh; then
    mark_completed "$task"
    git commit -m "✅ $task completed"  # 原子提交
  else
    retry_or_fail "$task"
  fi
done
```

#### 5.0.2 Agent Loop（Plan-Act-Observe-Reflect）

**来源**：[Hugging Face Agents Course](https://huggingface.co/learn/agents-course/en/unit1/agent-steps-and-structure)、[KI-Campus Agentic AI](https://ki-campus.org/en/blog/agentic-ai)、[ReAct Pattern](https://www.mindstudio.ai/blog/what-is-react-loop-ai-agent-reasoning/)

这是 2026 年公认的 Agent 基础架构模式，每个子 Agent 内部运行一个 PAOR 循环：

```
Goal → Plan → Act → Observe → Reflect → [Iterate] → Done
```

| 阶段 | 子 Agent 内部行为 | 主 Agent 可观测内容 |
|------|------------------|-------------------|
| **Plan** | 子 Agent 根据上下文生成执行计划（工具调用序列） | 无（内部思考） |
| **Act** | 执行工具调用（编辑文件、运行命令） | 通过 stream-json 输出可见 |
| **Observe** | 观察工具调用结果（成功/失败/输出） | 子 Agent 日志 |
| **Reflect** | 反思是否达成目标，决定是否继续迭代 | 无（内部思考） |
| **Done** | 子 Agent 认为任务完成，进程退出 | 主 Agent 收到 exit 信号 |

**与 Ralph Loop 的协同**：
- 子 Agent 内部跑 PAOR 循环（Claude Code 原生行为）
- 主 Agent 外部跑 Ralph Loop（选任务 → 启动 → 验证 → 下一轮）
- **关键区别**：子 Agent 的"Done"判断**不可信**，主 Agent 必须通过外部验证脚本二次确认

#### 5.0.3 验证门控（Verification Gates）

**来源**：[NiteAgent Guardrail Patterns](https://niteagent.com/blog/ai-agent-guardrails-automation-patterns-2026/)、[Google Cloud: Ralph Loop with ADK](https://medium.com/google-cloud/ralph-loop-with-google-adk-ai-agents-that-verify-not-guess-b41f71c0f30f)

**核心思想**：**AI agents verify, not guess**——Agent 的自我报告（"我完成了"）不可靠，必须通过外部机制验证。

**三层验证体系**：

| 层级 | 验证机制 | 示例 |
|------|----------|------|
| **Hard Stops** | 语法级检查，失败则强制失败 | 编译检查、JSON 格式校验 |
| **Eval Gates** | 功能级检查，失败则重试 | 单元测试、集成测试 |
| **Circuit Breakers** | 行为级检查，异常则熔断 | Token 预算、死循环检测、重复询问 |

**实施建议**：
- 每个子任务必须声明 `verificationScript`
- 验证脚本应该是**幂等的**（可重复执行）
- 验证超时应该远短于任务超时（如 30 秒 vs 5 分钟）

#### 5.0.4 状态管理模式：Stateless Runs, Persistent Environment

**来源**：[LinkedIn: Designing Long-Running AI Agents](https://www.linkedin.com/pulse/designing-long-running-ai-agents-rohit-sharma-rnlzc)、[Hugging Face Discussion](https://discuss.huggingface.co/t/how-do-you-design-memory-systems-for-long-running-ai-agents/175584)

**原则**："**Do not make the prompt the memory system. Store memory outside the model.**"

- **每次 Agent 运行是无状态的**：全新进程、全新上下文窗口、无记忆累积
- **环境持久存在**：代码、spec 文件、状态文件、Git 历史都在磁盘上
- **上下文文件是"记忆注入口"**：每次运行前重新生成 `context.md`，从环境中提取相关状态

**反模式**：
- ❌ 让子 Agent 保持长驻进程，通过多轮对话积累上下文
- ❌ 把所有历史消息都塞进下次 prompt（上下文窗口爆炸）

**正确模式**：
- ✅ 子 Agent 退出后，状态写入 `.team/tasks/<id>/state.json`
- ✅ 下次运行前，主 Agent 从 `state.json` + Git 历史 + 依赖产出物 **重新生成** `context.md`
- ✅ 上下文大小可控（只包含当前任务需要的信息）

---

### 5.1 通信协议

#### 5.2.1 日志文件格式 (`.team/logs.jsonl`)

```json
{"timestamp":"2025-01-15T10:30:00.000Z","agentId":"leader","type":"status","content":{"action":"started","description":"开始任务分解"}}
{"timestamp":"2025-01-15T10:30:05.000Z","agentId":"leader","type":"decision","content":{"action":"create_team","subtasks":["sub-1","sub-2"]}}
{"timestamp":"2025-01-15T10:30:10.000Z","agentId":"sub-1","agentTool":"claude-code","type":"status","content":{"action":"progress","description":"分析代码库","progress":30}}
{"timestamp":"2025-01-15T10:30:15.000Z","agentId":"sub-1","agentTool":"claude-code","type":"question","content":{"text":"选择重构方案？","options":["A","B"]}}
{"timestamp":"2025-01-15T10:30:16.000Z","agentId":"leader","type":"answer","content":{"questionId":"q-123","choice":"A"}}
{"timestamp":"2025-01-15T10:30:20.000Z","agentId":"sub-1","agentTool":"claude-code","type":"result","content":{"artifacts":["artifacts/sub-1/report.json"]}}
{"timestamp":"2025-01-15T10:30:25.000Z","agentId":"sub-2","agentTool":"codex","type":"status","content":{"action":"started","description":"开始代码生成"}}
```

**新增字段**：
- `agentTool`：记录该日志条目对应的 Agent 工具名称（如 "claude-code", "codex", "opencode"）

#### 5.1.2 子 Agent 询问协议（含问题分级）

```json
// 子 Agent → 主 Agent (stdout)
{
  "type": "question",
  "id": "q-<uuid>",
  "level": "L1",  // L0=自动决策 / L1=建议+倒计时确认 / L2=必须人工确认
  "content": {
    "text": "问题描述",
    "options": ["选项1", "选项2"],
    "context": { "taskId": "sub-1", "currentFile": "src/main.js" }
  },
  "suggestion": "选项1",      // 主 Agent 的建议答案（L1/L2 时提供给用户参考）
  "autoApproveSeconds": 5     // L1 时的自动确认倒计时（秒）
}

// 主 Agent → 子 Agent (stdin)
{
  "type": "answer",
  "questionId": "q-<uuid>",
  "choice": "选项1",
  "decidedBy": "leader"  // leader=主Agent自动决策 / user=用户人工确认
}
```

**问题分级规则**：

| 级别 | 触发条件 | 处理方式 |
|------|----------|----------|
| L0 | 格式选择、命名风格等无风险问题 | 主 Agent 根据历史决策或默认规则自动答复 |
| L1 | 重构方案选择、依赖版本等中风险问题 | 主 Agent 给出建议，倒计时 N 秒无用户响应自动采纳 |
| L2 | 删除文件、修改核心逻辑、外部 API 调用等高风险问题 | 必须等待用户输入，无超时 |

级别判定由主 Agent 根据问题内容 + 配置规则决定，用户可在配置中自定义判定规则（如"包含'删除'关键词的问题强制 L2"）。

#### 5.1.3 状态快照格式 (`.team/state-snapshot.json`)

```json
{
  "snapshotAt": "2025-01-15T10:30:20.000Z",
  "logOffset": 1024,  // 快照对应的日志文件字节偏移，恢复时从此处读增量
  "tasks": {
    "sub-1": { "status": "completed", "artifacts": ["artifacts/sub-1/report.json"], "startedAt": "...", "completedAt": "..." },
    "sub-2": { "status": "running", "progress": 45, "startedAt": "..." },
    "sub-3": { "status": "pending", "dependencies": ["sub-2"] }
  },
  "pendingQuestions": []
}
```

恢复流程：读取最新快照 → 从 `logOffset` 开始重放增量日志 → 重建完整状态。目标恢复时间 < 1 秒。

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

### 5.3 主 Agent 调度核心逻辑（Ralph Loop 模式）

```javascript
class LeaderAgent {
  constructor() {
    this.tasks = new Map();        // taskId -> TaskState
    this.tokenBudget = { total: 500000, spent: 0 };
    this.logWatcher = null;
  }

  async start(userPrompt) {
    // 1. 任务分解
    const dag = await this.decompose(userPrompt);

    // 2. 初始化任务状态
    for (const task of dag.tasks) {
      this.tasks.set(task.id, { 
        ...task, 
        status: 'pending',
        retryCount: 0,
        verificationScript: task.verificationScript  // 新增：验证脚本
      });
    }

    // 3. 启动日志监听
    this.watchLogs();

    // 4. 启动 Ralph Loop
    this.ralphLoop();
  }

  async ralphLoop() {
    while (true) {
      // 选择一个就绪任务（依赖已满足 + status=pending）
      const readyTask = this.selectNextTask();
      
      if (!readyTask) {
        // 检查是否全部完成
        if (this.allTasksCompleted()) {
          console.log('✅ 所有任务完成');
          break;
        }
        // 否则等待当前运行任务完成或用户输入
        await this.sleep(1000);
        continue;
      }

      // Token 预算检查
      if (this.tokenBudget.spent >= this.tokenBudget.total) {
        console.log('⚠️ Token 预算耗尽，停止启动新任务');
        break;
      }

      // 启动子 Agent（全新进程 + 全新上下文）
      console.log(`🚀 启动任务 ${readyTask.id}...`);
      readyTask.status = 'running';
      
      const exitCode = await this.spawnFreshAgent(readyTask);

      // Agent 退出后，执行验证脚本
      const verificationResult = await this.runVerification(readyTask);

      if (verificationResult.success) {
        console.log(`✅ 任务 ${readyTask.id} 通过验证`);
        readyTask.status = 'completed';
        readyTask.completedAt = new Date();
        this.logTaskCompletion(readyTask);
        
        // 触发依赖此任务的下游任务（在下次循环中被选中）
      } else {
        console.log(`❌ 任务 ${readyTask.id} 验证失败: ${verificationResult.error}`);
        readyTask.retryCount++;
        
        if (readyTask.retryCount >= this.config.retryCount) {
          readyTask.status = 'failed';
          await this.handleTaskFailure(readyTask);
        } else {
          readyTask.status = 'pending';  // 重新排队
          console.log(`🔄 任务 ${readyTask.id} 重试 (${readyTask.retryCount}/${this.config.retryCount})`);
        }
      }

      // 保存状态快照（每轮循环后）
      await this.saveSnapshot();
    }
  }

  async spawnFreshAgent(task) {
    // 每次都是全新进程，从磁盘读取最新状态
    const contextFile = `.team/tasks/${task.id}/context.md`;
    
    // 生成上下文文件（包含任务描述、依赖任务的产出物路径、当前工作区状态）
    await this.generateContextFile(task, contextFile);
    
    // Spawn Claude Code（全新进程 + 全新上下文窗口）
    const proc = spawn('claude', [
      '-p', contextFile,
      '--output-format', 'stream-json'
    ], {
      cwd: this.getTaskWorkspace(task),
      stdio: ['pipe', 'pipe', 'inherit']
    });

    // 等待进程退出
    return new Promise((resolve) => {
      proc.on('exit', (code) => {
        // 记录 Token 消耗（通过 AICodeSwitch 代理获取）
        this.tokenBudget.spent += this.getTokensUsedByTask(task.id);
        resolve(code);
      });
    });
  }

  async runVerification(task) {
    const { verificationScript } = task;
    
    if (!verificationScript) {
      // 无验证脚本则默认通过（不推荐）
      return { success: true };
    }

    try {
      // 执行验证脚本
      const result = await execPromise(verificationScript, {
        cwd: this.getTaskWorkspace(task),
        timeout: 30000  // 30秒超时
      });

      return {
        success: result.code === 0,
        stdout: result.stdout,
        stderr: result.stderr
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  selectNextTask() {
    // 拓扑排序：选择依赖已满足且 status=pending 的任务
    for (const [id, task] of this.tasks) {
      if (task.status !== 'pending') continue;
      
      const allDepsCompleted = task.dependencies.every(depId => {
        const dep = this.tasks.get(depId);
        return dep && dep.status === 'completed';
      });

      if (allDepsCompleted) {
        return task;
      }
    }
    return null;
  }
}
```

**Ralph Loop 关键特性**：

1. **验证即出口**：`runVerification()` 执行外部脚本，exit code 0 = 通过，非 0 = 失败
2. **无状态运行**：每次 `spawnFreshAgent()` 都重新生成 `context.md`，子 Agent 从磁盘读取最新状态，无记忆累积
3. **迭代式调度**：`selectNextTask()` 每轮选一个就绪任务，而非并行启动所有就绪任务（可配置并发数）
4. **Token 预算门控**：`tokenBudget.spent >= tokenBudget.total` 时停止启动新任务
5. **原子提交**：每个任务完成后可自动 git commit（optional），便于回滚

### 5.4 工作目录结构

```
project/
├── .team/
│   ├── logs.jsonl              # 团队日志
│   ├── state-snapshot.json     # 最新状态快照（每 10 条日志更新）
│   ├── state.db                # SQLite 持久化（可选，用于复杂查询）
│   ├── tasks/                  # 每个子任务的上下文和状态
│   │   ├── sub-1/
│   │   │   ├── context.md      # 任务上下文（每次运行前重新生成）
│   │   │   ├── spec.md         # 任务规格（不变）
│   │   │   ├── verification.sh # 验证脚本
│   │   │   └── state.json      # 任务状态（重试次数、Token 消耗等）
│   │   ├── sub-2/
│   │   └── ...
│   ├── locks/                  # 文件锁目录（shared 模式）
│   │   ├── src_main.js.lock
│   │   └── ...
│   └── artifacts/              # 子 Agent 产出物
│       ├── sub-1/
│       ├── sub-2/
│       └── ...
├── workspace/                  # 共享工作区（代码文件等）
├── workspace-sub-1/            # 隔离模式：子 Agent 独立工作副本
├── workspace-sub-2/
└── config/
    └── orchestrator.json       # 配置文件
```

**关键文件说明**：

| 文件 | 用途 | 生命周期 |
|------|------|----------|
| `context.md` | 每次子 Agent 运行前重新生成，包含：任务描述、依赖任务产出物路径、当前工作区摘要、重试历史 | 每次运行前覆盖 |
| `spec.md` | 子任务的固定规格，不变 | 创建时写入，不再修改 |
| `verification.sh` | 验证脚本（可执行文件） | 创建时写入，可热更新 |
| `state.json` | 任务的运行时状态（重试次数、Token 消耗、上次失败原因） | 每次运行后更新 |

**工作目录策略**：

| 策略 | 适用场景 | 优点 | 缺点 |
|------|----------|------|------|
| **shared** | 顺序依赖任务（如"分析→重构→测试"） | 磁盘空间小，状态一致 | 需要文件锁，不支持真正并行 |
| **isolated** | 完全并行任务（如"分析不同模块"） | 无冲突，真正并行 | 磁盘占用大，合并复杂 |
| **hybrid** | 部分并行+部分共享（如"多个探索性分析 → 统一实施"） | 平衡空间和隔离 | 需要显式标记只读/读写区域 |

用户在启动时通过 `--workspace-strategy shared|isolated|hybrid` 指定，配置文件中可为每个子任务单独覆盖策略。

### 5.5 配置文件示例

```json
{
  "defaultAgent": "claude-code",
  "maxConcurrency": 1,
  "ralphLoopMode": true,
  "taskTimeout": 300,
  "retryCount": 2,
  "autoApproveQuestions": false,
  "questionApprovalRules": {
    "autoL0": true,
    "autoL1TimeoutSeconds": 5,
    "forceL2Keywords": ["删除", "drop", "delete", "外部API"]
  },
  "workspaceStrategy": "hybrid",
  "enableFileLocking": true,
  "tokenBudget": {
    "enabled": true,
    "total": 500000,
    "perTask": 50000,
    "stopOnExhaustion": true
  },
  "verificationDefaults": {
    "timeout": 30000,
    "retryOnTimeout": false
  },
  "subAgentLimits": {
    "maxCpuTimeSeconds": 300,
    "maxMemoryMB": 2048,
    "maxLogLineBytes": 10240,
    "maxConsecutiveIdenticalQuestions": 3
  },
  "failureStrategy": "replan",
  "allowPartialSuccess": true,
  "atomicCommits": true,
  "agents": {
    "claude-code": {
      "enabled": true,
      "path": "claude",
      "priority": 1,
      "features": {
        "streamJson": true,
        "stdinInteraction": true,
        "contextFile": true,
        "workspaceIsolation": true
      }
    },
    "codex": {
      "enabled": true,
      "path": "codex",
      "priority": 2,
      "features": {
        "streamJson": false,
        "stdinInteraction": false,
        "contextFile": true,
        "workspaceIsolation": true
      }
    },
    "opencode": {
      "enabled": false,
      "path": "/usr/local/bin/opencode",
      "priority": 3,
      "adapter": "generic",
      "adapterConfig": {
        "args": ["--file", "{contextFile}", "--workspace", "{workspace}"],
        "contextFormat": "markdown",
        "outputFormat": "plain"
      }
    }
  },
  "taskAgentMapping": {
    "code-analysis": "claude-code",
    "code-generation": "codex",
    "ui-generation": "opencode",
    "default": "claude-code"
  },
  "logLevel": "info"
}
```

**新增配置项说明**：

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `defaultAgent` | 默认使用的 Agent 工具名称 | `"claude-code"` |
| `agents.<name>.enabled` | 是否启用该 Agent 工具 | `true` |
| `agents.<name>.path` | Agent 工具的可执行文件路径 | CLI 命令名 |
| `agents.<name>.priority` | 优先级（数字越小优先级越高），当 taskAgentMapping 未指定时按优先级选择 | `1` |
| `agents.<name>.features` | 该 Agent 工具支持的特性列表 | 见上述 |
| `agents.<name>.adapter` | 适配器类型（`builtin` / `generic`） | `"builtin"` |
| `agents.<name>.adapterConfig` | 通用适配器的配置（仅当 adapter="generic" 时有效） | - |
| `taskAgentMapping` | 任务类型到 Agent 工具的映射 | `{}` |
| `taskAgentMapping.default` | 未匹配任何规则时的默认 Agent 工具 | `defaultAgent` 值 |

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
[10:30:05] 🧠 Leader: 已创建团队 - 子任务: sub-1, sub-2, sub-3
[10:30:06] 🧠 Leader: Agent 健康检查...
[10:30:06] ✅ claude-code: available
[10:30:06] ✅ codex: available
[10:30:06] ❌ opencode: not found (disabled)

[10:30:10] 🔧 sub-1 (claude-code): 正在分析代码库... (30%)
[10:30:12] 🔨 sub-2 (codex): 等待依赖 sub-1...

[10:30:15] 🔧 sub-1 (claude-code): ❓ 选择重构方案？ [A) class封装 | B) 函数式模块]
[10:30:16] 🧠 Leader: 📢 答复 sub-1: 选择方案A

[10:30:20] 🔧 sub-1 (claude-code): ✅ 完成！产出: artifacts/sub-1/report.json
[10:30:21] 🔨 sub-2 (codex): 🚀 开始执行...
[10:30:35] 🔨 sub-2 (codex): ✅ 完成！产出: artifacts/sub-2/code.ts

[10:30:36] 🎨 sub-3 (opencode): ⚠️  Agent 工具不可用，fallback to claude-code
[10:30:36] 🔧 sub-3 (claude-code): 🚀 开始执行...
```

**新增特性**：
- 每个 Agent 标识后显示使用的工具名称（如 `claude-code`、`codex`）
- 启动时显示 Agent 健康检查结果
- 支持 fallback 机制（工具不可用时自动降级到默认工具）

### 7.2 命令列表

| 命令 | 说明 |
|------|------|
| `ato run "任务描述"` | 启动新任务 |
| `ato run "任务描述" --agent opencode` | 使用指定 Agent 工具启动任务 |
| `ato status` | 查看当前所有 Agent 状态 |
| `ato logs [agentId]` | 查看日志（可选过滤 Agent）|
| `ato resume` | 恢复上次中断的任务 |
| `ato stop` | 停止所有 Agent |
| `ato adapters list` | 列出所有已注册的 Agent 适配器 |
| `ato adapters check` | 健康检查所有 Agent 工具的可用性 |
| `ato adapters info <name>` | 查看指定适配器的详细信息 |

---

## 8. 异常处理

| 场景 | 处理方式 |
|------|----------|
| 子 Agent 进程崩溃 | 主 Agent 记录日志，根据配置决定是否重启（最多 `retryCount` 次） |
| 子 Agent 超时 | 主 Agent 发送 SIGTERM 终止进程，标记失败，根据 `failureStrategy` 重新规划或跳过 |
| 子 Agent 失控（死循环） | 检测到 5 秒内输出超过 100 行或 CPU 占用持续 > 95%，强制 SIGKILL |
| 子 Agent 失控（频繁询问） | 检测到连续 3 次相同问题，自动答复默认选项并警告用户 |
| 子 Agent 失控（异常输出） | 检测到单行日志超过 10KB，截断并标记异常 |
| 日志文件写入冲突 | 使用排他锁（flock）或消息队列（p-queue）序列化写入 |
| 日志文件损坏 | 读取时跳过 CRC32 校验失败的行，记录警告 |
| 主 Agent 自身崩溃 | 重启后读取最新快照 + 增量日志，重建任务状态 |
| 用户中断 (Ctrl+C) | 主 Agent 捕获 SIGINT，发送 SIGTERM 给所有子 Agent，等待最多 5 秒后强制 SIGKILL，保存状态快照 |
| 任务依赖失败传播 | 根据 `failureStrategy`：abort（停止所有任务）/ skip（跳过下游任务）/ replan（请求主 Agent 重新生成 DAG） |
| 文件锁死锁 | 超时 10 秒后强制释放锁，记录警告 |

---

## 9. 与 AICodeSwitch 的集成方案

### 9.1 候选方案

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| **A：内置集成** | 在 `src/server/orchestrator/` 实现 Leader Agent，路由页新增"团队模式"，请求带 `X-Team-Mode: true` 时由编排器接管 | 复用现有代理、日志、UI 基础设施；子 Agent 流量天然经过代理（可观测、可路由） | 增加 AICodeSwitch 复杂度；编排器崩溃可能影响代理服务 |
| **B：独立 CLI 工具** | 单独发布 `ato` 命令行工具，通过配置指定 AICodeSwitch 代理 URL，AICodeSwitch 不感知编排层 | 关注点分离，快速迭代验证；不影响现有稳定性 | 需独立维护 UI/日志系统；与 AICodeSwitch 集成度低 |

### 9.2 推荐路线

**阶段一（验证期）**：采用方案 B，独立 CLI 工具快速验证编排设计。子 Agent 的 API 请求通过 AICodeSwitch 代理（配置 `ANTHROPIC_BASE_URL` 指向本地代理），天然获得：
- 路由能力（不同子 Agent 可走不同上游模型）
- 请求日志与 Token 统计
- 格式转换（子 Agent 可使用非 Claude 上游）

**阶段二（成熟期）**：设计验证后迁移到方案 A，深度集成：
- 编排器作为 AICodeSwitch 的可选模块
- Web UI 展示 DAG 进度（复用现有前端框架）
- 子 Agent 与会话系统打通（每个子 Agent 一个 Session，可在会话页查看）

### 9.3 协同收益

| AICodeSwitch 能力 | 对编排系统的价值 |
|-------------------|------------------|
| 路由规则（thinking/long-context） | 子 Agent 自动按内容类型选择最优模型 |
| 会话追踪 | 每个子 Agent 的完整对话历史可追溯 |
| Token 统计 | 精确核算每个子任务的成本 |
| AccessKey 配额 | 限制编排任务的总 Token 消耗 |

---

## 10. 里程碑与交付计划

| 阶段 | 时间 | 交付物 | 关键验证点 |
|------|------|--------|-----------|
| **P0 - 原型** | 第1周 | 基础进程管理 + Agent 适配器架构 + Claude Code 适配器 + 单个子 Agent 示例 | ✅ 验证 Claude Code headless 模式下 `AskUserQuestion` 行为<br>✅ 验证 stream-json 双向通信可行性<br>✅ 适配器接口设计验证 |
| **P1 - Ralph Loop 核心** | 第2-3周 | 任务分解 + DAG 验证 + Ralph Loop 调度器 + 验证脚本执行引擎 + Codex 适配器 | ✅ 单个 Ralph Loop 能够成功完成 3 个串行任务<br>✅ 验证脚本能正确判断任务成败<br>✅ Claude Code 和 Codex 混用无问题 |
| **P2 - 完整流程** | 第4周 | 问答协议（分级）+ CLI 实时视图 + 断点续传（快照机制）+ Token 预算控制 + 通用适配器模板 | ✅ 完整 5 任务 DAG 执行成功<br>✅ 崩溃恢复时间 < 1秒<br>✅ 第三方 Agent 工具（如 OpenCode）可通过通用适配器接入 |
| **P3 - 生产级可靠性** | 第5周 | 失控熔断 + 配置文件 + 错误恢复 + 工作目录策略 + 适配器插件加载 | ✅ 故意注入失控 Agent，系统能正确熔断<br>✅ Token 预算耗尽时优雅停止<br>✅ 适配器插件可热加载 |
| **P4 - 集成与优化** | 第6-8周 | 与 AICodeSwitch 集成（方案 B → 方案 A 迁移评估）+ 性能调优 + 文档 + 示例项目 | ✅ 子 Agent 流量通过 AICodeSwitch 代理<br>✅ Token 统计准确<br>✅ 至少 3 个第三方 Agent 工具适配器示例 |

**关键里程碑门控**：
- **P0 → P1**：必须验证 Claude Code headless 下问答机制可行，**且适配器接口设计合理**（能支撑 Codex 的接入）
- **P1 → P2**：必须验证 Ralph Loop 能稳定运行，单轮验证脚本成功率 > 95%，**且两种 Agent 工具混用无冲突**
- **P2 → P3**：必须验证快照恢复机制，恢复时间 < 1秒，**且通用适配器模板可用**
- **P3 → P4**：必须验证 Token 预算控制，不能出现预算超支 > 10%，**且适配器生态初步建立**

---

## 11. 附录

### 11.1 与现有方案的对比

| 方案 | 定位 | ATO 差异化 |
|------|------|------------|
| OpenClaw | 完整 Agent 框架 | 纯编排，不执行逻辑 |
| LangGraph | 图状态机 | 使用真实 Claude Code 进程 |
| AutoGen | 多 Agent 对话 | 轻量级，无额外依赖 |
| Claude Code Agent Teams（官方实验特性） | Claude Code 内置多 Agent 协作 | ATO 跨工具（Claude Code + Codex 混编）、进程级隔离、可自定义调度策略 |
| **Ralph Loop 实现（Vercel、Atomic等）** | 单 Agent 迭代式自动化 | ATO 扩展为多 Agent DAG 编排，每个节点是一个 Ralph Loop |

### 11.2 风险与缓解

| 风险 | 概率 | 缓解措施 |
|------|------|----------|
| Claude Code 输出格式变更 | 中 | 使用稳定版本的 CLI，适配层隔离（所有格式解析集中在 wrapper 中） |
| `AskUserQuestion` 拦截机制失效（headless 模式下行为差异） | 高 | P0 阶段优先验证此机制；备选方案：通过 system prompt 约定子 Agent 用特定格式输出问题 |
| 子 Agent 资源占用过高 | 中 | 限制并发数，资源限制（F-31），支持工作目录隔离 |
| 日志文件过大 | 低 | 支持日志轮转（按大小或时间），快照机制减少重放成本 |
| DAG 分解质量不稳定 | 中 | 子任务模板库（F-23）+ DAG 验证（F-25）+ 用户编辑确认（F-24） |
| 子 Agent 间产出物格式不一致 | 中 | 子任务定义中强制声明 `expectedOutput` schema，主 Agent 校验产出物 |
| **验证脚本编写成本高** | 中 | 提供内置验证器库（compile-check、test-runner、lint-check）；主 Agent 在分解时自动生成常见验证脚本 |
| **Token 预算超支** | 中 | 实时追踪 Token 消耗（通过 AICodeSwitch 代理统计），达到 90% 时警告，100% 时硬停止 |

### 11.3 待验证的关键技术假设

以下假设需要在 P0 原型阶段优先验证，任何一条不成立都需要调整设计：

1. **Claude Code headless 模式（`-p` + `--output-format stream-json`）下 `AskUserQuestion` 的行为**：headless 模式下 Claude Code 可能不发出 AskUserQuestion 而是自主决策，需实测确认拦截可行性
2. **stream-json 双向通信**：`--input-format stream-json` 配合 stdin 写入是否能实现多轮交互（而非单次 prompt）
3. **`fs.watch` 跨平台可靠性**：macOS 上 fs.watch 可能丢失事件，备选方案为轮询（chokidar）
4. **子 Agent 上下文携带**：依赖任务的产出物如何注入下游任务（文件路径引用 vs 内容内联），需要评估上下文窗口占用
5. **验证脚本的覆盖度**：常见任务类型（代码生成、重构、测试编写）是否都能找到可靠的验证方法

### 11.4 Loop Engineering 参考资料（2025-2026）

本 PRD 的架构设计受以下资源启发：

#### 核心模式

1. **Ralph Loop 模式**
   - [Ralph Wiggum - Viral Agentic Coding Loop](https://ralph-wiggum.ai/)
   - [Atomic's Ralph Loop: Plan → Orchestrate → Review](https://alexlavaee.me/blog/atomic-ralph-loop/)
   - [Stop Orchestrating AI Agents. Use Ralph Loops Instead](https://www.decodingai.com/p/ralph-loops)
   - [The Ralph Loop Explained (GitHub)](https://github.com/snarktank/ralph)
   - [Ralph Loop with Google ADK: AI Agents That Verify, Not Guess](https://medium.com/google-cloud/ralph-loop-with-google-adk-ai-agents-that-verify-not-guess-b41f71c0f30f)

2. **Agent Loop (Plan-Act-Observe-Reflect)**
   - [Understanding AI Agents through the Thought-Action-Observation Cycle](https://huggingface.co/learn/agents-course/en/unit1/agent-steps-and-structure) (Hugging Face)
   - [Agentic AI: The New Software Paradigm](https://ki-campus.org/en/blog/agentic-ai) (KI-Campus)
   - [What Is the ReAct Loop? How AI Agents Reason, Act, and Iterate](https://www.mindstudio.ai/blog/what-is-react-loop-ai-agent-reasoning/)
   - [From ReAct to Ralph Loop: A Continuous Iteration Paradigm](https://www.alibabacloud.com/blog/from-react-to-ralph-loop-a-continuous-iteration-paradigm-for-ai-agents_602799)

3. **多 Agent 编排实践**
   - [How I Built a Multi-Agent Orchestration System with Claude Code](https://www.reddit.com/r/ClaudeAI/comments/1l11fo2/how_i_built_a_multiagent_orchestration_system/) (Reddit)
   - [The Code Agent Orchestra - What Makes Multi-Agent Coding Work](https://addyosmani.com/blog/code-agent-orchestra/) (Addy Osmani)
   - [How We Built Our Multi-Agent Research System](https://www.anthropic.com/engineering/multi-agent-research-system) (Anthropic Official)
   - [Claude Flow V3: 54+ Specialized Agents in Coordinated Swarms](https://github.com/ruvnet/ruflo/issues/945)

4. **状态管理与记忆**
   - [7 State Persistence Strategies for Long-Running AI Agents in 2026](https://www.indium.tech/blog/7-state-persistence-strategies-ai-agents-2026/)
   - [How do you design memory systems for long-running AI agents?](https://discuss.huggingface.co/t/how-do-you-design-memory-systems-for-long-running-ai-agents/175584) (Hugging Face Discussion)
   - [State of AI Agent Memory 2026: Benchmarks, Architectures](https://mem0.ai/blog/state-of-ai-agent-memory-2026)

5. **生产级 Guardrails**
   - [AI Agent Guardrails: 5 Automation Patterns for Reliable Workflows](https://niteagent.com/blog/ai-agent-guardrails-automation-patterns-2026/)
   - [Guardrails in Agentic AI: From Chaos to Control](https://ritikjain51.medium.com/guardrails-in-agentic-ai-from-chaos-to-control-a7a24d77d1a5)
   - [Build Production-Ready AI Agents in 2026 (Without Deleting Your Database)](https://codingscape.com/blog/build-production-ready-ai-agents-in-2026-without-deleting-your-database)

#### 关键引用

> "**Do not make the prompt the memory system. Store memory outside the model, then only give the model what it needs.**"  
> — Hugging Face Discussion on Long-Running Agent Memory

> "**Most AI agents fail silently. Hard stops, eval gates, circuit breakers — designed to catch failures before they become costly.**"  
> — NiteAgent Guardrail Patterns

> "**The Ralph Loop is deterministically mediocre — reliably average at each iteration, but grinding the codebase into shape over time.**"  
> — Thomas Wiegold on Recursive AI Agents

> "**In 2026, the agent stack is not the LLM stack. The infrastructure that makes the agent loop work reliably, at scale, in production — that's the real engineering challenge.**"  
> — O'Reilly: The AI Agents Stack (2026 Edition)

### 11.5 术语表

| 术语 | 定义 |
|------|------|
| **Ralph Loop** | 迭代式 Agent 调度模式：原子任务 + 验证门控 + 全新上下文窗口 |
| **Agent Loop** | Plan → Act → Observe → Reflect，单个 Agent 内部的推理循环 |
| **Verification Gate** | 外部验证机制（测试/编译/检查脚本），决定任务是否真正完成 |
| **Stateless Run** | 每次 Agent 运行是全新进程 + 全新上下文，无状态累积 |
| **Persistent Environment** | 代码、spec、状态文件持久存在于磁盘，跨 Agent 运行共享 |
| **Hard Stop** | 语法级验证（编译/格式校验），失败则强制失败 |
| **Eval Gate** | 功能级验证（测试），失败则重试 |
| **Circuit Breaker** | 行为级检查（Token 预算/死循环），异常则熔断 |
| **Atomic Commit** | 每个任务完成后自动 git commit，便于回滚 |
| **Token Budget** | 全局 Token 消耗上限，达到后停止启动新任务 |
| **Agent Adapter** | CLI Agent 工具的适配器，实现 `IAgentAdapter` 接口 |
| **Agent Adapter Registry** | 管理所有已注册 Agent 适配器的注册表 |
| **Generic Adapter** | 通用适配器模板，用于快速接入第三方 CLI Agent 工具 |

### 11.6 可扩展性设计原则

#### 1. 面向接口编程
所有与具体 Agent 工具相关的操作都通过 `IAgentAdapter` 接口进行，主调度器不依赖具体实现。

#### 2. 插件式架构
- 适配器可以是内置的（Claude Code、Codex）
- 也可以是第三方的（通过配置文件或代码注册）
- 支持运行时注册（无需重启）

#### 3. 配置驱动
- 通过配置文件控制哪些 Agent 工具可用
- 通过 `taskAgentMapping` 控制任务类型与 Agent 工具的绑定
- 通过 `agents.<name>.adapterConfig` 自定义适配器行为

#### 4. 降级与 Fallback
- Agent 工具不可用时自动降级到默认工具
- 健康检查失败时禁用该工具，不影响整体运行

#### 5. 隔离与封装
- 每个适配器封装了工具特定的启动参数、输出格式、上下文格式
- 主调度器只关心统一的接口，不关心底层实现差异

#### 6. 第三方适配器示例

**OpenCode 适配器（假设）**：
```typescript
// 用户可在 ~/.ato/adapters/opencode.js 中定义
module.exports = {
  name: 'opencode',
  version: '1.0.0',
  command: 'opencode',
  features: {
    streamJson: false,
    stdinInteraction: false,
    contextFile: true,
    workspaceIsolation: true
  },
  buildArgs: (options) => [
    '--file', options.contextFilePath,
    '--workspace', options.workspacePath,
    '--no-interactive'
  ],
  contextTemplate: (task, deps) => {
    return `Task: ${task.description}\n\nExpected: ${task.expectedOutput}`;
  },
  parseOutput: (raw) => ({
    type: 'log',
    content: raw,
    timestamp: new Date().toISOString()
  }),
  healthCheckArgs: '--version'
};
```

加载方式：
```bash
# 1. 放在 ~/.ato/adapters/ 目录
# 2. 在配置文件中启用
{
  "agents": {
    "opencode": {
      "enabled": true,
      "adapter": "generic",
      "adapterPath": "~/.ato/adapters/opencode.js"
    }
  }
}
```

#### 7. 社区生态构想

**适配器市场**（未来）：
- 提供适配器模板生成器（CLI 工具）
- 社区贡献的适配器可发布到 npm（如 `@ato-adapters/opencode`）
- 通过 `ato adapters install opencode` 一键安装

**适配器质量标准**：
- 必须通过标准测试套件（spawn 测试、输出解析测试、健康检查测试）
- 必须提供文档（支持的特性、已知限制、配置示例）
- 建议提供验证脚本模板（针对该 Agent 工具的常见任务）

---

**文档版本**: 3.1 (Extensible Agent Adapter Edition)
**最后更新**: 2026-06-11
**负责人**: [待填写]
**变更日志**:
- v3.1 (2026-06-11): 新增 Agent 适配器架构，支持可扩展的 CLI Agent 工具（OpenCode、KimiCode 等）
- v3.0 (2026-06-11): 融合 Loop Engineering 最佳实践，引入 Ralph Loop 模式、验证门控、Token 预算控制
- v2.0 (2026-06-11): 补充细节建议，新增工作目录策略、失控检测、问题分级等
- v1.0 (2025-01-15): 初始版本