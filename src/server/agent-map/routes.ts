/**
 * Agent Map 路由：SSE 实时流 + REST 快照/事件
 *
 * - GET /api/agent-map/stream         SSE（init 快照 + session-update/activity/stats/heartbeat）
 * - GET /api/agent-map/sessions       Session 节点列表（含 status）
 * - GET /api/agent-map/sessions/:id/events?since=   某 Session 增量活动
 * - GET /api/agent-map/stats          全局指标
 */
import type { Express } from 'express';
import type { AgentMapService } from './agent-map-service';

export function registerAgentMapRoutes(app: Express, service: AgentMapService) {
  // SSE 实时流
  app.get('/api/agent-map/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // init 快照
    const snap = service.getSnapshot();
    res.write(`data: ${JSON.stringify({ type: 'init', ...snap })}\n\n`);

    const onSessionUpdate = (s: any) => {
      res.write(`data: ${JSON.stringify({ type: 'session-update', session: s })}\n\n`);
    };
    const onActivity = (e: any) => {
      res.write(`data: ${JSON.stringify({ type: 'activity', event: e })}\n\n`);
    };
    const onStats = (s: any) => {
      res.write(`data: ${JSON.stringify({ type: 'stats', stats: s })}\n\n`);
    };
    service.on('session-update', onSessionUpdate);
    service.on('activity', onActivity);
    service.on('stats', onStats);

    const heartbeat = setInterval(() => {
      res.write(`data: ${JSON.stringify({ type: 'heartbeat', timestamp: Date.now() })}\n\n`);
    }, 3000);

    req.on('close', () => {
      service.off('session-update', onSessionUpdate);
      service.off('activity', onActivity);
      service.off('stats', onStats);
      clearInterval(heartbeat);
    });
  });

  app.get('/api/agent-map/sessions', (_req, res) => {
    res.json(service.getSnapshot().sessions);
  });

  app.get('/api/agent-map/sessions/:id/events', (req, res) => {
    const sinceRaw = typeof req.query.since === 'string' ? parseInt(req.query.since, 10) : NaN;
    const since = Number.isFinite(sinceRaw) ? sinceRaw : undefined;
    res.json(service.getSessionEvents(req.params.id, since));
  });

  // 按需解析会话的项目路径 + 原始标题（仅 global 来源会在本机解析；access-key 返回 source 标记）
  app.get('/api/agent-map/sessions/:id/meta', async (req, res) => {
    try {
      const meta = await service.getSessionMeta(req.params.id);
      res.json(meta);
    } catch (err) {
      console.error('[AgentMap] getSessionMeta error:', err);
      res.json({ source: 'unknown' });
    }
  });

  app.get('/api/agent-map/stats', (_req, res) => {
    res.json(service.getSnapshot().stats);
  });

  // 任务结束 OS 通知：开关 / 页面后台态上报 / 测试
  app.get('/api/agent-map/notify', (_req, res) => {
    res.json({ enabled: service.getNotifyEnabled() });
  });
  app.post('/api/agent-map/notify', (req, res) => {
    const enabled = !!req.body?.enabled;
    service.setNotifyEnabled(enabled);
    res.json({ enabled });
  });
  app.post('/api/agent-map/notify-focus', (req, res) => {
    service.setPageHidden(!!req.body?.hidden);
    res.json({ ok: true });
  });
  app.post('/api/agent-map/notify-test', (_req, res) => {
    service.notifyTest();
    res.json({ ok: true });
  });
}
