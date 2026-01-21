const fs = require('fs');
const path = require('path');
const os = require('os');
const chalk = require('chalk');
const boxen = require('boxen');
const ora = require('ora');

const PID_FILE = path.join(os.homedir(), '.aicodeswitch', 'server.pid');

const stop = () => {
  console.log('\n');

  if (!fs.existsSync(PID_FILE)) {
    console.log(boxen(
      chalk.yellow.bold('⚠ Server is not running'),
      {
        padding: 1,
        margin: 1,
        borderStyle: 'round',
        borderColor: 'yellow'
      }
    ));
    console.log('\n');
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
            showStoppedMessage();
          }
        } catch (err) {
          // 进程已停止
          clearInterval(checkStopped);
          spinner.succeed(chalk.green('Server stopped successfully'));
          fs.unlinkSync(PID_FILE);
          showStoppedMessage();
        }
      }, 200);

    } catch (err) {
      // 进程不存在
      spinner.warn(chalk.yellow('Process not found'));
      fs.unlinkSync(PID_FILE);
      showStoppedMessage();
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

module.exports = stop();
