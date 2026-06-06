import { useState, useEffect } from 'react';
import { api } from '../api/client';
import { toast } from './Toast';
import vendorsConfig from '../constants/vendors';
import VendorSelector from './VendorSelector';
import type { ApiPathBinding, Vendor, APIService, Route } from '../../types';
import { AuthType } from '../../types';

/**
 * 一键配置 Modal
 *
 * 仅需选择供应商 + 目标（+ 可选 API Key），即可自动完成：
 * 1. 创建或复用供应商（补充缺失的 API 服务）
 * 2. 以"供应商名 [目标]"创建路由
 * 3. 按目标优先级选取最佳服务创建默认规则（不启用编程套餐限制）
 * 4. 将路由激活到选定的目标（强制覆盖已有绑定）
 */

interface QuickSetupModalProps {
  show: boolean;
  onClose: () => void;
  /** 配置全部完成后的回调 */
  onComplete?: () => void;
}

// 目标类型
type SetupTarget = 'codex' | 'claude-code' | 'api';

const TARGET_OPTIONS: Array<{ value: SetupTarget; label: string; icon: string }> = [
  { value: 'codex', label: 'Codex', icon: '🤖' },
  { value: 'claude-code', label: 'Claude Code', icon: '⚡' },
  { value: 'api', label: '所有 API', icon: '🔗' },
];

const TARGET_SUFFIX: Record<SetupTarget, string> = {
  'codex': ' [Codex]',
  'claude-code': ' [Claude Code]',
  'api': ' [API]',
};

// 按目标区分的服务选取优先级（数值越小优先级越高）
const TARGET_SERVICE_PRIORITY: Record<SetupTarget, Record<string, number>> = {
  'claude-code': {
    'claude': 0,
    'claude-chat': 1,
    'openai-chat': 2,
    'openai': 3,
    'gemini': 4,
    'gemini-chat': 5,
  },
  'codex': {
    'openai': 0,
    'openai-chat': 1,
    'claude': 2,
    'claude-chat': 3,
    'gemini': 4,
    'gemini-chat': 5,
  },
  'api': {
    'openai-chat': 0,
    'claude': 1,
    'claude-chat': 2,
    'openai': 3,
    'gemini': 4,
    'gemini-chat': 5,
  },
};

export default function QuickSetupModal({ show, onClose, onComplete }: QuickSetupModalProps) {
  const [vendorKey, setVendorKey] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [target, setTarget] = useState<SetupTarget>('codex');
  const [loading, setLoading] = useState(false);
  const [existingVendors, setExistingVendors] = useState<Vendor[]>([]);
  const [existingRoutes, setExistingRoutes] = useState<Route[]>([]);

  // 弹窗打开时加载已有供应商和路由
  useEffect(() => {
    if (show) {
      api.getVendors().then(setExistingVendors).catch(() => {});
      api.getRoutes().then(setExistingRoutes).catch(() => {});
    }
  }, [show]);

  // 当前选中的配置
  const currentConfig = vendorKey
    ? vendorsConfig[vendorKey as keyof typeof vendorsConfig]
    : null;

  // 是否已有同名供应商
  const existingVendor = currentConfig
    ? existingVendors.find(v => v.name === currentConfig.name)
    : null;

  // 已有供应商是否已配置 API Key
  const hasExistingApiKey = !!existingVendor?.apiKey;

  // 是否需要展示 API Key 输入框
  const needsApiKey = !existingVendor || !hasExistingApiKey;

  if (!show) return null;

  const handleClose = () => {
    if (!loading) {
      setVendorKey('');
      setApiKey('');
      setTarget('codex');
      onClose();
    }
  };

  /** 根据预设配置创建一个 API 服务 */
  const createServiceFromConfig = (
    vendorId: string,
    sc: typeof vendorsConfig[string]['services'][number],
  ) =>
    api.createAPIService({
      vendorId,
      name: sc.name,
      apiUrl: sc.apiUrl,
      apiKey: '',
      inheritVendorApiKey: true,
      inheritVendorApiBaseUrl: false,
      sourceType: sc.sourceType,
      authType: sc.authType,
      supportedModels: sc.models
        ? sc.models.split(',').map((m: string) => m.trim())
        : undefined,
      modelLimits: sc.modelLimits || {},
      enableCodingPlan: false,
    });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!vendorKey) {
      toast.warning('请选择供应商');
      return;
    }
    if (needsApiKey && !apiKey) {
      toast.warning('请填写 API Key');
      return;
    }

    const vendorConfig = vendorsConfig[vendorKey as keyof typeof vendorsConfig];
    if (!vendorConfig) {
      toast.error('未找到对应的供应商配置');
      return;
    }

    setLoading(true);

    try {
      let vendorId: string;
      let allServices: APIService[];

      if (existingVendor) {
        // ── 供应商已存在：补充缺失服务 ──
        vendorId = existingVendor.id;

        // 若供应商没有 API Key，更新之
        if (!hasExistingApiKey && apiKey) {
          await api.updateVendor(vendorId, { ...existingVendor, apiKey });
        }

        // 找出已有服务的 sourceType 集合
        const existingTypes = new Set(
          (existingVendor.services || []).map(s => s.sourceType),
        );
        const missingConfigs = vendorConfig.services.filter(
          sc => !existingTypes.has(sc.sourceType),
        );

        // 仅创建缺失的服务
        const newServices = missingConfigs.length > 0
          ? await Promise.all(
              missingConfigs.map(sc => createServiceFromConfig(vendorId, sc)),
            )
          : [];

        allServices = [...(existingVendor.services || []), ...newServices];
      } else {
        // ── 新建供应商 ──
        const vendorResult = await api.createVendor({
          name: vendorConfig.name,
          description: vendorConfig.description,
          apiKey,
          authType: AuthType.AUTH_TOKEN,
          sortOrder: 0,
          services: [],
        });

        if (!vendorResult?.id) {
          throw new Error('供应商创建失败');
        }
        vendorId = vendorResult.id;

        // 创建全部 API 服务
        allServices = await Promise.all(
          vendorConfig.services.map(sc => createServiceFromConfig(vendorId, sc)),
        );
      }

      // ── 创建路由（供应商名 + 目标后缀，去重） ──
      const baseRouteName = vendorConfig.name + TARGET_SUFFIX[target];
      const existingNames = new Set(existingRoutes.map(r => r.name));
      let routeName = baseRouteName;
      if (existingNames.has(routeName)) {
        let n = 2;
        while (existingNames.has(`${baseRouteName}-${n}`)) n++;
        routeName = `${baseRouteName}-${n}`;
      }
      const routeResult = await api.createRoute({
        name: routeName,
        description: '由一键配置自动创建',
      });
      if (!routeResult?.id) {
        throw new Error('路由创建失败');
      }

      // ── 按目标优先级选取最佳服务，创建默认规则 ──
      const priorityMap = TARGET_SERVICE_PRIORITY[target];
      const bestService = [...allServices]
        .filter(s => s.sourceType)
        .map(s => ({
          service: s,
          priority: priorityMap[s.sourceType!] ?? 99,
        }))
        .sort((a, b) => a.priority - b.priority)[0]?.service;

      if (bestService) {
        const firstModel = bestService.supportedModels?.length
          ? bestService.supportedModels[0]
          : undefined;

        await api.createRule({
          routeId: routeResult.id,
          contentType: 'default',
          targetServiceId: bestService.id,
          targetModel: firstModel,
          sortOrder: 0,
        });
      }

      // ── 激活路由到选定目标（强制覆盖） ──
      if (target === 'codex' || target === 'claude-code') {
        try {
          await api.activateToolRoute(target, routeResult.id);
        } catch { /* ignore */ }
      }

      if (target === 'api') {
        let currentPathBindings: { bindings: ApiPathBinding[]; models: string } | null = null;
        try {
          currentPathBindings = await api.getApiPathBindings();
        } catch { /* ignore */ }

        if (currentPathBindings?.bindings) {
          const updatedBindings = currentPathBindings.bindings.map(binding => {
            if (binding.apiPath === '/v1/models') return binding;
            return { ...binding, routeId: routeResult.id };
          });
          try {
            await api.updateApiPathBindings(updatedBindings, currentPathBindings.models || '');
          } catch { /* ignore */ }
        }
      }

      toast.success('一键配置完成！路由已激活，可以开始使用');
      onComplete?.();
      handleClose();
      // 刷新页面以确保显示最新的路由和供应商数据
      setTimeout(() => {
        window.location.reload();
      }, 300);
    } catch (error) {
      console.error('一键配置失败:', error);
      toast.error(`配置失败: ${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay">
      <button
        type="button"
        className="modal-close-btn"
        onClick={handleClose}
        aria-label="关闭"
        disabled={loading}
      >
        ×
      </button>
      <div className="modal">
        <div className="modal-container">
          <div className="modal-header">
            <h2>🚀 一键配置</h2>
          </div>
          <form onSubmit={handleSubmit}>
            {/* 供应商选择 */}
            <div className="form-group">
              <label>供应商</label>
              <VendorSelector
                value={vendorKey}
                onChange={(key) => setVendorKey(key)}
                existingVendors={existingVendors}
                disabled={loading}
              />
            </div>

            {/* 供应商描述 */}
            {currentConfig?.description && (
              <div style={{ fontSize: '.8em', marginBottom: 16, marginTop: -16 }}>
                {currentConfig.description}
                {currentConfig.link && (
                  <>
                    {' '}
                    <a
                      href={currentConfig.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: 'var(--accent-primary)' }}
                    >
                      {(() => {
                        try {
                          const url = new URL(currentConfig.link!);
                          return url.protocol + '//' + url.hostname;
                        } catch {
                          return currentConfig.link;
                        }
                      })()}
                    </a>
                  </>
                )}
              </div>
            )}

            {/* API Key —— 仅在供应商不存在或未配置 Key 时展示 */}
            {needsApiKey && (
              <div className="form-group">
                <label>API Key</label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="请输入API密钥"
                  required
                  disabled={loading}
                />
              </div>
            )}

            {/* 目标选择 */}
            <div className="form-group">
              <label>目标</label>
              <div style={{
                border: '1px solid var(--border-primary)',
                borderRadius: '8px',
                padding: '12px',
                background: 'var(--bg-secondary)',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
              }}>
                {TARGET_OPTIONS.map((opt) => {
                  const isChecked = target === opt.value;
                  return (
                    <label
                      key={opt.value}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        cursor: 'pointer',
                        padding: '10px 14px',
                        borderRadius: '6px',
                        background: isChecked ? 'var(--accent-light)' : 'transparent',
                        border: `2px solid ${isChecked ? 'var(--accent-primary)' : 'transparent'}`,
                        transition: 'all 0.2s ease',
                      }}
                      onMouseEnter={(e) => {
                        if (!isChecked) {
                          e.currentTarget.style.background = 'var(--bg-hover)';
                          e.currentTarget.style.borderColor = 'var(--border-secondary)';
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!isChecked) {
                          e.currentTarget.style.background = 'transparent';
                          e.currentTarget.style.borderColor = 'transparent';
                        }
                      }}
                    >
                      <input
                        type="radio"
                        name="setupTarget"
                        value={opt.value}
                        checked={isChecked}
                        onChange={() => setTarget(opt.value)}
                        style={{
                          width: '18px',
                          height: '18px',
                          marginRight: '12px',
                          cursor: 'pointer',
                          accentColor: 'var(--accent-primary)',
                        }}
                        disabled={loading}
                      />
                      <span style={{
                        fontSize: '14px',
                        fontWeight: isChecked ? '600' : '400',
                        color: 'var(--text-primary)',
                        transition: 'all 0.2s ease',
                      }}>
                        {opt.icon} {opt.label}
                      </span>
                      {isChecked && (
                        <span style={{
                          marginLeft: 'auto',
                          fontSize: '16px',
                          color: 'var(--text-primary)',
                        }}>✓</span>
                      )}
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={handleClose} disabled={loading}>
                取消
              </button>
              <button type="submit" className="btn btn-primary" disabled={loading}>
                {loading ? '配置中...' : '确认配置'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
