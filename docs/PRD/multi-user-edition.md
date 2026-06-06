# AICodeSwitch 多用户版 — 产品需求文档 (PRD)

> **版本**: v1.0.0-draft
> **日期**: 2026-06-05
> **作者**: 产品团队
> **状态**: 草稿 — 待评审

---

## 目录

1. [项目背景](#1-项目背景)
2. [愿景与目标](#2-愿景与目标)
3. [目标用户与角色](#3-目标用户与角色)
4. [核心概念与数据模型](#4-核心概念与数据模型)
5. [功能需求](#5-功能需求)
6. [用户故事](#6-用户故事)
7. [API 设计](#7-api-设计)
8. [技术方案概要](#8-技术方案概要)
9. [非功能需求](#9-非功能需求)
10. [数据迁移与兼容性](#10-数据迁移与兼容性)
11. [分期交付计划](#11-分期交付计划)
12. [风险与缓解](#12-风险与缓解)
13. [附录](#附录)

---

## 1. 项目背景

### 1.1 现状分析

AICodeSwitch 目前是一个**单用户本地代理工具**，核心设计假设为：

| 维度 | 现状 | 局限 |
|------|------|------|
| **部署方式** | 本地单机运行 | 无法服务多人 |
| **认证体系** | 单一管理密码 (`AUTH`) + 单一全局代理 Key (`config.apiKey`) | 无用户隔离 |
| **数据存储** | JSON 文件 (`~/.aicodeswitch/fs-db/`)，全量内存加载 | 无法支撑高并发 |
| **路由策略** | 全局共享一套路由/规则 | 无法按用户差异化配置 |
| **配置写入** | 写入本机的 `~/.claude/settings.json`、`~/.codex/config.toml` | 仅适用于本地工具直连场景 |

### 1.2 为什么需要多用户版

大量企业场景（内部工具团队、外包团队、教育机构）提出以下需求：

- **集中管理**：一个管理员统一维护供应商和路由策略，用户无需自行配置
- **用量管控**：按用户设置 Token / 请求次数配额，防止单个用户耗尽资源
- **成本分摊**：精确追踪每个用户的消耗，支撑内部成本核算
- **零配置接入**：用户只需获得一个 API Key，无需登录管理后台即可使用

### 1.3 典型场景

> **某 1000 人科技公司**：IT 团队部署一套 AICodeSwitch 服务端，为每位开发者分配一个 API Key。管理员统一接入 Anthropic / OpenAI / Google 等供应商，按部门设定不同的路由策略和 Token 配额。开发者只需在自己的 Claude Code 或 Codex 中配置该 API Key 即可使用，无需关心上游供应商。

---

## 2. 愿景与目标

### 2.1 产品愿景

将 AICodeSwitch 从「个人本地代理工具」升级为「可服务端部署的多用户 AI 编程网关」，成为团队和企业统一管理 AI 编程工具接入的基础设施。

### 2.2 核心目标

| # | 目标 | 衡量标准 |
|---|------|----------|
| G1 | 用户零感知接入 | 用户仅需配置 API Key，无需其他操作 |
| G2 | 管理员高效管控 | 管理员可在 5 分钟内完成一个新用户的创建和配置 |
| G3 | 用量精确追踪 | 可按用户、时间范围查看 Token 消耗、请求次数、成功率 |
| G4 | 差异化路由策略 | 不同用户可使用不同的路由策略和模型池 |
| G5 | 弹性配额管理 | 支持 Token 配额、请求频率限制、并发限制等多维度管控 |

### 2.3 非目标（本期不做）

- 用户自主注册（由管理员创建账户）
- 实名身份绑定（仅使用内部 ID + 备注标识）
- 计费/支付系统（本期仅做用量追踪，不做自动扣费）
- 多租户数据物理隔离（逻辑隔离即可）
- 替代单用户版本（两个版本共存，共享核心代理逻辑）

---

## 3. 目标用户与角色

### 3.1 角色定义

#### 管理员 (Admin)

- **描述**：系统的运维/管理者，负责维护供应商、路由策略、用户管理
- **权限**：
  - 完整的管理后台访问权限
  - 创建/编辑/删除用户
  - 配置用户配额和路由策略
  - 查看全局和单用户数据统计
  - 管理供应商、路由、规则
  - 导入/导出系统配置

#### 用户 / 租户 (Tenant)

- **描述**：终端开发者，通过 API Key 连接系统使用 AI 编程服务
- **权限**：
  - **不需要登录管理后台**（本期设计如此）
  - 仅通过 API Key 发起代理请求
  - 未来可扩展为：登录后查看个人用量、修改个人偏好

### 3.2 角色对比

| 能力 | 管理员 | 用户 |
|------|--------|------|
| 管理后台登录 | ✅ | ❌ |
| 管理供应商/服务 | ✅ | ❌ |
| 管理路由/规则 | ✅ | ❌ |
| 管理用户 | ✅ | ❌ |
| 查看全局统计 | ✅ | ❌ |
| 查看所有日志 | ✅ | ❌ |
| 通过 API Key 使用代理 | ✅（可选） | ✅ |
| 查看个人用量（未来） | - | ✅ |

---

## 4. 核心概念与数据模型

### 4.1 新增核心实体

```
┌─────────────┐         ┌──────────────────┐
│    Admin     │         │     Tenant       │
│  (管理员)    │         │   (用户/租户)    │
├─────────────┤         ├──────────────────┤
│ id          │         │ id               │
│ username    │         │ name             │
│ passwordHash│         │ remark           │
│ role        │         │ status           │
│ createdAt   │         │ apiKey           │ ← 系统生成，前缀 skt_
│             │         │ routePolicyId    │ ← 绑定路由策略
│             │         │ quota            │ ← 配额配置
│             │         │ tags[]           │ ← 标签（按部门/分组）
│             │         │ createdAt        │
│             │         │ updatedAt        │
└─────────────┘         └──────────────────┘
                               │
                               │ 使用
                               ▼
                    ┌──────────────────┐
                    │  RoutePolicy     │
                    │  (路由策略)      │
                    ├──────────────────┤
                    │ id               │
                    │ name             │
                    │ description      │
                    │ rules[]          │ ← 包含完整的路由规则集
                    │ isActive         │
                    │ createdAt        │
                    │ updatedAt        │
                    └──────────────────┘
```

### 4.2 关键概念

#### Tenant（租户/用户）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 系统生成的唯一标识（如 `t_abc123`） |
| `name` | string | 显示名称（如 "张三"、"Dev-Team-A"） |
| `remark` | string? | 备注信息（如 "前端组 / 工号 12345"） |
| `status` | enum | `active` / `suspended` / `disabled` |
| `apiKey` | string | 系统生成的 API Key（前缀 `skt_`），**不可自定义** |
| `routePolicyId` | string? | 绑定的路由策略 ID |
| `quota` | TenantQuota | 配额配置（详见下文） |
| `tags` | string[] | 标签，用于分组管理（如 `["前端组", "VIP"]`） |
| `createdAt` | number | 创建时间 |
| `updatedAt` | number | 更新时间 |

#### TenantQuota（租户配额）

| 字段 | 类型 | 说明 |
|------|------|------|
| `totalTokenLimit` | number? | 总 Token 上限（累计，不重置）。`null` 表示不限制 |
| `periodicTokenLimit` | number? | 周期性 Token 上限（单位：k） |
| `periodicTokenResetInterval` | number? | Token 重置周期（小时） |
| `requestCountLimit` | number? | 周期内请求次数上限 |
| `requestResetInterval` | number? | 请求次数重置周期（小时） |
| `rpmLimit` | number? | 每分钟请求数上限（Rate Per Minute） |
| `concurrentLimit` | number? | 最大并发请求数 |
| `allowedModels` | string[]? | 允许使用的模型白名单。`null` 表示不限制 |
| `blockedModels` | string[]? | 禁止使用的模型黑名单 |

#### RoutePolicy（路由策略）

路由策略是一个**独立的路由配置集合**，可被多个租户复用：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 策略 ID |
| `name` | string | 策略名称（如 "VIP 策略"、"普通用户策略"） |
| `description` | string? | 策略说明 |
| `toolBindings` | ToolBindings | 工具绑定（claude-code / codex 对应的路由） |
| `apiPathBindings` | ApiPathBinding[] | API 路径绑定 |
| `isActive` | boolean | 是否启用 |
| `createdAt` | number | 创建时间 |
| `updatedAt` | number | 更新时间 |

> **设计说明**：RoutePolicy 本质上是将现有「路由激活绑定」抽象为可复用的策略模板。一个策略被多个租户共享时，修改策略会影响所有绑定该策略的租户。

#### Admin（管理员）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 管理员 ID |
| `username` | string | 登录用户名 |
| `passwordHash` | string | bcrypt 密码哈希 |
| `role` | enum | `super_admin` / `admin` |
| `createdAt` | number | 创建时间 |

> **初始管理员**：首次部署时通过环境变量或命令行创建 super_admin。

### 4.3 与现有模型的关系

```
现有模型（保持不变）         新增模型
─────────────────         ────────
Vendor ◄─────────────────┐
  └ services[]           │   共享，由管理员统一维护
                         │
Route ◄──────────────────┤
  └ rules[]              │   Route 继续承载规则定义
                         │
ToolBindings ────────────┤   → 迁移为 RoutePolicy.toolBindings
ApiPathBindings ─────────┘   → 迁移为 RoutePolicy.apiPathBindings

                              Tenant.routePolicyId → RoutePolicy
                              Tenant.apiKey → 替代原全局 config.apiKey
```

---

## 5. 功能需求

### 5.1 模块总览

```
┌──────────────────────────────────────────────────────────────┐
│                    多用户版功能模块                            │
├──────────────┬───────────────┬───────────────┬───────────────┤
│  认证与权限   │   用户管理     │   策略管理     │   监控统计    │
│              │               │               │               │
│ · 管理员登录  │ · 用户CRUD    │ · 路由策略CRUD │ · 全局仪表盘  │
│ · JWT 鉴权   │ · API Key管理 │ · 策略绑定     │ · 用户级统计  │
│ · 权限控制    │ · 配额配置     │ · 规则继承     │ · 日志查看    │
│ · 初始管理员  │ · 批量操作     │ · 模型过滤     │ · 告警通知    │
│              │ · 标签分组     │               │ · 报表导出    │
└──────────────┴───────────────┴───────────────┴───────────────┘
                              │
                    ┌─────────┴─────────┐
                    │  核心代理引擎       │
                    │  (共享现有逻辑)     │
                    │                    │
                    │ · 请求认证         │
                    │ · 用户配额检查     │
                    │ · 路由策略匹配     │
                    │ · 格式转换         │
                    │ · 流式转发         │
                    │ · 用量记录         │
                    └────────────────────┘
```

### 5.2 F1 — 认证与权限模块

#### F1.1 管理员登录

- 管理后台提供用户名 + 密码登录
- 登录成功后签发 JWT（有效期 7 天）
- 支持 `super_admin` 和 `admin` 两种角色
- `super_admin` 可管理其他管理员账户
- 首次部署时通过环境变量 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 创建初始管理员
- 也支持通过 CLI 命令创建：`aicos admin create --username <name> --password <pwd>`

#### F1.2 代理请求认证

- 代理请求（`/v1/*`、`/claude-code/*`、`/codex/*`）通过 `skt_` 前缀的 API Key 认证
- 认证流程：
  1. 从 `Authorization: Bearer`、`x-api-key` 或 `x-goog-api-key` 提取 Key
  2. 查找匹配的 Tenant 记录
  3. 检查 Tenant 状态（`active` 才放行）
  4. 将 Tenant 信息注入请求上下文，供后续配额检查和路由使用

#### F1.3 权限矩阵

| 资源 | super_admin | admin | 说明 |
|------|:-----------:|:-----:|------|
| 管理员账户 CRUD | ✅ | ❌ | super_admin 独占 |
| 用户 CRUD | ✅ | ✅ | |
| 路由策略 CRUD | ✅ | ✅ | |
| 供应商/服务 CRUD | ✅ | ✅ | |
| 全局配置 | ✅ | ✅ | |
| 数据导出 | ✅ | ✅ | |
| 系统级配置（端口、密钥等） | ✅ | ❌ | |

### 5.3 F2 — 用户管理模块

#### F2.1 用户 CRUD

| 操作 | 说明 |
|------|------|
| 创建用户 | 填写名称、备注，选择路由策略，设定配额。系统自动生成 `skt_` API Key |
| 查看用户 | 列表展示所有用户，支持按名称/标签/状态筛选 |
| 编辑用户 | 修改名称、备注、路由策略、配额、状态 |
| 停用用户 | 将状态设为 `suspended`，其 API Key 立即失效 |
| 删除用户 | 软删除（标记 `disabled`），关联日志保留 |
| 批量操作 | 批量创建（如导入名单）、批量修改路由策略、批量调整配额 |

#### F2.2 API Key 管理

| 操作 | 说明 |
|------|------|
| 自动生成 | 创建用户时自动生成 `skt_` 前缀 API Key |
| 重新生成 | 可重新生成 API Key（旧 Key 立即失效） |
| 复制展示 | 管理后台展示完整 Key（创建时仅显示一次完整 Key，之后掩码展示） |
| 批量导出 | 导出所有用户的 API Key 列表（管理员场景） |

#### F2.3 配额配置

每个用户可独立配置以下配额维度：

| 维度 | 配置项 | 说明 |
|------|--------|------|
| **Token 总量** | `totalTokenLimit` | 累计消耗上限，达到后拒绝请求。`null` 不限制 |
| **Token 周期** | `periodicTokenLimit` + `periodicTokenResetInterval` | 周期性 Token 上限，自动重置 |
| **请求次数** | `requestCountLimit` + `requestResetInterval` | 周期内请求次数上限 |
| **频率限制** | `rpmLimit` | 每分钟最大请求数 |
| **并发限制** | `concurrentLimit` | 同时进行的最大请求数 |
| **模型白名单** | `allowedModels` | 只允许使用的模型列表 |
| **模型黑名单** | `blockedModels` | 禁止使用的模型列表 |

> **配额优先级**：用户配额 > 路由规则配额 > 服务配额。取最严格值。

#### F2.4 标签与分组

- 支持为用户设置标签（如 `["前端组", "VIP", "试用期"]`）
- 管理后台支持按标签筛选用户
- 批量操作支持按标签批量修改

### 5.4 F3 — 路由策略管理

#### F3.1 路由策略 CRUD

| 操作 | 说明 |
|------|------|
| 创建策略 | 定义策略名称、描述，关联路由和工具绑定 |
| 编辑策略 | 修改策略的路由规则、工具绑定、API 路径绑定 |
| 复制策略 | 基于现有策略复制一份新的（快速创建相似策略） |
| 删除策略 | 仅允许删除未被用户引用的策略 |
| 策略预览 | 预览策略的完整规则链（匹配顺序、对应服务、模型映射） |

#### F3.2 策略与用户的绑定

- 一个用户绑定一个路由策略
- 多个用户可共享同一策略
- 修改策略会实时影响所有绑定该策略的用户
- 用户未绑定策略时：使用「默认策略」（系统内置，管理员可编辑）

#### F3.3 默认策略

- 系统内置一个「默认策略」
- 新创建的用户默认绑定该策略
- 管理员可编辑默认策略的内容
- 默认策略不可删除

### 5.5 F4 — 监控与统计模块

#### F4.1 全局仪表盘

| 指标 | 说明 |
|------|------|
| 在线用户数 | 当前活跃（有请求）的用户数量 |
| 总请求数 | 全局请求总数 |
| 总 Token 消耗 | 全局 Token 总消耗 |
| 平均响应时间 | 全局平均响应延迟 |
| 错误率 | 全局请求错误率 |
| Top 用户 | Token 消耗最多的用户排名 |
| Top 模型 | 使用频率最高的模型排名 |
| 时序趋势 | 请求量、Token 消耗的时间趋势图 |

#### F4.2 用户级统计

| 指标 | 说明 |
|------|------|
| 用户基础信息 | 名称、状态、绑定的策略、标签 |
| Token 消耗 | 累计 Token、周期内 Token、剩余配额 |
| 请求统计 | 总请求数、成功率、平均响应时间 |
| 配额使用率 | 各配额维度的已用/总量百分比 |
| 最近请求 | 该用户的最近请求列表 |
| 会话列表 | 该用户的活跃会话 |
| 消耗趋势 | 按日/周/月的消耗趋势 |

#### F4.3 日志查看

- 支持按用户筛选日志
- 每条日志记录关联 `tenantId`
- 保留现有的日志详情展示（请求体、响应体、上游请求等）

#### F4.4 配额告警

- 当用户配额使用率达到阈值（如 80%、90%、100%）时，在管理后台显示告警
- 可选：通过 Webhook 通知管理员

### 5.6 F5 — 管理后台 UI

#### F5.1 页面结构

```
管理后台
├── 仪表盘（Dashboard）        ← 全局概览
├── 用户管理（Tenants）         ← 用户列表、CRUD、配额
│   ├── 用户列表
│   ├── 创建/编辑用户
│   ├── 用户详情（含统计）
│   └── 批量操作
├── 路由策略（Route Policies）  ← 策略管理
│   ├── 策略列表
│   ├── 创建/编辑策略
│   └── 策略预览
├── 供应商（Vendors）           ← 现有功能，保持不变
├── 路由（Routes）              ← 现有功能，保持不变
├── 规则（Rules）               ← 现有功能，保持不变
├── 日志（Logs）                ← 增强用户筛选
├── 统计（Statistics）          ← 增强用户维度
├── MCP                         ← 现有功能
└── 设置（Settings）            ← 增加管理员账户管理
    ├── 系统配置
    ├── 管理员管理
    └── 导入/导出
```

#### F5.2 用户列表页

- 表格列：名称、API Key（掩码）、状态、路由策略、标签、Token 使用率、请求次数、创建时间
- 筛选：按状态、标签、路由策略筛选
- 搜索：按名称/备注搜索
- 批量操作：批量修改策略、批量调整配额、批量导出 Key

#### F5.3 用户详情页

- 基础信息卡片：名称、备注、状态、API Key、标签
- 配额使用情况：各维度的进度条
- 消耗趋势图：日/周/月维度
- 最近请求列表：可跳转至日志详情

---

## 6. 用户故事

### 6.1 管理员故事

| ID | 用户故事 | 验收标准 |
|----|----------|----------|
| A-01 | 作为管理员，我想通过用户名和密码登录管理后台 | 登录成功后跳转至仪表盘，获得 JWT，7 天有效 |
| A-02 | 作为管理员，我想创建新用户并自动生成 API Key | 创建成功后显示完整 Key（仅一次），之后掩码展示 |
| A-03 | 作为管理员，我想为用户设置 Token 配额 | 设置后，该用户达到配额时请求被拒绝并返回明确错误 |
| A-04 | 作为管理员，我想为用户绑定路由策略 | 绑定后，该用户的请求按策略路由 |
| A-05 | 作为管理员，我想查看所有用户的 Token 消耗排名 | 仪表盘显示 Top 10 用户消耗列表 |
| A-06 | 作为管理员，我想批量创建用户 | 通过导入 CSV 创建多个用户，每个自动生成 API Key |
| A-07 | 作为管理员，我想停用某个用户的 Key | 停用后该用户的所有请求立即被拒绝 |
| A-08 | 作为管理员，我想查看某用户的详细请求日志 | 日志页面支持按用户 ID 筛选，显示完整请求详情 |
| A-09 | 作为管理员，我想设置配额告警 | 配额达到 80% 时在仪表盘显示黄色告警，100% 显示红色 |
| A-10 | 作为管理员，我想复制一份现有策略并修改 | 复制后的策略是独立的，修改不影响原策略 |
| A-11 | 作为管理员，我想通过 CLI 命令管理用户 | `aicos tenant list` / `aicos tenant create` 等命令可用 |

### 6.2 终端用户故事

| ID | 用户故事 | 验收标准 |
|----|----------|----------|
| U-01 | 作为用户，我想用分配到的 API Key 配置 Claude Code | 配置 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_AUTH_TOKEN` 后即可使用 |
| U-02 | 作为用户，我想用分配到的 API Key 配置 Codex | 配置对应的 endpoint 和 Key 后即可使用 |
| U-03 | 作为用户，当我的配额耗尽时我想收到明确的错误信息 | 返回 `429 Too Many Requests` 并附带剩余配额信息 |
| U-04 | 作为用户，我想使用 OpenAI 兼容格式的 API | 通过 `/v1/chat/completions` 端点使用 `skt_` Key 认证 |
| U-05 | 作为用户，我想使用 Claude 原生格式的 API | 通过 `/v1/messages` 端点使用 `skt_` Key 认证 |

---

## 7. API 设计

### 7.1 认证 API

```
POST   /api/auth/login                # 管理员登录
  Request:  { username, password }
  Response: { token, expiresIn }

GET    /api/auth/status                # 认证状态
  Response: { enabled: true }

POST   /api/auth/logout               # 管理员登出（可选）
```

### 7.2 管理员管理 API

```
GET    /api/admins                     # 管理员列表 [super_admin]
POST   /api/admins                     # 创建管理员 [super_admin]
  Request:  { username, password, role }
PUT    /api/admins/:id                 # 编辑管理员 [super_admin]
  Request:  { username?, password?, role? }
DELETE /api/admins/:id                 # 删除管理员 [super_admin]
PUT    /api/admins/:id/password        # 修改密码 [super_admin 或自己]
  Request:  { password }
```

### 7.3 用户（租户）管理 API

```
GET    /api/tenants                    # 用户列表（分页、筛选）
  Query:    ?page=1&pageSize=20&status=active&tag=前端组&search=张三
  Response: { data: Tenant[], total, page, pageSize }

POST   /api/tenants                    # 创建用户
  Request:  { name, remark?, routePolicyId?, quota?, tags? }
  Response: { tenant, apiKey }         # 仅此时返回完整 apiKey

GET    /api/tenants/:id                # 用户详情
  Response: Tenant

PUT    /api/tenants/:id                # 编辑用户
  Request:  { name?, remark?, routePolicyId?, quota?, tags?, status? }

DELETE /api/tenants/:id                # 删除用户（软删除）

POST   /api/tenants/:id/regenerate-key # 重新生成 API Key
  Response: { apiKey }

POST   /api/tenants/batch              # 批量创建
  Request:  { tenants: [{ name, remark?, quota?, tags? }], routePolicyId? }
  Response: { created: [{ tenant, apiKey }] }

PUT    /api/tenants/batch/policy       # 批量修改路由策略
  Request:  { tenantIds, routePolicyId }

PUT    /api/tenants/batch/quota        # 批量修改配额
  Request:  { tenantIds, quota }

POST   /api/tenants/export-keys        # 批量导出 API Key
  Request:  { tenantIds? }             # 空 = 全部
  Response: CSV / JSON 格式下载

GET    /api/tenants/:id/usage          # 用户用量统计
  Query:    ?period=7d
  Response: { tokenUsage, requestCount, byModel[], byContentType[], timeline[] }

GET    /api/tenants/:id/logs           # 用户日志
  Query:    ?page=1&pageSize=50

GET    /api/tenants/:id/sessions       # 用户会话列表
  Query:    ?page=1&pageSize=20
```

### 7.4 路由策略 API

```
GET    /api/route-policies             # 策略列表
POST   /api/route-policies             # 创建策略
  Request:  { name, description?, toolBindings?, apiPathBindings? }
GET    /api/route-policies/:id         # 策略详情
PUT    /api/route-policies/:id         # 编辑策略
DELETE /api/route-policies/:id         # 删除策略（检查是否有关联用户）
POST   /api/route-policies/:id/duplicate  # 复制策略
GET    /api/route-policies/:id/preview    # 预览策略规则链
GET    /api/route-policies/:id/tenants    # 使用该策略的用户列表
```

### 7.5 统计 API（增强）

```
GET    /api/statistics/overview        # 全局概览（增强：含用户维度）
GET    /api/statistics/tenants         # 用户消耗排名
  Query:    ?sortBy=totalTokens&order=desc&limit=20
GET    /api/statistics/tenant/:id      # 单用户统计
  Query:    ?period=7d
GET    /api/statistics/quota-alerts    # 配额告警列表
```

### 7.6 代理请求认证流程

```
客户端请求 → /v1/messages (携带 Authorization: Bearer skt_xxx)
  │
  ├── 1. 提取 API Key
  │     从 Authorization / x-api-key / x-goog-api-key 中提取
  │
  ├── 2. Key 前缀判断
  │     ├── skt_ → 查找 Tenant → 注入 tenantContext
  │     ├── skr_ → 查找 Routing Key（现有逻辑）
  │     └── 其他 → 使用全局 config.apiKey（兼容单用户模式）
  │
  ├── 3. Tenant 状态检查
  │     status === 'active' ? 继续 : 403
  │
  ├── 4. 配额检查
  │     检查 Token 配额、请求次数、RPM、并发数
  │     通过 ? 继续 : 429
  │
  ├── 5. 路由策略解析
  │     通过 tenant.routePolicyId 获取策略
  │     无策略 → 使用默认策略
  │
  ├── 6. 模型过滤
  │     allowedModels / blockedModels 检查
  │     通过 ? 继续 : 403
  │
  ├── 7. 规则匹配 & 请求转发
  │     复用现有规则匹配、格式转换、上游转发逻辑
  │
  └── 8. 用量记录
        记录到 TenantUsage，更新配额计数
```

---

## 8. 技术方案概要

### 8.1 架构演进

```
当前架构（单用户）                     目标架构（多用户）
──────────────────                    ──────────────────
┌──────────────┐                      ┌──────────────┐
│  React UI    │                      │  React UI    │
│  (管理后台)   │                      │  (管理后台)   │
└──────┬───────┘                      └──────┬───────┘
       │ HTTP                                │ HTTP
┌──────▼───────┐                      ┌──────▼───────┐
│  Express API │                      │  Express API │
│  + Proxy     │                      │  + Proxy     │
└──────┬───────┘                      └──────┬───────┘
       │                                     │
┌──────▼───────┐                      ┌──────▼───────┐
│  JSON Files  │                      │  数据库       │
│  (内存)       │                      │  (SQLite)    │
└──────────────┘                      └──────────────┘
```

### 8.2 数据库选型

| 方案 | 优点 | 缺点 | 推荐 |
|------|------|------|:----:|
| **SQLite (better-sqlite3)** | 零部署、高性能读、事务支持、单文件 | 并发写受限 | ✅ |
| JSON 文件（现有） | 简单、无依赖 | 无事务、并发问题、全量内存 | ❌ |
| PostgreSQL | 企业级、高并发 | 部署复杂、增加运维成本 | 🔮 未来 |

**推荐方案**：SQLite（better-sqlite3）

- 保持"零依赖部署"优势（单个 `.db` 文件）
- 支持事务、索引、SQL 查询
- 同步 API，与现有代码风格一致
- 足以支撑 1000 用户级别

### 8.3 数据库 Schema 概要

```sql
-- 管理员
CREATE TABLE admins (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',  -- 'super_admin' | 'admin'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 租户（用户）
CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  remark TEXT,
  status TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'suspended' | 'disabled'
  api_key TEXT UNIQUE NOT NULL,           -- skt_ 前缀
  api_key_hash TEXT UNIQUE NOT NULL,      -- 用于快速查找
  route_policy_id TEXT,
  quota TEXT,                             -- JSON: TenantQuota
  tags TEXT,                              -- JSON: string[]
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (route_policy_id) REFERENCES route_policies(id)
);

-- 路由策略
CREATE TABLE route_policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  tool_bindings TEXT,       -- JSON: ToolBindings
  api_path_bindings TEXT,   -- JSON: ApiPathBinding[]
  is_default INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 租户用量（按周期）
CREATE TABLE tenant_usage (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  total_tokens INTEGER DEFAULT 0,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  request_count INTEGER DEFAULT 0,
  error_count INTEGER DEFAULT 0,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  UNIQUE(tenant_id, period_start)
);

-- 租户累计用量
CREATE TABLE tenant_lifetime_usage (
  tenant_id TEXT PRIMARY KEY,
  total_tokens INTEGER DEFAULT 0,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  request_count INTEGER DEFAULT 0,
  error_count INTEGER DEFAULT 0,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

-- 租户配额快照（用于 RPM / 并发检查的内存计数）
-- 注意：频率限制和并发限制通过内存数据结构实现，不持久化

-- 现有表保持兼容（vendors, services, routes, rules 等）
-- 请求日志增加 tenant_id 字段
```

### 8.4 认证架构

```
┌────────────────────────────────────────────────────┐
│                    认证流程                         │
├──────────────────────┬─────────────────────────────┤
│   管理后台请求        │      代理请求                │
│   /api/*             │   /v1/*, /claude-code/*      │
├──────────────────────┼─────────────────────────────┤
│                      │                             │
│  Authorization:      │  Authorization:             │
│  Bearer <JWT>        │  Bearer skt_xxxxxxxx        │
│                      │                             │
│         │            │              │               │
│         ▼            │              ▼               │
│  ┌──────────┐        │     ┌──────────────┐        │
│  │ JWT验证   │        │     │ Key 前缀判断  │        │
│  │ 管理员角色 │        │     │ skt_ → 租户   │        │
│  └──────────┘        │     │ skr_ → 路由   │        │
│                      │     │ 其他 → 全局   │        │
│                      │     └──────────────┘        │
└──────────────────────┴─────────────────────────────┘
```

### 8.5 核心代理流程改造

现有 `proxy-server.ts` 需要进行以下改造：

1. **API Key 解析层**：在现有 Key 提取逻辑后，增加 `skt_` 前缀识别和 Tenant 查找
2. **Tenant 上下文注入**：将 `tenantId`、`routePolicyId`、`quota` 注入到请求上下文
3. **配额检查中间件**：在规则匹配之前检查用户级配额
4. **策略路由解析**：从 `tenant.routePolicyId` 获取策略，替代全局 `toolBindings`
5. **用量记录增强**：在日志记录中增加 `tenantId`，同时更新 `tenant_usage`

> **设计原则**：保持现有代理核心逻辑不变，仅在入口层和出口层增加多用户相关处理。

### 8.6 部署模式兼容

```
┌───────────────────────────────────────────────────┐
│              运行模式自动检测                        │
├───────────────────────────────────────────────────┤
│                                                   │
│  环境变量 MULTITENANT=true ?                      │
│                                                   │
│  ├── 是 → 多用户模式                               │
│  │   ├── 使用 SQLite 数据库                        │
│  │   ├── 代理请求需要 skt_ Key                     │
│  │   ├── 管理后台需要管理员登录                      │
│  │   └── 不写入本地工具配置文件                     │
│  │                                                │
│  └── 否 → 单用户模式（现有行为）                    │
│      ├── 使用 JSON 文件数据库                      │
│      ├── 代理请求使用全局 apiKey                   │
│      ├── 管理后台使用简单密码认证                    │
│      └── 写入本地工具配置文件                       │
│                                                   │
└───────────────────────────────────────────────────┘
```

---

## 9. 非功能需求

### 9.1 性能

| 指标 | 目标 |
|------|------|
| 代理请求延迟增加 | < 5ms（相比单用户版） |
| 并发用户支持 | ≥ 100 同时在线 |
| 总用户规模 | ≥ 1000 注册用户 |
| API Key 查找 | < 1ms（内存缓存 + 索引） |
| 管理后台页面加载 | < 2s |

### 9.2 安全

| 要求 | 措施 |
|------|------|
| API Key 安全 | Key 在数据库中哈希存储，仅创建/重新生成时明文展示 |
| 密码安全 | bcrypt 哈希，cost factor ≥ 12 |
| JWT 安全 | HS256 签名，密钥从 `JWT_SECRET` 环境变量读取 |
| 数据隔离 | 用户只能通过自己的 Key 访问自己的数据 |
| 敏感信息脱敏 | 管理后台的日志展示中对上游 API Key、用户 API Key 掩码处理 |
| 传输安全 | 推荐生产环境使用反向代理（Nginx/Caddy）提供 HTTPS |
| 防暴力破解 | 登录失败 5 次后锁定 15 分钟 |

### 9.3 可靠性

| 要求 | 措施 |
|------|------|
| 数据持久化 | SQLite WAL 模式，定期 checkpoint |
| 优雅关闭 | SIGTERM 时完成进行中的请求，保存状态 |
| 错误恢复 | 配额计数器异常时自动降级为不限制（宁可多用不可误拒） |
| 日志轮转 | 按现有策略执行日志保留和清理 |

### 9.4 可运维性

| 要求 | 措施 |
|------|------|
| 配置简单 | 通过环境变量 + 单个配置文件完成部署 |
| CLI 管理 | `aicos tenant` / `aicos admin` 命令行工具 |
| 健康检查 | `/health` 端点返回服务状态和数据库连接状态 |
| 备份恢复 | 数据库文件可直接拷贝备份，支持导入/导出 |
| 日志查看 | PM2 日志 + 应用日志 + 请求日志 |

---

## 10. 数据迁移与兼容性

### 10.1 单用户 → 多用户迁移

- 多用户版是**独立部署**，不支持从单用户版原地升级
- 管理员可在多用户版管理后台中导入单用户版的导出数据（供应商、路由、规则等）
- 迁移步骤：
  1. 部署多用户版
  2. 在管理后台导入供应商/路由/规则配置
  3. 创建用户并分配策略
  4. 分发 API Key 给终端用户

### 10.2 共享核心代码

多用户版和单用户版共享以下核心模块：

| 模块 | 共享策略 |
|------|----------|
| 代理引擎（格式转换、流式处理） | 100% 共享 |
| 转换器（Claude/OpenAI/Gemini/DeepSeek） | 100% 共享 |
| 路由规则匹配逻辑 | 100% 共享 |
| 内容类型检测 | 100% 共享 |
| 认证模块 | 分支：单用户走现有逻辑，多用户走 Tenant 查找 |
| 数据库层 | 分支：单用户用 JSON 文件，多用户用 SQLite |
| 管理后台 UI | 分支：多用户版增加用户管理、策略管理页面 |

---

## 11. 分期交付计划

### Phase 1：核心基础（MVP）

> 目标：管理员可以创建用户、分配 API Key，用户可以通过 Key 使用代理

**功能范围**：

- [ ] 数据库层：SQLite 集成、Schema 创建、Migration 机制
- [ ] 管理员认证：用户名 + 密码登录、JWT、权限中间件
- [ ] 用户管理：CRUD、API Key 生成（`skt_` 前缀）
- [ ] 代理认证：`skt_` Key 识别、Tenant 查找、状态检查
- [ ] 基础路由策略：策略 CRUD、用户绑定
- [ ] 基础配额：Token 总量限制、请求次数限制
- [ ] 用量记录：日志中关联 `tenantId`
- [ ] 管理后台 UI：登录页、仪表盘（基础）、用户管理页
- [ ] CLI 命令：`aicos tenant create/list`

**预计工期**：2-3 周

### Phase 2：管控增强

> 目标：完善的配额管理、策略管理、统计监控

**功能范围**：

- [ ] 高级配额：周期性 Token 重置、RPM 限制、并发限制、模型过滤
- [ ] 策略管理：策略编辑 UI、策略预览、策略复制、默认策略
- [ ] 统计增强：用户级统计、消耗排名、趋势图
- [ ] 批量操作：批量创建用户、批量修改策略/配额、导出 Key
- [ ] 标签分组：用户标签管理、按标签筛选
- [ ] 配额告警：阈值告警、仪表盘告警展示
- [ ] 管理后台 UI：策略管理页、统计页增强、用户详情页增强

**预计工期**：2 周

### Phase 3：运维与体验优化

> 目标：生产级稳定性、运维工具、用户体验优化

**功能范围**：

- [ ] 安全加固：登录锁定、API Key 哈希存储、审计日志
- [ ] 运维工具：数据库备份/恢复、健康检查增强
- [ ] 文档：部署指南、管理员手册、用户接入指南
- [ ] Docker 镜像：一键部署
- [ ] 性能优化：Key 查找缓存、统计查询优化
- [ ] 国际化：管理后台 UI 多语言支持（中/英）
- [ ] Webhook 通知：配额告警推送

**预计工期**：1-2 周

---

## 12. 风险与缓解

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|:----:|----------|
| SQLite 并发写瓶颈 | 高用户并发时写入性能下降 | 中 | WAL 模式 + 写入队列批处理；未来可迁移至 PostgreSQL |
| 代理性能回退 | Key 查找和配额检查增加延迟 | 低 | 内存缓存 Tenant 信息，配额检查使用原子操作 |
| 配额计数不精确 | 进程崩溃时丢失部分计数 | 中 | 定期持久化到数据库；使用周期重置降低累计误差 |
| 管理后台复杂度 | UI 开发工作量大于预期 | 中 | 复用现有 UI 组件和样式；MVP 阶段精简功能 |
| API Key 泄露 | 用户 Key 被他人盗用 | 中 | Key 仅在创建时展示一次；支持即时重新生成；频率限制可缓解滥用 |
| 数据迁移困难 | 从单用户版迁移配置复杂 | 低 | 提供导入工具，复用现有导出格式 |

---

## 附录

### A. API Key 前缀约定

| 前缀 | 用途 | 生成方 |
|------|------|--------|
| `skt_` | 租户 API Key（多用户版） | 系统自动生成 |
| `skr_` | 路由 Key（现有） | 系统自动生成 |
| `sk_` | 池 Key（AICodingBus） | 系统自动生成 |

### B. 错误码规范

| HTTP 状态码 | 错误代码 | 说明 |
|:-----------:|----------|------|
| 401 | `INVALID_API_KEY` | API Key 无效或不存在 |
| 403 | `TENANT_SUSPENDED` | 用户已被停用 |
| 403 | `TENANT_DISABLED` | 用户已被删除 |
| 403 | `MODEL_NOT_ALLOWED` | 请求的模型不在白名单中 |
| 429 | `TOKEN_QUOTA_EXCEEDED` | Token 配额已耗尽 |
| 429 | `REQUEST_QUOTA_EXCEEDED` | 请求次数配额已耗尽 |
| 429 | `RPM_LIMIT_EXCEEDED` | 频率限制触发 |
| 429 | `CONCURRENT_LIMIT_EXCEEDED` | 并发限制触发 |

### C. 配额响应头

代理响应中增加以下 Header，帮助用户了解配额状态：

```
X-RateLimit-Limit: 1000              # 周期内请求上限
X-RateLimit-Remaining: 842           # 周期内剩余请求数
X-RateLimit-Reset: 1700000000        # 周期重置时间（Unix 时间戳）
X-Token-Quota-Limit: 5000000         # Token 总量限制
X-Token-Quota-Remaining: 3200000     # Token 剩余量
X-Token-Quota-Period-Remaining: 80%  # 周期内 Token 剩余百分比
```

### D. 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|:----:|--------|------|
| `MULTITENANT` | 是 | `false` | 启用多用户模式 |
| `ADMIN_USERNAME` | 首次启动 | — | 初始管理员用户名 |
| `ADMIN_PASSWORD` | 首次启动 | — | 初始管理员密码 |
| `JWT_SECRET` | 推荐 | — | JWT 签名密钥（推荐 32+ 字符） |
| `DATABASE_PATH` | 否 | `~/.aicodeswitch/aicodeswitch.db` | SQLite 数据库路径 |
| `PORT` | 否 | `4567` | 服务端口 |
| `HOST` | 否 | `0.0.0.0` | 绑定地址（多用户版默认监听所有接口） |

### E. CLI 命令扩展

```bash
# 管理员管理
aicos admin create --username <name> --password <pwd> [--role admin|super_admin]
aicos admin list
aicos admin reset-password --username <name> --password <new-pwd>

# 用户管理
aicos tenant create --name <name> [--remark <text>] [--policy <id>] [--tag <tag>]
aicos tenant list [--status active|suspended] [--tag <tag>]
aicos tenant show <id>
aicos tenant suspend <id>
aicos tenant activate <id>
aicos tenant regenerate-key <id>
aicos tenant delete <id>

# 策略管理
aicos policy list
aicos policy show <id>
aicos policy create --name <name>
```

### F. 术语表

| 术语 | 英文 | 说明 |
|------|------|------|
| 租户 | Tenant | 多用户版中的终端用户 |
| 路由策略 | Route Policy | 可复用的路由配置集合 |
| 配额 | Quota | 对用户使用量的多维限制 |
| 管理员 | Admin | 管理后台的操作者 |
| 超级管理员 | Super Admin | 拥有所有权限的管理员 |
