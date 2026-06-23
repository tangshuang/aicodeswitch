/**
 * Agent Map 3D 画布（Three.js / WebGL）——独立组件，与 2D 画布完全隔离。
 *
 * 自持：Three.js 场景容器与生命周期（挂载/卸载/数据推送/选中/聚焦/标签开关/主题）。
 * 父级只通过 props 推送数据与回调，所有交互（OrbitControls、raycaster 拾取）都在本组件与场景内部闭环。
 */
import { useEffect, useRef } from 'react';
import type { SessionMapItem } from '../../types';
import { AgentMap3DScene } from '../three/AgentMap3DScene';

interface AgentMapCanvas3DProps {
  sessions: SessionMapItem[];
  now: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  showLabels: boolean;
  focus: { sessionId: string; nonce: number } | null;
  resetNonce: number;
  onContextLost: () => void;
  onSelectedScreen: (id: string, x: number, y: number) => void;
}

export default function AgentMapCanvas3D({
  sessions, now, selectedId, onSelect, showLabels, focus, resetNonce, onContextLost, onSelectedScreen,
}: AgentMapCanvas3DProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<AgentMap3DScene | null>(null);
  const followThrottle = useRef<{ t: number; x: number; y: number }>({ t: 0, x: -9999, y: -9999 });

  // 挂载 / 卸载场景
  useEffect(() => {
    if (!containerRef.current) return;
    let scene: AgentMap3DScene;
    try {
      scene = new AgentMap3DScene(containerRef.current, {
        onSelect,
        onContextLost,
        onSelectedScreenUpdate: (_sid, x, y) => {
          // 节流：移动 > 4px 且距上次 > 110ms 才上报，驱动 popover 跟随
          const ref = followThrottle.current;
          const t = performance.now();
          if (t - ref.t < 110 && Math.hypot(x - ref.x, y - ref.y) < 4) return;
          ref.t = t; ref.x = x; ref.y = y;
          // 容器内坐标 → 视口坐标
          const wrap = containerRef.current?.getBoundingClientRect();
          onSelectedScreen(_sid, x + (wrap?.left ?? 0), y + (wrap?.top ?? 0));
        },
      });
    } catch {
      onContextLost();
      return;
    }
    sceneRef.current = scene;
    return () => { scene.dispose(); sceneRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 推送数据快照（diff 更新）
  useEffect(() => {
    sceneRef.current?.update(sessions, now);
  }, [sessions, now]);

  // 选中态同步
  useEffect(() => {
    sceneRef.current?.setSelected(selectedId);
  }, [selectedId]);

  // 标签显隐开关
  useEffect(() => {
    sceneRef.current?.setLabelsVisible(showLabels);
  }, [showLabels]);

  // 定位（来自活动流）：相机聚焦到节点
  useEffect(() => {
    if (!focus) return;
    sceneRef.current?.focusSession(focus.sessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);

  // 复位视角
  useEffect(() => {
    if (resetNonce === 0) return;
    sceneRef.current?.resetCamera();
  }, [resetNonce]);

  return <div ref={containerRef} className="am-canvas am-canvas-3d" />;
}
