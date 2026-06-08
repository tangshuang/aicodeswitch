# Changelog

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
