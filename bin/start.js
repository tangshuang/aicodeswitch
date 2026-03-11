const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const chalk = require('chalk');
const boxen = require('boxen');
const ora = require('ora');
const { isServerRunning, getServerInfo } = require('./utils/get-server');
const { findPidByPort } = require('./utils/port-utils');

const PID_FILE = path.join(os.homedir(), '.aicodeswitch', 'server.pid');
const LOG_FILE = path.join(os.homedir(), '.aicodeswitch', 'server.log');

// 确保目录存在
const ensureDir = (filePath) => {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

const start = async (options = {}) => {
  const { silent = false, noExit = false, callback } = options;
  console.log('\n');

  // 已经运行
  const { host, port } = getServerInfo();
  if (isServerRunning() || await findPidByPort(port)) {
    if (!silent) {
      console.log(boxen(
        chalk.yellow.bold('⚠ Server is already running!\n\n') +
        chalk.white('URL: ') + chalk.cyan.bold(`http://${host}:${port}\n\n`) +
        chalk.white('Use ') + chalk.cyan('aicos restart') + chalk.white(' to restart the server.\n'),
        {
          padding: 1,
          margin: 1,
          borderStyle: 'round',
          borderColor: 'yellow'
        }
      ));
      console.log('');
    }

    if (callback) {
      callback();
    }

    if (!noExit) {
      process.exit(0);
    }

    return true;
  }

  const spinner = ora({
    text: chalk.cyan('Starting AI Code Switch server...'),
    color: 'cyan',
  }).start();

  ensureDir(PID_FILE);
  ensureDir(LOG_FILE);

  // 找到 main.js 的路径
  const serverPath = path.join(__dirname, '..', 'dist', 'server', 'main.js');

  if (!fs.existsSync(serverPath)) {
    spinner.fail(chalk.red('Server file not found!'));
    console.log(chalk.yellow(`\nPlease run ${chalk.cyan('npm run build')} first.\n`));
    if (!noExit) process.exit(1);
    return false;
  }

  // 启动服务器进程 - 完全分离
  const logFd = fs.openSync(LOG_FILE, 'a');

  const serverProcess = spawn('node', [serverPath], {
    detached: true,
    stdio: ['ignore', logFd, logFd]
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

      if (!silent) {
        spinner.succeed(chalk.green('Server started successfully!'));

        const { host: runningHost, port: runningPort } = getServerInfo();
        const url = `http://${runningHost}:${runningPort}`;

        console.log(boxen(
          chalk.green.bold('🚀 AI Code Switch Server\n\n') +
          chalk.white('Status:  ') + chalk.green.bold('● Running\n') +
          chalk.white('URL:     ') + chalk.cyan.bold(url) + '\n' +
          chalk.white('PID:     ') + chalk.yellow(pid) + '\n' +
          chalk.white('Logs:    ') + chalk.gray(LOG_FILE) + '\n\n' +
          chalk.gray('Open the URL in your browser to access the dashboard'),
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
      }

      if (callback) callback();
      if (!noExit) process.exit(0);
      return true;
    } catch (err) {
      spinner.fail(chalk.red('Failed to start server!'));
      console.log(chalk.yellow(`\nCheck logs: ${chalk.cyan(LOG_FILE)}\n`));
      if (!noExit) process.exit(1);
      return false;
    }
  }

  spinner.fail(chalk.red('Failed to start server!'));
  console.log(chalk.yellow(`\nCheck logs: ${chalk.cyan(LOG_FILE)}\n`));
  if (!noExit) process.exit(1);
  return false;
};

module.exports = start;
