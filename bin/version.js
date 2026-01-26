const path = require('path');
const fs = require('fs');
const chalk = require('chalk');
const boxen = require('boxen');

const getVersionInfo = () => {
  try {
    const packageJson = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(packageJson, 'utf-8'));

    return {
      version: pkg.version,
      path: path.dirname(packageJson)
    };
  } catch (err) {
    return {
      version: 'unknown',
      path: 'unknown'
    };
  }
};

const version = () => {
  const info = getVersionInfo();

  console.log('\n');

  console.log(boxen(
    chalk.cyan.bold('AI Code Switch\n\n') +
    chalk.white('Version:  ') + chalk.cyan.bold(info.version) + '\n' +
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
  console.log(chalk.white('  • Restart server:     ') + chalk.yellow('aicos restart\n'));

  process.exit(0);
};

module.exports = version;
