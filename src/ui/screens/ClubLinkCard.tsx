// Tarjeta «Servidor del club» en un equipo local: vincularlo con un equipo del
// club y enviar sus datos a mano. Solo aparece si este dispositivo tiene permiso
// de entrenador en algún equipo del club o si el equipo ya está vinculado.
import { CloudUpload, Link2 } from 'lucide-react';
import { useState } from 'react';
import { errorMessage } from '../../app/errors';
import { autoSync, clubSync, remote } from '../../app/remote';
import { showToast } from '../../app/toast';
import { useLoad } from '../../app/useLoad';
import { useRemote } from '../../app/useRemote';
import type { Team } from '../../domain/types';
import { formatChecked } from '../../remote/session';
import type { TeamLink, UploadRecord } from '../../remote/store';
import { pendingTotal, type PendingChanges } from '../../remote/upload';
import { Icon } from '../components/Icon';
import { SyncIndicator } from '../match/SyncIndicator';
import { ConfirmSheet } from '../components/Sheet';
import { ImportedTeamCard } from './ImportedTeamCard';
import { LinkSheet } from './LinkSheet';
import { UploadSheet } from './UploadSheet';

const STATUS_TEXT: Record<UploadRecord['status'], string> = {
  running: 'Envío sin terminar',
  verified: 'Sincronización completada',
  sent: 'Enviado',
  differences: 'Enviado con diferencias',
  interrupted: 'Envío interrumpido',
  stopped: 'Envío detenido',
};

export function ClubLinkCard({ team, onDataChanged }: { team: Team; onDataChanged?: () => void }) {
  const session = useRemote(remote);
  const [sheet, setSheet] = useState<'link' | 'upload' | 'unlink' | null>(null);
  /** Cambios sin enviar al activar el envío automático: se confirman antes del primer envío. */
  const [confirmAuto, setConfirmAuto] = useState<PendingChanges | null>(null);
  const [autoError, setAutoError] = useState<string | null>(null);
  const info = useLoad(async (): Promise<{ link: TeamLink | null; last: UploadRecord | null; sent: boolean } | null> => {
    if (!clubSync) return null;
    const link = await clubSync.getLink(team.id);
    return { link, last: await clubSync.lastUpload(team.id), sent: link ? await clubSync.hasSent(link) : false };
  }, [team.id]);
  const load = info.reload;

  if (!clubSync || !info.data) return null;
  const { link, last, sent } = info.data;
  // Copia del club importada en este dispositivo: tarjeta propia (solo lectura).
  if (link?.origin === 'imported') {
    return (
      <ImportedTeamCard
        team={team}
        link={link}
        onChanged={() => {
          load();
          onDataChanged?.();
        }}
      />
    );
  }
  const writable = session.teams.some((t) => t.role === 'coach' && t.status === 'active');
  if (!link && !writable) return null;
  const canSend = link ? session.teams.some((t) => t.teamId === link.remoteTeamId && t.role === 'coach' && t.status === 'active') : false;

  return (
    <section className="card club-card" aria-label="Servidor del club">
      <h3>Servidor del club</h3>
      {!link ? (
        <>
          <p className="hint">
            Este equipo solo está en este dispositivo. Puedes vincularlo con un equipo del club para enviar después sus datos.
            Vincular no envía nada ni cambia nada aquí.
          </p>
          <button type="button" className="btn btn-block" onClick={() => setSheet('link')}>
            <Icon as={Link2} />
            Vincular con un equipo del club
          </button>
        </>
      ) : (
        <>
          <p className="club-link">
            <Icon as={Link2} size={18} />
            <span>
              Vinculado con <strong>{link.remoteTeamName}</strong> · {link.clubName} · {link.remoteSeason}
            </span>
          </p>
          {last && (
            <p className={`hint club-last club-last-${last.status}`}>
              {STATUS_TEXT[last.status]} · {formatChecked(last.finishedAt ?? last.startedAt)}
            </p>
          )}
          {!canSend && (
            <p className="hint">Ahora mismo este dispositivo no tiene permiso de entrenador en ese equipo: no se puede enviar.</p>
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={link.auto === true}
              disabled={!canSend && link.auto !== true}
              onChange={(e) => {
                setAutoError(null);
                if (!e.target.checked) {
                  void autoSync?.setEnabled(team.id, false).then(load);
                  return;
                }
                // Activar: si hay cambios sin enviar, se muestran y se confirman antes del primer envío.
                void (async () => {
                  try {
                    const plan = await clubSync!.preview(team.id);
                    if (plan.problems.length > 0) {
                      setAutoError(`No se puede activar: hay datos que el servidor no aceptaría (${plan.problems[0]}). Revisa «Enviar al servidor».`);
                      return;
                    }
                    const pending = await clubSync!.pending(team.id);
                    if (pendingTotal(pending) > 0) setConfirmAuto(pending);
                    else await autoSync?.setEnabled(team.id, true);
                  } catch (err) {
                    setAutoError(errorMessage(err));
                  }
                  load();
                })();
              }}
            />
            Envío automático de los cambios
          </label>
          {link.auto !== true && (
            <p className="hint">Desactivado: los cambios solo se envían con «Enviar al servidor».</p>
          )}
          {autoError && (
            <p className="form-error" role="alert">
              {autoError}
            </p>
          )}
          {link.auto === true && <SyncIndicator teamId={team.id} variant="text" />}
          {link.autoBlocked && (
            <p className="hint">
              El envío automático se ha detenido para no sobrescribir nada. Revisa el aviso y usa «Enviar al servidor»: si
              termina con «Sincronización completada», se reanuda solo.
            </p>
          )}
          <button type="button" className="btn btn-primary btn-block" disabled={!canSend} onClick={() => setSheet('upload')}>
            <Icon as={CloudUpload} />
            Enviar al servidor
          </button>
          {!sent && (
            <button type="button" className="btn btn-ghost btn-block" onClick={() => setSheet('unlink')}>
              Deshacer el vínculo
            </button>
          )}
        </>
      )}
      {sheet === 'link' && (
        <LinkSheet
          team={team}
          onClose={() => setSheet(null)}
          onLinked={() => {
            setSheet(null);
            showToast('Equipo vinculado. No se ha enviado nada.');
            load();
          }}
        />
      )}
      {sheet === 'upload' && (
        <UploadSheet
          team={team}
          onClose={() => {
            setSheet(null);
            load();
            // Tras un envío manual, el envío automático vuelve a mirar (y se reanuda si estaba detenido).
            void autoSync?.checkAll();
          }}
        />
      )}
      {confirmAuto && (
        <ConfirmSheet
          title="Activar el envío automático"
          message={
            <>
              <p>Hay cambios en este dispositivo que todavía no están en el servidor del club:</p>
              <ul className="problem-list">
                {confirmAuto.players > 0 && <li>{confirmAuto.players} jugadores</li>}
                {confirmAuto.matches > 0 && <li>{confirmAuto.matches} partidos (datos, convocatoria o cronómetro)</li>}
                {confirmAuto.events > 0 && <li>{confirmAuto.events} acciones</li>}
                {confirmAuto.matchDeletions > 0 && <li>{confirmAuto.matchDeletions} partidos eliminados en este dispositivo</li>}
              </ul>
              <p>
                Al activarlo se enviarán ahora y, a partir de entonces, cada cambio se enviará solo, sin más confirmaciones. Lo
                que ya está en el servidor y no ha cambiado no se vuelve a enviar.
              </p>
            </>
          }
          confirmLabel="Activar y enviar"
          onCancel={() => setConfirmAuto(null)}
          onConfirm={async () => {
            setConfirmAuto(null);
            await autoSync?.setEnabled(team.id, true);
            load();
          }}
        />
      )}
      {sheet === 'unlink' && link && (
        <ConfirmSheet
          title="Deshacer el vínculo"
          message={<p>«{team.name}» dejará de estar vinculado con {link.remoteTeamName}. No se ha enviado nada, así que nada cambia.</p>}
          confirmLabel="Deshacer"
          onCancel={() => setSheet(null)}
          onConfirm={async () => {
            try {
              await clubSync?.unlink(team.id);
              showToast('Vínculo deshecho', 'info');
            } catch (e) {
              showToast(errorMessage(e), 'error');
            }
            setSheet(null);
            load();
          }}
        />
      )}
    </section>
  );
}
