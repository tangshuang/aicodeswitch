# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

### 3.4.0 (2026-02-16)

#### Features
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
