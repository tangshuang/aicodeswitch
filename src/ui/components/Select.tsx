import { useState, useEffect, useRef } from 'react';

/**
 * 通用下拉选择器（支持每个选项展示标题 + 说明）
 *
 * - 点击触发器展开面板，点击外部或选中后自动关闭
 * - 每个选项可携带 description，在列表中以浅色小字展示
 * - 纯 inline styles + CSS Variables，无外部 CSS 框架依赖
 */

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
}

interface SelectProps {
  /** 当前选中值 */
  value: string;
  /** 选项列表 */
  options: SelectOption[];
  /** 选中变更回调 */
  onChange: (value: string) => void;
  /** 是否禁用 */
  disabled?: boolean;
  /** 无选中时的占位文字 */
  placeholder?: string;
}

export default function Select({
  value,
  options,
  onChange,
  disabled = false,
  placeholder = '请选择',
}: SelectProps) {
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

  const selected = options.find(o => o.value === value);

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      {/* 触发器 */}
      <div
        onClick={() => !disabled && setOpen(!open)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          border: `1px solid ${open ? 'var(--accent-primary)' : 'var(--border-primary)'}`,
          borderRadius: '8px',
          background: 'var(--input-bg, var(--bg-primary))',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.6 : 1,
          transition: 'border-color 0.2s',
          userSelect: 'none',
          minWidth: 0,
        }}
      >
        {selected ? (
          <span style={{ fontSize: '14px', color: 'var(--text-primary)' }}>
            {selected.label}
          </span>
        ) : (
          <span style={{ fontSize: '14px', color: 'var(--text-muted)' }}>{placeholder}</span>
        )}
        <span style={{
          fontSize: '12px',
          color: 'var(--text-muted)',
          marginLeft: '8px',
          flexShrink: 0,
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
          maxHeight: '360px',
          overflowY: 'auto',
          background: 'var(--bg-primary)',
          border: '1px solid var(--border-primary)',
          borderRadius: '8px',
          boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
        }}>
          {options.map((option) => {
            const isSelected = value === option.value;
            return (
              <div
                key={option.value}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                style={{
                  padding: '10px 14px',
                  cursor: 'pointer',
                  background: isSelected
                    ? 'var(--accent-light)'
                    : 'transparent',
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
                    e.currentTarget.style.background = 'transparent';
                  }
                }}
              >
                <div style={{
                  fontSize: '14px',
                  fontWeight: isSelected ? 600 : 400,
                  color: 'var(--text-primary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '8px',
                }}>
                  <span>{option.label}</span>
                  {isSelected && (
                    <span style={{
                      fontSize: '13px',
                      color: 'var(--accent-primary)',
                      flexShrink: 0,
                    }}>✓</span>
                  )}
                </div>
                {option.description && (
                  <div style={{
                    fontSize: '12px',
                    color: 'var(--text-muted)',
                    marginTop: '4px',
                    lineHeight: '1.5',
                  }}>
                    {option.description}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
