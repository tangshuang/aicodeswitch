# Supervisor Agent PRD v3.0 升级说明

## 概述

基于 2025-2026 年 Loop Engineering 最新实践，PRD 从 v2.0 升级到 **v3.0 (Loop Engineering Edition)**。核心变化是从"长驻进程 + 问答协议"转向"**Ralph Loop + 验证门控**"范式。

---

## 🔄 范式转变

### v2.0（旧）：长驻进程模式
```
主 Agent 启动多个子 Agent 进程 → 子 Agent 保持运行 
→ 通过 stdin/stdout 多轮对话 
→ 子 Agent 报告"完成" 
→ 主 Agent 信任报告，标记完成
```

**问题**：
- 上下文累积导致漂移
- Agent 自我报告不可靠
- 进程管理复杂（需要维护长驻进程池）

### v3.0（新）：Ralph Loop 模式
```
主 Agent 循环：选一个就绪任务 
→ spawn 全新子 Agent 进程（全新上下文窗口） 
→ 子 Agent 退出 
→ 执行外部验证脚本（测试/编译/检查） 
→ 通过则完成，失败则重试
```

**优势**：
- 无上下文累积（每次全新进程）
- 验证脚本裁定，Agent 无法"说谎"
- 实现简单（无长驻进程，无复杂通信）

---

## 📊 核心架构变更

### 1. 新增模块

| 模块 | 职责 |
|------|------|
| **Verification Engine** | 执行任务验证脚本（测试运行器、编译检查、grep 断言等） |
| **Token Budget Tracker** | 追踪总 Token 消耗，达到上限时提前终止 |

### 2. 模块职责变化

| 模块 | v2.0 | v3.0 |
|------|------|------|
| **Scheduler** | 并行调度多个子任务 | Ralph Loop：每轮选一个任务，串行执行（可配置并发数） |
| **Process Manager** | 维护长驻子进程池 | 每次 spawn 全新进程 |

---

## 🎯 新增功能需求

### 验证门控相关（F-44 ~ F-48）
- F-44: 每个子任务必须声明 `verificationScript`
- F-45: 支持验证脚本类型（shell 命令、可执行文件、内置检查器）
- F-46: Ralph Loop 调度模式
- F-47: 子 Agent 全新进程 + 全新上下文窗口
- F-48: 验证脚本执行（exit code 0 = 通过）

### Token 预算控制（F-49 ~ F-50）
- F-49: 全局 Token 计数器，达到预算上限时拒绝启动新子任务
- F-50: Token 预算可配置为总量限制或单任务限制

---

## 📝 技术规格重大更新

### 新增章节：5.0 Loop Engineering 架构概述

详细介绍了三大核心模式：

1. **Ralph Loop 模式**（来自 Vercel、Atomic 等）
   - Atomic Tasks
   - Verification-Gated Exit
   - Fresh Context Each Iteration

2. **Agent Loop (Plan-Act-Observe-Reflect)**（来自 Hugging Face、KI-Campus）
   - 子 Agent 内部的推理循环
   - 与 Ralph Loop 的协同关系

3. **验证门控（Verification Gates）**（来自 NiteAgent、Google Cloud）
   - Hard Stops（语法级）
   - Eval Gates（功能级）
   - Circuit Breakers（行为级）

### 代码示例更新

**5.3 主 Agent 调度核心逻辑**：
- 从"并行调度多任务"改为"Ralph Loop 单任务迭代"
- 新增 `spawnFreshAgent()`（每次全新进程）
- 新增 `runVerification()`（执行验证脚本）
- 新增 Token 预算检查逻辑

**5.4 工作目录结构**：
- 新增 `.team/tasks/<id>/context.md`（每次运行前重新生成）
- 新增 `.team/tasks/<id>/verification.sh`（验证脚本）
- 新增 `.team/tasks/<id>/state.json`（任务状态）

**5.5 配置文件**：
- 新增 `ralphLoopMode`（启用 Ralph Loop）
- 新增 `tokenBudget` 配置块
- 新增 `verificationDefaults` 配置块
- 新增 `atomicCommits`（自动 git commit）

---

## 🗺️ 里程碑调整

### 关键验证点前置

v3.0 强调"验证假设优先于实现功能"，每个阶段都明确了关键验证点：

| 阶段 | 新增验证点 |
|------|-----------|
| P0 | ✅ 验证 Claude Code headless 模式下 `AskUserQuestion` 行为 |
| P1 | ✅ 单个 Ralph Loop 能够成功完成 3 个串行任务<br>✅ 验证脚本能正确判断任务成败 |
| P2 | ✅ 崩溃恢复时间 < 1秒 |
| P3 | ✅ 故意注入失控 Agent，系统能正确熔断<br>✅ Token 预算耗尽时优雅停止 |

---

## 📚 新增参考资料

v3.0 附录新增 **11.4 Loop Engineering 参考资料** 章节，包含 30+ 最新资源（2025-2026）：

### 核心模式文献
- Ralph Loop 模式（5 篇）
- Agent Loop (PAOR)（4 篇）
- 多 Agent 编排实践（4 篇，含 Anthropic 官方）
- 状态管理与记忆（3 篇）
- 生产级 Guardrails（3 篇）

### 关键引用

> "**Do not make the prompt the memory system. Store memory outside the model.**"  
> — Hugging Face

> "**Most AI agents fail silently. Hard stops, eval gates, circuit breakers.**"  
> — NiteAgent

> "**The Ralph Loop is deterministically mediocre — reliably average at each iteration.**"  
> — Thomas Wiegold

---

## ⚠️ 风险更新

### 新增风险

| 风险 | 概率 | 缓解措施 |
|------|------|----------|
| **验证脚本编写成本高** | 中 | 提供内置验证器库；主 Agent 自动生成常见验证脚本 |
| **Token 预算超支** | 中 | 实时追踪，达到 90% 时警告，100% 时硬停止 |

### 待验证假设新增

5. **验证脚本的覆盖度**：常见任务类型（代码生成、重构、测试编写）是否都能找到可靠的验证方法

---

## 🎨 用户体验变化

### CLI 输出（群聊风格）保持不变

但新增验证脚本执行的可见性：

```
[10:30:00] 🧠 Leader: 开始任务分解...
[10:30:05] 🧠 Leader: 已创建团队 - 子任务: sub-1, sub-2

[10:30:10] 🔧 sub-1: 正在分析代码库... (Claude Code 运行中)
[10:30:20] 🔧 sub-1: 进程退出，开始验证...
[10:30:21] ✅ sub-1: 验证通过 (npm test unit/analyzer.test.js)
[10:30:21] 📝 sub-1: 已自动提交 (git commit -m "✅ sub-1 completed")

[10:30:22] 🔨 sub-2: 🚀 开始执行...
```

---

## 💡 实施建议

### 优先级调整

1. **P0 阶段必须验证 Ralph Loop 可行性**  
   如果 Claude Code headless 下无法获取 stdout 或验证脚本不可靠，整个设计需要回退到 v2.0

2. **从固定 DAG 开始**  
   不要一开始就做 AI 动态分解，先用硬编码的 3 个任务验证 Ralph Loop

3. **验证脚本库是关键**  
   开发一套通用验证脚本（compile-check、test-runner、lint-check、grep-assert）可以大幅降低使用门槛

---

## 📊 对比总结

| 维度 | v2.0 | v3.0 |
|------|------|------|
| **核心模式** | 长驻进程 + 问答协议 | Ralph Loop + 验证门控 |
| **子 Agent 生命周期** | 长驻（多轮对话） | 短生命（单次运行） |
| **完成判断** | Agent 自我报告 | 外部验证脚本 |
| **上下文管理** | 累积（容易漂移） | 每次全新（无漂移） |
| **成本控制** | 无 | Token 预算 + 硬停止 |
| **实现复杂度** | 中等（需维护长驻进程池） | 低（简单循环 + spawn） |
| **可靠性** | 中 | 高（验证脚本裁定） |
| **业界实践对齐** | 少 | 强（Vercel、Anthropic、Google Cloud 均采用类似模式） |

---

## 🚀 下一步行动

1. **立即开始 P0 原型验证**：优先验证 Claude Code headless 下的行为
2. **准备验证脚本库**：开发 5-10 个通用验证脚本模板
3. **调研 AICodeSwitch 集成点**：确认 Token 统计 API 是否可用
4. **与团队讨论**：确认 Ralph Loop 范式是否被接受

---

**文档版本**: v3.0 (Loop Engineering Edition)  
**升级时间**: 2026-06-11  
**下次审阅**: P0 原型验证完成后
