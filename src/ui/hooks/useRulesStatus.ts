import { useEffect, useRef, useState } from 'react';

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

interface RuleStatusState {
  [ruleId: string]: {
    status: 'in_use' | 'idle';
    totalTokensUsed?: number;
    totalRequestsUsed?: number;
    lastUpdate: number;
  };
}

export function useRulesStatus() {
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected'>('disconnected');
  const [ruleStatuses, setRuleStatuses] = useState<RuleStatusState>({});
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const heartbeatTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const connect = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    setConnectionStatus('connecting');

    // 构建 WebSocket URL
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/api/rules/status`;

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[RulesStatus] WebSocket 连接已建立');
        setConnectionStatus('connected');

        // 清除重连定时器
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }

        // 启动心跳检测
        startHeartbeat();
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as RuleStatusMessage;

          if (message.type === 'rule_status') {
            const { ruleId, status, totalTokensUsed, totalRequestsUsed, timestamp } = message.data;

            setRuleStatuses((prev) => ({
              ...prev,
              [ruleId]: {
                status,
                totalTokensUsed,
                totalRequestsUsed,
                lastUpdate: timestamp,
              },
            }));
          }
        } catch (error) {
          console.error('[RulesStatus] 解析消息失败:', error);
        }
      };

      ws.onclose = (event) => {
        console.log('[RulesStatus] WebSocket 连接关闭:', event.code, event.reason);
        setConnectionStatus('disconnected');
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
      setConnectionStatus('disconnected');
      reconnect();
    }
  };

  const disconnect = () => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    stopHeartbeat();

    if (wsRef.current) {
      wsRef.current.close(1000, '主动关闭');
      wsRef.current = null;
    }

    setConnectionStatus('disconnected');
  };

  const reconnect = () => {
    if (reconnectTimeoutRef.current) {
      return; // 已经在重连中
    }

    console.log('[RulesStatus] 5秒后尝试重连...');
    reconnectTimeoutRef.current = setTimeout(() => {
      reconnectTimeoutRef.current = null;
      connect();
    }, 5000);
  };

  const startHeartbeat = () => {
    heartbeatTimeoutRef.current = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'ping' }));
      } else {
        stopHeartbeat();
      }
    }, 30000); // 每30秒发送一次心跳
  };

  const stopHeartbeat = () => {
    if (heartbeatTimeoutRef.current) {
      clearInterval(heartbeatTimeoutRef.current);
      heartbeatTimeoutRef.current = null;
    }
  };

  // 组件挂载时连接
  useEffect(() => {
    connect();

    return () => {
      disconnect();
    };
  }, []);

  // 清理过期的规则状态（超过1分钟未更新的）
  useEffect(() => {
    const cleanupInterval = setInterval(() => {
      const now = Date.now();
      setRuleStatuses((prev) => {
        const updated = { ...prev };
        let hasChanges = false;

        Object.keys(updated).forEach((ruleId) => {
          if (now - updated[ruleId].lastUpdate > 60000) {
            // 如果状态是 in_use，转为 idle
            if (updated[ruleId].status === 'in_use') {
              updated[ruleId] = {
                ...updated[ruleId],
                status: 'idle',
              };
              hasChanges = true;
            }
          }
        });

        return hasChanges ? updated : prev;
      });
    }, 10000); // 每10秒检查一次

    return () => {
      clearInterval(cleanupInterval);
    };
  }, []);

  return {
    connectionStatus,
    ruleStatuses,
    getRuleStatus: (ruleId: string) => ruleStatuses[ruleId],
    isConnected: connectionStatus === 'connected',
  };
}
