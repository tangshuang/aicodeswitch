import { createContext, useContext, useEffect, useState, ReactNode } from 'react';

// 类型定义
interface RuleStatusMessage {
  type: 'rule_status';
  data: {
    ruleId: string;
    status: 'in_use' | 'idle';
    totalTokensUsed?: number;
    totalRequestsUsed?: number;
    timestamp: number;
  };
}

export interface RuleStatusState {
  [ruleId: string]: {
    status: 'in_use' | 'idle';
    totalTokensUsed?: number;
    totalRequestsUsed?: number;
    lastUpdate: number;
  };
}

interface RulesStatusContextValue {
  connectionStatus: 'connecting' | 'connected' | 'disconnected';
  ruleStatuses: RuleStatusState;
  getRuleStatus: (ruleId: string) => RuleStatusState[string] | undefined;
  isConnected: boolean;
}

const RulesStatusContext = createContext<RulesStatusContextValue | null>(null);

// 全局 WebSocket 连接管理
let globalWsRef: WebSocket | null = null;
let globalReconnectTimeoutRef: NodeJS.Timeout | null = null;
let globalHeartbeatTimeoutRef: NodeJS.Timeout | null = null;
let globalConnectionStatus: 'connecting' | 'connected' | 'disconnected' = 'disconnected';
let globalRuleStatuses: RuleStatusState = {};
let globalSubscribers: Set<(status: RuleStatusState) => void> = new Set();
let globalStatusSubscribers: Set<(status: 'connecting' | 'connected' | 'disconnected') => void> = new Set();

// 通知所有订阅者状态更新
const notifyStatusSubscribers = () => {
  globalStatusSubscribers.forEach((callback) => callback(globalConnectionStatus));
};

const notifyRuleSubscribers = () => {
  globalSubscribers.forEach((callback) => callback(globalRuleStatuses));
};

// 清理过期状态（超过1分钟未更新的 in_use 转为 idle）
const cleanupExpiredStatuses = () => {
  const now = Date.now();
  let hasChanges = false;

  Object.keys(globalRuleStatuses).forEach((ruleId) => {
    if (now - globalRuleStatuses[ruleId].lastUpdate > 60000) {
      if (globalRuleStatuses[ruleId].status === 'in_use') {
        globalRuleStatuses[ruleId] = {
          ...globalRuleStatuses[ruleId],
          status: 'idle',
        };
        hasChanges = true;
      }
    }
  });

  if (hasChanges) {
    notifyRuleSubscribers();
  }
};

let cleanupInterval: NodeJS.Timeout | null = null;

const connect = () => {
  if (globalWsRef?.readyState === WebSocket.OPEN) {
    return;
  }

  globalConnectionStatus = 'connecting';
  notifyStatusSubscribers();

  // 构建 WebSocket URL
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  const wsUrl = `${protocol}//${host}/api/rules/status`;

  try {
    const ws = new WebSocket(wsUrl);
    globalWsRef = ws;

    ws.onopen = () => {
      console.log('[RulesStatus] WebSocket 连接已建立');
      globalConnectionStatus = 'connected';
      notifyStatusSubscribers();

      // 清除重连定时器
      if (globalReconnectTimeoutRef) {
        clearTimeout(globalReconnectTimeoutRef);
        globalReconnectTimeoutRef = null;
      }

      // 启动心跳检测
      startHeartbeat();
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as RuleStatusMessage;

        if (message.type === 'rule_status') {
          const { ruleId, status, totalTokensUsed, totalRequestsUsed, timestamp } = message.data;

          globalRuleStatuses = {
            ...globalRuleStatuses,
            [ruleId]: {
              status,
              totalTokensUsed,
              totalRequestsUsed,
              lastUpdate: timestamp,
            },
          };

          notifyRuleSubscribers();
        }
      } catch (error) {
        console.error('[RulesStatus] 解析消息失败:', error);
      }
    };

    ws.onclose = (event) => {
      console.log('[RulesStatus] WebSocket 连接关闭:', event.code, event.reason);
      globalConnectionStatus = 'disconnected';
      notifyStatusSubscribers();
      stopHeartbeat();

      // 如果不是主动关闭，尝试重连
      if (event.code !== 1000) {
        reconnect();
      }
    };

    ws.onerror = (error) => {
      console.error('[RulesStatus] WebSocket 错误:', error);
    };
  } catch (error) {
    console.error('[RulesStatus] 创建 WebSocket 失败:', error);
    globalConnectionStatus = 'disconnected';
    notifyStatusSubscribers();
    reconnect();
  }
};

const disconnect = () => {
  if (globalReconnectTimeoutRef) {
    clearTimeout(globalReconnectTimeoutRef);
    globalReconnectTimeoutRef = null;
  }

  stopHeartbeat();

  if (globalWsRef) {
    globalWsRef.close(1000, '主动关闭');
    globalWsRef = null;
  }

  globalConnectionStatus = 'disconnected';
  notifyStatusSubscribers();
};

const reconnect = () => {
  if (globalReconnectTimeoutRef) {
    return; // 已经在重连中
  }

  console.log('[RulesStatus] 5秒后尝试重连...');
  globalReconnectTimeoutRef = setTimeout(() => {
    globalReconnectTimeoutRef = null;
    connect();
  }, 5000);
};

const startHeartbeat = () => {
  stopHeartbeat();
  globalHeartbeatTimeoutRef = setInterval(() => {
    if (globalWsRef?.readyState === WebSocket.OPEN) {
      globalWsRef.send(JSON.stringify({ type: 'ping' }));
    } else {
      stopHeartbeat();
    }
  }, 30000); // 每30秒发送一次心跳
};

const stopHeartbeat = () => {
  if (globalHeartbeatTimeoutRef) {
    clearInterval(globalHeartbeatTimeoutRef);
    globalHeartbeatTimeoutRef = null;
  }
};

// 初始化全局连接和清理定时器
const initializeGlobalConnection = () => {
  // 启动清理定时器
  if (!cleanupInterval) {
    cleanupInterval = setInterval(cleanupExpiredStatuses, 10000); // 每10秒检查一次
  }

  // 连接 WebSocket
  connect();
};

// 清理全局资源
const cleanupGlobalConnection = () => {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }

  disconnect();
};

// Context Provider 组件
interface RulesStatusProviderProps {
  children: ReactNode;
}

export function RulesStatusProvider({ children }: RulesStatusProviderProps) {
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected'>('disconnected');
  const [ruleStatuses, setRuleStatuses] = useState<RuleStatusState>({});

  // 订阅全局状态更新
  useEffect(() => {
    // 注册状态变化回调
    const handleStatusChange = (status: 'connecting' | 'connected' | 'disconnected') => {
      setConnectionStatus(status);
    };

    const handleRuleChange = (statuses: RuleStatusState) => {
      setRuleStatuses(statuses);
    };

    globalStatusSubscribers.add(handleStatusChange);
    globalSubscribers.add(handleRuleChange);

    // 初始化全局连接
    initializeGlobalConnection();

    return () => {
      globalStatusSubscribers.delete(handleStatusChange);
      globalSubscribers.delete(handleRuleChange);

      // 检查是否还有其他订阅者
      if (globalStatusSubscribers.size === 0 && globalSubscribers.size === 0) {
        cleanupGlobalConnection();
      }
    };
  }, []);

  const getRuleStatus = (ruleId: string) => {
    return ruleStatuses[ruleId];
  };

  const value: RulesStatusContextValue = {
    connectionStatus,
    ruleStatuses,
    getRuleStatus,
    isConnected: connectionStatus === 'connected',
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
      connectionStatus: 'disconnected' as const,
      ruleStatuses: {} as RuleStatusState,
      getRuleStatus: (_ruleId: string) => undefined,
      isConnected: false,
    };
  }

  return context;
}
