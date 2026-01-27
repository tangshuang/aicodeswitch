const path = require('path');
const fs = require('fs');
const os = require('os');

const PID_FILE = path.join(os.homedir(), '.aicodeswitch', 'server.pid');

/**
 * 判断服务器是否正在运行
 * @returns
 */
const isServerRunning = () => {
  if (!fs.existsSync(PID_FILE)) {
    return false;
  }

  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8'), 10);
    // 检查进程是否存在
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // 进程不存在,删除过期的 PID 文件
    fs.unlinkSync(PID_FILE);
    return false;
  }
};

/**
 * 获取服务器信息
 * @returns
 */
const getServerInfo = () => {
  // 尝试多个可能的配置文件位置
  const possiblePaths = [
    path.join(os.homedir(), '.aicodeswitch', '.env'),
    path.join(os.homedir(), '.aicodeswitch', 'aicodeswitch.conf')
  ];

  let host = '127.0.0.1';
  let port = 4567;

  for (const dotenvPath of possiblePaths) {
    if (fs.existsSync(dotenvPath)) {
      const content = fs.readFileSync(dotenvPath, 'utf-8');
      const hostMatch = content.match(/HOST=(.+)/);
      const portMatch = content.match(/PORT=(.+)/);

      if (hostMatch) host = hostMatch[1].trim();
      if (portMatch) port = parseInt(portMatch[1].trim(), 10);
      break;
    }
  }

  return { host, port };
};

module.exports.isServerRunning = isServerRunning;
module.exports.getServerInfo = getServerInfo;