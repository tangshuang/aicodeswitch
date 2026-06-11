# Supervisor Agent PRD v3.1 升级说明

## 概述

基于用户需求，PRD 从 v3.0 升级到 **v3.1 (Extensible Agent Adapter Edition)**。核心变化是**引入可扩展的 Agent 适配器架构**，使系统能够支持任意 CLI Agent 工具（OpenCode、KimiCode、Cursor CLI、Windsurf CLI 等），而不仅限于 Claude Code 和 Codex。

---

## 🎯 核心目标

**从**："基于 Claude Code / Codex 的多 Agent 协作编排系统"  
**到**："基于 **任意 CLI Agent 工具** 的多 Agent 协作编排系统"

---

## 🏗️ 架构新增：Agent 适配器层

### 设计原则

1. **面向接口编程**：定义标准的 `IAgentAdapter` 接口
2. **插件式架构**：适配器可以是内置的或第三方的
3. **配置驱动**：通过配置文件控制 Agent 工具的可用性和映射
4. **降级与 Fallback**：工具不可用时自动降级到默认工具
5. **隔离与封装**：每个适配器封装工具特定的启动参数、输出格式、上下文格式

---

## 📐 核心组件

### 1. Agent 适配器接口（`IAgentAdapter`）

```typescript
interface IAgentAdapter {
  readonly name: string;              // 如 "claude-code", "codex", "opencode"
  readonly version: string;
  readonly supportedFeatures: {
    streamJson: boolean;
    stdinInteraction: boolean;
    contextFile: boolean;
    workspaceIsolation: boolean;
  };

  spawn(options: SpawnOptions): Promise<AgentProcess>;
  generateContextFile(task: Task, dependencies: TaskResult[]): Promise<string>;
  parseOutput(rawOutput: string): AgentOutput;
  convertQuestion?(rawQuestion: any): Question;
  convertAnswer?(answer: Answer): any;
  checkHealth(): Promise<boolean>;
}
```

**关键方法**：
- `spawn()`：启动 CLI Agent 进程
- `generateContextFile()`：生成适配该工具的上下文文件（Markdown / 纯文本 / JSON 等）
- `parseOutput()`：解析工具输出为统一格式
- `checkHealth()`：健康检查（运行 `--version` 等）

### 2. 内置适配器

#### Claude Code 适配器
- 支持 `stream-json` 输出
- 支持 `stdin` 交互（需 P0 验证）
- 上下文格式：Markdown
- 问题分级：自动推断（关键词匹配）

#### Codex 适配器
- 不支持 `stream-json`（纯文本输出）
- 不支持 `stdin` 交互
- 上下文格式：纯文本 prompt
- 无问答机制

### 3. 通用适配器模板（`GenericCLIAdapter`）

允许用户通过配置快速接入新的 CLI Agent 工具：

```typescript
new GenericCLIAdapter({
  name: 'opencode',
  command: 'opencode',
  buildArgs: (options) => ['--file', options.contextFilePath],
  contextTemplate: (task, deps) => `Task: ${task.description}`,
  parseOutput: (raw) => ({ type: 'log', content: raw }),
  healthCheckArgs: '--version'
})
```

### 4. Agent 适配器注册表（`AgentAdapterRegistry`）

```typescript
const registry = new AgentAdapterRegistry();

// 注册内置适配器
registry.register(new ClaudeCodeAdapter());
registry.register(new CodexAdapter());

// 注册第三方适配器
registry.register(new GenericCLIAdapter({ ... }));

// 健康检查
await registry.checkAll();  // 返回所有工具的可用性
```

---

## 🔧 使用方式

### 1. 配置文件扩展

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
      "priority": 3,
      "adapter": "generic",
      "adapterConfig": {
        "args": ["--file", "{contextFile}"],
        "contextFormat": "markdown"
      }
    }
  },
  "taskAgentMapping": {
    "code-analysis": "claude-code",
    "code-generation": "codex",
    "ui-generation": "opencode",
    "default": "claude-code"
  }
}
```

### 2. 启动时健康检查

```
[10:30:00] 🧠 Leader: Agent 健康检查...
[10:30:00] ✅ claude-code: available
[10:30:00] ✅ codex: available
[10:30:00] ❌ opencode: not found (disabled)
```

### 3. 任务自动分配 Agent 工具

- 根据 `taskAgentMapping` 配置
- 根据优先级自动选择可用工具
- 工具不可用时自动 fallback 到默认工具

### 4. CLI 输出展示工具名称

```
[10:30:10] 🔧 sub-1 (claude-code): 正在分析代码库...
[10:30:20] 🔨 sub-2 (codex): 开始代码生成...
[10:30:30] 🎨 sub-3 (opencode): ⚠️ Agent 工具不可用，fallback to claude-code
```

---

## 📊 新增功能需求

### 4.8 Agent 适配器与可扩展性

| ID | 需求描述 | 优先级 |
|----|----------|--------|
| F-51 | 定义标准 Agent 适配器接口（`IAgentAdapter`） | P0 |
| F-52 | 实现 Claude Code 适配器 | P0 |
| F-53 | 实现 Codex 适配器 | P0 |
| F-54 | 提供通用适配器模板（`GenericCLIAdapter`） | P1 |
| F-55 | Agent 适配器注册表（`AgentAdapterRegistry`） | P1 |
| F-56 | 子任务支持指定使用的 Agent 工具 | P1 |
| F-57 | 启动时自动健康检查所有 Agent 工具 | P1 |
| F-58 | 支持通过配置文件加载第三方适配器（插件式加载） | P2 |

---

## 🎨 CLI 命令新增

| 命令 | 说明 |
|------|------|
| `ato adapters list` | 列出所有已注册的 Agent 适配器 |
| `ato adapters check` | 健康检查所有 Agent 工具的可用性 |
| `ato adapters info <name>` | 查看指定适配器的详细信息 |
| `ato run "任务" --agent opencode` | 使用指定 Agent 工具启动任务 |

---

## 🗺️ 里程碑调整

### P0 阶段（第1周）新增交付物
- **Agent 适配器架构**：`IAgentAdapter` 接口定义 + 注册表实现
- **Claude Code 适配器**：完整实现
- **适配器接口设计验证**：能支撑 Codex 的接入

### P1 阶段（第2-3周）新增验证点
- ✅ Claude Code 和 Codex 混用无问题
- ✅ 适配器接口稳定，无需调整即可支持 Codex

### P2 阶段（第4周）新增交付物
- **通用适配器模板**：`GenericCLIAdapter` 实现
- ✅ 第三方 Agent 工具（如 OpenCode）可通过通用适配器接入

### P4 阶段（第6-8周）新增交付物
- ✅ 至少 3 个第三方 Agent 工具适配器示例（OpenCode、KimiCode、Cursor CLI）

---

## 🔍 技术亮点

### 1. 隔离与封装

每个适配器封装了工具特定的：
- 启动参数（如 Claude Code 的 `-p` vs Codex 的 `--prompt-file`）
- 输出格式（stream-json vs 纯文本）
- 上下文格式（Markdown vs 纯文本）
- 问答协议（Claude Code 的 AskUserQuestion vs 无）

主调度器只关心统一的接口，不关心底层实现差异。

### 2. 降级与 Fallback

```typescript
async spawnFreshAgent(task: Task) {
  const agentName = task.agentTool || this.config.defaultAgent;
  const adapter = this.registry.get(agentName);
  
  if (!adapter) {
    console.warn(`⚠️ Agent ${agentName} not found, fallback to ${this.config.defaultAgent}`);
    adapter = this.registry.get(this.config.defaultAgent);
  }
  
  // ...
}
```

### 3. 特性标识（Feature Flags）

每个适配器声明支持的特性：

```typescript
supportedFeatures: {
  streamJson: true,         // 是否支持 stream-json
  stdinInteraction: true,   // 是否支持 stdin 交互
  contextFile: true,        // 是否支持上下文文件
  workspaceIsolation: true  // 是否支持独立工作空间
}
```

主调度器根据特性选择不同的执行路径：
- 如果不支持 `stdinInteraction`，则跳过问答机制
- 如果不支持 `streamJson`，则使用行缓冲解析输出

---

## 🌍 社区生态构想（未来）

### 适配器市场

1. **模板生成器**：
   ```bash
   ato adapters create opencode
   # 生成 opencode-adapter.js 模板
   ```

2. **社区发布**：
   ```bash
   npm publish @ato-adapters/opencode
   ```

3. **一键安装**：
   ```bash
   ato adapters install opencode
   # 自动下载 + 注册 + 健康检查
   ```

### 质量标准

- 必须通过标准测试套件
- 必须提供文档（支持的特性、已知限制、配置示例）
- 建议提供验证脚本模板

---

## 📊 对比总结

| 维度 | v3.0 | v3.1 |
|------|------|------|
| **支持的 Agent 工具** | 仅 Claude Code + Codex（硬编码） | 任意 CLI Agent 工具（可扩展） |
| **新增工具流程** | 修改代码 | 提供适配器（配置或代码） |
| **适配器类型** | 无 | 内置 / 通用 / 第三方插件 |
| **健康检查** | 无 | 启动时自动检查 |
| **Fallback 机制** | 无 | 工具不可用时自动降级 |
| **CLI 可见性** | Agent ID | Agent ID + 工具名称 |
| **配置复杂度** | 低 | 中（新增 agents 配置块） |
| **扩展性** | 低 | 高（插件式架构） |

---

## ⚠️ 向后兼容性

### 配置文件

v3.0 的配置文件在 v3.1 中仍然有效：

```json
// v3.0
{
  "claudePath": "claude",
  "codexPath": "codex"
}

// v3.1 自动转换为
{
  "agents": {
    "claude-code": { "path": "claude" },
    "codex": { "path": "codex" }
  }
}
```

### API

所有 v3.0 的调度逻辑在 v3.1 中仍然适用，只是内部实现改为通过适配器调用。

---

## 💡 实施建议

### 优先级

1. **P0 阶段**：先实现 `IAgentAdapter` 接口 + Claude Code 适配器，验证接口设计
2. **P1 阶段**：实现 Codex 适配器，验证适配器能否适配不同特性的工具
3. **P2 阶段**：实现通用适配器模板，用一个真实的第三方工具（如 OpenCode）验证

### 风险

| 风险 | 概率 | 缓解措施 |
|------|------|----------|
| 适配器接口设计不合理 | 中 | P0 阶段同时实现 Claude Code + Codex 两个差异较大的适配器，提前暴露接口问题 |
| 第三方工具协议差异大 | 高 | 提供足够灵活的 `GenericCLIAdapter`，允许用户自定义解析逻辑 |
| 适配器质量参差不齐 | 中 | 建立测试套件 + 文档标准 |

---

## 🚀 下一步行动

1. **评审 `IAgentAdapter` 接口设计**：确认接口能覆盖常见 CLI Agent 工具的差异
2. **P0 原型验证**：同时实现 Claude Code + Codex 适配器，验证接口稳定性
3. **选择试点工具**：选择一个真实的第三方工具（如 OpenCode / KimiCode）作为 P2 验证对象

---

**文档版本**: v3.1 (Extensible Agent Adapter Edition)  
**升级时间**: 2026-06-11  
**关键变化**: 从"硬编码 Claude Code + Codex"到"可扩展的 Agent 适配器架构"  
**向后兼容**: ✅ 完全兼容 v3.0
