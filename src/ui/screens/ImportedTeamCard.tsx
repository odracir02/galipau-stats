// Tarjeta de una copia del club en este dispositivo: de dónde viene, si está al
// día, «Actualizar copia» y «Quitar copia». Por ahora es de solo lectura: no
// se edita ni se envía nada desde aquí.
import { CloudDownload, Link2, Lock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { errorMessage } from '../../app/errors';
import { teamImporter } from '../../app/remote';
import { navigate } from '../../app/router';
import { showToast } from '../../app/toast';
import type { Team } from '../../domain/types';
import type { ImportPhase } from '../../remote/importer';
import { formatChecked } from '../../remote/session';
import type { TeamLink } from '../../remote/store';
import { Icon } from '../components/Icon';
import { ConfirmSheet } from '../components/Sheet';

const PHASE_TEXT: Record<ImportPhase, string> = {
  download: 'Descargando…',
  check: 'Comprobando…',
  save: 'Guardando…',
  verify: 'Comprobando la copia…',
};

export function ImportedTeamCard({ team, link, onChanged }: { team: Team; link: TeamLink; onChanged: () => void }) {
  const [behind, setBehind] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<ImportPhase | null>(null);
  const [removing, setRemoving] = useState(false);

  // Una consulta ligera al abrir: ¿hay cambios en el club desde la copia?
  useEffect(() => {
    let alive = true;
    void teamImporter?.isBehind(team.id).then((b) => alive && setBehind(b));
    return () => {
      alive = false;
    };
  }, [team.id, link.cursor]);

  const refresh = async () => {
    if (!teamImporter) return;
    setPhase('download');
    try {
      await teamImporter.refresh(team.id, setPhase);
      setBehind(false);
      showToast('Copia actualizada con el club');
      onChanged();
    } catch (e) {
      showToast(errorMessage(e), 'error');
    } finally {
      setPhase(null);
    }
  };

  const pending = link.importState === 'pending';
  return (
    <section className="card club-card" aria-label="Copia del club">
      <h3>Copia del club</h3>
      <p className="club-link">
        <Icon as={Link2} size={18} />
        <span>
          <strong>{link.remoteTeamName}</strong> · {link.clubName} · {link.remoteSeason}
        </span>
      </p>
      <p className="notice">
        <Icon as={Lock} size={18} />
        {pending
          ? 'La importación no terminó: reanúdala desde «Equipos del club» o quita la copia.'
          : 'Solo lectura en este dispositivo: puedes consultarla, pero todavía no editarla ni enviar cambios desde aquí.'}
      </p>
      {link.refreshedAt && <p className="hint">Copia del {formatChecked(link.refreshedAt)}.</p>}
      {behind === true && <p className="hint club-last club-last-differences">Hay cambios en el club posteriores a esta copia.</p>}
      {behind === false && <p className="hint club-last club-last-verified">Al día con el club.</p>}
      {!pending && (
        <button type="button" className="btn btn-block" onClick={() => void refresh()} disabled={phase !== null}>
          <Icon as={CloudDownload} />
          {phase ? PHASE_TEXT[phase] : 'Actualizar copia'}
        </button>
      )}
      <button type="button" className="btn btn-ghost btn-block" onClick={() => setRemoving(true)} disabled={phase !== null}>
        Quitar la copia de este dispositivo
      </button>
      {removing && (
        <ConfirmSheet
          title="Quitar la copia"
          message={
            <>
              <p>
                Se borrará de este dispositivo la copia de <strong>{team.name}</strong>. En el club no cambia nada y podrás volver
                a importarla con tu código de entrenador.
              </p>
              <p>Los demás equipos de este dispositivo no cambian.</p>
            </>
          }
          confirmLabel="Quitar la copia"
          danger
          onCancel={() => setRemoving(false)}
          onConfirm={async () => {
            try {
              await teamImporter?.discard(team.id);
              showToast('Copia quitada de este dispositivo', 'info');
              navigate({ name: 'teams' }, { replace: true });
            } catch (e) {
              setRemoving(false);
              showToast(errorMessage(e), 'error');
            }
          }}
        />
      )}
    </section>
  );
}
