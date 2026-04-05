import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { api } from '../api/client';

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

// Context Provider 组件
interface RulesStatusProviderProps {
  children: ReactNode;
}

export function RulesStatusProvider({ children }: RulesStatusProviderProps) {
  const [ruleStatuses, setRuleStatuses] = useState<RuleStatusState>({});

  // 轮询获取规则状态
  useEffect(() => {
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
