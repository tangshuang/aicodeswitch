const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const srcDist = path.join(repoRoot, 'dist');
const srcPackage = path.join(repoRoot, 'package.json');
const srcNodeModules = path.join(repoRoot, 'node_modules');
const index = path.join(repoRoot, 'tauri/screens/index.html');
const shouldPruneDevDeps = process.env.TAURI_PRUNE_DEPS !== 'false';

// 资源复制到项目根目录的 resources/（Tauri 的 bundle.resources 路径相对于项目根目录）
const destRoot = path.join(repoRoot, 'tauri/resources');
const destDist = path.join(destRoot, 'dist');
const destNodeModules = path.join(destRoot, 'node_modules');
const indexDestRoot = path.join(destRoot, 'screens');


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
fs.mkdirSync(indexDestRoot, { recursive: true });
fs.cpSync(srcDist, destDist, { recursive: true });
fs.copyFileSync(srcPackage, path.join(destRoot, 'package.json'));
fs.copyFileSync(index, path.join(indexDestRoot, 'index.html'));

if (fs.existsSync(srcNodeModules)) {
  fs.rmSync(destNodeModules, { recursive: true, force: true });
  fs.cpSync(srcNodeModules, destNodeModules, { recursive: true, dereference: true });
  console.log('[tauri] node_modules copied to', destNodeModules);
  if (shouldPruneDevDeps) {
    try {
      const { execFileSync } = require('child_process');
      console.log('[tauri] pruning dev dependencies from node_modules...');
      execFileSync('npm', ['prune', '--omit=dev', '--no-audit', '--no-fund'], {
        cwd: destRoot,
        stdio: 'inherit'
      });
      console.log('[tauri] dev dependencies pruned');
    } catch (error) {
      console.warn('[tauri] failed to prune dev dependencies:', error?.message || error);
    }
  }
} else {
  console.warn('[tauri] node_modules not found, backend dependencies may be missing at runtime');
}

console.log('[tauri] resources prepared at', destRoot);
console.log('[tauri] files to be packaged:');
console.log('  - dist/');
console.log('  - package.json');
console.log('  - index.html');
console.log('  - node_modules/');
