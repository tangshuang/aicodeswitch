/**
 * LeaderManager —— 主 Agent 会话管理
 *
 * - 多会话：sessions/<id>/ 下隔离对话历史；profile/scratchpad 跨会话共享
 * - 单活跃流：一次只处理一条用户消息，避免 claude 进程并发冲突
 * - 每轮：追加 user 消息 → buildLeaderPrompt（注入记忆+该会话历史）→ streamLeader → 回流 delta
 * - 结束后追加 assistant 消息，并记录该轮关联的 CLI 会话文件（claude session_id / codex rollout）
 * - 删除会话时一并清理关联的 Claude/Codex 本地会话文件
 */
import {
  appendConversation, clearConversation, loadConversation,
  listSessions as readSessionIndex, getSessionMeta, withIndex,
  createSession as createSessionRecord, resolveCurrentSessionId, writeCurrentSessionId,
  loadArtifacts, saveArtifacts, appendArtifact, deleteSessionData,
  deriveTitleFromFirstMessage, migrateLegacyConversationIfNeeded,
  loadLeaderConfig, saveLeaderConfig, LEADER_PATHS, type LeaderConfig, type SessionMeta,
  capCli, type LeaderCliEntry,
} from './memory';
import { buildLeaderPrompt } from './prompt';
import { isToolAvailable, streamLeader, type LeaderTool, type StreamHandle, type ToolEvent, type CliEntry } from './runner';
import { PermissionJudge } from './permission';
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface LeaderSink {
  text: (delta: string) => void;
  tool: (e: ToolEvent) => void;
  status?: (text: string) => void;
  done: (full: string) => void;
  error: (message: string) => void;
  /** 原始 CLI stdout/stderr 片段（前端每消息 CLI 区实时展示） */
  cli?: (e: CliEntry) => void;
}

/** 递归收集目录下所有 .jsonl 绝对路径 */
function listJsonlFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const full = path.join(dir, name);
    let stat: fs.Stats;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      out.push(...listJsonlFiles(full));
    } else if (name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
}

/** 快照 ~/.codex/sessions 下所有 .jsonl（codex 每轮差分用） */
function snapshotCodexSessionFiles(): string[] {
  return listJsonlFiles(path.join(os.homedir(), '.codex', 'sessions'));
}

/** 删除指定 Claude session_id 在 ~/.claude/projects 各子目录下对应的 jsonl，返回删除数 */
function deleteClaudeSessionFile(sessionId: string): number {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  let dirs: string[];
  try { dirs = fs.readdirSync(projectsDir); } catch { return 0; }
  let removed = 0;
  for (const d of dirs) {
    const full = path.join(projectsDir, d, `${sessionId}.jsonl`);
    try { fs.unlinkSync(full); removed++; } catch { /* ignore missing */ }
  }
  return removed;
}

export class LeaderManager {
  private active: { handle: StreamHandle } | null = null;
  private currentSessionId: string | null = null;
  /** 当前正在流式的会话 id（用于删除时阻止删到正在处理的会话） */
  private activeTurnSessionId: string | null = null;
  readonly judge: PermissionJudge;

  constructor(proxyBase = 'http://127.0.0.1:4567') {
    this.judge = new PermissionJudge(proxyBase);
    // 初始化：迁移遗留对话 → 解析当前会话指针
    try {
      migrateLegacyConversationIfNeeded();
      this.currentSessionId = resolveCurrentSessionId();
    } catch (e) {
      console.error('[leader:manager] init sessions failed:', e);
    }
  }

  isBusy(): boolean {
    return this.active !== null;
  }

  isAvailable(): boolean {
    return isToolAvailable(this.getLeaderTool());
  }

  getLeaderTool(): LeaderTool {
    return loadLeaderConfig().leaderTool;
  }

  setLeaderTool(tool: LeaderTool): LeaderConfig {
    const config: LeaderConfig = { leaderTool: tool };
    saveLeaderConfig(config);
    return config;
  }

  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  /** 列出所有会话（按 updatedAt 倒序） */
  getSessions(): SessionMeta[] {
    return readSessionIndex().slice().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 新建会话并设为当前 */
  createSessionAndActivate(): SessionMeta {
    const meta = createSessionRecord(this.getLeaderTool());
    this.currentSessionId = meta.id;
    writeCurrentSessionId(meta.id);
    return meta;
  }

  /** 切换当前会话；返回是否成功（会话存在） */
  activateSession(id: string): boolean {
    if (!getSessionMeta(id)) return false;
    this.currentSessionId = id;
    writeCurrentSessionId(id);
    return true;
  }

  /** 重命名会话 */
  renameSession(id: string, title: string): SessionMeta | null {
    let result: SessionMeta | null = null;
    withIndex((arr) => {
      const idx = arr.findIndex((s) => s.id === id);
      if (idx >= 0) {
        arr[idx].title = title || '未命名会话';
        result = arr[idx];
      }
    });
    return result;
  }

  /**
   * 删除会话：清理关联的 Claude/Codex 本地会话文件 + 会话数据 + 索引；
   * 若删的是当前会话，自动切到最近剩余会话或空态。
   * 流式中删除当前会话会被拒绝。
   */
  deleteSession(id: string): { deleted: string; switchedTo: string | null; filesRemoved: number } | { error: string } {
    if (this.isBusy() && this.activeTurnSessionId === id) {
      return { error: '该会话正在处理消息，无法删除' };
    }
    if (!getSessionMeta(id)) {
      return { error: '会话不存在' };
    }
    // 1) 清理关联的 CLI 会话文件（best-effort）
    const artifacts = loadArtifacts(id);
    let filesRemoved = 0;
    for (const cid of artifacts.claudeSessionIds) {
      filesRemoved += deleteClaudeSessionFile(cid);
    }
    for (const f of artifacts.codexFiles) {
      try { fs.unlinkSync(f); filesRemoved++; } catch { /* ignore */ }
    }
    // 2) 删除会话数据目录
    deleteSessionData(id);
    // 3) 从索引移除
    withIndex((arr) => {
      const idx = arr.findIndex((s) => s.id === id);
      if (idx >= 0) arr.splice(idx, 1);
    });
    // 4) 若删的是当前会话，切到最近剩余或空态
    if (this.currentSessionId === id) {
      this.currentSessionId = resolveCurrentSessionId();
    }
    return { deleted: id, switchedTo: this.currentSessionId, filesRemoved };
  }

  sendMessage(text: string, sink: LeaderSink): void {
    if (this.active) {
      sink.error('主 Agent 正在处理上一条消息，请稍候再发送。');
      return;
    }
    const tool = this.getLeaderTool();
    if (!isToolAvailable(tool)) {
      const name = tool === 'codex' ? 'codex' : 'claude';
      sink.error(`未检测到 ${name} CLI，无法启动主 Agent。请先安装对应工具，或切换主 Agent。`);
      return;
    }

    // 懒创建：无当前会话则建一个
    if (this.currentSessionId == null) {
      this.createSessionAndActivate();
    }
    // 本轮会话 id：所有闭包内只用它，绝不读 this.currentSessionId（防删除/切换竞态）
    const turnSessionId = this.currentSessionId as string;
    const isFirstMessage = (getSessionMeta(turnSessionId)?.messageCount ?? 0) === 0;
    this.activeTurnSessionId = turnSessionId;

    appendConversation(turnSessionId, { ts: Date.now(), role: 'user', content: text });
    const prompt = buildLeaderPrompt(text, loadConversation(turnSessionId));
    const tools: ToolEvent[] = [];
    const cliEntries: LeaderCliEntry[] = [];
    let capturedClaudeId: string | null = null;
    const codexBefore = tool === 'codex' ? snapshotCodexSessionFiles() : null;
    sink.status?.(`主 Agent（${tool === 'codex' ? 'Codex' : 'Claude Code'}）思考中…`);

    const persistArtifacts = () => {
      // Claude：记录 session_id（用于精确删除 ~/.claude/projects/*/<id>.jsonl）
      if (tool !== 'codex' && capturedClaudeId) {
        try { appendArtifact(turnSessionId, { claudeId: capturedClaudeId }); } catch { /* ignore */ }
      }
      // Codex：差分新增的 rollout 文件（延迟 500ms 规避 close 后惰性落盘）
      if (tool === 'codex' && codexBefore) {
        setTimeout(() => {
          try {
            const after = snapshotCodexSessionFiles();
            const diff = after.filter((p) => !codexBefore.includes(p));
            if (diff.length) appendArtifact(turnSessionId, { codexFiles: diff });
          } catch { /* ignore */ }
        }, 500);
      }
    };

    const finalizeTurn = () => {
      withIndex((arr) => {
        const idx = arr.findIndex((s) => s.id === turnSessionId);
        if (idx < 0) return;
        arr[idx].updatedAt = Date.now();
        arr[idx].messageCount += 2; // user + assistant
        if (isFirstMessage) arr[idx].title = deriveTitleFromFirstMessage(text);
      });
    };

    const handle = streamLeader(
      tool,
      prompt,
      { cwd: LEADER_PATHS.workspace, timeoutMs: 10 * 60 * 1000, judge: this.judge },
      {
        onText: (delta) => sink.text(delta),
        onTool: (e) => {
          tools.push(e);
          sink.tool(e);
        },
        onSessionId: (id) => { capturedClaudeId = id; },
        onCli: (entry) => {
          cliEntries.push(entry);
          sink.cli?.(entry);
        },
        onDone: (full) => {
          const content = full || '(主 Agent 未返回文本)';
          appendConversation(turnSessionId, {
            ts: Date.now(),
            role: 'assistant',
            content,
            tools: tools.length > 0 ? tools : undefined,
            leaderTool: tool,
            cli: capCli(cliEntries),
          });
          finalizeTurn();
          persistArtifacts();
          this.active = null;
          this.activeTurnSessionId = null;
          sink.done(content);
        },
        onError: (err) => {
          console.warn('[leader:manager] [runner error] ' + err);
          appendConversation(turnSessionId, {
            ts: Date.now(),
            role: 'assistant',
            content: `[错误] ${err}`,
            leaderTool: tool,
            cli: capCli(cliEntries),
          });
          finalizeTurn();
          persistArtifacts(); // 早错但可能已写 session 文件，仍记录
          this.active = null;
          this.activeTurnSessionId = null;
          sink.error(err);
        },
      }
    );

    this.active = { handle };
  }

  stop(): void {
    this.active?.handle.kill();
    this.active = null;
    this.activeTurnSessionId = null;
  }

  shutdownAll(): void {
    this.stop();
  }

  getHistory() {
    return this.currentSessionId ? loadConversation(this.currentSessionId) : [];
  }

  /** 清空当前会话消息 + artifacts（不碰共享 scratchpad；不删除会话本身） */
  reset(): void {
    this.stop();
    const id = this.currentSessionId;
    if (!id) return;
    clearConversation(id);
    try { saveArtifacts(id, { claudeSessionIds: [], codexFiles: [] }); } catch { /* ignore */ }
    withIndex((arr) => {
      const idx = arr.findIndex((s) => s.id === id);
      if (idx >= 0) {
        arr[idx].messageCount = 0;
        arr[idx].updatedAt = Date.now();
      }
    });
  }
}
