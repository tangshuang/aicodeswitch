const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const srcDist = path.join(repoRoot, 'dist');
const srcPackage = path.join(repoRoot, 'package.json');
const index = path.join(repoRoot, 'tauri/screens/index.html');

// 资源复制到项目根目录的 resources/（Tauri 的 bundle.resources 路径相对于项目根目录）
const destRoot = path.join(repoRoot, 'tauri/resources');
const destDist = path.join(destRoot, 'dist');
const indexDestRoot = path.join(destRoot, 'screens');


if (!fs.existsSync(srcDist)) {
  console.error('[tauri] dist/ not found. Run npm run build first.');
  process.exit(1);
}

const iconsDir = path.join(repoRoot, 'tauri/icons');
if (!fs.existsSync(iconsDir)) {
  execFileSync('yarn', ['tauri:icon'], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: true
  });
  console.log('[tauri] icons generated at', iconsDir);
}

// 注意：不要删除 target/release 目录，因为 Tauri 构建需要它
// 之前在这里删除会导致并行编译失败
// const releaseRoot = path.join(repoRoot, 'tauri/target/release');
// fs.rmSync(releaseRoot, { recursive: true, force: true });
console.log('[tauri] skipping release directory cleanup (preserving build artifacts)');

// 清理并重新创建 resources 目录
fs.rmSync(destRoot, { recursive: true, force: true });
fs.mkdirSync(destRoot, { recursive: true });
fs.mkdirSync(indexDestRoot, { recursive: true });
fs.cpSync(srcDist, destDist, { recursive: true });
fs.copyFileSync(index, path.join(indexDestRoot, 'index.html'));


console.log('[tauri] resources prepared at', destRoot);
console.log('[tauri] files to be packaged:');
console.log('  - dist/');
console.log('  - package.json');
console.log('  - index.html');

// 读取 package.json 并移除 devDependencies
const packageJson = JSON.parse(fs.readFileSync(srcPackage, 'utf-8'));
delete packageJson.devDependencies;
delete packageJson.scripts;
delete packageJson.bin;
fs.writeFileSync(
  path.join(destRoot, 'package.json'),
  JSON.stringify(packageJson, null, 2),
  'utf-8'
);
console.log('[tauri] package.json copied (devDependencies, scripts, bin removed)');

// 在 resources 目录执行 yarn 安装
try {
  console.log('[tauri] installing dependencies with yarn...');
  execFileSync('yarn', ['install', '--no-lockfile', '--no-non-interactive'], {
    cwd: destRoot,
    stdio: 'inherit',
    shell: true
  });
  console.log('[tauri] dependencies installed');

  // 删除 node_modules 下 . 开头的所有目录和 @types 目录
  console.log('[tauri] cleaning up node_modules...');
  const nodeModulesPath = path.join(destRoot, 'node_modules');
  if (fs.existsSync(nodeModulesPath)) {
    const entries = fs.readdirSync(nodeModulesPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const name = entry.name;
        // 删除 . 开头的目录
        if (name.startsWith('.')) {
          const fullPath = path.join(nodeModulesPath, name);
          fs.rmSync(fullPath, { recursive: true, force: true });
          console.log('[tauri] removed hidden directory:', name);
        }
        // 删除 @types 目录
        if (name === '@types') {
          const fullPath = path.join(nodeModulesPath, name);
          fs.rmSync(fullPath, { recursive: true, force: true });
          console.log('[tauri] removed @types directory');
        }
      }
    }
  }
  console.log('[tauri] node_modules cleanup completed');
} catch (error) {
  console.warn('[tauri] failed to install dependencies:', error?.message || error);
  process.exit(1);
}

console.log('[tauri] resources prepared at', destRoot);
console.log('  - node_modules/');
