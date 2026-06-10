import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { AccessKey, Policy, Route, KeyUsage, KeyUsageDailyRecord, AccessKeyRequestLog } from '../../types';
import { toast } from '../components/Toast';
import { useConfirm } from '../components/Confirm';
import { Pagination } from '../components/Pagination';
import LogDetailModal from '../components/LogDetailModal';
import AccessKeyGuideModal from '../components/AccessKeyGuideModal';

type DetailTab = 'info' | 'policy' | 'stats' | 'logs';

export default function AccessKeyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { confirm } = useConfirm();

  // 基础数据
  const [key, setKey] = useState<(AccessKey & { policyName?: string }) | null>(null);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [loading, setLoading] = useState(true);

  // Tab 状态
  const [activeTab, setActiveTab] = useState<DetailTab>('info');

  // 统计 Tab
  const [usage, setUsage] = useState<KeyUsage | null>(null);
  const [trend, setTrend] = useState<KeyUsageDailyRecord[]>([]);
  const [trendDays, setTrendDays] = useState(30);

  // 日志 Tab
  const [logs, setLogs] = useState<AccessKeyRequestLog[]>([]);
  const [logsTotal, setLogsTotal] = useState(0);
  const [logsPage, setLogsPage] = useState(1);
  const [logsPageSize, setLogsPageSize] = useState(20);
  const [logsStartDate, setLogsStartDate] = useState('');
  const [logsEndDate, setLogsEndDate] = useState('');
  const [selectedLog, setSelectedLog] = useState<AccessKeyRequestLog | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [countdown, setCountdown] = useState(10);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 弹窗
  const [showEditModal, setShowEditModal] = useState(false);
  const [editName, setEditName] = useState('');
  const [editRemark, setEditRemark] = useState('');
  const [editPolicyId, setEditPolicyId] = useState('');
  const [guideData, setGuideData] = useState<{ key: AccessKey; guide: any } | null>(null);
  const [showWriteLocalModal, setShowWriteLocalModal] = useState(false);
  const [writeLocalTargets, setWriteLocalTargets] = useState<{ 'claude-code': boolean; codex: boolean }>({ 'claude-code': true, codex: true });
  const [writeLocalLoading, setWriteLocalLoading] = useState(false);

  // ==================== 数据加载 ====================

  const loadKeyData = useCallback(async () => {
    if (!id) return;
    try {
      const [keyData, policiesData, routesData] = await Promise.all([
        api.getAccessKey(id).catch(() => null),
        api.getPolicies().catch(() => []),
        api.getRoutes().catch(() => []),
      ]);
      if (!keyData) {
        toast.error('密钥不存在');
        navigate('/access-keys');
        return;
      }
      setKey(keyData);
      setPolicies(policiesData);
      setRoutes(routesData);
      setEditName(keyData.name);
      setEditRemark(keyData.remark || '');
      setEditPolicyId(keyData.policyId || '');
    } catch (err: any) {
      toast.error('加载数据失败: ' + err.message);
    } finally {
      setLoading(false);
    }
  }, [id, navigate]);

  const loadUsageData = useCallback(async () => {
    if (!id) return;
    try {
      const [usageData, trendData] = await Promise.all([
        api.getAccessKeyUsage(id).catch(() => null),
        api.getAccessKeyUsageTrend(id, trendDays).catch(() => []),
      ]);
      setUsage(usageData);
      setTrend(trendData);
    } catch {
      // ignore
    }
  }, [id, trendDays]);

  const loadLogData = useCallback(async () => {
    if (!id) return;
    try {
      const result = await api.getAccessKeyLogs(id, {
        page: logsPage,
        pageSize: logsPageSize,
        startDate: logsStartDate || undefined,
        endDate: logsEndDate || undefined,
      });
      setLogs(result.data);
      setLogsTotal(result.total);
    } catch {
      // ignore
    }
  }, [id, logsPage, logsPageSize, logsStartDate, logsEndDate]);

  // 初始加载
  useEffect(() => { loadKeyData(); }, [loadKeyData]);

  // Tab 切换时按需加载
  useEffect(() => {
    if (activeTab === 'stats') loadUsageData();
    if (activeTab === 'logs') loadLogData();
  }, [activeTab, loadUsageData, loadLogData]);

  // 自动刷新倒计时
  useEffect(() => {
    if (autoRefresh && activeTab === 'logs') {
      countdownRef.current = setInterval(() => {
        setCountdown(prev => {
          if (prev <= 1) {
            loadLogData();
            return 10;
          }
          return prev - 1;
        });
      }, 1000);
      return () => { if (countdownRef.current) clearInterval(countdownRef.current); };
    } else {
      if (countdownRef.current) clearInterval(countdownRef.current);
      setCountdown(10);
    }
  }, [autoRefresh, activeTab, loadLogData]);

  // ==================== 操作函数 ====================

  const handleSave = async () => {
    if (!id || !editName.trim()) return;
    try {
      await api.updateAccessKey(id, {
        name: editName.trim(),
        remark: editRemark || undefined,
        policyId: editPolicyId || undefined,
      });
      toast.success('已保存');
      setShowEditModal(false);
      loadKeyData();
    } catch (err: any) {
      toast.error('保存失败: ' + err.message);
    }
  };

  const handleToggleStatus = async () => {
    if (!key) return;
    try {
      await api.updateAccessKey(key.id, { status: key.status === 'active' ? 'disabled' : 'active' });
      toast.success(key.status === 'active' ? '已停用' : '已启用');
      loadKeyData();
    } catch (err: any) {
      toast.error('操作失败: ' + err.message);
    }
  };

  const handleDelete = async () => {
    if (!key) return;
    const ok = await confirm({ message: '确定删除此密钥吗？删除后不可恢复。' });
    if (!ok) return;
    try {
      await api.deleteAccessKey(key.id);
      toast.success('已删除');
      navigate('/access-keys');
    } catch (err: any) {
      toast.error('删除失败: ' + err.message);
    }
  };

  const handleGuide = async () => {
    if (!key) return;
    try {
      const guide = await api.getAccessKeyGuide(key.id);
      setGuideData({ key, guide });
    } catch (err: any) {
      toast.error('获取指引失败: ' + err.message);
    }
  };

  const handleCopyKey = async () => {
    if (!key) return;
    try {
      // 尝试获取完整 key（从 guide 接口）
      const guide = await api.getAccessKeyGuide(key.id);
      const fullKey = guide?.claudeCode?.envVars?.ANTHROPIC_AUTH_TOKEN || key.apiKey;
      await navigator.clipboard.writeText(fullKey);
      toast.success('已复制到剪贴板');
    } catch {
      // guide API 可能只返回脱敏 key，使用当前显示的 key
      try {
        await navigator.clipboard.writeText(key.apiKey);
        toast.success('已复制到剪贴板');
      } catch {
        toast.error('复制失败');
      }
    }
  };

  const handleWriteLocal = async () => {
    if (!key) return;
    const targets = Object.entries(writeLocalTargets)
      .filter(([, v]) => v)
      .map(([k]) => k);
    if (targets.length === 0) {
      toast.error('请选择至少一个目标');
      return;
    }
    setWriteLocalLoading(true);
    try {
      await api.writeAccessKeyToLocal(key.id, targets);
      toast.success('已写入本地配置文件');
      setShowWriteLocalModal(false);
    } catch (err: any) {
      toast.error('写入失败: ' + (err.message || '未知错误'));
    } finally {
      setWriteLocalLoading(false);
    }
  };

  // ==================== 工具函数 ====================

  const formatToken = (n: number) => {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  };

  const formatDate = (ts: number | undefined) => {
    if (!ts) return '-';
    return new Date(ts).toLocaleString();
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 12px', borderRadius: '8px',
    border: '1px solid var(--border-primary)', background: 'var(--bg-secondary)',
    color: 'var(--text-primary)', boxSizing: 'border-box', fontSize: '14px',
  };

  // ==================== 加载状态 ====================

  if (loading) return <div style={{ textAlign: 'center', padding: '40px' }}>加载中...</div>;
  if (!key) return null;

  const successRate = usage && usage.lifetime.totalRequests > 0
    ? (((usage.lifetime.totalRequests - usage.lifetime.errorCount) / usage.lifetime.totalRequests) * 100).toFixed(1)
    : '-';

  const trendMaxTokens = Math.max(...trend.map(t => t.tokens), 1);
  const trendMaxRequests = Math.max(...trend.map(t => t.requests), 1);

  // ==================== 渲染 ====================

  const tabs: { key: DetailTab; label: string }[] = [
    { key: 'info', label: '基本信息' },
    { key: 'policy', label: '策略' },
    { key: 'stats', label: '统计' },
    { key: 'logs', label: '日志' },
  ];

  return (
    <div className="page-container">
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
        <button className="btn btn-secondary" onClick={() => navigate('/access-keys')}>← 返回</button>
        <h2 style={{ flex: 1 }}>{key.name}</h2>
        <button className="ak-action-btn" style={{ padding: '6px 14px' }} onClick={() => setShowEditModal(true)}>编辑</button>
        <button className="ak-action-btn" style={{ padding: '6px 14px' }} onClick={() => setShowWriteLocalModal(true)}>💾 写入本地</button>
        <button className="ak-action-btn" style={{ padding: '6px 14px' }} onClick={handleToggleStatus}>
          {key.status === 'active' ? '停用' : '启用'}
        </button>
        <button className="ak-action-btn ak-action-btn--danger" style={{ padding: '6px 14px' }} onClick={handleDelete}>删除</button>
      </div>

      {/* Tab 栏 */}
      <div className="ak-tab-bar" style={{ display: 'flex', gap: '0', borderBottom: '2px solid var(--border-primary)', marginBottom: '20px' }}>
        {tabs.map(tab => (
          <button
            key={tab.key}
            className={`ak-tab-btn ${activeTab === tab.key ? 'ak-tab-btn--active' : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ==================== 基本信息 Tab ==================== */}
      {activeTab === 'info' && (
        <div className="card">
          <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: '16px 20px', alignItems: 'start' }}>
            {/* API Key */}
            <div style={{ color: 'var(--text-tertiary)', fontSize: '14px', paddingTop: '4px' }}>API Key</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <code style={{ fontSize: '14px', padding: '4px 8px', background: 'var(--bg-secondary)', borderRadius: '4px' }}>{key.apiKey}</code>
              <button className="ak-action-btn" onClick={handleCopyKey} title="复制">📋</button>
              <button className="ak-action-btn" onClick={handleGuide}>接入指引</button>
            </div>

            {/* 策略 */}
            <div style={{ color: 'var(--text-tertiary)', fontSize: '14px', paddingTop: '4px' }}>策略</div>
            <div style={{ fontSize: '14px' }}>
              {key.policyName || <span style={{ color: 'var(--text-tertiary)' }}>未配置</span>}
            </div>

            {/* 状态 */}
            <div style={{ color: 'var(--text-tertiary)', fontSize: '14px', paddingTop: '4px' }}>状态</div>
            <div style={{ fontSize: '14px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{
                display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%',
                background: key.status === 'active' ? 'var(--color-success, #22c55e)' : 'var(--text-tertiary)',
              }} />
              {key.status === 'active' ? '启用' : '停用'}
            </div>

            {/* 创建时间 */}
            <div style={{ color: 'var(--text-tertiary)', fontSize: '14px', paddingTop: '4px' }}>创建时间</div>
            <div style={{ fontSize: '14px' }}>{formatDate(key.createdAt)}</div>

            {/* 最后活跃 */}
            <div style={{ color: 'var(--text-tertiary)', fontSize: '14px', paddingTop: '4px' }}>最后活跃</div>
            <div style={{ fontSize: '14px' }}>{formatDate(key.lastActiveAt)}</div>

            {/* 备注 */}
            <div style={{ color: 'var(--text-tertiary)', fontSize: '14px', paddingTop: '4px' }}>备注</div>
            <div style={{ fontSize: '14px', color: key.remark ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>
              {key.remark || '无'}
            </div>

            {/* 累计用量摘要 */}
            {usage && (
              <>
                <div style={{ color: 'var(--text-tertiary)', fontSize: '14px', paddingTop: '4px' }}>累计 Token</div>
                <div style={{ fontSize: '14px' }}>{formatToken(usage.lifetime.totalTokens)}</div>
                <div style={{ color: 'var(--text-tertiary)', fontSize: '14px', paddingTop: '4px' }}>累计请求</div>
                <div style={{ fontSize: '14px' }}>{usage.lifetime.totalRequests}</div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ==================== 策略 Tab ==================== */}
      {activeTab === 'policy' && (() => {
        const policy = policies.find(p => p.id === key.policyId);
        const routeName = policy?.routeId && policy.routeId !== 'system' ? routes.find(r => r.id === policy.routeId)?.name : undefined;
        const formatQuota = (p: Policy) => {
          const parts: string[] = [];
          if (p.dailyTokenLimit) parts.push(`日 ${p.dailyTokenLimit}k Token`);
          if (p.weeklyTokenLimit) parts.push(`周 ${p.weeklyTokenLimit}k Token`);
          if (p.monthlyTokenLimit) parts.push(`月 ${p.monthlyTokenLimit}k Token`);
          if (p.customTokenLimit && p.customTokenResetHours) parts.push(`${p.customTokenResetHours}h ${p.customTokenLimit}k Token`);
          if (p.dailyRequestLimit) parts.push(`日 ${p.dailyRequestLimit} 次请求`);
          if (p.weeklyRequestLimit) parts.push(`周 ${p.weeklyRequestLimit} 次请求`);
          if (p.monthlyRequestLimit) parts.push(`月 ${p.monthlyRequestLimit} 次请求`);
          if (p.customRequestLimit && p.customRequestResetHours) parts.push(`${p.customRequestResetHours}h ${p.customRequestLimit} 次请求`);
          if (p.rpmLimit) parts.push(`RPM ${p.rpmLimit}`);
          if (p.concurrentLimit) parts.push(`并发 ${p.concurrentLimit}`);
          return parts.length > 0 ? parts : null;
        };
        const modelList = policy?.allowedModels?.length ? policy.allowedModels
          : policy?.blockedModels?.length ? policy.blockedModels : null;
        const modelMode = policy?.allowedModels?.length ? 'allow'
          : policy?.blockedModels?.length ? 'block' : 'none';

        if (!policy) {
          return (
            <div className="card" style={{ textAlign: 'center', padding: '60px 20px' }}>
              <div style={{ fontSize: '36px', marginBottom: '12px' }}>📋</div>
              <div style={{ fontSize: '16px', fontWeight: 500, marginBottom: '8px' }}>未绑定策略</div>
              <div style={{ color: 'var(--text-tertiary)', fontSize: '13px' }}>
                可在「编辑」弹窗中为此密钥绑定策略，以启用配额限制和模型过滤
              </div>
            </div>
          );
        }

        const quotas = formatQuota(policy);
        return (
          <div className="card">
            {/* 策略头部 */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <div>
                <h3 style={{ margin: '0 0 4px', fontSize: '18px' }}>📋 {policy.name}</h3>
                {policy.description && <div style={{ color: 'var(--text-tertiary)', fontSize: '13px' }}>{policy.description}</div>}
              </div>
              <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>只读 · 如需修改请前往策略管理</span>
            </div>

            {/* 路由绑定 */}
            <div style={{ display: 'flex', gap: '4px', alignItems: 'center', marginBottom: '20px', paddingBottom: '20px', borderBottom: '1px solid var(--border-primary)' }}>
              <div style={{ color: 'var(--text-tertiary)', fontSize: '14px' }}>绑定路由：</div>
              <div style={{ fontSize: '14px' }}>
                {routeName ? (
                  <span>{routeName}</span>
                ) : (
                  <span style={{ color: 'var(--accent-color, #4a90d9)' }}>按系统默认</span>
                )}
              </div>
            </div>

            {/* 配额限制 */}
            <div style={{ marginBottom: '20px', paddingBottom: '20px', borderBottom: '1px solid var(--border-primary)' }}>
              <h4 style={{ margin: '0 0 12px', fontSize: '15px' }}>📊 配额限制</h4>
              {quotas ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                  {quotas.map((q, i) => (
                    <span key={i} style={{
                      display: 'inline-block', padding: '6px 12px', borderRadius: '6px',
                      background: 'var(--bg-secondary)', fontSize: '13px',
                      border: '1px solid var(--border-primary)',
                    }}>{q}</span>
                  ))}
                </div>
              ) : (
                <div style={{ color: 'var(--text-tertiary)', fontSize: '14px' }}>无限制</div>
              )}
            </div>

            {/* 模型过滤 */}
            <div>
              <h4 style={{ margin: '0 0 12px', fontSize: '15px' }}>🏷️ 模型过滤</h4>
              {modelMode === 'none' ? (
                <div style={{ color: 'var(--text-tertiary)', fontSize: '14px' }}>不限制，允许所有模型</div>
              ) : (
                <div>
                  <div style={{ fontSize: '13px', marginBottom: '10px', color: 'var(--text-secondary)' }}>
                    {modelMode === 'allow' ? '✅ 白名单模式 — 仅允许以下模型' : '🚫 黑名单模式 — 禁止以下模型'}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                    {modelList!.map((m, i) => (
                      <span key={i} style={{
                        display: 'inline-flex', alignItems: 'center', gap: '6px',
                        padding: '5px 12px', background: 'var(--bg-secondary)',
                        borderRadius: '16px', fontSize: '13px', border: '1px solid var(--border-primary)',
                      }}>
                        {m}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* ==================== 统计 Tab ==================== */}
      {activeTab === 'stats' && (
        <div>
          {/* 概览卡片 */}
          {usage && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px', marginBottom: '20px' }}>
              {[
                { label: '累计 Token', value: formatToken(usage.lifetime.totalTokens) },
                { label: '累计请求', value: String(usage.lifetime.totalRequests) },
                { label: '成功率', value: successRate + '%' },
                { label: '错误数', value: String(usage.lifetime.errorCount) },
                { label: '输入 Token', value: formatToken(usage.lifetime.inputTokens) },
                { label: '输出 Token', value: formatToken(usage.lifetime.outputTokens) },
              ].map(card => (
                <div key={card.label} className="card" style={{ padding: '16px', textAlign: 'center', marginBottom: '0' }}>
                  <div style={{ color: 'var(--text-tertiary)', fontSize: '13px', marginBottom: '4px' }}>{card.label}</div>
                  <div style={{ fontSize: '20px', fontWeight: 600 }}>{card.value}</div>
                </div>
              ))}
            </div>
          )}

          {/* 趋势图区 */}
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h4 style={{ margin: 0 }}>消耗趋势</h4>
              <div style={{ display: 'flex', gap: '4px' }}>
                {[7, 30, 90].map(d => (
                  <button
                    key={d}
                    className={`ak-action-btn ${trendDays === d ? 'ak-action-btn--active' : ''}`}
                    style={{ padding: '3px 10px', fontSize: '12px' }}
                    onClick={() => setTrendDays(d)}
                  >
                    {d}天
                  </button>
                ))}
              </div>
            </div>

            {trend.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-tertiary)' }}>暂无趋势数据</div>
            ) : (
              <>
                {/* Token 消耗 */}
                <div style={{ marginBottom: '20px' }}>
                  <div style={{ fontSize: '13px', color: 'var(--text-tertiary)', marginBottom: '8px' }}>Token 消耗</div>
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: '2px', height: '80px' }}>
                    {trend.slice(-trendDays).map((t, i) => (
                      <div key={i} style={{
                        flex: 1, minWidth: 0,
                        height: trendMaxTokens > 0 ? `${Math.max(2, (t.tokens / trendMaxTokens) * 100)}%` : '2px',
                        background: 'var(--color-primary, #3b82f6)',
                        borderRadius: '2px 2px 0 0',
                        transition: 'height 0.2s',
                      }} title={`${t.date}: ${formatToken(t.tokens)}`} />
                    ))}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '4px' }}>
                    <span>{trend[0]?.date}</span>
                    <span>{trend[trend.length - 1]?.date}</span>
                  </div>
                </div>

                {/* 请求量 */}
                <div style={{ marginBottom: '8px' }}>
                  <div style={{ fontSize: '13px', color: 'var(--text-tertiary)', marginBottom: '8px' }}>请求量</div>
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: '2px', height: '60px' }}>
                    {trend.slice(-trendDays).map((t, i) => (
                      <div key={i} style={{
                        flex: 1, minWidth: 0,
                        height: trendMaxRequests > 0 ? `${Math.max(2, (t.requests / trendMaxRequests) * 100)}%` : '2px',
                        background: 'var(--color-success, #22c55e)',
                        borderRadius: '2px 2px 0 0',
                        transition: 'height 0.2s',
                      }} title={`${t.date}: ${t.requests} 请求`} />
                    ))}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '4px' }}>
                    <span>{trend[0]?.date}</span>
                    <span>{trend[trend.length - 1]?.date}</span>
                  </div>
                </div>

                {/* 错误数 */}
                <div>
                  <div style={{ fontSize: '13px', color: 'var(--text-tertiary)', marginBottom: '8px' }}>错误数</div>
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: '2px', height: '40px' }}>
                    {trend.slice(-trendDays).map((t, i) => {
                      const maxErrors = Math.max(...trend.map(t => t.errors), 1);
                      return (
                        <div key={i} style={{
                          flex: 1, minWidth: 0,
                          height: maxErrors > 0 ? `${Math.max(2, (t.errors / maxErrors) * 100)}%` : '2px',
                          background: t.errors > 0 ? 'var(--accent-danger, #ef4444)' : 'var(--border-primary)',
                          borderRadius: '2px 2px 0 0',
                          transition: 'height 0.2s',
                        }} title={`${t.date}: ${t.errors} 错误`} />
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ==================== 日志 Tab ==================== */}
      {activeTab === 'logs' && (
        <div>
          {/* 筛选栏 */}
          <div className="card" style={{ marginBottom: '16px', padding: '12px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <label style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>开始日期</label>
                <input type="date" value={logsStartDate} onChange={e => { setLogsStartDate(e.target.value); setLogsPage(1); }}
                  style={{ padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--border-primary)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: '13px' }} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <label style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>结束日期</label>
                <input type="date" value={logsEndDate} onChange={e => { setLogsEndDate(e.target.value); setLogsPage(1); }}
                  style={{ padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--border-primary)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: '13px' }} />
              </div>
              <button className="ak-action-btn" onClick={() => loadLogData()} style={{ padding: '4px 12px' }}>🔄 刷新</button>
              <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px', cursor: 'pointer', color: 'var(--text-tertiary)' }}>
                <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
                自动刷新 {autoRefresh && <span style={{ color: 'var(--color-primary)' }}>({countdown}s)</span>}
              </label>
            </div>
          </div>

          {/* 日志表格 */}
          <div className="card">
            {logs.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-tertiary)' }}>暂无请求记录</div>
            ) : (
              <>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border-primary)' }}>
                        <th style={{ padding: '8px 6px', textAlign: 'left' }}>时间</th>
                        <th style={{ padding: '8px 6px', textAlign: 'left' }}>路径</th>
                        <th style={{ padding: '8px 6px', textAlign: 'left' }}>模型</th>
                        <th style={{ padding: '8px 6px', textAlign: 'right' }}>Token</th>
                        <th style={{ padding: '8px 6px', textAlign: 'right' }}>耗时</th>
                        <th style={{ padding: '8px 6px', textAlign: 'center' }}>状态</th>
                        <th style={{ padding: '8px 6px', textAlign: 'left' }}>类型</th>
                        <th style={{ padding: '8px 6px', textAlign: 'center' }}>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {logs.map(log => {
                        const tokens = log.usage?.totalTokens || (log.usage?.inputTokens || 0) + (log.usage?.outputTokens || 0);
                        const statusOk = (log.statusCode || 200) < 400;
                        return (
                          <tr key={log.id} style={{ borderBottom: '1px solid var(--border-primary)', cursor: 'pointer' }}
                            onClick={() => setSelectedLog(log)}>
                            <td style={{ padding: '8px 6px', whiteSpace: 'nowrap' }}>{new Date(log.timestamp).toLocaleString()}</td>
                            <td style={{ padding: '8px 6px', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{log.path || '-'}</td>
                            <td style={{ padding: '8px 6px' }}>{log.requestModel || log.targetModel || '-'}</td>
                            <td style={{ padding: '8px 6px', textAlign: 'right' }}>{formatToken(tokens)}</td>
                            <td style={{ padding: '8px 6px', textAlign: 'right' }}>{log.responseTime ? (log.responseTime / 1000).toFixed(1) + 's' : '-'}</td>
                            <td style={{ padding: '8px 6px', textAlign: 'center' }}>
                              <span style={{ display: 'inline-block', padding: '2px 6px', borderRadius: '4px', fontSize: '12px',
                                background: statusOk ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                                color: statusOk ? 'var(--color-success, #22c55e)' : 'var(--accent-danger, #ef4444)',
                              }}>{log.statusCode || 200}</span>
                            </td>
                            <td style={{ padding: '8px 6px' }}>{log.contentType || '-'}</td>
                            <td style={{ padding: '8px 6px', textAlign: 'center' }}>
                              <button className="ak-action-btn" style={{ padding: '2px 8px', fontSize: '12px' }}
                                onClick={e => { e.stopPropagation(); setSelectedLog(log); }}>详情</button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div style={{ marginTop: '12px' }}>
                  <Pagination
                    currentPage={logsPage}
                    totalItems={logsTotal}
                    pageSize={logsPageSize}
                    onPageChange={setLogsPage}
                    onPageSizeChange={size => { setLogsPageSize(size); setLogsPage(1); }}
                  />
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ==================== 编辑弹窗 ==================== */}
      {showEditModal && (
        <div className="modal-overlay" onClick={() => setShowEditModal(false)}>
          <div className="modal" style={{ minWidth: 'auto', width: '480px', padding: '28px' }} onClick={e => e.stopPropagation()}>
            <button type="button" className="modal-close-btn"
              onClick={() => setShowEditModal(false)}
              style={{ top: '12px', right: '12px', width: '36px', height: '36px', fontSize: '24px' }}
              aria-label="关闭">×</button>
            <h3 style={{ margin: '0 0 20px', fontSize: '20px' }}>编辑密钥</h3>
            <div style={{ marginBottom: '14px' }}>
              <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600, fontSize: '14px' }}>名称</label>
              <input type="text" value={editName} onChange={e => setEditName(e.target.value)} style={inputStyle} />
            </div>
            <div style={{ marginBottom: '14px' }}>
              <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600, fontSize: '14px' }}>备注</label>
              <textarea value={editRemark} onChange={e => setEditRemark(e.target.value)}
                style={{ ...inputStyle, minHeight: '60px', resize: 'vertical' }} />
            </div>
            <div style={{ marginBottom: '24px' }}>
              <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600, fontSize: '14px' }}>策略</label>
              <select value={editPolicyId} onChange={e => setEditPolicyId(e.target.value)}
                style={{ ...inputStyle, cursor: 'pointer' }}>
                <option value="">未配置</option>
                {policies.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button onClick={() => setShowEditModal(false)} className="ak-modal-btn-secondary">取消</button>
              <button onClick={handleSave} className="ak-modal-btn-primary">保存</button>
            </div>
          </div>
        </div>
      )}

      {/* 日志详情弹窗 */}
      {selectedLog && (
        <LogDetailModal
          log={selectedLog}
          onClose={() => setSelectedLog(null)}
        />
      )}

      {/* 接入指引弹窗 */}
      {guideData && (
        <AccessKeyGuideModal
          keyName={guideData.key.name}
          apiKey={guideData.key.apiKey}
          guide={guideData.guide}
          onClose={() => setGuideData(null)}
        />
      )}

      {/* 写入本地弹窗 */}
      {showWriteLocalModal && (
        <div className="modal-overlay" onClick={() => setShowWriteLocalModal(false)}>
          <div className="modal" style={{ minWidth: 'auto', width: '420px', padding: '28px' }} onClick={e => e.stopPropagation()}>
            <button type="button" className="modal-close-btn"
              onClick={() => setShowWriteLocalModal(false)}
              style={{ top: '12px', right: '12px', width: '36px', height: '36px', fontSize: '24px' }}
              aria-label="关闭">×</button>
            <h3 style={{ margin: '0 0 16px', fontSize: '20px' }}>写入本地配置</h3>
            <p style={{ margin: '0 0 16px', fontSize: '14px', color: 'var(--text-secondary)' }}>
              将此密钥写入本地工具配置文件（仅更新认证字段，不影响其他配置）
            </p>
            <div style={{ marginBottom: '20px' }}>
              {([
                { key: 'claude-code' as const, label: 'Claude Code', desc: '~/.claude/settings.json → ANTHROPIC_AUTH_TOKEN' },
                { key: 'codex' as const, label: 'Codex', desc: '~/.codex/auth.json → OPENAI_API_KEY' },
              ]).map(item => (
                <label key={item.key} style={{
                  display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '12px',
                  marginBottom: '8px', borderRadius: '8px', border: '1px solid var(--border-primary)',
                  background: writeLocalTargets[item.key] ? 'var(--bg-secondary)' : 'transparent',
                  cursor: 'pointer',
                }}>
                  <input type="checkbox"
                    checked={writeLocalTargets[item.key]}
                    onChange={e => setWriteLocalTargets(prev => ({ ...prev, [item.key]: e.target.checked }))}
                    style={{ marginTop: '2px' }}
                  />
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '14px' }}>{item.label}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '2px' }}>{item.desc}</div>
                  </div>
                </label>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button onClick={() => setShowWriteLocalModal(false)} className="ak-modal-btn-secondary">取消</button>
              <button onClick={handleWriteLocal} className="ak-modal-btn-primary" disabled={writeLocalLoading}>
                {writeLocalLoading ? '写入中...' : '确认写入'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 样式 */}
      <style>{`
        .ak-tab-btn {
          padding: 10px 24px;
          border: none;
          background: transparent;
          color: var(--text-tertiary);
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          border-bottom: 2px solid transparent;
          margin-bottom: -2px;
          transition: all 0.15s;
        }
        .ak-tab-btn:hover {
          color: var(--text-secondary);
        }
        .ak-tab-btn--active {
          color: var(--color-primary, #3b82f6);
          border-bottom-color: var(--color-primary, #3b82f6);
          font-weight: 600;
        }
        .ak-action-btn {
          padding: 4px 10px; border-radius: 6px;
          border: 1px solid var(--border-primary);
          background: var(--bg-secondary);
          color: var(--text-secondary);
          cursor: pointer; font-size: 13px;
          transition: all 0.15s;
        }
        .ak-action-btn:hover {
          background: var(--bg-route-item-hover);
          border-color: var(--text-secondary);
        }
        .ak-action-btn--active {
          background: var(--color-primary, #3b82f6);
          color: #fff;
          border-color: var(--color-primary, #3b82f6);
        }
        .ak-action-btn--danger {
          color: var(--accent-danger);
        }
        .ak-action-btn--danger:hover {
          background: rgba(220, 38, 38, 0.1);
          border-color: var(--accent-danger);
        }
        .ak-modal-btn-primary {
          padding: 10px 28px; border-radius: 8px; border: none;
          background: var(--color-primary, #3b82f6); color: #fff;
          cursor: pointer; font-size: 14px; font-weight: 600;
          transition: opacity 0.15s;
        }
        .ak-modal-btn-primary:hover { opacity: 0.9; }
        .ak-modal-btn-secondary {
          padding: 10px 24px; border-radius: 8px;
          border: 1px solid var(--border-primary);
          background: var(--bg-secondary);
          color: var(--text-primary);
          cursor: pointer; font-size: 14px; font-weight: 500;
          transition: all 0.15s;
        }
        .ak-modal-btn-secondary:hover {
          background: var(--bg-route-item-hover);
        }

        /* 深色模式 */
        [data-theme="dark"] .ak-action-btn {
          background: rgba(30, 58, 40, 0.95);
          border-color: rgba(167, 243, 208, 0.2);
          color: #A7F3D0;
        }
        [data-theme="dark"] .ak-action-btn:hover {
          background: rgba(40, 75, 52, 0.95);
          border-color: rgba(167, 243, 208, 0.4);
        }
        [data-theme="dark"] .ak-action-btn--danger {
          color: #EF4444;
        }
        [data-theme="dark"] .ak-action-btn--danger:hover {
          background: rgba(239, 68, 68, 0.15);
          border-color: rgba(239, 68, 68, 0.5);
        }
        [data-theme="dark"] .ak-modal-btn-secondary {
          background: rgba(30, 58, 40, 0.95);
          border-color: rgba(167, 243, 208, 0.2);
          color: #ECFEF5;
        }
        [data-theme="dark"] .ak-modal-btn-secondary:hover {
          background: rgba(40, 75, 52, 0.95);
          border-color: rgba(167, 243, 208, 0.35);
        }
        [data-theme="dark"] .page-container select option {
          background: #0C1F12;
          color: #ECFEF5;
        }
        [data-theme="dark"] .page-container textarea,
        [data-theme="dark"] .page-container input[type="text"],
        [data-theme="dark"] .page-container input[type="date"] {
          color-scheme: dark;
        }
      `}</style>
    </div>
  );
}
