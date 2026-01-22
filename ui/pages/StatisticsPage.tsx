import { useState, useEffect } from 'react';
import { api } from '../api/client';
import type { Statistics } from '../../types';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import dayjs from 'dayjs';

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316'];

function StatisticsPage() {
  const [statistics, setStatistics] = useState<Statistics | null>(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);

  useEffect(() => {
    loadStatistics();
  }, [days]);

  const loadStatistics = async () => {
    try {
      setLoading(true);
      const data = await api.getStatistics(days);
      setStatistics(data);
    } catch (error) {
      console.error('Failed to load statistics:', error);
    } finally {
      setLoading(false);
    }
  };

  const formatNumber = (num: number): string => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toString();
  };

  const formatTime = (minutes: number): string => {
    if (minutes >= 60) {
      const hours = Math.floor(minutes / 60);
      const mins = minutes % 60;
      return `${hours}h ${mins}m`;
    }
    return `${minutes}m`;
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh' }}>
        <div style={{ fontSize: '18px', color: 'var(--text-muted)' }}>加载统计数据中...</div>
      </div>
    );
  }

  if (!statistics) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh' }}>
        <div style={{ fontSize: '18px', color: 'var(--text-muted)' }}>暂无统计数据</div>
      </div>
    );
  }

  const contentTypeLabels: Record<string, string> = {
    'default': '默认请求',
    'image-understanding': '图像理解',
    'thinking': '思考模式',
    'long-context': '长上下文',
    'background': '后台任务',
    'model-mapping': '模型映射',
  };

  // 计算每日编程时长（基于 tokens 估算）
  const codingTimeTimeline = statistics.timeline.map(day => ({
    date: day.date,
    codingTime: Math.round(day.totalInputTokens / 250 + day.totalOutputTokens / 100),
  }));

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '28px', fontWeight: 'bold', color: 'var(--text-primary)' }}>
            📊 数据统计
          </h1>
          <p style={{ margin: '4px 0 0 0', color: 'var(--text-muted)' }}>
            查看您的 AI 编程助手使用情况分析
          </p>
        </div>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <label style={{ color: 'var(--text-primary)', fontWeight: '500' }}>统计周期:</label>
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            style={{
              padding: '8px 16px',
              borderRadius: '8px',
              border: '1px solid var(--border-primary)',
              background: 'var(--bg-card)',
              color: 'var(--text-primary)',
              fontSize: '14px',
              cursor: 'pointer',
            }}
          >
            <option value={7}>最近 7 天</option>
            <option value={30}>最近 30 天</option>
            <option value={90}>最近 90 天</option>
          </select>
          <button
            onClick={loadStatistics}
            style={{
              padding: '8px 16px',
              borderRadius: '8px',
              border: '1px solid var(--border-primary)',
              background: 'var(--bg-card)',
              color: 'var(--text-primary)',
              fontSize: '14px',
              cursor: 'pointer',
            }}
          >
            🔄 刷新
          </button>
        </div>
      </div>

      {/* 概览卡片 */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
        gap: '16px',
        marginBottom: '24px',
      }}>
        <div style={{
          background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
          padding: '20px',
          borderRadius: '16px',
          color: 'white',
          boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)',
        }}>
          <div style={{ fontSize: '14px', opacity: 0.9, marginBottom: '8px' }}>总请求数</div>
          <div style={{ fontSize: '32px', fontWeight: 'bold' }}>{formatNumber(statistics.overview.totalRequests)}</div>
        </div>

        <div style={{
          background: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
          padding: '20px',
          borderRadius: '16px',
          color: 'white',
          boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)',
        }}>
          <div style={{ fontSize: '14px', opacity: 0.9, marginBottom: '8px' }}>总 Tokens</div>
          <div style={{ fontSize: '32px', fontWeight: 'bold' }}>{formatNumber(statistics.overview.totalTokens)}</div>
        </div>

        <div style={{
          background: 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
          padding: '20px',
          borderRadius: '16px',
          color: 'white',
          boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)',
        }}>
          <div style={{ fontSize: '14px', opacity: 0.9, marginBottom: '8px' }}>编程时长</div>
          <div style={{ fontSize: '32px', fontWeight: 'bold' }}>{formatTime(statistics.overview.totalCodingTime)}</div>
        </div>

        <div style={{
          background: 'linear-gradient(135deg, #14a042 0%, #38f9d7 100%)',
          padding: '20px',
          borderRadius: '16px',
          color: 'white',
          boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)',
        }}>
          <div style={{ fontSize: '14px', opacity: 0.9, marginBottom: '8px' }}>成功率</div>
          <div style={{ fontSize: '32px', fontWeight: 'bold' }}>{statistics.overview.successRate.toFixed(1)}%</div>
        </div>

        <div style={{
          background: 'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
          padding: '20px',
          borderRadius: '16px',
          color: 'white',
          boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)',
        }}>
          <div style={{ fontSize: '14px', opacity: 0.9, marginBottom: '8px' }}>平均响应时间</div>
          <div style={{ fontSize: '32px', fontWeight: 'bold' }}>{statistics.overview.avgResponseTime}ms</div>
        </div>

        <div style={{
          background: 'linear-gradient(135deg, #30cfd0 0%, #330867 100%)',
          padding: '20px',
          borderRadius: '16px',
          color: 'white',
          boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)',
        }}>
          <div style={{ fontSize: '14px', opacity: 0.9, marginBottom: '8px' }}>配置统计</div>
          <div style={{ fontSize: '14px', marginTop: '8px' }}>
            {statistics.overview.totalVendors} 供应商 · {statistics.overview.totalServices} 服务 · {statistics.overview.totalRoutes} 路由
          </div>
        </div>
      </div>

      {/* 图表区域 */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(500px, 1fr))',
        gap: '20px',
        marginBottom: '24px',
      }}>
        {/* 时间趋势图 */}
        <div style={{
          background: 'var(--bg-card)',
          padding: '20px',
          borderRadius: '16px',
          border: '1px solid var(--border-primary)',
        }}>
          <h3 style={{ margin: '0 0 16px 0', fontSize: '18px', color: 'var(--text-primary)' }}>
            📈 请求趋势
          </h3>
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={statistics.timeline}>
              <defs>
                <linearGradient id="colorRequests" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#8884d8" stopOpacity={0.8}/>
                  <stop offset="95%" stopColor="#8884d8" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-primary)" />
              <XAxis
                dataKey="date"
                stroke="var(--text-muted)"
                fontSize={12}
                tickFormatter={(date) => dayjs(date).format('MM/DD')}
              />
              <YAxis stroke="var(--text-muted)" fontSize={12} />
              <Tooltip
                contentStyle={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border-primary)',
                  borderRadius: '8px',
                  color: 'var(--text-primary)',
                }}
                labelFormatter={(date) => dayjs(date).format('YYYY-MM-DD')}
              />
              <Legend />
              <Area
                type="monotone"
                dataKey="totalRequests"
                name="请求数"
                stroke="#8884d8"
                fillOpacity={1}
                fill="url(#colorRequests)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* Token 趋势图 */}
        <div style={{
          background: 'var(--bg-card)',
          padding: '20px',
          borderRadius: '16px',
          border: '1px solid var(--border-primary)',
        }}>
          <h3 style={{ margin: '0 0 16px 0', fontSize: '18px', color: 'var(--text-primary)' }}>
            🔢 Token 使用趋势
          </h3>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={statistics.timeline}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-primary)" />
              <XAxis
                dataKey="date"
                stroke="var(--text-muted)"
                fontSize={12}
                tickFormatter={(date) => dayjs(date).format('MM/DD')}
              />
              <YAxis stroke="var(--text-muted)" fontSize={12} tickFormatter={(value) => value ? formatNumber(Number(value)) : ''} />
              <Tooltip
                contentStyle={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border-primary)',
                  borderRadius: '8px',
                  color: 'var(--text-primary)',
                }}
                labelFormatter={(date) => dayjs(date).format('YYYY-MM-DD')}
                formatter={(value) => value ? formatNumber(Number(value)) : ''}
              />
              <Legend />
              <Line type="monotone" dataKey="totalInputTokens" name="输入 Tokens" stroke="#10b981" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="totalOutputTokens" name="输出 Tokens" stroke="#f59e0b" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* 每日编程时长趋势 */}
        <div style={{
          background: 'var(--bg-card)',
          padding: '20px',
          borderRadius: '16px',
          border: '1px solid var(--border-primary)',
        }}>
          <h3 style={{ margin: '0 0 16px 0', fontSize: '18px', color: 'var(--text-primary)' }}>
            ⏱️ 每日编程时长趋势
          </h3>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={codingTimeTimeline}>
              <defs>
                <linearGradient id="colorCodingTime" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.8}/>
                  <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-primary)" />
              <XAxis
                dataKey="date"
                stroke="var(--text-muted)"
                fontSize={12}
                tickFormatter={(date) => dayjs(date).format('MM/DD')}
              />
              <YAxis
                stroke="var(--text-muted)"
                fontSize={12}
                tickFormatter={(value) => value !== undefined && value !== null ? (value >= 60 ? `${Math.round(Number(value) / 60)}h` : `${Number(value)}m`) : ''}
              />
              <Tooltip
                contentStyle={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border-primary)',
                  borderRadius: '8px',
                  color: 'var(--text-primary)',
                }}
                labelFormatter={(date) => dayjs(date).format('YYYY-MM-DD')}
                formatter={(value) => value !== undefined && value !== null ? formatTime(Number(value)) : ''}
              />
              <Legend />
              <Area
                type="monotone"
                dataKey="codingTime"
                name="编程时长"
                stroke="#8b5cf6"
                fillOpacity={1}
                fill="url(#colorCodingTime)"
              />
              <Line
                type="monotone"
                dataKey="codingTime"
                name="编程时长"
                stroke="#8b5cf6"
                strokeWidth={3}
                dot={{ fill: '#8b5cf6', r: 4 }}
                activeDot={{ r: 6 }}
              />
            </LineChart>
          </ResponsiveContainer>
          <div style={{
            marginTop: '12px',
            padding: '12px',
            background: 'var(--bg-secondary)',
            borderRadius: '8px',
            fontSize: '14px',
            color: 'var(--text-muted)',
            textAlign: 'center',
          }}>
            💡 编程时长基于 tokens 估算（阅读速度 250 tokens/分钟，编码速度 100 tokens/分钟）
          </div>
        </div>

        {/* 供应商分布 */}
        <div style={{
          background: 'var(--bg-card)',
          padding: '20px',
          borderRadius: '16px',
          border: '1px solid var(--border-primary)',
        }}>
          <h3 style={{ margin: '0 0 16px 0', fontSize: '18px', color: 'var(--text-primary)' }}>
            🏢 供应商使用分布
          </h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={statistics.byVendor}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-primary)" />
              <XAxis
                dataKey="vendorName"
                stroke="var(--text-muted)"
                fontSize={12}
                angle={-45}
                textAnchor="end"
                height={80}
              />
              <YAxis stroke="var(--text-muted)" fontSize={12} />
              <Tooltip
                contentStyle={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border-primary)',
                  borderRadius: '8px',
                  color: 'var(--text-primary)',
                }}
              />
              <Legend />
              <Bar dataKey="totalRequests" name="请求数" fill="#3b82f6" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* 内容类型分布 */}
        <div style={{
          background: 'var(--bg-card)',
          padding: '20px',
          borderRadius: '16px',
          border: '1px solid var(--border-primary)',
        }}>
          <h3 style={{ margin: '0 0 16px 0', fontSize: '18px', color: 'var(--text-primary)' }}>
            📋 请求类型分布
          </h3>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={statistics.contentTypeDistribution}
                cx="50%"
                cy="50%"
                labelLine={true}
                label={(props: any) => `${contentTypeLabels[props.contentType] || props.contentType} (${props.percentage}%)`}
                outerRadius={80}
                fill="#8884d8"
                dataKey="count"
              >
                {statistics.contentTypeDistribution.map((_entry, index) => (
                  <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border-primary)',
                  borderRadius: '8px',
                  color: 'var(--text-primary)',
                }}
                formatter={(value: any, _name: any, props: any) => {
                  const count = value ?? 0;
                  const pct = props.payload?.percentage ?? 0;
                  const type = props.payload?.contentType || '';
                  const label = contentTypeLabels[type] || type;
                  return `${count} (${pct}%) - ${label}`;
                }}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* 详细统计表格 */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))',
        gap: '20px',
      }}>
        {/* 按目标类型 */}
        <div style={{
          background: 'var(--bg-card)',
          padding: '20px',
          borderRadius: '16px',
          border: '1px solid var(--border-primary)',
        }}>
          <h3 style={{ margin: '0 0 16px 0', fontSize: '18px', color: 'var(--text-primary)' }}>
            🎯 按目标类型统计
          </h3>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--border-primary)' }}>
                <th style={{ padding: '12px', textAlign: 'left', color: 'var(--text-muted)', fontSize: '14px' }}>类型</th>
                <th style={{ padding: '12px', textAlign: 'right', color: 'var(--text-muted)', fontSize: '14px' }}>请求数</th>
                <th style={{ padding: '12px', textAlign: 'right', color: 'var(--text-muted)', fontSize: '14px' }}>Tokens</th>
              </tr>
            </thead>
            <tbody>
              {statistics.byTargetType.map((item) => (
                <tr key={item.targetType} style={{ borderBottom: '1px solid var(--border-secondary)' }}>
                  <td style={{ padding: '12px', color: 'var(--text-primary)' }}>
                    {item.targetType === 'claude-code' ? 'Claude Code' : 'Codex'}
                  </td>
                  <td style={{ padding: '12px', textAlign: 'right', color: 'var(--text-primary)' }}>
                    {formatNumber(item.totalRequests)}
                  </td>
                  <td style={{ padding: '12px', textAlign: 'right', color: 'var(--text-primary)' }}>
                    {formatNumber(item.totalTokens)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 按模型统计 */}
        <div style={{
          background: 'var(--bg-card)',
          padding: '20px',
          borderRadius: '16px',
          border: '1px solid var(--border-primary)',
        }}>
          <h3 style={{ margin: '0 0 16px 0', fontSize: '18px', color: 'var(--text-primary)' }}>
            🤖 按模型统计
          </h3>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--border-primary)' }}>
                <th style={{ padding: '12px', textAlign: 'left', color: 'var(--text-muted)', fontSize: '14px' }}>模型</th>
                <th style={{ padding: '12px', textAlign: 'right', color: 'var(--text-muted)', fontSize: '14px' }}>请求数</th>
                <th style={{ padding: '12px', textAlign: 'right', color: 'var(--text-muted)', fontSize: '14px' }}>Tokens</th>
              </tr>
            </thead>
            <tbody>
              {statistics.byModel.slice(0, 10).map((item) => (
                <tr key={item.modelName} style={{ borderBottom: '1px solid var(--border-secondary)' }}>
                  <td style={{ padding: '12px', color: 'var(--text-primary)', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {item.modelName}
                  </td>
                  <td style={{ padding: '12px', textAlign: 'right', color: 'var(--text-primary)' }}>
                    {formatNumber(item.totalRequests)}
                  </td>
                  <td style={{ padding: '12px', textAlign: 'right', color: 'var(--text-primary)' }}>
                    {formatNumber(item.totalTokens)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 按服务统计 */}
        <div style={{
          background: 'var(--bg-card)',
          padding: '20px',
          borderRadius: '16px',
          border: '1px solid var(--border-primary)',
        }}>
          <h3 style={{ margin: '0 0 16px 0', fontSize: '18px', color: 'var(--text-primary)' }}>
            🔧 按服务统计
          </h3>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--border-primary)' }}>
                <th style={{ padding: '12px', textAlign: 'left', color: 'var(--text-muted)', fontSize: '14px' }}>服务</th>
                <th style={{ padding: '12px', textAlign: 'right', color: 'var(--text-muted)', fontSize: '14px' }}>请求数</th>
                <th style={{ padding: '12px', textAlign: 'right', color: 'var(--text-muted)', fontSize: '14px' }}>Tokens</th>
              </tr>
            </thead>
            <tbody>
              {statistics.byService.slice(0, 10).map((item) => (
                <tr key={item.serviceId} style={{ borderBottom: '1px solid var(--border-secondary)' }}>
                  <td style={{ padding: '12px', color: 'var(--text-primary)' }}>
                    <div style={{ fontSize: '14px', fontWeight: 'bold' }}>{item.serviceName}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{item.vendorName}</div>
                  </td>
                  <td style={{ padding: '12px', textAlign: 'right', color: 'var(--text-primary)' }}>
                    {formatNumber(item.totalRequests)}
                  </td>
                  <td style={{ padding: '12px', textAlign: 'right', color: 'var(--text-primary)' }}>
                    {formatNumber(item.totalTokens)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Token 详细统计 */}
        <div style={{
          background: 'var(--bg-card)',
          padding: '20px',
          borderRadius: '16px',
          border: '1px solid var(--border-primary)',
        }}>
          <h3 style={{ margin: '0 0 16px 0', fontSize: '18px', color: 'var(--text-primary)' }}>
            💰 Token 详细统计
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px', background: 'var(--bg-secondary)', borderRadius: '8px' }}>
              <span style={{ color: 'var(--text-muted)' }}>输入 Tokens</span>
              <span style={{ color: 'var(--text-primary)', fontWeight: 'bold' }}>{formatNumber(statistics.overview.totalInputTokens)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px', background: 'var(--bg-secondary)', borderRadius: '8px' }}>
              <span style={{ color: 'var(--text-muted)' }}>输出 Tokens</span>
              <span style={{ color: 'var(--text-primary)', fontWeight: 'bold' }}>{formatNumber(statistics.overview.totalOutputTokens)}</span>
            </div>
            {statistics.overview.totalCacheReadTokens > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px', background: 'var(--bg-secondary)', borderRadius: '8px' }}>
                <span style={{ color: 'var(--text-muted)' }}>缓存读取 Tokens</span>
                <span style={{ color: 'var(--text-primary)', fontWeight: 'bold' }}>{formatNumber(statistics.overview.totalCacheReadTokens)}</span>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px', background: 'var(--bg-secondary)', borderRadius: '8px' }}>
              <span style={{ color: 'var(--text-muted)' }}>总计 Tokens</span>
              <span style={{ color: 'var(--text-primary)', fontWeight: 'bold' }}>{formatNumber(statistics.overview.totalTokens)}</span>
            </div>
            <div style={{ marginTop: '8px', padding: '12px', background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', borderRadius: '8px', color: 'white' }}>
              <div style={{ fontSize: '12px', opacity: 0.9 }}>预估节省</div>
              <div style={{ fontSize: '20px', fontWeight: 'bold', marginTop: '4px' }}>
                ${((statistics.overview.totalTokens / 1000000) * 15).toFixed(2)}
              </div>
              <div style={{ fontSize: '12px', opacity: 0.9, marginTop: '4px' }}>按 $15/1M tokens 估算</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default StatisticsPage;
