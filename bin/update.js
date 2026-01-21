const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { spawn } = require('child_process');
const chalk = require('chalk');
const ora = require('ora');
const boxen = require('boxen');

const AICOSWITCH_DIR = path.join(os.homedir(), '.aicodeswitch');
const RELEASES_DIR = path.join(AICOSWITCH_DIR, 'releases');
const CURRENT_FILE = path.join(AICOSWITCH_DIR, 'current');
const PACKAGE_NAME = 'aicodeswitch';
const NPM_REGISTRY = 'https://registry.npmjs.org';

// 确保目录存在
const ensureDir = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};

// 获取当前使用的版本（从 current 文件或本地 package.json）
const getCurrentVersion = () => {
  // 先检查是否有 current 文件（更新的版本）
  if (fs.existsSync(CURRENT_FILE)) {
    try {
      const currentPath = fs.readFileSync(CURRENT_FILE, 'utf-8').trim();
      const currentPackageJson = path.join(currentPath, 'package.json');
      if (fs.existsSync(currentPackageJson)) {
        const pkg = JSON.parse(fs.readFileSync(currentPackageJson, 'utf-8'));
        return pkg.version;
      }
    } catch (err) {
      // 读取失败，fallback 到本地版本
    }
  }

  // 使用本地 package.json
  try {
    const packageJson = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(packageJson, 'utf-8'));
    return pkg.version;
  } catch (err) {
    return '0.0.0';
  }
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

// 从 npm registry 获取最新版本
const getLatestVersion = () => {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'registry.npmjs.org',
      path: `/${PACKAGE_NAME}`,
      method: 'GET',
      headers: {
        'User-Agent': 'aicodeswitch'
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
          const latestVersion = packageInfo['dist-tags'].latest;
          resolve({
            version: latestVersion,
            tarball: packageInfo.versions[latestVersion].dist.tarball
          });
        } catch (err) {
          reject(new Error('Failed to parse package info from npm'));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
};

// 使用 npm 安装指定版本到指定目录
const installPackage = (version, targetDir) => {
  return new Promise((resolve, reject) => {
    const npmProcess = spawn('npm', [
      'install',
      `${PACKAGE_NAME}@${version}`,
      '--prefix',
      targetDir,
      '--no-save',
      '--no-package-lock',
      '--no-bin-links'
    ]);

    let stderr = '';

    npmProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    npmProcess.on('close', (code) => {
      if (code === 0) {
        // npm install 会把包安装到 targetDir/node_modules/ 目录下
        const packageDir = path.join(targetDir, 'node_modules', PACKAGE_NAME);
        if (fs.existsSync(packageDir)) {
          resolve(packageDir);
        } else {
          reject(new Error('Package installation directory not found'));
        }
      } else {
        reject(new Error(`npm install failed: ${stderr}`));
      }
    });

    npmProcess.on('error', reject);
  });
};

// 更新 current 文件
const updateCurrentFile = (versionPath) => {
  fs.writeFileSync(CURRENT_FILE, versionPath);
};

// 执行 restart
const restart = () => {
  return new Promise((resolve, reject) => {
    const restartScript = path.join(__dirname, 'restart.js');

    const restartProcess = spawn('node', [restartScript], {
      stdio: 'inherit'
    });

    restartProcess.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Restart failed with exit code ${code}`));
      }
    });

    restartProcess.on('error', reject);
  });
};

// 主更新逻辑
const update = async () => {
  console.log('\n');

  const currentVersion = getCurrentVersion();
  const spinner = ora({
    text: chalk.cyan('Checking for updates...'),
    color: 'cyan'
  }).start();

  try {
    // 获取最新版本信息
    const latestInfo = await getLatestVersion();
    const latestVersion = latestInfo.version;

    spinner.succeed(chalk.green(`Latest version: ${chalk.bold(latestVersion)}`));

    // 检查是否需要更新
    const comparison = compareVersions(latestVersion, currentVersion);

    if (comparison <= 0) {
      console.log(chalk.yellow(`\n✓ You are already on the latest version (${chalk.bold(currentVersion)})\n`));
      process.exit(0);
      return;
    }

    console.log(chalk.cyan(`\n📦 Update available: ${chalk.bold(currentVersion)} → ${chalk.bold(latestVersion)}\n`));

    // 确保目录存在
    ensureDir(RELEASES_DIR);

    // 安装新版本
    const installSpinner = ora({
      text: chalk.cyan('Downloading and installing from npm...'),
      color: 'cyan'
    }).start();

    const versionDir = path.join(RELEASES_DIR, latestVersion);
    ensureDir(versionDir);

    try {
      const packageDir = await installPackage(latestVersion, versionDir);
      installSpinner.succeed(chalk.green('Package installed'));
    } catch (err) {
      installSpinner.fail(chalk.red('Installation failed'));
      console.log(chalk.red(`Error: ${err.message}\n`));
      process.exit(1);
      return;
    }

    // 实际的包在 node_modules/aicodeswitch 目录下
    const actualPackageDir = path.join(versionDir, 'node_modules', PACKAGE_NAME);
    updateCurrentFile(actualPackageDir);

    // 显示更新成功信息
    console.log(boxen(
      chalk.green.bold('✨ Update Successful!\n\n') +
      chalk.white('Version:  ') + chalk.cyan.bold(latestVersion) + '\n' +
      chalk.white('Location: ') + chalk.gray(actualPackageDir) + '\n\n' +
      chalk.gray('Restarting server with the new version...'),
      {
        padding: 1,
        margin: 1,
        borderStyle: 'double',
        borderColor: 'green'
      }
    ));

    // 重启服务器
    try {
      await restart();
    } catch (err) {
      console.log(chalk.yellow(`\n⚠️  Update completed, but restart failed: ${err.message}`));
      console.log(chalk.cyan('Please manually run: ') + chalk.yellow('aicos restart\n'));
      process.exit(1);
      return;
    }

    process.exit(0);

  } catch (err) {
    spinner.fail(chalk.red('Update check failed'));
    console.log(chalk.red(`Error: ${err.message}\n`));
    console.log(chalk.gray('You can check for updates manually at:\n'));
    console.log(chalk.cyan('  https://www.npmjs.com/package/aicodeswitch\n'));
    process.exit(1);
  }
};

module.exports = update();
