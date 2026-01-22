import { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { api } from '../api/client';
import type { Vendor, APIService, SourceType } from '../../types';
import recommendMd from '../docs/vendors-recommand.md?raw';

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

const SOURCE_TYPE = {
  'openai-chat': 'OpenAI Chat',
  'openai-code': 'OpenAI Code',
  'openai-responses': 'OpenAI Responses',
  'claude-chat': 'Claude Chat',
  'claude-code': 'Claude Code',
  'deepseek-chat': 'DeepSeek Chat',
};

function VendorsPage() {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [services, setServices] = useState<APIService[]>([]);
  const [selectedVendor, setSelectedVendor] = useState<Vendor | null>(null);
  const [showVendorModal, setShowVendorModal] = useState(false);
  const [showServiceModal, setShowServiceModal] = useState(false);
  const [showRecommendModal, setShowRecommendModal] = useState(false);
  const [editingVendor, setEditingVendor] = useState<Vendor | null>(null);
  const [editingService, setEditingService] = useState<APIService | null>(null);
  const [supportedModels, setSupportedModels] = useState<string[]>([]);
  const [tagInputValue, setTagInputValue] = useState('');

  useEffect(() => {
    loadVendors();
  }, []);

  useEffect(() => {
    if (selectedVendor) {
      loadServices(selectedVendor.id);
    }
  }, [selectedVendor]);

  const loadVendors = async () => {
    const data = await api.getVendors();
    setVendors(data);
    if (data.length > 0 && !selectedVendor) {
      setSelectedVendor(data[0]);
    }
  };

  const loadServices = async (vendorId: string) => {
    const data = await api.getAPIServices(vendorId);
    setServices(data);
  };

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
    if (confirm('确定要删除此供应商吗')) {
      await api.deleteVendor(id);
      loadVendors();
      if (selectedVendor && selectedVendor.id === id) {
        setSelectedVendor(null);
        setServices([]);
      }
    }
  };

  const handleSaveVendor = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const vendor = {
      name: formData.get('name') as string,
      description: formData.get('description') as string,
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
    setShowServiceModal(true);
  };

  const handleEditService = (service: APIService) => {
    setEditingService(service);
    setSupportedModels(service.supportedModels || []);
    setTagInputValue('');
    setShowServiceModal(true);
  };



  const handleDeleteService = async (id: string) => {
    if (confirm('确定要删除此API服务吗')) {
      await api.deleteAPIService(id);
      if (selectedVendor) {
        loadServices(selectedVendor.id);
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

    const service = {
      vendorId: selectedVendor!.id,
      name: formData.get('name') as string,
      apiUrl: formData.get('apiUrl') as string,
      apiKey: formData.get('apiKey') as string,
      timeout: parseInt(formData.get('timeout') as string) || 30000,
      sourceType: formData.get('sourceType') as SourceType,
      supportedModels: finalModels.length > 0 ? finalModels : undefined,
    };

    if (editingService) {
      await api.updateAPIService(editingService.id, service);
    } else {
      await api.createAPIService(service);
    }

    setShowServiceModal(false);
    setSupportedModels([]);
    setTagInputValue('');
    if (selectedVendor) {
      loadServices(selectedVendor.id);
    }
  };

  return (
    <div>
      <div className="page-header">
        <h1>供应商管理</h1>
        <p>管理API供应商和服务配置</p>
      </div>

      <div style={{ display: 'flex', gap: '20px' }}>
        <div className="card" style={{ flex: '0 0 33%' }}>
          <div className="toolbar">
            <h3>供应商列表</h3>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                className="btn btn-secondary"
                style={{
                  background: 'linear-gradient(135deg, #2563EB 0%, #F97316 100%)',
                  color: '#FFFFFF',
                  boxShadow: '0 4px 12px rgba(37, 99, 235, 0.3)',
                  border: 'none',
                  transition: 'all 0.3s ease',
                  cursor: 'pointer',
                  fontWeight: '600',
                  letterSpacing: '0.5px'
                }}
                onClick={handleRecommend}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = 'translateY(-2px)';
                  e.currentTarget.style.boxShadow = '0 8px 20px rgba(37, 99, 235, 0.4)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = '0 4px 12px rgba(37, 99, 235, 0.3)';
                }}
                onFocus={(e) => {
                  e.currentTarget.style.outline = '2px solid #2563EB';
                  e.currentTarget.style.outlineOffset = '2px';
                }}
                onBlur={(e) => {
                  e.currentTarget.style.outline = 'none';
                }}
              >
                推荐
              </button>
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
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <div>
                      <div style={{ fontWeight: 500 }}>{vendor.name}</div>
                      {vendor.description && (
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                          {vendor.description}
                        </div>
                      )}
                    </div>
                    <div className="action-buttons">
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
             <h3>供应商API服务{selectedVendor && ` - ${selectedVendor.name}`}</h3>
             {selectedVendor && (
               <button className="btn btn-primary" onClick={handleCreateService}>新增服务</button>
             )}
           </div>
          {!selectedVendor ? (
            <div className="empty-state"><p>请先选择一个供应商</p></div>
          ) : services.length === 0 ? (
            <div className="empty-state"><p>暂无API服务</p></div>
          ) : (
            <table style={{ fontSize: 'smaller' }}>
              <thead>
                <tr>
                  <th style={{ whiteSpace: 'nowrap' }}>服务名称</th>
                  <th>源类型</th>
                  <th>API地址</th>
                  <th>模型列表</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {services.map((service) => (
                  <tr key={service.id}>
                    <td>{service.name}</td>
                    <td>{service.sourceType ? SOURCE_TYPE[service.sourceType] : '-'}</td>
                     <td style={{ maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={service.apiUrl}>{service.apiUrl}</td>
                    <td>{service.supportedModels?.join(', ') || '*'}</td>
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
          <div className="modal" onClick={(e) => e.stopPropagation()}>
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
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowVendorModal(false)}>取消</button>
                <button type="submit" className="btn btn-primary">保存</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showServiceModal && (
        <div className="modal-overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{editingService ? '编辑供应商API服务' : '新增供应商API服务'}</h2>
            </div>
            <form onSubmit={handleSaveService}>
              <div className="form-group">
                <label>服务名称</label>
                <input type="text" name="name" defaultValue={editingService ? editingService.name : ''} required />
              </div>
              <div className="form-group">
                <label>源类型 <small>供应商接口返回的数据格式标准类型</small></label>
                <select name="sourceType" defaultValue={editingService ? editingService.sourceType || '' : ''} required>
                  <option value="">请选择源类型</option>
                  <option value="openai-chat">OpenAI Chat</option>
                  <option value="openai-code">OpenAI Code</option>
                  <option value="openai-responses">OpenAI Responses</option>
                  <option value="claude-chat">Claude Chat</option>
                  <option value="claude-code">Claude Code</option>
                  <option value="deepseek-chat">DeepSeek Chat</option>
                </select>
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
                 <label>超时时间(ms)</label>
                 <input type="number" name="timeout" defaultValue={editingService ? editingService.timeout : 30000} />
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
               <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setShowServiceModal(false)}>取消</button>
                <button type="submit" className="btn btn-primary">保存</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showRecommendModal && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: '800px' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>供应商推荐</h2>
            </div>
            <div className="modal-body">
              <div className="markdown-content">
                <ReactMarkdown
                  components={{
                    a: ({ href, children }) => (
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
                    )
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
      )}
    </div>
  );
}

export default VendorsPage;
