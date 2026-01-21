import express, { Request, Response, NextFunction } from 'express';
import axios, { AxiosRequestConfig } from 'axios';
import { pipeline } from 'stream';
import { DatabaseManager } from './database';
import {
  ClaudeToOpenAIResponsesEventTransform,
  OpenAIResponsesToClaudeEventTransform,
  OpenAIToClaudeEventTransform,
  SSEParserTransform,
  SSESerializerTransform,
} from './transformers/streaming';
import { ChunkCollectorTransform } from './transformers/chunk-collector';
import {
  extractTokenUsageFromClaudeUsage,
  extractTokenUsageFromOpenAIUsage,
  transformClaudeRequestToOpenAIChat,
  transformOpenAIChatResponseToClaude,
} from './transformers/claude-openai';
import {
  extractTokenUsageFromOpenAIResponsesUsage,
  transformClaudeRequestToOpenAIResponses,
  transformClaudeResponseToOpenAIResponses,
  transformOpenAIResponsesRequestToClaude,
  transformOpenAIResponsesRequestToOpenAIChat,
  transformOpenAIResponsesToClaude,
} from './transformers/openai-responses';
import type { AppConfig, Rule, APIService, Route, SourceType, TokenUsage, ContentType } from '../types';

type ContentTypeDetector = {
  type: ContentType;
  match: (req: Request, body: any) => boolean;
};

const SUPPORTED_TARGETS = ['claude-code', 'codex'];

export class ProxyServer {
  private app: express.Application;
  private dbManager: DatabaseManager;
  private routes: Route[] = [];
  private rules: Map<string, Rule[]> = new Map();
  private services: Map<string, APIService> = new Map();
  private config: AppConfig;

  constructor(dbManager: DatabaseManager, app: express.Application) {
    this.dbManager = dbManager;
    this.config = dbManager.getConfig();
    this.app = app;
  }

  private setupMiddleware() {
    // Access logging middleware
    this.app.use(async (req: Request, res: Response, next: NextFunction) => {
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

      res.send = (data: any) => {
        res.send = originalSend;
        const responseTime = Date.now() - startTime;
        accessLog.then((accessLogId) => {
          this.dbManager.updateAccessLog(accessLogId, {
            responseTime,
            statusCode: res.statusCode,
          });
        });
        return originalSend(data);
      };

      res.json = (data: any) => {
        res.json = originalJson;
        const responseTime = Date.now() - startTime;
        accessLog.then((accessLogId) => {
          this.dbManager.updateAccessLog(accessLogId, {
            responseTime,
            statusCode: res.statusCode,
          });
        });
        return originalJson(data);
      };

      res.on('error', (err) => {
        accessLog.then((accessLogId) => {
          this.dbManager.updateAccessLog(accessLogId, {
            statusCode: res.statusCode,
            error: err.message,
          });
        });
      });

      next();
    });

    // Logging middleware (legacy RequestLog)
    this.app.use(async (req: Request, res: Response, next: NextFunction) => {
      const startTime = Date.now();
      const originalSend = res.send.bind(res);

      if (SUPPORTED_TARGETS.some(target => req.path.startsWith(`/${target}/`))) {
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
      // 根路径 / 不应该被代理中间件处理，应该传递给静态文件服务
      if (req.path === '/') {
        return next();
      }

      try {
        const route = this.findMatchingRoute(req);
        if (!route) {
          return res.status(404).json({ error: 'No matching route found' });
        }

        const rule = this.findMatchingRule(route.id, req);
        if (!rule) {
          return res.status(404).json({ error: 'No matching rule found' });
        }

        const service = this.services.get(rule.targetServiceId);
        if (!service) {
          return res.status(500).json({ error: 'Target service not configured' });
        }

        await this.proxyRequest(req, res, route, rule, service);
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
        res.status(500).json({ error: error.message });
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

        const rule = this.findMatchingRule(route.id, req);
        if (!rule) {
          return res.status(404).json({ error: 'No matching rule found' });
        }

        const service = this.services.get(rule.targetServiceId);
        if (!service) {
          return res.status(500).json({ error: 'Target service not configured' });
        }

        await this.proxyRequest(req, res, route, rule, service);
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

  private findMatchingRoute(_req: Request): Route | undefined {
    // Find active route based on targetType - for now, return the first active route
    // This can be extended later based on specific routing logic
    return this.routes.find(route => route.isActive);
  }

  private findRouteByTargetType(targetType: 'claude-code' | 'codex'): Route | undefined {
    return this.routes.find(route => route.targetType === targetType && route.isActive);
  }

  private findMatchingRule(routeId: string, req: Request): Rule | undefined {
    const rules = this.rules.get(routeId);
    if (!rules) return undefined;

    // Determine content type from request
    const contentType = this.determineContentType(req);
    return rules.find(rule => rule.contentType === contentType) || rules.find(rule => rule.contentType === 'default');
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
    return sourceType === 'claude-chat' || sourceType === 'claude-code';
  }

  private isOpenAIChatSource(sourceType: SourceType) {
    return sourceType === 'openai-chat' || sourceType === 'openai-code' || sourceType === 'deepseek-chat';
  }

  private isOpenAIResponsesSource(sourceType: SourceType) {
    return sourceType === 'openai-responses';
  }

  private applyModelOverride(body: any, rule: Rule) {
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
    if (typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number' && usage.prompt_tokens === undefined) {
      return extractTokenUsageFromOpenAIResponsesUsage(usage);
    }
    if (typeof usage.prompt_tokens === 'number' || typeof usage.completion_tokens === 'number') {
      return extractTokenUsageFromOpenAIUsage(usage);
    }
    if (typeof usage.input_tokens === 'number' || typeof usage.output_tokens === 'number') {
      return extractTokenUsageFromClaudeUsage(usage);
    }
    return undefined;
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

    const finalizeLog = async (statusCode: number, error?: string) => {
      if (logged || !this.config?.enableLogging) return;
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
      });
    };

    try {
      if (targetType === 'claude-code') {
        if (this.isClaudeSource(sourceType)) {
          requestBody = this.applyModelOverride(requestBody, rule);
        } else if (this.isOpenAIChatSource(sourceType)) {
          requestBody = transformClaudeRequestToOpenAIChat(requestBody, rule.targetModel);
        } else if (this.isOpenAIResponsesSource(sourceType)) {
          requestBody = transformClaudeRequestToOpenAIResponses(requestBody, rule.targetModel);
        } else {
          res.status(400).json({ error: 'Unsupported source type for Claude Code.' });
          await finalizeLog(400, 'Unsupported source type for Claude Code');
          return;
        }
      } else if (targetType === 'codex') {
        if (this.isOpenAIResponsesSource(sourceType)) {
          requestBody = this.applyModelOverride(requestBody, rule);
        } else if (this.isOpenAIChatSource(sourceType)) {
          requestBody = transformOpenAIResponsesRequestToOpenAIChat(requestBody, rule.targetModel);
        } else if (this.isClaudeSource(sourceType)) {
          requestBody = transformOpenAIResponsesRequestToClaude(requestBody, rule.targetModel);
        } else {
          res.status(400).json({ error: 'Codex requires an OpenAI Responses compatible source.' });
          await finalizeLog(400, 'Unsupported source type for Codex');
          return;
        }
      }

      const streamRequested = this.isStreamRequested(req, requestBody);

      const config: AxiosRequestConfig = {
        method: req.method as any,
        url: service.apiUrl,
        headers: this.buildUpstreamHeaders(req, service, sourceType, streamRequested),
        timeout: service.timeout || 30000,
        validateStatus: () => true,
        responseType: streamRequested ? 'stream' : 'json',
      };

      if (Object.keys(req.query).length > 0) {
        config.params = req.query;
      }

      if (['POST', 'PUT', 'PATCH'].includes(req.method.toUpperCase())) {
        config.data = requestBody;
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
          const chunkCollector = new ChunkCollectorTransform();
          const converter = new OpenAIToClaudeEventTransform({ model: requestBody?.model });
          const serializer = new SSESerializerTransform();

          // 收集响应头
          responseHeadersForLog = this.normalizeResponseHeaders(responseHeaders);

          res.on('finish', () => {
            const usage = converter.getUsage();
            if (usage) {
              usageForLog = extractTokenUsageFromClaudeUsage(usage);
            }
            // 收集stream chunks
            streamChunksForLog = chunkCollector.getChunks();
            void finalizeLog(res.statusCode);
          });

          pipeline(response.data, parser, chunkCollector, converter, serializer, res, (error) => {
            if (error) {
              void finalizeLog(500, error.message);
            }
          });
          return;
        }

        if (targetType === 'claude-code' && this.isOpenAIResponsesSource(sourceType)) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');

          const parser = new SSEParserTransform();
          const chunkCollector = new ChunkCollectorTransform();
          const converter = new OpenAIResponsesToClaudeEventTransform({ model: requestBody?.model });
          const serializer = new SSESerializerTransform();

          responseHeadersForLog = this.normalizeResponseHeaders(responseHeaders);

          res.on('finish', () => {
            const usage = converter.getUsage();
            if (usage) {
              usageForLog = extractTokenUsageFromClaudeUsage(usage);
            }
            streamChunksForLog = chunkCollector.getChunks();
            void finalizeLog(res.statusCode);
          });

          pipeline(response.data, parser, chunkCollector, converter, serializer, res, (error) => {
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
          const chunkCollector = new ChunkCollectorTransform();
          const converter = new ClaudeToOpenAIResponsesEventTransform({ model: requestBody?.model });
          const serializer = new SSESerializerTransform();

          responseHeadersForLog = this.normalizeResponseHeaders(responseHeaders);

          res.on('finish', () => {
            const usage = converter.getUsage();
            if (usage) {
              usageForLog = extractTokenUsageFromClaudeUsage(usage);
            }
            streamChunksForLog = chunkCollector.getChunks();
            void finalizeLog(res.statusCode);
          });

          pipeline(response.data, parser, chunkCollector, converter, serializer, res, (error) => {
            if (error) {
              void finalizeLog(500, error.message);
            }
          });
          return;
        }

        if (targetType === 'codex' && this.isOpenAIChatSource(sourceType)) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');

          const parser = new SSEParserTransform();
          const chunkCollector = new ChunkCollectorTransform();
          const toClaude = new OpenAIToClaudeEventTransform({ model: requestBody?.model });
          const toResponses = new ClaudeToOpenAIResponsesEventTransform({ model: requestBody?.model });
          const serializer = new SSESerializerTransform();

          responseHeadersForLog = this.normalizeResponseHeaders(responseHeaders);

          res.on('finish', () => {
            const usage = toResponses.getUsage();
            if (usage) {
              usageForLog = extractTokenUsageFromClaudeUsage(usage);
            }
            streamChunksForLog = chunkCollector.getChunks();
            void finalizeLog(res.statusCode);
          });

          pipeline(response.data, parser, chunkCollector, toClaude, toResponses, serializer, res, (error) => {
            if (error) {
              void finalizeLog(500, error.message);
            }
          });
          return;
        }

        // 默认stream处理(无转换)
        const chunkCollector = new ChunkCollectorTransform();
        responseHeadersForLog = this.normalizeResponseHeaders(responseHeaders);

        this.copyResponseHeaders(responseHeaders, res);
        res.on('finish', () => {
          streamChunksForLog = chunkCollector.getChunks();
          // 尝试从stream chunks中解析usage信息
          if (streamChunksForLog && streamChunksForLog.length > 0) {
            // 合并所有chunks并尝试解析usage
            const allChunks = streamChunksForLog.join('');
            // 查找包含usage信息的部分
            const usageMatch = allChunks.match(/usage[\s\S]*?\{[\s\S]*?\}/);
            if (usageMatch) {
              try {
                // 尝试解析usage信息
                const usageStr = usageMatch[0];
                const jsonStart = usageStr.indexOf('{');
                const jsonEnd = usageStr.lastIndexOf('}') + 1;
                const usageJson = JSON.parse(usageStr.slice(jsonStart, jsonEnd));
                usageForLog = this.extractTokenUsage(usageJson);
              } catch (e) {
                console.error('Failed to parse usage from stream chunks:', e);
              }
            }
          }
          void finalizeLog(res.statusCode);
        });
        pipeline(response.data, chunkCollector, res, (error) => {
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
      } else if (targetType === 'claude-code' && this.isOpenAIResponsesSource(sourceType)) {
        const converted = transformOpenAIResponsesToClaude(responseData);
        usageForLog = extractTokenUsageFromOpenAIResponsesUsage(responseData?.usage);
        responseBodyForLog = JSON.stringify(converted);
        res.status(response.status).json(converted);
      } else if (targetType === 'codex' && this.isClaudeSource(sourceType)) {
        const converted = transformClaudeResponseToOpenAIResponses(responseData);
        usageForLog = extractTokenUsageFromClaudeUsage(responseData?.usage);
        responseBodyForLog = JSON.stringify(converted);
        res.status(response.status).json(converted);
      } else if (targetType === 'codex' && this.isOpenAIChatSource(sourceType)) {
        const claudeResponse = transformOpenAIChatResponseToClaude(responseData);
        const converted = transformClaudeResponseToOpenAIResponses(claudeResponse);
        usageForLog = extractTokenUsageFromOpenAIUsage(responseData?.usage);
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
      await finalizeLog(500, error.message);
      res.status(500).json({ error: error.message });
    }
  }

  async reloadRoutes() {
    this.routes = this.dbManager.getRoutes().filter((g) => g.isActive);
    this.rules.clear();

    for (const route of this.routes) {
      const routeRules = this.dbManager.getRules(route.id);
      this.rules.set(route.id, routeRules);
    }

    // Load all services
    const allServices = this.dbManager.getAPIServices();
    this.services.clear();
    allServices.forEach((service) => {
      this.services.set(service.id, service);
    });

    console.log(`Loaded ${this.routes.length} active routes and ${this.services.size} services`);
  }

  async updateConfig(config: AppConfig) {
    this.config = config;
  }

  async initialize() {
    this.setupMiddleware();
    await this.reloadRoutes();
  }
}
