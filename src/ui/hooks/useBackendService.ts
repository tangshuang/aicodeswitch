import { useEffect, useState } from 'react';

// 检测是否在 Tauri 环境中运行
const isTauri = () => {
  return typeof window !== 'undefined' && '__TAURI__' in window;
};

// 动态导入 Tauri API（仅在 Tauri 环境中）
let tauriInvoke: ((cmd: string, args?: any) => Promise<any>) | null = null;

if (isTauri()) {
  import('@tauri-apps/api/tauri').then((module) => {
    tauriInvoke = module.invoke;
  });
}

export const useBackendService = () => {
  const [isServerRunning, setIsServerRunning] = useState(false);
  const [serverPort] = useState(4567);
  const [error, setError] = useState<string | null>(null);
  const [isCheckingNode, setIsCheckingNode] = useState(false);
  const [nodeInstalled, setNodeInstalled] = useState(true);

  // 检查 Node.js 是否安装
  const checkNodeInstalled = async () => {
    if (!isTauri() || !tauriInvoke) {
      setNodeInstalled(true);
      return true;
    }

    setIsCheckingNode(true);
    try {
      const result = await tauriInvoke('check_node_installed');
      console.log('Node.js check result:', result);
      setNodeInstalled(true);
      setError(null);
      return true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      setError(errorMsg);
      setNodeInstalled(false);
      console.error('Node.js not installed:', errorMsg);
      return false;
    } finally {
      setIsCheckingNode(false);
    }
  };

  // 启动后端服务
  const startServer = async () => {
    // 如果不在 Tauri 环境中，不需要启动服务（开发模式下服务已经运行）
    if (!isTauri() || !tauriInvoke) {
      setIsServerRunning(true);
      return;
    }

    try {
      const result = await tauriInvoke('start_server', { port: serverPort });
      console.log('Server start result:', result);
      setIsServerRunning(true);
      setError(null);

      // 给服务一些启动时间
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      setError(errorMsg);
      console.error('Failed to start server:', errorMsg);
    }
  };

  // 停止后端服务
  const stopServer = async () => {
    if (!isTauri() || !tauriInvoke) {
      return;
    }

    try {
      await tauriInvoke('stop_server', {});
      setIsServerRunning(false);
      setError(null);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      setError(errorMsg);
      console.error('Failed to stop server:', errorMsg);
    }
  };

  // 获取服务状态
  const checkServerStatus = async () => {
    if (!isTauri() || !tauriInvoke) {
      setIsServerRunning(true);
      return;
    }

    try {
      const status = await tauriInvoke('get_server_status', {});
      setIsServerRunning(status);
    } catch (err) {
      setIsServerRunning(false);
    }
  };

  // 获取 API 基础 URL
  const getApiBaseUrl = () => {
    return `http://localhost:${serverPort}`;
  };

  // 应用启动时检查 Node.js 和服务状态
  useEffect(() => {
    const init = async () => {
      if (isTauri()) {
        // 等待 Tauri API 加载
        let retries = 0;
        while (!tauriInvoke && retries < 10) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          retries++;
        }

        if (tauriInvoke) {
          const nodeOk = await checkNodeInstalled();
          if (nodeOk) {
            await checkServerStatus();
          }
        }
      } else {
        // 开发模式，假设服务已运行
        setIsServerRunning(true);
      }
    };

    init();
  }, []);

  return {
    isServerRunning,
    serverPort,
    error,
    isCheckingNode,
    nodeInstalled,
    isTauriMode: isTauri(),
    startServer,
    stopServer,
    checkServerStatus,
    checkNodeInstalled,
    getApiBaseUrl,
  };
};
