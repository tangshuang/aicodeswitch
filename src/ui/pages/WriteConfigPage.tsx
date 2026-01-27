import { useState, useEffect } from 'react';
import { api } from '../api/client';

type ConfigType = 'claude' | 'codex';

interface ConfigStatus {
  isOverwritten: boolean;
  isModified: boolean;
  hasBackup: boolean;
  metadata?: {
    configType: string;
    timestamp: number;
    proxyMarker: string;
  };
}

function WriteConfigPage() {
  const [isWriting, setIsWriting] = useState<{[key in ConfigType]: boolean}>({
    claude: false,
    codex: false
  });
  const [isRestoring, setIsRestoring] = useState<{[key in ConfigType]: boolean}>({
    claude: false,
    codex: false
  });
  const [configStatus, setConfigStatus] = useState<{[key in ConfigType]: ConfigStatus | null}>({
    claude: null,
    codex: null
  });
  const [message, setMessage] = useState('');

  useEffect(() => {
    checkConfigStatus();
  }, []);

  const checkConfigStatus = async () => {
    try {
      const [claudeStatus, codexStatus] = await Promise.all([
        api.getClaudeConfigStatus(),
        api.getCodexConfigStatus()
      ]);

      setConfigStatus({
        claude: claudeStatus,
        codex: codexStatus
      });
    } catch (error) {
      console.error('Failed to check config status:', error);
    }
  };

  const handleWriteConfig = async (type: ConfigType) => {
    setIsWriting(prev => ({ ...prev, [type]: true }));
    setMessage('');

    try {
      const result = type === 'claude'
        ? await api.writeClaudeConfig()
        : await api.writeCodexConfig();

      if (result) {
        setMessage(`${type === 'claude' ? 'Claude Code' : 'Codex'}配置文件写入成功！原始文件已备份为 .aicodeswitch_backup 文件。`);
        await checkConfigStatus(); // 重新检查配置状态
      } else {
        setMessage(`写入失败: 操作未成功`);
      }
    } catch (error: any) {
      setMessage(`写入失败: ${error.message}`);
    } finally {
      setIsWriting(prev => ({ ...prev, [type]: false }));
    }
  };

  const handleRestoreConfig = async (type: ConfigType) => {
    setIsRestoring(prev => ({ ...prev, [type]: true }));
    setMessage('');

    try {
      const result = type === 'claude'
        ? await api.restoreClaudeConfig()
        : await api.restoreCodexConfig();

      if (result) {
        setMessage(`${type === 'claude' ? 'Claude Code' : 'Codex'}配置文件已从备份恢复！`);
        await checkConfigStatus(); // 重新检查配置状态
      } else {
        setMessage(`恢复失败: 操作未成功`);
      }
    } catch (error: any) {
      setMessage(`恢复失败: ${error.message}`);
    } finally {
      setIsRestoring(prev => ({ ...prev, [type]: false }));
    }
  };

  const renderStatusInfo = (type: ConfigType) => {
    const status = configStatus[type];
    if (!status) return null;

    const displayName = type === 'claude' ? 'Claude Code' : 'Codex';

    // 如果已被覆盖且被修改
    if (status.isOverwritten && status.isModified) {
      return (
        <p style={{ color: '#f39c12', fontSize: '12px', marginTop: '10px' }}>
          ⚠️ 检测到{displayName}配置已被修改,但备份文件仍然存在。建议先恢复原始配置,再重新写入以确保配置正确。
        </p>
      );
    }

    // 如果已被覆盖且未被修改
    if (status.isOverwritten && !status.isModified) {
      return (
        <p style={{ color: '#27ae60', fontSize: '12px', marginTop: '10px' }}>
          ✓ {displayName}配置已正确设置为代理模式,且未被修改。
        </p>
      );
    }

    // 如果未被覆盖但有备份(可能是用户手动恢复了)
    if (!status.isOverwritten && status.hasBackup) {
      return (
        <p style={{ color: '#e74c3c', fontSize: '12px', marginTop: '10px' }}>
          ⚠️ 检测到配置状态不一致。备份文件存在但当前配置不是代理配置,请先恢复或手动删除备份文件。
        </p>
      );
    }

    return null;
  };

  return (
    <div>
      <div className="page-header">
        <h1>写入配置</h1>
        <p>将Claude Code和Codex的配置文件写入到用户目录</p>
      </div>

      <div className="card" style={{ marginBottom: '20px' }}>
        <h3>Claude Code配置</h3>
        <p style={{ color: '#7f8c8d', marginBottom: '15px' }}>
          为Claude Code工具写入配置文件。原始文件将被备份为.aicodeswitch_backup文件。
        </p>

        <div style={{ marginBottom: '15px' }}>
          <h4>配置文件：</h4>
          <ul style={{ color: '#7f8c8d', lineHeight: '1.6' }}>
            <li><code>~/.claude/settings.json</code> - Claude Code设置</li>
            <li><code>~/.claude.json</code> - Claude Code初始化设置</li>
          </ul>
        </div>

        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            className="btn btn-primary"
            onClick={() => handleWriteConfig('claude')}
            disabled={isWriting.claude || (configStatus.claude?.isOverwritten ?? false)}
          >
            {isWriting.claude ? '写入中...' : '写入Claude Code配置'}
          </button>

          <button
            className="btn btn-secondary"
            onClick={() => handleRestoreConfig('claude')}
            disabled={isRestoring.claude || !(configStatus.claude?.hasBackup ?? false)}
          >
            {isRestoring.claude ? '恢复中...' : '恢复Claude Code配置'}
          </button>
        </div>

        {renderStatusInfo('claude')}

        {configStatus.claude?.isOverwritten && !configStatus.claude?.isModified && (
          <p style={{ color: '#e74c3c', fontSize: '12px', marginTop: '10px' }}>
            ⚠️ 配置已被覆盖,如需重新写入请先恢复原始配置
          </p>
        )}
      </div>

      <div className="card">
        <h3>Codex配置</h3>
        <p style={{ color: '#7f8c8d', marginBottom: '15px' }}>
          为Codex工具写入配置文件。原始文件将被备份为.aicodeswitch_backup文件。
        </p>

        <div style={{ marginBottom: '15px' }}>
          <h4>配置文件：</h4>
          <ul style={{ color: '#7f8c8d', lineHeight: '1.6' }}>
            <li><code>~/.codex/config.toml</code> - Codex配置</li>
            <li><code>~/.codex/auth.json</code> - Codex认证信息</li>
          </ul>
        </div>

        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            className="btn btn-primary"
            onClick={() => handleWriteConfig('codex')}
            disabled={isWriting.codex || (configStatus.codex?.isOverwritten ?? false)}
          >
            {isWriting.codex ? '写入中...' : '写入Codex配置'}
          </button>

          <button
            className="btn btn-secondary"
            onClick={() => handleRestoreConfig('codex')}
            disabled={isRestoring.codex || !(configStatus.codex?.hasBackup ?? false)}
          >
            {isRestoring.codex ? '恢复中...' : '恢复Codex配置'}
          </button>
        </div>

        {renderStatusInfo('codex')}

        {configStatus.codex?.isOverwritten && !configStatus.codex?.isModified && (
          <p style={{ color: '#e74c3c', fontSize: '12px', marginTop: '10px' }}>
            ⚠️ 配置已被覆盖,如需重新写入请先恢复原始配置
          </p>
        )}
      </div>

      {message && (
        <div style={{
          marginTop: '20px',
          padding: '10px',
          borderRadius: '4px',
          backgroundColor: message.includes('成功') ? '#d4edda' : '#f8d7da',
          color: message.includes('成功') ? '#155724' : '#721c24',
          border: `1px solid ${message.includes('成功') ? '#c3e6cb' : '#f5c6cb'}`
        }}>
          {message}
        </div>
      )}
    </div>
  );
}

export default WriteConfigPage;