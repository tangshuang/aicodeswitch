import { createContext, useContext, useState, ReactNode } from 'react';

interface ConfirmOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  type?: 'danger' | 'warning' | 'info';
}

interface ConfirmContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextValue | undefined>(undefined);

export function useConfirm() {
  const context = useContext(ConfirmContext);
  if (!context) {
    throw new Error('useConfirm must be used within ConfirmProvider');
  }
  return context;
}

let resolveConfirm: ((value: boolean) => void) | null = null;

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [options, setOptions] = useState<ConfirmOptions>({ message: '' });

  const confirm = (opts: ConfirmOptions): Promise<boolean> => {
    setOptions(opts);
    setIsOpen(true);
    return new Promise((resolve) => {
      resolveConfirm = resolve;
    });
  };

  const handleConfirm = () => {
    setIsOpen(false);
    if (resolveConfirm) {
      resolveConfirm(true);
      resolveConfirm = null;
    }
  };

  const handleCancel = () => {
    setIsOpen(false);
    if (resolveConfirm) {
      resolveConfirm(false);
      resolveConfirm = null;
    }
  };

  const getTypeStyles = () => {
    switch (options.type) {
      case 'danger':
        return {
          icon: '⚠️',
          iconColor: '#dc3545',
          buttonClass: 'btn-danger',
        };
      case 'warning':
        return {
          icon: '⚠',
          iconColor: '#ffc107',
          buttonClass: 'btn-warning',
        };
      default:
        return {
          icon: 'ℹ️',
          iconColor: '#17a2b8',
          buttonClass: 'btn-primary',
        };
    }
  };

  const typeStyles = getTypeStyles();

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      {isOpen && (
        <div className="modal-overlay" style={{ zIndex: 10000 }}>
          <div className="modal" style={{ maxWidth: '500px' }}>
            <div className="modal-container">
              <div className="modal-header">
                <h2>{options.title || '确认操作'}</h2>
              </div>
              <div style={{ padding: '20px' }}>
                <div style={{ display: 'flex', gap: '15px', alignItems: 'flex-start' }}>
                  <span style={{ fontSize: '32px', flexShrink: 0 }}>{typeStyles.icon}</span>
                  <div style={{ flex: 1, whiteSpace: 'pre-wrap', lineHeight: '1.6' }}>
                    {options.message}
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button className="btn btn-secondary" onClick={handleCancel}>
                  {options.cancelText || '取消'}
                </button>
                <button className={`btn ${typeStyles.buttonClass}`} onClick={handleConfirm}>
                  {options.confirmText || '确认'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

// 便捷函数（用于在非组件中调用）
export async function confirm(_options: ConfirmOptions): Promise<boolean> {
  // 这个函数需要在 ConfirmProvider 包裹的组件树中使用 useConfirm hook
  throw new Error('confirm function must be called within a component wrapped by ConfirmProvider');
}
