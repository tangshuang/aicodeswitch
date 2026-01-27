// 重启服务器 - 依次执行 stop 和 start 命令
// 这样可以复用 stop 和 start 命令中的所有逻辑
const stop = require('./stop');
const start = require('./start');

const restart = () => {
  stop({ silent: true, callback: () => start() });
};

module.exports = restart;