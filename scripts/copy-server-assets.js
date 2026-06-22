/**
 * 构建期把 src/server/assets/* 复制到 dist/server/assets/*。
 * tsc 只编译 .ts，不会带走 .png 等资源；服务端引用的资源（如通知用 logo.png）靠此脚本随包发布。
 * 跨平台（Node，不依赖 shell cp）；源目录不存在时静默跳过。
 */
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'src', 'server', 'assets');
const dest = path.join(__dirname, '..', 'dist', 'server', 'assets');

if (!fs.existsSync(src)) {
  console.log('[copy-server-assets] src 不存在，跳过');
  process.exit(0);
}

fs.mkdirSync(dest, { recursive: true });
const copied = [];
for (const name of fs.readdirSync(src)) {
  fs.copyFileSync(path.join(src, name), path.join(dest, name));
  copied.push(name);
}
console.log('[copy-server-assets] copied:', copied.join(', '));
