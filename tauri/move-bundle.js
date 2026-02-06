const fs = require('fs');
const path = require('path');

const sourceDir = path.join(__dirname, 'target', 'release', 'bundle');
const targetDir = path.join(__dirname, 'target', 'bundle');

console.log('Moving bundle files...');

// 确保目标目录存在
if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

// 检查源目录是否存在
if (!fs.existsSync(sourceDir)) {
  console.log(`Source directory not found: ${sourceDir}`);
  console.log('No bundle files to move.');
  process.exit(0);
}

// 读取源目录内容
const items = fs.readdirSync(sourceDir);

let movedCount = 0;

// 移动每个子目录
for (const item of items) {
  const sourcePath = path.join(sourceDir, item);
  const targetPath = path.join(targetDir, item);

  // 如果目标已存在，先删除
  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }

  // 移动目录
  fs.renameSync(sourcePath, targetPath);
  movedCount++;
  console.log(`Moved: ${item}`);
}

console.log(`\n✓ Moved ${movedCount} bundle(s) to ${targetDir}`);
