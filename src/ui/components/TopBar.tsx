import type { ReactNode } from 'react';

interface TopBarProps {
  title: string;
  subtitle?: string;
  back?: () => void;
  actions?: ReactNode;
}

export function TopBar({ title, subtitle, back, actions }: TopBarProps) {
  return (
    <header className="topbar">
      {back && (
        <button type="button" className="icon-btn" onClick={back} aria-label="Volver">
          ←
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
