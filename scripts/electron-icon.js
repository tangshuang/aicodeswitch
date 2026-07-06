/**
 * 将源 logo 复制为 electron-builder 使用的 build/icon.png。
 *
 * electron-builder 在打包时会自动从 build/icon.png（≥512x512）生成各平台
 * 所需的 .ico / .icns 等格式，因此无需依赖外部图标生成工具。
 *
 * 触发：npm run electron:icon
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..', 'src', 'ui', 'assets', 'logo.png');
const BUILD_DIR = path.resolve(__dirname, '..', 'build');
const DEST = path.join(BUILD_DIR, 'icon.png');

if (!fs.existsSync(SRC)) {
  console.error(`[electron-icon] 源文件不存在: ${SRC}`);
  process.exit(1);
}

if (!fs.existsSync(BUILD_DIR)) {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
}

fs.copyFileSync(SRC, DEST);
console.log(`[electron-icon] 已生成 ${path.relative(path.resolve(__dirname, '..'), DEST)}`);
console.log('[electron-icon] electron-builder 会在打包时据此自动生成 .ico/.icns。');
