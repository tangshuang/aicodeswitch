import { ReactNode, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import '../styles/Tooltip.css';

interface NavItemWithTooltipProps {
  children: ReactNode;
  text: string;
  showTooltip: boolean;
}

function NavItemWithTooltip({ children, text, showTooltip }: NavItemWithTooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const handleMouseEnter = () => {
    if (!showTooltip) return;
    // 通过 Portal 渲染到 body，需基于触发元素的位置计算 fixed 坐标，
    // 这样 tooltip 不受任何祖先 overflow（如折叠态滚动容器）裁切影响
    if (wrapperRef.current) {
      const rect = wrapperRef.current.getBoundingClientRect();
      setCoords({ left: rect.right + 12, top: rect.top + rect.height / 2 });
    }
    setIsVisible(true);
  };

  const handleMouseLeave = () => {
    setIsVisible(false);
  };

  return (
    <div
      ref={wrapperRef}
      className="nav-item-with-tooltip"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}
      {showTooltip && isVisible && coords && createPortal(
        <div
          className="nav-tooltip"
          style={{ left: coords.left, top: coords.top }}
        >
          {text}
        </div>,
        document.body
      )}
    </div>
  );
}

export default NavItemWithTooltip;
