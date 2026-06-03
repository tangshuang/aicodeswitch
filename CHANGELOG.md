# Changelog

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
