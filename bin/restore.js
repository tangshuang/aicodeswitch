const fs = require('fs');
const path = require('path');
const os = require('os');
const chalk = require('chalk');
const boxen = require('boxen');
const ora = require('ora');

// 停用所有激活的路由（直接操作数据库文件）
const deactivateAllRoutes = () => {
  const appDir = path.join(os.homedir(), '.aicodeswitch');
  const primaryRoutesFilePath = path.join(appDir, 'fs-db', 'routes.json');
  const legacyRoutesFilePath = path.join(appDir, 'data', 'routes.json');
  const routesFilePath = fs.existsSync(primaryRoutesFilePath)
    ? primaryRoutesFilePath
    : legacyRoutesFilePath;

  // 如果数据文件不存在，说明没有路由需要停用
  if (!fs.existsSync(routesFilePath)) {
    return { success: true, deactivatedCount: 0, reason: 'no_data_file' };
  }

  try {
    // 读取路由数据
    const routesData = JSON.parse(fs.readFileSync(routesFilePath, 'utf-8'));

    let routes = [];
    let payload = routesData;

    if (Array.isArray(routesData)) {
      routes = routesData;
      payload = routesData;
    } else if (routesData && typeof routesData === 'object' && Array.isArray(routesData.routes)) {
      routes = routesData.routes;
      payload = { ...routesData, routes };
    } else {
      return { success: false, error: 'Invalid routes data format' };
    }

    let deactivatedCount = 0;

    // 将所有激活的路由设置为停用状态
    routes.forEach(route => {
      if (route.isActive === true) {
        route.isActive = false;
        deactivatedCount++;
      }
    });

    // 保存修改后的数据
    fs.writeFileSync(routesFilePath, JSON.stringify(payload, null, 2));

    return { success: true, deactivatedCount };
  } catch (err) {
    return { success: false, error: err.message };
  }
};

// 恢复 Claude Code 配置
const restoreClaudeConfig = () => {
  const results = {
    restored: [],
    notFound: [],
    errors: []
  };

  try {
    const homeDir = os.homedir();
    const claudeDir = path.join(homeDir, '.claude');
    const claudeSettingsPath = path.join(claudeDir, 'settings.json');
    const claudeSettingsBakPath = path.join(claudeDir, 'settings.json.aicodeswitch_backup');

    // Restore settings.json
    if (fs.existsSync(claudeSettingsBakPath)) {
      if (fs.existsSync(claudeSettingsPath)) {
        fs.unlinkSync(claudeSettingsPath);
      }
      fs.renameSync(claudeSettingsBakPath, claudeSettingsPath);
      results.restored.push('settings.json');
    } else {
      results.notFound.push('settings.json.aicodeswitch_backup');
    }
  } catch (err) {
    results.errors.push({ file: 'settings.json', error: err.message });
  }

  try {
    const homeDir = os.homedir();
    const claudeJsonPath = path.join(homeDir, '.claude.json');
    const claudeJsonBakPath = path.join(homeDir, '.claude.json.aicodeswitch_backup');

    // Restore .claude.json
    if (fs.existsSync(claudeJsonBakPath)) {
      if (fs.existsSync(claudeJsonPath)) {
        fs.unlinkSync(claudeJsonPath);
      }
      fs.renameSync(claudeJsonBakPath, claudeJsonPath);
      results.restored.push('.claude.json');
    } else {
      results.notFound.push('.claude.json.aicodeswitch_backup');
    }
  } catch (err) {
    results.errors.push({ file: '.claude.json', error: err.message });
  }

  return results;
};

// 恢复 Codex 配置
const restoreCodexConfig = () => {
  const results = {
    restored: [],
    notFound: [],
    errors: []
  };

  try {
    const homeDir = os.homedir();
    const codexDir = path.join(homeDir, '.codex');
    const codexConfigPath = path.join(codexDir, 'config.toml');
    const codexConfigBakPath = path.join(codexDir, 'config.toml.aicodeswitch_backup');

    // Restore config.toml
    if (fs.existsSync(codexConfigBakPath)) {
      if (fs.existsSync(codexConfigPath)) {
        fs.unlinkSync(codexConfigPath);
      }
      fs.renameSync(codexConfigBakPath, codexConfigPath);
      results.restored.push('config.toml');
    } else {
      results.notFound.push('config.toml.aicodeswitch_backup');
    }
  } catch (err) {
    results.errors.push({ file: 'config.toml', error: err.message });
  }

  try {
    const homeDir = os.homedir();
    const codexAuthPath = path.join(homeDir, '.codex', 'auth.json');
    const codexAuthBakPath = path.join(homeDir, '.codex', 'auth.json.aicodeswitch_backup');

    // Restore auth.json
    if (fs.existsSync(codexAuthBakPath)) {
      if (fs.existsSync(codexAuthPath)) {
        fs.unlinkSync(codexAuthPath);
      }
      fs.renameSync(codexAuthBakPath, codexAuthPath);
      results.restored.push('auth.json');
    } else {
      results.notFound.push('auth.json.aicodeswitch_backup');
    }
  } catch (err) {
    results.errors.push({ file: 'auth.json', error: err.message });
  }

  return results;
};

// 显示恢复结果
const showRestoreResult = (target, results) => {
  const targetName = target === 'claude-code' ? 'Claude Code' : 'Codex';
  const targetColor = target === 'claude-code' ? chalk.cyan : chalk.magenta;

  let message = targetColor.bold(`${targetName} Configuration Restore\n\n`);

  if (results.restored.length > 0) {
    message += chalk.green('Restored files:\n');
    results.restored.forEach(file => {
      message += chalk.white(`  ✓ ${file}\n`);
    });
    message += '\n';
  }

  if (results.notFound.length > 0) {
    message += chalk.gray('No backup found:\n');
    results.notFound.forEach(file => {
      message += chalk.gray(`  - ${file}\n`);
    });
    message += '\n';
  }

  if (results.errors.length > 0) {
    message += chalk.red('Errors:\n');
    results.errors.forEach(({ file, error }) => {
      message += chalk.red(`  ✗ ${file}: ${error}\n`);
    });
    message += '\n';
  }

  // 添加重启提示
  if (results.restored.length > 0) {
    message += chalk.yellow.bold('⚠️  Important:\n\n');
    if (target === 'claude-code') {
      message += chalk.white('Please restart ') + chalk.cyan.bold('Claude Code') + chalk.white(' to apply the restored configuration.\n');
    } else {
      message += chalk.white('Please restart ') + chalk.magenta.bold('Codex') + chalk.white(' to apply the restored configuration.\n');
    }
  }

  const borderColor = results.errors.length > 0 ? 'red' :
                     results.restored.length > 0 ? 'green' : 'gray';

  console.log(boxen(message, {
    padding: 1,
    margin: 1,
    borderStyle: 'round',
    borderColor
  }));
};

// 主恢复逻辑
const restore = async () => {
  const args = process.argv.slice(2);
  // 处理两种情况：
  // 1. 直接执行: node bin/restore.js claude-code => args[0]
  // 2. 通过 aicos: aicos restore claude-code => args[1] (因为 args[0] 是 'restore')
  let target;
  if (args[0] === 'restore') {
    target = args[1];
  } else {
    target = args[0];
  }

  console.log('\n');

  const validTargets = ['claude-code', 'codex', undefined];

  if (target && !validTargets.includes(target)) {
    console.log(boxen(
      chalk.red.bold('✗ Invalid target\n\n') +
      chalk.white('Usage: ') + chalk.cyan('aicos restore [target]\n\n') +
      chalk.white('Targets:\n') +
      chalk.white('  claude-code   Restore Claude Code configuration\n') +
      chalk.white('  codex         Restore Codex configuration\n') +
      chalk.white('  (no arg)      Restore all configurations\n'),
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

  // 恢复配置
  if (target === 'claude-code' || !target) {
    const spinner = ora({
      text: chalk.cyan('Restoring Claude Code configuration...'),
      color: 'cyan'
    }).start();

    const claudeResults = restoreClaudeConfig();
    spinner.succeed(chalk.green('Claude Code restore complete'));
    showRestoreResult('claude-code', claudeResults);
  }

  if (target === 'codex' || !target) {
    if (!target) console.log(''); // Add spacing when restoring both

    const spinner = ora({
      text: chalk.magenta('Restoring Codex configuration...'),
      color: 'magenta'
    }).start();

    const codexResults = restoreCodexConfig();
    spinner.succeed(chalk.green('Codex restore complete'));
    showRestoreResult('codex', codexResults);
  }

  // 停用所有激活的路由
  console.log('');
  const routesSpinner = ora({
    text: chalk.yellow('Deactivating all active routes...'),
    color: 'yellow'
  }).start();

  const routesResult = deactivateAllRoutes();

  if (routesResult.success) {
    if (routesResult.deactivatedCount > 0) {
      routesSpinner.succeed(chalk.green(`Deactivated ${routesResult.deactivatedCount} active route(s)`));
    } else {
      routesSpinner.info(chalk.gray('No active routes to deactivate'));
    }
  } else {
    routesSpinner.fail(chalk.red(`Failed to deactivate routes: ${routesResult.error}`));
  }

  console.log('');
  console.log(chalk.cyan('💡 Tips:\n'));
  console.log(chalk.white('  • Restart server:   ') + chalk.cyan('aicos restart'));
  console.log(chalk.white('  • Start server:   ') + chalk.cyan('aicos start'));
  console.log('\n');
};

module.exports = restore;
