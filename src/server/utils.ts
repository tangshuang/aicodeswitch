const net = require('net');

export function checkPortUsable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createConnection({ port });
    server.on('connect', () => {
      server.end();
      resolve(false);
    });
    server.on('error', () => {
      resolve(true);
    });
  });
}
