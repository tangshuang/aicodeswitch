/**
 * 任务结束 OS 通知（服务端交付，全应用跨页面）
 *
 * 设计：
 * - 通知由后端用 OS 原生通知弹出；触发信号在后端 agent-map-service（active → idle，见 detectTurnEnd）。
 * - 开关以**后端为权威**（持久化在 AppConfig），前端挂载时 GET 回填、切换时 POST 持久化。
 *   这样重启服务后、关闭浏览器都不影响——Node 端凭持久化标志即可弹通知。
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
  const [enabled, setEnabled] = useState<boolean>(false);

  // 挂载时：从后端取持久化的开关值（后端为权威来源）
  useEffect(() => {
    api.getAgentMapNotify()
      .then(r => setEnabled(!!r.enabled))
      .catch(() => { /* ignore */ });
  }, []);

  const toggle = useCallback(() => {
    setEnabled(prev => {
      const next = !prev;
      api.setAgentMapNotify(next).catch(() => { /* ignore */ });
      return next;
    });
  }, []);

  return <Ctx.Provider value={{ enabled, toggle }}>{children}</Ctx.Provider>;
}
