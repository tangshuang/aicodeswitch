import { useState, useEffect, useRef } from 'react';
import { api } from '../api/client';
import type { AccessKey, Policy, Route } from '../../types';
import { useConfirm } from '../components/Confirm';
import { toast } from '../components/Toast';
import AccessKeyGuideModal from '../components/AccessKeyGuideModal';

export default function AccessKeysPage() {
  const [keys, setKeys] = useState<(AccessKey & { policyName?: string })[]>([]);
  const [policies, setPolicies] = useState<(Policy & { keyCount?: number })[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [templates, setTemplates] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showCreatedModal, setShowCreatedModal] = useState<{ key: AccessKey; apiKey: string } | null>(null);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyRemark, setNewKeyRemark] = useState('');
  const [newKeyPolicyId, setNewKeyPolicyId] = useState('');
  const [showBatchMenu, setShowBatchMenu] = useState(false);

  // ====== 策略管理状态 ======
  const [showPolicyPanel, setShowPolicyPanel] = useState(() => localStorage.getItem('policies-panel-open') === 'true');
  const [editingPolicy, setEditingPolicy] = useState<Policy | null>(null);
  const [showPolicyEditor, setShowPolicyEditor] = useState(false);
  const [formName, setFormName] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formRouteId, setFormRouteId] = useState('system');
  const [formDailyToken, setFormDailyToken] = useState('');
  const [formMonthlyToken, setFormMonthlyToken] = useState('');
  const [formDailyReq, setFormDailyReq] = useState('');
  const [formRpm, setFormRpm] = useState('');
  const [formConcurrent, setFormConcurrent] = useState('');
  const [formAllowedModels, setFormAllowedModels] = useState<string[]>([]);
  const [formBlockedModels, setFormBlockedModels] = useState<string[]>([]);
  const [formModelMode, setFormModelMode] = useState<'none' | 'allow' | 'block'>('none');
  const [modelInput, setModelInput] = useState('');
  const [allModels, setAllModels] = useState<{name: string; vendors: string[]}[]>([]);
  const [showModelSuggest, setShowModelSuggest] = useState(false);
  const modelInputRef = useRef<HTMLInputElement>(null);

  const { confirm } = useConfirm();
  const batchMenuRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭批量操作菜单
  useEffect(() => {
    if (!showBatchMenu) return;
    const handler = (e: MouseEvent) => {
      if (batchMenuRef.current && !batchMenuRef.current.contains(e.target as Node)) {
        setShowBatchMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showBatchMenu]);

  const loadKeys = async () => {
    setLoading(true);
    try {
      const result = await api.getAccessKeys({
        page, pageSize,
        status: statusFilter || undefined,
        search: searchQuery || undefined,
      } as any);
      setKeys(result.data);
      setTotal(result.total);
    } catch (err: any) {
      toast.error('加载密钥列表失败: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  const loadPolicies = async () => {
    try {
      const [p, r, t] = await Promise.all([
        api.getPolicies().catch(() => []),
        api.getRoutes().catch(() => []),
        api.getPolicyTemplates().catch(() => []),
      ]);
      setPolicies(p);
      setRoutes(r);
      setTemplates(t);
    } catch { /* ignore */ }
  };

  useEffect(() => { loadKeys(); }, [page, statusFilter, searchQuery]);
  useEffect(() => { loadPolicies(); }, []);

  // ====== AccessKey 操作 ======

  const handleCreate = async () => {
    if (!newKeyName.trim()) { toast.error('请输入密钥名称'); return; }
    try {
      const result = await api.createAccessKey({ name: newKeyName.trim(), remark: newKeyRemark || undefined, policyId: newKeyPolicyId || undefined });
      setShowCreateModal(false);
      setShowCreatedModal(result);
      setNewKeyName(''); setNewKeyRemark(''); setNewKeyPolicyId('');
      loadKeys();
    } catch (err: any) { toast.error('创建失败: ' + err.message); }
  };

  const handleToggleStatus = async (key: AccessKey) => {
    try {
      await api.updateAccessKey(key.id, { status: key.status === 'active' ? 'disabled' : 'active' });
      toast.success(key.status === 'active' ? '已停用' : '已启用');
      loadKeys();
    } catch (err: any) { toast.error('操作失败: ' + err.message); }
  };

  const handleDelete = async (key: AccessKey) => {
    const ok = await confirm({ message: `确定删除密钥「${key.name}」吗？` });
    if (!ok) return;
    try { await api.deleteAccessKey(key.id); toast.success('已删除'); loadKeys(); }
    catch (err: any) { toast.error('删除失败: ' + err.message); }
  };

  const handleRegenerate = async (key: AccessKey) => {
    const ok = await confirm({ message: '重新生成后旧密钥将立即失效，确定继续吗？' });
    if (!ok) return;
    try {
      const result = await api.regenerateAccessKey(key.id);
      setShowCreatedModal({ key: { ...key, apiKey: result.apiKey }, apiKey: result.apiKey });
      loadKeys();
    } catch (err: any) { toast.error('重新生成失败: ' + err.message); }
  };

  const [guideKey, setGuideKey] = useState<{ key: AccessKey; guide: any } | null>(null);

  const handleGuide = async (key: AccessKey) => {
    try {
      const guide = await api.getAccessKeyGuide(key.id);
      setGuideKey({ key, guide });
    } catch (err: any) { toast.error('获取指引失败: ' + err.message); }
  };

  const handleBatchStatus = async (status: 'active' | 'disabled') => {
    if (selectedIds.size === 0) return;
    try {
      await api.batchUpdateAccessKeyStatus(Array.from(selectedIds), status);
      toast.success(`已批量${status === 'active' ? '启用' : '停用'} ${selectedIds.size} 个密钥`);
      setSelectedIds(new Set()); setShowBatchMenu(false); loadKeys();
    } catch (err: any) { toast.error('批量操作失败: ' + err.message); }
  };

  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) return;
    const ok = await confirm({ message: `确定删除选中的 ${selectedIds.size} 个密钥吗？` });
    if (!ok) return;
    try {
      await api.batchDeleteAccessKeys(Array.from(selectedIds));
      toast.success(`已删除 ${selectedIds.size} 个密钥`);
      setSelectedIds(new Set()); setShowBatchMenu(false); loadKeys();
    } catch (err: any) { toast.error('批量删除失败: ' + err.message); }
  };

  const handleBatchBindPolicy = async (policyId: string) => {
    if (selectedIds.size === 0 || !policyId) return;
    try {
      await api.batchBindAccessKeyPolicy(Array.from(selectedIds), policyId);
      toast.success('已批量绑定策略');
      setSelectedIds(new Set()); setShowBatchMenu(false); loadKeys();
    } catch (err: any) { toast.error('批量绑定失败: ' + err.message); }
  };

  const toggleSelect = (id: string) => {
    const next = new Set(selectedIds);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelectedIds(next);
  };
  const toggleSelectAll = () => setSelectedIds(selectedIds.size === keys.length ? new Set() : new Set(keys.map(k => k.id)));
  const copyToClipboard = (text: string) => navigator.clipboard.writeText(text).then(() => toast.success('已复制'));

  // ====== Policy 操作 ======

  const resetPolicyForm = () => {
    setFormName(''); setFormDesc(''); setFormRouteId('');
    setFormDailyToken(''); setFormMonthlyToken(''); setFormDailyReq('');
    setFormRpm(''); setFormConcurrent('');
    setFormAllowedModels([]); setFormBlockedModels([]);
    setFormModelMode('none'); setModelInput('');
  };

  const openPolicyEditor = (policy?: Policy) => {
    if (policy) {
      setEditingPolicy(policy);
      setFormName(policy.name); setFormDesc(policy.description || ''); setFormRouteId(policy.routeId || 'system');
      setFormDailyToken(policy.dailyTokenLimit?.toString() || '');
      setFormMonthlyToken(policy.monthlyTokenLimit?.toString() || '');
      setFormDailyReq(policy.dailyRequestLimit?.toString() || '');
      setFormRpm(policy.rpmLimit?.toString() || ''); setFormConcurrent(policy.concurrentLimit?.toString() || '');
      setFormAllowedModels(policy.allowedModels || []); setFormBlockedModels(policy.blockedModels || []);
      setFormModelMode(policy.allowedModels?.length ? 'allow' : policy.blockedModels?.length ? 'block' : 'none');
    } else {
      setEditingPolicy(null);
      resetPolicyForm();
    }
    setShowPolicyEditor(true);
    // 加载所有可用模型用于自动补全
    loadAllModels();
  };

  const loadAllModels = async () => {
    try {
      const vendors = await api.getVendors();
      const map = new Map<string, Set<string>>();
      (vendors || []).forEach((v: any) => {
        const vName = v.name || '';
        (v.services || []).forEach((s: any) => {
          (s.supportedModels || []).forEach((m: string) => {
            if (!map.has(m)) map.set(m, new Set());
            map.get(m)!.add(vName);
          });
        });
      });
      setAllModels(Array.from(map.entries()).map(([name, vSet]) => ({ name, vendors: Array.from(vSet) })).sort((a, b) => a.name.localeCompare(b.name)));
    } catch { /* ignore */ }
  };

  const currentModelList = formModelMode === 'allow' ? formAllowedModels : formBlockedModels;
  const filteredModels = modelInput.trim()
    ? allModels.filter(m => m.name.toLowerCase().includes(modelInput.toLowerCase()) && !currentModelList.includes(m.name))
    : allModels.filter(m => !currentModelList.includes(m.name));

  const applyTemplate = (template: any) => {
    const c = template.config;
    setFormName(c.name || ''); setFormDesc(template.description);
    setFormDailyToken(c.dailyTokenLimit?.toString() || ''); setFormMonthlyToken(c.monthlyTokenLimit?.toString() || '');
    setFormDailyReq(c.dailyRequestLimit?.toString() || ''); setFormRpm(c.rpmLimit?.toString() || '');
    setFormConcurrent(c.concurrentLimit?.toString() || '');
    toast.success(`已应用模板: ${template.name}`);
  };

  const handleSavePolicy = async () => {
    if (!formName.trim()) { toast.error('请输入策略名称'); return; }
    const data: any = {
      name: formName.trim(), description: formDesc || undefined, routeId: formRouteId === 'system' ? 'system' : (formRouteId || undefined),
      dailyTokenLimit: formDailyToken ? Number(formDailyToken) : undefined,
      monthlyTokenLimit: formMonthlyToken ? Number(formMonthlyToken) : undefined,
      dailyRequestLimit: formDailyReq ? Number(formDailyReq) : undefined,
      rpmLimit: formRpm ? Number(formRpm) : undefined,
      concurrentLimit: formConcurrent ? Number(formConcurrent) : undefined,
      allowedModels: formModelMode === 'allow' ? formAllowedModels : undefined,
      blockedModels: formModelMode === 'block' ? formBlockedModels : undefined,
    };
    try {
      if (editingPolicy) { await api.updatePolicy(editingPolicy.id, data); toast.success('策略已更新'); }
      else { await api.createPolicy(data); toast.success('策略已创建'); }
      setShowPolicyEditor(false); loadPolicies(); loadKeys();
    } catch (err: any) { toast.error('保存失败: ' + err.message); }
  };

  const handleDeletePolicy = async (policy: Policy & { keyCount?: number }) => {
    if (policy.keyCount && policy.keyCount > 0) {
      toast.error(`有 ${policy.keyCount} 个密钥正在使用此策略，请先解除绑定`);
      return;
    }
    const ok = await confirm({ message: `确定删除策略「${policy.name}」吗？` });
    if (!ok) return;
    try { await api.deletePolicy(policy.id); toast.success('已删除'); loadPolicies(); loadKeys(); }
    catch (err: any) { toast.error('删除失败: ' + err.message); }
  };

  const handleDuplicatePolicy = async (policy: Policy) => {
    try { await api.duplicatePolicy(policy.id); toast.success('已复制'); loadPolicies(); }
    catch (err: any) { toast.error('复制失败: ' + err.message); }
  };

  const addModel = (list: string[], setList: (v: string[]) => void) => {
    const m = modelInput.trim();
    if (m && !list.includes(m)) { setList([...list, m]); setModelInput(''); }
  };

  const getRouteName = (routeId?: string) => routes.find(r => r.id === routeId)?.name;

  const formatQuota = (p: Policy) => {
    const parts: string[] = [];
    if (p.dailyTokenLimit) parts.push(`日${p.dailyTokenLimit}k`);
    if (p.monthlyTokenLimit) parts.push(`月${p.monthlyTokenLimit}k`);
    if (p.dailyRequestLimit) parts.push(`日${p.dailyRequestLimit}次`);
    if (p.rpmLimit) parts.push(`RPM ${p.rpmLimit}`);
    if (p.concurrentLimit) parts.push(`并发${p.concurrentLimit}`);
    return parts.length > 0 ? parts.join(', ') : '无限制';
  };

  const totalPages = Math.ceil(total / pageSize);

  const inputStyle: React.CSSProperties = {
    padding: '6px 10px', borderRadius: '4px', border: '1px solid var(--border-primary)',
    background: 'var(--bg-secondary)', color: 'var(--text-primary)', boxSizing: 'border-box', fontSize: '13px',
  };

  return (
    <div className="page-container">
      {/* 头部 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <h2 style={{ margin: 0 }}>接入密钥</h2>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button className="btn btn-primary" onClick={() => { setShowCreateModal(true); loadPolicies(); }} style={{ height: '45px' }}>+ 创建密钥</button>
          <button
            className={`btn ${showPolicyPanel ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => { const next = !showPolicyPanel; setShowPolicyPanel(next); localStorage.setItem('policies-panel-open', String(next)); if (next) loadPolicies(); }}
            style={{ height: '45px', display: 'inline-flex', alignItems: 'center', gap: '8px' }}
          >
            <span>📜 策略管理</span>
            {policies.length > 0 && <span>({policies.length})</span>}
            <span style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: '18px', height: '18px', borderRadius: '50%',
              border: showPolicyPanel ? '2px solid #fff' : '2px solid #fff',
              background: showPolicyPanel ? 'var(--color-success, #22c55e)' : 'transparent',
              flexShrink: 0, transition: 'all 0.25s',
            }}>
              {showPolicyPanel && <span style={{ color: '#fff', fontSize: '12px', lineHeight: 1 }}>✓</span>}
            </span>
          </button>
        </div>
      </div>

      {/* ====== 下方区域：密钥列表卡片 (flex:1) + 策略面板卡片 (480px, 滑出) ====== */}
      <div style={{ display: 'flex', gap: '0', minHeight: 0 }}>
        {/* ====== 左：密钥列表主区域 ====== */}
        <div style={{ flex: 1, minWidth: 0, transition: 'margin-right 0.35s ease', marginRight: showPolicyPanel ? '24px' : '0' }}>

          {/* 密钥卡片 (align with .card pattern) */}
          <div className="card" style={{ marginBottom: '0' }}>
            {/* 筛选栏 + 批量操作 */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <div style={{ display: 'flex', gap: '10px' }}>
                <select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(1); }} style={inputStyle}>
                  <option value="">全部状态</option>
                  <option value="active">启用</option>
                  <option value="disabled">停用</option>
                </select>
                <input type="text" placeholder="搜索名称或备注..." value={searchQuery}
                  onChange={e => { setSearchQuery(e.target.value); setPage(1); }}
                  style={{ ...inputStyle, minWidth: '200px' }} />
              </div>
              {selectedIds.size > 0 && (
                <div ref={batchMenuRef} style={{ position: 'relative', flexShrink: 0 }}>
                  <button className="ak-action-btn" onClick={() => setShowBatchMenu(!showBatchMenu)}>
                    批量操作 ({selectedIds.size}) ▾
                  </button>
                  {showBatchMenu && (
                    <div className="ak-dropdown-menu">
                      <button className="dropdown-btn" onClick={() => handleBatchStatus('active')}>批量启用</button>
                      <button className="dropdown-btn" onClick={() => handleBatchStatus('disabled')}>批量停用</button>
                      <hr style={{ margin: '2px 0', border: 'none', borderTop: '1px solid var(--border-primary)' }} />
                      <select style={{ width: '100%', border: 'none', background: 'none', padding: '6px 10px', cursor: 'pointer', color: 'var(--text-primary)' }}
                        onChange={e => { if (e.target.value) handleBatchBindPolicy(e.target.value); }}>
                        <option value="">批量绑定策略...</option>
                        {policies.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                      <hr style={{ margin: '2px 0', border: 'none', borderTop: '1px solid var(--border-primary)' }} />
                      <button className="dropdown-btn" style={{ color: 'var(--color-danger)' }} onClick={handleBatchDelete}>批量删除</button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 表格 */}
            {loading ? <div style={{ textAlign: 'center', padding: '40px' }}>加载中...</div> : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid var(--border-primary)' }}>
                      <th style={{ padding: '10px 12px', textAlign: 'left', width: 32 }}>
                        <input type="checkbox" checked={selectedIds.size === keys.length && keys.length > 0} onChange={toggleSelectAll} />
                      </th>
                      <th style={{ padding: '10px 12px', textAlign: 'left' }}>名称</th>
                      <th style={{ padding: '10px 12px', textAlign: 'left' }}>API Key</th>
                      <th style={{ padding: '10px 12px', textAlign: 'left' }}>策略</th>
                      <th style={{ padding: '10px 12px', textAlign: 'center', width: 60 }}>状态</th>
                      <th style={{ padding: '10px 12px', textAlign: 'left', minWidth: 90 }}>创建时间</th>
                      <th style={{ padding: '10px 12px', textAlign: 'left', minWidth: 90 }}>最后活跃</th>
                      <th style={{ padding: '10px 12px', textAlign: 'center', width: 120 }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {keys.length === 0 ? (
                      <tr><td colSpan={8} style={{ padding: '40px', textAlign: 'center', color: 'var(--text-tertiary)' }}>
                        {total === 0 ? '暂无密钥，点击「创建密钥」开始' : '无匹配结果'}
                      </td></tr>
                    ) : keys.map(key => (
                      <tr key={key.id} style={{ borderBottom: '1px solid var(--border-primary)' }}>
                        <td style={{ padding: '10px 12px' }}>
                          <input type="checkbox" checked={selectedIds.has(key.id)} onChange={() => toggleSelect(key.id)} />
                        </td>
                        <td style={{ padding: '10px 12px' }}>
                          <a href={`#/access-keys/${key.id}`} style={{ color: 'var(--color-primary)', textDecoration: 'none', fontWeight: 500 }}>{key.name}</a>
                          {key.remark && <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '2px' }}>{key.remark}</div>}
                        </td>
                        <td style={{ padding: '10px 12px' }}>
                          <code style={{ fontSize: '12px', background: 'var(--bg-secondary)', padding: '2px 6px', borderRadius: '3px' }}>{key.apiKey}</code>
                        </td>
                        <td style={{ padding: '10px 12px', fontSize: '13px' }}>
                          {key.policyName || <span style={{ color: 'var(--text-tertiary)' }}>未配置</span>}
                        </td>
                        <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                          <span style={{
                            display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%',
                            background: key.status === 'active' ? '#22c55e' : 'var(--text-tertiary)',
                          }} title={key.status === 'active' ? '启用' : '停用'} />
                        </td>
                        <td style={{ padding: '10px 12px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                          {new Date(key.createdAt).toLocaleDateString()}
                        </td>
                        <td style={{ padding: '10px 12px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                          {key.lastActiveAt ? new Date(key.lastActiveAt).toLocaleDateString() : '-'}
                        </td>
                        <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                          <div style={{ display: 'flex', gap: '4px', justifyContent: 'center' }}>
                            <button className="btn btn-sm ak-action-btn" onClick={() => handleGuide(key)} title="接入指引">📋</button>
                            <button className="btn btn-sm ak-action-btn" onClick={() => handleToggleStatus(key)} title={key.status === 'active' ? '停用' : '启用'}>
                              {key.status === 'active' ? '⏸' : '▶'}
                            </button>
                            <button className="btn btn-sm ak-action-btn" onClick={() => handleRegenerate(key)} title="重新生成">🔄</button>
                            <button className="btn btn-sm ak-action-btn ak-action-btn--danger" onClick={() => handleDelete(key)} title="删除">✕</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* 分页 */}
            {totalPages > 1 && (
              <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', marginTop: '16px' }}>
                <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</button>
                <span style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>{page}/{totalPages} · 共 {total} 个</span>
                <button className="btn btn-sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>›</button>
              </div>
            )}
          </div>
        </div>

        {/* ====== 右：策略管理面板 (滑出动画, 固定 480px) ====== */}
        <div style={{
          width: showPolicyPanel ? '480px' : '0',
          overflow: 'hidden',
          transition: 'width 0.35s ease, opacity 0.35s ease',
          opacity: showPolicyPanel ? 1 : 0,
          flexShrink: 0,
        }}>
          <div style={{ width: '480px', height: '100%' }}>
            <div className="card" style={{ height: '100%', marginBottom: '0', display: 'flex', flexDirection: 'column' }}>
              {/* 面板头部 */}
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                paddingBottom: '16px', marginBottom: '16px',
                borderBottom: '1px solid var(--border-primary)',
                flexShrink: 0,
              }}>
                <h4 style={{ margin: 0, fontSize: '16px' }}>📜 策略管理</h4>
                <button className="btn btn-primary btn-sm" onClick={() => openPolicyEditor()}>+ 创建策略</button>
              </div>

              {/* 面板内容 */}
              <div style={{ overflowY: 'auto', flex: 1 }}>
                {policies.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-tertiary)', fontSize: '14px' }}>
                    暂无策略<br/>点击「创建策略」开始配置
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    {policies.map(policy => (
                      <div key={policy.id} style={{
                        padding: '16px', borderRadius: '12px',
                        border: '1px solid var(--border-primary)', background: 'var(--bg-secondary)',
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
                          <div>
                            <div style={{ fontWeight: 600, fontSize: '14px', marginBottom: '2px' }}>📋 {policy.name}</div>
                            {policy.description && (
                              <div style={{ color: 'var(--text-tertiary)', fontSize: '12px' }}>{policy.description}</div>
                            )}
                          </div>
                          <div style={{ display: 'flex', gap: '4px' }}>
                            <button className="btn btn-sm ak-action-btn" onClick={() => openPolicyEditor(policy)}>编辑</button>
                            <button className="btn btn-sm ak-action-btn" onClick={() => handleDuplicatePolicy(policy)}>复制</button>
                            <button className="btn btn-sm ak-action-btn ak-action-btn--danger" onClick={() => handleDeletePolicy(policy)}>删除</button>
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: '16px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                          <span>🔗 路由: {policy.routeId === 'system' ? <span style={{ color: 'var(--accent-color, #4a90d9)' }}>系统默认</span> : (getRouteName(policy.routeId) || <span style={{ color: 'var(--text-tertiary)' }}>未绑定</span>)}</span>
                          <span>🔑 Key: {policy.keyCount || 0}</span>
                          <span>📊 配额: {formatQuota(policy)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ====== 创建密钥弹窗 ====== */}
      {showCreateModal && (
        <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="modal" style={{ minWidth: 'auto', width: '480px', padding: '28px' }} onClick={e => e.stopPropagation()}>
            <button
              type="button"
              className="modal-close-btn"
              onClick={() => setShowCreateModal(false)}
              style={{ top: '12px', right: '12px', width: '36px', height: '36px', fontSize: '24px' }}
              aria-label="关闭"
            >×</button>
            <h3 style={{ margin: '0 0 6px', fontSize: '20px' }}>创建接入密钥</h3>
            <p style={{ margin: '0 0 20px', color: 'var(--text-tertiary)', fontSize: '13px' }}>生成一个以 sk_ 开头的 API Key，分发给团队成员使用</p>

            <div style={{ marginBottom: '14px' }}>
              <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600, fontSize: '14px' }}>名称 <span style={{ color: 'var(--color-danger)' }}>*</span></label>
              <input type="text" value={newKeyName} onChange={e => setNewKeyName(e.target.value)}
                placeholder="例如：张三 - 前端组" autoFocus
                style={{ ...inputStyle, width: '100%', padding: '10px 14px', fontSize: '14px', borderRadius: '8px' }} />
            </div>
            <div style={{ marginBottom: '14px' }}>
              <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600, fontSize: '14px' }}>备注 <span style={{ color: 'var(--text-tertiary)', fontWeight: 400, fontSize: '12px' }}>(可选)</span></label>
              <textarea value={newKeyRemark} onChange={e => setNewKeyRemark(e.target.value)} placeholder="补充说明信息"
                style={{ ...inputStyle, width: '100%', padding: '10px 14px', minHeight: '52px', fontSize: '14px', borderRadius: '8px', resize: 'vertical' }} />
            </div>
            <div style={{ marginBottom: '24px' }}>
              <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600, fontSize: '14px' }}>策略 <span style={{ color: 'var(--text-tertiary)', fontWeight: 400, fontSize: '12px' }}>(可选)</span></label>
              <select value={newKeyPolicyId} onChange={e => setNewKeyPolicyId(e.target.value)}
                style={{ ...inputStyle, width: '100%', padding: '10px 14px', fontSize: '14px', borderRadius: '8px', cursor: 'pointer' }}>
                <option value="">稍后配置</option>
                {policies.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button
                onClick={() => setShowCreateModal(false)}
                className="ak-modal-btn-secondary"
              >取消</button>
              <button
                onClick={handleCreate}
                className="ak-modal-btn-primary"
              >创建密钥</button>
            </div>
          </div>
        </div>
      )}

      {/* ====== 创建成功弹窗 ====== */}
      {showCreatedModal && (
        <div className="modal-overlay" onClick={() => setShowCreatedModal(null)}>
          <div className="modal" style={{ minWidth: 'auto', width: '600px', padding: '28px' }} onClick={e => e.stopPropagation()}>
            <button
              type="button"
              className="modal-close-btn"
              onClick={() => setShowCreatedModal(null)}
              style={{ top: '12px', right: '12px', width: '36px', height: '36px', fontSize: '24px' }}
              aria-label="关闭"
            >×</button>
            <div style={{ textAlign: 'center', marginBottom: '20px' }}>
              <div style={{ fontSize: '40px', marginBottom: '8px' }}>🔑</div>
              <h3 style={{ margin: '0', fontSize: '20px', color: '#22c55e' }}>密钥创建成功</h3>
            </div>
            <div style={{
              background: 'var(--bg-primary)', borderRadius: '10px', padding: '16px',
              border: '2px dashed #22c55e', marginBottom: '20px',
            }}>
              <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '1px' }}>API Key</div>
              <code style={{
                display: 'block', fontSize: '16px', wordBreak: 'break-all', lineHeight: 1.6,
                fontFamily: '"SF Mono", "Fira Code", monospace', color: 'var(--text-primary)',
              }}>
                {showCreatedModal.apiKey}
              </code>
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', gap: '10px' }}>
              <button
                onClick={() => copyToClipboard(showCreatedModal.apiKey)}
                className="ak-modal-btn-primary"
              >📋 复制 Key</button>
              <button
                onClick={() => setShowCreatedModal(null)}
                className="ak-modal-btn-secondary"
              >完成</button>
            </div>
          </div>
        </div>
      )}

      {/* ====== 策略编辑弹窗 ====== */}
      {showPolicyEditor && (
        <div className="modal-overlay" onClick={() => setShowPolicyEditor(false)}>
          <div className="modal" style={{ minWidth: 'auto', width: '600px', padding: '28px' }} onClick={e => e.stopPropagation()}>
            <button
              type="button"
              className="modal-close-btn"
              onClick={() => setShowPolicyEditor(false)}
              style={{ top: '12px', right: '12px', width: '36px', height: '36px', fontSize: '24px' }}
              aria-label="关闭"
            >×</button>

            {/* 标题 */}
            <h3 style={{ margin: '0 0 4px', fontSize: '20px' }}>{editingPolicy ? '编辑策略' : '创建策略'}</h3>
            <p style={{ margin: '0 0 22px', color: 'var(--text-tertiary)', fontSize: '13px' }}>
              配置路由、配额限制和模型过滤规则，多个密钥可复用同一策略
            </p>

            {/* 基本信息 + 路由 */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px', marginBottom: '18px' }}>
              <div>
                <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600, fontSize: '14px' }}>名称 <span style={{ color: 'var(--color-danger)' }}>*</span></label>
                <input type="text" value={formName} onChange={e => setFormName(e.target.value)}
                  placeholder="例如：中度限制策略"
                  style={{ ...inputStyle, width: '100%', padding: '10px 14px', fontSize: '14px', borderRadius: '8px' }} />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600, fontSize: '14px' }}>描述 <span style={{ color: 'var(--text-tertiary)', fontWeight: 400, fontSize: '12px' }}>(可选)</span></label>
                <input type="text" value={formDesc} onChange={e => setFormDesc(e.target.value)}
                  placeholder="适合普通开发者使用"
                  style={{ ...inputStyle, width: '100%', padding: '10px 14px', fontSize: '14px', borderRadius: '8px' }} />
              </div>
            </div>

            {/* 路由 */}
            <div style={{ marginBottom: '18px' }}>
              <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600, fontSize: '14px' }}>路由绑定</label>
              <select value={formRouteId} onChange={e => setFormRouteId(e.target.value)}
                style={{ ...inputStyle, width: '100%', padding: '10px 14px', fontSize: '14px', borderRadius: '8px', cursor: 'pointer' }}>
                <option value="system">按系统默认</option>
                {routes.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>

            {/* 配额限制 */}
            <div style={{ marginBottom: '18px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <label style={{ fontWeight: 600, fontSize: '14px' }}>配额限制</label>
                {!editingPolicy && templates.length > 0 && (
                  <select
                    style={{ fontSize: '13px', padding: '6px 12px', borderRadius: '6px', border: '1px solid var(--border-primary)', background: 'var(--bg-secondary)', cursor: 'pointer', color: 'var(--text-secondary)' }}
                    onChange={e => { if (e.target.value) { applyTemplate(templates[Number(e.target.value)]); e.target.value = ''; } }}>
                    <option value="">📋 使用模板...</option>
                    {templates.map((t, i) => <option key={i} value={String(i)}>{t.name} — {t.description}</option>)}
                  </select>
                )}
              </div>
              <div style={{
                background: 'var(--bg-primary)', borderRadius: '10px', padding: '16px',
                border: '1px solid var(--border-primary)',
              }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-tertiary)', marginBottom: '4px' }}>日 Token (k)</label>
                    <input type="number" value={formDailyToken} onChange={e => setFormDailyToken(e.target.value)} placeholder="不限"
                      style={{ ...inputStyle, width: '100%', padding: '9px 10px', borderRadius: '6px' }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-tertiary)', marginBottom: '4px' }}>月 Token (k)</label>
                    <input type="number" value={formMonthlyToken} onChange={e => setFormMonthlyToken(e.target.value)} placeholder="不限"
                      style={{ ...inputStyle, width: '100%', padding: '9px 10px', borderRadius: '6px' }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-tertiary)', marginBottom: '4px' }}>日请求 (次)</label>
                    <input type="number" value={formDailyReq} onChange={e => setFormDailyReq(e.target.value)} placeholder="不限"
                      style={{ ...inputStyle, width: '100%', padding: '9px 10px', borderRadius: '6px' }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-tertiary)', marginBottom: '4px' }}>RPM</label>
                    <input type="number" value={formRpm} onChange={e => setFormRpm(e.target.value)} placeholder="不限"
                      style={{ ...inputStyle, width: '100%', padding: '9px 10px', borderRadius: '6px' }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-tertiary)', marginBottom: '4px' }}>并发</label>
                    <input type="number" value={formConcurrent} onChange={e => setFormConcurrent(e.target.value)} placeholder="不限"
                      style={{ ...inputStyle, width: '100%', padding: '9px 10px', borderRadius: '6px' }} />
                  </div>
                </div>
              </div>
            </div>

            {/* 模型过滤 */}
            <div style={{ marginBottom: '24px' }}>
              <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600, fontSize: '14px' }}>模型过滤</label>
              <div style={{
                background: 'var(--bg-primary)', borderRadius: '10px', padding: '14px',
                border: '1px solid var(--border-primary)',
              }}>
                <div style={{ display: 'flex', gap: '16px', marginBottom: formModelMode !== 'none' ? '12px' : '0' }}>
                  {[
                    { value: 'none', label: '不限制', desc: '允许所有模型' },
                    { value: 'allow', label: '白名单', desc: '仅允许指定模型' },
                    { value: 'block', label: '黑名单', desc: '禁止指定模型' },
                  ].map(opt => (
                    <label key={opt.value} className={`policy-model-opt ${formModelMode === opt.value ? 'policy-model-opt--active' : ''}`}>
                      <input type="radio" name="modelMode" value={opt.value}
                        checked={formModelMode === opt.value}
                        onChange={() => setFormModelMode(opt.value as any)}
                        style={{ display: 'none' }} />
                      <div style={{ fontWeight: 600, fontSize: '14px', marginBottom: '2px' }}>{opt.label}</div>
                      <div style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>{opt.desc}</div>
                    </label>
                  ))}
                </div>
                {formModelMode !== 'none' && (
                  <div>
                    <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                      <div style={{ position: 'relative', flex: 1 }}>
                        <input ref={modelInputRef} type="text" value={modelInput}
                          onChange={e => { setModelInput(e.target.value); setShowModelSuggest(true); }}
                          onFocus={() => setShowModelSuggest(true)}
                          onBlur={() => setTimeout(() => setShowModelSuggest(false), 150)}
                          placeholder={allModels.length > 0 ? '搜索或输入模型名...' : '输入模型名，回车确认...'}
                          autoFocus
                          onKeyDown={e => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              addModel(formModelMode === 'allow' ? formAllowedModels : formBlockedModels, formModelMode === 'allow' ? setFormAllowedModels : setFormBlockedModels);
                            }
                            if (e.key === 'Escape') { setShowModelSuggest(false); }
                          }}
                          style={{ ...inputStyle, width: '100%', padding: '8px 12px', borderRadius: '6px', fontSize: '13px' }} />
                        {showModelSuggest && filteredModels.length > 0 && (
                          <div className="ak-model-suggest">
                            {filteredModels.map(m => (
                              <button key={m.name} className="ak-model-suggest-item"
                                onMouseDown={e => {
                                  e.preventDefault();
                                  const list = formModelMode === 'allow' ? formAllowedModels : formBlockedModels;
                                  const setter = formModelMode === 'allow' ? setFormAllowedModels : setFormBlockedModels;
                                  if (!list.includes(m.name)) { setter([...list, m.name]); }
                                  setModelInput('');
                                  setShowModelSuggest(false);
                                  modelInputRef.current?.focus();
                                }}>
                                <span>{m.name}</span>
                                <span>{m.vendors.join(', ')}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      <button className="btn btn-primary btn-sm" style={{ padding: '8px 14px', borderRadius: '6px' }}
                        onClick={() => addModel(formModelMode === 'allow' ? formAllowedModels : formBlockedModels, formModelMode === 'allow' ? setFormAllowedModels : setFormBlockedModels)}>添加</button>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', minHeight: '24px' }}>
                      {(formModelMode === 'allow' ? formAllowedModels : formBlockedModels).length === 0 && (
                        <span style={{ fontSize: '12px', color: 'var(--text-tertiary)', padding: '4px 0' }}>
                          {formModelMode === 'allow' ? '尚未添加模型，至少需要添加一个模型才能生效' : '尚未添加模型，不添加则不对任何模型进行屏蔽'}
                        </span>
                      )}
                      {(formModelMode === 'allow' ? formAllowedModels : formBlockedModels).map((m, i) => (
                        <span key={i} style={{
                          display: 'inline-flex', alignItems: 'center', gap: '6px',
                          padding: '4px 10px', background: 'var(--bg-secondary)',
                          borderRadius: '16px', fontSize: '13px', border: '1px solid var(--border-primary)',
                        }}>
                          {m}
                          <button style={{ border: 'none', background: 'none', cursor: 'pointer', padding: '0 2px', color: 'var(--text-tertiary)', fontSize: '14px', lineHeight: 1 }}
                            onClick={() => {
                              const list = formModelMode === 'allow' ? formAllowedModels : formBlockedModels;
                              const setter = formModelMode === 'allow' ? setFormAllowedModels : setFormBlockedModels;
                              setter(list.filter((_, j) => j !== i));
                            }}>×</button>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* 底部按钮 */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button onClick={() => setShowPolicyEditor(false)}
                className="ak-modal-btn-secondary"
              >取消</button>
              <button onClick={handleSavePolicy}
                className="ak-modal-btn-primary"
              >{editingPolicy ? '保存修改' : '创建策略'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ====== 接入指引弹窗 ====== */}
      {guideKey && (
        <AccessKeyGuideModal
          keyName={guideKey.key.name}
          apiKey={guideKey.key.apiKey}
          guide={guideKey.guide}
          onClose={() => setGuideKey(null)}
        />
      )}
      {/* 全局样式 */}
      <style>{`
        .dropdown-btn {
          display: block; width: 100%; padding: 6px 10px; text-align: left;
          border: none; background: none; cursor: pointer; font-size: 13px;
          color: var(--text-primary);
        }
        .dropdown-btn:hover { background: var(--bg-secondary); }

        /* 操作按钮 - 列表/策略面板中的小按钮 */
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
        .ak-action-btn--danger {
          color: var(--accent-danger);
        }
        .ak-action-btn--danger:hover {
          background: rgba(220, 38, 38, 0.1);
          border-color: var(--accent-danger);
        }

        /* 模型自动补全下拉 */
        .ak-model-suggest {
          position: absolute; left: 0; right: 0; bottom: 100%; z-index: 50;
          margin-top: 4px; max-height: 240px; overflow-y: auto;
          background: var(--bg-primary-solid); border: 1px solid var(--border-primary);
          border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.12);
          padding: 4px 0;
        }
        .ak-model-suggest-item {
          display: flex; justify-content: space-between; align-items: center; gap: 8px;
          width: 100%; padding: 7px 12px;
          border: none; background: none; cursor: pointer;
          font-size: 13px; color: var(--text-primary); text-align: left;
        }
        .ak-model-suggest-item > span:first-child {
          font-family: "SF Mono", "Fira Code", monospace;
          white-space: nowrap;
        }
        .ak-model-suggest-item > span:last-child {
          color: #999; font-size: 11px; white-space: nowrap; flex-shrink: 0;
        }
        [data-theme="dark"] .ak-model-suggest-item > span:last-child {
          color: #888;
        }
        .ak-model-suggest-item:hover {
          background: var(--bg-secondary);
        }
        [data-theme="dark"] .ak-model-suggest {
          background: #0C1F12;
          border-color: rgba(167, 243, 208, 0.2);
        }
        [data-theme="dark"] .ak-model-suggest-item:hover {
          background: rgba(30, 58, 40, 0.95);
        }

        /* 批量操作按钮 */
        .ak-action-btn[onClick] {
          padding: 6px 12px;
        }

        /* 下拉菜单 */
        .ak-dropdown-menu {
          position: absolute; right: 0; top: 100%; z-index: 100;
          background: var(--bg-primary-solid);
          border: 1px solid var(--border-primary);
          border-radius: 6px;
          box-shadow: 0 4px 12px rgba(0,0,0,0.15);
          min-width: 140px; padding: 4px 0;
        }

        /* 弹窗按钮 */
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

        /* 模型过滤选项 */
        .policy-model-opt {
          cursor: pointer; padding: 10px 14px; border-radius: 8px;
          flex: 1; text-align: center; transition: all 0.2s;
          border: 1px solid var(--border-primary);
          background: transparent;
        }
        .policy-model-opt:hover {
          background: rgba(59,130,246,0.05);
        }
        .policy-model-opt--active {
          border: 2px solid var(--color-primary, #3b82f6);
          background: rgba(59,130,246,0.12);
        }
        .policy-model-opt--active:hover {
          background: rgba(59,130,246,0.18);
        }

        /* ========== 深色模式 ========== */
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
        [data-theme="dark"] .ak-dropdown-menu {
          background: #0C1F12;
          border-color: rgba(167, 243, 208, 0.2);
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
        [data-theme="dark"] .policy-model-opt:hover {
          background: rgba(96,165,250,0.12);
        }
        [data-theme="dark"] .policy-model-opt--active {
          background: rgba(96,165,250,0.28);
          border-color: #60a5fa;
        }
        [data-theme="dark"] .policy-model-opt--active:hover {
          background: rgba(96,165,250,0.38);
        }
        [data-theme="dark"] .page-container select option {
          background: #0C1F12;
          color: #ECFEF5;
        }
        [data-theme="dark"] .page-container textarea,
        [data-theme="dark"] .page-container input[type="text"],
        [data-theme="dark"] .page-container input[type="number"] {
          color-scheme: dark;
        }
      `}</style>
    </div>
  );
}
