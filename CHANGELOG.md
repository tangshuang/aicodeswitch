# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

### 3.8.0 (2026-03-01)

#### Changed
* **Breaking Change (向下兼容)**: 重命名数据源类型（SourceType）
  - `'claude-code'` → `'claude'`
  - `'openai-responses'` → `'openai'`
  - 命名更简洁，避免与 `TargetType` 中的 `'claude-code'` 混淆
  - **向下兼容保障**：
    - 数据库自动迁移：启动时自动迁移旧类型数据，创建备份文件
    - API 向下兼容：自动接受旧类型请求并转换为新类型
    - 导入导出：支持新旧两种格式的数据交换
    - 零感知升级：老用户无需任何手动操作

### 3.7.0 (2026-03-01)

#### Features
* 新增"Gemini Chat"数据源类型
  - 支持用户传入完整的 Gemini API 地址，无需系统自动拼接
  - 与 Gemini 数据源类型不同，Gemini Chat 要求用户提供完整的 API 端点 URL
  - 自动使用 Google API Key (x-goog-api-key) 认证方式
  - 支持请求和响应的自动转换（Claude/OpenAI ↔ Gemini）
  - 支持流式和非流式响应处理

### 3.6.0 (2026-03-01)

#### Features
* 新增"高智商"请求类型功能
  - 在路由规则中新增"高智商"（high-iq）请求类型选项
  - 用户可在提示词中使用 `!!` 前缀（如 `!! 重构A模块`）开启高智能模式
  - 使用 `!x` 前缀（如 `!x 继续正常对话`）关闭高智能模式
  - **会话持久化**：一旦开启高智商模式，整个会话将持续使用高智商模型，直到手动关闭或规则不可用
  - 系统自动检测用户消息中的命令前缀并管理会话状态
  - 实际转发请求时自动移除命令前缀和多余空格，保持提示词干净
  - 日志记录中会标记该请求为"高智商"请求类型
  - 支持字符串和数组类型的消息内容
  - 自动检测规则可用性，规则不可用时优雅降级

### 3.5.2 (2026-03-01)

#### Fixes
* 修复故障自动切换机制在特定场景下不生效的问题
  - 新增 Fallback 机制：当所有服务都在黑名单中时，自动使用最后一个失败的服务重试
  - 优化黑名单 TTL：从 10 分钟缩短到 2 分钟，使服务能够更快地重新可用
  - 确保即使只有一个规则配置，也能在服务报错时提供容错能力
  - 改进日志输出，增加 Fallback 尝试的详细记录

### 3.5.1 (2026-02-24)

#### Fixes
* 优化智能故障切换：当上游 API 返回 4xx/5xx 时，同一请求内立即切换到下一个可用服务，不再等待下次请求
* 故障兜底时错误日志新增转发提示（如“已自动转发给 xx 服务继续处理”），便于用户确认已自动接管

### 3.5.0 (2026-02-21)

#### Features
* 新增路由规则"请求频率限制"功能
  - 用户可以为规则设置请求频率限制（次数 + 时间窗口）
  - 当同一内容类型的请求频率超过限制时，系统会自动切换到其他同类型规则
  - 支持按内容类型（default/background/thinking/long-context/image-understanding/model-mapping）分别限制
  - 频率限制仅在同一内容类型存在多个规则时生效，用于实现负载均衡
  - 如果没有其他同类型规则，则继续使用当前规则（原行为不变）

#### Fixes
* 新增 GitHub Actions CI/CD 流水线用于 Tauri 应用构建和发布
  - **重要调整**：Tauri 构建优先于 npm 发布，确保桌面应用可用后才发布 npm 包
  - **新流程**：PR 合并 → Tauri 构建 → npm 发布（创建 tag）
  - **修复**：自动触发时直接构建，不检查 tag 是否存在
  - **修复**：使用 `npx tauri build` 代替 `tauri-action`，适配自定义构建脚本
  - **改进**：macOS 构建添加更详细的错误日志和目录检查
  - **修复**：Windows 构建日志命令使用 bash 兼容语法
  - **修复**：macOS cross-compilation 构建路径问题（使用 target triple 子目录）
  - 支持手动触发构建（可指定版本号）
  - 新增强制构建选项：允许为已发布的版本重新构建 Tauri 应用
  - 跨平台构建支持：macOS (dmg/app - Intel 和 Apple Silicon)、Windows (msi/exe)
  - 自动创建或更新 GitHub Release 并上传所有平台的安装包
  - macOS 平台同时构建两个独立版本：Intel 芯片 (x86_64) 和 Apple Silicon (M1/M2/M3)
  - macOS 构建文件自动添加架构标识（-apple-silicon / -intel）
  - .app 文件压缩为 .zip 格式以便发布
  - 新增详细的使用文档和故障排查指南
  - **注意**：移除 Linux 平台支持以确保 macOS 和 Windows 构建的稳定性

### 3.4.0 (2026-02-16)

#### Fixes
* 修复激活状态下切换 Agent Teams 功能开关时复选框状态不更新的问题
  - 路由激活时同时更新配置文件和路由数据库的 enableAgentTeams 字段
  - 确保前端复选框状态与实际配置保持同步

#### Features
* 路由管理新增 Agent Teams 功能配置
  - Claude Code 路由规则容器下方新增"Claude Code"配置容器
  - 新增"开启Agent Teams功能"开关
  - 开启后会设置 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1"` 环境变量
  - 路由已激活时，实时更新配置文件；路由未激活时，待激活时应用
  - 新增 Claude Code 版本检查，仅版本 ≥ 2.1.32 时支持 Agent Teams 功能
  - 版本不支持时自动禁用开关并显示警告提示
* 日志模块新增内容搜索功能
  - 请求日志支持通过内容关键词搜索（请求体、响应体、流式响应、错误信息、路径、模型名）
  - 错误日志支持通过内容关键词搜索（错误信息、错误堆栈、请求体、响应体、路径、模型名）
  - 新增搜索 API 端点：`/api/logs/search` 和 `/api/error-logs/search`
  - 前端日志页面添加搜索输入框，支持回车键触发搜索
* 新增 MCP 管理模块
  - 支持添加、编辑、删除 MCP 工具
  - 支持三种 MCP 类型：stdio、http、sse
  - 支持配置命令、URL、请求头、环境变量等参数
  - 支持为 Claude Code 和 Codex 分别启用 MCP
  - 新增一键安装 GLM MCP 工具（视觉理解、联网搜索、网页读取、开源仓库）
  - 一键安��弹层中自动标记已安装的 MCP 工具，防止重复安装
* MCP 配置自动同步
  - 激活路由时，自动将启用的 MCP 写入目标工具的全局配置文件
  - 仅在有激活路由且该目标有启用的 MCP 时才执行写入
* 图像理解路由规则支持 MCP
  - 为"图像理解"类型的路由规则新增"使用MCP"开关
  - 开启后可选择已配置的 MCP 工具处理图像理解请求
  - 后端自动提取图片并保存到临时文件，修改请求消息为本地路径引用
  - 消息中明确指示 Agent 使用指定的 MCP 工具处理图片
  - 提供 MCP 工具详细信息（名称、类型、说明）引导 Agent 主动调用
  - 支持自动清理临时图片文件
  - 规则列表中展示 MCP 工具信息
  - 新增详细的 MCP 诊断日志，帮助排查 MCP 未触发的原因
  - 日志包含规则配置检查、MCP 可用性验证、图片提取过程等详细信息
  - 所有诊断日志以 `[MCP-DIAG]` 前缀标记，便于在 server.log 中筛选
  - 新增降级机制：当 MCP 不可用时自动降级到默认图像处理逻辑
  - 降级条件包括：mcpId 缺失、MCP 未注册、图片处理失败
  - 确保请求不会因 MCP 问题而失败
* 数据库新增 mcps.json 文件存储 MCP 工具配置

### 3.3.2 (2026-02-15)

#### Fixes
* 在 upstream 请求头中添加 `content-length` 字段
  - 修改 `buildUpstreamHeaders` 方法，新增 `requestBody` 参数
  - 对于 POST/PUT/PATCH 请求，自动计算并设置 `content-length`
  - 确保 axios 发送请求和日志记录都包含正确的 content-length 信息

### 3.3.1 (2026-02-15)

#### Changes
* 移除前端的 `AuthType.AUTO` 选项
  - 从类型定义中移除 `AuthType.AUTO` 枚举值（已废弃，保留注释）
  - 从前端常量 `AUTH_TYPE` 和 `AUTH_TYPE_MESSAGE` 中移除 AUTO 相关配置
  - 前端默认认证方式改为 `AuthType.AUTH_TOKEN`
  - 后端保留对旧数据中 `'auto'` 字符串值的兼容性处理
* 新增智能认证方式选择
  - 选择 gemini 数据源时，自动将认证方式设置为 `GOOGLE_API_KEY`
  - 选择 claude-chat 或 claude-code 数据源时，自动将认证方式设置为 `API_KEY`
  - 选择其他数据源时，自动将认证方式设置为 `AUTH_TOKEN`
  - 编辑已有服务时也能正确处理认证方式的自动推导

### 3.3.0 (2026-02-12)

#### Features
* 重构数据导入/导出功能
  - 仅支持当前数据库格式（版本 3.0.0），移除对旧版本数据的兼容性支持
  - 添加严格的数据校验（供应商、服务、路由、规则的完整字段验证）
  - 导入前增加预览功能，显示数据概览（供应商数、服务数、路由数、规则数、导出时间）
  - 导入时需要用户确认后才能执行
  - 导入/导出 API 返回详细的错误信息（success, message, details）
  - 新增预览 API 端点 `POST /api/import/preview`
  - 更新 `ImportResult` 和 `ImportPreview` 类型定义

#### Breaking Changes
* 不再支持导入 3.0.0 版本之前导出的数据文件
* 导入 API 返回值格式从 `boolean` 改为 `ImportResult` 对象

### 3.2.0 (2026-02-12)

#### Features
* 新增 Gemini API 支持 - 可以将 Claude Code/Codex 的请求转换为 Gemini GenerateContent API
  - 新增 `src/server/transformers/gemini.ts` 转换器
  - 支持 Claude ↔ Gemini 双向转换（请求/响应）
  - 支持 OpenAI Chat ↔ Gemini 双向转换（请求/响应）
  - 支持流式响应转换（GeminiToClaudeEventTransform / GeminiToOpenAIChatEventTransform）
  - 支持图像内容转换（inlineData 格式）
  - 支持工具调用转换（functionCall ↔ tool_use/tool_calls）
  - 支持思考配置转换（thinking ↔ thinkingConfig）
  - 新增 `gemini` SourceType 类型
  - 更新 proxy-server.ts 支持 Gemini 流式/非流式转换
  - 更新 CLAUDE.md 文档说明 Gemini 转换功能

#### Changes
* 更新 API 转换功能说明，新增 Gemini API 转换

### 3.1.1 (2026-02-11)

#### Fixes
* 修复日志页弹层被侧栏遮挡、以及会话详情内的日志详情弹层层级错误的问题
* 请求日志补充记录规则内容类型，并修复内容类型统计分布缺失的问题


### 3.1.0 (2026-02-10)

#### Breaking Changes
* **数据库结构重构**：将供应商的 API 服务作为嵌套数组存储在 `vendors.json` 中，不再使用独立的 `services.json` 文件
  * 从 SQLite 迁移时自动将 services 嵌入到 vendors 中
  * 从旧的文件系统数据库迁移时自动将 services.json 合并到 vendors.json
  * 导出功能更新版本为 `2.0.0`，同时兼容旧格式导入
  * 前端代码适配新的数据结构，服务列表直接从供应商对象获取

#### Features
* 供应商删除时自动级联删除服务（无需手动维护关联）
* 获取供应商时直接包含服务列表，减少二次查询
* 数据导出/导入支持新旧两种格式自动检测
* SQLite 迁移脚本更新，支持新的嵌套数据结构

#### Fixes
* **重要修复**：修复后端异步路由缺少 await 的问题，导致创建供应商/服务/路由/规则时返回空对象
* 修复一键配置供应商后服务列表未显示的问题，完成配置后自动选中新建供应商
* 修复一键配置供应商时缺少 sortOrder 字段的问题
* 添加一键配置的详细日志输出和 vendorId 验证，便于调试服务创建失败问题

### 3.0.1 (2026-02-10)

#### Fixes
* 修复 main.ts 中数据库迁移功能的接入，改用 `DatabaseFactory.createAuto()` 自动检测并执行迁移
* 改进 database-factory.ts 使用静态导入替代动态导入，确保迁移功能正常工作
* restore 命令执行时同步停用所有激活的路由，直接修改数据库文件

#### Features
* 规则列表"类型"列添加图标（后台⚙、思考💭、长上下文📄、图像理解🖼、模型顶替🔄），默认类型不显示图标

#### BREAKING CHANGES

* 将基于sqlite和leveldb的数据库，迁移为json文件数据库，并且在升级版本后第一次启动时，自动迁移数据库文件

### 2.1.5 (2026-02-08)

### 2.1.4 (2026-02-07)

### 2.1.3 (2026-02-06)

### 2.1.2 (2026-02-04)

### 2.1.1 (2026-02-03)

### 2.0.11 (2026-02-03)

### 2.0.10 (2026-02-03)

### 2.0.9 (2026-02-02)

### 2.0.8 (2026-02-02)

### 2.0.7 (2026-02-02)

### 2.0.6 (2026-02-01)

### 2.0.5 (2026-01-27)

### 2.0.4 (2026-01-27)

### 2.0.3 (2026-01-27)

### 2.0.2 (2026-01-27)

### 2.0.1 (2026-01-27)

### 1.10.2 (2026-01-26)

### 1.10.1 (2026-01-25)

## [1.10.0](https://github.com/tangshuang/aicodeswitch/compare/v1.9.0...v1.10.0) (2026-01-25)


### Features

* 日志分页 ([0e68786](https://github.com/tangshuang/aicodeswitch/commit/0e68786b4e5bdce9bf7fc5ce85a1d4bdaf5a710c))
* 新增了代理能力 ([d6254ae](https://github.com/tangshuang/aicodeswitch/commit/d6254ae463f01f583601ed71f64f346b63718853))
* 优化细节 ([e4bdaef](https://github.com/tangshuang/aicodeswitch/commit/e4bdaef14bb0088e7feb5371490124c8dd169fdd))
* github workflows ([37dd371](https://github.com/tangshuang/aicodeswitch/commit/37dd3717e79dab1c4aec99b762774cc549f1efc8))
