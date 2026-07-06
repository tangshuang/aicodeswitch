/**
 * AICodeSwitch Electron 主进程入口。
 *
 * 设计要点（与旧 Tauri 方案的差异）：
 *   - 后端不再以「node 子进程」方式 spawn，而是被直接 require 进 Electron 主进程，
 *     通过调用其导出的 start() 在进程内启动 Express 服务（AIC_IN_PROCESS=1）。
 *     这样无需用户预装 Node.js，也消除了子进程生命周期管理的复杂度。
 *   - 主窗口先加载本地 loading.html（启动屏 + 错误面板），主进程在服务就绪后
 *     通过 IPC 通知渲染层，再由主进程把窗口导航到 http://127.0.0.1:{PORT}。
 *   - 关闭窗口时调用服务端 gracefulShutdown()（恢复本地工具配置 + 关闭 DB/日志），
 *     再退出应用。
 */

'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');

// ── 调试日志（与旧 Tauri 启动日志同路径，便于延续运维习惯） ───────────────
const LOG_DIR = path.join(os.homedir(), '.aicodeswitch');
const LOG_FILE = path.join(LOG_DIR, 'app-launch-debug.log');

function appendLog(msg) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const ts = new Date().toISOString();
    fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`);
  } catch { /* ignore */ }
  // 同时输出到终端，方便调试
  // eslint-disable-next-line no-console
  console.log(msg);
}

// ── 端口读取（与 CLI/Rust 行为一致：从 ~/.aicodeswitch/aicodeswitch.conf 取 PORT） ──
const DEFAULT_PORT = 4567;

function readPortFromConfig() {
  try {
    const confPath = path.join(os.homedir(), '.aicodeswitch', 'aicodeswitch.conf');
    if (!fs.existsSync(confPath)) return DEFAULT_PORT;
    const content = fs.readFileSync(confPath, 'utf-8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith('PORT=')) {
        const n = parseInt(trimmed.slice('PORT='.length).trim(), 10);
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
  } catch { /* ignore */ }
  return DEFAULT_PORT;
}

// ── 全局状态 ──────────────────────────────────────────────────────────
let mainWindow = null;
let serverModule = null;     // require('./dist/server/main.js') 的返回值
let serverReady = false;
let port = DEFAULT_PORT;
let watchdogTimer = null;
let isQuitting = false;

const WATCHDOG_MS = 45000;   // 与旧 Tauri 看门狗一致：覆盖健康检查超时 + 宽限

// ── 健康检查 ──────────────────────────────────────────────────────────
function checkHealth() {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: '127.0.0.1', port, path: '/health', timeout: 1500 },
      (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitForServer() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    // 进程内服务启动失败可能直接 process.exit，这里轮询健康即可感知
    // eslint-disable-next-line no-await-in-loop
    if (await checkHealth()) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

// ── 向渲染层推送启动日志/错误 ─────────────────────────────────────────
function sendLog(msg) {
  appendLog(msg);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('startup-log', msg);
  }
}

function sendError(report) {
  appendLog(`✗ 启动失败:\n${report}`);
  if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('startup-error', report);
  }
}

// ── 在主进程内启动后端服务 ─────────────────────────────────────────────
async function startInProcessServer() {
  // 开发态：通过环境变量 AIC_ELECTRON_DEV_SERVER 指向 vite dev server，UI 走热更新；
  // 生产态：UI 由 Express 的 dist/ui 静态资源提供。
  const isDev = !!process.env.AIC_ELECTRON_DEV_SERVER;

  // 服务端入口解析：基于 electron/main.js 自身的 __dirname 推导仓库/应用根。
  // 不使用 app.getAppPath()：当以 `electron electron/main.js` 显式入口启动时，
  // getAppPath() 可能返回该文件路径而非目录；__dirname 在「显式文件入口」与
  // 「打包后（approot/electron/main.js + approot/dist）」两种布局下都稳定。
  const repoRoot = path.resolve(__dirname, '..');
  const serverEntry = path.join(repoRoot, 'dist', 'server', 'main.js');
  appendLog(`Electron 主进程模式: ${isDev ? '开发' : '生产'}`);
  appendLog(`应用根目录: ${repoRoot}`);
  appendLog(`服务入口: ${serverEntry}`);

  if (!fs.existsSync(serverEntry)) {
    throw new Error(`Server entry file not found: ${serverEntry}\n请先执行 \`npm run build\`（或 yarn build）生成 dist/server。`);
  }

  // 内嵌进程模式：服务端 shutdown 后不 process.exit，且被 require 时不自动 start
  process.env.AIC_IN_PROCESS = '1';
  process.env.PORT = String(port);
  process.env.NODE_ENV = 'production';

  // 清理 require 缓存，避免开发态热重载时旧实例残留
  try { delete require.cache[require.resolve(serverEntry)]; } catch { /* ignore */ }

  // eslint-disable-next-line global-require, import/no-dynamic-require
  serverModule = require(serverEntry);
  if (!serverModule || typeof serverModule.start !== 'function') {
    throw new Error('服务入口未导出 start() 函数，请检查 src/server/main.ts 的导出。');
  }

  // 进程内启动服务（异步）；start 内部的致命错误会 process.exit(1)，由系统兜底
  serverModule.start().catch((err) => {
    appendLog(`服务启动异常: ${err && err.stack ? err.stack : err}`);
    sendError(`服务启动异常：${err && err.message ? err.message : err}`);
  });

  sendLog('正在等待服务就绪...');
  const ok = await waitForServer();
  if (!ok) {
    throw new Error(`服务在 30 秒内未就绪（端口 ${port}）。详见 ~/.aicodeswitch/app-launch-debug.log`);
  }
  serverReady = true;
  sendLog('服务已就绪');
}

// ── 创建主窗口 ────────────────────────────────────────────────────────
function createWindow() {
  const isDev = !!process.env.AIC_ELECTRON_DEV_SERVER;

  // 窗口图标（Windows/Linux 任务栏 + 开发期可见）；macOS 应用图标来自 .app bundle，
  // 由 electron-builder 在打包时根据 build/icon.png 自动生成 icon.icns。
  const iconPath = path.join(__dirname, '..', 'build', 'icon.png');
  const windowOptions = {
    width: 1200,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    resizable: true,
    title: 'AI Code Switch',
    backgroundColor: '#081c15',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  };
  if (fs.existsSync(iconPath)) {
    windowOptions.icon = iconPath;
  }
  mainWindow = new BrowserWindow(windowOptions);

  // 先加载本地启动屏（显示启动日志/错误面板）
  mainWindow.loadFile(path.join(__dirname, 'loading.html'));

  // 启动即最大化（保留 width/height 作为不可最大化时的兜底尺寸）
  if (mainWindow.maximizable) {
    mainWindow.maximize();
  }

  // macOS：把 app 拉到前台并显示/聚焦窗口，避免从 CLI 启动时只在 dock 出现图标
  if (process.platform === 'darwin' && app.dock && typeof app.dock.show === 'function') {
    app.dock.show();
  }
  mainWindow.show();
  mainWindow.focus();

  // 启动看门狗：超时未就绪则展示错误面板，避免无限转圈
  watchdogTimer = setTimeout(() => {
    if (!serverReady) {
      sendError(
        `启动超时：在 ${WATCHDOG_MS / 1000} 秒内未收到服务就绪信号。\n` +
        '可能是后端启动卡死或端口冲突，详见 ~/.aicodeswitch/app-launch-debug.log。',
      );
    }
  }, WATCHDOG_MS);

  // macOS：点关闭按钮只是隐藏窗口（不销毁、不退出），点 dock 图标可再次显示；
  // 真正退出走 before-quit（Cmd+Q / dock Quit）→ gracefulQuit，此时 isQuitting=true 放行关闭。
  // Windows / Linux：保持「关窗即退出」的常规行为。
  mainWindow.on('close', (e) => {
    if (process.platform === 'darwin' && !isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // 窗口真正销毁时（仅退出流程）清理引用
  mainWindow.on('closed', () => { mainWindow = null; });

  // 捕获窗口内的导航错误（服务已就绪但打不开界面）
  mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDescription) => {
    if (!serverReady) return; // 启动屏阶段忽略
    sendError(`界面加载失败 (code=${errorCode}): ${errorDescription}`);
  });

  // 渲染进程崩溃/被杀时记录，便于诊断「窗口出现后又消失」类问题
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    appendLog(`⚠ 渲染进程异常退出: reason=${details && details.reason}`);
  });

  return mainWindow;
}

// ── 启动主流程 ────────────────────────────────────────────────────────
async function bootstrap() {
  port = readPortFromConfig();
  appendLog('=== AICodeSwitch Electron 启动日志 ===');

  createWindow();
  sendLog('应用已启动');

  try {
    await startInProcessServer();
  } catch (err) {
    sendError(err && err.message ? err.message : String(err));
    return;
  }

  // 服务就绪 → 导航到管理界面
  const isDev = !!process.env.AIC_ELECTRON_DEV_SERVER;
  const targetUrl = isDev
    ? process.env.AIC_ELECTRON_DEV_SERVER
    : `http://127.0.0.1:${port}`;

  try {
    sendLog(`正在加载 ${targetUrl} ...`);
    await mainWindow.loadURL(targetUrl);
    if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
  } catch (err) {
    sendError(`服务已就绪，但无法打开管理界面：${err && err.message ? err.message : err}`);
  }
}

// ── 退出前的优雅关闭 ──────────────────────────────────────────────────
async function gracefulQuit() {
  if (isQuitting) return;
  isQuitting = true;
  appendLog('开始应用退出流程...');
  try {
    if (serverModule && typeof serverModule.gracefulShutdown === 'function') {
      // 触发服务端完整关闭：恢复 Claude/Codex/OpenCode 配置、关闭 DB/日志、释放端口
      await serverModule.gracefulShutdown('ELECTRON_QUIT');
    } else if (serverReady) {
      // 兜底：服务未导出 gracefulShutdown 时走 HTTP /api/shutdown
      await new Promise((resolve) => {
        const req = http.request(
          { hostname: '127.0.0.1', port, path: '/api/shutdown', method: 'POST', timeout: 8000 },
          (res) => { res.resume(); resolve(); },
        );
        req.on('error', () => resolve());
        req.on('timeout', () => { req.destroy(); resolve(); });
        req.end();
      });
    }
  } catch (err) {
    appendLog(`关闭流程异常: ${err && err.message ? err.message : err}`);
  }
}

// ── 应用生命周期 ──────────────────────────────────────────────────────
// macOS Cmd+Q / 窗口关闭都汇聚到 before-quit，统一走 gracefulQuit
app.on('before-quit', (e) => {
  if (!isQuitting) {
    e.preventDefault();
    gracefulQuit().finally(() => {
      app.exit(0);
    });
  }
});

app.whenReady().then(() => {
  bootstrap().catch((err) => {
    appendLog(`bootstrap 异常: ${err && err.stack ? err.stack : err}`);
  });
});

// 所有窗口关闭时退出（非 macOS 行为；macOS 由 before-quit 兜底）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// macOS：点击 dock 图标时重新显示已隐藏的窗口（关窗只是 hide，窗口仍在）
app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});
