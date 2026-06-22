/**
 * 任务结束 OS 通知（服务端交付，全应用跨页面）
 *
 * 设计：
 * - 通知由后端用 OS 原生通知（osascript/notify-send/PowerShell toast）弹出，更可靠，
 *   浏览器/Tab 关掉也能弹；不再依赖浏览器 Notification API（避免「授权 OK 但系统层关闭」盲区）。
 * - 开关偏好：localStorage 为 UI 真相源；挂载时同步到后端；切换时 POST 给后端。
 * - 后台闸门：前端在 visibilitychange（及挂载时）上报 document.hidden；后端仅在「页面后台」时弹。
 *
 * 触发信号在后端 agent-map-service（active → idle = 一轮结束，见 detectTurnEnd）。
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from '../api/client';

interface AgentNotificationsValue {
  enabled: boolean;
  toggle: () => void;
}

const Ctx = createContext<AgentNotificationsValue | null>(null);

export function useAgentNotifications(): AgentNotificationsValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAgentNotifications must be used inside <AgentNotificationsProvider>');
  return v;
}

export function AgentNotificationsProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState<boolean>(() => {
    try { return localStorage.getItem('agent-map-notify') === 'on'; } catch { return false; }
  });

  // 挂载时：把本地偏好同步到后端（解决后端重启后丢失）+ 上报一次可见性
  useEffect(() => {
    api.setAgentMapNotify(enabled).catch(() => { /* ignore */ });
    const reportFocus = () => {
      api.setAgentMapNotifyFocus(typeof document !== 'undefined' ? document.hidden : true).catch(() => { /* ignore */ });
    };
    reportFocus();
    document.addEventListener('visibilitychange', reportFocus);
    return () => document.removeEventListener('visibilitychange', reportFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = useCallback(() => {
    setEnabled(prev => {
      const next = !prev;
      try { localStorage.setItem('agent-map-notify', next ? 'on' : 'off'); } catch { /* ignore */ }
      api.setAgentMapNotify(next).catch(() => { /* ignore */ });
      return next;
    });
  }, []);

  return <Ctx.Provider value={{ enabled, toggle }}>{children}</Ctx.Provider>;
}
