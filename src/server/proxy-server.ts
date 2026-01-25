import express, { Request, Response, NextFunction } from 'express';
import axios, { AxiosRequestConfig } from 'axios';
import { pipeline } from 'stream';
import { DatabaseManager } from './database';
import {
  ClaudeToOpenAIChatEventTransform,
  OpenAIToClaudeEventTransform,
  SSEParserTransform,
  SSESerializerTransform,
} from './transformers/streaming';
import { SSEEventCollectorTransform } from './transformers/chunk-collector';
import {
  extractTokenUsageFromClaudeUsage,
  extractTokenUsageFromOpenAIUsage,
  transformClaudeRequestToOpenAIChat,
  transformClaudeResponseToOpenAIChat,
  transformOpenAIChatResponseToClaude,
} from './transformers/claude-openai';
import type { AppConfig, Rule, APIService, Route, SourceType, TargetType, TokenUsage, ContentType, RequestLog } from '../types';

type ContentTypeDetector = {
  type: ContentType;
  match: (req: Request, body: any) => boolean;
};

const SUPPORTED_TARGETS = ['claude-code', 'codex'];

// 需要排除的路径模式（非业务请求）
const IGNORED_PATHS = [
  '/favicon.ico',
  '/robots.txt',
  '/sitemap.xml',
];

/**
 * 检查路径是否应该被忽略
 */
function shouldIgnorePath(path: string): boolean {
  return IGNORED_PATHS.some(ignored => path === ignored || path.startsWith(ignored + '?'));
}

export class ProxyServer {
  private app: express.Application;
  private dbManager: DatabaseManager;
  // 以下字段用于缓存备份（将来可能用于性能优化）
  // 实际使用时，所有配置都从数据库实时读取
  private routes?: Route[] = [];
  private rules?: Map<string, Rule[]> = new Map();
  private services?: Map<string, APIService> = new Map();
  private config: AppConfig;

  constructor(dbManager: DatabaseManager, app: express.Application) {
    this.dbManager = dbManager;
    this.config = dbManager.getConfig();
    this.app = app;
  }

  private setupMiddleware() {
    // Access logging middleware
    this.app.use(async (req: Request, res: Response, next: NextFunction) => {
      // 忽略非业务请求
      if (shouldIgnorePath(req.path)) {
        return next();
      }

      // Capture client info
      const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0] || req.socket.remoteAddress || '';
      const userAgent = req.headers['user-agent'] || '';

      const startTime = Date.now();
      const originalSend = res.send.bind(res);
      const originalJson = res.json.bind(res);

      const accessLog = this.dbManager.addAccessLog({
        timestamp: Date.now(),
        method: req.method,
        path: req.path,
        clientIp,
        userAgent,
      });

      const updateLog = (res: Response | Error, data?: any) => {
        const responseTime = Date.now() - startTime;
        accessLog.then((accessLogId) => {
          const updateData: any = {
            responseTime,
          };
          let errorMessage: string = '';
          if (res instanceof Error) {
            updateData.error = res.message;
            errorMessage = res.message;
          }
          else if (res.statusCode >= 400) {
            updateData.statusCode = res.statusCode;
            updateData.error = res.statusMessage;
            // @ts-ignore
            updateData.responseHeaders = this.normalizeResponseHeaders(res.headers || {});
            errorMessage = res.statusMessage;
          }
          else {
            updateData.statusCode = res.statusCode;
            // @ts-ignore
            updateData.responseHeaders = this.normalizeResponseHeaders(res.headers || {});
            updateData.responseBody = data ? JSON.stringify(data) : undefined;
          }
          this.dbManager.updateAccessLog(accessLogId, updateData);
          // 记录错误日志
          if (res instanceof Error || res.statusCode >= 400) {
            this.dbManager.addErrorLog({
              timestamp: Date.now(),
              method: req.method,
              path: req.path,
              statusCode: 503,
              errorMessage,
              requestHeaders: this.normalizeHeaders(req.headers),
              requestBody: req.body ? JSON.stringify(req.body) : undefined,
              responseBody: data ? JSON.stringify(data) : undefined,
              // @ts-ignore
              responseHeaders: res.headers ? this.normalizeResponseHeaders(res.headers) : undefined,
              responseTime,
            });
          }
        });
      };

      res.send = (data: any) => {
        res.send = originalSend;
        updateLog(res, data);
        return originalSend(data);
      };

      res.json = (data: any) => {
        res.json = originalJson;
        updateLog(res, data);
        return originalJson(data);
      };

      res.on('error', (err) => {
        updateLog(err);
      });

      next();
    });

    // Logging middleware (legacy RequestLog)
    this.app.use(async (req: Request, res: Response, next: NextFunction) => {
      const startTime = Date.now();
      const originalSend = res.send.bind(res);

      // 忽略非业务请求，并且只记录支持的编程工具请求
      if (!shouldIgnorePath(req.path) && SUPPORTED_TARGETS.some(target => req.path.startsWith(`/${target}/`))) {
        res.send = (data: any) => {
          res.send = originalSend;
          if (!res.locals.skipLog && this.config?.enableLogging && SUPPORTED_TARGETS.some(target => req.path.startsWith(`/${target}/`))) {
            const responseTime = Date.now() - startTime;
            this.dbManager.addLog({
              timestamp: Date.now(),
              method: req.method,
              path: req.path,
              headers: this.normalizeHeaders(req.headers),
              body: req.body ? JSON.stringify(req.body) : undefined,
              statusCode: res.statusCode,
              responseTime,
            });
          }

          return res.send(data);
        };
      }

      next();
    });

    // Fixed route handlers
    this.app.use('/claude-code/', this.createFixedRouteHandler('claude-code'));
    this.app.use('/claude-code', this.createFixedRouteHandler('claude-code'));
    this.app.use('/codex/', this.createFixedRouteHandler('codex'));
    this.app.use('/codex', this.createFixedRouteHandler('codex'));

    // Dynamic proxy middleware
    this.app.use(async (req: Request, res: Response, next: NextFunction) => {
      // 根路径 / 不应该被代理中间件处理,应该传递给静态文件服务
      if (req.path === '/') {
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

        for (const rule of allRules) {
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
            // 尝试代理请求
            await this.proxyRequest(req, res, route, rule, service);
            return; // 成功,直接返回
          } catch (error: any) {
            console.error(`Service ${service.name} failed:`, error.message);
            lastError = error;

            // 判断是否应该加入黑名单 (4xx + 5xx)
            const statusCode = error.response?.status || 500;
            if (statusCode >= 400) {
              await this.dbManager.addToBlacklist(
                service.id,
                route.id,
                rule.contentType,
                error.message,
                statusCode
              );
              console.log(
                `Service ${service.name} added to blacklist (${route.id}:${rule.contentType}:${service.id})`
              );
            }

            // 继续尝试下一个服务
            continue;
          }
        }

        // 所有服务都失败了
        console.error('All services failed');

        // 记录日志
        if (this.config?.enableLogging && SUPPORTED_TARGETS.some(target => req.path.startsWith(`/${target}/`))) {
          await this.dbManager.addLog({
            timestamp: Date.now(),
            method: req.method,
            path: req.path,
            headers: this.normalizeHeaders(req.headers),
            body: req.body ? JSON.stringify(req.body) : undefined,
            error: lastError?.message || 'All services failed',
          });
        }

        // 记录错误日志
        await this.dbManager.addErrorLog({
          timestamp: Date.now(),
          method: req.method,
          path: req.path,
          statusCode: 503,
          errorMessage: 'All services failed',
          errorStack: lastError?.stack,
          requestHeaders: this.normalizeHeaders(req.headers),
          requestBody: req.body ? JSON.stringify(req.body) : undefined,
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
        if (this.config?.enableLogging && SUPPORTED_TARGETS.some(target => req.path.startsWith(`/${target}/`))) {
          await this.dbManager.addLog({
            timestamp: Date.now(),
            method: req.method,
            path: req.path,
            headers: this.normalizeHeaders(req.headers),
            body: req.body ? JSON.stringify(req.body) : undefined,
            error: error.message,
          });
        }
        // Add error log
        await this.dbManager.addErrorLog({
          timestamp: Date.now(),
          method: req.method,
          path: req.path,
          statusCode: 500,
          errorMessage: error.message,
          errorStack: error.stack,
          requestHeaders: this.normalizeHeaders(req.headers),
          requestBody: req.body ? JSON.stringify(req.body) : undefined,
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

        for (const rule of allRules) {
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
            // 尝试代理请求
            await this.proxyRequest(req, res, route, rule, service);
            return; // 成功,直接返回
          } catch (error: any) {
            console.error(`Service ${service.name} failed:`, error.message);
            lastError = error;

            // 判断是否应该加入黑名单 (4xx + 5xx)
            const statusCode = error.response?.status || 500;
            if (statusCode >= 400) {
              await this.dbManager.addToBlacklist(
                service.id,
                route.id,
                rule.contentType,
                error.message,
                statusCode
              );
              console.log(
                `Service ${service.name} added to blacklist (${route.id}:${rule.contentType}:${service.id})`
              );
            }

            // 继续尝试下一个服务
            continue;
          }
        }

        // 所有服务都失败了
        console.error('All services failed');

        // 记录日志
        if (this.config?.enableLogging && SUPPORTED_TARGETS.some(target => req.path.startsWith(`/${target}/`))) {
          await this.dbManager.addLog({
            timestamp: Date.now(),
            method: req.method,
            path: req.path,
            headers: this.normalizeHeaders(req.headers),
            body: req.body ? JSON.stringify(req.body) : undefined,
            error: lastError?.message || 'All services failed',
          });
        }

        // 记录错误日志
        await this.dbManager.addErrorLog({
          timestamp: Date.now(),
          method: req.method,
          path: req.path,
          statusCode: 503,
          errorMessage: 'All services failed',
          errorStack: lastError?.stack,
          requestHeaders: this.normalizeHeaders(req.headers),
          requestBody: req.body ? JSON.stringify(req.body) : undefined,
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
        if (this.config?.enableLogging && SUPPORTED_TARGETS.some(target => req.path.startsWith(`/${target}/`))) {
          await this.dbManager.addLog({
            timestamp: Date.now(),
            method: req.method,
            path: req.path,
            headers: this.normalizeHeaders(req.headers),
            body: req.body ? JSON.stringify(req.body) : undefined,
            error: error.message,
          });
        }
        // Add error log
        await this.dbManager.addErrorLog({
          timestamp: Date.now(),
          method: req.method,
          path: req.path,
          statusCode: 500,
          errorMessage: error.message,
          errorStack: error.stack,
          requestHeaders: this.normalizeHeaders(req.headers),
          requestBody: req.body ? JSON.stringify(req.body) : undefined,
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

  private findMatchingRoute(_req: Request): Route | undefined {
    // Find active route based on targetType - for now, return the first active route
    // This can be extended later based on specific routing logic
    const activeRoutes = this.getActiveRoutes();
    return activeRoutes.find(route => route.isActive);
  }

  private findRouteByTargetType(targetType: 'claude-code' | 'codex'): Route | undefined {
    const activeRoutes = this.getActiveRoutes();
    return activeRoutes.find(route => route.targetType === targetType && route.isActive);
  }

  /**
   * 根据GLM计费逻辑判断请求是否应该计费
   * 核心规则：
   * 1. 最后一条消息必须是 role: "user"
   * 2. 上一条消息不能是包含 tool_calls 的 assistant 消息（即不是工具回传）
   */
  private shouldChargeRequest(requestBody: any): boolean {
    const messages = requestBody?.messages;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return false;
    }

    const lastMessage = messages[messages.length - 1];
    if (lastMessage.role !== 'user') {
      return false;
    }

    if (messages.length > 1) {
      const previousMessage = messages[messages.length - 2];
      if (previousMessage.role === 'assistant' && previousMessage.tool_calls) {
        return false;
      }
    }

    return true;
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

        // 检查token限制
        if (rule.tokenLimit && rule.totalTokensUsed !== undefined && rule.totalTokensUsed >= rule.tokenLimit) {
          continue; // 跳过超限规则
        }

        // 检查请求次数限制
        if (rule.requestCountLimit && rule.totalRequestsUsed !== undefined && rule.totalRequestsUsed >= rule.requestCountLimit) {
          continue; // 跳过超限规则
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

      // 检查token限制
      if (rule.tokenLimit && rule.totalTokensUsed !== undefined && rule.totalTokensUsed >= rule.tokenLimit) {
        continue; // 跳过超限规则
      }

      // 检查请求次数限制
      if (rule.requestCountLimit && rule.totalRequestsUsed !== undefined && rule.totalRequestsUsed >= rule.requestCountLimit) {
        continue; // 跳过超限规则
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

      // 检查token限制
      if (rule.tokenLimit && rule.totalTokensUsed !== undefined && rule.totalTokensUsed >= rule.tokenLimit) {
        continue; // 跳过超限规则
      }

      // 检查请求次数限制
      if (rule.requestCountLimit && rule.totalRequestsUsed !== undefined && rule.totalRequestsUsed >= rule.requestCountLimit) {
        continue; // 跳过超限规则
      }

      return rule;
    }

    return undefined;
  }

  private getAllMatchingRules(routeId: string, req: Request): Rule[] {
    const rules = this.getRulesByRouteId(routeId);
    if (!rules || rules.length === 0) return [];

    const body = req.body;
    const requestModel = body?.model;
    const candidates: Rule[] = [];

    // 1. Model mapping rules
    if (requestModel) {
      const modelMappingRules = rules.filter(rule =>
        rule.contentType === 'model-mapping' &&
        rule.replacedModel &&
        requestModel.includes(rule.replacedModel)
      );
      candidates.push(...modelMappingRules);
    }

    // 2. Content type specific rules
    const contentType = this.determineContentType(req);
    const contentTypeRules = rules.filter(rule => rule.contentType === contentType);
    candidates.push(...contentTypeRules);

    // 3. Default rules
    const defaultRules = rules.filter(rule => rule.contentType === 'default');
    candidates.push(...defaultRules);

    // 4. 检查并重置到期的规则
    candidates.forEach(rule => {
      this.dbManager.checkAndResetRuleIfNeeded(rule.id);
      this.dbManager.checkAndResetRequestCountIfNeeded(rule.id);
    });

    // 5. 过滤掉超过限制的规则（仅在有多个候选规则时）
    if (candidates.length > 1) {
      const filteredCandidates = candidates.filter(rule => {
        // 检查token限制
        if (rule.tokenLimit && rule.totalTokensUsed !== undefined) {
          if (rule.totalTokensUsed >= rule.tokenLimit) {
            return false;
          }
        }
        // 检查请求次数限制
        if (rule.requestCountLimit && rule.totalRequestsUsed !== undefined) {
          if (rule.totalRequestsUsed >= rule.requestCountLimit) {
            return false;
          }
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

  private determineContentType(req: Request): ContentType {
    const body = req.body;
    if (!body) return 'default';

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

  private hasBackgroundSignal(body: any): boolean {
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

  private isClaudeSource(sourceType: SourceType) {
    return sourceType === 'claude-chat';
  }

  private isOpenAIChatSource(sourceType: SourceType) {
    return sourceType === 'openai-chat' || sourceType === 'deepseek-chat';
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
      console.log(`[Proxy] Limiting ${maxTokensFieldName} from ${requestedMaxTokens} to ${maxOutputLimit} for model ${model} in service ${service.name}`);
      result[maxTokensFieldName] = maxOutputLimit;

      // 如果使用了 max_completion_tokens，清理旧的 max_tokens 字段
      if (maxTokensFieldName === 'max_completion_tokens' && result.max_tokens !== undefined) {
        delete result.max_tokens;
      }
    } else if (requestedMaxTokens === undefined) {
      // 如果请求中没有指定 max_tokens，则使用配置的最大值
      console.log(`[Proxy] Setting ${maxTokensFieldName} to ${maxOutputLimit} for model ${model} in service ${service.name}`);
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

  private buildUpstreamHeaders(req: Request, service: APIService, sourceType: SourceType, streamRequested: boolean) {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (['host', 'connection', 'content-length', 'authorization'].includes(key.toLowerCase())) {
        continue;
      }
      if (typeof value === 'string') {
        headers[key] = value;
      } else if (Array.isArray(value)) {
        headers[key] = value.join(', ');
      }
    }

    if (streamRequested) {
      headers.accept = 'text/event-stream';
    }

    if (this.isClaudeSource(sourceType)) {
      headers['x-api-key'] = service.apiKey;
      headers['anthropic-version'] = headers['anthropic-version'] || '2023-06-01';
    } else {
      delete headers['anthropic-version'];
      delete headers['anthropic-beta'];
      headers.authorization = `Bearer ${service.apiKey}`;
    }

    if (!headers['content-type']) {
      headers['content-type'] = 'application/json';
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

  private normalizeHeaders(headers: Request['headers']) {
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === 'string') {
        normalized[key] = value;
      } else if (Array.isArray(value)) {
        normalized[key] = value.join(', ');
      }
    }
    return normalized;
  }

  private normalizeResponseHeaders(headers: Record<string, any>): Record<string, string> {
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (value !== null && value !== undefined) {
        if (typeof value === 'string') {
          normalized[key] = value;
        } else if (Array.isArray(value)) {
          normalized[key] = value.join(', ');
        } else {
          normalized[key] = String(value);
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

  private async proxyRequest(req: Request, res: Response, route: Route, rule: Rule, service: APIService) {
    res.locals.skipLog = true;
    const startTime = Date.now();
    const sourceType = (service.sourceType || 'openai-chat') as SourceType;
    const targetType = route.targetType;
    let requestBody: any = req.body || {};
    let usageForLog: TokenUsage | undefined;
    let logged = false;

    // 用于收集响应数据的变量
    let responseHeadersForLog: Record<string, string> | undefined;
    let responseBodyForLog: string | undefined;
    let streamChunksForLog: string[] | undefined;
    let upstreamRequestForLog: RequestLog['upstreamRequest'] | undefined;
    let actuallyUsedProxy = false; // 标记是否实际使用了代理

    const finalizeLog = async (statusCode: number, error?: string) => {
      if (logged || !this.config?.enableLogging) return;

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
        body: req.body ? JSON.stringify(req.body) : undefined,
        statusCode,
        responseTime: Date.now() - startTime,
        targetProvider: service.name,
        usage: usageForLog,
        error,

        // 新增字段
        ruleId: rule.id,
        targetType,
        targetServiceId: service.id,
        targetServiceName: service.name,
        targetModel: rule.targetModel,
        vendorId: service.vendorId,
        vendorName: vendor?.name,
        requestModel,
        responseHeaders: responseHeadersForLog,
        responseBody: responseBodyForLog,
        streamChunks: streamChunksForLog,
        upstreamRequest: upstreamRequestForLog,
      });

      // 更新规则的token使用量（只在成功请求时更新）
      if (usageForLog && statusCode < 400) {
        const totalTokens = (usageForLog.inputTokens || 0) + (usageForLog.outputTokens || 0);
        if (totalTokens > 0) {
          this.dbManager.incrementRuleTokenUsage(rule.id, totalTokens);
        }
      }

      // 更新规则的请求次数（只在成功请求时更新）
      if (statusCode < 400 && this.shouldChargeRequest(req.body)) {
        this.dbManager.incrementRuleRequestCount(rule.id, 1);
      }
    };

    try {
      if (targetType === 'claude-code') {
        if (this.isClaudeSource(sourceType)) {
          requestBody = this.applyModelOverride(requestBody, rule);
        } else if (this.isOpenAIChatSource(sourceType)) {
          requestBody = transformClaudeRequestToOpenAIChat(requestBody, rule.targetModel);
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

      const config: AxiosRequestConfig = {
        method: req.method as any,
        url: `${service.apiUrl}${mappedPath}`,
        headers: this.buildUpstreamHeaders(req, service, sourceType, streamRequested),
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
      const actualModel = requestBody?.model || '';
      const maxTokensFieldName = this.getMaxTokensFieldName(actualModel);
      const actualMaxTokens = requestBody?.[maxTokensFieldName] || requestBody?.max_tokens;

      upstreamRequestForLog = {
        url: `${service.apiUrl}${mappedPath}`,
        model: actualModel,
        [maxTokensFieldName]: actualMaxTokens,
      };
      if (actuallyUsedProxy) {
        upstreamRequestForLog.useProxy = true;
      }

      const response = await axios(config);
      const responseHeaders = response.headers || {};
      const contentType = typeof responseHeaders['content-type'] === 'string' ? responseHeaders['content-type'] : '';
      const isEventStream = streamRequested && contentType.includes('text/event-stream');

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

          res.on('finish', () => {
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
            void finalizeLog(res.statusCode);
          });

          pipeline(response.data, parser, eventCollector, converter, serializer, res, (error) => {
            if (error) {
              void finalizeLog(500, error.message);
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

          res.on('finish', () => {
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
            void finalizeLog(res.statusCode);
          });

          pipeline(response.data, parser, eventCollector, converter, serializer, res, (error) => {
            if (error) {
              void finalizeLog(500, error.message);
            }
          });
          return;
        }

        // 默认stream处理(无转换)
        const eventCollector = new SSEEventCollectorTransform();
        responseHeadersForLog = this.normalizeResponseHeaders(responseHeaders);

        this.copyResponseHeaders(responseHeaders, res);
        res.on('finish', () => {
          streamChunksForLog = eventCollector.getChunks();
          // 尝试从event collector中提取usage信息
          const extractedUsage = eventCollector.extractUsage();
          if (extractedUsage) {
            usageForLog = this.extractTokenUsage(extractedUsage);
          }
          void finalizeLog(res.statusCode);
        });
        pipeline(response.data, eventCollector, res, (error) => {
          if (error) {
            void finalizeLog(500, error.message);
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

      if (response.status >= 400) {
        usageForLog = this.extractTokenUsage(responseData?.usage);
        // 记录错误响应体
        responseBodyForLog = typeof responseData === 'string' ? responseData : JSON.stringify(responseData);
        this.copyResponseHeaders(responseHeaders, res);
        if (contentType.includes('application/json')) {
          res.status(response.status).json(responseData);
        } else {
          res.status(response.status).send(responseData);
        }
        await finalizeLog(res.statusCode);
        return;
      }

      if (targetType === 'claude-code' && this.isOpenAIChatSource(sourceType)) {
        const converted = transformOpenAIChatResponseToClaude(responseData);
        usageForLog = extractTokenUsageFromOpenAIUsage(responseData?.usage);
        // 记录转换后的响应体
        responseBodyForLog = JSON.stringify(converted);
        res.status(response.status).json(converted);
      } else if (targetType === 'codex' && this.isClaudeSource(sourceType)) {
        const converted = transformClaudeResponseToOpenAIChat(responseData);
        usageForLog = extractTokenUsageFromClaudeUsage(responseData?.usage);
        responseBodyForLog = JSON.stringify(converted);
        res.status(response.status).json(converted);
      } else {
        usageForLog = this.extractTokenUsage(responseData?.usage);
        // 记录原始响应体
        responseBodyForLog = typeof responseData === 'string' ? responseData : JSON.stringify(responseData);
        this.copyResponseHeaders(responseHeaders, res);
        if (contentType.includes('application/json')) {
          res.status(response.status).json(responseData);
        } else {
          res.status(response.status).send(responseData);
        }
      }

      await finalizeLog(res.statusCode);
    } catch (error: any) {
      console.error('Proxy error:', error);

      // 检测是否是 timeout 错误
      const isTimeout = error.code === 'ECONNABORTED' ||
                        error.message?.toLowerCase().includes('timeout') ||
                        (error.errno && error.errno === 'ETIMEDOUT');

      const errorMessage = isTimeout
        ? 'Request timeout - the upstream API took too long to respond'
        : (error.message || 'Internal server error');

      await finalizeLog(500, errorMessage);

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

  async initialize() {
    this.setupMiddleware();
    await this.reloadRoutes();
  }
}
