#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const os = require('os');

const args = process.argv.slice(2);
const command = args[0];

// 检查是否有更新版本的 current 文件
const CURRENT_FILE = path.join(os.homedir(), '.aicodeswitch', 'current');

let binDir = __dirname;
let useLocalVersion = true;

// 如果存在 current 文件，使用更新版本的脚本
if (fs.existsSync(CURRENT_FILE)) {
  try {
    const currentPath = fs.readFileSync(CURRENT_FILE, 'utf-8').trim();
    const currentBinDir = path.join(currentPath, 'bin');

    // 检查新版本的 bin 目录是否存在
    if (fs.existsSync(currentBinDir) && fs.existsSync(path.join(currentBinDir, 'cli.js'))) {
      binDir = currentBinDir;
      useLocalVersion = false;
    }
  } catch (err) {
    // 读取失败，使用本地版本
  }
}

const commands = {
  start: () => require(path.join(binDir, 'start')),
  stop: () => require(path.join(binDir, 'stop')),
  restart: () => require(path.join(binDir, 'restart')),
  update: () => require(path.join(binDir, 'update')),
  version: () => require(path.join(binDir, 'version')),
};

if (!command || !commands[command]) {
  console.log(`
Usage: aicos <command>

Commands:
  start      Start the AI Code Switch server
  stop       Stop the AI Code Switch server
  restart    Restart the AI Code Switch server
  update     Update to the latest version and restart
  version    Show current version information

Example:
  aicos start
  aicos stop
  aicos restart
  aicos update
  aicos version
  `);
  process.exit(1);
}

commands[command]();
