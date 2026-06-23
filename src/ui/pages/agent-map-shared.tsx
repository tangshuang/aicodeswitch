/**
 * Agent Map 2D/3D 画布共享的常量、纯函数与小组件。
 * 父页面与两个独立画布组件（AgentMapCanvas2D / AgentMapCanvas3D）都从这里取，
 * 避免重复定义与循环依赖。
 */
import { ClaudeCodeIcon, CodexIcon } from '../components/AgentIcons';
import type { SessionMapItem } from '../../types';

// ============================ 常量 ============================

export const SVG_W = 1000;
export const SVG_H = 700;
export const HOUR = 3600_000;
export const DAY = 86400_000;
export const ZOOM_MIN = 0.4;
export const ZOOM_MAX = 4;

export const TOOL_ICON: Record<string, string> = {
  Read: '📖', Edit: '📝', Write: '📝', MultiEdit: '📝',
  Bash: '🔧', Glob: '🔍', Grep: '🔍',
  WebFetch: '🌐', WebSearch: '🌐',
  Agent: '🤖', Task: '🤖',
  NotebookEdit: '📓',
};

// 节点视觉半径（SVG 单位）：默认很小，仅随对话轮数增长，封顶避免过大
export const NODE_R_MIN = 8;
export const NODE_R_MAX = 96;

export interface NodePos { x: number; y: number; }
export interface View { zoom: number; panX: number; panY: number; }

// ============================ 工具函数 ============================

export function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// [会话开始距今天数, 半径] 控制点：age=0 紧贴中心，前两小时缓慢外移，之后逐渐加速
const R_POINTS: [number, number][] = [
  [0, 20],
  [2 / 24, 60],
  [1, 420],
  [5, 620],
  [10, 760],
  [30, 860],
];

export function radiusForAgeDays(ageDays: number): number {
  if (!Number.isFinite(ageDays) || ageDays <= 0) return R_POINTS[0][1];
  for (let i = 1; i < R_POINTS.length; i++) {
    if (ageDays <= R_POINTS[i][0]) {
      const [a0, r0] = R_POINTS[i - 1];
      const [a1, r1] = R_POINTS[i];
      const k = (ageDays - a0) / (a1 - a0);
      return r0 + (r1 - r0) * k;
    }
  }
  return R_POINTS[R_POINTS.length - 1][1];
}

/** 计算节点 2D 基础位置：半径=会话年龄分档，角度=sessionId 哈希（稳定不漂移） */
export function basePosition(sessionId: string, firstRequestAt: number, now: number): NodePos {
  const cx = SVG_W / 2;
  const cy = SVG_H / 2;
  const rawAge = now - firstRequestAt;
  const ageDays = Number.isFinite(rawAge) && rawAge > 0 ? rawAge / DAY : 0;
  const radius = radiusForAgeDays(ageDays);
  const angle = ((hashStr(sessionId) % 360) + (hashStr(sessionId + '~j') % 40 - 20)) * (Math.PI / 180);
  return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius };
}

// 距离分档临界圆：1 / 5 / 10 天
export const RINGS: { days: number; r: number; tier: number; label: string }[] = [
  { days: 1, r: 420, tier: 0, label: '1 天' },
  { days: 5, r: 620, tier: 1, label: '5 天' },
  { days: 10, r: 760, tier: 2, label: '10 天' },
];

export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}秒前`;
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}小时前`;
  return `${Math.floor(diff / 86400_000)}天前`;
}

// ============================ 2D 画布节点（SVG） ============================

export function SessionNodeSvg({ item, pos, selected }: {
  item: SessionMapItem;
  pos: NodePos;
  selected: boolean;
}) {
  const req = item.requestCount || 0;
  const activity = Math.min(req / 100, 1);
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

// ============================ 缩放控制（2D） ============================

export function ZoomControls({ view, onView }: { view: View; onView: React.Dispatch<React.SetStateAction<View>>; }) {
  const zoomBy = (factor: number) => {
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
      <button className="am-zoom-btn" onClick={() => onView({ zoom: 1, panX: 0, panY: 0 })} title="重置缩放">⟲</button>
    </div>
  );
}
