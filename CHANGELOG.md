# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

### 2026-03-11 (继续)

#### Features
* 实现配置文件智能合并方案
  - 新增管理字段定义（`src/server/config-managed-fields.ts`），区分管理字段和保留字段
  - 新增配置合并模块（`src/server/config-merge.ts`），支持 JSON 和 TOML 格式的智能合并
  - 重构配置写入函数（`writeClaudeConfig`, `writeCodexConfig`），使用智能合并保留工具运行时写入的内容
  - 重构配置恢复函数（`restoreClaudeConfig`, `restoreCodexConfig`），使用智能合并恢复原始配置
  - 使用原子性写入确保配置文件不会损坏
  - 使用 `@iarna/toml` 库处理 Codex 的 TOML 格式配置

#### Fixes
* 修复 Claude Code 激活/停用路由时 `projects` 丢失的问题
* 修复 Codex 激活/停用路由时 `[projects...]` 丢失的问题

### 2026-03-11

#### Fixes
* 修复 Codex 使用 `openai-chat` 数据源时流式转换丢事件问题
  - 修复 `SSEEventCollectorTransform` 在对象模式下错误透传空对象的问题，改为原样透传事件
  - 解决下游转换器拿不到 OpenAI Chat chunk，导致无法稳定产出 Responses 事件的问题
* 增强 Responses SSE 兼容性
  - `SSESerializerTransform` 在存在 `event` 且 `data.type` 缺失时自动补齐 `type`
  - 避免客户端仅按 `data.type` 解析时漏判 `response.completed`
* 修复客户端断开后的错误处理
  - `proxyRequest` 增加请求中止控制（`AbortController`）与 `req/res` 断开监听
  - 在进入 `pipeline` 前检查 `res` 可写状态，避免 `ERR_STREAM_UNABLE_TO_PIPE`
  - 客户端断开时记录为 499 并跳过故障切换/黑名单，避免误判服务故障
* 统一所有主流 SSE 转发路径到同一套稳定链路
  - 关闭历史特殊流式分支，统一使用 `transformSSEToTool + 默认 pipeline`
  - 覆盖 `codex -> openai-chat/claude/gemini` 与 `claude-code -> openai-chat/openai/gemini` 场景
  - 避免历史分支转换器不一致（如 Claude/Gemini 误转 OpenAI Chat）导致的兼容问题
* 全面审计并修复 `streaming.ts` 各 Transform 的协议对齐问题
  - `SSEParserTransform` 改为保留 `data:` 原始内容，仅移除可选单个前导空格，避免 `trim()` 破坏增量 JSON
  - `convertOpenAIUsageToClaude` 同时兼容 Chat（`prompt/completion_tokens`）和 Responses（`input/output_tokens`）usage 结构
  - `ChatCompletionsToResponsesEventTransform` 修复完成事件重复与 finish_reason 处理时机，补齐 `response.in_progress` 与 `function_call_arguments.done`
  - `ClaudeToResponsesEventTransform` 修复工具调用索引关联逻辑，补齐 `function_call_arguments.done`，并按 stop reason 透传不完整原因
  - `GeminiToResponsesEventTransform` 统一输出函数调用 delta/done 事件并保留 `item_id/call_id` 兼容字段，完善不完整原因映射
  - `ResponsesToClaudeEventTransform` 新增对标准 Responses 事件（`data.type`）兼容，支持 `output_item.added` 与 `function_call_arguments.delta/done`
  - `OpenAIToClaudeEventTransform` 增强 Responses 事件识别与函数调用处理，补齐 `response.failed/incomplete` 的 stop reason 映射
  - `GeminiToClaudeEventTransform` 修复工具调用索引冲突（多候选场景），改用全局递增索引
  - `GeminiToOpenAIChatEventTransform` 修复图像 chunk 映射为非法 `delta.content` 数组的问题，改为兼容文本占位输出

### 2026-03-10 (继续)

#### Fixes
* 修复 `ChatCompletionsToResponsesEventTransform` 流式转换器重复发送结束事件的问题
  - 在 `_flush` 方法中添加对 `this.finalized` 的检查，避免重复发送 `response.completed` 事件
  - 修复 "Cannot pipe to a closed or destroyed stream" 错误
* 移除 `streaming.ts` 中不需要的导出
  - 移除 `SSEEvent` 类型导出（改为文件内部使用）
  - 移除 `rewriteStream` 函数导出（未使用）
  - 移除 `convertOpenAIUsageToClaude` 和 `mapOpenAIToClaudeStopReason` 函数导出（改为文件内部使用）
  - 移除 `ResponsesToClaudeEventTransform` 中的类型错误
  - 修正 `toolCalls` 和 `toolCallIndexToBlockIndex` 的类型定义，确保类型匹配
  - 修复 `findToolBlockIndexByCallId` 方法中的类型不匹配问题
* 重构流式转换逻辑到 `transformSSEToTool` 方法
  - 创建 `transformSSEToTool` 方法，统一流式转换器的选择逻辑
  - 简化 `proxy-server.ts` 中的默认流式处理代码
  - 改进 usage 提取逻辑，使用自定义的 `extractUsage` 函数

#### Features
* Codex model_reasoning_effort 新增 xhigh（Extra high）选项
  - 类型定义更新为 `low | medium | high | xhigh`
  - 前端 UI 新增 Extra high 选项
  - 后端验证支持 xhigh 值

### 2026-03-10 (继续)

#### Features
* 新增四个 SSE 流式事件转换器
  - `ClaudeToResponsesEventTransform`：Claude Events → Responses API Events
  - `GeminiToResponsesEventTransform`：Gemini Events → Responses API Events
  - `ChatCompletionsToClaudeEventTransform`：OpenAI Chat Events → Claude Events
  - `ResponsesToClaudeEventTransform`：Responses API Events → Claude Events
* 在 `proxy-server.ts` 中集成新转换器
  - 支持 Claude → Codex 流式转换
  - 支持 Gemini → Codex 流式转换
  - 支持 OpenAI Chat → Claude Code 流式转换
  - 支持 OpenAI Responses → Claude Code 流式转换
* 流式转换支持更多 API 格式组合，增强代理兼容性

#### Features
* 日志系统升级：新增"实际转发的响应体"字段
* 日志系统升级：新增"实际转发的响应体"字段
  - 在 `RequestLog` 接口中添加 `downstreamResponseBody` 字段
  - 记录 aicodeswitch 在收到上游 API 响应并转换后发送给客户端的响应体
  - 对于流式响应，存储转换后的 SSE chunks 数组（实际发送给客户端的格式）
  - 对于非流式响应，存储 JSON 格式的响应体
  - 日志详情窗口中正确显示实际转发的响应体内容
  - 修复了错误的转换器导入：`OpenAIChatToResponsesEventTransform` → `ChatCompletionsToResponsesEventTransform`
  - 移除不再需要的 `assembleConvertedResponseBody` 函数

#### Fixes
* 修复 `proxy-server.ts` 中响应转换函数的导入和调用错误
  - 添加缺失的导入：`transformResponseFromClaudeToResponses`
  - 修正 Claude Code 接收 OpenAI Responses 响应时的函数调用：`transformResponseFromClaudeToResponses` → `transformResponseFromResponsesToClaude`

#### Refactoring
* 清理 `src/server/transformers/claude-openai.ts` 中未被使用的函数
  - 保留被 `streaming.ts` 使用的函数：`convertOpenAIUsageToClaude`、`mapStopReason`
  - 删除 15 个未被使用的导出函数及其依赖的内部辅助函数
  - 减少代码体积约 1000+ 行，提升代码可维护性

#### Features
* 新增三个 Claude Code 请求转换函数
  - `transformRequestFromClaudeToGemini`：Claude → Gemini
  - `transformRequestFromClaudeToResponses`：Claude → Responses
  - `transformRequestFromClaudeToChatCompletions`：Claude → Chat Completions
  - 支持文本和图像内容转换、工具调用转换、生成参数转换
* 新增三个 Chat Completions 转换函数
  - `transformRequestFromChatCompletionsToResponses`：Chat Completions → Responses
  - `transformRequestFromChatCompletionsToClaude`：Chat Completions → Claude
  - `transformRequestFromChatCompletionsToGemini`：Chat Completions → Gemini
  - 支持文本和图像内容转换、工具调用转换、生成参数转换
* 新增 `transformRequestFromResponsesToGemini` 转换函数
  - 将 Codex 发起的 Responses API 请求转换为 Gemini API 格式
  - 支持系统提示词（instructions → systemInstruction）
  - 支持消息转换（input → contents）
  - 支持文本和图像内容转换
  - 支持 tools 和 tool_choice 转换
  - 支持生成参数转换
* 新增九个响应转换函数
  - `transformResponseFromChatCompletionsToResponses`：Chat Completions → Responses
  - `transformResponseFromClaudeToResponses`：Claude → Responses
  - `transformResponseFromGeminiToResponses`：Gemini → Responses
  - `transformResponseFromResponsesToChatCompletions`：Responses → Chat Completions
  - `transformResponseFromClaudeToChatCompletions`：Chat Completions → Claude
  - `transformResponseFromGeminiToChatCompletions`：Gemini → Chat Completions
  - `transformResponseFromChatCompletionsToClaude`：Chat Completions → Claude
  - `transformResponseFromResponsesToClaude`：Responses → Claude
  - `transformResponseFromGeminiToClaude`：Gemini → Claude

#### Fixes
* 修复 `transformRequestFromResponsesToChatCompletions` 函数的多个问题
  - 添加输入验证，处理 `input` 为非数组的情况
  - 修复空系统消息问题，仅当有实际内容时才添加系统/developer 消息
  - 新增图像内容类型转换支持：`input_image` → `image_url`
  - 修复模型参数处理，当 `targetModel` 为 `undefined` 时使用原始 `model` 字段
  - 支持字符串格式的 `content` 处理
  - 根据 `shouldUseDeveloperRole` 函数选择正确的角色（`system` 或 `developer`）
  - 转换 `max_output_tokens` → `max_tokens`
  - 保留 `reasoning` 参数
  - 新增 `transformResponseContentItem` 辅助函数统一处理 content item 转换

#### Refactoring
* 创建统一的请求转换器导出文件 `request-transformers.ts`
  - 提供语义化的转换函数名称，明确表示转换方向
  - 例如：`transformRequestFromClaudeToChatCompletions`、`transformResponseFromGeminiToClaude`
  - 统一管理所有转换函数的导入和导出
* 更新 Gemini 转换函数以支持 `targetModel` 参数
  - `transformClaudeRequestToGemini` 和 `transformOpenAIChatRequestToGemini` 新增可选参数
  - 保持与其他转换函数的接口一致性
* 更新 Chat Completions ↔ Responses 转换函数
  - `transformChatCompletionsToResponses` 和 `transformResponsesToChatCompletions` 支持 `targetModel` 参数
  - 转换时正确应用目标模型名称
* 重构 proxy-server.ts 的转换函数导入
  - 统一从 `request-transformers.ts` 导入所有转换函数
  - 更新所有响应转换函数调用以使用新的语义化名称
* 重构 URL 构建逻辑，使用 `mapRequestPathToUpstreamUrl` 方法统一处理
  - 删除冗余方法：`buildOpenAIResponsesUrl`、`buildGeminiUrl`、`mapRequestPath`
  - 删除未使用方法：`isClaudeChatSource`、`isOpenAIChatSource`
  - 简化上游 URL 构建逻辑，统一由 `mapRequestPathToUpstreamUrl` 方法处理

#### Fixes
* 修复 OpenAI（Responses）请求类型 URL 拼接问题
  - 修复 `isOpenAIChatSource` 方法错误地将 `openai` 类型归类为 OpenAI Chat 的问题
  - 新增 `isOpenAIType` 方法统一处理 OpenAI Chat 和 OpenAI Responses 类型
  - 在 `mapRequestPath` 方法中添加对 OpenAI Responses 的路径映射处理
  - Claude Code → OpenAI Responses：路径从 `/v1/messages` 正确映射为 `/v1/responses`
  - Codex → OpenAI Responses：路径从 `/v1/chat/completions` 正确映射为 `/v1/responses`
  - 修复请求体转换、响应转换、流式响应转换中缺少对 OpenAI Responses 的处理
  - 所有使用 OpenAI 转换函数的地方现在统一使用 `isOpenAIType` 方法

### 2026-03-09

#### Fixes
* 调整 OpenAI（Responses）数据源 URL 规则为固定拼接
  - 后端移除 base URL `/v{number}` 兼容分支，统一按 `{baseUrl}/v1/*` 转发
  - OpenAI 类型服务新增 `/v1` 结尾校验，要求填写不含 `/v1` 的 base URL
  - 前端 Vendors 页面新增校验与提示文案，阻止保存以 `/v1` 结尾的 OpenAI base URL
* 新增 OpenAI base URL 自动迁移
  - 启动时自动扫描 `vendors.json`，仅对 `sourceType=openai` 且 `apiUrl` 末尾为 `/v1` 的服务进行迁移
  - 迁移规则为移除末尾 `/v1` 并回写数据库
  - 导入数据时同步执行同样归一化，避免导入旧配置后再次触发问题

### 2026-03-08

#### Improvements
* 调整请求类型优先级顺序为：图像理解 → 高智商 → 长上下文 → 思考 → 后台 → 模型顶替 → 默认
