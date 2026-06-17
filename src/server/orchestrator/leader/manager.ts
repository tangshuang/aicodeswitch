/**
 * LeaderManager —— 主 Agent 会话管理
 *
 * - 单活跃会话：一次只处理一条用户消息，避免 claude 进程并发冲突
 * - 每轮：追加 user 消息 → buildLeaderPrompt（注入记忆+历史）→ streamClaude → 回流 delta
 * - 结束后追加 assistant 消息到 conversation.jsonl
 */
import { appendConversation, clearConversation, loadConversation, writeMemoryFile, loadLeaderConfig, saveLeaderConfig, LEADER_PATHS, type LeaderConfig } from './memory';
import { buildLeaderPrompt } from './prompt';
import { isToolAvailable, streamLeader, type LeaderTool, type StreamHandle, type ToolEvent } from './runner';
import { PermissionJudge } from './permission';

export interface LeaderSink {
  text: (delta: string) => void;
  tool: (e: ToolEvent) => void;
  status?: (text: string) => void;
  done: (full: string) => void;
  error: (message: string) => void;
}

const DEFAULT_SCRATCHPAD = '# 工作记忆\n\n（Leader 的临时笔记：当前任务、TODO、待跟进项）\n';

export class LeaderManager {
  private active: { handle: StreamHandle } | null = null;
  readonly judge: PermissionJudge;

  constructor(proxyBase = 'http://127.0.0.1:4567') {
    this.judge = new PermissionJudge(proxyBase);
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

    appendConversation({ ts: Date.now(), role: 'user', content: text });
    const prompt = buildLeaderPrompt(text);
    const tools: ToolEvent[] = [];
    sink.status?.(`主 Agent（${tool === 'codex' ? 'Codex' : 'Claude Code'}）思考中…`);

    const handle = streamLeader(
      tool,
      prompt,
      { cwd: LEADER_PATHS.workspace, timeoutMs: 10 * 60 * 1000 },
      {
        onText: (delta) => sink.text(delta),
        onTool: (e) => {
          tools.push(e);
          sink.tool(e);
        },
        onDone: (full) => {
          const content = full || '(主 Agent 未返回文本)';
          appendConversation({
            ts: Date.now(),
            role: 'assistant',
            content,
            tools: tools.length > 0 ? tools : undefined,
          });
          this.active = null;
          sink.done(content);
        },
        onError: (err) => {
          appendConversation({ ts: Date.now(), role: 'assistant', content: `[错误] ${err}` });
          this.active = null;
          sink.error(err);
        },
      }
    );

    this.active = { handle };
  }

  stop(): void {
    this.active?.handle.kill();
    this.active = null;
  }

  shutdownAll(): void {
    this.stop();
  }

  getHistory() {
    return loadConversation();
  }

  reset(): void {
    this.stop();
    clearConversation();
    writeMemoryFile('scratchpad', DEFAULT_SCRATCHPAD);
  }
}
