/**
 * Agent Map 2D 画布（SVG）——独立组件，与 3D 画布完全隔离。
 *
 * 自持：svgRef / groupRef、滚轮缩放监听、拖拽平移 + 点击选中、缩放/平移视图状态由父级受控。
 * 关键：本组件每次挂载都会在 useEffect 里重新挂载 wheel 监听到自身的 svgRef，
 * 因此在 2D ↔ 3D 之间切换（卸载/重新挂载）后，滚轮缩放始终可用。
 */
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import type { SessionMapItem } from '../../types';
import {
  SVG_W, SVG_H, ZOOM_MIN, ZOOM_MAX, RINGS,
  basePosition, SessionNodeSvg, type View,
} from './agent-map-shared';

interface AgentMapCanvas2DProps {
  sessions: SessionMapItem[];
  now: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  view: View;
  onView: React.Dispatch<React.SetStateAction<View>>;
  focus: { sessionId: string; nonce: number } | null;
}

export default function AgentMapCanvas2D({
  sessions, now, selectedId, onSelect, view, onView, focus,
}: AgentMapCanvas2DProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const groupRef = useRef<SVGSVGElement>(null);
  const viewRef = useRef(view); viewRef.current = view;
  const [pressing, setPressing] = useState(false);

  // 节点 2D 位置
  const pos = useMemo(() => {
    const m: Record<string, { x: number; y: number }> = {};
    for (const s of sessions) m[s.sessionId] = basePosition(s.sessionId, s.firstRequestAt, now);
    return m;
  }, [sessions, now]);

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

  // 滚轮缩放（原生非被动监听）——每次挂载重新绑定
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
      onView({ zoom: newZoom, panX: V.x - ux * newZoom, panY: V.y - uy * newZoom });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [clientToViewBox, onView, sessions.length]);

  // 定位（来自活动流）：平移视图使目标节点居中
  useEffect(() => {
    if (!focus) return;
    const s = sessions.find(x => x.sessionId === focus.sessionId);
    if (!s) return;
    const p = basePosition(focus.sessionId, s.firstRequestAt, Date.now());
    onView(v => ({
      zoom: v.zoom,
      panX: SVG_W / 2 - p.x * v.zoom,
      panY: SVG_H / 2 - p.y * v.zoom,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);

  // 拖拽平移 + 点击选中
  const pressRef = useRef<{
    startClient: { x: number; y: number };
    startVB: { x: number; y: number };
    panX: number; panY: number; moved: boolean; sid: string | null;
  } | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    setPressing(true);
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
      panX: viewRef.current.panX, panY: viewRef.current.panY,
      moved: false, sid,
    };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const p = pressRef.current;
    if (!p) return;
    if (!p.moved && Math.hypot(e.clientX - p.startClient.x, e.clientY - p.startClient.y) > 5) {
      p.moved = true;
      onSelect(null); // 拖拽即关闭 popover
    }
    const cur = clientToViewBox(e.clientX, e.clientY);
    if (!cur) return;
    onView(v => ({ ...v, panX: p.panX + (cur.x - p.startVB.x), panY: p.panY + (cur.y - p.startVB.y) }));
  };
  const onPointerUp = () => {
    setPressing(false);
    const p = pressRef.current;
    pressRef.current = null;
    if (!p || p.moved) return;
    onSelect(p.sid);
  };

  // 节点排序：active / error / 选中排最后，确保脉冲发光永远在最顶层
  const sortedSessions = useMemo(() => {
    // 选中节点优先级最高（画在最上层，不被遮挡）；其次 active/error；最后其余
    const top = (s: SessionMapItem) => s.sessionId === selectedId ? 2
      : (s.status === 'active' || s.status === 'error') ? 1 : 0;
    return [...sessions].sort((a, b) => top(a) - top(b));
  }, [sessions, selectedId]);

  return (
    <svg
      ref={svgRef}
      className="am-canvas"
      viewBox={`0 0 ${SVG_W} ${SVG_H}`}
      preserveAspectRatio="xMidYMid meet"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{ cursor: pressing ? 'grabbing' : 'grab', touchAction: 'none' }}
    >
      <rect x={0} y={0} width={SVG_W} height={SVG_H} fill="transparent" />
      <g ref={groupRef} transform={`translate(${view.panX} ${view.panY}) scale(${view.zoom})`}>
        {/* 中心标记 */}
        <circle cx={SVG_W / 2} cy={SVG_H / 2} r={4} className="am-center-mark" />
        {/* 距离分档临界圆（1 / 5 / 10 天） */}
        {RINGS.map(ring => (
          <g key={`ring-${ring.days}`} className={`am-ring am-ring--t${ring.tier}`}>
            <circle cx={SVG_W / 2} cy={SVG_H / 2} r={ring.r} fill="none" />
            <text x={SVG_W / 2} y={SVG_H / 2 - ring.r - 6} textAnchor="middle" className="am-ring-label">
              {ring.label}
            </text>
          </g>
        ))}
        {/* 连线（active 节点到中心） */}
        {sessions.filter(s => s.status === 'active').map(s => {
          const p = pos[s.sessionId];
          if (!p) return null;
          return <line key={`l-${s.sessionId}`} x1={SVG_W / 2} y1={SVG_H / 2} x2={p.x} y2={p.y} className="am-link am-link--active" />;
        })}
        {/* 节点 */}
        {sortedSessions.map(s => {
          const p = pos[s.sessionId];
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
  );
}
