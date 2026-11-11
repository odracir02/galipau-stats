import { ChevronRight, DatabaseBackup, Smartphone } from 'lucide-react';
import { useEffect, useState } from 'react';
import { remote, teamImporter } from '../../app/remote';
import { repo } from '../../app/repo';
import { useImportedTeam } from '../../app/useImportedTeam';
import { navigate, routeHref } from '../../app/router';
import { useLoad } from '../../app/useLoad';
import { Icon } from '../components/Icon';
import { Brand } from '../components/Logo';
import { TopBar } from '../components/TopBar';
import { BackupSheet } from './BackupSheet';
import { OngoingMatchBanner } from './OngoingMatchBanner';
import { RemoteTeamsSection } from './RemoteTeamsSection';

export function TeamsScreen() {
  // Cambia cuando se prepara (o se quita) un equipo del club en este dispositivo.
  const [copies, setCopies] = useState(0);
  useEffect(() => teamImporter?.subscribe(() => setCopies((v) => v + 1)), []);
  const teams = useLoad(() => repo.listTeams(), [copies]);
  const [backup, setBackup] = useState(false);

  return (
    <div className="screen">
      <TopBar
        title={<Brand />}
        subtitle="Estadísticas de balonmano"
        actions={
          <button type="button" className="icon-btn" onClick={() => setBackup(true)} aria-label="Copia de seguridad">
            <Icon as={DatabaseBackup} />
          </button>
        }
      />
      <main className="content">
        <OngoingMatchBanner />
        {remote && (
          <h2 className="section-title" id="local-title">
            En este dispositivo
          </h2>
        )}
        {teams.error && <p className="form-error">{teams.error}</p>}
        {teams.data?.length === 0 && (
          <div className="empty-card">
            <strong>Todavía no hay equipos en este dispositivo</strong>
            <span>Los equipos de tu club aparecerán aquí cuando te unas con el código que te dé el club.</span>
          </div>
        )}
        <ul className="list">
          {teams.data?.map((t) => (
            <li key={t.id}>
              <button type="button" className="list-item" onClick={() => navigate({ name: 'team', teamId: t.id })}>
                <span className="list-main">
                  <strong>{t.name}</strong>
                  <span className="muted">
                    {t.code} · Temporada {t.season}
                    <ImportedMark teamId={t.id} />
                  </span>
                </span>
                <Icon as={ChevronRight} className="chevron" />
              </button>
            </li>
          ))}
        </ul>
        {/* Sin «Nuevo equipo»: los equipos los creará el club desde su panel de administración. */}
        <RemoteTeamsSection />
        <a className="install-link" href={routeHref({ name: 'install' })}>
          <Icon as={Smartphone} size={18} />
          ¿Cómo instalar GalipauStats?
        </a>
      </main>
      {backup && <BackupSheet onClose={() => setBackup(false)} />}
    </div>
  );
}

/** Marca discreta de un equipo del club que está bloqueado en este dispositivo. */
function ImportedMark({ teamId }: { teamId: string }) {
  const link = useImportedTeam(teamId);
  if (link?.accessLost) return <> · Sin permiso del club: cambios guardados aquí</>;
  if (link?.importState === 'pending') return <> · Preparándose</>;
  return null;
}
