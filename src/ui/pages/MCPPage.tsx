import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { MCPServer, TargetType } from '../../types';
import { toast } from '../components/Toast';

interface MCPFormData {
  name: string;
  description: string;
  type: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string;
  url?: string;
  headers?: string;
  env?: string;
  targets: TargetType[];
}

interface DeleteConfirmState {
  mcpId: string | null;
  mcpName: string;
  isDeleting: boolean;
}

interface QuickInstallState {
  isOpen: boolean;
  step: 'select' | 'input-api-key' | 'installing' | 'completed' | 'error';
  message: string;
  installingMCPName: string | null;
  apiKey: string;
  selectedDefinition: typeof QUICK_INSTALL_MCP_DEFINITIONS[number] | null;
}

// 一键安装 MCP 配置定义
const QUICK_INSTALL_MCP_DEFINITIONS = [
  {
    id: 'glm-vision',
    name: 'GLM 视觉理解',
    description: '提供图像理解能力，支持多种视觉场景分析',
    type: 'stdio' as const,
    command: 'npx',
    args: ['-y', '@z_ai/mcp-server'],
    env: { Z_AI_MODE: 'ZHIPU' },
  },
  {
    id: 'glm-web-search',
    name: 'GLM 联网搜索',
    description: '提供网络搜索能力，实时获取最新信息',
    type: 'http' as const,
    url: 'https://open.bigmodel.cn/api/mcp/web_search_prime/mcp',
  },
  {
    id: 'glm-web-reader',
    name: 'GLM 网页读取',
    description: '提供网页内容读取和解析能力',
    type: 'http' as const,
    url: 'https://open.bigmodel.cn/api/mcp/web_reader/mcp',
  },
  {
    id: 'glm-zread',
    name: 'GLM 开源仓库',
    description: '提供开源仓库代码搜索和阅读能力',
    type: 'http' as const,
    url: 'https://open.bigmodel.cn/api/mcp/zread/mcp',
  },
];

function MCPPage() {
  const [mcps, setMCPs] = useState<MCPServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [editMCP, setEditMCP] = useState<MCPServer | null>(null);
  const [formData, setFormData] = useState<MCPFormData>({
    name: '',
    description: '',
    type: 'stdio',
    command: '',
    args: '',
    url: '',
    headers: '',
    env: '',
    targets: [],
  });
  const [formLoading, setFormLoading] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState>({
    mcpId: null,
    mcpName: '',
    isDeleting: false,
  });
  const [quickInstall, setQuickInstall] = useState<QuickInstallState>({
    isOpen: false,
    step: 'select',
    message: '',
    installingMCPName: null,
    apiKey: '',
    selectedDefinition: null,
  });

  const loadMCPs = async () => {
    try {
      setLoading(true);
      const data = await api.getMCPs();
      setMCPs(data);
    } catch (error) {
      console.error('Failed to load MCPs:', error);
      toast.error('加载 MCP 工具失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMCPs();
  }, []);

  const openAddModal = () => {
    setEditMCP(null);
    setFormData({
      name: '',
      description: '',
      type: 'stdio',
      command: '',
      args: '',
      url: '',
      headers: '',
      env: '',
      targets: [],
    });
    setAddModalOpen(true);
  };

  const openEditModal = (mcp: MCPServer) => {
    setEditMCP(mcp);
    setFormData({
      name: mcp.name,
      description: mcp.description || '',
      type: mcp.type,
      command: mcp.command || '',
      args: mcp.args ? mcp.args.join(' ') : '',
      url: mcp.url || '',
      headers: mcp.headers ? JSON.stringify(mcp.headers, null, 2) : '',
      env: mcp.env ? JSON.stringify(mcp.env, null, 2) : '',
      targets: mcp.targets || [],
    });
    setAddModalOpen(true);
  };

  const closeAddModal = () => {
    if (!formLoading) {
      setAddModalOpen(false);
      setEditMCP(null);
    }
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.name.trim()) {
      toast.error('请填写 MCP 名称');
      return;
    }
    if (formData.type === 'stdio' && !formData.command) {
      toast.error('请填写命令');
      return;
    }
    if ((formData.type === 'http' || formData.type === 'sse') && !formData.url) {
      toast.error('请填写 URL');
      return;
    }

    try {
      setFormLoading(true);

      const envObj: Record<string, string> = {};
      const headersObj: Record<string, string> = {};

      if (formData.env) {
        try {
          Object.assign(envObj, JSON.parse(formData.env));
        } catch {
          toast.error('环境变量格式错误，请使用有效的 JSON 格式');
          return;
        }
      }

      if (formData.headers) {
        try {
          Object.assign(headersObj, JSON.parse(formData.headers));
        } catch {
          toast.error('请求头格式错误，请使用有效的 JSON 格式');
          return;
        }
      }

      const mcpData = {
        name: formData.name.trim(),
        description: formData.description.trim(),
        type: formData.type,
        command: formData.command?.trim(),
        args: formData.args ? formData.args.trim().split(/\s+/) : undefined,
        url: formData.url?.trim(),
        headers: Object.keys(headersObj).length > 0 ? headersObj : undefined,
        env: Object.keys(envObj).length > 0 ? envObj : undefined,
        targets: formData.targets,
      };

      if (editMCP) {
        await api.updateMCP(editMCP.id, mcpData);
        toast.success('MCP 工具已更新');
      } else {
        await api.createMCP(mcpData);
        toast.success('MCP 工具已添加');
      }

      setAddModalOpen(false);
      setEditMCP(null);
      await loadMCPs();
    } catch (error) {
      console.error('Failed to save MCP:', error);
      toast.error('保存失败，请稍后重试');
    } finally {
      setFormLoading(false);
    }
  };

  const openDeleteConfirm = (mcp: MCPServer) => {
    setDeleteConfirm({ mcpId: mcp.id, mcpName: mcp.name, isDeleting: false });
  };

  const closeDeleteConfirm = () => {
    if (!deleteConfirm.isDeleting) {
      setDeleteConfirm({ mcpId: null, mcpName: '', isDeleting: false });
    }
  };

  const handleDeleteMCP = async () => {
    if (!deleteConfirm.mcpId) {
      return;
    }

    try {
      setDeleteConfirm((prev) => ({ ...prev, isDeleting: true }));
      await api.deleteMCP(deleteConfirm.mcpId);
      toast.success('已删除 MCP 工具');
      await loadMCPs();
      closeDeleteConfirm();
    } catch (error) {
      console.error('Failed to delete MCP:', error);
      toast.error('删除失败，请稍后重试');
      setDeleteConfirm((prev) => ({ ...prev, isDeleting: false }));
    }
  };

  const openQuickInstall = () => {
    setQuickInstall({
      isOpen: true,
      step: 'select',
      message: '',
      installingMCPName: null,
      apiKey: '',
      selectedDefinition: null,
    });
  };

  const closeQuickInstall = () => {
    if (quickInstall.installingMCPName) {
      return;
    }
    setQuickInstall({
      isOpen: false,
      step: 'select',
      message: '',
      installingMCPName: null,
      apiKey: '',
      selectedDefinition: null,
    });
  };

  const handleSelectMCP = (def: typeof QUICK_INSTALL_MCP_DEFINITIONS[number]) => {
    setQuickInstall((prev) => ({
      ...prev,
      step: 'input-api-key',
      selectedDefinition: def,
    }));
  };

  const handleInstallMCP = async () => {
    if (!quickInstall.apiKey.trim()) {
      toast.error('请填写 API Key');
      return;
    }

    if (!quickInstall.selectedDefinition) {
      return;
    }

    try {
      const def = quickInstall.selectedDefinition;
      setQuickInstall((prev) => ({
        ...prev,
        step: 'installing',
        message: '正在安装...',
        installingMCPName: def.name,
      }));

      const mcpData = {
        name: def.name,
        description: def.description,
        type: def.type,
        command: def.command,
        args: def.args,
        url: def.url,
        env: def.env ? { ...def.env, Z_AI_API_KEY: quickInstall.apiKey.trim() } : undefined,
        headers: { Authorization: `Bearer ${quickInstall.apiKey.trim()}` },
        targets: ['claude-code', 'codex'] as TargetType[],
      };

      await api.createMCP(mcpData);

      setQuickInstall((prev) => ({
        ...prev,
        step: 'completed',
        message: `成功安装 ${def.name}`,
        installingMCPName: null,
      }));
      toast.success(`已安装 ${def.name}`);

      await loadMCPs();
    } catch (error) {
      console.error(`Failed to install ${quickInstall.selectedDefinition?.id}:`, error);
      setQuickInstall((prev) => ({
        ...prev,
        step: 'error',
        message: '安装失败，请稍后重试',
        installingMCPName: null,
      }));
      toast.error('安装失败，请稍后重试');
    }
  };

  const getTypeLabel = (type: string) => {
    switch (type) {
      case 'stdio':
        return '命令行';
      case 'http':
        return 'HTTP';
      case 'sse':
        return 'SSE';
      default:
        return type;
    }
  };

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1>MCP 管理</h1>
          <p>管理 Model Context Protocol (MCP) 工具，扩展 Claude Code 和 Codex 的能力</p>
        </div>
        <div style={{ display: 'flex', gap: '12px' }}>
          <button
            className="btn btn-secondary"
            onClick={openQuickInstall}
            style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
          >
            <span>⚡</span>
            <span>一键安装 MCP</span>
          </button>
          <button
            className="btn btn-primary"
            onClick={openAddModal}
          >
            添加 MCP 工具
          </button>
        </div>
      </div>

      {loading ? (
        <div className="empty-state">
          <p>正在加载 MCP 工具...</p>
        </div>
      ) : mcps.length === 0 ? (
        <div className="empty-state">
          <p>当前没有安装 MCP 工具</p>
          <span>你可以点击"添加 MCP 工具"或"一键安装 MCP"来添加工具。</span>
        </div>
      ) : (
        <div className="mcp-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(400px, 1fr))', gap: '16px', marginTop: '24px' }}>
          {mcps.map((mcp) => (
            <div className="card mcp-card" key={mcp.id} style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
                <div className="mcp-title" style={{ flex: 1 }}>{mcp.name}</div>
                <div className="badge badge-secondary">{getTypeLabel(mcp.type)}</div>
              </div>
              {mcp.description && (
                <div className="mcp-description" style={{ marginTop: '12px', color: 'var(--text-muted)', fontSize: '14px' }}>
                  {mcp.description}
                </div>
              )}
              <div style={{ marginTop: '12px', fontSize: '12px', color: 'var(--text-muted)' }}>
                安装时间: {new Date(mcp.createdAt).toLocaleDateString('zh-CN')}
              </div>
              {mcp.type === 'stdio' && mcp.command && (
                <div style={{ marginTop: '8px', fontSize: '12px', fontFamily: 'monospace', color: 'var(--text-muted)' }}>
                  命令: {mcp.command} {mcp.args?.join(' ')}
                </div>
              )}
              {(mcp.type === 'http' || mcp.type === 'sse') && mcp.url && (
                <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--text-muted)' }}>
                  URL: {mcp.url}
                </div>
              )}
              <div style={{ marginTop: 'auto', paddingTop: '16px', borderTop: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', gap: '16px', fontSize: '14px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={mcp.targets?.includes('claude-code')}
                      onChange={async (e) => {
                        const targets = mcp.targets || [];
                        const newTargets = e.target.checked
                          ? [...targets, 'claude-code'] as TargetType[]
                          : targets.filter((t) => t !== 'claude-code');
                        await api.updateMCP(mcp.id, { targets: newTargets });
                        await loadMCPs();
                      }}
                      style={{ width: '16px', height: '16px', cursor: 'pointer' }}
                    />
                    <span>Claude Code</span>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={mcp.targets?.includes('codex')}
                      onChange={async (e) => {
                        const targets = mcp.targets || [];
                        const newTargets = e.target.checked
                          ? [...targets, 'codex'] as TargetType[]
                          : targets.filter((t) => t !== 'codex');
                        await api.updateMCP(mcp.id, { targets: newTargets });
                        await loadMCPs();
                      }}
                      style={{ width: '16px', height: '16px', cursor: 'pointer' }}
                    />
                    <span>Codex</span>
                  </label>
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    className="btn btn-secondary"
                    onClick={() => openEditModal(mcp)}
                    style={{ padding: '6px 12px', fontSize: '12px' }}
                  >
                    编辑
                  </button>
                  <button
                    className="btn btn-danger"
                    onClick={() => openDeleteConfirm(mcp)}
                    style={{ padding: '6px 12px', fontSize: '12px' }}
                  >
                    删除
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {addModalOpen && (
        <div className="modal-overlay" style={{ zIndex: 1000000 }}>
          <button
            type="button"
            className="modal-close-btn"
            onClick={closeAddModal}
            disabled={formLoading}
            aria-label="关闭"
          >
            ×
          </button>
          <div className="modal" style={{ maxWidth: '600px', maxHeight: '80vh', overflow: 'auto' }}>
            <div className="modal-container">
              <div className="modal-header">
                <h2>{editMCP ? '编辑 MCP 工具' : '添加 MCP 工具'}</h2>
              </div>
              <form onSubmit={handleFormSubmit}>
                <div className="modal-body" style={{ padding: '0 20px 10px' }}>
                  <div className="form-group">
                    <label htmlFor="mcp-name">
                      MCP 名称 <span className="required">*</span>
                    </label>
                    <input
                      id="mcp-name"
                      type="text"
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      placeholder="例如：GLM 视觉理解"
                      disabled={formLoading}
                    />
                  </div>

                  <div className="form-group">
                    <label htmlFor="mcp-description">
                      描述
                    </label>
                    <textarea
                      id="mcp-description"
                      rows={2}
                      value={formData.description}
                      onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                      placeholder="描述该 MCP 工具的功能"
                      disabled={formLoading}
                    />
                  </div>

                  <div className="form-group">
                    <label htmlFor="mcp-type">
                      类型 <span className="required">*</span>
                    </label>
                    <select
                      id="mcp-type"
                      value={formData.type}
                      onChange={(e) => setFormData({ ...formData, type: e.target.value as any })}
                      disabled={formLoading}
                    >
                      <option value="stdio">命令行 (stdio)</option>
                      <option value="http">HTTP</option>
                      <option value="sse">SSE</option>
                    </select>
                  </div>

                  {formData.type === 'stdio' && (
                    <>
                      <div className="form-group">
                        <label htmlFor="mcp-command">
                          命令 <span className="required">*</span>
                        </label>
                        <input
                          id="mcp-command"
                          type="text"
                          value={formData.command}
                          onChange={(e) => setFormData({ ...formData, command: e.target.value })}
                          placeholder="例如：npx"
                          disabled={formLoading}
                        />
                      </div>

                      <div className="form-group">
                        <label htmlFor="mcp-args">
                          参数（空格分隔）
                        </label>
                        <input
                          id="mcp-args"
                          type="text"
                          value={formData.args}
                          onChange={(e) => setFormData({ ...formData, args: e.target.value })}
                          placeholder="例如：-y @z_ai/mcp-server"
                          disabled={formLoading}
                        />
                      </div>
                    </>
                  )}

                  {(formData.type === 'http' || formData.type === 'sse') && (
                    <div className="form-group">
                      <label htmlFor="mcp-url">
                        URL <span className="required">*</span>
                      </label>
                      <input
                        id="mcp-url"
                        type="url"
                        value={formData.url}
                        onChange={(e) => setFormData({ ...formData, url: e.target.value })}
                        placeholder="例如：https://api.example.com/mcp"
                        disabled={formLoading}
                      />
                    </div>
                  )}

                  {(formData.type === 'http' || formData.type === 'sse') && (
                    <div className="form-group">
                      <label htmlFor="mcp-headers">
                        请求头 (JSON)
                      </label>
                      <textarea
                        id="mcp-headers"
                        rows={3}
                        value={formData.headers}
                        onChange={(e) => setFormData({ ...formData, headers: e.target.value })}
                        placeholder='{\n  "Authorization": "Bearer your-token"\n}'
                        disabled={formLoading}
                        style={{ fontFamily: 'monospace', fontSize: '13px' }}
                      />
                    </div>
                  )}

                  <div className="form-group">
                    <label htmlFor="mcp-env">
                      环境变量 (JSON)
                    </label>
                    <textarea
                      id="mcp-env"
                      rows={3}
                      value={formData.env}
                      onChange={(e) => setFormData({ ...formData, env: e.target.value })}
                      placeholder='{\n  "API_KEY": "your-key"\n}'
                      disabled={formLoading}
                      style={{ fontFamily: 'monospace', fontSize: '13px' }}
                    />
                  </div>

                  <div className="form-group">
                    <label>启用目标</label>
                    <div style={{ display: 'flex', gap: '16px' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={formData.targets.includes('claude-code')}
                          onChange={(e) => setFormData({
                            ...formData,
                            targets: e.target.checked
                              ? [...formData.targets, 'claude-code']
                              : formData.targets.filter((t) => t !== 'claude-code')
                          })}
                          style={{ width: '16px', height: '16px', cursor: 'pointer' }}
                          disabled={formLoading}
                        />
                        <span>Claude Code</span>
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={formData.targets.includes('codex')}
                          onChange={(e) => setFormData({
                            ...formData,
                            targets: e.target.checked
                              ? [...formData.targets, 'codex']
                              : formData.targets.filter((t) => t !== 'codex')
                          })}
                          style={{ width: '16px', height: '16px', cursor: 'pointer' }}
                          disabled={formLoading}
                        />
                        <span>Codex</span>
                      </label>
                    </div>
                  </div>
                </div>
                <div className="modal-footer">
                  <button
                    className="btn btn-secondary"
                    type="button"
                    onClick={closeAddModal}
                    disabled={formLoading}
                  >
                    取消
                  </button>
                  <button
                    className="btn btn-primary"
                    type="submit"
                    disabled={formLoading}
                  >
                    {formLoading ? '保存中...' : editMCP ? '保存' : '添加'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {deleteConfirm.mcpId && (
        <div className="modal-overlay" style={{ zIndex: 1000001 }}>
          <button
            type="button"
            className="modal-close-btn"
            onClick={closeDeleteConfirm}
            disabled={deleteConfirm.isDeleting}
            aria-label="关闭"
          >
            ×
          </button>
          <div className="modal" style={{ maxWidth: '400px' }}>
            <div className="modal-container">
              <div className="modal-header">
                <h2>确认删除</h2>
              </div>
              <div className="modal-body" style={{ padding: '0 20px 10px' }}>
                <p style={{ color: 'var(--text-muted)' }}>
                  确定要删除 MCP 工具 "<strong>{deleteConfirm.mcpName}</strong>" 吗？此操作无法撤销。
                </p>
              </div>
              <div className="modal-footer">
                <button
                  className="btn btn-secondary"
                  onClick={closeDeleteConfirm}
                  disabled={deleteConfirm.isDeleting}
                >
                  取消
                </button>
                <button
                  className="btn btn-danger"
                  onClick={handleDeleteMCP}
                  disabled={deleteConfirm.isDeleting}
                >
                  {deleteConfirm.isDeleting ? '删除中...' : '删除'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {quickInstall.isOpen && (
        <div className="modal-overlay" style={{ zIndex: 1000002 }}>
          <button
            type="button"
            className="modal-close-btn"
            onClick={closeQuickInstall}
            disabled={quickInstall.installingMCPName !== null}
            aria-label="关闭"
          >
            ×
          </button>
          <div className="modal" style={{ maxWidth: '700px' }}>
            <div className="modal-container">
              <div className="modal-header">
                <h2>一键安装 MCP 工具</h2>
              </div>
              <div className="modal-body" style={{ padding: '0 20px 10px' }}>
                {quickInstall.step === 'select' && (
                  <>
                    <p style={{ fontSize: '14px', color: 'var(--text-muted)', marginBottom: '20px' }}>
                      点击下方的卡片，快速安装 MCP 工具到您的系统中：
                    </p>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px' }}>
                      {QUICK_INSTALL_MCP_DEFINITIONS.map((def) => {
                        const isInstalled = mcps.some(mcp => mcp.name === def.name);
                        return (
                          <div
                            key={def.id}
                            className="card"
                            style={{
                              padding: '16px',
                              cursor: isInstalled ? 'not-allowed' : 'pointer',
                              transition: 'all 0.2s ease',
                              opacity: isInstalled ? 0.7 : 1,
                            }}
                            onClick={() => !isInstalled && handleSelectMCP(def)}
                          >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
                              <div style={{ fontWeight: '600', fontSize: '16px' }}>{def.name}</div>
                              <div style={{ display: 'flex', gap: '8px' }}>
                                {isInstalled && (
                                  <div className="badge badge-success" style={{ fontSize: '12px' }}>已安装</div>
                                )}
                                <div className="badge badge-secondary" style={{ fontSize: '12px' }}>{getTypeLabel(def.type)}</div>
                              </div>
                            </div>
                            <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '12px' }}>{def.description}</div>
                            <button
                              className="btn btn-primary"
                              style={{ width: '100%' }}
                              disabled={isInstalled}
                            >
                              {isInstalled ? '已安装' : '安装'}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}

                {quickInstall.step === 'input-api-key' && (
                  <>
                    <div style={{ textAlign: 'center', marginBottom: '16px' }}>
                      <h3 style={{ fontSize: '18px', marginBottom: '8px' }}>{quickInstall.selectedDefinition?.name}</h3>
                      <p style={{ fontSize: '14px', color: 'var(--text-muted)' }}>{quickInstall.selectedDefinition?.description}</p>
                    </div>
                    <div className="form-group">
                      <label htmlFor="quick-install-api-key">
                        API Key <span className="required">*</span>
                      </label>
                      <input
                        id="quick-install-api-key"
                        type="password"
                        value={quickInstall.apiKey}
                        onChange={(e) => setQuickInstall({ ...quickInstall, apiKey: e.target.value })}
                        placeholder="请输入您的 API Key"
                        disabled={quickInstall.installingMCPName !== null}
                        autoFocus
                      />
                      <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                        API Key 将用于此 MCP 工具的认证。您可以访问相应的开放平台获取。
                      </p>
                    </div>
                    <div className="modal-footer">
                      <button
                        className="btn btn-secondary"
                        onClick={() => setQuickInstall((prev) => ({ ...prev, step: 'select', selectedDefinition: null }))}
                        disabled={quickInstall.installingMCPName !== null}
                      >
                        返回
                      </button>
                      <button
                        className="btn btn-primary"
                        onClick={handleInstallMCP}
                        disabled={quickInstall.installingMCPName !== null || !quickInstall.apiKey.trim()}
                      >
                        {quickInstall.installingMCPName ? '安装中...' : '开始安装'}
                      </button>
                    </div>
                  </>
                )}

                {quickInstall.step === 'installing' && (
                  <div style={{ padding: '20px 0', textAlign: 'center' }}>
                    <div className="spinner" style={{ width: '32px', height: '32px', margin: '0 auto 16px' }} />
                    <p style={{ color: 'var(--text-muted)' }}>{quickInstall.message}</p>
                    <p style={{ fontSize: '14px', marginTop: '8px', color: 'var(--text-muted)' }}>
                      正在安装 <strong>{quickInstall.installingMCPName}</strong>...
                    </p>
                  </div>
                )}

                {quickInstall.step === 'completed' && (
                  <div style={{ padding: '20px 0', textAlign: 'center' }}>
                    <div style={{ fontSize: '48px', marginBottom: '16px' }}>✅</div>
                    <p style={{ fontSize: '16px', marginBottom: '8px' }}>{quickInstall.message}</p>
                    <p style={{ fontSize: '14px', color: 'var(--text-muted)' }}>
                      MCP 工具已启用到 Claude Code 和 Codex，您可以在列表中查看详情。
                    </p>
                  </div>
                )}

                {quickInstall.step === 'error' && (
                  <div style={{ padding: '20px 0', textAlign: 'center' }}>
                    <div style={{ fontSize: '48px', marginBottom: '16px' }}>❌</div>
                    <p style={{ fontSize: '16px', marginBottom: '8px' }}>{quickInstall.message}</p>
                  </div>
                )}
              </div>
              <div className="modal-footer" style={{ justifyContent: quickInstall.step === 'select' || quickInstall.step === 'input-api-key' ? 'center' : 'center' }}>
                {(quickInstall.step === 'completed' || quickInstall.step === 'error') && (
                  <button
                    className="btn btn-primary"
                    onClick={closeQuickInstall}
                  >
                    关闭
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default MCPPage;
