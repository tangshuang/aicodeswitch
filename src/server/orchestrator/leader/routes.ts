/**
 * 主 Agent（Leader）HTTP 路由：/api/orchestrator/leader/*
 *
 * - POST /message        流式返回主 Agent 回复（text/event-stream）
 * - GET  /history        返回对话历史
 * - GET  /status         { busy, available }
 * - POST /reset          清空对话与工作记忆
 */
import type { Express, Request, Response } from 'express';
import type { LeaderManager } from './manager';
import type { ToolEvent } from './runner';

function sseData(res: Response, payload: unknown): boolean {
  if (res.writableEnded) return false;
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

export function registerLeaderRoutes(app: Express, manager: LeaderManager): void {
  // 流式对话
  app.post('/api/orchestrator/leader/message', (req: Request, res: Response) => {
    const text = (req.body?.text as string) || '';
    if (!text.trim()) {
      res.status(400).json({ error: 'text 不能为空' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let closed = false;
    req.on('close', () => {
      console.error(`[leader:routes] SSE req.on('close') fired — client disconnected, killing leader`);
      closed = true;
      manager.stop();
    });

    manager.sendMessage(text, {
      status: (t) => { if (!closed) sseData(res, { type: 'status', text: t }); },
      text: (delta) => { if (!closed) sseData(res, { type: 'text', delta }); },
      tool: (e: ToolEvent) => { if (!closed) sseData(res, { type: 'tool', tool: e }); },
      debug: (entry) => {
        if (closed) {
          console.error(`[leader:routes] SSE debug dropped (closed=true): ${entry.message?.slice(0, 100)}`);
          return;
        }
        const ok = sseData(res, { type: 'debug', debug: entry });
        if (!ok) console.error(`[leader:routes] SSE debug write FAILED (writableEnded=${res.writableEnded}): ${entry.message?.slice(0, 100)}`);
      },
      done: (full) => {
        if (!closed) { sseData(res, { type: 'done', full }); }
        if (!res.writableEnded) res.end();
      },
      error: (message) => {
        if (!closed) { sseData(res, { type: 'error', message }); }
        if (!res.writableEnded) res.end();
      },
    });
  });

  app.get('/api/orchestrator/leader/history', (_req, res) => {
    res.json(manager.getHistory());
  });

  app.get('/api/orchestrator/leader/status', (_req, res) => {
    res.json({ busy: manager.isBusy(), available: manager.isAvailable(), leaderTool: manager.getLeaderTool() });
  });

  app.get('/api/orchestrator/leader/config', (_req, res) => {
    res.json({ leaderTool: manager.getLeaderTool(), available: manager.isAvailable() });
  });

  app.put('/api/orchestrator/leader/config', (req, res) => {
    const tool = req.body?.leaderTool;
    if (tool !== 'claude-code' && tool !== 'codex') {
      res.status(400).json({ error: 'leaderTool 必须是 claude-code 或 codex' });
      return;
    }
    if (manager.isBusy()) {
      res.status(409).json({ error: '主 Agent 正在处理消息，请稍后再切换。' });
      return;
    }
    res.json(manager.setLeaderTool(tool));
  });

  app.post('/api/orchestrator/leader/reset', (_req, res) => {
    manager.reset();
    res.json({ success: true });
  });

  // ===== 会话管理 =====

  app.get('/api/orchestrator/leader/sessions', (_req, res) => {
    res.json({ sessions: manager.getSessions(), currentSessionId: manager.getCurrentSessionId() });
  });

  app.post('/api/orchestrator/leader/sessions', (_req, res) => {
    if (manager.isBusy()) {
      res.status(409).json({ error: '主 Agent 正在处理消息，请稍后再新建会话。' });
      return;
    }
    const session = manager.createSessionAndActivate();
    res.json({ session, currentSessionId: manager.getCurrentSessionId() });
  });

  app.post('/api/orchestrator/leader/sessions/:id/activate', (req, res) => {
    if (manager.isBusy()) {
      res.status(409).json({ error: '主 Agent 正在处理消息，无法切换会话。' });
      return;
    }
    if (!manager.activateSession(req.params.id)) {
      res.status(404).json({ error: '会话不存在' });
      return;
    }
    res.json({ currentSessionId: manager.getCurrentSessionId() });
  });

  app.patch('/api/orchestrator/leader/sessions/:id', (req, res) => {
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (!title) {
      res.status(400).json({ error: 'title 不能为空' });
      return;
    }
    const session = manager.renameSession(req.params.id, title);
    if (!session) {
      res.status(404).json({ error: '会话不存在' });
      return;
    }
    res.json({ session });
  });

  app.delete('/api/orchestrator/leader/sessions/:id', (req, res) => {
    const result = manager.deleteSession(req.params.id);
    if ('error' in result) {
      res.status(409).json(result);
      return;
    }
    res.json(result);
  });

  // ===== 权限裁决（Claude Code 经 --permission-prompt-tool 调用）=====

  // 同步阻塞：返回 {behavior:'allow'|'deny', ...}
  app.post('/api/orchestrator/leader/permission', async (req, res) => {
    const toolName = String(req.body?.tool_name || req.body?.toolName || 'Unknown');
    const input = req.body?.input ?? {};
    try {
      const result = await manager.judge.evaluate({ toolName, input });
      res.json(result);
    } catch (e) {
      res.status(500).json({ behavior: 'deny', risk: 'high', reason: `裁决异常：${e instanceof Error ? e.message : String(e)}` });
    }
  });

  app.get('/api/orchestrator/leader/permissions/pending', (_req, res) => {
    res.json(manager.judge.listPending());
  });

  app.post('/api/orchestrator/leader/permissions/:id/resolve', (req, res) => {
    const behavior = req.body?.behavior === 'allow' ? 'allow' : 'deny';
    const message = typeof req.body?.message === 'string' ? req.body.message : undefined;
    const ok = manager.judge.resolve(req.params.id, behavior, message);
    if (!ok) return res.status(404).json({ error: 'pending not found' });
    res.json({ success: true });
  });

  // SSE：实时推送权限事件（pending/decision/resolved）给前端
  app.get('/api/orchestrator/leader/permissions/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let closed = false;
    req.on('close', () => { closed = true; });
    const onEvent = (data: unknown) => { if (!closed) sseData(res, data); };
    manager.judge.on('event', onEvent);
    // 心跳
    const hb = setInterval(() => { if (!closed) sseData(res, { type: 'heartbeat' }); }, 15000);
    req.on('close', () => { manager.judge.off('event', onEvent); clearInterval(hb); });
  });
}
