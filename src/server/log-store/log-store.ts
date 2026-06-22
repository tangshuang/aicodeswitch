/**
 * LogStore —— 追加写 NDJSON 日志存储
 *
 * 设计要点：
 * - 每条日志一行（NDJSON），按 namespace 分目录，文件按日期 + 大小滚动，**只追加不重写**。
 * - append 在 per-file 锁内「先 stat 取 size 作 offset，再 append」，保证字节偏移严格对应。
 * - 会话索引 sessionRefs 存 {file, offset, length, timestamp, logId}；追加写下偏移永远稳定，
 *   按会话取日志 = 按字节范围随机读，零邻居解析。
 * - 查询 getRecent/search 流式逐行扫，内存只持轻量描述符 + 当前页；切页后按字节范围回填正文。
 * - 会话级删除用 tombstone（按 id），追加写无需重写文件。
 *
 * 仅依赖 node:fs / node:path / node:crypto，零原生依赖。
 */
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { RequestLog } from '../../types';
import type {
  Namespace,
  ShardMeta,
  SessionRef,
  TimelineEntry,
  LogFilter,
  LogQueryOpts,
  LogQueryResult,
  LogStoreQueryOpts,
  AppendResult,
} from './types';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB 滚动新文件
const FLUSH_DELAY = 3000;
const FLUSH_THRESHOLD = 50;
const READ_CHUNK = 64 * 1024;

/** 从日志推导 sessionId（与 fs-database.extractSessionIdFromLog 同源逻辑） */
function extractSessionId(log: RequestLog): string | null {
  const headers: any = log.headers || {};
  const headerSessionId = headers['session-id'] || headers['session_id'];
  if (typeof headerSessionId === 'string') return headerSessionId;
  if (log.body) {
    try {
      const body = typeof log.body === 'string' ? JSON.parse(log.body) : log.body;
      if (body?.metadata?.user_id) {
        const userId = body.metadata.user_id;
        try {
          const parsed = JSON.parse(userId);
          if (parsed && typeof parsed === 'object' && parsed.session_id) {
            return parsed.session_id;
          }
        } catch {
          return userId;
        }
      }
    } catch {
      // 忽略
    }
  }
  return null;
}

function utcDate(ts: number): string {
  return new Date(ts).toISOString().split('T')[0];
}

/** 判断一条记录（描述符或已解析日志）是否命中字段筛选条件（AND 组合） */
function matchEntry(rec: { targetType?: string; vendorId?: string; targetServiceId?: string; targetModel?: string; routeId?: string }, filters: LogFilter): boolean {
  if (filters.targetType && rec.targetType !== filters.targetType) return false;
  if (filters.vendorId && rec.vendorId !== filters.vendorId) return false;
  if (filters.targetServiceId && rec.targetServiceId !== filters.targetServiceId) return false;
  if (filters.targetModel && rec.targetModel !== filters.targetModel) return false;
  if (filters.routeId && rec.routeId !== filters.routeId) return false;
  return true;
}

/** 筛选条件是否非空 */
function hasFilters(filters?: LogFilter): boolean {
  return !!(filters && (filters.targetType || filters.vendorId || filters.targetServiceId || filters.targetModel || filters.routeId));
}

function nsDirName(ns: Namespace): string {
  // 'global' -> 'global'；'key:{keyId}' -> 直接用 keyId 作目录名（keyId 本身已带 key_ 前缀，避免 key-key_ 重复）
  return ns === 'global' ? 'global' : ns.slice('key:'.length);
}

/** 单个 namespace 的运行时态 */
interface NsState {
  name: Namespace;
  dir: string;
  shards: ShardMeta[];
  sessionRefs: Map<string, SessionRef[]>;
  tombstones: Set<string>;
  /** 时间线索引：全部日志的轻量描述符（含筛选字段），append 顺序（最旧在前） */
  timeline: TimelineEntry[];
  /** 时间线索引是否就绪；冷启动重建完成前为 false，期间查询回退扫描 */
  timelineReady: boolean;
  appendLocks: Map<string, Promise<unknown>>;
  flushTimer: ReturnType<typeof setTimeout> | null;
  dirtyCount: number;
  loaded: boolean;
}

interface LineRef {
  file: string;
  offset: number;
  length: number;
  ts: number;
  id: string;
}

export class LogStore {
  private rootDir: string;
  private namespaces = new Map<string, NsState>();
  private initialized = false;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  /** 启动时加载所有已存在 namespace 的索引 */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await fs.mkdir(this.rootDir, { recursive: true });
    let entries: string[] = [];
    try {
      entries = await fs.readdir(this.rootDir);
    } catch {
      entries = [];
    }
    for (const name of entries) {
      if (name === 'legacy-backup') continue;
      const full = path.join(this.rootDir, name);
      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      // 'global' 目录 → global；其余目录名即 keyId，重建 namespace = key:{keyId}
      if (name === 'global') {
        await this.ensureNs('global');
      } else {
        await this.ensureNs(`key:${name}` as Namespace);
      }
    }
  }

  private async ensureNs(ns: Namespace): Promise<NsState> {
    let st = this.namespaces.get(ns);
    if (st && st.loaded) return st;
    const dir = path.join(this.rootDir, nsDirName(ns));
    await fs.mkdir(dir, { recursive: true });
    if (!st) {
      st = {
        name: ns,
        dir,
        shards: [],
        sessionRefs: new Map(),
        tombstones: new Set(),
        timeline: [],
        timelineReady: false,
        appendLocks: new Map(),
        flushTimer: null,
        dirtyCount: 0,
        loaded: false,
      };
      this.namespaces.set(ns, st);
    }
    await this.loadNsState(st);
    return st;
  }

  private async loadNsState(st: NsState): Promise<void> {
    try {
      const shardsRaw = await fs.readFile(path.join(st.dir, 'shards-index.json'), 'utf-8');
      st.shards = JSON.parse(shardsRaw);
      if (!Array.isArray(st.shards)) st.shards = [];
    } catch {
      st.shards = [];
    }
    try {
      const refsRaw = await fs.readFile(path.join(st.dir, 'session-index.json'), 'utf-8');
      const parsed = JSON.parse(refsRaw);
      st.sessionRefs = new Map(Array.isArray(parsed) ? parsed : Object.entries(parsed));
    } catch {
      st.sessionRefs = new Map();
    }
    try {
      const tombRaw = await fs.readFile(path.join(st.dir, 'tombstones.json'), 'utf-8');
      const parsed = JSON.parse(tombRaw);
      st.tombstones = new Set(Array.isArray(parsed) ? parsed : []);
    } catch {
      st.tombstones = new Set();
    }
    // 时间线索引：加载 sidecar 并做 count 一致性校验
    const expectedCount = st.shards.reduce((sum, s) => sum + s.count, 0);
    let loaded: TimelineEntry[] | null = null;
    try {
      const tlRaw = await fs.readFile(path.join(st.dir, 'timeline-index.json'), 'utf-8');
      const parsed = JSON.parse(tlRaw);
      if (Array.isArray(parsed)) loaded = parsed;
    } catch {
      loaded = null;
    }
    if (loaded && loaded.length === expectedCount) {
      st.timeline = loaded;
      st.timelineReady = true;
    } else {
      // sidecar 缺失/过期：置空，后台重建；期间查询回退扫描
      st.timeline = [];
      st.timelineReady = false;
      if (expectedCount > 0) {
        void this.rebuildTimeline(st);
      } else {
        st.timelineReady = true; // 空库视为就绪
      }
    }
    st.loaded = true;
  }

  /**
   * 后台一次性重建时间线索引：按 startTime 升序遍历分片，逐行取 id/ts/筛选字段。
   * 仅在 sidecar 缺失/过期时触发；重建完成后 flush 落盘。
   */
  private async rebuildTimeline(st: NsState): Promise<void> {
    try {
      const sorted = [...st.shards].sort((a, b) => a.startTime - b.startTime);
      const timeline: TimelineEntry[] = [];
      for (const shard of sorted) {
        for await (const ln of this.readLines(st, shard.filename)) {
          let log: any;
          try {
            log = JSON.parse(ln.text);
          } catch {
            continue;
          }
          timeline.push({
            file: shard.filename,
            offset: ln.offset,
            length: ln.length,
            ts: log.timestamp || 0,
            id: log.id,
            targetType: log.targetType,
            vendorId: log.vendorId,
            targetServiceId: log.targetServiceId,
            targetModel: log.targetModel,
            routeId: log.routeId,
          });
        }
      }
      st.timeline = timeline;
      st.timelineReady = true;
      this.scheduleFlush(st);
    } catch {
      // 重建失败：保持 timelineReady=false，查询继续走扫描回退
    }
  }

  // ============ 写入 ============

  async append(ns: Namespace, logIn: Omit<RequestLog, 'id'> & { id?: string }): Promise<AppendResult> {
    const st = await this.ensureNs(ns);
    const id = logIn.id || crypto.randomUUID();
    const log: RequestLog = { ...(logIn as RequestLog), id } as RequestLog;
    const dateStr = utcDate(log.timestamp);
    const filename = this.pickActiveFile(st, dateStr);
    const lockKey = filename;
    const prev = st.appendLocks.get(lockKey) || Promise.resolve();
    const work = prev.then(async () => {
      const filePath = path.join(st.dir, filename);
      const line = Buffer.from(JSON.stringify(log) + '\n', 'utf8');
      let offset = 0;
      try {
        const stat = await fs.stat(filePath);
        offset = stat.size;
      } catch {
        offset = 0;
      }
      await fs.appendFile(filePath, line);
      let meta = st.shards.find(s => s.filename === filename);
      if (!meta) {
        meta = {
          filename,
          date: dateStr,
          startTime: log.timestamp,
          endTime: log.timestamp,
          count: 0,
          size: 0,
        };
        st.shards.push(meta);
      }
      meta.count += 1;
      if (log.timestamp < meta.startTime) meta.startTime = log.timestamp;
      if (log.timestamp > meta.endTime) meta.endTime = log.timestamp;
      meta.size = offset + line.length;

      const sid = extractSessionId(log);
      if (sid) {
        const ref: SessionRef = {
          file: filename,
          offset,
          length: line.length - 1,
          timestamp: log.timestamp,
          logId: id,
        };
        let arr = st.sessionRefs.get(sid);
        if (!arr) {
          arr = [];
          st.sessionRefs.set(sid, arr);
        }
        arr.push(ref);
      }
      // 时间线索引：append 顺序 push（最旧在前），查询时反向遍历
      st.timeline.push({
        file: filename,
        offset,
        length: line.length - 1,
        ts: log.timestamp,
        id,
        targetType: log.targetType,
        vendorId: log.vendorId,
        targetServiceId: log.targetServiceId,
        targetModel: log.targetModel,
        routeId: log.routeId,
      });
      st.timelineReady = true;
      this.scheduleFlush(st);
      const res: AppendResult = { id, namespace: ns, file: filename, offset, length: line.length - 1 };
      return res;
    });
    st.appendLocks.set(lockKey, work);
    try {
      return await work;
    } finally {
      if (st.appendLocks.get(lockKey) === work) st.appendLocks.delete(lockKey);
    }
  }

  private pickActiveFile(st: NsState, dateStr: string): string {
    const sameDay = st.shards.filter(s => s.date === dateStr);
    for (let i = sameDay.length - 1; i >= 0; i--) {
      if (sameDay[i].size < MAX_FILE_SIZE) return sameDay[i].filename;
    }
    const seq = sameDay.length;
    return seq === 0 ? `${dateStr}.ndjson` : `${dateStr}.${seq}.ndjson`;
  }

  // ============ 查询 ============

  async count(ns: Namespace): Promise<number> {
    const st = await this.ensureNs(ns);
    return st.shards.reduce((sum, s) => sum + s.count, 0);
  }

  /** 最近日志（newest-first，分页）。优先走时间线索引（零扫描），未就绪时回退扫描。 */
  async getRecent(ns: Namespace, opts: LogStoreQueryOpts = {}): Promise<RequestLog[]> {
    const st = await this.ensureNs(ns);
    if (!st.timelineReady) return this.getRecentScan(st, opts);
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const since = opts.since;
    const page: TimelineEntry[] = [];
    let skipped = 0;
    // timeline 为 append 顺序（最旧在前），反向遍历得到 newest-first
    for (let i = st.timeline.length - 1; i >= 0 && page.length < limit; i--) {
      const r = st.timeline[i];
      if (since != null && r.ts < since) break; // newest-first：一旦早于 since 即终止
      if (st.tombstones.has(r.id)) continue;
      if (skipped < offset) { skipped++; continue; }
      page.push(r);
    }
    return this.hydrate(st, page);
  }

  /** getRecent 的扫描回退实现（冷启动索引未就绪时使用） */
  private async getRecentScan(st: NsState, opts: LogStoreQueryOpts): Promise<RequestLog[]> {
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const since = opts.since;
    const need = offset + limit;
    const collected: LineRef[] = [];
    const sorted = [...st.shards].sort((a, b) => b.endTime - a.endTime);
    for (const shard of sorted) {
      if (since != null && shard.endTime < since) break; // 整片早于 since，跳过
      if (collected.length >= need) break;
      for await (const ln of this.readLines(st, shard.filename)) {
        let log: any;
        try {
          log = JSON.parse(ln.text);
        } catch {
          continue; // 坏行跳过（NDJSON 逐行容错）
        }
        if (since != null && (log.timestamp || 0) < since) continue;
        if (st.tombstones.has(log.id)) continue;
        collected.push({ file: shard.filename, offset: ln.offset, length: ln.length, ts: log.timestamp || 0, id: log.id });
      }
    }
    collected.sort((a, b) => b.ts - a.ts);
    const page = collected.slice(offset, offset + limit);
    return this.hydrate(st, page);
  }

  /**
   * 统一查询：字段筛选 + 关键词 + 时间窗 + 分页 + 全量命中总数。
   * - 无关键词且索引就绪：走快路径，在描述符上直接筛选（零全量扫描、零 JSON.parse）。
   * - 有关键词或索引未就绪：回退扫描，match 谓词同时检查字段筛选与正文子串。
   */
  async query(ns: Namespace, opts: LogQueryOpts): Promise<LogQueryResult> {
    const st = await this.ensureNs(ns);
    const limit = opts.limit;
    const offset = opts.offset;
    const filters = opts.filters;
    const keyword = (opts.keyword || '').toLowerCase().trim();

    // 快路径：无关键词且索引就绪
    if (!keyword && st.timelineReady) {
      const need = offset + limit;
      const page: TimelineEntry[] = [];
      let total = 0;
      for (let i = st.timeline.length - 1; i >= 0; i--) {
        const r = st.timeline[i];
        if (opts.since != null && r.ts < opts.since) break;
        if (opts.until != null && r.ts > opts.until) continue;
        if (st.tombstones.has(r.id)) continue;
        if (hasFilters(filters) && !matchEntry(r, filters!)) continue;
        total++;
        if (page.length < need) page.push(r);
      }
      const slice = page.slice(offset, offset + limit);
      const data = await this.hydrate(st, slice);
      return { data, total };
    }

    // 慢路径：扫描（关键词必须查正文，或索引未就绪）
    return this.queryScan(st, opts, keyword);
  }

  /** query 的扫描回退实现 */
  private async queryScan(st: NsState, opts: LogQueryOpts, keyword: string): Promise<LogQueryResult> {
    const limit = opts.limit;
    const offset = opts.offset;
    const filters = opts.filters;
    const need = offset + limit;
    const page: LineRef[] = [];
    let total = 0;
    const sorted = [...st.shards].sort((a, b) => b.endTime - a.endTime);
    for (const shard of sorted) {
      if (opts.since != null && shard.endTime < opts.since) break;
      if (opts.until != null && shard.startTime > opts.until) continue;
      for await (const ln of this.readLines(st, shard.filename)) {
        // 关键词先在原始文本上做廉价 substring 命中
        if (keyword && !ln.text.toLowerCase().includes(keyword)) continue;
        let log: any;
        try {
          log = JSON.parse(ln.text);
        } catch {
          continue;
        }
        const ts = log.timestamp || 0;
        if (opts.since != null && ts < opts.since) continue;
        if (opts.until != null && ts > opts.until) continue;
        if (st.tombstones.has(log.id)) continue;
        if (hasFilters(filters) && !matchEntry(log, filters!)) continue;
        total++;
        if (page.length < need) {
          page.push({ file: shard.filename, offset: ln.offset, length: ln.length, ts, id: log.id });
        }
      }
    }
    page.sort((a, b) => b.ts - a.ts);
    const slice = page.slice(offset, offset + limit);
    const data = await this.hydrate(st, slice);
    return { data, total };
  }

  async getBySession(ns: Namespace, sessionId: string, opts: LogStoreQueryOpts = {}): Promise<RequestLog[]> {
    const st = await this.ensureNs(ns);
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const since = opts.since;
    let refs = st.sessionRefs.get(sessionId) || [];
    if (since != null) refs = refs.filter(r => r.timestamp >= since);
    const filtered = [...refs].filter(r => !st.tombstones.has(r.logId));
    filtered.sort((a, b) => b.timestamp - a.timestamp);
    const page = filtered.slice(offset, offset + limit);
    return this.hydrate(st, page);
  }

  /** 批量按会话取近期日志（跨会话合并文件读取），用于 Agent Map 启动重建。 */
  async getBySessionsBatch(
    ns: Namespace,
    sessionIds: string[],
    opts: { since?: number; perSessionLimit?: number } = {}
  ): Promise<Map<string, RequestLog[]>> {
    const st = await this.ensureNs(ns);
    const result = new Map<string, RequestLog[]>();
    if (sessionIds.length === 0) return result;
    const since = opts.since;
    const perLimit = opts.perSessionLimit ?? 100;
    // 1) 每会话选目标 ref
    type Picked = SessionRef & { sessionId: string };
    const picked: Picked[] = [];
    for (const sid of sessionIds) {
      let refs = st.sessionRefs.get(sid) || [];
      if (since != null) refs = refs.filter(r => r.timestamp >= since);
      refs = refs.filter(r => !st.tombstones.has(r.logId));
      refs.sort((a, b) => a.timestamp - b.timestamp);
      const tail = refs.slice(-perLimit);
      for (const r of tail) picked.push({ ...r, sessionId: sid });
    }
    if (picked.length === 0) return result;
    // 2) 按文件分组，每文件打开一次
    const byFile = new Map<string, Picked[]>();
    for (const p of picked) {
      let arr = byFile.get(p.file);
      if (!arr) {
        arr = [];
        byFile.set(p.file, arr);
      }
      arr.push(p);
    }
    const buckets = new Map<string, RequestLog[]>();
    for (const [file, group] of byFile) {
      const fd = await fs.open(path.join(st.dir, file), 'r');
      try {
        for (const p of group) {
          const buf = Buffer.alloc(p.length);
          await fd.read(buf, 0, p.length, p.offset);
          let log: any;
          try {
            log = JSON.parse(buf.toString('utf8'));
          } catch {
            continue;
          }
          let bucket = buckets.get(p.sessionId);
          if (!bucket) {
            bucket = [];
            buckets.set(p.sessionId, bucket);
          }
          bucket.push(log);
        }
      } finally {
        await fd.close();
      }
    }
    for (const [sid, logs] of buckets) {
      logs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      result.set(sid, logs);
    }
    return result;
  }

  /** 两阶段搜索：流式收集匹配描述符 → 切页 → 字节范围回填正文。 */
  async search(ns: Namespace, query: string, opts: LogStoreQueryOpts = {}): Promise<RequestLog[]> {
    const st = await this.ensureNs(ns);
    const q = (query || '').toLowerCase().trim();
    if (!q) return this.getRecent(ns, opts);
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const need = offset + limit;
    const matches: LineRef[] = [];
    const sorted = [...st.shards].sort((a, b) => b.endTime - a.endTime);
    for (const shard of sorted) {
      if (matches.length >= need) break;
      for await (const ln of this.readLines(st, shard.filename)) {
        // 先在原始文本上做廉价 substring 命中，命中再 parse
        if (!ln.text.toLowerCase().includes(q)) continue;
        let log: any;
        try {
          log = JSON.parse(ln.text);
        } catch {
          continue;
        }
        if (st.tombstones.has(log.id)) continue;
        matches.push({ file: shard.filename, offset: ln.offset, length: ln.length, ts: log.timestamp || 0, id: log.id });
      }
    }
    matches.sort((a, b) => b.ts - a.ts);
    const page = matches.slice(offset, offset + limit);
    return this.hydrate(st, page);
  }

  /** search 的匹配计数（流式，不持正文） */
  async searchCount(ns: Namespace, query: string): Promise<number> {
    const st = await this.ensureNs(ns);
    const q = (query || '').toLowerCase().trim();
    if (!q) return this.count(ns);
    let n = 0;
    const sorted = [...st.shards].sort((a, b) => b.endTime - a.endTime);
    for (const shard of sorted) {
      for await (const ln of this.readLines(st, shard.filename)) {
        if (!ln.text.toLowerCase().includes(q)) continue;
        n++;
      }
    }
    return n;
  }

  /** 按字节范围回填一组 ref 的正文，按文件分组、每文件打开一次 */
  private async hydrate(st: NsState, refs: { file: string; offset: number; length: number }[]): Promise<RequestLog[]> {
    if (refs.length === 0) return [];
    const byFile = new Map<string, { idx: number; ref: { file: string; offset: number; length: number } }[]>();
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      let arr = byFile.get(ref.file);
      if (!arr) {
        arr = [];
        byFile.set(ref.file, arr);
      }
      arr.push({ idx: i, ref });
    }
    const out: (RequestLog | undefined)[] = new Array(refs.length);
    for (const [file, group] of byFile) {
      const fd = await fs.open(path.join(st.dir, file), 'r');
      try {
        for (const g of group) {
          const buf = Buffer.alloc(g.ref.length);
          await fd.read(buf, 0, g.ref.length, g.ref.offset);
          try {
            out[g.idx] = JSON.parse(buf.toString('utf8'));
          } catch {
            // 坏行跳过
          }
        }
      } finally {
        await fd.close();
      }
    }
    return out.filter(Boolean) as RequestLog[];
  }

  // ============ 流式逐行读（带字节偏移） ============

  private async *readLines(st: NsState, filename: string): AsyncGenerator<{ text: string; offset: number; length: number }> {
    const filePath = path.join(st.dir, filename);
    let fd;
    try {
      fd = await fs.open(filePath, 'r');
    } catch {
      return;
    }
    try {
      let carry = Buffer.alloc(0);
      let carryOffset = 0;
      let filePos = 0;
      while (true) {
        const buf = Buffer.alloc(READ_CHUNK);
        const { bytesRead } = await fd.read(buf, 0, READ_CHUNK, filePos);
        if (bytesRead === 0) {
          if (carry.length > 0) {
            yield { text: carry.toString('utf8'), offset: carryOffset, length: carry.length };
            carry = Buffer.alloc(0);
          }
          break;
        }
        const data = buf.subarray(0, bytesRead);
        const block = carry.length > 0 ? Buffer.concat([carry, data]) : data;
        const blockStart = carryOffset;
        let searchFrom = 0;
        let nl = block.indexOf(0x0a, searchFrom);
        while (nl !== -1) {
          const lineBuf = block.subarray(searchFrom, nl);
          yield {
            text: lineBuf.toString('utf8'),
            offset: blockStart + searchFrom,
            length: lineBuf.length,
          };
          searchFrom = nl + 1;
          nl = block.indexOf(0x0a, searchFrom);
        }
        carry = block.subarray(searchFrom);
        carryOffset = blockStart + searchFrom;
        filePos += bytesRead;
      }
    } finally {
      await fd.close();
    }
  }

  // ============ 删除 / 清理 ============

  /** 按会话删除日志（tombstone + 清理 sessionRefs） */
  async deleteLogsBySession(ns: Namespace, sessionId: string): Promise<number> {
    const st = await this.ensureNs(ns);
    const refs = st.sessionRefs.get(sessionId) || [];
    let n = 0;
    for (const r of refs) {
      if (!st.tombstones.has(r.logId)) {
        st.tombstones.add(r.logId);
        n++;
      }
    }
    st.sessionRefs.delete(sessionId);
    if (n > 0) this.scheduleFlush(st);
    return n;
  }

  /** 按 id 批量删除（tombstone） */
  async deleteLogsByIds(ns: Namespace, ids: string[]): Promise<number> {
    const st = await this.ensureNs(ns);
    let n = 0;
    for (const id of ids) {
      if (id && !st.tombstones.has(id)) {
        st.tombstones.add(id);
        n++;
      }
    }
    if (n > 0) this.scheduleFlush(st);
    return n;
  }

  /** 清空某 namespace 全部日志 */
  async clear(ns: Namespace): Promise<void> {
    const st = await this.ensureNs(ns);
    for (const s of st.shards) {
      try {
        await fs.unlink(path.join(st.dir, s.filename));
      } catch {
        // 忽略
      }
    }
    st.shards = [];
    st.sessionRefs.clear();
    st.tombstones.clear();
    st.timeline = [];
    st.timelineReady = true;
    await this.flushNow(st);
  }

  /** 保留最近 N 天，删除更早的分片文件（整文件删，ref 自带 file，零逐条修正） */
  async retain(ns: Namespace, days: number): Promise<number> {
    const st = await this.ensureNs(ns);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const toDelete = st.shards.filter(s => s.endTime < cutoff);
    if (toDelete.length === 0) return 0;
    const deleted = new Set(toDelete.map(s => s.filename));
    for (const s of toDelete) {
      try {
        await fs.unlink(path.join(st.dir, s.filename));
      } catch {
        // 忽略
      }
    }
    st.shards = st.shards.filter(s => !deleted.has(s.filename));
    // 清理指向已删文件的 sessionRefs
    for (const [sid, refs] of st.sessionRefs) {
      const remaining = refs.filter(r => !deleted.has(r.file));
      if (remaining.length === 0) st.sessionRefs.delete(sid);
      else if (remaining.length < refs.length) st.sessionRefs.set(sid, remaining);
    }
    // 清理时间线索引中指向已删文件的描述符
    if (st.timeline.length > 0) {
      st.timeline = st.timeline.filter(r => !deleted.has(r.file));
    }
    await this.flushNow(st);
    return toDelete.length;
  }

  /**
   * 流式遍历某 namespace 的全部日志（逐行 parse，跳过坏行与 tombstone）。
   * 供统计 contentType 分布重建、迁移校验等「需要扫全量」的场景；查询走 getRecent/search。
   */
  async *streamAll(ns: Namespace, opts: { skipTombstone?: boolean } = {}): AsyncGenerator<RequestLog> {
    const st = await this.ensureNs(ns);
    const sorted = [...st.shards].sort((a, b) => a.startTime - b.startTime);
    for (const shard of sorted) {
      for await (const ln of this.readLines(st, shard.filename)) {
        let log: any;
        try {
          log = JSON.parse(ln.text);
        } catch {
          continue;
        }
        if (opts.skipTombstone && log.id && st.tombstones.has(log.id)) continue;
        yield log;
      }
    }
  }

  /**
   * 带过滤的分页查询：流式扫描全量，对每条日志应用 match 谓词（+ 可选 since/until 时间窗），
   * 收集轻量描述符直到够一页，同时继续计数得到 total；最后按字节范围回填当前页。
   * 返回 { data, total }。内存仅持描述符 + 当前页。
   */
  async getFiltered(
    ns: Namespace,
    opts: {
      since?: number;
      until?: number;
      match?: (log: RequestLog) => boolean;
      limit: number;
      offset: number;
    }
  ): Promise<{ data: RequestLog[]; total: number }> {
    const st = await this.ensureNs(ns);
    const limit = opts.limit;
    const offset = opts.offset;
    const need = offset + limit;
    const page: LineRef[] = [];
    let total = 0;
    const sorted = [...st.shards].sort((a, b) => b.endTime - a.endTime);
    outer:
    for (const shard of sorted) {
      if (opts.since != null && shard.endTime < opts.since) break;
      if (opts.until != null && shard.startTime > opts.until) continue;
      for await (const ln of this.readLines(st, shard.filename)) {
        let log: any;
        try {
          log = JSON.parse(ln.text);
        } catch {
          continue;
        }
        const ts = log.timestamp || 0;
        if (opts.since != null && ts < opts.since) continue;
        if (opts.until != null && ts > opts.until) continue;
        if (st.tombstones.has(log.id)) continue;
        if (opts.match && !opts.match(log)) continue;
        total++;
        if (page.length < need) {
          page.push({ file: shard.filename, offset: ln.offset, length: ln.length, ts, id: log.id });
        }
        if (page.length >= need && opts.since == null && opts.until == null && !opts.match) {
          // 无过滤时可提前结束（total == page.length 满足分页即可）
          break outer;
        }
      }
    }
    page.sort((a, b) => b.ts - a.ts);
    const slice = page.slice(offset, offset + limit);
    const data = await this.hydrate(st, slice);
    return { data, total };
  }

  /** 列出所有已加载的 namespace（供定时清理遍历 AccessKey） */
  listNamespaces(): Namespace[] {
    return Array.from(this.namespaces.keys()) as Namespace[];
  }

  // ============ 索引持久化（防抖） ============

  private scheduleFlush(st: NsState) {
    st.dirtyCount += 1;
    if (st.dirtyCount >= FLUSH_THRESHOLD) {
      if (st.flushTimer) {
        clearTimeout(st.flushTimer);
        st.flushTimer = null;
      }
      this.flushNow(st).catch(() => {});
      return;
    }
    if (!st.flushTimer) {
      st.flushTimer = setTimeout(() => {
        st.flushTimer = null;
        this.flushNow(st).catch(() => {});
      }, FLUSH_DELAY);
      if (typeof st.flushTimer.unref === 'function') st.flushTimer.unref();
    }
  }

  private async flushNow(st: NsState) {
    st.dirtyCount = 0;
    if (st.flushTimer) {
      clearTimeout(st.flushTimer);
      st.flushTimer = null;
    }
    const tmp1 = path.join(st.dir, '.tmp-shards-index.json');
    const tmp2 = path.join(st.dir, '.tmp-session-index.json');
    const tmp3 = path.join(st.dir, '.tmp-tombstones.json');
    const tmp4 = path.join(st.dir, '.tmp-timeline-index.json');
    await fs.writeFile(tmp1, JSON.stringify(st.shards));
    await fs.rename(tmp1, path.join(st.dir, 'shards-index.json'));
    await fs.writeFile(tmp2, JSON.stringify(Array.from(st.sessionRefs.entries())));
    await fs.rename(tmp2, path.join(st.dir, 'session-index.json'));
    await fs.writeFile(tmp3, JSON.stringify(Array.from(st.tombstones)));
    await fs.rename(tmp3, path.join(st.dir, 'tombstones.json'));
    await fs.writeFile(tmp4, JSON.stringify(st.timeline));
    await fs.rename(tmp4, path.join(st.dir, 'timeline-index.json'));
  }

  /**
   * store 是否真的有数据文件（看实际 *.ndjson，不信 shards-index.json 元数据，
   * 防「索引还在、数据文件被删」的误判）。
   */
  async storeHasData(): Promise<boolean> {
    let ents: string[] = [];
    try {
      ents = await fs.readdir(this.rootDir);
    } catch {
      return false;
    }
    for (const name of ents) {
      if (name === 'legacy-backup') continue;
      if (name.startsWith('.')) continue;
      const full = path.join(this.rootDir, name);
      try {
        const stat = await fs.stat(full);
        if (!stat.isDirectory()) continue;
      } catch {
        continue;
      }
      try {
        const files = await fs.readdir(full);
        if (files.some(f => f.endsWith('.ndjson'))) return true;
      } catch {
        // 忽略
      }
    }
    return false;
  }

  /**
   * 流式收集某 namespace 已存在的全部 logId，供迁移去重。
   * 仅在迁移启动时为「有数据的 namespace」调用一次；store 空则返回空 Set。
   */
  private async collectIds(ns: Namespace): Promise<Set<string>> {
    const ids = new Set<string>();
    try {
      for await (const log of this.streamAll(ns)) {
        if ((log as any).id) ids.add((log as any).id);
      }
    } catch {
      // 忽略
    }
    return ids;
  }

  /**
   * 稳健迁移旧 JSON 日志到 NDJSON（main.ts 在 listen 之前调用）。
   * - 主库：{dataPath}/logs.json（旧单文件）+ {dataPath}/logs/logs-*.json（旧分片）→ 'global'
   * - AccessKey：{dataPath}/key-logs/<keyId>/*.json（跳过 logs-index.json）→ 'key:{keyId}'
   *
   * 设计（幂等 + 非破坏性 + 内容感知）：
   * - gate：仅当 `标记缺失 OR store 实际无数据文件` 才进入迁移。正常重启（标记在 + 数据在）直接跳过，不扫源。
   * - 去重：进入迁移时，先为每个有数据的 namespace 用 collectIds 建已存在 idSet，
   *   迁移时 idSet.has(id) 则跳过。于是「部分残留/中断续跑/标记过期重跑」都不产生重复。
   * - 非破坏性：不 wipe 任何目录；源头 logs/、key-logs/ 始终只读、永不移动/删除（见 UPGRADE.md）。
   * - 标记 `.log-store-migration` 仅作「已完成」提示，不单独决定跳过——必须同时 storeHasData()。
   */
  async migrateLegacy(dataPath: string): Promise<{ global: number; keys: Record<string, number> }> {
    await fs.mkdir(this.rootDir, { recursive: true });

    // 兼容：清理旧版本标记名
    try {
      await fs.unlink(path.join(this.rootDir, '.legacy-migrated'));
    } catch {
      // 无旧标记，忽略
    }

    const marker = path.join(this.rootDir, '.log-store-migration');
    let hasMarker = false;
    try {
      await fs.access(marker);
      hasMarker = true;
    } catch {
      hasMarker = false;
    }
    const hasData = await this.storeHasData();

    // 快速路径：标记在 + store 真有数据 → 已完成，跳过（不扫源）
    if (hasMarker && hasData) {
      return { global: 0, keys: {} };
    }

    console.log(`[LogStore] migrate: start (marker=${hasMarker}, hasData=${hasData})`);

    // store 无实际数据文件时，可能残留指向已删文件的 stale 索引（shards-index.json 等）。
    // 清掉这些索引 + 内存态，避免「索引说有、文件没有」的幽灵；.ndjson 本就不存在，无数据丢失风险。
    if (!hasData) {
      for (const ns of this.listNamespaces()) {
        const dir = path.join(this.rootDir, nsDirName(ns));
        for (const idxFile of ['shards-index.json', 'session-index.json', 'tombstones.json', 'timeline-index.json']) {
          try {
            await fs.unlink(path.join(dir, idxFile));
          } catch {
            // 忽略
          }
        }
      }
      this.namespaces.clear();
    }

    // 为每个有数据的 namespace 建去重 idSet（防部分残留导致重复追加）
    const idSets = new Map<Namespace, Set<string>>();
    for (const ns of this.listNamespaces()) {
      try {
        const dir = path.join(this.rootDir, nsDirName(ns));
        const files = await fs.readdir(dir);
        if (files.some(f => f.endsWith('.ndjson'))) {
          idSets.set(ns, await this.collectIds(ns));
        }
      } catch {
        // 忽略
      }
    }

    const ensureIdSet = (ns: Namespace): Set<string> => {
      let s = idSets.get(ns);
      if (!s) {
        s = new Set();
        idSets.set(ns, s);
      }
      return s;
    };

    const result = { global: 0, keys: {} as Record<string, number> };
    let sourceFiles = 0;

    const migrateFile = async (ns: Namespace, file: string): Promise<number> => {
      // ★ 不变量：源头文件（logs/、key-logs/、logs.json）只读——本函数只 readFile，
      //   绝不 unlink / rm / rename 任何源文件，也不把源文件移动到别处。
      //   所有写入只落到 log-store/{namespace}/ 内。违反此约束会破坏用户数据可恢复性。
      if (file.startsWith(this.rootDir)) {
        console.error(`[LogStore] migrate: refuse to touch file inside log-store (${file}); source must be logs/ or key-logs/`);
        return 0;
      }
      let content: string;
      try {
        content = await fs.readFile(file, 'utf-8');
      } catch {
        return 0;
      }
      sourceFiles++;
      // 旧分片可能含 \x00 损坏：截断到首个 NUL
      const nul = content.indexOf('\x00');
      if (nul !== -1) content = content.substring(0, nul);
      let arr: any[];
      try {
        arr = JSON.parse(content);
        if (!Array.isArray(arr)) arr = [];
      } catch {
        console.warn(`[LogStore] migrate: skip unparseable file ${file}`);
        return 0;
      }
      const idSet = ensureIdSet(ns);
      let written = 0;
      let skippedDup = 0;
      for (const log of arr) {
        if (!log || typeof log !== 'object') continue;
        if (!log.id) log.id = crypto.randomUUID();
        if (typeof log.timestamp !== 'number') log.timestamp = Date.now();
        if (idSet.has(log.id)) {
          skippedDup++;
          continue; // 去重：已存在则跳过
        }
        try {
          await this.append(ns, log as RequestLog);
          idSet.add(log.id);
          written++;
        } catch (err) {
          console.error(`[LogStore] migrate: append failed in ${file}`, err);
        }
      }
      if (skippedDup > 0) {
        console.log(`[LogStore] migrate: ${file} dedup-skipped=${skippedDup} written=${written}`);
      }
      return written;
    };

    // 主库：logs.json + logs/logs-*.json
    const oldSingle = path.join(dataPath, 'logs.json');
    try {
      await fs.access(oldSingle);
      result.global += await migrateFile('global', oldSingle);
    } catch {
      // 无单文件
    }
    const oldLogsDir = path.join(dataPath, 'logs');
    try {
      const files = await fs.readdir(oldLogsDir);
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        if (!/^logs-.*\.json$/.test(f)) continue;
        result.global += await migrateFile('global', path.join(oldLogsDir, f));
      }
    } catch {
      // 无 logs 目录
    }

    // AccessKey：key-logs/<keyId>/*.json
    const keyRoot = path.join(dataPath, 'key-logs');
    try {
      const keyDirs = await fs.readdir(keyRoot);
      for (const kd of keyDirs) {
        const kdFull = path.join(keyRoot, kd);
        let st;
        try {
          st = await fs.stat(kdFull);
        } catch {
          continue;
        }
        if (!st.isDirectory()) continue;
        const ns: Namespace = `key:${kd}`;
        let files: string[];
        try {
          files = await fs.readdir(kdFull);
        } catch {
          continue;
        }
        let n = 0;
        for (const f of files) {
          if (!f.endsWith('.json')) continue;
          if (f === 'logs-index.json') continue; // 跳过旧索引
          n += await migrateFile(ns, path.join(kdFull, f));
        }
        if (n > 0) result.keys[kd] = (result.keys[kd] || 0) + n;
      }
    } catch {
      // 无 key-logs
    }

    // 落盘所有 namespace
    for (const nss of this.namespaces.values()) {
      try {
        await this.flushNow(nss);
      } catch {
        // 忽略
      }
    }

    // 写标记（记录版本/时间/源文件数，便于排查；仍需 storeHasData 才会在下次跳过）
    await fs.writeFile(
      marker,
      JSON.stringify({ version: 1, finishedAt: Date.now(), sources: sourceFiles })
    );

    if (result.global > 0 || Object.keys(result.keys).length > 0 || !hasData) {
      console.log(`[LogStore] migration done: global=${result.global} keys=${JSON.stringify(result.keys)} sources=${sourceFiles}`);
    }
    return result;
  }


  /** 关闭时强制落盘所有 namespace */
  async close(): Promise<void> {
    for (const st of this.namespaces.values()) {
      try {
        await this.flushNow(st);
      } catch {
        // 忽略
      }
    }
  }
}
