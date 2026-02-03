// @ts-ignore - ws 类型声明可能需要手动安装 @types/ws
import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { installTool, ToolInstallationCallbacks } from './tools-service';
import os from 'os';

/**
 * WebSocket 消息类型
 */
type WSMessage =
  | { type: 'start'; data: { tool: string; os: string; command: string; pid: number } }
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | { type: 'close'; data: { code: number | null; success: boolean } }
  | { type: 'error'; data: string }
  | { type: 'input'; data: string };  // 客户端发送输入（如密码）

/**
 * WebSocket 连接管理
 */
class ToolInstallationWS {
  private ws: WebSocket;
  private childProcess: ReturnType<typeof installTool> | null = null;

  constructor(ws: WebSocket, req: IncomingMessage) {
    this.ws = ws;

    console.log(`[WS] 新的 WebSocket 连接: ${req.socket.remoteAddress}`);

    this.ws.on('message', (data: Buffer) => {
      try {
        const message: WSMessage = JSON.parse(data.toString());
        console.log(`[WS] 收到消息:`, message.type);

        if (message.type === 'input') {
          // 用户输入（如密码），发送到子进程的 stdin
          if (this.childProcess && this.childProcess.stdin) {
            console.log(`[WS] 发送用户输入到子进程:`, message.data.slice(0, 10));
            this.childProcess.stdin.write(message.data);
          } else {
            console.warn(`[WS] 子进程不存在或无 stdin，无法发送输入`);
          }
        }
      } catch (err) {
        console.error(`[WS] 解析消息失败:`, err);
      }
    });

    this.ws.on('close', () => {
      console.log(`[WS] WebSocket 连接关闭`);
      this.cleanup();
    });

    this.ws.on('error', (err: Error) => {
      console.error(`[WS] WebSocket 错误:`, err);
      this.cleanup();
    });
  }

  /**
   * 开始安装工具
   */
  startInstallation(toolName: 'claude-code' | 'codex') {
    console.log(`[WS] 开始安装 ${toolName}`);

    const callbacks: ToolInstallationCallbacks = {
      onData: (data: string) => {
        this.sendMessage({ type: 'stdout', data });
      },
      onError: (data: string) => {
        this.sendMessage({ type: 'stderr', data });
      },
      onClose: (code: number | null) => {
        const success = code === 0;
        this.sendMessage({ type: 'close', data: { code, success } });
        // 延迟关闭连接，让客户端收到最终消息
        setTimeout(() => {
          this.ws.close();
        }, 1000);
      },
    };

    // 启动安装进程
    this.childProcess = installTool(toolName, callbacks);

    // 发送启动信息
    const platform = os.platform();
    const command = platform === 'win32'
      ? `npm install -g ${toolName === 'claude-code' ? '@anthropic-ai/claude-code' : '@openai/codex'}`
      : `sudo npm install -g ${toolName === 'claude-code' ? '@anthropic-ai/claude-code' : '@openai/codex'}`;

    this.sendMessage({
      type: 'start',
      data: {
        tool: toolName,
        os: platform,
        command,
        pid: this.childProcess.pid || 0,
      },
    });
  }

  /**
   * 发送消息到客户端
   */
  private sendMessage(message: WSMessage) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  /**
   * 清理资源
   */
  private cleanup() {
    if (this.childProcess) {
      console.log(`[WS] 清理资源，终止子进程`);
      // 给进程5秒时间正常退出
      setTimeout(() => {
        if (this.childProcess && !this.childProcess.killed) {
          this.childProcess.kill('SIGTERM');
        }
      }, 5000);
    }
  }
}

/**
 * 创建 WebSocket 服务器
 */
export function createToolInstallationWSServer() {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const wsHandler = new ToolInstallationWS(ws, req);

    // 监听第一次消息，获取要安装的工具名称
    ws.once('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === 'install' && message.tool) {
          wsHandler.startInstallation(message.tool);
        } else {
          ws.send(JSON.stringify({ type: 'error', data: '无效的请求' }));
          ws.close();
        }
      } catch (error) {
        console.error(`[WS] 解析安装请求失败:`, error);
        ws.send(JSON.stringify({ type: 'error', data: '解析请求失败' }));
        ws.close();
      }
    });
  });

  return wss;
}

export { ToolInstallationWS };
