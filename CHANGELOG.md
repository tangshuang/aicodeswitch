# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

### 2026-03-30

#### Bug Fixes
* **修复流式响应中文乱码的根本问题**
  - 在 `SSEParserTransform` 中使用 `StringDecoder` 正确处理多字节字符边界
  - 在 `ChunkCollectorTransform` 中使用 `StringDecoder` 确保日志记录不乱码
  - 在 `SSEEventCollectorTransform` 中使用 `StringDecoder` 确保 SSE 事件解析正确
  - 修复 `readStreamBody` 方法使用 Buffer 数组收集后一次性解码
  - 修复 `version-check.ts` 中的流处理使用 Buffer 数组收集
  - 使用 `StringDecoder` 处理 UTF-8 多字节字符被截断到不同 chunk 的情况

### 2026-03-25

#### Bug Fixes
* **修复代理响应中文乱码问题**
  - 修复 `readStreamBody` 方法中 `chunk.toString()` 未指定 UTF-8 编码的问题
  - 修复所有 SSE 流式响应的 Content-Type 缺少 `; charset=utf-8` 声明
  - 修复请求头和响应日志中 Content-Type 缺少 charset 声明的问题
  - 确保中文字符在流式和非流式��应中正确传输

### 2026-03-18

#### Bug Fixes
* **忽略 499 Client Disconnect 状态码作为错误处理**
  - 当上游供应商返回 499 状态码时，不再将规则标记为"请求失败"错误状态
  - 499 状态码现在会恢复为 idle 状态，与正常请求相同
  - 避免客户端主动断开连接导致的误报错误

### 2026-03-16

#### Bug Fixes
* **修复非空闲状态（error/suspended）规则未自动恢复的问题**
  - `error` 状态超过 30 秒后自动恢复为 `idle`，并通过 WebSocket 广播给前端
  - `suspended` 状态在黑名单过期后自动恢复为 `idle`
  - 覆盖"请求失败"、"服务不可用"等所有非空闲状态的自动恢复场景

* **修复黑名单过期后规则状态未同步恢复的问题**
  - 在全量同步定时器中增加黑名单过期检查逻辑
  - 当 `suspended` 状态的规则对应的黑名单过期时，自动恢复为 `idle` 状态
  - 前端无需刷新即可看到规则状态自动恢复

#### Features
* **新增 WebSocket 规则状态全量同步机制**
  - ��端每 10 秒广播一次所有规则状态（`all_rules_status` 消息类型）
  - 前端收到全量同步消息后自动替换本地状态
  - 新客户端连接时立即发送当前所有规则状态
  - 作为兜底机制，确保状态不会因网络问题丢失同步

### 2026-03-15

#### Features
* **优化图像理解请求类型检测**
  - 新增 `containsImageContentInLatestMessage` 方法，仅检测最新用户消息中的图像内容
  - 修复后续对话轮次仍被错误匹配为"图像理解"类型的问题
  - 忽略历史消息中的图像内容，只关注当前用户输入

* **优化 WebSocket 规则状态实时同步**
  - 移除心跳检测机制，改用事件驱动的状态通知
  - 新增 `suspended`（挂起）状态类型，表示规则因黑名单暂时不可用
  - 服务被加入黑名单时实时广播规则挂起状态
  - 前端增加 `suspended` 状态的视觉显示（紫色 ⏸ 图标）
  - 挂起状态下支持一键恢复功能
  - 新增 `errorType` 字段区分 `http` / `timeout` / `unknown` 错误类型
  - 10 秒无活动后自动标记规则为空闲状态

### 2026-03-14

#### Features
* **优化 WebSocket 规则状态同步机制**
  - 在中转过程中持续发送规则状态心跳（每 0.2 秒一次）
  - 新增 `ruleHeartbeats` Map 管理心跳定时器
  - 新增 `HEARTBEAT_INTERVAL` 常量（200ms）
  - 新增 `clearRuleTimers` 私有方法统一清理定时器
  - 确保前端路由规则列表的"状态"实时同步

* **新增 Claude Code Effort Level 配置支持**
  - 新增 `ClaudeEffortLevel` 类型（可选值：'low', 'medium', 'high'）
  - 在 `AppConfig` 中添加 `claudeEffortLevel` 全局配置字段
  - 在 Claude Code settings.json 管理字段中添加 `effortLevel`
  - 更新 `writeClaudeConfig` 函数支持 `effortLevel` 参数
  - 在路由页面添加 Effort Level 下拉选择器 UI
  - 配置会实时写入 ~/.claude/settings.json，重启 Claude Code 后生效

### 2026-03-13

#### Changes
* **故障自动重置时间从 10 秒改为 30 秒**
  - 更新 `DEFAULT_FAILOVER_RECOVERY_SECONDS` 常量
  - 更新类型注释说明

* **高智商标识符从 `!!` 改为 `[!]`**
  - 原因：Claude Code 已占用 `!` 作为执行 bash 命令的标识符
  - 使用方式：`[!] 重构A模块` 启用高智商模式
  - 移除自动移除标识符的逻辑，保持原始 prompt 不变
  - 更新 UI 提示文本和文档

### 2026-03-11 (继续)

#### Breaking Changes
* **移除旧的 SQLite/LevelDB 数据库支持**
  - 删除 `src/server/database.ts`（旧的 SQLite/LevelDB 实现）
  - 删除 `src/server/migrate-to-fs.ts`（迁移工具）
  - 简化 `src/server/database-factory.ts`，移除所有迁移相关代码
  - 移除 npm 依赖：`better-sqlite3`、`level`、`@types/better-sqlite3`
  - 移除 CLI 命令 `aicos-migrate`
  - 更新文档，移除所有与 SQLite/LevelDB/迁移相关的内容

### 2026-03-11 (继续)

#### Fixes
* **修复日志记录中的Tokens用量统计问题**
  - 问题：所有日志记录中的usage字段为null，导致tokens用量无法正常统计和显示
  - 根本原因：流式响应处理中，usage提取逻辑存在时序和优先级问题
    - 当`extractedUsage`为null时，整个usage赋值逻辑被跳过
    - converter和eventCollector的usage提取时机不同步
  - 修复方案：
    - 改进usage提取逻辑：优先从converter获取，失败后再从eventCollector获取
    - 去除if-else的互斥逻辑，改为顺序尝试
    - 在所有流式处理分支添加详细的调试日志
    - 修复main.ts中rulesStatusBroadcaster的导入问题
  - 影响：现在日志记录可以正确保存tokens使用情况，统计数据页面能够正常显示用量信息
  - 相关文件：`src/server/proxy-server.ts`, `src/server/main.ts`

### 2026-03-11 (继续)

#### Fixes
* 修复 Claude Code → Gemini 流式响应 Token 使用统计显示 undefined
  - 统一默认流式链路的 `extractUsage` 函数返回 camelCase 字段名（`inputTokens`, `outputTokens`）
  - 修复 `transformSSEToTool` 中所有转换器的 usage 字段映射，确保与日志数据库格式一致

### 2026-03-11 (继续)

#### Features
* 优化规则列表实时状态展示
  - 增加规则 `error` 状态类型，用于标识请求失败
  - 后端在请求完成时（无论成功或失败）立即发送 WebSocket 状态更新
  - 缩短后端超时时间（30秒 → 10秒）和前端过期检查间隔（10秒 → 5秒）
  - 缩短前端过期时间（60秒 → 15秒），使状态更新更实时
  - 在请求失败时立即显示错误状态，提升用户体验

### 2026-03-11 (继续)

#### Fixes
* 优化激活路由无可用规则时的 fallback 行为
  - 当存在激活路由但匹配不到任何可用规则时（含 failover 关闭/开启两种模式），不再直接返回 `No matching rule found`
  - 改为优先 fallback 到备份原始配置（`*.aicodeswitch_backup`）继续转发请求
  - 当候选规则均不可用（如全部黑名单或服务缺失）且尚未实际发起上游请求时，也会触发同样 fallback 逻辑
* 修复 `isRequestOpenAIModels` 函数空值检查缺失导致的代理崩溃
  - 当 `model` 参数为 `undefined` 或非字符串时，函数会抛出 `Cannot read properties of undefined (reading 'toLowerCase')` 错误
  - 添加类型检查，确保 `model` 存在且为字符串后才调用 `toLowerCase()`
* 修复 Claude 在无激活路由 fallback 场景下默认模型映射缺失
  - fallback 读取 `settings.json.aicodeswitch_backup` 中的 `ANTHROPIC_DEFAULT_HAIKU_MODEL`、`ANTHROPIC_DEFAULT_SONNET_MODEL`、`ANTHROPIC_DEFAULT_OPUS_MODEL`
  - 按请求模型名关键段 `haiku/sonnet/opus` 自动映射并改写上游 `model`（如 `claude-sonnet-4-5-20250929` 命中 Sonnet 默认模型）
* 调整日志列表页展示信息
  - 移除请求日志列表顶部“显示 X / Y 条”文案，避免重复信息占位
* 优化日志详情弹窗中的流式事件展示
  - 将 "Stream Chunks" 改为 "实际输出效果" 并移至 "实际转发的响应体" 下方
  - 改为基于 `downstreamResponseBody` 解析 SSE 事件，简化解析逻辑
  - 正确处理 Responses API (Codex) 格式：支持 `response.reasoning_text.delta` 和 `response.content_part.done`
  - 正确处理 Claude API (ClaudeCode) 格式：支持 `content_block_delta` 中的 `thinking_delta` 和 `text_delta`
  - 只需支持两种标准格式，无需处理各种供应商原始数据

#### Features
* 日志列表中流式响应标识
  - 在请求日志列表中，为流式响应的日志条目添加黄色小点标识
  - 位置在"详情"按钮右上角，便于快速识别流式和非流式响应
* 修复 Codex → `deepseek-reasoning-chat` 流式响应协议不兼容问题
* 修复“实际转发的响应体”日志字段格式
  - 默认流式链路新增下游文本收集器，改为记录真实发送给客户端的 SSE 文本
  - `downstreamResponseBody` 在流式/非流式场景统一以字符串落库，不再写入 JSON 数组结构
* 修复日志字段语义回归：`responseBody` 与 `downstreamResponseBody` 混淆
  - 流式场景恢复 `responseBody/streamChunks` 记录上游供应商原始 SSE 返回
  - `downstreamResponseBody` 保持记录实际转发给客户端的内容
  - 非流式转换场景中，`responseBody` 改回记录上游原始响应，`downstreamResponseBody` 记录转换后响应
* 移除 OpenAI 数据源 base URL 的 `/v1` 限制
  - 删除前后端针对 OpenAI `apiUrl` 的 `/v1` 保存校验
* **错误日志展示 499 状态码日志**
  - 添加 API 端点 `/api/logs/client-disconnected` 获取状态码为 499 的请求日志
  - 错误日志页面现在同时展示状态码为 499 的请求日志
  - 在错误日志列表中，499 日志的 `errorMessage` 显示为 "Client disconnected"
  - 添加后端方法 `requestLogToErrorLog` 将请求日志转换为错误日志格式
  - 删除启动迁移与导入时对 OpenAI `apiUrl` 的 `/v1` 自动去尾归一化
  - Vendors 页面提示改为允许任意格式地址
* 优化 NPM 发布 workflow，避免不必要的版本号递增
  - 发布前先检查当前版本是否已被 npm 注册，若未发布则直接使用当前版本
  - 仅在当前版本已存在时才执行 `standard-version` bump 版本
  - 减少版本号浪费，提升发布流程灵活性
* 修复无激活路由时 fallback 误用当前配置导致的鉴权异常
  - fallback 改为实时仅读取 `*.aicodeswitch_backup`（Claude/Codex）
  - Codex fallback 依据备份中的 provider/wire_api 推断 `sourceType` 与 `authType`，避免 OpenAI 类上游被错误使用 `x-api-key`
  - 保留并增强自指向检测：当上游地址指向 aicodeswitch 自身时，跳过 fallback 并返回明确错误，避免回环

#### Features
* 实现配置文件智能合并方案
  - 新增管理字段定义（`src/server/config-managed-fields.ts`），区分管理字段和保留字段
  - 新增配置合并模块（`src/server/config-merge.ts`），支持 JSON 和 TOML 格式的智能合并
  - 重构配置写入函数（`writeClaudeConfig`, `writeCodexConfig`），使用智能合并保留工具运行时写入的内容
  - 重构配置恢复函数（`restoreClaudeConfig`, `restoreCodexConfig`），使用智能合并恢复原始配置
  - 使用原子性写入确保配置文件不会损坏
  - 使用 `@iarna/toml` 库处理 Codex 的 TOML 格式配置
* 重构配置写入时机
  - 服务启动时自动写入 Claude Code 和 Codex 配置文件（不依赖激活路由）
  - `aicos stop` 时自动恢复原始配置文件
  - `aicos restore` 时主动恢复原始配置文件
  - 新增 `bin/utils/config-helpers.js` 模块，提供 CLI 脚本的配置处理辅助函数
    - `parseToml()` - TOML 解析器
    - `stringifyToml()` - TOML 序列化器
    - `mergeJsonSettings()` - JSON 配置合并
    - `mergeTomlSettings()` - TOML 配置合并
    - `atomicWriteFile()` - 原子性文件写入
  - `bin/start.js` / `bin/stop.js` 保持仅进程启停职责
  - 统一 `src/server/original-config-reader.ts` 使用 `@iarna/toml` 库进行 TOML 解析
  - 移除路由激活/停用时的配置覆盖/恢复动作，`/api/routes/deactivate-all` 改为仅停用路由
* 新增“故障自动恢复时间”全局配置
  - 设置页在“启用智能故障切换”下新增“故障自动恢复时间（秒）”，默认 10 秒
  - 仅当“启用智能故障切换=是”时可编辑该字段
  - 后端黑名单恢复时间改为读取该配置（默认 10 秒）

#### Fixes
* 修复 Claude Code 激活/停用路由时 `projects` 丢失的问题
* 修复 Codex 激活/停用路由时 `[projects...]` 丢失的问题
* 修复全局工具配置修改后的生效时机
  - `/api/config` 与兼容更新接口在保存全局配置后，立即回写 Claude/Codex 配置文件
  - 无需重启服务；重启对应编程工具即可使全局配置生效
* 调整服务不可用自动恢复时间
  - 服务黑名单自动恢复时间统一改为 10 秒（原实现存在 2 分钟/10 分钟不一致）
  - 同步更新 Routes/Settings 页面中的故障切换提示文案为 10 秒
* 优化 `aicos restore` 运行中保护逻辑
  - restore 执行前新增服务运行状态检查（PID/端口）
  - 若服务仍在运行，则跳过恢复并提示先执行 `aicos stop`（stop 会自动恢复配置）
* 修复 CLI 配置备份/恢复重构回归问题
  - 修复 `bin/start.js` 语法错误导致 CLI 全命令无法加载的问题
  - `bin/start.js` 改为读取 `~/.aicodeswitch/fs-db`（不存在时回退 `~/.aicodeswitch/data`），并在读取前执行数据库 `initialize()`
  - `bin/start.js` 写入代理地址统一使用 `HOST/PORT`（与 `aicodeswitch.conf` 一致），不再使用 `AICOS_HOST/AICOS_PORT`
  - `bin/start.js` 补齐 Claude `.claude.json` 写入逻辑，并透传路由配置 `enableAgentTeams` / `enableBypassPermissionsSupport` / `codexModelReasoningEffort`
  - `bin/utils/config-helpers.js` 改为使用 `@iarna/toml` 进行 TOML 解析和序列化，修复复杂 TOML（数组、quoted key、projects）被破坏的问题
  - `bin/utils/config-helpers.js` 合并逻辑改为管理字段前缀匹配，确保 `model_providers.aicodeswitch` 等托管区块不会被旧值反向覆盖
  - `aicos stop` / `aicos restore` 在恢复成功后删除对应 `*.aicodeswitch_backup`，避免长期陈旧备份反复覆盖用户后续修改
  - `src/server/original-config-reader.ts` 兼容读取 `OPENAI_API_KEY`
* 调整配置文件写入/恢复触发时机（按服务生命周期）
  - 配置备份与覆盖改为在服务进程启动时执行（覆盖 `aicos start`、`aicos ui`、`aicos restart`、`yarn dev:server`）
  - 配置恢复改为在服务进程终止前执行（覆盖 `aicos stop` 发送 SIGTERM、开发态 `Ctrl+C` 触发 SIGINT）
  - `bin/start.js` 与 `bin/stop.js` 不再直接处理配置文件，仅负责进程启停
  - 保留 `aicos restore` 作为手动恢复入口
* 修复服务启动写配置触发条件
  - 移除“必须有激活路由才写入”的限制，改为服务启动即写入配置（按目标路由优先级选择参数：激活路由优先，否则使用同目标第一条路由，缺省回退默认值）
* 补齐工具请求日志覆盖范围与中转标记
  - 路由未命中、规则未命中、服务未配置、鉴权失败等早退场景也会写入请求日志
  - 请求日志 `tags` 统一记录中转状态：`通过中转` / `未通过中转`；fallback 原始配置额外记录 `使用原始配置`
  - 统计维持按日志 `usage` 聚合 token（通过 `addLog -> updateStatistics` 链路）
* 修复 fallback 路径请求体空值导致的代理崩溃
  - `applyModelOverride` 在未指定 `targetModel` 时改为返回原始请求体，不再返回 `undefined`
  - `proxyRequest` 对转换结果增加空值兜底，并将 `requestBody.model` 读取改为可选链
* 优化 Claude Code 到非 Claude 源的流式与 count_tokens 行为
  - `claude-code -> gemini/gemini-chat/openai-chat/openai/deepseek-reasoning-chat` 在未显式 `stream=false` 时默认按 Streaming（SSE）处理
  - 对 `/v1/messages/count_tokens` 请求改为服务端本地计算并直接返回 `{ "input_tokens": N }`，不再转发到上游服务
  - 请求日志新增标签 `系统计算Token直返`，用于标识“系统内计算后直接返回”的 count_tokens 请求

#### Docs
* 完善 `CLAUDE.md` 的“智能配置合并”文档
  - 细化服务启动写入/备份、服务终止恢复、UI 配置项修改生效时机与 `aicos restore` 命令行为
  - 补充状态检测、metadata 清理、Fallback 读取与 MCP 同步例外说明
* 调整路由页全局配置区块布局
  - 将“Claude Code 全局配置”和“Codex 全局配置”从路由规则区域移至“配置文件自动管理”模块上方，避免与路由规则混排
* 路由页新增“规则优先级顺序”提示模块
  - 在“智能故障切换机制”上方展示规则命中顺序，说明开启/关闭故障切换时的匹配优先级与同类规则排序行为
* 优化路由页规则说明文案（用户视角）
  - 将“规则优先级顺序”改为“如何配置规则（推荐）”，按操作步骤给出配置建议，降低理解成本
  - 追加常见类型优先顺序：图像理解 → 高智商 → 长上下文 → 思考 → 后台 → 模型顶替 → 默认
* 同步更新故障切换文案
  - Routes/Settings 页面改为“按故障自动恢复时间（默认10秒）”描述，避免写死时间与配置不一致

#### Fixes
* 修复服务终止恢复未生效但日志显示成功的问题
  - 修复 `config-merge` 路径收集策略：由“父子路径全量复制”改为“仅叶子路径复制”，避免 `env`/`model_providers` 整体覆盖导致托管字段被反向带回
  - `restoreClaudeConfig` / `restoreCodexConfig` 返回值改为“是否实际恢复过文件”，避免无 backup 场景误报 restored
* 工具配置改为全局配置并增加迁移兼容
  - 新增全局配置字段：`enableAgentTeams`、`enableBypassPermissionsSupport`、`codexModelReasoningEffort`
  - `syncConfigsOnServerStartup` 改为仅读取全局配置，不再从路由推导参数
  - 增加启动迁移：旧路由字段自动迁移到全局配置，并清理路由中的废弃字段
  - `RoutesPage` 中 Claude/Codex 配置改为读写 `/api/config`

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

### 2026-03-11

#### Improvements
* 新增供应商 API Key 继承配置
  - Vendors 页面新增供应商级 API 密钥字段，新增/编辑/一键配置均保存到供应商 `apiKey`
  - API 服务新增“使用供应商全局配置的API密钥”开关，开启后隐藏服务级 API 密钥输入框（仅隐藏不删除）
  - 后端转发鉴权在 `inheritVendorApiKey=true` 时改为读取供应商 `apiKey`，忽略服务自身 `apiKey`
* 调整供应商 API Key 继承默认行为
  - API 服务新增/保存后重置时，“使用供应商全局配置的API密钥”默认选中
  - 一键配置生成的 API 服务保持 `inheritVendorApiKey=true`，并继续使用供应商层 API Key
* 修复编辑供应商后 API 服务更新 404
  - 前端编辑供应商不再提交 `services`，避免误清空服务列表
  - 后端 `updateVendor` 保留既有 `services`，服务仅通过 API 服务接口维护
* 删除供应商/服务支持级联删除规则并增加二次确认
  - 删除 API 服务时，自动删除所有关联路由规则
  - 删除供应商时，自动删除其服务关联的全部路由规则
  - Vendors 页面删除 API 服务与删除供应商均新增二次确认弹窗，显示将删除的规则数量

### 2026-03-11

#### Fixes
* 修复代理成功响应后的二次写响应问题
  - 修正 `proxyRequest` 非流式分支的响应头写入顺序，避免先 `res.json/res.send` 后再 `setHeader`
  - 为代理入口和 `proxyRequest` 错误分支补充 `headersSent/writableEnded` 保护，避免日志或 fallback 再次写回客户端触发 `ERR_HTTP_HEADERS_SENT`
* 修复 Claude Code → Gemini 函数参数 Schema 不兼容导致的 400
  - 新增 Gemini 函数声明参数清洗逻辑，过滤 `$schema`、`additionalProperties`、`exclusiveMinimum`、`propertyNames`、`const` 等不兼容字段
  - `transformRequestFromClaudeToGemini` 与 `transformRequestFromResponsesToGemini` 统一使用清洗后的 `parameters`，避免 Gemini 返回 `Invalid JSON payload received`
* 修复 Claude Code → Gemini thinking 参数冲突导致的 400
  - Gemini `thinkingConfig` 改为互斥写入：存在 `budget_tokens` 时仅写 `thinkingBudget`，不再同时写 `thinkingLevel`
  - 同步修复 `transformRequestFromClaudeToGemini` 与 `transformRequestFromResponsesToGemini` 两条链路，避免 `You can only set only one of thinking budget and thinking level`

### 2026-03-11

#### Improvements
* 调整路由规则列表排序
  - UI 规则列表改为先按类型顺序排序，再按同类型内优先级排序
  - 类型顺序统一为：图像理解 → 高智商 → 长上下文 → 思考 → 后台 → 模型顶替 → 默认

### 2026-03-11

#### Fixes
* 修复规则中供应商模型覆盖未生效
  - 修复 `transformRequestToUpstream` 中 `applyModelOverride` 未传入 `targetModel` 的分支
  - 规则配置 `targetModel` 后，实际转发请求体 `model` 现在会正确覆盖工具原始模型

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
