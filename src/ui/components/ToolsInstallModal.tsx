import { useState, useCallback, useEffect, useRef } from 'react';
import { api } from '../api/client';
import type { ToolInstallationStatus } from '../../types';
import Terminal from './Terminal';

interface ToolsInstallModalProps {
  status: ToolInstallationStatus;
  onClose: () => void;
  onInstallComplete: () => void;
}

type InstallState = 'idle' | 'installing' | 'completed' | 'error';

export default function ToolsInstallModal({ status, onClose, onInstallComplete }: ToolsInstallModalProps) {
  const [installState, setInstallState] = useState<InstallState>('idle');
  const [installingTool, setInstallingTool] = useState<'claude-code' | 'codex' | null>(null);
  const [output, setOutput] = useState<string[]>([]);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [waitingForInput, setWaitingForInput] = useState(false);
  const cancelRef = useRef<(() => void) & { sendInput?: (input: string) => void } | null>(null);

  // 清理函数
  useEffect(() => {
    return () => {
      if (cancelRef.current) {
        cancelRef.current();
      }
    };
  }, []);

  const resetState = useCallback(() => {
    setInstallState('idle');
    setInstallingTool(null);
    setOutput([]);
    setErrorMessage('');
    setWaitingForInput(false);
  }, []);

  const getManualInstallSteps = useCallback((tool: 'claude-code' | 'codex') => {
    const packageName = tool === 'claude-code' ? '@anthropic-ai/claude-code' : '@openai/codex';
    const platform = window.navigator.platform;

    let steps: string[] = [];

    if (platform.includes('Win')) {
      steps = [
        `打开命令提示符（CMD）或 PowerShell`,
        `执行以下命令：`,
        `npm install -g ${packageName}`,
      ];
    } else {
      steps = [
        `打开终端`,
        `执行以下命令（需要输入管理员密码）：`,
        `sudo npm install -g ${packageName}`,
        `输入您的系统密码`,
      ];
    }

    return steps;
  }, []);

  const handleInstall = useCallback((tool: 'claude-code' | 'codex') => {
    if (installState === 'installing') return;

    console.log(`[Frontend] 开始安装 ${tool}`);
    setInstallingTool(tool);
    setInstallState('installing');
    setErrorMessage('');
    setWaitingForInput(false);
    setOutput([
      `正在连接到服务器...\n`,
      `准备安装 ${tool === 'claude-code' ? 'Claude Code' : 'Codex'}...\n`,
      `请稍候...\n`,
    ]);

    try {
      cancelRef.current = api.installTool(tool, {
        onStdout: (data) => {
          console.log('[Frontend] stdout:', data);
          setOutput((prev) => [...prev, data]);
        },
        onStderr: (data) => {
          console.log('[Frontend] stderr:', data);
          setOutput((prev) => [...prev, data]);
          // 检测是否需要输入密码（sudo）
          if (data.includes('password') || data.includes('Password') || data.includes('密码')) {
            setWaitingForInput(true);
          }
        },
        onClose: (code, success) => {
          console.log(`[Frontend] 安装完成，退出码: ${code}, 成功: ${success}`);
          setWaitingForInput(false);
          setOutput((prev) => [
            ...prev,
            success ? `\n✓ 安装成功！` : `\n✗ 安装失败 (退出码: ${code})`,
          ]);
          setInstallState(success ? 'completed' : 'error');
          setErrorMessage(success ? '' : `安装失败，退出码: ${code}`);
          if (success) {
            setTimeout(() => {
              onInstallComplete();
            }, 1500);
          }
        },
        onError: (err) => {
          console.error('[Frontend] 安装错误:', err);
          setOutput((prev) => [...prev, `[ERROR] ${err}`]);
          setWaitingForInput(false);
          setInstallState('error');
          setErrorMessage(err);
        },
      });

      // 设置连接超时检测
      const timeoutId = setTimeout(() => {
        setInstallState((currentState) => {
          // 只有在安装过程中且没有收到任何数据时才报错超时
          if (currentState === 'installing' && output.length <= 3) {
            console.error('[Frontend] 连接超时');
            setOutput((prev) => [
              ...prev,
              `\n[ERROR] 连接服务器超时！`,
            ]);
            setErrorMessage('连接服务器超时');
            return 'error';
          }
          return currentState;
        });
      }, 15000);

      // 将 timeoutId 保存到 cancelRef 中，以便在安装完成时清除
      if (!cancelRef.current) {
        cancelRef.current = () => clearTimeout(timeoutId);
      }
    } catch (err) {
      console.error('[Frontend] 启动安装失败:', err);
      setOutput((prev) => [...prev, `[ERROR] 启动安装失败: ${err}`]);
      setInstallState('error');
      setErrorMessage(String(err));
    }
  }, [installState, onInstallComplete]);

  const handleInput = useCallback((input: string) => {
    console.log('[Frontend] 发送用户输入:', input.slice(0, 10));
    if (cancelRef.current?.sendInput) {
      cancelRef.current.sendInput(input);
      setOutput((prev) => [...prev, `\n$ ${'•'.repeat(input.length)}\n`]); // 隐藏密码显示
      setWaitingForInput(false);
    }
  }, []);

  const needsInstall = !status.claudeCode.installed || !status.codex.installed;
  const showInitial = installState === 'idle';
  const showInstalling = installState === 'installing';
  const showCompleted = installState === 'completed';
  const showError = installState === 'error';

  const manualInstallSteps = installingTool ? getManualInstallSteps(installingTool) : [];

  return (
    <div className="modal-overlay">
      <button
        type="button"
        className="modal-close-btn"
        onClick={onClose}
        aria-label="关闭"
        disabled={showInstalling}
        style={showInstalling ? { opacity: 0.3, cursor: 'not-allowed' } : undefined}
      >
        ×
      </button>
      <div className="modal" style={{ maxWidth: '800px' }}>
        <div className="modal-container">
          <div className="modal-header">
            <h2>🔧 工具安装检测</h2>
          </div>
          <div style={{ padding: '20px 0' }}>
            {showInitial && (
              <>
                <p style={{ marginBottom: '16px', lineHeight: '1.6', color: 'var(--text-secondary)' }}>
                  检测到您的系统中缺少以下 AI 编程工具。
                </p>

                <div style={{ marginBottom: '20px' }}>
                  <div style={{
                    padding: '12px',
                    marginBottom: '12px',
                    borderRadius: '6px',
                    backgroundColor: status.claudeCode.installed ? '#f0fdf4' : '#fef3c7',
                    border: `1px solid ${status.claudeCode.installed ? '#86efac' : '#fbbf24'}`,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <div style={{ fontWeight: '500', marginBottom: '4px' }}>
                          Claude Code {status.claudeCode.installed && `(${status.claudeCode.version})`}
                        </div>
                        <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                          {status.claudeCode.installed ? '✓ 已安装' : '✗ 未安装'}
                        </div>
                      </div>
                      {!status.claudeCode.installed && (
                        <button
                          type="button"
                          className="btn btn-primary"
                          onClick={() => handleInstall('claude-code')}
                          disabled={showInstalling}
                          style={{ fontSize: '13px', padding: '6px 12px' }}
                        >
                          安装
                        </button>
                      )}
                    </div>
                  </div>

                  <div style={{
                    padding: '12px',
                    borderRadius: '6px',
                    backgroundColor: status.codex.installed ? '#f0fdf4' : '#fef3c7',
                    border: `1px solid ${status.codex.installed ? '#86efac' : '#fbbf24'}`,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <div style={{ fontWeight: '500', marginBottom: '4px' }}>
                          Codex {status.codex.installed && `(${status.codex.version})`}
                        </div>
                        <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                          {status.codex.installed ? '✓ 已安装' : '✗ 未安装'}
                        </div>
                      </div>
                      {!status.codex.installed && (
                        <button
                          type="button"
                          className="btn btn-primary"
                          onClick={() => handleInstall('codex')}
                          disabled={showInstalling}
                          style={{ fontSize: '13px', padding: '6px 12px' }}
                        >
                          安装
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {needsInstall && (
                  <div style={{
                    padding: '12px',
                    borderRadius: '6px',
                    backgroundColor: '#fffbeb',
                    border: '1px solid #fbbf24',
                    fontSize: '13px',
                    lineHeight: '1.6',
                  }}>
                    <strong>⚠️ 注意：</strong>
                    <ul style={{ margin: '8px 0 0 0', paddingLeft: '20px' }}>
                      <li>在 macOS 和 Linux 上安装需要管理员权限，可能需要输入 sudo 密码</li>
                      <li>如果提示输入密码，请在下方的终端输入框中输入</li>
                      <li>Windows 用户通常会自动完成安装</li>
                      <li>安装过程可能需要几分钟时间，请耐心等待</li>
                    </ul>
                  </div>
                )}
              </>
            )}

            {(showInstalling || showError) && (
              <>
                <p style={{ marginBottom: '16px', lineHeight: '1.6' }}>
                  {showError ? (
                    <>安装 <strong>{installingTool === 'claude-code' ? 'Claude Code' : 'Codex'}</strong> 时出错</>
                  ) : (
                    <>正在安装 <strong>{installingTool === 'claude-code' ? 'Claude Code' : 'Codex'}</strong>...</>
                  )}
                </p>
                <Terminal
                  output={output}
                  readOnly={false}
                  onInput={handleInput}
                  waitingForInput={waitingForInput}
                  placeholder={waitingForInput ? '密码:' : '$ '}
                />
                {showError && manualInstallSteps.length > 0 && (
                  <div style={{
                    marginTop: '16px',
                    padding: '16px',
                    borderRadius: '6px',
                    backgroundColor: '#f0f9ff',
                    border: '1px solid #7dd3fc',
                  }}>
                    <div style={{ fontWeight: '600', marginBottom: '12px', color: '#0369a1' }}>
                      📖 手动安装步骤
                    </div>
                    <ol style={{ margin: 0, paddingLeft: '20px', lineHeight: '1.8' }}>
                      {manualInstallSteps.map((step, index) => (
                        <li key={index} style={{ marginBottom: index < manualInstallSteps.length - 1 ? '8px' : '0' }}>
                          {step}
                        </li>
                      ))}
                    </ol>
                    <div style={{ marginTop: '12px', fontSize: '13px', color: '#0369a1' }}>
                      💡 如果自动安装失败，您可以在终端中手动执行上述命令来安装工具。
                    </div>
                  </div>
                )}
                {showError && errorMessage && (
                  <div style={{
                    marginTop: '12px',
                    padding: '12px',
                    borderRadius: '6px',
                    backgroundColor: '#fee',
                    border: '1px solid #fcc',
                    fontSize: '13px',
                  }}>
                    <strong>错误：</strong> {errorMessage}
                  </div>
                )}
              </>
            )}

            {showCompleted && (
              <div style={{
                padding: '20px',
                borderRadius: '6px',
                backgroundColor: '#f0fdf4',
                border: '1px solid #86efac',
                textAlign: 'center',
              }}>
                <div style={{ fontSize: '48px', marginBottom: '12px' }}>✓</div>
                <div style={{ fontWeight: '500', marginBottom: '8px' }}>安装完成！</div>
                <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                  您现在可以正常使用 AI Code Switch 了
                </div>
              </div>
            )}
          </div>

          {showInitial && (
            <div className="modal-footer">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={onClose}
              >
                稍后安装
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  if (!status.claudeCode.installed) {
                    handleInstall('claude-code');
                  } else if (!status.codex.installed) {
                    handleInstall('codex');
                  }
                }}
                disabled={status.claudeCode.installed && status.codex.installed}
              >
                一键安装所需工具
              </button>
            </div>
          )}

          {showCompleted && (
            <div className="modal-footer">
              <button
                type="button"
                className="btn btn-primary"
                onClick={onClose}
              >
                完成
              </button>
            </div>
          )}

          {showError && (
            <div className="modal-footer">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={onClose}
              >
                关闭
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={resetState}
              >
                重试
              </button>
            </div>
          )}
        </div>
      </div>
      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
