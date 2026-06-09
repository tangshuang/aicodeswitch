# Changelog

## 2026-06-09: 编程套餐 Headers 覆盖功能

### 新增
- 新增编程套餐 Headers 覆盖模块 (`coding-plan-headers.ts`)，当 API 服务启用编程套餐限制 (`enableCodingPlan`) 时，自动将发送到上游的请求 Headers 覆盖为对应编程工具的标准 Headers
- Claude 源 (`claude`/`claude-chat`) 使用 Claude Code 标准 Headers（含 x-stainless-*、anthropic-beta 等）
- 其他源 (`openai`/`openai-chat`/`gemini`/`gemini-chat`) 使用 Codex 标准 Headers（含 x-codex-*、originator 等）

## 2026-06-09: 修复 Streaming/Thinking 过程中规则状态未保持使用中

### 修复
- 修复 streaming 响应（包括 thinking 思考过程）超过 10 秒后规则状态错误变为空闲的问题
- 新增 `refreshRuleInUse` 方法，仅在状态已为 `in_use` 时轻量刷新不活动定时器
- 在 `ChunkCollectorTransform` 中增加节流回调（每 5 秒），streaming 期间持续刷新定时器保持使用中状态

## 2026-06-09: 会话对话视图去重与导出优化

### 修复
- 修复对话视图中 assistant 消息重复显示的问题（请求体历史中的消息与响应体提取的消息内容相同）
- 新增基于内容比较的去重逻辑：内容相同的 assistant 消息保留有 token 消耗信息的那条，无重复的独立消息不受影响

### 变更
- 对话模式下导出按钮改为导出对话数据（messages 数组），日志模式下仍导出完整日志数据

## 2026-06-09: 会话页面新增搜索、筛选和自动刷新功能

### 新增
- 会话列表新增搜索框，支持按标题或 ID 模糊搜索
- 新增来源类型筛选下拉框（Claude Code / Codex）
- 新增自动刷新开关（10 秒间隔）和手动刷新按钮
- 新增清除筛选按钮，一键重置所有筛选条件

## 2026-06-09: 会话管理迁为独立页面

### 变更
- 会话管理从日志页面的 `sessions` tab 迁出为独立页面 `/sessions`，侧边栏增加专属菜单入口
- 移除 LogsPage 中所有 session 相关代码（state、函数、弹窗、模块级组件）
- 修复 SessionsPage 中 `setSessionsTotal` 类型错误和 `Pagination` 组件 `totalItems` 属性名

## 2026-06-09: 会话对话视图深度优化 — 工具调用链可视化、消息折叠、交互增强

### 新增
- 对话视图完整展示工具调用链：左侧显示模型的工具调用（含参数），右侧显示工具执行结果，通过工具名+短 ID 精确对应
- 长消息自动折叠/展开（超过 10 行），工具消息强制可折叠，工具调用消息收起时仅显示 header
- 会话详情弹窗刷新按钮，支持重新拉取最新日志
- 对话视图底部向下箭头按钮，一键滚动到最新消息
- 新增 `--bg-primary-solid` CSS 变量，解决渐变色无法作为 gradient color stop 的问题
- 深色模式工具消息使用半透明白色背景，与普通消息明确区分

### 优化
- 采用增量对比算法提取对话消息，确保首条用户消息到最新回复完整展示
- 收起消息时智能判断是否需要滚动：仅在 top bar 不可见时才执行 scrollIntoView
- 会话日志获取上限从 100 提升至 10000，避免长会话消息丢失
- 日志列表同样按时间升序排列，与对话视图顺序一致
- 深色模式下用户消息、助手消息气泡背景色加深，提升可辨识度

## 2026-06-09: 会话详情弹窗优化 — 聊天视图、固定头尾、标题清理

### 新增
- 会话详情弹窗新增「对话」视图，以聊天气泡形式展示完整对话历史（含用户消息和助手回复）
- 支持在「日志」和「对话」两种视图间一键切换
- 聊天视图支持显示思考内容（可折叠）和消息元信息（时间、模型、tokens）

### 优化
- 会话详情弹窗标题和底部按钮改为固定布局，仅中间内容区域可滚动
- 清理会话标题中残留的 `<session>` / `</session>` 标签（服务端 + 前端双重处理）

## 2026-06-09: 修复 GLM Claude 兼容端点 tool_result 缺少 id 字段导致 500 错误

### 修复
- 修复使用 GLM Claude 兼容端点时，包含 tool_result 的请求返回 500 错误的问题
- 根因：GLM 的 Anthropic 兼容端点要求 `tool_result` 内容块必须包含 `id` 字段，但标准 Claude API 的 `tool_result` 块仅有 `tool_use_id` 而无 `id`
- 新增 `ensureToolResultIds` 函数（`conversions/utils/tool-result.ts`），在转发到 claude 格式目标时自动为缺少 `id` 的 `tool_result` 块补上标识
- `tool_result.id` 使用 `tool_use_id` 的值，确保与对应 `tool_use` 块的 `id` 一致

## 2026-06-08: 修复 DeepSeek Anthropic 端点多轮对话 thinking 块兼容问题

### 修复
- 修复使用 DeepSeek Anthropic 兼容端点（sourceType: claude）时，多轮对话返回 400 错误的问题
- 根因：Claude Code 将历史 thinking 压缩为 `redacted_thinking` 块，DeepSeek 不识别该类型
- 新增 `convertRedactedThinkingForProvider` 函数，在转发前将 `redacted_thinking` 转换为 `thinking` 块

## 2026-06-07: 新增请求体 JSON 安全性清理

### 新增
- 新增请求体安全性清理模块 `body-sanitizer.ts`，在转发前自动修复请求体中的潜在问题
- 清除字符串中的非法 C0 控制字符（保留 TAB/LF/CR）
- 修复 Responses API `function_call.arguments` 中的无效 JSON 字符串
- 移除对象树中的 `undefined` 值，防止序列化时 content-length 不匹配
- 防循环引用和最大递归深度保护

## 2026-06-07: 实现 Codex MCP 配置写入

### 新增
- 实现 Codex 目标的 MCP 配置写入功能，将 MCP 服务器以 `[mcp_servers.<name>]` TOML 格式写入 `~/.codex/config.toml`
- 支持 stdio、http、sse 三种 MCP 传输类型
- 实现 Codex MCP 配置移除功能（删除 MCP 时自动清理 config.toml）
- MCP targets 变更时自动同步配置到对应工具（PUT /api/mcps/:id）
- 服务启动时自动同步 MCP 配置到已激活的工具
- 将 `mcp_servers` 加入 Codex config.toml 管理字段，确保配置合并时正确处理

## 2026-06-06: 新增 Agnes 提供商及 chat_template_kwargs thinking 规则

### 新增
- 新增 `chat_template_kwargs` thinking 参数规则，支持通过 `chat_template_kwargs.enable_thinking` 控制推理模型的思考模式
- 新增 Agnes 提供商配置，模型匹配 `agnes` 前缀，使用 `chat_template_kwargs` 格式注入 thinking 参数

## 2026-06-06: 新增一键配置功能

### 新增
- 新增「一键配置」功能，仅需选择供应商、目标即可自动完成全部配置
- 供应商去重：同名供应商不重复创建，仅补充缺失的 API 服务
- API Key 智能展示：已有供应商且已配置 Key 时隐藏输入框
- 路由名自动附加目标后缀（如 `[Codex]`、`[Claude Code]`、`[API]`）
- 目标导向服务选取：Claude Code 优先 Claude 服务、Codex 优先 Responses/Chat Completions、API 按通用优先级
- 弹窗新增「目标」单选项：Codex、Claude Code、所有 API，仅激活所选目标（强制覆盖）
- 无供应商提示弹窗和路由管理页面右上角均可触发一键配置
- 默认不启用编程套餐限制，提供最宽松配置

## 2026-06-05: 修复 Codex → Claude thinking 历史丢失问题

### 修复
- 修复 Responses API → Claude Messages 转换时 `reasoning` 条目被跳过导致 thinking 内容丢失的问题
- 现在正确将 `reasoning` 条目的 `summary` 转换为 Claude `thinking` 块并合并到对应的 assistant 消息中
- 新增安全网：Claude 上游目标启用 thinking 模式时，自动为包含 `tool_use` 但缺少 `thinking` 块的 assistant 消息补充占位 thinking 块

## 2026-06-04: 新增编程套餐限制功能

### 新增
- API 服务配置新增「启用编程套餐限制」选项（`enableCodingPlan`），启用后仅允许编程工具（Claude Code / Codex / Cursor 等）发起的请求通过，普通对话请求返回 403
- 新增 `coding-plan.ts` 编程工具检测工具，从 AICodingBus 移植 `isCodingToolRequest` 逻辑，支持三层检测：HTTP Headers（User-Agent / 特征 Header）、Claude Messages / OpenAI Responses / OpenAI Chat Completions / Gemini 格式的请求体特征

### 变更
- `proxyRequest` 和 `proxyRequestForApiPath` 两个代理入口在请求转发前增加编程套餐检查

## 2026-06-04: 启动优化 - 延迟日志分片维护

### 变更
- 将启动时的日志分片一致性校验（verifyShardIndexConsistency）、损坏修复、旧日志清理改为服务启动后异步执行
- 将会话日志索引全量构建（buildSessionLogIndex）改为服务启动后异步执行
- 新增 `deferredMaintenance()` 方法，在 HTTP 服务器启动后 fire-and-forget 调用
- 启动速度显著提升，不再因大量日志分片的 IO 操作阻塞

## 2026-06-04: 路由激活交互重构

### 新增
- `tool-bindings.json` 独立存储：每个工具（Claude Code / Codex）当前激活的路由 ID 独立存储，不再依赖 Route.isActive
- `ToolName`、`ToolBinding`、`ToolBindings` 类型
- `GET /api/tool-bindings` API：获取当前工具绑定状态
- `POST /api/tool-bindings/activate` API：激活指定工具的路由
- `POST /api/tool-bindings/deactivate` API：停用指定工具的路由
- Claude Code / Codex 全局配置区域新增路由选择下拉框和激活/停用按钮

### 移除
- `Route.targetType` 和 `Route.isActive` 字段（从类型和数据模型中移除）
- 路由列表中的"激活"/"停用"按钮和激活状态角标
- 新建/编辑路由弹窗中的"客户端工具"选择器
- `POST /api/routes/:id/activate` 和 `POST /api/routes/:id/deactivate` API
- `activateRoute`、`deactivateRoute`、`deactivateAllRoutes` 数据库方法

### 变更
- 代理请求路由查找：从遍历 `Route[]` 按 `targetType`+`isActive` 匹配改为从 `tool-bindings` 直接读取 routeId
- `proxyRequest` 中的 `targetType` 改为从请求路径推断
- `reloadRoutes` 不再按 `isActive` 过滤路由
- `apiPathBindings` 路由查找不再检查 `isActive`
- 删除路由时检查是否被工具绑定
- 数据迁移：自动将旧 `Route.isActive`+`Route.targetType` 迁移到 `tool-bindings.json`

## 2026-06-03: 强化 Claude Code compact 链路

- compact 请求在转发到上游前会补齐未配对的 `tool_use/server_tool_use`，并主动移除 `thinking`、`tools`、`tool_choice`、`mcp_servers`
- compact 响应回传给 Claude Code 前会过滤 `thinking` / `tool_use` block，只保留纯文本摘要

## 2026-03-11: 修复 Claude Code → Gemini thinking 配置互斥冲突

- 生成 `thinkingConfig` 时，若存在 `budget_tokens` 则仅写入 `thinkingBudget`，不再同时写入 `thinkingLevel`
