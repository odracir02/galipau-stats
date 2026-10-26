import { useMemo, useState } from 'react';
import { describePayload } from '../../domain/catalog';
import { compareEvents } from '../../domain/events';
import { formatClock } from '../../domain/format';
import type { MatchEvent, SquadEntry } from '../../domain/types';
import { Segmented } from '../components/Segmented';
import { playerLabel } from './labels';

interface Props {
  events: readonly MatchEvent[];
  squad: readonly SquadEntry[];
  initialFilter: 'all' | 'pending';
  onEdit: (event: MatchEvent) => void;
  onAdd: () => void;
}

/** Cronología editable: lo más reciente arriba. Tocar una acción la abre para corregirla. */
export function Timeline({ events, squad, initialFilter, onEdit, onAdd }: Props) {
  const [filter, setFilter] = useState(initialFilter);
  const live = useMemo(
    () => events.filter((e) => e.deletedAt === null).sort(compareEvents).reverse(),
    [events],
  );
  const pending = live.filter((e) => e.playerId === null);
  const shown = filter === 'pending' ? pending : live;

  return (
    <div className="timeline">
      <button type="button" className="btn btn-block" onClick={onAdd}>
        + Añadir acción olvidada
      </button>
      <Segmented
        ariaLabel="Filtro de cronología"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: `Todas (${live.length})` },
          { value: 'pending', label: 'Sin asignar', badge: pending.length },
        ]}
      />
      {shown.length === 0 && (
        <p className="empty">{filter === 'pending' ? 'No hay acciones pendientes de atribuir.' : 'Aún no hay acciones.'}</p>
      )}
      <ul className="list tl-list">
        {shown.map((e) => (
          <li key={e.id}>
            <button type="button" className={`tl-item tl-${e.kind}`} onClick={() => onEdit(e)}>
              <span className="tl-time">
                {formatClock(e.matchTimeMs)}
                <small>{e.period}.ª</small>
              </span>
              <span className="tl-main">
                <strong>{describePayload(e)}</strong>
                <span className={e.playerId === null ? 'tl-pending' : 'muted'}>{playerLabel(squad, e.playerId)}</span>
              </span>
              <span className="chevron">✎</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
