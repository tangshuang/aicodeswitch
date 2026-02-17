const { spawn } = require('child_process');
const https = require('https');
const path = require('path');
const fs = require('fs');
const os = require('os');
const chalk = require('chalk');
const boxen = require('boxen');
const ora = require('ora');

const PACKAGE_NAME = 'aicodeswitch';
const NPM_REGISTRY = 'registry.npmjs.org';

// 获取当前版本
const getCurrentVersion = () => {
  const packageJsonPath = path.join(__dirname, '..', 'package.json');
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    return packageJson.version;
  } catch (err) {
    return null;
  }
};

// 从 npm 获取最新版本
const getLatestVersion = () => {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: NPM_REGISTRY,
      path: `/${PACKAGE_NAME}`,
      method: 'GET',
      headers: {
        'User-Agent': 'aicodeswitch-upgrade'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const packageInfo = JSON.parse(data);
          resolve(packageInfo['dist-tags'].latest);
        } catch (err) {
          reject(new Error('Failed to parse npm response'));
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.end();
  });
};

// 执行命令
const execCommand = (command, args, options = {}) => {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: options.silent ? 'pipe' : 'inherit',
      ...options
    });

    let output = '';
    let errorOutput = '';

    if (options.silent) {
      proc.stdout.on('data', (data) => {
        output += data.toString();
      });
      proc.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });
    }

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ output, errorOutput });
      } else {
        reject({ code, output, errorOutput });
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
};

// 检查是否需要 sudo 权限
const needsSudo = () => {
  const npmPrefix = process.env.npm_config_prefix || '/usr/local';
  const globalInstallPath = path.join(npmPrefix, 'lib', 'node_modules');
  const aicosPath = path.join(globalInstallPath, PACKAGE_NAME);

  // 如果全局安装路径存在且不可写，可能需要 sudo
  if (fs.existsSync(globalInstallPath)) {
    try {
      fs.accessSync(globalInstallPath, fs.constants.W_OK);
      return false;
    } catch (err) {
      return true;
    }
  }

  // 检查当前 aicos 安装位置
  const currentLink = path.join(__dirname, 'cli.js');
  const realPath = fs.realpathSync(currentLink);

  // 如果在全局目录下，需要检查权限
  if (realPath.includes('/usr/local/') || realPath.includes('/usr/lib/')) {
    try {
      fs.accessSync(path.dirname(realPath), fs.constants.W_OK);
      return false;
    } catch (err) {
      return true;
    }
  }

  return false;
};

// 比较版本号
const compareVersions = (v1, v2) => {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    if (parts1[i] > parts2[i]) return 1;
    if (parts1[i] < parts2[i]) return -1;
  }
  return 0;
};

// 主升级逻辑
const upgrade = async () => {
  console.log('\n');

  const currentVersion = getCurrentVersion();
  if (!currentVersion) {
    console.log(boxen(
      chalk.red.bold('✗ Failed to read current version\n\n') +
      chalk.white('Please reinstall the package.'),
      {
        padding: 1,
        margin: 1,
        borderStyle: 'round',
        borderColor: 'red'
      }
    ));
    console.log('');
    process.exit(1);
  }

  // 显示当前版本
  console.log(chalk.cyan('📦 Current Version: ') + chalk.white.bold(currentVersion));
  console.log('');

  // 检查最新版本
  const checkSpinner = ora({
    text: chalk.cyan('Checking for updates...'),
    color: 'cyan',
    hideCursor: false
  }).start();

  let latestVersion;
  try {
    latestVersion = await getLatestVersion();
    checkSpinner.succeed(chalk.green('Checked for updates'));
  } catch (err) {
    checkSpinner.fail(chalk.red('Failed to check for updates'));
    console.log(chalk.yellow(`\nError: ${err.message}\n`));
    console.log(chalk.white('You can manually upgrade by running:\n'));
    console.log(chalk.cyan('  npm install -g aicodeswitch\n'));
    process.exit(1);
  }

  console.log(chalk.cyan('📦 Latest Version:  ') + chalk.white.bold(latestVersion));
  console.log('');

  // 比较版本
  const versionCompare = compareVersions(latestVersion, currentVersion);

  if (versionCompare <= 0) {
    console.log(boxen(
      chalk.green.bold('✓ You are already using the latest version!\n\n') +
      chalk.white(`Current version: ${chalk.cyan.bold(currentVersion)}\n`) +
      chalk.white(`Latest version:  ${chalk.cyan.bold(latestVersion)}`),
      {
        padding: 1,
        margin: 1,
        borderStyle: 'round',
        borderColor: 'green'
      }
    ));
    console.log('');
    process.exit(0);
  }

  // 有新版本可用
  console.log(boxen(
    chalk.yellow.bold('⬆️  New version available!\n\n') +
    chalk.white('Current: ') + chalk.gray(currentVersion) + '\n' +
    chalk.white('Latest:  ') + chalk.green.bold(latestVersion) + '\n\n' +
    chalk.gray('Preparing to upgrade...'),
    {
      padding: 1,
      margin: 1,
      borderStyle: 'round',
      borderColor: 'yellow'
    }
  ));
  console.log('');

  // 检查是否需要 sudo
  const needSudo = needsSudo();

  // 如果需要 sudo，显示提示让用户手动执行
  if (needSudo) {
    console.log(boxen(
      chalk.yellow.bold('⚠️  Sudo privileges required\n\n') +
      chalk.white('This operation requires ') + chalk.yellow.bold('sudo') + chalk.white(' privileges.\n\n') +
      chalk.white('Please run the following command to upgrade:\n\n') +
      chalk.cyan.bold('  sudo npm install -g ' + PACKAGE_NAME + '@latest\n\n') +
      chalk.gray('After upgrading, run ') + chalk.cyan('aicos restart') + chalk.gray(' to restart the server.'),
      {
        padding: 1,
        margin: 1,
        borderStyle: 'round',
        borderColor: 'yellow'
      }
    ));
    console.log('');
    process.exit(0);
  }

  // 执行升级
  const upgradeSpinner = ora({
    text: chalk.cyan('Upgrading to latest version...'),
    color: 'cyan'
  }).start();

  try {
    await execCommand('npm', ['install', '-g', `${PACKAGE_NAME}@latest`]);
    upgradeSpinner.succeed(chalk.green('Upgrade successful!'));
  } catch (err) {
    upgradeSpinner.fail(chalk.red('Upgrade failed'));
    console.log(chalk.yellow(`\nUpgrade failed with error code ${err.code || 'unknown'}\n`));
    console.log(chalk.white('You can try manually upgrading:\n'));
    console.log(chalk.cyan(`  npm install -g ${PACKAGE_NAME}@latest\n`));
    process.exit(1);
  }

  console.log('');
  console.log(boxen(
    chalk.green.bold('✓ Successfully upgraded!\n\n') +
    chalk.white('Previous version: ') + chalk.gray(currentVersion) + '\n' +
    chalk.white('New version:     ') + chalk.green.bold(latestVersion),
    {
      padding: 1,
      margin: 1,
      borderStyle: 'double',
      borderColor: 'green'
    }
  ));
  console.log('');
  console.log(chalk.cyan('💡 Tips:\n'));
  console.log(chalk.white('  • Restart server: ') + chalk.cyan('aicos restart'));
  console.log(chalk.white('  • Check version: ') + chalk.cyan('aicos version'));
  console.log('\n');
};

module.exports = upgrade;
