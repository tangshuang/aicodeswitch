import fs from 'fs';
import path from 'path';
import os from 'os';
import type { TargetType, SourceType, AuthType } from '../types';
import { AuthType as AuthTypeEnum } from '../types';
import toml from '@iarna/toml';

/**
 * 原始配置信息
 */
export interface OriginalConfig {
  apiUrl: string;
  apiKey: string;
  authType: AuthType;
  sourceType?: SourceType;
  model?: string;
  claudeDefaultModels?: {
    haiku?: string;
    sonnet?: string;
    opus?: string;
  };
}

/**
 * TOML 解析器（使用 @iarna/toml 库）
 */
const parseToml = (content: string): Record<string, any> => {
  try {
    return toml.parse(content);
  } catch (error) {
    console.warn('Failed to parse TOML file:', error);
    return {}; // 返回空对象以保持兼容性
  }
};

const normalizeApiUrl = (value: string): string => {
  return value.replace(/\/+$/, '');
};

const inferSourceTypeFromBaseUrlAndWireApi = (baseUrl: string, wireApi?: string): SourceType => {
  const lowerBaseUrl = baseUrl.toLowerCase();
  const normalizedWireApi = (wireApi || '').toLowerCase();

  if (lowerBaseUrl.includes('anthropic')) {
    return normalizedWireApi === 'chat' ? 'claude-chat' : 'claude';
  }

  if (
    lowerBaseUrl.includes('generativelanguage.googleapis.com') ||
    lowerBaseUrl.includes('aiplatform.googleapis.com') ||
    lowerBaseUrl.includes('vertexai')
  ) {
    return normalizedWireApi === 'chat' ? 'gemini-chat' : 'gemini';
  }

  if (lowerBaseUrl.includes('deepseek')) {
    return 'deepseek-reasoning-chat';
  }

  if (normalizedWireApi === 'chat') {
    return 'openai-chat';
  }

  return 'openai';
};

const inferAuthTypeFromSource = (sourceType: SourceType): AuthType => {
  if (sourceType === 'gemini' || sourceType === 'gemini-chat') {
    return AuthTypeEnum.G_API_KEY;
  }
  if (sourceType === 'claude' || sourceType === 'claude-chat') {
    return AuthTypeEnum.API_KEY;
  }
  return AuthTypeEnum.AUTH_TOKEN;
};

const getProviderCandidateKeys = (providerName?: string): string[] => {
  if (!providerName) {
    return [];
  }

  const upper = providerName.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const lower = providerName.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return [
    `${upper}_API_KEY`,
    `${upper}_AUTH_TOKEN`,
    `${lower}_api_key`,
    `${lower}_auth_token`,
  ];
};

const pickApiKey = (authConfig: Record<string, any>, candidates: string[]): string => {
  for (const key of candidates) {
    const value = authConfig[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
};

/**
 * 读取 Claude Code 原始配置
 * fallback 场景下仅从备份文件读取
 */
export const readClaudeOriginalConfig = (): OriginalConfig | null => {
  try {
    const homeDir = os.homedir();
    const settingsBakPath = path.join(homeDir, '.claude/settings.json.aicodeswitch_backup');

    // fallback 只读取备份文件，确保使用真实上游配置
    if (!fs.existsSync(settingsBakPath)) {
      console.log('No Claude backup config file found');
      return null;
    }

    const content = fs.readFileSync(settingsBakPath, 'utf-8');
    const config = JSON.parse(content);

    // 提取配置信息
    const baseUrlRaw = config.env?.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
    const baseUrl = normalizeApiUrl(baseUrlRaw);
    const authToken = typeof config.env?.ANTHROPIC_AUTH_TOKEN === 'string' ? config.env.ANTHROPIC_AUTH_TOKEN : '';
    const apiKeyValue = typeof config.env?.ANTHROPIC_API_KEY === 'string' ? config.env.ANTHROPIC_API_KEY : '';
    const apiKey = (authToken || apiKeyValue).trim();
    const defaultHaikuModel = typeof config.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL === 'string'
      ? config.env.ANTHROPIC_DEFAULT_HAIKU_MODEL.trim()
      : '';
    const defaultSonnetModel = typeof config.env?.ANTHROPIC_DEFAULT_SONNET_MODEL === 'string'
      ? config.env.ANTHROPIC_DEFAULT_SONNET_MODEL.trim()
      : '';
    const defaultOpusModel = typeof config.env?.ANTHROPIC_DEFAULT_OPUS_MODEL === 'string'
      ? config.env.ANTHROPIC_DEFAULT_OPUS_MODEL.trim()
      : '';

    if (!apiKey) {
      console.log('No API key found in Claude config');
      return null;
    }

    return {
      apiUrl: baseUrl,
      apiKey: apiKey,
      authType: authToken ? AuthTypeEnum.AUTH_TOKEN : AuthTypeEnum.API_KEY,
      sourceType: 'claude',
      claudeDefaultModels: {
        haiku: defaultHaikuModel || undefined,
        sonnet: defaultSonnetModel || undefined,
        opus: defaultOpusModel || undefined,
      },
    };
  } catch (error) {
    console.error('Failed to read Claude original config:', error);
    return null;
  }
};

/**
 * 读取 Codex 原始配置
 * fallback 场景下仅从备份文件读取
 */
export const readCodexOriginalConfig = (): OriginalConfig | null => {
  try {
    const homeDir = os.homedir();
    const configBakPath = path.join(homeDir, '.codex/config.toml.aicodeswitch_backup');
    const authBakPath = path.join(homeDir, '.codex/auth.json.aicodeswitch_backup');

    // fallback 只读取备份文件，确保使用真实上游配置
    if (!fs.existsSync(configBakPath)) {
      console.log('No Codex backup config file found');
      return null;
    }

    const tomlContent = fs.readFileSync(configBakPath, 'utf-8');
    const config = parseToml(tomlContent);

    // 提取 provider 配置
    let baseUrl = '';
    let wireApi = '';
    const model = typeof config.model === 'string' ? config.model : undefined;
    const providerName = typeof config.model_provider === 'string' ? config.model_provider : undefined;

    // 从 model_providers 中查找配置
    if (config.model_providers && typeof config.model_providers === 'object') {
      const providers = config.model_providers as Record<string, any>;
      if (providerName && providers[providerName]) {
        const providerConfig = providers[providerName];
        if (typeof providerConfig?.base_url === 'string') {
          baseUrl = providerConfig.base_url;
        }
        if (typeof providerConfig?.wire_api === 'string') {
          wireApi = providerConfig.wire_api;
        }
      } else {
        const firstProvider = Object.values(providers).find(provider => typeof provider?.base_url === 'string') as Record<string, any> | undefined;
        if (firstProvider) {
          baseUrl = firstProvider.base_url;
          if (typeof firstProvider.wire_api === 'string') {
            wireApi = firstProvider.wire_api;
          }
        }
      }
    }

    if (!baseUrl) {
      if (typeof config.base_url === 'string' && config.base_url.trim()) {
        baseUrl = config.base_url;
      }
    }

    if (!baseUrl) {
      console.log('No base_url found in Codex config');
      return null;
    }

    const normalizedBaseUrl = normalizeApiUrl(baseUrl);
    const sourceType = inferSourceTypeFromBaseUrlAndWireApi(normalizedBaseUrl, wireApi);

    // 读取 API key（从 auth.json.aicodeswitch_backup）
    let apiKey = '';
    if (fs.existsSync(authBakPath)) {
      try {
        const authContent = fs.readFileSync(authBakPath, 'utf-8');
        const authConfig = JSON.parse(authContent) as Record<string, any>;
        const providerCandidateKeys = getProviderCandidateKeys(providerName);
        const sourceTypeKeys: string[] = sourceType === 'claude' || sourceType === 'claude-chat'
          ? ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']
          : sourceType === 'gemini' || sourceType === 'gemini-chat'
            ? ['GEMINI_API_KEY', 'GOOGLE_API_KEY']
            : ['OPENAI_API_KEY', 'DEEPSEEK_API_KEY'];
        const commonKeys = ['api_key', 'openai_api_key', 'key'];

        apiKey = pickApiKey(authConfig, [
          ...providerCandidateKeys,
          ...sourceTypeKeys,
          ...commonKeys,
        ]);
      } catch (error) {
        console.error('Failed to read Codex auth backup:', error);
      }
    } else {
      console.log('No Codex backup auth file found');
    }

    // 某些配置会把 key 内联在 provider 中
    if (!apiKey && config.model_providers && providerName) {
      const providerConfig = (config.model_providers as Record<string, any>)[providerName];
      if (providerConfig && typeof providerConfig.api_key === 'string' && providerConfig.api_key.trim()) {
        apiKey = providerConfig.api_key.trim();
      }
    }

    if (!apiKey) {
      console.log('No API key found in Codex backup config/auth');
      return null;
    }

    return {
      apiUrl: normalizedBaseUrl,
      apiKey: apiKey,
      authType: inferAuthTypeFromSource(sourceType),
      sourceType,
      model: model,
    };
  } catch (error) {
    console.error('Failed to read Codex original config:', error);
    return null;
  }
};

/**
 * 根据目标类型读取原始配置
 */
export const readOriginalConfig = (targetType: TargetType): OriginalConfig | null => {
  if (targetType === 'claude-code') {
    return readClaudeOriginalConfig();
  } else if (targetType === 'codex') {
    return readCodexOriginalConfig();
  }
  return null;
};
