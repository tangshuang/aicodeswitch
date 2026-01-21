#!/usr/bin/env node

const path = require('path');

const args = process.argv.slice(2);
const command = args[0];

const commands = {
  start: () => require(path.join(__dirname, 'start')),
  stop: () => require(path.join(__dirname, 'stop')),
  restart: () => require(path.join(__dirname, 'restart')),
  update: () => require(path.join(__dirname, 'update')),
  restore: () => require(path.join(__dirname, 'restore')),
  version: () => require(path.join(__dirname, 'version')),
};

if (!command || !commands[command]) {
  console.log(`
Usage: aicos <command>

Commands:
  start      Start the AI Code Switch server
  stop       Stop the AI Code Switch server
  restart    Restart the AI Code Switch server
  update     Update to the latest version and restart
  restore    Restore original configuration files
  version    Show current version information

Example:
  aicos start
  aicos stop
  aicos restart
  aicos update
  aicos restore
  aicos restore claude-code
  aicos restore codex
  aicos version
  `);
  process.exit(1);
}

commands[command]();
