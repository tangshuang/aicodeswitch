# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

### 2026-03-10

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
