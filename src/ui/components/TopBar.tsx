import { ChevronLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { Icon } from './Icon';

interface TopBarProps {
  title: ReactNode;
  subtitle?: string;
  back?: () => void;
  actions?: ReactNode;
}

export function TopBar({ title, subtitle, back, actions }: TopBarProps) {
  return (
    <header className="topbar">
      {back && (
        <button type="button" className="icon-btn" onClick={back} aria-label="Volver">
          <Icon as={ChevronLeft} size={24} />
        </button>
      )}
      <div className="topbar-title">
        <h1>{title}</h1>
        {subtitle && <span>{subtitle}</span>}
      </div>
      {actions}
    </header>
  );
}
