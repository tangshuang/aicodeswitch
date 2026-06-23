/**
 * Agent Map（任务雷达）主页面
 *
 * 把每个 Claude Code / Codex Session 画成画布上的一个节点，状态由后端活跃度推断并经 SSE 实时推送。
 *
 * 2D 与 3D 是两个完全独立的画布组件（AgentMapCanvas2D / AgentMapCanvas3D），
 * 各自拥有自己的交互与生命周期，互不干扰：本页面仅负责共享状态（数据、选中态、popover、活动流）
 * 与视图切换。2D 走 SVG；3D 走 Three.js（WebGL 不可用时回退到 2D）。
 */
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { api } from '../api/client';
import { ClaudeCodeIcon, CodexIcon, AgentIcon } from '../components/AgentIcons';
import { Switch } from '../components/Switch';
import SessionDetailModal from '../components/SessionDetailModal';
import { useAgentNotifications } from '../components/AgentNotificationsProvider';
import AgentMapCanvas2D from './AgentMapCanvas2D';
import AgentMapCanvas3D from './AgentMapCanvas3D';
import { DAY, HOUR, timeAgo, TOOL_ICON, ZoomControls, type View } from './agent-map-shared';
import type {
  ActivityEvent,
  AgentMapInitPayload,
  AgentMapStats,
  RequestLog,
  SessionMapItem,
} from '../../types';

type SessionDetailInfo = {
  id: string;
  targetType: string;
  title?: string;
  firstRequestAt: number;
  lastRequestAt: number;
  requestCount: number;
  totalTokens: number;
};

const STATUS_LABEL: Record<string, string> = {
  active: '进行中', idle: '空闲', completed: '已完成', error: '异常',
};

type Preset = 'all' | '1h' | '6h' | '24h' | '7d';
const PRESETS: { key: Preset; label: string; ms: number }[] = [
  { key: 'all', label: '全部', ms: 0 },
  { key: '1h', label: '近 1 小时', ms: HOUR },
  { key: '6h', label: '近 6 小时', ms: 6 * HOUR },
  { key: '24h', label: '近 24 小时', ms: 24 * HOUR },
  { key: '7d', label: '近 7 天', ms: 7 * DAY },
];

// ============================ 时间直方图 / 趋势图 ============================

interface Bucket { index: number; start: number; end: number; count: number; }

function buildHistogram(events: ActivityEvent[], start: number, end: number, bucketCount: number): Bucket[] {
  const span = Math.max(1, end - start);
  const ms = span / bucketCount;
  const counts = new Array(bucketCount).fill(0);
  for (const e of events) {
    if (e.ts < start || e.ts > end) continue;
    let idx = Math.floor((e.ts - start) / ms);
    if (idx < 0) idx = 0;
    if (idx >= bucketCount) idx = bucketCount - 1;
    counts[idx]++;
  }
  return counts.map((count, index) => ({ index, start: start + index * ms, end: start + (index + 1) * ms, count }));
}

function formatBucketLabel(ts: number, spanMs: number): string {
  const s = new Date(ts);
  if (spanMs <= DAY) return `${s.getHours().toString().padStart(2, '0')}:00`;
  return `${s.getMonth() + 1}/${s.getDate()}`;
}

function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`;
  const d = [`M ${pts[0].x} ${pts[0].y}`];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d.push(`C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`);
  }
  return d.join(' ');
}

function TrendChart({ events, start, end }: { events: ActivityEvent[]; start: number; end: number }) {
  const W = 220, H = 44, PAD = 3;
  const BUCKET_COUNT = 28;
  const buckets = useMemo(() => buildHistogram(events, start, end, BUCKET_COUNT), [events, start, end]);
  const counts = buckets.map(b => b.count);
  const maxCount = Math.max(1, ...counts);
  const total = counts.reduce((a, b) => a + b, 0);
  const spanMs = end - start;
  const pts = counts.map((c, i) => ({
    x: counts.length === 1 ? W / 2 : (i / (counts.length - 1)) * (W - 2) + 1,
    y: H - PAD - (c / maxCount) * (H - 2 * PAD),
  }));
  const line = smoothPath(pts);
  const area = pts.length > 0
    ? `${line} L ${pts[pts.length - 1].x.toFixed(2)} ${H} L ${pts[0].x.toFixed(2)} ${H} Z`
    : '';
  return (
    <div className="am-trend" title={`区间内活动趋势：共 ${total} 次活动`}>
      <span className="am-trend-label">活动趋势</span>
      <svg className="am-trend-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="am-trend-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent-primary)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--accent-primary)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {area && <path d={area} fill="url(#am-trend-grad)" stroke="none" />}
        {line && <path d={line} fill="none" stroke="var(--accent-primary)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />}
      </svg>
      <span className="am-trend-axis">
        {formatBucketLabel(start, spanMs)} – {formatBucketLabel(end, spanMs)}
      </span>
    </div>
  );
}

// ============================ 活动路径子图 / 活动流 / 图例 ============================

function ActivityPathGraph({ events }: { events: ActivityEvent[] }) {
  if (events.length === 0) return <div className="am-empty">暂无活动记录（发起一次请求后会出现）</div>;
  const sorted = [...events].sort((a, b) => b.ts - a.ts);
  const groups: { key: string; kind: ActivityEvent['kind']; toolName?: string; summary: string; count: number; ts: number }[] = [];
  for (const e of sorted) {
    const gkey = `${e.kind}|${e.toolName || ''}|${e.summary || ''}`;
    const last = groups[groups.length - 1];
    if (last && last.key === gkey) { last.count += 1; continue; }
    groups.push({ key: gkey, kind: e.kind, toolName: e.toolName, summary: e.summary || e.kind, count: 1, ts: e.ts });
  }
  return (
    <div className="am-path">
      {groups.map((g, i) => {
        const icon = g.kind === 'prompt' ? '💬'
          : g.kind === 'thinking' ? '💭'
          : g.kind === 'error' ? '⚠️'
          : g.kind === 'cancelled' ? '🚫'
          : g.kind === 'response' ? '💬'
          : TOOL_ICON[g.toolName || ''] || '•';
        return (
          <div key={g.key + i} className={`am-path-item am-path-item--${g.kind}`}>
            <div className="am-path-rail">
              <div className="am-path-dot" />
              {i < groups.length - 1 && <div className="am-path-line" />}
            </div>
            <div className="am-path-body">
              <div className="am-path-head">
                <span className="am-path-icon">{icon}</span>
                <span className="am-path-summary">{g.summary}</span>
                <span className="am-path-time">{new Date(g.ts).toLocaleTimeString()}</span>
                {g.count > 1 && <span className="am-path-count">×{g.count}</span>}
              </div>
              {g.kind === 'prompt' && <div className="am-path-prompt">{g.summary}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ActivityFeed({ events, onSelectSession }: { events: ActivityEvent[]; onSelectSession?: (sessionId: string) => void }) {
  if (events.length === 0) return <div className="am-feed-empty">等待实时活动…</div>;
  return (
    <div className="am-feed">
      {events.slice(0, 80).map(e => (
        <div
          key={e.id}
          className={`am-feed-row am-feed-row--${e.kind}${onSelectSession ? ' am-feed-row--clickable' : ''}`}
          onClick={onSelectSession ? () => onSelectSession(e.sessionId) : undefined}
          title={onSelectSession ? '点击定位到地图节点并展开详情' : undefined}
        >
          <span className="am-feed-time">{new Date(e.ts).toLocaleTimeString()}</span>
          <AgentIcon agent={e.agent} size={13} className="am-feed-agent" />
          <span className="am-feed-icon">
            {e.kind === 'prompt' ? '💬' : e.kind === 'error' ? '⚠️' : e.kind === 'cancelled' ? '🚫' : TOOL_ICON[e.toolName || ''] || '•'}
          </span>
          <span className="am-feed-summary">{e.summary}</span>
        </div>
      ))}
    </div>
  );
}

function LegendRow({ icon, label, desc }: { icon: React.ReactNode; label: string; desc: string }) {
  return (
    <div className="am-legend-row">
      <span className="am-legend-ic">{icon}</span>
      <span className="am-legend-text">
        <span className="am-legend-label">{label}</span>
        <span className="am-legend-desc">{desc}</span>
      </span>
    </div>
  );
}
function LegendGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="am-legend-group">
      <div className="am-legend-group-title">{title}</div>
      {children}
    </div>
  );
}
function MapLegend({ onClose }: { onClose: () => void }) {
  return (
    <>
      <div className="am-popover-overlay" onClick={onClose} />
      <div className="am-popover am-popover--wide">
        <div className="am-popover-head">
          <span>🗺️ 地图符号说明</span>
          <button className="am-popover-close" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="am-popover-body am-legend-grid">
          <div className="am-legend-col">
            <LegendGroup title="客户端类型（节点中心图标）">
              <LegendRow icon={<ClaudeCodeIcon size={16} />} label="Claude Code" desc="该 Session 来自 Claude Code 客户端" />
              <LegendRow icon={<CodexIcon size={16} />} label="Codex" desc="该 Session 来自 Codex 客户端" />
            </LegendGroup>
            <LegendGroup title="节点状态（颜色 + 光晕）">
              <LegendRow icon={<i className="am-dot am-dot--active" />} label="进行中" desc="最近 60 秒内有请求，或有在途请求（脉冲发光）" />
              <LegendRow icon={<i className="am-dot am-dot--idle" />} label="空闲" desc="超过 60 秒无新请求，但 10 分钟内有过活动" />
              <LegendRow icon={<i className="am-dot am-dot--completed" />} label="已完成" desc="超过 10 分钟无活动，且末轮正常结束（变暗、虚线）" />
              <LegendRow icon={<i className="am-dot am-dot--error" />} label="异常" desc="末次请求失败（上游 5xx），红色脉冲" />
            </LegendGroup>
            <LegendGroup title="距离分档（同心圆，按时间阶梯 1/7/30/365 天）">
              <LegendRow icon={<span className="am-ring-swatch" style={{ color: 'var(--accent-success)' }} />} label="1 天临界" desc="圈内在 1 天内开始的会话；圈外是更早的会话" />
              <LegendRow icon={<span className="am-ring-swatch" style={{ color: 'var(--accent-warning)' }} />} label="7 天临界" desc="1–7 天前开始的会话落在本圈与 1 天圈之间" />
              <LegendRow icon={<span className="am-ring-swatch" style={{ color: '#6BA8E5' }} />} label="30 天临界" desc="7–30 天前开始的会话落在本圈与 7 天圈之间" />
              <LegendRow icon={<span className="am-ring-swatch" style={{ color: '#6BA8E5' }} />} label="1 年临界（最外圈）" desc="30 天–1 年前开始的会话落在本圈与 30 天圈之间；超过 1 年的会话游离在本圈之外（最外围）" />
            </LegendGroup>
          </div>
          <div className="am-legend-col">
            <LegendGroup title="节点装饰">
              <LegendRow icon={<span>🔑</span>} label="接入密钥来源" desc="节点下方钥匙标记，走 AccessKey 接入密钥流量" />
              <LegendRow icon={<span className="am-ic-center" />} label="中心点" desc="画布中心圆点，进行中节点会与它连线" />
            </LegendGroup>
            <LegendGroup title="节点位置与尺寸">
              <LegendRow icon={<span>🎯</span>} label="距中心距离 = 会话开始时间" desc="以会话开始时间（firstRequestAt）按龄分档：1 天内居内侧（分布最宽），1–5 天、5–10 天依次外扩，10 天以上在最外围。内圈带宽最大、越往外越紧凑，落定后不漂移" />
              <LegendRow icon={<span>🔵</span>} label="节点大小 = 对话轮数" desc="默认较小，仅随对话轮数（requestCount）增长并封顶，越大代表历史对话轮数越多" />
            </LegendGroup>
            <LegendGroup title="操作">
              <LegendRow icon={<span className="am-ic-mouse">🖱</span>} label="缩放 / 平移" desc="2D：滚轮缩放、拖拽平移、短按选中；3D：拖拽旋转、滚轮缩放、右键平移、点击选中" />
              <LegendRow icon={<span className="am-ic-chart">📈</span>} label="时间筛选" desc="点 topbar「时间筛选」按预设区间过滤；趋势曲线仅作参考" />
            </LegendGroup>
          </div>
          <div className="am-legend-col">
            <LegendGroup title="3D 视图操作与标识">
              <LegendRow icon={<span>🧊</span>} label="进入 / 退出 3D"
                desc="右下角「2D / 3D」分段切换；3D 使用 WebGL，若环境不支持会自动回退到 2D（此时 3D 按钮置灰）。3D 与 2D 是两套完全独立的画布，互不影响" />
              <LegendRow icon={<span className="am-ic-mouse">🖱</span>} label="鼠标操作"
                desc="左键按住拖拽 = 环绕旋转视角；滚轮 = 以光标为中心缩放；右键（或双指）按住拖拽 = 平移；在节点上单击 = 选中并展开详情，点空白 = 取消选中。一旦开始拖拽，复位/定位的自动过渡会立即停止，视角完全交给用户" />
              <LegendRow icon={<span>🕹️</span>} label="连线 / 标签 / 复位"
                desc="3D 模式下右下角额外出现「连线」「标签」「复位」三个按钮：连线 = 开关中心点到各节点的 Token 连线（默认开，关闭后选中节点的连线仍显示）；标签 = 切换是否显示所有节点文字（默认只显示选中节点的文字）；复位 = 把相机平滑回到初始机位" />
              <LegendRow icon={<span>📐</span>} label="中心纵轴 = Token 量尺"
                desc="底部中心点垂直向上一根虚线纵轴，标注 10k / 100k / 1M / 10M / 100M / 1B 临界刻度；节点高度由 Token 总量驱动（阶梯式分段、每跨一档放大但不超过 2 倍），Token 越多越往上长" />
              <LegendRow icon={<span>🌀</span>} label="地面同心圆 = 会话年龄"
                desc="底部平面同心圆按时间阶梯对齐到 1 天 / 7 天 / 30 天 / 1 年 临界（段长比 20/30/30/20，1 天段最长）：越靠中心 = 会话越新（刚创建），越往外 = 会话开始得越早；超过 1 年的节点游离在最外圈之外。节点距中心的水平距离由会话开始时间决定，落定后不漂移" />
              <LegendRow icon={<span>🎨</span>} label="节点颜色 / 形态"
                desc="进行中=主色（带脉冲发光圈）、空闲=黄色、异常=红色（快频脉冲）、已完成=浅绿线框球（半透明、不遮挡视野）。in-flight 请求中的节点球体会轻微呼吸缩放" />
            </LegendGroup>
          </div>
          <div className="am-legend-col">
            <LegendGroup title="活动路径 / 活动流图标">
              <LegendRow icon={<span>💬</span>} label="提问 / 回复" desc="用户提问或模型回复" />
              <LegendRow icon={<span>💭</span>} label="思考" desc="模型推理思考过程" />
              <LegendRow icon={<span>⚠️</span>} label="错误" desc="请求失败" />
              <LegendRow icon={<span>📖</span>} label="Read" desc="读取文件" />
              <LegendRow icon={<span>📝</span>} label="Edit / Write" desc="编辑 / 写入文件" />
              <LegendRow icon={<span>🔧</span>} label="Bash" desc="执行终端命令" />
              <LegendRow icon={<span>🔍</span>} label="Grep / Glob" desc="搜索内容 / 匹配文件" />
              <LegendRow icon={<span>🌐</span>} label="WebFetch / WebSearch" desc="抓取网页 / 联网搜索" />
              <LegendRow icon={<span>🤖</span>} label="Agent / Task" desc="调用子 Agent" />
            </LegendGroup>
          </div>
        </div>
      </div>
    </>
  );
}

// ============================ 主页面 ============================

export default function AgentMapPage() {
  const [sessions, setSessions] = useState<Map<string, SessionMapItem>>(new Map());
  const [feedEvents, setFeedEvents] = useState<ActivityEvent[]>([]);
  const [stats, setStats] = useState<AgentMapStats | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailEvents, setDetailEvents] = useState<ActivityEvent[]>([]);
  const [detailSession, setDetailSession] = useState<SessionDetailInfo | null>(null);
  const [detailSessionLogs, setDetailSessionLogs] = useState<RequestLog[]>([]);
  const [detailSessionLoading, setDetailSessionLoading] = useState(false);
  const [detailSessionSource, setDetailSessionSource] = useState<{ source: 'global' | 'access-key'; keyId?: string; sessionId: string } | null>(null);
  const [pathInfo, setPathInfo] = useState<{ loading: boolean; projectPath?: string; unavailable?: boolean }>({ loading: false });
  const [feedOpen, setFeedOpen] = useState(true);
  const toggleFeed = useCallback(() => setFeedOpen(prev => !prev), []);
  const [helpOpen, setHelpOpen] = useState(false);
  const [timebarOpen, setTimebarOpen] = useState(false);
  const { enabled: notifyEnabled, toggle: toggleNotify } = useAgentNotifications();
  const [connected, setConnected] = useState(false);

  // 视图：2D 缩放/平移（仅 2D 画布使用，3D 由 OrbitControls 自持）
  const [view, setView] = useState<View>({ zoom: 1, panX: 0, panY: 0 });
  // 2D / 3D 切换；WebGL 不可用时回退 2D
  const [view3D, setView3D] = useState(false);
  const [webglFailed, setWebglFailed] = useState(false);
  // 3D：是否展示所有节点标签
  const [showLabels, setShowLabels] = useState(false);
  // 3D：是否展示中心点到各节点的 Token 连线（默认关；选中节点的连线始终显示）
  const [showLinks, setShowLinks] = useState(false);
  // 定位触发（活动流行 → 对应画布聚焦节点）；resetNonce 触发 3D 复位视角
  const [focus, setFocus] = useState<{ sessionId: string; nonce: number } | null>(null);
  const [resetNonce, setResetNonce] = useState(0);

  // SSE 连接
  useEffect(() => {
    const stream = api.streamAgentMap({
      onInit: (payload: AgentMapInitPayload) => {
        setConnected(true);
        const m = new Map<string, SessionMapItem>();
        for (const s of payload.sessions) m.set(s.sessionId, s);
        setSessions(m);
        setFeedEvents(payload.events);
        setStats(payload.stats);
      },
      onSessionUpdate: (s) => setSessions(prev => { const next = new Map(prev); next.set(s.sessionId, s); return next; }),
      onActivity: (e) => setFeedEvents(prev => [e, ...prev].slice(0, 500)),
      onStats: (s) => setStats(s),
      onError: () => setConnected(false),
    });
    return () => stream.abort();
  }, []);

  // 10s 定时刷新：强制重渲染，让节点位置周期性重算（2D 年龄扩散 + 3D token 高度）
  const [, setLayoutTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setLayoutTick(t => (t + 1) % 1_000_000_000), 10_000);
    return () => clearInterval(id);
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    try { setDetailEvents(await api.getAgentMapSessionEvents(id)); }
    catch { setDetailEvents([]); }
  }, []);

  const fetchSessionLogs = useCallback(async (source: 'global' | 'access-key', sessionId: string, keyId?: string): Promise<RequestLog[]> => {
    if (source === 'access-key' && keyId) return api.getAccessKeySessionLogs(keyId, sessionId, 10000);
    return api.getSessionLogs(sessionId, 10000);
  }, []);

  const openSessionDetail = useCallback((item: SessionMapItem) => {
    const source: 'global' | 'access-key' = item.source === 'access-key' ? 'access-key' : 'global';
    setDetailSession({
      id: item.sessionId, targetType: item.agent, title: item.title,
      firstRequestAt: item.firstRequestAt, lastRequestAt: item.lastRequestAt,
      requestCount: item.requestCount, totalTokens: item.totalTokens,
    });
    setDetailSessionLogs([]);
    setDetailSessionSource({ source, keyId: item.keyId, sessionId: item.sessionId });
    setDetailSessionLoading(true);
    fetchSessionLogs(source, item.sessionId, item.keyId)
      .then(logs => setDetailSessionLogs(logs))
      .catch(error => console.error('Failed to load session logs:', error))
      .finally(() => setDetailSessionLoading(false));
  }, [fetchSessionLogs]);

  const closeSessionDetail = useCallback(() => {
    setDetailSession(null); setDetailSessionLogs([]); setDetailSessionSource(null); setDetailSessionLoading(false);
  }, []);

  useEffect(() => {
    if (selectedId) loadDetail(selectedId);
    else setDetailEvents([]);
  }, [selectedId, loadDetail]);

  const selected = selectedId ? sessions.get(selectedId) : null;
  useEffect(() => {
    if (selectedId) loadDetail(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.lastRequestAt]);

  useEffect(() => {
    if (!selectedId) { setPathInfo({ loading: false }); return; }
    const s = sessions.get(selectedId);
    if (!s) { setPathInfo({ loading: false }); return; }
    if (s.source === 'access-key') { setPathInfo({ loading: false, unavailable: true }); return; }
    if (s.projectPath) { setPathInfo({ loading: false, projectPath: s.projectPath }); return; }
    setPathInfo({ loading: true });
    let alive = true;
    api.getAgentMapSessionMeta(selectedId)
      .then(m => { if (alive) setPathInfo({ loading: false, projectPath: m.projectPath }); })
      .catch(() => { if (alive) setPathInfo({ loading: false }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, selected?.projectPath]);

  // 定位：活动流行 → 选中 + 清除时间筛选 + 通知当前画布聚焦（2D 平移居中 / 3D 相机 lerp）
  const locateSession = useCallback((sessionId: string) => {
    if (!sessions.has(sessionId)) return;
    setSelectedId(sessionId);
    setPreset('all');
    setFeedOpen(true);
    setFocus({ sessionId, nonce: Date.now() });
  }, [sessions]);

  // 时间筛选
  const [preset, setPreset] = useState<Preset>('all');
  const nowQ = Math.floor(Date.now() / 10000) * 10000;
  const presetMs = PRESETS.find(p => p.key === preset)!.ms;
  const hasTimeFilter = preset !== 'all';
  const range = useMemo(() => (preset === 'all' ? null : { start: nowQ - presetMs, end: nowQ }), [preset, nowQ, presetMs]);
  const sessionList = useMemo(() => Array.from(sessions.values()), [sessions]);
  const filteredSessions = useMemo(() => {
    if (!range) return sessionList;
    return sessionList.filter(s => s.lastRequestAt >= range.start && s.lastRequestAt <= range.end);
  }, [sessionList, range]);

  // ===== 选中数据「粘性」：实时刷新瞬时缺失时沿用上次数据，避免侧栏在 详情↔活动流 之间闪跳 =====
  const selectedStickyRef = useRef<SessionMapItem | null>(null);
  if (selected) selectedStickyRef.current = selected;
  const selectedView = selected ?? (selectedId ? selectedStickyRef.current : null);
  useEffect(() => { if (!selectedId) selectedStickyRef.current = null; }, [selectedId]);

  // 点击节点 → 选中并确保侧栏展开（详情/活动流都在侧栏里）
  const handleSelect = useCallback((id: string | null) => {
    setSelectedId(id);
    if (id) setFeedOpen(true);
  }, []);

  // 趋势图窗口
  const oldestTs = feedEvents.length ? feedEvents[feedEvents.length - 1].ts : nowQ;
  const trendStart = preset === 'all' ? Math.min(oldestTs, nowQ - 24 * HOUR) : nowQ - presetMs;
  const trendEnd = nowQ;

  return (
    <div className="am-page">
      {/* 顶部状态条 */}
      <div className="am-header">
        <div className="am-title">
          <h2>🗺️ 任务雷达</h2>
          <span className={`am-conn${connected ? ' am-conn--on' : ''}`}>{connected ? '● 实时' : '○ 连接中'}</span>
        </div>
        <div className="am-stats">
          <span className="am-stat am-stat--active">进行中 <b>{stats?.activeSessions ?? 0}</b></span>
          <span className="am-stat am-stat--idle">空闲 <b>{stats?.idleSessions ?? 0}</b></span>
          <span className="am-stat am-stat--completed">已完成 <b>{stats?.completedSessions ?? 0}</b></span>
          <span className="am-stat am-stat--error">异常 <b>{stats?.errorSessions ?? 0}</b></span>
          <span className="am-stat">在途 <b>{stats?.inFlightRequests ?? 0}</b></span>
          <span className="am-stat">显示 <b>{filteredSessions.length}</b>/{sessionList.length}</span>
        </div>
        <div className="am-actions">
          <button className="am-btn am-toggle-btn" onClick={() => { setTimebarOpen(v => !v); setHelpOpen(false); }} title={timebarOpen ? '收起时间筛选' : '展开时间筛选'}>
            <span>时间筛选</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transition: 'transform 0.18s', transform: timebarOpen ? 'rotate(180deg)' : 'none' }}><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          <button className="am-btn am-toggle-btn" onClick={() => { setHelpOpen(v => !v); setTimebarOpen(false); }} title="符号说明">
            <span>符号说明</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transition: 'transform 0.18s', transform: helpOpen ? 'rotate(180deg)' : 'none' }}><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          <div className="am-notify-switch" title={notifyEnabled ? '已开启：每个会话的一轮任务结束时（请求完成、流结束，或停滞超过阈值）会弹一次系统通知' : '开启：每个会话的一轮任务结束时（请求完成、流结束，或停滞超过阈值）会弹一次系统通知'}>
            <Switch checked={notifyEnabled} onChange={toggleNotify} label="🔔 通知" />
            {notifyEnabled && (
              <button type="button" className="am-notify-test" onClick={() => api.testAgentMapNotify()} title="发一条测试通知，验证系统是否真的弹（若没弹，请在系统设置里允许 AICodeSwitch/终端 的通知）">测试</button>
            )}
          </div>
        </div>
        {helpOpen && <MapLegend onClose={() => setHelpOpen(false)} />}
      </div>

      {/* 时间筛选 Popover */}
      {timebarOpen && (
        <>
          <div className="am-popover-overlay" onClick={() => setTimebarOpen(false)} />
          <div className="am-popover am-popover--time">
            <div className="am-popover-head">
              <span>🕒 时间筛选</span>
              <button className="am-popover-close" onClick={() => setTimebarOpen(false)} aria-label="关闭">×</button>
            </div>
            <div className="am-timefilter">
              <div className="am-timepresets">
                {PRESETS.map(p => (
                  <button key={p.key} className={`am-chip${preset === p.key ? ' am-chip--active' : ''}`} onClick={() => setPreset(p.key)}>{p.label}</button>
                ))}
              </div>
              <TrendChart events={feedEvents} start={trendStart} end={trendEnd} />
            </div>
            {hasTimeFilter && (
              <div className="am-timefilter-hint">
                已筛选：{new Date(range!.start).toLocaleString()} → 现在 · 显示 {filteredSessions.length}/{sessionList.length}
              </div>
            )}
          </div>
        </>
      )}

      <div className="am-main">
        {/* 画布（2D / 3D 完全隔离的独立组件） */}
        <div className="am-canvas-wrap">
          {sessionList.length === 0 ? (
            <div className="am-empty-canvas">
              <div className="am-empty-icon">🌌</div>
              <p>暂无 Session</p>
              <p className="am-empty-hint">启动 Claude Code 或 Codex 开始编程，节点会实时出现在这里</p>
            </div>
          ) : view3D && !webglFailed ? (
            <AgentMapCanvas3D
              sessions={filteredSessions}
              now={nowQ}
              selectedId={selectedId}
              onSelect={handleSelect}
              showLabels={showLabels}
              showLinks={showLinks}
              focus={focus}
              resetNonce={resetNonce}
              onContextLost={() => setWebglFailed(true)}
            />
          ) : (
            <AgentMapCanvas2D
              sessions={filteredSessions}
              now={nowQ}
              selectedId={selectedId}
              onSelect={handleSelect}
              view={view}
              onView={setView}
              focus={focus}
            />
          )}
          <div className="am-legend">
            <span><i className="am-dot am-dot--active" /> 进行中</span>
            <span><i className="am-dot am-dot--idle" /> 空闲</span>
            <span><i className="am-dot am-dot--completed" /> 已完成</span>
            <span><i className="am-dot am-dot--error" /> 异常</span>
          </div>
          <div className="am-float-controls">
            <div className="am-view-toggle" role="group" aria-label="2D / 3D 视图切换">
              <button className={`am-view-btn${!view3D ? ' am-view-btn--active' : ''}`} onClick={() => setView3D(false)} title="2D 平面视图（默认）">2D</button>
              <button
                className={`am-view-btn${view3D ? ' am-view-btn--active' : ''}${webglFailed ? ' am-view-btn--disabled' : ''}`}
                onClick={() => { if (!webglFailed) setView3D(true); }}
                disabled={webglFailed}
                title={webglFailed ? 'WebGL 不可用，已回退到 2D' : '3D 场景视图（Three.js）：自由轨道旋转/缩放/平移'}
              >3D</button>
            </div>
            {view3D && !webglFailed ? (
              <div className="am-view-toggle" role="group" aria-label="3D 显示控制">
                <button
                  className={`am-view-btn am-view-btn--link${showLinks ? ' am-view-btn--active' : ''}`}
                  onClick={() => setShowLinks(v => !v)}
                  title={showLinks ? '隐藏中心点到节点的 Token 连线（选中节点的连线仍显示）' : '显示中心点到节点的 Token 连线'}
                >连线</button>
                <button
                  className={`am-view-btn am-view-btn--label${showLabels ? ' am-view-btn--active' : ''}`}
                  onClick={() => setShowLabels(v => !v)}
                  title={showLabels ? '隐藏所有节点标签（仅保留选中节点）' : '显示所有节点标签'}
                >标签</button>
                <button className="am-view-btn" onClick={() => setResetNonce(n => n + 1)} title="复位视角">复位</button>
              </div>
            ) : (
              <ZoomControls view={view} onView={setView} />
            )}
          </div>
        </div>

        {/* 右侧侧栏：选中节点 → 节点详情面板；未选中 → 全局活动流 */}
        <div className="am-feed-wrap">
          <button className="am-feed-toggle" onClick={toggleFeed} title={feedOpen ? '收起侧栏' : '展开侧栏'} aria-label={feedOpen ? '收起侧栏' : '展开侧栏'}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {feedOpen ? <polyline points="9 18 15 12 9 6" /> : <polyline points="15 18 9 12 15 6" />}
            </svg>
          </button>
          {feedOpen && (
            <aside className="am-feed-sidebar">
              {selectedView ? (
                <div className="am-detail am-detail--sidebar">
                  <div className="am-detail-head">
                    <span className={`am-badge am-badge--${selectedView.status}`}>
                      <AgentIcon agent={selectedView.agent} size={14} /> {STATUS_LABEL[selectedView.status]}
                    </span>
                    <button className="am-detail-close" onClick={() => setSelectedId(null)} title="返回活动流">×</button>
                  </div>
                  <div className="am-detail-body">
                    <h3 className="am-detail-title">{selectedView.title || selectedView.sessionId}</h3>
                    <div className="am-detail-meta">
                      <div>请求轮次：<b>{selectedView.requestCount}</b></div>
                      <div>输入 Token：<b>{(selectedView.inputTokens || 0).toLocaleString()}</b></div>
                      <div>输出 Token：<b>{(selectedView.outputTokens || 0).toLocaleString()}</b></div>
                      <div>累计 Token：<b>{(selectedView.totalTokens || 0).toLocaleString()}</b></div>
                      <div>最近模型：<b>{selectedView.lastModel || '-'}</b></div>
                      <div className="am-detail-path">
                        项目路径：
                        {pathInfo.projectPath
                          ? <code title={pathInfo.projectPath}>{pathInfo.projectPath}</code>
                          : pathInfo.unavailable
                            ? <span className="am-detail-path-na">接入密钥会话，无法读取本地项目信息</span>
                            : pathInfo.loading
                              ? <span className="am-detail-path-na">解析中…</span>
                              : <span className="am-detail-path-na">未识别</span>}
                      </div>
                      <div>首/末：<b>{timeAgo(selectedView.firstRequestAt)}</b> · <b>{timeAgo(selectedView.lastRequestAt)}</b></div>
                    </div>
                    <div className="am-detail-section-title">活动路径</div>
                    <ActivityPathGraph events={detailEvents} />
                  </div>
                  <div className="am-detail-footer">
                    <button className="am-btn am-btn--ghost" onClick={() => loadDetail(selectedView.sessionId)}>刷新活动</button>
                    <button className="am-btn am-btn--ghost" disabled={selectedView.source === 'access-key' && !selectedView.keyId} onClick={() => openSessionDetail(selectedView)}>会话详情</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="am-feed-head">
                    <span>📜 全局活动流</span>
                    <span className="am-feed-count">{feedEvents.length}</span>
                  </div>
                  <ActivityFeed events={feedEvents} onSelectSession={locateSession} />
                </>
              )}
            </aside>
          )}
        </div>
      </div>

      {/* 会话详情弹窗 */}
      {detailSession && detailSessionSource && (
        <SessionDetailModal
          session={detailSession}
          logs={detailSessionLogs}
          logsLoading={detailSessionLoading}
          onRefreshLogs={async () => {
            if (!detailSessionSource) return;
            setDetailSessionLoading(true);
            try {
              const logs = await fetchSessionLogs(detailSessionSource.source, detailSessionSource.sessionId, detailSessionSource.keyId);
              setDetailSessionLogs(logs);
            } catch (error) {
              console.error('Failed to refresh session logs:', error);
            } finally {
              setDetailSessionLoading(false);
            }
          }}
          onFetchNewLogs={async () => {
            if (!detailSessionSource) return [];
            const logs = await fetchSessionLogs(detailSessionSource.source, detailSessionSource.sessionId, detailSessionSource.keyId);
            setDetailSessionLogs(logs);
            return logs;
          }}
          onClose={closeSessionDetail}
        />
      )}
    </div>
  );
}
