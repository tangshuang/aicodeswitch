/**
 * 主 Agent（Leader）记忆、目录与会话管理
 *
 * 目录：~/.aicodeswitch/ato-leader/
 *   memory/profile.md            长期记忆（用户画像/偏好/约定）—— 所有会话共享
 *   memory/scratchpad.md         短期工作记忆（当前关注点/TODO）—— 所有会话共享
 *   memory/conversation.jsonl    遗留全局对话（仅用于首次迁移，迁移后不再使用）
 *   sessions/index.json          会话索引（SessionMeta[]，原子写）
 *   sessions/current.json        当前会话指针 { sessionId }（原子写；主服务 + mcp 进程都读）
 *   sessions/<id>/conversation.jsonl   该会话的对话历史（NDJSON）
 *   sessions/<id>/artifacts.json        该会话关联的 CLI 会话文件（claude session_id / codex rollout 路径）
 *   workspace/                  Leader 的固定 cwd（所有会话共享），内种 CLAUDE.md
 *   config.json                 leaderTool + permission 配置
 *
 * 设计：每次 Leader 运行无状态，从磁盘读取记忆重建上下文（v4 PRD）。
 *      workspace cwd 跨会话共享；仅 conversation.jsonl 按会话隔离。
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

/** 会话元信息（写入 sessions/index.json） */
export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** 创建该会话时的主 Agent 类型 */
  leaderTool: 'claude-code' | 'codex';
  messageCount: number;
}

/** 会话关联的本地 CLI 会话文件（删除会话时一并清理） */
export interface SessionArtifacts {
  /** Claude Code 的 session_id（定位 ~/.claude/projects 下对应的会话文件） */
  claudeSessionIds: string[];
  /** Codex rollout 文件绝对路径（位于 ~/.codex/sessions 目录树下） */
  codexFiles: string[];
}

const LEADER_ROOT = path.join(os.homedir(), '.aicodeswitch', 'ato-leader');
const MEMORY_DIR = path.join(LEADER_ROOT, 'memory');
const SESSIONS_DIR = path.join(LEADER_ROOT, 'sessions');
const WORKSPACE_DIR = path.join(LEADER_ROOT, 'workspace');
const CONVERSATION_FILE = path.join(MEMORY_DIR, 'conversation.jsonl');
const SESSIONS_INDEX = path.join(SESSIONS_DIR, 'index.json');
const CURRENT_SESSION = path.join(SESSIONS_DIR, 'current.json');

export const LEADER_PATHS = {
  root: LEADER_ROOT,
  memory: MEMORY_DIR,
  sessions: SESSIONS_DIR,
  workspace: WORKSPACE_DIR,
  /** 遗留全局对话文件（仅迁移用） */
  conversation: CONVERSATION_FILE,
  legacyConversation: CONVERSATION_FILE,
  sessionsIndex: SESSIONS_INDEX,
  currentSession: CURRENT_SESSION,
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

// ─── 底层 IO（原子写 + 安全读）────────────────────────────────────────

/** 原子写 JSON：先写 .tmp 再 rename，避免跨进程读到半截文件 */
function atomicWriteJSON(file: string, obj: unknown): void {
  const dir = path.dirname(file);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

/** 安全读 JSON：缺失/损坏返回 fallback */
function readJSONSafe<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

// ─── 会话目录辅助 ────────────────────────────────────────────────────

function sessionDir(id: string): string {
  return path.join(SESSIONS_DIR, id);
}
function sessionConversationPath(id: string): string {
  return path.join(sessionDir(id), 'conversation.jsonl');
}
function sessionArtifactsPath(id: string): string {
  return path.join(sessionDir(id), 'artifacts.json');
}

function genSessionId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─── 配置（leaderTool / permission）───────────────────────────────────

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

// ─── 长期记忆（共享）─────────────────────────────────────────────────

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

// ─── 会话索引 / 指针 ─────────────────────────────────────────────────

export function listSessions(): SessionMeta[] {
  const raw = readJSONSafe<unknown>(SESSIONS_INDEX, []);
  if (!Array.isArray(raw)) return [];
  const out: SessionMeta[] = [];
  for (const item of raw) {
    if (item && typeof item === 'object' && typeof (item as SessionMeta).id === 'string') {
      out.push(item as SessionMeta);
    }
  }
  return out;
}

export function getSessionMeta(id: string): SessionMeta | null {
  return listSessions().find((s) => s.id === id) || null;
}

export function saveSessionIndex(arr: SessionMeta[]): void {
  ensureLeaderDirs();
  atomicWriteJSON(SESSIONS_INDEX, arr);
}

/** 所有索引变更走它：读 → 改（副本）→ 校验为数组 → 原子写 */
export function withIndex(mutator: (arr: SessionMeta[]) => void): SessionMeta[] {
  const arr = listSessions().map((s) => ({ ...s }));
  mutator(arr);
  saveSessionIndex(arr);
  return arr;
}

export function createSession(leaderTool: 'claude-code' | 'codex', title = '新会话'): SessionMeta {
  ensureLeaderDirs();
  const id = genSessionId();
  const now = Date.now();
  const meta: SessionMeta = { id, title, createdAt: now, updatedAt: now, leaderTool, messageCount: 0 };
  fs.mkdirSync(sessionDir(id), { recursive: true });
  withIndex((arr) => arr.push(meta));
  return meta;
}

/** 读当前会话指针（纯读，不校验悬空） */
export function readCurrentSessionId(): string | null {
  const raw = readJSONSafe<{ sessionId?: string } | null>(CURRENT_SESSION, null);
  return raw?.sessionId || null;
}

export function writeCurrentSessionId(id: string | null): void {
  ensureLeaderDirs();
  if (id == null) {
    atomicWriteJSON(CURRENT_SESSION, { sessionId: null });
  } else {
    atomicWriteJSON(CURRENT_SESSION, { sessionId: id });
  }
}

/** 读指针 → 缺失/悬空则按 updatedAt 取最近会话并回写指针 → 无会话返回 null（自愈） */
export function resolveCurrentSessionId(): string | null {
  const sessions = listSessions();
  if (sessions.length === 0) return null;
  const ptr = readCurrentSessionId();
  if (ptr && sessions.some((s) => s.id === ptr)) return ptr;
  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  writeCurrentSessionId(sorted[0].id);
  return sorted[0].id;
}

/** 从首条用户消息派生会话标题（取首行、≈30 字截断） */
export function deriveTitleFromFirstMessage(text: string): string {
  const firstLine = text.trim().split('\n')[0].trim();
  if (!firstLine) return '新会话';
  const max = 30;
  if (firstLine.length <= max) return firstLine;
  return firstLine.slice(0, max) + '…';
}

// ─── 会话级对话 IO ───────────────────────────────────────────────────
// loadConversation 支持无参（读遗留全局文件，供迁移/mcp 兜底）；append/clear 必须带 sessionId。

export function loadConversation(sessionId?: string): ConversationMessage[] {
  ensureLeaderDirs();
  const file = sessionId ? sessionConversationPath(sessionId) : CONVERSATION_FILE;
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
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

export function appendConversation(sessionId: string, msg: ConversationMessage): void {
  ensureLeaderDirs();
  fs.mkdirSync(sessionDir(sessionId), { recursive: true });
  fs.appendFileSync(sessionConversationPath(sessionId), JSON.stringify(msg) + '\n', 'utf-8');
}

export function clearConversation(sessionId: string): void {
  ensureLeaderDirs();
  fs.mkdirSync(sessionDir(sessionId), { recursive: true });
  fs.writeFileSync(sessionConversationPath(sessionId), '', 'utf-8');
}

// ─── 会话 artifacts（关联的 CLI 会话文件）─────────────────────────────

export function loadArtifacts(sessionId: string): SessionArtifacts {
  return readJSONSafe<SessionArtifacts>(sessionArtifactsPath(sessionId), { claudeSessionIds: [], codexFiles: [] });
}

export function saveArtifacts(sessionId: string, a: SessionArtifacts): void {
  ensureLeaderDirs();
  fs.mkdirSync(sessionDir(sessionId), { recursive: true });
  atomicWriteJSON(sessionArtifactsPath(sessionId), a);
}

/** 合并去重地追加 claude session_id 或 codex 文件路径 */
export function appendArtifact(
  sessionId: string,
  patch: { claudeId?: string; codexFiles?: string[] }
): void {
  const a = loadArtifacts(sessionId);
  if (patch.claudeId && !a.claudeSessionIds.includes(patch.claudeId)) {
    a.claudeSessionIds.push(patch.claudeId);
  }
  if (patch.codexFiles) {
    for (const f of patch.codexFiles) {
      if (!a.codexFiles.includes(f)) a.codexFiles.push(f);
    }
  }
  saveArtifacts(sessionId, a);
}

/** 删除会话数据目录（conversation.jsonl + artifacts.json） */
export function deleteSessionData(id: string): void {
  try {
    fs.rmSync(sessionDir(id), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
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

// ─── 遗留迁移 ────────────────────────────────────────────────────────

/**
 * 幂等迁移：sessions/index.json 已存在则直接返回（已初始化/已迁移）；
 * 否则若遗留 memory/conversation.jsonl 非空，迁入一个「迁移的会话」并设为当前；
 * 否则初始化空索引（current=null，首条消息时懒创建）。
 * 仅在主服务进程调用（mcp-server 不迁移）。
 */
export function migrateLegacyConversationIfNeeded(): void {
  ensureLeaderDirs();
  if (fs.existsSync(SESSIONS_INDEX)) return; // 已初始化
  if (fs.existsSync(CONVERSATION_FILE)) {
    const raw = fs.readFileSync(CONVERSATION_FILE, 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length > 0) {
      // 解析首尾消息的时间戳用于 createdAt/updatedAt
      let firstTs = 0;
      let lastTs = 0;
      for (const line of lines) {
        try {
          const m = JSON.parse(line) as ConversationMessage;
          if (typeof m.ts === 'number') {
            if (!firstTs) firstTs = m.ts;
            lastTs = m.ts;
          }
        } catch {
          /* skip */
        }
      }
      const now = Date.now();
      const meta = createSession(loadLeaderConfig().leaderTool, '迁移的会话');
      // 复制原对话内容到会话文件
      fs.mkdirSync(sessionDir(meta.id), { recursive: true });
      fs.writeFileSync(sessionConversationPath(meta.id), lines.join('\n') + '\n', 'utf-8');
      meta.messageCount = lines.length;
      meta.createdAt = firstTs || now;
      meta.updatedAt = lastTs || now;
      withIndex((arr) => {
        const idx = arr.findIndex((s) => s.id === meta.id);
        if (idx >= 0) arr[idx] = meta;
      });
      writeCurrentSessionId(meta.id);
      return;
    }
  }
  // 无遗留数据：初始化空索引，current=null
  saveSessionIndex([]);
}
