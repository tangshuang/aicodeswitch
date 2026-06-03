# PRD: 路由激活交互重构（Route Activation UX Refactor）

**文档版本:** 3.0  
**创建日期:** 2026-06-03  
**更新日期:** 2026-06-04  
**状态:** Implemented  
**前置依赖:** `route-path-binding.md`（API 路径路由映射）

---

## 1. 背景与动机

当前系统的路由激活模型存在以下问题：

- **路由列表中的激活/停用按钮** 将"路由配置"与"客户端工具绑定"两个概念混在一起，用户在路由列表中同时管理路由规则和工具激活状态，认知负担重。
- **`Route.targetType` 和 `Route.isActive`** 这两个字段让 Route 承担了不属于它的职责。Route 本质上是一个"规则集合"，而"哪个工具用哪条路由"是一个独立的绑定关系，应该有自己的存储空间。
- **后端匹配逻辑绕弯：** `/claude-code/` 请求进来后，后端要遍历所有 Route，按 `targetType === 'claude-code'` 筛选，再取 `isActive === true` 的那一条。如果用独立存储直接记录 "claude-code → routeId"，查找就是 O(1)。

本次改动目标：

1. 新建独立存储 `tool-bindings.json`，记录每个工具当前激活的路由 ID。
2. 从 `Route` 类型中移除 `targetType` 和 `isActive` 字段，让路由回归纯粹的"规则集合"。
3. 将激活操作从路由列表移至各工具的全局配置区域。
4. 后端代理直接从 `tool-bindings` 读取激活路由，不再遍历 Route 列表。

---

## 2. 交互模式变更概览

| 变更项 | 当前行为 | 改造后 |
|--------|---------|--------|
| 新建/编辑路由弹窗 | 包含"客户端工具"下拉框 | 移除"客户端工具"字段 |
| 路由列表项 | 显示"客户端工具: xxx"文字 | 移除该文字 |
| 路由列表项 | 包含"激活"/"停用"按钮 | 移除这两个按钮 |
| 路由列表项 | 激活状态角标 "[工具名] 已激活" | 移除角标 |
| Claude Code 全局配置区域 | 无路由选择功能 | 新增路由选择下拉框 + 激活/停用按钮 |
| Codex 全局配置区域 | 无路由选择功能 | 新增路由选择下拉框 + 激活/停用按钮 |
| 激活数据存储 | `Route.isActive` + `Route.targetType` | 独立文件 `tool-bindings.json` |
| 后端路由查找 | 遍历 `Route[]` 按 `targetType` + `isActive` 匹配 | 从 `tool-bindings` 直接读取 `routeId` |

---

## 3. 数据模型变更

### 3.1 新增 `ToolBindings` 类型和存储

**新增类型：**

```typescript
// src/types/index.ts

/** 工具类型（与路由解耦后的独立枚举） */
export type ToolName = 'claude-code' | 'codex';

/** 单个工具的激活配置 */
export interface ToolBinding {
  tool: ToolName;
  routeId: string | null;    // null = 未激活
}

/** 所有工具的激活配置集合 */
export type ToolBindings = Record<ToolName, ToolBinding>;
```

**新增存储文件：** `~/.aicodeswitch/fs-db/tool-bindings.json`

```json
{
  "claude-code": {
    "tool": "claude-code",
    "routeId": "route-abc123"
  },
  "codex": {
    "tool": "codex",
    "routeId": null
  }
}
```

**设计意图：**

- 这是完全独立的存储空间，不挂在 `AppConfig` 上，不嵌入 `routes.json`。
- 语义明确：`tool-bindings.json` 回答"每个工具当前使用哪条路由"这个问题。
- 读取 O(1)：`toolBindings['claude-code'].routeId`，无需遍历任何列表。
- 每个工具独立维护，允许两个工具指向同一条路由。

### 3.2 从 `Route` 类型中移除 `targetType` 和 `isActive`

**变更前：**

```typescript
export interface Route {
  id: string;
  name: string;
  description?: string;
  targetType: ToolType;      // ← 移除
  isActive: boolean;          // ← 移除
  createdAt: number;
  updatedAt: number;
}
```

**变更后：**

```typescript
export interface Route {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
}
```

Route 不再关心"我是给哪个工具用的"和"我是不是激活的"。这两个概念完全由 `tool-bindings.json` 承担。

### 3.3 清理 `AppConfig` 中的相关类型

`ToolType` 和 `TargetType` 类型保留（API 路径路由映射等仍可能用到），但不再作为 Route 的字段类型。后端在使用 `ToolName` 替代时，可复用 `ToolType` 类型或定义新别名。

---

## 4. 详细功能需求

### 4.1 移除路由表单中的"客户端工具"字段

- 删除新建/编辑路由弹窗中的 `targetType` 下拉选择器。
- `handleSaveRoute` 不再提交 `targetType` 和 `isActive` 字段。
- 路由创建时的数据结构仅需 `name`、`description`。

### 4.2 移除路由列表项中的激活/停用相关 UI

- 删除"激活"和"停用"按钮。
- 删除激活状态角标。
- 删除"客户端工具: xxx"展示文字。
- 保留"编辑"和"删除"按钮。
- 路由列表排序改为按创建时间倒序。

### 4.3 Claude Code 全局配置区域：新增路由选择与激活

在卡片顶部添加"路由选择"区域：

```
┌──────────────────────────────────────────────────────┐
│  Claude Code 全局配置                                  │
│                                                        │
│  ┌──────────────────────────────────────────────────┐ │
│  │ 激活路由                                          │ │
│  │                                                    │ │
│  │ [▼ 选择要激活的路由...                         ] │ │
│  │                                                    │ │
│  │ [激活]  [停用]                                     │ │
│  └──────────────────────────────────────────────────┘ │
│                                                        │
│  --- 现有配置项 ---                                     │
│  Agent Teams ...                                       │
│  ...                                                   │
└──────────────────────────────────────────────────────┘
```

**交互细节：**

1. 下拉列表显示 **所有路由**（不限 targetType，因为路由已不绑定工具类型）。
2. 从 `tool-bindings` 中读取 `claude-code` 的 `routeId`，下拉框默认选中该路由（如有），路由名后显示"(已激活)"。
3. 未激活时，下拉框显示占位文本"选择要激活的路由..."。
4. **激活操作：** 调用 `POST /api/tool-bindings/activate`，参数 `{ tool: 'claude-code', routeId: 'xxx' }`。
5. **停用操作：** 调用 `POST /api/tool-bindings/deactivate`，参数 `{ tool: 'claude-code' }`。
6. 操作完成后刷新 `tool-bindings` 和路由列表状态。

### 4.4 Codex 全局配置区域：新增路由选择与激活

与 Claude Code 区域完全对称，参数中 `tool` 为 `'codex'`。

### 4.5 删除路由时的保护

删除路由前检查 `tool-bindings`：如果该路由 ID 被任一工具激活，提示用户"该路由当前被 [工具名] 使用中，请先停用后再删除"并阻止删除。

### 4.6 "配置文件自动管理" 说明区域更新

更新说明文字，提及激活/停用路由的操作已移至各工具全局配置区域。

---

## 5. 后端改动

### 5.1 新增存储层：`tool-bindings.json`

在 `fs-database.ts` 中新增：

```
文件路径: this.toolBindingsFile = path.join(this.dataPath, 'tool-bindings.json')
内存变量: private toolBindings: ToolBindings
加载: loadToolBindings() — 初始化时调用
保存: saveToolBindings()
读取: getToolBindings(): ToolBindings
```

**默认值（首次创建）：**

```typescript
const DEFAULT_TOOL_BINDINGS: ToolBindings = {
  'claude-code': { tool: 'claude-code', routeId: null },
  'codex': { tool: 'codex', routeId: null },
};
```

### 5.2 新增 API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/tool-bindings` | 获取当前所有工具绑定 |
| POST | `/api/tool-bindings/activate` | 激活指定工具的路由 |
| POST | `/api/tool-bindings/deactivate` | 停用指定工具的路由 |

**`POST /api/tool-bindings/activate` 请求体：**

```typescript
{
  tool: ToolName;    // 'claude-code' | 'codex'
  routeId: string;   // 要激活的路由 ID
}
```

后端逻辑：

```
1. 验证 routeId 对应的 Route 存在
2. 更新 toolBindings[tool].routeId = routeId
3. 保存 tool-bindings.json
4. proxyServer.reloadRoutes()
5. 同步 MCP 配置（如果该工具有关联 MCP）
```

**`POST /api/tool-bindings/deactivate` 请求体：**

```typescript
{
  tool: ToolName;
}
```

后端逻辑：

```
1. 清空 toolBindings[tool].routeId = null
2. 保存 tool-bindings.json
3. proxyServer.reloadRoutes()
```

### 5.3 代理请求路由查找逻辑改造

**改造前（`proxy-server.ts`）：**

```typescript
// 遍历所有 Route，按 targetType + isActive 匹配
private findMatchingRoute(req: Request): Route | undefined {
  let targetType = req.path.startsWith('/claude-code/') ? 'claude-code' : 'codex';
  const activeRoutes = this.getActiveRoutes(); // filter(isActive)
  return activeRoutes.find(route => route.targetType === targetType && route.isActive);
}
```

**改造后：**

```typescript
private findMatchingRoute(req: Request): Route | undefined {
  const toolBindings = this.dbManager.getToolBindings();
  let routeId: string | null | undefined;

  if (req.path.startsWith('/claude-code/')) {
    routeId = toolBindings['claude-code']?.routeId;
  } else if (req.path.startsWith('/codex/')) {
    routeId = toolBindings['codex']?.routeId;
  }

  if (!routeId) return undefined;
  return this.dbManager.getRoute(routeId);
}
```

**同理改造 `findRouteByTargetType`：**

```typescript
private findRouteByTargetType(tool: ToolName): Route | undefined {
  const toolBindings = this.dbManager.getToolBindings();
  const routeId = toolBindings[tool]?.routeId;
  if (!routeId) return undefined;
  return this.dbManager.getRoute(routeId);
}
```

### 5.4 `proxyRequest` 中的 `targetType` 引用处理

`proxyRequest` 内部约 20 处使用 `route.targetType`（compact 清理、路径裁剪、格式判断等）。Route 不再有 `targetType` 字段后，这些地方需要改为从**请求路径**推断工具类型：

```typescript
// 改造前
const targetType = route.targetType;

// 改造后：从请求路径推断
private inferToolFromPath(reqPath: string): ToolName {
  if (reqPath.startsWith('/claude-code')) return 'claude-code';
  if (reqPath.startsWith('/codex')) return 'codex';
  return 'claude-code'; // fallback
}

const tool = this.inferToolFromPath(req.path);
```

`proxyRequest` 方法签名中需要新增 `tool: ToolName` 参数（或从 `req` 中推断），所有原来读取 `route.targetType` 的地方改为使用传入的 `tool`。

**影响清单（`proxy-server.ts` 中所有 `route.targetType` 引用）：**

- `prepareHighIqRouting(req, route, route.targetType)` → `prepareHighIqRouting(req, route, tool)`
- `this.determineContentType(req, route?.targetType || 'claude-code', routeId)` → `this.determineContentType(req, tool, routeId)`
- `targetType === 'claude-code'` 判断（compact 清理）→ `tool === 'claude-code'`
- `targetType === 'codex'` 判断（格式转换）→ `tool === 'codex'`
- `route.targetType === 'claude-code' && req.path.startsWith('/claude-code')` 路径裁剪 → 简化为 `tool === 'claude-code'`
- 日志中的 `targetType` 字段 → 改用 `tool`

### 5.5 `reloadRoutes` 方法

不再按 `isActive` 过滤路由。所有路由的规则都可能被 `apiPathBindings` 或 `tool-bindings` 使用：

```typescript
async reloadRoutes() {
  const allRoutes = this.dbManager.getRoutes();
  const allServices = this.dbManager.getAPIServices();

  this.routes! = allRoutes;
  // rules 和 services 缓存逻辑不变

  console.log(`Initialized with ${allRoutes.length} routes and ${allServices.length} services`);
}
```

### 5.6 `apiPathBindings` 兼容性

`apiPathBindings` 中查找路由时移除 `isActive` 检查：

```typescript
// 改造前
const route = allRoutes.find((r: Route) => r.id === binding.routeId && r.isActive);

// 改造后
const route = allRoutes.find((r: Route) => r.id === binding.routeId);
```

绑定关系本身就表示该路径由该路由服务。

### 5.7 删除旧 API

移除以下旧端点：

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/routes/:id/activate` | 删除 |
| POST | `/api/routes/:id/deactivate` | 删除 |
| POST | `/api/routes/deactivate-all` | 改为清空 `tool-bindings` |

在 `fs-database.ts` 中移除以下方法：

- `activateRoute(id: string)`
- `deactivateRoute(id: string)`
- `deactivateAllRoutes()`

新增方法：

- `getRoute(id: string): Route | undefined` — 按 ID 获取单条路由（`getRule` 已有类似实现）

### 5.8 `handleFallbackToOriginalConfig` 改造

该方法目前从请求路径推断 `targetType` 然后查找原始配置。改造后不再需要 `targetType`，改为从请求路径直接推断 `tool`，其余逻辑不变。

---

## 6. 前端 API Client 改动

**`src/ui/api/client.ts` 新增：**

```typescript
getToolBindings: () => requestJson(buildUrl('/api/tool-bindings')),
activateToolRoute: (tool: ToolName, routeId: string) =>
  requestJson(buildUrl('/api/tool-bindings/activate'), {
    method: 'POST',
    body: JSON.stringify({ tool, routeId }),
  }),
deactivateToolRoute: (tool: ToolName) =>
  requestJson(buildUrl('/api/tool-bindings/deactivate'), {
    method: 'POST',
    body: JSON.stringify({ tool }),
  }),
```

**移除：**

```typescript
activateRoute: (id: string) => ...
deactivateRoute: (id: string) => ...
```

---

## 7. 不在范围内

以下内容本次不实施：

- 修改写入配置文件（`write-config`）的核心逻辑。
- 修改规则（Rule）相关的任何功能。
- 修改格式转换（transformers）逻辑。
- 修改 API 路径路由映射（`apiPathBindings`）的功能设计（仅移除 `isActive` 检查）。

---

## 8. UI 改动对照

### 8.1 路由列表 - 变更后

```
┌─────────────────────────────────────┐
│  我的路由                              │
│  [编辑] [删除]                          │
└─────────────────────────────────────┘
```

（无激活按钮、无角标、无"客户端工具"文字）

### 8.2 Claude Code 全局配置 - 变更后

```
Claude Code 全局配置
─────────────────────
┌─────────────────────────────────────┐
│ 激活路由                              │
│ [▼ 我的路由 (已激活)               ] │
│                      [停用]           │
└─────────────────────────────────────┘

☑ Agent Teams
☑ bypassPermissions
Effort Level: [Medium ▼]
默认模型: [claude-sonnet-4... ]
Autocompact PCT: [80]
```

### 8.3 新建路由弹窗 - 变更后

```
新建路由
─────────
路由名称: [          ]
描述:     [          ]

[取消] [保存]
```

---

## 9. 实施步骤

### Phase 1: 后端数据层

1. 新增 `ToolBindings`、`ToolName` 类型到 `src/types/index.ts`。
2. 从 `Route` 类型中移除 `targetType` 和 `isActive`。
3. 在 `fs-database.ts` 中新增 `tool-bindings.json` 的加载、保存、读取逻辑。
4. 新增 `getRoute(id: string)` 方法。
5. 移除 `activateRoute`、`deactivateRoute`、`deactivateAllRoutes` 方法。

### Phase 2: 后端 API

6. 新增 `GET /api/tool-bindings`、`POST /api/tool-bindings/activate`、`POST /api/tool-bindings/deactivate`。
7. 移除 `POST /api/routes/:id/activate`、`POST /api/routes/:id/deactivate`。
8. 改造 `POST /api/routes/deactivate-all` 为清空 tool-bindings。
9. 删除路由时增加 tool-bindings 保护检查。

### Phase 3: 后端代理逻辑

10. 改造 `findMatchingRoute`：从 tool-bindings 直接读取。
11. 改造 `findRouteByTargetType`：同上。
12. 改造 `proxyRequest`：`route.targetType` 替换为从请求路径推断的 `tool`。
13. 改造 `handleFallbackToOriginalConfig`：移除 `targetType` 依赖。
14. 改造 `apiPathBindings` 路由查找：移除 `isActive` 检查。
15. 改造 `reloadRoutes`：移除 `isActive` 过滤。
16. 全量搜索 `route.targetType` 和 `route.isActive` 的引用并逐一清理。

### Phase 4: 前端

17. 移除路由表单中的 `targetType` 选择器。
18. 移除路由列表中的激活/停用按钮和角标。
19. 路由列表排序改为创建时间倒序。
20. Claude Code 全局配置区域新增路由选择 + 激活/停用。
21. Codex 全局配置区域新增路由选择 + 激活/停用。
22. 删除路由时增加激活保护。
23. 更新 API Client（新增 tool-bindings API，移除旧 activate/deactivate）。
24. 更新"配置文件自动管理"说明文字。

### Phase 5: 测试与文档

25. 验证新建路由仅需名称和描述。
26. 验证全局配置区域激活/停用路由正常。
27. 验证激活后 `/claude-code/` 和 `/codex/` 代理请求正常。
28. 验证 compact 请求处理正常。
29. 验证 `apiPathBindings` 功能不受影响。
30. 验证写入配置文件（write-config）在激活/停用时正常触发。
31. 更新 `AGENTS.md` 和 `CHANGELOG.md`。

---

## 10. 迁移策略

### 10.1 已有用户数据迁移

升级后首次启动时，后端执行一次性迁移（在 `initialize()` 中）：

```
1. 读取旧 routes.json 中的 Route 数据
2. 找到 isActive=true 且 targetType='claude-code' 的路由 → 写入 tool-bindings['claude-code'].routeId
3. 找到 isActive=true 且 targetType='codex' 的路由 → 写入 tool-bindings['codex'].routeId
4. 创建 tool-bindings.json
5. 从所有 Route 对象中移除 targetType 和 isActive 字段
6. 保存 routes.json（不含这两个字段）
```

### 10.2 无降级兼容

旧版前端/外部工具调用旧 `POST /api/routes/:id/activate` 端点会收到 404。这是有意为之——本次重构不含过渡期兼容。

---

## 11. 风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| `proxyRequest` 中约 20 处 `route.targetType` 需逐一替换 | 中 | 全量搜索替换，每处确认语义正确 |
| `write-config` 时机依赖路由激活状态 | 中 | `write-config` 触发改为监听 tool-bindings 变更而非 Route.isActive |
| 用户找不到激活入口 | 中 | 路由列表顶部添加引导提示 |
| 同一路由被两个工具同时激活 | 无 | 新架构天然支持共享，`tool-bindings` 中两个工具各自维护 routeId |
| 删除路由时忘记检查 tool-bindings | 低 | API 层面强制校验 |

---

## 12. 未来展望

- **路由标签/分组：** 为路由增加自由标签系统，替代 `targetType` 的分类功能。
- **配置区域独立页面：** 当全局配置项越来越多时，可将各工具的配置拆分为独立页面。
- **`ToolName` 扩展：** 新增工具时只需在 `tool-bindings.json` 中增加一条记录，无需修改 Route 类型。
