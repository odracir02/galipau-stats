// Tarjeta «Servidor del club» en un equipo local: vincularlo con un equipo del
// club y enviar sus datos a mano. Solo aparece si este dispositivo tiene permiso
// de entrenador en algún equipo del club o si el equipo ya está vinculado.
import { CloudUpload, Link2 } from 'lucide-react';
import { useState } from 'react';
import { errorMessage } from '../../app/errors';
import { clubSync, remote } from '../../app/remote';
import { showToast } from '../../app/toast';
import { useLoad } from '../../app/useLoad';
import { useRemote } from '../../app/useRemote';
import type { Team } from '../../domain/types';
import { formatChecked } from '../../remote/session';
import type { TeamLink, UploadRecord } from '../../remote/store';
import { Icon } from '../components/Icon';
import { ConfirmSheet } from '../components/Sheet';
import { LinkSheet } from './LinkSheet';
import { UploadSheet } from './UploadSheet';

const STATUS_TEXT: Record<UploadRecord['status'], string> = {
  running: 'Envío sin terminar',
  verified: 'Sincronización completada',
  differences: 'Enviado con diferencias',
  interrupted: 'Envío interrumpido',
  stopped: 'Envío detenido',
};

export function ClubLinkCard({ team }: { team: Team }) {
  const session = useRemote(remote);
  const [sheet, setSheet] = useState<'link' | 'upload' | 'unlink' | null>(null);
  const info = useLoad(async (): Promise<{ link: TeamLink | null; last: UploadRecord | null; sent: boolean } | null> => {
    if (!clubSync) return null;
    const link = await clubSync.getLink(team.id);
    return { link, last: await clubSync.lastUpload(team.id), sent: link ? await clubSync.hasSent(link) : false };
  }, [team.id]);
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
          {last && (
            <p className={`hint club-last club-last-${last.status}`}>
              {STATUS_TEXT[last.status]} · {formatChecked(last.finishedAt ?? last.startedAt)}
            </p>
          )}
          {!canSend && (
            <p className="hint">Ahora mismo este dispositivo no tiene permiso de entrenador en ese equipo: no se puede enviar.</p>
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
