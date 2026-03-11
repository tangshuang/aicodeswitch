# AI Code Switch - 项目知识库

**生成时间:** 2026-02-11
**项目类型:** AI 代理工具 / 本地代理服务器

## 项目概述

AI Code Switch 是一个本地代理服务器，管理 AI 编程工具（Claude Code、Codex）到大语言模型的连接。支持模型 API 路由、API 格式转换（Claude ↔ OpenAI）、技能分发、日志记录等功能。

**核心技术栈:**
- 后端: Node.js + TypeScript + Express
- 前端: React + TypeScript + Vite
- 桌面: Tauri 2.0 (Rust 主进程)
- 存储: JSON 文件系统数据库 (~/.aicodeswitch/data/)
- 部署: CLI 工具 + Web UI + 桌面应用

## 目录结构

```
aicodeswitch/
├── src/
│   ├── server/          # Node.js 后端服务 (Express API + 代理服务器)
│   └── ui/             # React 前端应用
├── tauri/              # Tauri 桌面应用 (Rust + 嵌入式资源)
├── bin/                # CLI 脚本 (aicos 命令)
├── dist/               # 构建产物 (server/, ui/)
├── documents/          # 文档 (Tauri 研究、构建指南)
├── scripts/           # 构建/发布脚本
├── package.json       # npm 脚本、依赖声明
├── tsconfig.json      # TypeScript 配置
├── vite.config.ts     # Vite 构建配置
└── .github/workflows/ # CI/CD 流水线
```

## 快速定位

| 任务 | 位置 | 说明 |
|------|------|------|
| 核心代理逻辑 | `src/server/proxy-server.ts` | 请求路由、匹配规则、转发 |
| API 格式转换 | `src/server/transformers/` | Claude ↔ OpenAI ↔ Gemini 数据格式互转 |
| 数据库层 | `src/server/fs-database.ts` | JSON 文件存储 CRUD |
| UI 页面 | `src/ui/pages/` | 供应商管理、路由配置、日志等 |
| CLI 命令 | `bin/*.js` | start/stop/ui/upgrade/restore 等 |
| Tauri 主进程 | `tauri/src/main.rs` | Rust 窗口管理、Node 进程生命周期 |
| 构建配置 | `package.json` scripts | dev/build/tauri:dev 等 |

## 代码规范

### 通用约定
- **包管理器:** yarn (使用 `yarn install`，前端依赖装在 devDependencies)
- **服务端路径:** 使用 `__dirname` 获取目录，不要用 `process.cwd()`
- **UI 样式:** 禁止使用依赖 GPU 的 CSS 样式
- **测试命令:** 禁止运行 `dev:ui`、`dev:server`、`tauri:dev` 进行测试
- **文档位置:** 新建文档放 `documents/` 目录
- **测试脚本:** 新建测试放 `scripts/` 目录

### TypeScript 规范
- 后端: `src/server/**/*.ts`
- 前端: `src/ui/**/*.{tsx,ts}`
- 编译配置: `tsconfig.json` (后端), `tsconfig.json` (前端)
- 类型定义: `src/types/index.ts`

### 路径约定
- API 路由前缀: `/api/` (除代理路由 `/claude-code/`、`/codex/`)
- 服务端口: 4567 (服务器), 4568 (UI 开发服务器)
- 数据目录: `~/.aicodeswitch/fs-db/`
- 配置文件: `~/.aicodeswitch/aicodeswitch.conf`

## 特殊约定

### 数据库与迁移
- **数据格式:** 所有数据存为 JSON 文件 (`~/.aicodeswitch/fs-db/*.json`)
- **数据结构:** `vendors.json` 内嵌 `services` 数组（已迁移，旧结构已废弃）
- **自动迁移:** 启动时自动检测并迁移旧 SQLite/LevelDB/旧 JSON 结构
- **迁移工具:** `src/server/migrate-to-fs.ts`

### 路由与故障切换
- **路由规则:** 按请求内容类型 (image-understanding/thinking/long-context/background/default) 匹配
- **智能故障切换:** 同类型多条规则时，优先使用第一条；报错/超时时自动切换下一条

### 日志规范
- **日志类型:** 请求日志、错误日志、会话日志
- **敏感字段:** API 密钥等自动在 UI 层脱敏显示
- **会话标题:** 从首条用户消息提取，自动截断 (最大 100 字符)

### Tauri 桌面应用
- **Node.js 检测:** 启动时检查是否安装，未安装显示友好错误
- **退出处理:** 关闭时自动禁用所有激活的路由，防止配置文件残留
- **资源打包:** 构建时将 `dist/server` 和 `dist/ui` 嵌入 Tauri
- **原理:** 通过tauri来运行dist/server/main.js，并使用内置的webview来渲染ui页面

## 构建与发布

```bash
# 开发
yarn dev              # 并行运行 UI + Server (watch 模式)
yarn dev:ui           # 仅运行 React UI (Vite)
yarn dev:server       # 仅运行 Node Server (tsx watch)

# 构建
yarn build            # 构建 UI + Server
yarn build:ui         # 构建 React UI
yarn build:server     # 构建 TypeScript Server

# Tauri
yarn tauri:dev        # 开发模式 (需要 Rust 工具链)
yarn tauri:build      # 构建桌面应用
yarn tauri:icon       # 生成图标

# CLI
yarn link             # 本地链接 CLI 进行测试
aicos start           # 启动代理服务
aicos ui              # 启动服务 + 打开浏览器 UI
aicos stop            # 停止服务
```

## 子模块文档

- `src/server/AGENTS.md` - 后端服务详细约定
- `src/ui/AGENTS.md` - 前端 React 应用约定
- `tauri/AGENTS.md` - Tauri 桌面应用约定

## 变更记录

每次代码变更后:
1. 更新 AGENTS.md, CLAUDE.md 保持文档同步
2. 在 `CHANGELOG.md` 中以简单概述记录变更

- 2026-02-11: 调整 UI 弹层层级与日志页弹层叠放逻辑，修复侧栏遮挡问题。
- 2026-02-11: 请求日志补充记录规则内容类型，补齐统计页的请求类型分布数据。
- 2026-02-24: 智能故障切换改为同一请求内即时兜底（上游 4xx/5xx 立即切换下一服务），并在错误日志增加“已转发给 xx 服务继续处理”提示。
- 2026-03-03: OpenAI（Responses）数据源 base URL 增加版本兼容：若地址不以 `/v{number}` 结尾，服务端转发时自动补 `/v1`；若已以版本结尾则直接拼接路径。
- 2026-03-03: 修复前端 Vendors 页面中旧数据源类型 `claude-code` 的类型判断残留，统一为 `claude`，消除 TypeScript 类型检查报错。
- 2026-03-03: 路由管理新增 Codex 配置区域，支持设置 `model_reasoning_effort`（Reasoning Effort 下拉）；路由激活时按配置写入 Codex 配置文件，激活后修改可立即覆盖 `~/.codex/config.toml`。
- 2026-03-03: 调整 Codex 配置区 Reasoning Effort 表单布局为 label/value 左右排列，避免上下排布。
- 2026-03-08: 高智商规则改为自动推断模式：移除 `!x` 关闭语法，按”最近真���用户输入 + 工具消息过滤”判断是否命中 `high-iq`，并修复高智商规则优先级与会话状态持久化问题。
- 2026-03-09: OpenAI（Responses）数据源调整为固定拼接 `/v1/responses` 转发；供应商 OpenAI base URL 规范为不包含 `/v1`，并补充前后端保存校验与提示文案。
- 2026-03-09: 新增 OpenAI base URL 启动迁移：仅对 `sourceType=openai` 且地址末尾为 `/v1` 的服务自动去尾并回写 `vendors.json`，导入数据时同步归一化。
- 2026-03-10: 修复 OpenAI（Responses）请求类型 URL 拼接问题：
  - 修复 `isOpenAIChatSource` 方法错误地将 `openai` 类型归类为 OpenAI Chat 的问题
  - 新增 `isOpenAIType` 方法统一处理 OpenAI Chat 和 OpenAI Responses 类型
  - 修复 `mapRequestPath` 中 Codex → OpenAI Responses 的路径映射错误
  - 统一所有请求体转换、响应转换、流式响应转换使用 `isOpenAIType` 方法处理 OpenAI 类型
- 2026-03-10: 修复 OpenAI（Responses)请求类型 URL 拼接问题：
  - 修复 `isOpenAIChatSource` 方法错误地将 `openai` 类型归类为 OpenAI Chat 的问题
  - 新增 `isOpenAIType` 方法统一处理 OpenAI Chat 和 OpenAI Responses 类型
  - 修复 `mapRequestPath` 中 Codex → OpenAI Responses 的路径映射错误
  - 统一所有请求体转换、响应转换、流式响应转换使用 `isOpenAIType` 方法处理 OpenAI 类型
- 2026-03-10: 新增 Codex → OpenAI Chat 转换器
  - 支持 Codex 请求格式转换为 OpenAI Chat Completions 格式
  - 在 Codex 请求 OpenAI Chat / DeepSeek Reasoning Chat 时自动转换请求格式
  - 保留 Codex 特有的工具定义和字段
- 2026-03-10: 新增 Responses → Gemini 转换器
  - 支持 Codex Responses API 请求格式转换为 Gemini API 格式
  - 转换系统提示词（instructions → systemInstruction）
  - 转换消息内容（input → contents，支持文本和图像）
  - 转换工具定义（tools → functionDeclarations）
  - 转换生成参数（temperature、top_p、max_output_tokens、stop）
- 2026-03-10: 新增 Chat Completions 转换器
  - `transformRequestFromChatCompletionsToResponses`：Chat Completions → Responses
    - messages → input，system/developer → instructions
    - content items: text → input_text，image_url → input_image
  - `transformRequestFromChatCompletionsToClaude`：Chat Completions → Claude
    - messages → messages，system → system
    - tool_calls → tool_use，image_url → image
  - `transformRequestFromChatCompletionsToGemini`：Chat Completions → Gemini
    - messages → contents，system → systemInstruction
    - tool_calls → functionCall，image_url → inlineData
- 2026-03-10: 新增 Claude Code 请求转换器
  - `transformRequestFromClaudeToGemini`：Claude → Gemini
  - `transformRequestFromClaudeToResponses`：Claude → Responses
  - `transformRequestFromClaudeToChatCompletions`：Claude → Chat Completions
- 2026-03-10: 新增九个响应转换函数
  - `transformResponseFromChatCompletionsToResponses`：Chat Completions → Responses
  - `transformResponseFromClaudeToResponses`：Claude → Responses
  - `transformResponseFromGeminiToResponses`：Gemini → Responses
  - `transformResponseFromResponsesToChatCompletions`：Responses → Chat Completions
  - `transformResponseFromClaudeToChatCompletions`：Claude → Chat Completions
  - `transformResponseFromGeminiToChatCompletions`：Gemini → Chat Completions
  - `transformResponseFromChatCompletionsToClaude`：Chat Completions → Claude
  - `transformResponseFromResponsesToClaude`：Responses → Claude
  - `transformResponseFromGeminiToClaude`：Gemini → Claude
  - `transformRequestFromClaudeToGemini`：Claude → Gemini
    - messages → contents，system → systemInstruction
    - tool_use → functionCall，tool_result → functionResponse
    - image → inlineData，thinking → thinkingConfig
  - `transformRequestFromClaudeToResponses`：Claude → Responses
    - messages → input，system → instructions
    - tool_use → function_call，image → input_image
  - `transformRequestFromClaudeToChatCompletions`：Claude → Chat Completions
    - messages → messages，system → system
    - tool_use → tool_calls，image → image_url
    - tool_result → tool 消息，thinking → reasoning
- 2026-03-10: 日志系统升级：新增"实际转发的响应体"字段
  - 在 `RequestLog` 接口中添加 `downstreamResponseBody` 字段
  - 记录 aicodeswitch 在收到上游 API 响应并转换后发送给客户端的响应体
  - 对于流式响应，存储转换后的 SSE chunks 数组（实际发送给客户端的格式）
  - 对于非流式响应，存储 JSON 格式的响应体
  - 日志详情窗口中正确显示实际转发的响应体内容
- 2026-03-11: 修复 Codex 使用 `openai-chat` 数据源时的流式稳定性问题
  - 修复 `SSEEventCollectorTransform` 对象模式透传错误，避免向下游转换器传递空事件
  - `SSESerializerTransform` 在 `event` 存在且 `data.type` 缺失时自动补齐 `type` 字段，提升 Responses SSE 兼容性
  - `proxyRequest` 新增客户端断开检测与上游请求中止逻辑，避免 `Cannot pipe to a closed or destroyed stream` 误判为服务故障
  - 统一 `codex/claude-code` 的 OpenAI/Claude/Gemini 流式转发链路，关闭历史特殊分支并统一走 `transformSSEToTool`
  - 修复历史特殊分支中转换器不一致问题（Claude/Gemini -> Codex 误用 OpenAI Chat 转换器）
  - 全面校验并修复 `src/server/transformers/streaming.ts` 各 Transform 的协议对齐问题（Chat/Responses/Claude/Gemini）
  - Responses 相关转换器统一支持 `event` 与 `data.type` 两种事件来源，补齐函数调用 done 事件与不完整原因映射
- 2026-03-11: 实现配置文件智能合并方案
  - 新增管理字段定义（`src/server/config-managed-fields.ts`），区分管理字段和保留字段
  - 新增配置合并模块（`src/server/config-merge.ts`），支持 JSON 和 TOML 格式的智能合并
  - 重构配置写入函数（`writeClaudeConfig`, `writeCodexConfig`），使用智能合并保留工具运行时写入的内容
  - 重构配置恢复函数（`restoreClaudeConfig`, `restoreCodexConfig`），使用智能合并恢复原始配置
  - 使用原子性写入确保配置文件不会损坏
  - 使用 `@iarna/toml` 库处理 Codex 的 TOML 格式配置
  - 修复 Claude Code 激活/停用路由时 `projects` 丢失的问题
  - 修复 Codex 激活/停用路由时 `[projects...]` 丢失的问题
- 2026-03-11: 修复 CLI 配置备份/恢复重构回归
  - 修复 `bin/start.js` 语法错误导致 CLI 全命令无法运行的问题
  - `bin/start.js` 读取数据库目录改为优先 `~/.aicodeswitch/fs-db`，不存在时回退 `~/.aicodeswitch/data`，并在读取前执行 `initialize()`
  - `bin/start.js` 写入配置地址统一使用 `HOST/PORT`（与 `aicodeswitch.conf` 对齐）
  - `bin/start.js` 补齐 Claude `.claude.json` 写入，并透传路由开关：`enableAgentTeams`、`enableBypassPermissionsSupport`、`codexModelReasoningEffort`
  - `bin/utils/config-helpers.js` 改为使用 `@iarna/toml`，并修复管理字段前缀匹配（托管 section 不被旧值覆盖）
  - `aicos stop` / `aicos restore` 恢复成功后删除对应 backup 文件，避免陈旧备份持续污染
  - `src/server/original-config-reader.ts` 新增 `OPENAI_API_KEY` 兼容读取
- 2026-03-11: 调整配置写入/恢复为服务生命周期驱动
  - 配置备份与覆盖改为在服务启动时执行（适用于 `aicos start/ui/restart` 与 `dev:server`）
  - 配置恢复改为在服务终止前执行（适用于 `aicos stop` 与开发态 `Ctrl+C`）
  - `bin/start.js`、`bin/stop.js` 回归仅进程启停职责，不再直接读写工具配置
  - 保留 `aicos restore` 手动恢复能力
- 2026-03-11: 修复启动写配置触发条件
  - 移除“仅激活路由才写配置”的限制，改为服务启动即写入配置
  - 启动写配置时参数选择优先级：激活路由 > 同目标第一条路由 > 默认值
- 2026-03-11: 移除路由操作触发配置写入/恢复
  - `RoutesPage` 激活/停用仅更新路由状态，不再调用配置写入/恢复 API
  - `/api/routes/deactivate-all` 仅停用路由，配置恢复统一由服务退出流程处理
- 2026-03-11: 补充配置机制文档（CLAUDE.md）
  - 细化“智能配置合并”章节，补齐服务起停写入/恢复、UI 配置修改、`aicos restore`、状态检测与 MCP 例外说明
- 2026-03-11: 修复服务退出恢复误报与合并覆盖问题
  - `src/server/config-merge.ts` 改为仅复制叶子路径，避免父级对象（如 `env`、`model_providers`）整块覆盖回写
  - `restoreClaudeConfig` / `restoreCodexConfig` 返回“是否实际恢复文件”，日志不再在无 backup 场景误报 restored
- 2026-03-11: 工具配置改为全局配置并补齐兼容迁移
  - 新增全局配置字段：`enableAgentTeams`、`enableBypassPermissionsSupport`、`codexModelReasoningEffort`
  - 服务启动写配置改为仅读取全局配置，不再读取路由字段
  - `fs-database` 启动时自动迁移旧路由字段到全局配置，并清理路由中的废弃字段
  - `RoutesPage` 的 Claude/Codex 配置改为读写全局配置（`/api/config`）
- 2026-03-11: 调整路由配置页全局配置卡片布局
  - 将“Claude Code 全局配置”“Codex 全局配置”从路由规则区域移至“📝 配置文件自动管理”模块上方
  - 避免全局工具设置与路由规则混排，提升页面结构清晰度
- 2026-03-11: 修正全局配置生效逻辑与提示文案
  - 保存全局配置后服务端立即回写 Claude/Codex 配置文件（不再要求重启服务）
  - 路由规则修改保持后端实时生效；全局配置修改仅需重启对应编程工具
- 2026-03-11: 路由规则页补充优先级说明
  - 在“智能故障切换机制”上方新增“规则优先级顺序”提示模块
  - 明确展示故障切换开启/关闭时的命中顺序与同类规则排序逻辑
- 2026-03-11: 路由规则说明改为用户操作指引
  - 将“规则优先级顺序”文案简化为“如何配置规则（推荐）”
  - 采用“先分类型、再排顺序、上主下备”的用户视角说明，减少概念负担
- 2026-03-11: 路由规则文案补充常见优先顺序
  - 在用户操作指引末尾追加：图像理解 → 高智商 → 长上下文 → 思考 → 后台 → 模型顶替 → 默认
- 2026-03-11: 调整服务黑名单自动恢复时间为 10 秒
  - 统一 `fs-database` 与 `database` 的黑名单过期时间为 `10s`
  - 同步修正 Routes/Settings 页面“不可用恢复时间”提示文案
- 2026-03-11: 故障自动恢复时间改为可配置
  - 设置页新增 `failoverRecoverySeconds` 字段（默认 10 秒，仅在启用故障切换时可编辑）
  - 黑名单过期时间改为按配置读取；旧配置自动回填默认值 10 秒
- 2026-03-11: `aicos restore` 增加运行中保护
  - restore 前检查服务是否仍在运行（PID/端口）
  - 服务运行中时不执行恢复，提示先执行 `aicos stop`（stop 会自动恢复配置）
- 2026-03-11: 后端请求日志补齐中转标记与全路径记录
  - 工具请求在路由未命中/鉴权失败/服务未配置等早退场景也会写入请求日志
  - 请求日志 `tags` 新增中转状态标记：`通过中转` / `未通过中转`，fallback 原始配置额外标记 `使用原始配置`
  - 统计继续基于每条日志 `usage` 聚合 token（`addLog` 触发 `updateStatistics`）

---

*本文件由 `/init-deep` 自动生成*
