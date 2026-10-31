// Tarjeta «Servidor del club» en un equipo local: vincularlo con un equipo del
// club y ver el estado de la sincronización, que es automática. Cuando algo
// requiere atención ofrece la acción que corresponde; el envío y la recepción
// manuales quedan en «Opciones avanzadas». Solo aparece si este dispositivo
// tiene permiso de entrenador en algún equipo del club o si ya está vinculado.
import { CloudUpload, Link2, RotateCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { errorMessage } from '../../app/errors';
import { autoSync, clubSync, remote, teamImporter } from '../../app/remote';
import { showToast } from '../../app/toast';
import { useLoad } from '../../app/useLoad';
import { useRemote } from '../../app/useRemote';
import { useAutoSync } from '../../app/useAutoSync';
import { useRemoteRevision } from '../../app/useTeamSync';
import type { Team } from '../../domain/types';
import { formatChecked } from '../../remote/session';
import type { TeamLink, UploadRecord } from '../../remote/store';
import { Icon } from '../components/Icon';
import { SyncIndicator } from '../match/SyncIndicator';
import { ConfirmSheet } from '../components/Sheet';
import { ClubChangesBlock } from './ClubChangesBlock';
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
  const auto = useAutoSync(autoSync, team.id);
  // Se vuelve a leer cuando llegan cambios del club (conflictos, permiso, cursor…).
  const revision = useRemoteRevision(team.id);
  const [copies, setCopies] = useState(0);
  useEffect(() => teamImporter?.subscribe(() => setCopies((v) => v + 1)), []);
  const info = useLoad(async (): Promise<{ link: TeamLink | null; last: UploadRecord | null; sent: boolean } | null> => {
    if (!clubSync) return null;
    const link = await clubSync.getLink(team.id);
    return { link, last: await clubSync.lastUpload(team.id), sent: link ? await clubSync.hasSent(link) : false };
  }, [team.id, revision, copies]);
  const load = info.reload;

  if (!clubSync || !info.data) return null;
  const { link, last, sent } = info.data;
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
          {!canSend && (
            <p className="hint">Ahora mismo este dispositivo no tiene permiso de entrenador en ese equipo: no se puede enviar.</p>
          )}
          <SyncIndicator teamId={team.id} variant="text" />
          {canSend && !link.accessLost && auto.status === 'attention' && auto.action && (
            <button type="button" className="btn btn-primary btn-block" onClick={() => setSheet('upload')}>
              <Icon as={auto.action === 'review' ? CloudUpload : RotateCw} />
              {auto.action === 'review' ? 'Revisar y enviar' : 'Reintentar'}
            </button>
          )}
          <ClubChangesBlock
            team={team}
            link={link}
            onChanged={() => {
              load();
              onDataChanged?.();
            }}
            advanced={
              <>
                {last && (
                  <p className={`hint club-last club-last-${last.status}`}>
                    {STATUS_TEXT[last.status]} · {formatChecked(last.finishedAt ?? last.startedAt)}
                  </p>
                )}
                <button type="button" className="btn btn-block" disabled={!canSend || link.accessLost === true} onClick={() => setSheet('upload')}>
                  <Icon as={CloudUpload} />
                  Enviar al servidor
                </button>
              </>
            }
          />
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
            // Sin nada que enviar empieza a sincronizar solo; con datos, pide revisarlos.
            void autoSync?.checkAll();
          }}
        />
      )}
      {sheet === 'upload' && (
        <UploadSheet
          team={team}
          onClose={() => {
            setSheet(null);
            load();
            // Tras un envío manual, el envío automático vuelve a mirar: se reanuda si estaba
            // detenido y, si ya no queda nada pendiente, empieza a enviar solo.
            void autoSync?.checkAll();
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
