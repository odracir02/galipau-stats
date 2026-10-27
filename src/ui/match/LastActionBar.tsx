import { Undo2 } from 'lucide-react';
import { describePayload } from '../../domain/catalog';
import { formatClock } from '../../domain/format';
import type { MatchEvent, SquadEntry } from '../../domain/types';
import { Icon } from '../components/Icon';
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
            <span className="last-label">Última · {formatClock(last.matchTimeMs)}</span>
            <span>
              <strong>{describePayload(last)}</strong> · {playerLabel(squad, last.playerId)}
            </span>
          </>
        ) : (
          <span className="last-label">Sin acciones registradas</span>
        )}
      </div>
      {pendingCount > 0 && (
        <button type="button" className="pending-chip" onClick={onPending} title="Acciones pendientes de atribuir">
          {pendingCount} sin asignar
        </button>
      )}
      <button type="button" className="btn btn-undo" onClick={onUndo} disabled={!last}>
        <Icon as={Undo2} size={18} />
        Deshacer
      </button>
    </div>
  );
}
