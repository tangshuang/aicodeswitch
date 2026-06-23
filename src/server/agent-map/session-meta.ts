/**
 * 会话元信息解析器：从本机 Claude Code / Codex 的会话存储里
 * 读取每个会话的「项目路径（cwd）」与「原始标题」。
 *
 * 仅适用于「非 AccessKey」场景——只有当 Claude Code / Codex 运行在本机
 * （代理写本地配置、工具在本地落会话文件）时，磁盘文件才在本机可读。
 * AccessKey 流量来自远端客户端，其会话文件不在本机，无法解析。
 *
 * 数据来源（调研自本机真实文件）：
 * - Claude Code：~/.claude/projects 下每个项目目录的 sessions-index.json（含 projectPath/summary）；
 *   回退：在 projects 各目录下找 sessionId.jsonl，读行内 cwd 与 type=ai-title 的 aiTitle。
 * - Codex：~/.codex/sessions（按年月日嵌套）与 archived_sessions 下匹配 sessionId 的 rollout-*.jsonl，
 *   读首行 session_meta.payload.cwd；标题优先 session_index.jsonl 的 thread_name，回退首条用户消息。
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { ToolType } from '../../types';

export interface SessionMeta {
  projectPath?: string;
  title?: string;
}

// 解析结果缓存（含空结果，避免重复扫盘）
const cache = new Map<string, SessionMeta>();

// ─── Claude Code 索引（sessions-index.json） ───
interface ClaudeEntry { projectPath?: string; originalPath?: string; fullPath?: string; summary?: string; firstPrompt?: string; title?: string; }
let claudeIndex: Map<string, ClaudeEntry> | null = null;

function getClaudeIndex(): Map<string, ClaudeEntry> {
  if (claudeIndex) return claudeIndex;
  const map = new Map<string, ClaudeEntry>();
  const root = join(homedir(), '.claude', 'projects');
  let dirs: string[] = [];
  try { dirs = readdirSync(root); } catch { claudeIndex = map; return map; }
  for (const d of dirs) {
    const idxFile = join(root, d, 'sessions-index.json');
    if (!existsSync(idxFile)) continue;
    try {
      const data = JSON.parse(readFileSync(idxFile, 'utf-8'));
      const dirOriginal: string | undefined = data?.originalPath;
      const entries: any[] = Array.isArray(data) ? data : (data?.sessions || data?.entries || []);
      for (const e of entries) {
        if (e && e.sessionId) {
          map.set(e.sessionId, {
            projectPath: e.projectPath || e.originalPath || dirOriginal,
            originalPath: e.originalPath || dirOriginal,
            fullPath: e.fullPath,
            summary: e.summary,
            firstPrompt: e.firstPrompt,
            title: e.title,
          });
        }
      }
    } catch { /* skip unreadable index */ }
  }
  claudeIndex = map;
  return map;
}

function parseClaudeJsonl(file: string): SessionMeta {
  let projectPath: string | undefined;
  let title: string | undefined;
  try {
    const lines = readFileSync(file, 'utf-8').split('\n');
    for (let i = 0; i < Math.min(lines.length, 120); i++) {
      const line = lines[i];
      if (!line || !line.trim()) continue;
      let obj: any;
      try { obj = JSON.parse(line); } catch { continue; }
      if (!projectPath && obj.cwd) projectPath = obj.cwd;
      if (!title && obj.type === 'ai-title' && obj.aiTitle) title = obj.aiTitle;
      if (projectPath && title) break;
    }
  } catch { /* ignore */ }
  return { projectPath, title };
}

/** 清洗作为标题用的 prompt 文本：剥掉开头的 <tag>...</tag> 注入块 */
function cleanPromptTitle(s?: string): string | undefined {
  if (!s) return undefined;
  let t = s.trim();
  t = t.replace(/^<[^>]+>[\s\S]*?<\/[^>]+>\s*/, '').trim();
  return t || undefined;
}

function findClaudeJsonl(sessionId: string): string | null {
  const root = join(homedir(), '.claude', 'projects');
  let dirs: string[] = [];
  try { dirs = readdirSync(root); } catch { return null; }
  for (const d of dirs) {
    const f = join(root, d, sessionId + '.jsonl');
    if (existsSync(f)) return f;
  }
  return null;
}

function resolveClaude(sessionId: string): SessionMeta {
  const entry = getClaudeIndex().get(sessionId);
  let projectPath = entry?.projectPath || entry?.originalPath;
  let title: string | undefined;
  // 标题优先取 .jsonl 里的 ai-title（最标准）；项目路径也可从行内 cwd 兜底
  const jsonl = entry?.fullPath && existsSync(entry.fullPath) ? entry.fullPath : findClaudeJsonl(sessionId);
  if (jsonl) {
    const m = parseClaudeJsonl(jsonl);
    if (m.title) title = m.title;
    if (!projectPath && m.projectPath) projectPath = m.projectPath;
  }
  // 回退标题：index 的 summary / firstPrompt（清洗掉注入标签）
  if (!title) title = cleanPromptTitle(entry?.summary) || cleanPromptTitle(entry?.firstPrompt);
  return { projectPath, title };
}

// ─── Codex 文件索引（sessionId → 文件路径，一次构建） ───
const UUID_RE = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
let codexFileIndex: Map<string, string> | null = null;

function getCodexFileIndex(): Map<string, string> {
  if (codexFileIndex) return codexFileIndex;
  const map = new Map<string, string>();
  const bases = [
    join(homedir(), '.codex', 'sessions'),
    join(homedir(), '.codex', 'archived_sessions'),
  ];
  for (const base of bases) walkIndex(base, map);
  codexFileIndex = map;
  return map;
}

function walkIndex(dir: string, map: Map<string, string>) {
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const p = join(dir, name);
    let st: { isDirectory: () => boolean };
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      walkIndex(p, map);
    } else if (name.endsWith('.jsonl')) {
      const m = name.match(UUID_RE);
      if (m) map.set(m[1], p);
    }
  }
}

let codexThreadIndex: Map<string, string> | null = null;
function getCodexThreadIndex(): Map<string, string> {
  if (codexThreadIndex) return codexThreadIndex;
  const map = new Map<string, string>();
  try {
    const f = join(homedir(), '.codex', 'session_index.jsonl');
    if (existsSync(f)) {
      const lines = readFileSync(f, 'utf-8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line);
          if (o && o.id && o.thread_name) map.set(o.id, o.thread_name);
        } catch { /* skip */ }
      }
    }
  } catch { /* ignore */ }
  codexThreadIndex = map;
  return map;
}

function stripEnvContext(text: string): string {
  return text
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '')
    .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '') // 剥掉其它注入标签包裹的占位
    .trim();
}

function extractCodexUserText(content: any): string | undefined {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    for (const c of content) {
      if (typeof c === 'string') text += c;
      else if (c && typeof c.text === 'string') text += c.text;
    }
  }
  const cleaned = stripEnvContext(text);
  return cleaned || undefined;
}

function parseCodexSessionFile(file: string): SessionMeta {
  let projectPath: string | undefined;
  let title: string | undefined;
  try {
    const lines = readFileSync(file, 'utf-8').split('\n');
    for (let i = 0; i < Math.min(lines.length, 60); i++) {
      const line = lines[i];
      if (!line || !line.trim()) continue;
      let obj: any;
      try { obj = JSON.parse(line); } catch { continue; }
      if (!projectPath && obj.type === 'session_meta' && obj.payload?.cwd) {
        projectPath = obj.payload.cwd;
      }
      if (!title && obj.type === 'response_item' && obj.payload?.type === 'message' && obj.payload?.role === 'user') {
        title = extractCodexUserText(obj.payload.content);
      }
      if (projectPath && title) break;
    }
  } catch { /* ignore */ }
  return { projectPath, title };
}

function resolveCodex(sessionId: string): SessionMeta {
  const file = getCodexFileIndex().get(sessionId);
  let projectPath: string | undefined;
  let title: string | undefined;
  if (file) {
    const m = parseCodexSessionFile(file);
    projectPath = m.projectPath;
    title = m.title;
  }
  // 标题优先用 session_index.jsonl 的 thread_name（更标准），缺失再用首条消息
  const threadName = getCodexThreadIndex().get(sessionId);
  if (threadName) title = threadName;
  return { projectPath, title };
}

/**
 * 解析会话的项目路径与原始标题。结果会被缓存。
 * 注意：调用方需自行判断是否为 AccessKey 来源——AccessKey 会话不在本机，不应调用。
 */
export async function resolveSessionMeta(sessionId: string, agent: ToolType): Promise<SessionMeta> {
  const cached = cache.get(sessionId);
  if (cached) return cached;
  let meta: SessionMeta = {};
  try {
    meta = agent === 'codex' ? resolveCodex(sessionId) : resolveClaude(sessionId);
  } catch { /* ignore */ }
  cache.set(sessionId, meta);
  return meta;
}

/** 清理缓存（供测试 / 配置变更后重建） */
export function clearSessionMetaCache(): void {
  cache.clear();
  claudeIndex = null;
  codexFileIndex = null;
  codexThreadIndex = null;
}
