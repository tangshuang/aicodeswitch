/**
 * 开发模式启动器（替代 concurrently）
 *
 * 目标：
 * 1. 先启动 server，轮询 /health 确认服务可用后，再启动 UI（避免 UI 起来后代理目标尚未就绪）。
 * 2. Ctrl+C 后「同步阻塞」到服务子进程真正退出（即服务端打印 Server stopped. 并
 *    process.exit 之后）再退出父进程，从而避免「终端提示符已回但端口 4567 尚未释放」
 *    导致的快速重启 EADDRINUSE 冲突。
 *
 * 原理：Node 无法真正同步阻塞事件循环，但只要本进程（前台进程组长）不调用
 * process.exit，终端就不会回到提示符。因此我们在信号处理器里 await 子进程的
 * 'exit' 事件，等价于「等到 Server stopped. 出现」。
 *
 * 直接运行：node scripts/dev.js（package.json 的 dev 脚本）
 */

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');
const http = require('http');

// 可选彩色前缀；非 TTY 时 chalk 自动失活，无副作用
let chalk;
try {
  // eslint-disable-next-line global-require
  chalk = require('chalk');
} catch {
  chalk = {
    cyan: (s) => s,
    magenta: (s) => s,
    gray: (s) => s,
    yellow: (s) => s,
  };
}

const ROOT = path.resolve(__dirname, '..');

// 等待子进程优雅退出的硬超时（秒）。需大于服务端 server.close 的 5s 上限 + 配置恢复余量。
const SHUTDOWN_TIMEOUT_MS = 15000;

// 服务端健康检查配置：轮询 /health 直到服务可用再启动 UI。
const SERVER_PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 4567;
const SERVER_HOST = '127.0.0.1';
const HEALTH_PATH = '/health';
const HEALTH_POLL_INTERVAL_MS = 300;
const HEALTH_WAIT_TIMEOUT_MS = 30000;

const SERVER_LABEL = chalk.cyan('[server]');
const UI_LABEL = chalk.magenta('[ui]');
const DEV_LABEL = chalk.gray('[dev]');

/**
 * 探测服务端 /health 是否可用（返回 2xx 即视为就绪）。
 * @returns {Promise<boolean>}
 */
function checkServerHealth() {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: SERVER_HOST,
        port: SERVER_PORT,
        path: HEALTH_PATH,
        timeout: 1500,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * 轮询等待服务端可用。期间若 serverChild 已退出，立即返回 false。
 * @param {import('child_process').ChildProcess} serverChild
 * @returns {Promise<boolean>} 服务是否在超时内就绪
 */
async function waitForServerReady(serverChild) {
  const deadline = Date.now() + HEALTH_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // 服务进程已退出则无需再等
    if (serverChild.exitCode !== null || serverChild.signalCode) return false;
    if (await checkServerHealth()) return true; // eslint-disable-line no-await-in-loop
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS)); // eslint-disable-line no-await-in-loop
  }
  return false;
}

/**
 * 给子进程的 stdout/stderr 加行级前缀后写出。
 * @param {import('child_process').ChildProcess} child
 * @param {string} label
 */
function prefixStream(child, label) {
  for (const streamName of ['stdout', 'stderr']) {
    const stream = child[streamName];
    if (!stream) continue;
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      process.stdout.write(`${label} ${line}\n`);
    });
  }
}

/**
 * 等待子进程 exit（触发于 process.exit 或被信号杀死）。
 * @returns {Promise<number>} exit code 或 signal 字符串
 */
function waitForExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode) {
      resolve(child.exitCode ?? 0);
      return;
    }
    child.once('exit', (code, signal) => {
      resolve(code ?? (signal ? 128 + 1 : 0));
    });
  });
}

function safeKill(child, signal) {
  try {
    if (child && child.exitCode === null && !child.signalCode) {
      child.kill(signal);
    }
  } catch {
    /* ignore */
  }
}

async function main() {
  let exitCode = 0;
  let shuttingDown = false;
  let uiChild = null;

  // 直接调本地 bin，去掉 `npm run` 额外进程层
  // shell:true 让 Windows 能找到 .cmd 版 bin
  const serverChild = spawn(
    'tsx',
    ['--tsconfig=tsconfig.server.json', 'src/server/main.ts'],
    { cwd: ROOT, shell: true, stdio: ['inherit', 'pipe', 'pipe'] },
  );
  prefixStream(serverChild, SERVER_LABEL);

  // 在启动 UI 之前注册信号处理与 server 退出级联，确保等待健康期间 Ctrl+C 也能正确清理
  process.on('SIGINT', () => { void stop('Ctrl+C'); });
  process.on('SIGTERM', () => { void stop('SIGTERM'); });

  serverChild.once('exit', (code) => {
    if (!shuttingDown) {
      process.stderr.write(
        `${DEV_LABEL} 服务进程已退出${code ? `（code=${code}）` : ''}，停止 UI 进程。\n`,
      );
      if (code && code !== 0) exitCode = code;
      void stop();
    }
  });

  // 1) 先等待服务端 /health 可用，再启动 UI，避免 UI 启动时代理目标尚未就绪
  process.stdout.write(
    `${DEV_LABEL} 等待服务端就绪（http://${SERVER_HOST}:${SERVER_PORT}${HEALTH_PATH}）...\n`,
  );
  const ready = await waitForServerReady(serverChild);
  if (!ready) {
    process.stderr.write(
      `${DEV_LABEL} 服务端在 ${HEALTH_WAIT_TIMEOUT_MS / 1000}s 内未就绪，放弃启动 UI。\n`,
    );
    // 走正常停止流程：清理可能残留的服务子进程后退出
    await stop();
    return;
  }
  process.stdout.write(`${DEV_LABEL} 服务端已就绪，启动 UI...\n`);

  // 2) 启动 UI
  uiChild = spawn('vite', [], {
    cwd: ROOT,
    shell: true,
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  prefixStream(uiChild, UI_LABEL);

  uiChild.once('exit', (code) => {
    if (!shuttingDown) {
      process.stderr.write(
        `${DEV_LABEL} UI 进程已退出${code ? `（code=${code}）` : ''}，停止服务进程。\n`,
      );
      if (code && code !== 0) exitCode = code;
      void stop();
    }
  });

  /**
   * 停止流程：向子进程转发信号，等待服务子进程（长时序）与 UI 子进程（若已启动）都退出。
   * 关键：不在此处立即 process.exit——父进程存活 = 终端提示符不回。
   */
  async function stop(reason) {
    if (shuttingDown) return;
    shuttingDown = true;

    if (reason) {
      process.stdout.write(
        `${DEV_LABEL} ${chalk.yellow(reason)}，等待服务完全停止后再退出...\n`,
      );
    }

    // 子进程随进程组已直接收到信号，这里再显式转发一次（幂等，无副作用）
    safeKill(serverChild, 'SIGINT');
    safeKill(uiChild, 'SIGINT');

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      process.stderr.write(
        `${DEV_LABEL} 等待超时（${SHUTDOWN_TIMEOUT_MS / 1000}s），强制终止残留子进程。\n`,
      );
      safeKill(serverChild, 'SIGKILL');
      safeKill(uiChild, 'SIGKILL');
    }, SHUTDOWN_TIMEOUT_MS);

    // 服务是长时序（配置恢复 + server.close 最多 5s），UI 通常已先退出
    const exits = [waitForExit(serverChild)];
    if (uiChild) exits.push(waitForExit(uiChild));
    const [serverCode, uiCode] = await Promise.all(exits);

    clearTimeout(timer);

    if (timedOut) exitCode = 1;
    else if (serverCode && serverCode !== 0) exitCode = serverCode;
    else if (uiCode && uiCode !== 0) exitCode = uiCode;

    process.exit(exitCode);
  }
}

main();
