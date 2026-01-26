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

  const { host, port } = getServerInfo();

  if (!fs.existsSync(PID_FILE)) {
    if (!silent) {
      // PID 文件不存在，尝试通过端口检测进程
      console.log(boxen(
        chalk.yellow('⚠ PID file not found, checking port...'),
        {
          padding: 1,
          margin: 1,
          borderStyle: 'round',
          borderColor: 'yellow'
        }
      ));
    }

    const spinner = ora({
      text: chalk.cyan(`Checking port ${port}...`),
      color: 'cyan'
    }).start();

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
        showStoppedMessage();
      } else {
        spinner.fail(chalk.red('Failed to terminate process'));
      }
    } else {
      spinner.info(chalk.yellow(`No process found on port ${port}`));
      if (!silent) {
        console.log(boxen(
          chalk.yellow.bold('⚠ Server is not running'),
          {
            padding: 1,
            margin: 1,
            borderStyle: 'round',
            borderColor: 'yellow'
          }
        ));
      }
    }
    if (!silent) {
      console.log('\n');
    }

    if (callback) {
      console.log(boxen(chalk.yellow.bold('⚠ Server is not running')));
      callback();
    }
    return;
  }

  const spinner = ora({
    text: chalk.cyan('Stopping server...'),
    color: 'cyan'
  }).start();

  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8'), 10);

    // 尝试终止进程
    try {
      process.kill(pid, 'SIGTERM');

      // 等待进程停止
      let attempts = 0;
      const maxAttempts = 10;

      const checkStopped = setInterval(() => {
        attempts++;
        try {
          process.kill(pid, 0);
          if (attempts >= maxAttempts) {
            clearInterval(checkStopped);
            // 强制终止
            process.kill(pid, 'SIGKILL');
            spinner.warn(chalk.yellow('Server forcefully stopped'));
            fs.unlinkSync(PID_FILE);
            if (!silent) {
              showStoppedMessage();
            }
            callback && callback();
          }
        } catch (err) {
          // 进程已停止
          clearInterval(checkStopped);
          spinner.succeed(chalk.green('Server stopped successfully'));
          fs.unlinkSync(PID_FILE);
          if (!silent) {
            showStoppedMessage();
          }
          callback && callback();
        }
      }, 200);

    } catch (err) {
      // 进程不存在
      spinner.warn(chalk.yellow('Process not found'));
      fs.unlinkSync(PID_FILE);
      if (!silent) {
        showStoppedMessage();
      }
      callback && callback();
    }
  } catch (err) {
    spinner.fail(chalk.red('Failed to stop server'));
    console.log(chalk.red(`\nError: ${err.message}\n`));
  }
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