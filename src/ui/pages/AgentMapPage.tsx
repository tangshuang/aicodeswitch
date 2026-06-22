/**
 * Agent Map（任务可视化节点地图）
 *
 * 把每个 Claude Code / Codex Session 画成画布上的一个节点（"星球"），
 * 状态（进行中 / 空闲 / 已完成 / 异常）由后端活跃度推断并经 SSE 实时推送。
 *
 * 能力：
 * - 鼠标滚轮缩放 + 拖拽平移 + 节点拖拽（缩放下仍可精确点击/拖动）
 * - 按时间筛选 Session（全部 / 1h / 6h / 24h / 7d）
 * - 时间分布直方图，点击柱子快速框选该时间段
 * - 点开节点查看活动路径子图（提问 → 工具调用链 → 响应）
 *
 * 数据源：/api/agent-map/stream（SSE 实时） + REST 冷启动补齐。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import { api } from '../api/client';
import { ClaudeCodeIcon, CodexIcon, AgentIcon } from '../components/AgentIcons';
import { Switch } from '../components/Switch';
import SessionDetailModal from '../components/SessionDetailModal';
import { useAgentNotifications } from '../components/AgentNotificationsProvider';
import type {
  ActivityEvent,
  AgentMapInitPayload,
  AgentMapStats,
  RequestLog,
  SessionMapItem,
} from '../../types';

// SessionDetailModal 所需的会话信息子集（SessionMapItem 已覆盖全部字段，用于立即打开弹窗）
type SessionDetailInfo = {
  id: string;
  targetType: string;
  title?: string;
  firstRequestAt: number;
  lastRequestAt: number;
  requestCount: number;
  totalTokens: number;
};

// ============================ 工具与常量 ============================

const SVG_W = 1000;
const SVG_H = 700;
const HOUR = 3600_000;
const DAY = 86400_000;
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 4;

const TOOL_ICON: Record<string, string> = {
  Read: '📖', Edit: '📝', Write: '📝', MultiEdit: '📝',
  Bash: '🔧', Glob: '🔍', Grep: '🔍',
  WebFetch: '🌐', WebSearch: '🌐',
  Agent: '🤖', Task: '🤖',
  NotebookEdit: '📓',
};

const STATUS_LABEL: Record<string, string> = {
  active: '进行中', idle: '空闲', completed: '已完成', error: '异常',
};

type Preset = 'all' | '1h' | '6h' | '24h' | '7d';

// 节点视觉半径：默认很小，仅随对话轮数增长，封顶避免过大；尺寸差距刻意拉大
const NODE_R_MIN = 8;
const NODE_R_MAX = 96;
const PRESETS: { key: Preset; label: string; ms: number }[] = [
  { key: 'all', label: '全部', ms: 0 },
  { key: '1h', label: '近 1 小时', ms: HOUR },
  { key: '6h', label: '近 6 小时', ms: 6 * HOUR },
  { key: '24h', label: '近 24 小时', ms: 24 * HOUR },
  { key: '7d', label: '近 7 天', ms: 7 * DAY },
];

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * 计算节点基础位置：
 * - 半径（距中心距离）以「会话开始时间 firstRequestAt」为准：越早开始的会话越靠外围，
 *   使用饱和函数 t = age/(age+TAU) 增长到 MAX_R 后收敛、不会无限远。
 *   由于 firstRequestAt 不随后续请求变化，节点落定后位置稳定、不再漂移。
 * - 角度由 sessionId 哈希决定（稳定，新增节点不会扰动已有节点位置）。
 *
 * 半径量级刻意放大：MAX_R 使最早开始的节点在画布缩到 40% 时才出现在最外围
 * （R_MAX * 0.4 ≈ 350 ≈ viewBox 短半轴），日常 100% 视野只聚焦近期开始的会话。
 */
// [会话开始距今天数, 半径] 控制点：内圈分布最宽、越往外越紧凑
const R_POINTS: [number, number][] = [
  [0, 80],
  [1, 420],
  [5, 620],
  [10, 760],
  [30, 860],
];
// 距离分档临界圆：1 / 5 / 10 天（10 天为最外圈，超过 10 天的节点落在此圈之外）
const RINGS: { days: number; r: number; tier: number; label: string }[] = [
  { days: 1, r: 420, tier: 0, label: '1 天' },
  { days: 5, r: 620, tier: 1, label: '5 天' },
  { days: 10, r: 760, tier: 2, label: '10 天' },
];
function radiusForAgeDays(ageDays: number): number {
  if (ageDays <= 0) return R_POINTS[0][1];
  for (let i = 1; i < R_POINTS.length; i++) {
    if (ageDays <= R_POINTS[i][0]) {
      const [a0, r0] = R_POINTS[i - 1];
      const [a1, r1] = R_POINTS[i];
      const k = (ageDays - a0) / (a1 - a0);
      return r0 + (r1 - r0) * k;
    }
  }
  return R_POINTS[R_POINTS.length - 1][1]; // 超过最大档位，封顶
}
function basePosition(sessionId: string, firstRequestAt: number, now: number) {
  const cx = SVG_W / 2;
  const cy = SVG_H / 2;
  const ageDays = Math.max(0, now - firstRequestAt) / DAY;
  const radius = radiusForAgeDays(ageDays);
  // 主角度由 hash 决定；再用第二个 hash 做小幅抖动，避免同角度重叠
  const angle = ((hashStr(sessionId) % 360) + (hashStr(sessionId + '~j') % 40 - 20)) * (Math.PI / 180);
  return {
    x: cx + Math.cos(angle) * radius,
    y: cy + Math.sin(angle) * radius,
  };
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}秒前`;
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}小时前`;
  return `${Math.floor(diff / 86400_000)}天前`;
}

interface NodePos { x: number; y: number; }
interface View { zoom: number; panX: number; panY: number; }

// ============================ 画布节点 ============================

function SessionNodeSvg({ item, pos, selected }: {
  item: SessionMapItem;
  pos: NodePos;
  selected: boolean;
}) {
  // 节点尺寸：默认小，仅随对话轮数增长，封顶；尺寸越大代表历史对话轮数越多
  const req = item.requestCount || 0;
  const activity = Math.min(req / 100, 1); // 0..1 饱和（30 轮约半饱和）
  const r = NODE_R_MIN + (NODE_R_MAX - NODE_R_MIN) * activity;
  const iconSize = Math.round(r * 0.85);

  return (
    <g
      transform={`translate(${pos.x} ${pos.y})`}
      className={`am-node am-node--${item.status}${selected ? ' am-node--selected' : ''}`}
      data-sid={item.sessionId}
    >
      <circle r={r + 6} className="am-node-glow" />
      <circle r={r} className="am-node-circle" vectorEffect="non-scaling-stroke" />
      {item.agent === 'codex'
        ? <CodexIcon size={iconSize} x={-iconSize / 2} y={-iconSize / 2} />
        : <ClaudeCodeIcon size={iconSize} x={-iconSize / 2} y={-iconSize / 2} />}
      <text textAnchor="middle" dy={r + 16} className="am-node-title">
        {(item.title || item.sessionId.slice(-8)).slice(0, 18)}
      </text>
      <text textAnchor="middle" dy={r + 32} className="am-node-activity">
        {item.lastToolName
          ? `${TOOL_ICON[item.lastToolName] || '•'} ${item.lastToolName}`
          : (item.lastActivitySummary || '').slice(0, 20) || timeAgo(item.lastRequestAt)}
      </text>
      {item.source === 'access-key' && (
        <text textAnchor="middle" dy={r + 48} className="am-node-source">🔑 {item.keyName || 'key'}</text>
      )}
    </g>
  );
}

// ============================ 缩放控制 ============================

function ZoomControls({ view, onView }: { view: View; onView: (v: View) => void }) {
  const zoomBy = (factor: number) => {
    // 以画布中心为锚点缩放
    const cx = SVG_W / 2, cy = SVG_H / 2;
    const { zoom, panX, panY } = view;
    const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom * factor));
    const ux = (cx - panX) / zoom;
    const uy = (cy - panY) / zoom;
    onView({ zoom: newZoom, panX: cx - ux * newZoom, panY: cy - uy * newZoom });
  };
  const pct = Math.round(view.zoom * 100);
  return (
    <div className="am-zoom">
      <button className="am-zoom-btn" onClick={() => zoomBy(1 / 1.2)} title="缩小">−</button>
      <span className="am-zoom-pct">{pct}%</span>
      <button className="am-zoom-btn" onClick={() => zoomBy(1.2)} title="放大">+</button>
      <button
        className="am-zoom-btn"
        onClick={() => onView({ zoom: 1, panX: 0, panY: 0 })}
        title="重置缩放"
      >⟲</button>
    </div>
  );
}

// ============================ 时间直方图 ============================

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
  if (spanMs <= DAY) {
    // 小时级
    return `${s.getHours().toString().padStart(2, '0')}:00`;
  }
  return `${s.getMonth() + 1}/${s.getDate()}`;
}

/** Catmull-Rom 转三次贝塞尔，生成平滑曲线 path */
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

/** 平滑曲线趋势图（仅展示，不可交互筛选） */
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

// ============================ 活动路径子图（详情） ============================

function ActivityPathGraph({ events }: { events: ActivityEvent[] }) {
  if (events.length === 0) {
    return <div className="am-empty">暂无活动记录（发起一次请求后会出现）</div>;
  }
  const sorted = [...events].sort((a, b) => b.ts - a.ts);

  // 游程折叠：相邻且 kind+toolName+summary 相同的事件合并为一组，
  // 渲染成单行 + 「×N」徽标（纯静态展示，无展开交互）。消除连续相同工具调用等视觉重复。
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
              {g.kind === 'prompt' && (
                <div className="am-path-prompt">{g.summary}</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ============================ 全局活动 feed ============================

function ActivityFeed({ events, onSelectSession }: { events: ActivityEvent[]; onSelectSession?: (sessionId: string) => void }) {
  if (events.length === 0) {
    return <div className="am-feed-empty">等待实时活动…</div>;
  }
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

// ============================ 图例说明（Popover） ============================

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
              <LegendRow icon={<ClaudeCodeIcon size={16} />} label="Claude Code"
                desc="该 Session 来自 Claude Code 客户端" />
              <LegendRow icon={<CodexIcon size={16} />} label="Codex"
                desc="该 Session 来自 Codex 客户端" />
            </LegendGroup>

            <LegendGroup title="节点状态（外环颜色 + 光晕）">
              <LegendRow icon={<i className="am-dot am-dot--active" />} label="进行中"
                desc="最近 60 秒内有请求，或有在途请求（脉冲发光）" />
              <LegendRow icon={<i className="am-dot am-dot--idle" />} label="空闲"
                desc="超过 60 秒无新请求，但 10 分钟内有过活动" />
              <LegendRow icon={<i className="am-dot am-dot--completed" />} label="已完成"
                desc="超过 10 分钟无活动，且末轮正常结束（变暗、虚线）" />
              <LegendRow icon={<i className="am-dot am-dot--error" />} label="异常"
                desc="末次请求失败（上游 5xx），红色脉冲" />
            </LegendGroup>

            <LegendGroup title="距离分档（同心圆）">
              <LegendRow icon={<span className="am-ring-swatch" style={{ color: 'var(--accent-success)' }} />} label="1 天临界"
                desc="圈内在 1 天内开始的会话；圈外是更早（1 天以上）的会话" />
              <LegendRow icon={<span className="am-ring-swatch" style={{ color: 'var(--accent-warning)' }} />} label="5 天临界"
                desc="1–5 天前开始的会话落在本圈与 1 天圈之间" />
              <LegendRow icon={<span className="am-ring-swatch" style={{ color: '#6BA8E5' }} />} label="10 天临界（最外圈）"
                desc="5–10 天前开始的会话落在本圈与 5 天圈之间；超过 10 天的会话落在本圈之外（最外围）" />
            </LegendGroup>
          </div>

          <div className="am-legend-col">
            <LegendGroup title="节点装饰">
              <LegendRow icon={<span>🔑</span>} label="接入密钥来源"
                desc="节点下方钥匙标记，走 AccessKey 接入密钥流量" />
              <LegendRow icon={<span className="am-ic-center" />} label="中心点"
                desc="画布中心圆点，进行中节点会与它连线" />
            </LegendGroup>

            <LegendGroup title="节点位置与尺寸">
              <LegendRow icon={<span>🎯</span>} label="距中心距离 = 会话开始时间"
                desc="以会话开始时间（firstRequestAt）按龄分档：1 天内居内侧（分布最宽），1–5 天、5–10 天依次外扩，10 天以上在最外围（缩到约 40% 可见）。内圈带宽最大、越往外越紧凑，落定后不漂移" />
              <LegendRow icon={<span>🔵</span>} label="节点大小 = 对话轮数"
                desc="默认较小，仅随对话轮数（requestCount）增长并封顶，越大代表历史对话轮数越多" />
            </LegendGroup>

            <LegendGroup title="操作">
              <LegendRow icon={<span className="am-ic-mouse">🖱</span>} label="缩放 / 平移"
                desc="滚轮缩放（光标处为锚点）；在节点或空白处按下拖拽即可平移画布，短按选中节点" />
              <LegendRow icon={<span className="am-ic-chart">📈</span>} label="时间筛选"
                desc="点 topbar「时间筛选」按预设区间过滤；趋势曲线仅作参考" />
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
  // 会话详情弹窗（复用 SessionDetailModal）：按来源分流拉取 global / access-key 日志
  const [detailSession, setDetailSession] = useState<SessionDetailInfo | null>(null);
  const [detailSessionLogs, setDetailSessionLogs] = useState<RequestLog[]>([]);
  const [detailSessionLoading, setDetailSessionLoading] = useState(false);
  // 打开会话详情时记录来源元信息，供刷新 / 拉取新日志复用
  const [detailSessionSource, setDetailSessionSource] = useState<{ source: 'global' | 'access-key'; keyId?: string; sessionId: string } | null>(null);
  // 详情 popover：项目路径（按需向后端解析，仅 global 来源）
  const [pathInfo, setPathInfo] = useState<{ loading: boolean; projectPath?: string; unavailable?: boolean }>({ loading: false });
  // 全局活动流默认展开（每次进入页面均展示）
  const [feedOpen, setFeedOpen] = useState(true);
  const toggleFeed = useCallback(() => setFeedOpen(prev => !prev), []);
  const [helpOpen, setHelpOpen] = useState(false);
  // 时间筛选工具条默认展开，可在 topbar 收起
  const [timebarOpen, setTimebarOpen] = useState(false);
  // 任务结束浏览器通知（全局 Provider 提供）
  const { enabled: notifyEnabled, toggle: toggleNotify } = useAgentNotifications();
  const [connected, setConnected] = useState(false);
  // 画布按下时切换为 grabbing 光标
  const [pressing, setPressing] = useState(false);

  // 缩放 / 平移
  const [view, setView] = useState<View>({ zoom: 1, panX: 0, panY: 0 });
  const viewRef = useRef(view); viewRef.current = view;

  // 时间筛选
  const [preset, setPreset] = useState<Preset>('all');

  const svgRef = useRef<SVGSVGElement>(null);
  const groupRef = useRef<SVGGElement>(null);

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
      onSessionUpdate: (s) => {
        setSessions(prev => {
          const next = new Map(prev);
          next.set(s.sessionId, s);
          return next;
        });
      },
      onActivity: (e) => {
        setFeedEvents(prev => [e, ...prev].slice(0, 500));
      },
      onStats: (s) => setStats(s),
      onError: () => setConnected(false),
    });
    return () => stream.abort();
  }, []);

  // 拉取选中节点详情事件
  const loadDetail = useCallback(async (id: string) => {
    try {
      const evs = await api.getAgentMapSessionEvents(id);
      setDetailEvents(evs);
    } catch {
      setDetailEvents([]);
    }
  }, []);

  // 按来源（global / access-key）拉取会话日志（session 信息直接取自 SessionMapItem）
  const fetchSessionLogs = useCallback(async (
    source: 'global' | 'access-key',
    sessionId: string,
    keyId?: string,
  ): Promise<RequestLog[]> => {
    if (source === 'access-key' && keyId) {
      return api.getAccessKeySessionLogs(keyId, sessionId, 10000);
    }
    return api.getSessionLogs(sessionId, 10000);
  }, []);

  // 打开「会话详情」弹窗：立即用 SessionMapItem 构造 session 打开，日志后台加载
  const openSessionDetail = useCallback((item: SessionMapItem) => {
    const source: 'global' | 'access-key' = item.source === 'access-key' ? 'access-key' : 'global';
    setDetailSession({
      id: item.sessionId,
      targetType: item.agent,
      title: item.title,
      firstRequestAt: item.firstRequestAt,
      lastRequestAt: item.lastRequestAt,
      requestCount: item.requestCount,
      totalTokens: item.totalTokens,
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
    setDetailSession(null);
    setDetailSessionLogs([]);
    setDetailSessionSource(null);
    setDetailSessionLoading(false);
  }, []);

  useEffect(() => {
    if (selectedId) loadDetail(selectedId);
    else setDetailEvents([]);
  }, [selectedId, loadDetail]);

  // 选中节点的 lastRequestAt 变化时（有新请求结束），刷新详情活动
  const selected = selectedId ? sessions.get(selectedId) : null;
  useEffect(() => {
    if (selectedId) loadDetail(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.lastRequestAt]);

  // 项目路径：access-key 直接标记不可用；global 若 SSE 已带 projectPath 则直接用，否则按需解析
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

  // ===== 坐标转换工具（client → SVG viewBox / 用户空间） =====
  const clientToViewBox = useCallback((cx: number, cy: number): { x: number; y: number } | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const pt = svg.createSVGPoint();
    pt.x = cx; pt.y = cy;
    const p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }, []);

  // ===== 滚轮缩放（原生非被动监听，确保 preventDefault 生效） =====
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const V = clientToViewBox(e.clientX, e.clientY);
      if (!V) return;
      const { zoom, panX, panY } = viewRef.current;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom * factor));
      const ux = (V.x - panX) / zoom;
      const uy = (V.y - panY) / zoom;
      setView({ zoom: newZoom, panX: V.x - ux * newZoom, panY: V.y - uy * newZoom });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [clientToViewBox, sessions.size]);

  // ===== 画布拖拽平移 + 点击选中（节点与空白统一处理，按下→抬起距离区分点击/拖拽） =====
  const pressRef = useRef<{
    startClient: { x: number; y: number };
    startVB: { x: number; y: number };
    panX: number; panY: number;
    moved: boolean;
    sid: string | null;
  } | null>(null);

  const onCanvasPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    setPressing(true);
    // 识别按下处是否落在某个节点上（沿 DOM 向上找 data-sid）
    let el = e.target as Element | null;
    let sid: string | null = null;
    while (el && el !== e.currentTarget) {
      const attr = el.getAttribute && el.getAttribute('data-sid');
      if (attr) { sid = attr; break; }
      el = el.parentElement;
    }
    const vb = clientToViewBox(e.clientX, e.clientY);
    pressRef.current = {
      startClient: { x: e.clientX, y: e.clientY },
      startVB: vb || { x: 0, y: 0 },
      panX: viewRef.current.panX,
      panY: viewRef.current.panY,
      moved: false,
      sid,
    };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
  const onCanvasPointerMove = (e: React.PointerEvent) => {
    const p = pressRef.current;
    if (!p) return;
    if (!p.moved && Math.hypot(e.clientX - p.startClient.x, e.clientY - p.startClient.y) > 5) {
      p.moved = true;
      // 一旦判定为拖拽平移，立即关闭详情 popover（避免遮挡 / 跟随抖动）
      setSelectedId(null);
    }
    // 拖拽即平移（在节点上或空白上都生效）
    const cur = clientToViewBox(e.clientX, e.clientY);
    if (!cur) return;
    setView(v => ({ ...v, panX: p.panX + (cur.x - p.startVB.x), panY: p.panY + (cur.y - p.startVB.y) }));
  };
  const onCanvasPointerUp = () => {
    setPressing(false);
    const p = pressRef.current;
    pressRef.current = null;
    if (!p || p.moved) return; // 发生了拖拽平移，不改变选中态
    // 未移动 → 视为点击：点节点选中并展开详情，点空白关闭详情
    setSelectedId(p.sid);
  };
  const onCanvasPointerLeave = () => {
    // 指针离开 / 取消时兜底复位光标与按压态（pointer 已 capture，up 仍会触发）
    if (!pressRef.current) setPressing(false);
  };

  // ===== 节点布局 =====
  const sessionList = useMemo(() => Array.from(sessions.values()), [sessions]);

  // 时间筛选窗口
  // nowQ 按 30s 量化：作为 useMemo 依赖时在同一桶内值不变，避免每渲染重建 range/filteredSessions/layout
  // （否则会与详情 popover 的 useLayoutEffect 形成 setState 循环 → Maximum update depth）
  const nowQ = Math.floor(Date.now() / 30000) * 30000;
  const presetMs = PRESETS.find(p => p.key === preset)!.ms;
  const hasTimeFilter = preset !== 'all';
  const range = useMemo(
    () => (preset === 'all' ? null : { start: nowQ - presetMs, end: nowQ }),
    [preset, nowQ, presetMs]
  );
  const filteredSessions = useMemo(() => {
    if (!range) return sessionList;
    return sessionList.filter(s => s.lastRequestAt >= range.start && s.lastRequestAt <= range.end);
  }, [sessionList, range]);

  const layout = useMemo(() => {
    const pos: Record<string, NodePos> = {};
    for (const s of filteredSessions) {
      pos[s.sessionId] = basePosition(s.sessionId, s.firstRequestAt, nowQ);
    }
    return pos;
  }, [filteredSessions, nowQ]);

  // 点击全局活动流某条 → 定位到地图节点并展开详情 popover
  const locateSession = useCallback((sessionId: string) => {
    const s = sessions.get(sessionId);
    if (!s) return;
    setSelectedId(sessionId);
    setPreset('all'); // 清除时间筛选，确保该节点出现在画布上
    // 计算节点用户空间位置，平移视图使其居中（保持当前缩放）
    const pos = basePosition(sessionId, s.firstRequestAt, Date.now());
    setView(v => ({
      zoom: v.zoom,
      panX: SVG_W / 2 - pos.x * v.zoom,
      panY: SVG_H / 2 - pos.y * v.zoom,
    }));
  }, [sessions]);

  // ===== 详情 Popover 定位（跟随节点屏幕位置，禁止溢出屏幕） =====
  const detailRef = useRef<HTMLDivElement>(null);
  const [detailStyle, setDetailStyle] = useState<React.CSSProperties>({ visibility: 'hidden' });
  const [detailPlacement, setDetailPlacement] = useState<'left' | 'right'>('right');
  const [recomputeTick, setRecomputeTick] = useState(0);

  // 滚动 / 窗口尺寸变化 → 触发重新定位（popover 为 fixed，需主动跟随）
  useEffect(() => {
    const bump = () => setRecomputeTick(t => (t + 1) % 1_000_000);
    window.addEventListener('resize', bump);
    window.addEventListener('scroll', bump, true);
    return () => {
      window.removeEventListener('resize', bump);
      window.removeEventListener('scroll', bump, true);
    };
  }, []);

  useLayoutEffect(() => {
    if (!selectedId) return;
    const el = detailRef.current;
    const g = groupRef.current;
    const svg = svgRef.current;
    if (!el || !g || !svg) return;
    const nodePos = layout[selectedId];
    if (!nodePos) return;
    const ctm = g.getScreenCTM();
    if (!ctm) return;
    // 节点中心 → 屏幕坐标（含缩放 / 平移 / 滚动）
    const pt = svg.createSVGPoint();
    pt.x = nodePos.x; pt.y = nodePos.y;
    const screen = pt.matrixTransform(ctm);

    const rect = el.getBoundingClientRect();
    const margin = 10;
    const gap = 16;
    const nodeR = 30;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // 水平：优先右侧，空间不足放左侧；两侧都放不下则贴边
    let placement: 'left' | 'right' = 'right';
    let left: number;
    if (screen.x + nodeR + gap + rect.width <= vw - margin) {
      left = screen.x + nodeR + gap;
      placement = 'right';
    } else if (screen.x - nodeR - gap - rect.width >= margin) {
      left = screen.x - nodeR - gap - rect.width;
      placement = 'left';
    } else {
      left = Math.max(margin, Math.min(screen.x, vw - rect.width - margin));
    }
    // 垂直：以节点为中心，整体 clamp 进屏幕
    let top = screen.y - rect.height / 2;
    top = Math.max(margin, Math.min(top, vh - rect.height - margin));

    setDetailPlacement(placement);
    setDetailStyle({ left, top, visibility: 'visible' });
  }, [selectedId, layout, view, sessions, detailEvents, recomputeTick]);

  // 趋势图窗口（始终反映 preset 窗口；仅展示参考，不参与筛选）
  const oldestTs = feedEvents.length ? feedEvents[feedEvents.length - 1].ts : nowQ;
  const trendStart = preset === 'all' ? Math.min(oldestTs, nowQ - 24 * HOUR) : nowQ - presetMs;
  const trendEnd = nowQ;

  return (
    <div className="am-page">
      {/* 顶部状态条 */}
      <div className="am-header">
        <div className="am-title">
          <h2>🗺️ 任务雷达</h2>
          <span className={`am-conn${connected ? ' am-conn--on' : ''}`}>
            {connected ? '● 实时' : '○ 连接中'}
          </span>
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
          <button
            className="am-btn am-toggle-btn"
            onClick={() => { setTimebarOpen(v => !v); setHelpOpen(false); }}
            title={timebarOpen ? '收起时间筛选' : '展开时间筛选'}
          >
            <span>时间筛选</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transition: 'transform 0.18s', transform: timebarOpen ? 'rotate(180deg)' : 'none' }}>
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          <button
            className="am-btn am-toggle-btn"
            onClick={() => { setHelpOpen(v => !v); setTimebarOpen(false); }}
            title="符号说明"
          >
            <span>符号说明</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transition: 'transform 0.18s', transform: helpOpen ? 'rotate(180deg)' : 'none' }}>
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          <div
            className="am-notify-switch"
            title={notifyEnabled
              ? '已开启：本页处于后台时，Agent 一轮工作结束会弹系统通知（服务端 OS 通知，浏览器关掉也能弹）'
              : '开启：本页处于后台时，Agent 一轮工作结束会弹系统通知'}
          >
            <Switch
              checked={notifyEnabled}
              onChange={toggleNotify}
              label="🔔 通知"
              labelPosition="left"
            />
            {notifyEnabled && (
              <button
                type="button"
                className="am-notify-test"
                onClick={() => api.testAgentMapNotify()}
                title="发一条测试通知，验证系统是否真的弹（若没弹，请在系统设置里允许 AICodeSwitch/终端 的通知）"
              >
                测试
              </button>
            )}
          </div>
        </div>
        {helpOpen && <MapLegend onClose={() => setHelpOpen(false)} />}
      </div>

      {/* 时间筛选 Popover（点 topbar「时间筛选」展开，不占用画布空间） */}
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
                  <button
                    key={p.key}
                    className={`am-chip${preset === p.key ? ' am-chip--active' : ''}`}
                    onClick={() => setPreset(p.key)}
                  >
                    {p.label}
                  </button>
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
        {/* 画布 */}
        <div className="am-canvas-wrap">
          {sessionList.length === 0 ? (
            <div className="am-empty-canvas">
              <div className="am-empty-icon">🌌</div>
              <p>暂无 Session</p>
              <p className="am-empty-hint">启动 Claude Code 或 Codex 开始编程，节点会实时出现在这里</p>
            </div>
          ) : (
            <svg
              ref={svgRef}
              className="am-canvas"
              viewBox={`0 0 ${SVG_W} ${SVG_H}`}
              preserveAspectRatio="xMidYMid meet"
              onPointerDown={onCanvasPointerDown}
              onPointerMove={onCanvasPointerMove}
              onPointerUp={onCanvasPointerUp}
              onPointerLeave={onCanvasPointerLeave}
              onPointerCancel={onCanvasPointerUp}
              style={{ cursor: pressing ? 'grabbing' : 'grab', touchAction: 'none' }}
            >
              <rect x={0} y={0} width={SVG_W} height={SVG_H} fill="transparent" />
              <g ref={groupRef} transform={`translate(${view.panX} ${view.panY}) scale(${view.zoom})`}>
                {/* 中心标记 */}
                <circle cx={SVG_W / 2} cy={SVG_H / 2} r={4} className="am-center-mark" />
                {/* 距离分档临界圆（2 / 5 / 10 天 + 最外围），浅色虚线，由内向外颜色递深 */}
                {RINGS.map(ring => (
                  <g key={`ring-${ring.days}`} className={`am-ring am-ring--t${ring.tier}`}>
                    <circle cx={SVG_W / 2} cy={SVG_H / 2} r={ring.r} fill="none" />
                    <text x={SVG_W / 2} y={SVG_H / 2 - ring.r - 6} textAnchor="middle" className="am-ring-label">
                      {ring.label}
                    </text>
                  </g>
                ))}
                {/* 连线（active 节点到中心） */}
                {filteredSessions.filter(s => s.status === 'active').map(s => {
                  const p = layout[s.sessionId];
                  if (!p) return null;
                  return <line key={`l-${s.sessionId}`} x1={SVG_W / 2} y1={SVG_H / 2} x2={p.x} y2={p.y} className="am-link am-link--active" />;
                })}
                {/* 节点：active / error / 选中节点排在最后渲染，确保脉冲发光永远处于最顶层、不被遮住 */}
                {[...filteredSessions]
                  .sort((a, b) => {
                    const top = (s: SessionMapItem) => (s.status === 'active' || s.status === 'error' || s.sessionId === selectedId) ? 1 : 0;
                    return top(a) - top(b);
                  })
                  .map(s => {
                  const p = layout[s.sessionId];
                  if (!p) return null;
                  return (
                    <SessionNodeSvg
                      key={s.sessionId}
                      item={s}
                      pos={p}
                      selected={s.sessionId === selectedId}
                    />
                  );
                })}
              </g>
            </svg>
          )}
          <div className="am-legend">
            <span><i className="am-dot am-dot--active" /> 进行中</span>
            <span><i className="am-dot am-dot--idle" /> 空闲</span>
            <span><i className="am-dot am-dot--completed" /> 已完成</span>
            <span><i className="am-dot am-dot--error" /> 异常</span>
          </div>
          <ZoomControls view={view} onView={setView} />
        </div>

        {/* 右侧活动流边栏：浮动 toggle 按钮在面板外部，收起后仅剩箭头 */}
        <div className="am-feed-wrap">
          <button
            className="am-feed-toggle"
            onClick={toggleFeed}
            title={feedOpen ? '收起活动流' : '展开活动流'}
            aria-label={feedOpen ? '收起活动流' : '展开活动流'}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {feedOpen
                ? <polyline points="9 18 15 12 9 6" />
                : <polyline points="15 18 9 12 15 6" />}
            </svg>
          </button>
          {feedOpen && (
            <aside className="am-feed-sidebar">
              <div className="am-feed-head">
                <span>📜 全局活动流</span>
                <span className="am-feed-count">{feedEvents.length}</span>
              </div>
              <ActivityFeed events={feedEvents} onSelectSession={locateSession} />
            </aside>
          )}
        </div>
      </div>

      {/* 详情 Popover：跟随选中节点屏幕位置浮动，不占用主视图空间 */}
      {selected && (
        <div
          ref={detailRef}
          className={`am-detail am-detail--popover am-detail--${detailPlacement}`}
          style={detailStyle}
        >
          <div className="am-detail-head">
            <span className={`am-badge am-badge--${selected.status}`}>
              <AgentIcon agent={selected.agent} size={14} /> {STATUS_LABEL[selected.status]}
            </span>
            <button className="am-detail-close" onClick={() => setSelectedId(null)}>×</button>
          </div>
          <h3 className="am-detail-title">{selected.title || selected.sessionId}</h3>
          <div className="am-detail-meta">
            <div>请求轮次：<b>{selected.requestCount}</b></div>
            <div>累计 Tokens：<b>{selected.totalTokens.toLocaleString()}</b></div>
            <div>最近模型：<b>{selected.lastModel || '-'}</b></div>
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
            <div>首/末：<b>{timeAgo(selected.firstRequestAt)}</b> · <b>{timeAgo(selected.lastRequestAt)}</b></div>
            {selected.inFlight > 0 && <div className="am-detail-inflight">● 正在处理 {selected.inFlight} 个请求…</div>}
          </div>
          <div className="am-detail-section-title">活动路径</div>
          <ActivityPathGraph events={detailEvents} />
          <div className="am-detail-footer">
            <button className="am-btn am-btn--ghost" onClick={() => loadDetail(selected.sessionId)}>
              刷新活动
            </button>
            <button
              className="am-btn am-btn--ghost"
              disabled={selected.source === 'access-key' && !selected.keyId}
              onClick={() => openSessionDetail(selected)}
            >
              会话详情
            </button>
          </div>
        </div>
      )}

      {/* 会话详情弹窗（复用「会话」模块的 SessionDetailModal） */}
      {detailSession && detailSessionSource && (
        <SessionDetailModal
          session={detailSession}
          logs={detailSessionLogs}
          logsLoading={detailSessionLoading}
          onRefreshLogs={async () => {
            if (!detailSessionSource) return;
            setDetailSessionLoading(true);
            try {
              const logs = await fetchSessionLogs(
                detailSessionSource.source,
                detailSessionSource.sessionId,
                detailSessionSource.keyId,
              );
              setDetailSessionLogs(logs);
            } catch (error) {
              console.error('Failed to refresh session logs:', error);
            } finally {
              setDetailSessionLoading(false);
            }
          }}
          onFetchNewLogs={async () => {
            if (!detailSessionSource) return [];
            const logs = await fetchSessionLogs(
              detailSessionSource.source,
              detailSessionSource.sessionId,
              detailSessionSource.keyId,
            );
            setDetailSessionLogs(logs);
            return logs;
          }}
          onClose={closeSessionDetail}
        />
      )}
    </div>
  );
}
