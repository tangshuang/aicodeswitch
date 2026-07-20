import { useState, useEffect, useMemo } from 'react';
import { api } from '../api/client';
import type { LogsDiskUsage } from '../api/client';
import { toast } from './Toast';
import { useConfirm } from './Confirm';
import { formatBytes } from '../utils/format';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import dayjs from 'dayjs';

interface Props {
  onClose: () => void;
  onCleared: () => void;
}

const BLUE = '#3b82f6';
const RED = '#ef4444';

/** 按日期清理老日志：图表展示每日占用 + 选截止日 + 二次确认 */
export function CleanupLogsModal({ onClose, onCleared }: Props) {
  const { confirm } = useConfirm();
  const [usage, setUsage] = useState<LogsDiskUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [granularity, setGranularity] = useState<'day' | 'week'>('day');
  const [selectedDate, setSelectedDate] = useState<string>('');

  useEffect(() => {
    loadUsage();
  }, []);

  const loadUsage = async () => {
    setLoading(true);
    try {
      const data = await api.getLogsDiskUsage();
      data.daily.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      setUsage(data);
      // 默认截止日：保留最近 7 天，即倒数第 8 天；不足 8 天则取最早日
      const dates = data.daily.map((d) => d.date);
      if (dates.length > 0) {
        const idx = Math.max(0, dates.length - 8);
        setSelectedDate(dates[idx]);
      }
    } catch (err: any) {
      toast.error(err.message || '加载日志占用失败');
    } finally {
      setLoading(false);
    }
  };

  const daily = usage?.daily ?? [];

  // 按周聚合（周日为周首）
  const weekly = useMemo(() => {
    const map = new Map<string, { bytes: number; count: number; weekEnd: string }>();
    for (const d of daily) {
      const weekStart = dayjs(d.date).startOf('week').format('YYYY-MM-DD');
      const weekEnd = dayjs(weekStart).add(6, 'day').format('YYYY-MM-DD');
      let entry = map.get(weekStart);
      if (!entry) {
        entry = { bytes: 0, count: 0, weekEnd };
        map.set(weekStart, entry);
      }
      entry.bytes += d.bytes;
      entry.count += d.count;
    }
    return Array.from(map.entries())
      .map(([weekStart, v]) => ({ weekStart, weekEnd: v.weekEnd, bytes: v.bytes, count: v.count }))
      .sort((a, b) => (a.weekStart < b.weekStart ? -1 : 1));
  }, [daily]);

  // 当前粒度的图表数据
  const chartData = useMemo(() => {
    if (granularity === 'day') {
      return daily.map((d) => ({
        key: d.date,
        label: dayjs(d.date).format('MM/DD'),
        bytes: d.bytes,
        count: d.count,
      }));
    }
    return weekly.map((w) => ({
      key: w.weekStart,
      weekEnd: w.weekEnd,
      label: dayjs(w.weekStart).format('MM/DD'),
      bytes: w.bytes,
      count: w.count,
    }));
  }, [daily, weekly, granularity]);

  // 联动高亮：按天精确 date <= selectedDate；按周近似 weekStart <= selectedDate
  const isHighlighted = (key: string) => !!selectedDate && key <= selectedDate;

  // 汇总：被清理的 bytes/count（按天精确计算，清理按天执行）
  const summary = useMemo(() => {
    let bytes = 0;
    let count = 0;
    for (const d of daily) {
      if (selectedDate && d.date <= selectedDate) {
        bytes += d.bytes;
        count += d.count;
      }
    }
    return { bytes, count };
  }, [daily, selectedDate]);

  const totalBytes = usage?.totalBytes ?? 0;
  const totalCount = usage?.totalCount ?? 0;
  const hasData = daily.length > 0;

  const handleConfirm = async () => {
    if (!selectedDate) return;
    const message =
      `确定要清理 ${selectedDate}（含）及之前的所有日志吗？\n\n` +
      `⚠️ 此操作将永久删除：\n` +
      `- ${summary.count.toLocaleString()} 条日志（含接入密钥日志）\n` +
      `- 释放约 ${formatBytes(summary.bytes)} 磁盘空间\n\n` +
      `此操作不可撤销。`;
    const ok = await confirm({
      message,
      title: '确认清理老日志',
      type: 'danger',
      confirmText: '确认清理',
      cancelText: '取消',
    });
    if (!ok) return;
    setSubmitting(true);
    try {
      const result = await api.cleanupLogsBeforeDate(selectedDate);
      toast.success(`已清理 ${result.deletedCount.toLocaleString()} 条日志，释放 ${formatBytes(result.deletedBytes)}`);
      onCleared();
      onClose();
    } catch (err: any) {
      toast.error(err.message || '清理失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay">
      <button type="button" className="modal-close-btn" onClick={onClose} aria-label="关闭">×</button>
      <div className="modal" style={{ width: '860px', maxWidth: '92vw' }}>
        {/* Header */}
        <div className="modal-header">
          <h2>清理老日志</h2>
          <div style={{ fontSize: '13px', color: 'var(--text-tertiary)', marginLeft: '12px' }}>
            按日期清理日志，释放磁盘空间
          </div>
        </div>

        {/* Body */}
        <div className="modal-body-scrollable" style={{ padding: '20px' }}>
          {loading ? (
            <div className="empty-state"><p>加载中...</p></div>
          ) : !hasData ? (
            <div className="empty-state"><p>暂无日志可清理</p></div>
          ) : (
            <>
              {/* 总览 */}
              <div style={{ display: 'flex', gap: '12px', marginBottom: '16px', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: '140px', padding: '12px 16px', background: 'var(--bg-secondary)', borderRadius: '8px', border: '1px solid var(--border-primary)' }}>
                  <div style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>总占用</div>
                  <div style={{ fontSize: '22px', fontWeight: 600, color: 'var(--text-primary)' }}>{formatBytes(totalBytes)}</div>
                </div>
                <div style={{ flex: 1, minWidth: '140px', padding: '12px 16px', background: 'var(--bg-secondary)', borderRadius: '8px', border: '1px solid var(--border-primary)' }}>
                  <div style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>总日志数</div>
                  <div style={{ fontSize: '22px', fontWeight: 600, color: 'var(--text-primary)' }}>{totalCount.toLocaleString()}</div>
                </div>
                <div style={{ flex: 1, minWidth: '240px', padding: '12px 16px', background: 'var(--bg-secondary)', borderRadius: '8px', border: '1px solid var(--border-primary)' }}>
                  <div style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>时间范围</div>
                  <div style={{ fontSize: '14px', fontWeight: 500, color: 'var(--text-primary)', marginTop: '4px', whiteSpace: 'nowrap' }}>
                    {daily[0]?.date} ~ {daily[daily.length - 1]?.date}
                  </div>
                </div>
              </div>

              {/* 图表 + 粒度切换 */}
              <div style={{ marginBottom: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <label style={{ fontWeight: 500, color: 'var(--text-secondary)', fontSize: '13px' }}>
                    占用空间分布（红色 = 将被清理）
                  </label>
                  <div style={{ display: 'flex', gap: '4px' }}>
                    {(['day', 'week'] as const).map((g) => (
                      <button
                        key={g}
                        type="button"
                        onClick={() => setGranularity(g)}
                        disabled={submitting}
                        style={{
                          padding: '4px 12px',
                          fontSize: '12px',
                          cursor: 'pointer',
                          borderRadius: '6px',
                          border: '1px solid var(--border-primary)',
                          background: granularity === g ? 'var(--accent-primary, #3498db)' : 'var(--bg-primary)',
                          color: granularity === g ? '#fff' : 'var(--text-secondary)',
                        }}
                      >
                        {g === 'day' ? '按天' : '按周'}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ background: 'var(--bg-secondary)', borderRadius: '8px', border: '1px solid var(--border-primary)', padding: '12px' }}>
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border-primary)" />
                      <XAxis dataKey="label" stroke="var(--text-muted)" fontSize={11} interval="preserveStartEnd" minTickGap={8} />
                      <YAxis stroke="var(--text-muted)" fontSize={11} tickFormatter={(v: any) => formatBytes(Number(v))} width={56} />
                      <Tooltip
                        cursor={{ fill: 'rgba(127,127,127,0.1)' }}
                        contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border-primary)', borderRadius: '8px', color: 'var(--text-primary)' }}
                        formatter={(v: any) => [formatBytes(Number(v)), '占用空间']}
                        labelFormatter={(_l: any, payload: any) => {
                          const p = payload?.[0]?.payload;
                          if (!p) return '';
                          return granularity === 'day' ? dayjs(p.key).format('YYYY-MM-DD') : `${p.key} ~ ${p.weekEnd}`;
                        }}
                      />
                      <Bar dataKey="bytes" name="占用空间" radius={[3, 3, 0, 0]}>
                        {chartData.map((entry) => (
                          <Cell key={entry.key} fill={isHighlighted(entry.key) ? RED : BLUE} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* 截止日选择 */}
              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', marginBottom: '8px', fontWeight: 500, color: 'var(--text-secondary)', fontSize: '13px' }}>
                  清理到（选中日期当天及之前的全部日志）
                </label>
                <div style={{ padding: '10px 12px', backgroundColor: 'var(--bg-secondary)', borderRadius: '8px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>截止日期</span>
                  <select
                    value={selectedDate}
                    onChange={(e) => setSelectedDate(e.target.value)}
                    disabled={submitting}
                    style={{ padding: '6px 10px', borderRadius: '6px', border: '1px solid var(--border-primary)', backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: '14px', cursor: 'pointer', flex: 1 }}
                  >
                    {daily.map((d) => (
                      <option key={d.date} value={d.date}>
                        {d.date}（{formatBytes(d.bytes)}，{d.count.toLocaleString()} 条）
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* 汇总警告 */}
              <div style={{ padding: '12px 14px', backgroundColor: 'rgba(231, 76, 60, 0.08)', border: '1px solid rgba(231, 76, 60, 0.3)', borderRadius: '6px', fontSize: '13px', color: '#c0392b', lineHeight: 1.5 }}>
                <strong>⚠️ 将清理：</strong>{selectedDate}（含）及之前的所有日志（含接入密钥日志），共{' '}
                <strong>{summary.count.toLocaleString()}</strong> 条，释放约 <strong>{formatBytes(summary.bytes)}</strong>。此操作不可撤销。
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="modal-footer">
          <div style={{ flex: 1 }} />
          <button className="btn btn-secondary" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button className="btn btn-danger" onClick={handleConfirm} disabled={submitting || !hasData || !selectedDate}>
            {submitting ? '处理中...' : '确认清理'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default CleanupLogsModal;
