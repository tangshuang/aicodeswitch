import { useState, useEffect } from 'react';
import { api } from '../api/client';
import type { AppConfig, ImportPreview } from '../../types';
import { toast } from '../components/Toast';
import { Switch } from '../components/Switch';

function SettingsPage() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [password, setPassword] = useState('');
  const [importData, setImportData] = useState('');
  const [exportedData, setExportedData] = useState('');
  const [proxyFormData, setProxyFormData] = useState({
    proxyEnabled: false,
    proxyUrl: '',
    proxyUsername: '',
    proxyPassword: '',
  });

  // 导入预览状态
  const [previewData, setPreviewData] = useState<ImportPreview | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    const data = await api.getConfig();
    setConfig(data);
    setProxyFormData({
      proxyEnabled: data.proxyEnabled || false,
      proxyUrl: data.proxyUrl || '',
      proxyUsername: data.proxyUsername || '',
      proxyPassword: data.proxyPassword || '',
    });
  };

  const handleSaveConfig = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const newConfig: AppConfig = {
      ...config, // 保留现有配置
      apiKey: formData.get('apiKey') as string,
      enableFailover: formData.get('enableFailover') === 'true',
    };

    const success = await api.updateConfig(newConfig);
    if (success) {
      toast.success('配置保存成功');
      loadConfig();
    } else {
      toast.error('配置保存失败');
    }
  };

  const handleSaveLogConfig = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const newConfig: AppConfig = {
      ...config, // 保留现有配置
      enableLogging: formData.get('enableLogging') === 'true',
      logRetentionDays: parseInt(formData.get('logRetentionDays') as string),
      maxLogSize: parseInt(formData.get('maxLogSize') as string),
    };

    const success = await api.updateConfig(newConfig);
    if (success) {
      toast.success('日志配置保存成功');
      loadConfig();
    } else {
      toast.error('日志配置保存失败');
    }
  };

  const handleSaveProxyConfig = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const newConfig: AppConfig = {
      ...config, // 保留现有配置
      proxyEnabled: formData.get('proxyEnabled') === 'true',
      proxyUrl: formData.get('proxyUrl') as string,
      proxyUsername: formData.get('proxyUsername') as string,
      proxyPassword: formData.get('proxyPassword') as string,
    };

    const success = await api.updateConfig(newConfig);
    if (success) {
      toast.success('代理配置保存成功');
      loadConfig();
    } else {
      toast.error('代理配置保存失败');
    }
  };

  const handleExport = async () => {
    if (!password) {
      toast.warning('请输入密码');
      return;
    }

    try {
      const data = await api.exportData(password);
      setExportedData(data);
      toast.success('导出成功,请复制下方数据');
    } catch (error: any) {
      toast.error('导出失败: ' + error.message);
    }
  };

  // 预览导入数据
  const handlePreview = async () => {
    if (!password || !importData) {
      toast.warning('请输入密码和导入数据');
      return;
    }

    setIsPreviewing(true);
    try {
      const result = await api.previewImportData(importData, password);
      setPreviewData(result);
      if (!result.success) {
        toast.error(result.message || '预览失败');
      }
    } catch (error: any) {
      toast.error('预览失败: ' + error.message);
      setPreviewData({ success: false, message: error.message });
    } finally {
      setIsPreviewing(false);
    }
  };

  // 执行导入
  const handleImport = async () => {
    if (!password || !importData || !previewData?.success) {
      toast.warning('请先预览数据并确认无误');
      return;
    }

    setIsImporting(true);
    try {
      const result = await api.importData(importData, password);
      if (result.success) {
        toast.success(result.message + (result.details ? ` (${result.details})` : ''));
        // 重置状态
        setImportData('');
        setPassword('');
        setPreviewData(null);
      } else {
        toast.error(result.message + (result.details ? `: ${result.details}` : ''));
      }
    } catch (error: any) {
      toast.error('导入失败: ' + error.message);
    } finally {
      setIsImporting(false);
    }
  };

  // 取消预览/导入
  const handleCancelImport = () => {
    setPreviewData(null);
    setImportData('');
    setPassword('');
  };

  if (!config) {
    return <div>加载中...</div>;
  }

  return (
    <div>
      <div className="page-header">
        <h1>设置</h1>
        <p>管理应用配置和数据导入导出</p>
      </div>

      <div className="card">
        <h3>应用配置</h3>
        <form onSubmit={handleSaveConfig}>

           <div className="form-group">
             <label>API Key</label>
             <input
               type="password"
               name="apiKey"
               defaultValue={config.apiKey}
             />
             <small style={{ display: 'block', marginTop: '4px', color: '#666', fontSize: '12px' }}>
              当编程工具连接到aicodeswitch时，需要使用此API Key进行认证
            </small>
           </div>
          <div className="form-group">
            <label>启用智能故障切换</label>
            <select name="enableFailover" defaultValue={config.enableFailover !== false ? 'true' : 'false'}>
              <option value="true">是</option>
              <option value="false">否</option>
            </select>
            <small style={{ display: 'block', marginTop: '4px', color: '#666', fontSize: '12px' }}>
              启用后,当某个服务报错时会自动切换到备用服务,并将报错服务标记为不可用10分钟
            </small>
          </div>
           <button type="submit" className="btn btn-primary">保存配置</button>
        </form>
      </div>

      <div className="card" style={{ marginTop: '20px' }}>
        <h3>日志设置</h3>
        <p style={{ color: '#7f8c8d', fontSize: '14px' }}>
          配置请求日志的记录和保留策略。
        </p>
        <form onSubmit={handleSaveLogConfig}>
          <div className="form-group">
            <label>启用日志</label>
            <select name="enableLogging" defaultValue={config.enableLogging ? 'true' : 'false'}>
              <option value="true">是</option>
              <option value="false">否</option>
            </select>
          </div>
          <div className="form-group">
            <label>日志保留天数</label>
            <input
              type="number"
              name="logRetentionDays"
              defaultValue={config.logRetentionDays}
              required
            />
          </div>
          <div className="form-group">
            <label>最大日志数量</label>
            <input
              type="number"
              name="maxLogSize"
              defaultValue={config.maxLogSize}
              required
            />
          </div>
          <button type="submit" className="btn btn-primary">保存日志配置</button>
        </form>
      </div>

      <div className="card" style={{ marginTop: '20px' }}>
        <h3>代理设置</h3>
        <p style={{ color: '#7f8c8d', fontSize: '14px' }}>
          配置代理服务器，API 服务可选择是否通过代理转发请求。
        </p>
        <form onSubmit={handleSaveProxyConfig}>
          <input type="hidden" name="proxyEnabled" value={proxyFormData.proxyEnabled ? 'true' : 'false'} />
          <div className="form-group">
            <label>启用代理</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <Switch
                checked={proxyFormData.proxyEnabled}
                onChange={(checked) => setProxyFormData(prev => ({ ...prev, proxyEnabled: checked }))}
              />
              <span style={{ fontSize: '14px', color: '#666' }}>
                {proxyFormData.proxyEnabled ? '已启用' : '未启用'}
              </span>
            </div>
          </div>
          <div className="form-group">
            <label>代理地址</label>
            <input
              type="text"
              name="proxyUrl"
              value={proxyFormData.proxyUrl}
              onChange={(e) => setProxyFormData(prev => ({ ...prev, proxyUrl: e.target.value }))}
              placeholder="例如: proxy.example.com:8080 或 http://proxy.example.com:8080"
            />
          </div>
          <div className="form-group">
            <label>代理用户名（可选）</label>
            <input
              type="text"
              name="proxyUsername"
              value={proxyFormData.proxyUsername}
              onChange={(e) => setProxyFormData(prev => ({ ...prev, proxyUsername: e.target.value }))}
              placeholder="如果代理需要认证"
            />
          </div>
          <div className="form-group">
            <label>代理密码（可选）</label>
            <input
              type="password"
              name="proxyPassword"
              value={proxyFormData.proxyPassword}
              onChange={(e) => setProxyFormData(prev => ({ ...prev, proxyPassword: e.target.value }))}
              placeholder="如果代理需要认证"
            />
          </div>
          <button type="submit" className="btn btn-primary">保存代理配置</button>
        </form>
      </div>

      <div className="card" style={{ marginTop: '20px' }}>
        <h3>数据导出</h3>
        <p style={{ color: '#7f8c8d', fontSize: '14px' }}>
          导出所有配置数据，包括供应商、API服务、路由等。数据将使用密码加密。
        </p>
        <div className="form-group">
          <label>加密密码</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="用于加密导出数据"
          />
        </div>
        <button className="btn btn-primary" onClick={handleExport}>导出数据</button>

        {exportedData && (
          <div className="form-group" style={{ marginTop: '20px' }}>
            <label>导出的数据(请复制保存)</label>
            <textarea
              rows={6}
              value={exportedData}
              readOnly
              style={{ fontFamily: 'monospace', fontSize: '12px' }}
            />
            <button
              className="btn btn-secondary"
              style={{ marginTop: '10px' }}
              onClick={() => {
                navigator.clipboard.writeText(exportedData);
                toast.success('已复制到剪贴板');
              }}
            >
              复制到剪贴板
            </button>
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: '20px' }}>
        <h3>数据导入</h3>
        <p style={{ color: '#e74c3c', fontSize: '14px', fontWeight: 500 }}>
          警告:导入数据将覆盖所有现有配置！请确保已备份重要数据。
        </p>

        {!previewData?.success ? (
          // 第一步：输入密码和数据，进行预览
          <>
            <div className="form-group">
              <label>解密密码</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="用于解密导入数据"
              />
            </div>
            <div className="form-group">
              <label>导入数据</label>
              <textarea
                rows={6}
                value={importData}
                onChange={(e) => setImportData(e.target.value)}
                placeholder="粘贴导出的加密数据"
                style={{ fontFamily: 'monospace', fontSize: '12px' }}
              />
            </div>
            <button
              className="btn btn-primary"
              onClick={handlePreview}
              disabled={isPreviewing || !password || !importData}
            >
              {isPreviewing ? '预览中...' : '预览数据'}
            </button>
            {previewData?.success === false && (
              <div style={{ marginTop: '10px', padding: '10px', backgroundColor: '#fdeaea', borderRadius: '4px', color: '#e74c3c' }}>
                <strong>预览失败：</strong>{previewData.message}
              </div>
            )}
          </>
        ) : (
          // 第二步：显示预览结果，等待确认
          <>
            <div style={{
              marginTop: '15px',
              padding: '15px',
              backgroundColor: '#e8f4fd',
              borderRadius: '6px',
              border: '1px solid #bee5eb'
            }}>
              <h4 style={{ margin: '0 0 12px 0', color: '#0c5460', fontSize: '16px' }}>
                数据预览
              </h4>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '10px', marginBottom: '12px' }}>
                <div style={{ padding: '10px', backgroundColor: 'white', borderRadius: '4px' }}>
                  <div style={{ fontSize: '12px', color: '#666' }}>供应商</div>
                  <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#333' }}>{previewData.data?.vendors || 0}</div>
                </div>
                <div style={{ padding: '10px', backgroundColor: 'white', borderRadius: '4px' }}>
                  <div style={{ fontSize: '12px', color: '#666' }}>API服务</div>
                  <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#333' }}>{previewData.data?.services || 0}</div>
                </div>
                <div style={{ padding: '10px', backgroundColor: 'white', borderRadius: '4px' }}>
                  <div style={{ fontSize: '12px', color: '#666' }}>路由</div>
                  <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#333' }}>{previewData.data?.routes || 0}</div>
                </div>
                <div style={{ padding: '10px', backgroundColor: 'white', borderRadius: '4px' }}>
                  <div style={{ fontSize: '12px', color: '#666' }}>规则</div>
                  <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#333' }}>{previewData.data?.rules || 0}</div>
                </div>
              </div>
              <div style={{ fontSize: '12px', color: '#666', marginTop: '8px' }}>
                <div>数据版本: {previewData.data?.version}</div>
                <div>导出时间: {previewData.data?.exportDate ? new Date(previewData.data.exportDate).toLocaleString('zh-CN') : '-'}</div>
              </div>
            </div>

            <div style={{
              marginTop: '15px',
              padding: '12px',
              backgroundColor: '#fff3cd',
              borderRadius: '4px',
              border: '1px solid #ffeaa7',
              color: '#856404'
            }}>
              <strong>确认导入？</strong> 此操作将覆盖所有现有的供应商、服务、路由和规则配置，且无法撤销。
            </div>

            <div style={{ marginTop: '15px', display: 'flex', gap: '10px' }}>
              <button
                className="btn btn-danger"
                onClick={handleImport}
                disabled={isImporting}
              >
                {isImporting ? '导入中...' : '确认导入'}
              </button>
              <button
                className="btn btn-secondary"
                onClick={handleCancelImport}
                disabled={isImporting}
              >
                取消
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default SettingsPage;
