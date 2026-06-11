import { createContext, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { api } from '../api/client';

// 全局控制：规则状态同步模式
// 'sse' = 使用 Server-Sent Events（服务端推送，推荐）
// 'polling' = 使用传统 HTTP 轮询
const RULES_STATUS_MODE: 'sse' | 'polling' = 'sse';

// 类型定义
export type RuleStatus = 'in_use' | 'idle' | 'error' | 'suspended';

// 单个规则状态数据
interface RuleStatusData {
  ruleId: string;
  status: RuleStatus;
  totalTokensUsed?: number;
  totalRequestsUsed?: number;
  errorMessage?: string;
  errorType?: 'http' | 'timeout' | 'unknown';
  timestamp: number;
}

export interface RuleStatusState {
  [ruleId: string]: {
    status: RuleStatus;
    totalTokensUsed?: number;
    totalRequestsUsed?: number;
    errorMessage?: string;
    errorType?: 'http' | 'timeout' | 'unknown';
    lastUpdate: number;
  };
}

interface RulesStatusContextValue {
  ruleStatuses: RuleStatusState;
  getRuleStatus: (ruleId: string) => RuleStatusState[string] | undefined;
  clearRuleStatus: (ruleId: string) => Promise<void>;
}

const RulesStatusContext = createContext<RulesStatusContextValue | null>(null);

// 清除指定规则的状态
const clearRuleStatus = async (ruleId: string) => {
  try {
    await api.clearRuleStatus(ruleId);
  } catch (error) {
    console.error('[RulesStatus] 清除规则状态失败:', error);
    throw error;
  }
};

/**
 * 将 RuleStatusData 转换为 RuleStatusState
 */
function toStateMap(statuses: RuleStatusData[]): RuleStatusState {
  const map: RuleStatusState = {};
  statuses.forEach(s => {
    map[s.ruleId] = {
      status: s.status,
      totalTokensUsed: s.totalTokensUsed,
      totalRequestsUsed: s.totalRequestsUsed,
      errorMessage: s.errorMessage,
      errorType: s.errorType,
      lastUpdate: s.timestamp,
    };
  });
  return map;
}

// Context Provider 组件
interface RulesStatusProviderProps {
  children: ReactNode;
}

export function RulesStatusProvider({ children }: RulesStatusProviderProps) {
  const [ruleStatuses, setRuleStatuses] = useState<RuleStatusState>({});
  const eventSourceRef = useRef<EventSource | null>(null);
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastHeartbeatRef = useRef<number>(Date.now());

  // ===== SSE 模式（默认） =====
  useEffect(() => {
    if (RULES_STATUS_MODE !== 'sse') return;

    const HEARTBEAT_TIMEOUT = 15000; // 15 秒无心跳视为断连
    const CHECK_INTERVAL = 3000; // 每 3 秒检查一次心跳

    let mounted = true;

    const createSSEConnection = () => {
      // 关闭旧连接
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }

      // EventSource 不支持自定义 Header，通过查询参数传递 JWT token
      const token = localStorage.getItem('auth_token');
      const url = token
        ? `/api/rules/status/stream?token=${encodeURIComponent(token)}`
        : '/api/rules/status/stream';

      const es = new EventSource(url);
      eventSourceRef.current = es;
      lastHeartbeatRef.current = Date.now();

      es.onmessage = (event) => {
        // 收到任何消息都刷新心跳时间戳
        lastHeartbeatRef.current = Date.now();

        try {
          const payload = JSON.parse(event.data);
          if (payload.type === 'init') {
            // 全量初始化
            setRuleStatuses(toStateMap(payload.statuses));
          } else if (payload.type === 'update') {
            // 增量更新单个规则
            const s: RuleStatusData = payload.status;
            setRuleStatuses(prev => ({
              ...prev,
              [s.ruleId]: {
                status: s.status,
                totalTokensUsed: s.totalTokensUsed,
                totalRequestsUsed: s.totalRequestsUsed,
                errorMessage: s.errorMessage,
                errorType: s.errorType,
                lastUpdate: s.timestamp,
              },
            }));
          }
          // payload.type === 'heartbeat' 仅用于刷新时间戳，无需额外处理
        } catch (e) {
          console.error('[RulesStatus] SSE 数据解析错误:', e);
        }
      };

      es.onerror = () => {
        console.warn('[RulesStatus] SSE 连接错误，准备重连...');
        // 关闭当前连接，由心跳检测触发重连
        es.close();
        eventSourceRef.current = null;
        lastHeartbeatRef.current = 0; // 立即触发重连
      };
    };

    // 初始连接
    createSSEConnection();

    // 心跳检测定时器：检查服务端心跳是否超时
    heartbeatTimerRef.current = setInterval(() => {
      if (!mounted) return;

      const now = Date.now();
      const elapsed = now - lastHeartbeatRef.current;

      if (elapsed >= HEARTBEAT_TIMEOUT) {
        console.warn(`[RulesStatus] 心跳超时（${Math.round(elapsed / 1000)}秒无响应），重新连接 SSE...`);
        createSSEConnection();
      }
    }, CHECK_INTERVAL);

    return () => {
      mounted = false;
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (heartbeatTimerRef.current) {
        clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
      }
    };
  }, []);

  // ===== 轮询模式（保留原逻辑） =====
  useEffect(() => {
    if (RULES_STATUS_MODE !== 'polling') return;

    const fetchRuleStatuses = async () => {
      try {
        const statuses = await api.getRuleStatuses();
        // 将数组转换为状态对象
        const newStatuses: RuleStatusState = {};
        statuses.forEach((status: RuleStatusData) => {
          newStatuses[status.ruleId] = {
            status: status.status,
            totalTokensUsed: status.totalTokensUsed,
            totalRequestsUsed: status.totalRequestsUsed,
            errorMessage: status.errorMessage,
            errorType: status.errorType,
            lastUpdate: status.timestamp,
          };
        });
        setRuleStatuses(newStatuses);
      } catch (error) {
        console.error('[RulesStatus] 获取规则状态失败:', error);
      }
    };

    // 立即执行一次
    fetchRuleStatuses();

    // 每1秒轮询一次
    const intervalId = setInterval(fetchRuleStatuses, 1000);

    return () => {
      clearInterval(intervalId);
    };
  }, []);

  const getRuleStatus = (ruleId: string) => {
    return ruleStatuses[ruleId];
  };

  const value: RulesStatusContextValue = {
    ruleStatuses,
    getRuleStatus,
    clearRuleStatus,
  };

  return (
    <RulesStatusContext.Provider value={value}>
      {children}
    </RulesStatusContext.Provider>
  );
}

// Hook: 使用规则状态
export function useRulesStatus() {
  const context = useContext(RulesStatusContext);

  if (!context) {
    // 如果没有 Provider，返回默认值（向后兼容）
    return {
      ruleStatuses: {} as RuleStatusState,
      getRuleStatus: (_ruleId: string) => undefined,
      clearRuleStatus: async (_ruleId: string) => {},
    };
  }

  return context;
}
