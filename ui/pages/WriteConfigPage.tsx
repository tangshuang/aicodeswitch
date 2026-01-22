import { useState, useEffect } from 'react';
import { api } from '../api/client';

type ConfigType = 'claude' | 'codex';

function WriteConfigPage() {
  const [isWriting, setIsWriting] = useState<{[key in ConfigType]: boolean}>({
    claude: false,
    codex: false
  });
  const [isRestoring, setIsRestoring] = useState<{[key in ConfigType]: boolean}>({
    claude: false,
    codex: false
  });
  const [hasBackup, setHasBackup] = useState<{[key in ConfigType]: boolean}>({
    claude: false,
    codex: false
  });
  const [message, setMessage] = useState('');

  useEffect(() => {
    checkBackups();
  }, []);

  const checkBackups = async () => {
    try {
      const [claudeBackup, codexBackup] = await Promise.all([
        api.checkClaudeBackup(),
        api.checkCodexBackup()
      ]);

      setHasBackup({
        claude: claudeBackup.exists,
        codex: codexBackup.exists
      });
    } catch (error) {
      console.error('Failed to check backups:', error);
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
        setMessage(`${type === 'claude' ? 'Claude Code' : 'Codex'}配置文件写入成功！原始文件已备份为 .bak 文件。`);
        await checkBackups(); // 重新检查备份状态
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
        await checkBackups(); // 重新检查备份状态
      } else {
        setMessage(`恢复失败: 操作未成功`);
      }
    } catch (error: any) {
      setMessage(`恢复失败: ${error.message}`);
    } finally {
      setIsRestoring(prev => ({ ...prev, [type]: false }));
    }
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
          为Claude Code工具写入配置文件。原始文件将被备份为.bak文件。
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
            disabled={isWriting.claude || hasBackup.claude}
          >
            {isWriting.claude ? '写入中...' : '写入Claude Code配置'}
          </button>

          <button
            className="btn btn-secondary"
            onClick={() => handleRestoreConfig('claude')}
            disabled={isRestoring.claude || !hasBackup.claude}
          >
            {isRestoring.claude ? '恢复中...' : '恢复Claude Code配置'}
          </button>
        </div>

        {!hasBackup.claude && (
          <p style={{ color: '#95a5a6', fontSize: '12px', marginTop: '10px' }}>
            没有找到备份文件,恢复功能不可用
          </p>
        )}

        {hasBackup.claude && (
          <p style={{ color: '#e74c3c', fontSize: '12px', marginTop: '10px' }}>
            ⚠️ 备份文件已存在,为避免覆盖原始备份,请先恢复或手动删除备份文件后再写入
          </p>
        )}
      </div>

      <div className="card">
        <h3>Codex配置</h3>
        <p style={{ color: '#7f8c8d', marginBottom: '15px' }}>
          为Codex工具写入配置文件。原始文件将被备份为.bak文件。
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
            disabled={isWriting.codex || hasBackup.codex}
          >
            {isWriting.codex ? '写入中...' : '写入Codex配置'}
          </button>

          <button
            className="btn btn-secondary"
            onClick={() => handleRestoreConfig('codex')}
            disabled={isRestoring.codex || !hasBackup.codex}
          >
            {isRestoring.codex ? '恢复中...' : '恢复Codex配置'}
          </button>
        </div>

        {!hasBackup.codex && (
          <p style={{ color: '#95a5a6', fontSize: '12px', marginTop: '10px' }}>
            没有找到备份文件,恢复功能不可用
          </p>
        )}

        {hasBackup.codex && (
          <p style={{ color: '#e74c3c', fontSize: '12px', marginTop: '10px' }}>
            ⚠️ 备份文件已存在,为避免覆盖原始备份,请先恢复或手动删除备份文件后再写入
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