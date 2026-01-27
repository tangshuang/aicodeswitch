const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

/**
 * 获取占用指定端口的进程 PID
 * @param {number} port - 端口号
 * @returns {Promise<number|null>} 返回 PID 或 null
 */
const findPidByPort = async (port) => {
  const platform = process.platform;

  try {
    if (platform === 'win32') {
      // Windows: 使用 netstat
      const { stdout } = await execPromise(`netstat -ano | findstr :${port}`);
      const lines = stdout.split('\n').filter(line => line.trim());

      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        // 格式: 协议 本地地址 外部地址 状态 PID
        if (parts.length >= 5) {
          const localAddress = parts[1];
          if (localAddress.includes(`:${port}`)) {
            const pid = parseInt(parts[parts.length - 1], 10);
            if (!isNaN(pid)) {
              return pid;
            }
          }
        }
      }
    } else {
      // macOS 和 Linux: 使用 lsof
      const { stdout } = await execPromise(`lsof -ti :${port}`);
      const pidStr = stdout.trim();
      if (pidStr) {
        // lsof -ti 可能返回多个 PID，取第一个
        const pids = pidStr.split('\n').filter(p => p);
        if (pids.length > 0) {
          return parseInt(pids[0], 10);
        }
      }
    }
  } catch (err) {
    // 命令执行失败，说明端口未被占用
    return null;
  }

  return null;
};

/**
 * 终止指定 PID 的进程
 * @param {number} pid - 进程 PID
 * @returns {Promise<boolean>} 是否成功终止
 */
const killProcess = async (pid) => {
  const platform = process.platform;

  try {
    if (platform === 'win32') {
      // Windows: 使用 taskkill
      await execPromise(`taskkill /F /PID ${pid}`);
    } else {
      // macOS 和 Linux: 使用 kill
      process.kill(pid, 'SIGTERM');

      // 等待进程停止
      let attempts = 0;
      const maxAttempts = 10;

      while (attempts < maxAttempts) {
        try {
          process.kill(pid, 0);
          await new Promise(resolve => setTimeout(resolve, 200));
          attempts++;
        } catch (err) {
          // 进程已停止
          return true;
        }
      }

      // 强制终止
      process.kill(pid, 'SIGKILL');
    }
    return true;
  } catch (err) {
    // 进程可能已经不存在
    return false;
  }
};

/**
 * 获取进程信息（用于显示）
 * @param {number} pid - 进程 PID
 * @returns {Promise<string>} 进程信息
 */
const getProcessInfo = async (pid) => {
  const platform = process.platform;

  try {
    if (platform === 'win32') {
      const { stdout } = await execPromise(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`);
      return stdout.trim();
    } else {
      const { stdout } = await execPromise(`ps -p ${pid} -o comm=`);
      return stdout.trim();
    }
  } catch (err) {
    return 'Unknown';
  }
};

module.exports = {
  findPidByPort,
  killProcess,
  getProcessInfo
};
