const path = require('path');
const fs = require('fs');
const os = require('os');
const chalk = require('chalk');
const boxen = require('boxen');

const AICOSWITCH_DIR = path.join(os.homedir(), '.aicodeswitch');
const CURRENT_FILE = path.join(AICOSWITCH_DIR, 'current');

const getVersionInfo = () => {
  // 先检查是否有 current 文件（更新的版本）
  if (fs.existsSync(CURRENT_FILE)) {
    try {
      const currentPath = fs.readFileSync(CURRENT_FILE, 'utf-8').trim();
      const currentPackageJson = path.join(currentPath, 'package.json');

      if (fs.existsSync(currentPackageJson)) {
        const pkg = JSON.parse(fs.readFileSync(currentPackageJson, 'utf-8'));

        return {
          version: pkg.version,
          source: 'npm',
          path: currentPath,
          isUpdated: true
        };
      }
    } catch (err) {
      // 读取失败，fallback 到本地版本
    }
  }

  // 使用本地 package.json
  try {
    const packageJson = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(packageJson, 'utf-8'));

    return {
      version: pkg.version,
      source: 'local',
      path: path.dirname(packageJson),
      isUpdated: false
    };
  } catch (err) {
    return {
      version: 'unknown',
      source: 'unknown',
      path: 'unknown',
      isUpdated: false
    };
  }
};

const version = () => {
  const info = getVersionInfo();

  console.log('\n');

  if (info.isUpdated) {
    console.log(boxen(
      chalk.green.bold('AI Code Switch\n\n') +
      chalk.white('Version:  ') + chalk.cyan.bold(info.version) + '\n' +
      chalk.white('Source:   ') + chalk.yellow.bold('npm (updated)') + '\n' +
      chalk.white('Location: ') + chalk.gray(info.path),
      {
        padding: 1,
        margin: 1,
        borderStyle: 'double',
        borderColor: 'green'
      }
    ));

    console.log(chalk.cyan('💡 Tips:\n'));
    console.log(chalk.white('  • Check for updates: ') + chalk.yellow('aicos update'));
    console.log(chalk.white('  • Revert to local:   ') + chalk.gray('rm ~/.aicodeswitch/current\n'));
  } else {
    console.log(boxen(
      chalk.cyan.bold('AI Code Switch\n\n') +
      chalk.white('Version:  ') + chalk.cyan.bold(info.version) + '\n' +
      chalk.white('Source:   ') + chalk.yellow.bold('local development') + '\n' +
      chalk.white('Location: ') + chalk.gray(info.path),
      {
        padding: 1,
        margin: 1,
        borderStyle: 'double',
        borderColor: 'cyan'
      }
    ));

    console.log(chalk.cyan('💡 Tips:\n'));
    console.log(chalk.white('  • Check for updates: ') + chalk.yellow('aicos update'));
    console.log(chalk.white('  • Update to latest:  ') + chalk.yellow('aicos update\n'));
  }

  process.exit(0);
};

module.exports = version();
