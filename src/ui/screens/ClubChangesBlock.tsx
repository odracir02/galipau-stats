// Recepción de los cambios del club en un equipo vinculado: cuándo se
// recibieron, «Recibir cambios», conflictos (con elección expresa) y, en las
// copias del club, quitarla del dispositivo. Discreto: solo destaca algo cuando
// hay conflictos o falta el permiso.
import { CloudDownload, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { errorMessage } from '../../app/errors';
import { teamImporter, teamPuller } from '../../app/remote';
import { navigate } from '../../app/router';
import { showToast } from '../../app/toast';
import type { Team } from '../../domain/types';
import { formatChecked } from '../../remote/session';
import type { SyncConflict, TeamLink } from '../../remote/store';
import { Icon } from '../components/Icon';
import { ConfirmSheet, Sheet } from '../components/Sheet';

const PULL_TEXT = {
  offline: 'Sin conexión: los cambios del club se recibirán al volver a tenerla.',
  forbidden: 'Ahora mismo este dispositivo no tiene acceso al equipo del club.',
  error: 'No se pudieron recibir los cambios del club.',
  busy: 'Hay un envío en curso: vuelve a intentarlo en un momento.',
} as const;

export function ClubChangesBlock({ team, link, onChanged }: { team: Team; link: TeamLink; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [conflicts, setConflicts] = useState(false);
  const [removing, setRemoving] = useState<{ pending: boolean } | null>(null);
  const list = link.conflicts ?? [];

  const receive = async () => {
    if (!teamPuller) return;
    setBusy(true);
    try {
      const r = await teamPuller.pull(team.id);
      if (r.status === 'ok') showToast(r.applied > 0 ? 'Cambios del club recibidos' : 'Ya estaba al día con el club');
      else if (r.status !== 'skipped') showToast(PULL_TEXT[r.status], r.status === 'busy' ? 'info' : 'error');
      onChanged();
    } catch (e) {
      showToast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {link.accessLost && (
        <p className="notice" role="status">
          <Icon as={TriangleAlert} size={18} />
          Este dispositivo ya no tiene permiso de entrenador en el equipo del club. Los cambios sin enviar se conservan aquí,
          bloqueados, hasta recuperar el permiso (vuelve a unirte con el código de entrenador).
        </p>
      )}
      {list.length > 0 && (
        <div className="notice" role="status">
          <Icon as={TriangleAlert} size={18} />
          <span>
            {list.length === 1 ? 'Hay 1 dato cambiado' : `Hay ${list.length} datos cambiados`} aquí y en el club a la vez. No se
            ha mezclado nada: elige cuál conservar.
          </span>
          <button type="button" className="btn btn-sm" onClick={() => setConflicts(true)}>
            Revisar
          </button>
        </div>
      )}
      {!link.accessLost && (
        <p className="hint club-receive">
          {link.refreshedAt ? `Cambios del club recibidos ${formatChecked(link.refreshedAt)}` : 'Todavía no se han recibido cambios del club.'}
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => void receive()} disabled={busy}>
            <Icon as={CloudDownload} size={16} />
            {busy ? 'Recibiendo…' : 'Recibir cambios'}
          </button>
        </p>
      )}
      {link.origin === 'imported' && (
        <button
          type="button"
          className="btn btn-ghost btn-block"
          onClick={async () => setRemoving({ pending: (await teamImporter?.hasLocalChanges(team.id)) ?? false })}
        >
          Quitar este equipo del dispositivo
        </button>
      )}
      {conflicts && <ConflictsSheet team={team} conflicts={list} onClose={() => setConflicts(false)} onChanged={onChanged} />}
      {removing && (
        <ConfirmSheet
          title="Quitar del dispositivo"
          message={
            <>
              <p>
                Se borrará de este dispositivo <strong>{team.name}</strong>. En el club no cambia nada y no se volverá a añadir solo:
                podrás añadirlo de nuevo desde «Equipos del club».
              </p>
              {removing.pending && (
                <p className="notice">Hay cambios hechos aquí que todavía no están en el club: se perderán. Envíalos antes si quieres conservarlos.</p>
              )}
            </>
          }
          confirmLabel="Quitar"
          danger
          onCancel={() => setRemoving(null)}
          onConfirm={async () => {
            try {
              await teamImporter?.discard(team.id, { dismiss: true });
              showToast('Equipo quitado de este dispositivo', 'info');
              navigate({ name: 'teams' }, { replace: true });
            } catch (e) {
              setRemoving(null);
              showToast(errorMessage(e), 'error');
            }
          }}
        />
      )}
    </>
  );
}

/** Conflictos: cada dato, con la elección expresa entre el de este dispositivo y el del club. */
function ConflictsSheet({ team, conflicts, onClose, onChanged }: { team: Team; conflicts: SyncConflict[]; onClose: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  /** Elección pendiente de confirmar: hasta entonces no se sustituye nada. */
  const [asking, setAsking] = useState<{ conflict: SyncConflict; choice: 'club' | 'mine'; pendingEvents: number } | null>(null);
  /** Abre la confirmación; si el club eliminó un partido, cuenta sus acciones sin enviar aquí. */
  const ask = async (conflict: SyncConflict, choice: 'club' | 'mine') => {
    const deletes = conflict.entity === 'match' && (conflict.server.record as { deletedAt?: string | null }).deletedAt != null;
    const pendingEvents = choice === 'club' && deletes ? ((await teamPuller?.pendingEventsIn(team.id, conflict.entityId)) ?? 0) : 0;
    setAsking({ conflict, choice, pendingEvents });
  };
  const choose = async (c: SyncConflict, choice: 'club' | 'mine') => {
    setAsking(null);
    setBusy(c.key);
    try {
      await teamPuller?.resolve(team.id, c.key, choice);
      showToast(choice === 'club' ? 'Se ha conservado la versión del club' : 'Se conservará la de este dispositivo al enviar');
      onChanged();
    } catch (e) {
      showToast(errorMessage(e), 'error');
    } finally {
      setBusy(null);
    }
  };
  return (
    <Sheet title="Cambios en conflicto" onClose={onClose}>
      <p className="hint">
        Estos datos se han cambiado en este dispositivo y en el club a la vez. Elige en cada uno cuál conservar: «la del club»
        sustituye la de aquí; «la mía» se enviará sustituyendo la del club.
      </p>
      {conflicts.length === 0 && <p>No queda ninguno.</p>}
      <ul className="list">
        {conflicts.map((c) => (
          <li key={c.key} className="conflict-row">
            <strong>{c.label}</strong>
            <span className="conflict-actions">
              <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void ask(c, 'club')}>
                Quedarme con la del club
              </button>
              <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void ask(c, 'mine')}>
                Quedarme con la mía
              </button>
            </span>
          </li>
        ))}
      </ul>
      {asking && (
        <ConfirmSheet
          title={asking.choice === 'club' ? 'Quedarme con la del club' : 'Quedarme con la mía'}
          message={
            <>
              <p>
                <strong>{asking.conflict.label}</strong>
              </p>
              {asking.choice === 'club' ? (
                <>
                  <p>
                    Se descartará el cambio hecho en este dispositivo en este dato y se usará el del club. No se envía nada y
                    los demás datos no cambian. Se guarda en el dispositivo una copia del dato descartado.
                  </p>
                  {asking.pendingEvents > 0 && (
                    <p className="notice">
                      El club ha eliminado este partido. Las {asking.pendingEvents} acciones registradas aquí sin enviar se quedarán
                      guardadas en este dispositivo, pero no se enviarán.
                    </p>
                  )}
                </>
              ) : (
                <p>
                  El cambio de este dispositivo se enviará y sustituirá el del club. Si el club lo vuelve a cambiar antes del envío,
                  aparecerá otro conflicto y no se sustituirá nada.
                </p>
              )}
            </>
          }
          confirmLabel={asking.choice === 'club' ? 'Usar la del club' : 'Usar la mía'}
          danger
          onCancel={() => setAsking(null)}
          onConfirm={() => void choose(asking.conflict, asking.choice)}
        />
      )}
    </Sheet>
  );
}
