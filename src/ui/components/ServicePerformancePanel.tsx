import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import type {
  PerfVendorOverview,
  PerfVendorDetail,
  PerfServiceDetail,
  PerfModelDetail,
  PerfTrendPoint,
} from '../../types';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

type Metric = 'ttft' | 'tpm';
type Level = 'vendors' | 'vendor' | 'service' | 'model';

const cardStyle: React.CSSProperties = {
  background: 'var(--bg-card)',
  borderRadius: '16px',
  border: '1px solid var(--border-primary)',
  padding: '20px',
  marginTop: '24px',
};

const tableBtn: React.CSSProperties = {
  padding: '6px 12px',
  borderRadius: '8px',
  border: '1px solid var(--border-primary)',
  background: 'var(--bg-secondary)',
  color: 'var(--text-primary)',
  cursor: 'pointer',
  fontSize: '13px',
};

const selectStyle: React.CSSProperties = {
  padding: '6px 12px',
  borderRadius: '8px',
  border: '1px solid var(--border-primary)',
  background: 'var(--bg-card)',
  color: 'var(--text-primary)',
  fontSize: '13px',
};

function formatMs(ms: number): string {
  if (!ms) return '-';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

function formatNum(n: number): string {
  return Math.round(n).toLocaleString();
}

function formatPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

/** 截取最近 N 个小时桶 */
function sliceTrend(trend: PerfTrendPoint[], hours: number): PerfTrendPoint[] {
  if (!trend) return [];
  return trend.slice(-hours);
}

export default function ServicePerformancePanel() {
  const [metric, setMetric] = useState<Metric>('ttft');
  const [hours, setHours] = useState(24);
  const [level, setLevel] = useState<Level>('vendors');

  const [vendorId, setVendorId] = useState<string | null>(null);
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);

  const [vendors, setVendors] = useState<PerfVendorOverview[]>([]);
  const [vendorDetail, setVendorDetail] = useState<PerfVendorDetail | null>(null);
  const [serviceDetail, setServiceDetail] = useState<PerfServiceDetail | null>(null);
  const [modelDetail, setModelDetail] = useState<PerfModelDetail | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (level === 'vendors') {
        const data = await api.getPerformanceVendors();
        setVendors(data || []);
      } else if (level === 'vendor' && vendorId) {
        const data = await api.getPerformanceVendor(vendorId);
        setVendorDetail(data);
      } else if (level === 'service' && serviceId) {
        const data = await api.getPerformanceService(serviceId);
        setServiceDetail(data);
      } else if (level === 'model' && serviceId && model) {
        const data = await api.getPerformanceModel(serviceId, model);
        setModelDetail(data);
      }
    } catch (e: any) {
      setError(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [level, vendorId, serviceId, model]);

  useEffect(() => {
    load();
  }, [load]);

  // 当前层级的走势数据
  const trend: PerfTrendPoint[] = (() => {
    if (level === 'vendor') return vendorDetail?.hourly || [];
    if (level === 'service') return serviceDetail?.hourly || [];
    if (level === 'model') return modelDetail?.hourly || [];
    return [];
  })();
  const slicedTrend = sliceTrend(trend, hours);
  const chartData = slicedTrend.map(p => ({
    hour: p.hour.slice(11), // 仅显示 HH
    [metric === 'ttft' ? 'avgTtftMs' : 'avgTpm']: metric === 'ttft' ? p.avgTtftMs : p.avgTpm,
  }));

  const goVendor = (vid: string) => {
    setVendorId(vid); setServiceId(null); setModel(null);
    setVendorDetail(null); setServiceDetail(null); setModelDetail(null);
    setLevel('vendor');
  };
  const goService = (sid: string) => {
    setServiceId(sid); setModel(null);
    setServiceDetail(null); setModelDetail(null);
    setLevel('service');
  };
  const goModel = (m: string) => {
    setModel(m); setModelDetail(null);
    setLevel('model');
  };
  const backToVendors = () => {
    setVendorId(null); setServiceId(null); setModel(null);
    setLevel('vendors');
  };

  const metricLabel = metric === 'ttft' ? '首 Token 返回时间' : '吞吐 TPM';
  const valueField = metric === 'ttft' ? 'avgTtftMs' : 'avgTpm';

  // 通用表格行渲染
  const renderDerived = (d: any) => (
    <>
      <td style={cell}>{formatMs(d.avgTtftMs)}</td>
      <td style={cell}>{d.count > 0 ? formatNum(d.avgTpm) : '-'}</td>
      <td style={cell}>{d.count}</td>
      <td style={cell}>{formatPct(d.successRate)}</td>
    </>
  );

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
        <h3 style={{ margin: 0, fontSize: '18px', color: 'var(--text-primary)' }}>
          ⚡ 服务性能 / 测速统计
        </h3>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {/* 面包屑 */}
          <button style={tableBtn} onClick={backToVendors} disabled={level === 'vendors'}>
            全部供应商
          </button>
          {vendorDetail && <span style={{ color: 'var(--text-muted)' }}>› {vendorDetail.vendorName || vendorId}</span>}
          {serviceDetail && <span style={{ color: 'var(--text-muted)' }}>› {serviceDetail.serviceName || serviceId}</span>}
          {model && <span style={{ color: 'var(--text-muted)' }}>› {model}</span>}
        </div>
      </div>

      <p style={{ margin: '0 0 16px 0', color: 'var(--text-muted)', fontSize: '13px' }}>
        全局统计，与认证模式无关。首 Token 返回时间 = 请求发起到首个 token 的延迟；TPM = 生成阶段每分钟吐出的 token 数（基于真实流量被动采集）。
      </p>

      {/* 筛选器 */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <label style={{ color: 'var(--text-muted)', fontSize: '13px' }}>指标:</label>
          <select style={selectStyle} value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
            <option value="ttft">首 Token 返回时间</option>
            <option value="tpm">吞吐 TPM</option>
          </select>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <label style={{ color: 'var(--text-muted)', fontSize: '13px' }}>时段:</label>
          <select style={selectStyle} value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            <option value={24}>近 24 小时</option>
            <option value={168}>近 7 天</option>
            <option value={720}>近 30 天</option>
          </select>
        </div>
        <button style={tableBtn} onClick={load}>🔄 刷新</button>
      </div>

      {error && <div style={{ color: '#e74c3c', marginBottom: '12px' }}>{error}</div>}

      {/* 对比表 */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <thead>
            <tr>
              <th style={th}>{level === 'vendors' ? '供应商' : level === 'vendor' ? 'API 服务' : '模型'}</th>
              <th style={th}>平均首Token</th>
              <th style={th}>平均 TPM</th>
              <th style={th}>样本数</th>
              <th style={th}>成功率</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td style={cell} colSpan={5} align="center">加载中...</td></tr>
            )}
            {!loading && level === 'vendors' && vendors.length === 0 && (
              <tr><td colSpan={5} align="center" style={{ ...cell, color: 'var(--text-muted)' }}>暂无数据</td></tr>
            )}
            {!loading && level === 'vendors' && vendors.map((v) => (
              <tr key={v.vendorId} style={rowHover}>
                <td style={cell}>
                  <span style={{ color: 'var(--text-primary)', cursor: 'pointer', textDecoration: 'underline' }} onClick={() => goVendor(v.vendorId)}>
                    {v.vendorName || v.vendorId}
                  </span>
                </td>
                {renderDerived(v.derived)}
              </tr>
            ))}
            {!loading && level === 'vendor' && vendorDetail?.services.map((s) => (
              <tr key={s.serviceId} style={rowHover}>
                <td style={cell}>
                  <span style={{ color: 'var(--text-primary)', cursor: 'pointer', textDecoration: 'underline' }} onClick={() => goService(s.serviceId)}>
                    {s.serviceName || s.serviceId}
                  </span>
                </td>
                {renderDerived(s.derived)}
              </tr>
            ))}
            {!loading && level === 'service' && serviceDetail?.models.map((m) => (
              <tr key={m.model} style={rowHover}>
                <td style={cell}>
                  <span style={{ color: 'var(--text-primary)', cursor: 'pointer', textDecoration: 'underline' }} onClick={() => goModel(m.model)}>
                    {m.model}
                  </span>
                </td>
                {renderDerived(m.derived)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 走势图（vendor/service/model 层级） */}
      {level !== 'vendors' && (
        <div style={{ marginTop: '24px' }}>
          <h4 style={{ margin: '0 0 12px 0', fontSize: '15px', color: 'var(--text-primary)' }}>
            {metricLabel} · 按小时走势
            {level === 'model' && modelDetail && (
              <span style={{ marginLeft: '12px', fontSize: '12px', color: 'var(--text-muted)' }}>
                最小 {metric === 'ttft' ? formatMs(modelDetail.derived.minTtftMs ?? 0) : formatNum(modelDetail.derived.minTps ?? 0)}
                {' / 最大 '}{metric === 'ttft' ? formatMs(modelDetail.derived.maxTtftMs ?? 0) : formatNum(modelDetail.derived.maxTps ?? 0)}
              </span>
            )}
          </h4>
          {chartData.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', padding: '24px', textAlign: 'center' }}>暂无走势数据</div>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-primary)" />
                <XAxis dataKey="hour" stroke="var(--text-muted)" fontSize={12} />
                <YAxis stroke="var(--text-muted)" fontSize={12} />
                <Tooltip
                  contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border-primary)', borderRadius: '8px' }}
                  formatter={(v: any) => [metric === 'ttft' ? formatMs(Number(v)) : formatNum(Number(v)), metricLabel]}
                />
                <Line
                  type="monotone"
                  dataKey={valueField}
                  stroke="#667eea"
                  strokeWidth={2}
                  dot={false}
                  name={metricLabel}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      )}
    </div>
  );
}

const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '10px 12px',
  borderBottom: '2px solid var(--border-primary)',
  color: 'var(--text-muted)',
  fontWeight: 500,
  fontSize: '12px',
};

const cell: React.CSSProperties = {
  padding: '10px 12px',
  borderBottom: '1px solid var(--border-primary)',
  color: 'var(--text-primary)',
};

const rowHover: React.CSSProperties = {
  transition: 'background 0.15s',
};
