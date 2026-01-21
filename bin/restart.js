const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const chalk = require('chalk');
const boxen = require('boxen');
const ora = require('ora');

const PID_FILE = path.join(os.homedir(), '.aicodeswitch', 'server.pid');
const LOG_FILE = path.join(os.homedir(), '.aicodeswitch', 'server.log');

// 确保目录存在
const ensureDir = (filePath) => {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

const isServerRunning = () => {
  if (!fs.existsSync(PID_FILE)) {
    return false;
  }

  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8'), 10);
    // 检查进程是否存在
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // 进程不存在,删除过期的 PID 文件
    fs.unlinkSync(PID_FILE);
    return false;
  }
};

const getServerInfo = () => {
  // 尝试多个可能的配置文件位置
  const possiblePaths = [
    path.join(os.homedir(), '.aicodeswitch', '.env'),
    path.join(os.homedir(), '.aicodeswitch', 'aicodeswitch.conf')
  ];

  let host = '127.0.0.1';
  let port = 4567;

  for (const dotenvPath of possiblePaths) {
    if (fs.existsSync(dotenvPath)) {
      const content = fs.readFileSync(dotenvPath, 'utf-8');
      const hostMatch = content.match(/HOST=(.+)/);
      const portMatch = content.match(/PORT=(.+)/);

      if (hostMatch) host = hostMatch[1].trim();
      if (portMatch) port = parseInt(portMatch[1].trim(), 10);
      break;
    }
  }

  return { host, port };
};

const stopServer = async () => {
  if (!fs.existsSync(PID_FILE)) {
    return true; // 服务未运行,视为停止成功
  }

  const spinner = ora({
    text: chalk.cyan('Stopping server...'),
    color: 'cyan'
  }).start();

  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8'), 10);

    try {
      process.kill(pid, 'SIGTERM');

      // 等待进程停止
      let attempts = 0;
      const maxAttempts = 10;

      await new Promise((resolve) => {
        const checkStopped = setInterval(() => {
          attempts++;
          try {
            process.kill(pid, 0);
            if (attempts >= maxAttempts) {
              clearInterval(checkStopped);
              // 强制终止
              try {
                process.kill(pid, 'SIGKILL');
              } catch (e) {
                // 进程可能已经停止
              }
              resolve();
            }
          } catch (err) {
            // 进程已停止
            clearInterval(checkStopped);
            resolve();
          }
        }, 200);
      });

      spinner.succeed(chalk.green('Server stopped'));
      fs.unlinkSync(PID_FILE);
      return true;
    } catch (err) {
      // 进程不存在
      spinner.succeed(chalk.green('Server stopped'));
      fs.unlinkSync(PID_FILE);
      return true;
    }
  } catch (err) {
    spinner.fail(chalk.red('Failed to stop server'));
    return false;
  }
};

const startServer = async () => {
  const spinner = ora({
    text: chalk.cyan('Starting server...'),
    color: 'cyan'
  }).start();

  ensureDir(PID_FILE);
  ensureDir(LOG_FILE);

  // 找到 main.js 的路径
  const serverPath = path.join(__dirname, '..', 'dist', 'server', 'main.js');

  if (!fs.existsSync(serverPath)) {
    spinner.fail(chalk.red('Server file not found!'));
    console.log(chalk.yellow(`\nPlease run ${chalk.cyan('npm run build')} first.\n`));
    return false;
  }

  // 启动服务器进程 - 完全分离
  // 打开日志文件用于输出
  const logFd = fs.openSync(LOG_FILE, 'a');

  const serverProcess = spawn('node', [serverPath], {
    detached: true,
    stdio: ['ignore', logFd, logFd]  // 使用文件描述符
  });

  // 关闭文件描述符(子进程会保持打开)
  fs.closeSync(logFd);

  // 保存 PID
  fs.writeFileSync(PID_FILE, serverProcess.pid.toString());

  // 分离进程,让父进程可以退出
  serverProcess.unref();

  // 等待服务器启动
  await new Promise(resolve => setTimeout(resolve, 2000));

  // 检查服务器是否成功启动
  if (fs.existsSync(PID_FILE)) {
    try {
      const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8'), 10);
      process.kill(pid, 0);
      spinner.succeed(chalk.green('Server started'));
      return true;
    } catch (err) {
      spinner.fail(chalk.red('Failed to start server'));
      return false;
    }
  } else {
    spinner.fail(chalk.red('Failed to start server'));
    return false;
  }
};

const restart = async () => {
  console.log('\n');

  const wasRunning = isServerRunning();

  if (wasRunning) {
    console.log(chalk.cyan('🔄 Restarting AI Code Switch server...\n'));

    // 停止服务器
    const stopped = await stopServer();
    if (!stopped) {
      console.log(chalk.red('\nFailed to stop server. Restart aborted.\n'));
      process.exit(1);
    }

    // 等待一下确保端口释放
    await new Promise(resolve => setTimeout(resolve, 500));
  } else {
    console.log(chalk.cyan('Starting AI Code Switch server...\n'));
  }

  // 启动服务器
  const started = await startServer();

  if (!started) {
    console.log(chalk.yellow(`\nCheck logs: ${chalk.cyan(LOG_FILE)}\n`));
    process.exit(1);
  }

  const { host, port } = getServerInfo();
  const url = `http://${host}:${port}`;

  // 显示漂亮的启动信息
  console.log(boxen(
    chalk.green.bold('🚀 AI Code Switch Server\n\n') +
    chalk.white('Status:  ') + chalk.green.bold('● Running\n') +
    chalk.white('URL:     ') + chalk.cyan.bold(url) + '\n' +
    chalk.white('Logs:    ') + chalk.gray(LOG_FILE) + '\n\n' +
    chalk.gray('Server has been ' + (wasRunning ? 'restarted' : 'started') + ' successfully'),
    {
      padding: 1,
      margin: 1,
      borderStyle: 'double',
      borderColor: 'green'
    }
  ));

  console.log(chalk.cyan('💡 Tips:\n'));
  console.log(chalk.white('  • Open browser: ') + chalk.cyan(url));
  console.log(chalk.white('  • View logs:    ') + chalk.gray(`tail -f ${LOG_FILE}`));
  console.log(chalk.white('  • Stop server:  ') + chalk.yellow('aicos stop'));
  console.log('\n');

  process.exit(0);
};

module.exports = restart();
