# Agent 团队编排系统 - 快速参考卡片

## 🎯 核心理念（5 秒版）

> 简单循环 + 外部验证 + 全新上下文 + **可扩展 Agent 工具** = 可靠的多 Agent 系统

---

## 🔄 Ralph Loop 一句话

每轮选一个任务 → spawn 全新 Agent 进程 → Agent 退出后运行验证脚本 → 通过则完成，失败则重试

---

## 📐 架构四要素

1. **主 Agent (Leader)**：调度器，选任务、spawn 子进程、执行验证
2. **子 Agent (Worker)**：任意 CLI Agent 工具进程（Claude Code / Codex / OpenCode / ...），每次运行后立即退出
3. **验证脚本 (Verification Script)**：外部检查（测试/编译），裁定任务成败
4. **Agent 适配器 (Agent Adapter)**：统一封装不同 CLI Agent 工具的差异（启动参数、输出格式、上下文格式）

---

## 🔌 Agent 适配器架构（新增 v3.1）

### 标准接口（`IAgentAdapter`）

```typescript
interface IAgentAdapter {
  name: string;              // "claude-code" / "codex" / "opencode"
  version: string;
  supportedFeatures: {
    streamJson: boolean;     // 是否支持 stream-json 输出
    stdinInteraction: boolean; // 是否支持 stdin 交互（问答）
    contextFile: boolean;    // 是否支持上下文文件
    workspaceIsolation: boolean;
  };
  
  spawn(options): Promise<AgentProcess>;
  generateContextFile(task, deps): Promise<string>;
  parseOutput(rawOutput): AgentOutput;
  checkHealth(): Promise<boolean>;
}
```

### 内置适配器

| 适配器 | stream-json | stdin 交互 | 上下文格式 |
|--------|------------|-----------|-----------|
| **Claude Code** | ✅ | ✅ (需验证) | Markdown |
| **Codex** | ❌ | ❌ | 纯文本 |

### 通用适配器（快速接入第三方工具）

```typescript
new GenericCLIAdapter({
  name: 'opencode',
  command: 'opencode',
  buildArgs: (opts) => ['--file', opts.contextFilePath],
  contextTemplate: (task, deps) => `Task: ${task.description}`,
  parseOutput: (raw) => ({ type: 'log', content: raw }),
  healthCheckArgs: '--version'
})
```

---

## ⚙️ 配置文件关键项（v3.1）

```json
{
  "defaultAgent": "claude-code",    // 默认 Agent 工具
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
      "enabled": false,             // 可选的第三方工具
      "path": "/usr/local/bin/opencode",
      "adapter": "generic",
      "adapterConfig": { ... }
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

---

## 🎨 CLI 输出示例（v3.1）

```
[10:30:00] 🧠 Leader: Agent 健康检查...
[10:30:00] ✅ claude-code: available
[10:30:00] ✅ codex: available
[10:30:00] ❌ opencode: not found (disabled)

[10:30:10] 🔧 sub-1 (claude-code): 🚀 开始执行
[10:30:25] ✅ sub-1 (claude-code): 验证通过

[10:30:27] 🔧 sub-2 (codex): 🚀 开始执行
[10:30:40] ✅ sub-2 (codex): 验证通过

[10:30:42] 🎨 sub-3 (opencode): ⚠️ Agent 工具不可用，fallback to claude-code
[10:30:42] 🔧 sub-3 (claude-code): 🚀 开始执行
```

**新增特性**：
- 启动时健康检查所有 Agent 工具
- 每个任务显示使用的工具名称
- 自动 fallback 机制

---

## 🔧 CLI 命令（v3.1 新增）

| 命令 | 说明 |
|------|------|
| `ato adapters list` | 列出所有已注册的 Agent 适配器 |
| `ato adapters check` | 健康检查所有 Agent 工具的可用性 |
| `ato adapters info <name>` | 查看指定适配器的详细信息 |
| `ato run "任务" --agent opencode` | 使用指定 Agent 工具启动任务 |

---

## 📊 Agent Loop (PAOR) vs Ralph Loop

| | Agent Loop | Ralph Loop |
|---|---|---|
| **层级** | 单个 Agent 内部 | 多 Agent 外部调度 |
| **目的** | Agent 如何推理 | 如何编排多个 Agent |
| **循环体** | Plan → Act → Observe → Reflect | 选任务 → 启动 → 验证 → 下一轮 |
| **运行位置** | CLI Agent 工具内部 | 编排器 |

**关系**：子 Agent 内部跑 PAOR 循环，主 Agent 外部跑 Ralph Loop

---

## 🔑 关键设计决策

| 决策 | 理由 |
|------|------|
| **短生命周期子 Agent** | 避免上下文累积导致漂移 |
| **外部验证脚本** | Agent 自我报告不可靠 |
| **Token 预算控制** | 防止成本失控 |
| **Atomic Commits** | 每个任务一个 commit，可追溯可回滚 |
| **无状态运行 + 持久化环境** | 状态在磁盘，Agent 从磁盘读取 |
| **Agent 适配器架构** | 支持任意 CLI Agent 工具，无需修改核心代码 |

---

## 🔁 主 Agent 调度伪代码（v3.1）

```javascript
const registry = new AgentAdapterRegistry();
registry.register(new ClaudeCodeAdapter());
registry.register(new CodexAdapter());

await registry.checkAll();  // 健康检查

while (true) {
  task = selectNextTask()
  if (!task) break
  
  if (tokenBudget.spent >= tokenBudget.total) break
  
  // 选择 Agent 适配器
  adapter = registry.get(task.agentTool || config.defaultAgent)
  if (!adapter) {
    adapter = registry.get(config.defaultAgent)  // fallback
  }
  
  // 生成上下文文件（适配器负责格式转换）
  contextContent = await adapter.generateContextFile(task)
  
  // Spawn 全新进程
  proc = await adapter.spawn({ contextFilePath, ... })
  
  // 等待退出后验证
  result = runVerification(task)
  if (result.success) {
    markCompleted(task)
    gitCommit(task)
  } else {
    retry(task)
  }
}
```

---

## 🔌 如何接入新的 CLI Agent 工具（3 种方式）

### 1. 通过配置文件（最简单）

```json
{
  "agents": {
    "opencode": {
      "enabled": true,
      "path": "opencode",
      "adapter": "generic",
      "adapterConfig": {
        "args": ["--file", "{contextFile}"],
        "contextFormat": "markdown"
      }
    }
  }
}
```

### 2. 编写自定义适配器（灵活）

```javascript
// ~/.ato/adapters/opencode.js
module.exports = {
  name: 'opencode',
  command: 'opencode',
  features: { streamJson: false, stdinInteraction: false },
  buildArgs: (opts) => ['--file', opts.contextFilePath],
  contextTemplate: (task, deps) => `Task: ${task.description}`,
  parseOutput: (raw) => ({ type: 'log', content: raw }),
  healthCheckArgs: '--version'
};
```

### 3. 实现完整适配器类（完全控制）

```typescript
class OpenCodeAdapter implements IAgentAdapter {
  name = 'opencode';
  // ... 实现所有接口方法
}

registry.register(new OpenCodeAdapter());
```

---

## 🚦 验证门控三层

| 层级 | 检查内容 | 失败后果 |
|------|----------|----------|
| **Hard Stops** | 语法（编译/格式） | 强制失败，不重试 |
| **Eval Gates** | 功能（测试） | 重试 N 次 |
| **Circuit Breakers** | 行为（Token/死循环） | 熔断整个任务 |

---

## 💰 Token 预算工作流程

```
启动任务前：spent < total ? 允许 : 拒绝
任务运行中：通过 AICodeSwitch 代理统计 Token 消耗
任务结束后：spent += thisTaskTokens
达到 90% total：警告
达到 100% total：停止启动新任务（已运行的可完成）
```

---

## 🚨 反模式（不要这样做）

| 反模式 | 正确做法 |
|--------|----------|
| ❌ 信任 Agent 的"完成"报告 | ✅ 用验证脚本裁定 |
| ❌ 让 Agent 长驻进程多轮对话 | ✅ 每次全新进程 |
| ❌ 把所有历史消息塞进 prompt | ✅ 只给当前任务需要的上下文 |
| ❌ 无 Token 预算控制 | ✅ 设置预算 + 硬停止 |
| ❌ 硬编码支持的 Agent 工具 | ✅ 使用适配器架构 |

---

## 📞 快速决策指南

**何时使用 ATO？**
- 任务可分解为多个独立子任务
- 每个子任务有明确的验证标准
- 预期 Token 消耗 > 100k
- 需要混用多种 CLI Agent 工具

**何时不用 ATO？**
- 单一任务（用单个 CLI Agent 足够）
- 无法定义验证脚本（纯创意/探索性任务）
- 实时性要求高（< 1 分钟响应）

---

**文档版本**: v3.1 (Extensible Agent Adapter Edition)  
**最后更新**: 2026-06-11  
**完整 PRD**: `supervisor-agent.md`  
**变更日志**: `supervisor-agent-v3.1-changelog.md`

---

## 🔄 Ralph Loop 一句话

每轮选一个任务 → spawn 全新 Agent 进程 → Agent 退出后运行验证脚本 → 通过则完成，失败则重试

---

## 📐 架构三要素

1. **主 Agent (Leader)**：调度器，选任务、spawn 子进程、执行验证
2. **子 Agent (Worker)**：Claude Code / Codex 进程，每次运行后立即退出
3. **验证脚本 (Verification Script)**：外部检查（测试/编译），裁定任务成败

---

## 🔑 关键设计决策

| 决策 | 理由 |
|------|------|
| **短生命周期子 Agent** | 避免上下文累积导致漂移 |
| **外部验证脚本** | Agent 自我报告不可靠 |
| **Token 预算控制** | 防止成本失控 |
| **Atomic Commits** | 每个任务一个 commit，可追溯可回滚 |
| **无状态运行 + 持久化环境** | 状态在磁盘，Agent 从磁盘读取 |

---

## 📁 目录结构（核心文件）

```
.team/
├── logs.jsonl                  # 团队日志
├── state-snapshot.json         # 状态快照
└── tasks/
    └── sub-1/
        ├── context.md          # 每次运行前重新生成
        ├── spec.md             # 固定规格
        ├── verification.sh     # 验证脚本
        └── state.json          # 运行时状态（重试次数、Token 消耗）
```

---

## 🔧 子任务定义模板

```json
{
  "id": "sub-1",
  "description": "分析 src/ 目录的代码质量",
  "dependencies": [],
  "expectedOutput": "artifacts/sub-1/report.json",
  "verificationScript": "test -f artifacts/sub-1/report.json && jq -e '.issues | length > 0' artifacts/sub-1/report.json",
  "workspace": "shared"
}
```

---

## ✅ 验证脚本示例

### 1. 编译检查
```bash
npm run build
```

### 2. 单元测试
```bash
npm test -- unit/foo.test.js
```

### 3. 自定义检查
```bash
# 检查是否没有 TODO 注释
! grep -r "TODO" src/
```

### 4. 产出物存在性
```bash
test -f artifacts/sub-1/output.json
```

### 5. JSON schema 验证
```bash
ajv validate -s schema.json -d artifacts/sub-1/output.json
```

---

## ⚙️ 配置文件关键项

```json
{
  "ralphLoopMode": true,           // 启用 Ralph Loop
  "maxConcurrency": 1,             // 串行执行（可改为 N 并行）
  "tokenBudget": {
    "total": 500000,               // 总 Token 预算
    "perTask": 50000               // 单任务上限
  },
  "retryCount": 2,                 // 失败重试次数
  "atomicCommits": true,           // 自动 git commit
  "failureStrategy": "replan"      // abort / skip / replan
}
```

---

## 🔁 主 Agent 调度伪代码

```javascript
while (true) {
  task = selectNextTask()  // 拓扑排序选择就绪任务
  if (!task) break
  
  if (tokenBudget.spent >= tokenBudget.total) break
  
  generateContextFile(task)
  exitCode = spawnFreshAgent(task)  // 全新进程
  
  result = runVerification(task)
  if (result.success) {
    markCompleted(task)
    gitCommit(task)
  } else {
    retry(task)
  }
}
```

---

## 📊 Agent Loop (PAOR) vs Ralph Loop

| | Agent Loop | Ralph Loop |
|---|---|---|
| **层级** | 单个 Agent 内部 | 多 Agent 外部调度 |
| **目的** | Agent 如何推理 | 如何编排多个 Agent |
| **循环体** | Plan → Act → Observe → Reflect | 选任务 → 启动 → 验证 → 下一轮 |
| **运行位置** | Claude Code 内部 | 编排器 |

**关系**：子 Agent 内部跑 PAOR 循环，主 Agent 外部跑 Ralph Loop

---

## 🚦 验证门控三层

| 层级 | 检查内容 | 失败后果 |
|------|----------|----------|
| **Hard Stops** | 语法（编译/格式） | 强制失败，不重试 |
| **Eval Gates** | 功能（测试） | 重试 N 次 |
| **Circuit Breakers** | 行为（Token/死循环） | 熔断整个任务 |

---

## 💰 Token 预算工作流程

```
启动任务前：spent < total ? 允许 : 拒绝
任务运行中：通过 AICodeSwitch 代理统计 Token 消耗
任务结束后：spent += thisTaskTokens
达到 90% total：警告
达到 100% total：停止启动新任务（已运行的可完成）
```

---

## 🎨 CLI 输出示例

```
[10:30:00] 🧠 Leader: 开始任务分解...
[10:30:05] 🧠 Leader: 已创建团队 - 子任务: 3 个

[10:30:10] 🔧 sub-1: 🚀 开始执行 (Claude Code spawned)
[10:30:25] 🔧 sub-1: 进程退出，开始验证...
[10:30:26] ✅ sub-1: 验证通过 (npm test)
[10:30:26] 📝 sub-1: git commit "✅ sub-1 completed"

[10:30:27] 🔧 sub-2: 🚀 开始执行...
[10:30:40] 🔧 sub-2: 进程退出，开始验证...
[10:30:41] ❌ sub-2: 验证失败 (test failed)
[10:30:41] 🔄 sub-2: 重试 (1/2)

[10:30:42] 🔧 sub-2: 🚀 重试执行...
[10:30:55] 🔧 sub-2: 进程退出，开始验证...
[10:30:56] ✅ sub-2: 验证通过
[10:30:56] 📝 sub-2: git commit "✅ sub-2 completed"

[10:30:57] 💰 Token 预算: 已消耗 450k / 500k (90%)
[10:30:57] ⚠️  Token 预算警告：接近上限

[10:30:58] 🔧 sub-3: 🚀 开始执行...
```

---

## 🔗 核心参考资料（前 3）

1. [Ralph Wiggum - Viral Agentic Coding Loop](https://ralph-wiggum.ai/)
2. [Anthropic: How We Built Our Multi-Agent Research System](https://www.anthropic.com/engineering/multi-agent-research-system)
3. [Google Cloud: Ralph Loop with ADK - AI Agents That Verify, Not Guess](https://medium.com/google-cloud/ralph-loop-with-google-adk-ai-agents-that-verify-not-guess-b41f71c0f30f)

---

## ⚡ P0 原型验证清单

- [ ] Claude Code headless 下 `AskUserQuestion` 行为正常
- [ ] stream-json 双向通信可行
- [ ] 验证脚本能正确判断任务成败（测试 10 次，成功率 > 95%）
- [ ] 单个 Ralph Loop 能完成 3 个串行任务
- [ ] Token 统计准确（误差 < 5%）

---

## 🚨 反模式（不要这样做）

| 反模式 | 正确做法 |
|--------|----------|
| ❌ 信任 Agent 的"完成"报告 | ✅ 用验证脚本裁定 |
| ❌ 让 Agent 长驻进程多轮对话 | ✅ 每次全新进程 |
| ❌ 把所有历史消息塞进 prompt | ✅ 只给当前任务需要的上下文 |
| ❌ 无 Token 预算控制 | ✅ 设置预算 + 硬停止 |
| ❌ 并行启动所有就绪任务 | ✅ Ralph Loop 迭代式单任务（或限制并发数） |

---

## 📞 快速决策指南

**何时使用 ATO？**
- 任务可分解为多个独立子任务
- 每个子任务有明确的验证标准
- 预期 Token 消耗 > 100k

**何时不用 ATO？**
- 单一任务（用单个 Claude Code 足够）
- 无法定义验证脚本（纯创意/探索性任务）
- 实时性要求高（< 1 分钟响应）

---

**文档版本**: v3.0  
**最后更新**: 2026-06-11  
**完整 PRD**: `supervisor-agent.md`
