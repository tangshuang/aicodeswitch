import { useState, useEffect, useCallback, useMemo } from 'react';
import { api } from '../api/client';
import type {
  PerfServiceOverview,
  PerfVendorOverview,
  PerfVendorDetail,
  PerfServiceDetail,
  PerfModelDetail,
  PerfTrendPoint,
  PerfDerived,
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
type Dimension = 'service' | 'vendor';
type DrillLevel = 'overview' | 'vendor' | 'service' | 'model';
type SortField = 'avgTtftMs' | 'avgTpm' | 'successRate';
type SortOrder = 'asc' | 'desc';

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

function formatMs(ms?: number): string {
  if (!ms) return '-';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

function formatNum(n?: number): string {
  if (!n) return '-';
  return Math.round(n).toLocaleString();
}

function formatPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function sliceTrend(trend: PerfTrendPoint[] | undefined, hours: number): PerfTrendPoint[] {
  if (!trend) return [];
  return trend.slice(-hours);
}

interface TableRow {
  id: string;
  name: string;
  vendorName?: string;
  derived: PerfDerived;
  onClick: () => void;
}

export default function ServicePerformancePanel() {
  const [dimension, setDimension] = useState<Dimension>('service');
  const [metric, setMetric] = useState<Metric>('ttft');
  const [hours, setHours] = useState(24);
  const [drillLevel, setDrillLevel] = useState<DrillLevel>('overview');

  const [vendorId, setVendorId] = useState<string | null>(null);
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);

  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');

  const [servicesOverview, setServicesOverview] = useState<PerfServiceOverview[]>([]);
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
      if (drillLevel === 'overview') {
        if (dimension === 'service') {
          setServicesOverview((await api.getPerformanceServicesOverview()) || []);
        } else {
          setVendors((await api.getPerformanceVendors()) || []);
        }
      } else if (drillLevel === 'vendor' && vendorId) {
        setVendorDetail(await api.getPerformanceVendor(vendorId));
      } else if (drillLevel === 'service' && serviceId) {
        setServiceDetail(await api.getPerformanceService(serviceId));
      } else if (drillLevel === 'model' && serviceId && model) {
        setModelDetail(await api.getPerformanceModel(serviceId, model));
      }
    } catch (e: any) {
      setError(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [dimension, drillLevel, vendorId, serviceId, model]);

  useEffect(() => {
    load();
  }, [load]);

  // —— 下钻导航 ——
  const changeDimension = (d: Dimension) => {
    setDimension(d);
    setDrillLevel('overview');
    setVendorId(null); setServiceId(null); setModel(null);
    setVendorDetail(null); setServiceDetail(null); setModelDetail(null);
    setSortField(null);
  };
  const goVendor = (vid: string) => {
    setVendorId(vid); setServiceId(null); setModel(null);
    setVendorDetail(null); setServiceDetail(null); setModelDetail(null);
    setDrillLevel('vendor'); setSortField(null);
  };
  const goService = (sid: string) => {
    setServiceId(sid); setModel(null);
    setServiceDetail(null); setModelDetail(null);
    setDrillLevel('service'); setSortField(null);
  };
  const goModel = (m: string) => {
    setModel(m); setModelDetail(null);
    setDrillLevel('model'); setSortField(null);
  };
  const backToOverview = () => {
    setVendorId(null); setServiceId(null); setModel(null);
    setDrillLevel('overview'); setSortField(null);
  };
  // 在供应商维度内，从服务层返回到供应商层
  const backToVendor = () => {
    setServiceId(null); setModel(null); setServiceDetail(null);
    setDrillLevel('vendor'); setSortField(null);
  };

  // —— 表格行（统一结构） ——
  const rows: TableRow[] = useMemo(() => {
    if (drillLevel === 'overview' && dimension === 'service') {
      return servicesOverview.map(s => ({
        id: s.serviceId,
        name: s.serviceName || s.serviceId,
        vendorName: s.vendorName,
        derived: s.derived,
        onClick: () => goService(s.serviceId),
      }));
    }
    if (drillLevel === 'overview' && dimension === 'vendor') {
      return vendors.map(v => ({
        id: v.vendorId,
        name: v.vendorName || v.vendorId,
        derived: v.derived,
        onClick: () => goVendor(v.vendorId),
      }));
    }
    if (drillLevel === 'vendor' && vendorDetail) {
      return vendorDetail.services.map(s => ({
        id: s.serviceId,
        name: s.serviceName || s.serviceId,
        derived: s.derived,
        onClick: () => goService(s.serviceId),
      }));
    }
    if (drillLevel === 'service' && serviceDetail) {
      return serviceDetail.models.map(m => ({
        id: m.model,
        name: m.model,
        derived: m.derived,
        onClick: () => goModel(m.model),
      }));
    }
    return [];
  }, [drillLevel, dimension, servicesOverview, vendors, vendorDetail, serviceDetail]);

  // —— 排序 ——
  const sortedRows = useMemo(() => {
    if (!sortField) return rows;
    const dir = sortOrder === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = (a.derived as any)[sortField] ?? 0;
      const vb = (b.derived as any)[sortField] ?? 0;
      return (va - vb) * dir;
    });
  }, [rows, sortField, sortOrder]);

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(prev => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortOrder('desc');
    }
  };

  const sortArrow = (field: SortField): string => {
    if (sortField !== field) return ' ⇅';
    return sortOrder === 'asc' ? ' ▲' : ' ▼';
  };

  // —— 走势 ——
  const trend: PerfTrendPoint[] | undefined = (() => {
    if (drillLevel === 'vendor') return vendorDetail?.hourly;
    if (drillLevel === 'service') return serviceDetail?.hourly;
    if (drillLevel === 'model') return modelDetail?.hourly;
    return undefined;
  })();
  const slicedTrend = sliceTrend(trend, hours);
  const chartData = slicedTrend.map(p => ({
    hour: p.hour.slice(11),
    value: metric === 'ttft' ? p.avgTtftMs : p.avgTpm,
  }));

  // —— 列与标题 ——
  const showVendorColumn = drillLevel === 'overview' && dimension === 'service';
  const nameColLabel =
    (drillLevel === 'overview' && dimension === 'vendor') ? '供应商'
      : drillLevel === 'service' ? '模型'
      : 'API 服务';

  const metricLabel = metric === 'ttft' ? '首 Token 返回时间' : '吞吐 TPM';

  // 当前下钻的极值（仅模型级）
  const extremeDerived = drillLevel === 'model' ? modelDetail?.derived : undefined;

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
        <h3 style={{ margin: 0, fontSize: '18px', color: 'var(--text-primary)' }}>
          ⚡ 服务性能 / 测速统计
        </h3>
        {/* 面包屑（仅在离开根时显示） */}
        {drillLevel !== 'overview' && (
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', fontSize: '13px' }}>
            <span onClick={backToOverview} style={breadcrumbLink}>
              {dimension === 'service' ? '全部 API 服务' : '全部供应商'}
            </span>
            {dimension === 'vendor' && vendorId && (
              <>
                <span style={{ color: 'var(--text-muted)' }}>›</span>
                {drillLevel === 'vendor' ? (
                  <span style={{ color: 'var(--text-primary)' }}>{vendorDetail?.vendorName || vendorId}</span>
                ) : (
                  <span onClick={backToVendor} style={breadcrumbLink}>
                    {vendorDetail?.vendorName || vendorId}
                  </span>
                )}
              </>
            )}
            {serviceDetail && (drillLevel === 'service' || drillLevel === 'model') && (
              <>
                <span style={{ color: 'var(--text-muted)' }}>›</span>
                {drillLevel === 'service' ? (
                  <span style={{ color: 'var(--text-primary)' }}>{serviceDetail.serviceName || serviceId}</span>
                ) : (
                  <span onClick={() => { setModel(null); setModelDetail(null); setDrillLevel('service'); setSortField(null); }} style={breadcrumbLink}>
                    {serviceDetail.serviceName || serviceId}
                  </span>
                )}
              </>
            )}
            {model && drillLevel === 'model' && (
              <>
                <span style={{ color: 'var(--text-muted)' }}>›</span>
                <span style={{ color: 'var(--text-primary)' }}>{model}</span>
              </>
            )}
          </div>
        )}
      </div>

      <p style={{ margin: '0 0 16px 0', color: 'var(--text-muted)', fontSize: '13px' }}>
        全局统计，与认证模式无关。首 Token 返回时间 = 请求发起到首个 token 的延迟；TPM = 生成阶段每分钟吐出的 token 数（基于真实流量被动采集）。
      </p>

      {/* 筛选器 */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <label style={{ color: 'var(--text-muted)', fontSize: '13px' }}>维度:</label>
          <select style={selectStyle} value={dimension} onChange={(e) => changeDimension(e.target.value as Dimension)} disabled={drillLevel !== 'overview'}>
            <option value="service">API 服务</option>
            <option value="vendor">供应商</option>
          </select>
        </div>
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
              <th style={th}>{nameColLabel}</th>
              {showVendorColumn && <th style={th}>供应商</th>}
              <th style={{ ...th, cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort('avgTtftMs')}>
                平均首Token{sortArrow('avgTtftMs')}
              </th>
              <th style={{ ...th, cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort('avgTpm')}>
                平均 TPM{sortArrow('avgTpm')}
              </th>
              <th style={th}>样本数</th>
              <th style={{ ...th, cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort('successRate')}>
                成功率{sortArrow('successRate')}
              </th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td style={cell} colSpan={showVendorColumn ? 6 : 5} align="center">加载中...</td></tr>
            )}
            {!loading && sortedRows.length === 0 && (
              <tr><td style={{ ...cell, color: 'var(--text-muted)' }} colSpan={showVendorColumn ? 6 : 5} align="center">暂无数据</td></tr>
            )}
            {!loading && sortedRows.map((r) => (
              <tr key={r.id} style={rowHover}>
                <td style={cell}>
                  <span style={{ color: 'var(--text-primary)', cursor: 'pointer', textDecoration: 'underline' }} onClick={r.onClick}>
                    {r.name}
                  </span>
                </td>
                {showVendorColumn && <td style={{ ...cell, color: 'var(--text-muted)' }}>{r.vendorName || '-'}</td>}
                <td style={cell}>{formatMs(r.derived.avgTtftMs)}</td>
                <td style={cell}>{r.derived.count > 0 ? formatNum(r.derived.avgTpm) : '-'}</td>
                <td style={cell}>{r.derived.count}</td>
                <td style={cell}>{formatPct(r.derived.successRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 走势图（vendor/service/model 下钻层级） */}
      {drillLevel !== 'overview' && (
        <div style={{ marginTop: '24px' }}>
          <h4 style={{ margin: '0 0 12px 0', fontSize: '15px', color: 'var(--text-primary)' }}>
            {metricLabel} · 按小时走势
            {extremeDerived && (
              <span style={{ marginLeft: '12px', fontSize: '12px', color: 'var(--text-muted)' }}>
                最小 {metric === 'ttft' ? formatMs(extremeDerived.minTtftMs) : formatNum(extremeDerived.minTps ? extremeDerived.minTps * 60 : undefined)}
                {' / 最大 '}{metric === 'ttft' ? formatMs(extremeDerived.maxTtftMs) : formatNum(extremeDerived.maxTps ? extremeDerived.maxTps * 60 : undefined)}
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
                <Line type="monotone" dataKey="value" stroke="#667eea" strokeWidth={2} dot={false} name={metricLabel} />
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

const breadcrumbLink: React.CSSProperties = {
  color: 'var(--text-primary)',
  cursor: 'pointer',
  textDecoration: 'underline',
  textDecorationColor: 'transparent',
};

const rowHover: React.CSSProperties = {
  transition: 'background 0.15s',
};
