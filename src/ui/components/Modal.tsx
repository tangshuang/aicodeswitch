import { ReactNode } from 'react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  showCloseButton?: boolean;
  closeOnOverlayClick?: boolean;
  maxWidth?: string;
}

export function Modal({
  isOpen,
  onClose,
  title,
  children,
  showCloseButton = true,
  closeOnOverlayClick = false,
  maxWidth = '600px',
}: ModalProps) {
  if (!isOpen) {
    return null;
  }

  return (
    <div
      className="modal-overlay"
      style={{ zIndex: 1000000 }}
      onClick={(e) => {
        if (!closeOnOverlayClick) {
          e.stopPropagation();
        }
      }}
    >
      {showCloseButton && (
        <button
          type="button"
          className="modal-close-btn"
          onClick={onClose}
          aria-label="关闭"
        >
          ×
        </button>
      )}
      <div className="modal" style={{ maxWidth, width: '90%' }}>
        <div className="modal-container">
          <div className="modal-header">
            <h2>{title}</h2>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
