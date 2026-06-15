const path = require('path');
const fs = require('fs');
const os = require('os');
const chalk = require('chalk');
const boxen = require('boxen');
const { isServerRunning, getServerInfo } = require('./utils/get-server');
const { findPidByPort, getProcessInfo } = require('./utils/port-utils');

const PID_FILE = path.join(os.homedir(), '.aicodeswitch', 'server.pid');
const LOG_FILE = path.join(os.homedir(), '.aicodeswitch', 'server.log');

const status = async () => {
  console.log('\n');

  // 读取配置的 host/port
  const { host, port } = getServerInfo();
  const url = `http://${host}:${port}`;

  // 优先通过 PID 文件判断
  let pidFromFile = null;
  if (fs.existsSync(PID_FILE)) {
    try {
      pidFromFile = parseInt(fs.readFileSync(PID_FILE, 'utf-8'), 10);
    } catch (err) {
      pidFromFile = null;
    }
  }

  const runningByPidFile = isServerRunning();
  // 通过端口检测（兜底：PID 文件丢失但服务仍在监听的情况）
  const pidByPort = await findPidByPort(port);
  const isRunning = runningByPidFile || !!pidByPort;

  if (isRunning) {
    // PID 优先使用 PID 文件记录的，其次使用端口检测到的
    const pid = runningByPidFile ? pidFromFile : pidByPort;
    const processInfo = await getProcessInfo(pid);

    console.log(boxen(
      chalk.green.bold('🟢 AI Code Switch Server\n\n') +
      chalk.white('Status:  ') + chalk.green.bold('● Running\n') +
      chalk.white('Host:    ') + chalk.cyan(host) + '\n' +
      chalk.white('Port:    ') + chalk.cyan.bold(port) + '\n' +
      chalk.white('URL:     ') + chalk.cyan.bold(url) + '\n' +
      chalk.white('PID:     ') + chalk.yellow(pid) + '\n' +
      chalk.white('Process: ') + chalk.gray(processInfo) + '\n' +
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
    console.log(chalk.white('  • Restart:      ') + chalk.yellow('aicos restart'));
    console.log('\n');
  } else {
    console.log(boxen(
      chalk.gray('AI Code Switch Server\n\n') +
      chalk.white('Status: ') + chalk.red('● Stopped\n\n') +
      chalk.white('Host:   ') + chalk.gray(host) + '\n' +
      chalk.white('Port:   ') + chalk.gray(port) + '\n' +
      chalk.white('URL:    ') + chalk.gray(url) + ' ' + chalk.gray('(not listening)'),
      {
        padding: 1,
        margin: 1,
        borderStyle: 'round',
        borderColor: 'gray'
      }
    ));

    console.log(chalk.white('Use ') + chalk.cyan('aicos start') + chalk.white(' to start the server.\n'));
  }

  process.exit(0);
};

module.exports = status;
