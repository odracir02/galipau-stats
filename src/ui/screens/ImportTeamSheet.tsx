// «Trabajar con este equipo aquí»: copia un equipo del club en este dispositivo
// (solo entrenadores). También reanuda o descarta una importación interrumpida.
import { CloudDownload } from 'lucide-react';
import { useState } from 'react';
import { errorMessage } from '../../app/errors';
import { teamImporter } from '../../app/remote';
import type { RemoteTeam } from '../../remote/api';
import type { ImportPhase, ImportState, ImportSummary } from '../../remote/importer';
import { Icon } from '../components/Icon';
import { Sheet } from '../components/Sheet';
import { KV } from '../stats/StatTables';

const PHASE_TEXT: Record<ImportPhase, string> = {
  download: 'Descargando el equipo del club…',
  check: 'Comprobando que no hay datos repetidos…',
  save: 'Guardando la copia en este dispositivo…',
  verify: 'Comprobando la copia…',
};

export function ImportTeamSheet({
  team,
  state,
  onClose,
  onOpen,
}: {
  team: RemoteTeam;
  state: ImportState;
  onClose: () => void;
  /** Abrir el equipo ya copiado. */
  onOpen: (localTeamId: string) => void;
}) {
  const [phase, setPhase] = useState<ImportPhase | null>(null);
  const [result, setResult] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = phase !== null && !result && !error;
  const pending = state.kind === 'pending';

  const run = async () => {
    if (!teamImporter) return;
    setError(null);
    setPhase('download');
    try {
      setResult(await teamImporter.importTeam(team.teamId, setPhase));
    } catch (e) {
      setError(errorMessage(e));
      setPhase(null);
    }
  };

  const discard = async () => {
    if (!teamImporter || state.kind !== 'pending') return;
    try {
      await teamImporter.discard(state.link.localTeamId);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Sheet
      title={pending ? 'Importación sin terminar' : 'Trabajar con este equipo aquí'}
      onClose={busy ? () => undefined : onClose}
      footer={
        result ? (
          <button type="button" className="btn btn-primary btn-block" onClick={() => onOpen(result.localTeamId)}>
            Abrir el equipo
          </button>
        ) : (
          <>
            {pending ? (
              <button type="button" className="btn" onClick={() => void discard()} disabled={busy}>
                Descartar
              </button>
            ) : (
              <button type="button" className="btn" onClick={onClose} disabled={busy}>
                Cancelar
              </button>
            )}
            <button type="button" className="btn btn-primary" onClick={() => void run()} disabled={busy}>
              <Icon as={CloudDownload} />
              {pending ? 'Reanudar' : 'Importar'}
            </button>
          </>
        )
      }
    >
      <p>
        <strong>{team.name}</strong> · {team.clubName} · {team.season}
      </p>
      {!result && (
        <>
          <p>
            Se copiarán en este dispositivo su plantilla, sus partidos y todas sus acciones, tal como están en el club. No se
            envía ni se cambia nada en el servidor, y los demás equipos de este dispositivo no cambian.
          </p>
          <p className="notice">
            Por ahora la copia es de <strong>solo lectura</strong>: podrás consultarla y ponerla al día con «Actualizar copia»,
            pero todavía no editarla ni enviar cambios desde aquí. El envío automático queda desactivado.
          </p>
          {pending && <p className="hint">La importación anterior no terminó. Puedes reanudarla o descartarla: no queda nada a medias a la vista.</p>}
        </>
      )}
      {busy && phase && (
        <p className="hint" role="status">
          {PHASE_TEXT[phase]}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <>
          <p className="club-last club-last-verified" role="status">
            Copia lista y comprobada
          </p>
          <dl className="kv">
            <KV k="Jugadores" v={result.players} />
            <KV k="Partidos" v={result.matches} />
            {result.deletedMatches > 0 && <KV k="Partidos eliminados (no cuentan)" v={result.deletedMatches} />}
            <KV k="Acciones" v={result.events} />
            {result.deletedEvents > 0 && <KV k="Acciones anuladas (no cuentan)" v={result.deletedEvents} />}
          </dl>
          <p className="hint">Nada pendiente de enviar.</p>
        </>
      )}
    </Sheet>
  );
}
