/**
 * 流式 Claude Code / Codex 运行器
 *
 * Claude 侧由 **Claude Agent SDK**（`@anthropic-ai/claude-agent-sdk`）的 `query()` 驱动：
 * 不再手动 spawn CLI / 解析 stream-json / 写 stdin，由 SDK 管理子进程与协议，
 * 彻底规避旧实现里 server 运行时下 async stdin 导致 claude exit 1 零输出的死局。
 *
 * - onText：SDK `stream_event`（content_block_delta/text_delta）逐字增量
 * - onTool：SDK `assistant` 消息里的 tool_use/tool_result 块
 * - onSessionId：SDK `system/init` 的 session_id
 * - onCli：SDK `stderr` 回调（错误/告警通道）
 * - 权限：SDK `canUseTool` 接 PermissionJudge（替代失效的 --permission-prompt-tool）
 * - MCP：SDK `mcpServers` 内联拉起 ato-leader stdio MCP（替代写 ~/.claude.json）
 *
 * Codex 侧暂仍用 `codex exec` CLI spawn（待 Codex SDK 代理路由验证后迁移）。
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { isCliAvailable, resolveCli } from '../cli-resolver';
import { loadPermissionConfig, type PermissionJudge } from './permission';
import { resolveLeaderMcpServer } from './ato-tools';

export interface ToolEvent {
  kind: 'tool_use' | 'tool_result';
  name?: string;
  input?: unknown;
  content?: unknown;
}

/** CLI 原始输出条目（stdout/stderr 的一个片段） */
export interface CliEntry {
  s: 'stdout' | 'stderr';
  t: string;
}

export interface StreamCallbacks {
  onText: (delta: string) => void;
  onTool?: (e: ToolEvent) => void;
  onDone?: (fullText: string) => void;
  onError?: (err: string) => void;
  /** 原始 stdout/stderr 片段（前端每消息 CLI 区实时展示 + 持久化） */
  onCli?: (e: CliEntry) => void;
  /** 捕获 Claude Code 的 session_id（删除会话时用于定位其本地会话文件） */
  onSessionId?: (id: string) => void;
}

export interface StreamHandle {
  kill: () => void;
  done: Promise<string>;
}

export interface StreamOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** 权限裁决器；存在且 permission.enabled 时启用 SDK canUseTool */
  judge?: PermissionJudge;
}

/** 健康检查：claude/codex 是否可用 */
export type LeaderTool = 'claude-code' | 'codex';

/** Claude：依赖 Claude Agent SDK（自带 native binary）；SDK 可解析即视为可用 */
export function isClaudeAvailable(): boolean {
  try {
    require.resolve('@anthropic-ai/claude-agent-sdk');
    return true;
  } catch {
    return false;
  }
}

export function isCodexAvailable(): boolean {
  return isCliAvailable('codex');
}

export function isToolAvailable(tool: LeaderTool): boolean {
  return tool === 'codex' ? isCodexAvailable() : isClaudeAvailable();
}

function extractText(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('');
}

function collectTools(content: any): ToolEvent[] {
  if (!Array.isArray(content)) return [];
  const out: ToolEvent[] = [];
  for (const b of content) {
    if (!b) continue;
    if (b.type === 'tool_use') out.push({ kind: 'tool_use', name: b.name, input: b.input });
    if (b.type === 'tool_result') out.push({ kind: 'tool_result', content: b.content });
  }
  return out;
}

/** 由 SDK 驱动的 Claude Code 流式运行器 */
export function streamClaude(prompt: string, opts: StreamOptions, cb: StreamCallbacks): StreamHandle {
  const controller = new AbortController();
  let settled = false;
  let timedOut = false;
  let stopped = false; // 用户主动 stop（kill）触发，应静默结束
  let timer: NodeJS.Timeout | null = null;
  let fullText = '';
  let msgCount = 0;
  let lastMsgType = '';
  let stderrBuf = '';

  const finish = (err?: string) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    if (err) {
      cb.onError?.(err);
    } else {
      cb.onDone?.(fullText);
    }
  };

  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      try { controller.abort(); } catch { /* ignore */ }
      finish('主 Agent 运行超时');
    }, opts.timeoutMs);
  }

  // 权限：permission 开启且提供 judge 时，接 SDK canUseTool；否则 bypass 自由运行
  const cfg = loadPermissionConfig();
  const judge = opts.judge;
  const usePermission = cfg.enabled && !!judge;
  const canUseTool = usePermission
    ? async (toolName: string, input: Record<string, unknown>) => {
        try {
          const r = await judge!.evaluate({ toolName, input });
          return r.behavior === 'allow'
            ? { behavior: 'allow' as const, updatedInput: r.updatedInput }
            : { behavior: 'deny' as const, message: r.message ?? r.reason ?? '已拒绝' };
        } catch (e) {
          return { behavior: 'deny' as const, message: `权限裁决异常：${e instanceof Error ? e.message : String(e)}` };
        }
      }
    : undefined;

  const mcp = resolveLeaderMcpServer();

  const done = (async (): Promise<string> => {
    try {
      const q = query({
        prompt,
        options: {
          cwd: opts.cwd,
          abortController: controller,
          includePartialMessages: true,
          // 走 AICodeSwitch 代理：读 ~/.claude/settings.json 的 ANTHROPIC_BASE_URL
          settingSources: ['user', 'project'],
          // 只用内联 ato-leader MCP，忽略 ~/.claude.json / .mcp.json
          strictMcpConfig: true,
          mcpServers: {
            'ato-leader': { type: 'stdio', command: mcp.command, args: mcp.args, env: mcp.env },
          },
          permissionMode: usePermission ? 'default' : 'bypassPermissions',
          allowDangerouslySkipPermissions: !usePermission,
          stderr: (data: string) => { stderrBuf += data; cb.onCli?.({ s: 'stderr', t: data }); },
          ...(canUseTool ? { canUseTool } : {}),
          ...(opts.env ? { env: { ...process.env, ...opts.env } as Record<string, string> } : {}),
        },
      });

      for await (const msg of q) {
        if (timedOut || stopped) break;
        msgCount++;
        lastMsgType = msg.type + ((msg as any).subtype ? `/${(msg as any).subtype}` : '');
        try {
          if (msg.type === 'system' && msg.subtype === 'init') {
            if (msg.session_id) cb.onSessionId?.(msg.session_id);
          } else if (msg.type === 'stream_event' && msg.event) {
            const ev = msg.event;
            if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
              const delta = ev.delta.text;
              fullText += delta;
              cb.onText(delta);
            }
          } else if (msg.type === 'assistant' && msg.message) {
            const content = msg.message.content;
            for (const t of collectTools(content)) cb.onTool?.(t);
            if (!fullText) {
              const t = extractText(content);
              if (t) { fullText = t; cb.onText(t); } // 无 partial 时的快照兜底
            }
            if (msg.session_id) cb.onSessionId?.(msg.session_id);
          } else if (msg.type === 'result') {
            if (msg.subtype === 'success') {
              if (typeof msg.result === 'string' && msg.result.length > fullText.length) fullText = msg.result;
            } else if (Array.isArray(msg.errors) && msg.errors.length) {
              finish(`claude 执行出错：${msg.errors.join('; ')}`);
              return fullText;
            }
          }
        } catch (e) {
          console.error('[leader:runner] message handle error:', e instanceof Error ? e.message : e);
        }
      }
      finish();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isAbort = /abort/i.test(msg) || controller.signal.aborted;
      // 用户主动 stop：静默结束（不报错）
      if (stopped) {
        if (!settled) finish();
        return fullText;
      }
      // 超时已由 finish 处理
      if (timedOut) {
        if (!settled) finish();
        return fullText;
      }
      // 其余（含意外 abort）落详细诊断，便于定位
      const detail = `name=${e instanceof Error ? e.name : '?'} signalAborted=${controller.signal.aborted} msgs=${msgCount} last=${lastMsgType} cause=${e instanceof Error && (e as any).cause ? JSON.stringify((e as any).cause).slice(0, 300) : '(none)'} stderr=${JSON.stringify(stderrBuf.slice(0, 500))}`;
      console.error(`[leader:runner] SDK error: ${msg} | ${detail}`);
      if (e instanceof Error && e.stack) console.error(e.stack.split('\n').slice(0, 4).join('\n'));
      finish(isAbort ? `主 Agent 运行中断（${msg}）` : `claude SDK 调用失败：${msg}`);
    }
    return fullText;
  })();

  return {
    kill: () => {
      stopped = true;
      try { controller.abort(); } catch { /* ignore */ }
    },
    done,
  };
}

/** Codex 运行器：`codex exec` 读 stdin 作 prompt，stdout 为纯文本流式输出（无 stream-json/工具事件） */
export function streamCodex(prompt: string, opts: StreamOptions, cb: StreamCallbacks): StreamHandle {
  let fullText = '';
  let timedOut = false;
  let timer: NodeJS.Timeout | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let child: ChildProcess | null = null;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let firstStdoutEmitted = false;
  let firstStderrEmitted = false;

  const done = new Promise<string>((resolve) => {
    const startTime = Date.now();
    const finish = (finalText: string) => {
      if (timer) clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      console.error(`[leader:runner] [finish] elapsed=${Math.round((Date.now() - startTime) / 1000)}s stdout=${stdoutBytes}B stderr=${stderrBytes}B fullText=${finalText.length}chars`);
      cb.onDone?.(finalText);
      resolve(finalText);
    };

    const resolved = resolveCli('codex');
    const fullArgs = [...resolved.prependArgs, 'exec'];
    console.error(`[leader:runner] [spawn] cmd=${resolved.command} args=${JSON.stringify(fullArgs)} cwd=${opts.cwd || '(default)'} promptBytes=${Buffer.byteLength(prompt)}`);
    child = spawn(
      resolved.command,
      fullArgs,
      { cwd: opts.cwd, env: { ...process.env, ...opts.env } as Record<string, string>, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    );
    console.error(`[leader:runner] [spawn] pid=${child.pid ?? '(none)'}`);

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          if (child?.pid) {
            if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
            else process.kill(child.pid, 'SIGKILL');
          }
        } catch { /* ignore */ }
        console.error(`[leader:runner] [timeout] ${opts.timeoutMs}ms 超时，强制终止 pid=${child?.pid}`);
        cb.onError?.('主 Agent 运行超时');
      }, opts.timeoutMs);
    }

    // 心跳
    heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.error(`[leader:runner] [heartbeat] elapsed=${elapsed}s pid=${child?.pid ?? '(gone)'} stdout=${stdoutBytes}B stderr=${stderrBytes}B`);
    }, 5000);

    child.stdout?.on('data', (d: Buffer) => {
      stdoutBytes += d.length;
      if (!firstStdoutEmitted) {
        firstStdoutEmitted = true;
        console.error(`[leader:runner] [stdout] first byte (${d.length}B)`);
      }
      const delta = d.toString();
      fullText += delta;
      cb.onText(delta);
      // 原始 stdout 流出
      cb.onCli?.({ s: 'stdout', t: delta });
    });

    let stderrText = '';
    child.stderr?.on('data', (d: Buffer) => {
      const text = d.toString();
      stderrBytes += d.length;
      if (!firstStderrEmitted) {
        firstStderrEmitted = true;
        console.error(`[leader:runner] [stderr] first byte (${d.length}B): ${text.slice(0, 200)}`);
      }
      stderrText += text;
      // 原始 stderr 流出
      cb.onCli?.({ s: 'stderr', t: text });
    });

    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      console.error(`[leader:runner] [exit] code=${code} signal=${signal}`);
    });

    child.on('error', (err: Error) => {
      console.error(`[leader:runner] [process error] ${err.message}`);
      if (timedOut) return finish(fullText);
      cb.onError?.(`无法启动 codex 进程：${err.message}`);
      finish(fullText);
    });

    child.on('close', (code: number | null) => {
      console.error(`[leader:runner] [close] exit code: ${code} stdout=${stdoutBytes}B stderr=${stderrBytes}B stderrText="${stderrText.slice(0, 200)}"`);
      if (timedOut) return finish(fullText);
      if (!fullText && stderrText) cb.onError?.(stderrText.slice(0, 500) + (code !== null ? ` (exit code: ${code})` : ''));
      finish(fullText);
    });

    // stdin：codex exec 读 stdin 作 prompt
    const stdin = child.stdin;
    if (stdin) {
      stdin.on('error', () => { /* ignore */ });
      try {
        stdin.end(prompt);
      } catch { /* ignore */ }
    }
  });

  return {
    kill: () => {
      try {
        if (child?.pid) {
          if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
          else process.kill(child.pid, 'SIGTERM');
        }
      } catch { /* ignore */ }
    },
    done,
  };
}

/** 按主 Agent 工具类型分派到对应运行器 */
export function streamLeader(tool: LeaderTool, prompt: string, opts: StreamOptions, cb: StreamCallbacks): StreamHandle {
  return tool === 'codex' ? streamCodex(prompt, opts, cb) : streamClaude(prompt, opts, cb);
}
