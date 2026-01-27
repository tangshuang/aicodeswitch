import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * 配置元数据结构
 */
export interface ConfigMetadata {
  configType: 'claude' | 'codex';
  timestamp: number; // 写入时间戳
  originalHash?: string; // 原始配置文件的 SHA256 hash(如果存在)
  proxyMarker: string; // 代理配置标记(用于识别当前配置是否是我们的代理配置)
  files: {
    originalPath: string;
    backupPath: string;
    currentHash?: string; // 写入时代理配置的 hash
  }[];
}

/**
 * 配置状态
 */
export interface ConfigStatus {
  isOverwritten: boolean; // 是否已被我们覆盖
  isModified: boolean; // 用户是否修改了我们的代理配置
  hasBackup: boolean; // 是否有备份文件
  metadata?: ConfigMetadata; // 元数据(如果存在)
}

/**
 * 获取元数据文件路径
 */
const getMetadataFilePath = (configType: 'claude' | 'codex'): string => {
  const dataDir = path.join(os.homedir(), '.aicodeswitch/data');
  return path.join(dataDir, `.${configType}-metadata.json`);
};

/**
 * 保存配置元数据
 */
export const saveMetadata = (metadata: ConfigMetadata): boolean => {
  try {
    const metadataPath = getMetadataFilePath(metadata.configType);
    const dataDir = path.dirname(metadataPath);

    // 确保目录存在
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
    return true;
  } catch (error) {
    console.error(`Failed to save metadata for ${metadata.configType}:`, error);
    return false;
  }
};

/**
 * 读取配置元数据
 */
export const loadMetadata = (configType: 'claude' | 'codex'): ConfigMetadata | null => {
  try {
    const metadataPath = getMetadataFilePath(configType);

    if (!fs.existsSync(metadataPath)) {
      return null;
    }

    const content = fs.readFileSync(metadataPath, 'utf-8');
    return JSON.parse(content) as ConfigMetadata;
  } catch (error) {
    console.error(`Failed to load metadata for ${configType}:`, error);
    return null;
  }
};

/**
 * 删除配置元数据
 */
export const deleteMetadata = (configType: 'claude' | 'codex'): boolean => {
  try {
    const metadataPath = getMetadataFilePath(configType);

    if (fs.existsSync(metadataPath)) {
      fs.unlinkSync(metadataPath);
    }

    return true;
  } catch (error) {
    console.error(`Failed to delete metadata for ${configType}:`, error);
    return false;
  }
};

/**
 * 计算文件的 SHA256 hash
 */
const calculateFileHash = (filePath: string): string | null => {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const crypto = require('crypto');
    const content = fs.readFileSync(filePath, 'utf-8');
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch (error) {
    console.error(`Failed to calculate hash for ${filePath}:`, error);
    return null;
  }
};

/**
 * 检查 Claude 配置文件是否包含我们的代理特征
 */
const isClaudeProxyConfig = (filePath: string): boolean => {
  try {
    if (!fs.existsSync(filePath)) {
      return false;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const config = JSON.parse(content);

    // 检查是否包含我们的 ANTHROPIC_BASE_URL 配置
    // 用户可能会修改端口,所以我们只检查主机名部分
    const baseUrl = config.env?.ANTHROPIC_BASE_URL;
    if (baseUrl && typeof baseUrl === 'string') {
      // 允许的格式: http://127.0.0.1:4567/claude-code 或 http://localhost:4567/claude-code
      return /https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/claude-code/.test(baseUrl);
    }

    return false;
  } catch (error) {
    console.error(`Failed to check Claude config:`, error);
    return false;
  }
};

/**
 * 检查 Codex 配置文件是否包含我们的代理特征
 */
const isCodexProxyConfig = (configPath: string): boolean => {
  try {
    // 检查 config.toml
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');

      // 检查是否包含我们的 model_provider 和 base_url 配置
      const hasModelProvider = content.includes('model_provider = "aicodeswitch"');
      const hasBaseUrl = /base_url = "https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/codex"/.test(content);

      if (hasModelProvider && hasBaseUrl) {
        return true;
      }
    }

    return false;
  } catch (error) {
    console.error(`Failed to check Codex config:`, error);
    return false;
  }
};

/**
 * 检查 Claude 配置状态
 */
export const checkClaudeConfigStatus = (): ConfigStatus => {
  const homeDir = os.homedir();
  const settingsPath = path.join(homeDir, '.claude/settings.json');
  const settingsBakPath = path.join(homeDir, '.claude/settings.json.aicodeswitch_backup');
  const claudeJsonBakPath = path.join(homeDir, '.claude.json.aicodeswitch_backup');

  // 检查备份文件是否存在
  const hasBackup = fs.existsSync(settingsBakPath) || fs.existsSync(claudeJsonBakPath);

  // 尝试加载元数据
  const metadata = loadMetadata('claude');

  if (metadata) {
    // 如果元数据存在,进行详细检查
    const currentHash = calculateFileHash(settingsPath);
    const isProxyConfig = isClaudeProxyConfig(settingsPath);

    // 检查是否被修改
    let isModified = false;
    if (currentHash && metadata.files[0]?.currentHash) {
      isModified = currentHash !== metadata.files[0].currentHash;
    }

    // 如果当前配置不是我们的代理配置,说明用户已经恢复或修改了
    const isOverwritten = isProxyConfig;

    return {
      isOverwritten,
      isModified,
      hasBackup,
      metadata
    };
  }

  // 如果元数据不存在,降级到简单检查
  if (hasBackup) {
    // 有备份文件,但没有元数据(可能是旧版本)
    // 检查当前配置是否是我们的代理配置
    const isProxyConfig = isClaudeProxyConfig(settingsPath);

    return {
      isOverwritten: isProxyConfig,
      isModified: false, // 无法判断是否被修改
      hasBackup
    };
  }

  // 没有备份也没有元数据
  // 检查当前配置是否恰好是我们的代理配置
  const isProxyConfig = isClaudeProxyConfig(settingsPath);

  return {
    isOverwritten: isProxyConfig,
    isModified: false,
    hasBackup: false
  };
};

/**
 * 检查 Codex 配置状态
 */
export const checkCodexConfigStatus = (): ConfigStatus => {
  const homeDir = os.homedir();
  const configPath = path.join(homeDir, '.codex/config.toml');
  const configBakPath = path.join(homeDir, '.codex/config.toml.aicodeswitch_backup');
  const authBakPath = path.join(homeDir, '.codex/auth.json.aicodeswitch_backup');

  // 检查备份文件是否存在
  const hasBackup = fs.existsSync(configBakPath) || fs.existsSync(authBakPath);

  // 尝试加载元数据
  const metadata = loadMetadata('codex');

  if (metadata) {
    // 如果元数据存在,进行详细检查
    const currentHash = calculateFileHash(configPath);
    const isProxyConfig = isCodexProxyConfig(configPath);

    // 检查是否被修改
    let isModified = false;
    if (currentHash && metadata.files[0]?.currentHash) {
      isModified = currentHash !== metadata.files[0].currentHash;
    }

    // 如果当前配置不是我们的代理配置,说明用户已经恢复或修改了
    const isOverwritten = isProxyConfig;

    return {
      isOverwritten,
      isModified,
      hasBackup,
      metadata
    };
  }

  // 如果元数据不存在,降级到简单检查
  if (hasBackup) {
    // 有备份文件,但没有元数据(可能是旧版本)
    // 检查当前配置是否是我们的代理配置
    const isProxyConfig = isCodexProxyConfig(configPath);

    return {
      isOverwritten: isProxyConfig,
      isModified: false, // 无法判断是否被修改
      hasBackup
    };
  }

  // 没有备份也没有元数据
  // 检查当前配置是否恰好是我们的代理配置
  const isProxyConfig = isCodexProxyConfig(configPath);

  return {
    isOverwritten: isProxyConfig,
    isModified: false,
    hasBackup: false
  };
};

/**
 * 清理无效的元数据
 * 当备份文件不存在但元数据存在时,说明状态不一致,需要清理
 */
export const cleanupInvalidMetadata = (configType: 'claude' | 'codex'): boolean => {
  try {
    const metadata = loadMetadata(configType);

    if (!metadata) {
      return true; // 没有元数据,无需清理
    }

    // 检查备份文件是否还存在
    const hasAnyBackup = metadata.files.some(file => fs.existsSync(file.backupPath));

    if (!hasAnyBackup) {
      // 备份文件都不存在了,删除元数据
      console.warn(`Cleaning up invalid metadata for ${configType}: no backup files found`);
      return deleteMetadata(configType);
    }

    return true;
  } catch (error) {
    console.error(`Failed to cleanup metadata for ${configType}:`, error);
    return false;
  }
};
