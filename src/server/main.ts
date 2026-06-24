import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { DatabaseFactory } from './database-factory';
import { ProxyServer } from './proxy-server';
import { AccessKeyModule } from './access-keys/index';
import { AccessKeyManager } from './access-keys/manager';
import { PolicyManager } from './access-keys/policy-manager';
import { ServicePerformanceTracker } from './performance-tracker';
import type { FileSystemDatabaseManager } from './fs-database';
import { createLogStore } from './log-store';
import { agentMapService, registerAgentMapRoutes } from './agent-map';
import { setNotifierAppUrl } from './notifier';
import type {
  AppConfig,
  APIService,
  LoginRequest,
  LoginResponse,
  AuthStatus,
  InstalledSkill,
  SkillCatalogItem,
  SkillInstallRequest,
  SkillInstallResponse,
  TargetType,
  MCPInstallRequest,
  CodexReasoningEffort,
  ClaudeEffortLevel,
  ClaudePermissionDefaultMode,
  ToolName,
  WriteLocalRecord,
  SourceType,
} from '../types';
import os from 'os';
import { isAuthEnabled, verifyAuthCode, generateToken, authMiddleware } from './auth';
import { checkVersionUpdate } from './version-check';
import { checkPortUsable } from './utils';
import { rulesStatusBroadcaster, type RuleStatusData } from './rules-status-service';
import { normalizeSourceType, isLegacySourceType } from './type-migration';
import {
  saveMetadata,
  deleteMetadata,
  checkClaudeConfigStatus,
  checkCodexConfigStatus,
  checkOpencodeConfigStatus,
  getOpencodeConfigPath,
  cleanupInvalidMetadata,
  type ConfigMetadata
} from './config-metadata';
import {
  mergeJsonConfig,
  parseToml,
  stringifyToml,
  mergeTomlConfig,
  atomicWriteFile
} from './config-merge';
import {
  CLAUDE_SETTINGS_MANAGED_FIELDS,
  CLAUDE_JSON_MANAGED_FIELDS,
  CODEX_CONFIG_MANAGED_FIELDS,
  CODEX_AUTH_MANAGED_FIELDS,
  OPENCODE_CONFIG_MANAGED_FIELDS
} from './config-managed-fields';
import { SKILLSMP_API_KEY } from './config';
import { extractSessionContent, previewMigration, migrateSession } from './session-migration';
import { writePromptToTempFile, cleanupTempFile, launchTargetWithFallback, cleanupOldTempFiles, resolveProjectDir } from './session-launcher';

const appDir = path.join(os.homedir(), '.aicodeswitch');
const legacyDataDir = path.join(appDir, 'data');
const dataDir = path.join(appDir, 'fs-db');
const dotenvPath = path.resolve(appDir, 'aicodeswitch.conf');
const upgradeHashFilePath = path.join(appDir, 'upgrade-hash');

if (fs.existsSync(dotenvPath)) {
  dotenv.config({ path: dotenvPath });
}

// 服务监听地址由 AUTH 模式强制决定（忽略 process.env.HOST）：
// - AUTH 开启：监听 0.0.0.0，允许远端 AccessKey 客户端连接
// - AUTH 关闭：监听 127.0.0.1，仅本机访问（默认最安全）
const host = isAuthEnabled() ? '0.0.0.0' : '127.0.0.1';
const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 4567;

// 写入本地编程工具配置（Codex config.toml / Claude settings.json）+ UI/CLI 展示用的地址恒为回环地址。
// 即便 AUTH 开启监听 0.0.0.0，本机工具与 dashboard 仍走 127.0.0.1，
// 避免 0.0.0.0（监听语义）被当成连接目标，导致 Windows 客户端 stream disconnected。
const clientHost = '127.0.0.1';

let globalProxyConfig: { enabled: boolean; url: string; username?: string; password?: string } | null = null;

function updateProxyConfig(config: AppConfig): void {
  if (config.proxyEnabled && config.proxyUrl) {
    globalProxyConfig = {
      enabled: true,
      url: config.proxyUrl,
      username: config.proxyUsername,
      password: config.proxyPassword,
    };
  } else {
    globalProxyConfig = null;
  }
}

function getProxyAgent() {
  if (!globalProxyConfig?.enabled || !globalProxyConfig.url) {
    return null;
  }

  try {
    const url = globalProxyConfig.url;
    const proxyUrl = url.startsWith('http') ? url : `http://${url}`;

    if (globalProxyConfig.username && globalProxyConfig.password) {
      const proxyUrlWithAuth = proxyUrl.replace('://', `://${encodeURIComponent(globalProxyConfig.username)}:${encodeURIComponent(globalProxyConfig.password)}@`);
      return proxyUrlWithAuth;
    }

    return proxyUrl;
  } catch {
    return null;
  }
}

// ============================================================================
// 写入本地记录持久化
// ============================================================================

const getWriteLocalRecordsFile = (): string => path.join(dataDir, 'write-local-records.json');

function loadWriteLocalRecords(): WriteLocalRecord[] {
  try {
    const filePath = getWriteLocalRecordsFile();
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch { /* ignore */ }
  return [];
}

function saveWriteLocalRecords(records: WriteLocalRecord[]): void {
  const filePath = getWriteLocalRecordsFile();
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  atomicWriteFile(filePath, JSON.stringify(records, null, 2));
}

function addWriteLocalRecord(accessKeyId: string, targets: string[]): void {
  const records = loadWriteLocalRecords();
  const existing = records.find(r => r.accessKeyId === accessKeyId);
  if (existing) {
    for (const t of targets) {
      if (!existing.targets.includes(t)) existing.targets.push(t);
    }
    existing.timestamp = Date.now();
  } else {
    records.push({ accessKeyId, targets: [...targets], timestamp: Date.now() });
  }
  saveWriteLocalRecords(records);
}

function removeWriteLocalRecords(accessKeyId: string): void {
  const records = loadWriteLocalRecords().filter(r => r.accessKeyId !== accessKeyId);
  saveWriteLocalRecords(records);
}

/**
 * 从持久化记录中恢复已写入本地的 AccessKey
 * 每次代理配置写入后调用，确保 AccessKey 不会被占位符覆盖
 */
function applyWriteLocalRecords(proxyServer: ProxyServer): void {
  const accessKeyModule = proxyServer.getAccessKeyModule();
  if (!accessKeyModule) return;

  const records = loadWriteLocalRecords();
  if (records.length === 0) return;

  let changed = false;
  const homeDir = os.homedir();

  const remainingRecords = records.filter(record => {
    const key = accessKeyModule.keyManager.get(record.accessKeyId);
    if (!key || key.status !== 'active') {
      changed = true;
      return false; // 密钥已删除或停用，移除记录
    }

    for (const target of record.targets) {
      try {
        if (target === 'claude-code') {
          const claudeDir = path.join(homeDir, '.claude');
          const settingsPath = path.join(claudeDir, 'settings.json');
          if (!fs.existsSync(claudeDir)) {
            fs.mkdirSync(claudeDir, { recursive: true });
          }
          let settings: Record<string, any> = {};
          if (fs.existsSync(settingsPath)) {
            try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch { /* ignore */ }
          }
          if (!settings.env) settings.env = {};
          settings.env.ANTHROPIC_AUTH_TOKEN = key.apiKey;
          atomicWriteFile(settingsPath, JSON.stringify(settings, null, 2));
        } else if (target === 'codex') {
          const codexDir = path.join(homeDir, '.codex');
          const authPath = path.join(codexDir, 'auth.json');
          if (!fs.existsSync(codexDir)) {
            fs.mkdirSync(codexDir, { recursive: true });
          }
          let auth: Record<string, any> = {};
          if (fs.existsSync(authPath)) {
            try { auth = JSON.parse(fs.readFileSync(authPath, 'utf-8')); } catch { /* ignore */ }
          }
          auth.OPENAI_API_KEY = key.apiKey;
          atomicWriteFile(authPath, JSON.stringify(auth, null, 2));
        } else if (target === 'opencode') {
          // 将真实 Key 写入 opencode.json 的 provider.aicodeswitch.options.apiKey
          const opencodeConfigPath = getOpencodeConfigPath();
          const opencodeDir = path.dirname(opencodeConfigPath);
          if (!fs.existsSync(opencodeDir)) {
            fs.mkdirSync(opencodeDir, { recursive: true });
          }
          let oc: Record<string, any> = {};
          if (fs.existsSync(opencodeConfigPath)) {
            try { oc = JSON.parse(fs.readFileSync(opencodeConfigPath, 'utf-8')); } catch { /* ignore */ }
          }
          if (!oc.provider) oc.provider = {};
          if (!oc.provider.aicodeswitch || typeof oc.provider.aicodeswitch !== 'object') {
            oc.provider.aicodeswitch = { npm: '@ai-sdk/openai-compatible', name: 'AICodeSwitch', options: {} };
          }
          if (!oc.provider.aicodeswitch.options) oc.provider.aicodeswitch.options = {};
          oc.provider.aicodeswitch.options.apiKey = key.apiKey;
          atomicWriteFile(opencodeConfigPath, JSON.stringify(oc, null, 2));
        }
      } catch (error) {
        console.error(`[WriteLocal] Failed to apply key ${record.accessKeyId} to ${target}:`, error);
      }
    }
    return true;
  });

  if (changed) {
    saveWriteLocalRecords(remainingRecords);
  }
}

const app = express();
app.use(cors());
app.use(express.json({ limit: 'Infinity' }));
app.use(express.urlencoded({ extended: true, limit: 'Infinity' }));

// 类型转换中间件：自动将旧的数据源类型转换为新类型
app.use((req: Request, _res: Response, next: NextFunction) => {
  if (req.body && typeof req.body === 'object') {
    // 转换 sourceType
    if (req.body.sourceType && typeof req.body.sourceType === 'string') {
      if (isLegacySourceType(req.body.sourceType)) {
        console.log(`[API] Converting legacy sourceType: ${req.body.sourceType} -> ${normalizeSourceType(req.body.sourceType)}`);
        req.body.sourceType = normalizeSourceType(req.body.sourceType);
      }
    }

    // 转换数组中的 sourceType（如 vendors 的 services）
    if (Array.isArray(req.body.services)) {
      req.body.services = req.body.services.map((service: any) => {
        if (service.sourceType && isLegacySourceType(service.sourceType)) {
          return {
            ...service,
            sourceType: normalizeSourceType(service.sourceType)
          };
        }
        return service;
      });
    }
  }
  next();
});

const asyncHandler =
  (handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch((err) => {
      console.error('[asyncHandler] Caught error:', err);
      next(err);
    });
  };

interface ToolConfigWriteOptions {
  allowOverwriteRefresh?: boolean;
}

const VALID_CLAUDE_EFFORT_LEVELS: ClaudeEffortLevel[] = ['low', 'medium', 'high', 'max'];
const DEFAULT_CLAUDE_EFFORT_LEVEL: ClaudeEffortLevel = 'medium';

const VALID_CLAUDE_PERMISSION_DEFAULT_MODES: ClaudePermissionDefaultMode[] =
  ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];
const DEFAULT_CLAUDE_PERMISSION_DEFAULT_MODE: ClaudePermissionDefaultMode = 'default';

const isClaudeEffortLevel = (value: unknown): value is ClaudeEffortLevel => {
  return typeof value === 'string' && VALID_CLAUDE_EFFORT_LEVELS.includes(value as ClaudeEffortLevel);
};

const isClaudePermissionDefaultMode = (value: unknown): value is ClaudePermissionDefaultMode => {
  return typeof value === 'string' && VALID_CLAUDE_PERMISSION_DEFAULT_MODES.includes(value as ClaudePermissionDefaultMode);
};

const isValidAutocompactPct = (v: unknown): v is number => {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 100;
};

const writeClaudeConfig = async (
  _dbManager: FileSystemDatabaseManager,
  enableAgentTeams?: boolean,
  enableBypassPermissionsSupport?: boolean,
  permissionsDefaultMode?: ClaudePermissionDefaultMode,
  effortLevel?: ClaudeEffortLevel,
  defaultModel?: string,
  autocompactPctOverride?: number,
  options: ToolConfigWriteOptions = {}
): Promise<boolean> => {
  try {
    const homeDir = os.homedir();
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 4567;

    // Claude Code settings.json
    const claudeDir = path.join(homeDir, '.claude');
    const claudeSettingsPath = path.join(claudeDir, 'settings.json');
    const claudeSettingsBakPath = path.join(claudeDir, 'settings.json.aicodeswitch_backup');
    const claudeJsonBakPath = path.join(homeDir, '.claude.json.aicodeswitch_backup');

    // 使用新的配置状态检测来判断是否可以写入
    const configStatus = checkClaudeConfigStatus();
    const isRuntimeRefresh = options.allowOverwriteRefresh === true && configStatus.isOverwritten;

    // 只有当当前配置已经是代理配置时，才拒绝写入
    if (configStatus.isOverwritten && !isRuntimeRefresh) {
      console.error('Claude config has already been overwritten. Please restore the original config first.');
      return false;
    }

    // 如果 .aicodeswitch_backup 文件不存在，才进行备份（避免覆盖已有备份）
    let originalSettingsHash: string | undefined = isRuntimeRefresh
      ? configStatus.metadata?.originalHash
      : undefined;

    if (!isRuntimeRefresh) {
      if (!fs.existsSync(claudeSettingsBakPath)) {
        // 计算原始配置文件的 hash(如果存在)
        if (fs.existsSync(claudeSettingsPath)) {
          originalSettingsHash = createHash('sha256').update(fs.readFileSync(claudeSettingsPath, 'utf-8')).digest('hex');
          // 备份当前配置文件
          fs.renameSync(claudeSettingsPath, claudeSettingsBakPath);
        }
      } else {
        // .aicodeswitch_backup 已存在，直接使用现有的备份文件
        console.log('Backup file already exists, skipping backup step');
      }
    }

    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }

    // 读取当前配置（如果存在），保留工具运行时写入的内容
    let currentSettings: Record<string, any> = {};
    if (fs.existsSync(claudeSettingsPath)) {
      try {
        currentSettings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf-8'));
      } catch (error) {
        console.warn('Failed to parse current settings.json, using empty object:', error);
      }
    }

    // 构建代理配置
    const claudeSettingsEnv: Record<string, any> = {
      ANTHROPIC_AUTH_TOKEN: "api_key",
      ANTHROPIC_BASE_URL: `http://${clientHost}:${port}/claude-code`,
      API_TIMEOUT_MS: "3000000",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: 1,
      CLAUDE_CODE_MAX_RETRIES: 3
    };

    // 如果启用Agent Teams功能，添加对应的环境变量
    if (enableAgentTeams) {
      claudeSettingsEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";
    }

    const proxySettings: Record<string, any> = {
      env: claudeSettingsEnv
    };

    // 解析默认权限模式：bypassPermissions 必须门控开启才生效，否则降级为 default
    let claudeDefaultMode: ClaudePermissionDefaultMode = isClaudePermissionDefaultMode(permissionsDefaultMode)
      ? permissionsDefaultMode
      : DEFAULT_CLAUDE_PERMISSION_DEFAULT_MODE;
    if (claudeDefaultMode === 'bypassPermissions' && enableBypassPermissionsSupport !== true) {
      claudeDefaultMode = 'default';
    }
    proxySettings.permissions = {
      defaultMode: claudeDefaultMode
    };
    if (claudeDefaultMode === 'bypassPermissions') {
      proxySettings.skipDangerousModePermissionPrompt = true;
    }

    // 如果设置了 effortLevel，添加对应的配置项
    if (effortLevel && isClaudeEffortLevel(effortLevel)) {
      proxySettings.effortLevel = effortLevel;
    }

    // 如果设置了默认模型，添加对应的配置项
    if (defaultModel && typeof defaultModel === 'string' && defaultModel.trim()) {
      proxySettings.model = defaultModel.trim();
    }

    // 如果设置了自动压缩百分比阈值，添加对应的配置项
    if (isValidAutocompactPct(autocompactPctOverride)) {
      claudeSettingsEnv.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(autocompactPctOverride);
    }

    // 使用智能合并：将代理配置的管理字段写入，保留当前配置的非管理字段
    const mergedSettings = mergeJsonConfig(
      proxySettings,
      currentSettings,
      CLAUDE_SETTINGS_MANAGED_FIELDS
    );

    // 原子性写入合并后的配置
    atomicWriteFile(claudeSettingsPath, JSON.stringify(mergedSettings, null, 2));

    // Claude Code .claude.json
    const claudeJsonPath = path.join(homeDir, '.claude.json');

    // 读取当前配置（如果存在），保留工具运行时写入的内容
    let currentClaudeJson: Record<string, any> = {};
    if (fs.existsSync(claudeJsonPath)) {
      try {
        currentClaudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
      } catch (error) {
        console.warn('Failed to parse current .claude.json, using empty object:', error);
      }
    }

    // 然后处理备份
    if (!isRuntimeRefresh) {
      if (!fs.existsSync(claudeJsonBakPath)) {
        if (fs.existsSync(claudeJsonPath)) {
          fs.renameSync(claudeJsonPath, claudeJsonBakPath);
        }
      }
    }

    // 构建代理配置
    const proxyClaudeJson: Record<string, any> = {
      hasCompletedOnboarding: true
    };

    // 使用智能合并
    const mergedClaudeJson = mergeJsonConfig(
      proxyClaudeJson,
      currentClaudeJson,
      CLAUDE_JSON_MANAGED_FIELDS
    );

    // 原子性写入合并后的配置
    atomicWriteFile(claudeJsonPath, JSON.stringify(mergedClaudeJson, null, 2));

    // 保存元数据
    const currentSettingsHash = createHash('sha256').update(fs.readFileSync(claudeSettingsPath, 'utf-8')).digest('hex');
    const metadata: ConfigMetadata = {
      configType: 'claude',
      timestamp: Date.now(),
      originalHash: originalSettingsHash,
      proxyMarker: `http://${host}:${port}/claude-code`,
      files: [
        {
          originalPath: claudeSettingsPath,
          backupPath: claudeSettingsBakPath,
          currentHash: currentSettingsHash
        },
        {
          originalPath: claudeJsonPath,
          backupPath: claudeJsonBakPath
        }
      ]
    };
    saveMetadata(metadata);

    return true;
  } catch (error) {
    console.error('Failed to write Claude config files:', error);
    return false;
  }
};

const VALID_CODEX_REASONING_EFFORTS: CodexReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];
const DEFAULT_CODEX_REASONING_EFFORT: CodexReasoningEffort = 'high';

const isCodexReasoningEffort = (value: unknown): value is CodexReasoningEffort => {
  return typeof value === 'string' && VALID_CODEX_REASONING_EFFORTS.includes(value as CodexReasoningEffort);
};

const writeCodexConfig = async (
  _dbManager: FileSystemDatabaseManager,
  modelReasoningEffort: CodexReasoningEffort = DEFAULT_CODEX_REASONING_EFFORT,
  codexDefaultModel?: string,
  enableMemories?: boolean,
  options: ToolConfigWriteOptions = {}
): Promise<boolean> => {
  try {
    const homeDir = os.homedir();

    // Codex config.toml
    const codexDir = path.join(homeDir, '.codex');
    const codexConfigPath = path.join(codexDir, 'config.toml');
    const codexConfigBakPath = path.join(codexDir, 'config.toml.aicodeswitch_backup');
    const codexAuthBakPath = path.join(codexDir, 'auth.json.aicodeswitch_backup');

    // 使用新的配置状态检测来判断是否可以写入
    const configStatus = checkCodexConfigStatus();
    const isRuntimeRefresh = options.allowOverwriteRefresh === true && configStatus.isOverwritten;

    // 只有当当前配置已经是代理配置时，才拒绝写入
    if (configStatus.isOverwritten && !isRuntimeRefresh) {
      console.error('Codex config has already been overwritten. Please restore the original config first.');
      return false;
    }

    // 如果 .aicodeswitch_backup 文件不存在，才进行备份（避免覆盖已有备份）
    let originalConfigHash: string | undefined = isRuntimeRefresh
      ? configStatus.metadata?.originalHash
      : undefined;

    if (!isRuntimeRefresh) {
      if (!fs.existsSync(codexConfigBakPath)) {
        // 计算原始配置文件的 hash(如果存在)
        if (fs.existsSync(codexConfigPath)) {
          originalConfigHash = createHash('sha256').update(fs.readFileSync(codexConfigPath, 'utf-8')).digest('hex');
          // 备份当前配置文件
          fs.renameSync(codexConfigPath, codexConfigBakPath);
        }
      } else {
        // .aicodeswitch_backup 已存在，直接使用现有的备份文件
        console.log('Backup file already exists, skipping backup step');
      }
    }

    if (!fs.existsSync(codexDir)) {
      fs.mkdirSync(codexDir, { recursive: true });
    }

    // 读取当前配置（如果存在），保留工具运行时写入的内容
    let currentConfig: Record<string, any> = {};
    if (fs.existsSync(codexConfigPath)) {
      try {
        currentConfig = parseToml(fs.readFileSync(codexConfigPath, 'utf-8'));
      } catch (error) {
        console.warn('Failed to parse current config.toml, using empty object:', error);
      }
    }

    // 构建代理配置
    const proxyConfig: Record<string, any> = {
      model_provider: "aicodeswitch",
      model: codexDefaultModel || "gpt-5.3-codex",  // 使用配置的默认模型，否则使用默认值
      model_reasoning_effort: modelReasoningEffort,
      disable_response_storage: true,
      preferred_auth_method: "apikey",
      requires_openai_auth: true,
      enableRouteSelection: true,
      model_providers: {
        aicodeswitch: {
          name: "aicodeswitch",
          base_url: `http://${clientHost}:${port}/codex`,
          wire_api: "responses",
          stream_max_retries: 3,
          stream_retry_backoff: "fixed"
        }
      }
    };

    // 记忆功能配置
    if (enableMemories) {
      proxyConfig.features = {
        memories: true,
      };
      proxyConfig.memories = {
        generate_memories: true,
        use_memories: true,
        disable_on_external_context: true,
      };
    }

    // 使用智能合并
    const mergedConfig = mergeTomlConfig(
      proxyConfig,
      currentConfig,
      CODEX_CONFIG_MANAGED_FIELDS
    );

    // 原子性写入合并后的配置
    atomicWriteFile(codexConfigPath, stringifyToml(mergedConfig));

    // Codex auth.json
    const codexAuthPath = path.join(codexDir, 'auth.json');

    // 读取当前配置（如果存在），保留工具运行时写入的内容
    let currentAuth: Record<string, any> = {};
    if (fs.existsSync(codexAuthPath)) {
      try {
        currentAuth = JSON.parse(fs.readFileSync(codexAuthPath, 'utf-8'));
      } catch (error) {
        console.warn('Failed to parse current auth.json, using empty object:', error);
      }
    }

    // 同样处理 auth.json 的备份
    if (!isRuntimeRefresh) {
      if (!fs.existsSync(codexAuthBakPath)) {
        if (fs.existsSync(codexAuthPath)) {
          fs.renameSync(codexAuthPath, codexAuthBakPath);
        }
      }
    }

    // 构建代理配置
    const proxyAuth: Record<string, any> = {
      OPENAI_API_KEY: "api_key"
    };

    // 使用智能合并
    const mergedAuth = mergeJsonConfig(
      proxyAuth,
      currentAuth,
      CODEX_AUTH_MANAGED_FIELDS
    );

    // 原子性写入合并后的配置
    atomicWriteFile(codexAuthPath, JSON.stringify(mergedAuth, null, 2));

    // 保存元数据
    const currentConfigHash = createHash('sha256').update(fs.readFileSync(codexConfigPath, 'utf-8')).digest('hex');
    const metadata: ConfigMetadata = {
      configType: 'codex',
      timestamp: Date.now(),
      originalHash: originalConfigHash,
      proxyMarker: `http://${host}:${process.env.PORT ? parseInt(process.env.PORT, 10) : 4567}/codex`,
      files: [
        {
          originalPath: codexConfigPath,
          backupPath: codexConfigBakPath,
          currentHash: currentConfigHash
        },
        {
          originalPath: codexAuthPath,
          backupPath: codexAuthBakPath
        }
      ]
    };
    saveMetadata(metadata);

    return true;
  } catch (error) {
    console.error('Failed to write Codex config files:', error);
    return false;
  }
};

const restoreClaudeConfig = async (): Promise<boolean> => {
  try {
    const homeDir = os.homedir();
    let restoredAnyFile = false;

    // Restore Claude Code settings.json
    const claudeDir = path.join(homeDir, '.claude');
    const claudeSettingsPath = path.join(claudeDir, 'settings.json');
    const claudeSettingsBakPath = path.join(claudeDir, 'settings.json.aicodeswitch_backup');

    if (fs.existsSync(claudeSettingsBakPath)) {
      // 读取备份配置
      const backupSettings: Record<string, any> = JSON.parse(
        fs.readFileSync(claudeSettingsBakPath, 'utf-8')
      );

      // 读取当前配置（可能包含工具运行时写入的新内容）
      let currentSettings: Record<string, any> = {};
      if (fs.existsSync(claudeSettingsPath)) {
        try {
          currentSettings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf-8'));
        } catch (error) {
          console.warn('Failed to parse current settings.json during restore, using empty object:', error);
        }
      }

      // 防御性清理：移除 currentSettings 中 ANTHROPIC_API_KEY 的空值，
      // 防止旧版本代理写入的空值覆盖 backup 中的真实 Key
      if (currentSettings?.env?.ANTHROPIC_API_KEY === '' && backupSettings?.env?.ANTHROPIC_API_KEY) {
        delete currentSettings.env.ANTHROPIC_API_KEY;
        if (Object.keys(currentSettings.env).length === 0) {
          delete currentSettings.env;
        }
      }

      // 生成合并后的配置（备份作为基础，合并当前的非管理字段）
      const mergedSettings = mergeJsonConfig(
        backupSettings,
        currentSettings,
        CLAUDE_SETTINGS_MANAGED_FIELDS
      );

      // 原子性写入合并后的配置
      atomicWriteFile(claudeSettingsPath, JSON.stringify(mergedSettings, null, 2));

      // 删除备份文件
      fs.unlinkSync(claudeSettingsBakPath);
      restoredAnyFile = true;
    }

    // Restore Claude Code .claude.json
    const claudeJsonPath = path.join(homeDir, '.claude.json');
    const claudeJsonBakPath = path.join(homeDir, '.claude.json.aicodeswitch_backup');

    if (fs.existsSync(claudeJsonBakPath)) {
      // 读取备份配置
      const backupClaudeJson: Record<string, any> = JSON.parse(
        fs.readFileSync(claudeJsonBakPath, 'utf-8')
      );

      // 读取当前配置（可能包含工具运行时写入的新内容）
      let currentClaudeJson: Record<string, any> = {};
      if (fs.existsSync(claudeJsonPath)) {
        try {
          currentClaudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
        } catch (error) {
          console.warn('Failed to parse current .claude.json during restore, using empty object:', error);
        }
      }

      // 生成合并后的配置
      const mergedClaudeJson = mergeJsonConfig(
        backupClaudeJson,
        currentClaudeJson,
        CLAUDE_JSON_MANAGED_FIELDS
      );

      // 原子性写入合并后的配置
      atomicWriteFile(claudeJsonPath, JSON.stringify(mergedClaudeJson, null, 2));

      // 删除备份文件
      fs.unlinkSync(claudeJsonBakPath);
      restoredAnyFile = true;
    }

    // 删除元数据
    deleteMetadata('claude');

    return restoredAnyFile;
  } catch (error) {
    console.error('Failed to restore Claude config files:', error);
    return false;
  }
};

const restoreCodexConfig = async (): Promise<boolean> => {
  try {
    const homeDir = os.homedir();
    let restoredAnyFile = false;

    // Restore Codex config.toml
    const codexDir = path.join(homeDir, '.codex');
    const codexConfigPath = path.join(codexDir, 'config.toml');
    const codexConfigBakPath = path.join(codexDir, 'config.toml.aicodeswitch_backup');

    if (fs.existsSync(codexConfigBakPath)) {
      // 读取备份配置
      const backupConfig: Record<string, any> = parseToml(
        fs.readFileSync(codexConfigBakPath, 'utf-8')
      );

      // 读取当前配置（可能包含工具运行时写入的新内容）
      let currentConfig: Record<string, any> = {};
      if (fs.existsSync(codexConfigPath)) {
        try {
          currentConfig = parseToml(fs.readFileSync(codexConfigPath, 'utf-8'));
        } catch (error) {
          console.warn('Failed to parse current config.toml during restore, using empty object:', error);
        }
      }

      // 生成合并后的配置（备份作为基础，合并当前的非管理字段）
      const mergedConfig = mergeTomlConfig(
        backupConfig,
        currentConfig,
        CODEX_CONFIG_MANAGED_FIELDS
      );

      // 原子性写入合并后的配置
      atomicWriteFile(codexConfigPath, stringifyToml(mergedConfig));

      // 删除备份文件
      fs.unlinkSync(codexConfigBakPath);
      restoredAnyFile = true;
    }

    // Restore Codex auth.json
    const codexAuthPath = path.join(codexDir, 'auth.json');
    const codexAuthBakPath = path.join(codexDir, 'auth.json.aicodeswitch_backup');

    if (fs.existsSync(codexAuthBakPath)) {
      // 读取备份配置
      const backupAuth: Record<string, any> = JSON.parse(
        fs.readFileSync(codexAuthBakPath, 'utf-8')
      );

      // 读取当前配置（可能包含工具运行时写入的新内容）
      let currentAuth: Record<string, any> = {};
      if (fs.existsSync(codexAuthPath)) {
        try {
          currentAuth = JSON.parse(fs.readFileSync(codexAuthPath, 'utf-8'));
        } catch (error) {
          console.warn('Failed to parse current auth.json during restore, using empty object:', error);
        }
      }

      // 生成合并后的配置
      const mergedAuth = mergeJsonConfig(
        backupAuth,
        currentAuth,
        CODEX_AUTH_MANAGED_FIELDS
      );

      // 原子性写入合并后的配置
      atomicWriteFile(codexAuthPath, JSON.stringify(mergedAuth, null, 2));

      // 删除备份文件
      fs.unlinkSync(codexAuthBakPath);
      restoredAnyFile = true;
    }

    // 删除元数据
    deleteMetadata('codex');

    return restoredAnyFile;
  } catch (error) {
    console.error('Failed to restore Codex config files:', error);
    return false;
  }
};

/**
 * 默认 OpenCode 模型（当用户未配置 opencodeDefaultModel 时使用）
 */
const DEFAULT_OPENCODE_MODEL = 'claude-sonnet-4-20250514';

/**
 * 写入 OpenCode 配置（~/.config/opencode/opencode.json）
 *
 * 注入一个自定义 provider `aicodeswitch`，经 @ai-sdk/openai-compatible 指向本代理
 * 的 /opencode/v1 端点（OpenAI Chat Completions 格式）。仅托管 provider.aicodeswitch
 * 段与 model/small_model/mcp 字段，其余用户配置（其它 provider、agent、command 等）保留。
 */
const writeOpencodeConfig = async (
  _dbManager: FileSystemDatabaseManager,
  defaultModel?: string,
  options: ToolConfigWriteOptions = {}
): Promise<boolean> => {
  try {
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 4567;
    const configPath = getOpencodeConfigPath();
    const configBakPath = `${configPath}.aicodeswitch_backup`;
    const configDir = path.dirname(configPath);

    const configStatus = checkOpencodeConfigStatus();
    const isRuntimeRefresh = options.allowOverwriteRefresh === true && configStatus.isOverwritten;

    if (configStatus.isOverwritten && !isRuntimeRefresh) {
      console.error('OpenCode config has already been overwritten. Please restore the original config first.');
      return false;
    }

    let originalHash: string | undefined = isRuntimeRefresh
      ? configStatus.metadata?.originalHash
      : undefined;

    if (!isRuntimeRefresh) {
      if (!fs.existsSync(configBakPath)) {
        if (fs.existsSync(configPath)) {
          originalHash = createHash('sha256').update(fs.readFileSync(configPath, 'utf-8')).digest('hex');
          fs.renameSync(configPath, configBakPath);
        }
      } else {
        console.log('OpenCode backup file already exists, skipping backup step');
      }
    }

    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    // 读取当前配置（保留用户其它 provider/agent/command 等）
    let currentConfig: Record<string, any> = {};
    if (fs.existsSync(configPath)) {
      try {
        currentConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      } catch (error) {
        console.warn('Failed to parse current opencode.json, using empty object:', error);
      }
    }

    const model = (defaultModel && typeof defaultModel === 'string' && defaultModel.trim())
      ? defaultModel.trim()
      : DEFAULT_OPENCODE_MODEL;

    // 构建代理配置
    const proxyConfig: Record<string, any> = {
      provider: {
        aicodeswitch: {
          npm: '@ai-sdk/openai-compatible',
          name: 'AICodeSwitch',
          options: {
            baseURL: `http://${clientHost}:${port}/opencode/v1`,
            apiKey: 'api_key'
          },
          models: {
            [model]: { name: model }
          }
        }
      },
      model: `aicodeswitch/${model}`
    };

    const mergedConfig = mergeJsonConfig(
      proxyConfig,
      currentConfig,
      OPENCODE_CONFIG_MANAGED_FIELDS
    );

    atomicWriteFile(configPath, JSON.stringify(mergedConfig, null, 2));

    // 保存元数据
    const currentHash = createHash('sha256').update(fs.readFileSync(configPath, 'utf-8')).digest('hex');
    const metadata: ConfigMetadata = {
      configType: 'opencode',
      timestamp: Date.now(),
      originalHash,
      proxyMarker: `http://${host}:${port}/opencode`,
      files: [
        {
          originalPath: configPath,
          backupPath: configBakPath,
          currentHash
        }
      ]
    };
    saveMetadata(metadata);

    return true;
  } catch (error) {
    console.error('Failed to write OpenCode config file:', error);
    return false;
  }
};

const restoreOpencodeConfig = async (): Promise<boolean> => {
  try {
    const configPath = getOpencodeConfigPath();
    const configBakPath = `${configPath}.aicodeswitch_backup`;
    let restoredAnyFile = false;

    if (fs.existsSync(configBakPath)) {
      const backupConfig: Record<string, any> = JSON.parse(
        fs.readFileSync(configBakPath, 'utf-8')
      );

      let currentConfig: Record<string, any> = {};
      if (fs.existsSync(configPath)) {
        try {
          currentConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        } catch (error) {
          console.warn('Failed to parse current opencode.json during restore, using empty object:', error);
        }
      }

      // 备份作为基础，合并当前的非管理字段
      const mergedConfig = mergeJsonConfig(
        backupConfig,
        currentConfig,
        OPENCODE_CONFIG_MANAGED_FIELDS
      );

      atomicWriteFile(configPath, JSON.stringify(mergedConfig, null, 2));
      fs.unlinkSync(configBakPath);
      restoredAnyFile = true;
    }

    deleteMetadata('opencode');

    return restoredAnyFile;
  } catch (error) {
    console.error('Failed to restore OpenCode config file:', error);
    return false;
  }
};

const checkOpencodeBackupExists = (): boolean => {
  try {
    const status = checkOpencodeConfigStatus();
    return status.hasBackup;
  } catch (error) {
    console.error('Failed to check OpenCode backup:', error);
    return false;
  }
};

const checkClaudeBackupExists = (): boolean => {
  try {
    // 清理可能的无效元数据
    cleanupInvalidMetadata('claude');

    // 使用新的配置状态检测
    const status = checkClaudeConfigStatus();

    // 返回是否已被覆盖(用于向后兼容)
    return status.isOverwritten;
  } catch (error) {
    console.error('Failed to check Claude backup files:', error);
    return false;
  }
};

const checkCodexBackupExists = (): boolean => {
  try {
    // 清理可能的无效元数据
    cleanupInvalidMetadata('codex');

    // 使用新的配置状态检测
    const status = checkCodexConfigStatus();

    // 返回是否已被覆盖(用于向后兼容)
    return status.isOverwritten;
  } catch (error) {
    console.error('Failed to check Codex backup files:', error);
    return false;
  }
};

const syncConfigsOnServerStartup = async (dbManager: FileSystemDatabaseManager): Promise<void> => {
  const config = dbManager.getConfig();

  // 服务启动即执行写入，参数来源改为全局配置
  const claudeEffortLevel = isClaudeEffortLevel(config.claudeEffortLevel)
    ? config.claudeEffortLevel
    : DEFAULT_CLAUDE_EFFORT_LEVEL;
  const claudeWritten = await writeClaudeConfig(
    dbManager,
    config.enableAgentTeams,
    config.enableBypassPermissionsSupport,
    config.claudePermissionsDefaultMode,
    claudeEffortLevel,
    config.claudeDefaultModel,
    config.autocompactPctOverride
  );
  console.log(`[Startup Config Sync] Claude Code config ${claudeWritten ? 'written' : 'skipped'}`);

  const modelReasoningEffort = isCodexReasoningEffort(config.codexModelReasoningEffort)
    ? config.codexModelReasoningEffort
    : DEFAULT_CODEX_REASONING_EFFORT;
  const codexWritten = await writeCodexConfig(
    dbManager,
    modelReasoningEffort,
    config.codexDefaultModel,
    config.codexEnableMemories
  );
  console.log(`[Startup Config Sync] Codex config ${codexWritten ? 'written' : 'skipped'}`);

  const opencodeWritten = await writeOpencodeConfig(
    dbManager,
    config.opencodeDefaultModel
  );
  console.log(`[Startup Config Sync] OpenCode config ${opencodeWritten ? 'written' : 'skipped'}`);
};

const syncConfigsOnGlobalConfigUpdate = async (dbManager: FileSystemDatabaseManager): Promise<void> => {
  const config = dbManager.getConfig();

  const claudeEffortLevel = isClaudeEffortLevel(config.claudeEffortLevel)
    ? config.claudeEffortLevel
    : DEFAULT_CLAUDE_EFFORT_LEVEL;
  const claudeUpdated = await writeClaudeConfig(
    dbManager,
    config.enableAgentTeams,
    config.enableBypassPermissionsSupport,
    config.claudePermissionsDefaultMode,
    claudeEffortLevel,
    config.claudeDefaultModel,
    config.autocompactPctOverride,
    { allowOverwriteRefresh: true }
  );
  console.log(`[Config Update Sync] Claude Code config ${claudeUpdated ? 'written' : 'skipped'}`);

  const modelReasoningEffort = isCodexReasoningEffort(config.codexModelReasoningEffort)
    ? config.codexModelReasoningEffort
    : DEFAULT_CODEX_REASONING_EFFORT;
  const codexUpdated = await writeCodexConfig(
    dbManager,
    modelReasoningEffort,
    config.codexDefaultModel,
    config.codexEnableMemories,
    { allowOverwriteRefresh: true }
  );
  console.log(`[Config Update Sync] Codex config ${codexUpdated ? 'written' : 'skipped'}`);

  const opencodeUpdated = await writeOpencodeConfig(
    dbManager,
    config.opencodeDefaultModel,
    { allowOverwriteRefresh: true }
  );
  console.log(`[Config Update Sync] OpenCode config ${opencodeUpdated ? 'written' : 'skipped'}`);
};

const getCentralSkillsDir = (): string => {
  return path.join(os.homedir(), '.aicodeswitch', 'skills');
};

function sanitizeDirName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 100);
}

function getSkillDirByName(name: string): string {
  const sanitizedName = sanitizeDirName(name);
  const centralDir = getCentralSkillsDir();
  return path.join(centralDir, sanitizedName);
}

const getSkillSymlinkPath = (skillId: string, targetType: TargetType): string => {
  if (targetType === 'opencode') {
    // OpenCode 没有 skills 目录，映射为全局 command：~/.config/opencode/commands/<skillId>.md
    return path.join(os.homedir(), '.config', 'opencode', 'commands', `${skillId}.md`);
  }
  const baseDir = targetType === 'claude-code' ? '.claude' : '.codex';
  return path.join(os.homedir(), baseDir, 'skills', skillId);
};

function isSkillSymlinkExists(skillId: string, targetType: TargetType): boolean {
  const symlinkPath = getSkillSymlinkPath(skillId, targetType);

  try {
    if (targetType === 'opencode') {
      // OpenCode 是普通文件，不是 symlink
      return fs.existsSync(symlinkPath);
    }
    const stats = fs.lstatSync(symlinkPath);
    return stats.isSymbolicLink();
  } catch (error) {
    return false;
  }
}

/**
 * 从 SKILL.md 内容中剥离前导 YAML frontmatter，返回 { description?, body }
 * 没有 frontmatter 时，description 为 undefined，body 为原文。
 */
function parseSkillMd(skillMdContent: string): { description?: string; body: string } {
  const trimmed = skillMdContent.replace(/^﻿/, '');
  const fmMatch = trimmed.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!fmMatch) {
    return { body: trimmed };
  }
  const frontmatter = fmMatch[1];
  const body = fmMatch[2];
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
  return {
    description: descMatch ? descMatch[1].replace(/^["']|["']$/g, '').trim() : undefined,
    body: body.trim(),
  };
}

/**
 * 为 OpenCode 生成 command markdown 文件内容。
 * frontmatter 用 description（OpenCode 在 TUI 展示），正文用 SKILL.md 的 body。
 */
function buildOpencodeSkillCommandMarkdown(skillDir: string, skillId: string, fallbackDescription?: string): string {
  let description = fallbackDescription || '';
  let body = '';

  const skillMdPath = path.join(skillDir, 'SKILL.md');
  if (fs.existsSync(skillMdPath)) {
    try {
      const parsed = parseSkillMd(fs.readFileSync(skillMdPath, 'utf-8'));
      body = parsed.body || '';
      if (!description && parsed.description) {
        description = parsed.description;
      }
    } catch { /* ignore */ }
  }

  if (!description) {
    description = skillId;
  }

  const bodySection = body ? `\n${body}\n` : '\n';
  return `---\ndescription: ${description.replace(/\n/g, ' ')}\nagent: build\n---\n${bodySection}`;
}

async function createSkillSymlink(skillId: string, targetType: TargetType): Promise<{ success: boolean; error?: string }> {
  try {
    const centralDir = getCentralSkillsDir();
    const skillDir = path.join(centralDir, skillId);

    if (!fs.existsSync(skillDir)) {
      return { success: false, error: 'Skill目录不存在' };
    }

    // OpenCode：生成 command markdown 写入 ~/.config/opencode/commands/<skillId>.md
    if (targetType === 'opencode') {
      const commandPath = getSkillSymlinkPath(skillId, targetType);
      const commandDir = path.dirname(commandPath);
      if (!fs.existsSync(commandDir)) {
        fs.mkdirSync(commandDir, { recursive: true });
      }

      let fallbackDescription: string | undefined;
      const metadataPath = path.join(skillDir, 'skill.json');
      if (fs.existsSync(metadataPath)) {
        try {
          fallbackDescription = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'))?.description;
        } catch { /* ignore */ }
      }

      const content = buildOpencodeSkillCommandMarkdown(skillDir, skillId, fallbackDescription);
      atomicWriteFile(commandPath, content);
      return { success: true };
    }

    const symlinkPath = getSkillSymlinkPath(skillId, targetType);

    const targetBaseDir = path.dirname(symlinkPath);
    if (!fs.existsSync(targetBaseDir)) {
      fs.mkdirSync(targetBaseDir, { recursive: true });
    }

    if (fs.existsSync(symlinkPath)) {
      if (fs.lstatSync(symlinkPath).isSymbolicLink()) {
        fs.unlinkSync(symlinkPath);
      } else {
        return { success: false, error: '目标路径已存在非软链接文件' };
      }
    }

    const relativePath = path.relative(targetBaseDir, skillDir);

    if (process.platform === 'win32') {
      fs.symlinkSync(skillDir, symlinkPath, 'junction');
    } else {
      fs.symlinkSync(relativePath, symlinkPath);
    }

    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

async function removeSkillSymlink(skillId: string, targetType: TargetType): Promise<{ success: boolean; error?: string }> {
  try {
    const symlinkPath = getSkillSymlinkPath(skillId, targetType);

    if (targetType === 'opencode') {
      // OpenCode：删除 command 文件
      if (fs.existsSync(symlinkPath)) {
        fs.unlinkSync(symlinkPath);
      }
      return { success: true };
    }

    if (!fs.existsSync(symlinkPath)) {
      return { success: true };
    }

    const stats = fs.lstatSync(symlinkPath);
    if (stats.isSymbolicLink()) {
      fs.unlinkSync(symlinkPath);
    }

    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// GitHub URL解析工具函数
interface GitHubRepoInfo {
  owner: string;
  repo: string;
  path: string;
}

function parseGitHubUrl(githubUrl: string, subPath?: string): GitHubRepoInfo {
  // 解析各种GitHub URL格式
  const patterns = [
    // https://github.com/owner/repo/tree/{ref}/path/to/dir
    /github\.com\/([^\/]+)\/([^\/]+)(?:\/tree\/[^\/]+)?\/(.*)/,
    // git@github.com:owner/repo.git
    /git@github\.com:([^\/]+)\/([^\/]+)(?:\.git)?$/,
  ];

  for (const pattern of patterns) {
    const match = githubUrl.match(pattern);
    if (match) {
      let owner = match[1];
      let repo = match[2];
      let repoPath = match[3] || '';

      // 移除.git后缀（如果存在）
      if (repo.endsWith('.git')) {
        repo = repo.slice(0, -4);
      }

      // 拼接完整路径
      const fullPath = subPath ? path.join(repoPath, subPath) : repoPath;

      return { owner, repo, path: fullPath };
    }
  }

  throw new Error(`无法解析GitHub URL: ${githubUrl}`);
}

// 重试配置
const MAX_RETRY_COUNT = 3;
const RETRY_DELAY_MS = 1000;

// 带重试的fetch包装函数，支持代理
async function fetchWithRetry(url: string, options: RequestInit = {}, retryCount = MAX_RETRY_COUNT): Promise<globalThis.Response> {
  let lastError: Error | null = null;

  // 获取代理配置
  const proxyUrl = getProxyAgent();

  for (let i = 0; i < retryCount; i++) {
    try {
      const fetchOptions: RequestInit = { ...options };

      // 如果启用了代理，添加 agent
      if (proxyUrl) {
        try {
          (fetchOptions as any).agent = new HttpsProxyAgent(proxyUrl);
          console.log(`使用代理请求: ${url}`);
        } catch (agentError) {
          console.warn('创建代理 agent 失败，将跳过代理:', agentError);
        }
      }

      const response = await fetch(url, fetchOptions);

      // 如果是403限流错误，等待后重试
      if (response.status === 403) {
        const resetTime = response.headers.get('X-RateLimit-Reset');
        const waitTime = resetTime
          ? Math.max(parseInt(resetTime) * 1000 - Date.now(), RETRY_DELAY_MS)
          : RETRY_DELAY_MS * (i + 1);

        console.warn(`GitHub API限流，等待 ${Math.ceil(waitTime / 1000)} 秒后重试...`);
        await new Promise(resolve => setTimeout(resolve, Math.min(waitTime, 30000)));
        continue;
      }

      return response;
    } catch (error) {
      lastError = error as Error;
      console.warn(`请求失败 (${i + 1}/${retryCount}):`, error);

      if (i < retryCount - 1) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * (i + 1)));
      }
    }
  }

  throw lastError || new Error('请求失败');
}

// 使用GitHub Contents API获取目录内容
async function getGitHubContents(owner: string, repo: string, filePath: string, ref?: string): Promise<any[]> {
  let apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;

  if (ref) {
    apiUrl += `?ref=${ref}`;
  }

  const response = await fetchWithRetry(apiUrl, {
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'AICodeSwitch-SkillsManager',
    },
  });

  if (!response.ok) {
    if (response.status === 403) {
      // API限流
      const resetTime = response.headers.get('X-RateLimit-Reset');
      throw new Error(`GitHub API限流，请稍后再试${resetTime ? `（${new Date(parseInt(resetTime) * 1000).toLocaleTimeString()}）` : ''}`);
    }
    if (response.status === 404) {
      throw new Error(`路径不存在: ${filePath}`);
    }
    throw new Error(`GitHub API错误: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  // Contents API对单个文件返回对象，对目录返回数组
  return Array.isArray(data) ? data : [data];
}

// 下载单个文件（带重试）
async function downloadFile(downloadUrl: string, targetPath: string, retryCount = MAX_RETRY_COUNT): Promise<void> {
  let lastError: Error | null = null;

  for (let i = 0; i < retryCount; i++) {
    try {
      const response = await fetchWithRetry(downloadUrl);

      if (!response.ok) {
        throw new Error(`下载失败: ${response.status} ${response.statusText}`);
      }

      const content = await response.text();

      // 确保目标目录存在
      const dir = path.dirname(targetPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(targetPath, content, 'utf-8');
      return;
    } catch (error) {
      lastError = error as Error;
      console.warn(`文件下载失败 (${i + 1}/${retryCount}):`, downloadUrl);

      if (i < retryCount - 1) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * (i + 1)));
      }
    }
  }

  throw lastError || new Error('文件下载失败');
}

// 递归下载目录内容
async function downloadDirectory(owner: string, repo: string, contents: any[], basePath: string, ref?: string): Promise<number> {
  let downloadedCount = 0;

  for (const item of contents) {
    const relativePath = item.path ? item.path.split('/').slice(-1)[0] : item.name;
    const targetPath = path.join(basePath, relativePath);

    if (item.type === 'file') {
      // 下载文件
      if (item.download_url) {
        await downloadFile(item.download_url, targetPath);
        downloadedCount++;
      }
    } else if (item.type === 'dir') {
      // 递归下载子目录
      const subContents = await getGitHubContents(owner, repo, item.path, ref);
      const subCount = await downloadDirectory(owner, repo, subContents, targetPath, ref);
      downloadedCount += subCount;
    }
  }

  return downloadedCount;
}

// 验证下载完整性
function verifyDownload(targetDir: string): { valid: boolean; filesCount: number; error?: string } {
  if (!fs.existsSync(targetDir)) {
    return { valid: false, filesCount: 0, error: '目标目录不存在' };
  }

  const hasSkillJson = fs.existsSync(path.join(targetDir, 'skill.json'));
  const hasSkillMd = fs.existsSync(path.join(targetDir, 'SKILL.md'));

  if (!hasSkillJson && !hasSkillMd) {
    return { valid: false, filesCount: 0, error: '缺少必要文件: skill.json 或 SKILL.md' };
  }

  // 统计下载的文件数量
  let filesCount = 0;
  try {
    const countFiles = (dir: string) => {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        if (item.isFile()) {
          filesCount++;
        } else if (item.isDirectory()) {
          countFiles(path.join(dir, item.name));
        }
      }
    };
    countFiles(targetDir);
  } catch (error) {
    return { valid: false, filesCount: 0, error: '无法读取目录' };
  }

  if (filesCount === 0) {
    return { valid: false, filesCount: 0, error: '下载的文件为空' };
  }

  return { valid: true, filesCount };
}

// 从GitHub下载指定路径的skill
async function downloadSkillFromGitHub(githubUrl: string, skillPath: string, targetDir: string): Promise<{ success: boolean; filesDownloaded: number; error?: string }> {
  try {
    // 解析GitHub URL
    const { owner, repo, path: repoPath } = parseGitHubUrl(githubUrl, skillPath);

    // 构造完整路径
    const fullPath = repoPath || skillPath;

    if (!fullPath) {
      throw new Error('无效的skill路径');
    }

    // 获取目录内容
    const contents = await getGitHubContents(owner, repo, fullPath);

    if (contents.length === 0) {
      throw new Error('目录为空');
    }

    // 确保目标目录存在
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // 递归下载所有文件
    const filesDownloaded = await downloadDirectory(owner, repo, contents, targetDir);

    if (filesDownloaded === 0) {
      throw new Error('未能下载任何文件');
    }

    // 验证下载完整性
    const verification = verifyDownload(targetDir);
    if (!verification.valid) {
      // 清理不完整的下载
      fs.rmSync(targetDir, { recursive: true, force: true });
      throw new Error(`下载验证失败: ${verification.error}`);
    }

    return { success: true, filesDownloaded };
  } catch (error: any) {
    return { success: false, filesDownloaded: 0, error: error.message };
  }
}

const listInstalledSkills = (): InstalledSkill[] => {
  const result = new Map<string, InstalledSkill>();
  const centralDir = getCentralSkillsDir();

  if (!fs.existsSync(centralDir)) {
    return [];
  }

  const entries = fs.readdirSync(centralDir, { withFileTypes: true });
  entries.filter(entry => entry.isDirectory()).forEach(entry => {
    const skillId = entry.name;
    const skillDir = path.join(centralDir, skillId);
    const metadataPath = path.join(skillDir, 'skill.json');

    if (!fs.existsSync(metadataPath)) {
      return;
    }

    try {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));

      const enabledTargets: TargetType[] = [];

      ['claude-code', 'codex', 'opencode'].forEach((targetType) => {
        if (isSkillSymlinkExists(skillId, targetType as TargetType)) {
          enabledTargets.push(targetType as TargetType);
        }
      });

      const existing = result.get(skillId);
      if (existing) {
        existing.targets = [...new Set([...existing.targets, ...(metadata.targets || [])])];
        existing.enabledTargets = enabledTargets;
      } else {
        result.set(skillId, {
          id: skillId,
          name: metadata.name || skillId,
          description: metadata.description,
          targets: metadata.targets || [],
          enabledTargets: enabledTargets,
          githubUrl: metadata.githubUrl,
          skillPath: metadata.skillPath,
          installedAt: metadata.installedAt || Date.now(),
        });
      }
    } catch (error) {
      console.error(`Failed to parse skill metadata for ${skillId}:`, error);
    }
  });

  return Array.from(result.values()).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
};

const registerRoutes = async (dbManager: FileSystemDatabaseManager, proxyServer: ProxyServer) => {
  updateProxyConfig(dbManager.getConfig());

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // 数据就绪验证端点（供 Tauri 启动阶段确认后端完全可用）
  app.get('/api/ready', (_req, res) => {
    const vendors = dbManager.getVendors();
    const routes = dbManager.getRoutes();
    res.json({ ready: true, vendorsCount: vendors.length, routesCount: routes.length });
  });

  // 局域网访问控制中间件：当 enableLanDiscovery 关闭时，仅允许本机访问 /api/* 路由
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    const config = dbManager.getConfig();
    if (config.enableLanDiscovery) {
      return next();
    }
    const clientIp = req.ip || req.socket.remoteAddress || '';
    // 规范化 IPv4-mapped IPv6 地址 (::ffff:127.0.0.1 -> 127.0.0.1)
    const normalizedIp = clientIp.replace(/^::ffff:/, '');
    if (normalizedIp === '127.0.0.1' || normalizedIp === '::1' || normalizedIp === 'localhost') {
      return next();
    }
    console.warn(`[LAN Guard] 拒绝非本机访问: ${clientIp} -> ${req.method} ${req.path}`);
    res.status(403).json({ error: 'LAN access is disabled. Only local access is allowed.' });
  });

  // 鉴权相关路由 - 公开访问
  app.get('/api/auth/status', (_req, res) => {
    const response: AuthStatus = { enabled: isAuthEnabled() };
    res.json(response);
  });

  app.post('/api/auth/login', (req, res) => {
    const { authCode } = req.body as LoginRequest;

    if (!authCode) {
      res.status(400).json({ error: 'Auth code is required' });
      return;
    }

    if (verifyAuthCode(authCode)) {
      const token = generateToken();
      const response: LoginResponse = { token };
      res.json(response);
    } else {
      res.status(401).json({ error: 'Invalid auth code' });
    }
  });

  // 鉴权中间件 - 保护所有 /api/* 路由 (除了 /api/auth/* 和 /api/lan/discover)
  app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/auth/') || req.path === '/lan/discover') {
      next(); // /api/auth/* 和 /api/lan/discover 路由不需要鉴权
    } else {
      authMiddleware(req, res, next);
    }
  });

  app.get('/api/vendors', (_req, res) => res.json(dbManager.getVendors()));
  app.post('/api/vendors', asyncHandler(async (req, res) => {
    res.json(await dbManager.createVendor(req.body));
  }));
  app.put('/api/vendors/:id', asyncHandler(async (req, res) => {
    res.json(await dbManager.updateVendor(req.params.id, req.body));
  }));
  app.delete('/api/vendors/:id', async (req, res) => {
    try {
      const result = await dbManager.deleteVendor(req.params.id);
      res.json(result);
    } catch (error) {
      console.error('[删除供应商] 错误:', error);
      res.setHeader('Content-Type', 'application/json');
      res.status(500).json({ error: error instanceof Error ? error.message : '删除失败' });
    }
  });

  app.get('/api/services', (req, res) => {
    const vendorId = typeof req.query.vendorId === 'string' ? req.query.vendorId : undefined;
    res.json(dbManager.getAPIServices(vendorId));
  });
  app.post('/api/services', asyncHandler(async (req, res) => {
    console.log('[创建服务] 请求数据:', JSON.stringify(req.body, null, 2));
    const result = await dbManager.createAPIService(req.body);
    console.log('[创建服务] 创建结果:', JSON.stringify(result, null, 2));
    res.json(result);
  }));
  app.put('/api/services/:id', asyncHandler(async (req, res) => {
    const existingService = dbManager.getAPIService(req.params.id);
    if (!existingService) {
      res.status(404).json({ error: '服务不存在' });
      return;
    }

    res.json(await dbManager.updateAPIService(req.params.id, req.body));
  }));
  app.delete('/api/services/:id', async (req, res) => {
    console.log('[删除服务] 请求 ID:', req.params.id);
    try {
      const result = await dbManager.deleteAPIService(req.params.id);
      console.log('[删除服务] 结果:', result);
      res.json(result);
    } catch (error) {
      console.error('[删除服务] 错误:', error);
      // 显式设置 Content-Type 并返回 JSON 错误
      res.setHeader('Content-Type', 'application/json');
      res.status(500).json({ error: error instanceof Error ? error.message : '删除失败' });
    }
  });

  app.get('/api/routes', (_req, res) => res.json(dbManager.getRoutes()));
  app.post('/api/routes', asyncHandler(async (req, res) => res.json(await dbManager.createRoute(req.body))));
  app.put('/api/routes/:id', asyncHandler(async (req, res) => res.json(await dbManager.updateRoute(req.params.id, req.body))));
  app.delete('/api/routes/:id', asyncHandler(async (req, res) => {
    // Check if route is bound to any tool
    if (dbManager.isRouteBound(req.params.id)) {
      return res.status(400).json({ error: '该路由当前被工具使用中，请先停用后再删除' });
    }
    const result = await dbManager.deleteRoute(req.params.id);
    res.json(result);
  }));
  // Tool Bindings API
  app.get('/api/tool-bindings', (_req, res) => {
    res.json(dbManager.getToolBindings());
  });

  app.post(
    '/api/tool-bindings/activate',
    asyncHandler(async (req, res) => {
      const { tool, routeId } = req.body as { tool: ToolName; routeId: string };
      if (!tool || !routeId) {
        return res.status(400).json({ error: 'tool and routeId are required' });
      }
      if (tool !== 'claude-code' && tool !== 'codex' && tool !== 'opencode') {
        return res.status(400).json({ error: 'Invalid tool name' });
      }
      const route = dbManager.getRoute(routeId);
      if (!route) {
        return res.status(404).json({ error: 'Route not found' });
      }

      const result = await dbManager.activateToolRoute(tool, routeId);
      if (result) {
        await proxyServer.reloadRoutes();

        // Sync MCP config for this tool
        const mcps = dbManager.getMCPs();
        const hasMCPForTarget = mcps.some(m => m.targets?.includes(tool));
        if (hasMCPForTarget) {
          await writeMCPConfig(tool);
        }
      }
      res.json({ success: result });
    })
  );

  app.post(
    '/api/tool-bindings/deactivate',
    asyncHandler(async (req, res) => {
      const { tool } = req.body as { tool: ToolName };
      if (!tool || (tool !== 'claude-code' && tool !== 'codex' && tool !== 'opencode')) {
        return res.status(400).json({ error: 'Invalid tool name' });
      }

      const result = await dbManager.deactivateToolRoute(tool);
      if (result) {
        await proxyServer.reloadRoutes();
      }
      res.json({ success: result });
    })
  );

  // 批量停用所有工具绑定（用于应用关闭时清理）
  app.post(
    '/api/routes/deactivate-all',
    asyncHandler(async (_req, res) => {
      console.log('[Deactivate All] Starting tool-bindings deactivation...');

      const deactivatedCount = await dbManager.deactivateAllToolRoutes();

      if (deactivatedCount > 0) {
        console.log(`[Deactivate All] Deactivated ${deactivatedCount} tool binding(s), reloading routes...`);
        await proxyServer.reloadRoutes();
        console.log('[Deactivate All] Routes reloaded successfully');
      } else {
        console.log('[Deactivate All] No active tool bindings to deactivate');
      }

      console.log('[Deactivate All] Deactivation completed');

      res.json({
        success: true,
        deactivatedCount
      });
    })
  );

  app.get('/api/rules', (req, res) => {
    const routeId = typeof req.query.routeId === 'string' ? req.query.routeId : undefined;
    res.json(dbManager.getRules(routeId));
  });
  app.post('/api/rules', asyncHandler(async (req, res) => res.json(await dbManager.createRule(req.body))));
  app.put('/api/rules/:id', asyncHandler(async (req, res) => res.json(await dbManager.updateRule(req.params.id, req.body))));
  app.delete('/api/rules/:id', asyncHandler(async (req, res) => res.json(await dbManager.deleteRule(req.params.id))));
  app.put('/api/rules/:id/reset-tokens', asyncHandler(async (req, res) => res.json(await dbManager.resetRuleTokenUsage(req.params.id))));
  app.put('/api/rules/:id/reset-requests', asyncHandler(async (req, res) => res.json(await dbManager.resetRuleRequestCount(req.params.id))));
  app.put('/api/rules/:id/toggle-disable', asyncHandler(async (req, res) => res.json(await dbManager.toggleRuleDisabled(req.params.id))));

  // 解除规则的黑名单状态
  app.put(
    '/api/rules/:id/clear-blacklist',
    asyncHandler(async (req, res) => {
      const { id } = req.params;
      const rule = dbManager.getRule(id);

      if (!rule) {
        res.status(404).json({ error: 'Rule not found' });
        return;
      }

      // 找到该规则所属的路由
      const routes = dbManager.getRoutes();
      const route = routes.find(r => {
        const rules = dbManager.getRules(r.id);
        return rules.some(r => r.id === id);
      });

      if (!route) {
        res.status(404).json({ error: 'Route not found' });
        return;
      }

      try {
        await dbManager.removeFromBlacklist(
          rule.targetServiceId,
          route.id,
          rule.contentType
        );
        res.json({ success: true });
      } catch (error) {
        console.error('Error clearing blacklist:', error);
        res.status(500).json({ error: 'Failed to clear blacklist' });
      }
    })
  );

  // 获取所有规则的当前状态
  app.get(
    '/api/rules/status',
    asyncHandler(async (_req, res) => {
      // 获取所有规则
      const allRules = dbManager.getRules();

      // 获取有状态记录的规则
      const statusMap = rulesStatusBroadcaster.getAllRuleStatuses();

      // 将数组转换为 Map 以便快速查找
      const statusMapByRuleId = new Map(
        statusMap.map(status => [status.ruleId, status])
      );

      // 合并所有规则的状态
      const allStatuses = allRules.map(rule => {
        const existingStatus = statusMapByRuleId.get(rule.id);

        if (existingStatus) {
          // 如果有状态记录，返回记录的状态
          return existingStatus;
        } else {
          // 如果没有状态记录，返回默认的 idle 状态
          return {
            ruleId: rule.id,
            status: 'idle' as const,
            timestamp: Date.now(),
          };
        }
      });

      res.json(allStatuses);
    })
  );

  // SSE 端点：实时推送规则状态变更
  app.get(
    '/api/rules/status/stream',
    asyncHandler(async (req, res) => {
      // 设置 SSE 响应头
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no', // 防止 nginx 等代理缓冲
      });

      // 连接时立即发送完整快照（init 事件）
      const allRules = dbManager.getRules();
      const statusMap = rulesStatusBroadcaster.getAllRuleStatuses();
      const statusMapByRuleId = new Map(
        statusMap.map(status => [status.ruleId, status])
      );
      const allStatuses = allRules.map(rule => {
        const existingStatus = statusMapByRuleId.get(rule.id);
        if (existingStatus) {
          return existingStatus;
        } else {
          return {
            ruleId: rule.id,
            status: 'idle' as const,
            timestamp: Date.now(),
          };
        }
      });
      res.write(`data: ${JSON.stringify({ type: 'init', statuses: allStatuses })}\n\n`);

      // 监听状态变更，推送增量更新
      const onChange = (data: RuleStatusData) => {
        res.write(`data: ${JSON.stringify({ type: 'update', status: data })}\n\n`);
      };
      rulesStatusBroadcaster.on('statusChanged', onChange);

      // 3 秒心跳，用于客户端检测连接存活状态
      const heartbeat = setInterval(() => {
        res.write(`data: ${JSON.stringify({ type: 'heartbeat', timestamp: Date.now() })}\n\n`);
      }, 3000);

      // 客户端断开时清理
      req.on('close', () => {
        rulesStatusBroadcaster.off('statusChanged', onChange);
        clearInterval(heartbeat);
      });
    })
  );

  // Agent Map（任务可视化节点地图）路由：SSE 实时流 + REST 快照/事件
  registerAgentMapRoutes(app, agentMapService);

  // 清除规则的错误状态（广播 idle 状态给所有客户端）
  app.post(
    '/api/rules/:id/clear-status',
    asyncHandler(async (req, res) => {
      const { id } = req.params;
      const rule = dbManager.getRule(id);

      if (!rule) {
        res.status(404).json({ error: 'Rule not found' });
        return;
      }

      // 找到该规则所属的路由
      const routes = dbManager.getRoutes();
      const route = routes.find(r => {
        const rules = dbManager.getRules(r.id);
        return rules.some(r => r.id === id);
      });

      if (!route) {
        res.status(404).json({ error: 'Route not found' });
        return;
      }

      // 标记规则为 idle 状态
      rulesStatusBroadcaster.markRuleIdle(route.id, id);
      res.json({ success: true });
    })
  );

  // 获取规则的黑名单状态
  app.get(
    '/api/rules/:routeId/blacklist-status',
    asyncHandler(async (req, res) => {
      const { routeId } = req.params;
      const rules = dbManager.getRules(routeId);

      try {
        const results = await Promise.all(
          rules.map(async (rule) => {
            const blacklistStatus = await dbManager.getRuleBlacklistStatus(
              rule.targetServiceId,
              routeId,
              rule.contentType
            );
            return {
              ruleId: rule.id,
              isBlacklisted: blacklistStatus !== null,
              blacklistEntry: blacklistStatus,
            };
          })
        );
        res.json(results);
      } catch (error) {
        console.error('Error getting blacklist status:', error);
        res.status(500).json({ error: 'Failed to get blacklist status' });
      }
    })
  );

  app.get(
    '/api/logs',
    asyncHandler(async (req, res) => {
      const rawLimit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : NaN;
      const rawOffset = typeof req.query.offset === 'string' ? parseInt(req.query.offset, 10) : NaN;
      const limit = Number.isFinite(rawLimit) ? rawLimit : 100;
      const offset = Number.isFinite(rawOffset) ? rawOffset : 0;
      const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
      const keyword = str(req.query.keyword) || str(req.query.query);
      const filters = {
        targetType: str(req.query.targetType) || undefined,
        vendorId: str(req.query.vendorId) || undefined,
        targetServiceId: str(req.query.serviceId) || str(req.query.targetServiceId) || undefined,
        targetModel: str(req.query.model) || str(req.query.targetModel) || undefined,
        routeId: str(req.query.routeId) || undefined,
      };
      const hasAnyFilter = keyword || filters.targetType || filters.vendorId || filters.targetServiceId || filters.targetModel || filters.routeId;
      if (hasAnyFilter) {
        const result = await dbManager.queryLogs({ filters, keyword, limit, offset });
        res.json({ logs: result.data, total: result.total });
      } else {
        // 无筛选：仍返回 total，避免前端额外请求 count
        const [logs, total] = await Promise.all([
          dbManager.getLogs(limit, offset),
          dbManager.getLogsCount(),
        ]);
        res.json({ logs, total });
      }
    })
  );
  app.delete(
    '/api/logs',
    asyncHandler(async (_req, res) => {
      await dbManager.clearLogs();
      res.json(true);
    })
  );

  app.get(
    '/api/error-logs',
    asyncHandler(async (req, res) => {
      const rawLimit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : NaN;
      const rawOffset = typeof req.query.offset === 'string' ? parseInt(req.query.offset, 10) : NaN;
      const limit = Number.isFinite(rawLimit) ? rawLimit : 100;
      const offset = Number.isFinite(rawOffset) ? rawOffset : 0;
      const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
      const filters = {
        targetType: str(req.query.targetType) || undefined,
        vendorId: str(req.query.vendorId) || undefined,
        serviceId: str(req.query.serviceId) || str(req.query.targetServiceId) || undefined,
        model: str(req.query.model) || str(req.query.targetModel) || undefined,
        routeId: str(req.query.routeId) || undefined,
      };
      const keyword = str(req.query.keyword) || str(req.query.query);
      const hasAnyFilter = keyword || filters.targetType || filters.vendorId || filters.serviceId || filters.model || filters.routeId;
      if (hasAnyFilter) {
        const result = await dbManager.queryErrorLogs({ filters, keyword, limit, offset });
        res.json({ logs: result.data, total: result.total });
      } else {
        const [logs, total] = await Promise.all([
          dbManager.getErrorLogs(limit, offset),
          dbManager.getErrorLogsCount(),
        ]);
        res.json({ logs, total });
      }
    })
  );
  app.delete(
    '/api/error-logs',
    asyncHandler(async (_req, res) => {
      await dbManager.clearErrorLogs();
      res.json(true);
    })
  );

  app.delete(
    '/api/statistics',
    asyncHandler(async (_req, res) => {
      await dbManager.resetStatistics();
      res.json(true);
    })
  );

  app.get(
    '/api/logs/count',
    asyncHandler(async (_req, res) => {
      const count = await dbManager.getLogsCount();
      res.json({ count });
    })
  );

  app.get(
    '/api/logs/search',
    asyncHandler(async (req, res) => {
      const query = typeof req.query.query === 'string' ? req.query.query : '';
      const rawLimit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : NaN;
      const rawOffset = typeof req.query.offset === 'string' ? parseInt(req.query.offset, 10) : NaN;
      const limit = Number.isFinite(rawLimit) ? rawLimit : 100;
      const offset = Number.isFinite(rawOffset) ? rawOffset : 0;
      const logs = await dbManager.searchLogs(query, limit, offset);
      res.json(logs);
    })
  );

  app.get(
    '/api/logs/search/count',
    asyncHandler(async (req, res) => {
      const query = typeof req.query.query === 'string' ? req.query.query : '';
      const count = await dbManager.searchLogsCount(query);
      res.json({ count });
    })
  );

  app.get(
    '/api/error-logs/count',
    asyncHandler(async (_req, res) => {
      const count = await dbManager.getErrorLogsCount();
      res.json({ count });
    })
  );

  app.get(
    '/api/error-logs/search',
    asyncHandler(async (req, res) => {
      const query = typeof req.query.query === 'string' ? req.query.query : '';
      const rawLimit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : NaN;
      const rawOffset = typeof req.query.offset === 'string' ? parseInt(req.query.offset, 10) : NaN;
      const limit = Number.isFinite(rawLimit) ? rawLimit : 100;
      const offset = Number.isFinite(rawOffset) ? rawOffset : 0;
      const logs = await dbManager.searchErrorLogs(query, limit, offset);
      res.json(logs);
    })
  );

  app.get(
    '/api/error-logs/search/count',
    asyncHandler(async (req, res) => {
      const query = typeof req.query.query === 'string' ? req.query.query : '';
      const count = await dbManager.searchErrorLogsCount(query);
      res.json({ count });
    })
  );

  app.get('/api/config', (_req, res) => res.json(dbManager.getConfig()));
  app.put(
    '/api/config',
    asyncHandler(async (req, res) => {
      const config = req.body as AppConfig;
      const result = await dbManager.updateConfig(config);
      if (result) {
        const latestConfig = dbManager.getConfig();
        await proxyServer.updateConfig(latestConfig);
        updateProxyConfig(latestConfig);
        await syncConfigsOnGlobalConfigUpdate(dbManager);
        applyWriteLocalRecords(proxyServer);
      }
      res.json(result);
    })
  );

  // ===================== 局域网同步相关 =====================

  // GET /api/lan/discover - 远端节点暴露配置数据（不受鉴权保护，由开关控制）
  app.get('/api/lan/discover', (_req, res) => {
    const config = dbManager.getConfig();
    if (!config.enableLanDiscovery) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    try {
      // 收集 Skills
      const installedSkills = listInstalledSkills();
      const skills: Array<{
        name: string;
        description?: string;
        targets?: string[];
        githubUrl?: string;
        skillPath?: string;
        instruction?: string;
      }> = [];

      for (const skill of installedSkills) {
        const skillItem: typeof skills[0] = {
          name: skill.name,
          description: skill.description,
          targets: skill.targets,
          githubUrl: skill.githubUrl,
          skillPath: skill.skillPath,
        };
        // 尝试读取 SKILL.md 内容
        const skillDir = path.join(getCentralSkillsDir(), skill.id);
        const skillMdPath = path.join(skillDir, 'SKILL.md');
        if (fs.existsSync(skillMdPath)) {
          try {
            skillItem.instruction = fs.readFileSync(skillMdPath, 'utf-8');
          } catch { /* ignore */ }
        }
        skills.push(skillItem);
      }

      // 收集 MCPs（脱敏 headers 和 env 中的敏感信息）
      const SENSITIVE_KEY_PATTERN = /api_key|apikey|access_token|accesstoken|auth|key|token|secret|password|private_key|privatekey|credentials/i;
      const allMcps = dbManager.getMCPs();
      const mcps = allMcps.map(mcp => {
        const sanitized: Record<string, unknown> = {
          name: mcp.name,
          description: mcp.description,
          type: mcp.type,
          command: mcp.command,
          args: mcp.args,
          targets: mcp.targets,
        };
        if (mcp.url) sanitized.url = mcp.url;
        // 脱敏 env
        if (mcp.env) {
          const sanitizedEnv: Record<string, string> = {};
          for (const [key, value] of Object.entries(mcp.env)) {
            if (SENSITIVE_KEY_PATTERN.test(key)) {
              sanitizedEnv[key] = '***';
            } else {
              sanitizedEnv[key] = value;
            }
          }
          sanitized.env = sanitizedEnv;
        }
        // 脱敏 headers
        if (mcp.headers) {
          const sanitizedHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(mcp.headers)) {
            if (SENSITIVE_KEY_PATTERN.test(key)) {
              sanitizedHeaders[key] = '***';
            } else {
              sanitizedHeaders[key] = value;
            }
          }
          sanitized.headers = sanitizedHeaders;
        }
        return sanitized;
      });

      // 读取版本号
      let version = 'unknown';
      try {
        const pkgPath = path.join(__dirname, '..', 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        version = pkg.version || 'unknown';
      } catch { /* ignore */ }

      res.json({
        node: {
          name: os.hostname(),
          version,
          port: process.env.PORT ? parseInt(process.env.PORT) : 4567,
        },
        skills,
        mcps,
      });
    } catch (error) {
      console.error('[LAN Discover] 错误:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/lan/scan - 获取本机局域网 IP 信息
  app.get('/api/lan/scan', (_req, res) => {
    const interfaces = os.networkInterfaces();
    const port = process.env.PORT ? parseInt(process.env.PORT) : 4567;

    // 收集所有非内部 IPv4 网络接口
    const networkInterfaces: Array<{ name: string; address: string; subnet: string; netmask: string }> = [];
    let localIp = '127.0.0.1';
    let subnet = '127.0.0';

    for (const [ifaceName, entries] of Object.entries(interfaces)) {
      if (!entries) continue;
      for (const entry of entries) {
        if (entry.family === 'IPv4' && !entry.internal) {
          const entrySubnet = entry.address.split('.').slice(0, 3).join('.');
          networkInterfaces.push({
            name: ifaceName,
            address: entry.address,
            subnet: entrySubnet,
            netmask: entry.netmask,
          });
          // 兼容旧逻辑：取第一个非内部接口作为默认值
          if (localIp === '127.0.0.1') {
            localIp = entry.address;
            subnet = entrySubnet;
          }
        }
      }
    }

    res.json({ localIp, subnet, port, networkInterfaces });
  });

  // POST /api/lan/sync - 执行同步写入
  app.post('/api/lan/sync', asyncHandler(async (req, res) => {
    const { remoteNode, skills, mcps, vendor } = req.body as {
      remoteNode: { ip: string; port: number; name: string };
      skills: Array<{
        name: string;
        description?: string;
        targets?: string[];
        githubUrl?: string;
        skillPath?: string;
        instruction?: string;
      }>;
      mcps: Array<{
        name: string;
        description?: string;
        type: 'stdio' | 'http' | 'sse';
        command?: string;
        args?: string[];
        url?: string;
        headers?: Record<string, string>;
        env?: Record<string, string>;
        targets?: string[];
      }>;
      vendor: { enabled: boolean; apiKey?: string };
    };

    const result = {
      skillsImported: 0,
      mcpsImported: 0,
      vendorCreated: false,
      vendorName: '',
      servicesCreated: 0,
    };

    // 1. 同步 Skills
    const centralDir = getCentralSkillsDir();
    if (!fs.existsSync(centralDir)) {
      fs.mkdirSync(centralDir, { recursive: true });
    }
    const existingSkills = listInstalledSkills();
    const existingSkillNames = new Set(existingSkills.map(s => s.name));

    for (const skill of skills) {
      if (existingSkillNames.has(skill.name)) continue; // 防御性跳过

      const dirName = sanitizeDirName(skill.name);
      const skillDir = path.join(centralDir, dirName);
      if (!fs.existsSync(skillDir)) {
        fs.mkdirSync(skillDir, { recursive: true });
      }

      // 写入 skill.json
      const skillJson = {
        id: dirName,
        name: skill.name,
        description: skill.description || '',
        targets: skill.targets || [],
        enabledTargets: [] as string[], // 不自动选中编程工具，由用户自行配置
        githubUrl: skill.githubUrl,
        skillPath: skill.skillPath,
        installedAt: Date.now(),
      };
      fs.writeFileSync(path.join(skillDir, 'skill.json'), JSON.stringify(skillJson, null, 2));

      // 写入 SKILL.md（如果有 instruction）
      if (skill.instruction) {
        fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skill.instruction);
      }

      result.skillsImported++;
    }

    // 2. 同步 MCPs
    const existingMcps = dbManager.getMCPs();
    const existingMcpNames = new Set(existingMcps.map(m => m.name));

    for (const mcp of mcps) {
      if (existingMcpNames.has(mcp.name)) continue; // 防御性跳过

      await dbManager.createMCP({
        name: mcp.name,
        description: mcp.description,
        type: mcp.type,
        command: mcp.command,
        args: mcp.args,
        url: mcp.url,
        headers: mcp.headers,
        env: mcp.env,
        targets: [], // 不自动选中编程工具，由用户自行配置
      });
      result.mcpsImported++;
    }

    // 3. 可选：创建供应商（将远端节点的代理路径映射为固定 API 服务）
    if (vendor.enabled) {
      const vendorName = `${remoteNode.name}@${remoteNode.ip}`;
      const remoteBaseUrl = `http://${remoteNode.ip}:${remoteNode.port}`;

      // 固定的代理路径到 API 服务映射
      // 规则：Claude/Responses/Gemini 标准接口只填 baseurl，Chat Completions 需完整路径
      const LAN_PROXY_SERVICES: Array<{ name: string; sourceType: SourceType; apiUrl: string }> = [
        { name: 'Claude Code', sourceType: 'claude', apiUrl: `${remoteBaseUrl}/claude-code` },
        { name: 'Codex', sourceType: 'openai', apiUrl: `${remoteBaseUrl}/codex` },
        { name: 'Claude 标准接口', sourceType: 'claude', apiUrl: remoteBaseUrl },
        { name: 'Responses 标准接口', sourceType: 'openai', apiUrl: remoteBaseUrl },
        { name: 'Chat Completions 标准接口', sourceType: 'openai-chat', apiUrl: `${remoteBaseUrl}/v1/chat/completions` },
        { name: 'Gemini 标准接口', sourceType: 'gemini', apiUrl: remoteBaseUrl },
      ];

      // 检查供应商是否已存在
      const existingVendor = dbManager.getVendors().find(v => v.name === vendorName);
      if (!existingVendor) {
        const services: Omit<APIService, 'id' | 'createdAt' | 'updatedAt'>[] = LAN_PROXY_SERVICES.map(svc => ({
          name: svc.name,
          apiUrl: svc.apiUrl,
          apiKey: vendor.apiKey || '',
          sourceType: svc.sourceType,
          enableProxy: false,
          enableCodingPlan: false,
        }));

        await dbManager.createVendor({
          name: vendorName,
          description: `从局域网节点 ${remoteNode.ip}:${remoteNode.port} 同步`,
          apiBaseUrl: remoteBaseUrl,
          services: services as any[],
        });
        result.vendorCreated = true;
        result.vendorName = vendorName;
        result.servicesCreated = services.length;
      }
    }

    res.json({ success: true, result });
  }));

  // Skills 管理相关
  app.get('/api/skills/installed', (_req, res) => {
    const skills = listInstalledSkills();
    res.json(skills);
  });

  app.post(
    '/api/skills/search',
    asyncHandler(async (req, res) => {
      const { query } = req.body as { query?: string };
      if (!query || !query.trim()) {
        res.status(400).json({ error: 'Query is required' });
        return;
      }

      if (!SKILLSMP_API_KEY) {
        res.status(500).json({ error: 'SKILLSMP_API_KEY 未配置' });
        return;
      }

      const url = `https://skillsmp.com/api/v1/skills/ai-search?q=${encodeURIComponent(query.trim())}`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${SKILLSMP_API_KEY}`,
        },
      });

      if (!response.ok) {
        let errorMessage = 'Skills 搜索失败';
        try {
          const errorBody = await response.json();
          errorMessage = errorBody?.error?.message || errorMessage;
        } catch (error) {
          errorMessage = await response.text();
        }
        res.status(response.status).json({ error: errorMessage });
        return;
      }

      const data = await response.json();
      const results = (data?.data?.data || [])
        .map((item: any) => item?.skill)
        .filter(Boolean)
        .map((skill: any) => {
          const tags: any[] = [
            skill.author ? `作者: ${skill.author}` : null,
            typeof skill.stars === 'number' ? `⭐ ${skill.stars}` : null,
          ].filter(Boolean);

          const result: SkillCatalogItem = {
            id: skill.id,
            name: skill.name || skill.id,
            description: skill.description,
            tags: tags.length > 0 ? tags : [],
            url: skill.githubUrl || skill.skillUrl,
          };

          return result;
        });

      res.json(results);
    })
  );

  app.post(
    '/api/skills/install',
    asyncHandler(async (req, res) => {
      const { skillId, name, description, tags, githubUrl, skillPath } = req.body as SkillInstallRequest & { githubUrl?: string; skillPath?: string };

      if (!skillId) {
        const response: SkillInstallResponse = {
          success: false,
          message: '缺少 Skill ID',
        };
        res.status(400).json(response);
        return;
      }

      const skillName = name || skillId;
      const skillDir = getSkillDirByName(skillName);
      const sanitizedDirName = path.basename(skillDir);

      if (fs.existsSync(skillDir)) {
        const existingSkillJson = path.join(skillDir, 'skill.json');
        let existingMetadata: any = null;
        if (fs.existsSync(existingSkillJson)) {
          try {
            existingMetadata = JSON.parse(fs.readFileSync(existingSkillJson, 'utf-8'));
          } catch (e) {
            // 忽略解析错误
          }
        }

        if (githubUrl) {
          const downloadResult = await downloadSkillFromGitHub(
            githubUrl,
            skillPath || '',
            skillDir
          );

          if (!downloadResult.success) {
            const response: SkillInstallResponse = {
              success: false,
              message: `下载失败: ${downloadResult.error}`,
            };
            res.status(500).json(response);
            return;
          }

          const metadata = {
            id: sanitizedDirName,
            name: name || existingMetadata?.name || skillId,
            description: description || existingMetadata?.description,
            tags: tags || existingMetadata?.tags,
            githubUrl,
            skillPath,
            targets: [...(existingMetadata?.targets || [])],
            enabledTargets: [...(existingMetadata?.enabledTargets || [])],
            installedAt: existingMetadata?.installedAt || Date.now(),
            updatedAt: Date.now(),
            filesDownloaded: downloadResult.filesDownloaded,
          };
          fs.writeFileSync(path.join(skillDir, 'skill.json'), JSON.stringify(metadata, null, 2));

          const response: SkillInstallResponse = {
            success: true,
            installedSkill: {
              id: sanitizedDirName,
              name: metadata.name,
              description: metadata.description,
              targets: metadata.targets,
              enabledTargets: metadata.enabledTargets,
              githubUrl,
              skillPath,
              installedAt: metadata.installedAt,
            }
          };
          res.json(response);
          return;
        }
      } else {
        fs.mkdirSync(skillDir, { recursive: true });
      }

      if (githubUrl) {
        const downloadResult = await downloadSkillFromGitHub(
          githubUrl,
          skillPath || '',
          skillDir
        );

        if (!downloadResult.success) {
          const response: SkillInstallResponse = {
            success: false,
            message: `下载失败: ${downloadResult.error}`,
          };
          res.status(500).json(response);
          return;
        }
      }

      const metadata = {
        id: sanitizedDirName,
        name: name || skillId,
        description,
        tags,
        targets: [],
        enabledTargets: [],
        githubUrl,
        skillPath,
        installedAt: Date.now(),
      };

      fs.writeFileSync(path.join(skillDir, 'skill.json'), JSON.stringify(metadata, null, 2));

      const response: SkillInstallResponse = {
        success: true,
        installedSkill: {
          id: sanitizedDirName,
          name: metadata.name,
          description: metadata.description,
          targets: [],
          enabledTargets: [],
          githubUrl,
          skillPath,
          installedAt: metadata.installedAt,
        }
      };

      res.json(response);
    })
  );

  app.post(
    '/api/skills/create-local',
    asyncHandler(async (req, res) => {
      const { name, description, instruction, link, targets } = req.body as {
        name: string;
        description: string;
        instruction: string;
        link?: string;
        targets: TargetType[];
      };

      if (!name?.trim()) {
        res.status(400).json({ success: false, message: '请填写 Skill 名称' });
        return;
      }
      if (!description?.trim()) {
        res.status(400).json({ success: false, message: '请填写描述' });
        return;
      }
      if (!instruction?.trim()) {
        res.status(400).json({ success: false, message: '请填写指令' });
        return;
      }
      if (!targets || targets.length === 0) {
        res.status(400).json({ success: false, message: '请至少选择一个安装目标' });
        return;
      }

      const skillDir = getSkillDirByName(name);
      const sanitizedDirName = path.basename(skillDir);

      if (fs.existsSync(skillDir)) {
        res.status(200).json({ success: false, message: `Skill "${name}" 已存在` });
        return;
      }

      fs.mkdirSync(skillDir, { recursive: true });

      const skillMdContent = `---
name: ${sanitizedDirName}
description: ${description.trim()}
---

# ${name.trim()}

${description.trim()}

## 指令

${instruction}
`;
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillMdContent, 'utf-8');

      const metadata = {
        id: sanitizedDirName,
        name: name.trim(),
        description: description.trim(),
        tags: [],
        targets: targets,
        enabledTargets: [],
        githubUrl: link || '',
        skillPath: '',
        installedAt: Date.now(),
      };

      fs.writeFileSync(path.join(skillDir, 'skill.json'), JSON.stringify(metadata, null, 2));

      const response: SkillInstallResponse = {
        success: true,
        installedSkill: {
          id: sanitizedDirName,
          name: metadata.name,
          description: metadata.description,
          targets: metadata.targets,
          enabledTargets: [],
          githubUrl: link || '',
          skillPath: '',
          installedAt: metadata.installedAt,
        }
      };

      res.json(response);
    })
  );

  // 获取skill详细信息（用于显示和安装）
  app.get(
    '/api/skills/:skillId/details',
    asyncHandler(async (req, res) => {
      const { skillId } = req.params;

      if (!SKILLSMP_API_KEY) {
        res.status(500).json({ error: 'SKILLSMP_API_KEY 未配置' });
        return;
      }

      try {
        const url = `https://skillsmp.com/api/v1/skills/${skillId}`;
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${SKILLSMP_API_KEY}`,
          },
        });

        if (!response.ok) {
          res.status(response.status).json({ error: '获取skill详情失败' });
          return;
        }

        const data = await response.json();
        const skill = data?.data;

        if (!skill) {
          res.status(404).json({ error: 'Skill不存在' });
          return;
        }

        res.json({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          author: skill.author,
          stars: skill.stars,
          githubUrl: skill.githubUrl || skill.skillUrl,
          skillPath: skill.skillPath || '',
          readme: skill.readme,
          tags: skill.tags || [],
        });
      } catch (error: any) {
        console.error('获取skill详情失败:', error);
        res.status(500).json({ error: error.message });
      }
    })
  );

  app.post(
    '/api/skills/:skillId/enable',
    asyncHandler(async (req, res) => {
      const { skillId } = req.params;
      const { targetType } = req.body as { targetType: TargetType };

      if (!targetType || (targetType !== 'claude-code' && targetType !== 'codex' && targetType !== 'opencode')) {
        res.status(400).json({ success: false, error: '无效的目标类型' });
        return;
      }

      const centralDir = getCentralSkillsDir();
      const skillDir = path.join(centralDir, skillId);

      if (!fs.existsSync(skillDir)) {
        res.status(404).json({ success: false, error: 'Skill不存在' });
        return;
      }

      const symlinkResult = await createSkillSymlink(skillId, targetType);

      if (!symlinkResult.success) {
        res.status(500).json({ success: false, error: symlinkResult.error });
        return;
      }

      const metadataPath = path.join(skillDir, 'skill.json');
      if (fs.existsSync(metadataPath)) {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
        if (!metadata.enabledTargets) {
          metadata.enabledTargets = [];
        }
        if (!metadata.enabledTargets.includes(targetType)) {
          metadata.enabledTargets.push(targetType);
        }
        fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
      }

      res.json({ success: true });
    })
  );

  app.post(
    '/api/skills/:skillId/disable',
    asyncHandler(async (req, res) => {
      const { skillId } = req.params;
      const { targetType } = req.body as { targetType: TargetType };

      if (!targetType || (targetType !== 'claude-code' && targetType !== 'codex' && targetType !== 'opencode')) {
        res.status(400).json({ success: false, error: '无效的目标类型' });
        return;
      }

      const symlinkResult = await removeSkillSymlink(skillId, targetType);

      if (!symlinkResult.success) {
        res.status(500).json({ success: false, error: symlinkResult.error });
        return;
      }

      const centralDir = getCentralSkillsDir();
      const skillDir = path.join(centralDir, skillId);
      const metadataPath = path.join(skillDir, 'skill.json');

      if (fs.existsSync(metadataPath)) {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
        if (metadata.enabledTargets) {
          metadata.enabledTargets = metadata.enabledTargets.filter((t: TargetType) => t !== targetType);
          fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
        }
      }

      res.json({ success: true });
    })
  );

  app.delete(
    '/api/skills/:skillId',
    asyncHandler(async (req, res) => {
      const { skillId } = req.params;

      const centralDir = getCentralSkillsDir();
      const skillDir = path.join(centralDir, skillId);

      if (!fs.existsSync(skillDir)) {
        res.status(404).json({ success: false, error: 'Skill不存在' });
        return;
      }

      ['claude-code', 'codex', 'opencode'].forEach(async (targetType) => {
        await removeSkillSymlink(skillId, targetType as TargetType);
      });

      fs.rmSync(skillDir, { recursive: true, force: true });

      res.json({ success: true });
    })
  );

  app.post(
    '/api/write-config/claude',
    asyncHandler(async (req, res) => {
      const appConfig = dbManager.getConfig();
      const requestedEnableAgentTeams = req.body.enableAgentTeams;
      const requestedBypass = req.body.enableBypassPermissionsSupport;
      const requestedMode = req.body.permissionsDefaultMode;
      const enableAgentTeams = typeof requestedEnableAgentTeams === 'boolean'
        ? requestedEnableAgentTeams
        : appConfig.enableAgentTeams;
      const enableBypassPermissionsSupport = typeof requestedBypass === 'boolean'
        ? requestedBypass
        : appConfig.enableBypassPermissionsSupport;
      const permissionsDefaultMode = isClaudePermissionDefaultMode(requestedMode)
        ? requestedMode
        : isClaudePermissionDefaultMode(appConfig.claudePermissionsDefaultMode)
          ? appConfig.claudePermissionsDefaultMode
          : DEFAULT_CLAUDE_PERMISSION_DEFAULT_MODE;
      const result = await writeClaudeConfig(
        dbManager,
        enableAgentTeams,
        enableBypassPermissionsSupport,
        permissionsDefaultMode,
        undefined,
        appConfig.claudeDefaultModel,
        appConfig.autocompactPctOverride
      );
      applyWriteLocalRecords(proxyServer);
      res.json(result);
    })
  );

  app.post(
    '/api/write-config/codex',
    asyncHandler(async (req, res) => {
      const appConfig = dbManager.getConfig();
      const requestedEffort = req.body.modelReasoningEffort;
      const modelReasoningEffort = isCodexReasoningEffort(requestedEffort)
        ? requestedEffort
        : isCodexReasoningEffort(appConfig.codexModelReasoningEffort)
          ? appConfig.codexModelReasoningEffort
        : DEFAULT_CODEX_REASONING_EFFORT;
      const requestedEnableMemories = req.body.enableMemories;
      const enableMemories = requestedEnableMemories !== undefined
        ? !!requestedEnableMemories
        : !!appConfig.codexEnableMemories;
      const result = await writeCodexConfig(
        dbManager,
        modelReasoningEffort,
        appConfig.codexDefaultModel,
        enableMemories
      );
      applyWriteLocalRecords(proxyServer);
      res.json(result);
    })
  );

  app.post(
    '/api/write-config/opencode',
    asyncHandler(async (req, res) => {
      const appConfig = dbManager.getConfig();
      const requestedModel = typeof req.body?.defaultModel === 'string' ? req.body.defaultModel : undefined;
      const defaultModel = requestedModel || appConfig.opencodeDefaultModel;
      const result = await writeOpencodeConfig(
        dbManager,
        defaultModel
      );
      applyWriteLocalRecords(proxyServer);
      res.json(result);
    })
  );

  // 兼容接口：更新全局 Agent Teams 配置
  app.post(
    '/api/update-claude-agent-teams',
    asyncHandler(async (req, res) => {
      const { enableAgentTeams } = req.body as { enableAgentTeams: boolean };
      const current = dbManager.getConfig();
      const result = await dbManager.updateConfig({
        ...current,
        enableAgentTeams: !!enableAgentTeams
      });
      if (result) {
        const latestConfig = dbManager.getConfig();
        await proxyServer.updateConfig(latestConfig);
        updateProxyConfig(latestConfig);
        await syncConfigsOnGlobalConfigUpdate(dbManager);
        applyWriteLocalRecords(proxyServer);
      }
      res.json(result);
    })
  );

  // 兼容接口：更新全局 bypassPermissions 支持配置
  app.post(
    '/api/update-claude-bypass-permissions-support',
    asyncHandler(async (req, res) => {
      const { enableBypassPermissionsSupport } = req.body as { enableBypassPermissionsSupport: boolean };
      const current = dbManager.getConfig();
      const result = await dbManager.updateConfig({
        ...current,
        enableBypassPermissionsSupport: !!enableBypassPermissionsSupport
      });
      if (result) {
        const latestConfig = dbManager.getConfig();
        await proxyServer.updateConfig(latestConfig);
        updateProxyConfig(latestConfig);
        await syncConfigsOnGlobalConfigUpdate(dbManager);
        applyWriteLocalRecords(proxyServer);
      }
      res.json(result);
    })
  );

  app.post(
    '/api/update-codex-reasoning-effort',
    asyncHandler(async (req, res) => {
      const requestedEffort = req.body.modelReasoningEffort;
      if (!isCodexReasoningEffort(requestedEffort)) {
        res.status(400).json({ error: 'Invalid modelReasoningEffort' });
        return;
      }

      const current = dbManager.getConfig();
      const result = await dbManager.updateConfig({
        ...current,
        codexModelReasoningEffort: requestedEffort
      });
      if (result) {
        const latestConfig = dbManager.getConfig();
        await proxyServer.updateConfig(latestConfig);
        updateProxyConfig(latestConfig);
        await syncConfigsOnGlobalConfigUpdate(dbManager);
        applyWriteLocalRecords(proxyServer);
      }
      res.json(result);
    })
  );

  app.post(
    '/api/restore-config/claude',
    asyncHandler(async (_req, res) => {
      const result = await restoreClaudeConfig();
      res.json(result);
    })
  );

  app.post(
    '/api/restore-config/codex',
    asyncHandler(async (_req, res) => {
      const result = await restoreCodexConfig();
      res.json(result);
    })
  );

  app.post(
    '/api/restore-config/opencode',
    asyncHandler(async (_req, res) => {
      const result = await restoreOpencodeConfig();
      res.json(result);
    })
  );

  app.get('/api/check-backup/claude', (_req, res) => {
    res.json({ exists: checkClaudeBackupExists() });
  });

  app.get('/api/check-backup/codex', (_req, res) => {
    res.json({ exists: checkCodexBackupExists() });
  });

  app.get('/api/check-backup/opencode', (_req, res) => {
    res.json({ exists: checkOpencodeBackupExists() });
  });

  // 新的详细配置状态 API 端点
  app.get('/api/config-status/claude', (_req, res) => {
    const status = checkClaudeConfigStatus();
    res.json(status);
  });

  app.get('/api/config-status/codex', (_req, res) => {
    const status = checkCodexConfigStatus();
    res.json(status);
  });

  app.get('/api/config-status/opencode', (_req, res) => {
    const status = checkOpencodeConfigStatus();
    res.json(status);
  });

  // API 路径路由映射
  app.get('/api/api-path-bindings', (_req, res) => {
    res.json({ bindings: dbManager.getApiPathBindings(), models: dbManager.getApiPathModels() });
  });

  app.put('/api/api-path-bindings', asyncHandler(async (req, res) => {
    const { bindings } = req.body as { bindings: Array<{ apiPath: string; routeId: string | null }> };
    const VALID_API_PATHS = ['/v1/messages', '/v1/responses', '/v1/chat/completions', '/v1beta/models', '/v1/models'];
    const routes = dbManager.getRoutes();
    const routeIds = new Set(routes.map((r: any) => r.id));

    // Validate
    for (const b of bindings) {
      if (!VALID_API_PATHS.includes(b.apiPath)) {
        res.status(400).json({ error: `Invalid apiPath: ${b.apiPath}` });
        return;
      }
      if (b.routeId !== null && !routeIds.has(b.routeId)) {
        res.status(400).json({ error: `Route not found: ${b.routeId}` });
        return;
      }
      // /v1/models does not accept route binding
      if (b.apiPath === '/v1/models' && b.routeId !== null) {
        res.status(400).json({ error: '/v1/models does not accept route binding' });
        return;
      }
    }

    const { models } = req.body as { models?: string };
    await dbManager.updateApiPathBindings(
      bindings.map(b => ({ apiPath: b.apiPath as any, routeId: b.routeId })),
      models,
    );
    res.json({ success: true, bindings: dbManager.getApiPathBindings(), models: dbManager.getApiPathModels() });
  }));

  app.post(
    '/api/export',
    asyncHandler(async (req, res) => {
      const { password } = req.body as { password: string };
      const data = await dbManager.exportData(password);
      res.json({ data });
    })
  );
  // 导入数据预览
  app.post(
    '/api/import/preview',
    asyncHandler(async (req, res) => {
      const { encryptedData, password } = req.body as { encryptedData: string; password: string };
      const result = await dbManager.previewImportData(encryptedData, password);
      res.json(result);
    })
  );

  app.post(
    '/api/import',
    asyncHandler(async (req, res) => {
      const { encryptedData, password } = req.body as { encryptedData: string; password: string };
      const result = await dbManager.importData(encryptedData, password);
      if (result.success) {
        await proxyServer.reloadRoutes();
      }
      res.json(result);
    })
  );

  app.get(
    '/api/version/check',
    asyncHandler(async (_req, res) => {
      const versionInfo = await checkVersionUpdate();
      res.json(versionInfo);
    })
  );

  app.get(
    '/api/statistics',
    asyncHandler(async (req, res) => {
      const days = typeof req.query.days === 'string' ? parseInt(req.query.days, 10) : 30;
      const stats = await dbManager.getStatistics(days);
      res.json(stats);
    })
  );

  // Sessions 相关端点
  app.get(
    '/api/sessions',
    asyncHandler(async (req, res) => {
      const rawLimit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : NaN;
      const rawOffset = typeof req.query.offset === 'string' ? parseInt(req.query.offset, 10) : NaN;
      const limit = Number.isFinite(rawLimit) ? rawLimit : 100;
      const offset = Number.isFinite(rawOffset) ? rawOffset : 0;
      const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
      const opts = {
        targetType: str(req.query.targetType) || undefined,
        keyword: str(req.query.keyword) || str(req.query.query) || undefined,
        vendorId: str(req.query.vendorId) || undefined,
        serviceId: str(req.query.serviceId) || undefined,
        model: str(req.query.model) || undefined,
        routeId: str(req.query.routeId) || undefined,
      };
      const hasFilter = opts.targetType || opts.keyword || opts.vendorId || opts.serviceId || opts.model || opts.routeId;
      const [sessions, total] = await Promise.all([
        dbManager.getSessions(hasFilter ? opts : undefined, limit, offset),
        dbManager.getSessionsCount(hasFilter ? opts : undefined),
      ]);
      res.json({ sessions, total });
    })
  );

  app.get(
    '/api/sessions/count',
    asyncHandler(async (_req, res) => {
      const count = await dbManager.getSessionsCount();
      res.json({ count });
    })
  );

  app.get(
    '/api/sessions/:id',
    asyncHandler(async (req, res) => {
      const session = dbManager.getSession(req.params.id);
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      res.json(session);
    })
  );

  app.get(
    '/api/sessions/:id/logs',
    asyncHandler(async (req, res) => {
      const rawLimit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : NaN;
      const limit = Number.isFinite(rawLimit) ? rawLimit : 100;
      const logs = await dbManager.getLogsBySessionId(req.params.id, limit);
      res.json(logs);
    })
  );

  app.delete(
    '/api/sessions/:id',
    asyncHandler(async (req, res) => {
      const result = dbManager.deleteSession(req.params.id);
      res.json(result);
    })
  );

  app.delete(
    '/api/sessions',
    asyncHandler(async (_req, res) => {
      dbManager.clearSessions();
      res.json(true);
    })
  );

  // 清理过期会话（基于最后请求时间），可选择仅清空关联日志而保留会话本身
  app.post(
    '/api/sessions/cleanup',
    asyncHandler(async (req, res) => {
      const beforeDays = Number(req.body?.beforeDays);
      const onlyLogs = Boolean(req.body?.onlyLogs);
      if (!Number.isFinite(beforeDays) || !Number.isInteger(beforeDays) || beforeDays < 1 || beforeDays > 15) {
        res.status(400).json({ error: 'beforeDays 必须为 1-15 之间的整数' });
        return;
      }
      const beforeTimestamp = Date.now() - beforeDays * 24 * 60 * 60 * 1000;
      const result = await dbManager.cleanupSessionsByAge(beforeTimestamp, { onlyLogs });
      res.json(result);
    })
  );

  // ─── Session Route Binding API ───

  app.put(
    '/api/sessions/:id/bind-route',
    asyncHandler(async (req, res) => {
      const sessionId = req.params.id;
      const { routeId } = req.body || {};

      if (!routeId) {
        res.status(400).json({ success: false, error: 'routeId is required' });
        return;
      }

      const session = dbManager.getSession(sessionId);
      if (!session) {
        res.status(404).json({ success: false, error: 'Session not found' });
        return;
      }

      const updatedSession = await dbManager.bindSessionRoute(sessionId, routeId);
      if (!updatedSession) {
        res.status(400).json({ success: false, error: 'Route not found' });
        return;
      }

      res.json({ success: true, session: updatedSession });
    })
  );

  app.delete(
    '/api/sessions/:id/bind-route',
    asyncHandler(async (req, res) => {
      const sessionId = req.params.id;

      const session = dbManager.getSession(sessionId);
      if (!session) {
        res.status(404).json({ success: false, error: 'Session not found' });
        return;
      }

      const result = await dbManager.unbindSessionRoute(sessionId);
      res.json({ success: result });
    })
  );

  app.get(
    '/api/routes/:id/bound-sessions',
    asyncHandler(async (req, res) => {
      const routeId = req.params.id;
      const route = dbManager.getRoute(routeId);
      if (!route) {
        res.status(404).json({ error: 'Route not found' });
        return;
      }

      const sessions = dbManager.getBoundSessions(routeId);
      res.json({
        routeId,
        sessions: sessions.map(s => ({
          id: s.id,
          title: s.title,
          targetType: s.targetType,
          requestCount: s.requestCount,
          totalTokens: s.totalTokens,
          lastRequestAt: s.lastRequestAt,
        })),
      });
    })
  );

  // ─── Session Migration API ───

  app.post(
    '/api/sessions/:id/migration-preview',
    asyncHandler(async (req, res) => {
      const sessionId = req.params.id;
      const { targetTool, includeThinking, includeToolCalls, maxRounds } = req.body || {};

      if (!targetTool || !['claude-code', 'codex'].includes(targetTool)) {
        res.status(400).json({ error: 'Invalid targetTool. Must be "claude-code" or "codex".' });
        return;
      }

      try {
        const content = await extractSessionContent(dbManager, sessionId, {
          sourceSessionId: sessionId,
          targetTool,
          includeThinking: includeThinking === true,
          includeToolCalls: includeToolCalls !== false,
          maxRounds: typeof maxRounds === 'number' ? maxRounds : 0,
        });

        const preview = previewMigration(content, targetTool);
        res.json(preview);
      } catch (err: any) {
        if (err.message?.includes('not found')) {
          res.status(404).json({ error: err.message });
        } else {
          res.status(500).json({ error: err.message || 'Migration preview failed' });
        }
      }
    })
  );

  app.post(
    '/api/sessions/:id/migrate',
    asyncHandler(async (req, res) => {
      const sessionId = req.params.id;
      const { targetTool, includeThinking, includeToolCalls, maxRounds, editedPrompt } = req.body || {};

      if (!targetTool || !['claude-code', 'codex'].includes(targetTool)) {
        res.status(400).json({ error: 'Invalid targetTool. Must be "claude-code" or "codex".' });
        return;
      }

      try {
        const content = await extractSessionContent(dbManager, sessionId, {
          sourceSessionId: sessionId,
          targetTool,
          includeThinking: includeThinking === true,
          includeToolCalls: includeToolCalls !== false,
          maxRounds: typeof maxRounds === 'number' ? maxRounds : 0,
        });

        const result = migrateSession(content, targetTool, editedPrompt);
        res.json(result);
      } catch (err: any) {
        if (err.message?.includes('not found')) {
          res.status(404).json({ error: err.message });
        } else {
          res.status(500).json({ error: err.message || 'Migration failed' });
        }
      }
    })
  );

  app.post(
    '/api/sessions/:id/migrate-launch',
    asyncHandler(async (req, res) => {
      const sessionId = req.params.id;
      const { targetTool, includeThinking, includeToolCalls, maxRounds } = req.body || {};

      if (!targetTool || !['claude-code', 'codex'].includes(targetTool)) {
        res.status(400).json({ error: 'Invalid targetTool. Must be "claude-code" or "codex".' });
        return;
      }

      try {
        // First extract content and generate prompt
        const content = await extractSessionContent(dbManager, sessionId, {
          sourceSessionId: sessionId,
          targetTool,
          includeThinking: includeThinking === true,
          includeToolCalls: includeToolCalls !== false,
          maxRounds: typeof maxRounds === 'number' ? maxRounds : 0,
        });

        const { prompt } = migrateSession(content, targetTool);

        // Resolve the project directory from session metadata
        const projectDir = resolveProjectDir(sessionId, content.sourceTool);

        // Write prompt to temp file
        const tempFilePath = writePromptToTempFile(prompt, sessionId);

        // Try to launch the target tool with the resolved project directory
        const result = await launchTargetWithFallback(targetTool, tempFilePath, prompt, projectDir || undefined);

        // Schedule cleanup
        cleanupTempFile(tempFilePath);

        res.json(result);
      } catch (err: any) {
        if (err.message?.includes('not found')) {
          res.status(404).json({ error: err.message });
        } else {
          res.status(500).json({ error: err.message || 'Launch migration failed' });
        }
      }
    })
  );

  app.get('/api/docs/recommend-vendors', asyncHandler(async (_req, res) => {
    const resp = await fetch('https://unpkg.com/aicodeswitch/docs/vendors-recommand.md');
    if (!resp.ok) {
      res.status(500).send('');
      return;
    }
    const text = await resp.text();
    res.type('text/plain').send(text);
  }));

  app.get('/api/docs/readme', asyncHandler(async (_req, res) => {
    const resp = await fetch('https://unpkg.com/aicodeswitch/README.md');
    if (!resp.ok) {
      res.status(500).send('');
      return;
    }
    const text = await resp.text();
    res.type('text/plain').send(text);
  }));

  app.get('/api/docs/upgrade', asyncHandler(async (_req, res) => {
    const resp = await fetch('https://unpkg.com/aicodeswitch/docs/upgrade.md');
    if (!resp.ok) {
      res.status(500).send('');
      return;
    }
    const text = await resp.text();
    res.type('text/plain').send(text);
  }));

  app.get('/api/upgrade', asyncHandler(async (_req, res) => {
    try {
      // 读取 upgrade.md 文件
      const upgradePath = path.resolve(__dirname, '../../UPGRADE.md');
      if (!upgradePath) {
        res.json({ shouldShow: false, content: '' });
        return;
      }

      const content = fs.readFileSync(upgradePath, 'utf-8').trim();

      // 计算当前内容的 hash
      const currentHash = createHash('sha256').update(content).digest('hex');

      // 如果 hash 文件不存在，说明是第一次安装
      if (!fs.existsSync(upgradeHashFilePath)) {
        // 第一次安装，直接保存当前 hash，不显示弹窗
        fs.writeFileSync(upgradeHashFilePath, currentHash, 'utf-8');
        res.json({ shouldShow: false, content: '' });
        return;
      }

      // 读取已保存的 hash
      const savedHash = fs.readFileSync(upgradeHashFilePath, 'utf-8').trim();

      // 如果 hash 不同，需要显示弹窗
      const shouldShow = savedHash !== currentHash;

      res.json({ shouldShow, content: shouldShow ? content : '' });
    } catch (error) {
      console.error('Failed to read upgrade file:', error);
      res.json({ shouldShow: false, content: '' });
    }
  }));

  app.post('/api/upgrade/ack', asyncHandler(async (_req, res) => {
    try {
      // 读取 upgrade.md 文件并计算 hash
      const upgradePath = path.resolve(__dirname, '../../UPGRADE.md');
      if (!upgradePath) {
        res.json({ success: false });
        return;
      }

      const content = fs.readFileSync(upgradePath, 'utf-8').trim();
      const hash = createHash('sha256').update(content).digest('hex');

      // 保存 hash 到文件
      fs.writeFileSync(upgradeHashFilePath, hash, 'utf-8');

      res.json({ success: true });
    } catch (error) {
      console.error('Failed to acknowledge upgrade:', error);
      res.json({ success: false });
    }
  }));

  // MCP 工具管理相关路由
  app.get('/api/mcps', (_req, res) => {
    res.json(dbManager.getMCPs());
  });

  app.get('/api/mcps/:id', (req, res) => {
    const mcp = dbManager.getMCP(req.params.id);
    if (!mcp) {
      res.status(404).json({ error: 'MCP工具不存在' });
      return;
    }
    res.json(mcp);
  });

  app.post('/api/mcps', asyncHandler(async (req, res) => {
    const mcpData: MCPInstallRequest = req.body;
    const result = await dbManager.createMCP({
      ...mcpData,
      targets: mcpData.targets || [],
    });

    // 如果有工具绑定的路由，立即写入MCP配置
    if (mcpData.targets) {
      for (const target of mcpData.targets) {
        const activeRouteId = dbManager.getActiveRouteIdForTool(target);
        if (activeRouteId) {
          await writeMCPConfig(target);
        }
      }
    }

    res.json(result);
  }));

  app.put('/api/mcps/:id', asyncHandler(async (req, res) => {
    const updateData = req.body;
    const oldMcp = dbManager.getMCP(req.params.id);
    const result = await dbManager.updateMCP(req.params.id, updateData);

    // 如果targets发生变化，同步MCP配置到对应工具
    if (updateData.targets !== undefined) {
      const newTargets: TargetType[] = updateData.targets;
      const oldTargets = oldMcp?.targets || [];

      // 需要同步的所有target（新增的 + 移除的都需要处理）
      const allAffectedTargets = new Set([...newTargets, ...oldTargets]);

      for (const target of allAffectedTargets) {
        const activeRouteId = dbManager.getActiveRouteIdForTool(target);
        if (activeRouteId) {
          await writeMCPConfig(target);
        }
      }
    }

    res.json(result);
  }));

  app.delete('/api/mcps/:id', asyncHandler(async (req, res) => {
    const mcp = dbManager.getMCP(req.params.id);
    if (!mcp) {
      res.status(404).json({ error: 'MCP工具不存在' });
      return;
    }

    const result = await dbManager.deleteMCP(req.params.id);

    // 从Claude Code和Codex配置中移除该MCP
    if (mcp.targets) {
      for (const target of mcp.targets) {
        await removeMCPFromConfig(target, mcp.id);
      }
    }

    res.json(result);
  }));

  // ============================================================
  // AccessKey 接入密钥 API
  // ============================================================

  // 获取密钥列表（支持分页和筛选）
  app.get('/api/access-keys', asyncHandler(async (req, res) => {
    const accessKeyModule = proxyServer.getAccessKeyModule();
    if (!accessKeyModule) {
      res.json({ data: [], total: 0, page: 1, pageSize: 20 });
      return;
    }

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string) || 20));
    const status = req.query.status as 'active' | 'disabled' | undefined;
    const policyId = req.query.policyId as string | undefined;
    const search = req.query.search as string | undefined;

    let keys = accessKeyModule.keyManager.list({ status, policyId, search });

    // 附加策略名称和用量信息
    const result = keys.map(key => {
      const policy = key.policyId ? accessKeyModule.policyManager.get(key.policyId) : null;
      return {
        ...key,
        apiKey: AccessKeyManager.maskApiKey(key.apiKey),
        policyName: policy?.name,
      };
    });

    const total = result.length;
    const start = (page - 1) * pageSize;
    const paged = result.slice(start, start + pageSize);

    res.json({ data: paged, total, page, pageSize });
  }));

  // 创建密钥
  app.post('/api/access-keys', asyncHandler(async (req, res) => {
    const accessKeyModule = proxyServer.getAccessKeyModule();
    if (!accessKeyModule) {
      res.status(500).json({ error: 'AccessKey 功能未启用' });
      return;
    }

    const { name, remark, policyId } = req.body;
    if (!name || !name.trim()) {
      res.status(400).json({ error: '名称不能为空' });
      return;
    }

    const result = accessKeyModule.keyManager.create({ name: name.trim(), remark, policyId });
    await accessKeyModule.save();

    res.json({
      key: { ...result.key, apiKey: AccessKeyManager.maskApiKey(result.key.apiKey) },
      apiKey: result.apiKey,
    });
  }));

  // 获取密钥详情
  app.get('/api/access-keys/:id', asyncHandler(async (req, res) => {
    const accessKeyModule = proxyServer.getAccessKeyModule();
    if (!accessKeyModule) {
      res.status(404).json({ error: 'AccessKey 功能未启用' });
      return;
    }

    const key = accessKeyModule.keyManager.get(req.params.id);
    if (!key) {
      res.status(404).json({ error: '密钥不存在' });
      return;
    }

    const policy = key.policyId ? accessKeyModule.policyManager.get(key.policyId) : null;
    res.json({ ...key, apiKey: AccessKeyManager.maskApiKey(key.apiKey), policyName: policy?.name });
  }));

  // 编辑密钥
  app.put('/api/access-keys/:id', asyncHandler(async (req, res) => {
    const accessKeyModule = proxyServer.getAccessKeyModule();
    if (!accessKeyModule) {
      res.status(500).json({ error: 'AccessKey 功能未启用' });
      return;
    }

    const result = accessKeyModule.keyManager.update(req.params.id, req.body);
    if (!result) {
      res.status(404).json({ error: '密钥不存在' });
      return;
    }
    await accessKeyModule.save();
    res.json(true);
  }));

  // 删除密钥
  app.delete('/api/access-keys/:id', asyncHandler(async (req, res) => {
    const accessKeyModule = proxyServer.getAccessKeyModule();
    if (!accessKeyModule) {
      res.status(500).json({ error: 'AccessKey 功能未启用' });
      return;
    }

    const result = accessKeyModule.keyManager.delete(req.params.id);
    await accessKeyModule.save();
    removeWriteLocalRecords(req.params.id);
    res.json(result);
  }));

  // 重新生成 API Key
  app.post('/api/access-keys/:id/regenerate', asyncHandler(async (req, res) => {
    const accessKeyModule = proxyServer.getAccessKeyModule();
    if (!accessKeyModule) {
      res.status(500).json({ error: 'AccessKey 功能未启用' });
      return;
    }

    const result = accessKeyModule.keyManager.regenerate(req.params.id);
    if (!result) {
      res.status(404).json({ error: '密钥不存在' });
      return;
    }
    await accessKeyModule.save();
    // 如果该密钥有写入本地记录，重新生成后自动重写
    applyWriteLocalRecords(proxyServer);
    res.json({ apiKey: result.apiKey });
  }));

  // 批量更新状态
  app.put('/api/access-keys/batch/status', asyncHandler(async (req, res) => {
    const accessKeyModule = proxyServer.getAccessKeyModule();
    if (!accessKeyModule) {
      res.status(500).json({ error: 'AccessKey 功能未启用' });
      return;
    }

    const { keyIds, status } = req.body;
    if (!Array.isArray(keyIds) || !status) {
      res.status(400).json({ error: '参数错误' });
      return;
    }
    const count = accessKeyModule.keyManager.batchUpdateStatus(keyIds, status);
    await accessKeyModule.save();
    res.json({ count });
  }));

  // 批量绑定策略
  app.put('/api/access-keys/batch/policy', asyncHandler(async (req, res) => {
    const accessKeyModule = proxyServer.getAccessKeyModule();
    if (!accessKeyModule) {
      res.status(500).json({ error: 'AccessKey 功能未启用' });
      return;
    }

    const { keyIds, policyId } = req.body;
    if (!Array.isArray(keyIds) || !policyId) {
      res.status(400).json({ error: '参数错误' });
      return;
    }
    const count = accessKeyModule.keyManager.batchBindPolicy(keyIds, policyId);
    await accessKeyModule.save();
    res.json({ count });
  }));

  // 批量删除
  app.delete('/api/access-keys/batch', asyncHandler(async (req, res) => {
    const accessKeyModule = proxyServer.getAccessKeyModule();
    if (!accessKeyModule) {
      res.status(500).json({ error: 'AccessKey 功能未启用' });
      return;
    }

    const { keyIds } = req.body;
    if (!Array.isArray(keyIds)) {
      res.status(400).json({ error: '参数错误' });
      return;
    }
    const count = accessKeyModule.keyManager.batchDelete(keyIds);
    await accessKeyModule.save();
    for (const keyId of keyIds) removeWriteLocalRecords(keyId);
    res.json({ count });
  }));

  // Key 用量统计
  app.get('/api/access-keys/:id/usage', asyncHandler(async (req, res) => {
    const accessKeyModule = proxyServer.getAccessKeyModule();
    if (!accessKeyModule) {
      res.status(404).json({ error: 'AccessKey 功能未启用' });
      return;
    }

    const usage = await accessKeyModule.usageTracker.getUsage(req.params.id);
    res.json(usage);
  }));

  // Key 用量趋势
  app.get('/api/access-keys/:id/usage/trend', asyncHandler(async (req, res) => {
    const accessKeyModule = proxyServer.getAccessKeyModule();
    if (!accessKeyModule) {
      res.status(404).json({ error: 'AccessKey 功能未启用' });
      return;
    }

    const days = parseInt(req.query.days as string) || 30;
    const trend = await accessKeyModule.usageTracker.getTrend(req.params.id, days);
    res.json(trend);
  }));

  // Key 日志
  app.get('/api/access-keys/:id/logs', asyncHandler(async (req, res) => {
    const accessKeyModule = proxyServer.getAccessKeyModule();
    if (!accessKeyModule) {
      res.status(404).json({ error: 'AccessKey 功能未启用' });
      return;
    }

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string) || 50));
    const startDate = req.query.startDate as string | undefined;
    const endDate = req.query.endDate as string | undefined;
    const contentType = req.query.contentType as string | undefined;
    const search = req.query.search as string | undefined;

    const result = await accessKeyModule.keyLogger.getLogs(req.params.id, { page, pageSize, startDate, endDate, contentType, search });
    res.json(result);
  }));

  // ========== AccessKey 会话 API ==========

  // 获取密钥的会话列表
  app.get('/api/access-keys/:id/sessions', asyncHandler(async (req, res) => {
    const accessKeyModule = proxyServer.getAccessKeyModule();
    if (!accessKeyModule) {
      res.status(404).json({ error: 'AccessKey 功能未启用' });
      return;
    }

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string) || 20));
    const targetType = req.query.targetType as string | undefined;
    const search = req.query.search as string | undefined;

    const result = await accessKeyModule.keySessionTracker.getSessions(req.params.id, {
      page, pageSize, targetType, search,
    });
    res.json(result);
  }));

  // 获取密钥的会话总数
  app.get('/api/access-keys/:id/sessions/count', asyncHandler(async (req, res) => {
    const accessKeyModule = proxyServer.getAccessKeyModule();
    if (!accessKeyModule) {
      res.status(404).json({ error: 'AccessKey 功能未启用' });
      return;
    }

    const targetType = req.query.targetType as string | undefined;
    const count = await accessKeyModule.keySessionTracker.getSessionsCount(req.params.id, targetType);
    res.json({ count });
  }));

  // 获取密钥的单个会话
  app.get('/api/access-keys/:id/sessions/:sessionId', asyncHandler(async (req, res) => {
    const accessKeyModule = proxyServer.getAccessKeyModule();
    if (!accessKeyModule) {
      res.status(404).json({ error: 'AccessKey 功能未启用' });
      return;
    }

    const session = await accessKeyModule.keySessionTracker.getSession(req.params.id, req.params.sessionId);
    if (!session) {
      res.status(404).json({ error: '会话不存在' });
      return;
    }
    res.json(session);
  }));

  // 获取密钥会话的日志
  app.get('/api/access-keys/:id/sessions/:sessionId/logs', asyncHandler(async (req, res) => {
    const accessKeyModule = proxyServer.getAccessKeyModule();
    if (!accessKeyModule) {
      res.status(404).json({ error: 'AccessKey 功能未启用' });
      return;
    }

    const limit = Math.min(10000, Math.max(1, parseInt(req.query.limit as string) || 10000));
    const logs = await accessKeyModule.keyLogger.getLogsBySessionId(req.params.id, req.params.sessionId, limit);
    res.json(logs);
  }));

  // 删除密钥的单个会话
  app.delete('/api/access-keys/:id/sessions/:sessionId', asyncHandler(async (req, res) => {
    const accessKeyModule = proxyServer.getAccessKeyModule();
    if (!accessKeyModule) {
      res.status(404).json({ error: 'AccessKey 功能未启用' });
      return;
    }

    const deleted = await accessKeyModule.keySessionTracker.deleteSession(req.params.id, req.params.sessionId);
    if (!deleted) {
      res.status(404).json({ error: '会话不存在' });
      return;
    }
    res.json({ success: true });
  }));

  // 清空密钥的所有会话
  app.delete('/api/access-keys/:id/sessions', asyncHandler(async (req, res) => {
    const accessKeyModule = proxyServer.getAccessKeyModule();
    if (!accessKeyModule) {
      res.status(404).json({ error: 'AccessKey 功能未启用' });
      return;
    }

    await accessKeyModule.keySessionTracker.clearSessions(req.params.id);
    res.json({ success: true });
  }));

  // Key 接入指引
  app.get('/api/access-keys/:id/guide', asyncHandler(async (req, res) => {
    const accessKeyModule = proxyServer.getAccessKeyModule();
    if (!accessKeyModule) {
      res.status(404).json({ error: 'AccessKey 功能未启用' });
      return;
    }

    const key = accessKeyModule.keyManager.get(req.params.id);
    if (!key) {
      res.status(404).json({ error: '密钥不存在' });
      return;
    }

    const host = (req.query.host as string) || req.hostname || 'localhost';
    const port = (req.query.port as string) || (req.socket.localAddress ? String(req.socket.localPort) : '4567');
    const baseUrl = `http://${host}:${port}`;
    const maskedKey = AccessKeyManager.maskApiKey(key.apiKey);

    res.json({
      claudeCode: {
        description: 'Claude Code 接入',
        envVars: {
          ANTHROPIC_BASE_URL: `${baseUrl}/claude-code`,
          ANTHROPIC_AUTH_TOKEN: maskedKey,
        },
      },
      codex: {
        description: 'Codex 接入',
        envVars: {
          OPENAI_API_KEY: maskedKey,
          OPENAI_BASE_URL: `${baseUrl}/codex`,
        },
      },
      openai: {
        description: 'OpenAI 兼容工具 (Cursor / Continue 等)',
        envVars: {
          OPENAI_API_KEY: maskedKey,
          OPENAI_BASE_URL: `${baseUrl}/v1`,
        },
      },
    });
  }));

  // 写入本地配置（将 AccessKey 写入 Claude Code / Codex 配置文件）
  app.post('/api/access-keys/:id/write-local', asyncHandler(async (req, res) => {
    const accessKeyModule = proxyServer.getAccessKeyModule();
    if (!accessKeyModule) {
      res.status(400).json({ error: 'AccessKey 功能未启用' });
      return;
    }

    const key = accessKeyModule.keyManager.get(req.params.id);
    if (!key) {
      res.status(404).json({ error: '密钥不存在' });
      return;
    }

    const targets: string[] = req.body.targets || [];
    if (targets.length === 0) {
      res.status(400).json({ error: '请选择至少一个目标' });
      return;
    }

    const homeDir = os.homedir();
    const results: Record<string, boolean> = {};

    for (const target of targets) {
      try {
        if (target === 'claude-code') {
          // 写入 ~/.claude/settings.json 的 env.ANTHROPIC_AUTH_TOKEN
          const claudeDir = path.join(homeDir, '.claude');
          const settingsPath = path.join(claudeDir, 'settings.json');
          if (!fs.existsSync(claudeDir)) {
            fs.mkdirSync(claudeDir, { recursive: true });
          }

          let settings: Record<string, any> = {};
          if (fs.existsSync(settingsPath)) {
            try {
              settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
            } catch { /* ignore */ }
          }

          if (!settings.env) settings.env = {};
          settings.env.ANTHROPIC_AUTH_TOKEN = key.apiKey;

          atomicWriteFile(settingsPath, JSON.stringify(settings, null, 2));
          results['claude-code'] = true;
        } else if (target === 'codex') {
          // 写入 ~/.codex/auth.json 的 OPENAI_API_KEY
          const codexDir = path.join(homeDir, '.codex');
          const authPath = path.join(codexDir, 'auth.json');
          if (!fs.existsSync(codexDir)) {
            fs.mkdirSync(codexDir, { recursive: true });
          }

          let auth: Record<string, any> = {};
          if (fs.existsSync(authPath)) {
            try {
              auth = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
            } catch { /* ignore */ }
          }

          auth.OPENAI_API_KEY = key.apiKey;
          atomicWriteFile(authPath, JSON.stringify(auth, null, 2));
          results['codex'] = true;
        } else if (target === 'opencode') {
          // 写入 ~/.config/opencode/opencode.json 的 provider.aicodeswitch.options.apiKey
          const opencodeConfigPath = getOpencodeConfigPath();
          const opencodeDir = path.dirname(opencodeConfigPath);
          if (!fs.existsSync(opencodeDir)) {
            fs.mkdirSync(opencodeDir, { recursive: true });
          }

          let oc: Record<string, any> = {};
          if (fs.existsSync(opencodeConfigPath)) {
            try {
              oc = JSON.parse(fs.readFileSync(opencodeConfigPath, 'utf-8'));
            } catch { /* ignore */ }
          }

          if (!oc.provider) oc.provider = {};
          if (!oc.provider.aicodeswitch || typeof oc.provider.aicodeswitch !== 'object') {
            oc.provider.aicodeswitch = { npm: '@ai-sdk/openai-compatible', name: 'AICodeSwitch', options: {} };
          }
          if (!oc.provider.aicodeswitch.options) oc.provider.aicodeswitch.options = {};
          oc.provider.aicodeswitch.options.apiKey = key.apiKey;

          atomicWriteFile(opencodeConfigPath, JSON.stringify(oc, null, 2));
          results['opencode'] = true;
        }
      } catch (error) {
        console.error(`Failed to write local config for ${target}:`, error);
        results[target] = false;
      }
    }

    // 持久化写入本地记录，确保服务重启后自动恢复
    const successTargets = Object.entries(results)
      .filter(([, v]) => v === true)
      .map(([k]) => k);
    if (successTargets.length > 0) {
      addWriteLocalRecord(key.id, successTargets);
    }

    res.json({ success: true, results });
  }));

  // 查询写入本地记录（供 UI 显示标注）
  app.get('/api/write-local-records', asyncHandler(async (_req, res) => {
    res.json(loadWriteLocalRecords());
  }));

  // ============================================================
  // Policy 策略 API
  // ============================================================

  // 策略列表
  app.get('/api/policies', asyncHandler(async (_req, res) => {
    const accessKeyModule = proxyServer.getAccessKeyModule();
    if (!accessKeyModule) {
      res.json([]);
      return;
    }

    const policies = accessKeyModule.policyManager.list();
    const result = policies.map(p => ({
      ...p,
      keyCount: accessKeyModule.keyManager.countByPolicyId(p.id),
    }));
    res.json(result);
  }));

  // 创建策略
  app.post('/api/policies', asyncHandler(async (req, res) => {
    const accessKeyModule = proxyServer.getAccessKeyModule();
    if (!accessKeyModule) {
      res.status(500).json({ error: 'AccessKey 功能未启用' });
      return;
    }

    const policy = accessKeyModule.policyManager.create(req.body);
    await accessKeyModule.save();
    res.json(policy);
  }));

  // 策略模板（必须在 /:id 之前注册，避免被当作 id 参数匹配）
  app.get('/api/policies/templates', asyncHandler(async (_req, res) => {
    res.json(PolicyManager.getTemplates());
  }));

  // 策略详情
  app.get('/api/policies/:id', asyncHandler(async (req, res) => {
    const accessKeyModule = proxyServer.getAccessKeyModule();
    if (!accessKeyModule) {
      res.status(404).json({ error: 'AccessKey 功能未启用' });
      return;
    }

    const policy = accessKeyModule.policyManager.get(req.params.id);
    if (!policy) {
      res.status(404).json({ error: '策略不存在' });
      return;
    }
    res.json(policy);
  }));

  // 编辑策略
  app.put('/api/policies/:id', asyncHandler(async (req, res) => {
    const accessKeyModule = proxyServer.getAccessKeyModule();
    if (!accessKeyModule) {
      res.status(500).json({ error: 'AccessKey 功能未启用' });
      return;
    }

    const result = accessKeyModule.policyManager.update(req.params.id, req.body);
    if (!result) {
      res.status(404).json({ error: '策略不存在' });
      return;
    }
    await accessKeyModule.save();
    res.json(true);
  }));

  // 删除策略
  app.delete('/api/policies/:id', asyncHandler(async (req, res) => {
    const accessKeyModule = proxyServer.getAccessKeyModule();
    if (!accessKeyModule) {
      res.status(500).json({ error: 'AccessKey 功能未启用' });
      return;
    }

    const keyCount = accessKeyModule.keyManager.countByPolicyId(req.params.id);
    if (keyCount > 0) {
      res.status(400).json({ error: `有 ${keyCount} 个密钥正在使用此策略，请先解除绑定` });
      return;
    }

    const result = accessKeyModule.policyManager.delete(req.params.id);
    await accessKeyModule.save();
    res.json(result);
  }));

  // 复制策略
  app.post('/api/policies/:id/duplicate', asyncHandler(async (req, res) => {
    const accessKeyModule = proxyServer.getAccessKeyModule();
    if (!accessKeyModule) {
      res.status(500).json({ error: 'AccessKey 功能未启用' });
      return;
    }

    const result = accessKeyModule.policyManager.duplicate(req.params.id);
    if (!result) {
      res.status(404).json({ error: '策略不存在' });
      return;
    }
    await accessKeyModule.save();
    res.json(result);
  }));

  // 使用策略的密钥列表
  app.get('/api/policies/:id/keys', asyncHandler(async (req, res) => {
    const accessKeyModule = proxyServer.getAccessKeyModule();
    if (!accessKeyModule) {
      res.json([]);
      return;
    }

    const keys = accessKeyModule.keyManager.listByPolicyId(req.params.id);
    res.json(keys.map(k => ({ ...k, apiKey: AccessKeyManager.maskApiKey(k.apiKey) })));
  }));

  // ============================================================
  // AccessKey 全局统计 API
  // ============================================================

  // Key 用量排行
  app.get('/api/statistics/access-keys', asyncHandler(async (req, res) => {
    const accessKeyModule = proxyServer.getAccessKeyModule();
    if (!accessKeyModule) {
      res.json([]);
      return;
    }

    const keys = accessKeyModule.keyManager.list();
    const result = await Promise.all(keys.map(async k => {
      const usage = await accessKeyModule.usageTracker.getUsage(k.id);
      return {
        keyId: k.id,
        keyName: k.name,
        totalTokens: usage.lifetime.totalTokens,
        totalRequests: usage.lifetime.totalRequests,
        lastActiveAt: k.lastActiveAt,
      };
    }));

    // 排序
    const sortBy = (req.query.sortBy as string) || 'totalTokens';
    const order = (req.query.order as string) || 'desc';
    result.sort((a, b) => {
      const va = (a as any)[sortBy] || 0;
      const vb = (b as any)[sortBy] || 0;
      return order === 'desc' ? vb - va : va - vb;
    });

    const limit = Math.min(100, parseInt(req.query.limit as string) || 20);
    res.json(result.slice(0, limit));
  }));

  // 配额告警
  app.get('/api/statistics/quota-alerts', asyncHandler(async (_req, res) => {
    const accessKeyModule = proxyServer.getAccessKeyModule();
    if (!accessKeyModule) {
      res.json([]);
      return;
    }

    const keys = accessKeyModule.keyManager.list({ status: 'active' });
    const alerts: any[] = [];

    for (const key of keys) {
      if (!key.policyId) continue;
      const policy = accessKeyModule.policyManager.get(key.policyId);
      if (!policy) continue;

      const usage = await accessKeyModule.usageTracker.getUsage(key.id);

      // 检查各维度
      const checks: Array<{ dimension: string; usage: number; limit: number }> = [];
      if (policy.dailyTokenLimit) {
        checks.push({ dimension: 'dailyTokenLimit', usage: usage.periods.daily.tokens, limit: policy.dailyTokenLimit * 1000 });
      }
      if (policy.monthlyTokenLimit) {
        checks.push({ dimension: 'monthlyTokenLimit', usage: usage.periods.monthly.tokens, limit: policy.monthlyTokenLimit * 1000 });
      }
      if (policy.dailyRequestLimit) {
        checks.push({ dimension: 'dailyRequestLimit', usage: usage.periods.daily.requests, limit: policy.dailyRequestLimit });
      }
      if (policy.monthlyRequestLimit) {
        checks.push({ dimension: 'monthlyRequestLimit', usage: usage.periods.monthly.requests, limit: policy.monthlyRequestLimit });
      }

      for (const check of checks) {
        if (check.limit <= 0) continue;
        const pct = Math.round((check.usage / check.limit) * 100);
        if (pct >= 80) {
          alerts.push({
            keyId: key.id,
            keyName: key.name,
            dimension: check.dimension,
            usage: check.usage,
            limit: check.limit,
            percentage: pct,
            level: pct >= 100 ? 'exceeded' : pct >= 95 ? 'critical' : 'warning',
          });
        }
      }
    }

    res.json(alerts);
  }));

  // ============ 服务性能统计（全局，与 AUTH 无关） ============
  const requirePerfTracker = (res: Response) => {
    const tracker = proxyServer.getPerformanceTracker();
    if (!tracker) {
      res.status(503).json({ error: 'Performance tracker not initialized' });
    }
    return tracker;
  };

  // 全部 API 服务平铺一览（含所属供应商）
  app.get('/api/performance/services-overview', asyncHandler(async (_req, res) => {
    const tracker = requirePerfTracker(res);
    if (!tracker) return;
    res.json(tracker.getServicesOverview());
  }));

  // 全部供应商一览
  app.get('/api/performance/vendors', asyncHandler(async (_req, res) => {
    const tracker = requirePerfTracker(res);
    if (!tracker) return;
    res.json(tracker.getVendorsOverview());
  }));

  // 某供应商详情（rollup + 其下服务）
  app.get('/api/performance/vendors/:vendorId', asyncHandler(async (req, res) => {
    const tracker = requirePerfTracker(res);
    if (!tracker) return;
    const detail = tracker.getVendorDetail(req.params.vendorId);
    if (!detail) { res.status(404).json({ error: 'Vendor not found' }); return; }
    res.json(detail);
  }));

  // 某服务详情（rollup + 其下模型）
  app.get('/api/performance/services/:serviceId', asyncHandler(async (req, res) => {
    const tracker = requirePerfTracker(res);
    if (!tracker) return;
    const detail = tracker.getServiceDetail(req.params.serviceId);
    if (!detail) { res.status(404).json({ error: 'Service not found' }); return; }
    res.json(detail);
  }));

  // 单模型详情（派生 + 小时走势 + 极值）
  app.get('/api/performance/services/:serviceId/models/:model', asyncHandler(async (req, res) => {
    const tracker = requirePerfTracker(res);
    if (!tracker) return;
    const detail = tracker.getModelDetail(req.params.serviceId, decodeURIComponent(req.params.model));
    if (!detail) { res.status(404).json({ error: 'Model not found' }); return; }
    res.json(detail);
  }));

  // 写入MCP配置到Claude Code或Codex的全局配置文件
  const writeMCPConfig = async (targetType: TargetType): Promise<boolean> => {
    try {
      const homeDir = os.homedir();
      const mcps = dbManager.getMCPsByTarget(targetType);

      if (targetType === 'claude-code') {
        // Claude Code配置文件路径
        const claudeJsonPath = path.join(homeDir, '.claude.json');
        let claudeJson: any = {};

        // 读取现有配置
        if (fs.existsSync(claudeJsonPath)) {
          claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
        }

        // 确保mcpServers存在
        if (!claudeJson.mcpServers) {
          claudeJson.mcpServers = {};
        }

        // 写入所有启用的MCP
        for (const mcp of mcps) {
          const mcpConfig: any = {
            type: mcp.type,
          };

          if (mcp.type === 'stdio') {
            mcpConfig.command = mcp.command;
            mcpConfig.args = mcp.args;
          } else if (mcp.type === 'http') {
            mcpConfig.url = mcp.url;
          } else if (mcp.type === 'sse') {
            mcpConfig.url = mcp.url;
          }

          if (mcp.headers && Object.keys(mcp.headers).length > 0) {
            mcpConfig.headers = mcp.headers;
          }

          if (mcp.env && Object.keys(mcp.env).length > 0) {
            mcpConfig.env = mcp.env;
          }

          claudeJson.mcpServers[mcp.id] = mcpConfig;
        }

        fs.writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2));
        return true;
      } else if (targetType === 'codex') {
        // Codex使用TOML格式的 config.toml，MCP配置格式为 [mcp_servers.<name>]
        const codexDir = path.join(homeDir, '.codex');
        const codexConfigPath = path.join(codexDir, 'config.toml');

        if (!fs.existsSync(codexDir)) {
          fs.mkdirSync(codexDir, { recursive: true });
        }

        // 读取当前 config.toml
        let currentConfig: Record<string, any> = {};
        if (fs.existsSync(codexConfigPath)) {
          try {
            currentConfig = parseToml(fs.readFileSync(codexConfigPath, 'utf-8'));
          } catch (error) {
            console.warn('[MCP] Failed to parse Codex config.toml:', error);
          }
        }

        // 清除已有的代理写入的 mcp_servers 条目（通过metadata追踪）
        const mcpMetaPath = path.join(codexDir, '.aicodeswitch_mcp_servers.json');
        let previousMcpIds: string[] = [];
        if (fs.existsSync(mcpMetaPath)) {
          try {
            previousMcpIds = JSON.parse(fs.readFileSync(mcpMetaPath, 'utf8'));
            for (const id of previousMcpIds) {
              if (currentConfig.mcp_servers && currentConfig.mcp_servers[id]) {
                delete currentConfig.mcp_servers[id];
              }
            }
          } catch {
            // ignore
          }
        }

        // 确保mcp_servers对象存在
        if (!currentConfig.mcp_servers) {
          currentConfig.mcp_servers = {};
        }

        // 写入所有启用的MCP
        const writtenMcpIds: string[] = [];
        for (const mcp of mcps) {
          const mcpConfig: Record<string, any> = {};

          if (mcp.type === 'stdio') {
            mcpConfig.command = mcp.command || '';
            if (mcp.args && mcp.args.length > 0) {
              mcpConfig.args = mcp.args;
            }
            // stdio 类型的环境变量写在 [mcp_servers.name.env] 子表中
            if (mcp.env && Object.keys(mcp.env).length > 0) {
              mcpConfig.env = { ...mcp.env };
            }
          } else if (mcp.type === 'http') {
            // Codex 使用 Streamable HTTP 传输，url 字段
            mcpConfig.url = mcp.url || '';
            // HTTP 类型可选的 headers
            if (mcp.headers && Object.keys(mcp.headers).length > 0) {
              mcpConfig.headers = { ...mcp.headers };
            }
          } else if (mcp.type === 'sse') {
            // SSE 传输也使用 url 字段
            mcpConfig.url = mcp.url || '';
            if (mcp.headers && Object.keys(mcp.headers).length > 0) {
              mcpConfig.headers = { ...mcp.headers };
            }
          }

          currentConfig.mcp_servers[mcp.id] = mcpConfig;
          writtenMcpIds.push(mcp.id);
        }

        // 如果mcp_servers为空对象，删除该键
        if (Object.keys(currentConfig.mcp_servers).length === 0) {
          delete currentConfig.mcp_servers;
        }

        // 写回 config.toml
        atomicWriteFile(codexConfigPath, stringifyToml(currentConfig));

        // 保存已写入的MCP ID列表，用于后续清理
        fs.writeFileSync(mcpMetaPath, JSON.stringify(writtenMcpIds, null, 2));

        console.log(`[MCP] Codex MCP config written: ${writtenMcpIds.length} server(s)`);
        return true;
      } else if (targetType === 'opencode') {
        // OpenCode 使用 JSON 格式的 opencode.json，MCP 配置位于 mcp 段
        // 格式：local → { type:"local", command:[...], enabled:true, env? }
        //       remote → { type:"remote", url, enabled:true, headers? }
        const opencodeConfigPath = getOpencodeConfigPath();
        const opencodeDir = path.dirname(opencodeConfigPath);

        if (!fs.existsSync(opencodeDir)) {
          fs.mkdirSync(opencodeDir, { recursive: true });
        }

        let currentConfig: Record<string, any> = {};
        if (fs.existsSync(opencodeConfigPath)) {
          try {
            currentConfig = JSON.parse(fs.readFileSync(opencodeConfigPath, 'utf-8'));
          } catch (error) {
            console.warn('[MCP] Failed to parse opencode.json:', error);
          }
        }

        // 清除代理上次写入的 mcp 条目（通过 metadata 追踪，避免误删用户自配的 mcp）
        const mcpMetaPath = path.join(opencodeDir, '.aicodeswitch_mcp_servers.json');
        let previousMcpIds: string[] = [];
        if (fs.existsSync(mcpMetaPath)) {
          try {
            previousMcpIds = JSON.parse(fs.readFileSync(mcpMetaPath, 'utf8'));
            for (const id of previousMcpIds) {
              if (currentConfig.mcp && currentConfig.mcp[id]) {
                delete currentConfig.mcp[id];
              }
            }
          } catch {
            // ignore
          }
        }

        if (!currentConfig.mcp) {
          currentConfig.mcp = {};
        }

        const writtenMcpIds: string[] = [];
        for (const mcp of mcps) {
          const mcpConfig: Record<string, any> = { enabled: true };

          if (mcp.type === 'stdio') {
            mcpConfig.type = 'local';
            const cmdParts = [mcp.command || ''];
            if (Array.isArray(mcp.args)) {
              cmdParts.push(...mcp.args);
            }
            mcpConfig.command = cmdParts.filter((c, i) => i === 0 ? c !== '' : true);
            if (mcp.env && Object.keys(mcp.env).length > 0) {
              mcpConfig.environment = { ...mcp.env };
            }
          } else {
            // http / sse 均使用 remote 类型
            mcpConfig.type = 'remote';
            mcpConfig.url = mcp.url || '';
            if (mcp.headers && Object.keys(mcp.headers).length > 0) {
              mcpConfig.headers = { ...mcp.headers };
            }
          }

          currentConfig.mcp[mcp.id] = mcpConfig;
          writtenMcpIds.push(mcp.id);
        }

        if (Object.keys(currentConfig.mcp).length === 0) {
          delete currentConfig.mcp;
        }

        atomicWriteFile(opencodeConfigPath, JSON.stringify(currentConfig, null, 2));
        fs.writeFileSync(mcpMetaPath, JSON.stringify(writtenMcpIds, null, 2));

        console.log(`[MCP] OpenCode MCP config written: ${writtenMcpIds.length} server(s)`);
        return true;
      }

      return false;
    } catch (error) {
      console.error('Failed to write MCP config:', error);
      return false;
    }
  };

  // 从配置中移除MCP
  const removeMCPFromConfig = async (targetType: TargetType, mcpId: string): Promise<boolean> => {
    try {
      if (targetType === 'claude-code') {
        const homeDir = os.homedir();
        const claudeJsonPath = path.join(homeDir, '.claude.json');

        if (!fs.existsSync(claudeJsonPath)) {
          return true;
        }

        const claudeJson: any = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));

        if (claudeJson.mcpServers && claudeJson.mcpServers[mcpId]) {
          delete claudeJson.mcpServers[mcpId];
          fs.writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2));
        }

        return true;
      } else if (targetType === 'codex') {
        // 从 Codex config.toml 中移除指定的 MCP 条目
        const homeDir = os.homedir();
        const codexDir = path.join(homeDir, '.codex');
        const codexConfigPath = path.join(codexDir, 'config.toml');

        if (!fs.existsSync(codexConfigPath)) {
          return true;
        }

        let currentConfig: Record<string, any> = {};
        try {
          currentConfig = parseToml(fs.readFileSync(codexConfigPath, 'utf-8'));
        } catch (error) {
          console.warn('[MCP] Failed to parse Codex config.toml for removal:', error);
          return false;
        }

        if (currentConfig.mcp_servers && currentConfig.mcp_servers[mcpId]) {
          delete currentConfig.mcp_servers[mcpId];

          // 如果mcp_servers为空对象，删除该键
          if (Object.keys(currentConfig.mcp_servers).length === 0) {
            delete currentConfig.mcp_servers;
          }

          atomicWriteFile(codexConfigPath, stringifyToml(currentConfig));

          // 更新metadata
          const mcpMetaPath = path.join(codexDir, '.aicodeswitch_mcp_servers.json');
          if (fs.existsSync(mcpMetaPath)) {
            try {
              const previousIds: string[] = JSON.parse(fs.readFileSync(mcpMetaPath, 'utf8'));
              const updatedIds = previousIds.filter(id => id !== mcpId);
              fs.writeFileSync(mcpMetaPath, JSON.stringify(updatedIds, null, 2));
            } catch {
              // ignore
            }
          }

          console.log(`[MCP] Removed MCP ${mcpId} from Codex config`);
        }

        return true;
      } else if (targetType === 'opencode') {
        const opencodeConfigPath = getOpencodeConfigPath();

        if (!fs.existsSync(opencodeConfigPath)) {
          return true;
        }

        let currentConfig: Record<string, any> = {};
        try {
          currentConfig = JSON.parse(fs.readFileSync(opencodeConfigPath, 'utf-8'));
        } catch (error) {
          console.warn('[MCP] Failed to parse opencode.json for removal:', error);
          return false;
        }

        if (currentConfig.mcp && currentConfig.mcp[mcpId]) {
          delete currentConfig.mcp[mcpId];
          if (Object.keys(currentConfig.mcp).length === 0) {
            delete currentConfig.mcp;
          }

          atomicWriteFile(opencodeConfigPath, JSON.stringify(currentConfig, null, 2));

          const opencodeDir = path.dirname(opencodeConfigPath);
          const mcpMetaPath = path.join(opencodeDir, '.aicodeswitch_mcp_servers.json');
          if (fs.existsSync(mcpMetaPath)) {
            try {
              const previousIds: string[] = JSON.parse(fs.readFileSync(mcpMetaPath, 'utf8'));
              const updatedIds = previousIds.filter(id => id !== mcpId);
              fs.writeFileSync(mcpMetaPath, JSON.stringify(updatedIds, null, 2));
            } catch {
              // ignore
            }
          }

          console.log(`[MCP] Removed MCP ${mcpId} from OpenCode config`);
        }

        return true;
      }

      return false;
    } catch (error) {
      console.error('Failed to remove MCP from config:', error);
      return false;
    }
  };

  // 服务启动时同步MCP配置到已激活的工具
  const allMcps = dbManager.getMCPs();
  const targetsToSync = new Set<TargetType>();
  for (const mcp of allMcps) {
    if (mcp.targets) {
      for (const target of mcp.targets) {
        targetsToSync.add(target);
      }
    }
  }
  for (const target of targetsToSync) {
    const activeRouteId = dbManager.getActiveRouteIdForTool(target);
    if (activeRouteId) {
      try {
        await writeMCPConfig(target);
        console.log(`[Startup MCP Sync] MCP config synced for ${target}`);
      } catch (error) {
        console.error(`[Startup MCP Sync] Failed to sync MCP config for ${target}:`, error);
      }
    }
  }

};

// listen 就绪标志：区分"启动阶段"与"运行阶段"，启动期致命异常应让进程退出
let listenReady = false;

const start = async () => {
  fs.mkdirSync(dataDir, { recursive: true });

  // 自动检测数据库类型并执行迁移（如果需要）
  console.time('[Server] step "database-init"');
  const dbManager = await DatabaseFactory.createAuto(dataDir, legacyDataDir) as FileSystemDatabaseManager;

  // 创建并初始化共享 LogStore（追加写 NDJSON），注入 dbManager
  const logStore = createLogStore(dataDir);
  await logStore.init();
  // 在服务对外提供流量前完成旧 JSON → NDJSON 迁移（含自愈：标记缺失时清空重迁，避免重复）。
  // 必须在 listen 之前，防止迁移的「清空重迁」与实时写入竞争。
  try {
    await logStore.migrateLegacy(dataDir);
  } catch (err) {
    console.error('[Server] LogStore legacy migration failed:', err);
  }
  dbManager.setLogStore(logStore);

  // Agent Map 服务接入 dbManager（种子化已有 Session + 启动状态清扫定时器）
  agentMapService.attach(dbManager);
  console.timeEnd('[Server] step "database-init"');

  // 服务启动时自动同步配置文件（适用于 CLI 和 dev:server）
  console.time('[Server] step "sync-configs"');
  try {
    await syncConfigsOnServerStartup(dbManager);
  } catch (error) {
    console.error('[Server] Tool config sync failed:', error);
  }
  console.timeEnd('[Server] step "sync-configs"');

  // 清理旧的迁移临时文件
  try {
    cleanupOldTempFiles();
  } catch { /* ignore */ }

  const proxyServer = new ProxyServer(dbManager, app);

  // Initialize AccessKey module
  const accessKeyModule = new AccessKeyModule(dataDir, logStore);
  try {
    await accessKeyModule.initialize();
    proxyServer.setAccessKeyModule(accessKeyModule);
  } catch (error) {
    console.error('[Server] AccessKey module initialization failed:', error);
  }

  // 日志保留期定时清理（主库 global + 所有 AccessKey key:*），每 6h 一次
  const logRetentionTimer = setInterval(() => {
    Promise.all([
      logStore.retain('global', 30).catch(() => {}),
      accessKeyModule.keyLogger.cleanupOldLogs().catch(() => {}),
    ]).catch(() => {});
  }, 6 * 60 * 60 * 1000);
  if (typeof logRetentionTimer.unref === 'function') logRetentionTimer.unref();

  // Initialize Service Performance Tracker (全局统计，与 AUTH 无关)
  const performanceTracker = new ServicePerformanceTracker(dataDir);
  try {
    await performanceTracker.initialize();
    performanceTracker.startAutoFlush();
    proxyServer.setPerformanceTracker(performanceTracker);
  } catch (error) {
    console.error('[Server] Performance tracker initialization failed:', error);
  }

  // 恢复已写入本地的 AccessKey（在代理配置写入之后、AccessKey 模块初始化之后）
  try {
    applyWriteLocalRecords(proxyServer);
  } catch (error) {
    console.error('[Server] Failed to apply write-local records:', error);
  }

  // Initialize proxy server and register proxy routes last
  proxyServer.initialize();

  // Register admin routes first
  console.time('[Server] step "register-routes"');
  await registerRoutes(dbManager, proxyServer);
  await proxyServer.registerProxyRoutes();
  console.timeEnd('[Server] step "register-routes"');

  app.use(express.static(path.resolve(__dirname, '../ui')));

  // 404 处理程序 - 确保返回 JSON 而不是 HTML（放在所有路由和静态文件之后）
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Error handling middleware - must be the last middleware
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[Error Handler]', err);
    // Ensure JSON response
    res.setHeader('Content-Type', 'application/json');
    res.status(500).json({ error: err.message || 'Internal server error' });
  });

  // 端口检测：若被占用，可能是上一个进程仍在退出过程中（Ctrl+C 后 shutdown 尚未完全释放端口），
  // 此处轮询等待其释放后再继续启动，避免与正在退出的旧进程发生端口冲突。
  // 超时仍未释放才判定为真正的占用并报错退出。
  const PORT_POLL_INTERVAL = 300;
  const PORT_WAIT_TIMEOUT = 10000;
  let isPortUsable = await checkPortUsable(port);
  if (!isPortUsable) {
    console.warn(`端口 ${port} 当前被占用，可能是上一个服务进程仍在退出中，等待其释放...`);
    const portDeadline = Date.now() + PORT_WAIT_TIMEOUT;
    while (!isPortUsable && Date.now() < portDeadline) {
      await new Promise(resolve => setTimeout(resolve, PORT_POLL_INTERVAL));
      isPortUsable = await checkPortUsable(port);
    }
    if (!isPortUsable) {
      console.error(`端口 ${port} 在 ${PORT_WAIT_TIMEOUT / 1000}s 后仍被占用，无法启动服务。请执行 aicos stop 后重启。`);
      process.exit(1);
    }
    console.log(`端口 ${port} 已释放，继续启动...`);
  }

  console.time('[Server] step "listen"');
  const server = app.listen(port, host, () => {
    listenReady = true;
    const listenInfo = host === '0.0.0.0'
      ? ` (listening on all interfaces, port ${port})`
      : '';
    console.log(`Admin server running on http://${clientHost}:${port}${listenInfo}`);
    // 点击 OS 通知时打开任务地图页（仅 terminal-notifier 路径生效；osascript 无法控制点击）
    setNotifierAppUrl(`http://${clientHost}:${port}/#/agent-map`);
    console.timeEnd('[Server] step "listen"');

    // 启动后异步执行延迟维护任务（分片校验/修复、日志清理、会话索引构建）
    // 不阻塞服务启动，后台静默执行
    dbManager.deferredMaintenance().catch(err => {
      console.error('[Server] Deferred maintenance error:', err);
    });
  });

  // 显式处理 listen 错误（EADDRINUSE/权限不足等），打印明确日志并退出，
  // 避免被全局 uncaughtException 静默吞掉导致"进程在但不 listen"
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[Server] 端口 ${port} 已被占用（EADDRINUSE）。请执行 aicos stop 后重启，或更换端口（PORT 环境变量）。`);
    } else {
      console.error('[Server] 监听失败:', err);
    }
    setImmediate(() => process.exit(1));
  });

  // 设置黑名单检查函数，用于在规则状态同步时检查黑名单是否已过期
  rulesStatusBroadcaster.setBlacklistChecker(async (serviceId, routeId, contentType) => {
    // 检查服务��否在黑名单中
    const isBlacklisted = await dbManager.isServiceBlacklisted(
      serviceId,
      routeId,
      contentType
    );
    return isBlacklisted;
  });

  let isShuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;

  const shutdown = async (signal: string) => {
    if (isShuttingDown) {
      return shutdownPromise ?? Promise.resolve();
    }

    isShuttingDown = true;
    shutdownPromise = (async () => {
      console.log(`[Server] Received ${signal}, shutting down...`);

      // 立即停止监听以释放端口（同步关闭监听句柄，端口马上可用），
      // 避免在漫长的清理流程期间端口仍被占用，导致此时重启产生 EADDRINUSE 冲突。
      const serverClosedPromise = new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      // 强制断开所有现存连接（含浏览器长连的 SSE：agent-map stream、rules-status
      // 广播等）。否则这些连接永不自行关闭，server.close 的回调要等满下面 5s 超时
      // 才触发，表现为 Ctrl+C 后「卡很久才打印 Server stopped.」。closeAllConnections
      // 立即销毁所有 socket，让 close 回调几乎瞬时完成。
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }

      // 服务终止前恢复配置文件（适用于 aicos stop 与 Ctrl+C）
      try {
        const claudeRestored = await restoreClaudeConfig();
        console.log(`[Shutdown ...] Claude Code config ${claudeRestored ? 'restored' : 'was not modified'}`);
      } catch (error) {
        console.error('[Shutdown ...] Failed to restore Claude config:', error);
      }

      try {
        const codexRestored = await restoreCodexConfig();
        console.log(`[Shutdown ...] Codex config ${codexRestored ? 'restored' : 'was not modified'}`);
      } catch (error) {
        console.error('[Shutdown ...] Failed to restore Codex config:', error);
      }

      try {
        const opencodeRestored = await restoreOpencodeConfig();
        console.log(`[Shutdown ...] OpenCode config ${opencodeRestored ? 'restored' : 'was not modified'}`);
      } catch (error) {
        console.error('[Shutdown ...] Failed to restore OpenCode config:', error);
      }

      // Shutdown AccessKey module
      try {
        await accessKeyModule.shutdown();
      } catch (error) {
        console.error('[Shutdown ...] AccessKey module shutdown failed:', error);
      }

      // Flush 服务性能统计（全局桶）后停止定时刷盘
      try {
        performanceTracker.stopAutoFlush();
        await performanceTracker.flush();
      } catch (error) {
        console.error('[Shutdown ...] Performance tracker flush failed:', error);
      }

      dbManager.close();

      // 落盘 LogStore 所有 namespace 的索引
      try {
        await logStore.close();
      } catch (error) {
        console.error('[Shutdown ...] LogStore close failed:', error);
      }

      // 清理规则状态广播器（关闭 SSE 连接）
      rulesStatusBroadcaster.destroy();

      // 等待监听句柄与现有连接关闭完成（最多 5s），确保端口彻底释放后再退出。
      await Promise.race([
        serverClosedPromise,
        new Promise<void>((resolve) => {
          setTimeout(resolve, 5000);
        })
      ]);

      console.log('Server stopped.');
      process.exit(0);
    })();

    return shutdownPromise;
  };

  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

  // 优雅关闭端点（供 Tauri 等外部调用者触发服务端完整清理流程）
  // 放在 shutdown 定义之后注册，确保闭包可引用
  app.post('/api/shutdown', asyncHandler(async (_req, res) => {
    res.json({ success: true });
    setImmediate(() => { void shutdown('HTTP_SHUTDOWN'); });
  }));
};

// 全局未捕获异常处理 - 防止服务崩溃
process.on('uncaughtException', (error: Error) => {
  console.error('[Uncaught Exception] 服务遇到未捕获的异常:', error);
  console.error('[Uncaught Exception] 堆栈信息:', error.stack);
  // 启动阶段（listen 之前）的异常通常是致命的（依赖加载失败、初始化崩溃等），
  // 静默吞掉会导致"进程在但不 listen"，Tauri 只能干等超时；此时退出让上层重新探测/诊断。
  if (!listenReady) {
    console.error('[Uncaught Exception] 发生在服务监听之前，退出进程');
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason: unknown) => {
  console.error('[Unhandled Rejection] 服务遇到未处理的 Promise 拒绝:', reason);
  if (!listenReady) {
    console.error('[Unhandled Rejection] 发生在服务监听之前，退出进程');
    process.exit(1);
  }
});

start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
