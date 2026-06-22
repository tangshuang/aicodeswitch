/**
 * ato-leader MCP server 命令解析
 *
 * Leader 经 Claude Agent SDK 的 `options.mcpServers` 内联拉起 ato-leader stdio MCP
 * （替代旧实现里写 ~/.claude.json / ~/.codex/config.toml 由 CLI 自行加载）。
 * 本模块只负责定位 mcp-server 的启动命令；工具实现仍在 ./mcp-server.ts（作为独立 stdio 进程）。
 */
import { existsSync } from 'fs';
import * as path from 'path';

export interface McpServerCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** 解析 ato-leader stdio MCP server 的启动命令（prod 编译产物优先，dev 回退 tsx 跑 .ts） */
export function resolveLeaderMcpServer(): McpServerCommand {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 4567;
  const envVars: Record<string, string> = {
    ATO_BASE: `http://127.0.0.1:${port}`,
    ATO_TOKEN: process.env.ATO_TOKEN || '',
  };
  const here = __dirname; // prod: dist/server/orchestrator/leader；dev(tsx): src/server/orchestrator/leader
  const projectRoot = path.join(here, '..', '..', '..', '..');

  // 1) 同目录编译产物（prod）
  const jsHere = path.join(here, 'mcp-server.js');
  if (existsSync(jsHere)) {
    return { command: process.execPath, args: [jsHere], env: envVars };
  }

  // 2) dev：优先用 dist 下上次 build 的 mcp-server.js（比 tsx 跑 .ts 更稳）
  const distJs = path.join(projectRoot, 'dist', 'server', 'orchestrator', 'leader', 'mcp-server.js');
  if (existsSync(distJs)) {
    return { command: process.execPath, args: [distJs], env: envVars };
  }

  // 3) dev 无 build：用 tsx 运行 .ts 源文件
  const tsHere = path.join(here, 'mcp-server.ts');
  const tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (existsSync(tsHere) && existsSync(tsxCli)) {
    return { command: process.execPath, args: [tsxCli, tsHere], env: envVars };
  }

  // 4) 兜底：返回不存在的 js 路径（SDK 拉起时报清晰错误）
  console.warn(`[ato-tools] 无法定位 ato-leader mcp-server：js=${jsHere}, dist=${distJs}, ts=${tsHere}`);
  return { command: process.execPath, args: [jsHere], env: envVars };
}
