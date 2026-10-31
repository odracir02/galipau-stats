import { ChevronRight, DatabaseBackup, Plus } from 'lucide-react';
import { useState } from 'react';
import { remote } from '../../app/remote';
import { repo } from '../../app/repo';
import { useImportedTeam } from '../../app/useImportedTeam';
import { navigate } from '../../app/router';
import { useLoad } from '../../app/useLoad';
import { Icon } from '../components/Icon';
import { Brand } from '../components/Logo';
import { TopBar } from '../components/TopBar';
import { BackupSheet } from './BackupSheet';
import { OngoingMatchBanner } from './OngoingMatchBanner';
import { RemoteTeamsSection } from './RemoteTeamsSection';
import { TeamFormSheet } from './TeamFormSheet';

export function TeamsScreen() {
  const teams = useLoad(() => repo.listTeams(), []);
  const [creating, setCreating] = useState(false);
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
            <span>Crea tu equipo y añade su plantilla para empezar a registrar partidos.</span>
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
        <button type="button" className="btn btn-primary btn-block" onClick={() => setCreating(true)}>
          <Icon as={Plus} />
          Nuevo equipo
        </button>
        <RemoteTeamsSection />
      </main>
      {backup && <BackupSheet onClose={() => setBackup(false)} />}
      {creating && (
        <TeamFormSheet
          onClose={() => setCreating(false)}
          onSaved={(team) => {
            setCreating(false);
            navigate({ name: 'team', teamId: team.id });
          }}
        />
      )}
    </div>
  );
}

/** Marca de las copias del club en la lista de equipos del dispositivo. */
function ImportedMark({ teamId }: { teamId: string }) {
  const link = useImportedTeam(teamId);
  return link ? <> · Copia del club (solo lectura)</> : null;
}
