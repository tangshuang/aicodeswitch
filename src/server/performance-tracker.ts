/**
 * ServicePerformanceTracker - 服务性能统计全局聚合模块
 *
 * 设计要点（详见 docs/PRD/service-performance-tpm.md）：
 * - 全局统计，与 AUTH 模式无关；普通路由 + AccessKey 路由流量统一采集。
 * - 两个数据点：TTFT（首 Token 返回时间）、TPM（每分钟吐 token 数）。
 * - 三级聚合：供应商 → 服务 → 模型；上卷基于 sum+count 加权，avg 由 sum/count 派生。
 * - 走势按小时桶（键 "YYYY-MM-DD HH"，保留 72 桶）。
 * - 内存增量 + debounce(5s) flush + 原子写（tmp+rename）。
 *
 * recordPerformance 为纯内存同步操作，可在请求完成路径无开销调用。
 */
import path from 'path';
import fs from 'fs/promises';
import type {
  ServicePerformanceFile,
  PerfAggregate,
  PerfBucket,
  PerfDerived,
  PerfTrendPoint,
} from '../types';

const HOURLY_BUCKET_LIMIT = 72; // 保留最近 72 个小时桶（约 3 天）

export interface PerformanceMetrics {
  ttftMs?: number;
  tokensPerSecond?: number;       // tps（TPM/60）
  outputTokens?: number;
  timingAccuracy: 'precise' | 'estimated';
  isError: boolean;
}

export class ServicePerformanceTracker {
  private dataPath: string;
  private file: ServicePerformanceFile = { vendors: {} };
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly FLUSH_INTERVAL = 5000; // 5s

  constructor(dataPath: string) {
    this.dataPath = dataPath;
  }

  /** 初始化：加载已有数据文件 */
  async initialize(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as ServicePerformanceFile;
      if (parsed && parsed.vendors) this.file = parsed;
    } catch {
      // 首次启动或文件损坏，使用空桶
      this.file = { vendors: {} };
    }
  }

  /**
   * 记录一次请求的性能数据点（三级同步聚合）。
   * 纯内存操作，不阻塞调用方。
   */
  recordPerformance(
    vendorId: string | undefined,
    vendorName: string | undefined,
    serviceId: string,
    serviceName: string | undefined,
    model: string | undefined,
    metrics: PerformanceMetrics,
    timestamp: number = Date.now(),
  ): void {
    if (!vendorId || !serviceId || !model) return;

    const hour = this.formatHourKey(timestamp);

    // 模型级（最细，维护极值）
    const modelAgg = this.ensureModel(vendorId, vendorName, serviceId, serviceName, model);
    this.accumulate(modelAgg, metrics, hour, /* withExtremes */ true);

    // 服务级上卷
    const serviceAgg = this.ensureService(vendorId, vendorName, serviceId, serviceName);
    this.accumulate(serviceAgg, metrics, hour, /* withExtremes */ false);

    // 供应商级上卷
    const vendorAgg = this.ensureVendor(vendorId, vendorName);
    this.accumulate(vendorAgg, metrics, hour, /* withExtremes */ false);

    this.dirty = true;
  }

  // ---------------- 读取（派生视图） ----------------

  /** 全部供应商一览（vendorRollup 派生） */
  getVendorsOverview(): Array<{ vendorId: string; vendorName?: string; derived: PerfDerived }> {
    return Object.entries(this.file.vendors).map(([vendorId, v]) => ({
      vendorId,
      vendorName: v.vendorName,
      derived: this.derive(v.vendorRollup),
    }));
  }

  /** 全部 API 服务平铺一览（含所属供应商），用于「API 服务」维度对比 */
  getServicesOverview(): Array<{
    serviceId: string;
    serviceName?: string;
    vendorId: string;
    vendorName?: string;
    derived: PerfDerived;
  }> {
    const out: Array<{ serviceId: string; serviceName?: string; vendorId: string; vendorName?: string; derived: PerfDerived }> = [];
    for (const [vendorId, v] of Object.entries(this.file.vendors)) {
      for (const [serviceId, s] of Object.entries(v.services)) {
        out.push({
          serviceId,
          serviceName: s.serviceName,
          vendorId,
          vendorName: v.vendorName,
          derived: this.derive(s.serviceRollup),
        });
      }
    }
    return out;
  }

  /** 某供应商：自身 rollup + 其下所有服务 rollup */
  getVendorDetail(vendorId: string): {
    vendorName?: string;
    derived: PerfDerived;
    hourly: PerfTrendPoint[];
    services: Array<{ serviceId: string; serviceName?: string; derived: PerfDerived }>;
  } | null {
    const v = this.file.vendors[vendorId];
    if (!v) return null;
    return {
      vendorName: v.vendorName,
      derived: this.derive(v.vendorRollup),
      hourly: this.trendFrom(vendorId, undefined, undefined),
      services: Object.entries(v.services).map(([serviceId, s]) => ({
        serviceId,
        serviceName: s.serviceName,
        derived: this.derive(s.serviceRollup),
      })),
    };
  }

  /** 某服务：自身 rollup + 其下所有模型 */
  getServiceDetail(serviceId: string): {
    vendorId?: string;
    vendorName?: string;
    serviceName?: string;
    derived: PerfDerived;
    hourly: PerfTrendPoint[];
    models: Array<{ model: string; derived: PerfDerived }>;
  } | null {
    const found = this.locateService(serviceId);
    if (!found) return null;
    const { vendorId, vendorName, serviceEntry } = found;
    return {
      vendorId,
      vendorName,
      serviceName: serviceEntry.serviceName,
      derived: this.derive(serviceEntry.serviceRollup),
      hourly: this.trendFrom(vendorId, serviceId, undefined),
      models: Object.entries(serviceEntry.models).map(([model, agg]) => ({
        model,
        derived: this.derive(agg),
      })),
    };
  }

  /** 单模型：派生 + 小时走势 + 极值 */
  getModelDetail(serviceId: string, model: string): {
    derived: PerfDerived;
    hourly: PerfTrendPoint[];
  } | null {
    const found = this.locateService(serviceId);
    if (!found) return null;
    const agg = found.serviceEntry.models[model];
    if (!agg) return null;
    return {
      derived: this.derive(agg),
      hourly: this.trendFrom(found.vendorId, serviceId, model),
    };
  }

  // ---------------- 持久化 ----------------

  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    await this.save();
  }

  startAutoFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      this.flush().catch(err => console.error('[PerformanceTracker] Auto flush error:', err));
    }, this.FLUSH_INTERVAL);
  }

  stopAutoFlush(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private get filePath(): string {
    return path.join(this.dataPath, 'service-performance.json');
  }

  private async save(): Promise<void> {
    const tmp = this.filePath + '.tmp';
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(this.file, null, 2), 'utf-8');
    await fs.rename(tmp, this.filePath);
  }

  // ---------------- 内部：结构创建 ----------------

  private ensureVendor(vendorId: string, vendorName?: string): PerfAggregate {
    let v = this.file.vendors[vendorId];
    if (!v) {
      v = {
        vendorName,
        vendorRollup: this.emptyAggregate(),
        services: {},
      };
      this.file.vendors[vendorId] = v;
    }
    if (vendorName && !v.vendorName) v.vendorName = vendorName;
    return v.vendorRollup;
  }

  private ensureService(vendorId: string, vendorName: string | undefined, serviceId: string, serviceName?: string): PerfAggregate {
    const v = this.file.vendors[vendorId] ?? (this.file.vendors[vendorId] = {
      vendorName, vendorRollup: this.emptyAggregate(), services: {},
    });
    let s = v.services[serviceId];
    if (!s) {
      s = {
        serviceName,
        serviceRollup: this.emptyAggregate(),
        models: {},
        updatedAt: Date.now(),
      };
      v.services[serviceId] = s;
    }
    if (serviceName && !s.serviceName) s.serviceName = serviceName;
    s.updatedAt = Date.now();
    return s.serviceRollup;
  }

  private ensureModel(vendorId: string, vendorName: string | undefined, serviceId: string, serviceName: string | undefined, model: string): PerfAggregate {
    // 确保供应商 + 服务节点存在（service rollup 由 recordPerformance 单独累加）
    this.ensureService(vendorId, vendorName, serviceId, serviceName);
    const s = this.file.vendors[vendorId].services[serviceId];
    let m = s.models[model];
    if (!m) {
      m = this.emptyAggregate();
      s.models[model] = m;
    }
    return m;
  }

  // ---------------- 内部：累加 ----------------

  private emptyAggregate(): PerfAggregate {
    return {
      precise: this.emptyBucket(),
      estimated: this.emptyBucket(),
      errorCount: 0,
      hourly: {},
    };
  }

  private emptyBucket(): PerfBucket {
    return { count: 0, sumTtftMs: 0, sumTps: 0, totalOutputTokens: 0 };
  }

  private accumulate(agg: PerfAggregate, m: PerformanceMetrics, hour: string, withExtremes: boolean): void {
    if (m.isError) {
      agg.errorCount += 1;
      return;
    }
    const bucket = m.timingAccuracy === 'precise' ? agg.precise : agg.estimated;
    const hasTtft = m.timingAccuracy === 'precise' && typeof m.ttftMs === 'number';
    const hasTps = typeof m.tokensPerSecond === 'number';

    bucket.count += 1;
    if (hasTtft) bucket.sumTtftMs += m.ttftMs!;
    if (hasTps) bucket.sumTps += m.tokensPerSecond!;
    if (m.outputTokens) bucket.totalOutputTokens += m.outputTokens;

    // 小时桶（仅精确样本计入走势，避免估算样本污染）
    if (m.timingAccuracy === 'precise') {
      const hb = agg.hourly[hour] ?? (agg.hourly[hour] = this.emptyBucket());
      hb.count += 1;
      if (hasTtft) hb.sumTtftMs += m.ttftMs!;
      if (hasTps) hb.sumTps += m.tokensPerSecond!;
      if (m.outputTokens) hb.totalOutputTokens += m.outputTokens;
      this.trimHourly(agg.hourly);
    }

    // 极值（仅模型级、仅精确样本）
    if (withExtremes && m.timingAccuracy === 'precise') {
      if (hasTtft) {
        if (agg.minTtftMs === undefined || m.ttftMs! < agg.minTtftMs) agg.minTtftMs = m.ttftMs!;
        if (agg.maxTtftMs === undefined || m.ttftMs! > agg.maxTtftMs) agg.maxTtftMs = m.ttftMs!;
      }
      if (hasTps) {
        if (agg.minTps === undefined || m.tokensPerSecond! < agg.minTps) agg.minTps = m.tokensPerSecond!;
        if (agg.maxTps === undefined || m.tokensPerSecond! > agg.maxTps) agg.maxTps = m.tokensPerSecond!;
      }
    }
  }

  private trimHourly(hourly: Record<string, PerfBucket>): void {
    const keys = Object.keys(hourly);
    if (keys.length <= HOURLY_BUCKET_LIMIT) return;
    keys.sort(); // "YYYY-MM-DD HH" 字典序即时间序
    const drop = keys.length - HOURLY_BUCKET_LIMIT;
    for (let i = 0; i < drop; i++) delete hourly[keys[i]];
  }

  // ---------------- 内部：派生 ----------------

  private derive(agg: PerfAggregate): PerfDerived {
    const p = agg.precise;
    const count = p.count;
    const avgTtftMs = count > 0 ? p.sumTtftMs / count : 0;
    const avgTps = count > 0 ? p.sumTps / count : 0;
    return {
      count,
      avgTtftMs,
      avgTpm: avgTps * 60,
      minTtftMs: agg.minTtftMs,
      maxTtftMs: agg.maxTtftMs,
      minTps: agg.minTps,
      maxTps: agg.maxTps,
      errorCount: agg.errorCount,
      totalOutputTokens: p.totalOutputTokens,
      successRate: count + agg.errorCount > 0 ? count / (count + agg.errorCount) : 0,
    };
  }

  private trendFrom(vendorId: string, serviceId: string | undefined, model: string | undefined): PerfTrendPoint[] {
    const v = this.file.vendors[vendorId];
    if (!v) return [];
    let agg: PerfAggregate | undefined;
    if (model && serviceId) {
      agg = v.services[serviceId]?.models[model];
    } else if (serviceId) {
      agg = v.services[serviceId]?.serviceRollup;
    } else {
      agg = v.vendorRollup;
    }
    if (!agg) return [];
    return Object.entries(agg.hourly)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([hour, b]) => ({
        hour,
        count: b.count,
        avgTtftMs: b.count > 0 ? b.sumTtftMs / b.count : 0,
        avgTpm: b.count > 0 ? (b.sumTps / b.count) * 60 : 0,
      }));
  }

  private locateService(serviceId: string): {
    vendorId: string;
    vendorName?: string;
    serviceEntry: ServicePerformanceFile['vendors'][string]['services'][string];
  } | null {
    for (const [vendorId, v] of Object.entries(this.file.vendors)) {
      const s = v.services[serviceId];
      if (s) return { vendorId, vendorName: v.vendorName, serviceEntry: s };
    }
    return null;
  }

  private formatHourKey(ts: number): string {
    const d = new Date(ts);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}`;
  }
}
