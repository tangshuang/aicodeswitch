import fs from 'fs';
import path from 'path';
import os from 'os';
import type { TargetType, SourceType, AuthType } from '../types';
import { AuthType as AuthTypeEnum } from '../types';

/**
 * 原始配置信息
 */
export interface OriginalConfig {
  apiUrl: string;
  apiKey: string;
  authType: AuthType;
  sourceType?: SourceType;
  model?: string;
}

/**
 * TOML 解析器（简单实现，仅用于解析 Codex config.toml）
 */
const parseToml = (content: string): Record<string, any> => {
  const result: Record<string, any> = {};
  let currentSection = result;

  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();

    // 跳过空行和注释
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    // 检查是否是 section
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      const sectionPath = sectionMatch[1].split('.');
      currentSection = result;

      for (const key of sectionPath) {
        if (!currentSection[key]) {
          currentSection[key] = {};
        }
        currentSection = currentSection[key];
      }
      continue;
    }

    // 解析键值对
    const kvMatch = trimmed.match(/^([^=]+)=(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1].trim();
      let value: any = kvMatch[2].trim();

      // 移除引号
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      // 尝试转换为布尔值
      if (value === 'true') {
        value = true;
      } else if (value === 'false') {
        value = false;
      }

      currentSection[key] = value;
    }
  }

  return result;
};

/**
 * 读取 Claude Code 原始配置
 * 从备份文件或当前配置文件中读取（如果未激活路由）
 */
export const readClaudeOriginalConfig = (): OriginalConfig | null => {
  try {
    const homeDir = os.homedir();
    const settingsPath = path.join(homeDir, '.claude/settings.json');
    const settingsBakPath = path.join(homeDir, '.claude/settings.json.aicodeswitch_backup');

    // 优先读取备份文件（原始配置）
    let configPath = settingsBakPath;
    if (!fs.existsSync(configPath)) {
      // 如果没有备份，尝试读取当前配置
      configPath = settingsPath;
      if (!fs.existsSync(configPath)) {
        console.log('No Claude config file found');
        return null;
      }
    }

    const content = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content);

    // 提取配置信息
    const baseUrl = config.env?.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
    const apiKey = config.env?.ANTHROPIC_AUTH_TOKEN || config.env?.ANTHROPIC_API_KEY || '';

    if (!apiKey) {
      console.log('No API key found in Claude config');
      return null;
    }

    return {
      apiUrl: baseUrl,
      apiKey: apiKey,
      authType: AuthTypeEnum.AUTH_TOKEN,
      sourceType: 'claude',
    };
  } catch (error) {
    console.error('Failed to read Claude original config:', error);
    return null;
  }
};

/**
 * 读取 Codex 原始配置
 * 从备份文件或当前配置文件中读取（如果未激活路由）
 */
export const readCodexOriginalConfig = (): OriginalConfig | null => {
  try {
    const homeDir = os.homedir();
    const configPath = path.join(homeDir, '.codex/config.toml');
    const configBakPath = path.join(homeDir, '.codex/config.toml.aicodeswitch_backup');
    const authPath = path.join(homeDir, '.codex/auth.json');

    // 优先读取备份文件（原始配置）
    let tomlPath = configBakPath;
    if (!fs.existsSync(tomlPath)) {
      // 如果没有备份，尝试读取当前配置
      tomlPath = configPath;
      if (!fs.existsSync(tomlPath)) {
        console.log('No Codex config file found');
        return null;
      }
    }

    const tomlContent = fs.readFileSync(tomlPath, 'utf-8');
    const config = parseToml(tomlContent);

    // 提取 base_url
    let baseUrl = '';
    let model = config.model;

    // 从 model_providers 中查找配置
    if (config.model_providers) {
      const providerName = config.model_provider;
      if (providerName && config.model_providers[providerName]) {
        baseUrl = config.model_providers[providerName].base_url;
      }
    }

    if (!baseUrl) {
      console.log('No base_url found in Codex config');
      return null;
    }

    // 读取 API key（从 auth.json）
    let apiKey = '';
    if (fs.existsSync(authPath)) {
      try {
        const authContent = fs.readFileSync(authPath, 'utf-8');
        const authConfig = JSON.parse(authContent);
        // Codex 的 auth.json 可能包含多个 provider 的 key
        // 尝试读取常见的字段
        apiKey = authConfig.api_key || authConfig.openai_api_key || authConfig.key || '';
      } catch (error) {
        console.error('Failed to read Codex auth.json:', error);
      }
    }

    if (!apiKey) {
      console.log('No API key found in Codex auth.json');
      return null;
    }

    return {
      apiUrl: baseUrl,
      apiKey: apiKey,
      authType: AuthTypeEnum.API_KEY,
      sourceType: 'openai',
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
