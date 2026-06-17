/**
 * 主 Agent（Leader）记忆与目录管理
 *
 * 目录：~/.aicodeswitch/ato-leader/
 *   memory/conversation.jsonl  完整对话历史（NDJSON，重建上下文用）
 *   memory/profile.md          长期记忆（用户画像/偏好/约定）
 *   memory/scratchpad.md       短期工作记忆（当前关注点/TODO）
 *   sessions/<id>/             每个会话的事件归档
 *   teams-index.json           Leader 维护的团队索引缓存
 *
 * 设计：每次 Leader 运行无状态，从磁盘读取记忆重建上下文（v4 PRD）。
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

export interface ConversationMessage {
  ts: number;
  role: 'user' | 'assistant';
  content: string;
  /** 本条 assistant 消息触发的工具调用（可选） */
  tools?: Array<{ kind?: string; name?: string; input?: unknown; content?: unknown; result?: unknown }>;
}

const LEADER_ROOT = path.join(os.homedir(), '.aicodeswitch', 'ato-leader');
const MEMORY_DIR = path.join(LEADER_ROOT, 'memory');
const SESSIONS_DIR = path.join(LEADER_ROOT, 'sessions');
const WORKSPACE_DIR = path.join(LEADER_ROOT, 'workspace');
const CONVERSATION_FILE = path.join(MEMORY_DIR, 'conversation.jsonl');

export const LEADER_PATHS = {
  root: LEADER_ROOT,
  memory: MEMORY_DIR,
  sessions: SESSIONS_DIR,
  workspace: WORKSPACE_DIR,
  conversation: CONVERSATION_FILE,
  profile: path.join(MEMORY_DIR, 'profile.md'),
  scratchpad: path.join(MEMORY_DIR, 'scratchpad.md'),
  teamsIndex: path.join(LEADER_ROOT, 'teams-index.json'),
  config: path.join(LEADER_ROOT, 'config.json'),
};

export interface LeaderConfig {
  /** 主 Agent 由谁扮演：claude-code | codex */
  leaderTool: 'claude-code' | 'codex';
  /** 权限裁决配置（PermissionJudge 读写） */
  permission?: any;
}

export function loadLeaderConfig(): LeaderConfig {
  ensureLeaderDirs();
  try {
    if (fs.existsSync(LEADER_PATHS.config)) {
      const raw = JSON.parse(fs.readFileSync(LEADER_PATHS.config, 'utf-8'));
      if (raw.leaderTool === 'codex' || raw.leaderTool === 'claude-code') {
        return { leaderTool: raw.leaderTool, permission: raw.permission };
      }
    }
  } catch {
    /* ignore */
  }
  return { leaderTool: 'claude-code' };
}

export function saveLeaderConfig(config: LeaderConfig): void {
  ensureLeaderDirs();
  fs.writeFileSync(LEADER_PATHS.config, JSON.stringify(config, null, 2), 'utf-8');
}

export function ensureLeaderDirs(): void {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  if (!fs.existsSync(LEADER_PATHS.profile)) {
    fs.writeFileSync(LEADER_PATHS.profile, '# 用户画像\n\n（Leader 会在对话中逐步补充你的偏好与约定）\n', 'utf-8');
  }
  if (!fs.existsSync(LEADER_PATHS.scratchpad)) {
    fs.writeFileSync(LEADER_PATHS.scratchpad, '# 工作记忆\n\n（Leader 的临时笔记：当前任务、TODO、待跟进项）\n', 'utf-8');
  }
  // 在 leader 家目录种入一份 CLAUDE.md，让 claude 进程启动时自带角色上下文
  const claudeMdPath = path.join(WORKSPACE_DIR, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) {
    fs.writeFileSync(
      claudeMdPath,
      [
        '# AICodeSwitch 主 Agent（Leader）的家',
        '',
        '这是你作为 AICodeSwitch 主 Agent 的固定工作目录。你可以在这里：',
        '- 用 `notes.md` / `plans/` 等保存自己的长期记忆与计划',
        '- 管理 skills、脚本、模板等任意辅助文件',
        '- 通过 ato_* / memory_* MCP 工具管理 ATO 团队任务与系统记忆',
        '',
        '> 注意：你的对话历史与系统记忆（profile.md / scratchpad.md）保存在上一级 `memory/` 目录，由系统维护，请勿手动改动。',
        '',
      ].join('\n'),
      'utf-8'
    );
  }
}

export function loadConversation(): ConversationMessage[] {
  ensureLeaderDirs();
  if (!fs.existsSync(CONVERSATION_FILE)) return [];
  const lines = fs.readFileSync(CONVERSATION_FILE, 'utf-8').split('\n').filter(Boolean);
  const out: ConversationMessage[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as ConversationMessage);
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}

export function appendConversation(msg: ConversationMessage): void {
  ensureLeaderDirs();
  fs.appendFileSync(CONVERSATION_FILE, JSON.stringify(msg) + '\n', 'utf-8');
}

export function clearConversation(): void {
  ensureLeaderDirs();
  fs.writeFileSync(CONVERSATION_FILE, '', 'utf-8');
}

export function readMemoryFile(name: 'profile' | 'scratchpad'): string {
  ensureLeaderDirs();
  const p = name === 'profile' ? LEADER_PATHS.profile : LEADER_PATHS.scratchpad;
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
}

export function writeMemoryFile(name: 'profile' | 'scratchpad', content: string): void {
  ensureLeaderDirs();
  const p = name === 'profile' ? LEADER_PATHS.profile : LEADER_PATHS.scratchpad;
  fs.writeFileSync(p, content, 'utf-8');
}

/** 重建最近 N 轮对话为 transcript 文本（注入 prompt） */
export function buildTranscript(messages: ConversationMessage[], recent = 20): string {
  const slice = messages.slice(-recent * 2);
  return slice
    .map((m) => {
      const role = m.role === 'user' ? '用户' : '主Agent';
      return `【${role}】${m.content}`;
    })
    .join('\n\n');
}
