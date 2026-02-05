const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const srcDist = path.join(repoRoot, 'dist');
const srcPackage = path.join(repoRoot, 'package.json');

const releaseRoot = path.join(__dirname, 'target/release');
const destRoot = path.join(releaseRoot, 'files');
const destDist = path.join(destRoot, 'dist');

if (!fs.existsSync(srcDist)) {
  console.error('[tauri] dist/ not found. Run npm run build first.');
  process.exit(1);
}

if (!fs.existsSync(srcPackage)) {
  console.error('[tauri] package.json not found at repo root.');
  process.exit(1);
}

fs.rmSync(releaseRoot, { recursive: true, force: true });
fs.mkdirSync(destRoot, { recursive: true });
fs.cpSync(srcDist, destDist, { recursive: true });
fs.copyFileSync(srcPackage, path.join(destRoot, 'package.json'));

console.log('[tauri] resources prepared at', destRoot);
