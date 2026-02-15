#!/usr/bin/env node

const args = process.argv.slice(2);
const command = args[0];

const commands = {
  start: require('./start'),
  stop: require('./stop'),
  restart: require('./restart'),
  upgrade: require('./upgrade'),
  restore: require('./restore'),
  version: require('./version'),
  ui: require('./ui'),
};

if (!command || !commands[command]) {
  console.log(`
Usage: aicos <command>

Commands:
  start      Start the AI Code Switch server
  stop       Stop the AI Code Switch server
  restart    Restart the AI Code Switch server
  ui         Open the web UI in browser (starts server if needed)
  upgrade    Upgrade to the latest version and restart
  restore    Restore original configuration files
  version    Show current version information

Example:
  aicos start
  aicos stop
  aicos restart
  aicos ui
  aicos upgrade
  aicos restore
  aicos restore claude-code
  aicos restore codex
  aicos version
  `);
  process.exit(1);
}

commands[command]();
