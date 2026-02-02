const { spawn } = require('child_process');
const os = require('os');
const chalk = require('chalk');
const ora = require('ora');
const start = require('./start');
const { getServerInfo } = require('./utils/get-server');

const openBrowser = (url) => {
  let command;
  let args;

  if (os.platform() === 'darwin') {
    command = 'open';
    args = [url];
  } else if (os.platform() === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url]; // 空字符串作为窗口标题
  } else {
    // Linux and others
    command = 'xdg-open';
    args = [url];
  }

  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    shell: os.platform() === 'win32' // Windows 需要 shell
  });

  child.unref();
};

const openUI = async () => {
  // 使用 start 命令启动服务器（如果需要）
  // 使用 silent 和 noExit 选项来控制行为
  const started = await start({ silent: true, noExit: true });

  if (!started) {
    console.log(chalk.red('\n✗ Failed to start server, cannot open UI\n'));
    process.exit(1);
  }

  const { host, port } = getServerInfo();
  const url = `http://${host}:${port}`;

  const spinner = ora({
    text: chalk.cyan('Opening browser...'),
    color: 'cyan'
  }).start();

  try {
    openBrowser(url);
    spinner.succeed(chalk.green('Browser opened successfully!'));
    console.log(chalk.white('   URL: ') + chalk.cyan.bold(url) + '\n');
  } catch (err) {
    spinner.fail(chalk.red('Failed to open browser automatically'));
    console.log(chalk.yellow('⚠ Please open this URL manually: ') + chalk.cyan.bold(url) + '\n');
  }

  process.exit(0);
};

module.exports = openUI;
