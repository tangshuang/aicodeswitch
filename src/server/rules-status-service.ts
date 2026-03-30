import type { ContentType } from '../types';

/**
 * 规则状态类型
 */
export type RuleStatus = 'in_use' | 'idle' | 'error' | 'suspended';

/**
 * 单个规则状态数据
 */
export interface RuleStatusData {
  ruleId: string;
  status: RuleStatus;
  routeId?: string; // 用于 suspended 状态，便于恢复时查找
  serviceId?: string; // 用于 suspended 状态，便于检查黑名单
  contentType?: ContentType; // 用于 suspended 状态，便于恢复时查找
  totalTokensUsed?: number;
  totalRequestsUsed?: number;
  errorMessage?: string;
  errorType?: 'http' | 'timeout' | 'unknown';
  timestamp: number;
}

/**
 * 黑名单检查函数类型
 */
export type BlacklistChecker = (
  serviceId: string,
  routeId: string,
  contentType: ContentType
) => Promise<boolean>;

/**
 * 规则状态管理服务
 * 负责管理所有规则的状态（使用中、空闲、错误、挂起）
 */
export class RulesStatusBroadcaster {
  private ruleStates: Map<string, RuleStatusData> = new Map(); // ruleId -> RuleStatusData
  private ruleTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private idleDebounceTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private syncInterval: NodeJS.Timeout | null = null;
  private blacklistChecker: BlacklistChecker | null = null;
  private readonly INACTIVITY_TIMEOUT = 10000; // 10秒无活动后标记为空闲
  private readonly IDLE_DEBOUNCE_DELAY = 3000; // idle 延迟3秒，避免对话快速进入 in_use 时闪烁
  private readonly SYNC_INTERVAL = 10000; // 每10秒检查一次 suspended 和 error 状态
  private readonly ERROR_RECOVERY_TIMEOUT = 30000; // error 状态30秒后自动恢复

  constructor() {
    // 启动定期状态检查定时器
    this.startSyncInterval();
  }

  /**
   * 设置黑名单检查函数
   */
  setBlacklistChecker(checker: BlacklistChecker) {
    this.blacklistChecker = checker;
  }

  /**
   * 启动定期状态检查定时器
   */
  private startSyncInterval() {
    this.syncInterval = setInterval(() => {
      this.checkSuspendedAndErrorRules();
    }, this.SYNC_INTERVAL);
  }

  /**
   * 检查 suspended 和 error 状态的规则是否已恢复
   */
  private async checkSuspendedAndErrorRules() {
    const now = Date.now();

    // 1. 检查所有 error 状态的规则，如果超过恢复时间则自动恢复为 idle
    this.ruleStates.forEach((data, ruleId) => {
      if (
        data.status === 'error' &&
        data.timestamp &&
        now - data.timestamp > this.ERROR_RECOVERY_TIMEOUT
      ) {
        console.log(
          `[RulesStatusBroadcaster] 规则 ${ruleId} 错误状态已超时，自动恢复为 idle 状态`
        );
        this.ruleStates.set(ruleId, {
          ruleId,
          status: 'idle',
          routeId: data.routeId,
          timestamp: now,
        });
      }
    });

    // 2. 检查所有 suspended 状态的规则，如果黑名单已过期则恢复为 idle
    if (this.blacklistChecker) {
      const suspendedRules: Array<{
        ruleId: string;
        serviceId: string;
        routeId: string;
        contentType: ContentType;
      }> = [];

      this.ruleStates.forEach((data, ruleId) => {
        if (
          data.status === 'suspended' &&
          data.serviceId &&
          data.routeId &&
          data.contentType
        ) {
          suspendedRules.push({
            ruleId,
            serviceId: data.serviceId,
            routeId: data.routeId,
            contentType: data.contentType,
          });
        }
      });

      // 检查每个 suspended 规则的黑名单状态
      for (const { ruleId, serviceId, routeId, contentType } of suspendedRules) {
        try {
          const isBlacklisted = await this.blacklistChecker(
            serviceId,
            routeId,
            contentType
          );
          if (!isBlacklisted) {
            // 黑名单已过期，恢复为 idle 状态
            console.log(
              `[RulesStatusBroadcaster] 规则 ${ruleId} 黑名单已过期，恢复为 idle 状态`
            );
            this.ruleStates.set(ruleId, {
              ruleId,
              status: 'idle',
              routeId,
              contentType,
              timestamp: now,
            });
          }
        } catch (error) {
          console.error(
            `[RulesStatusBroadcaster] 检查黑名单状态失败:`,
            error
          );
        }
      }
    }
  }

  /**
   * 清除规则的超时定时器
   */
  private clearRuleTimeout(timeoutKey: string) {
    const existingTimeout = this.ruleTimeouts.get(timeoutKey);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
      this.ruleTimeouts.delete(timeoutKey);
    }
  }

  /**
   * 清除规则的 idle debounce 定时器
   */
  private clearIdleDebounce(timeoutKey: string) {
    const existing = this.idleDebounceTimeouts.get(timeoutKey);
    if (existing) {
      clearTimeout(existing);
      this.idleDebounceTimeouts.delete(timeoutKey);
    }
  }

  /**
   * 更新规则状态
   */
  private updateRuleStatus(data: RuleStatusData) {
    // 更新本地状态
    this.ruleStates.set(data.ruleId, data);
  }

  /**
   * 标记规则正在使用
   */
  markRuleInUse(routeId: string, ruleId: string) {
    const timeoutKey = `${routeId}:${ruleId}`;

    // 清除之前的超时定时器和 idle debounce
    this.clearRuleTimeout(timeoutKey);
    this.clearIdleDebounce(timeoutKey);

    // 更新状态
    this.updateRuleStatus({
      ruleId,
      status: 'in_use',
      routeId,
      timestamp: Date.now(),
    });

    // 设置超时定时器，如果10秒内没有新活动则标记为空闲
    const timeout = setTimeout(() => {
      this.markRuleIdle(routeId, ruleId);
    }, this.INACTIVITY_TIMEOUT);

    this.ruleTimeouts.set(timeoutKey, timeout);
  }

  /**
   * 标记规则空闲（带3秒 debounce，避免对话快速进入 in_use 时状态闪烁）
   */
  markRuleIdle(routeId: string, ruleId: string) {
    const timeoutKey = `${routeId}:${ruleId}`;

    // 清除超时定时器
    this.clearRuleTimeout(timeoutKey);

    // 清除已有的 idle debounce，重新计时
    this.clearIdleDebounce(timeoutKey);

    const debounce = setTimeout(() => {
      this.idleDebounceTimeouts.delete(timeoutKey);
      this.updateRuleStatus({
        ruleId,
        status: 'idle',
        routeId,
        timestamp: Date.now(),
      });
    }, this.IDLE_DEBOUNCE_DELAY);

    this.idleDebounceTimeouts.set(timeoutKey, debounce);
  }

  /**
   * 标记规则错误
   */
  markRuleError(routeId: string, ruleId: string, errorMessage?: string) {
    const timeoutKey = `${routeId}:${ruleId}`;

    // 清除超时定时器和 idle debounce，避免 error 状态被延迟的 idle 覆盖
    this.clearRuleTimeout(timeoutKey);
    this.clearIdleDebounce(timeoutKey);

    // 更新状态
    this.updateRuleStatus({
      ruleId,
      status: 'error',
      routeId,
      errorMessage,
      timestamp: Date.now(),
    });
  }

  /**
   * 标记规则被挂起（进入黑名单）
   */
  markRuleSuspended(
    routeId: string,
    ruleId: string,
    serviceId: string,
    contentType: ContentType,
    errorMessage?: string,
    errorType?: 'http' | 'timeout' | 'unknown'
  ) {
    const timeoutKey = `${routeId}:${ruleId}`;

    // 清除超时定时器和 idle debounce，避免 suspended 状态被延迟的 idle 覆盖
    this.clearRuleTimeout(timeoutKey);
    this.clearIdleDebounce(timeoutKey);

    // 更新状态，同时存储 routeId、serviceId 和 contentType 用于恢复检查
    this.updateRuleStatus({
      ruleId,
      status: 'suspended',
      routeId,
      serviceId,
      contentType,
      errorMessage,
      errorType,
      timestamp: Date.now(),
    });
  }

  /**
   * 更新规则使用量
   */
  updateRuleUsage(ruleId: string, totalTokensUsed: number, totalRequestsUsed: number) {
    // 获取当前状态，保留其他字段
    const currentStatus = this.ruleStates.get(ruleId);

    this.updateRuleStatus({
      ruleId,
      status: currentStatus?.status || 'in_use',
      routeId: currentStatus?.routeId,
      contentType: currentStatus?.contentType,
      totalTokensUsed,
      totalRequestsUsed,
      timestamp: Date.now(),
    });
  }

  /**
   * 清除指定规则的状态
   */
  clearRuleStatus(ruleId: string) {
    this.ruleStates.delete(ruleId);
  }

  /**
   * 获取当前活动的规则列表
   */
  getActiveRules(): string[] {
    const activeRuleIds: string[] = [];
    this.ruleStates.forEach((data, ruleId) => {
      if (data.status === 'in_use') {
        activeRuleIds.push(ruleId);
      }
    });
    return activeRuleIds;
  }

  /**
   * 获取所有规则的状态（用于 HTTP 轮询）
   */
  getAllRuleStatuses(): RuleStatusData[] {
    return Array.from(this.ruleStates.values());
  }

  /**
   * 销毁广播器（清理定时器）
   */
  destroy() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    this.ruleTimeouts.forEach((timeout) => clearTimeout(timeout));
    this.ruleTimeouts.clear();
    this.idleDebounceTimeouts.forEach((timeout) => clearTimeout(timeout));
    this.idleDebounceTimeouts.clear();
    this.ruleStates.clear();
  }
}

// 全局单例
export const rulesStatusBroadcaster = new RulesStatusBroadcaster();
