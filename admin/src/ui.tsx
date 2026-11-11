// Piezas comunes de las pantallas del panel: cabecera, pantalla, campos y avisos.
import { ChevronLeft, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { go } from './hooks';

export function TopBar({ title, subtitle, back }: { title: string; subtitle?: string; back?: string }) {
  return (
    <header className="topbar">
      {back && (
        <button type="button" className="icon-btn" onClick={() => go(back)} aria-label="Volver">
          <ChevronLeft size={24} aria-hidden="true" />
        </button>
      )}
      <div className="topbar-title">
        <h1>{title}</h1>
        {subtitle && <span>{subtitle}</span>}
      </div>
    </header>
  );
}

export function Screen({ title, subtitle, back, children }: { title: string; subtitle?: string; back?: string; children?: ReactNode }) {
  return (
    <div className="screen">
      <TopBar title={title} subtitle={subtitle} back={back} />
      <main className="content">{children}</main>
    </div>
  );
}

export function WritesDisabled() {
  return (
    <p className="notice">
      <ShieldCheck size={18} aria-hidden="true" />
      Las operaciones de escritura (crear, editar, suspender y gestionar códigos) están desactivadas en este entorno hasta
      completar la verificación de seguridad.
    </p>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label>
      {label}
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

/** Error de una escritura; ante un conflicto, cómo seguir (sin repetirla). */
export function ActionError({ action, onReload }: { action: { error: string | null; conflict: boolean }; onReload?: () => void }) {
  if (!action.error) return null;
  return (
    <div className="form-error" role="alert">
      <span>{action.error}</span>
      {action.conflict && onReload && (
        <button type="button" className="btn btn-sm" onClick={onReload}>
          Ver los datos actuales
        </button>
      )}
    </div>
  );
}
