const net = require('net');

export {
  isClaudeCompactRequest as isCompactRequest,
  isLastClaudeMessageCompact as isLastMessageCompact,
  isCodexCompactRequest,
} from './conversions/compact';

export function checkPortUsable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const server = net.createConnection({ port });
    const finish = (val: boolean) => {
      if (settled) return;
      settled = true;
      try { server.destroy(); } catch { /* ignore */ }
      resolve(val);
    };
    // 正常：连得上 = 端口被占；连不上(ECONNREFUSED) = 端口可用
    server.on('connect', () => finish(false));
    server.on('error', () => finish(true));
    // 兜底：网络栈异常（防火墙/杀软 hook）时 connect/error 可能都不触发，
    // 1.5s 后强制按可用处理，避免 start() 永久卡死。误判由 app.listen 的 EADDRINUSE 兜底。
    server.setTimeout(1500);
    server.once('timeout', () => {
      console.warn(`[checkPortUsable] 探测端口 ${port} 超时(1.5s)，按可用处理`);
      finish(true);
    });
  });
}
