/**
 * ATO/Memory MCP Server（stdio JSON-RPC）
 *
 * 由 Claude Code 经 ~/.claude.json 的 mcpServers['ato-leader'] 条目 spawn。
 * 把 ATO 管理操作经 HTTP 转发到本机 /api/orchestrator/*，记忆操作读写本地文件。
 *
 * 环境变量：
 *   ATO_PORT  代理服务端口（默认 4567）
 *   ATO_BASE  可选，完整 base（如 http://127.0.0.1:4567）
 *   ATO_TOKEN 可选，管理面鉴权 token（Access-Token header）
 *
 * 仅作为独立进程入口运行（node dist/server/orchestrator/leader/mcp-server.js），
 * 不被其它模块 import。
 */
import readline from 'readline';
import { loadConversation, readCurrentSessionId, readMemoryFile, writeMemoryFile } from './memory';

const BASE = process.env.ATO_BASE || `http://127.0.0.1:${process.env.ATO_PORT || '4567'}`;
const TOKEN = process.env.ATO_TOKEN || '';

async function httpCall(method: string, p: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (TOKEN) headers['Access-Token'] = TOKEN;
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${typeof json === 'string' ? json : JSON.stringify(json)}`);
  }
  return json;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: any) => Promise<unknown> | unknown;
}

const TOOLS: ToolDef[] = [
  {
    name: 'ato_list_routes',
    description: '列出所有可用的 AICodeSwitch 路由，用于为团队选择 routeId。',
    inputSchema: { type: 'object', properties: {} },
    run: () => httpCall('GET', '/api/orchestrator/routes'),
  },
  {
    name: 'ato_list_teams',
    description: '列出所有 ATO 团队及其当前状态。',
    inputSchema: { type: 'object', properties: {} },
    run: () => httpCall('GET', '/api/orchestrator/teams'),
  },
  {
    name: 'ato_get_team',
    description: '获取指定团队的详细状态（任务、进度、待处理问题、日志摘要）。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: (a) => httpCall('GET', `/api/orchestrator/teams/${a.id}`),
  },
  {
    name: 'ato_create_team',
    description:
      '创建并启动一个 ATO 团队。prompt 为整体任务描述；可选 tasks 显式拆解子任务（含 id/description/dependencies/verificationScript/routeId/agentTool）；可选 routeId 绑定路由、verificationScript 默认验证脚本、defaultAgent(claude-code|codex)、workspacePath、teamAccessKey。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        defaultAgent: { type: 'string' },
        routeId: { type: 'string' },
        workspacePath: { type: 'string' },
        verificationScript: { type: 'string' },
        teamAccessKey: { type: 'string' },
        tasks: { type: 'array' },
      },
      required: ['prompt'],
    },
    run: (a) => httpCall('POST', '/api/orchestrator/teams', a),
  },
  {
    name: 'ato_stop_team',
    description: '停止指定团队。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: (a) => httpCall('POST', `/api/orchestrator/teams/${a.id}/stop`),
  },
  {
    name: 'ato_answer_question',
    description: '回答子 Agent 上抛给团队的问题（questionId 可从 ato_get_team 的 pendingQuestions 取得）。',
    inputSchema: {
      type: 'object',
      properties: { teamId: { type: 'string' }, questionId: { type: 'string' }, choice: { type: 'string' } },
      required: ['teamId', 'questionId', 'choice'],
    },
    run: (a) => httpCall('POST', `/api/orchestrator/teams/${a.teamId}/questions/${a.questionId}/answer`, { choice: a.choice }),
  },
  {
    name: 'ato_check_adapters',
    description: '检查各 CLI Agent 工具（claude-code/codex）是否可用。',
    inputSchema: { type: 'object', properties: {} },
    run: () => httpCall('GET', '/api/orchestrator/adapters/check'),
  },
  {
    // Claude Code 经 --permission-prompt-tool 调用此工具做权限裁决。
    // 入参字段名以实测为准，这里做容错：tool_name|toolName|name，input|arguments。
    name: 'permission_request',
    description: '权限裁决：判断是否允许执行某个工具调用。',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string' },
        toolName: { type: 'string' },
        name: { type: 'string' },
        input: { type: 'object' },
        arguments: { type: 'object' },
      },
    },
    run: async (a) => {
      const toolName = String(a.tool_name || a.toolName || a.name || 'Unknown');
      const input = a.input ?? a.arguments ?? {};
      // 用带显式长超时的 fetch（服务端可能等人类确认），避免 undici 默认超时
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (TOKEN) headers['Access-Token'] = TOKEN;
      const res = await fetch(`${BASE}/api/orchestrator/leader/permission`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ tool_name: toolName, input }),
        signal: AbortSignal.timeout(5 * 60 * 1000),
      });
      const txt = await res.text();
      let json: any = null;
      try { json = txt ? JSON.parse(txt) : null; } catch { json = { behavior: 'deny', message: txt }; }
      if (!res.ok && !json?.behavior) throw new Error(`HTTP ${res.status}: ${txt}`);
      return json || { behavior: 'deny', message: '权限裁决返回为空' };
    },
  },
  {
    name: 'memory_read',
    description: '读取长期记忆文件：profile（用户画像/偏好）或 scratchpad（工作记忆/TODO）。',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', enum: ['profile', 'scratchpad'] } },
      required: ['name'],
    },
    run: (a) => ({ content: readMemoryFile(a.name as 'profile' | 'scratchpad') }),
  },
  {
    name: 'memory_write',
    description: '覆盖写入长期记忆文件（profile 或 scratchpad）。请先 read 再整体写回，避免丢失内容。',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', enum: ['profile', 'scratchpad'] }, content: { type: 'string' } },
      required: ['name', 'content'],
    },
    run: (a) => {
      writeMemoryFile(a.name as 'profile' | 'scratchpad', String(a.content));
      return { ok: true };
    },
  },
  {
    name: 'conversation_recent',
    description: '返回最近 N 条对话（默认 12），用于回顾上下文。',
    inputSchema: { type: 'object', properties: { n: { type: 'number' } } },
    run: (a) => {
      const n = typeof a.n === 'number' ? a.n : 12;
      // 读当前会话指针；缺失则回落到遗留全局对话文件
      const id = readCurrentSessionId();
      const msgs = id ? loadConversation(id) : loadConversation();
      return msgs.slice(-n);
    },
  },
];

function result(id: unknown, content: unknown): void {
  if (id === undefined || id === null) return; // notification，无需响应
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: content }) + '\n');
}

function error(id: unknown, code: number, message: string): void {
  if (id === undefined || id === null) return;
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

async function handle(req: any): Promise<void> {
  const { id, method, params } = req;
  try {
    if (method === 'initialize') {
      result(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'ato-leader', version: '1.0.0' },
      });
    } else if (method === 'notifications/initialized') {
      /* no-op */
    } else if (method === 'tools/list') {
      result(id, {
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
    } else if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments || {};
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        error(id, -32601, `未知工具: ${name}`);
        return;
      }
      try {
        const out = await tool.run(args);
        result(id, { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out) }] });
      } catch (e) {
        result(id, { content: [{ type: 'text', text: `工具执行失败: ${e instanceof Error ? e.message : String(e)}` }], isError: true });
      }
    } else {
      error(id, -32601, `未实现的方法: ${method}`);
    }
  } catch (e) {
    error(id, -32603, e instanceof Error ? e.message : String(e));
  }
}

export function runMcpServer(): void {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: any;
    try {
      req = JSON.parse(trimmed);
    } catch {
      return; // 忽略非 JSON 行
    }
    void handle(req);
  });
  rl.on('close', () => process.exit(0));
}

// 作为独立进程入口时自动启动
runMcpServer();
