/**
 * 会话详情弹窗
 * 供 SessionsPage 和 AccessKeyDetailPage 共用
 * 基于原 SessionsPage 的弹窗结构，融合紧凑标题+信息布局
 */
import { useState } from 'react';
import dayjs from 'dayjs';
import type { RequestLog } from '../../types';
import LogDetailModal from './LogDetailModal';
import { ChatViewFromSessionLogs, cleanSessionTitle, extractChatMessagesFromLogs } from '../utils/session-chat-utils';

interface SessionInfo {
  id: string;
  targetType: string;
  title?: string;
  firstRequestAt: number;
  lastRequestAt: number;
  requestCount: number;
  totalTokens: number;
}

interface SessionDetailModalProps {
  session: SessionInfo;
  logs: RequestLog[];
  logsLoading: boolean;
  onRefreshLogs: () => void;
  onFetchNewLogs: () => Promise<RequestLog[]>;
  onClose: () => void;
  onExport?: (session: SessionInfo, logs: RequestLog[], viewMode: 'logs' | 'chat') => void;
}

export default function SessionDetailModal({
  session,
  logs,
  logsLoading,
  onRefreshLogs,
  onFetchNewLogs,
  onClose,
  onExport,
}: SessionDetailModalProps) {
  const [viewMode, setViewMode] = useState<'logs' | 'chat'>('logs');
  const [detailLog, setDetailLog] = useState<RequestLog | null>(null);

  const formatDuration = (start: number, end: number) => {
    const d = end - start;
    if (d < 60000) return `${Math.floor(d / 1000)}秒`;
    if (d < 3600000) return `${Math.floor(d / 60000)}分钟`;
    return `${Math.floor(d / 3600000)}小时`;
  };

  const formatToken = (n: number) => {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  };

  const handleExport = () => {
    if (onExport) {
      onExport(session, logs, viewMode);
      return;
    }

    const title = cleanSessionTitle(session.title);
    const filename = `${title}.json`;

    if (viewMode === 'chat') {
      const chatMessages = extractChatMessagesFromLogs(logs);
      const exportData = {
        session: { id: session.id, targetType: session.targetType, title: session.title,
          firstRequestAt: session.firstRequestAt, lastRequestAt: session.lastRequestAt,
          requestCount: session.requestCount, totalTokens: session.totalTokens },
        messages: chatMessages.map(m => ({
          role: m.role, type: m.type, header: m.header, content: m.content,
          thinking: m.thinking, timestamp: m.timestamp, model: m.model, tokens: m.tokens,
        })),
      };
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
    } else {
      const exportData = {
        session: { id: session.id, targetType: session.targetType, title: session.title,
          firstRequestAt: session.firstRequestAt, lastRequestAt: session.lastRequestAt,
          requestCount: session.requestCount, totalTokens: session.totalTokens },
        logs,
      };
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
    }
  };

  return (
    <div className="modal-overlay">
      <button type="button" className="modal-close-btn" onClick={onClose} aria-label="关闭">×</button>
      <div className="modal modal--sticky-layout" style={{ width: '900px', maxWidth: '90vw' }}>
        {/* Header */}
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <h2>会话详情</h2>
            <button className="session-refresh-btn" onClick={onRefreshLogs} disabled={logsLoading} title="刷新">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={logsLoading ? 'spin-icon' : ''}>
                <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.3"/>
              </svg>
            </button>
          </div>
          <div className="session-view-toggle">
            <button className={viewMode === 'logs' ? 'active' : ''} onClick={() => setViewMode('logs')}>日志</button>
            <button className={viewMode === 'chat' ? 'active' : ''} onClick={() => setViewMode('chat')}>对话</button>
          </div>
        </div>

        {/* Body */}
        <div className="modal-body-scrollable">
          {viewMode === 'logs' ? (
            <>
              {/* 紧凑标题+信息卡片 */}
              <div style={{ marginBottom: '12px', padding: '10px 12px', background: 'var(--bg-secondary)', borderRadius: '8px' }}>
                <div style={{ fontSize: '15px', fontWeight: 500, marginBottom: '8px' }}>{cleanSessionTitle(session.title)}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px 20px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                  <div>
                    <span style={{ color: 'var(--text-tertiary)' }}>类型</span>{' '}
                    <span style={{ display: 'inline-block', padding: '1px 6px', borderRadius: '4px', fontSize: '12px',
                      background: session.targetType === 'claude-code' ? 'rgba(59,130,246,0.1)' : 'rgba(34,197,94,0.1)',
                      color: session.targetType === 'claude-code' ? 'var(--color-primary, #3b82f6)' : 'var(--color-success, #22c55e)',
                    }}>
                      {session.targetType === 'claude-code' ? 'Claude Code' : 'Codex'}
                    </span>
                  </div>
                  <div><span style={{ color: 'var(--text-tertiary)' }}>请求数</span> {session.requestCount}</div>
                  <div><span style={{ color: 'var(--text-tertiary)' }}>Tokens</span> {formatToken(session.totalTokens)}</div>
                  <div><span style={{ color: 'var(--text-tertiary)' }}>时长</span> {formatDuration(session.firstRequestAt, session.lastRequestAt)}</div>
                  <div><span style={{ color: 'var(--text-tertiary)' }}>首次请求</span> {dayjs(session.firstRequestAt).format('YYYY-MM-DD HH:mm:ss')}</div>
                  <div><span style={{ color: 'var(--text-tertiary)' }}>最后请求</span> {dayjs(session.lastRequestAt).format('YYYY-MM-DD HH:mm:ss')}</div>
                </div>
              </div>

              {/* 会话日志 */}
              <h3 style={{ marginTop: '0', marginBottom: '10px' }}>会话日志 ({logs.length})</h3>
              {logsLoading ? (
                <div style={{ textAlign: 'center', padding: '20px' }}>加载中...</div>
              ) : logs.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '20px', color: '#7f8c8d' }}>暂无日志</div>
              ) : (
                <div style={{ border: '1px solid var(--border-color)', borderRadius: '8px', overflow: 'hidden' }}>
                  <table style={{ fontSize: '14px' }}>
                    <thead>
                      <tr>
                        <th>时间</th>
                        <th>状态</th>
                        <th>响应时间</th>
                        <th>Tokens</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...logs].sort((a, b) => a.timestamp - b.timestamp).map((log) => (
                        <tr key={log.id}>
                          <td>{dayjs(log.timestamp).format('HH:mm:ss')}</td>
                          <td>
                            <span className={`badge ${log.statusCode && log.statusCode >= 200 && log.statusCode < 300 ? 'badge-success' : log.statusCode && log.statusCode >= 400 ? 'badge-danger' : 'badge-warning'}`}>
                              {log.statusCode || 'Error'}
                            </span>
                          </td>
                          <td>{log.responseTime ? `${log.responseTime}ms` : '-'}</td>
                          <td>
                            {log.usage ? (
                              <span>{log.usage.totalTokens || log.usage.inputTokens + log.usage.outputTokens}</span>
                            ) : '-'}
                          </td>
                          <td>
                            <button className="btn btn-sm btn-secondary" onClick={() => setDetailLog(log)}>详情</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : (
            <>
              {logsLoading ? (
                <div style={{ textAlign: 'center', padding: '20px' }}>加载中...</div>
              ) : (
                <ChatViewFromSessionLogs
                  logs={logs}
                  onFetchNew={onFetchNewLogs}
                />
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="modal-footer">
          <button className="btn btn-primary" onClick={handleExport} disabled={logs.length === 0}>导出</button>
          <button className="btn btn-secondary" onClick={onClose}>关闭</button>
        </div>
      </div>

      {/* 日志详情子弹窗 */}
      {detailLog && (
        <LogDetailModal log={detailLog} onClose={() => setDetailLog(null)} />
      )}
    </div>
  );
}
