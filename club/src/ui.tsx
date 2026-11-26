// Piezas comunes del panel de clubes: cabecera, marca, avisos y secciones aún no disponibles.
import { Lock, LogOut } from 'lucide-react';
import type { ReactNode } from 'react';

export function Brand() {
  return (
    <a className="brand club-brand" href="#/" aria-label="GalipauStats · Clubes, inicio">
      <span className="brand-name">
        Galipau<span>Stats</span>
      </span>
      <span className="club-brand-tag">Clubes</span>
    </a>
  );
}

export function Header({ children, email, onSignOut }: { children?: ReactNode; email?: string; onSignOut?: () => void }) {
  return (
    <header className="topbar club-topbar">
      <Brand />
      <div className="club-topbar-side">
        {children}
        {email && onSignOut && (
          <div className="club-account">
            <span className="club-account-email" title={email}>
              {email}
            </span>
            <button type="button" className="btn btn-sm btn-ghost club-signout" onClick={onSignOut}>
              <LogOut size={16} aria-hidden="true" />
              Cerrar sesión
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

export function Page({ children, header }: { children: ReactNode; header: ReactNode }) {
  return (
    <div className="screen club-screen">
      {header}
      <main className="content">{children}</main>
    </div>
  );
}

export function ErrorBox({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="form-error" role="alert">
      {message}
    </p>
  );
}

/**
 * Parte del panel que todavía no existe en el servidor. Sin formularios ni botones
 * que aparenten guardar nada: solo explica qué llegará.
 */
export function ComingSoon({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card club-soon" aria-label={`${title} (no disponible todavía)`}>
      <h3>
        <Lock size={16} aria-hidden="true" />
        {title}
        <span className="status club-soon-tag">Próximamente</span>
      </h3>
      <p className="muted">{children}</p>
    </section>
  );
}

export function Loading({ label = 'Cargando…' }: { label?: string }) {
  return (
    <p className="empty" role="status">
      {label}
    </p>
  );
}
