import { describePayload } from '../../domain/catalog';
import { formatClock } from '../../domain/format';
import type { MatchEvent, SquadEntry } from '../../domain/types';
import { playerLabel } from './labels';

interface Props {
  last: MatchEvent | undefined;
  squad: readonly SquadEntry[];
  pendingCount: number;
  onUndo: () => void;
  onPending: () => void;
}

/** Última acción + Deshacer, siempre visibles durante el registro. */
export function LastActionBar({ last, squad, pendingCount, onUndo, onPending }: Props) {
  return (
    <div className="last-bar">
      <div className="last-text">
        {last ? (
          <>
            <span className="last-time">{formatClock(last.matchTimeMs)}</span>{' '}
            <strong>{describePayload(last)}</strong> · {playerLabel(squad, last.playerId)}
          </>
        ) : (
          <span className="muted">Sin acciones registradas</span>
        )}
      </div>
      {pendingCount > 0 && (
        <button type="button" className="pending-chip" onClick={onPending} title="Acciones pendientes de atribuir">
          {pendingCount} sin asignar
        </button>
      )}
      <button type="button" className="btn btn-undo" onClick={onUndo} disabled={!last}>
        ↶ Deshacer
      </button>
    </div>
  );
}
