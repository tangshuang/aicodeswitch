# 供应商服务测速与吞吐统计（被动流量）PRD

> 版本：v1.1　|　日期：2026-06-17　|　状态：设计中
>
> v1.1 变更：固化两个数据点（首 Token 返回时间 TTFT / TPM）的逐次记录与**模型 → 服务 → 供应商**三级上卷；聚合层改用 `sum + count` 加权（替代滚动平均）；走势统一为小时桶。
>
> v1.2 变更：明确为**全局统计指标**——与 AUTH 模式无关（AUTH 开启/关闭、普通路由 / AccessKey 路由均统一采集）；使用**独立全局数据桶**；UI 集成进现有「数据统计」页面，提供指标 / 维度 / 时段筛选。

## 1. 背景与目标

AICodeSwitch 目前缺少让用户了解「某个供应商的服务（以及其下某个模型）在真实编程过程中表现究竟如何」的能力。用户希望在编程时**被动、自动**地采集每个服务的速度数据，并以 **TPM（每分钟吐多少 token）** 为核心指标，做统计与对比。

### 1.1 设计决策（已与用户对齐）

| 维度 | 决策 |
|---|---|
| 数据来源 | **被动真实流量统计**——不主动向上游发探测请求，零额外开销、零额外费用，只基于代理转发的真实请求 |
| 触发方式 | **编程过程中自动采集**——无手动按钮、无定时任务，在代理转发管道里自动打点 |
| 采集范围 | **服务下全部模型**——对每个服务的每个模型分别统计 |
| 时段维度 | **按小时分桶**（走势统一小时桶，支持 24h / 7d / 30d 切换） |
| **统计范围** | **全局统计指标，与 AUTH 模式无关**——无论 AUTH 开启或关闭、请求走普通路由还是 AccessKey 路由，都统一采集进同一个全局桶；不按 key / 用户隔离 |
| **存储位置** | **独立全局数据桶** `~/.aicodeswitch/data/service-performance.json`，与现有 logs / AccessKey 用量统计完全解耦 |
| **UI 位置** | 集成进现有「数据统计」页面（`StatisticsPage`），通过**指标 / 维度 / 时段筛选**查看，不新增独立菜单 |

### 1.2 现状痛点

- `RequestLog`（`src/types/index.ts:181-216`）已记录 `responseTime`、`usage.outputTokens`、`targetServiceId`、`vendorId`、`targetModel`、`timestamp`，**原始数据基本齐全**。
- 但 `responseTime` 是**端到端**耗时（含网络往返 + 首延迟 + 生成 + 尾处理），直接用来算吞吐会严重偏低，无法反映模型真实的"吐字速度"。
- 没有任何按「服务 × 模型 × 时段」的吞吐聚合视图，`StatisticsPage` 只有总览级的 `avgResponseTime`。

### 1.3 目标产出

在不改变现有代理转发行为、不影响性能的前提下，新增一条链路：

```
流式管道打点  →  增量聚合（服务×模型×时段）  →  按时段统计  →  前端可视化
```

---

## 2. 核心指标定义

本功能采集**两个数据点**，均为「**以 API 服务中的模型为维度，记录每一次请求**」的原始测量值；在此基础上再做聚合统计。

> 时间锚点（由流式打点采集，见第 3 章）：
> - `requestStartAt`：代理向上游发起请求的时刻（已有 `startTime`）
> - `firstTokenAt`：第一个 token 返回的时刻（首个被解析出的 SSE 内容事件）
> - `lastTokenAt`：整个返回结束的时刻（最后一个 SSE 事件）

### 2.1 数据点 A：首 Token 返回时间（TTFT）

- **定义**：从**请求发起**到**第一个 token 返回**的时间。
- **单次计算**：`TTFT = firstTokenAt − requestStartAt`（毫秒）。
- **记录粒度**：以「API 服务 × 模型」为维度，记录该模型**每一次请求**的 TTFT。
- **可统计项**：
  - 该模型的 TTFT 平均值、按**小时**走势（hourly bucket）；
  - 在此基础上**上卷**得到「该 API 服务」的首 Token 平均时长；
  - 进一步上卷得到「该供应商」的首 Token 平均时长。

### 2.2 数据点 B：TPM（每分钟吐多少 token）

- **定义**：从**第一个 token 开始返回**，到**整个返回结束**，每分钟吐多少 token。
- **单次计算**：
  ```
  generationSec = (lastTokenAt − firstTokenAt) / 1000
  TPM_request   = outputTokens / generationSec × 60
  ```
  其中 `outputTokens` 来自上游 usage（提取逻辑见 `proxy-server.ts:3654-3731`）。该指标衡量「该模型在吐字时每分钟能输出多少 token」。
- **记录粒度**：以「API 服务 × 模型」为维度，记录该模型**每一次请求**的 TPM（同时保留 `outputTokens` 与 `generationMs`，便于精确上卷）。
- **可统计项**：
  - 该模型的 TPM 平均值、按**小时**走势；
  - 上卷得到「该 API 服务」的 TPM；
  - 进一步上卷得到「该供应商」的 TPM。

### 2.3 聚合层级（三级上卷）

```
供应商 (Vendor)
   └── API 服务 (Service)        ← 其下所有模型加权聚合
          └── 模型 (Model)        ← 每一次请求的原始数据点在此聚合
```

每一级都产出两个指标的：**平均值** + **按小时走势** + 样本数 / 成功率。

- 上卷采用**加权聚合**（基于 `sum + count`），而非简单平均的平均，保证三级数学自洽：
  ```
  levelAvg = Σ(value_i × count_i) / Σ(count_i)
  ```
  因此聚合层在每个桶/总览里存 **`count` + 求和字段**（`sumTtftMs` / `sumTps` / `totalOutputTokens`），avg 由 `sum/count` 派生。
- min / max 仅在**模型级**精确保留；服务级 / 供应商级取「其下子项 min 的最小、max 的最大」作为参考。

### 2.4 非流式与失败请求的口径

- **非流式分支**：无法拆分首/末 token，TTFT 与精确 TPM 不可得，标记 `timingAccuracy = 'estimated'`；TPM 用端到端 `outputTokens / responseSec × 60` 近似，统计时与精确值**分开存放**，不污染精确口径。
- **失败 / 超时请求**：仍记录（status=error），计入错误率与样本数，吞吐字段留空，不参与 TTFT/TPM 均值。

### 2.5 重要边界

本功能的 TPM 是**单请求生成吞吐率**，反映"吐字快慢"，**不是**集群并发容量（后者还取决于并发数）。PRD 与 UI 文案需明确标注，避免误读。

---

## 3. 数据采集层（代理转发管道打点）

### 3.1 现状

现有流式管道已在两处组装：
- 主路径：`src/server/proxy-server.ts:4504-4515`
- fallback 路径：`src/server/proxy-server.ts:5407-5410`

均使用 `SSEEventCollectorTransform`（来自 `src/server/transformers/chunk-collector.ts`）。

### 3.2 方案

**新增 `StreamTimingTransform`**（一个极简 `Transform`），插入到 SSE 解析管道中，记录：
- `firstEventAt`：首个被解析出的 SSE 内容事件时间戳（TTFT 起点）
- `lastEventAt`：最后一个 SSE 事件时间戳（生成结束点）

通过实例属性暴露给 `proxyRequest`。

### 3.3 指标计算

`proxyRequest`（`3747` 已有 `startTime`，结束时已有 `responseTime`）补充计算并写入日志：

| 字段 | 计算 |
|---|---|
| `ttftMs` | `firstEventAt − startTime`（首 token 延迟） |
| `generationMs` | `lastEventAt − firstEventAt`（纯生成阶段） |
| `tokensPerSecond` | `outputTokens / (generationMs/1000)`（outputTokens 来自现有提取逻辑 `3654-3731`） |
| `timingAccuracy` | 流式 = `'precise'` |

### 3.4 采集点的全局性（与 AUTH 无关）

性能数据点是一个**全局统计指标**，采集点设在代理引擎转发完成的统一出口处（两条流式路径 + 非流式路径的日志构造点），独立于现有日志 / AccessKey 用量体系：

- **AUTH 开启或关闭都采集**：不读取 `isAuthEnabled()`，不做 key 校验，仅依据转发是否发生、上游服务/模型是谁。
- **普通路由流量与 AccessKey 路由流量都纳入**：AccessKey（`sk_`）请求虽使用独立日志与配额体系（`key-logs/`、`key-usage/`），但其请求仍经同一代理引擎转发到上游服务，因此在引擎出口同样产生一个性能数据点，写入**全局** `service-performance.json`。
- **以「上游服务 × 模型」为唯一主键**，不含 key / 用户 / session 信息，天然脱敏、可全局聚合。
- 该采集**不替代**也**不影响** AccessKey 自身的独立日志与用量统计，两者并行、互不污染。

> **挂载点（已核实 `proxy-server.ts` 代码）：**
> - 共有**两条转发路径**：标准路径 `proxyRequest`（`3738`，处理 `/v1/*`）与 API 路径 `proxyRequestForApiPath`（`5091`，处理 `/claude-code/`、`/codex/` 直连）。两条都需挂采集点，共**两个挂载点**。
> - **AccessKey 与普通路由在 `proxyRequest` 内合流**，无需为 AccessKey 单独挂载。其完成处理在 `~3949` 分两支：AccessKey 分支（`3949-4046`，写 `keyLogger` 后 `return`，跳过全局 `addLog`）与普通分支（`4061 dbManager.addLog`）。两支分叉前的**公共点（`~3946` 之后）**已具备 `usageForLog` / `statusCode` / `startTime` / `service` / `vendor` / `targetModel` 全部数据——`recordPerformance` 挂在此公共点即同时覆盖 AccessKey + 普通路由。
> - `proxyRequestForApiPath` 的完成处（`~5148` / `~5229`）同样挂一次。
> - **早期失败 / 未真正转发到上游**的 `logToolRequest` 点（`530-1283`）不计入性能样本（可选计入 `errorCount`），避免无 timing 数据污染均值。
> - 与 `enableLogging` 的关系：公共点位于 `enableLogging` 检查（`3942`）之后；若希望「关闭日志仍采集性能」，需将采集点提到该检查之前，使其独立于日志开关。

### 3.5 分支处理

- **非流式分支**：无首/末 token 拆分，`ttftMs`/`generationMs` 留空，`tokensPerSecond = outputTokens / responseTime*1000`，`timingAccuracy = 'estimated'`。
- **失败 / 超时请求**：仍记录（status=error），吞吐字段留空，计入错误率，不污染吞吐均值。

### 3.6 `RequestLog` 类型扩展

`src/types/index.ts` 新增可选字段，向后兼容（旧日志缺字段则不参与精确吞吐统计）：

```ts
ttftMs?: number;
generationMs?: number;
tokensPerSecond?: number;     // 等效 tokens/s
timingAccuracy?: 'precise' | 'estimated';
```

---

## 4. 存储与聚合层（`ServicePerformanceTracker`）

### 4.1 两层存储

| 层 | 载体 | 说明 |
|---|---|---|
| **明细层（原始数据点）** | `RequestLog`（已有分片 `logs-YYYY-MM-DD.json`） | 每一次请求记录一个数据点：`ttftMs` / `generationMs` / `tokensPerSecond` / `outputTokens` / `timingAccuracy` + 已有的 `targetServiceId` / `vendorId` / `targetModel` / `timestamp`。这是「模型每一次的记录」，不重复造存储。 |
| **聚合层** | 新文件 `~/.aicodeswitch/data/service-performance.json` | 按「供应商 → 服务 → 模型」三级增量聚合，前端直接读取，避免每次扫全量日志。 |

### 4.2 设计范式

仿照现有可复用范式：
- `access-keys/usage-tracker.ts`：debounce flush + 原子写
- `access-keys/quota-checker.ts`：内存计数 + 时间窗

**新增模块 `src/server/performance-tracker.ts`**：

- `recordPerformance(serviceId, vendorId, model, metrics, timestamp)`：在 `proxyRequest` 完成、构造 `RequestLog` 的同一处调用一次（主路径 `proxy-server.ts:3954-4030` 区域，以及 fallback/降级路径）。
- **加权聚合**（不用滚动平均，以支持三级上卷）：聚合层在每个节点存 `count + 求和字段`：
  - 精确样本（流式）：累加进 `sumTtftMs` / `sumTps`（tps = tokensPerSecond）/ `preciseCount` / `totalOutputTokens`，并更新模型级 `minTtftMs/maxTtftMs/minTps/maxTps`。
  - 估算样本（非流式）：累加进独立的 `estimatedCount` / `estimatedSumTps`，不混入精确口径。
  - 失败样本：累加 `errorCount`，不动吞吐求和。
  - avg 全部由 `sum / count` 派生。
- **小时走势桶**：键 `YYYY-MM-DD HH`，保留最近 **72 桶**（约 3 天）。桶内同样存 `count + sumTtftMs + sumTps + totalOutputTokens`，用于任一级别的按小时走势。按天桶（`YYYY-MM-DD`，30 天）作为更粗粒度可选视图。
- **服务级 / 供应商级上卷**：在 `recordPerformance` 写模型级的同时，增量更新对应 `serviceRollup` 与 `vendorRollup`（同样 `count + sum` 结构 + hourly 桶）。三级数据一次性写齐，读取时无需现算。
- 持久化：内存缓存 + 5s debounce flush + 原子写（tmp+rename）。

### 4.3 聚合数据结构

```ts
// 可复用的聚合单元：总览 + 小时走势
interface PerfBucket {
  count: number;            // 精确样本数
  sumTtftMs: number;
  sumTps: number;           // Σ tokensPerSecond
  totalOutputTokens: number;
}
interface PerfAggregate {
  precise: PerfBucket;      // 流式精确口径
  estimated: PerfBucket;    // 非流式端到端估算（TPM 用，TTFT 不计）
  errorCount: number;
  // 模型级独有：极值（仅精确样本）
  minTtftMs?: number; maxTtftMs?: number;
  minTps?: number;    maxTps?: number;
  hourly: Record<string, PerfBucket>;   // 键 "YYYY-MM-DD HH"，72 桶
  daily?: Record<string, PerfBucket>;   // 键 "YYYY-MM-DD"，30 天
}

interface ServicePerformanceFile {
  vendors: {
    [vendorId: string]: {
      vendorName?: string;
      vendorRollup: PerfAggregate;                 // 供应商级
      services: {
        [serviceId: string]: {
          serviceName?: string;
          serviceRollup: PerfAggregate;            // 服务级
          models: {
            [model: string]: PerfAggregate;        // 模型级（最细）
          };
          updatedAt: number;
        };
      };
    };
  };
}
```

> 派生读取：`avgTtftMs = precise.sumTtftMs / precise.count`；`avgTpm = precise.sumTps / precise.count × 60`；`successRate = precise.count / (precise.count + errorCount)`。服务级 / 供应商级同理（其 `sum` 已是子项之和）。

### 4.4 历史回填（可选，低优先）

提供一次性脚本 `scripts/rebuild-performance.ts`，扫描已分片的 `logs-YYYY-MM-DD.json` 回填聚合（旧日志无 `ttftMs/generationMs` → 全部落入 `estimated` 口径）。默认不做自动回填。

---

## 5. API 层

在 `src/server/main.ts` 注册，沿用现有 `/api/*` + `authMiddleware` 模式。按三级层级提供读取端点，走势统一以小时桶返回：

| 端点 | 用途 |
|---|---|
| `GET /api/performance/vendors` | 全供应商一览：每个供应商的 `vendorRollup`（avg TTFT / avg TPM / 样本数 / 成功率 / hourly 走势），供顶层对比 |
| `GET /api/performance/vendors/:vid` | 某供应商详情：`vendorRollup` + 其下所有 `serviceRollup` |
| `GET /api/performance/services/:sid` | 某服务详情：`serviceRollup` + 其下所有模型级 `PerfAggregate`（avg TTFT / avg TPM / min/max / 样本数 / hourly） |
| `GET /api/performance/services/:sid/models/:model` | 单模型详情：该模型的 hourly 走势 + 极值（最细粒度下钻） |
| `POST /api/performance/rebuild`（可选） | 从 logs 回填（管理员/调试用） |

查询参数统一支持 `?hours=24|168|720`（小时桶范围：24h / 7d / 30d）。

---

## 6. 前端层（集成进「数据统计」页面）

UI 不新增独立菜单，而是在现有 **「数据统计」页面（`src/ui/pages/StatisticsPage.tsx`）** 内新增一个「**服务性能 / 测速**」区块（Tab 或卡片），通过筛选器切换查看。

### 6.1 筛选器（三轴）

| 筛选轴 | 选项 | 说明 |
|---|---|---|
| **指标** | 首 Token 返回时间 (TTFT) / TPM | 对应第 2 章两个数据点，单选切换主指标 |
| **维度（分组）** | 供应商 / API 服务 / 模型 | 决定对比表与走势按哪一级聚合（三级上卷） |
| **时段** | 近 24 小时 / 近 7 天 / 近 30 天 | 控制小时桶范围（`?hours=24\|168\|720`） |

可选级联筛选：选定供应商 → 可再选该供应商下的服务 → 模型，实现下钻。

### 6.2 展示区

- **对比表**：按所选维度列出每一项的「avg TTFT / avg TPM / 样本数 / 成功率 / 最近更新」，点行下钻到下一级。
- **走势图**（recharts，复用 `StatisticsPage.tsx` 图表模式）：所选指标按**小时**的折线走势；模型级额外展示 min / avg / max。
- 指标切换时，对比表与走势图随之联动；维度切换时，对比表重新分组。

### 6.3 i18n

3 locale（en / zh-CN / zh-TW）补全所有新文案，遵循 CLAUDE.md 规则。禁用 GPU 依赖的 CSS。

> 因 UI 已集中在数据统计页，**不再**在 `VendorsPage` 增加列、也**不**新增 `ServicePerformancePage` 独立页面。

---

## 7. 关键复用点（避免重造）

| 用途 | 现成资产 | 路径 |
|---|---|---|
| 流式事件收集 / 打点位置 | `SSEEventCollectorTransform` | `src/server/transformers/chunk-collector.ts` |
| 增量统计 / 分桶范式（加权求和替代滚动平均） | `updateStatistics`（结构参考） | `src/server/fs-database.ts:2818` |
| debounce flush + 原子写范式 | `UsageTracker` | `src/server/access-keys/usage-tracker.ts` |
| 滑动窗口 / 时段思路 | `QuotaChecker.rpmTracker` | `src/server/access-keys/quota-checker.ts` |
| token 跨格式归一 | `usage.ts` 映射函数 | `src/server/conversions/utils/usage.ts` |
| 前端图表范式 | `StatisticsPage.tsx`（recharts） | `src/ui/pages/StatisticsPage.tsx` |
| API 客户端封装范式 | `requestJson(buildUrl(...))` | `src/ui/api/client.ts` |
| 服务/供应商元信息 | `getVendorByServiceId` 等 | `src/server/fs-database.ts` |

---

## 8. 涉及文件清单

### 新增

- `src/server/performance-tracker.ts`（核心聚合模块，全局唯一桶）
- `src/server/transformers/stream-timing-transform.ts`（流式打点 Transform）
- `scripts/rebuild-performance.ts`（可选，历史回填）

### 修改

- `src/types/index.ts`：`RequestLog` 加 4 个可选字段；新增 `ServicePerformance*` 类型
- `src/server/proxy-server.ts`：流式两处路径（`4504` 主、`5407` API path）注入 timing transform；在两条转发路径的完成处挂载 `recordPerformance`——`proxyRequest` 公共点（`~3946`，同时覆盖 AccessKey 与普通路由）+ `proxyRequestForApiPath` 完成处（`~5148/5229`）
- `src/server/main.ts`：注册 `/api/performance/*` 路由；初始化全局 tracker
- `src/server/fs-database.ts`：可选集成 tracker 生命周期（或独立 init）
- `src/ui/api/client.ts`：新增 `getPerformanceVendors` / `getPerformanceVendor` / `getPerformanceService` / `getPerformanceModel` 封装
- `src/ui/pages/StatisticsPage.tsx`：新增「服务性能 / 测速」区块 + 指标/维度/时段筛选器 + 对比表 + 走势图
- `src/ui/i18n/locales/{en,zh-CN,zh-TW}.json`：3 语种文案

---

## 9. 验证方式

1. **采集验证**：`npm run dev:server` 启动后，用 Claude Code / Codex 跑几次真实编程请求（含流式与非流式），检查 `~/.aicodeswitch/data/service-performance.json` 出现对应 `serviceId → model` 记录，且 `avgTokensPerSecond`、`avgTtftMs` 合理（非 0、非端到端偏低值）。
2. **时段分桶验证**：跨小时 / 跨天再发请求，确认 `hourly` / `daily` 正确分桶、桶内均值随新样本滚动更新。
3. **API 验证**：`GET /api/services/:id/performance` 与 `GET /api/performance/overview` 返回结构与 JSON 一致。
4. **前端验证**：打开新页面，确认对比表、时段切换、趋势折线渲染正确，3 语种切换无误。
5. **非流式 / 失败请求验证**：构造一个非流式请求与一个会超时 / 报错的请求，确认前者标 `estimated`、后者计入错误率且不污染吞吐均值。

> 注：遵守 CLAUDE.md，禁止运行 `dev:ui` / `dev:server` / `tauri:dev` 等命令做自动化测试，仅人工联调。

---

## 10. 范围说明与未来扩展

- **不做主动探测**：当前完全被动。若未来需要"无流量时也能测"，可扩展主动探测模块（复用 `transformRequestToUpstream` + axios stream）作为独立可选功能，不影响本次设计。
- **不做定时自动测速**：被动采集已天然覆盖"持续统计"，无需 cron。
- **P50 / 分位数**：当前用 min / avg / max + 时段桶近似；精确分位数需保留分布或采样，暂不引入，待需要时扩展。
