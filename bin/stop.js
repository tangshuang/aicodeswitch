const fs = require('fs');
const path = require('path');
const os = require('os');
const chalk = require('chalk');
const boxen = require('boxen');
const ora = require('ora');
const { findPidByPort, killProcess, getProcessInfo } = require('./utils/port-utils');
const { getServerInfo } = require('./utils/get-server');

const PID_FILE = path.join(os.homedir(), '.aicodeswitch', 'server.pid');

const stop = async (options = {}) => {
  const { callback, silent } = options;

  console.log('\n');

  const spinner = ora({ text: chalk.cyan('Stopping server...'), color: 'cyan' }).start();

  // 第一步：如果 PID 文件存在，优先通过 PID 文件停止服务器
  if (fs.existsSync(PID_FILE)) {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8'), 10);
    try {
      const processInfo = await getProcessInfo(pid);
      if (!silent) {
        console.log('\n' + chalk.gray(`Process found: ${chalk.white(pid)} (${chalk.gray(processInfo)})`));
      }

      // 尝试终止进程
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
              process.kill(pid, 'SIGKILL');
              spinner.warn(chalk.yellow(`PID ${pid} forcefully killed!`));
              fs.unlinkSync(PID_FILE);
              resolve();
            }
          } catch (err) {
            spinner.succeed(chalk.green(`PID ${pid} killed!`));
            // 进程已停止
            clearInterval(checkStopped);
            fs.unlinkSync(PID_FILE);
            resolve();
          }
        }, 200);
      });
    }
    catch (err) {
      // 进程不存在
      if (err.code === 'ESRCH') {
          spinner.warn(chalk.yellow(`PID ${pid} not found!`));
      }
      else {
        spinner.fail(chalk.red(`\nError: ${err.message}\n`));
      }
      fs.unlinkSync(PID_FILE);
    }
  }

  // 第二步：如果 PID 文件不存在，通过端口检测进程并停止
  const { port } = getServerInfo();
  spinner.text = chalk.yellow(`⚠ Checking port... (port: ${port})`);
  const pid = await findPidByPort(port);
  if (pid) {
    spinner.text = chalk.cyan(`Found process on port ${port}, stopping...`);

    const processInfo = await getProcessInfo(pid);
    if (!silent) {
      console.log('\n' + chalk.gray(`Process found: ${chalk.white(pid)} (${chalk.gray(processInfo)})`));
    }

    const killed = await killProcess(pid);
    if (killed) {
      spinner.succeed(chalk.green(`Process ${pid} terminated successfully`));
      if (!silent) {
        showStoppedMessage();
      }
    }
    else {
      spinner.fail(chalk.red('Failed to terminate process'));
    }
  }
  else {
    spinner.info(chalk.yellow(`No process found on port ${port}`));
    if (!silent) {
      showStoppedMessage();
    }
  }

  // 第三步：(callback)
  callback && callback();
};

const showStoppedMessage = () => {
  console.log(boxen(
    chalk.gray('AI Code Switch Server\n\n') +
    chalk.white('Status: ') + chalk.red('● Stopped'),
    {
      padding: 1,
      margin: 1,
      borderStyle: 'round',
      borderColor: 'gray'
    }
  ));
  console.log(chalk.white('Use ') + chalk.cyan('aicos start') + chalk.white(' to start the server again.\n'));
};

module.exports = stop;