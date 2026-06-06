import { useState, useMemo, useEffect, useRef } from 'react';
import vendorsConfig from '../constants/vendors';
import type { Vendor } from '../../types';

/**
 * 自定义供应商下拉选择器
 *
 * - 按 sortedGroup 分组，组间以分割线分隔
 * - 展示供应商名称 + 描述
 * - 已配置供应商标浅橙色，未配置标浅绿色
 * - 选中项高亮
 */

interface VendorSelectorProps {
  /** 当前选中的 vendorKey */
  value: string;
  /** 选中变更回调 */
  onChange: (vendorKey: string) => void;
  /** 已有的供应商列表（用于判断配置状态） */
  existingVendors?: Vendor[];
  /** 是否禁用 */
  disabled?: boolean;
}

export default function VendorSelector({
  value,
  onChange,
  existingVendors = [],
  disabled = false,
}: VendorSelectorProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // 排序后的供应商列表
  const sortedVendors = useMemo(() => {
    const entries = Object.entries(vendorsConfig).map(([key, config]) => ({
      key,
      name: config.name,
      sortedGroup: config.sortedGroup ?? 0,
    }));
    entries.sort((a, b) => a.sortedGroup - b.sortedGroup);

    const result: Array<{ key: string; name: string } | null> = [];
    let lastGroup: number | null = null;
    for (const entry of entries) {
      if (lastGroup !== null && entry.sortedGroup !== lastGroup) {
        result.push(null); // 分隔线
      }
      result.push(entry);
      lastGroup = entry.sortedGroup;
    }
    return result;
  }, []);

  const currentConfig = value
    ? vendorsConfig[value as keyof typeof vendorsConfig]
    : null;

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      {/* 触发器 */}
      <div
        onClick={() => !disabled && setOpen(!open)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 14px',
          border: `1px solid ${open ? 'var(--accent-primary)' : 'var(--border-primary)'}`,
          borderRadius: '8px',
          background: 'var(--input-bg, var(--bg-primary))',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.6 : 1,
          transition: 'border-color 0.2s',
          userSelect: 'none',
        }}
      >
        {currentConfig ? (
          <span style={{ fontSize: '14px', color: 'var(--text-primary)' }}>
            {currentConfig.name}
          </span>
        ) : (
          <span style={{ fontSize: '14px', color: 'var(--text-muted)' }}>请选择供应商</span>
        )}
        <span style={{
          fontSize: '12px',
          color: 'var(--text-muted)',
          transform: open ? 'rotate(180deg)' : 'rotate(0)',
          transition: 'transform 0.2s',
        }}>▼</span>
      </div>

      {/* 下拉面板 */}
      {open && (
        <div style={{
          position: 'absolute',
          top: '100%',
          left: 0,
          right: 0,
          zIndex: 999,
          marginTop: '4px',
          maxHeight: '320px',
          overflowY: 'auto',
          background: 'var(--bg-primary)',
          border: '1px solid var(--border-primary)',
          borderRadius: '8px',
          boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
        }}>
          {sortedVendors.map((vendor, index) => {
            if (!vendor) {
              return (
                <div key={`sep-${index}`} style={{
                  height: '1px',
                  background: 'var(--border-primary)',
                }} />
              );
            }

            const config = vendorsConfig[vendor.key as keyof typeof vendorsConfig];
            const isConfigured = existingVendors.some(ev => ev.name === vendor.name);
            const isSelected = value === vendor.key;

            return (
              <div
                key={vendor.key}
                onClick={() => {
                  onChange(vendor.key);
                  setOpen(false);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  padding: '10px 14px',
                  cursor: 'pointer',
                  background: isSelected
                    ? 'var(--accent-light)'
                    : isConfigured
                      ? 'rgba(255, 167, 38, 0.08)'
                      : 'rgba(76, 175, 80, 0.08)',
                  borderLeft: isSelected
                    ? '3px solid var(--accent-primary)'
                    : '3px solid transparent',
                  transition: 'background 0.15s',
                }}
                onMouseEnter={(e) => {
                  if (!isSelected) {
                    e.currentTarget.style.background = 'var(--bg-hover)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isSelected) {
                    e.currentTarget.style.background = isConfigured
                      ? 'rgba(255, 167, 38, 0.08)'
                      : 'rgba(76, 175, 80, 0.08)';
                  }
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: '14px',
                    fontWeight: isSelected ? 600 : 400,
                    color: 'var(--text-primary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {vendor.name}
                    {config?.tags?.map((tag, i) => (
                      <span key={i} style={{
                        fontSize: '11px',
                        marginLeft: '6px',
                        padding: '1px 6px',
                        borderRadius: '8px',
                        background: 'rgba(229, 57, 53, 0.1)',
                        color: '#e53935',
                        fontWeight: 500,
                        verticalAlign: 'middle',
                      }}>{tag}</span>
                    ))}
                  </div>
                  {config?.description && (
                    <div style={{
                      fontSize: '12px',
                      color: 'var(--text-muted)',
                      marginTop: '2px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {config.description}
                    </div>
                  )}
                </div>
                <span style={{
                  fontSize: '11px',
                  padding: '2px 8px',
                  borderRadius: '10px',
                  fontWeight: 500,
                  whiteSpace: 'nowrap',
                  background: isConfigured
                    ? 'rgba(255, 167, 38, 0.15)'
                    : 'rgba(76, 175, 80, 0.15)',
                  color: isConfigured
                    ? '#e67e22'
                    : '#4caf50',
                }}>
                  {isConfigured ? '已配置' : '可用'}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
