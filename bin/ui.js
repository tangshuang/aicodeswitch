const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const chalk = require('chalk');
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

const startServer = async () => {
  const spinner = ora({
    text: chalk.cyan('Starting AI Code Switch server...'),
    color: 'cyan'
  }).start();

  ensureDir(PID_FILE);
  ensureDir(LOG_FILE);

  // 找到 main.js 的路径
  const serverPath = path.join(__dirname, '..', 'dist', 'server', 'main.js');

  if (!fs.existsSync(serverPath)) {
    spinner.fail(chalk.red('Server file not found!'));
    console.log(chalk.yellow(`\nPlease run ${chalk.cyan('npm run build')} first.\n`));
    process.exit(1);
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
      spinner.succeed(chalk.green('Server started successfully!'));
      return true;
    } catch (err) {
      spinner.fail(chalk.red('Failed to start server!'));
      console.log(chalk.yellow(`\nCheck logs: ${chalk.cyan(LOG_FILE)}\n`));
      return false;
    }
  } else {
    spinner.fail(chalk.red('Failed to start server!'));
    console.log(chalk.yellow(`\nCheck logs: ${chalk.cyan(LOG_FILE)}\n`));
    return false;
  }
};

const openBrowser = (url) => {
  const platform = os.platform();
  let command;

  if (platform === 'darwin') {
    command = 'open';
  } else if (platform === 'win32') {
    command = 'start';
  } else {
    // Linux and others
    command = 'xdg-open';
  }

  const child = spawn(command, [url], {
    detached: true,
    stdio: 'ignore'
  });

  child.unref();
};

const openUI = async () => {
  console.log('\n');

  const running = isServerRunning();

  if (!running) {
    console.log(chalk.yellow('⚠ Server is not running, starting server first...\n'));
    const started = await startServer();
    if (!started) {
      console.log(chalk.red('\n✗ Failed to start server, cannot open UI\n'));
      process.exit(1);
    }
  } else {
    console.log(chalk.green('✓ Server is already running\n'));
  }

  const { host, port } = getServerInfo();
  const url = `http://${host}:${port}`;

  console.log(chalk.cyan('🌐 Opening browser...'));
  console.log(chalk.white('   URL: ') + chalk.cyan.bold(url) + '\n');

  try {
    openBrowser(url);
    console.log(chalk.green('✓ Browser opened successfully!\n'));
  } catch (err) {
    console.log(chalk.yellow('⚠ Failed to open browser automatically'));
    console.log(chalk.white('  Please open this URL manually: ') + chalk.cyan.bold(url) + '\n');
  }

  process.exit(0);
};

module.exports = openUI();
