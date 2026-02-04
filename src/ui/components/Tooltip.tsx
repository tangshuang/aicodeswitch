import { ReactNode, useState } from 'react';
import '../styles/Tooltip.css';

interface NavItemWithTooltipProps {
  children: ReactNode;
  text: string;
  showTooltip: boolean;
}

function NavItemWithTooltip({ children, text, showTooltip }: NavItemWithTooltipProps) {
  const [isVisible, setIsVisible] = useState(false);

  return (
    <div
      className="nav-item-with-tooltip"
      onMouseEnter={() => setIsVisible(true)}
      onMouseLeave={() => setIsVisible(false)}
    >
      {children}
      {showTooltip && isVisible && (
        <div className="nav-tooltip">
          {text}
        </div>
      )}
    </div>
  );
}

export default NavItemWithTooltip;

