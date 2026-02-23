import { useState, useEffect, useMemo, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import { api } from '../api/client';
import type { Vendor, APIService, SourceType } from '../../types';
import { AuthType } from '../../types';
import vendorsConfig from '../constants/vendors';
import { SOURCE_TYPE, SOURCE_TYPE_MESSAGE, AUTH_TYPE, AUTH_TYPE_MESSAGE } from '../constants';
import { useRecomandVendors } from '../hooks/docs';
import { useConfirm } from '../components/Confirm';
import { toast } from '../components/Toast';

/**
 * 将 Date 对象转换为 datetime-local input 所需的格式
 */
function formatDateTimeLocal(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

// TagInput 组件
function TagInput({ value = [], onChange, placeholder, inputValue, onInputChange }: {
  value: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  inputValue: string;
  onInputChange: (value: string) => void;
}) {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const newTag = inputValue.trim();
      if (newTag && !value.includes(newTag)) {
        onChange([...value, newTag]);
        onInputChange('');
      }
    } else if (e.key === 'Backspace' && !inputValue && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  const removeTag = (indexToRemove: number) => {
    onChange(value.filter((_, index) => index !== indexToRemove));
  };

  return (
    <div style={{
      border: `1px solid var(--border-primary)`,
      borderRadius: '4px',
      padding: '8px',
      minHeight: '40px',
      background: 'var(--bg-secondary)'
    }}>
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '4px',
        alignItems: 'center'
      }}>
        {value.map((tag, index) => (
          <span key={index} style={{
            backgroundColor: 'var(--accent-light)',
            color: 'var(--text-primary)',
            padding: '4px 8px',
            borderRadius: '4px',
            fontSize: '12px',
            display: 'flex',
            alignItems: 'center',
            gap: '4px'
          }}>
            {tag}
            <button
              type="button"
              onClick={() => removeTag(index)}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--text-primary)',
                cursor: 'pointer',
                fontSize: '16px',
                lineHeight: '1',
                padding: '0',
                marginLeft: '4px'
              }}
              onMouseOver={(e) => e.currentTarget.style.color = 'var(--accent-danger)'}
              onMouseOut={(e) => e.currentTarget.style.color = 'var(--text-primary)'}
            >
              ×
            </button>
          </span>
        ))}
        <input
          type="text"
          value={inputValue}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          style={{
            border: 'none',
            outline: 'none',
            flex: '1',
            minWidth: '120px',
            fontSize: '14px'
          }}
        />
      </div>
    </div>
  );
}


function VendorsPage() {
  const { confirm } = useConfirm();
  const authTypeSelectRef = useRef<HTMLSelectElement>(null);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  // 移除独立的 services 状态，现在从 selectedVendor.services 获取
  const [selectedVendor, setSelectedVendor] = useState<Vendor | null>(null);
  const [showVendorModal, setShowVendorModal] = useState(false);
  const [showServiceModal, setShowServiceModal] = useState(false);
  const [showRecommendModal, setShowRecommendModal] = useState(false);
  const [showQuickSetupModal, setShowQuickSetupModal] = useState(false);
  const [editingVendor, setEditingVendor] = useState<Vendor | null>(null);
  const [editingService, setEditingService] = useState<APIService | null>(null);
  const [supportedModels, setSupportedModels] = useState<string[]>([]);
  const [tagInputValue, setTagInputValue] = useState('');
  const [modelLimits, setModelLimits] = useState<Record<string, number>>({});

  // Token超量配置
  const [enableTokenLimit, setEnableTokenLimit] = useState(false);
  const [tokenLimit, setTokenLimit] = useState<number | undefined>(undefined);
  const [tokenResetInterval, setTokenResetInterval] = useState<number | undefined>(undefined);
  const [tokenResetBaseTime, setTokenResetBaseTime] = useState<Date | undefined>(undefined);

  // 请求次数超量配置
  const [enableRequestLimit, setEnableRequestLimit] = useState(false);
  const [requestCountLimit, setRequestCountLimit] = useState<number | undefined>(undefined);
  const [requestResetInterval, setRequestResetInterval] = useState<number | undefined>(undefined);
  const [requestResetBaseTime, setRequestResetBaseTime] = useState<Date | undefined>(undefined);

  // 当前选择的数据源类型（用于动态显示API地址提示）
  const [currentSourceType, setCurrentSourceType] = useState<SourceType>('openai-chat');
  // 当前选择的认证方式（用于动态显示认证方式提示）
  const [currentAuthType, setCurrentAuthType] = useState<AuthType>(AuthType.AUTH_TOKEN);

  // 处理数据源类型变化，自动设置合适的认证方式
  const handleSourceTypeChange = (sourceType: SourceType) => {
    setCurrentSourceType(sourceType);
    let newAuthType: AuthType;

    if (sourceType === 'gemini') {
      newAuthType = AuthType.G_API_KEY;
    } else if (sourceType === 'claude-chat' || sourceType === 'claude-code') {
      newAuthType = AuthType.API_KEY;
    } else {
      newAuthType = AuthType.AUTH_TOKEN;
    }

    setCurrentAuthType(newAuthType);

    // 更新选择器的值
    if (authTypeSelectRef.current) {
      authTypeSelectRef.current.value = newAuthType;
    }
  };

  // 一键配置相关状态
  const [quickSetupVendorKey, setQuickSetupVendorKey] = useState<string>('');
  const [quickSetupSelectedIndices, setQuickSetupSelectedIndices] = useState<number[]>([]);
  const [quickSetupApiKey, setQuickSetupApiKey] = useState('');

  const recommendMd = useRecomandVendors();

  const constantVendors = useMemo(() => {
    const overseaVendors = Object.keys(vendorsConfig).filter(key => vendorsConfig[key].is_oversea).map((key) => ({ ...vendorsConfig[key], key }));
    const insideVendors = Object.keys(vendorsConfig).filter(key => !vendorsConfig[key].is_oversea).map((key) => ({ ...vendorsConfig[key], key }));
    return [
      ...insideVendors,
      null,
      ...overseaVendors,
    ];
  }, []);

  useEffect(() => {
    loadVendors();
  }, []);

  // 移除 useEffect - 服务现在直接从 selectedVendor.services 获取

  // 同步模型列表和模型限制
  useEffect(() => {
    const currentModels = new Set(supportedModels);

    // 移除已从 supportedModels 删除的模型的限制
    const cleanedLimits: Record<string, number> = {};
    Object.entries(modelLimits).forEach(([model, limit]) => {
      if (currentModels.has(model)) {
        cleanedLimits[model] = limit;
      }
    });

    // 应用变更（只移除删除的模型，不自动添加新模型的默认限制）
    const hasRemovedLimits = Object.keys(cleanedLimits).length !== Object.keys(modelLimits).length;

    if (hasRemovedLimits) {
      setModelLimits(cleanedLimits);
    }
  }, [supportedModels]);

  const loadVendors = async () => {
    const data = await api.getVendors();
    setVendors(data);
    if (data.length > 0 && !selectedVendor) {
      setSelectedVendor(data[0]);
    }
    return data;
  };

  // 移除 loadServices 函数 - 服务现在从 selectedVendor.services 获取

  const handleCreateVendor = () => {
    setEditingVendor(null);
    setShowVendorModal(true);
  };

  const handleRecommend = () => {
    setShowRecommendModal(true);
  };

  const handleEditVendor = (vendor: Vendor) => {
    setEditingVendor(vendor);
    setShowVendorModal(true);
  };

  const handleDeleteVendor = async (id: string) => {
    const confirmed = await confirm({
      message: '确定要删除此供应商吗？',
      title: '确认删除',
      type: 'danger',
      confirmText: '删除',
      cancelText: '取消'
    });

    if (confirmed) {
      try {
        await api.deleteVendor(id);
        loadVendors();
        if (selectedVendor && selectedVendor.id === id) {
          setSelectedVendor(null);
        }
        toast.success('供应商已删除');
      } catch (error) {
        // 显示错误信息
        const errorMessage = error instanceof Error ? error.message : '删除失败';
        toast.error(errorMessage);
      }
    }
  };

  const handleSaveVendor = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const vendor = {
      name: formData.get('name') as string,
      description: formData.get('description') as string,
      sortOrder: parseInt(formData.get('sortOrder') as string) || 0,
      services: []
    };

    if (editingVendor) {
      await api.updateVendor(editingVendor.id, vendor);
    } else {
      await api.createVendor(vendor);
    }

    setShowVendorModal(false);
    loadVendors();
  };

  const handleCreateService = () => {
    setEditingService(null);
    setSupportedModels([]);
    setTagInputValue('');
    setModelLimits({});
    // Token超量配置
    setEnableTokenLimit(false);
    setTokenLimit(undefined);
    setTokenResetInterval(undefined);
    setTokenResetBaseTime(undefined);
    // 请求次数超量配置
    setEnableRequestLimit(false);
    setRequestCountLimit(undefined);
    setRequestResetInterval(undefined);
    setRequestResetBaseTime(undefined);
    setCurrentSourceType('openai-chat');
    setCurrentAuthType(AuthType.AUTH_TOKEN);
    setShowServiceModal(true);
  };

  const handleEditService = (service: APIService) => {
    setEditingService(service);
    setSupportedModels(service.supportedModels || []);
    setTagInputValue('');
    setModelLimits(service.modelLimits || {});
    // Token超量配置
    setEnableTokenLimit(service.enableTokenLimit || false);
    setTokenLimit(service.tokenLimit);
    setTokenResetInterval(service.tokenResetInterval);
    setTokenResetBaseTime(
      (service as any).tokenResetBaseTime ? new Date((service as any).tokenResetBaseTime) : undefined
    );
    // 请求次数超量配置
    setEnableRequestLimit(service.enableRequestLimit || false);
    setRequestCountLimit(service.requestCountLimit);
    setRequestResetInterval(service.requestResetInterval);
    setRequestResetBaseTime(
      (service as any).requestResetBaseTime ? new Date((service as any).requestResetBaseTime) : undefined
    );

    const sourceType = service.sourceType || 'openai-chat';
    setCurrentSourceType(sourceType);

    // 如果服务有明确的 authType 且不是 'auto'，使用它；否则根据 sourceType 推导
    if (service.authType) {
      setCurrentAuthType(service.authType);
    } else {
      // 根据 sourceType 自动推导 authType
      let derivedAuthType: AuthType;
      if (sourceType === 'gemini') {
        derivedAuthType = AuthType.G_API_KEY;
      } else if (sourceType === 'claude-chat' || sourceType === 'claude-code') {
        derivedAuthType = AuthType.API_KEY;
      } else {
        derivedAuthType = AuthType.AUTH_TOKEN;
      }
      setCurrentAuthType(derivedAuthType);
    }

    setShowServiceModal(true);
  };



  const handleDeleteService = async (id: string) => {
    const confirmed = await confirm({
      message: '确定要删除此API服务吗？',
      title: '确认删除',
      type: 'danger',
      confirmText: '删除',
      cancelText: '取消'
    });

    if (confirmed) {
      try {
        await api.deleteAPIService(id);
        // 重新加载供应商（服务已自动包含）
        const updatedVendors = await loadVendors();
        if (selectedVendor) {
          // 刷新选中供应商
          const updatedVendor = updatedVendors.find(v => v.id === selectedVendor.id);
          if (updatedVendor) {
            setSelectedVendor(updatedVendor);
          }
        }
        toast.success('API服务已删除');
      } catch (error) {
        // 显示错误信息
        const errorMessage = error instanceof Error ? error.message : '删除失败';
        toast.error(errorMessage);
      }
    }
  };

  const handleSaveService = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    // 处理输入框中未提交的内容
    let finalModels = [...supportedModels];
    if (tagInputValue.trim()) {
      // 按英文逗号分隔,处理多个模型名
      const newTags = tagInputValue
        .split(',')
        .map(tag => tag.trim())
        .filter(tag => tag && !finalModels.includes(tag));

      finalModels = [...finalModels, ...newTags];
    }

    const formData = new FormData(e.currentTarget);

    // 过滤掉值为空的 modelLimits
    const finalModelLimits: Record<string, number> = {};
    Object.entries(modelLimits).forEach(([model, limit]) => {
      if (model && limit && limit > 0) {
        finalModelLimits[model] = limit;
      }
    });

    const service = {
      vendorId: selectedVendor!.id,
      name: formData.get('name') as string,
      apiUrl: formData.get('apiUrl') as string,
      apiKey: formData.get('apiKey') as string,
      sourceType: formData.get('sourceType') as SourceType,
      authType: formData.get('authType') as AuthType || undefined,
      supportedModels: finalModels.length > 0 ? finalModels : undefined,
      modelLimits: Object.keys(finalModelLimits).length > 0 ? finalModelLimits : undefined,
      enableProxy: formData.get('enableProxy') === 'on',
      // Token超量配置
      enableTokenLimit,
      tokenLimit,
      tokenResetInterval,
      tokenResetBaseTime: tokenResetBaseTime ? tokenResetBaseTime.getTime() : undefined,
      // 请求次数超量配置
      enableRequestLimit,
      requestCountLimit,
      requestResetInterval,
      requestResetBaseTime: requestResetBaseTime ? requestResetBaseTime.getTime() : undefined,
    };

    if (editingService) {
      await api.updateAPIService(editingService.id, service);
    } else {
      await api.createAPIService(service);
    }

    setShowServiceModal(false);
    setSupportedModels([]);
    setTagInputValue('');
    setModelLimits({});
    setEnableTokenLimit(false);
    setTokenLimit(undefined);
    setTokenResetInterval(undefined);
    setTokenResetBaseTime(undefined);
    setEnableRequestLimit(false);
    setRequestCountLimit(undefined);
    setRequestResetInterval(undefined);
    setRequestResetBaseTime(undefined);
    // 重新加载供应商（服务已自动包含）
    const updatedVendors = await loadVendors();
    if (selectedVendor) {
      // 刷新选中供应商
      const updatedVendor = updatedVendors.find(v => v.id === selectedVendor.id);
      if (updatedVendor) {
        setSelectedVendor(updatedVendor);
      }
    }
  };

  // 打开一键配置弹层
  const handleQuickSetup = (vendorKey?: string) => {
    if (vendorKey) {
      // 从链接点击进入，自动填充供应商信息
      setQuickSetupVendorKey(vendorKey);
      const vendorConfig = vendorsConfig[vendorKey as keyof typeof vendorsConfig];
      if (vendorConfig && vendorConfig.services.length > 0) {
        // 预选所有可用的服务（使用索引）
        setQuickSetupSelectedIndices(vendorConfig.services.map((_, index) => index));
      }
    } else {
      // 从按钮点击进入，清空表单
      setQuickSetupVendorKey('');
      setQuickSetupSelectedIndices([]);
    }
    setQuickSetupApiKey('');
    setShowQuickSetupModal(true);
  };

  // 处理一键配置提交
  const handleQuickSetupSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);

    const vendorKey = formData.get('vendorKey') as string;
    const apiKey = formData.get('apiKey') as string;

    if (!vendorKey || !apiKey) {
      toast.warning('请填写完整信息');
      return;
    }

    if (quickSetupSelectedIndices.length === 0) {
      toast.warning('请至少选择一个源类型');
      return;
    }

    const vendorConfig = vendorsConfig[vendorKey as keyof typeof vendorsConfig];
    if (!vendorConfig) {
      toast.error('未找到对应的供应商配置');
      return;
    }

    try {
      // 1. 创建供应商
      const vendorResult = await api.createVendor({
        name: vendorConfig.name,
        description: vendorConfig.description,
        sortOrder: 0,  // 添加默认排序值
        services: []
      });

      console.log('[一键配置] 供应商创建成功:', vendorResult);
      console.log('[一键配置] 供应商 ID:', vendorResult?.id);

      if (!vendorResult || !vendorResult.id) {
        console.error('[一键配置] 供应商创建失败或缺少 ID:', vendorResult);
        throw new Error('供应商创建失败，缺少 ID');
      }

      // 2. 批量创建API服务（根据选中的索引）
      const services = vendorConfig.services.filter((_, index) => quickSetupSelectedIndices.includes(index));

      console.log('[一键配置] 准备创建服务:', services.length, '个');
      console.log('[一键配置] vendorId:', vendorResult.id);

      if (services.length === 0) {
        throw new Error('没有选择任何服务');
      }

      const servicePromises = services.map(async (serviceConfig, index) => {
        // 确保 vendorId 被正确传递
        const serviceData = {
          vendorId: vendorResult.id,  // 必须字段
          name: serviceConfig.name,
          apiUrl: serviceConfig.apiUrl,
          apiKey: apiKey,
          sourceType: serviceConfig.sourceType,
          authType: serviceConfig.authType,
          supportedModels: serviceConfig.models ? serviceConfig.models.split(',').map(m => m.trim()) : undefined,
          modelLimits: serviceConfig.modelLimits || {},
        };

        console.log(`[一键配置] 创建服务 ${index + 1}/${services.length}:`, {
          ...serviceData,
          apiKey: '***',  // 隐藏 API Key
        });

        const result = await api.createAPIService(serviceData);
        console.log(`[一键配置] 服务 ${index + 1} 创建成功，ID:`, result.id);

        // 验证返回的服务是否包含 vendorId
        if (!result.vendorId) {
          console.error(`[一键配置] 警告：服务 ${result.id} 缺少 vendorId！`);
        }

        return result;
      });

      const createdServices = await Promise.all(servicePromises);
      console.log('[一键配置] 所有服务创建完成，数量:', createdServices.length);

      // 验证所有创建的服务都有 vendorId
      const servicesWithoutVendorId = createdServices.filter(s => !s.vendorId);
      if (servicesWithoutVendorId.length > 0) {
        console.error('[一键配置] 发现缺少 vendorId 的服务:', servicesWithoutVendorId);
        throw new Error(`有 ${servicesWithoutVendorId.length} 个服务缺少 vendorId`);
      }

      // 3. 刷新列表并选中新建的供应商（含最新 services）
      const updatedVendors = await loadVendors();
      const updatedVendor = updatedVendors.find(v => v.id === vendorResult.id);
      setSelectedVendor(updatedVendor || { ...vendorResult, services: createdServices });
      setShowQuickSetupModal(false);
      toast.success(`配置成功! 已创建 ${quickSetupSelectedIndices.length} 个API服务`);
    } catch (error) {
      console.error('一键配置失败:', error);
      toast.error(`配置失败: ${error instanceof Error ? error.message : '未知错误'}`);
    }
  };

  return (
    <div className='vendors-page'>
      <div className="page-header">
        <h1>供应商管理</h1>
        <p>管理API供应商和服务配置</p>
      </div>

      <div style={{ display: 'flex', gap: '20px' }}>
        <div className="card" style={{ flex: '0 0 25%', minWidth: 400 }}>
          <div className="toolbar">
            <h3>供应商列表</h3>
            <div style={{ display: 'flex', gap: '10px' }}>

              <button
                className="btn btn-secondary"
                style={{
                  background: '#2563EB',
                  color: '#FFFFFF',
                  border: 'none',
                  cursor: 'pointer',
                }}
                onClick={handleRecommend}
              >
                推荐
              </button>
              <button className="btn btn-primary" onClick={() => handleQuickSetup()}>一键配置</button>
              <button className="btn btn-primary" onClick={handleCreateVendor}>新增</button>
            </div>
          </div>
          {vendors.length === 0 ? (
            <div className="empty-state"><p>暂无供应商</p></div>
          ) : (
            <div style={{ marginTop: '10px' }}>
              {vendors.map((vendor) => (
                <div
                  key={vendor.id}
                  onClick={() => setSelectedVendor(vendor)}
                  style={{
                    padding: '12px',
                    marginBottom: '8px',
                    backgroundColor: selectedVendor && selectedVendor.id === vendor.id ? 'var(--accent-light)' : 'var(--bg-secondary)',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    border: `1px solid var(--border-secondary)`,
                    color: 'var(--text-primary)'
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                    <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                      <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{vendor.name}</div>
                      {vendor.description && (
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {vendor.description}
                        </div>
                      )}
                    </div>
                    <div className="action-buttons" style={{ flexShrink: 0 }}>
                      <button
                        className="btn btn-secondary"
                        style={{ padding: '4px 8px', fontSize: '12px' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleEditVendor(vendor);
                        }}
                      >编辑</button>
                      <button
                        className="btn btn-danger"
                        style={{ padding: '4px 8px', fontSize: '12px' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteVendor(vendor.id);
                        }}
                      >删除</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card" style={{ flex: 1 }}>
           <div className="toolbar">
             <h3>供应商{selectedVendor ? `(${selectedVendor.name})` : null}API服务</h3>
             {selectedVendor && (
               <button className="btn btn-primary" onClick={handleCreateService}>新增服务</button>
             )}
           </div>
          {!selectedVendor ? (
            <div className="empty-state"><p>请先选择一个供应商</p></div>
          ) : !selectedVendor.services || selectedVendor.services.length === 0 ? (
            <div className="empty-state"><p>暂无API服务</p></div>
          ) : (
            <table style={{ fontSize: 'smaller' }}>
              <thead>
                <tr>
                  <th style={{ whiteSpace: 'nowrap' }}>服务名称</th>
                  <th>源类型</th>
                  <th>API地址</th>
                  <th>模型</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {selectedVendor.services.map((service) => (
                  <tr key={service.id}>
                    <td>{service.name}</td>
                    <td>{service.sourceType ? SOURCE_TYPE[service.sourceType] : '-'}</td>
                     <td style={{ maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={service.apiUrl}>{service.apiUrl}</td>
                    <td>{service.supportedModels?.length ? `${service.supportedModels.length}个` : '*'}</td>
                    <td>
                      <div className="action-buttons">
                        <button className="btn btn-sm btn-secondary" onClick={() => handleEditService(service)}>编辑</button>
                        <button className="btn btn-sm btn-danger" onClick={() => handleDeleteService(service.id)}>删除</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {showVendorModal && (
        <div className="modal-overlay">
          <button
            type="button"
            className="modal-close-btn"
            onClick={() => setShowVendorModal(false)}
            aria-label="关闭"
          >
            ×
          </button>
          <div className="modal">
            <div className="modal-container">
              <div className="modal-header">
                <h2>{editingVendor ? '编辑供应商' : '新增供应商'}</h2>
              </div>
            <form onSubmit={handleSaveVendor}>
              <div className="form-group">
                <label>供应商名称</label>
                <input type="text" name="name" defaultValue={editingVendor ? editingVendor.name : ''} required />
              </div>
              <div className="form-group">
                <label>描述</label>
                <textarea name="description" rows={3} defaultValue={editingVendor ? editingVendor.description : ''} />
              </div>
              <div className="form-group">
                <label>排序 <small>数值越大越靠前</small></label>
                <input type="number" name="sortOrder" defaultValue={editingVendor ? editingVendor.sortOrder || 0 : 0} min="0" />
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowVendorModal(false)}>取消</button>
                <button type="submit" className="btn btn-primary">保存</button>
              </div>
            </form>
            </div>
          </div>
        </div>
      )}

      {showServiceModal && (
        <div className="modal-overlay">
          <button
            type="button"
            className="modal-close-btn"
            onClick={() => setShowServiceModal(false)}
            aria-label="关闭"
          >
            ×
          </button>
          <div className="modal" style={{ width: 800 }}>
            <div className="modal-container">
              <div className="modal-header">
                <h2>{editingService ? '编辑供应商API服务' : '新增供应商API服务'}</h2>
              </div>
            <form onSubmit={handleSaveService}>
              <div className="form-group">
                <label>服务名称</label>
                <input type="text" name="name" defaultValue={editingService ? editingService.name : ''} required />
              </div>
              <div className="form-group">
                <label>数据源类型 <small>供应商接口返回的数据格式标准类型</small></label>
                <select
                  name="sourceType"
                  defaultValue={editingService ? editingService.sourceType || '' : ''}
                  onChange={(e) => handleSourceTypeChange(e.target.value as SourceType)}
                  required
                >
                  <option value="" disabled>请选择源类型</option>
                  {Object.keys(SOURCE_TYPE).map((type) => (
                    <option key={type} value={type}>{SOURCE_TYPE[type as keyof typeof SOURCE_TYPE]}</option>
                  ))}
                </select>
                <small style={{ display: 'block', marginTop: '4px', color: 'var(--text-muted)' }}>
                  {SOURCE_TYPE_MESSAGE[currentSourceType] || ''}
                </small>
              </div>
              <div className="form-group">
                <label>供应商API地址</label>
                <input type="url" name="apiUrl" defaultValue={editingService ? editingService.apiUrl : ''} required />
              </div>
              <div className="form-group">
                <label>供应商API密钥</label>
                <input type="password" name="apiKey" defaultValue={editingService ? editingService.apiKey : ''} required />
              </div>
              <div className="form-group">
                <label>供应商API认证方式 <small>请在供应商的文档中查阅相关信息</small></label>
                <select
                  ref={authTypeSelectRef}
                  name="authType"
                  defaultValue={editingService ? editingService.authType || AuthType.AUTH_TOKEN : AuthType.AUTH_TOKEN}
                  onChange={(e) => setCurrentAuthType(e.target.value as AuthType)}
                >
                  {Object.keys(AUTH_TYPE).map((type) => (
                    <option key={type} value={type}>{AUTH_TYPE[type as keyof typeof AUTH_TYPE]}</option>
                  ))}
                </select>
                <small style={{ display: 'block', marginTop: '4px', color: 'var(--text-muted)' }}>
                  {AUTH_TYPE_MESSAGE[currentAuthType] || ''}
                </small>
              </div>
               <div className="form-group">
                 <label>支持的模型列表</label>
                  <TagInput
                    key={editingService?.id || 'new'}
                    value={supportedModels}
                    onChange={setSupportedModels}
                    inputValue={tagInputValue}
                    onInputChange={setTagInputValue}
                    placeholder="输入模型名,按Enter或逗号添加"
                  />
                  <div style={{ display:'block', width: '100%' }}>
                    <small style={{fontSize:'10px'}}>留空表示支持所有模型，路由配置中，可直接将模型透传给该供应商服务接口。</small>
                  </div>
               </div>
               <div className="form-group">
                 <label>模型输出限制 <small>为支持的模型配置最大输出tokens</small></label>
                 <div style={{
                   border: '1px solid var(--border-primary)',
                   borderRadius: '8px',
                   padding: '16px',
                   background: 'var(--bg-secondary)',
                   maxHeight: '300px',
                   overflowY: 'auto'
                 }}>
                   {Object.keys(modelLimits).length === 0 && supportedModels.length === 0 ? (
                     <div style={{
                       color: 'var(--text-muted)',
                       textAlign: 'center',
                       padding: '20px',
                       fontSize: '14px'
                     }}>
                       暂无模型限制配置，可点击下方按钮添加
                     </div>
                   ) : (
                     <div>
                       {supportedModels.length > 0 && (
                         <div style={{ marginBottom: '12px' }}>
                           <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px', fontWeight: 500 }}>
                             来自"支持的模型列表"（自动同步）
                           </div>
                           {supportedModels.map((model) => (
                             <div key={`sync-${model}`} style={{
                               display: 'flex',
                               gap: '8px',
                               marginBottom: '8px',
                               alignItems: 'center',
                               padding: '8px',
                               background: 'var(--bg-primary)',
                               borderRadius: '4px',
                               border: '1px solid var(--accent-light)'
                             }}>
                               <div style={{
                                 flex: 2,
                                 fontSize: '14px',
                                 color: 'var(--text-primary)',
                                 fontWeight: 500,
                                 display: 'flex',
                                 alignItems: 'center',
                                 gap: '6px'
                               }}>
                                 {model}
                                 <span style={{
                                   fontSize: '10px',
                                   padding: '2px 6px',
                                   borderRadius: '3px',
                                   background: 'var(--accent-light)',
                                   color: 'var(--accent-primary)'
                                 }}>
                                   已同步
                                 </span>
                               </div>
                               <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '8px' }}>
                                 <input
                                   type="number"
                                   value={modelLimits[model] || ''}
                                   onChange={(e) => {
                                     const value = e.target.value;
                                     if (value === '') {
                                       const newLimits = { ...modelLimits };
                                       delete newLimits[model];
                                       setModelLimits(newLimits);
                                     } else {
                                       setModelLimits({
                                         ...modelLimits,
                                         [model]: parseInt(value) || 0
                                       });
                                     }
                                   }}
                                   placeholder="留空不限"
                                   min="1"
                                   style={{
                                     width: '100%',
                                     padding: '6px 8px',
                                     border: '1px solid var(--border-primary)',
                                     borderRadius: '4px',
                                     fontSize: '14px'
                                   }}
                                 />
                                 <span style={{ fontSize: '12px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                                   tokens
                                 </span>
                               </div>
                               <button
                                 type="button"
                                 className="btn btn-sm btn-secondary"
                                 onClick={() => {
                                   const newLimits = { ...modelLimits };
                                   delete newLimits[model];
                                   setModelLimits(newLimits);
                                 }}
                                 style={{ padding: '4px 8px', fontSize: '12px' }}
                                 title="移除此限制（模型仍在支持列表中）"
                               >
                                 移除限制
                               </button>
                             </div>
                           ))}
                         </div>
                       )}

                       {Object.keys(modelLimits).length > 0 && (
                         <div>
                           {Object.entries(modelLimits)
                             .filter(([model]) => !supportedModels.includes(model))
                             .map(([model, limit]) => (
                               <div key={`custom-${model}`} style={{
                                 display: 'flex',
                                 gap: '8px',
                                 marginBottom: '8px',
                                 alignItems: 'center',
                                 padding: '8px',
                                 background: 'var(--bg-primary)',
                                 borderRadius: '4px',
                                 border: '1px solid var(--border-secondary)'
                               }}>
                                 <input
                                   type="text"
                                   value={model}
                                   onChange={(e) => {
                                     const newLimits = { ...modelLimits };
                                     const newModel = e.target.value;
                                     delete newLimits[model];
                                     newLimits[newModel] = limit;
                                     setModelLimits(newLimits);
                                   }}
                                   placeholder="模型名 (如: gpt-4)"
                                   style={{
                                     flex: 2,
                                     padding: '6px 8px',
                                     border: '1px solid var(--border-primary)',
                                     borderRadius: '4px',
                                     fontSize: '14px'
                                   }}
                                 />
                                 <input
                                   type="number"
                                   value={limit}
                                   onChange={(e) => {
                                     setModelLimits({
                                       ...modelLimits,
                                       [model]: parseInt(e.target.value) || 0
                                     });
                                   }}
                                   placeholder="最大tokens"
                                   min="1"
                                   style={{
                                     flex: 1,
                                     padding: '6px 8px',
                                     border: '1px solid var(--border-primary)',
                                     borderRadius: '4px',
                                     fontSize: '14px'
                                   }}
                                 />
                                 <button
                                   type="button"
                                   className="btn btn-sm btn-danger"
                                   onClick={() => {
                                     const newLimits = { ...modelLimits };
                                     delete newLimits[model];
                                     setModelLimits(newLimits);
                                   }}
                                   style={{ padding: '4px 8px', fontSize: '12px' }}
                                 >
                                   删除
                                 </button>
                               </div>
                             ))}
                         </div>
                       )}
                     </div>
                   )}
                   <button
                     type="button"
                     className="btn btn-sm btn-secondary"
                     onClick={() => {
                       const newModel = `model-${Date.now()}`;
                       setModelLimits({
                         ...modelLimits,
                         [newModel]: 4096
                       });
                     }}
                     style={{ marginTop: '8px', width: '100%' }}
                   >
                     + 添加模型限制
                   </button>
                 </div>
                 <div style={{ display:'block', width: '100%', marginTop: '8px' }}>
                   <small style={{fontSize:'10px'}}>
                     <strong>自动同步：</strong>上方添加的模型会自动在此创建限制配置（默认4096），删除模型会同步移除限制。
                     <strong>手动添加：</strong>可点击下方按钮为特定模型（如 gpt-4）或前缀（如 gpt-4-*）添加限制。
                     留空则透传前端工具发送的值。支持精确匹配和前缀匹配。
                     对于o1等新模型，将自动映射到max_completion_tokens字段。
                   </small>
                 </div>
               </div>

              {/* Token超量配置 */}
              <div className="form-group">
                <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={enableTokenLimit}
                    onChange={(e) => setEnableTokenLimit(e.target.checked)}
                    style={{ marginRight: '8px', cursor: 'pointer', width: '16px', height: '16px' }}
                  />
                  <span>启用Token超量限制</span>
                </label>
              </div>

              {enableTokenLimit && (
                <>
                  <div className="form-group">
                    <label>Token超量值（单位：k）</label>
                    <input
                      type="number"
                      value={tokenLimit || ''}
                      onChange={(e) => setTokenLimit(e.target.value ? parseInt(e.target.value) : undefined)}
                      min="1"
                      placeholder="例如：1000表示1000k tokens"
                    />
                  </div>

                  <div className="form-group">
                    <label>自动重置间隔（小时）</label>
                    <input
                      type="number"
                      value={tokenResetInterval || ''}
                      onChange={(e) => setTokenResetInterval(e.target.value ? parseInt(e.target.value) : undefined)}
                      min="1"
                      placeholder="例如：720表示30天，168表示7天"
                    />
                  </div>

                  <div className="form-group">
                    <label>下一次重置时间基点</label>
                    <input
                      type="datetime-local"
                      value={tokenResetBaseTime ? formatDateTimeLocal(tokenResetBaseTime) : ''}
                      onChange={(e) => {
                        if (e.target.value) {
                          setTokenResetBaseTime(new Date(e.target.value));
                        } else {
                          setTokenResetBaseTime(undefined);
                        }
                      }}
                      className="datetime-picker-input"
                    />
                    <small style={{ color: '#666', fontSize: '12px', marginTop: '4px', display: 'block' }}>
                      设置下一次重置的精确时间点
                    </small>
                  </div>
                </>
              )}

              {/* 请求次数超量配置 */}
              <div className="form-group">
                <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={enableRequestLimit}
                    onChange={(e) => setEnableRequestLimit(e.target.checked)}
                    style={{ marginRight: '8px', cursor: 'pointer', width: '16px', height: '16px' }}
                  />
                  <span>启用请求次数超量限制</span>
                </label>
              </div>

              {enableRequestLimit && (
                <>
                  <div className="form-group">
                    <label>请求次数超量值</label>
                    <input
                      type="number"
                      value={requestCountLimit || ''}
                      onChange={(e) => setRequestCountLimit(e.target.value ? parseInt(e.target.value) : undefined)}
                      min="1"
                      placeholder="例如：100"
                    />
                  </div>

                  <div className="form-group">
                    <label>自动重置间隔（小时）</label>
                    <input
                      type="number"
                      value={requestResetInterval || ''}
                      onChange={(e) => setRequestResetInterval(e.target.value ? parseInt(e.target.value) : undefined)}
                      min="1"
                      placeholder="例如：720表示30天，168表示7天"
                    />
                  </div>

                  <div className="form-group">
                    <label>下一次重置时间基点</label>
                    <input
                      type="datetime-local"
                      value={requestResetBaseTime ? formatDateTimeLocal(requestResetBaseTime) : ''}
                      onChange={(e) => {
                        if (e.target.value) {
                          setRequestResetBaseTime(new Date(e.target.value));
                        } else {
                          setRequestResetBaseTime(undefined);
                        }
                      }}
                      className="datetime-picker-input"
                    />
                    <small style={{ color: '#666', fontSize: '12px', marginTop: '4px', display: 'block' }}>
                      设置下一次重置的精确时间点
                    </small>
                  </div>
                </>
              )}

              <div className="form-group">
                <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    name="enableProxy"
                    defaultChecked={editingService?.enableProxy || false}
                    style={{ marginRight: '8px', cursor: 'pointer', width: '16px', height: '16px' }}
                  />
                  <span>启用代理</span>
                </label>
                <small style={{ display: 'block', marginTop: '6px', color: '#666', fontSize: '12px', marginLeft: '24px' }}>
                  勾选后，此 API 服务的请求将通过设置的代理转发。请在"设置"页面配置代理。
                </small>
              </div>

               <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowServiceModal(false)}>取消</button>
                <button type="submit" className="btn btn-primary">保存</button>
              </div>
            </form>
            </div>
          </div>
        </div>
      )}

      {showRecommendModal && (
        <div className="modal-overlay">
          <button
            type="button"
            className="modal-close-btn"
            onClick={() => setShowRecommendModal(false)}
            aria-label="关闭"
          >
            ×
          </button>
          <div className="modal" style={{ maxWidth: '800px' }}>
            <div className="modal-container">
              <div className="modal-header">
                <h2>供应商推荐</h2>
              </div>
            <div className="modal-body">
              <div className="markdown-content">
                <ReactMarkdown
                  components={{
                    a: ({ href, children, title }) => {
                      // 检查是否有特殊标记(通过title属性)
                      if (title && vendorsConfig[title as keyof typeof vendorsConfig]) {
                        return (
                          <a
                            href="#"
                            style={{
                              color: '#2563EB',
                              borderBottom: 'solid 1px #2563EB',
                              cursor: 'pointer'
                            }}
                            onClick={(e) => {
                              e.preventDefault();
                              setShowRecommendModal(false);
                              handleQuickSetup(title);
                            }}
                          >
                            {children}
                          </a>
                        );
                      }
                      // 普通链接
                      return (
                        <a
                          href={href}
                          style={{
                            color: '#2563EB',
                            borderBottom: 'solid 1px #2563EB'
                          }}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {children}
                        </a>
                      );
                    }
                  }}
                >
                  {recommendMd}
                </ReactMarkdown>
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={() => setShowRecommendModal(false)}>关闭</button>
            </div>
            </div>
          </div>
        </div>
      )}

      {showQuickSetupModal && (
        <div className="modal-overlay">
          <button
            type="button"
            className="modal-close-btn"
            onClick={() => setShowQuickSetupModal(false)}
            aria-label="关闭"
          >
            ×
          </button>
          <div className="modal">
            <div className="modal-container">
              <div className="modal-header">
                <h2>一键配置供应商</h2>
              </div>
            <form onSubmit={handleQuickSetupSubmit}>
              <div className="form-group">
                <label>供应商</label>
                <select
                  name="vendorKey"
                  value={quickSetupVendorKey}
                  onChange={(e) => {
                    const key = e.target.value;
                    setQuickSetupVendorKey(key);
                    // 自动选择所有可用的服务（使用索引）
                    if (key) {
                      const vendorConfig = vendorsConfig[key as keyof typeof vendorsConfig];
                      if (vendorConfig && vendorConfig.services.length > 0) {
                        setQuickSetupSelectedIndices(vendorConfig.services.map((_, index) => index));
                      }
                    } else {
                      setQuickSetupSelectedIndices([]);
                    }
                  }}
                  required
                >
                  <option value="" disabled>请选择供应商</option>
                  {constantVendors.map((vendor: any) => vendor ? (
                    <option key={vendor.key} value={vendor.key}>{vendor.name}</option>
                  ) : (<option value="" disabled>--</option>))}
                </select>
              </div>
              {vendorsConfig[quickSetupVendorKey]?.description ? (
                <div style={{fontSize:'.8em',marginBottom:16,marginTop:-16}}>{vendorsConfig[quickSetupVendorKey].description}</div>
              ) : null}
              <div className="form-group">
                <label>源类型 <small style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>可选择多个</small></label>
                <div style={{
                  border: '1px solid var(--border-primary)',
                  borderRadius: '8px',
                  padding: '16px',
                  background: 'var(--bg-secondary)',
                  minHeight: '100px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px'
                }}>
                  {quickSetupVendorKey ? (
                    vendorsConfig[quickSetupVendorKey as keyof typeof vendorsConfig]?.services.map((service, index) => {
                      const isChecked = quickSetupSelectedIndices.includes(index);
                      return (
                        <label
                          key={index}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            cursor: 'pointer',
                            padding: '10px 14px',
                            borderRadius: '6px',
                            background: isChecked ? 'var(--accent-light)' : 'transparent',
                            border: `2px solid ${isChecked ? 'var(--accent-primary)' : 'transparent'}`,
                            transition: 'all 0.2s ease',
                            position: 'relative',
                            overflow: 'hidden'
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
                            type="checkbox"
                            checked={isChecked}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setQuickSetupSelectedIndices([...quickSetupSelectedIndices, index]);
                              } else {
                                setQuickSetupSelectedIndices(quickSetupSelectedIndices.filter(i => i !== index));
                              }
                            }}
                            style={{
                              width: '18px',
                              height: '18px',
                              marginRight: '12px',
                              cursor: 'pointer',
                              accentColor: 'var(--accent-primary)'
                            }}
                          />
                          <span style={{
                            fontSize: '14px',
                            fontWeight: isChecked ? '600' : '400',
                            color: 'var(--text-primary)',
                            transition: 'all 0.2s ease'
                          }}>
                            {service.name} - {SOURCE_TYPE[service.sourceType as keyof typeof SOURCE_TYPE]}
                          </span>
                          {isChecked && (
                            <span style={{
                              marginLeft: 'auto',
                              fontSize: '16px',
                              color: 'var(--text-primary)'
                            }}>✓</span>
                          )}
                        </label>
                      );
                    })
                  ) : (
                    <div style={{
                      color: 'var(--text-muted)',
                      textAlign: 'center',
                      padding: '30px 20px',
                      fontSize: '14px'
                    }}>
                      请先选择供应商
                    </div>
                  )}
                </div>
              </div>
              <div className="form-group">
                <label>API Key</label>
                <input
                  type="password"
                  name="apiKey"
                  value={quickSetupApiKey}
                  onChange={(e) => setQuickSetupApiKey(e.target.value)}
                  placeholder="请输入API密钥"
                  required
                />
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowQuickSetupModal(false)}>取消</button>
                <button type="submit" className="btn btn-primary">确认配置</button>
              </div>
            </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default VendorsPage;
