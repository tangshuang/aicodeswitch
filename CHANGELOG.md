# Changelog

## 2026-06-11: 修复关闭 AUTH 后日志/会话不再写入的问题

### 修复
- 修复当未配置 AUTH（`AUTH` 环境变量为空）时，代理请求日志和会话不再写入「日志」「会话」页面的问题
- 根因：`AccessKeyModule` 在服务启动时被无条件初始化并注入 `ProxyServer`，导致 4 处 `sk_` 前缀识别条件（`/v1/models`、`/v1/*` 标准路径、`/claude-code/`+`/codex/` 动态路径、`createFixedRouteHandler`）仅依赖 `apiKeyValue.startsWith('sk_') && this.accessKeyModule` 即判定为 AccessKey 请求
- 当用户曾开启 AUTH 并通过「写入本地」把 AccessKey 写入编程工具配置（如 `~/.claude/settings.json` 的 `ANTHROPIC_AUTH_TOKEN`），关闭 AUTH 后该 `sk_` 凭据仍残留在配置中，编程工具继续携带它发请求；代理将这些请求误判为 AccessKey，日志写入密钥独立日志空间（`key-logs/{keyId}/`）并在 `finalizeLog` 中 `return` 跳过 `dbManager.addLog`，导致关闭 AUTH 后本应可见的「日志」「会话」始终为空
- 修复：上述 4 处识别条件统一追加 `&& isAuthEnabled()` 守卫，明确语义——未配置 AUTH 时完全不进入任何 API Key 相关逻辑，即使请求携带 `sk_` 凭据也直接忽略并走普通放行+普通日志路径
- 影响文件：`src/server/proxy-server.ts`

## 2026-06-23: 流式模式下智能故障切换修复

### 修复
- 修复流式（SSE）模式下智能故障切换几乎完全失效的问题
- 根因：原实现在流管道建立前就发送了响应头（`res.status()` + `copyResponseHeaders()`），导致 `res.headersSent=true`，而所有故障切换判断条件都要求响应未提交，因此流式场景下无法切换到下一个候选服务
- 新增 `preflightStream()` 方法：在提交响应头前预读第一个 SSE 事件，若首事件为 `response.failed`/`error` 或超时/提前关闭，则不提交响应头，直接抛出 `FailoverProxyError` 触发故障切换
- 新增 `createPreflightCombinedStream()` 方法：预检通过后用组合流（缓冲字节 + 上游剩余流）无缝衔接后续 SSE 管道，原有所有 Transform 无需改动
- 同步覆盖 `proxyRequest()` 与 `proxyRequestForApiPath()` 两条流式处理路径
- 预检阶段保留原始字节（非解析后事件），避免二次解析，最大兼容现有转换器

## 2026-06-22: 密钥详情页新增"会话"Tab

### 新增
- 密钥详情页新增"会话"Tab，支持按密钥查看独立会话列表
- 每密钥独立会话存储（`key-sessions/<keyId>/sessions.json`），与全局会话系统完全隔离
- 会话列表支持搜索（标题/ID）、客户端类型过滤、分页、自动刷新
- 会话详情弹窗支持双模式切换：日志模式（表格查看）和对话模式（聊天视图）
- 会话日志/对话数据导出（JSON 格式）
- 代理请求处理中自动追踪密钥级会话（两处 finalizeLog 覆盖全部代理路径）
- 新增 `KeySessionTracker` 模块（`src/server/access-keys/key-session-tracker.ts`）
- 新增 `KeyLogger.getLogsBySessionId()` 方法，按 sessionId 过滤密钥日志
- 提取共享聊天工具函数到 `session-chat-utils.tsx`，供 SessionsPage 和 AccessKeyDetailPage 共用
- 新增 6 个 API 端点：`GET/DELETE /api/access-keys/:id/sessions`、`GET /api/access-keys/:id/sessions/count`、`GET /api/access-keys/:id/sessions/:sessionId`、`GET /api/access-keys/:id/sessions/:sessionId/logs`、`DELETE /api/access-keys/:id/sessions/:sessionId`

## 2026-06-21: 写入本地记录持久化与自动恢复

### 新增
- 写入本地记录持久化：记录哪个 AccessKey 写入了哪些工具配置文件
- 服务启动后自动恢复已写入的 AccessKey 到 Claude Code / Codex 配置文件
- 全局配置更新、手动写入配置后自动恢复 AccessKey，防止被占位符覆盖
- 密钥删除/批量删除时自动清理写入本地记录
- 密钥重新生成时自动重写到已绑定的工具配置文件
- 密钥列表页面显示写入本地 tag 标注（Claude Code / Codex）
- 新增 `GET /api/write-local-records` 端点

## 2026-06-21: 代理响应 model 字段回写

### 新增
- 代理层统一将响应中的 `model` 字段回写为客户端请求时的原始模型名，解决 Claude Code / Codex 等工具因读取上游模型名而导致模型映射规则失效的问题
- 新增 `ModelRewriteTransform` 流式 SSE 文本 model 回写 Transform
- 新增 `rewriteResponseModel` 非流式响应 model 回写函数
- 覆盖全部 4 条代理路径（proxyRequest / proxyRequestForApiPath 的流式与非流式）

## 2026-06-11: 修复配置文件写入时认证字段丢失

### 修复
- 修复代理写入 Claude Code 配置时 `ANTHROPIC_API_KEY` 被置空的问题
- 修复恢复配置时空值覆盖 backup 中原始 API Key 的问题
- CLI `aicos restore` 管理字段列表与 Server 端同步，补全 8 个缺失字段
- 提取 CLI 共享管理字段模块，避免未来不同步

## 2026-06-20: 局域网配置同步

### 新增
- 设置页面新增"局域网同步"卡片，支持开启/关闭"允许局域网拉取配置"开关
- 路由管理页面新增"同步配置"按钮，打开局域网同步弹窗
- 5 步同步流程：扫描发现 → 选择 Skills → 选择 MCP → 供应商配置 → 预览确认
- Skills 同步含 SKILL.md 内容，MCP 同步含完整配置（command/args/env/url 等）
- 重名检测：本地已存在的 Skills/MCP 自动禁用，橙色提醒"本地已存在，无法重复同步"
- 可选将远端节点作为本地供应商（选填 API Key）
- 后端新增 `GET /api/lan/discover`（免鉴权，由开关控制）、`GET /api/lan/scan`、`POST /api/lan/sync`

## 2026-06-20: API认证方式支持继承供应商全局配置

### 新增
- API 服务新增"使用供应商全局配置的API认证方式"复选框，与 API 地址、API 密钥采用同一继承模式
- 新建服务时若供应商已配置 authType 则默认勾选继承
- 代理请求时自动解析继承的 authType（`resolveEffectiveAuthType`）

## 2026-06-10: 策略路由支持"按系统默认" + 配置重试次数

### 新增
- 策略路由绑定新增"按系统默认"选项（`routeId: 'system'`），作为默认值
  - 选择后 AccessKey 请求使用系统路由管理中配置的默认路由规则
  - 支持所有 3 个代理入口（标准 API 路径、动态代理中间件、固定路由处理器）
- Claude Code 配置写入增加 `env.CLAUDE_CODE_MAX_RETRIES: 3`
- Codex 配置写入增加 `stream_max_retries = 3` 和 `stream_retry_backoff = "fixed"`

### 变更
- 策略编辑表单路由默认选项从"选择路由..."改为"按系统默认"
- 策略卡片和密钥详情页展示"系统默认"标签（蓝色）

## 2026-06-10: 修复 AUTH 错误导致 Claude Code 挂起

### 修复
- 修复 AUTH 启用后，Claude Code 收到 401 错误但持续请求不停止的问题
  - 根因：`sendAuthError` 对流式请求返回 SSE 格式的 401 响应，违反 Anthropic API 规范
  - 按 Anthropic 文档，4xx 错误应始终以标准 HTTP JSON 返回，SSE error event 仅用于 200 已发送后的流中错误
  - 现所有 401 错误统一返回标准 HTTP JSON + `request-id` header + `connection: close`
- 修复 `sendAccessKeyError` 仅返回 OpenAI 格式的问题，现根据客户端格式自动返回 Claude 或 OpenAI 格式
- 所有 AccessKey 错误响应统一添加 `request-id` 和 `connection: close` header

## 2026-06-10: 认证体系简化与密钥详情页 Tabs 改造

### 新增
- AccessKey 请求现在会同步更新全局统计数据（`syncStatisticsFromAccessKey`），确保"数据统计"页面在 AUTH 启用后仍能展示完整的使用情况
  - 仅更新统计，不写入全局日志（AccessKey 日志仍独立存储）
  - 覆盖 `/claude-code/`、`/codex/` 和 API 路径（`/v1/*`）所有代理入口

### 修复
- 修复 AUTH 启用后，动态代理中间件未执行认证检查的漏洞（`proxy-server.ts` 的 Dynamic proxy middleware 分支）
  - 该中间件先于 `createFixedRouteHandler` 注册，会先拦截 `/claude-code/` 和 `/codex/` 路径的请求
  - 现已补充完整的 AccessKey 鉴权 + 配额检查 + 策略路由解析逻辑

### 变更
- 移除全局 `config.apiKey` 认证机制，简化为 AUTH 驱动的 AccessKey-only 认证
- AUTH 未配置时：不展示"接入密钥"菜单，所有代理请求无需认证直接通过
- AUTH 已配置时：展示"接入密钥"菜单，隐藏"会话""日志"菜单，所有代理请求必须通过 AccessKey (`sk_` 前缀) 认证
- 移除设置页面的 API Key 配置项
- Claude Code / Codex 配置注入改用固定占位符 `"api_key"`，用户通过密钥详情页的"写入本地"功能将真实 Key 写入本地

### 新增
- 密钥详情页重构为 Tabs 布局：基本信息 / 统计 / 日志
  - **基本信息**：展示 API Key（脱敏 + 复制）、策略、状态、创建时间、最后活跃、备注等
  - **统计**：概览卡片 + Token/请求量/错误数趋势图，支持 7/30/90 天切换
  - **日志**：完整日志列表，支持日期筛选、分页、自动刷新，复用 `LogDetailModal` 组件
- 新增"写入本地"功能：将 AccessKey 真实 Key 写入 Claude Code / Codex 本地配置文件
  - 后端 API：`POST /api/access-keys/:id/write-local`
  - 弹窗支持选择目标（Claude Code / Codex）
- 新增 `writeAccessKeyToLocal` 前端 API 方法

### 移除
- `AppConfig.apiKey` 类型定义
- `fs-database.ts` 中 `apiKey` 默认值
- `proxy-server.ts` 中 4 处 `config.apiKey` 认证分支
- `SettingsPage` 中 API Key 表单项

## 2026-06-10: 日志详情弹窗组件化重构

### 优化
- 将日志详情弹窗从 LogsPage 提炼为公共组件 `LogDetailModal`，支持 RequestLog 和 ErrorLog 两种类型
- 将 SSE 解析、日志格式化等工具函数提取到 `src/ui/utils/log-utils.ts`，消除 LogsPage 与 SessionsPage 之间的代码重复
- 修复会话详情页"详情"按钮无法弹出日志详情的问题，现在使用与日志管理页相同的富格式弹窗

## 2026-06-10: AccessKey 接入密钥共享功能

### 新增
- 新增 AccessKey（接入密钥）功能模块，支持通过 `sk_` 前缀的 API Key 实现多端接入共享
- 新增 Policy（策略）管理功能，支持可复用的策略模板（路由绑定 + 配额限制 + 模型过滤）
- 新增 Key 级独立日志和统计系统，AccessKey 请求完全独立于现有系统
- 新增配额检查：Token 日/周/月限额、请求次数限额、RPM 限制、并发限制、模型过滤
- 新增接入指引功能，为每个密钥生成 Claude Code/Codex/OpenAI 兼容工具的接入配置
- 新增批量操作：批量启用/停用、批量绑定策略、批量删除
- 新增 Key 详情页：统计概览、Token 趋势图、最近请求列表
- 新增全局统计 API：Key 用量排行、配额告警
- 新增预置策略模板：不限/轻度/中度/严格限制
- 新增 `src/server/access-keys/` 模块目录（manager/policy-manager/quota-checker/usage-tracker/key-logger/key-resolver）
- 新增 `src/ui/pages/AccessKeysPage.tsx`：接入密钥管理页面（含策略管理折叠面板）
- 新增 `src/ui/pages/AccessKeyDetailPage.tsx`：密钥详情页面
- 新增侧边栏导航入口：接入密钥
- 接入密钥与策略管理合并为单一页面，策略面板默认折叠，通过右上角「📜 策略管理」按钮展开
- 创建密钥弹窗样式美化：使用现有 `.modal` 体系，增加关闭按钮、标题描述、成功态大图标+虚线边框 Key 展示

### 修改
- 代理引擎支持 `sk_` 前缀 Key 识别，通过策略路由处理请求
- 代理请求流程支持三种 Header 认证：`Authorization: Bearer`、`x-api-key`、`x-goog-api-key`
- AccessKey 请求完全绕过现有日志和统计系统，写入独立存储空间
- 管理面板 JWT 认证从 `Authorization: Bearer` 迁移到 `Access-Token` Header，避免与 AccessKey 认证冲突
- 当 AUTH 开启时，带有 `Authorization` Header 的请求自动跳过管理面板认证，由代理引擎在业务前置对 AccessKey 进行鉴权

### 认证体系重构
- **管理面板认证**：JWT token 从 `Authorization: Bearer` 迁移到 `Access-Token` header，前后端同步调整
- **代理 API 认证**：`config.apiKey` 和 AccessKey 均通过 `Authorization: Bearer`（以及 `x-api-key`、`x-goog-api-key`）传递，代理引擎通过 `sk_` 前缀区分
- **AUTH 强制认证**：当 AUTH 环境变量启用后，代理请求必须通过 `config.apiKey` 或 AccessKey 认证，不再允许匿名访问
  - AUTH 开启 + `config.apiKey` 已配置 → 支持 `config.apiKey` 或 AccessKey
  - AUTH 开启 + `config.apiKey` 未配置 → 仅允许 AccessKey (`sk_` 前缀)
  - AUTH 未开启 → 保持原有行为（可选认证）
- 修复 `handleApiPathProxyRequest` 中 `config.apiKey` 校验只读取 `Authorization` header 的问题，现统一使用 `extractApiKey()` 方法同时支持三种 Header

## 2026-06-09: 会话路由绑定功能

### 新增
- 新增会话路由绑定功能，允许将会话绑定到指定路由，实现会话级别的差异化路由策略
- 新增 `src/ui/components/SessionRouteBindingModal.tsx`：路由绑定弹窗组件，支持选择路由进行绑定和解绑
- 新增 3 个 API 端点：`PUT /api/sessions/:id/bind-route`（绑定路由）、`DELETE /api/sessions/:id/bind-route`（解绑路由）、`GET /api/routes/:id/bound-sessions`（查询路由绑定会话）
- 会话管理页操作栏新增「路由」按钮，已绑定时显示路由名（绿色），未绑定时显示"路由"（蓝色）
- 路由管理页路由卡片新增绑定会话数量标签（📎 N 个会话），点击后弹窗展示绑定会话列表
- 代理路由选择优先级：会话级绑定 > 全局工具绑定 > 原始配置兜底

### 修改
- `src/types/index.ts`：Session 接口新增 `routeId?` 和 `routeName?` 可选字段
- `src/server/fs-database.ts`：新增 `bindSessionRoute()`、`unbindSessionRoute()`、`getBoundSessions()` 方法；`deleteRoute()` 增加级联清理绑定逻辑；`upsertSession()` 保留已有路由绑定
- `src/server/proxy-server.ts`：`findMatchingRoute()` 和标准 API 路径中间件增加会话级路由覆盖逻辑；新增 `extractSessionIdForFormat()` 辅助方法
- `src/server/main.ts`：新增会话路由绑定相关 API 端点
- `src/ui/api/client.ts`：新增 `bindSessionRoute()`、`unbindSessionRoute()`、`getBoundSessions()` 三个 API 方法
- `src/ui/pages/SessionsPage.tsx`：新增路由按钮和 SessionRouteBindingModal 集成
- `src/ui/pages/RoutesPage.tsx`：路由卡片新增绑定会话数量标签和弹窗查看

## 2026-06-09: 会话迁移功能

### 新增
- 新增会话迁移功能，支持在 Claude Code 和 Codex 之间（及同工具内）迁移对话上下文
- 新增 `src/server/session-migration.ts`：迁移核心服务，包含 SSE 解析、内容提取、Prompt 生成、Token 估算
- 新增 `src/server/session-launcher.ts`：CLI 启动器，支持跨平台终端窗口启动（macOS/Linux/Windows）及临时文件管理
- 新增 `src/ui/components/SessionMigrationModal.tsx`：迁移弹窗组件，支持预览、编辑、CLI 启动和剪贴板复制三种交付方式
- 新增 3 个 API 端点：`POST /api/sessions/:id/migration-preview`（预览）、`POST /api/sessions/:id/migrate`（执行迁移）、`POST /api/sessions/:id/migrate-launch`（CLI 启动）
- 迁移弹窗采用卡片式布局：左侧固定来源工具 → 箭头 → 右侧两个可选项（支持同工具迁移）
- 自动推断项目目录（从 `~/.claude/sessions/` 读取 cwd），CLI 启动时自动 cd 到正确目录
- 工具调用摘要化：将 Bash/Read/Write/Edit 等工具调用转为自然语言描述
- 支持 Claude/OpenAI/Responses/Gemini/DeepSeek 五种格式的 SSE 流式响应文本提取
- 服务启动时自动清理旧的迁移临时文件（`/tmp/aicodeswitch-migration-*`）

### 修改
- `src/types/index.ts`：新增 MigrationOptions、MigrationRound、MigrationContent、MigrationPreview、MigrationResult、LaunchResult 类型
- `src/ui/pages/SessionsPage.tsx`：会话列表操作列新增「迁移」按钮
- `src/ui/api/client.ts`：新增 migrationPreview、migrateSession、migrateLaunch 三个 API 方法
- `src/ui/styles/App.css`：新增迁移弹窗样式（卡片选择、来源徽章、深色模式）

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
