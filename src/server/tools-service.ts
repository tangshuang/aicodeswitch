import { spawn, ChildProcess } from 'child_process';
import os from 'os';
import type { ToolInstallationStatus } from '../types';

/**
 * 检测工具是否已安装
 */
async function checkToolInstalled(toolName: string): Promise<{ installed: boolean; version?: string }> {
  console.log(`[ToolsService] 开始检测工具: ${toolName}`);
  return new Promise((resolve) => {
    const command = toolName === 'claude-code' ? 'claude' : 'codex';

    console.log(`[ToolsService] 执行命令: ${command} --version`);

    const child = spawn(command, ['--version'], {
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
      console.log(`[ToolsService] ${toolName} stdout:`, data.toString());
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
      console.log(`[ToolsService] ${toolName} stderr:`, data.toString());
    });

    child.on('close', (code) => {
      console.log(`[ToolsService] ${toolName} 进程退出，退出码: ${code}`);
      if (code === 0) {
        // 尝试从输出中提取版本号
        const versionMatch = stdout.match(/(\d+\.\d+\.\d+)/) || stderr.match(/(\d+\.\d+\.\d+)/);
        resolve({
          installed: true,
          version: versionMatch ? versionMatch[1] : 'unknown',
        });
      } else {
        resolve({ installed: false });
      }
    });

    child.on('error', (err) => {
      console.log(`[ToolsService] ${toolName} 检测出错:`, err);
      resolve({ installed: false });
    });

    // 10秒超时
    setTimeout(() => {
      console.log(`[ToolsService] ${toolName} 检测超时`);
      child.kill();
      resolve({ installed: false });
    }, 10000);
  });
}

/**
 * 获取工具的安装命令
 */
function getInstallCommand(toolName: string): string {
  const platform = os.platform();
  const tool = toolName === 'claude-code' ? '@anthropic-ai/claude-code' : '@openai/codex';

  if (platform === 'win32') {
    return `npm install -g ${tool}`;
  } else {
    // macOS 和 Linux 需要 sudo
    return `sudo npm install -g ${tool}`;
  }
}

/**
 * 检测所有工具的安装状态
 */
export async function getToolsInstallationStatus(): Promise<ToolInstallationStatus> {
  const [claudeCodeStatus, codexStatus] = await Promise.all([
    checkToolInstalled('claude-code'),
    checkToolInstalled('codex'),
  ]);

  return {
    claudeCode: {
      ...claudeCodeStatus,
      installCommand: claudeCodeStatus.installed ? undefined : getInstallCommand('claude-code'),
    },
    codex: {
      ...codexStatus,
      installCommand: codexStatus.installed ? undefined : getInstallCommand('codex'),
    },
  };
}

/**
 * 工具安装回调接口
 */
export interface ToolInstallationCallbacks {
  onData: (data: string) => void;
  onError: (data: string) => void;
  onClose: (code: number | null) => void;
}

/**
 * 执行工具安装
 */
export function installTool(
  toolName: 'claude-code' | 'codex',
  callbacks: ToolInstallationCallbacks
): ChildProcess & { stdin?: NodeJS.WritableStream } {
  const command = getInstallCommand(toolName);
  const platform = os.platform();

  console.log(`[ToolsService] ========== 开始安装 ${toolName} ==========`);
  console.log(`[ToolsService] 操作系统: ${platform}`);
  console.log(`[ToolsService] 安装命令: ${command}`);

  // 立即发送启动消息，让前端快速进入 terminal 界面
  callbacks.onData(`\n========== 开始安装 ${toolName} ==========\n`);
  callbacks.onData(`操作系统: ${platform}\n`);
  callbacks.onData(`执行命令: ${command}\n`);
  callbacks.onData(`进程启动中...\n\n`);

  // 在 macOS/Linux 上，需要使用 sudo 并且可能需要输入密码
  // 在 Windows 上直接使用 cmd 执行 npm 命令
  let child: ChildProcess;

  if (platform === 'win32') {
    // Windows: 使用 cmd.exe 执行命令
    console.log(`[ToolsService] Windows 环境，使用 cmd.exe`);
    child = spawn('cmd.exe', ['/c', command], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true, // 隐藏命令行窗口
    });
  } else {
    // Unix: 使用 sh 执行命令
    console.log(`[ToolsService] Unix 环境，使用 sh`);
    child = spawn('sh', ['-c', command], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
  }

  console.log(`[ToolsService] 子进程 PID: ${child.pid}`);

  // 立即发送进程信息
  callbacks.onData(`子进程已创建 (PID: ${child.pid})\n`);
  callbacks.onData(`等待 npm 输出...\n\n`);

  // 设置超时：30分钟后自动终止
  const timeout = 30 * 60 * 1000;
  const timeoutHandle = setTimeout(() => {
    console.error(`[ToolsService] ${toolName} 安装超时 (${timeout}ms)，终止进程`);
    child.kill('SIGTERM');
    callbacks.onError(`\n安装超时 (${timeout / 60000} 分钟)，请检查网络连接或手动执行命令：\n${command}\n`);
  }, timeout);

  let hasReceivedData = false;

  child.stdout?.on('data', (data) => {
    const output = data.toString();
    if (!hasReceivedData) {
      console.log(`[ToolsService] ${toolName} 首次收到 stdout 数据`);
      hasReceivedData = true;
    }
    console.log(`[ToolsService] ${toolName} stdout:`, output.slice(0, 200)); // 只记录前200字符
    callbacks.onData(output);
  });

  child.stderr?.on('data', (data) => {
    const output = data.toString();
    if (!hasReceivedData) {
      console.log(`[ToolsService] ${toolName} 首次收到 stderr 数据`);
      hasReceivedData = true;
    }
    console.log(`[ToolsService] ${toolName} stderr:`, output.slice(0, 200)); // 只记录前200字符
    callbacks.onError(output);
  });

  child.on('close', (code) => {
    clearTimeout(timeoutHandle);
    console.log(`[ToolsService] ${toolName} 安装进程关闭，退出码: ${code}`);
    if (code === 0) {
      callbacks.onData(`\n========== 安装完成 ==========\n`);
    } else if (code === null) {
      callbacks.onError(`\n========== 安装被终止 ==========\n`);
    } else {
      callbacks.onError(`\n========== 安装失败 (退出码: ${code}) ==========\n`);
    }
    callbacks.onClose(code);
  });

  child.on('error', (err) => {
    clearTimeout(timeoutHandle);
    console.error(`[ToolsService] ${toolName} 安装进程错误:`, err);
    callbacks.onError(`启动安装进程失败: ${err.message}\n`);
    callbacks.onError(`错误详情: ${err}\n`);
    callbacks.onClose(null);
  });

  // 处理进程退出信号
  child.on('exit', (_code, signal) => {
    clearTimeout(timeoutHandle);
    if (signal) {
      console.log(`[ToolsService] ${toolName} 进程被信号终止: ${signal}`);
      callbacks.onError(`\n安装进程被信号终止: ${signal}\n`);
    }
  });

  // 如果10秒后还没有收到任何数据，发送提示
  setTimeout(() => {
    if (!hasReceivedData) {
      console.log(`[ToolsService] ${toolName} 10秒内未收到输出，发送等待提示`);
      callbacks.onData(`[提示] 正在连接 npm 服务器，这可能需要一些时间...\n`);
      callbacks.onData(`[提示] 如果持续无响应，请检查网络连接或 npm 配置\n\n`);
    }
  }, 10000);

  return child as ChildProcess & { stdin?: NodeJS.WritableStream };
}
