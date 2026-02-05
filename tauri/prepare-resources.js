const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const srcDist = path.join(repoRoot, 'dist');
const srcPackage = path.join(repoRoot, 'package.json');
const index = path.join(repoRoot, 'tauri/ui/index.html');

// 资源复制到项目根目录的 resources/（Tauri 的 bundle.resources 路径相对于项目根目录）
const destRoot = path.join(repoRoot, 'tauri/resources');
const destDist = path.join(destRoot, 'dist');


if (!fs.existsSync(srcDist)) {
  console.error('[tauri] dist/ not found. Run npm run build first.');
  process.exit(1);
}

// 移除release目录
const releaseRoot = path.join(repoRoot, 'tauri/target/release');
fs.rmSync(releaseRoot, { recursive: true, force: true });

console.log('[tauri] release directory removed at', releaseRoot);

// 清理并重新创建 resources 目录
fs.rmSync(destRoot, { recursive: true, force: true });
fs.mkdirSync(destRoot, { recursive: true });
fs.cpSync(srcDist, destDist, { recursive: true });
fs.copyFileSync(srcPackage, path.join(destRoot, 'package.json'));
fs.copyFileSync(index, path.join(destRoot, 'index.html'));

console.log('[tauri] resources prepared at', destRoot);
console.log('[tauri] files to be packaged:');
console.log('  - dist/');
console.log('  - package.json');
console.log('  - index.html');

