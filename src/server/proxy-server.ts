import express, { Request, Response, NextFunction } from 'express';
import axios, { AxiosRequestConfig } from 'axios';
import { pipeline } from 'stream';
import type { Transform } from 'stream';
import crypto from 'crypto';
import type { FileSystemDatabaseManager } from './fs-database';
import {
  ClaudeToOpenAIChatEventTransform,
  OpenAIToClaudeEventTransform,
  ChatCompletionsToResponsesEventTransform,
  GeminiToClaudeEventTransform,
  GeminiToOpenAIChatEventTransform,
  ClaudeToResponsesEventTransform,
  GeminiToResponsesEventTransform,
  ChatCompletionsToClaudeEventTransform,
  ResponsesToClaudeEventTransform,
  SSEParserTransform,
  SSESerializerTransform,
} from './transformers/streaming';
import { ChunkCollectorTransform, SSEEventCollectorTransform } from './transformers/chunk-collector';
import { rulesStatusBroadcaster } from './rules-status-service';
import {
  // 请求转换函数，将工具发起的请求，转化为API服务接口需要的请求数据结构
  transformRequestFromClaudeToGemini,
  transformRequestFromClaudeToChatCompletions,
  transformRequestFromClaudeToResponses,
  transformRequestFromResponsesToChatCompletions,
  transformRequestFromResponsesToGemini,
  transformRequestFromResponsesToClaude,
  // 响应转换函数，将API服务接口吐出的数据，转化为工具需要的数据结构
  transformResponseFromChatCompletionsToClaude,
  transformResponseFromGeminiToClaude,
  transformResponseFromResponsesToClaude,
  transformResponseFromClaudeToResponses,
  transformResponseFromChatCompletionsToResponses,
  transformResponseFromGeminiToResponses,
  // 辅助函数
  applyPayloadOverride,
  extractTokenUsageFromGeminiUsage,
  extractTokenUsageFromOpenAIUsage,
  extractTokenUsageFromClaudeUsage,
} from './transformers/transformers';
import type { AppConfig, Rule, APIService, Route, SourceType, ToolType, TokenUsage, ContentType, RequestLog } from '../types';
import { AuthType } from '../types';
import {
  isRuleUsingMCP,
  isMCPAvailable,
  extractImagesFromMessages,
  constructMCPMessages,
  cleanupTempImages,
} from './mcp-image-handler';
import { normalizeSourceType } from './type-migration';
import { readOriginalConfig } from './original-config-reader';

type ContentTypeDetector = {
  type: ContentType;
  match: (req: Request, body: any, sessionId?: string | null, routeId?: string) => boolean;
};

const SUPPORTED_TARGETS = ['claude-code', 'codex'];

type ProxyRequestOptions = {
  failoverEnabled?: boolean;
  forwardedToServiceName?: string;
  useOriginalConfig?: boolean;  // 是否使用原始配置（fallback 模式）
};

type FailoverProxyError = Error & {
  isFailoverCandidate?: boolean;
  response?: {
    status: number;
  };
};

type HighIqInferenceResult = {
  shouldUseHighIq: boolean;
  decisionSource: 'human' | 'fallback' | 'none';
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

  private inferTargetTypeFromPath(path: string): ToolType | undefined {
    if (path === '/claude-code' || path.startsWith('/claude-code/')) {
      return 'claude-code';
    }
    if (path === '/codex' || path.startsWith('/codex/')) {
      return 'codex';
    }
    return undefined;
  }

  private buildRelayTags(relayed: boolean, useOriginalConfig: boolean = false): string[] {
    const tags = [relayed ? '通过中转' : '未通过中转'];
    if (useOriginalConfig) {
      tags.push('使用原始配置');
    }
    return tags;
  }

  private async logToolRequest(
    req: Request,
    options: {
      statusCode: number;
      error?: string;
      responseTime?: number;
      targetType?: ToolType;
      usage?: TokenUsage;
      tags?: string[];
    }
  ): Promise<void> {
    const enableLogging = this.config?.enableLogging !== false;
    const resolvedTargetType = options.targetType ||
      this.inferTargetTypeFromPath(req.path) ||
      this.inferTargetTypeFromPath(req.originalUrl || '');

    if (!enableLogging || !resolvedTargetType) {
      return;
    }

    await this.dbManager.addLog({
      timestamp: Date.now(),
      method: req.method,
      path: req.originalUrl || req.path,
      headers: this.normalizeHeaders(req.headers),
      body: req.body,
      statusCode: options.statusCode,
      responseTime: options.responseTime,
      usage: options.usage,
      error: options.error,
      targetType: resolvedTargetType,
      requestModel: req.body?.model,
      tags: options.tags,
    });
  }

  initialize() {
    // Dynamic proxy middleware
    this.app.use(async (req: Request, res: Response, next: NextFunction) => {
      // 仅处理支持的目标路径
      if (!SUPPORTED_TARGETS.some(target => req.path.startsWith(`/${target}/`))) {
        return next();
      }

      const requestStartAt = Date.now();
      let hasRelayAttempt = false;

      try {
        const pathTargetType = this.inferTargetTypeFromPath(req.path);
        const route = this.findMatchingRoute(req);
        if (!route) {
          // 没有找到激活的路由，尝试使用原始配置
          const fallbackResult = await this.handleFallbackToOriginalConfig(req, res, requestStartAt);
          if (fallbackResult) {
            return; // 成功使用原始配置处理请求
          }

          await this.logToolRequest(req, {
            statusCode: 404,
            responseTime: Date.now() - requestStartAt,
            targetType: pathTargetType,
            error: 'No matching route found and no original config available',
            tags: this.buildRelayTags(false),
          });

          // 如果原始配置也不可用，返回错误
          return res.status(404).json({ error: 'No matching route found and no original config available' });
        }

        // 高智商请求判定：从消息结构推断是否启用，不再使用 !x 显式关闭语法
        const forcedContentType = await this.prepareHighIqRouting(req, route, route.targetType);

        // 检查是否启用故障切换
        const enableFailover = this.config?.enableFailover !== false; // 默认为 true

        if (!enableFailover) {
          // 故障切换已禁用,使用传统的单一规则匹配
          const rule = await this.findMatchingRule(route.id, req, forcedContentType);
          if (!rule) {
            // 有激活路由但无可用规则时，回退到原始配置
            const fallbackResult = await this.handleFallbackToOriginalConfig(req, res, requestStartAt);
            if (fallbackResult) {
              return;
            }

            await this.logToolRequest(req, {
              statusCode: 404,
              responseTime: Date.now() - requestStartAt,
              targetType: route.targetType,
              error: 'No matching rule found',
              tags: this.buildRelayTags(false),
            });
            return res.status(404).json({ error: 'No matching rule found' });
          }

          const service = this.getServiceById(rule.targetServiceId);
          if (!service) {
            await this.logToolRequest(req, {
              statusCode: 500,
              responseTime: Date.now() - requestStartAt,
              targetType: route.targetType,
              error: 'Target service not configured',
              tags: this.buildRelayTags(false),
            });
            return res.status(500).json({ error: 'Target service not configured' });
          }

          hasRelayAttempt = true;
          await this.proxyRequest(req, res, route, rule, service);
          return;
        }

        // 启用故障切换:获取所有候选规则
        const allRules = this.getAllMatchingRules(route.id, req, forcedContentType);
        if (allRules.length === 0) {
          // 有激活路由但无可用规则时，回退到原始配置
          const fallbackResult = await this.handleFallbackToOriginalConfig(req, res, requestStartAt);
          if (fallbackResult) {
            return;
          }

          await this.logToolRequest(req, {
            statusCode: 404,
            responseTime: Date.now() - requestStartAt,
            targetType: route.targetType,
            error: 'No matching rule found',
            tags: this.buildRelayTags(false),
          });
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
            hasRelayAttempt = true;
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
              // 广播规则挂起状态
              rulesStatusBroadcaster.markRuleSuspended(
                route.id,
                rule.id,
                service.id,
                rule.contentType,
                '请求超时 - 服务暂时不可用',
                'timeout'
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
                // 广播规则挂起状态
                rulesStatusBroadcaster.markRuleSuspended(
                  route.id,
                  rule.id,
                  service.id,
                  rule.contentType,
                  `HTTP ${statusCode} 错误 - 服务暂时不可用`,
                  'http'
                );
              }
            }

            // 继续尝试下一个服务
            continue;
          }
        }

        // 所有候选规则都不可用（如黑名单或服务缺失）时，尝试回退到原始配置
        if (!hasRelayAttempt && !lastFailedRule && !lastFailedService) {
          const fallbackResult = await this.handleFallbackToOriginalConfig(req, res, requestStartAt);
          if (fallbackResult) {
            return;
          }
        }

        // 所有服务都失败了
        console.error('All services failed');

        // 如果有失败的服务但都在黑名单中，尝试使用最后一个失败的服务（作为 fallback）
        if (lastFailedRule && lastFailedService) {
          console.log(`All services in blacklist, attempting fallback to last failed service: ${lastFailedService.name}`);
          try {
            hasRelayAttempt = true;
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

        await this.logToolRequest(req, {
          statusCode: 503,
          responseTime: Date.now() - requestStartAt,
          targetType: route.targetType,
          error: lastError?.message || 'All services failed',
          tags: this.buildRelayTags(hasRelayAttempt),
        });

        // 确定目标类型
        const targetType: ToolType = req.path.startsWith('/claude-code/') ? 'claude-code' : 'codex';

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
        if (this.isResponseCommitted(res)) {
          return;
        }
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
        await this.logToolRequest(req, {
          statusCode: 500,
          responseTime: Date.now() - requestStartAt,
          targetType: this.inferTargetTypeFromPath(req.path),
          error: error.message,
          tags: this.buildRelayTags(hasRelayAttempt),
        });
        // Add error log - 包含请求详情
        const targetType: ToolType = req.path.startsWith('/claude-code/') ? 'claude-code' : 'codex';
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
        if (this.isResponseCommitted(res)) {
          return;
        }
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
      const requestStartAt = Date.now();
      let hasRelayAttempt = false;

      try {
        // 检查API Key验证
        if (this.config.apiKey) {
          const authHeader = req.headers.authorization;
          const providedKey = authHeader?.replace('Bearer ', '');
          if (!providedKey || providedKey !== this.config.apiKey) {
            await this.logToolRequest(req, {
              statusCode: 401,
              responseTime: Date.now() - requestStartAt,
              targetType,
              error: 'Invalid API key',
              tags: this.buildRelayTags(false),
            });
            return res.status(401).json({ error: 'Invalid API key' });
          }
        }

        const route = this.findRouteByTargetType(targetType);
        if (!route) {
          await this.logToolRequest(req, {
            statusCode: 404,
            responseTime: Date.now() - requestStartAt,
            targetType,
            error: `No active route found for target type: ${targetType}`,
            tags: this.buildRelayTags(false),
          });
          return res.status(404).json({ error: `No active route found for target type: ${targetType}` });
        }

        // 高智商请求判定：从消息结构推断是否启用，不再使用 !x 显式关闭语法
        const forcedContentType = await this.prepareHighIqRouting(req, route, targetType);

        // 检查是否启用故障切换
        const enableFailover = this.config?.enableFailover !== false; // 默认为 true

        if (!enableFailover) {
          // 故障切换已禁用,使用传统的单一规则匹配
          const rule = await this.findMatchingRule(route.id, req, forcedContentType);
          if (!rule) {
            // 有激活路由但无可用规则时，回退到原始配置
            const fallbackResult = await this.handleFallbackToOriginalConfig(req, res, requestStartAt);
            if (fallbackResult) {
              return;
            }

            await this.logToolRequest(req, {
              statusCode: 404,
              responseTime: Date.now() - requestStartAt,
              targetType,
              error: 'No matching rule found',
              tags: this.buildRelayTags(false),
            });
            return res.status(404).json({ error: 'No matching rule found' });
          }

          const service = this.getServiceById(rule.targetServiceId);
          if (!service) {
            await this.logToolRequest(req, {
              statusCode: 500,
              responseTime: Date.now() - requestStartAt,
              targetType,
              error: 'Target service not configured',
              tags: this.buildRelayTags(false),
            });
            return res.status(500).json({ error: 'Target service not configured' });
          }

          hasRelayAttempt = true;
          await this.proxyRequest(req, res, route, rule, service);
          return;
        }

        // 启用故障切换:获取所有候选规则
        const allRules = this.getAllMatchingRules(route.id, req, forcedContentType);
        if (allRules.length === 0) {
          // 有激活路由但无可用规则时，回退到原始配置
          const fallbackResult = await this.handleFallbackToOriginalConfig(req, res, requestStartAt);
          if (fallbackResult) {
            return;
          }

          await this.logToolRequest(req, {
            statusCode: 404,
            responseTime: Date.now() - requestStartAt,
            targetType,
            error: 'No matching rule found',
            tags: this.buildRelayTags(false),
          });
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
            hasRelayAttempt = true;
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
              // 广播规则挂起状态
              rulesStatusBroadcaster.markRuleSuspended(
                route.id,
                rule.id,
                service.id,
                rule.contentType,
                '请求超时 - 服务暂时不可用',
                'timeout'
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
                // 广播规则挂起状态
                rulesStatusBroadcaster.markRuleSuspended(
                  route.id,
                  rule.id,
                  service.id,
                  rule.contentType,
                  `HTTP ${statusCode} 错误 - 服务暂时不可用`,
                  'http'
                );
              }
            }

            // 继续尝试下一个服务
            continue;
          }
        }

        // 所有候选规则都不可用（如黑名单或服务缺失）时，尝试回退到原始配置
        if (!hasRelayAttempt && !lastFailedRule && !lastFailedService) {
          const fallbackResult = await this.handleFallbackToOriginalConfig(req, res, requestStartAt);
          if (fallbackResult) {
            return;
          }
        }

        // 所有服务都失败了
        console.error('All services failed');

        // 如果有失败的服务但都在黑名单中，尝试使用最后一个失败的服务（作为 fallback）
        if (lastFailedRule && lastFailedService) {
          console.log(`All services in blacklist, attempting fallback to last failed service: ${lastFailedService.name}`);
          try {
            hasRelayAttempt = true;
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

        await this.logToolRequest(req, {
          statusCode: 503,
          responseTime: Date.now() - requestStartAt,
          targetType,
          error: lastError?.message || 'All services failed',
          tags: this.buildRelayTags(hasRelayAttempt),
        });

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
        if (this.isResponseCommitted(res)) {
          return;
        }
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
        await this.logToolRequest(req, {
          statusCode: 500,
          responseTime: Date.now() - requestStartAt,
          targetType,
          error: error.message,
          tags: this.buildRelayTags(hasRelayAttempt),
        });
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
        if (this.isResponseCommitted(res)) {
          return;
        }
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
    let targetType: ToolType | undefined;
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

  /**
   * 当没有激活的路由时，fallback 到原始配置
   * @returns true 表示成功处理，false 表示无法处理
   */
  private async handleFallbackToOriginalConfig(req: Request, res: Response, requestStartAt?: number): Promise<boolean> {
    // 确定目标类型
    let targetType: ToolType | undefined;
    if (req.path.startsWith('/claude-code/')) {
      targetType = 'claude-code';
    } else if (req.path.startsWith('/codex/')) {
      targetType = 'codex';
    }

    if (!targetType) {
      return false;
    }

    // 读取原始配置
    const originalConfig = readOriginalConfig(targetType);
    if (!originalConfig) {
      console.log(`[FALLBACK] No original config available for ${targetType}`);
      return false;
    }

    // 检查原始配置的 API URL 是否指向本系统（避免死循环）
    if (this.isLocalProxyUrl(originalConfig.apiUrl)) {
      const errorMessage = `Fallback skipped: original upstream points to AI Code Switch itself (${originalConfig.apiUrl})`;
      console.error(`[FALLBACK] ${errorMessage}`);
      await this.logToolRequest(req, {
        statusCode: 502,
        responseTime: requestStartAt ? Date.now() - requestStartAt : undefined,
        targetType,
        error: errorMessage,
        tags: this.buildRelayTags(false),
      });
      res.status(502).json({
        error: errorMessage,
      });
      return true;
    }

    console.log(`[FALLBACK] Using original config for ${targetType}: ${originalConfig.apiUrl}`);

    try {
      const fallbackTargetModel = targetType === 'claude-code'
        ? this.resolveClaudeFallbackTargetModel(req.body?.model, originalConfig)
        : undefined;

      // 创建临时的路由对象（用于传递给 proxyRequest）
      const tempRoute: Route = {
        id: 'fallback-route',
        name: 'Fallback to Original Config',
        targetType: targetType,
        isActive: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      // 创建临时的规则对象
      const tempRule: Rule = {
        id: 'fallback-rule',
        routeId: 'fallback-route',
        contentType: 'default',
        targetServiceId: 'fallback-service',
        targetModel: fallbackTargetModel,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      // 创建临时的服务对象
      const tempService: APIService = {
        id: 'fallback-service',
        name: 'Original Config',
        apiUrl: originalConfig.apiUrl,
        apiKey: originalConfig.apiKey,
        authType: originalConfig.authType,
        sourceType: originalConfig.sourceType || (targetType === 'claude-code' ? 'claude' : 'openai'),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      // 调用 proxyRequest 处理请求，并标记使用原始配置
      await this.proxyRequest(req, res, tempRoute, tempRule, tempService, {
        useOriginalConfig: true,
      });

      return true;
    } catch (error: any) {
      console.error('[FALLBACK] Failed to use original config:', error);
      return false;
    }
  }

  /**
   * 检查 API URL 是否指向本系统的代理服务
   * 用于避免 fallback 时的死循环
   */
  private isLocalProxyUrl(apiUrl: string): boolean {
    try {
      const url = new URL(apiUrl);
      const configuredHost = (process.env.HOST || '').trim();
      const localHosts = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
      if (configuredHost) {
        localHosts.add(configuredHost);
      }

      // 检查是否是本机地址
      const isLocalhost = localHosts.has(url.hostname);

      if (!isLocalhost) {
        return false;
      }

      // 检查端口是否是本系统的端口（默认 4567）
      const serverPort = process.env.PORT ? parseInt(process.env.PORT, 10) : 4567;
      const urlPort = url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 80);
      const isSamePort = urlPort === serverPort;

      if (!isSamePort) {
        return false;
      }
      return true;
    } catch (error) {
      // URL 解析失败，认为不是本地代理 URL
      return false;
    }
  }

  private resolveClaudeFallbackTargetModel(requestModel: unknown, originalConfig: ReturnType<typeof readOriginalConfig>): string | undefined {
    if (typeof requestModel !== 'string') {
      return undefined;
    }
    const normalized = requestModel.trim().toLowerCase();
    if (!normalized) {
      return undefined;
    }
    const defaults = originalConfig?.claudeDefaultModels;
    if (!defaults) {
      return undefined;
    }

    const matchSegment = (segment: 'haiku' | 'sonnet' | 'opus') => {
      return normalized === segment
        || normalized.startsWith(`claude-${segment}-`)
        || normalized.includes(`-${segment}-`)
        || normalized.endsWith(`-${segment}`)
        || normalized.includes(`_${segment}_`)
        || normalized.endsWith(`_${segment}`);
    };

    if (matchSegment('haiku') && defaults.haiku) {
      return defaults.haiku;
    }
    if (matchSegment('sonnet') && defaults.sonnet) {
      return defaults.sonnet;
    }
    if (matchSegment('opus') && defaults.opus) {
      return defaults.opus;
    }

    return undefined;
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

  private isDownstreamClosed(res: Response): boolean {
    return res.destroyed || res.writableEnded || !res.writable;
  }

  private isResponseCommitted(res: Response): boolean {
    return res.headersSent || this.isDownstreamClosed(res);
  }

  private isClientDisconnectError(error: any, res?: Response): boolean {
    const code = error?.code;
    if (code === 'CLIENT_DISCONNECTED' || code === 'ERR_CANCELED') {
      return true;
    }
    if (code === 'ERR_STREAM_UNABLE_TO_PIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ERR_STREAM_PREMATURE_CLOSE') {
      return true;
    }
    if (code === 'ECONNRESET' || code === 'EPIPE') {
      return true;
    }
    const message = typeof error?.message === 'string' ? error.message.toLowerCase() : '';
    if (message.includes('socket hang up') || message.includes('client disconnected') || message.includes('premature close')) {
      return true;
    }
    if (res && this.isDownstreamClosed(res)) {
      return message.includes('stream') || message.includes('pipe');
    }
    return false;
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

  private async findMatchingRule(routeId: string, req: Request, forcedContentType?: ContentType): Promise<Rule | undefined> {
    const rules = this.getRulesByRouteId(routeId);
    if (!rules || rules.length === 0) return undefined;

    // 过滤掉被屏蔽的规则
    const enabledRules = rules.filter(rule => !rule.isDisabled);
    if (enabledRules.length === 0) return undefined;

    const body = req.body;
    const requestModel = body?.model;
    const route = this.dbManager.getRoutes().find(r => r.id === routeId);
    const contentType = forcedContentType || this.determineContentType(req, route?.targetType || 'claude-code', routeId);

    // 高智商规则优先于 model-mapping，确保 !!/推断命中时不会被模型映射覆盖
    if (contentType === 'high-iq') {
      const highIqRules = enabledRules.filter(rule => rule.contentType === 'high-iq');
      for (const rule of highIqRules) {
        const isBlacklisted = await this.dbManager.isServiceBlacklisted(
          rule.targetServiceId,
          routeId,
          rule.contentType
        );
        if (isBlacklisted) {
          continue;
        }

        this.dbManager.checkAndResetRuleIfNeeded(rule.id);
        this.dbManager.checkAndResetRequestCountIfNeeded(rule.id);

        if (rule.tokenLimit && rule.totalTokensUsed !== undefined && rule.totalTokensUsed >= rule.tokenLimit * 1000) {
          continue;
        }
        if (rule.requestCountLimit && rule.totalRequestsUsed !== undefined && rule.totalRequestsUsed >= rule.requestCountLimit) {
          continue;
        }
        if (this.isFrequencyLimitExceeded(rule)) {
          continue;
        }

        return rule;
      }
    }

    // 1. 查找其他内容类型的规则
    const contentTypeRules = enabledRules.filter(rule => rule.contentType === contentType);

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

    // 2. 然后查找 model-mapping 类型的规则
    if (requestModel) {
      const modelMappingRules = enabledRules.filter(rule =>
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

    // 3. 最后返回 default 规则
    const defaultRules = enabledRules.filter(rule => rule.contentType === 'default');

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

  private getAllMatchingRules(routeId: string, req: Request, forcedContentType?: ContentType): Rule[] {
    const rules = this.getRulesByRouteId(routeId);
    if (!rules || rules.length === 0) return [];

    // 过滤掉被屏蔽的规则
    const enabledRules = rules.filter(rule => !rule.isDisabled);
    if (enabledRules.length === 0) return [];

    const body = req.body;
    const requestModel = body?.model;
    const candidates: Rule[] = [];
    const route = this.dbManager.getRoutes().find(r => r.id === routeId);
    const contentType = forcedContentType || this.determineContentType(req, route?.targetType || 'claude-code', routeId);
    const prioritizeContentType = contentType === 'high-iq';

    const modelMappingRules = requestModel
      ? enabledRules.filter(rule =>
          rule.contentType === 'model-mapping' &&
          rule.replacedModel &&
          requestModel.includes(rule.replacedModel)
        )
      : [];
    const contentTypeRules = enabledRules.filter(rule => rule.contentType === contentType);
    const defaultRules = enabledRules.filter(rule => rule.contentType === 'default');

    if (prioritizeContentType) {
      candidates.push(...contentTypeRules, ...modelMappingRules, ...defaultRules);
    } else {
      candidates.push(...modelMappingRules, ...contentTypeRules, ...defaultRules);
    }

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

  private determineContentType(req: Request, targetType: ToolType, routeId?: string): ContentType {
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

    // 获取sessionId用于session级别的检测（如long-context）
    const sessionId = this.defaultExtractSessionId(req, targetType);

    for (const detector of this.getContentTypeDetectors()) {
      if (detector.match(req, body, sessionId, routeId)) {
        return detector.type;
      }
    }

    return 'default';
  }

  private getContentTypeDetectors(): ContentTypeDetector[] {
    return [
      {
        type: 'image-understanding',
        match: (_req, body) => this.containsImageContentInLatestMessage(body.messages) || this.containsImageContent(body.input),
      },
      {
        type: 'high-iq',
        match: (_req, body) => this.hasHighIqSignal(body),
      },
      {
        type: 'long-context',
        match: (_req, body, sessionId, routeId) => this.hasLongContextSignal(body, sessionId, routeId),
      },
      {
        type: 'thinking',
        match: (_req, body) => this.hasThinkingSignal(body),
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

  /** 检测最新用户消息中是否包含图像内容 */
  private containsImageContentInLatestMessage(messages: any[] | undefined): boolean {
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return false;
    }

    // 从后向���找到最后一个用户消息
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message?.role === 'user') {
        const content = message?.content;
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
        // 只检查最后一个用户消息，找到后立即返回
        return false;
      }
    }

    return false;
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
    return this.inferHighIqRouting(body, false).shouldUseHighIq;
  }

  private inferHighIqRouting(body: any, previousMode: boolean): HighIqInferenceResult {
    const messages = this.extractConversationMessages(body);
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message?.role !== 'user') {
        continue;
      }

      const signal = this.analyzeUserMessageForHighIq(message);
      if (!signal.hasHumanText) {
        continue;
      }

      if (signal.hasHighIqPrefix) {
        return {
          shouldUseHighIq: true,
          decisionSource: 'human',
        };
      }

      return {
        shouldUseHighIq: false,
        decisionSource: 'human',
      };
    }

    if (previousMode) {
      return {
        shouldUseHighIq: true,
        decisionSource: 'fallback',
      };
    }

    return {
      shouldUseHighIq: false,
      decisionSource: 'none',
    };
  }

  private async prepareHighIqRouting(req: Request, route: Route, targetType: ToolType): Promise<ContentType | undefined> {
    const sessionId = this.defaultExtractSessionId(req, targetType);
    const session = sessionId ? this.dbManager.getSession(sessionId) : null;
    const previousMode = session?.highIqMode === true;
    const inference = this.inferHighIqRouting(req.body, previousMode);

    if (!inference.shouldUseHighIq) {
      if (sessionId && session?.highIqMode && inference.decisionSource === 'human') {
        await this.dbManager.updateSession(sessionId, {
          highIqMode: false,
          highIqRuleId: undefined,
          lastRequestAt: Date.now(),
        });
        console.log(`[HIGH-IQ] Session ${sessionId} auto-disabled by latest human message`);
      }
      return undefined;
    }

    const highIqRule = await this.findHighIqRule(route.id);
    if (!highIqRule) {
      if (sessionId && session?.highIqMode) {
        await this.dbManager.updateSession(sessionId, {
          highIqMode: false,
          highIqRuleId: undefined,
          lastRequestAt: Date.now(),
        });
      }
      console.log('[HIGH-IQ] Inferred high-iq request but no available high-iq rule found');
      return undefined;
    }

    if (sessionId && (!session?.highIqMode || session.highIqRuleId !== highIqRule.id)) {
      await this.dbManager.updateSession(sessionId, {
        highIqMode: true,
        highIqRuleId: highIqRule.id,
        highIqEnabledAt: session?.highIqEnabledAt || Date.now(),
        lastRequestAt: Date.now(),
      });
      console.log(`[HIGH-IQ] Session ${sessionId} inferred ON with rule ${highIqRule.id}`);
    }

    return 'high-iq';
  }

  private extractConversationMessages(body: any): any[] {
    if (!body || typeof body !== 'object') {
      return [];
    }
    if (Array.isArray(body.messages)) {
      return body.messages;
    }
    if (typeof body.input === 'string') {
      return [{ role: 'user', content: body.input }];
    }
    if (Array.isArray(body.input)) {
      const normalized: any[] = [];
      for (const item of body.input) {
        if (item && typeof item === 'object' && typeof item.role === 'string') {
          normalized.push(item);
        } else if (typeof item === 'string') {
          normalized.push({ role: 'user', content: item });
        }
      }
      return normalized;
    }
    if (body.input && typeof body.input === 'object' && typeof body.input.role === 'string') {
      return [body.input];
    }
    return [];
  }

  private analyzeUserMessageForHighIq(message: any): { hasHumanText: boolean; hasHighIqPrefix: boolean } {
    let hasHumanText = false;
    let hasHighIqPrefix = false;

    const scanText = (text: string, treatAsHuman: boolean) => {
      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }
      if (treatAsHuman) {
        hasHumanText = true;
      }
      if (treatAsHuman && trimmed.startsWith('[!]')) {
        hasHighIqPrefix = true;
      }
    };

    const content = message?.content;
    if (typeof content === 'string') {
      scanText(content, true);
      return { hasHumanText, hasHighIqPrefix };
    }

    const blocks = Array.isArray(content) ? content : [content];
    for (const block of blocks) {
      if (typeof block === 'string') {
        scanText(block, true);
        continue;
      }
      if (!block || typeof block !== 'object') {
        continue;
      }

      const type = typeof block.type === 'string' ? block.type : '';
      const toolGenerated = type === 'tool_result' || type === 'tool' || Boolean(block.tool_use_id || block.tool_call_id);

      if (typeof block.text === 'string') {
        scanText(block.text, !toolGenerated);
      }
      if (typeof block.content === 'string') {
        scanText(block.content, !toolGenerated);
      }
      if (Array.isArray(block.content)) {
        for (const nested of block.content) {
          if (typeof nested === 'string') {
            scanText(nested, !toolGenerated);
            continue;
          }
          if (nested && typeof nested === 'object') {
            if (typeof nested.text === 'string') {
              scanText(nested.text, !toolGenerated);
            }
            if (typeof nested.content === 'string') {
              scanText(nested.content, !toolGenerated);
            }
          }
        }
      }
    }

    return { hasHumanText, hasHighIqPrefix };
  }

  /**
   * 查找可用的高智商规则
   */
  private async findHighIqRule(routeId: string): Promise<Rule | undefined> {
    const rules = this.getRulesByRouteId(routeId);
    if (!rules || rules.length === 0) return undefined;

    const highIqRules = rules.filter(rule =>
      rule.contentType === 'high-iq' && !rule.isDisabled
    );

    // 过滤黑名单和限制
    for (const rule of highIqRules) {
      const isBlacklisted = await this.dbManager.isServiceBlacklisted(
        rule.targetServiceId,
        routeId,
        'high-iq'
      );
      if (isBlacklisted) continue;

      // 检查并重置到期的规则
      this.dbManager.checkAndResetRuleIfNeeded(rule.id);
      this.dbManager.checkAndResetRequestCountIfNeeded(rule.id);

      // 检查token限制
      if (rule.tokenLimit && rule.totalTokensUsed !== undefined &&
          rule.totalTokensUsed >= rule.tokenLimit * 1000) {
        continue;
      }

      // 检查请求次数限制
      if (rule.requestCountLimit && rule.totalRequestsUsed !== undefined &&
          rule.totalRequestsUsed >= rule.requestCountLimit) {
        continue;
      }

      // 检查频率限制
      if (this.isFrequencyLimitExceeded(rule)) {
        continue;
      }

      return rule;
    }

    return undefined;
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

  private hasLongContextSignal(body: any, sessionId?: string | null, routeId?: string): boolean {
    const explicit = [
      body?.long_context,
      body?.longContext,
      body?.metadata?.long_context,
      body?.metadata?.longContext,
    ];
    if (explicit.some((value) => value === true)) {
      return true;
    }

    // 检查session累积tokens
    if (sessionId && routeId) {
      const session = this.dbManager.getSession(sessionId);
      if (session && session.totalTokens > 0) {
        // 查找该route下的long-context规则，获取阈值配置
        const rules = this.getRulesByRouteId(routeId);
        const longContextRule = rules?.find(rule => rule.contentType === 'long-context' && !rule.isDisabled);

        // 默认阈值为1M tokens (1000k)
        const defaultThreshold = 1000; // 单位：k
        const threshold = longContextRule?.sessionTokenThreshold ?? defaultThreshold;

        // 如果session累积tokens超过阈值，则认为是long-context
        if (session.totalTokens >= threshold * 1000) {
          return true;
        }
      }
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

  private isCountTokensPath(path?: string): boolean {
    if (!path) {
      return false;
    }
    const normalizedPath = path.split('?')[0];
    return /\/v1\/messages\/count_tokens\/?$/.test(normalizedPath);
  }

  private isClaudeCodeBridgeSource(sourceType: SourceType): boolean {
    return this.isGeminiSource(sourceType)
      || this.isGeminiChatSource(sourceType)
      || this.isOpenAISource(sourceType)
      || this.isOpenAIChatSource(sourceType);
  }

  private shouldDefaultStreamingForClaudeBridge(req: Request, targetType: ToolType, sourceType: SourceType, body: any): boolean {
    if (targetType !== 'claude-code') {
      return false;
    }
    if (!this.isClaudeCodeBridgeSource(sourceType)) {
      return false;
    }
    if (this.isCountTokensPath(req.path) || this.isCountTokensPath(req.originalUrl)) {
      return false;
    }
    if (body?.stream === false) {
      return false;
    }
    return true;
  }

  private shouldHandleCountTokensLocally(req: Request, targetType: ToolType, sourceType: SourceType): boolean {
    if (targetType !== 'claude-code') {
      return false;
    }
    if (!this.isClaudeCodeBridgeSource(sourceType)) {
      return false;
    }
    return this.isCountTokensPath(req.path) || this.isCountTokensPath(req.originalUrl);
  }

  private estimateTokensFromText(text: string): number {
    if (!text) {
      return 0;
    }
    const compactText = text.replace(/\s+/g, '');
    if (!compactText) {
      return 0;
    }
    const cjkCount = (compactText.match(/[\u3400-\u9FFF\uF900-\uFAFF]/g) || []).length;
    const nonCjkCount = Math.max(compactText.length - cjkCount, 0);
    return cjkCount + Math.ceil(nonCjkCount / 4);
  }

  private countImageBlocks(payload: any): number {
    if (!payload) {
      return 0;
    }
    let count = 0;
    const scanContent = (content: any) => {
      if (!content) return;
      if (Array.isArray(content)) {
        for (const part of content) {
          scanContent(part);
        }
        return;
      }
      if (typeof content !== 'object') {
        return;
      }
      const partType = typeof (content as any).type === 'string' ? (content as any).type : '';
      const isImageBlock = partType === 'image'
        || partType === 'image_url'
        || partType === 'input_image'
        || Boolean((content as any).image_url)
        || (content as any).source?.type === 'base64';
      if (isImageBlock) {
        count++;
      }
      if ((content as any).content) {
        scanContent((content as any).content);
      }
    };

    scanContent(payload?.messages);
    scanContent(payload?.input);
    return count;
  }

  private estimateClaudeCountTokens(body: any): number {
    let baseTokens = 0;
    const addText = (value?: string | null) => {
      if (typeof value === 'string') {
        baseTokens += this.estimateTokensFromText(value);
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

    const imageBlocks = this.countImageBlocks(body);
    const imageTokens = imageBlocks * 85;
    const toolTokens = Array.isArray(body?.tools)
      ? Math.ceil(JSON.stringify(body.tools).length / 4)
      : 0;
    const overheadTokens = 8;
    return Math.max(1, baseTokens + imageTokens + toolTokens + overheadTokens);
  }

  /** 判断是否为 Claude 相关类型（使用 x-api-key 认证） */
  private isClaudeSource(sourceType: SourceType | string) {
    // 向下兼容：支持旧类型 'claude-code'
    return sourceType === 'claude' || sourceType === 'claude-code';
  }

  /** 判断是否为 Claude Chat 类型 */
  private isClaudeChatSource(sourceType: SourceType | string) {
    return sourceType === 'claude-chat';
  }

  private isOpenAISource(sourceType: SourceType | string) {
    // 向下兼容：支持旧类型 'openai-responses'
    return sourceType === 'openai' || sourceType === 'openai-responses';
  }

  /** 判断是否为 OpenAI Chat 类型 */
  private isOpenAIChatSource(sourceType: SourceType | string) {
    return sourceType === 'openai-chat' || sourceType === 'deepseek-reasoning-chat';
  }

  /** 判断是否为 OpenAI 类型（包括 OpenAI Chat 和 OpenAI Responses） */
  private isOpenAIType(sourceType: SourceType | string) {
    return sourceType === 'openai' || sourceType === 'openai-chat' || sourceType === 'openai-responses' || sourceType === 'deepseek-reasoning-chat';
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
    return sourceType.endsWith('-chat');
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

  private isStreamRequested(req: Request, body: any, targetType?: ToolType, sourceType?: SourceType) {
    const accept = typeof req.headers.accept === 'string' ? req.headers.accept : '';
    if (body?.stream === true || accept.includes('text/event-stream')) {
      return true;
    }
    if (body?.stream === false) {
      return false;
    }
    if (targetType && sourceType && this.shouldDefaultStreamingForClaudeBridge(req, targetType, sourceType, body)) {
      return true;
    }
    return false;
  }

  private buildUpstreamHeaders(
    req: Request,
    service: APIService,
    sourceType: SourceType,
    streamRequested: boolean,
    requestBody?: any
  ) {
    const effectiveApiKey = this.resolveEffectiveApiKey(service);
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
      headers['x-goog-api-key'] = effectiveApiKey;
    }
    // 使用 x-api-key 认证（适用于 claude-chat, claude-code 及某些需要 x-api-key 的 openai-chat 兼容 API）
    else if (authType === AuthType.API_KEY || (isAuto && this.isClaudeSource(sourceType))) {
      headers['x-api-key'] = effectiveApiKey;
      if (this.isClaudeSource(sourceType) || authType === AuthType.API_KEY) {
        // 仅在明确配置或 Claude 源时添加 anthropic-version
        headers['anthropic-version'] = headers['anthropic-version'] || '2023-06-01';
      }
    }
    // 使用 Authorization 认证（适用于 openai-chat, openai-responses, deepseek-reasoning-chat 等）
    else {
      headers.authorization = `Bearer ${effectiveApiKey}`;
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
      headers['content-type'] = 'application/json; charset=utf-8';
    }

    // 添加 content-length（对于有请求体的方法）
    if (requestBody && ['POST', 'PUT', 'PATCH'].includes(req.method.toUpperCase())) {
      const bodyStr = JSON.stringify(requestBody);
      headers['content-length'] = Buffer.byteLength(bodyStr, 'utf8').toString();
    }

    return headers;
  }

  private resolveEffectiveApiKey(service: APIService): string {
    if (service.inheritVendorApiKey !== true) {
      return service.apiKey;
    }

    const vendor = this.dbManager.getVendorByServiceId(service.id);
    if (!vendor) {
      console.warn(`[Proxy] Service ${service.id} is set to inherit vendor API key, but vendor is missing`);
      return '';
    }

    return vendor.apiKey || '';
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
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.on('end', () => {
        const fullBuffer = Buffer.concat(chunks);
        resolve(fullBuffer.toString('utf8'));
      });
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

  /**
   * 从请求中提取 session ID（默认方法）
   * Claude Code: metadata.user_id
   * Codex: headers.session_id
   */
  private defaultExtractSessionId(request: Request, type: ToolType): string | null {
    if (type === 'claude-code') {
      // Claude Code 使用 metadata.user_id
      const rawUserId = request.body?.metadata?.user_id;
      return ProxyServer.extractSessionIdFromUserId(rawUserId);
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
   * 从 metadata.user_id 中提取 session ID
   * 新版本格式: JSON 字符串 {"device_id":"...","account_uuid":"...","session_id":"..."}
   * 旧版本格式: 纯字符串 session ID
   */
  static extractSessionIdFromUserId(rawUserId: string | undefined | null): string | null {
    if (!rawUserId || typeof rawUserId !== 'string') return null;
    try {
      const parsed = JSON.parse(rawUserId);
      if (parsed && typeof parsed === 'object' && parsed.session_id) {
        return parsed.session_id;
      }
    } catch {
      // 不是 JSON，按旧版本纯字符串处理
    }
    return rawUserId;
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

    // 1. Claude Code 格式：从 messages 数组提取
    const rawText = this.extractTitleFromMessages(request.body?.messages)
      || this.extractTitleFromInput(request.body?.input)
      || null;

    if (rawText) {
      return this.formatSessionTitle(rawText);
    }
    return undefined;
  }

  /**
   * 从 messages 数组提取标题（Claude Code / OpenAI Chat 格式）
   */
  private extractTitleFromMessages(messages: any[]): string | null {
    if (!Array.isArray(messages) || messages.length === 0) return null;
    const firstUserMessage = messages.find((msg: any) => msg.role === 'user');
    if (!firstUserMessage) return null;

    const content = firstUserMessage.content;
    if (typeof content === 'string') {
      return content;
    } else if (Array.isArray(content) && content.length > 0) {
      const lastBlock = content[content.length - 1];
      if (lastBlock?.type === 'text' && lastBlock?.text) {
        return lastBlock.text;
      }
      const textBlock = content.find((block: any) => block?.type === 'text');
      if (textBlock?.text) return textBlock.text;
    }
    return null;
  }

  /**
   * 从 input 数组提取标题（Codex Responses API 格式）
   * 忽略 developer 消息和系统级内容（AGENTS.md、<tag> 包裹的内容），
   * 使用最后一条有效的用户输入作为标题
   */
  private extractTitleFromInput(input: any[]): string | null {
    if (!Array.isArray(input) || input.length === 0) return null;

    const userMessages = input.filter((item: any) => item.type === 'message' && item.role === 'user');
    for (let i = userMessages.length - 1; i >= 0; i--) {
      const msg = userMessages[i];
      const content = msg.content;
      if (!Array.isArray(content)) continue;
      // 拼接所有 input_text，排除 AGENTS.md 和 <tag> 包裹的内容
      const textParts: string[] = [];
      for (const block of content) {
        if (block.type === 'input_text' && typeof block.text === 'string') {
          const text = block.text.trim();
          if (text.startsWith('# AGENTS.md') || text.startsWith('<environment_context>') || /^<\w+>/.test(text)) {
            continue;
          }
          textParts.push(text);
        }
      }
      if (textParts.length > 0) {
        return textParts.join(' ');
      }
    }
    return null;
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
   * 将请求路径映射到目标API的URL
   * @param tool 工具类型
   * @param source API的数据源类型
   * @param originalPath 工具发送的请求路径，注意，不带origin部分
   * @param apiUrl route所选API服务的API地址字段值
   * @param modelName route中选择的模型名称
   * @param isStream 是否请求流式响应
   */
  private mapRequestPathToUpstreamUrl(tool: ToolType, source: SourceType, originalPath: string, apiUrl: string, modelName: string, isStream: boolean) {
    const geminiEndpoint = isStream ? 'streamGenerateContent' : 'generateContent';
    const buildGeminiUrl = (url: string) => {
      if (url.includes('streamGenerateContent')) {
        const [pathname, search] = url.split('?');
        if (search?.includes('alt=sse')) {
          return url;
        }
        if (search) {
          return `${pathname}?${search}&alt=sse`;
        }
        return `${pathname}?alt=sse`;
      }
      return url;
    };

    // gemini-chat类型
    if (this.isGeminiChatSource(source)) {
      const url = apiUrl.replace('{modelName}', modelName).replace('{endPoint}', geminiEndpoint);
      return buildGeminiUrl(url);
    }

    // 聊天类型
    if (this.isChatType(source)) {
      return apiUrl;
    }

    // 对于 gemini 类型接口
    if (this.isGeminiSource(source)) {
      const url = `${apiUrl}/v1beta/models/${modelName}:${geminiEndpoint}`;
      return buildGeminiUrl(url);
    }

    // claude code 请求 openai 类型接口，直接使用 openai-chat 接口来处理
    if (tool === 'claude-code' && this.isOpenAISource(source)) {
      return `${apiUrl}/v1/chat/completions`;
    }

    // codex 请求 claude 类型接口，直接使用 claude-chat 接口来处理
    if (tool === 'codex' && this.isClaudeSource(source)) {
      return `${apiUrl}/v1/messages`;
    }

    // 透传路径
    return `${apiUrl}${originalPath}`;
  }

  /**
   * 转换请求数据到目标API的请求数据
   * 统一处理所有格式转换和模型覆盖
   * @param tool 源工具类型
   * @param source 数据源类型
   * @param payloadData 工具往上提交的原始请求数据
   * @param targetModel 目标模型名称（可选）
   * @returns 转换后往服务商API接口的数据
   */
  private transformRequestToUpstream(tool: ToolType, source: SourceType, payloadData: any, targetModel: string): any {
    // Claude Code 发起的请求
    if (tool === 'claude-code') {
      // claudecode向claude发送的请求，无需转换，但需要应用模型覆盖
      if (this.isClaudeSource(source) || this.isClaudeChatSource(source)) {
        return applyPayloadOverride(payloadData, targetModel);
      }

      // claudecode发送给gemini
      if (this.isGeminiChatSource(source) || this.isGeminiSource(source)) {
        return transformRequestFromClaudeToGemini(payloadData, targetModel);
      }

      // claudecode发送给openai chat completion接口
      if (this.isOpenAIChatSource(source)) {
        return transformRequestFromClaudeToChatCompletions(payloadData, targetModel);
      }

      // claudecode发送给openai responses接口
      if (this.isOpenAISource(source)) {
        return transformRequestFromClaudeToResponses(payloadData, targetModel);
      }
    }

    // Codex 发起的请求（仅支持 Responses API 格式）
    if (tool === 'codex') {
      // Codex 发送给 OpenAI Responses
      if (this.isOpenAISource(source)) {
        return applyPayloadOverride(payloadData, targetModel);
      }

      // Codex 发送给 OpenAI Chat
      if (this.isOpenAIChatSource(source)) {
        // 将 responses 格式转换为 chat completions 格式
        return transformRequestFromResponsesToChatCompletions(payloadData, targetModel);
      }

      // Codex 发送给 Gemini
      if (this.isGeminiChatSource(source) || this.isGeminiSource(source)) {
        return transformRequestFromResponsesToGemini(payloadData, targetModel);
      }

      // Codex 发送给 Claude
      if (this.isClaudeSource(source) || this.isClaudeChatSource(source)) {
        return transformRequestFromResponsesToClaude(payloadData, targetModel);
      }
    }

    // 默认: 直接返回原始数据（如果需要，应用模型覆盖）
    return applyPayloadOverride(payloadData, targetModel);
  }

  /**
   * 将来自API接口的响应数据，转换为工具需要的数据结构
   * @param tool
   * @param source
   * @param responseData
   */
  private transformResponseToTool(tool: ToolType, source: SourceType, responseData: any): any {
    if (tool === 'claude-code') {
      if (this.isClaudeSource(source) || this.isClaudeChatSource(source)) {
        return responseData;
      }
      if (this.isOpenAIChatSource(source)) {
        return transformResponseFromChatCompletionsToClaude(responseData);
      }
      if (this.isOpenAISource(source)) {
        return transformResponseFromResponsesToClaude(responseData);
      }
      if (this.isGeminiSource(source) || this.isGeminiChatSource(source)) {
        return transformResponseFromGeminiToClaude(responseData);
      }
    }

    if (tool === 'codex') {
      // Codex 仅支持 Responses API 格式
      // Codex 接收来自 OpenAI Responses 的响应
      if (this.isOpenAISource(source)) {
        return responseData;
      }

      // Codex 接收来自 OpenAI Chat 的响应（转换为 Responses 格式）
      if (this.isOpenAIChatSource(source)) {
        return transformResponseFromChatCompletionsToResponses(responseData);
      }

      // Codex 接收来自 Claude 的响应（转换为 Responses 格式）
      if (this.isClaudeSource(source) || this.isClaudeChatSource(source)) {
        return transformResponseFromClaudeToResponses(responseData);
      }

      // Codex 接收来自 Gemini 的响应（转换为 Responses 格式）
      if (this.isGeminiSource(source) || this.isGeminiChatSource(source)) {
        return transformResponseFromGeminiToResponses(responseData);
      }
    }
  }

  /**
   * 获取流式响应转换器
   * @param targetType 目标工具类型
   * @param sourceType 数据源类型
   * @param model 模型名称
   * @returns 转换器实例和相关信息
   */
  private transformSSEToTool(targetType: ToolType, sourceType: SourceType, model?: string): {
    converter: Transform | null;
    extractUsage?: (usage: any) => any;
  } {
    // Claude Code 接收流式响应
    if (targetType === 'claude-code') {
      // Claude Code 接收来自 OpenAI Chat 的响应
      if (this.isOpenAIChatSource(sourceType)) {
        console.log('[Proxy] Using OpenAI Chat -> Claude API stream converter');
        return {
          converter: new ChatCompletionsToClaudeEventTransform({ model }),
          extractUsage: (usage) => ({
            inputTokens: usage?.input_tokens || 0,
            outputTokens: usage?.output_tokens || 0,
            cacheReadInputTokens: usage?.cache_read_input_tokens || 0,
          }),
        };
      }

      // Claude Code 接收来自 OpenAI Responses 的响应
      if (this.isOpenAISource(sourceType)) {
        console.log('[Proxy] Using Responses API -> Claude API stream converter');
        return {
          converter: new ResponsesToClaudeEventTransform({ model }),
          extractUsage: (usage) => ({
            inputTokens: usage?.input_tokens || 0,
            outputTokens: usage?.output_tokens || 0,
            cacheReadInputTokens: usage?.cache_read_input_tokens || 0,
          }),
        };
      }

      // Claude Code 接收来自 Gemini 的响应
      if (this.isGeminiSource(sourceType) || this.isGeminiChatSource(sourceType)) {
        return {
          converter: new GeminiToClaudeEventTransform({ model }),
          extractUsage: (usage) => ({
            inputTokens: usage?.input_tokens || 0,
            outputTokens: usage?.output_tokens || 0,
            cacheReadInputTokens: usage?.cache_read_input_tokens || 0,
          }),
        };
      }
    }

    // Codex 接收流式响应
    if (targetType === 'codex') {
      // Codex 接收来自 Claude 的响应
      if (this.isClaudeSource(sourceType) || this.isClaudeChatSource(sourceType)) {
        console.log('[Proxy] Using Claude -> Responses API stream converter');
        return {
          converter: new ClaudeToResponsesEventTransform({ model }),
          extractUsage: (usage) => ({
            inputTokens: usage?.input_tokens || 0,
            outputTokens: usage?.output_tokens || 0,
            totalTokens: (usage?.input_tokens || 0) + (usage?.output_tokens || 0),
          }),
        };
      }

      // Codex 接收来自 OpenAI Chat 的响应
      if (this.isOpenAIChatSource(sourceType)) {
        console.log('[Proxy] Using OpenAI Chat -> Responses API stream converter');
        return {
          converter: new ChatCompletionsToResponsesEventTransform({ model }),
          extractUsage: (usage) => ({
            inputTokens: usage?.input_tokens || 0,
            outputTokens: usage?.output_tokens || 0,
            totalTokens: (usage?.input_tokens || 0) + (usage?.output_tokens || 0),
          }),
        };
      }

      // Codex 接收来自 Gemini 的响应
      if (this.isGeminiSource(sourceType) || this.isGeminiChatSource(sourceType)) {
        console.log('[Proxy] Using Gemini -> Responses API stream converter');
        return {
          converter: new GeminiToResponsesEventTransform({ model }),
          extractUsage: (usage) => ({
            inputTokens: usage?.input_tokens || 0,
            outputTokens: usage?.output_tokens || 0,
            totalTokens: (usage?.input_tokens || 0) + (usage?.output_tokens || 0),
          }),
        };
      }
    }

    // 默认：返回空转换器（不需要转换）
    return { converter: null };
  }

  private extractTokenUsageFromResponse(responseData: any, sourceType: SourceType) {
    if (!responseData) return undefined;

    // Gemini 使用 usageMetadata 字段
    if (this.isGeminiSource(sourceType) || this.isGeminiChatSource(sourceType)) {
      return extractTokenUsageFromGeminiUsage(responseData?.usageMetadata);
    }

    // OpenAI 使用 usage 字段
    if (this.isOpenAIChatSource(sourceType) || this.isOpenAISource(sourceType)) {
      return extractTokenUsageFromOpenAIUsage(responseData.usage);
    }

    // Claude：responseData 可能是 usage 对象本身，也可能包含 usage 字段
    if (this.isClaudeSource(sourceType) || this.isClaudeChatSource(sourceType)) {
      // 如果 responseData 直接包含 input_tokens/output_tokens，说明它本身就是 usage 对象
      if (typeof responseData?.input_tokens === 'number' || typeof responseData?.output_tokens === 'number') {
        return extractTokenUsageFromClaudeUsage(responseData);
      }
      // 否则尝试从 usage 字段提取
      return extractTokenUsageFromClaudeUsage(responseData.usage);
    }

    const usage = responseData.usage;
    if (!usage) return undefined;

    // OpenAI 使用 prompt_tokens 和 completion_tokens
    if (typeof usage?.prompt_tokens === 'number' || typeof usage?.completion_tokens === 'number') {
      return extractTokenUsageFromOpenAIUsage(usage);
    }

    // Claude 使用 input_tokens 和 output_tokens
    if (typeof usage?.input_tokens === 'number' || typeof usage?.output_tokens === 'number') {
      return extractTokenUsageFromClaudeUsage(usage);
    }

    return undefined;
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
    const rawSourceType = service.sourceType || 'openai-chat';
    // 标准化 sourceType，将旧类型转换为新类型（向下兼容）
    const sourceType = normalizeSourceType(rawSourceType);
    const targetType = route.targetType;
    const sessionId = this.defaultExtractSessionId(req, targetType) || '-';

    console.log(`\x1b[32m[Request Start]\x1b[0m client=${targetType}, session=${sessionId}, rule=${rule.id}(${rule.contentType}), service=${service.name}, model=${rule.targetModel || req.body?.model || '-'}`);
    const failoverEnabled = options?.failoverEnabled === true;
    const forwardedToServiceName = options?.forwardedToServiceName;
    const useOriginalConfig = options?.useOriginalConfig === true;
    let relayedForLog = !useOriginalConfig;
    let requestBody: any = req.body || {};
    let usageForLog: TokenUsage | undefined;
    let logged = false;
    const extraTagsForLog: string[] = [];

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

    // 用于收集响应数据的变量
    let responseHeadersForLog: Record<string, string> | undefined;
    let responseBodyForLog: string | undefined;
    let streamChunksForLog: string[] | undefined;
    let downstreamResponseBodyForLog: string | undefined;
    let upstreamRequestForLog: RequestLog['upstreamRequest'] | undefined;
    let actuallyUsedProxy = false; // 标记是否实际使用了代理

    // 标记规则正在使用
    rulesStatusBroadcaster.markRuleInUse(route.id, rule.id);

    const finalizeLog = async (statusCode: number, error?: string) => {
      if (logged) return;

      const isError = statusCode >= 400;
      if (isError) {
        console.log(`\x1b[31m[Request Error]\x1b[0m client=${targetType}, session=${sessionId}, rule=${rule.id}(${rule.contentType}), service=${service.name}, status=${statusCode}, time=${Date.now() - startTime}ms${error ? `, error=${error}` : ''}`);
      } else {
        console.log(`\x1b[33m[Request End]\x1b[0m client=${targetType}, session=${sessionId}, rule=${rule.id}(${rule.contentType}), service=${service.name}, status=${statusCode}, time=${Date.now() - startTime}ms`);
      }

      // 检查是否启用日志记录（默认启用）
      const enableLogging = this.config?.enableLogging !== false; // 默认为 true
      if (!enableLogging) {
        return;
      }

      logged = true;

      // 获取供应商信息
      const vendors = this.dbManager.getVendors();
      const vendor = vendors.find(v => v.id === service.vendorId);

      // 从请求体中提取模型信息
      const requestModel = req.body?.model;

      const tagsForLog = this.buildRelayTags(relayedForLog, useOriginalConfig);
      if (extraTagsForLog.length > 0) {
        tagsForLog.push(...extraTagsForLog);
      }

      await this.dbManager.addLog({
        timestamp: Date.now(),
        method: req.method,
        path: req.originalUrl || req.path,
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
        tags: tagsForLog,
        responseHeaders: responseHeadersForLog,
        responseBody: responseBodyForLog,
        streamChunks: streamChunksForLog,

        upstreamRequest: upstreamRequestForLog,
        downstreamResponseBody: downstreamResponseBodyForLog ?? responseBodyForLog,
      });

      // Session 索引逻辑
      if (sessionId && sessionId !== '-') {
        // 正确计算当前请求的tokens：优先使用totalTokens，否则使用input+output
        const totalTokens = usageForLog?.totalTokens ||
                           ((usageForLog?.inputTokens || 0) + (usageForLog?.outputTokens || 0));
        const sessionTitle = this.defaultExtractSessionTitle(req, sessionId);
        const existingSession = this.dbManager.getSession(sessionId);
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
          highIqMode: rule.contentType === 'high-iq' ? true : existingSession?.highIqMode,
          highIqRuleId: rule.contentType === 'high-iq' ? rule.id : existingSession?.highIqRuleId,
          highIqEnabledAt: rule.contentType === 'high-iq'
            ? (existingSession?.highIqEnabledAt || Date.now())
            : existingSession?.highIqEnabledAt,
        });
      }

      // 更新规则的token使用量（只在成功请求时更新）
      if (usageForLog && statusCode < 400) {
        const totalTokens = usageForLog.totalTokens ||
                          ((usageForLog.inputTokens || 0) + (usageForLog.outputTokens || 0));
        if (totalTokens > 0) {
          this.dbManager.incrementRuleTokenUsage(rule.id, totalTokens);

          // 获取更新后的规则数据并更新状态
          const updatedRule = this.dbManager.getRule(rule.id);
          if (updatedRule) {
            rulesStatusBroadcaster.updateRuleUsage(
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

          // 获取更新后的规则数据并更新状态
          const updatedRule = this.dbManager.getRule(rule.id);
          if (updatedRule) {
            rulesStatusBroadcaster.updateRuleUsage(
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

      // 请求完成后立即更新规则状态
      // 499 Client disconnect 不视为错误，直接恢复为 idle
      if (statusCode === 499) {
        rulesStatusBroadcaster.markRuleIdle(route.id, rule.id);
      } else if (statusCode >= 400) {
        // 请求失败，标记为错误状态
        rulesStatusBroadcaster.markRuleError(route.id, rule.id, error);
      } else {
        // 请求成功，标记为空闲状态
        rulesStatusBroadcaster.markRuleIdle(route.id, rule.id);
      }
    };

    const handleUpstreamHttpError = async (
      statusCode: number,
      responseData: any,
      responseHeaders: any,
      contentType: string
    ) => {
      usageForLog = this.extractTokenUsageFromResponse(responseData, sourceType);
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

    if (this.shouldHandleCountTokensLocally(req, targetType, sourceType)) {
      const inputTokens = this.estimateClaudeCountTokens(requestBody);
      const localTokenResponse = { input_tokens: inputTokens };
      usageForLog = {
        inputTokens,
        outputTokens: 0,
        totalTokens: inputTokens,
      };
      responseHeadersForLog = {
        'content-type': 'application/json; charset=utf-8',
      };
      responseBodyForLog = JSON.stringify(localTokenResponse);
      streamChunksForLog = undefined;
      relayedForLog = false;
      extraTagsForLog.push('系统计算Token直返');
      res.status(200).json(localTokenResponse);
      await finalizeLog(200);
      return;
    }

    const upstreamAbortController = new AbortController();
    const abortUpstreamRequest = (reason: string) => {
      if (!upstreamAbortController.signal.aborted) {
        const abortError = new Error(`Client disconnected: ${reason}`) as Error & { code?: string };
        abortError.code = 'CLIENT_DISCONNECTED';
        upstreamAbortController.abort(abortError);
      }
    };
    const onRequestAborted = () => abortUpstreamRequest('request aborted');
    const onResponseClosed = () => {
      if (!res.writableEnded) {
        abortUpstreamRequest('response stream closed');
      }
    };
    req.once('aborted', onRequestAborted);
    res.once('close', onResponseClosed);

    try {
      // 使用统一的请求转换方法
      const transformedRequestBody = this.transformRequestToUpstream(targetType, sourceType, requestBody, rule.targetModel as string);
      requestBody = transformedRequestBody ?? requestBody ?? {};

      // 应用 max_output_tokens 限制
      requestBody = this.applyMaxOutputTokensLimit(requestBody, service);

      if (this.shouldDefaultStreamingForClaudeBridge(req, targetType, sourceType, requestBody)
          && requestBody?.stream === undefined
          && typeof requestBody === 'object') {
        requestBody.stream = true;
      }

      const streamRequested = this.isStreamRequested(req, requestBody, targetType, sourceType);

      // Build the full URL by appending the request path to the service API URL
      let pathToRequest = req.path;
      if (route.targetType === 'claude-code' && req.path.startsWith('/claude-code')) {
        pathToRequest = req.path.slice('/claude-code'.length);
      } else if (route.targetType === 'codex' && req.path.startsWith('/codex')) {
        pathToRequest = req.path.slice('/codex'.length);
      }

      // 使用 mapRequestPathToUpstreamUrl 统一构建上游 URL
      const model = rule.targetModel || requestBody?.model;
      const apiUrl = service.apiUrl;
      const upstreamUrl = this.mapRequestPathToUpstreamUrl(
        route.targetType,
        sourceType,
        pathToRequest,
        apiUrl,
        model,
        streamRequested
      );

      const config: AxiosRequestConfig = {
        method: req.method as any,
        url: upstreamUrl,
        headers: this.buildUpstreamHeaders(req, service, sourceType, streamRequested, requestBody),
        timeout: rule.timeout || 3000000, // 默认300秒
        validateStatus: () => true,
        responseType: streamRequested ? 'stream' : 'json',
        signal: upstreamAbortController.signal,
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

      const ensureResponseWritable = () => {
        if (this.isDownstreamClosed(res)) {
          const disconnectError = new Error('Client disconnected before stream pipeline setup') as Error & { code?: string };
          disconnectError.code = 'CLIENT_DISCONNECTED';
          throw disconnectError;
        }
      };

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
        // 统一走默认流式链路（transformSSEToTool + 统一断连保护），避免历史分支行为不一致
        const useLegacySpecialSSEBranches = false;

        if (useLegacySpecialSSEBranches && targetType === 'claude-code' && this.isOpenAIType(sourceType)) {
          res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
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
            console.log('[Proxy] Claude Code stream: converter usage:', usage);
            if (usage) {
              usageForLog = extractTokenUsageFromClaudeUsage(usage);
              console.log('[Proxy] Claude Code stream: usageForLog from converter:', usageForLog);
            }

            // 尝试从event collector中提取usage（作为补充）
            const extractedUsage = eventCollector.extractUsage();
            console.log('[Proxy] Claude Code stream: extracted usage from eventCollector:', extractedUsage);
            if (!usageForLog && extractedUsage) {
              usageForLog = this.extractTokenUsageFromResponse(extractedUsage, sourceType);
              console.log('[Proxy] Claude Code stream: usageForLog from eventCollector:', usageForLog);
            }

            // 收集stream chunks（每个chunk是一个完整的SSE事件）
            streamChunksForLog = eventCollector.getChunks();
            // 将所有 chunks 合并成完整的响应体用于日志记录
            responseBodyForLog = streamChunksForLog.join('\n');
            console.log('[Proxy] Stream request finished, collected chunks:', streamChunksForLog?.length || 0);
            console.log('[Proxy] Response body length:', responseBodyForLog?.length || 0);
            console.log('[Proxy] Claude Code stream: final usageForLog before finalizeLog:', usageForLog);
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

        if (useLegacySpecialSSEBranches && targetType === 'codex' && this.isClaudeSource(sourceType)) {
          res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
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
            console.log('[Proxy] Codex stream: converter usage:', usage);
            if (usage) {
              usageForLog = extractTokenUsageFromOpenAIUsage(usage);
              console.log('[Proxy] Codex stream: usageForLog from converter:', usageForLog);
            }

            // 尝试从event collector中提取usage（作为补充）
            const extractedUsage = eventCollector.extractUsage();
            console.log('[Proxy] Codex stream: extracted usage from eventCollector:', extractedUsage);
            if (!usageForLog && extractedUsage) {
              usageForLog = this.extractTokenUsageFromResponse(extractedUsage, sourceType);
              console.log('[Proxy] Codex stream: usageForLog from eventCollector:', usageForLog);
            }

            streamChunksForLog = eventCollector.getChunks();
            // 将所有 chunks 合并成完整的响应体用于日志记录
            responseBodyForLog = streamChunksForLog.join('\n');
            console.log('[Proxy] Codex stream request finished, collected chunks:', streamChunksForLog?.length || 0);
            console.log('[Proxy] Response body length:', responseBodyForLog?.length || 0);
            console.log('[Proxy] Codex stream: final usageForLog before finalizeLog:', usageForLog);
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
        if (useLegacySpecialSSEBranches && targetType === 'claude-code' && (this.isGeminiSource(sourceType) || this.isGeminiChatSource(sourceType))) {
          res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
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
                inputTokens: usage?.input_tokens || 0,
                outputTokens: usage?.output_tokens || 0,
                cacheReadInputTokens: usage?.cache_read_input_tokens || 0,
              };
            } else {
              const extractedUsage = eventCollector.extractUsage();
              if (extractedUsage) {
                usageForLog = this.extractTokenUsageFromResponse(extractedUsage, sourceType);
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
        if (useLegacySpecialSSEBranches && targetType === 'codex' && (this.isGeminiSource(sourceType) || this.isGeminiChatSource(sourceType))) {
          res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
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
                usageForLog = this.extractTokenUsageFromResponse(extractedUsage, sourceType);
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
        const downstreamChunkCollector = new ChunkCollectorTransform();
        responseHeadersForLog = this.normalizeResponseHeaders(responseHeaders);

        // 使用 transformSSEToTool 方法选择转换器
        const { converter, extractUsage } = this.transformSSEToTool(targetType, sourceType, requestBody?.model);

        this.copyResponseHeaders(responseHeaders, res);

        // 收集日志：responseBody/streamChunks 记录上游原始响应；downstreamResponseBody 记录实际下发内容
        const finalizeChunks = () => {
          const upstreamChunks = eventCollector.getChunks();
          streamChunksForLog = upstreamChunks;
          responseBodyForLog = upstreamChunks.join('\n');

          const downstreamChunks = downstreamChunkCollector.getChunks();
          downstreamResponseBodyForLog = downstreamChunks.join('');

          // 尝试从event collector或converter中提取usage信息
          let extractedUsage = eventCollector.extractUsage();
          if (converter && typeof (converter as any).getUsage === 'function') {
            const converterUsage = (converter as any).getUsage();
            if (converterUsage) {
              extractedUsage = converterUsage || extractedUsage;
            }
          }

          // 如果有自定义的 extractUsage 函数，使用它
          if (extractUsage && extractedUsage) {
            usageForLog = extractUsage(extractedUsage);
          } else if (extractedUsage) {
            usageForLog = this.extractTokenUsageFromResponse(extractedUsage, sourceType);
          }

          void finalizeLog(res.statusCode);
        };

        // 在下游 chunk 收集器完成后执行，确保拿到真正下发给客户端的完整文本
        downstreamChunkCollector.on('finish', () => {
          finalizeChunks();
        });

        // 备用：如果eventCollector的finish没有触发，监听res的finish
        res.on('finish', () => {
          if (!streamChunksForLog) {
            finalizeChunks();
          }
        });

        // 监听 res 的错误事件
        res.on('error', (err) => {
          console.error('[Proxy] Response stream error:', err);
        });

        // 构建 pipeline，根据是否需要转换选择不同的处理链
        if (converter) {
          ensureResponseWritable();
          pipeline(response.data, parser, eventCollector, converter, serializer, downstreamChunkCollector, res, async (error) => {
            if (error) {
              if (this.isClientDisconnectError(error, res)) {
                console.warn('[Proxy] Default stream pipeline closed because client disconnected');
                await finalizeLog(499, 'Client disconnected');
                return;
              }
              console.error('[Proxy] Pipeline error (default stream with converter):', error);

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
        } else {
          ensureResponseWritable();
          pipeline(response.data, parser, eventCollector, serializer, downstreamChunkCollector, res, async (error) => {
            if (error) {
              if (this.isClientDisconnectError(error, res)) {
                console.warn('[Proxy] Default stream pipeline closed because client disconnected');
                await finalizeLog(499, 'Client disconnected');
                return;
              }
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
        }
        return;
      }

      let responseData = response.data;
      if (streamRequested && response.data && typeof response.data.on === 'function' && !isEventStream) {
        const raw = await this.readStreamBody(response.data);
        responseData = this.safeJsonParse(raw) ?? raw;
      }

      // 收集响应头
      responseHeadersForLog = this.normalizeResponseHeaders(responseHeaders);

      // 使用统一的响应转换方法
      const converted = this.transformResponseToTool(targetType, sourceType, responseData);

      // 提取 token usage（从原始响应数据中提取）
      usageForLog = this.extractTokenUsageFromResponse(responseData, sourceType);
      console.log('[Proxy] Non-stream response: extracted usageForLog:', usageForLog);

      this.copyResponseHeaders(responseHeaders, res);

      if (converted && converted !== responseData) {
        // 非流式：responseBody 记录上游原始响应，downstreamResponseBody 记录转换后下发内容
        responseBodyForLog = typeof responseData === 'string' ? responseData : JSON.stringify(responseData);
        downstreamResponseBodyForLog = JSON.stringify(converted);
        res.status(response.status).json(converted);
      } else {
        // 没有转换，使用原始数据
        responseBodyForLog = typeof responseData === 'string' ? responseData : JSON.stringify(responseData);
        downstreamResponseBodyForLog = responseBodyForLog;
        console.log('[Proxy] Non-stream response logged, body length:', responseBodyForLog?.length || 0);
        if (contentType.includes('application/json')) {
          res.status(response.status).json(responseData);
        } else {
          res.status(response.status).send(responseData);
        }
      }

      await finalizeLog(res.statusCode);
    } catch (error: any) {
      if (this.isClientDisconnectError(error, res)) {
        console.warn('[Proxy] Client disconnected, skipping failover and blacklist');
        await finalizeLog(499, 'Client disconnected');
        return;
      }

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

      if (this.isResponseCommitted(res)) {
        return;
      }

      // 根据请求类型返回适当格式的错误响应
      const streamRequested = this.isStreamRequested(req, req.body || {}, targetType, sourceType);

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
          res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
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
    } finally {
      req.off('aborted', onRequestAborted);
      res.off('close', onResponseClosed);
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
