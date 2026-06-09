# PRD: 会话路由绑定（Session Route Binding）

**文档版本:** 1.0  
**创建日期:** 2026-06-09  
**最后更新:** 2026-06-09  
**状态:** Draft

---

## 1. 背景与动机

当前 AICodeSwitch 的路由选择机制是**全局工具级别**的：通过 `ToolBindings`（`tool-bindings.json`）将 Claude Code 或 Codex 工具绑定到一个路由，该工具的所有会话都使用同一个路由的规则进行代理。

这种设计在以下场景中存在不足：

- **差异化路由需求**：用户希望不同的会话使用不同的路由策略（如：一个会话用高智商模型做架构设计，另一个会话用默认模型做日常编码），但当前只能全局切换路由，影响所有会话。
- **特定会话专用服务**：某个会话需要使用特定的上游 API 服务（如长上下文模型、特定供应商），需要通过绑定到不同路由来实现。
- **路由灵活切换**：用户希望在会话级别自由指定路由，而不影响其他正在进行的会话。

**目标：** 为会话添加路由绑定能力，允许用户在会话管理界面将指定会话绑定到特定路由。绑定后，该会话的所有后续请求将使用绑定的路由进行代理，而非全局工具级别的路由。

---

## 2. 用户场景

### 场景一：会话级差异化路由

用户同时运行多个 Claude Code 会话，其中一个进行复杂架构设计需要高智商模型，另一个做日常编码使用默认模型。用户在会话管理界面将架构设计会话绑定到配置了高智商规则的路由，其他会话继续使用全局默认路由。

### 场景二：特定会话使用专用服务

用户有一个处理长文档的会话，需要使用长上下文模型。用户创建一个专门配置了长上下文服务的路由，然后将该会话绑定到这个路由。

### 场景三：临时切换路由

用户想临时让某个会话使用另一个路由的规则进行测试。在会话管理界面点击"路由"按钮，选择目标路由即可，测试完成后可以解绑恢复使用全局路由。

### 场景四：查看路由绑定关系

用户在路由管理界面，可以直观看到每个路由被多少个会话绑定，点击可以展开查看具体的会话列表，了解路由的使用情况。

---

## 3. 核心概念

### 3.1 会话路由绑定

一个**会话路由绑定**就是一条关系："哪个会话使用哪个路由的规则进行代理"。

```
会话 A (claude-code)  →  路由 X（高智商路由）
会话 B (claude-code)  →  未绑定（使用全局 ToolBindings）
会话 C (codex)        →  路由 Y（长上下文路由）
```

### 3.2 路由选择优先级

当请求到达代理服务器时，路由选择遵循以下优先级：

```
1. 会话级绑定（Session.routeId）    ← 最高优先级
2. 全局工具绑定（ToolBindings）     ← 默认行为
3. Fallback 到原始配置               ← 兜底
```

### 3.3 绑定关系存储

绑定关系直接存储在 `Session` 对象的 `routeId` 字段中，不需要额外的存储文件。

---

## 4. 功能需求

### 4.1 会话管理界面

#### FR-1.1 路由绑定按钮

在会话列表每行的操作栏中，"迁移"按钮右侧新增"路由"按钮：

```
┌──────────────────────────────────────────────────────────┐
│ 操作                                                     │
├──────────────────────────────────────────────────────────┤
│ [查看] [对话] [迁移] [路由]                               │
└──────────────────────────────────────────────────────────┘
```

- 按钮样式：`backgroundColor: '#2980b9', color: 'white'`（蓝色系，与迁移按钮的紫色区分）
- 已绑定路由的会话，按钮文字显示为当前绑定的路由名称（截断显示，最多 8 个字符）
- 未绑定路由的会话，按钮文字显示"路由"
- 点击按钮打开路由绑定弹窗（FR-1.2）

#### FR-1.2 路由绑定弹窗

点击"路由"按钮后，弹出路由选择弹窗：

```
┌─────────────────────────────────────────┐
│ 路由绑定                           [×]  │
├─────────────────────────────────────────┤
│                                         │
│ 会话：[会话标题]                         │
│ 客户端：Claude Code                      │
│                                         │
│ 当前绑定：[路由A] ✕                      │
│                                         │
│ ── 选择路由 ──                           │
│                                         │
│ ┌───────────────────────────────────┐   │
│ │ ○ 路由A - 高智商模型路由          │   │
│ │   规则数: 5                       │   │
│ ├───────────────────────────────────┤   │
│ │ ○ 路由B - 默认路由                │   │
│ │   规则数: 3                       │   │
│ ├───────────────────────────────────┤   │
│ │ ○ 路由C - 长上下文路由            │   │
│ │   规则数: 2                       │   │
│ └───────────────────────────────────┘   │
│                                         │
│        [解绑]  [取消]  [确认绑定]        │
│                                         │
└─────────────────────────────────────────┘
```

**交互逻辑：**
- 弹窗加载时，列出所有可用路由（`GET /api/routes`）
- 每个路由显示名称、描述、规则数量
- 当前绑定的路由高亮显示，且顶部有"当前绑定"标签
- 单选模式：一次只能绑定一个路由
- 点击"确认绑定"：调用绑定 API，成功后关闭弹窗，刷新会话列表
- 点击"解绑"：调用解绑 API，移除绑定关系，成功后关闭弹窗
- 点击"取消"或右上角 ×：关闭弹窗

### 4.2 路由管理界面

#### FR-2.1 路由卡片绑定数量展示

在路由列表的每个路由卡片右上角，展示已绑定的会话数量：

```
┌──────────────────────────────────┐
│ 路由A                📎 3 个会话  │
│ 高智商模型路由                    │
│                                  │
│ [编辑] [删除]                    │
└──────────────────────────────────┘
```

- 无绑定时：不显示数量标签
- 有绑定时：显示 `📎 N 个会话`（N 为绑定到该路由的会话总数）
- 标签为可点击元素，点击后展开显示绑定会话列表

#### FR-2.2 绑定会话弹窗查看

点击路由卡片上的会话数量标签，弹出 Modal 展示绑定到该路由的会话列表：

```
┌─────────────────────────────────────────┐
│ 绑定会话 - 路由A                   [×]  │
├─────────────────────────────────────────┤
│                                         │
│ 以下 3 个会话绑定了此路由：              │
│                                         │
│ ┌─────────────────────────────────────┐ │
│ │ 架构设计讨论                         │ │
│ │ Claude Code · 15 次请求 · 50k tokens│ │
│ ├─────────────────────────────────────┤ │
│ │ Bug排查记录                          │ │
│ │ Claude Code · 8 次请求 · 20k tokens │ │
│ ├─────────────────────────────────────┤ │
│ │ API重构计划                          │ │
│ │ Claude Code · 22 次请求 · 80k tokens│ │
│ └─────────────────────────────────────┘ │
│                                         │
│                          [关闭]         │
└─────────────────────────────────────────┘
```

**交互逻辑：**
- 点击路由卡片上的 `📎 N 个会话` 标签，打开 Modal
- Modal 标题为"绑定会话 - {路由名称}"
- 列表中每个会话显示：标题、客户端类型 Badge、请求数、Token 使用量
- 会话按最后请求时间降序排列
- 最多显示 50 个会话，超出部分底部显示"等共 N 个会话"
- 点击右上角 × 或底部"关闭"按钮关闭 Modal
- 关闭后自动释放数据

### 4.3 代理路由选择

#### FR-3.1 会话级路由覆盖

代理请求到达时，路由选择逻辑调整为：

```
1. 从请求中提取 sessionId
2. 若 sessionId 存在：
   a. 查询 Session，检查是否有 routeId 绑定
   b. 若有绑定且路由存在 → 使用绑定路由
   c. 若绑定路由已被删除 → 清除绑定，回退到全局绑定
3. 若无绑定或无 sessionId：
   a. 查询 ToolBindings 获取全局路由
4. 若全局路由也无 → Fallback 到原始配置
```

此逻辑同时适用于：
- `/claude-code/*` 和 `/codex/*` 路径（原有工具路径）
- 标准 API 路径（`/v1/messages`, `/v1/responses` 等）

#### FR-3.2 绑定路由的状态检查

使用绑定路由时，不检查该路由是否在 ToolBindings 中被"激活"——会话级绑定独立于全局激活状态。即使路由未在全局被激活，只要会话绑定了它，就使用它。

---

## 5. 数据模型

### 5.1 Session 类型扩展

在现有 `Session` 接口（`src/types/index.ts`）中新增一个可选字段：

```typescript
export interface Session {
  id: string;
  targetType: ToolType;
  title?: string;
  firstRequestAt: number;
  lastRequestAt: number;
  requestCount: number;
  totalTokens: number;
  vendorId?: string;
  vendorName?: string;
  serviceId?: string;
  serviceName?: string;
  model?: string;
  highIqMode?: boolean;
  highIqRuleId?: string;
  highIqEnabledAt?: number;
  routeId?: string;          // 🆕 绑定的路由 ID（可选，未绑定为 undefined）
  routeName?: string;        // 🆕 绑定的路由名称（冗余字段，用于 UI 快速显示）
}
```

**设计说明：**
- `routeId`：绑定的路由 ID，可选字段。`undefined` 或不存在表示未绑定。
- `routeName`：冗余存储路由名称，避免 UI 列表展示时需要额外查询路由表。在绑定/解绑时同步更新。
- 无需新建存储文件，绑定关系直接存储在 `sessions.json` 中。

### 5.2 数据迁移

由于 `routeId` 和 `routeName` 均为可选字段，旧数据不存在这两个字段时视为"未绑定"，**无需数据迁移**。

---

## 6. API 设计

### 6.1 会话路由绑定

**绑定路由：**
```
PUT /api/sessions/:id/bind-route
```

请求体：
```json
{
  "routeId": "route-abc123"
}
```

成功响应：
```json
{
  "success": true,
  "session": {
    "id": "session-xxx",
    "routeId": "route-abc123",
    "routeName": "高智商路由"
  }
}
```

错误响应：
```json
{
  "success": false,
  "error": "Route not found"
}
```

**校验逻辑：**
- 检查 session 是否存在（404）
- 检查 route 是否存在（400）
- 更新 session 的 `routeId` 和 `routeName`
- 返回更新后的 session

### 6.2 会话路由解绑

**解绑路由：**
```
DELETE /api/sessions/:id/bind-route
```

成功响应：
```json
{
  "success": true
}
```

**逻辑：**
- 检查 session 是否存在（404）
- 将 `routeId` 和 `routeName` 置为 `undefined`
- 返回成功

### 6.3 路由绑定会话查询

**查询路由下的绑定会话：**
```
GET /api/routes/:id/bound-sessions
```

成功响应：
```json
{
  "routeId": "route-abc123",
  "sessions": [
    {
      "id": "session-xxx",
      "title": "架构设计讨论",
      "targetType": "claude-code",
      "requestCount": 15,
      "totalTokens": 50000,
      "lastRequestAt": 1717912345678
    }
  ]
}
```

**说明：**
- 返回所有 `routeId` 等于指定路由 ID 的会话摘要信息
- 按最后请求时间降序排列

### 6.4 会话列表增强

现有 `GET /api/sessions` 返回的 Session 对象已包含 `routeId` 和 `routeName`（新增字段），无需修改接口签名。

---

## 7. 技术方案

### 7.1 数据库层（`src/server/fs-database.ts`）

#### 7.1.1 新增方法

```typescript
/**
 * 绑定会话到路由
 */
async bindSessionRoute(sessionId: string, routeId: string): Promise<boolean>

/**
 * 解绑会话路由
 */
async unbindSessionRoute(sessionId: string): Promise<boolean>

/**
 * 获取绑定到指定路由的所有会话
 */
getBoundSessions(routeId: string): Session[]
```

#### 7.1.2 现有方法修改

**`upsertSession()`**：需要处理 `routeId`/`routeName` 字段的保留逻辑——当 session 已存在且有 `routeId` 时，`upsertSession` 不应覆盖已有的绑定关系（除非显式传入新的 `routeId`）。

**`updateSession()`**：在 `updates` 参数类型中新增 `routeId?` 和 `routeName?` 字段。

**`deleteRoute()`**：删除路由时，需要级联清除所有绑定到该路由的 session 的 `routeId`/`routeName`。

### 7.2 代理层（`src/server/proxy-server.ts`）

#### 7.2.1 路由选择逻辑修改

**影响的方法：**

| 方法 | 修改内容 |
|---|---|
| `findMatchingRoute()` (line 970) | 新增会话级路由查找逻辑：先提取 sessionId，查 Session 的 routeId，优先使用 |
| 标准 API 路径中间件 (line 277) | 在查找 apiPath binding 之后，增加会话级路由覆盖逻辑 |
| `handleApiPathProxyRequest()` (line 4256) | 支持传入会话级覆盖路由 |

**伪代码（`findMatchingRoute` 改造）：**

```
findMatchingRoute(req):
  1. 从 req 中推断 tool
  2. 从 req 中提取 sessionId
  3. if sessionId:
     a. session = getSession(sessionId)
     b. if session?.routeId:
        - route = getRoute(session.routeId)
        - if route 存在:
          → 返回 route（会话级绑定优先）
        - else:
          → 路由已被删除，清除 session.routeId
          → 继续走全局绑定
  4. 走原有逻辑：getActiveRouteIdForTool(tool)
```

#### 7.2.2 Session ID 提取时机

当前 Session ID 在 `proxyRequest()` 方法内部提取（line 3486 区域）。为了让路由选择逻辑能提前获取 Session ID，需要在 `findMatchingRoute()` 调用之前就提取。

由于提取逻辑已存在（`defaultExtractSessionId()`），只需要将提取时机提前到路由选择之前即可。对于标准 API 路径，需要从请求体中提取（Claude 格式从 `metadata.user_id`，OpenAI 格式从自定义 header 或 body 中推断）。

### 7.3 API 层（`src/server/main.ts`）

在 Sessions API 区域（line 2325 附近）新增 3 个端点：

```typescript
app.put('/api/sessions/:id/bind-route', ...)
app.delete('/api/sessions/:id/bind-route', ...)
app.get('/api/routes/:id/bound-sessions', ...)
```

### 7.4 前端 UI

#### 7.4.1 新增组件：`SessionRouteBindingModal`

文件：`src/ui/components/SessionRouteBindingModal.tsx`

Props：
```typescript
interface SessionRouteBindingModalProps {
  session: Session | null;
  onClose: () => void;
  onBound: () => void;  // 绑定成功后的回调（刷新列表）
}
```

功能：
- 加载所有路由列表
- 显示当前绑定状态
- 单选路由列表
- 绑定/解绑操作

#### 7.4.2 修改：`SessionsPage.tsx`

- 在操作栏"迁移"按钮后新增"路由"按钮
- 新增 `routeBindingSession` state
- 按钮根据绑定状态显示不同内容

#### 7.4.3 修改：`RoutesPage.tsx`

- 路由卡片新增会话绑定数量展示
- 可展开/收起的绑定会话列表
- 需要在路由列表加载时一并查询各路由的绑定会话数

#### 7.4.4 API Client（`src/ui/api/client.ts`）

新增方法：
```typescript
bindSessionRoute(sessionId: string, routeId: string): Promise<any>
unbindSessionRoute(sessionId: string): Promise<any>
getBoundSessions(routeId: string): Promise<any>
```

---

## 8. 边界情况与异常处理

### 8.1 路由被删除

**场景：** 会话绑定的路由被用户删除。

**处理：**
- `deleteRoute()` 方法中增加级联清理逻辑
- 遍历所有 session，将 `routeId` 匹配的 session 的 `routeId`/`routeName` 置为 `undefined`
- 清理后保存 sessions
- 代理请求到达时，发现 `routeId` 指向的路由不存在，自动清除绑定并回退到全局路由

### 8.2 路由未被全局激活

**场景：** 会话绑定的路由未在 ToolBindings 中被全局激活。

**处理：**
- 会话级绑定**不依赖**全局激活状态
- 即使路由未在全局激活，只要会话绑定了它，就使用它
- 这允许用户为特定会话使用"未激活"的路由

### 8.3 会话被删除

**场景：** 绑定了路由的会话被删除。

**处理：**
- 无需额外处理，session 删除后绑定关系自然消失
- 路由管理界面的绑定计数会在下次刷新时自动更新

### 8.4 全部会话清除

**场景：** 用户执行"清除所有会话"。

**处理：**
- 所有绑定关系随会话一起清除
- 无需额外清理

### 8.5 路由为空（无任何路由）

**场景：** 用户没有创建任何路由时点击"路由"按钮。

**处理：**
- 弹窗显示"暂无可用路由，请先创建路由"
- 提供"前往创建"链接（跳转到路由管理页面）

### 8.6 跨 targetType 绑定

**场景：** Claude Code 的会话绑定到一个主要配置 Codex 服务的路由，或反之。

**处理：**
- 允许跨类型绑定，不强制校验 targetType 一致性
- 路由本身不携带 targetType（已迁移到 ToolBindings），规则中的服务才是真正的执行单元
- 代理时会根据请求的 clientFormat 和服务的 sourceType 自动进行格式转换

---

## 9. 前端 UI 详细设计

### 9.1 会话管理页 - 路由按钮样式

未绑定时：
```css
{
  backgroundColor: '#2980b9',
  color: 'white',
  border: 'none'
}
```
显示文字："路由"

已绑定时：
```css
{
  backgroundColor: '#27ae60',
  color: 'white',
  border: 'none'
}
```
显示文字：路由名称（截断到 8 字符），如 "高智商路由" → "高智商路由"，超长则 "超长路由名..."

### 9.2 路由管理页 - 卡片增强

路由卡片区域新增绑定会话数量标签，点击后通过 Modal 展示绑定会话列表：

**卡片布局：**

```
┌─────────────────────────────────────────┐
│ [路由名称]              📎 3 个会话     │
│ [路由描述]              （可点击）       │
│                                          │
│ [编辑] [删除]                            │
└─────────────────────────────────────────┘
```

- 会话数量标签仅在 N > 0 时显示
- 标签为灰色小字体（`var(--text-route-muted)`），定位在卡片右上角，不干扰主要信息
- 标签为可点击元素，cursor: pointer，hover 时变色提示

**点击后弹出 Modal：**

```
┌─────────────────────────────────────────┐
│ 绑定会话 - [路由名称]              [×]  │
├─────────────────────────────────────────┤
│                                         │
│ 以下 N 个会话绑定了此路由：              │
│                                         │
│ ┌─────────────────────────────────────┐ │
│ │ 会话标题1                           │ │
│ │ Claude Code · 15 reqs · 50k tokens  │ │
│ ├─────────────────────────────────────┤ │
│ │ 会话标题2                           │ │
│ │ Codex · 8 reqs · 20k tokens         │ │
│ └─────────────────────────────────────┘ │
│                                         │
│                          [关闭]         │
└─────────────────────────────────────────┘
```

- Modal 宽度 500px，居中显示
- 每个会话条目显示标题（截断 20 字符）、客户端类型 Badge、请求数、Token 用量
- 最多显示 50 条，超出底部提示"等共 N 个会话"
- 点击右上角 × 或"关闭"按钮关闭

---

## 10. 非功能需求

### 10.1 性能

- Session 路由绑定查询使用内存中的 `sessions` 数组，O(N) 遍历，会话数通常 < 1000，性能无压力
- 代理请求中的路由查找增加一次 `getSession()` 调用（Map 查找），对请求延迟影响可忽略
- 路由管理页的绑定会话数查询使用 `getBoundSessions()`，在页面加载时一次性查询

### 10.2 向后兼容

- `routeId`/`routeName` 为可选字段，不影响现有数据
- 未绑定的会话行为完全不变
- 现有 API 签名不变（GET /api/sessions 返回数据多了两个可选字段）

### 10.3 数据一致性

- 路由删除时级联清理绑定
- upsertSession 保留已有的绑定关系
- routeName 冗余字段在绑定时写入，解绑时清除

---

## 11. 不在范围内

| 项目 | 说明 |
|---|---|
| 批量绑定 | 不支持一次选择多个会话绑定到同一路由 |
| 自动绑定规则 | 不支持基于条件的自动绑定（如按模型名自动绑定路由） |
| 绑定历史记录 | 不记录绑定/解绑的历史操作日志 |
| 会话跳转 | 路由管理页的绑定会话暂不支持点击跳转到会话详情 |

---

## 12. 实施阶段

### Phase 1：数据模型与数据库层

1. `src/types/index.ts`：Session 接口新增 `routeId?` 和 `routeName?` 字段
2. `src/server/fs-database.ts`：
   - `updateSession()` 参数新增 `routeId?`/`routeName?`
   - `upsertSession()` 处理绑定字段保留逻辑
   - 新增 `bindSessionRoute()` 方法
   - 新增 `unbindSessionRoute()` 方法
   - 新增 `getBoundSessions()` 方法
   - `deleteRoute()` 增加级联清理绑定逻辑

### Phase 2：API 层

3. `src/server/main.ts`：新增 3 个 API 端点
4. `src/ui/api/client.ts`：新增 3 个 API client 方法

### Phase 3：代理层

5. `src/server/proxy-server.ts`：
   - `findMatchingRoute()` 改造，加入会话级路由查找
   - 标准 API 路径中间件加入会话级路由覆盖
   - 处理路由已删除的自动清理

### Phase 4：前端 UI

6. `src/ui/components/SessionRouteBindingModal.tsx`：新建路由绑定弹窗组件
7. `src/ui/pages/SessionsPage.tsx`：新增路由按钮和弹窗集成
8. `src/ui/pages/RoutesPage.tsx`：路由卡片新增绑定会话数量和展开列表

---

## 13. 风险评估

| 风险 | 影响程度 | 概率 | 缓解措施 |
|---|---|---|---|
| 代理请求延迟增加 | 低 | 低 | getSession 为内存查找，O(1) 级别 |
| 路由删除忘记级联清理 | 中 | 低 | deleteRoute 中强制清理 + 代理层双重检查 |
| routeName 冗余数据不一致 | 低 | 低 | 绑定时从路由对象读取，删除路由时同步清理 |
| 大量会话绑定同一路由时展开列表过长 | 低 | 低 | 限制显示数量（如最多 10 个），超出的显示"等 N 个会话" |
| upsertSession 覆盖绑定关系 | 中 | 中 | 确保 upsertSession 保留已有 routeId（不传入时不覆盖） |

---

## 14. 未来展望

- **批量绑定**：支持在会话列表中多选后批量绑定到同一路由
- **自动绑定规则**：基于会话属性（模型、token 阈值等）自动绑定到指定路由
- **绑定历史**：记录绑定/解绑操作历史
- **会话跳转**：路由管理页的绑定会话支持点击跳转到会话详情
- **绑定统计**：在 Usage 页面展示路由绑定的使用统计
