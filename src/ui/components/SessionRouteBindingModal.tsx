import { useState, useEffect } from 'react';
import { api } from '../api/client';
import type { Session, Route } from '../../types';
import { toast } from './Toast';

interface Props {
  session: Session;
  onClose: () => void;
  onBound: () => void;
}

export function SessionRouteBindingModal({ session, onClose, onBound }: Props) {
  const [routes, setRoutes] = useState<Route[]>([]);
  const [routeRuleCounts, setRouteRuleCounts] = useState<Record<string, number>>({});
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(session.routeId || null);
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);

  const clientLabel = session.targetType === 'claude-code' ? 'Claude Code' : 'Codex';

  useEffect(() => {
    const loadData = async () => {
      try {
        const routeList = await api.getRoutes();
        setRoutes(routeList);
        // 加载每个路由的规则数量
        const counts: Record<string, number> = {};
        for (const route of routeList) {
          try {
            const rules = await api.getRules(route.id);
            counts[route.id] = rules.length;
          } catch {
            counts[route.id] = 0;
          }
        }
        setRouteRuleCounts(counts);
      } catch (err: any) {
        toast.error('加载路由列表失败');
      } finally {
        setInitialLoading(false);
      }
    };
    loadData();
  }, []);

  const handleBind = async () => {
    if (!selectedRouteId) return;
    setLoading(true);
    try {
      const result = await api.bindSessionRoute(session.id, selectedRouteId);
      if (result.success) {
        toast.success('路由绑定成功');
        onBound();
        onClose();
      } else {
        toast.error(result.error || '绑定失败');
      }
    } catch (err: any) {
      toast.error(err.message || '绑定失败');
    } finally {
      setLoading(false);
    }
  };

  const handleUnbind = async () => {
    setLoading(true);
    try {
      const result = await api.unbindSessionRoute(session.id);
      if (result.success) {
        toast.success('已解除路由绑定');
        onBound();
        onClose();
      } else {
        toast.error(result.error || '解绑失败');
      }
    } catch (err: any) {
      toast.error(err.message || '解绑失败');
    } finally {
      setLoading(false);
    }
  };

  const isCurrentBindingChanged = selectedRouteId !== (session.routeId || null);

  return (
    <div className="modal-overlay">
      <button
        type="button"
        className="modal-close-btn"
        onClick={onClose}
        aria-label="关闭"
      >×</button>
      <div className="modal" style={{ width: '500px', maxWidth: '90vw' }}>
        {/* Header */}
        <div className="modal-header">
          <h2>路由绑定</h2>
          <div style={{ fontSize: '13px', color: 'var(--text-tertiary)', marginLeft: '12px' }}>
            为会话指定专用的路由
          </div>
        </div>

        {/* Body */}
        <div className="modal-body-scrollable" style={{ padding: '20px' }}>
          {/* Session Info */}
          <div style={{
            padding: '12px 16px',
            backgroundColor: 'var(--bg-secondary)',
            borderRadius: '8px',
            marginBottom: '20px',
          }}>
            <div style={{ fontWeight: 500, marginBottom: '6px' }}>
              {session.title?.replace(/<\/?session>/g, '').trim() || session.id.slice(0, 8)}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', display: 'flex', gap: '12px', alignItems: 'center' }}>
              <span className={`badge ${session.targetType === 'claude-code' ? 'badge-claude-code' : 'badge-codex'}`} style={{ fontSize: '11px' }}>
                {clientLabel}
              </span>
              <span>{session.requestCount} 次请求</span>
              <span>{session.totalTokens.toLocaleString()} tokens</span>
            </div>
          </div>

          {/* Current Binding */}
          {session.routeId && (
            <div style={{
              padding: '10px 14px',
              backgroundColor: 'var(--bg-info, rgba(41, 128, 185, 0.1))',
              borderRadius: '6px',
              marginBottom: '16px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              fontSize: '13px',
            }}>
              <span style={{ color: 'var(--text-secondary)' }}>
                当前绑定：<strong>{session.routeName || session.routeId}</strong>
              </span>
            </div>
          )}

          {/* Route Selection */}
          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', marginBottom: '10px', fontWeight: 500, color: 'var(--text-secondary)', fontSize: '13px' }}>
              选择路由
            </label>

            {initialLoading ? (
              <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-tertiary)' }}>
                加载中...
              </div>
            ) : routes.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-tertiary)' }}>
                <p>暂无可用路由</p>
                <p style={{ fontSize: '12px', marginTop: '8px' }}>请先在路由管理页面创建路由</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '300px', overflowY: 'auto' }}>
                {routes.map((route) => {
                  const isSelected = selectedRouteId === route.id;
                  const isCurrentBound = session.routeId === route.id;
                  return (
                    <div
                      key={route.id}
                      onClick={() => setSelectedRouteId(route.id)}
                      style={{
                        padding: '12px 14px',
                        border: `2px solid ${isSelected ? 'var(--color-primary, #2980b9)' : 'var(--border-primary, #e0e0e0)'}`,
                        borderRadius: '8px',
                        cursor: 'pointer',
                        backgroundColor: isSelected ? 'var(--bg-route-item-selected, rgba(41, 128, 185, 0.08))' : 'var(--bg-primary)',
                        transition: 'all 0.15s ease',
                        position: 'relative',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                          <div style={{ fontWeight: 500, fontSize: '14px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{
                              width: '16px',
                              height: '16px',
                              borderRadius: '50%',
                              border: `2px solid ${isSelected ? 'var(--color-primary, #2980b9)' : 'var(--border-secondary, #ccc)'}`,
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              flexShrink: 0,
                            }}>
                              {isSelected && (
                                <span style={{
                                  width: '8px',
                                  height: '8px',
                                  borderRadius: '50%',
                                  backgroundColor: 'var(--color-primary, #2980b9)',
                                }} />
                              )}
                            </span>
                            {route.name}
                            {isCurrentBound && (
                              <span style={{
                                fontSize: '10px',
                                padding: '1px 6px',
                                borderRadius: '4px',
                                backgroundColor: 'var(--color-primary, #2980b9)',
                                color: 'white',
                              }}>
                                当前
                              </span>
                            )}
                          </div>
                          {route.description && (
                            <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '4px', marginLeft: '24px' }}>
                              {route.description}
                            </div>
                          )}
                        </div>
                        <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', flexShrink: 0 }}>
                          {routeRuleCounts[route.id] || 0} 条规则
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="modal-footer">
          {session.routeId && (
            <button
              className="btn btn-danger"
              onClick={handleUnbind}
              disabled={loading}
            >
              解绑
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button
            className="btn btn-secondary"
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="btn btn-primary"
            onClick={handleBind}
            disabled={loading || !selectedRouteId || !isCurrentBindingChanged}
          >
            {loading ? '处理中...' : '确认绑定'}
          </button>
        </div>
      </div>
    </div>
  );
}
