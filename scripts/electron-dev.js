/**
 * Electron 开发模式启动器。
 *
 * 流程：
 *   1. 必要时构建后端（dist/server/main.js），因为 Electron 主进程会 require 它
 *   2. 启动 vite dev server（UI 热更新）
 *   3. 启动 Electron，主进程内嵌启动后端服务，窗口导航到 vite 的 dev URL
 *
 * Ctrl+C 时统一清理 vite / electron 子进程。
 *
 * 直接运行：node scripts/electron-dev.js（package.json 的 electron:dev 脚本）
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';
const VITE_PORT = process.env.VITE_PORT || '17808';
const VITE_URL = `http://localhost:${VITE_PORT}`;

function spawnChild(cmd, args, opts = {}) {
  return spawn(cmd, args, {
    cwd: ROOT,
    shell: IS_WIN,
    detached: !IS_WIN,
    stdio: ['inherit', 'inherit', 'inherit'],
    ...opts,
  });
}

function buildServerSync() {
  // Electron 主进程会 require dist/server/main.js 的导出，必须保证产物是最新的。
  // 每次都重编：server 编译很快（~2s），但跳过会导致旧产物缺导出 / 缺修复。
  console.log('[electron-dev] 编译 server (tsc) ...');
  require('child_process').execSync('node node_modules/typescript/bin/tsc -p tsconfig.server.json', {
    cwd: ROOT,
    stdio: 'inherit',
  });
}

function signalGroup(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const pid = child.pid;
  if (IS_WIN || pid == null) {
    try { child.kill(signal); } catch { /* ignore */ }
    return;
  }
  try { process.kill(-pid, signal); } catch { /* ignore */ }
}

async function main() {
  buildServerSync();

  let exiting = false;
  const viteChild = spawnChild('vite', ['--port', VITE_PORT]);
  // 等待 vite 起来（简单延迟）
  await new Promise((r) => setTimeout(r, 1500));

  const env = { ...process.env, AIC_ELECTRON_DEV_SERVER: VITE_URL };
  // 显式指定 electron/main.js 为入口，避免 Electron 读取 package.json 的 main
  // （npm 包的 main 指向 dist/server/main.js，会被当成主进程入口导致只起服务不开窗口）
  const electronChild = spawn('electron', ['electron/main.js'], {
    cwd: ROOT,
    shell: IS_WIN,
    detached: !IS_WIN,
    stdio: 'inherit',
    env,
  });

  const stop = (reason) => {
    if (exiting) return;
    exiting = true;
    if (reason) console.log(`[electron-dev] ${reason}，清理子进程...`);
    signalGroup(viteChild, 'SIGTERM');
    signalGroup(electronChild, 'SIGTERM');
    setTimeout(() => {
      signalGroup(viteChild, 'SIGKILL');
      signalGroup(electronChild, 'SIGKILL');
      process.exit(0);
    }, 3000);
  };

  process.on('SIGINT', () => stop('Ctrl+C'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  electronChild.once('exit', (code) => stop(code != null ? `electron 退出 (code=${code})` : 'electron 退出'));
  viteChild.once('exit', () => stop('vite 退出'));
}

main().catch((err) => {
  console.error('[electron-dev] 启动失败:', err);
  process.exit(1);
});
