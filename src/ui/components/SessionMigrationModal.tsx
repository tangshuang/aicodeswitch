import { useState } from 'react';
import { api } from '../api/client';
import type { Session, MigrationPreview, MigrationOptions, LaunchResult, ToolType } from '../../types';
import { toast } from './Toast';

interface Props {
  session: Session;
  onClose: () => void;
}

export function SessionMigrationModal({ session, onClose }: Props) {
  const [targetTool, setTargetTool] = useState<ToolType>(
    session.targetType === 'claude-code' ? 'codex' : 'claude-code'
  );
  const [includeThinking, setIncludeThinking] = useState(false);
  const [includeToolCalls, setIncludeToolCalls] = useState(true);
  const [maxRounds, setMaxRounds] = useState(0);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<MigrationPreview | null>(null);
  const [editedPrompt, setEditedPrompt] = useState('');
  const [launchResult, setLaunchResult] = useState<LaunchResult | null>(null);
  const [launchLoading, setLaunchLoading] = useState(false);

  const sourceLabel = session.targetType === 'claude-code' ? 'Claude Code' : 'Codex';
  const targetLabel = targetTool === 'claude-code' ? 'Claude Code' : 'Codex';

  const duration = (() => {
    const diff = session.lastRequestAt - session.firstRequestAt;
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return `${Math.max(1, Math.floor(diff / 1000))}秒`;
    if (minutes < 60) return `${minutes}分钟`;
    const hours = Math.floor(minutes / 60);
    return `${hours}小时${minutes % 60}分钟`;
  })();

  const handlePreview = async () => {
    setLoading(true);
    setPreview(null);
    setLaunchResult(null);
    try {
      const options: Partial<MigrationOptions> = {
        sourceSessionId: session.id,
        targetTool,
        includeThinking,
        includeToolCalls,
        maxRounds,
      };
      const result = await api.migrationPreview(session.id, options);
      setPreview(result);
      setEditedPrompt(result.generatedPrompt);
    } catch (err: any) {
      toast.error(err.message || '预览失败');
    } finally {
      setLoading(false);
    }
  };

  const handleCopyPrompt = async () => {
    const text = editedPrompt || preview?.generatedPrompt || '';
    try {
      await navigator.clipboard.writeText(text);
      toast.success('已复制到剪贴板！请打开 ' + targetLabel + '，粘贴为第一条消息');
    } catch {
      // Fallback: select text
      const textarea = document.querySelector('.migration-prompt-textarea') as HTMLTextAreaElement;
      if (textarea) {
        textarea.select();
        document.execCommand('copy');
        toast.success('已复制到剪贴板！');
      } else {
        toast.error('复制失败，请手动选择内容复制');
      }
    }
  };

  const handleCopyCommand = async () => {
    if (!launchResult?.command) return;
    try {
      await navigator.clipboard.writeText(launchResult.command);
      toast.success('命令已复制！请在终端中执行');
    } catch {
      toast.error('复制失败');
    }
  };

  const handleLaunch = async () => {
    setLaunchLoading(true);
    setLaunchResult(null);
    try {
      const options: Partial<MigrationOptions> = {
        sourceSessionId: session.id,
        targetTool,
        includeThinking,
        includeToolCalls,
        maxRounds,
      };
      const result = await api.migrateLaunch(session.id, options);
      setLaunchResult(result);
      if (result.success) {
        toast.success(`已在新的终端窗口中启动 ${targetLabel}`);
      }
    } catch (err: any) {
      toast.error(err.message || '启动失败');
    } finally {
      setLaunchLoading(false);
    }
  };

  return (
    <div className="modal-overlay">
      <button
        type="button"
        className="modal-close-btn"
        onClick={onClose}
        aria-label="关闭"
      >×</button>
      <div className="modal modal--sticky-layout migration-modal" style={{ width: '900px', maxWidth: '90vw' }}>
        {/* Header */}
        <div className="modal-header">
          <h2>会话迁移</h2>
          <div style={{ fontSize: '13px', color: 'var(--text-tertiary)', marginLeft: '12px' }}>
            将 {sourceLabel} 会话迁移到 {targetLabel}
          </div>
        </div>

        {/* Body */}
        <div className="modal-body-scrollable" style={{ padding: '20px' }}>
          {/* Source Session Info */}
          <div className="migration-source-info">
            <div className="migration-source-title">
              {session.title?.replace(/<\/?session>/g, '').trim() || session.id.slice(0, 8)}
            </div>
            <div className="migration-source-meta">
              <span className={`badge migration-source-badge ${session.targetType === 'claude-code' ? 'migration-badge-claude' : 'migration-badge-codex'}`}>
                {session.targetType === 'claude-code' ? 'Claude Code' : 'Codex'}
              </span>
              <span>{session.requestCount} 轮对话</span>
              <span>{session.totalTokens.toLocaleString()} tokens</span>
              <span>{duration}</span>
            </div>
          </div>

          {/* Target Tool Selection — 来源 → 目标 */}
          <div style={{ marginTop: '20px' }}>
            <label style={{ display: 'block', marginBottom: '12px', fontWeight: 500, color: 'var(--text-secondary)', fontSize: '13px' }}>
              迁移方向
            </label>
            <div className="migration-tool-cards">
              {/* 左侧：来源工具（固定，不可点击） */}
              <div className="migration-tool-card is-source" style={{ cursor: 'default' }}>
                <div className="migration-tool-card-icon">
                  {session.targetType === 'claude-code' ? (
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Z"/>
                      <path d="M8.5 8.5h7v7h-7z"/>
                      <path d="M5 12h2"/><path d="M17 12h2"/><path d="M12 5v2"/><path d="M12 17v2"/>
                    </svg>
                  ) : (
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Z"/>
                      <path d="M12 6v4l3 2"/><path d="M9 18h6"/><path d="M9 14h3"/>
                    </svg>
                  )}
                </div>
                <div className="migration-tool-card-name">{sourceLabel}</div>
                <span className="migration-tool-card-badge">来源</span>
              </div>

              {/* 箭头（固定向右） */}
              <div className="migration-arrow">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14"/>
                  <path d="m12 5 7 7-7 7"/>
                </svg>
              </div>

              {/* 右侧：两个可选项并排大卡片 */}
              <button
                type="button"
                className={`migration-tool-card${targetTool === 'claude-code' ? ' active' : ''}`}
                onClick={() => { setTargetTool('claude-code'); setLaunchResult(null); }}
              >
                <div className="migration-tool-card-icon">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Z"/>
                    <path d="M8.5 8.5h7v7h-7z"/>
                    <path d="M5 12h2"/><path d="M17 12h2"/><path d="M12 5v2"/><path d="M12 17v2"/>
                  </svg>
                </div>
                <div className="migration-tool-card-name">Claude Code</div>
                <div className="migration-tool-card-desc">
                  {session.targetType === 'claude-code' && targetTool === 'claude-code' ? '同工具新会话' : 'Anthropic 编程助手'}
                </div>
              </button>

              <button
                type="button"
                className={`migration-tool-card${targetTool === 'codex' ? ' active' : ''}`}
                onClick={() => { setTargetTool('codex'); setLaunchResult(null); }}
              >
                <div className="migration-tool-card-icon">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Z"/>
                    <path d="M12 6v4l3 2"/><path d="M9 18h6"/><path d="M9 14h3"/>
                  </svg>
                </div>
                <div className="migration-tool-card-name">Codex</div>
                <div className="migration-tool-card-desc">
                  {session.targetType === 'codex' && targetTool === 'codex' ? '同工具新会话' : 'OpenAI 编程助手'}
                </div>
              </button>
            </div>
          </div>

          {/* Options */}
          <div className="migration-options" style={{ marginTop: '12px', display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '14px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={includeToolCalls}
                onChange={(e) => setIncludeToolCalls(e.target.checked)}
              />
              包含工具调用摘要
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '14px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={includeThinking}
                onChange={(e) => setIncludeThinking(e.target.checked)}
              />
              包含思考过程
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <label style={{ fontSize: '14px', whiteSpace: 'nowrap' }}>最大轮数：</label>
              <select
                value={maxRounds}
                onChange={(e) => setMaxRounds(Number(e.target.value))}
                style={{
                  padding: '4px 8px',
                  border: '1px solid var(--border-primary)',
                  borderRadius: '6px',
                  fontSize: '14px',
                  backgroundColor: 'var(--input-bg)',
                  color: 'var(--text-primary)',
                }}
              >
                <option value={0}>全部</option>
                <option value={5}>最近 5 轮</option>
                <option value={10}>最近 10 轮</option>
                <option value={20}>最近 20 轮</option>
                <option value={30}>最近 30 轮</option>
              </select>
            </div>
          </div>

          {/* Preview Button */}
          <div style={{ marginTop: '16px' }}>
            <button
              className="btn btn-primary"
              onClick={handlePreview}
              disabled={loading}
            >
              {loading ? '加载中...' : '预览迁移内容'}
            </button>
          </div>

          {/* Empty State — 未预览时的提示 */}
          {!preview && !loading && (
            <div className="migration-empty-hint">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9"/>
                <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4Z"/>
              </svg>
              <div>
                <div style={{ fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '4px' }}>请先预览迁移内容</div>
                <div style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>点击上方「预览迁移内容」按钮，确认迁移 Prompt 后即可启动目标工具或复制到剪贴板</div>
              </div>
            </div>
          )}

          {/* Preview Content */}
          {preview && (
            <div className="migration-preview-section" style={{ marginTop: '16px' }}>
              <textarea
                className="migration-prompt-textarea"
                value={editedPrompt}
                onChange={(e) => setEditedPrompt(e.target.value)}
                style={{
                  width: '100%',
                  minHeight: '400px',
                  padding: '12px',
                  border: '1px solid var(--border-primary)',
                  borderRadius: '8px',
                  fontSize: '13px',
                  fontFamily: 'monospace',
                  backgroundColor: 'var(--input-bg)',
                  color: 'var(--text-primary)',
                  resize: 'vertical',
                  lineHeight: 1.5,
                }}
              />
              <div className="migration-preview-footer" style={{ marginTop: '10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>
                  预估 Tokens: {preview.estimatedTokens.toLocaleString()}
                  {preview.warnings.map((w, i) => (
                    <span key={i} style={{ color: '#e67e22', marginLeft: '12px' }}>⚠ {w}</span>
                  ))}
                  {preview.content.extractedRounds > 0 && (
                    <span style={{ color: 'var(--text-tertiary)', marginLeft: '12px' }}>
                      {preview.content.extractedRounds}/{preview.content.totalRounds} 轮
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Launch Result */}
          {launchResult && (
            <div className={`migration-launch-result ${launchResult.success ? 'migration-launch-success' : 'migration-launch-fallback'}`}
              style={{
                marginTop: '16px',
                padding: '16px',
                borderRadius: '8px',
                backgroundColor: launchResult.success ? '#27ae6010' : '#e67e2210',
                border: `1px solid ${launchResult.success ? '#27ae6040' : '#e67e2240'}`,
              }}
            >
              {launchResult.success ? (
                <div>
                  <div style={{ fontSize: '14px', fontWeight: 600, color: '#27ae60', marginBottom: '8px' }}>
                    ✅ 已在新终端窗口中启动 {targetLabel}
                  </div>
                  <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                    请在新终端窗口中继续与 {targetLabel} 交互
                  </div>
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: '14px', fontWeight: 600, color: '#e67e22', marginBottom: '8px' }}>
                    ⚠️ {launchResult.reason || '无法自动启动'}
                  </div>
                  {launchResult.command && (
                    <div style={{ marginTop: '8px' }}>
                      <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>请在终端中执行以下命令：</div>
                      <pre style={{
                        marginTop: '6px',
                        padding: '10px',
                        backgroundColor: 'var(--bg-secondary)',
                        borderRadius: '6px',
                        fontSize: '12px',
                        fontFamily: 'monospace',
                        overflow: 'auto',
                      }}>
                        {launchResult.command}
                      </pre>
                      <button className="btn btn-sm btn-secondary" onClick={handleCopyCommand} style={{ marginTop: '6px' }}>
                        复制命令
                      </button>
                    </div>
                  )}
                  {launchResult.fallbackSuggestions && launchResult.fallbackSuggestions.length > 0 && (
                    <div style={{ marginTop: '8px', fontSize: '13px', color: 'var(--text-tertiary)' }}>
                      {launchResult.fallbackSuggestions.map((s, i) => (
                        <div key={i}>• {s}</div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="modal-footer">
          <button
            className="btn btn-primary"
            onClick={handleLaunch}
            disabled={launchLoading || !preview}
            title={!preview ? '请先预览迁移内容' : ''}
          >
            {launchLoading ? '启动中...' : `🚀 启动 ${targetLabel}`}
          </button>
          <button
            className="btn btn-secondary"
            onClick={handleCopyPrompt}
            disabled={!preview}
            title={!preview ? '请先预览迁移内容' : ''}
          >
            📋 复制到剪贴板
          </button>
          <button className="btn btn-secondary" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
