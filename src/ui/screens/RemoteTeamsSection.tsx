// Equipos del club a los que este dispositivo tiene acceso con un código. Es
// una sección separada de los equipos guardados en el dispositivo: no los
// sustituye, no los mezcla y no los modifica. Con permiso de entrenador, se
// puede copiar un equipo del club en el dispositivo («Trabajar con este equipo
// aquí»), salvo que ya esté vinculado con uno de sus equipos.
import { ChevronRight, CloudDownload, CloudOff, KeyRound, Link2, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { remote, teamImporter } from '../../app/remote';
import { navigate } from '../../app/router';
import { useRemote } from '../../app/useRemote';
import type { RemoteTeam } from '../../remote/api';
import type { ImportState } from '../../remote/importer';
import { formatChecked, ROLE_LABEL } from '../../remote/session';
import { Icon } from '../components/Icon';
import { DeviceSessionSheet } from './DeviceSessionSheet';
import { ImportTeamSheet } from './ImportTeamSheet';
import { JoinSheet } from './JoinSheet';

export function RemoteTeamsSection() {
  const state = useRemote(remote);
  const [joining, setJoining] = useState(false);
  const [account, setAccount] = useState(false);
  const [importing, setImporting] = useState<{ team: RemoteTeam; state: ImportState } | null>(null);
  const imports = useImportStates(state.teams);

  // Al abrir la pantalla y al recuperar la conexión se comprueban los permisos con el servidor.
  useEffect(() => {
    if (!remote) return;
    void remote.whenReady().then(() => remote?.refresh());
    const onOnline = () => void remote?.refresh();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, []);

  if (!remote) return null;

  return (
    <section className="remote-section" aria-labelledby="remote-title">
      <h2 id="remote-title" className="section-title">
        Equipos del club
      </h2>
      {state.revoked && (
        <div className="notice" role="status">
          <span>
            La sesión de este dispositivo ya no es válida (se cerró o se retiró el acceso). Los equipos y partidos guardados
            en el dispositivo no han cambiado. Puedes volver a unirte con un código.
          </span>
          <button type="button" className="btn btn-sm" onClick={() => remote?.dismissRevoked()}>
            Entendido
          </button>
        </div>
      )}
      {state.problem && state.teams.length > 0 && (
        <p className="hint remote-offline">
          <Icon as={CloudOff} size={16} />
          {state.problem === 'offline' ? 'Sin conexión' : 'El servidor no responde'}: se muestra la última comprobación
          {state.checkedAt ? ` (${formatChecked(state.checkedAt)})` : ''}.
        </p>
      )}
      {state.teams.length === 0 ? (
        <p className="hint">
          Si el club te ha dado un código de entrenador o de consulta, úsalo para acceder al equipo. Los equipos de este
          dispositivo no se ven afectados.
        </p>
      ) : (
        <ul className="list">
          {state.teams.map((t) => (
            <li key={t.teamId}>
              <button
                type="button"
                className={`list-item ${t.status === 'active' ? '' : 'inactive'}`}
                onClick={() => navigate({ name: 'remoteTeam', teamId: t.teamId })}
              >
                <span className="list-main">
                  <strong>{t.name}</strong>
                  <span className="muted">
                    {t.clubName} · Temporada {t.season}
                    {t.status === 'active' ? '' : ' · No disponible'}
                  </span>
                </span>
                <span className={`status status-${t.role}`}>{ROLE_LABEL[t.role]}</span>
                <Icon as={ChevronRight} className="chevron" />
              </button>
              <ImportAction team={t} state={imports.get(t.teamId)} onImport={(st) => setImporting({ team: t, state: st })} />
            </li>
          ))}
        </ul>
      )}
      <div className="remote-actions">
        <button type="button" className="btn btn-block" onClick={() => setJoining(true)}>
          <Icon as={KeyRound} />
          Unirse con código
        </button>
        {state.linked && (
          <button type="button" className="btn btn-ghost btn-block" onClick={() => setAccount(true)}>
            <Icon as={UserRound} />
            Sesión de este dispositivo
          </button>
        )}
      </div>
      {joining && <JoinSheet onClose={() => setJoining(false)} />}
      {account && <DeviceSessionSheet onClose={() => setAccount(false)} />}
      {importing && (
        <ImportTeamSheet
          team={importing.team}
          state={importing.state}
          onClose={() => setImporting(null)}
          onOpen={(localTeamId) => {
            setImporting(null);
            navigate({ name: 'team', teamId: localTeamId });
          }}
        />
      )}
    </section>
  );
}

/** Situación de cada equipo del club en este dispositivo (se recalcula al cambiar las copias). */
function useImportStates(teams: readonly RemoteTeam[]): Map<string, ImportState> {
  const [states, setStates] = useState(new Map<string, ImportState>());
  const [version, setVersion] = useState(0);
  useEffect(() => teamImporter?.subscribe(() => setVersion((v) => v + 1)), []);
  useEffect(() => {
    if (!teamImporter) return;
    let alive = true;
    void Promise.all(teams.map(async (t) => [t.teamId, await teamImporter!.state(t.teamId)] as const)).then((list) => {
      if (alive) setStates(new Map(list));
    });
    return () => {
      alive = false;
    };
  }, [teams, version]);
  return states;
}

/** Acción de entrenador bajo cada equipo: copiarlo, abrir su copia o el equipo vinculado. */
function ImportAction({ team, state, onImport }: { team: RemoteTeam; state: ImportState | undefined; onImport: (s: ImportState) => void }) {
  if (!state || team.role !== 'coach') return null;
  switch (state.kind) {
    case 'available':
      return (
        <button type="button" className="btn btn-sm remote-import" onClick={() => onImport(state)}>
          <Icon as={CloudDownload} size={16} />
          Trabajar con este equipo aquí
        </button>
      );
    case 'pending':
      return (
        <button type="button" className="btn btn-sm remote-import" onClick={() => onImport(state)}>
          <Icon as={CloudDownload} size={16} />
          Importación sin terminar
        </button>
      );
    case 'imported':
      return (
        <button type="button" className="btn btn-sm btn-ghost remote-import" onClick={() => navigate({ name: 'team', teamId: state.link.localTeamId })}>
          <Icon as={Link2} size={16} />
          Copia en este dispositivo (solo lectura) · Abrir
        </button>
      );
    case 'linked':
      return (
        <button type="button" className="btn btn-sm btn-ghost remote-import" onClick={() => navigate({ name: 'team', teamId: state.link.localTeamId })}>
          <Icon as={Link2} size={16} />
          Vinculado con un equipo de este dispositivo · Abrir
        </button>
      );
    default:
      return null;
  }
}
