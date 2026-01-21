#!/usr/bin/env node

const args = process.argv.slice(2);
const command = args[0];

const commands = {
  start: () => require('./start'),
  stop: () => require('./stop'),
  restart: () => require('./restart'),
};

if (!command || !commands[command]) {
  console.log(`
Usage: aicos <command>

Commands:
  start      Start the AI Code Switch server
  stop       Stop the AI Code Switch server
  restart    Restart the AI Code Switch server

Example:
  aicos start
  aicos stop
  aicos restart
  `);
  process.exit(1);
}

commands[command]();
