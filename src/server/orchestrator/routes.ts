/**
 * Orchestrator HTTP 路由：/api/orchestrator/*
 *
 * 端点：
 * - POST   /teams                       创建并启动团队
 * - GET    /teams                        列出团队
 * - GET    /teams/:id                    团队状态（含 tasks/results/pendingQuestions）
 * - GET    /teams/:id/logs?since=        增量日志
 * - POST   /teams/:id/stop               停止团队
 * - POST   /teams/:id/questions/:qid/answer  人工回答问题
 * - GET    /adapters/check               适配器健康检查
 * - GET    /routes                       可用路由（供选择 Layer 1 routeId）
 */
import type { Express, Request, Response } from 'express';
import type { OrchestratorManager } from './manager';
import type { FileSystemDatabaseManager } from '../fs-database';
import type { CreateTeamRequest } from './types';

export function registerOrchestratorRoutes(app: Express, manager: OrchestratorManager, dbManager: FileSystemDatabaseManager): void {
  // 创建并启动团队
  app.post('/api/orchestrator/teams', async (req: Request, res: Response) => {
    try {
      const body = req.body as CreateTeamRequest;
      if (!body || !body.prompt || !body.prompt.trim()) {
        return res.status(400).json({ error: 'prompt 不能为空' });
      }
      const team = await manager.createTeam(body);
      res.json(team);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 列出团队
  app.get('/api/orchestrator/teams', (_req, res) => {
    res.json(manager.listTeams());
  });

  // 团队状态
  app.get('/api/orchestrator/teams/:id', (req, res) => {
    const team = manager.getTeam(req.params.id);
    if (!team) return res.status(404).json({ error: 'team not found' });
    const { _scheduler, ...rest } = team;
    void _scheduler;
    res.json(rest);
  });

  // 增量日志
  app.get('/api/orchestrator/teams/:id/logs', (req, res) => {
    const since = Number(req.query.since || 0);
    const logs = manager.getLogs(req.params.id, since);
    res.json(logs);
  });

  // 停止团队
  app.post('/api/orchestrator/teams/:id/stop', (req, res) => {
    const ok = manager.stopTeam(req.params.id);
    if (!ok) return res.status(404).json({ error: 'team not found' });
    res.json({ success: true });
  });

  // 回答问题
  app.post('/api/orchestrator/teams/:id/questions/:qid/answer', async (req, res) => {
    const choice = (req.body?.choice as string) || req.body?.choice;
    if (!choice) return res.status(400).json({ error: 'choice 不能为空' });
    const ok = await manager.answerQuestion(req.params.id, req.params.qid, String(choice), 'user');
    if (!ok) return res.status(404).json({ error: 'team or question not found' });
    res.json({ success: true });
  });

  // 适配器健康检查
  app.get('/api/orchestrator/adapters/check', async (_req, res) => {
    const result = await manager.checkAdapters();
    res.json(result);
  });

  // 可用路由（供前端选择 Layer 1 routeId）
  app.get('/api/orchestrator/routes', (_req, res) => {
    try {
      const routes = dbManager.getRoutes();
      res.json(routes);
    } catch {
      res.json([]);
    }
  });
}
