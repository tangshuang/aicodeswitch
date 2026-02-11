# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

### 3.0.3 (2026-02-11)

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
