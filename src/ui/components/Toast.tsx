import { useEffect, useState } from 'react';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

interface Toast {
  id: number;
  message: string;
  type: ToastType;
  duration?: number;
}

let toastId = 0;
const listeners: Set<(toasts: Toast[]) => void> = new Set();
let toasts: Toast[] = [];

function notifyListeners() {
  listeners.forEach(listener => listener([...toasts]));
}

function addToast(message: string, type: ToastType, duration: number = 3000) {
  const id = ++toastId;
  const toast: Toast = { id, message, type, duration };
  toasts.push(toast);
  notifyListeners();

  if (duration > 0) {
    setTimeout(() => {
      removeToast(id);
    }, duration);
  }

  return id;
}

function removeToast(id: number) {
  toasts = toasts.filter(t => t.id !== id);
  notifyListeners();
}

export const toast = {
  success(message: string, duration?: number) {
    addToast(message, 'success', duration);
  },
  error(message: string, duration?: number) {
    addToast(message, 'error', duration);
  },
  warning(message: string, duration?: number) {
    addToast(message, 'warning', duration);
  },
  info(message: string, duration?: number) {
    addToast(message, 'info', duration);
  },
};

export function ToastContainer() {
  const [currentToasts, setCurrentToasts] = useState<Toast[]>([]);

  useEffect(() => {
    listeners.add(setCurrentToasts);
    return () => {
      listeners.delete(setCurrentToasts);
    };
  }, []);

  const getToastStyles = (type: ToastType) => {
    const baseStyles = {
      padding: '12px 20px',
      borderRadius: '8px',
      marginBottom: '10px',
      boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      minWidth: '300px',
      maxWidth: '500px',
      animation: 'slideIn 0.3s ease-out',
    };

    const typeStyles = {
      success: {
        backgroundColor: '#d4edda',
        color: '#155724',
        border: '1px solid #c3e6cb',
      },
      error: {
        backgroundColor: '#f8d7da',
        color: '#721c24',
        border: '1px solid #f5c6cb',
      },
      warning: {
        backgroundColor: '#fff3cd',
        color: '#856404',
        border: '1px solid #ffeaa7',
      },
      info: {
        backgroundColor: '#d1ecf1',
        color: '#0c5460',
        border: '1px solid #bee5eb',
      },
    };

    return { ...baseStyles, ...typeStyles[type] };
  };

  const getIcon = (type: ToastType) => {
    const icons = {
      success: '✓',
      error: '✕',
      warning: '⚠',
      info: 'ℹ',
    };
    return icons[type];
  };

  return (
    <>
      <style>{`
        @keyframes slideIn {
          from {
            transform: translateX(100%);
            opacity: 0;
          }
          to {
            transform: translateX(0);
            opacity: 1;
          }
        }
        @keyframes slideOut {
          from {
            transform: translateX(0);
            opacity: 1;
          }
          to {
            transform: translateX(100%);
            opacity: 0;
          }
        }
      `}</style>
      <div
        style={{
          position: 'fixed',
          top: '20px',
          right: '20px',
          zIndex: 9999,
        }}
      >
        {currentToasts.map((t) => (
          <div
            key={t.id}
            style={getToastStyles(t.type)}
          >
            <span style={{ fontSize: '18px', fontWeight: 'bold' }}>{getIcon(t.type)}</span>
            <span style={{ flex: 1 }}>{t.message}</span>
            <button
              onClick={() => removeToast(t.id)}
              style={{
                background: 'none',
                border: 'none',
                color: 'inherit',
                cursor: 'pointer',
                fontSize: '18px',
                padding: '0',
                marginLeft: '10px',
                opacity: 0.6,
              }}
              onMouseEnter={(e) => e.currentTarget.style.opacity = '1'}
              onMouseLeave={(e) => e.currentTarget.style.opacity = '0.6'}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
