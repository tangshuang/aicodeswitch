import express, { Request, Response, NextFunction } from 'express';
import axios, { AxiosRequestConfig } from 'axios';
import { pipeline } from 'stream';
import crypto from 'crypto';
import type { FileSystemDatabaseManager } from './fs-database';
import {
  ClaudeToOpenAIChatEventTransform,
  OpenAIToClaudeEventTransform,
  GeminiToClaudeEventTransform,
  GeminiToOpenAIChatEventTransform,
  SSEParserTransform,
  SSESerializerTransform,
} from './transformers/streaming';
import { SSEEventCollectorTransform } from './transformers/chunk-collector';
import { rulesStatusBroadcaster } from './rules-status-service';
import {
  extractTokenUsageFromClaudeUsage,
  extractTokenUsageFromOpenAIUsage,
  transformClaudeRequestToOpenAIChat,
  transformClaudeResponseToOpenAIChat,
  transformOpenAIChatResponseToClaude,
} from './transformers/claude-openai';
import {
  transformClaudeRequestToGemini,
  transformGeminiResponseToClaude,
  transformOpenAIChatRequestToGemini,
  transformGeminiResponseToOpenAIChat,
  extractTokenUsageFromGeminiUsage,
} from './transformers/gemini';
import type { AppConfig, Rule, APIService, Route, SourceType, TargetType, TokenUsage, ContentType, RequestLog } from '../types';
import { AuthType } from '../types';
import {
  isRuleUsingMCP,
  isMCPAvailable,
  extractImagesFromMessages,
  constructMCPMessages,
  cleanupTempImages,
} from './mcp-image-handler';

type ContentTypeDetector = {
  type: ContentType;
  match: (req: Request, body: any) => boolean;
};

const SUPPORTED_TARGETS = ['claude-code', 'codex'];

type ProxyRequestOptions = {
  failoverEnabled?: boolean;
  forwardedToServiceName?: string;
};

type FailoverProxyError = Error & {
  isFailoverCandidate?: boolean;
  response?: {
    status: number;
  };
};

export class ProxyServer {
  private app: express.Application;
  private dbManager: FileSystemDatabaseManager;
  // 以下字段用于缓存备份（将来可能用于性能优化）
  // 实际使用时，所有配置都从数据库实时读取
  private routes?: Route[] = [];
  private rules?: Map<string, Rule[]> = new Map();
  private services?: Map<string, APIService> = new Map();
  private config: AppConfig;
  // 请求去重缓存：用于防止同一个请求被重复计数（如网络重试）
  // key: requestHash, value: timestamp
  private requestDedupeCache = new Map<string, number>();
  private readonly DEDUPE_CACHE_TTL = 60000; // 去重缓存1分钟过期

  // 频率限制跟踪：用于跟踪每个规则在当前时间窗口内的请求数
  // key: ruleId, value: { count: number, windowStart: number }
  private frequencyLimitTracker = new Map<string, { count: number; windowStart: number }>();

  constructor(dbManager: FileSystemDatabaseManager, app: express.Application) {
    this.dbManager = dbManager;
    this.config = dbManager.getConfig();
    this.app = app;
  }

  initialize() {
    // Dynamic proxy middleware
    this.app.use(async (req: Request, res: Response, next: NextFunction) => {
      // 仅处理支持的目标路径
      if (!SUPPORTED_TARGETS.some(target => req.path.startsWith(`/${target}/`))) {
        return next();
      }

      try {
        const route = this.findMatchingRoute(req);
        if (!route) {
          return res.status(404).json({ error: 'No matching route found' });
        }

        // 检查是否启用故障切换
        const enableFailover = this.config?.enableFailover !== false; // 默认为 true

        if (!enableFailover) {
          // 故障切换已禁用,使用传统的单一规则匹配
          const rule = await this.findMatchingRule(route.id, req);
          if (!rule) {
            return res.status(404).json({ error: 'No matching rule found' });
          }

          const service = this.getServiceById(rule.targetServiceId);
          if (!service) {
            return res.status(500).json({ error: 'Target service not configured' });
          }

          await this.proxyRequest(req, res, route, rule, service);
          return;
        }

        // 启用故障切换:获取所有候选规则
        const allRules = this.getAllMatchingRules(route.id, req);
        if (allRules.length === 0) {
          return res.status(404).json({ error: 'No matching rule found' });
        }

        // 尝试每个规则,直到成功或全部失败
        let lastError: Error | null = null;
        let lastFailedRule: Rule | null = null;
        let lastFailedService: APIService | null = null;

        for (let index = 0; index < allRules.length; index++) {
          const rule = allRules[index];
          const service = this.getServiceById(rule.targetServiceId);
          if (!service) continue;

          // 检查黑名单
          const isBlacklisted = await this.dbManager.isServiceBlacklisted(
            service.id,
            route.id,
            rule.contentType
          );

          if (isBlacklisted) {
            console.log(`Service ${service.name} is blacklisted, skipping...`);
            continue;
          }

          try {
            const nextServiceName = await this.findNextAvailableServiceName(allRules, index + 1, route.id);
            // 尝试代理请求
            await this.proxyRequest(req, res, route, rule, service, {
              failoverEnabled: true,
              forwardedToServiceName: nextServiceName,
            });
            return; // 成功,直接返回
          } catch (error: any) {
            console.error(`Service ${service.name} failed:`, error.message);
            lastError = error;
            lastFailedRule = rule;
            lastFailedService = service;

            // 检测是否是 timeout 错误
            const isTimeout = error.code === 'ECONNABORTED' ||
                              error.message?.toLowerCase().includes('timeout') ||
                              (error.errno && error.errno === 'ETIMEDOUT');

            // 判断错误类型并加入黑名单
            if (isTimeout) {
              // Timeout错误，加入黑名单
              await this.dbManager.addToBlacklist(
                service.id,
                route.id,
                rule.contentType,
                'Request timeout - the upstream API took too long to respond',
                undefined,  // timeout没有HTTP状态码
                'timeout'
              );
              console.log(
                `Service ${service.name} added to blacklist due to timeout (${route.id}:${rule.contentType}:${service.id})`
              );
            } else {
              // HTTP错误，检查状态码
              const statusCode = error.response?.status || 500;
              if (statusCode >= 400) {
                await this.dbManager.addToBlacklist(
                  service.id,
                  route.id,
                  rule.contentType,
                  error.message,
                  statusCode,
                  'http'
                );
                console.log(
                  `Service ${service.name} added to blacklist due to HTTP error ${statusCode} (${route.id}:${rule.contentType}:${service.id})`
                );
              }
            }

            // 继续尝试下一个服务
            continue;
          }
        }

        // 所有服务都失败了
        console.error('All services failed');

        // 如果有失败的服务但都在黑名单中，尝试使用最后一个失败的服务（作为 fallback）
        if (lastFailedRule && lastFailedService) {
          console.log(`All services in blacklist, attempting fallback to last failed service: ${lastFailedService.name}`);
          try {
            await this.proxyRequest(req, res, route, lastFailedRule, lastFailedService, {
              failoverEnabled: false,  // Fallback 模式不启用故障切换
              forwardedToServiceName: undefined,
            });
            return;
          } catch (fallbackError: any) {
            console.error(`Fallback to service ${lastFailedService.name} also failed:`, fallbackError.message);
            lastError = fallbackError;
          }
        }

        // 记录日志
        if (this.config?.enableLogging !== false && SUPPORTED_TARGETS.some(target => req.path.startsWith(`/${target}/`))) {
          await this.dbManager.addLog({
            timestamp: Date.now(),
            method: req.method,
            path: req.path,
            headers: this.normalizeHeaders(req.headers),
            body: req.body,
            error: lastError?.message || 'All services failed',
          });
        }

        // 确定目标类型
        const targetType: TargetType = req.path.startsWith('/claude-code/') ? 'claude-code' : 'codex';

        // 记录错误日志 - 包含请求详情
        await this.dbManager.addErrorLog({
          timestamp: Date.now(),
          method: req.method,
          path: req.path,
          statusCode: 503,
          errorMessage: 'All services failed',
          errorStack: lastError?.stack,
          requestHeaders: this.normalizeHeaders(req.headers),
          requestBody: req.body ? JSON.stringify(req.body) : undefined,
          // 添加请求详情
          targetType,
          requestModel: req.body?.model,
          responseTime: 0,
        });

        // 根据路径判断目标类型并返回适当的错误格式
        const isClaudeCode = req.path.startsWith('/claude-code/');
        if (isClaudeCode) {
          const claudeError = {
            type: 'error',
            error: {
              type: 'api_error',
              message: 'All API services failed. Please try again later.'
            }
          };
          res.status(503).json(claudeError);
        } else {
          res.status(503).json({
            error: 'All services failed',
            details: lastError?.message
          });
        }
      } catch (error: any) {
        console.error('Proxy error:', error);
        if (this.config?.enableLogging !== false && SUPPORTED_TARGETS.some(target => req.path.startsWith(`/${target}/`))) {
          await this.dbManager.addLog({
            timestamp: Date.now(),
            method: req.method,
            path: req.path,
            headers: this.normalizeHeaders(req.headers),
            body: req.body,
            error: error.message,
          });
        }
        // Add error log - 包含请求详情
        const targetType: TargetType = req.path.startsWith('/claude-code/') ? 'claude-code' : 'codex';
        await this.dbManager.addErrorLog({
          timestamp: Date.now(),
          method: req.method,
          path: req.path,
          statusCode: 500,
          errorMessage: error.message,
          errorStack: error.stack,
          requestHeaders: this.normalizeHeaders(req.headers),
          requestBody: req.body ? JSON.stringify(req.body) : undefined,
          // 添加请求详情
          targetType,
          requestModel: req.body?.model,
          responseTime: 0,
        });

        // 根据路径判断目标类型并返回适当的错误格式
        const isClaudeCode = req.path.startsWith('/claude-code/');
        if (isClaudeCode) {
          const claudeError = {
            type: 'error',
            error: {
              type: 'api_error',
              message: error.message || 'Internal server error'
            }
          };
          res.status(500).json(claudeError);
        } else {
          res.status(500).json({ error: error.message });
        }
      }
    });
  }

  private addProxyRoutes() {
    // Fixed route handlers
    this.app.use('/claude-code/', this.createFixedRouteHandler('claude-code'));
    this.app.use('/claude-code', this.createFixedRouteHandler('claude-code'));
    this.app.use('/codex/', this.createFixedRouteHandler('codex'));
    this.app.use('/codex', this.createFixedRouteHandler('codex'));
  }

  private createFixedRouteHandler(targetType: 'claude-code' | 'codex') {
    return async (req: Request, res: Response) => {
      try {
        // 检查API Key验证
        if (this.config.apiKey) {
          const authHeader = req.headers.authorization;
          const providedKey = authHeader?.replace('Bearer ', '');
          if (!providedKey || providedKey !== this.config.apiKey) {
            return res.status(401).json({ error: 'Invalid API key' });
          }
        }

        const route = this.findRouteByTargetType(targetType);
        if (!route) {
          return res.status(404).json({ error: `No active route found for target type: ${targetType}` });
        }

        // 检查是否启用故障切换
        const enableFailover = this.config?.enableFailover !== false; // 默认为 true

        if (!enableFailover) {
          // 故障切换已禁用,使用传统的单一规则匹配
          const rule = await this.findMatchingRule(route.id, req);
          if (!rule) {
            return res.status(404).json({ error: 'No matching rule found' });
          }

          const service = this.getServiceById(rule.targetServiceId);
          if (!service) {
            return res.status(500).json({ error: 'Target service not configured' });
          }

          await this.proxyRequest(req, res, route, rule, service);
          return;
        }

        // 启用故障切换:获取所有候选规则
        const allRules = this.getAllMatchingRules(route.id, req);
        if (allRules.length === 0) {
          return res.status(404).json({ error: 'No matching rule found' });
        }

        // 尝试每个规则,直到成功或全部失败
        let lastError: Error | null = null;
        let lastFailedRule: Rule | null = null;
        let lastFailedService: APIService | null = null;

        for (let index = 0; index < allRules.length; index++) {
          const rule = allRules[index];
          const service = this.getServiceById(rule.targetServiceId);
          if (!service) continue;

          // 检查黑名单
          const isBlacklisted = await this.dbManager.isServiceBlacklisted(
            service.id,
            route.id,
            rule.contentType
          );

          if (isBlacklisted) {
            console.log(`Service ${service.name} is blacklisted, skipping...`);
            continue;
          }

          try {
            const nextServiceName = await this.findNextAvailableServiceName(allRules, index + 1, route.id);
            // 尝试代理请求
            await this.proxyRequest(req, res, route, rule, service, {
              failoverEnabled: true,
              forwardedToServiceName: nextServiceName,
            });
            return; // 成功,直接返回
          } catch (error: any) {
            console.error(`Service ${service.name} failed:`, error.message);
            lastError = error;
            lastFailedRule = rule;
            lastFailedService = service;

            // 检测是否是 timeout 错误
            const isTimeout = error.code === 'ECONNABORTED' ||
                              error.message?.toLowerCase().includes('timeout') ||
                              (error.errno && error.errno === 'ETIMEDOUT');

            // 判断错误类型并加入黑名单
            if (isTimeout) {
              // Timeout错误，加入黑名单
              await this.dbManager.addToBlacklist(
                service.id,
                route.id,
                rule.contentType,
                'Request timeout - the upstream API took too long to respond',
                undefined,  // timeout没有HTTP状态码
                'timeout'
              );
              console.log(
                `Service ${service.name} added to blacklist due to timeout (${route.id}:${rule.contentType}:${service.id})`
              );
            } else {
              // HTTP错误，检查状态码
              const statusCode = error.response?.status || 500;
              if (statusCode >= 400) {
                await this.dbManager.addToBlacklist(
                  service.id,
                  route.id,
                  rule.contentType,
                  error.message,
                  statusCode,
                  'http'
                );
                console.log(
                  `Service ${service.name} added to blacklist due to HTTP error ${statusCode} (${route.id}:${rule.contentType}:${service.id})`
                );
              }
            }

            // 继续尝试下一个服务
            continue;
          }
        }

        // 所有服务都失败了
        console.error('All services failed');

        // 如果有失败的服务但都在黑名单中，尝试使用最后一个失败的服务（作为 fallback）
        if (lastFailedRule && lastFailedService) {
          console.log(`All services in blacklist, attempting fallback to last failed service: ${lastFailedService.name}`);
          try {
            await this.proxyRequest(req, res, route, lastFailedRule, lastFailedService, {
              failoverEnabled: false,  // Fallback 模式不启用故障切换
              forwardedToServiceName: undefined,
            });
            return;
          } catch (fallbackError: any) {
            console.error(`Fallback to service ${lastFailedService.name} also failed:`, fallbackError.message);
            lastError = fallbackError;
          }
        }

        // 记录日志
        if (this.config?.enableLogging !== false && SUPPORTED_TARGETS.some(target => req.path.startsWith(`/${target}/`))) {
          await this.dbManager.addLog({
            timestamp: Date.now(),
            method: req.method,
            path: req.path,
            headers: this.normalizeHeaders(req.headers),
            body: req.body,
            error: lastError?.message || 'All services failed',
          });
        }

        // 记录错误日志 - 包含请求详情（使用函数参数 targetType）
        await this.dbManager.addErrorLog({
          timestamp: Date.now(),
          method: req.method,
          path: req.path,
          statusCode: 503,
          errorMessage: 'All services failed',
          errorStack: lastError?.stack,
          requestHeaders: this.normalizeHeaders(req.headers),
          requestBody: req.body ? JSON.stringify(req.body) : undefined,
          // 添加请求详情
          targetType,
          requestModel: req.body?.model,
          responseTime: 0,
        });

        // 根据路径判断目标类型并返回适当的错误格式
        const isClaudeCode = req.path.startsWith('/claude-code/');
        if (isClaudeCode) {
          const claudeError = {
            type: 'error',
            error: {
              type: 'api_error',
              message: 'All API services failed. Please try again later.'
            }
          };
          res.status(503).json(claudeError);
        } else {
          res.status(503).json({
            error: 'All services failed',
            details: lastError?.message
          });
        }
      } catch (error: any) {
        console.error(`Fixed route error for ${targetType}:`, error);
        if (this.config?.enableLogging !== false && SUPPORTED_TARGETS.some(target => req.path.startsWith(`/${target}/`))) {
          await this.dbManager.addLog({
            timestamp: Date.now(),
            method: req.method,
            path: req.path,
            headers: this.normalizeHeaders(req.headers),
            body: req.body,
            error: error.message,
          });
        }
        // Add error log - 包含请求详情（使用函数参数 targetType）
        await this.dbManager.addErrorLog({
          timestamp: Date.now(),
          method: req.method,
          path: req.path,
          statusCode: 500,
          errorMessage: error.message,
          errorStack: error.stack,
          requestHeaders: this.normalizeHeaders(req.headers),
          requestBody: req.body ? JSON.stringify(req.body) : undefined,
          // 添加请求详情
          targetType,
          requestModel: req.body?.model,
          responseTime: 0,
        });
        res.status(500).json({ error: error.message });
      }
    };
  }

  /**
   * 从数据库实时获取所有活跃路由
   * @returns 活跃路由列表
   */
  private getActiveRoutes(): Route[] {
    return this.dbManager.getRoutes().filter(route => route.isActive);
  }

  /**
   * 从数据库实时获取指定路由的规则
   * @param routeId 路由ID
   * @returns 规则列表（按 sortOrder 降序排序）
   */
  private getRulesByRouteId(routeId: string): Rule[] {
    const routeRules = this.dbManager.getRules(routeId);
    return routeRules.sort((a, b) => (b.sortOrder || 0) - (a.sortOrder || 0));
  }

  private getRuleById(ruleId: string): Rule | undefined {
    return this.dbManager.getRule(ruleId);
  }

  private findMatchingRoute(req: Request): Route | undefined {
    // 根据请求路径确定目标类型
    let targetType: TargetType | undefined;
    if (req.path.startsWith('/claude-code/')) {
      targetType = 'claude-code';
    } else if (req.path.startsWith('/codex/')) {
      targetType = 'codex';
    }

    if (!targetType) {
      return undefined;
    }

    // 返回匹配目标类型且处于活跃状态的路由
    const activeRoutes = this.getActiveRoutes();
    return activeRoutes.find(route => route.targetType === targetType && route.isActive);
  }

  private findRouteByTargetType(targetType: 'claude-code' | 'codex'): Route | undefined {
    const activeRoutes = this.getActiveRoutes();
    return activeRoutes.find(route => route.targetType === targetType && route.isActive);
  }

  private async findNextAvailableServiceName(allRules: Rule[], startIndex: number, routeId: string): Promise<string | undefined> {
    for (let index = startIndex; index < allRules.length; index++) {
      const rule = allRules[index];
      const service = this.getServiceById(rule.targetServiceId);
      if (!service) continue;

      const isBlacklisted = await this.dbManager.isServiceBlacklisted(
        service.id,
        routeId,
        rule.contentType
      );
      if (isBlacklisted) continue;

      return service.name;
    }

    return undefined;
  }

  private buildFailoverHint(forwardedToServiceName?: string): string {
    if (!forwardedToServiceName) {
      return '';
    }
    return `；已自动转发给 ${forwardedToServiceName} 服务继续处理`;
  }

  private createFailoverError(message: string, statusCode: number, originalError?: any): FailoverProxyError {
    const failoverError = new Error(message) as FailoverProxyError;
    failoverError.isFailoverCandidate = true;
    failoverError.response = { status: statusCode };
    if (originalError?.stack) {
      failoverError.stack = originalError.stack;
    }
    return failoverError;
  }

  /**
   * 计算请求内容的哈希值，用于去重
   * 基于请求的关键字段生成唯一标识
   */
  private computeRequestHash(req: Request): string | null {
    const body = req.body;
    if (!body) return null;

    // 提取关键信息用于哈希
    const messages = body.messages;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return null;
    }

    // 只使用最后几条消息的内容来生成哈希（避免整个历史过长）
    const lastMessages = messages.slice(-3).map((msg: any) => ({
      role: msg.role,
      // 对消息内容进行简化处理，避免token差异导致哈希不同
      content: this.normalizeMessageContent(msg.content)
    }));

    // 包含其他可能影响计费的字段
    const keyFields = {
      messages: lastMessages,
      model: body.model,
      stream: body.stream
    };

    return crypto.createHash('md5').update(JSON.stringify(keyFields)).digest('hex');
  }

  /**
   * 规范化消息内容，去除细微差异
   */
  private normalizeMessageContent(content: any): string {
    if (typeof content === 'string') {
      // 去除首尾空白，限制长度
      return content.trim().slice(0, 500);
    }
    if (Array.isArray(content)) {
      // 对于数组类型内容（如图片+文本），只提取文本部分
      const textParts = content
        .filter((item: any) => item?.type === 'text')
        .map((item: any) => item.text?.trim().slice(0, 500) || '')
        .join('|');
      return textParts;
    }
    return String(content || '').slice(0, 500);
  }

  /**
   * 检查请求是否已经被处理过（去重）
   */
  private isRequestProcessed(hash: string | null): boolean {
    if (!hash) return false;

    const timestamp = this.requestDedupeCache.get(hash);
    if (timestamp === undefined) {
      // 未处理过，记录并返回false
      this.requestDedupeCache.set(hash, Date.now());
      return false;
    }

    // 检查是否过期
    const now = Date.now();
    if (now - timestamp > this.DEDUPE_CACHE_TTL) {
      // 缓存已过期，视为新请求
      this.requestDedupeCache.set(hash, now);
      return false;
    }

    // 在缓存期内，视为重复请求
    return true;
  }

  /**
   * 清理过期的去重缓存
   */
  private cleanExpiredDedupeCache(): void {
    const now = Date.now();
    for (const [hash, timestamp] of this.requestDedupeCache.entries()) {
      if (now - timestamp > this.DEDUPE_CACHE_TTL) {
        this.requestDedupeCache.delete(hash);
      }
    }
  }

  /**
   * 清理过期的频率限制跟踪数据
   */
  private cleanExpiredFrequencyTrackers(): void {
    const now = Date.now();
    const rules = this.dbManager.getRules();
    const activeRuleIds = new Set(rules.map((r: Rule) => r.id));

    for (const ruleId of this.frequencyLimitTracker.keys()) {
      // 清理不再存在的规则的跟踪数据
      if (!activeRuleIds.has(ruleId)) {
        this.frequencyLimitTracker.delete(ruleId);
        continue;
      }

      // 清理超时的跟踪数据
      const tracker = this.frequencyLimitTracker.get(ruleId);
      if (tracker) {
        const rule = this.dbManager.getRule(ruleId);
        if (rule && rule.frequencyWindow) {
          const windowMs = rule.frequencyWindow * 1000;
          if (now - tracker.windowStart > windowMs * 2) {
            this.frequencyLimitTracker.delete(ruleId);
          }
        }
      }
    }
  }

  /**
   * 根据GLM计费逻辑判断请求是否应该计费
   * 核心规则：
   * 1. 最后一条消息必须是 role: "user"
   * 2. 上一条消息不能是包含 tool_calls 的 assistant 消息（即不是工具回传）
   * 3. 上一条消息应该是 assistant（正常的对话流程），而非连续的 user 消息
   * 4. 避免历史消息重复计数：检查消息序列是否符合正常的对话模式
   */
  private shouldChargeRequest(req: Request): boolean {
    const body = req.body;
    const messages = body?.messages;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return false;
    }

    const lastMessage = messages[messages.length - 1];
    if (lastMessage.role !== 'user') {
      return false;
    }

    // 规则1：只有一条消息，这是新会话的开始，应该计费
    if (messages.length === 1) {
      return true;
    }

    const previousMessage = messages[messages.length - 2];

    // 规则2：上一条消息是 assistant 且包含 tool_calls，说明这是工具回调，不应计费
    if (previousMessage.role === 'assistant' && previousMessage.tool_calls) {
      return false;
    }

    // 规则3：上一条消息不是 user，说明是正常的 user->assistant->user 流程，应该计费
    if (previousMessage.role !== 'user') {
      return true;
    }

    // 规则4：上一条消息也是 user（连续的 user 消息）
    // 这种情况下需要进一步判断：
    // - 如果倒数第三条是 assistant，可能是用户连续发送的消息，只计最后一条
    // - 检查两条 user 消息的内容是否相同，相同则可能是历史重放
    if (messages.length >= 3) {
      const thirdLastMessage = messages[messages.length - 3];
      // 正常的对话流程: ... assistant, user, user
      // 这种情况说明最后一条 user 消息是在 assistant 之后的新消息，应该计费
      if (thirdLastMessage.role === 'assistant') {
        return true;
      }
    }

    // 规则5：检查是否有连续的 user 消息内容相同（可能的重复）
    const lastContent = this.normalizeMessageContent(lastMessage.content);
    const prevContent = this.normalizeMessageContent(previousMessage.content);
    if (lastContent === prevContent && lastContent.length > 0) {
      // 两条连续的 user 消息内容相同，可能是重复，不应计费
      return false;
    }

    // 规则6：如果上一条是 user，但没有 assistant 在中间，可能是异常的对话流
    // 为了安全起见，检查再往前是否有 assistant
    for (let i = messages.length - 3; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'assistant') {
        // 找到了最近的 assistant，说明当前是新的对话轮次，应该计费
        return true;
      }
      if (msg.role === 'user') {
        // 还是 user 消息，继续往前找
        continue;
      }
      // 其他 role（如 system），继续
    }

    // 没有找到 assistant，可能是异常情况，不计费
    return false;
  }

  /**
   * 从数据库实时获取服务配置
   * @param serviceId 服务ID
   * @returns 服务配置，如果不存在则返回 undefined
   */
  private getServiceById(serviceId: string): APIService | undefined {
    const allServices = this.dbManager.getAPIServices();
    const service = allServices.find(s => s.id === serviceId);

    // 调试日志: 记录获取的服务信息
    if (process.env.NODE_ENV === 'development' && service) {
      console.log(`[Proxy] getServiceById(${serviceId}): ${service.name} -> ${service.apiUrl}`);
    }

    return service;
  }

  private async findMatchingRule(routeId: string, req: Request): Promise<Rule | undefined> {
    const rules = this.getRulesByRouteId(routeId);
    if (!rules || rules.length === 0) return undefined;

    // 过滤掉被屏蔽的规则
    const enabledRules = rules.filter(rule => !rule.isDisabled);
    if (enabledRules.length === 0) return undefined;

    const body = req.body;
    const requestModel = body?.model;

    // 1. 首先查找 model-mapping 类型的规则，按 sortOrder 降序匹配
    if (requestModel) {
      const modelMappingRules = rules.filter(rule =>
        rule.contentType === 'model-mapping' &&
        rule.replacedModel &&
        requestModel.includes(rule.replacedModel)
      );

      // 过滤黑名单和token限制
      for (const rule of modelMappingRules) {
        const isBlacklisted = await this.dbManager.isServiceBlacklisted(
          rule.targetServiceId,
          routeId,
          rule.contentType
        );
        if (isBlacklisted) {
          continue;
        }

        // 检查并重置到期的规则
        this.dbManager.checkAndResetRuleIfNeeded(rule.id);
        this.dbManager.checkAndResetRequestCountIfNeeded(rule.id);

        // 检查token限制（tokenLimit单位是k，需要乘以1000转换为实际token数）
        if (rule.tokenLimit && rule.totalTokensUsed !== undefined && rule.totalTokensUsed >= rule.tokenLimit * 1000) {
          continue; // 跳过超限规则
        }

        // 检查请求次数限制
        if (rule.requestCountLimit && rule.totalRequestsUsed !== undefined && rule.totalRequestsUsed >= rule.requestCountLimit) {
          continue; // 跳过超限规则
        }

        // 检查频率限制
        if (this.isFrequencyLimitExceeded(rule)) {
          continue; // 跳过达到频率限制的规则
        }

        return rule;
      }
    }

    // 2. 查找其他内容类型的规则
    const contentType = this.determineContentType(req);
    const contentTypeRules = rules.filter(rule => rule.contentType === contentType);

    // 过滤黑名单和token限制
    for (const rule of contentTypeRules) {
      const isBlacklisted = await this.dbManager.isServiceBlacklisted(
        rule.targetServiceId,
        routeId,
        contentType
      );
      if (isBlacklisted) {
        continue;
      }

      // 检查并重置到期的规则
      this.dbManager.checkAndResetRuleIfNeeded(rule.id);
      this.dbManager.checkAndResetRequestCountIfNeeded(rule.id);

      // 检查token限制（tokenLimit单位是k，需要乘以1000转换为实际token数）
      if (rule.tokenLimit && rule.totalTokensUsed !== undefined && rule.totalTokensUsed >= rule.tokenLimit * 1000) {
        continue; // 跳过超限规则
      }

      // 检查请求次数限制
      if (rule.requestCountLimit && rule.totalRequestsUsed !== undefined && rule.totalRequestsUsed >= rule.requestCountLimit) {
        continue; // 跳过超限规则
      }

      // 检查频率限制
      if (this.isFrequencyLimitExceeded(rule)) {
        continue; // 跳过达到频率限制的规则
      }

      return rule;
    }

    // 3. 最后返回 default 规则
    const defaultRules = rules.filter(rule => rule.contentType === 'default');

    // 过滤黑名单和token限制
    for (const rule of defaultRules) {
      const isBlacklisted = await this.dbManager.isServiceBlacklisted(
        rule.targetServiceId,
        routeId,
        'default'
      );
      if (isBlacklisted) {
        continue;
      }

      // 检查并重置到期的规则
      this.dbManager.checkAndResetRuleIfNeeded(rule.id);
      this.dbManager.checkAndResetRequestCountIfNeeded(rule.id);

      // 检查token限制（tokenLimit单位是k，需要乘以1000转换为实际token数）
      if (rule.tokenLimit && rule.totalTokensUsed !== undefined && rule.totalTokensUsed >= rule.tokenLimit * 1000) {
        continue; // 跳过超限规则
      }

      // 检查请求次数限制
      if (rule.requestCountLimit && rule.totalRequestsUsed !== undefined && rule.totalRequestsUsed >= rule.requestCountLimit) {
        continue; // 跳过超限规则
      }

      // 检查频率限制
      if (this.isFrequencyLimitExceeded(rule)) {
        continue; // 跳过达到频率限制的规则
      }

      return rule;
    }

    return undefined;
  }

  private getAllMatchingRules(routeId: string, req: Request): Rule[] {
    const rules = this.getRulesByRouteId(routeId);
    if (!rules || rules.length === 0) return [];

    // 过滤掉被屏蔽的规则
    const enabledRules = rules.filter(rule => !rule.isDisabled);
    if (enabledRules.length === 0) return [];

    const body = req.body;
    const requestModel = body?.model;
    const candidates: Rule[] = [];

    // 1. Model mapping rules
    if (requestModel) {
      const modelMappingRules = enabledRules.filter(rule =>
        rule.contentType === 'model-mapping' &&
        rule.replacedModel &&
        requestModel.includes(rule.replacedModel)
      );
      candidates.push(...modelMappingRules);
    }

    // 2. Content type specific rules
    const contentType = this.determineContentType(req);
    const contentTypeRules = enabledRules.filter(rule => rule.contentType === contentType);
    candidates.push(...contentTypeRules);

    // 3. Default rules
    const defaultRules = enabledRules.filter(rule => rule.contentType === 'default');
    candidates.push(...defaultRules);

    // 4. 检查并重置到期的规则
    candidates.forEach(rule => {
      this.dbManager.checkAndResetRuleIfNeeded(rule.id);
      this.dbManager.checkAndResetRequestCountIfNeeded(rule.id);
    });

    // 5. 过滤掉超过限制的规则（仅在有多个候选规则时）
    if (candidates.length > 1) {
      const filteredCandidates = candidates.filter(rule => {
        // 检查token限制（tokenLimit单位是k，需要乘以1000转换为实际token数）
        if (rule.tokenLimit && rule.totalTokensUsed !== undefined) {
          if (rule.totalTokensUsed >= rule.tokenLimit * 1000) {
            return false;
          }
        }
        // 检查请求次数限制
        if (rule.requestCountLimit && rule.totalRequestsUsed !== undefined) {
          if (rule.totalRequestsUsed >= rule.requestCountLimit) {
            return false;
          }
        }
        // 检查频率限制
        if (this.isFrequencyLimitExceeded(rule)) {
          return false;
        }
        return true; // 没有设置限制的规则总是可用
      });

      // 如果过滤后还有规则，使用过滤后的结果
      if (filteredCandidates.length > 0) {
        return filteredCandidates;
      }
    }

    return candidates;
  }

  /**
   * 检查规则是否达到频率限制
   * 如果设置了频率限制(frequencyLimit)和时间窗口(frequencyWindow)，
   * 则跟踪当前时间窗口内的请求数，超过限制则返回true
   *
   * frequencyWindow = 0 表示"同一时刻"，计数器不会按时间窗口重置，
   * 持续累积直到达到 frequencyLimit
   */
  private isFrequencyLimitExceeded(rule: Rule): boolean {
    if (!rule.frequencyLimit || rule.frequencyLimit <= 0) {
      return false; // 没有设置频率限制，不超过限制
    }

    // frequencyWindow 为 0 表示"同一时刻"（不按时间窗口重置）
    const isZeroWindow = rule.frequencyWindow === 0;

    if (!rule.frequencyWindow && !isZeroWindow) {
      return false; // 没有设置时间窗口且不是0，不启用频率限制
    }

    const now = Date.now();
    const existing = this.frequencyLimitTracker.get(rule.id);

    if (!existing) {
      // 首次请求，创建新记录
      this.frequencyLimitTracker.set(rule.id, { count: 1, windowStart: now });
      return false;
    }

    // 如果是零窗口（同一时刻），不按时间重置，持续累积
    if (!isZeroWindow && rule.frequencyWindow) {
      const windowMs = rule.frequencyWindow * 1000;
      // 检查是否在当前时间窗口内
      if (now - existing.windowStart >= windowMs) {
        // 时间窗口已过，重置计数器
        this.frequencyLimitTracker.set(rule.id, { count: 1, windowStart: now });
        return false;
      }
    }

    // 检查是否超过限制
    if (existing.count >= rule.frequencyLimit) {
      return true; // 超过频率限制
    }

    // 增加计数
    existing.count++;
    this.frequencyLimitTracker.set(rule.id, existing);
    return false;
  }

  /**
   * 记录请求（增加频率计数）
   * 在请求成功处理后调用
   * frequencyWindow = 0 表示"同一时刻"，计数器不会按时间窗口重置
   */
  private recordRequest(ruleId: string): void {
    const rule = this.getRuleById(ruleId);
    if (!rule || !rule.frequencyLimit || rule.frequencyLimit <= 0) {
      return;
    }

    // frequencyWindow 为 0 表示"同一时刻"
    const isZeroWindow = rule.frequencyWindow === 0;

    // 如果 frequencyWindow 既不是 0 也不是正数，则不记录
    if (!isZeroWindow && !rule.frequencyWindow) {
      return;
    }

    const now = Date.now();
    const existing = this.frequencyLimitTracker.get(ruleId);

    if (!existing) {
      this.frequencyLimitTracker.set(ruleId, { count: 1, windowStart: now });
    } else if (isZeroWindow) {
      // 零窗口：持续累积，不按时间重置
      existing.count++;
      this.frequencyLimitTracker.set(ruleId, existing);
    } else if (rule.frequencyWindow) {
      const windowMs = rule.frequencyWindow * 1000;
      if (now - existing.windowStart < windowMs) {
        // 在时间窗口内，增加计数
        existing.count++;
        this.frequencyLimitTracker.set(ruleId, existing);
      } else {
        // 时间窗口已过，重置
        this.frequencyLimitTracker.set(ruleId, { count: 1, windowStart: now });
      }
    }
  }

  private determineContentType(req: Request): ContentType {
    const body = req.body;
    if (!body) return 'default';

    // 检查是否为 count_tokens 请求（后台类型）
    if (req.path.includes('/count_tokens')) {
      return 'background';
    }

    const explicitType = this.getExplicitContentType(req, body);
    if (explicitType) {
      return explicitType;
    }

    for (const detector of this.getContentTypeDetectors()) {
      if (detector.match(req, body)) {
        return detector.type;
      }
    }

    return 'default';
  }

  private getContentTypeDetectors(): ContentTypeDetector[] {
    return [
      {
        type: 'image-understanding',
        match: (_req, body) => this.containsImageContent(body.messages) || this.containsImageContent(body.input),
      },
      {
        type: 'thinking',
        match: (_req, body) => this.hasThinkingSignal(body),
      },
      {
        type: 'high-iq',
        match: (_req, body) => this.hasHighIqSignal(body),
      },
      {
        type: 'long-context',
        match: (_req, body) => this.hasLongContextSignal(body),
      },
      {
        type: 'background',
        match: (_req, body) => this.hasBackgroundSignal(body),
      },
    ];
  }

  private getExplicitContentType(req: Request, body: any): ContentType | null {
    const headerKeys = ['x-aicodeswitch-content-type', 'x-content-type', 'x-request-type', 'x-object-type'];
    const queryKeys = ['contentType', 'content_type', 'requestType', 'request_type', 'objectType', 'object_type'];
    const bodyKeys = ['contentType', 'content_type', 'requestType', 'request_type', 'objectType', 'object_type', 'mode'];

    for (const key of headerKeys) {
      const raw = req.headers[key];
      if (typeof raw === 'string') {
        const normalized = this.normalizeContentType(raw);
        if (normalized) return normalized;
      }
    }

    for (const key of queryKeys) {
      const raw = req.query[key];
      if (typeof raw === 'string') {
        const normalized = this.normalizeContentType(raw);
        if (normalized) return normalized;
      }
    }

    for (const key of bodyKeys) {
      const raw = body?.[key];
      if (typeof raw === 'string') {
        const normalized = this.normalizeContentType(raw);
        if (normalized) return normalized;
      }
    }

    const metaCandidates = [
      body?.metadata?.contentType,
      body?.metadata?.content_type,
      body?.metadata?.requestType,
      body?.metadata?.request_type,
      body?.meta?.contentType,
      body?.meta?.content_type,
    ];

    for (const raw of metaCandidates) {
      if (typeof raw === 'string') {
        const normalized = this.normalizeContentType(raw);
        if (normalized) return normalized;
      }
    }

    return null;
  }

  private normalizeContentType(raw: string): ContentType | null {
    const normalized = raw.trim().toLowerCase();
    const mapping: Record<string, ContentType> = {
      default: 'default',
      background: 'background',
      bg: 'background',
      thinking: 'thinking',
      reasoning: 'thinking',
      'high-iq': 'high-iq',
      high_iq: 'high-iq',
      highiq: 'high-iq',
      smart: 'high-iq',
      'long-context': 'long-context',
      long_context: 'long-context',
      long: 'long-context',
      image: 'image-understanding',
      image_understanding: 'image-understanding',
      'image-understanding': 'image-understanding',
      vision: 'image-understanding',
    };

    return mapping[normalized] || null;
  }

  private containsImageContent(payload: any): boolean {
    if (!payload) return false;
    const messages = Array.isArray(payload) ? payload : [payload];
    for (const message of messages) {
      const content = message?.content ?? message;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          const type = (block as any).type;
          if (type === 'image' || type === 'image_url' || type === 'input_image') {
            return true;
          }
          if ((block as any).image_url) {
            return true;
          }
        }
      }
    }
    return false;
  }

  private hasThinkingSignal(body: any): boolean {
    return Boolean(
      body?.reasoning ||
      body?.thinking ||
      body?.reasoning_effort ||
      body?.reasoning?.effort ||
      body?.reasoning?.enabled
    );
  }

  private hasHighIqSignal(body: any): boolean {
    const messages = body?.messages;
    if (!Array.isArray(messages)) {
      return false;
    }

    for (const message of messages) {
      if (message?.role !== 'user') continue;

      const content = message?.content;
      // 处理字符串类型的 content
      if (typeof content === 'string') {
        if (content.trim().startsWith('!!')) {
          return true;
        }
      }
      // 处理数组类型的 content
      else if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'text' && typeof block.text === 'string') {
            if (block.text.trim().startsWith('!!')) {
              return true;
            }
          }
        }
      }
    }

    return false;
  }

  private removeHighIqPrefix(body: any): any {
    if (!body?.messages || !Array.isArray(body.messages)) {
      return body;
    }

    // 深拷贝 body 以避免修改原始对象
    const processedBody = JSON.parse(JSON.stringify(body));

    for (const message of processedBody.messages) {
      if (message?.role !== 'user') continue;

      const content = message?.content;
      // 处理字符串类型的 content
      if (typeof content === 'string') {
        if (content.trim().startsWith('!!')) {
          // 移除 !! 前缀并执行 trim
          message.content = content.replace(/^!!\s*/, '').trim();
        }
      }
      // 处理数组类型的 content
      else if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'text' && typeof block.text === 'string') {
            if (block.text.trim().startsWith('!!')) {
              // 移除 !! 前缀并执行 trim
              block.text = block.text.replace(/^!!\s*/, '').trim();
            }
          }
        }
      }
    }

    return processedBody;
  }

  private hasBackgroundSignal(body: any): boolean {
    // 检测 count tokens 请求：messages 只有一条，role 为 "user"，content 为 "count"
    const messages = body?.messages;
    if (Array.isArray(messages) && messages.length === 1) {
      const firstMessage = messages[0];
      if (
        firstMessage?.role === 'user' &&
        (firstMessage?.content === 'count' ||
         (typeof firstMessage?.content === 'string' && firstMessage.content.trim() === 'count'))
      ) {
        return true;
      }
    }

    // 检测其他后台信号
    const candidates = [
      body?.background,
      body?.metadata?.background,
      body?.meta?.background,
      body?.priority,
      body?.metadata?.priority,
      body?.mode,
    ];
    return candidates.some((value) => value === true || value === 'background');
  }

  private hasLongContextSignal(body: any): boolean {
    const explicit = [
      body?.long_context,
      body?.longContext,
      body?.metadata?.long_context,
      body?.metadata?.longContext,
    ];
    if (explicit.some((value) => value === true)) {
      return true;
    }

    const maxTokens = this.extractNumericField(body, [
      'max_tokens',
      'max_output_tokens',
      'max_completion_tokens',
      'max_context_tokens',
    ]);
    if (maxTokens !== null && maxTokens >= 8000) {
      return true;
    }

    const contentLength = this.estimateTextLength(body);
    return contentLength >= 12000;
  }

  private extractNumericField(body: any, fields: string[]): number | null {
    for (const field of fields) {
      const value = body?.[field];
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }
      if (typeof value === 'string') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
    }
    return null;
  }

  private estimateTextLength(body: any): number {
    let length = 0;
    const addText = (value?: string | null) => {
      if (typeof value === 'string') {
        length += value.length;
      }
    };
    const addContent = (content: any) => {
      if (typeof content === 'string' || content === null) {
        addText(content);
        return;
      }
      if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part === 'string') {
            addText(part);
            continue;
          }
          if (part && typeof part === 'object') {
            if (typeof part.text === 'string') {
              addText(part.text);
            }
            if (typeof part.content === 'string') {
              addText(part.content);
            }
          }
        }
      }
    };

    if (Array.isArray(body?.messages)) {
      for (const message of body.messages) {
        addContent(message?.content);
      }
    }

    if (body?.input) {
      if (typeof body.input === 'string') {
        addText(body.input);
      } else if (Array.isArray(body.input)) {
        for (const message of body.input) {
          if (typeof message === 'string') {
            addText(message);
          } else if (message && typeof message === 'object') {
            addContent(message.content ?? message);
          }
        }
      } else if (body.input && typeof body.input === 'object') {
        addContent(body.input.content ?? body.input);
      }
    }

    addContent(body?.system);
    addText(body?.instructions);
    addText(body?.prompt);

    return length;
  }

  /** 判断是否为 Claude 相关类型（使用 x-api-key 认证） */
  private isClaudeSource(sourceType: SourceType) {
    return sourceType === 'claude-chat' || sourceType === 'claude';
  }

  private isOpenAIChatSource(sourceType: SourceType) {
    return sourceType === 'openai-chat' || sourceType === 'openai' || sourceType === 'deepseek-reasoning-chat';
  }

  /** 判断是否为 Gemini 类型 */
  private isGeminiSource(sourceType: SourceType) {
    return sourceType === 'gemini';
  }

  /** 判断是否为 Gemini Chat 类型 */
  private isGeminiChatSource(sourceType: SourceType) {
    return sourceType === 'gemini-chat';
  }

  private isChatType(sourceType: SourceType) {
    return sourceType.endsWith('-chat') || sourceType === 'gemini';
  }

  /**
   * 构建 Gemini API 的完整 URL
   * 用户只填写 base 地址（如 https://generativelanguage.googleapis.com）
   * 需要根据模型名称拼接成完整的 URL
   */
  private buildGeminiUrl(baseUrl: string, model: string, streamRequested: boolean): string {
    // 移除末尾的斜杠
    const base = baseUrl.replace(/\/$/, '');
    // 移除模型名称中可能包含的 models/ 前缀
    const modelName = model.replace(/^models\//, '');
    // 根据是否流式选择 endpoint
    const endpoint = streamRequested ? 'streamGenerateContent' : 'generateContent';
    return `${base}/v1beta/models/${modelName}:${endpoint}`;
  }

  /**
   * 判断模型是否应该使用 max_completion_tokens 字段
   * GPT 的新模型（如 o1 系列）使用 max_completion_tokens
   */
  private shouldUseMaxCompletionTokens(model: string): boolean {
    if (!model) return false;
    const lowerModel = model.toLowerCase();
    // o1 系列模型使用 max_completion_tokens
    return lowerModel.includes('o1-') ||
           lowerModel.startsWith('o1') ||
           lowerModel.includes('gpt-4.1') ||
           lowerModel.includes('gpt-4o') ||
           lowerModel.startsWith('chatgpt-');
  }

  /**
   * 获取 max tokens 字段的名称
   */
  private getMaxTokensFieldName(model: string): 'max_tokens' | 'max_completion_tokens' {
    return this.shouldUseMaxCompletionTokens(model) ? 'max_completion_tokens' : 'max_tokens';
  }

  /**
   * 应用 max_output_tokens 限制
   * 根据服务的 modelLimits 配置，对具体模型应用 max_tokens/max_completion_tokens 限制
   */
  private applyMaxOutputTokensLimit(body: any, service: APIService): any {
    if (!service.modelLimits || !body || typeof body !== 'object') {
      return body;
    }

    const result = { ...body };
    const model = result.model;

    if (!model) {
      return body;
    }

    // 查找该模型的限制配置
    // 支持精确匹配和前缀匹配（例如：gpt-4 可以匹配 gpt-4-turbo）
    let maxOutputLimit: number | undefined;

    // 1. 先尝试精确匹配
    if (typeof service.modelLimits[model] === 'number') {
      maxOutputLimit = service.modelLimits[model];
    } else {
      // 2. 尝试前缀匹配（查找配置中以模型名开头的项）
      const matchedKey = Object.keys(service.modelLimits).find(key =>
        model.startsWith(key) || key.startsWith(model)
      );
      if (matchedKey && typeof service.modelLimits[matchedKey] === 'number') {
        maxOutputLimit = service.modelLimits[matchedKey];
      }
    }

    if (maxOutputLimit === undefined) {
      // 没有找到配置，直接透传
      return body;
    }

    const maxTokensFieldName = this.getMaxTokensFieldName(model);

    // 获取请求中的 max_tokens 或 max_completion_tokens 值
    const requestedMaxTokens = result[maxTokensFieldName] || result.max_tokens;

    // 如果请求中指定了 max_tokens，并且超过配置的限制，则限制为配置的最大值
    if (typeof requestedMaxTokens === 'number' && requestedMaxTokens > maxOutputLimit) {
      // console.log(`[Proxy] Limiting ${maxTokensFieldName} from ${requestedMaxTokens} to ${maxOutputLimit} for model ${model} in service ${service.name}`);
      result[maxTokensFieldName] = maxOutputLimit;

      // 如果使用了 max_completion_tokens，清理旧的 max_tokens 字段
      if (maxTokensFieldName === 'max_completion_tokens' && result.max_tokens !== undefined) {
        delete result.max_tokens;
      }
    } else if (requestedMaxTokens === undefined) {
      // 如果请求中没有指定 max_tokens，则使用配置的最大值
      // console.log(`[Proxy] Setting ${maxTokensFieldName} to ${maxOutputLimit} for model ${model} in service ${service.name}`);
      result[maxTokensFieldName] = maxOutputLimit;
    }

    return result;
  }

  private applyModelOverride(body: any, rule: Rule) {
    // 如果 targetModel 为空或不存在,保留原始 model(透传)
    if (!rule.targetModel) return body;

    if (body && typeof body === 'object') {
      return { ...body, model: rule.targetModel };
    }
    return body;
  }

  private isStreamRequested(req: Request, body: any) {
    const accept = typeof req.headers.accept === 'string' ? req.headers.accept : '';
    return body?.stream === true || accept.includes('text/event-stream');
  }

  private buildUpstreamHeaders(
    req: Request,
    service: APIService,
    sourceType: SourceType,
    streamRequested: boolean,
    requestBody?: any
  ) {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      // 排除原始认证头，防止与代理设置的认证头冲突
      if (['host', 'content-length', 'authorization', 'x-api-key', 'x-anthropic-api-key', 'anthropic-api-key', 'x-goog-api-key'].includes(key.toLowerCase())) {
        continue;
      }
      if (typeof value === 'string') {
        headers[key] = value;
      } else if (Array.isArray(value)) {
        headers[key] = value.join(', ');
      }
    }

    // 确定认证方式：优先使用服务配置的 authType
    // 注意：向下兼容 'auto' 字符串值（前端已移除 AuthType.AUTO 枚举，但旧数据可能包含此值）
    const authType = service.authType || AuthType.AUTH_TOKEN;
    // 向下兼容：检测旧数据的 'auto' 值
    // TODO: 删除
    const isAuto = authType === 'auto' as any;

    // 使用 x-goog-api-key 认证（适用于 Google Gemini API 和 Gemini Chat）
    if (authType === AuthType.G_API_KEY || (isAuto && (this.isGeminiSource(sourceType) || this.isGeminiChatSource(sourceType)))) {
      headers['x-goog-api-key'] = service.apiKey;
    }
    // 使用 x-api-key 认证（适用于 claude-chat, claude-code 及某些需要 x-api-key 的 openai-chat 兼容 API）
    else if (authType === AuthType.API_KEY || (isAuto && this.isClaudeSource(sourceType))) {
      headers['x-api-key'] = service.apiKey;
      if (this.isClaudeSource(sourceType) || authType === AuthType.API_KEY) {
        // 仅在明确配置或 Claude 源时添加 anthropic-version
        headers['anthropic-version'] = headers['anthropic-version'] || '2023-06-01';
      }
    }
    // 使用 Authorization 认证（适用于 openai-chat, openai-responses, deepseek-reasoning-chat 等）
    else {
      headers.authorization = `Bearer ${service.apiKey}`;
    }

    if (streamRequested && !headers.accept) {
      headers.accept = 'text/event-stream';
    }

    if (!headers.connection) {
      if (streamRequested) {
        headers.connection = 'keep-alive';
      }
    }

    if (!headers['content-type']) {
      headers['content-type'] = 'application/json';
    }

    // 添加 content-length（对于有请求体的方法）
    if (requestBody && ['POST', 'PUT', 'PATCH'].includes(req.method.toUpperCase())) {
      const bodyStr = JSON.stringify(requestBody);
      headers['content-length'] = Buffer.byteLength(bodyStr, 'utf8').toString();
    }

    return headers;
  }

  private copyResponseHeaders(responseHeaders: Record<string, any>, res: Response) {
    Object.keys(responseHeaders).forEach((key) => {
      if (!['content-encoding', 'transfer-encoding', 'connection', 'content-length'].includes(key.toLowerCase())) {
        res.setHeader(key, responseHeaders[key]);
      }
    });
  }

  /**
   * 对敏感的 header 值进行脱敏处理
   * @param key header 键（小写）
   * @param value header 值
   * @returns 脱敏后的值，如果 header 是敏感的则返回 32 个 *
   */
  private sanitizeHeaderValue(key: string, value: string): string {
    // 需要脱敏的敏感 header 列表（不区分大小写）
    const sensitiveHeaders = [
      'authorization',        // Bearer token
      'x-api-key',           // API key
      'api-key',             // API key
      'apikey',              // API key
      'x-openai-api-key',    // OpenAI API key
      'openai-api-key',      // OpenAI API key
      'anthropic-api-key',   // Anthropic API key
      'access-token',         // Access token
      'x-anthropic-api-key', // Anthropic API key
      'refresh-token',      // Refresh token
    ];

    // 检查是否是敏感 header
    if (sensitiveHeaders.includes(key)) {
      return '********************************';
    }

    return value;
  }

  private normalizeHeaders(headers: Request['headers']) {
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === 'string') {
        normalized[key] = this.sanitizeHeaderValue(key.toLowerCase(), value);
      } else if (Array.isArray(value)) {
        normalized[key] = this.sanitizeHeaderValue(key.toLowerCase(), value.join(', '));
      }
    }
    return normalized;
  }

  private normalizeResponseHeaders(headers: Record<string, any>): Record<string, string> {
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (value !== null && value !== undefined) {
        if (typeof value === 'string') {
          normalized[key] = this.sanitizeHeaderValue(key.toLowerCase(), value);
        } else if (Array.isArray(value)) {
          normalized[key] = this.sanitizeHeaderValue(key.toLowerCase(), value.join(', '));
        } else {
          normalized[key] = this.sanitizeHeaderValue(key.toLowerCase(), String(value));
        }
      }
    }
    return normalized;
  }

  private async readStreamBody(stream: NodeJS.ReadableStream): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = '';
      stream.on('data', (chunk) => {
        data += chunk.toString();
      });
      stream.on('end', () => resolve(data));
      stream.on('error', reject);
    });
  }

  private safeJsonParse(raw: string) {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private extractTokenUsage(usage: any): TokenUsage | undefined {
    if (!usage) return undefined;
    if (typeof usage.prompt_tokens === 'number' || typeof usage.completion_tokens === 'number') {
      return extractTokenUsageFromOpenAIUsage(usage);
    }
    if (typeof usage.input_tokens === 'number' || typeof usage.output_tokens === 'number') {
      return extractTokenUsageFromClaudeUsage(usage);
    }
    return undefined;
  }

  /**
   * 从请求中提取 session ID（默认方法）
   * Claude Code: metadata.user_id
   * Codex: headers.session_id
   */
  private defaultExtractSessionId(request: Request, type: TargetType): string | null {
    if (type === 'claude-code') {
      // Claude Code 使用 metadata.user_id
      return request.body?.metadata?.user_id || null;
    } else if (type === 'codex') {
      // Codex 使用 headers.session_id
      const sessionId = request.headers['session_id'];
      if (typeof sessionId === 'string') {
        return sessionId;
      }
      if (Array.isArray(sessionId)) {
        return sessionId[0] || null;
      }
    }
    return null;
  }

  /**
   * 提取会话标题（默认方法）
   * 对于新会话，尝试从第一条消息的内容中提取标题
   * 优化：使用第一条用户消息的完整内容，并智能截取
   * 对于结构化内容（数组），从最后一个元素取值
   */
  private defaultExtractSessionTitle(request: Request, sessionId: string): string | undefined {
    const existingSession = this.dbManager.getSession(sessionId);
    if (existingSession) {
      // 已存在的会话，保持原有标题
      return existingSession.title;
    }

    // 新会话，从消息内容提取标题
    const messages = request.body?.messages;
    if (Array.isArray(messages) && messages.length > 0) {
      // 查找第一条 user 消息
      const firstUserMessage = messages.find((msg: any) => msg.role === 'user');
      if (firstUserMessage) {
        const content = firstUserMessage.content;
        let rawText = '';

        if (typeof content === 'string') {
          rawText = content;
        } else if (Array.isArray(content) && content.length > 0) {
          // 处理结构化内容（如图片+文本）
          // 从最后一个元素取值，通常最后的文本才是真正的用户输入
          const lastBlock = content[content.length - 1];
          if (lastBlock?.type === 'text' && lastBlock?.text) {
            rawText = lastBlock.text;
          } else {
            // 如果最后一个不是 text 类型，尝试找到第一个 text 类型作为备用
            const textBlock = content.find((block: any) => block?.type === 'text');
            if (textBlock?.text) {
              rawText = textBlock.text;
            }
          }
        }

        if (rawText) {
          return this.formatSessionTitle(rawText);
        }
      }
    }
    return undefined;
  }

  /**
   * 格式化会话标题
   * - 去除多余空白和换行符
   * - 智能截取，在单词边界处截断
   * - 限制最大长度为100个字符
   */
  private formatSessionTitle(text: string): string {
    // 去除多余空白和换行符，替换为单个空格
    let formatted = text
      .replace(/\s+/g, ' ')  // 多个空白字符替换为单个空格
      .replace(/[\r\n]+/g, ' ')  // 换行符替换为空格
      .trim();

    // 限制最大长度
    const maxLength = 100;
    if (formatted.length <= maxLength) {
      return formatted;
    }

    // 在单词边界处截断
    let truncated = formatted.slice(0, maxLength);
    const lastSpaceIndex = truncated.lastIndexOf(' ');

    if (lastSpaceIndex > maxLength * 0.7) {
      // 如果最后一个空格位置在长度的70%之后，在空格处截断
      truncated = truncated.slice(0, lastSpaceIndex);
    }

    // 添加省略号
    return truncated.trim() + '...';
  }

  /**
   * 根据源工具类型和目标API类型,映射请求路径
   * @param sourceTool 源工具类型 (claude-code 或 codex)
   * @param targetSourceType 目标API的数据格式类型
   * @param originalPath 原始请求路径(已去除工具前缀)
   * @returns 映射后的目标路径
   */
  private mapRequestPath(sourceTool: TargetType, targetSourceType: SourceType, originalPath: string): string {
    // Claude Code 发起的请求
    if (sourceTool === 'claude-code') {
      // Claude Code 默认使用 Claude API 格式
      if (this.isClaudeSource(targetSourceType)) {
        // Claude → Claude: 直接透传路径
        return originalPath;
      } else if (this.isOpenAIChatSource(targetSourceType)) {
        // Claude → OpenAI Chat: /v1/messages → /v1/chat/completions
        return originalPath.replace(/\/v1\/messages\b/, '/v1/chat/completions');
      }
    }

    // Codex 发起的请求
    if (sourceTool === 'codex') {
      // Codex 默认使用 OpenAI Chat API 格式
      if (this.isOpenAIChatSource(targetSourceType)) {
        // OpenAI Chat → OpenAI Chat: 直接透传路径
        return originalPath;
      } else if (this.isClaudeSource(targetSourceType)) {
        // OpenAI Chat → Claude: /v1/chat/completions → /v1/messages
        return originalPath.replace(/\/v1\/chat\/completions\b/, '/v1/messages');
      }
    }

    // 默认:直接返回原始路径
    return originalPath;
  }

  private async proxyRequest(
    req: Request,
    res: Response,
    route: Route,
    rule: Rule,
    service: APIService,
    options?: ProxyRequestOptions
  ) {
    res.locals.skipLog = true;
    const startTime = Date.now();
    const sourceType = (service.sourceType || 'openai-chat') as SourceType;
    const targetType = route.targetType;
    const failoverEnabled = options?.failoverEnabled === true;
    const forwardedToServiceName = options?.forwardedToServiceName;
    let requestBody: any = req.body || {};
    let usageForLog: TokenUsage | undefined;
    let logged = false;

    // MCP 图像理解处理
    let tempImageFiles: string[] = [];
    let useMCPProcessing = false;
    let mcpConfig: any = undefined;

    // 只对图像理解请求进行 MCP 诊断
    if (rule.contentType === 'image-understanding') {
      // 诊断日志：检查规则的MCP配置
      console.log('[MCP-DIAG] Checking MCP configuration for image-understanding rule:', {
        ruleId: rule.id,
        contentType: rule.contentType,
        useMCP: rule.useMCP,
        mcpId: rule.mcpId,
        isRuleUsingMCP: isRuleUsingMCP(rule)
      });
    }

    // 检查 MCP 是否可用
    if (isRuleUsingMCP(rule)) {
      if (rule.contentType === 'image-understanding') {
        console.log('[MCP-DIAG] Rule is configured to use MCP');
      }
      const mcps = this.dbManager.getMCPs();

      if (isMCPAvailable(rule, mcps)) {
        if (rule.contentType === 'image-understanding') {
          console.log('[MCP-DIAG] MCP is available, enabling MCP processing');
          console.log('[MCP-DIAG] Available MCPs:', mcps.map(m => ({ id: m.id, name: m.name })));
        }
        useMCPProcessing = true;
        // 获取 MCP 配置
        mcpConfig = mcps.find(m => m.id === rule.mcpId);
        if (rule.contentType === 'image-understanding') {
          console.log('[MCP-DIAG] MCP config found:', mcpConfig ? { id: mcpConfig.id, name: mcpConfig.name } : null);
        }
      } else {
        if (rule.contentType === 'image-understanding') {
          console.warn('[MCP-DIAG] MCP is NOT available');
          console.warn('[MCP-DIAG] Availability check failed for:');
          console.warn('  - Rule ID:', rule.id);
          console.warn('  - Configured MCP ID:', rule.mcpId || 'not configured');
          console.warn('  - useMCP flag:', rule.useMCP);
          console.warn('  - contentType:', rule.contentType);
          console.warn('  - MCPs in database:', mcps.length);
          if (rule.mcpId) {
            const found = mcps.find(m => m.id === rule.mcpId);
            console.warn('  - MCP found in database:', !!found);
          }
        }
      }
    } else {
      if (rule.contentType === 'image-understanding') {
        console.warn('[MCP-DIAG] Rule is NOT configured to use MCP');
        console.warn('[MCP-DIAG] Rule details:', {
          contentType: rule.contentType,
          useMCP: rule.useMCP,
          mcpId: rule.mcpId,
          contentTypeCheck: rule.contentType === 'image-understanding',
          useMCPCheck: rule.useMCP === true,
          mcpIdCheck: !!rule.mcpId
        });
      }
    }

    // 只有在 MCP 可用时才进行 MCP 处理
    if (useMCPProcessing) {
      if (rule.contentType === 'image-understanding') {
        console.log('[MCP-DIAG] Starting MCP image processing');
      }
      try {
        // 提取消息中的图片
        const messages = requestBody.messages || [];
        if (rule.contentType === 'image-understanding') {
          console.log('[MCP-DIAG] Request messages count:', messages.length);
        }

        const imageInfos = await extractImagesFromMessages(messages);
        if (rule.contentType === 'image-understanding') {
          console.log('[MCP-DIAG] Extracted images count:', imageInfos.length);
        }

        if (imageInfos.length > 0) {
          // 记录临时文件路径以便后续清理
          tempImageFiles = imageInfos.map(info => info.filePath);

          // 构造 MCP 消息体（将图片替换为本地路径引用，并添加明确的 MCP 调用指示）
          requestBody.messages = constructMCPMessages(messages, imageInfos, mcpConfig);

          console.log(`[MCP] Processed ${imageInfos.length} images for MCP request`);
          console.log(`[MCP] Using MCP tool: ${mcpConfig?.name || 'Unknown'}`);
          for (const info of imageInfos) {
            console.log(`[MCP] Image saved to: ${info.filePath}`);
          }
        } else {
          if (rule.contentType === 'image-understanding') {
            console.warn('[MCP-DIAG] No images found in request messages');
            console.warn('[MCP-DIAG] Message structure:');
            messages.forEach((msg: any, idx: number) => {
              if (msg.content && Array.isArray(msg.content)) {
                console.warn(`  Message ${idx}: ${msg.content.length} blocks`);
                msg.content.forEach((block: any, bidx: number) => {
                  console.warn(`    Block ${bidx}: type=${block.type}, hasSource=${!!block.source}, hasData=${!!(block.source && block.source.data)}`);
                });
              }
            });
          }
        }
      } catch (error: any) {
        if (rule.contentType === 'image-understanding') {
          console.error('[MCP-DIAG] Failed to process images:', error);
          console.error('[MCP-DIAG] Error stack:', error.stack);
        }
        // 清理已创建的临时文件
        if (tempImageFiles.length > 0) {
          cleanupTempImages(tempImageFiles);
          tempImageFiles = []; // 重置，因为已经清理了
        }
        // 不返回错误，而是继续使用默认处理逻辑
        useMCPProcessing = false;
      }
    }

    // 高智商请求处理：移除 !! 前缀
    if (rule.contentType === 'high-iq' && requestBody.messages) {
      requestBody = this.removeHighIqPrefix(requestBody);
      console.log('[HIGH-IQ] Removed !! prefix from user messages');
    }

    // 用于收集响应数据的变量
    let responseHeadersForLog: Record<string, string> | undefined;
    let responseBodyForLog: string | undefined;
    let streamChunksForLog: string[] | undefined;
    let upstreamRequestForLog: RequestLog['upstreamRequest'] | undefined;
    let actuallyUsedProxy = false; // 标记是否实际使用了代理

    // 标记规则正在使用
    rulesStatusBroadcaster.markRuleInUse(route.id, rule.id);

    const finalizeLog = async (statusCode: number, error?: string) => {
      if (logged) return;

      // 检查是否启用日志记录（默认启用）
      const enableLogging = this.config?.enableLogging !== false; // 默认为 true
      if (!enableLogging) {
        return;
      }

      // 只记录来自编程工具的请求
      if (!SUPPORTED_TARGETS.some(target => req.path.startsWith(`/${target}/`))) {
        return;
      }

      logged = true;

      // 获取供应商信息
      const vendors = this.dbManager.getVendors();
      const vendor = vendors.find(v => v.id === service.vendorId);

      // 从请求体中提取模型信息
      const requestModel = req.body?.model;

      await this.dbManager.addLog({
        timestamp: Date.now(),
        method: req.method,
        path: req.path,
        headers: this.normalizeHeaders(req.headers),
        body: req.body,
        statusCode,
        responseTime: Date.now() - startTime,
        targetProvider: service.name,
        usage: usageForLog,
        error,

        // 新增字段
        contentType: rule.contentType,
        ruleId: rule.id,
        targetType,
        targetServiceId: service.id,
        targetServiceName: service.name,
        targetModel: rule.targetModel || requestModel,
        vendorId: service.vendorId,
        vendorName: vendor?.name,
        requestModel,
        responseHeaders: responseHeadersForLog,
        responseBody: responseBodyForLog,
        streamChunks: streamChunksForLog,

        upstreamRequest: upstreamRequestForLog,
      });

      // Session 索引逻辑
      const sessionId = this.defaultExtractSessionId(req, targetType);
      if (sessionId) {
        const totalTokens = (usageForLog?.inputTokens || 0) + (usageForLog?.outputTokens || 0) +
                           (usageForLog?.totalTokens || 0);
        const sessionTitle = this.defaultExtractSessionTitle(req, sessionId);
        this.dbManager.upsertSession({
          id: sessionId,
          targetType,
          title: sessionTitle,
          firstRequestAt: startTime,
          lastRequestAt: Date.now(),
          vendorId: service.vendorId,
          vendorName: vendor?.name,
          serviceId: service.id,
          serviceName: service.name,
          model: requestModel || rule.targetModel,
          totalTokens,
        });
      }

      // 更新规则的token使用量（只在成功请求时更新）
      if (usageForLog && statusCode < 400) {
        const totalTokens = (usageForLog.inputTokens || 0) + (usageForLog.outputTokens || 0);
        if (totalTokens > 0) {
          this.dbManager.incrementRuleTokenUsage(rule.id, totalTokens);

          // 获取更新后的规则数据并广播
          const updatedRule = this.dbManager.getRule(rule.id);
          if (updatedRule) {
            rulesStatusBroadcaster.broadcastUsageUpdate(
              rule.id,
              updatedRule.totalTokensUsed || 0,
              updatedRule.totalRequestsUsed || 0
            );
          }
        }
      }

      // 更新规则的请求次数（只在成功请求时更新）
      if (statusCode < 400 && this.shouldChargeRequest(req)) {
        // 计算请求哈希用于去重
        const requestHash = this.computeRequestHash(req);
        // 检查是否是重复请求（如网络重试）
        if (!this.isRequestProcessed(requestHash)) {
          this.dbManager.incrementRuleRequestCount(rule.id, 1);

          // 更新频率限制跟踪
          this.recordRequest(rule.id);

          // 获取更新后的规则数据并广播
          const updatedRule = this.dbManager.getRule(rule.id);
          if (updatedRule) {
            rulesStatusBroadcaster.broadcastUsageUpdate(
              rule.id,
              updatedRule.totalTokensUsed || 0,
              updatedRule.totalRequestsUsed || 0
            );
          }
        }
        // 定期清理过期缓存
        if (Math.random() < 0.01) { // 1%概率清理，避免每次都清理
          this.cleanExpiredDedupeCache();
        }
      }

      // 定期清理过期的频率限制跟踪数据
      if (Math.random() < 0.01) { // 1%概率清理
        this.cleanExpiredFrequencyTrackers();
      }

      // 清理 MCP 临时图片文件
      if (tempImageFiles.length > 0) {
        cleanupTempImages(tempImageFiles);
        console.log(`[MCP] Cleaned up ${tempImageFiles.length} temporary image files`);
      }
    };

    const handleUpstreamHttpError = async (
      statusCode: number,
      responseData: any,
      responseHeaders: any,
      contentType: string
    ) => {
      usageForLog = this.extractTokenUsage(responseData?.usage);
      responseBodyForLog = typeof responseData === 'string' ? responseData : JSON.stringify(responseData);

      let errorDetail: string;
      if (typeof responseData?.error === 'string') {
        errorDetail = responseData.error;
      } else if (typeof responseData?.message === 'string') {
        errorDetail = responseData.message;
      } else if (responseData?.error) {
        errorDetail = JSON.stringify(responseData.error);
      } else {
        errorDetail = JSON.stringify(responseData);
      }

      const failoverHint = failoverEnabled ? this.buildFailoverHint(forwardedToServiceName) : '';
      const upstreamErrorMessage = `Upstream API returned ${statusCode}: ${errorDetail}${failoverHint}`;

      const vendors = this.dbManager.getVendors();
      const vendor = vendors.find(v => v.id === service.vendorId);

      await this.dbManager.addErrorLog({
        timestamp: Date.now(),
        method: req.method,
        path: req.path,
        statusCode,
        errorMessage: upstreamErrorMessage,
        errorStack: undefined,
        requestHeaders: this.normalizeHeaders(req.headers),
        requestBody: req.body ? JSON.stringify(req.body) : undefined,
        responseHeaders: responseHeadersForLog,
        responseBody: responseBodyForLog,
        ruleId: rule.id,
        targetType,
        targetServiceId: service.id,
        targetServiceName: service.name,
        targetModel: rule.targetModel || req.body?.model,
        vendorId: service.vendorId,
        vendorName: vendor?.name,
        requestModel: req.body?.model,
        upstreamRequest: upstreamRequestForLog,
        responseTime: Date.now() - startTime,
      });

      if (failoverEnabled) {
        await finalizeLog(statusCode, upstreamErrorMessage);
        throw this.createFailoverError(upstreamErrorMessage, statusCode);
      }

      this.copyResponseHeaders(responseHeaders, res);
      if (contentType.includes('application/json')) {
        res.status(statusCode).json(responseData);
      } else {
        res.status(statusCode).send(responseData);
      }
      await finalizeLog(res.statusCode);
    };

    try {
      if (targetType === 'claude-code') {
        if (this.isClaudeSource(sourceType)) {
          requestBody = this.applyModelOverride(requestBody, rule);
        } else if (this.isOpenAIChatSource(sourceType)) {
          requestBody = transformClaudeRequestToOpenAIChat(requestBody, rule.targetModel);
        } else if (this.isGeminiSource(sourceType) || this.isGeminiChatSource(sourceType)) {
          requestBody = transformClaudeRequestToGemini(requestBody);
        } else {
          res.status(400).json({ error: 'Unsupported source type for Claude Code.' });
          await finalizeLog(400, 'Unsupported source type for Claude Code');
          return;
        }
      } else if (targetType === 'codex') {
        if (this.isOpenAIChatSource(sourceType)) {
          requestBody = this.applyModelOverride(requestBody, rule);
        } else if (this.isClaudeSource(sourceType)) {
          requestBody = transformClaudeRequestToOpenAIChat(requestBody, rule.targetModel);
        } else if (this.isGeminiSource(sourceType) || this.isGeminiChatSource(sourceType)) {
          requestBody = transformOpenAIChatRequestToGemini(requestBody);
        } else {
          res.status(400).json({ error: 'Unsupported source type for Codex.' });
          await finalizeLog(400, 'Unsupported source type for Codex');
          return;
        }
      }

      // 应用 max_output_tokens 限制
      requestBody = this.applyMaxOutputTokensLimit(requestBody, service);

      const streamRequested = this.isStreamRequested(req, requestBody);

      // Build the full URL by appending the request path to the service API URL
      let pathToAppend = req.path;
      if (route.targetType === 'claude-code' && req.path.startsWith('/claude-code')) {
        pathToAppend = req.path.slice('/claude-code'.length);
      } else if (route.targetType === 'codex' && req.path.startsWith('/codex')) {
        pathToAppend = req.path.slice('/codex'.length);
      }

      // 根据源工具类型和目标API类型,映射请求路径
      const mappedPath = this.mapRequestPath(route.targetType, sourceType, pathToAppend);

      // 构建上游 URL
      let upstreamUrl: string;
      if (this.isGeminiSource(sourceType)) {
        // Gemini 类型需要特殊处理：根据模型拼接完整 URL
        const model = requestBody.model || rule.targetModel || 'gemini-pro';
        upstreamUrl = this.buildGeminiUrl(service.apiUrl, model, streamRequested);
      } else if (this.isChatType(sourceType) || this.isGeminiChatSource(sourceType)) {
        // Chat 类型（包括 gemini-chat）直接使用用户配置的完整 URL
        upstreamUrl = service.apiUrl;
      } else {
        upstreamUrl = `${service.apiUrl}${mappedPath}`;
      }

      const config: AxiosRequestConfig = {
        method: req.method as any,
        url: upstreamUrl,
        headers: this.buildUpstreamHeaders(req, service, sourceType, streamRequested, requestBody),
        timeout: rule.timeout || 3000000, // 默认300秒
        validateStatus: () => true,
        responseType: streamRequested ? 'stream' : 'json',
      };

      if (Object.keys(req.query).length > 0) {
        config.params = req.query;
      }

      if (['POST', 'PUT', 'PATCH'].includes(req.method.toUpperCase())) {
        config.data = requestBody;
      }

      // 应用代理配置
      if (service.enableProxy) {
        const appConfig = this.dbManager.getConfig();
        if (appConfig.proxyEnabled && appConfig.proxyUrl) {
          try {
            const { HttpsProxyAgent } = await import('https-proxy-agent');
            const proxyAuth = appConfig.proxyUsername && appConfig.proxyPassword
              ? `${appConfig.proxyUsername}:${appConfig.proxyPassword}@`
              : '';
            let proxyUrl = appConfig.proxyUrl;
            if (!proxyUrl.startsWith('http://') && !proxyUrl.startsWith('https://')) {
              proxyUrl = `http://${proxyAuth}${proxyUrl}`;
            } else if (proxyAuth) {
              // 如果 URL 已经包含协议，需要插入认证信息
              const urlObj = new URL(proxyUrl);
              urlObj.username = appConfig.proxyUsername!;
              urlObj.password = appConfig.proxyPassword!;
              proxyUrl = urlObj.toString();
            }

            config.httpsAgent = new HttpsProxyAgent(proxyUrl);
            config.httpAgent = new HttpsProxyAgent(proxyUrl);
            actuallyUsedProxy = true; // 标记实际使用了代理
          } catch (error) {
            console.error('[Proxy] Failed to create proxy agent:', error);
          }
        }
      }

      // 记录实际发出的请求信息作为日志的一部分
      // const actualModel = requestBody?.model || '';
      // const maxTokensFieldName = this.getMaxTokensFieldName(actualModel);
      // const actualMaxTokens = requestBody?.[maxTokensFieldName] || requestBody?.max_tokens;
      const upstreamHeaders = this.buildUpstreamHeaders(req, service, sourceType, streamRequested, requestBody);

      upstreamRequestForLog = {
        url: upstreamUrl,
        // model: actualModel,
        // [maxTokensFieldName]: actualMaxTokens,
        headers: upstreamHeaders,
        body: requestBody || undefined,
      };
      if (actuallyUsedProxy) {
        upstreamRequestForLog.useProxy = true;
      }

      const response = await axios(config);
      const responseHeaders = response.headers || {};
      const contentType = typeof responseHeaders['content-type'] === 'string' ? responseHeaders['content-type'] : '';
      const isEventStream = streamRequested && contentType.includes('text/event-stream');

      // 先处理 4xx/5xx：在故障切换模式下抛错，由上层继续切换下一服务
      if (response.status >= 400) {
        let errorResponseData = response.data;
        if (streamRequested && response.data && typeof response.data.on === 'function') {
          const raw = await this.readStreamBody(response.data);
          errorResponseData = this.safeJsonParse(raw) ?? raw;
        }

        responseHeadersForLog = this.normalizeResponseHeaders(responseHeaders);
        await handleUpstreamHttpError(response.status, errorResponseData, responseHeaders, contentType);
        return;
      }

      if (isEventStream && response.data) {
        res.status(response.status);

        if (targetType === 'claude-code' && this.isOpenAIChatSource(sourceType)) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');

          const parser = new SSEParserTransform();
          const eventCollector = new SSEEventCollectorTransform();
          const converter = new OpenAIToClaudeEventTransform({ model: requestBody?.model });
          const serializer = new SSESerializerTransform();

          // 收集响应头
          responseHeadersForLog = this.normalizeResponseHeaders(responseHeaders);

          // 监听事件收集器的完成事件，确保所有chunks都被收集
          const finalizeChunks = () => {
            const usage = converter.getUsage();
            if (usage) {
              usageForLog = extractTokenUsageFromClaudeUsage(usage);
            } else {
              // 尝试从event collector中提取usage
              const extractedUsage = eventCollector.extractUsage();
              if (extractedUsage) {
                usageForLog = this.extractTokenUsage(extractedUsage);
              }
            }
            // 收集stream chunks（每个chunk是一个完整的SSE事件）
            streamChunksForLog = eventCollector.getChunks();
            // 将所有 chunks 合并成完整的响应体用于日志记录
            responseBodyForLog = streamChunksForLog.join('\n');
            console.log('[Proxy] Stream request finished, collected chunks:', streamChunksForLog?.length || 0);
            console.log('[Proxy] Response body length:', responseBodyForLog?.length || 0);
            void finalizeLog(res.statusCode);
          };

          // 在pipeline完成且eventCollector flush后执行
          eventCollector.on('finish', () => {
            console.log('[Proxy] EventCollector finished, collecting chunks...');
            finalizeChunks();
          });

          // 备用：如果eventCollector的finish没有触发，监听res的finish
          res.on('finish', () => {
            console.log('[Proxy] Response finished');
            if (!streamChunksForLog) {
              console.log('[Proxy] Chunks not collected yet, forcing collection...');
              finalizeChunks();
            }
          });

          // 监听 res 的错误事件
          res.on('error', (err) => {
            console.error('[Proxy] Response stream error:', err);
          });

          pipeline(response.data, parser, eventCollector, converter, serializer, res, async (error) => {
            if (error) {
              console.error('[Proxy] Pipeline error for claude-code:', error);

              // 记录到错误日志 - 包含请求详情和实际转发信息
              try {
                // 获取供应商信息
                const vendors = this.dbManager.getVendors();
                const vendor = vendors.find(v => v.id === service.vendorId);

                await this.dbManager.addErrorLog({
                  timestamp: Date.now(),
                  method: req.method,
                  path: req.path,
                  statusCode: 500,
                  errorMessage: error.message || 'Stream processing error',
                  errorStack: error.stack,
                  requestHeaders: this.normalizeHeaders(req.headers),
                  requestBody: req.body ? JSON.stringify(req.body) : undefined,
                  upstreamRequest: upstreamRequestForLog,
                  // 添加请求详情
                  ruleId: rule.id,
                  targetType,
                  targetServiceId: service.id,
                  targetServiceName: service.name,
                  targetModel: rule.targetModel || req.body?.model,
                  vendorId: service.vendorId,
                  vendorName: vendor?.name,
                  requestModel: req.body?.model,
                  responseTime: Date.now() - startTime,
                });
              } catch (logError) {
                console.error('[Proxy] Failed to log error:', logError);
              }

              // 尝试向客户端发送错误事件
              try {
                if (!res.writableEnded) {
                  const errorEvent = `event: error\ndata: ${JSON.stringify({
                    type: 'error',
                    error: {
                      type: 'api_error',
                      message: 'Stream processing error occurred'
                    }
                  })}\n\n`;
                  res.write(errorEvent);
                  res.end();
                }
              } catch (writeError) {
                console.error('[Proxy] Failed to send error event:', writeError);
              }

              await finalizeLog(500, error.message);
            }
          });
          return;
        }

        if (targetType === 'codex' && this.isClaudeSource(sourceType)) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');

          const parser = new SSEParserTransform();
          const eventCollector = new SSEEventCollectorTransform();
          const converter = new ClaudeToOpenAIChatEventTransform({ model: requestBody?.model });
          const serializer = new SSESerializerTransform();

          responseHeadersForLog = this.normalizeResponseHeaders(responseHeaders);

          // 监听事件收集器的完成事件，确保所有chunks都被收集
          const finalizeChunks = () => {
            const usage = converter.getUsage();
            if (usage) {
              usageForLog = extractTokenUsageFromOpenAIUsage(usage);
            } else {
              // 尝试从event collector中提取usage
              const extractedUsage = eventCollector.extractUsage();
              if (extractedUsage) {
                usageForLog = this.extractTokenUsage(extractedUsage);
              }
            }
            streamChunksForLog = eventCollector.getChunks();
            // 将所有 chunks 合并成完整的响应体用于日志记录
            responseBodyForLog = streamChunksForLog.join('\n');
            console.log('[Proxy] Codex stream request finished, collected chunks:', streamChunksForLog?.length || 0);
            console.log('[Proxy] Response body length:', responseBodyForLog?.length || 0);
            void finalizeLog(res.statusCode);
          };

          // 在pipeline完成且eventCollector flush后执行
          eventCollector.on('finish', () => {
            console.log('[Proxy] EventCollector finished (codex), collecting chunks...');
            finalizeChunks();
          });

          // 备用：如果eventCollector的finish没有触发，监听res的finish
          res.on('finish', () => {
            console.log('[Proxy] Response finished (codex)');
            if (!streamChunksForLog) {
              console.log('[Proxy] Chunks not collected yet, forcing collection...');
              finalizeChunks();
            }
          });

          // 监听 res 的错误事件
          res.on('error', (err) => {
            console.error('[Proxy] Response stream error:', err);
          });

          pipeline(response.data, parser, eventCollector, converter, serializer, res, async (error) => {
            if (error) {
              console.error('[Proxy] Pipeline error for codex:', error);

              // 记录到错误日志 - 包含请求详情和实际转发信息
              try {
                // 获取供应商信息
                const vendors = this.dbManager.getVendors();
                const vendor = vendors.find(v => v.id === service.vendorId);

                await this.dbManager.addErrorLog({
                  timestamp: Date.now(),
                  method: req.method,
                  path: req.path,
                  statusCode: 500,
                  errorMessage: error.message || 'Stream processing error',
                  errorStack: error.stack,
                  requestHeaders: this.normalizeHeaders(req.headers),
                  requestBody: req.body ? JSON.stringify(req.body) : undefined,
                  upstreamRequest: upstreamRequestForLog,
                  // 添加请求详情
                  ruleId: rule.id,
                  targetType,
                  targetServiceId: service.id,
                  targetServiceName: service.name,
                  targetModel: rule.targetModel || req.body?.model,
                  vendorId: service.vendorId,
                  vendorName: vendor?.name,
                  requestModel: req.body?.model,
                  responseTime: Date.now() - startTime,
                });
              } catch (logError) {
                console.error('[Proxy] Failed to log error:', logError);
              }

              // 尝试向客户端发送错误事件
              try {
                if (!res.writableEnded) {
                  const errorEvent = `data: ${JSON.stringify({
                    error: 'Stream processing error occurred'
                  })}\n\n`;
                  res.write(errorEvent);
                  res.end();
                }
              } catch (writeError) {
                console.error('[Proxy] Failed to send error event:', writeError);
              }

              await finalizeLog(500, error.message);
            }
          });
          return;
        }

        // Gemini / Gemini Chat -> Claude Code 流式转换
        if (targetType === 'claude-code' && (this.isGeminiSource(sourceType) || this.isGeminiChatSource(sourceType))) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');

          const parser = new SSEParserTransform();
          const eventCollector = new SSEEventCollectorTransform();
          const converter = new GeminiToClaudeEventTransform({ model: requestBody?.model });
          const serializer = new SSESerializerTransform();

          responseHeadersForLog = this.normalizeResponseHeaders(responseHeaders);

          const finalizeChunks = () => {
            const usage = converter.getUsage();
            if (usage) {
              usageForLog = {
                inputTokens: usage.input_tokens,
                outputTokens: usage.output_tokens,
                cacheReadInputTokens: usage.cache_read_input_tokens,
              };
            } else {
              const extractedUsage = eventCollector.extractUsage();
              if (extractedUsage) {
                usageForLog = this.extractTokenUsage(extractedUsage);
              }
            }
            streamChunksForLog = eventCollector.getChunks();
            responseBodyForLog = streamChunksForLog.join('\n');
            console.log('[Proxy] Gemini stream request finished (claude-code), collected chunks:', streamChunksForLog?.length || 0);
            void finalizeLog(res.statusCode);
          };

          eventCollector.on('finish', () => {
            console.log('[Proxy] EventCollector finished (gemini->claude-code), collecting chunks...');
            finalizeChunks();
          });

          res.on('finish', () => {
            console.log('[Proxy] Response finished (gemini->claude-code)');
            if (!streamChunksForLog) {
              console.log('[Proxy] Chunks not collected yet, forcing collection...');
              finalizeChunks();
            }
          });

          res.on('error', (err) => {
            console.error('[Proxy] Response stream error:', err);
          });

          pipeline(response.data, parser, eventCollector, converter, serializer, res, async (error) => {
            if (error) {
              console.error('[Proxy] Pipeline error for gemini->claude-code:', error);

              try {
                const vendors = this.dbManager.getVendors();
                const vendor = vendors.find(v => v.id === service.vendorId);

                await this.dbManager.addErrorLog({
                  timestamp: Date.now(),
                  method: req.method,
                  path: req.path,
                  statusCode: 500,
                  errorMessage: error.message || 'Stream processing error',
                  errorStack: error.stack,
                  requestHeaders: this.normalizeHeaders(req.headers),
                  requestBody: req.body ? JSON.stringify(req.body) : undefined,
                  upstreamRequest: upstreamRequestForLog,
                  ruleId: rule.id,
                  targetType,
                  targetServiceId: service.id,
                  targetServiceName: service.name,
                  targetModel: rule.targetModel || req.body?.model,
                  vendorId: service.vendorId,
                  vendorName: vendor?.name,
                  requestModel: req.body?.model,
                  responseTime: Date.now() - startTime,
                });
              } catch (logError) {
                console.error('[Proxy] Failed to log error:', logError);
              }

              try {
                if (!res.writableEnded) {
                  const errorEvent = `event: error\ndata: ${JSON.stringify({
                    type: 'error',
                    error: {
                      type: 'api_error',
                      message: 'Stream processing error occurred'
                    }
                  })}\n\n`;
                  res.write(errorEvent);
                  res.end();
                }
              } catch (writeError) {
                console.error('[Proxy] Failed to send error event:', writeError);
              }

              await finalizeLog(500, error.message);
            }
          });
          return;
        }

        // Gemini / Gemini Chat -> Codex 流式转换
        if (targetType === 'codex' && (this.isGeminiSource(sourceType) || this.isGeminiChatSource(sourceType))) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');

          const parser = new SSEParserTransform();
          const eventCollector = new SSEEventCollectorTransform();
          const converter = new GeminiToOpenAIChatEventTransform({ model: requestBody?.model });
          const serializer = new SSESerializerTransform();

          responseHeadersForLog = this.normalizeResponseHeaders(responseHeaders);

          const finalizeChunks = () => {
            const usage = converter.getUsage();
            if (usage) {
              usageForLog = {
                inputTokens: usage.prompt_tokens,
                outputTokens: usage.completion_tokens,
                totalTokens: usage.total_tokens,
              };
            } else {
              const extractedUsage = eventCollector.extractUsage();
              if (extractedUsage) {
                usageForLog = this.extractTokenUsage(extractedUsage);
              }
            }
            streamChunksForLog = eventCollector.getChunks();
            responseBodyForLog = streamChunksForLog.join('\n');
            console.log('[Proxy] Gemini stream request finished (codex), collected chunks:', streamChunksForLog?.length || 0);
            void finalizeLog(res.statusCode);
          };

          eventCollector.on('finish', () => {
            console.log('[Proxy] EventCollector finished (gemini->codex), collecting chunks...');
            finalizeChunks();
          });

          res.on('finish', () => {
            console.log('[Proxy] Response finished (gemini->codex)');
            if (!streamChunksForLog) {
              console.log('[Proxy] Chunks not collected yet, forcing collection...');
              finalizeChunks();
            }
          });

          res.on('error', (err) => {
            console.error('[Proxy] Response stream error:', err);
          });

          pipeline(response.data, parser, eventCollector, converter, serializer, res, async (error) => {
            if (error) {
              console.error('[Proxy] Pipeline error for gemini->codex:', error);

              try {
                const vendors = this.dbManager.getVendors();
                const vendor = vendors.find(v => v.id === service.vendorId);

                await this.dbManager.addErrorLog({
                  timestamp: Date.now(),
                  method: req.method,
                  path: req.path,
                  statusCode: 500,
                  errorMessage: error.message || 'Stream processing error',
                  errorStack: error.stack,
                  requestHeaders: this.normalizeHeaders(req.headers),
                  requestBody: req.body ? JSON.stringify(req.body) : undefined,
                  upstreamRequest: upstreamRequestForLog,
                  ruleId: rule.id,
                  targetType,
                  targetServiceId: service.id,
                  targetServiceName: service.name,
                  targetModel: rule.targetModel || req.body?.model,
                  vendorId: service.vendorId,
                  vendorName: vendor?.name,
                  requestModel: req.body?.model,
                  responseTime: Date.now() - startTime,
                });
              } catch (logError) {
                console.error('[Proxy] Failed to log error:', logError);
              }

              try {
                if (!res.writableEnded) {
                  const errorEvent = `data: ${JSON.stringify({
                    error: 'Stream processing error occurred'
                  })}\n\n`;
                  res.write(errorEvent);
                  res.end();
                }
              } catch (writeError) {
                console.error('[Proxy] Failed to send error event:', writeError);
              }

              await finalizeLog(500, error.message);
            }
          });
          return;
        }

        // 默认stream处理(无转换)
        const parser = new SSEParserTransform();
        const eventCollector = new SSEEventCollectorTransform();
        const serializer = new SSESerializerTransform();
        responseHeadersForLog = this.normalizeResponseHeaders(responseHeaders);

        this.copyResponseHeaders(responseHeaders, res);

        // 监听事件收集器的完成事件，确保所有chunks都被收集
        const finalizeChunks = () => {
          streamChunksForLog = eventCollector.getChunks();
          // 将所有 chunks 合并成完整的响应体用于日志记录
          responseBodyForLog = streamChunksForLog.join('\n');
          // 尝试从event collector中提取usage信息
          const extractedUsage = eventCollector.extractUsage();
          if (extractedUsage) {
            usageForLog = this.extractTokenUsage(extractedUsage);
          }
          console.log('[Proxy] Default stream request finished, collected chunks:', streamChunksForLog?.length || 0);
          console.log('[Proxy] Response body length:', responseBodyForLog?.length || 0);
          void finalizeLog(res.statusCode);
        };

        // 在pipeline完成且eventCollector flush后执行
        eventCollector.on('finish', () => {
          console.log('[Proxy] EventCollector finished (default stream), collecting chunks...');
          finalizeChunks();
        });

        // 备用：如果eventCollector的finish没有触发，监听res的finish
        res.on('finish', () => {
          console.log('[Proxy] Response finished (default stream)');
          if (!streamChunksForLog) {
            console.log('[Proxy] Chunks not collected yet, forcing collection...');
            finalizeChunks();
          }
        });

        // 监听 res 的错误事件
        res.on('error', (err) => {
          console.error('[Proxy] Response stream error:', err);
        });

        pipeline(response.data, parser, eventCollector, serializer, res, async (error) => {
          if (error) {
            console.error('[Proxy] Pipeline error (default stream):', error);

            // 记录到错误日志
            try {
              await this.dbManager.addErrorLog({
                timestamp: Date.now(),
                method: req.method,
                path: req.path,
                statusCode: 500,
                errorMessage: error.message || 'Stream processing error',
                errorStack: error.stack,
                requestHeaders: this.normalizeHeaders(req.headers),
                requestBody: req.body ? JSON.stringify(req.body) : undefined,
                upstreamRequest: upstreamRequestForLog,
              });
            } catch (logError) {
              console.error('[Proxy] Failed to log error:', logError);
            }

            await finalizeLog(500, error.message);
          }
        });
        return;
      }

      let responseData = response.data;
      if (streamRequested && response.data && typeof response.data.on === 'function' && !isEventStream) {
        const raw = await this.readStreamBody(response.data);
        responseData = this.safeJsonParse(raw) ?? raw;
      }

      // 收集响应头
      responseHeadersForLog = this.normalizeResponseHeaders(responseHeaders);

      if (targetType === 'claude-code' && this.isOpenAIChatSource(sourceType)) {
        const converted = transformOpenAIChatResponseToClaude(responseData);
        usageForLog = extractTokenUsageFromOpenAIUsage(responseData?.usage);
        // 记录转换后的响应体
        responseBodyForLog = JSON.stringify(converted);
        res.status(response.status).json(converted);
      } else if (targetType === 'claude-code' && (this.isGeminiSource(sourceType) || this.isGeminiChatSource(sourceType))) {
        const converted = transformGeminiResponseToClaude(responseData, rule.targetModel);
        usageForLog = extractTokenUsageFromGeminiUsage(responseData?.usageMetadata);
        responseBodyForLog = JSON.stringify(converted);
        res.status(response.status).json(converted);
      } else if (targetType === 'codex' && this.isClaudeSource(sourceType)) {
        const converted = transformClaudeResponseToOpenAIChat(responseData);
        usageForLog = extractTokenUsageFromClaudeUsage(responseData?.usage);
        responseBodyForLog = JSON.stringify(converted);
        res.status(response.status).json(converted);
      } else if (targetType === 'codex' && (this.isGeminiSource(sourceType) || this.isGeminiChatSource(sourceType))) {
        const converted = transformGeminiResponseToOpenAIChat(responseData, rule.targetModel);
        usageForLog = extractTokenUsageFromGeminiUsage(responseData?.usageMetadata);
        responseBodyForLog = JSON.stringify(converted);
        res.status(response.status).json(converted);
      } else {
        usageForLog = this.extractTokenUsage(responseData?.usage);
        // 记录原始响应体
        responseBodyForLog = typeof responseData === 'string' ? responseData : JSON.stringify(responseData);
        console.log('[Proxy] Non-stream response logged, body length:', responseBodyForLog?.length || 0);
        this.copyResponseHeaders(responseHeaders, res);
        if (contentType.includes('application/json')) {
          res.status(response.status).json(responseData);
        } else {
          res.status(response.status).send(responseData);
        }
      }

      await finalizeLog(res.statusCode);
    } catch (error: any) {
      if (failoverEnabled && (error as FailoverProxyError)?.isFailoverCandidate) {
        throw error;
      }

      console.error('Proxy error:', error);

      // 检测是否是 timeout 错误
      const isTimeout = error.code === 'ECONNABORTED' ||
                        error.message?.toLowerCase().includes('timeout') ||
                        (error.errno && error.errno === 'ETIMEDOUT');

      const baseErrorMessage = isTimeout
        ? 'Request timeout - the upstream API took too long to respond'
        : (error.message || 'Internal server error');
      const failoverHint = failoverEnabled ? this.buildFailoverHint(forwardedToServiceName) : '';
      const errorMessage = `${baseErrorMessage}${failoverHint}`;

      // 将错误记录到错误日志 - 包含请求详情和实际转发信息
      // 获取供应商信息
      const vendors = this.dbManager.getVendors();
      const vendor = vendors.find(v => v.id === service.vendorId);

      await this.dbManager.addErrorLog({
        timestamp: Date.now(),
        method: req.method,
        path: req.path,
        statusCode: isTimeout ? 504 : 500,
        errorMessage: errorMessage,
        errorStack: error.stack,
        requestHeaders: this.normalizeHeaders(req.headers),
        requestBody: req.body ? JSON.stringify(req.body) : undefined,
        // 添加请求详情和实际转发信息
        ruleId: rule.id,
        targetType,
        targetServiceId: service.id,
        targetServiceName: service.name,
        targetModel: rule.targetModel || req.body?.model,
        vendorId: service.vendorId,
        vendorName: vendor?.name,
        requestModel: req.body?.model,
        upstreamRequest: upstreamRequestForLog,
        responseTime: Date.now() - startTime,
      });

      await finalizeLog(isTimeout ? 504 : 500, errorMessage);

      if (failoverEnabled) {
        throw this.createFailoverError(errorMessage, isTimeout ? 504 : 500, error);
      }

      // 根据请求类型返回适当格式的错误响应
      const streamRequested = this.isStreamRequested(req, req.body || {});

      if (route.targetType === 'claude-code') {
        // 对于 Claude Code，返回符合 Claude API 标准的错误响应
        const claudeError = {
          type: 'error',
          error: {
            type: isTimeout ? 'api_error' : 'api_error',
            message: errorMessage
          }
        };

        if (streamRequested) {
          // 流式请求：使用 SSE 格式
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.status(200);

          // 发送错误事件（使用 Claude API 的标准格式）
          const errorEvent = `event: error\ndata: ${JSON.stringify(claudeError)}\n\n`;
          res.write(errorEvent);
          res.end();
        } else {
          // 非流式请求：返回 JSON 格式
          res.status(500).json(claudeError);
        }
      } else {
        // 对于 Codex，返回 JSON 格式的错误响应
        res.status(500).json({ error: errorMessage });
      }
    }
  }

  async reloadRoutes() {
    // 注意：所有配置（路由、规则、服务）现在都在每次请求时实时从数据库读取
    // 这个方法主要用于初始化和日志记录
    // 修改数据库后无需调用此方法，配置会自动生效

    const allRoutes = this.dbManager.getRoutes();
    const activeRoutes = allRoutes.filter((g) => g.isActive);
    const allServices = this.dbManager.getAPIServices();

    // 保留缓存以备将来可能的性能优化需求
    this.routes! = activeRoutes;
    if (this.rules) {
      this.rules.clear();
      for (const route of activeRoutes) {
        const routeRules = this.dbManager.getRules(route.id);
        const sortedRules = [...routeRules].sort((a, b) => (b.sortOrder || 0) - (a.sortOrder || 0));
        this.rules.set(route.id, sortedRules);
      }
    }
    if (this.services) {
      const services = this.services;
      services.clear();
      allServices.forEach((service) => {
        services.set(service.id, service);
      });
    }

    console.log(`Initialized with ${activeRoutes.length} active routes and ${allServices.length} services (all config read from database in real-time)`);
  }

  async updateConfig(config: AppConfig) {
    this.config = config;
  }

  async registerProxyRoutes() {
    this.addProxyRoutes();
    await this.reloadRoutes();
  }
}
