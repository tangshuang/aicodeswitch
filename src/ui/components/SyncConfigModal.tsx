import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import type { LanDiscoverResponse, LanSkillItem, LanMcpItem, InstalledSkill, MCPServer } from '../../types';
import { toast } from './Toast';

interface SyncConfigModalProps {
  show: boolean;
  onClose: () => void;
  onComplete: () => void;
}

interface DiscoveredNode {
  ip: string;
  port: number;
  data: LanDiscoverResponse;
}

/** 可勾选的 Skill 条目 */
interface SelectableSkill extends LanSkillItem {
  isDuplicate: boolean;
}

/** 可勾选的 MCP 条目 */
interface SelectableMcp extends LanMcpItem {
  isDuplicate: boolean;
}

type Step = 1 | 2 | 3 | 4 | 5;

const STEP_LABELS: Record<Step, string> = {
  1: '选择节点',
  2: 'Skills',
  3: 'MCP',
  4: '供应商',
  5: '确认同步',
};

export default function SyncConfigModal({ show, onClose, onComplete }: SyncConfigModalProps) {
  const [step, setStep] = useState<Step>(1);
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState({ current: 0, total: 0 });
  const [discoveredNodes, setDiscoveredNodes] = useState<DiscoveredNode[]>([]);
  const [selectedNode, setSelectedNode] = useState<DiscoveredNode | null>(null);
  const [manualIp, setManualIp] = useState('');
  const [manualPort, setManualPort] = useState('4567');
  const [manualConnecting, setManualConnecting] = useState(false);

  // Step 2: Skills 选择
  const [selectableSkills, setSelectableSkills] = useState<SelectableSkill[]>([]);
  const [selectedSkillNames, setSelectedSkillNames] = useState<Set<string>>(new Set());

  // Step 3: MCP 选择
  const [selectableMcps, setSelectableMcps] = useState<SelectableMcp[]>([]);
  const [selectedMcpNames, setSelectedMcpNames] = useState<Set<string>>(new Set());

  // Step 4: 供应商
  const [createVendor, setCreateVendor] = useState(false);
  const [vendorApiKey, setVendorApiKey] = useState('');

  // Step 5: 同步中
  const [syncing, setSyncing] = useState(false);

  // 重置所有状态
  const resetState = useCallback(() => {
    setStep(1);
    setScanning(false);
    setScanProgress({ current: 0, total: 0 });
    setDiscoveredNodes([]);
    setSelectedNode(null);
    setManualIp('');
    setManualPort('4567');
    setManualConnecting(false);
    setSelectableSkills([]);
    setSelectedSkillNames(new Set());
    setSelectableMcps([]);
    setSelectedMcpNames(new Set());
    setCreateVendor(false);
    setVendorApiKey('');
    setSyncing(false);
  }, []);

  // 弹窗打开时自动开始扫描
  useEffect(() => {
    if (show) {
      resetState();
      startScan();
    }
  }, [show]); // eslint-disable-line react-hooks/exhaustive-deps

  // ========== Step 1: 扫描 ==========
  const startScan = async () => {
    setScanning(true);
    setDiscoveredNodes([]);
    setScanProgress({ current: 0, total: 0 });

    try {
      const scanInfo = await api.lanScan();
      const { subnet, port } = scanInfo;
      const localIp = scanInfo.localIp;

      const ips: string[] = [];
      for (let i = 1; i <= 254; i++) {
        const ip = `${subnet}.${i}`;
        if (ip !== localIp) ips.push(ip);
      }

      setScanProgress({ current: 0, total: ips.length });

      // 并发扫描，每批 30 个
      const batchSize = 30;
      const found: DiscoveredNode[] = [];

      for (let batchStart = 0; batchStart < ips.length; batchStart += batchSize) {
        const batch = ips.slice(batchStart, batchStart + batchSize);
        const results = await Promise.allSettled(
          batch.map(async (ip) => {
            const data = await api.lanDiscover(ip, port);
            return { ip, port, data };
          })
        );

        for (const r of results) {
          if (r.status === 'fulfilled') {
            found.push(r.value);
          }
        }

        setDiscoveredNodes([...found]);
        setScanProgress({ current: Math.min(batchStart + batchSize, ips.length), total: ips.length });
      }

      setScanProgress({ current: ips.length, total: ips.length });
    } catch (error: any) {
      console.error('[LAN Scan] 扫描失败:', error);
    } finally {
      setScanning(false);
    }
  };

  // 手动连接
  const handleManualConnect = async () => {
    if (!manualIp.trim()) return;
    setManualConnecting(true);
    try {
      const port = parseInt(manualPort) || 4567;
      const data = await api.lanDiscover(manualIp.trim(), port);
      const node: DiscoveredNode = { ip: manualIp.trim(), port, data };
      setDiscoveredNodes(prev => {
        if (prev.some(n => n.ip === manualIp.trim() && n.port === port)) return prev;
        return [...prev, node];
      });
      setSelectedNode(node);
      toast.success('连接成功');
    } catch (error: any) {
      toast.error('无法连接，请检查 IP 和端口');
    } finally {
      setManualConnecting(false);
    }
  };

  // 进入 Step 2 时准备 Skills 数据（含重名检测）
  const handleNodeSelectedAndNext = async () => {
    if (!selectedNode) return;

    // 获取本地 Skills 和 MCPs 用于重名检测
    let localSkills: InstalledSkill[] = [];
    let localMcps: MCPServer[] = [];
    try {
      localSkills = await api.getInstalledSkills();
    } catch { /* ignore */ }
    try {
      localMcps = await api.getMCPs();
    } catch { /* ignore */ }

    const localSkillNames = new Set(localSkills.map(s => s.name));
    const localMcpNames = new Set(localMcps.map(m => m.name));

    const skills: SelectableSkill[] = (selectedNode.data.skills || []).map(s => ({
      ...s,
      isDuplicate: localSkillNames.has(s.name),
    }));
    setSelectableSkills(skills);

    const mcps: SelectableMcp[] = (selectedNode.data.mcps || []).map(m => ({
      ...(m as LanMcpItem),
      isDuplicate: localMcpNames.has(m.name),
    }));
    setSelectableMcps(mcps);

    setStep(2);
  };

  // ========== Step 5: 同步 ==========
  const handleSync = async () => {
    if (!selectedNode) return;

    // 检查是否有选择任何内容
    const hasSkills = selectedSkillNames.size > 0;
    const hasMcps = selectedMcpNames.size > 0;
    if (!hasSkills && !hasMcps && !createVendor) return;

    setSyncing(true);

    try {
      const result = await api.lanSync({
        remoteNode: {
          ip: selectedNode.ip,
          port: selectedNode.port,
          name: selectedNode.data.node.name,
        },
        skills: selectableSkills
          .filter(s => selectedSkillNames.has(s.name) && !s.isDuplicate)
          .map(({ isDuplicate, ...rest }) => rest),
        mcps: selectableMcps
          .filter(m => selectedMcpNames.has(m.name) && !m.isDuplicate)
          .map(({ isDuplicate, ...rest }) => rest),
        vendor: {
          enabled: createVendor,
          apiKey: vendorApiKey || undefined,
        },
      });

      if (result.success) {
        toast.success('同步完成');
        onComplete();
        setTimeout(() => onClose(), 500);
      } else {
        toast.error('同步失败: ' + (result.error || '未知错误'));
      }
    } catch (error: any) {
      toast.error('同步失败: ' + error.message);
    } finally {
      setSyncing(false);
    }
  };

  const toggleSkill = (name: string) => {
    setSelectedSkillNames(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleAllSkills = () => {
    const available = selectableSkills.filter(s => !s.isDuplicate);
    const allSelected = available.every(s => selectedSkillNames.has(s.name));
    if (allSelected) {
      setSelectedSkillNames(new Set());
    } else {
      setSelectedSkillNames(new Set(available.map(s => s.name)));
    }
  };

  const toggleMcp = (name: string) => {
    setSelectedMcpNames(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleAllMcps = () => {
    const available = selectableMcps.filter(m => !m.isDuplicate);
    const allSelected = available.every(m => selectedMcpNames.has(m.name));
    if (allSelected) {
      setSelectedMcpNames(new Set());
    } else {
      setSelectedMcpNames(new Set(available.map(m => m.name)));
    }
  };

  const hasAnySelection = selectedSkillNames.size > 0 || selectedMcpNames.size > 0 || createVendor;
  const availableSkills = selectableSkills.filter(s => !s.isDuplicate);
  const availableMcps = selectableMcps.filter(m => !m.isDuplicate);

  if (!show) return null;

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget && !syncing) onClose(); }}>
      <button type="button" className="modal-close-btn" onClick={() => { if (!syncing) onClose(); }} aria-label="关闭">
        ×
      </button>
      <div className="modal">
        <div className="modal-container" style={{ maxWidth: '640px' }}>
          <div className="modal-header">
            <h2>局域网内同步配置</h2>
          </div>

          {/* 步骤指示器 */}
          <div style={{ display: 'flex', gap: '8px', padding: '0 24px', marginBottom: '20px', borderBottom: '1px solid var(--border-color)', paddingBottom: '12px' }}>
            {([1, 2, 3, 4, 5] as Step[]).map(s => (
              <span
                key={s}
                style={{
                  fontSize: '13px',
                  color: step === s ? 'var(--primary-color)' : s < step ? 'var(--text-secondary)' : 'var(--text-muted)',
                  fontWeight: step === s ? 600 : 400,
                  borderBottom: step === s ? '2px solid var(--primary-color)' : '2px solid transparent',
                  paddingBottom: '10px',
                  cursor: 'default',
                }}
              >
                {s < step ? '✓ ' : `${s} `}{STEP_LABELS[s]}
              </span>
            ))}
          </div>

          <div style={{ padding: '0 24px', minHeight: '300px' }}>
            {/* ========== Step 1: 扫描发现 ========== */}
            {step === 1 && (
              <div>
                {scanning && (
                  <div style={{ marginBottom: '16px' }}>
                    <p style={{ fontSize: '14px', color: '#666', marginBottom: '8px' }}>
                      正在扫描局域网... {scanProgress.current}/{scanProgress.total}
                    </p>
                    <div style={{
                      width: '100%',
                      height: '6px',
                      background: 'var(--bg-secondary)',
                      borderRadius: '3px',
                      overflow: 'hidden',
                    }}>
                      <div style={{
                        width: scanProgress.total > 0 ? `${(scanProgress.current / scanProgress.total * 100)}%` : '0%',
                        height: '100%',
                        background: 'var(--primary-color)',
                        borderRadius: '3px',
                        transition: 'width 0.3s ease',
                      }} />
                    </div>
                  </div>
                )}

                {!scanning && discoveredNodes.length === 0 && (
                  <div style={{ textAlign: 'center', padding: '40px 0', color: '#999' }}>
                    <p style={{ fontSize: '16px', marginBottom: '8px' }}>未发现可用节点</p>
                    <p style={{ fontSize: '14px' }}>请确认远端节点已开启"允许局域网拉取配置"，或手动输入 IP 地址</p>
                  </div>
                )}

                {discoveredNodes.length > 0 && (
                  <div style={{ marginBottom: '16px' }}>
                    <p style={{ fontSize: '14px', color: '#666', marginBottom: '8px' }}>
                      已发现 {discoveredNodes.length} 个节点：
                    </p>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      {discoveredNodes.map(node => (
                        <label
                          key={`${node.ip}-${node.port}`}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '12px',
                            padding: '12px',
                            border: `2px solid ${selectedNode?.ip === node.ip && selectedNode?.port === node.port ? 'var(--primary-color)' : 'var(--border-color)'}`,
                            borderRadius: '8px',
                            cursor: 'pointer',
                            background: selectedNode?.ip === node.ip && selectedNode?.port === node.port ? 'var(--primary-bg)' : 'transparent',
                            transition: 'all 0.2s',
                          }}
                          onClick={() => setSelectedNode(node)}
                        >
                          <input
                            type="radio"
                            name="node"
                            checked={selectedNode?.ip === node.ip && selectedNode?.port === node.port}
                            onChange={() => setSelectedNode(node)}
                            style={{ accentColor: 'var(--primary-color)' }}
                          />
                          <div style={{ flex: 1 }}>
                            <div style={{ fontWeight: 500 }}>{node.data.node.name}</div>
                            <div style={{ fontSize: '13px', color: '#666' }}>
                              {node.ip}:{node.port}
                              {node.data.skills?.length > 0 && ` · ${node.data.skills.length} Skills`}
                              {node.data.mcps?.length > 0 && ` · ${node.data.mcps.length} MCP`}
                            </div>
                          </div>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {/* 手动添加 */}
                <div style={{
                  borderTop: '1px solid var(--border-color)',
                  paddingTop: '16px',
                  display: 'flex',
                  gap: '8px',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                }}>
                  <span style={{ fontSize: '14px', color: '#666', whiteSpace: 'nowrap' }}>手动添加：</span>
                  <input
                    type="text"
                    value={manualIp}
                    onChange={e => setManualIp(e.target.value)}
                    placeholder="192.168.1.xxx"
                    style={{ flex: 1, minWidth: '140px', padding: '6px 10px', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'var(--input-bg, var(--bg-secondary))', color: 'var(--text-primary)' }}
                  />
                  <input
                    type="text"
                    value={manualPort}
                    onChange={e => setManualPort(e.target.value)}
                    placeholder="4567"
                    style={{ width: '70px', padding: '6px 10px', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'var(--input-bg, var(--bg-secondary))', color: 'var(--text-primary)' }}
                  />
                  <button
                    className="btn btn-secondary"
                    onClick={handleManualConnect}
                    disabled={manualConnecting || !manualIp.trim()}
                  >
                    {manualConnecting ? '连接中...' : '连接'}
                  </button>
                </div>
              </div>
            )}

            {/* ========== Step 2: 选择 Skills ========== */}
            {step === 2 && (
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <p style={{ fontSize: '14px', color: '#666' }}>
                    远端节点：{selectedNode?.data.node.name} ({selectedNode?.ip})
                  </p>
                  {availableSkills.length > 0 && (
                    <button className="btn btn-secondary" style={{ fontSize: '12px', padding: '4px 10px' }} onClick={toggleAllSkills}>
                      {availableSkills.every(s => selectedSkillNames.has(s.name)) ? '取消全选' : '全选'}
                    </button>
                  )}
                </div>

                <p style={{ fontSize: '15px', fontWeight: 500, marginBottom: '12px' }}>选择需要同步的 Skills：</p>

                {selectableSkills.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '30px 0', color: '#999' }}>
                    <p>远端无可用 Skills</p>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '360px', overflowY: 'auto' }}>
                    {selectableSkills.map(skill => (
                      <label
                        key={skill.name}
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: '10px',
                          padding: '10px 12px',
                          border: `1px solid ${skill.isDuplicate ? '#f0ad4e' : 'var(--border-color)'}`,
                          borderRadius: '8px',
                          cursor: skill.isDuplicate ? 'not-allowed' : 'pointer',
                          opacity: skill.isDuplicate ? 0.7 : 1,
                          background: skill.isDuplicate ? 'var(--bg-secondary)' : 'transparent',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={selectedSkillNames.has(skill.name)}
                          onChange={() => toggleSkill(skill.name)}
                          disabled={skill.isDuplicate}
                          style={{ accentColor: 'var(--primary-color)', marginTop: '2px' }}
                        />
                        <div style={{ flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{ fontWeight: 500 }}>{skill.name}</span>
                            {skill.targets && skill.targets.length > 0 && (
                              <span style={{ fontSize: '11px', padding: '1px 6px', borderRadius: '4px', background: 'var(--bg-secondary)', color: '#666' }}>
                                {skill.targets.join(', ')}
                              </span>
                            )}
                          </div>
                          {skill.description && (
                            <div style={{ fontSize: '13px', color: '#666', marginTop: '2px' }}>{skill.description}</div>
                          )}
                          {skill.isDuplicate && (
                            <div style={{ fontSize: '12px', color: '#e67e22', marginTop: '4px' }}>
                              ⚠ 本地已存在，无法重复同步
                            </div>
                          )}
                        </div>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ========== Step 3: 选择 MCP ========== */}
            {step === 3 && (
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <p style={{ fontSize: '15px', fontWeight: 500 }}>选择需要同步的 MCP：</p>
                  {availableMcps.length > 0 && (
                    <button className="btn btn-secondary" style={{ fontSize: '12px', padding: '4px 10px' }} onClick={toggleAllMcps}>
                      {availableMcps.every(m => selectedMcpNames.has(m.name)) ? '取消全选' : '全选'}
                    </button>
                  )}
                </div>

                {selectableMcps.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '30px 0', color: '#999' }}>
                    <p>远端无可用 MCP</p>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '360px', overflowY: 'auto' }}>
                    {selectableMcps.map(mcp => (
                      <label
                        key={mcp.name}
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: '10px',
                          padding: '10px 12px',
                          border: `1px solid ${mcp.isDuplicate ? '#f0ad4e' : 'var(--border-color)'}`,
                          borderRadius: '8px',
                          cursor: mcp.isDuplicate ? 'not-allowed' : 'pointer',
                          opacity: mcp.isDuplicate ? 0.7 : 1,
                          background: mcp.isDuplicate ? 'var(--bg-secondary)' : 'transparent',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={selectedMcpNames.has(mcp.name)}
                          onChange={() => toggleMcp(mcp.name)}
                          disabled={mcp.isDuplicate}
                          style={{ accentColor: 'var(--primary-color)', marginTop: '2px' }}
                        />
                        <div style={{ flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{ fontWeight: 500 }}>{mcp.name}</span>
                            <span style={{ fontSize: '11px', padding: '1px 6px', borderRadius: '4px', background: 'var(--bg-secondary)', color: '#666' }}>
                              {mcp.type}
                            </span>
                          </div>
                          {mcp.description && (
                            <div style={{ fontSize: '13px', color: '#666', marginTop: '2px' }}>{mcp.description}</div>
                          )}
                          {mcp.isDuplicate && (
                            <div style={{ fontSize: '12px', color: '#e67e22', marginTop: '4px' }}>
                              ⚠ 本地已存在，无法重复同步
                            </div>
                          )}
                        </div>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ========== Step 4: 供应商配置 ========== */}
            {step === 4 && (
              <div>
                <p style={{ fontSize: '15px', fontWeight: 500, marginBottom: '16px' }}>
                  是否将该节点作为本地供应商？
                </p>

                <div style={{ display: 'flex', gap: '24px', marginBottom: '16px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="createVendor"
                      checked={createVendor}
                      onChange={() => setCreateVendor(true)}
                      style={{ accentColor: 'var(--primary-color)' }}
                    />
                    <span>是</span>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="createVendor"
                      checked={!createVendor}
                      onChange={() => setCreateVendor(false)}
                      style={{ accentColor: 'var(--primary-color)' }}
                    />
                    <span>否</span>
                  </label>
                </div>

                {createVendor && (
                  <div style={{
                    padding: '16px',
                    border: '1px solid var(--border-color)',
                    borderRadius: '8px',
                    marginBottom: '12px',
                  }}>
                    <label style={{ fontSize: '14px', fontWeight: 500, display: 'block', marginBottom: '6px' }}>
                      API Key（选填）
                    </label>
                    <input
                      type="text"
                      value={vendorApiKey}
                      onChange={e => setVendorApiKey(e.target.value)}
                      placeholder="如果远端节点开启了认证，请填写其接入密钥"
                      style={{
                        width: '100%',
                        padding: '8px 12px',
                        borderRadius: '6px',
                        border: '1px solid var(--border-color)',
                        background: 'var(--input-bg, var(--bg-secondary))',
                        color: 'var(--text-primary)',
                        boxSizing: 'border-box',
                      }}
                    />
                    <p style={{ fontSize: '12px', color: '#999', marginTop: '6px' }}>
                      不填写则使用空密钥连接。
                    </p>
                  </div>
                )}

                {createVendor && (
                  <p style={{ fontSize: '13px', color: '#666' }}>
                    将创建供应商 <strong>{selectedNode?.data.node.name}@{selectedNode?.ip}</strong>，
                    包含 {selectedNode?.data.vendors?.reduce((sum, v) => sum + (v.services?.length || 0), 0) || 0} 个 API 服务。
                  </p>
                )}

                {!createVendor && (
                  <p style={{ fontSize: '13px', color: '#999' }}>
                    跳过供应商创建，仅同步 Skills 和 MCP 配置。
                  </p>
                )}
              </div>
            )}

            {/* ========== Step 5: 预览与确认 ========== */}
            {step === 5 && !syncing && (
              <div>
                <p style={{ fontSize: '16px', fontWeight: 600, marginBottom: '16px' }}>同步预览</p>

                {/* Skills */}
                <div style={{ marginBottom: '16px' }}>
                  <h4 style={{ fontSize: '14px', color: '#666', marginBottom: '8px' }}>
                    Skills（{selectedSkillNames.size} 项）
                  </h4>
                  {selectedSkillNames.size === 0 ? (
                    <p style={{ fontSize: '13px', color: '#999', paddingLeft: '8px' }}>未选择</p>
                  ) : (
                    <div style={{ paddingLeft: '8px' }}>
                      {selectableSkills
                        .filter(s => selectedSkillNames.has(s.name))
                        .map(s => (
                          <div key={s.name} style={{ fontSize: '14px', padding: '2px 0' }}>
                            · {s.name} {s.targets?.length ? `(${s.targets.join(', ')})` : ''}
                          </div>
                        ))}
                    </div>
                  )}
                </div>

                {/* MCP */}
                <div style={{ marginBottom: '16px' }}>
                  <h4 style={{ fontSize: '14px', color: '#666', marginBottom: '8px' }}>
                    MCP（{selectedMcpNames.size} 项）
                  </h4>
                  {selectedMcpNames.size === 0 ? (
                    <p style={{ fontSize: '13px', color: '#999', paddingLeft: '8px' }}>未选择</p>
                  ) : (
                    <div style={{ paddingLeft: '8px' }}>
                      {selectableMcps
                        .filter(m => selectedMcpNames.has(m.name))
                        .map(m => (
                          <div key={m.name} style={{ fontSize: '14px', padding: '2px 0' }}>
                            · {m.name} ({m.type})
                          </div>
                        ))}
                    </div>
                  )}
                </div>

                {/* 供应商 */}
                <div style={{ marginBottom: '16px' }}>
                  <h4 style={{ fontSize: '14px', color: '#666', marginBottom: '8px' }}>供应商</h4>
                  {createVendor ? (
                    <div style={{ paddingLeft: '8px' }}>
                      <div style={{ fontSize: '14px' }}>名称：{selectedNode?.data.node.name}@{selectedNode?.ip}</div>
                      <div style={{ fontSize: '14px' }}>API Key：{vendorApiKey ? '已填写' : '未填写'}</div>
                      <div style={{ fontSize: '14px' }}>
                        API 服务：{selectedNode?.data.vendors?.reduce((sum, v) => sum + (v.services?.length || 0), 0) || 0} 个
                      </div>
                    </div>
                  ) : (
                    <p style={{ fontSize: '13px', color: '#999', paddingLeft: '8px' }}>不创建</p>
                  )}
                </div>

                {!hasAnySelection && (
                  <p style={{ fontSize: '13px', color: '#e74c3c', textAlign: 'center' }}>
                    未选择任何同步内容
                  </p>
                )}
              </div>
            )}

            {/* ========== Step 5: 同步中 ========== */}
            {step === 5 && syncing && (
              <div style={{ textAlign: 'center', padding: '60px 0' }}>
                <div style={{
                  width: '40px',
                  height: '40px',
                  border: '3px solid var(--border-color)',
                  borderTop: '3px solid var(--primary-color)',
                  borderRadius: '50%',
                  animation: 'spin 1s linear infinite',
                  margin: '0 auto 16px',
                }} />
                <p style={{ fontSize: '16px', color: '#666' }}>正在同步...</p>
                <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
              </div>
            )}
          </div>

          {/* 底部按钮 */}
          <div className="modal-footer" style={{ marginTop: '20px' }}>
            {step > 1 && step < 5 && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setStep((step - 1) as Step)}
                disabled={syncing}
              >
                ← 上一步
              </button>
            )}
            <div style={{ flex: 1 }} />
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={syncing}>
              取消
            </button>

            {step === 1 && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleNodeSelectedAndNext}
                disabled={!selectedNode}
              >
                下一步 →
              </button>
            )}
            {step === 2 && (
              <button type="button" className="btn btn-primary" onClick={() => setStep(3)}>
                下一步 →
              </button>
            )}
            {step === 3 && (
              <button type="button" className="btn btn-primary" onClick={() => setStep(4)}>
                下一步 →
              </button>
            )}
            {step === 4 && (
              <button type="button" className="btn btn-primary" onClick={() => setStep(5)}>
                下一步 →
              </button>
            )}
            {step === 5 && !syncing && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleSync}
                disabled={!hasAnySelection}
              >
                同步
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
