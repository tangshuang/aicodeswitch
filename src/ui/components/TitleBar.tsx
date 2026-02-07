import { useState, useEffect, useRef } from 'react';
import logoImage from '../assets/logo.png';
import './TitleBar.css';

// Tauri API 类型定义
interface TauriInvokeCommand {
  (cmd: string, args?: Record<string, unknown>): Promise<unknown>;
}

interface TauriEvent {
  listen: (event: string, handler: () => void) => Promise<() => void>;
}

declare global {
  interface Window {
    __TAURI__?: {
      core: {
        invoke: TauriInvokeCommand;
      };
      event: TauriEvent;
      window: {
        getCurrent: () => {
          minimize: () => Promise<void>;
          maximize: () => Promise<void>;
          unmaximize: () => Promise<void>;
          isMaximized: () => Promise<boolean>;
          close: () => Promise<void>;
          setTitle: (title: string) => Promise<void>;
        };
      };
    };
  }
}

// 检查是否在Tauri环境中
const isTauri = () => {
  return !!window.__TAURI__;
};

interface ServerStatus {
  running: boolean;
  port: number;
}

export default function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);
  const [serverStatus, setServerStatus] = useState<ServerStatus>({ running: true, port: 4567 });
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭菜单
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowMenu(false);
      }
    };

    if (showMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showMenu]);

  // 获取服务器状态
  useEffect(() => {
    if (!isTauri()) return;

    const fetchStatus = async () => {
      try {
        const status = await window.__TAURI__!.core.invoke('get_server_status') as ServerStatus;
        setServerStatus(status);
      } catch (error) {
        console.error('Failed to get server status:', error);
      }
    };

    fetchStatus();
    // 每5秒刷新一次状态
    const interval = setInterval(fetchStatus, 5000);

    // 监听服务器启动事件
    const unlistenPromise = window.__TAURI__!.event.listen('server-started', () => {
      // 延迟1秒后刷新页面，确保服务器已完全启动
      setTimeout(() => {
        window.location.reload();
      }, 1000);
    });

    // 监听服务器重启事件
    const unlistenRestartPromise = window.__TAURI__!.event.listen('server-restarted', () => {
      // 延迟1秒后刷新页面，确保服务器已完全重启
      setTimeout(() => {
        window.location.reload();
      }, 1000);
    });

    return () => {
      clearInterval(interval);
      unlistenPromise.then(unlisten => unlisten());
      unlistenRestartPromise.then(unlisten => unlisten());
    };
  }, []);

  // 检查窗口最大化状态
  useEffect(() => {
    if (!isTauri()) return;

    const checkMaximized = async () => {
      try {
        const currentWindow = window.__TAURI__!.window.getCurrent();
        const maximized = await currentWindow.isMaximized();
        setIsMaximized(maximized);
      } catch (error) {
        console.error('Failed to check maximized state:', error);
      }
    };

    checkMaximized();
  }, []);

  const handleMinimize = async () => {
    if (!isTauri()) return;
    try {
      const currentWindow = window.__TAURI__!.window.getCurrent();
      await currentWindow.minimize();
    } catch (error) {
      console.error('Failed to minimize:', error);
    }
  };

  const handleMaximize = async () => {
    if (!isTauri()) return;
    try {
      const currentWindow = window.__TAURI__!.window.getCurrent();
      if (isMaximized) {
        await currentWindow.unmaximize();
        setIsMaximized(false);
      } else {
        await currentWindow.maximize();
        setIsMaximized(true);
      }
    } catch (error) {
      console.error('Failed to toggle maximize:', error);
    }
  };

  const handleClose = async () => {
    if (!isTauri()) return;
    try {
      const currentWindow = window.__TAURI__!.window.getCurrent();
      await currentWindow.close();
    } catch (error) {
      console.error('Failed to close:', error);
    }
  };

  const handleStart = async () => {
    if (!isTauri()) return;
    try {
      await window.__TAURI__!.core.invoke('start_server_command');
      setServerStatus({ running: true, port: serverStatus.port });
      setShowMenu(false);
    } catch (error) {
      console.error('Failed to start server:', error);
      alert('启动服务器失败: ' + (error as Error).message);
    }
  };

  const handleStop = async () => {
    if (!isTauri()) return;
    try {
      await window.__TAURI__!.core.invoke('stop_server_command');
      setServerStatus({ running: false, port: serverStatus.port });
      setShowMenu(false);
    } catch (error) {
      console.error('Failed to stop server:', error);
      alert('停止服务器失败: ' + (error as Error).message);
    }
  };

  const handleRestart = async () => {
    if (!isTauri()) return;
    try {
      await window.__TAURI__!.core.invoke('restart_server_command');
      setServerStatus({ running: true, port: serverStatus.port });
      setShowMenu(false);
    } catch (error) {
      console.error('Failed to restart server:', error);
      alert('重启服务器失败: ' + (error as Error).message);
    }
  };

  // 如果不在Tauri环境中，不渲染标题栏
  if (!isTauri()) {
    return null;
  }

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-left" data-tauri-drag-region>
        <img src={logoImage} alt="AI Code Switch" className="titlebar-logo" />
        <span className="titlebar-title" data-tauri-drag-region>AI Code Switch</span>
        {serverStatus.running && (
          <span className="titlebar-status titlebar-status-running">● 运行中</span>
        )}
        {!serverStatus.running && (
          <span className="titlebar-status titlebar-status-stopped">● 已停止</span>
        )}
      </div>

      <div className="titlebar-right">
        <div className="titlebar-menu-container" ref={menuRef}>
          <button
            className="titlebar-more-btn"
            onClick={() => setShowMenu(!showMenu)}
            title="更多操作"
          >
            ⋯
          </button>
          {showMenu && (
            <div className="titlebar-dropdown">
              <button
                className="titlebar-dropdown-item"
                onClick={handleStart}
                disabled={serverStatus.running}
              >
                <span className="dropdown-icon">▶</span>
                <span>开始</span>
              </button>
              <button
                className="titlebar-dropdown-item"
                onClick={handleStop}
                disabled={!serverStatus.running}
              >
                <span className="dropdown-icon">⏸</span>
                <span>停止</span>
              </button>
              <button
                className="titlebar-dropdown-item"
                onClick={handleRestart}
                disabled={!serverStatus.running}
              >
                <span className="dropdown-icon">↻</span>
                <span>重启</span>
              </button>
            </div>
          )}
        </div>

        <div className="titlebar-controls">
          <button
            className="titlebar-control titlebar-minimize"
            onClick={handleMinimize}
            title="最小化"
          >
            <span>─</span>
          </button>
          <button
            className="titlebar-control titlebar-maximize"
            onClick={handleMaximize}
            title={isMaximized ? "还原" : "最大化"}
          >
            {isMaximized ? <span>❐</span> : <span>□</span>}
          </button>
          <button
            className="titlebar-control titlebar-close"
            onClick={handleClose}
            title="关闭"
          >
            <span>✕</span>
          </button>
        </div>
      </div>
    </div>
  );
}
