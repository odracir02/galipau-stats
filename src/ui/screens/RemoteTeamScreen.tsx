// Equipo del club al que este dispositivo tiene acceso por código. Por ahora
// solo muestra su información básica y el permiso concedido por el servidor:
// los partidos llegarán con la sincronización. Es independiente de los equipos
// guardados en el dispositivo.
import { Info } from 'lucide-react';
import { useState } from 'react';
import { errorMessage } from '../../app/errors';
import { remote } from '../../app/remote';
import { navigate } from '../../app/router';
import { showToast } from '../../app/toast';
import { useRemote } from '../../app/useRemote';
import { formatChecked, ROLE_LABEL } from '../../remote/session';
import { Icon } from '../components/Icon';
import { ConfirmSheet } from '../components/Sheet';
import { TopBar } from '../components/TopBar';
import { KV } from '../stats/StatTables';

const ROLE_HELP = {
  coach: 'Podrás registrar los partidos de este equipo cuando se active la sincronización. Hasta entonces no se envía nada al servidor.',
  viewer: 'Puedes consultar la información del equipo. No puedes modificarla.',
} as const;

export function RemoteTeamScreen({ teamId }: { teamId: string }) {
  const state = useRemote(remote);
  const [leaving, setLeaving] = useState(false);
  const team = state.teams.find((t) => t.teamId === teamId);
  const back = () => navigate({ name: 'teams' });

  if (!remote || (state.ready && !team)) {
    return (
      <div className="screen">
        <TopBar title="Equipo del club" back={back} />
        <main className="content">
          <p className="empty">Este dispositivo no tiene acceso a ese equipo.</p>
        </main>
      </div>
    );
  }
  if (!team) return <div className="screen" />;

  return (
    <div className="screen">
      <TopBar title={team.name} subtitle={`${team.clubName} · Temporada ${team.season}`} back={back} />
      <main className="content">
        {team.status !== 'active' && (
          <p className="notice">El club no está activo ahora mismo. Los datos del equipo no están disponibles.</p>
        )}
        <section className="card">
          <h3>Equipo del club</h3>
          <dl className="kv">
            <KV k="Club" v={team.clubName} />
            <KV k="Equipo" v={team.name} />
            <KV k="Código del equipo" v={team.code} />
            <KV k="Temporada" v={team.season} />
            <KV k="Tu permiso" v={<span className={`status status-${team.role}`}>{ROLE_LABEL[team.role]}</span>} />
          </dl>
          <p className="hint">{ROLE_HELP[team.role]}</p>
          {state.checkedAt && (
            <p className="hint">
              Permiso comprobado con el servidor: {formatChecked(state.checkedAt)}
              {state.problem ? ' (sin conexión ahora)' : ''}.
            </p>
          )}
        </section>
        <div className="empty-card">
          <Icon as={Info} size={24} />
          <strong>Todavía no hay partidos sincronizados</strong>
          <span>
            La plantilla y los partidos de este equipo aparecerán aquí cuando se active la sincronización. Este equipo es
            independiente de los equipos guardados en este dispositivo.
          </span>
        </div>
        <button type="button" className="btn btn-danger-outline btn-block" onClick={() => setLeaving(true)}>
          Salir de este equipo
        </button>
      </main>
      {leaving && (
        <ConfirmSheet
          title="Salir del equipo"
          message={
            <>
              <p>
                Este dispositivo dejará de tener acceso a <strong>{team.name}</strong> ({team.clubName}). Para volver
                necesitarás un código.
              </p>
              <p>Los equipos y partidos guardados en este dispositivo no cambian.</p>
            </>
          }
          confirmLabel="Salir del equipo"
          danger
          onCancel={() => setLeaving(false)}
          onConfirm={async () => {
            try {
              await remote?.leave(team.teamId);
              showToast('Has salido del equipo', 'info');
              navigate({ name: 'teams' }, { replace: true });
            } catch (e) {
              setLeaving(false);
              showToast(errorMessage(e), 'error');
            }
          }}
        />
      )}
    </div>
  );
}
