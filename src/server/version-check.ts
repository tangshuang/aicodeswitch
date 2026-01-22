import https from 'https';
import path from 'path';
import fs from 'fs';

const PACKAGE_NAME = 'aicodeswitch';
const NPM_REGISTRY = 'registry.npmjs.org';

// 比较版本号
export const compareVersions = (v1: string, v2: string): number => {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    if (parts1[i] > parts2[i]) return 1;
    if (parts1[i] < parts2[i]) return -1;
  }
  return 0;
};

// 获取当前版本
export const getCurrentVersion = (): string | null => {
  try {
    const packageJsonPath = path.resolve(__dirname, '../../package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    return packageJson.version;
  } catch (err) {
    console.error('Failed to read current version:', err);
    return null;
  }
};

// 从 npm 获取最新版本
export const getLatestVersion = (): Promise<string> => {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: NPM_REGISTRY,
      path: `/${PACKAGE_NAME}`,
      method: 'GET',
      headers: {
        'User-Agent': 'aicodeswitch-version-check'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const packageInfo = JSON.parse(data);
          resolve(packageInfo['dist-tags'].latest);
        } catch (err) {
          reject(new Error('Failed to parse npm response'));
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.end();
  });
};

// 检查版本更新
export const checkVersionUpdate = async (): Promise<{
  hasUpdate: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
}> => {
  try {
    const currentVersion = getCurrentVersion();
    const latestVersion = await getLatestVersion();

    if (!currentVersion || !latestVersion) {
      return {
        hasUpdate: false,
        currentVersion,
        latestVersion
      };
    }

    const versionCompare = compareVersions(latestVersion, currentVersion);
    const hasUpdate = versionCompare > 0;

    return {
      hasUpdate,
      currentVersion,
      latestVersion
    };
  } catch (error) {
    console.error('Failed to check version update:', error);
    return {
      hasUpdate: false,
      currentVersion: getCurrentVersion(),
      latestVersion: null
    };
  }
};
