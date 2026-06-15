import { spawn, execSync } from 'child_process';
import { writeFileSync, unlinkSync, readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import type { LaunchResult, ToolType } from '../types';

function which(cmd: string): boolean {
  try {
    const command = process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`;
    execSync(command, { stdio: 'ignore', windowsHide: true }); // 隐藏 Windows 命令行窗口，避免检测时闪窗
    return true;
  } catch {
    return false;
  }
}

function isToolInstalled(tool: ToolType): boolean {
  if (tool === 'claude-code') return which('claude');
  if (tool === 'codex') return which('codex');
  return false;
}

function getToolCli(tool: ToolType): string {
  return tool === 'claude-code' ? 'claude' : 'codex';
}

// ─── 项目目录自动推断 ───

/**
 * 从 Claude Code session 文件中查找 cwd
 * Claude Code 在 ~/.claude/sessions/<PID>.json 中记录 sessionId 和 cwd
 */
function resolveProjectDirFromClaudeSessions(sessionId: string): string | null {
  try {
    const sessionsDir = join(homedir(), '.claude', 'sessions');
    if (!existsSync(sessionsDir)) return null;
    const files = readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const content = readFileSync(join(sessionsDir, file), 'utf-8');
        const meta = JSON.parse(content);
        if (meta.sessionId === sessionId && meta.cwd) {
          return meta.cwd;
        }
      } catch { /* skip unreadable files */ }
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * 从 Codex session 文件中查找 cwd
 * Codex 在 ~/.codex/sessions/ 目录下存储 JSONL 格式的会话文件
 */
function resolveProjectDirFromCodexSessions(sessionId: string): string | null {
  try {
    const sessionsDir = join(homedir(), '.codex', 'sessions');
    if (!existsSync(sessionsDir)) return null;
    const files = readdirSync(sessionsDir);
    for (const file of files) {
      // Codex session 文件名格式: <uuid>.jsonl 或在子目录中
      const filePath = join(sessionsDir, file);
      try {
        if (existsSync(filePath) && !filePath.endsWith('.jsonl')) continue;
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.trim().split('\n');
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            // Codex session 文件中可能包含 cwd 字段
            if (entry.sessionId === sessionId && entry.cwd) return entry.cwd;
            if (entry.cwd && line.includes(sessionId)) return entry.cwd;
          } catch { /* skip unparseable lines */ }
        }
      } catch { /* skip unreadable files */ }
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * 自动推断会话对应的项目目录
 */
export function resolveProjectDir(sessionId: string, _sourceTool?: ToolType): string | null {
  // 优先从 Claude Code sessions 查找
  let cwd = resolveProjectDirFromClaudeSessions(sessionId);
  if (cwd) return cwd;

  // 然后从 Codex sessions 查找
  cwd = resolveProjectDirFromCodexSessions(sessionId);
  if (cwd) return cwd;

  return null;
}

// ─── 临时文件管理 ───

export function writePromptToTempFile(prompt: string, sessionId: string): string {
  const fileName = `aicodeswitch-migration-${sessionId}.txt`;
  const filePath = join(tmpdir(), fileName);
  writeFileSync(filePath, prompt, 'utf-8');
  return filePath;
}

export function cleanupTempFile(filePath: string): void {
  setTimeout(() => {
    try { unlinkSync(filePath); } catch { /* already cleaned up */ }
  }, 30000);
}

export function cleanupOldTempFiles(): void {
  try {
    const dir = tmpdir();
    const files = readdirSync(dir);
    const now = Date.now();
    for (const file of files) {
      if (file.startsWith('aicodeswitch-migration-') && file.endsWith('.txt')) {
        const fullPath = join(dir, file);
        try {
          const { statSync } = require('fs');
          const stat = statSync(fullPath);
          if (now - stat.mtimeMs > 3600000) {
            unlinkSync(fullPath);
          }
        } catch { /* ignore per-file errors */ }
      }
    }
  } catch { /* ignore */ }
}

// ─── 命令构建 ───

function buildCommand(tool: ToolType, promptFilePath: string, projectDir?: string): string {
  const cli = getToolCli(tool);
  const cdPrefix = projectDir ? `cd "${projectDir}" && ` : '';
  const readCmd = process.platform === 'win32' ? `type "${promptFilePath}"` : `cat "${promptFilePath}"`;
  return `${cdPrefix}${readCmd} | ${cli}`;
}

// ─── 终端启动 ───

async function launchViaOSAScript(command: string): Promise<number | null> {
  return new Promise((resolve) => {
    const escaped = command.replace(/"/g, '\\"');
    const script = `tell app "Terminal" to do script "${escaped}"`;
    const child = spawn('osascript', ['-e', script], {
      stdio: 'ignore',
      detached: true,
    });
    child.on('error', () => {
      // Try iTerm2 as fallback
      const itermScript = `tell app "iTerm" to tell current window to set newTab to (create tab with default profile) then write session 1 of newTab text "${escaped}"`;
      const child2 = spawn('osascript', ['-e', itermScript], {
        stdio: 'ignore',
        detached: true,
      });
      child2.on('error', () => resolve(null));
      child2.on('spawn', () => resolve(child2.pid || 0));
    });
    child.on('spawn', () => resolve(child.pid || 0));
  });
}

async function launchViaTerminal(command: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn('gnome-terminal', ['--', 'bash', '-c', `${command}; exec bash`], {
      stdio: 'ignore',
      detached: true,
    });
    child.on('error', () => {
      const child2 = spawn('xterm', ['-e', `${command}; exec bash`], {
        stdio: 'ignore',
        detached: true,
      });
      child2.on('error', () => resolve(null));
      child2.on('spawn', () => resolve(child2.pid || 0));
    });
    child.on('spawn', () => resolve(child.pid || 0));
  });
}

// ─── 回退结果 ───

function createFallbackResult(
  tool: ToolType,
  command: string,
  promptFilePath: string,
): LaunchResult {
  const toolName = tool === 'claude-code' ? 'Claude Code' : 'Codex';
  return {
    success: false,
    method: 'fallback',
    reason: `无法自动启动 ${toolName}`,
    command,
    promptFilePath,
    fallbackSuggestions: [
      `请在终端中执行: ${command}`,
      '或复制下方 Prompt 内容，在新会话中粘贴',
    ],
  };
}

// ─── 主启动逻辑 ───

export async function launchTargetTool(
  tool: ToolType,
  promptFilePath: string,
  projectDir?: string,
): Promise<LaunchResult> {
  const command = buildCommand(tool, promptFilePath, projectDir);

  try {
    let pid: number | null = null;

    if (process.platform === 'darwin') {
      pid = await launchViaOSAScript(command);
    } else if (process.platform === 'linux') {
      pid = await launchViaTerminal(command);
    } else {
      // Windows: open new cmd window
      const cdPrefix = projectDir ? `cd /d "${projectDir}" && ` : '';
      const cli = getToolCli(tool);
      const winCommand = `start cmd /k "${cdPrefix}type "${promptFilePath}" | ${cli}"`;
      await new Promise<void>((resolve, reject) => {
        const child = spawn('cmd', ['/c', winCommand], {
          stdio: 'ignore',
          detached: true,
        });
        child.on('error', reject);
        child.on('spawn', () => resolve());
      });
      pid = 0;
    }

    if (pid !== null) {
      return {
        success: true,
        method: 'cli-launch',
        pid: pid || undefined,
        command,
        promptFilePath,
      };
    }
  } catch {
    // Fall through to fallback
  }

  return createFallbackResult(tool, command, promptFilePath);
}

export async function launchTargetWithFallback(
  tool: ToolType,
  promptFilePath: string,
  prompt: string,
  projectDir?: string,
): Promise<LaunchResult> {
  const installed = isToolInstalled(tool);
  if (!installed) {
    const toolName = tool === 'claude-code' ? 'Claude Code' : 'Codex';
    const command = buildCommand(tool, promptFilePath, projectDir);

    return {
      success: false,
      method: 'fallback',
      reason: `${toolName} CLI (${getToolCli(tool)}) not found in PATH`,
      command,
      prompt,
      promptFilePath,
      fallbackSuggestions: [
        `请在终端中执行: ${command}`,
        '或复制下方 Prompt 内容，在新会话中粘贴',
      ],
    };
  }

  return launchTargetTool(tool, promptFilePath, projectDir);
}
