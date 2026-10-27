import { ChevronRight, Plus } from 'lucide-react';
import { useState } from 'react';
import { repo } from '../../app/repo';
import { navigate } from '../../app/router';
import { useLoad } from '../../app/useLoad';
import { Icon } from '../components/Icon';
import { Brand } from '../components/Logo';
import { TopBar } from '../components/TopBar';
import { OngoingMatchBanner } from './OngoingMatchBanner';
import { TeamFormSheet } from './TeamFormSheet';

export function TeamsScreen() {
  const teams = useLoad(() => repo.listTeams(), []);
  const [creating, setCreating] = useState(false);

  return (
    <div className="screen">
      <TopBar title={<Brand />} subtitle="Estadísticas de balonmano" />
      <main className="content">
        <OngoingMatchBanner />
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
      </main>
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
