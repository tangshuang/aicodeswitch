# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

### 2026-03-10

#### Refactoring
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
