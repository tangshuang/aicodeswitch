// @ts-ignore - ws 类型声明可能需要手动安装 @types/ws
import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';

/**
 * 规则状态消息类型
 */
export interface RuleStatusMessage {
  type: 'rule_status';
  data: {
    ruleId: string;
    status: 'in_use' | 'idle';
    totalTokensUsed?: number;
    totalRequestsUsed?: number;
    timestamp: number;
  };
}

/**
 * 规则状态 WebSocket 连接管理
 */
class RulesStatusWS {
  private ws: WebSocket;

  constructor(ws: WebSocket, req: IncomingMessage) {
    this.ws = ws;

    console.log(`[RulesStatusWS] 新的 WebSocket 连接: ${req.socket.remoteAddress}`);

    this.ws.on('close', () => {
      console.log(`[RulesStatusWS] WebSocket 连接关闭`);
    });

    this.ws.on('error', (err: Error) => {
      console.error(`[RulesStatusWS] WebSocket 错误:`, err);
    });
  }

  /**
   * 发送规则状态消息到客户端
   */
  sendStatus(message: RuleStatusMessage) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }
}

/**
 * 规则状态广播服务
 * 管理所有连接的客户端，负责广播规则使用状态
 */
export class RulesStatusBroadcaster {
  private clients: Set<RulesStatusWS> = new Set();
  private activeRules: Map<string, Set<string>> = new Map(); // routeId -> Set of ruleIds
  private ruleTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private readonly INACTIVITY_TIMEOUT = 30000; // 30秒无活动后标记为空闲

  /**
   * 添加客户端
   */
  addClient(client: RulesStatusWS) {
    this.clients.add(client);
    console.log(`[RulesStatusBroadcaster] 客户端已连接，当前客户端数: ${this.clients.size}`);
  }

  /**
   * 移除客户端
   */
  removeClient(client: RulesStatusWS) {
    this.clients.delete(client);
    console.log(`[RulesStatusBroadcaster] 客户端已断开，当前客户端数: ${this.clients.size}`);
  }

  /**
   * 标记规则正在使用
   */
  markRuleInUse(routeId: string, ruleId: string) {
    // 添加到活动规则集合
    if (!this.activeRules.has(routeId)) {
      this.activeRules.set(routeId, new Set());
    }
    this.activeRules.get(routeId)!.add(ruleId);

    // 清除之前的超时定时器
    const timeoutKey = `${routeId}:${ruleId}`;
    const existingTimeout = this.ruleTimeouts.get(timeoutKey);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    // 广播状态
    this.broadcastStatus({
      type: 'rule_status',
      data: {
        ruleId,
        status: 'in_use',
        timestamp: Date.now(),
      },
    });

    // 设置超时定时器，如果30秒内没有新活动则标记为空闲
    const timeout = setTimeout(() => {
      this.markRuleIdle(routeId, ruleId);
    }, this.INACTIVITY_TIMEOUT);

    this.ruleTimeouts.set(timeoutKey, timeout);
  }

  /**
   * 标记规则空闲
   */
  private markRuleIdle(routeId: string, ruleId: string) {
    const timeoutKey = `${routeId}:${ruleId}`;

    // 清除超时定时器
    const existingTimeout = this.ruleTimeouts.get(timeoutKey);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
      this.ruleTimeouts.delete(timeoutKey);
    }

    // 从活动规则集合中移除
    if (this.activeRules.has(routeId)) {
      this.activeRules.get(routeId)!.delete(ruleId);
      if (this.activeRules.get(routeId)!.size === 0) {
        this.activeRules.delete(routeId);
      }
    }

    // 广播空闲状态
    this.broadcastStatus({
      type: 'rule_status',
      data: {
        ruleId,
        status: 'idle',
        timestamp: Date.now(),
      },
    });
  }

  /**
   * 广播规则使用量更新
   */
  broadcastUsageUpdate(ruleId: string, totalTokensUsed: number, totalRequestsUsed: number) {
    this.broadcastStatus({
      type: 'rule_status',
      data: {
        ruleId,
        status: 'in_use',
        totalTokensUsed,
        totalRequestsUsed,
        timestamp: Date.now(),
      },
    });
  }

  /**
   * 广播消息到所有客户端
   */
  private broadcastStatus(message: RuleStatusMessage) {
    const deadClients: RulesStatusWS[] = [];

    this.clients.forEach((client) => {
      try {
        client.sendStatus(message);
      } catch (error) {
        console.error('[RulesStatusBroadcaster] 发送消息失败:', error);
        deadClients.push(client);
      }
    });

    // 清理断开的客户端
    deadClients.forEach((client) => {
      this.removeClient(client);
    });
  }

  /**
   * 获取当前活动的规则列表
   */
  getActiveRules(): Map<string, Set<string>> {
    return new Map(this.activeRules);
  }
}

// 全局单例
export const rulesStatusBroadcaster = new RulesStatusBroadcaster();

/**
 * 创建 WebSocket 服务器用于规则状态
 */
export function createRulesStatusWSServer() {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const wsHandler = new RulesStatusWS(ws, req);
    rulesStatusBroadcaster.addClient(wsHandler);

    ws.on('close', () => {
      rulesStatusBroadcaster.removeClient(wsHandler);
    });
  });

  return wss;
}

export { RulesStatusWS };
