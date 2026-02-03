import { useState } from 'react';

interface NotificationBarProps {
  toolName?: 'claude-code' | 'codex' | 'both';
  onInstallClick: () => void;
  onClose: () => void;
}

export default function NotificationBar({ toolName = 'both', onInstallClick, onClose }: NotificationBarProps) {
  const [isClosing, setIsClosing] = useState(false);

  const handleClose = () => {
    setIsClosing(true);
    setTimeout(() => {
      onClose();
    }, 300);
  };

  const getToolText = () => {
    if (toolName === 'claude-code') return 'Claude Code';
    if (toolName === 'codex') return 'Codex';
    return 'Claude Code / Codex';
  };

  return (
    <div
      className={`notification-bar ${isClosing ? 'notification-bar-closing' : ''}`}
      style={{
        position: 'fixed',
        top: '20px',
        right: '20px',
        backgroundColor: '#fef3c7',
        border: '1px solid #fbbf24',
        borderRadius: '8px',
        padding: '16px 20px',
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
        zIndex: 9999,
        maxWidth: '400px',
        transition: 'all 0.3s ease',
        opacity: isClosing ? 0 : 1,
        transform: isClosing ? 'translateX(100%)' : 'translateX(0)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
        <div style={{ fontSize: '24px', flexShrink: 0 }}>⚠️</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: '600', marginBottom: '4px', fontSize: '15px' }}>
            工具未安装
          </div>
          <div style={{ fontSize: '13px', color: '#666', marginBottom: '12px', lineHeight: '1.5' }}>
            检测到您的系统中缺少 <strong>{getToolText()}</strong>。
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={onInstallClick}
              style={{ fontSize: '13px', padding: '6px 14px' }}
            >
              立即安装
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleClose}
              style={{ fontSize: '13px', padding: '6px 14px' }}
            >
              稍后
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={handleClose}
          style={{
            background: 'none',
            border: 'none',
            fontSize: '20px',
            color: '#999',
            cursor: 'pointer',
            padding: '0',
            width: '24px',
            height: '24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '4px',
            flexShrink: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = '#f0f0f0';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'transparent';
          }}
        >
          ×
        </button>
      </div>
    </div>
  );
}
