import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { DatabaseFactory } from './database-factory';
import { ProxyServer } from './proxy-server';
import type { FileSystemDatabaseManager } from './fs-database';
import type { AppConfig, LoginRequest, LoginResponse, AuthStatus, InstalledSkill, SkillCatalogItem, SkillInstallRequest, SkillInstallResponse, TargetType } from '../types';
import os from 'os';
import { isAuthEnabled, verifyAuthCode, generateToken, authMiddleware } from './auth';
import { checkVersionUpdate } from './version-check';
import { checkPortUsable } from './utils';
import { getToolsInstallationStatus } from './tools-service';
import { createToolInstallationWSServer } from './websocket-service';
import { createRulesStatusWSServer } from './rules-status-service';
import {
  saveMetadata,
  deleteMetadata,
  checkClaudeConfigStatus,
  checkCodexConfigStatus,
  cleanupInvalidMetadata,
  type ConfigMetadata
} from './config-metadata';
import { SKILLSMP_API_KEY } from './config';

const appDir = path.join(os.homedir(), '.aicodeswitch');
const legacyDataDir = path.join(appDir, 'data');
const dataDir = path.join(appDir, 'fs-db');
const dotenvPath = path.resolve(appDir, 'aicodeswitch.conf');
const upgradeHashFilePath = path.join(appDir, 'upgrade-hash');

if (fs.existsSync(dotenvPath)) {
  dotenv.config({ path: dotenvPath });
}

const host = process.env.HOST || '127.0.0.1';
const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 4567;

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

const app = express();
app.use(cors());
app.use(express.json({ limit: 'Infinity' }));
app.use(express.urlencoded({ extended: true, limit: 'Infinity' }));

const asyncHandler =
  (handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch((err) => {
      console.error('[asyncHandler] Caught error:', err);
      next(err);
    });
  };

const writeClaudeConfig = async (dbManager: FileSystemDatabaseManager): Promise<boolean> => {
  try {
    const homeDir = os.homedir();
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 4567;
    const config = dbManager.getConfig();

    // Claude Code settings.json
    const claudeDir = path.join(homeDir, '.claude');
    const claudeSettingsPath = path.join(claudeDir, 'settings.json');
    const claudeSettingsBakPath = path.join(claudeDir, 'settings.json.aicodeswitch_backup');
    const claudeJsonBakPath = path.join(homeDir, '.claude.json.aicodeswitch_backup');

    // 使用新的配置状态检测来判断是否可以写入
    const configStatus = checkClaudeConfigStatus();

    // 只有当当前配置已经是代理配置时，才拒绝写入
    if (configStatus.isOverwritten) {
      console.error('Claude config has already been overwritten. Please restore the original config first.');
      return false;
    }

    // 如果 .aicodeswitch_backup 文件不存在，才进行备份（避免覆盖已有备份）
    let originalSettingsHash: string | undefined = undefined;

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

    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }

    const claudeSettings = {
      env: {
        ANTHROPIC_AUTH_TOKEN: config.apiKey || "api_key",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_BASE_URL: `http://${host}:${port}/claude-code`,
        API_TIMEOUT_MS: "3000000",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: 1
      }
    };

    fs.writeFileSync(claudeSettingsPath, JSON.stringify(claudeSettings, null, 2));

    // Claude Code .claude.json
    const claudeJsonPath = path.join(homeDir, '.claude.json');

    // 先读取原文件内容（如果存在）
    let claudeJson: any = {};
    if (fs.existsSync(claudeJsonPath)) {
      claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    }

    // 然后处理备份
    if (!fs.existsSync(claudeJsonBakPath)) {
      if (fs.existsSync(claudeJsonPath)) {
        fs.renameSync(claudeJsonPath, claudeJsonBakPath);
      }
    }

    claudeJson.hasCompletedOnboarding = true;

    fs.writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2));

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

const writeCodexConfig = async (dbManager: FileSystemDatabaseManager): Promise<boolean> => {
  try {
    const homeDir = os.homedir();
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 4567;
    const config = dbManager.getConfig();

    // Codex config.toml
    const codexDir = path.join(homeDir, '.codex');
    const codexConfigPath = path.join(codexDir, 'config.toml');
    const codexConfigBakPath = path.join(codexDir, 'config.toml.aicodeswitch_backup');
    const codexAuthBakPath = path.join(codexDir, 'auth.json.aicodeswitch_backup');

    // 使用新的配置状态检测来判断是否可以写入
    const configStatus = checkCodexConfigStatus();

    // 只有当当前配置已经是代理配置时，才拒绝写入
    if (configStatus.isOverwritten) {
      console.error('Codex config has already been overwritten. Please restore the original config first.');
      return false;
    }

    // 如果 .aicodeswitch_backup 文件不存在，才进行备份（避免覆盖已有备份）
    let originalConfigHash: string | undefined = undefined;

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

    if (!fs.existsSync(codexDir)) {
      fs.mkdirSync(codexDir, { recursive: true });
    }

    const codexConfig = `model_provider = "aicodeswitch"
model = "gpt-5.1-codex"
model_reasoning_effort = "high"
disable_response_storage = true


[model_providers.aicodeswitch]
name = "aicodeswitch"
base_url = "http://${host}:${port}/codex"
wire_api = "responses"
requires_openai_auth = true
`;

    fs.writeFileSync(codexConfigPath, codexConfig);

    // Codex auth.json
    const codexAuthPath = path.join(codexDir, 'auth.json');

    // 同样处理 auth.json 的备份
    if (!fs.existsSync(codexAuthBakPath)) {
      if (fs.existsSync(codexAuthPath)) {
        fs.renameSync(codexAuthPath, codexAuthBakPath);
      }
    }

    const codexAuth = {
      OPENAI_API_KEY: config.apiKey || "api_key"
    };

    fs.writeFileSync(codexAuthPath, JSON.stringify(codexAuth, null, 2));

    // 保存元数据
    const currentConfigHash = createHash('sha256').update(fs.readFileSync(codexConfigPath, 'utf-8')).digest('hex');
    const metadata: ConfigMetadata = {
      configType: 'codex',
      timestamp: Date.now(),
      originalHash: originalConfigHash,
      proxyMarker: `http://${host}:${port}/codex`,
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

    // Restore Claude Code settings.json
    const claudeDir = path.join(homeDir, '.claude');
    const claudeSettingsPath = path.join(claudeDir, 'settings.json');
    const claudeSettingsBakPath = path.join(claudeDir, 'settings.json.aicodeswitch_backup');

    if (fs.existsSync(claudeSettingsBakPath)) {
      if (fs.existsSync(claudeSettingsPath)) {
        fs.unlinkSync(claudeSettingsPath);
      }
      fs.renameSync(claudeSettingsBakPath, claudeSettingsPath);
    }

    // Restore Claude Code .claude.json
    const claudeJsonPath = path.join(homeDir, '.claude.json');
    const claudeJsonBakPath = path.join(homeDir, '.claude.json.aicodeswitch_backup');

    if (fs.existsSync(claudeJsonBakPath)) {
      if (fs.existsSync(claudeJsonPath)) {
        fs.unlinkSync(claudeJsonPath);
      }
      fs.renameSync(claudeJsonBakPath, claudeJsonPath);
    }

    // 删除元数据
    deleteMetadata('claude');

    return true;
  } catch (error) {
    console.error('Failed to restore Claude config files:', error);
    return false;
  }
};

const restoreCodexConfig = async (): Promise<boolean> => {
  try {
    const homeDir = os.homedir();

    // Restore Codex config.toml
    const codexDir = path.join(homeDir, '.codex');
    const codexConfigPath = path.join(codexDir, 'config.toml');
    const codexConfigBakPath = path.join(codexDir, 'config.toml.aicodeswitch_backup');

    if (fs.existsSync(codexConfigBakPath)) {
      if (fs.existsSync(codexConfigPath)) {
        fs.unlinkSync(codexConfigPath);
      }
      fs.renameSync(codexConfigBakPath, codexConfigPath);
    }

    // Restore Codex auth.json
    const codexAuthPath = path.join(codexDir, 'auth.json');
    const codexAuthBakPath = path.join(codexDir, 'auth.json.aicodeswitch_backup');

    if (fs.existsSync(codexAuthBakPath)) {
      if (fs.existsSync(codexAuthPath)) {
        fs.unlinkSync(codexAuthPath);
      }
      fs.renameSync(codexAuthBakPath, codexAuthPath);
    }

    // 删除元数据
    deleteMetadata('codex');

    return true;
  } catch (error) {
    console.error('Failed to restore Codex config files:', error);
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
  const baseDir = targetType === 'claude-code' ? '.claude' : '.codex';
  return path.join(os.homedir(), baseDir, 'skills', skillId);
};

function isSkillSymlinkExists(skillId: string, targetType: TargetType): boolean {
  const symlinkPath = getSkillSymlinkPath(skillId, targetType);

  try {
    const stats = fs.lstatSync(symlinkPath);
    return stats.isSymbolicLink();
  } catch (error) {
    return false;
  }
}

async function createSkillSymlink(skillId: string, targetType: TargetType): Promise<{ success: boolean; error?: string }> {
  try {
    const centralDir = getCentralSkillsDir();
    const skillDir = path.join(centralDir, skillId);
    const symlinkPath = getSkillSymlinkPath(skillId, targetType);

    if (!fs.existsSync(skillDir)) {
      return { success: false, error: 'Skill目录不存在' };
    }

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

      ['claude-code', 'codex'].forEach((targetType) => {
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

const registerRoutes = (dbManager: FileSystemDatabaseManager, proxyServer: ProxyServer) => {
  updateProxyConfig(dbManager.getConfig());

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

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

  // 鉴权中间件 - 保护所有 /api/* 路由 (除了 /api/auth/*)
  app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/auth/')) {
      next(); // /api/auth/* 路由不需要鉴权
    } else {
      authMiddleware(req, res, next);
    }
  });

  app.get('/api/vendors', (_req, res) => res.json(dbManager.getVendors()));
  app.post('/api/vendors', asyncHandler(async (req, res) => res.json(await dbManager.createVendor(req.body))));
  app.put('/api/vendors/:id', asyncHandler(async (req, res) => res.json(await dbManager.updateVendor(req.params.id, req.body))));
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
  app.put('/api/services/:id', asyncHandler(async (req, res) => res.json(await dbManager.updateAPIService(req.params.id, req.body))));
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
  app.delete('/api/routes/:id', asyncHandler(async (req, res) => res.json(await dbManager.deleteRoute(req.params.id))));
  app.post(
    '/api/routes/:id/activate',
    asyncHandler(async (req, res) => {
      const result = await dbManager.activateRoute(req.params.id);
      if (result) {
        await proxyServer.reloadRoutes();
      }
      res.json(result);
    })
  );

  app.post(
    '/api/routes/:id/deactivate',
    asyncHandler(async (req, res) => {
      const result = await dbManager.deactivateRoute(req.params.id);
      if (result) {
        await proxyServer.reloadRoutes();
      }
      res.json(result);
    })
  );

  // 批量停用所有激活的路由（用于应用关闭时清理）
  app.post(
    '/api/routes/deactivate-all',
    asyncHandler(async (_req, res) => {
      console.log('[Deactivate All Routes] Starting cleanup process...');

      // 步骤1：恢复 Claude Code 配置文件
      try {
        console.log('[Deactivate All Routes] Restoring Claude Code config...');
        const claudeRestored = await restoreClaudeConfig();
        console.log(`[Deactivate All Routes] Claude Code config ${claudeRestored ? 'restored' : 'was not modified'}`);
      } catch (error: any) {
        console.error('[Deactivate All Routes] Failed to restore Claude config:', error);
      }

      // 步骤2：恢复 Codex 配置文件
      try {
        console.log('[Deactivate All Routes] Restoring Codex config...');
        const codexRestored = await restoreCodexConfig();
        console.log(`[Deactivate All Routes] Codex config ${codexRestored ? 'restored' : 'was not modified'}`);
      } catch (error: any) {
        console.error('[Deactivate All Routes] Failed to restore Codex config:', error);
      }

      // 步骤3：停用所有激活的路由
      console.log('[Deactivate All Routes] Deactivating all active routes...');
      const deactivatedCount = await dbManager.deactivateAllRoutes();

      if (deactivatedCount > 0) {
        console.log(`[Deactivate All Routes] Deactivated ${deactivatedCount} route(s), reloading routes...`);
        await proxyServer.reloadRoutes();
        console.log('[Deactivate All Routes] Routes reloaded successfully');
      } else {
        console.log('[Deactivate All Routes] No active routes to deactivate');
      }

      console.log('[Deactivate All Routes] Cleanup process completed');

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
      const logs = await dbManager.getLogs(limit, offset);
      res.json(logs);
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
      const logs = await dbManager.getErrorLogs(limit, offset);
      res.json(logs);
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
    '/api/error-logs/count',
    asyncHandler(async (_req, res) => {
      const count = await dbManager.getErrorLogsCount();
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
        await proxyServer.updateConfig(config);
        updateProxyConfig(config);
      }
      res.json(result);
    })
  );

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

      if (!targetType || (targetType !== 'claude-code' && targetType !== 'codex')) {
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

      if (!targetType || (targetType !== 'claude-code' && targetType !== 'codex')) {
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

      ['claude-code', 'codex'].forEach(async (targetType) => {
        await removeSkillSymlink(skillId, targetType as TargetType);
      });

      fs.rmSync(skillDir, { recursive: true, force: true });

      res.json({ success: true });
    })
  );

  app.post(
    '/api/write-config/claude',
    asyncHandler(async (_req, res) => {
      const result = await writeClaudeConfig(dbManager);
      res.json(result);
    })
  );

  app.post(
    '/api/write-config/codex',
    asyncHandler(async (_req, res) => {
      const result = await writeCodexConfig(dbManager);
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

  app.get('/api/check-backup/claude', (_req, res) => {
    res.json({ exists: checkClaudeBackupExists() });
  });

  app.get('/api/check-backup/codex', (_req, res) => {
    res.json({ exists: checkCodexBackupExists() });
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
      const sessions = await dbManager.getSessions(undefined, limit, offset);
      res.json(sessions);
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

  // 工具安装检测相关路由
  app.get('/api/tools/status', asyncHandler(async (_req, res) => {
    console.log('[API] GET /api/tools/status - 获取工具安装状态');
    try {
      const status = await getToolsInstallationStatus();
      console.log('[API] 工具安装状态:', status);
      res.json(status);
    } catch (error) {
      console.error('[API] 获取工具状态失败:', error);
      res.status(500).json({ error: '获取工具状态失败' });
    }
  }));

};

const start = async () => {
  fs.mkdirSync(dataDir, { recursive: true });

  // 自动检测数据库类型并执行迁移（如果需要）
  console.log('[Server] Initializing database...');
  const dbManager = await DatabaseFactory.createAuto(dataDir, legacyDataDir) as FileSystemDatabaseManager;
  console.log('[Server] Database initialized successfully');

  const proxyServer = new ProxyServer(dbManager, app);
  // Initialize proxy server and register proxy routes last
  proxyServer.initialize();

  // Register admin routes first
  registerRoutes(dbManager, proxyServer);
  await proxyServer.registerProxyRoutes();

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

  const isPortUsable = await checkPortUsable(port);
  if (!isPortUsable) {
    console.error(`端口 ${port} 已被占用，无法启动服务。请执行 aicos stop 后重启。`);
    process.exit(1);
  }

  const server = app.listen(port, host, () => {
    console.log(`Admin server running on http://${host}:${port}`);
  });

  // 创建 WebSocket 服务器用于工具安装
  const toolInstallWss = createToolInstallationWSServer();

  // 创建 WebSocket 服务器用于规则状态
  const rulesStatusWss = createRulesStatusWSServer();

  // 将 WebSocket 服务器附加到 HTTP 服务器
  server.on('upgrade', (request, socket, head) => {
    if (request.url === '/api/tools/install') {
      toolInstallWss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
        toolInstallWss.emit('connection', ws, request);
      });
    } else if (request.url === '/api/rules/status') {
      rulesStatusWss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
        rulesStatusWss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  console.log(`WebSocket server for tool installation attached to ws://${host}:${port}/api/tools/install`);
  console.log(`WebSocket server for rules status attached to ws://${host}:${port}/api/rules/status`);

  const shutdown = async () => {
    console.log('Shutting down server...');
    dbManager.close();
    server.close(() => {
      console.log('Server stopped.');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
};

// 全局未捕获异常处理 - 防止服务崩溃
process.on('uncaughtException', (error: Error) => {
  console.error('[Uncaught Exception] 服务遇到未捕获的异常:', error);
  console.error('[Uncaught Exception] 堆栈信息:', error.stack);
  // 不退出进程，继续运行
});

process.on('unhandledRejection', (reason: unknown) => {
  console.error('[Unhandled Rejection] 服务遇到未处理的 Promise 拒绝:', reason);
  // 不退出进程，继续运行
});

start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
