// Equipos del club a los que este dispositivo tiene acceso con un código. Es
// una sección separada de los equipos guardados en el dispositivo: no los
// sustituye, no los mezcla y no los modifica.
import { ChevronRight, CloudOff, KeyRound, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { remote } from '../../app/remote';
import { navigate } from '../../app/router';
import { useRemote } from '../../app/useRemote';
import { formatChecked, ROLE_LABEL } from '../../remote/session';
import { Icon } from '../components/Icon';
import { DeviceSessionSheet } from './DeviceSessionSheet';
import { JoinSheet } from './JoinSheet';

export function RemoteTeamsSection() {
  const state = useRemote(remote);
  const [joining, setJoining] = useState(false);
  const [account, setAccount] = useState(false);

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
    </section>
  );
}
