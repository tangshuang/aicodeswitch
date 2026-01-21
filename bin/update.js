const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const chalk = require('chalk');
const ora = require('ora');
const boxen = require('boxen');
const tar = require('tar');

const AICOSWITCH_DIR = path.join(os.homedir(), '.aicodeswitch');
const RELEASES_DIR = path.join(AICOSWITCH_DIR, 'releases');
const CURRENT_FILE = path.join(AICOSWITCH_DIR, 'current');
const PACKAGE_NAME = 'aicodeswitch';

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

// 下载 tarball 文件
const downloadTarball = (url, destPath) => {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const protocol = urlObj.protocol === 'http:' ? http : https;

    const requestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': 'aicodeswitch'
      }
    };

    const req = protocol.request(requestOptions, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Failed to download: HTTP ${res.statusCode}`));
        return;
      }

      const fileStream = fs.createWriteStream(destPath);
      res.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close();
        resolve(destPath);
      });

      fileStream.on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    });

    req.on('error', (err) => {
      if (fs.existsSync(destPath)) {
        fs.unlink(destPath, () => {});
      }
      reject(err);
    });

    req.setTimeout(60000, () => {
      req.destroy();
      if (fs.existsSync(destPath)) {
        fs.unlink(destPath, () => {});
      }
      reject(new Error('Download timeout'));
    });

    req.end();
  });
};

// 解压 tarball 到指定目录
const extractTarball = (tarballPath, destDir) => {
  return tar.x({
    file: tarballPath,
    cwd: destDir,
    strip: 1, // 去掉 package 目录层级
  });
};

// 安装 npm 依赖
const installDependencies = (dir) => {
  return new Promise((resolve, reject) => {
    console.log(chalk.cyan('Installing dependencies...'));

    const installProcess = spawn('npm', ['install', '--production'], {
      cwd: dir,
      stdio: 'inherit'
    });

    installProcess.on('close', (code) => {
      if (code === 0) {
        console.log(chalk.green('Dependencies installed successfully'));
        resolve();
      } else {
        reject(new Error(`npm install failed with exit code ${code}`));
      }
    });

    installProcess.on('error', reject);
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

// 清理旧版本的下载文件（保留最近 3 个版本）
const cleanupOldVersions = () => {
  try {
    if (!fs.existsSync(RELEASES_DIR)) {
      return;
    }

    const versions = fs.readdirSync(RELEASES_DIR)
      .filter(item => {
        const itemPath = path.join(RELEASES_DIR, item);
        return fs.statSync(itemPath).isDirectory();
      })
      .sort((a, b) => {
        // 按版本号降序排序
        return compareVersions(b, a);
      });

    // 保留最近 3 个版本，删除其他版本
    if (versions.length > 3) {
      const versionsToDelete = versions.slice(3);
      versionsToDelete.forEach(version => {
        const versionPath = path.join(RELEASES_DIR, version);
        fs.rmSync(versionPath, { recursive: true, force: true });
      });
    }
  } catch (err) {
    // 清理失败不影响更新流程
    console.error(chalk.yellow(`Warning: Failed to cleanup old versions: ${err.message}`));
  }
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
    }

    console.log(chalk.cyan(`\n📦 Update available: ${chalk.bold(currentVersion)} → ${chalk.bold(latestVersion)}\n`));

    // 确保目录存在
    ensureDir(RELEASES_DIR);

    // 创建版本目录
    const versionDir = path.join(RELEASES_DIR, latestVersion);
    ensureDir(versionDir);

    // 下载 tarball
    const downloadSpinner = ora({
      text: chalk.cyan('Downloading from npm...'),
      color: 'cyan'
    }).start();

    const tarballPath = path.join(versionDir, 'package.tgz');

    try {
      await downloadTarball(latestInfo.tarball, tarballPath);
      downloadSpinner.succeed(chalk.green('Download completed'));
    } catch (err) {
      downloadSpinner.fail(chalk.red('Download failed'));
      console.log(chalk.red(`Error: ${err.message}\n`));
      process.exit(1);
    }

    // 解压 tarball
    const extractSpinner = ora({
      text: chalk.cyan('Extracting package...'),
      color: 'cyan'
    }).start();

    try {
      await extractTarball(tarballPath, versionDir);
      extractSpinner.succeed(chalk.green('Package extracted'));
    } catch (err) {
      extractSpinner.fail(chalk.red('Extraction failed'));
      console.log(chalk.red(`Error: ${err.message}\n`));
      process.exit(1);
    } finally {
      // 删除 tarball 文件
      if (fs.existsSync(tarballPath)) {
        fs.unlinkSync(tarballPath);
      }
    }

    // 安装依赖
    const installSpinner = ora({
      text: chalk.cyan('Installing dependencies...'),
      color: 'cyan'
    }).start();

    try {
      await installDependencies(versionDir);
      installSpinner.succeed(chalk.green('Dependencies installed'));
    } catch (err) {
      installSpinner.fail(chalk.red('Dependencies installation failed'));
      console.log(chalk.red(`Error: ${err.message}\n`));
      process.exit(1);
    }

    // 更新 current 文件
    updateCurrentFile(versionDir);

    // 清理旧版本
    cleanupOldVersions();

    // 显示更新成功信息
    console.log(boxen(
      chalk.green.bold('✨ Update Successful!\n\n') +
      chalk.white('Version:  ') + chalk.cyan.bold(latestVersion) + '\n' +
      chalk.white('Location: ') + chalk.gray(versionDir) + '\n\n' +
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
