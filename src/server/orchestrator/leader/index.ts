export { LeaderManager } from './manager';
export type { LeaderSink } from './manager';
export { registerLeaderRoutes } from './routes';
export { ensureLeaderDirs, LEADER_PATHS } from './memory';
// 注意：mcp-server.ts 是独立进程入口，不在此处导出/导入，避免被服务主进程加载时启动。
