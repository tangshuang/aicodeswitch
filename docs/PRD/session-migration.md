# PRD: 会话迁移（Session Migration）

**文档版本:** 1.1
**创建日期:** 2026-06-09
**最后更新:** 2026-06-09
**状态:** Draft

---

## 1. 背景与动机

AICodeSwitch 作为 Claude Code 和 Codex 的统一代理中间件，用户经常在两个工具之间切换使用。当前存在一个核心痛点：**用户在 Claude Code（或 Codex）中进行了大量对话后，切换到另一个工具时必须从零开始，无法携带之前的对话上下文。**

这意味着：
- 需求分析、代码架构讨论等前期工作无法跨工具复用
- 遇到上游 API 故障时，无法无缝切换到另一个工具继续工作
- 无法利用两个工具各自的特长协作完成复杂任务

**目标：** 从 AICodeSwitch 已记录的会话日志中，提取对话上下文，经过格式适配和内容摘要化，生成一个可以在目标工具中直接使用的迁移 Prompt，使用户在目标工具的新会话中获得足够的背景信息继续工作。

---

## 2. 用户场景

### 场景一：跨工具继续编码

用户在 Claude Code 中完成了需求分析和代码架构讨论，现在想用 Codex 来执行具体的代码实现。需要把之前的讨论摘要和关键决策带入新会话。

### 场景二：工具故障切换

当 Claude Code（或 Codex）遇到上游 API 故障时，用户希望将当前会话的上下文迁移到另一个工具继续工作，避免丢失已有的讨论成果。

### 场景三：工具体验对比

用户想用同一个任务分别在 Claude Code 和 Codex 上尝试，比较两个工具的输出质量。需要把相同的上下文输入给两个工具。

### 场景四：会话存档复用

用户之前的 Claude Code 会话中有价值的讨论（如架构设计、Bug 排查记录），想将其作为上下文注入到新的 Codex 会话中。

---

## 3. 可行性分析

### 3.1 已有基础设施（可直接复用）

| 基础设施 | 说明 | 代码位置 |
|---|---|---|
| Session 数据模型 | 包含 id、targetType、title、requestCount、totalTokens 等 | `src/types/index.ts` Session 接口 |
| 会话日志索引 | `sessionLogIndex` (Map) + `session-log-index.json` | `src/server/fs-database.ts` |
| 完整日志记录 | 每条 RequestLog 包含 body、responseBody、downstreamResponseBody | `src/types/index.ts` RequestLog 接口 |
| SSE 解析能力 | `parseSSEChunks` + `assembleStreamText` 可从流式数据中提取文本 | `src/ui/pages/SessionsPage.tsx` 行 20-134 |
| Claude ↔ Responses 转换器 | 完整的双向请求体转换 | `src/server/conversions/pairs/claude-responses/` 和 `pairs/responses-claude/` |
| 对话视图组件 | `ChatViewFromSessionLogs` 组件已能展示会话聊天记录 | `src/ui/pages/SessionsPage.tsx` 行 495-587 |
| 消息提取函数 | `extractChatMessagesFromLogs` 已实现日志→聊天消息的转换 | `src/ui/pages/SessionsPage.tsx` 行 329-362 |
| Session API | 已有 getSessions、getSessionLogs、deleteSession 等完整 CRUD | `src/ui/api/client.ts` |

### 3.2 核心技术挑战

#### 挑战 1：工具调用无法直接迁移

- **Claude Code 工具集**：Bash、Read、Write、Edit、Glob、Grep、TodoWrite、Agent 等
- **Codex 工具集**：shell、apply_diff、create_file 等
- 两者的工具名称、参数结构、调用语义完全不同
- **结论：** 工具调用历史无法格式转换，只能做摘要描述

#### 挑战 2：系统提示词差异

- 每个工具有自己的系统提示词（包含工具使用说明、权限控制等）
- 直接迁移会导致目标工具收到不相关的系统指令
- **结论：** 迁移时不包含源工具的 system prompt，只迁移用户与助手的对话内容

#### 挑战 3：上下文窗口限制

- 长会话的完整对话历史可能超过目标模型的上下文窗口
- **结论：** 需要提供摘要/截断策略，让用户选择迁移内容的深度

#### 挑战 4：Thinking/Reasoning 内容

- Claude Code 使用 `thinking` block
- Codex 使用 `reasoning` item
- 已有转换器可处理格式差异，但 thinking 内容通常体量很大
- **结论：** 默认不迁移 thinking 内容，提供选项让用户选择是否包含

### 3.3 可行性结论

**技术完全可行。** 关键决策是选择"摘要式迁移"而非"格式转换式迁移"：

| 迁移方式 | 可行性 | 说明 |
|---|---|---|
| 格式转换式（直接转换 messages/input 数组） | ❌ 不可行 | 工具调用、tool_result 与特定工具绑定，无法跨工具使用 |
| **摘要式迁移（提取对话文本 + 生成上下文摘要文档）** | ✅ **推荐** | 对用户最有价值，复用已有的文本提取和 SSE 解析逻辑 |

---

## 4. 迁移策略

### 4.1 选定方案：混合式上下文迁移

采用"纯文本提取 + 工具调用摘要化 + 用户可编辑预览"的混合方案：

1. **纯文本提取**：从会话日志中提取所有用户消息和助手回复的文本内容
2. **工具调用摘要化**：将工具调用转换为自然语言描述（如"助手执行了 `ls -la src/` 命令"）
3. **用户可编辑预览**：在 UI 中展示迁移内容，允许用户编辑后再导出
4. **目标格式输出**：生成目标工具可直接粘贴使用的 Markdown 格式迁移 Prompt

### 4.2 迁移内容分层

| 层级 | 内容 | 处理方式 | 默认 |
|---|---|---|---|
| L1 | 用户消息文本 | 原样保留 | ✅ 包含 |
| L2 | 助手回复文本 | 原样保留 | ✅ 包含 |
| L3 | 工具调用摘要 | 转换为自然语言描述 | ✅ 包含 |
| L4 | 思考过程（thinking） | 可选包含 | ❌ 不含 |
| L5 | 文件操作详细内容 | 可选包含 | ❌ 不含 |

### 4.3 工具调用摘要化规则

| 源工具调用 | 摘要示例 |
|---|---|
| Claude Code: `Bash` `{command: "ls -la"}` | `🔧 执行命令: \`ls -la\`` |
| Claude Code: `Read` `{file_path: "/src/index.ts"}` | `📖 读取文件: /src/index.ts` |
| Claude Code: `Write` `{file_path: "/src/foo.ts"}` | `📝 写入文件: /src/foo.ts` |
| Claude Code: `Edit` `{file_path: "/src/bar.ts"}` | `✏️ 编辑文件: /src/bar.ts` |
| Claude Code: `Glob` `{pattern: "**/*.ts"}` | `🔍 搜索文件: **/*.ts` |
| Claude Code: `Grep` `{pattern: "TODO"}` | `🔍 搜索内容: TODO` |
| Codex: `shell` `{command: "npm test"}` | `🔧 执行命令: \`npm test\`` |
| Codex: `apply_diff` | `✏️ 应用代码变更` |
| Codex: `create_file` | `📝 创建文件` |
| 其他未知工具 | `🔧 调用工具: {tool_name}` |

---

## 5. 会话创建与交付机制

这是本功能的核心问题：**如何将迁移 Prompt 实际注入到目标工具的新会话中？**

采用多方案组合策略，按优先级逐级回退：

### 5.1 方案优先级

```
优先级 1: CLI 自动启动 → 失败时回退 ↓
优先级 2: 写入临时文件 + 复制指令 → 失败时回退 ↓
优先级 3: 剪贴板复制 + 手动粘贴（兜底方案）
```

### 5.2 方案一：CLI 自动启动（优先）

AICodeSwitch 服务器通过 `child_process.spawn()` 启动目标工具的 CLI 进程。

#### 两个工具的 CLI 启动能力

| 能力 | Claude Code | Codex |
|---|---|---|
| 带初始 prompt 启动 | `claude "prompt"` | `codex "prompt"` |
| 非交互模式 | `claude -p "prompt"` | `codex exec "prompt"` |
| stdin 管道输入 | `cat file \| claude -p "query"` | `echo "task" \| codex exec -` |
| 从文件读取 | 支持 stdin 重定向 | 支持 stdin 重定向 |
| 恢复已有会话 | `claude -r "session-id"` | `codex resume <SESSION_UUID>` |
| 会话存储目录 | `~/.claude/projects/<path>/<uuid>.jsonl` | `~/.codex/sessions/` |

#### 实现策略：Prompt 通过临时文件 + stdin 管道传入

直接通过命令行参数传入长 prompt 不可靠（shell 参数长度限制通常约 128KB，而迁移 prompt 可能超过此限制）。采用临时文件 + stdin 管道的方式：

**迁移到 Codex：**

```bash
# 1. 将迁移 prompt 写入临时文件
# 2. 通过 stdin 管道传入 codex exec
cat /tmp/aicodeswitch-migration-<id>.txt | codex exec -
```

或者启动交互式 TUI 会话（用户希望继续交互的场景）：

```bash
# macOS: 在新终端窗口中启动
osascript -e 'tell app "Terminal" to do script "cat /tmp/aicodeswitch-migration-<id>.txt | codex exec -"'
# Linux: 使用 xterm/gnome-terminal
gnome-terminal -- bash -c "cat /tmp/aicodeswitch-migration-<id>.txt | codex exec -"
```

**迁移到 Claude Code：**

```bash
# 非交互模式（仅获取响应）
cat /tmp/aicodeswitch-migration-<id>.txt | claude -p

# 交互模式（在新终端窗口中启动，用户可继续对话）
osascript -e 'tell app "Terminal" to do script "cd <project-dir> && cat /tmp/aicodeswitch-migration-<id>.txt | claude"'
```

#### 前置检查

在启动 CLI 前，需要检查：
1. 目标工具是否已安装（通过 `which claude` / `which codex` 或已有的 `tools-service.ts` 检测逻辑）
2. 是否在 Tauri 桌面应用环境中（Tauri 中无法直接打开新终端窗口，需用不同策略）
3. 临时文件写入是否成功

#### API 设计

新增端点 `POST /api/sessions/:id/migrate-launch`：

```json
// Request
{
  "targetTool": "codex",
  "mode": "interactive",        // "interactive" (新终端窗口) 或 "headless" (后台执行)
  "includeThinking": false,
  "includeToolCalls": true,
  "maxRounds": 0
}

// Response (成功启动)
{
  "success": true,
  "method": "cli-launch",
  "pid": 12345,                  // 启动的进程 PID
  "sessionId": "new-session-uuid", // 如果能获取到的话
  "promptFilePath": "/tmp/aicodeswitch-migration-xxx.txt",
  "command": "cat /tmp/aicodeswitch-migration-xxx.txt | codex exec -"
}

// Response (CLI 不可用，回退)
{
  "success": false,
  "method": "fallback",
  "reason": "codex CLI not found",
  "fallbackAvailable": true
}
```

### 5.3 方案二：写入临时文件 + 复制指令（回退方案）

当 CLI 启动失败（工具未安装、Tauri 环境限制等）时，采用此方案：

1. 将迁移 Prompt 写入临时文件：`/tmp/aicodeswitch-migration-<session-id>.txt`
2. 在 UI 中显示可复制的命令：

```
# 迁移到 Codex，请在终端中执行：
cat /tmp/aicodeswitch-migration-xxx.txt | codex exec -

# 或者先复制到剪贴板，再在 Codex 中粘贴
```

3. 同时提供「复制到剪贴板」按钮作为最简方案

### 5.4 方案三：剪贴板复制（兜底方案）

始终可用的最终回退：将迁移 Prompt 复制到系统剪贴板，用户手动在目标工具中粘贴。

### 5.5 交付流程（前端 UI 中的完整交互）

```
用户点击「迁移到 Codex」
        │
        ▼
┌─ 后端尝试 CLI 自动启动 ─┐
│  1. 检查 codex 是否已安装  │
│  2. 写入临时文件           │
│  3. spawn CLI 进程         │
│  4. 在新终端窗口中启动     │
└──────────────────────────┘
        │
   成功？│
   ┌─────┴──────┐
   │ 是         │ 否
   ▼            ▼
 显示成功      显示回退方案：
 "已在新       ├ 复制命令到剪贴板
  终端启动"    ├ 复制 Prompt 到剪贴板
               └ 显示手动执行说明
```

---

## 6. 技术方案

### 6.1 后端实现

#### 6.1.1 新增模块：`src/server/session-migration.ts`

核心服务模块，负责会话内容提取和迁移 Prompt 生成。

**主要函数：**

```
extractSessionContent(dbManager, sessionId, options) → MigrationContent
  - 调用 dbManager.getLogsBySessionId(sessionId) 获取会话日志
  - 对每条日志解析请求体和响应体，提取用户消息和助手回复
  - 复用 SessionsPage 中的 SSE 解析模式：parseSSEChunks + assembleStreamText
  - 对工具调用进行摘要化处理
  - 返回结构化的 MigrationContent

generateMigrationPrompt(content, targetTool, options) → string
  - 将 MigrationContent 格式化为 Markdown 迁移 Prompt
  - 根据目标工具类型调整输出格式
  - 应用 maxRounds 截断策略

estimateTokens(text) → number
  - 基于 token 估算逻辑计算 Prompt 的大致 token 数
```

**用户消息提取**（复用 `SessionsPage.tsx` 中 `extractChatItemsFromMessage` 的模式）：
- Claude Code：从 `body.messages` 数组取最后一条 `role === 'user'` 消息的 `text` 内容
- Codex：从 `body.input` 数组取最后一条 `type === 'message' && role === 'user'` 的 `input_text` 内容

**助手回复提取**（复用 `SessionsPage.tsx` 中 `extractAssistantMessagesFromLog` 的多格式解析策略）：
1. 优先从 `downstreamResponseBody`（SSE 流式数据）通过 `parseSSEChunks` + `assembleStreamText` 提取
2. 其次从 `responseBody`（JSON 格式）解析 Claude/OpenAI/Responses/Gemini 多种子格式
3. 最后从 `streamChunks` 数组中拼接

**工具调用提取**（新增逻辑）：
- Claude Code 格式：遍历 `messages` 中 `role === 'assistant'` 的 `content` 数组，找到 `type === 'tool_use'` 的 block，提取 `name` 和 `input` 字段
- Codex 格式：遍历 `input` 中 `type === 'function_call'` 的项，提取 `name` 和 `arguments` 字段
- 从助手回复的 `content` 数组中找到 `type === 'tool_use'` / SSE 事件中 `content_block_start` 的 `type === 'tool_use'` 块

#### 6.1.2 新增模块：`src/server/session-launcher.ts`

负责 CLI 进程启动和终端窗口管理。

```
checkToolInstalled(toolName) → boolean
  - 通过 which/where 命令检测目标工具是否已安装
  - 复用 tools-service.ts 中已有的检测逻辑

launchTargetTool(targetTool, promptFilePath, options) → LaunchResult
  - macOS: 通过 osascript 在新 Terminal 窗口中启动
  - Linux: 通过 gnome-terminal / xterm 启动
  - Windows: 通过 start 命令在新的 cmd 窗口中启动
  - 返回 { success, pid, command } 或错误信息

writePromptToTempFile(prompt, sessionId) → string
  - 将迁移 Prompt 写入 /tmp/aicodeswitch-migration-<sessionId>.txt
  - 返回临时文件路径

cleanupTempFile(filePath) → void
  - 清理临时文件（延迟清理，在进程启动后 30 秒执行）
```

**终端启动命令模板：**

```typescript
// macOS (Terminal.app)
const macCommand = `tell app "Terminal" to do script "cd ${projectDir} && cat ${tempFile} | ${toolCli}"`;

// macOS (iTerm2)
const itermCommand = `tell app "iTerm" to tell current window to set newTab to (create tab with default profile) then write session 1 of newTab text "cd ${projectDir} && cat ${tempFile} | ${toolCli}"`;

// Linux (gnome-terminal)
const linuxCommand = `gnome-terminal -- bash -c "cd ${projectDir} && cat ${tempFile} | ${toolCli}; exec bash"`;

// Windows
const winCommand = `start cmd /k "cd /d ${projectDir} && type ${tempFile} | ${toolCli}"`;
```

#### 6.1.3 迁移 Prompt 格式

```markdown
# 会话迁移上下文

> 以下内容从 {sourceTool} 会话「{sessionTitle}」迁移而来
> 迁移时间：{timestamp}
> 原始会话共 {totalRounds} 轮对话，此处包含最近 {extractedRounds} 轮

---

## 对话历史

### 👤 用户
{userMessage}

### 🤖 助手
{assistantText}

（如有工具调用）
> 🔧 执行命令: `npm run build`
> 📖 读取文件: src/index.ts

---

### 👤 用户
{userMessage}

### 🤖 助手
{assistantText}

---

请基于以上上下文继续工作。
```

### 6.2 API 设计

新增 3 个 API 端点：

#### `POST /api/sessions/:id/migration-preview`

预览迁移内容。用户选择源会话和目标工具后调用。

**Request Body:**
```json
{
  "targetTool": "codex",
  "includeThinking": false,
  "includeToolCalls": true,
  "maxRounds": 0
}
```

**Response (200):**
```json
{
  "content": {
    "sessionId": "xxx",
    "sessionTitle": "实现用户认证模块",
    "sourceTool": "claude-code",
    "rounds": [
      {
        "index": 1,
        "userMessage": "帮我设计一个用户认证模块",
        "assistantResponse": "好的，我来帮你设计...",
        "toolCallSummaries": ["🔧 执行命令: `ls src/auth/`"],
        "thinking": null,
        "timestamp": 1718000000000
      }
    ],
    "totalRounds": 15,
    "extractedRounds": 15
  },
  "generatedPrompt": "# 会话迁移上下文\n...",
  "estimatedTokens": 3500,
  "warnings": []
}
```

#### `POST /api/sessions/:id/migrate`

执行迁移，生成最终的迁移 Prompt（支持用户编辑后重新生成）。

**Request Body:**
```json
{
  "targetTool": "codex",
  "includeThinking": false,
  "includeToolCalls": true,
  "maxRounds": 0,
  "editedPrompt": "（用户编辑后的 Prompt 内容，如果用户未编辑则不传）"
}
```

**Response (200):**
```json
{
  "success": true,
  "prompt": "# 会话迁移上下文\n...",
  "format": "markdown",
  "estimatedTokens": 3500,
  "warnings": []
}
```

#### `POST /api/sessions/:id/migrate-launch`

尝试通过 CLI 自动启动目标工具（方案一）。失败时返回回退信息。

**Request Body:**
```json
{
  "targetTool": "codex",
  "mode": "interactive",
  "includeThinking": false,
  "includeToolCalls": true,
  "maxRounds": 0,
  "projectDir": "/Users/frustigor/dev/my-project"
}
```

**Response — CLI 启动成功 (200):**
```json
{
  "success": true,
  "method": "cli-launch",
  "pid": 12345,
  "command": "cat /tmp/aicodeswitch-migration-xxx.txt | codex exec -",
  "promptFilePath": "/tmp/aicodeswitch-migration-xxx.txt",
  "estimatedTokens": 3500
}
```

**Response — CLI 不可用，提供回退 (200):**
```json
{
  "success": false,
  "method": "fallback",
  "reason": "codex CLI not found in PATH",
  "prompt": "# 会话迁移上下文\n...",
  "command": "cat /tmp/aicodeswitch-migration-xxx.txt | codex exec -",
  "promptFilePath": "/tmp/aicodeswitch-migration-xxx.txt",
  "estimatedTokens": 3500,
  "fallbackSuggestions": [
    "复制以下命令到终端执行",
    "或复制 Prompt 内容手动粘贴"
  ]
}
```

### 6.3 前端实现

#### 6.3.1 入口位置

会话管理已独立为 `SessionsPage.tsx`（侧边栏导航项：💬 会话，路由：`/sessions`）。在会话列表的操作列（当前有「查看」和「对话」两个按钮）中新增「迁移」按钮（图标：↔️）。点击后弹出 `SessionMigrationModal`。

**当前 SessionsPage 会话列表结构：**

| 列 | 内容 |
|---|---|
| 标题 | `cleanSessionTitle(session.title)` 或截断的 ID |
| 客户端类型 | 徽章："Claude Code" 或 "Codex" |
| 请求数 | `session.requestCount` |
| Tokens | `session.totalTokens.toLocaleString()` |
| 首次请求 | `dayjs(session.firstRequestAt).format('MM-DD HH:mm')` |
| 最后请求 | `dayjs(session.lastRequestAt).format('MM-DD HH:mm')` |
| 时长 | 计算出的持续时间 |
| **操作** | 「查看」(日志模式) 、「对话」(聊天模式) 、**「迁移」(新增)** |

#### 6.3.2 新增组件：`src/ui/components/SessionMigrationModal.tsx`

**复用 SessionsPage 已有的 UI 模式：**

- 使用 `modal--sticky-layout`（粘性头部/底部，可滚动主体，900px 宽度）
- 使用 `session-view-toggle` 样式的切换按钮
- 使用 `chat-message` 系列样式展示预览中的对话内容
- 使用 `session-refresh-btn` 样式的操作按钮

**交互流程（完整的多方案组合）：**

1. 用户在会话列表点击「迁移」按钮
2. 弹出 Modal，顶部显示源会话信息（标题、来源工具徽章、总轮数、总 Tokens）
3. 用户选择目标工具（Claude Code 或 Codex）—— 使用 `session-view-toggle` 样式的切换按钮，不允许选择与源相同的工具
4. 配置迁移选项（折叠式配置面板）：
   - ☑️ 包含工具调用摘要（默认勾选）
   - ☐ 包含思考过程（默认不勾选）
   - 最大迁移轮数：下拉选择「全部 / 最近 5 轮 / 最近 10 轮 / 最近 20 轮」
5. 点击「预览」按钮，调用后端 API 获取 `MigrationPreview`
6. 在可编辑的 `<textarea>` 中展示生成的 Prompt（占满可滚动区域）
7. 用户可以手动编辑 Prompt 内容
8. 底部（粘性 footer）显示：预估 Tokens 数 + 警告信息 + 操作按钮
9. **点击「启动目标工具」按钮**：
   - 前端调用 `POST /api/sessions/:id/migrate-launch`
   - 如果 `success: true`：显示「✅ 已在新终端窗口中启动 Codex」
   - 如果 `success: false`（CLI 不可用）：显示回退方案 UI
10. **回退方案 UI**：
    - 显示可复制的命令：`cat /tmp/... | codex exec -`
    - 「复制命令」按钮
    - 「复制 Prompt 到剪贴板」按钮（最终兜底）
    - 显示手动操作说明

**UI 布局（ASCII 线框图）：**

```
┌──────────────────────────────────────────────────────┐
│  会话迁移                                      [×]   │
├──────────────────────────────────────────────────────┤
│  📋 源会话                                           │
│  ┌──────────────────────────────────────────────┐    │
│  │  实现用户认证模块                              │    │
│  │  [Claude Code] 15 轮对话  |  12,500 tokens   │    │
│  └──────────────────────────────────────────────┘    │
│                                                      │
│  🎯 目标工具  [ Claude Code ]  [ ● Codex ]          │
│                                                      │
│  ⚙️ 迁移选项                                         │
│  [✓] 包含工具调用摘要  [ ] 包含思考过程              │
│  最大轮数：[ 全部 ▼ ]                                │
│                                                      │
│  [ 预览迁移内容 ]                                    │
├──────────────────────────────────────────────────────┤
│  ↕ 可滚动区域                                       │
│  ┌──────────────────────────────────────────────┐    │
│  │  # 会话迁移上下文                              │    │
│  │  > 以下内容从 Claude Code 会话...             │    │
│  │  ## 对话历史                                  │    │
│  │  ### 👤 用户                                  │    │
│  │  帮我设计一个用户认证模块                      │    │
│  │  ...                                          │    │
│  │  （可编辑的 textarea）                        │    │
│  └──────────────────────────────────────────────┘    │
├──────────────────────────────────────────────────────┤
│  预估 Tokens: ~3,500                                 │
│                                                      │
│  [ 🚀 启动 Codex ]     [ 📋 复制到剪贴板 ]          │
│                                                      │
│  （启动成功时）                                       │
│  ✅ 已在新终端窗口中启动 Codex                       │
│                                                      │
│  （CLI 不可用时 - 回退）                             │
│  ⚠️ Codex CLI 未检测到                              │
│  $ cat /tmp/aicodeswitch-migration-xxx | codex exec -│
│  [复制命令]  [复制 Prompt]                            │
└──────────────────────────────────────────────────────┘
```

#### 6.3.3 API 客户端更新

在 `src/ui/api/client.ts` 的 `BackendAPI` 接口中新增：

```typescript
// 会话迁移
migrationPreview: (sessionId: string, options: Partial<MigrationOptions>) => Promise<MigrationPreview>;
migrateSession: (sessionId: string, options: Partial<MigrationOptions> & { editedPrompt?: string }) => Promise<MigrationResult>;
migrateLaunch: (sessionId: string, options: Partial<MigrationOptions> & { mode?: string; projectDir?: string }) => Promise<LaunchResult>;
```

---

## 7. 数据模型

### 7.1 新增类型（在 `src/types/index.ts` 中添加）

```typescript
/** 迁移选项 */
export interface MigrationOptions {
  sourceSessionId: string;
  targetTool: ToolType;
  /** 是否包含思考过程，默认 false */
  includeThinking?: boolean;
  /** 是否包含工具调用摘要，默认 true */
  includeToolCalls?: boolean;
  /** 最大迁移轮数，0 表示全部 */
  maxRounds?: number;
}

/** 单轮迁移内容 */
export interface MigrationRound {
  index: number;
  userMessage: string;
  assistantResponse: string;
  toolCallSummaries: string[];
  thinking?: string;
  timestamp: number;
}

/** 迁移内容提取结果 */
export interface MigrationContent {
  sessionId: string;
  sessionTitle: string;
  sourceTool: ToolType;
  rounds: MigrationRound[];
  totalRounds: number;
  extractedRounds: number;
}

/** 迁移预览 */
export interface MigrationPreview {
  content: MigrationContent;
  generatedPrompt: string;
  estimatedTokens: number;
  warnings: string[];
}

/** 迁移结果 */
export interface MigrationResult {
  success: boolean;
  prompt: string;
  format: 'markdown';
  estimatedTokens: number;
  warnings: string[];
}

/** CLI 启动结果 */
export interface LaunchResult {
  success: boolean;
  method: 'cli-launch' | 'fallback';
  pid?: number;
  command?: string;
  promptFilePath?: string;
  reason?: string;            // 失败原因
  prompt?: string;            // 回退时提供 prompt 内容
  estimatedTokens?: number;
  fallbackSuggestions?: string[];
}
```

### 7.2 无需新增持久化存储

迁移功能是无状态的：从现有会话日志中读取数据，生成迁移 Prompt，不需要持久化任何迁移相关的数据。用户通过「复制到剪贴板」将 Prompt 粘贴到目标工具使用。

---

## 8. 实现要点

### 8.1 后端文本提取逻辑

核心复用 `SessionsPage.tsx` 中已验证的提取模式：

| 功能 | SessionsPage 中的参考实现 | 迁移服务中的复用方式 |
|---|---|---|
| SSE 解析 | `parseSSEChunks`（行 20-71） | 后端实现相同逻辑（解析 SSE 文本为事件数组） |
| 流式文本组装 | `assembleStreamText`（行 76-134） | 后端实现相同逻辑（支持 Claude/Responses/OpenAI/Gemini 四种格式） |
| 聊天项提取 | `extractChatItemsFromMessage`（行 150-229） | 后端实现相同逻辑（处理 text/tool_use/tool_result） |
| 助手回复提取 | `extractAssistantMessagesFromLog`（行 234-324） | 后端实现相同的多格式解析策略 |
| 消息聚合 | `extractChatMessagesFromLogs`（行 329-362） | 后端实现相同的遍历+提取逻辑 |
| 消息去重 | `deduplicateChatMessages`（行 368-403） | 后端实现相同的去重逻辑 |

> **注意**：SessionsPage 中的提取逻辑是前端代码（在浏览器中运行），后端需要重新实现相同的解析逻辑。不能直接 import 前端代码。建议将核心的 SSE 解析和文本提取逻辑提取为共享模块 `src/shared/sse-parser.ts`，前后端共用。

### 8.2 工具调用提取逻辑（新增）

**Claude Code 格式**（从请求体 `body.messages` 中提取）：

```
遍历 messages 数组中 role === 'assistant' 的消息
  → content 数组中 type === 'tool_use' 的 block
  → 提取 name 和 input 字段
```

对应的 `tool_result` 从下一条 `role === 'user'` 消息的 `content` 数组中 `type === 'tool_result'` 的 block 提取。

**Codex 格式**（从请求体 `body.input` 中提取）：

```
遍历 input 数组
  → type === 'function_call' 的项
  → 提取 name 和 arguments 字段
```

对应的 `function_call_output` 从后续 `type === 'function_call_output'` 的项中提取。

### 8.3 Token 估算

使用字符数估算（与项目中已有的 `estimateTokensFromText` 类似的逻辑）：

- CJK 字符：约 1 token / 字符
- 英文和标点：约 0.25 token / 字符（即 4 字符 / token）
- 总估算 = CJK 字符数 × 1 + 非 CJK 字符数 × 0.25

### 8.4 截断策略

当 `maxRounds > 0` 时，保留最近的 N 轮对话（从尾部开始取），更早的轮次丢弃。用户可以通过「最大迁移轮数」选项控制。

---

## 9. 关键文件清单

| 操作 | 文件路径 | 说明 |
|---|---|---|
| **新建** | `src/server/session-migration.ts` | 迁移服务核心模块（内容提取、Prompt 生成） |
| **新建** | `src/server/session-launcher.ts` | CLI 启动器（进程管理、终端窗口创建） |
| **新建** | `src/ui/components/SessionMigrationModal.tsx` | 迁移弹窗组件 |
| 修改 | `src/types/index.ts` | 新增迁移相关类型定义 |
| 修改 | `src/server/main.ts` | 注册迁移 API 路由 |
| 修改 | `src/ui/pages/SessionsPage.tsx` | 在会话列表操作列添加「迁移」按钮 |
| 修改 | `src/ui/api/client.ts` | 新增迁移 API 客户端方法 |
| 修改 | `src/ui/styles/App.css` | 迁移弹窗相关样式（复用已有 modal 模式） |

> **注意**：`SessionsPage.tsx` 是会话管理的独立页面（已于近期从 `LogsPage.tsx` 中拆分），包含完整的会话列表、详情模态框（`modal--sticky-layout`）和聊天视图组件（`ChatViewFromSessionLogs`）。迁移功能应在此基础上扩展。

---

## 10. 风险与限制

### 10.1 已知限制

| 限制 | 影响 | 缓解措施 |
|---|---|---|
| 工具调用无法直接执行 | 迁移后目标工具不知道之前的文件操作结果 | 在工具调用摘要中包含关键操作的描述 |
| 上下文窗口有限 | 长会话可能无法完整迁移 | 提供 maxRounds 选项和 Token 估算 |
| 迁移是单向快照 | 从 A 迁移到 B 后，B 中的新对话不会回传到 A | 合理的限制，不做双向同步 |
| 文件上下文缺失 | 源工具已修改文件，但目标工具不知道文件当前状态 | 提示用户目标工具会自动读取项目文件 |
| CLI 启动依赖环境 | 不同操作系统的终端启动方式不同，Tauri 环境可能受限 | 多方案回退策略（CLI → 临时文件 → 剪贴板） |
| 临时文件清理 | 服务器异常退出可能导致临时文件残留 | 启动时清理旧的临时文件，设置 30 秒延迟清理 |

### 10.2 不在范围内

- ❌ 自动实时会话同步
- ❌ 双向会话状态同步（文件修改、环境变量等）
- ❌ LLM 辅助的智能摘要（可作为未来增强）
- ❌ 直接写入目标工具的内部会话文件（格式可能随版本变化）
- ❌ 在 Tauri 桌面应用中的内嵌终端（仅支持在系统终端中启动）

---

## 11. 实施阶段

### Phase 1：核心迁移功能（Prompt 生成 + 剪贴板交付）

**目标：** 实现会话内容提取和 Prompt 生成，用户可以复制到剪贴板

**工作项：**

1. 在 `src/types/index.ts` 中新增迁移相关类型定义（MigrationOptions, MigrationContent, MigrationRound, MigrationPreview, MigrationResult）
2. 创建 `src/server/session-migration.ts`，实现：
   - SSE 解析和流式文本组装逻辑（复用 SessionsPage 中的模式）
   - `extractSessionContent()`：从日志中提取对话内容
   - `generateMigrationPrompt()`：生成迁移 Prompt
   - 工具调用摘要化逻辑
   - Token 估算
3. 在 `src/server/main.ts` 中注册 `POST /api/sessions/:id/migration-preview` 和 `POST /api/sessions/:id/migrate` 路由
4. 在 `src/ui/api/client.ts` 中新增 `migrationPreview` 和 `migrateSession` API 方法
5. 创建 `src/ui/components/SessionMigrationModal.tsx` 迁移弹窗组件（复用 SessionsPage 的 `modal--sticky-layout` 布局模式）
6. 在 `SessionsPage.tsx` 会话列表操作列中添加「迁移」按钮（与现有的「查看」「对话」按钮并列）
7. i18n：为迁移相关的 UI 文案添加 3 个 locale 翻译（en, zh-CN, zh-TW）

**交付物：** 用户可以在会话页面选择一个会话，预览迁移内容，编辑后复制到剪贴板。

### Phase 2：CLI 自动启动

**目标：** 实现一键启动目标工具，自动传入迁移 Prompt

**工作项：**

1. 创建 `src/server/session-launcher.ts`，实现：
   - `checkToolInstalled()`：检测 CLI 可用性
   - `launchTargetTool()`：跨平台终端启动逻辑（macOS/Linux/Windows）
   - `writePromptToTempFile()`：临时文件管理
   - `cleanupTempFile()`：延迟清理
2. 在 `src/server/main.ts` 中注册 `POST /api/sessions/:id/migrate-launch` 路由
3. 在 `src/ui/api/client.ts` 中新增 `migrateLaunch` API 方法
4. 更新 `SessionMigrationModal.tsx`，添加「启动目标工具」按钮和回退 UI
5. 在服务启动时清理旧的迁移临时文件（`/tmp/aicodeswitch-migration-*`）

**交付物：** 用户点击「启动 Codex」按钮后，系统自动在新终端窗口中启动 Codex 并传入迁移 Prompt。CLI 不可用时回退到剪贴板方案。

### Phase 3：增强功能（可选）

1. 上下文压缩/摘要功能（规则化摘要，非 LLM）—— 当会话过长时，自动将早期轮次压缩为摘要
2. 迁移历史记录（保存在 localStorage）—— 记录用户的迁移操作，方便回溯
3. 批量会话迁移 —— 选择多个会话，生成合并后的迁移 Prompt
4. 优化工具调用摘要的细节描述 —— 根据工具类型和参数生成更详细的摘要

### Phase 4：高级功能（可选）

1. LLM 辅助的智能摘要 —— 调用已配置的模型 API 生成会话摘要
2. 会话对比视图 —— 并排展示两个工具对同一上下文的响应差异
3. 迁移模板 —— 预设不同场景的迁移策略（如"只迁移需求分析"或"只迁移错误排查"）
4. 直接写入 Session 文件探索 —— 研究逆向工具内部 JSONL 格式，实现更无缝的会话注入

---

## 12. 测试验证

### 12.1 功能验证

- 从 Claude Code 会话迁移到 Codex：选择一个有 10+ 轮对话的 Claude Code 会话，生成迁移 Prompt，在 Codex 中粘贴验证
- 从 Codex 会话迁移到 Claude Code：反向操作验证
- 空会话处理：选择只有 1-2 轮对话的会话
- 工具调用摘要：选择包含大量工具调用的会话，验证摘要生成是否准确
- 超长会话截断：选择 50+ 轮对话的会话，设置 maxRounds=10，验证截断行为

### 12.2 边界情况

- 无日志的会话
- 日志中只有错误请求的会话
- SSE 解析失败的日志
- 混合格式（同一会话中既有 Claude 格式又有 OpenAI 格式的响应）

### 12.3 UI 验证

- Modal 打开/关闭动画
- 复制到剪贴板成功/失败的提示
- 目标工具与源工具相同时的处理
- 大文本在 textarea 中的渲染性能

### 12.4 CLI 启动验证

- macOS：通过 osascript 在 Terminal.app 中启动
- macOS：通过 osascript 在 iTerm2 中启动（如已安装）
- CLI 未安装时的回退流程
- 长迁移 Prompt（超过 10KB）通过临时文件 + stdin 管道传入
- 迁移后目标工具的实际使用效果验证
