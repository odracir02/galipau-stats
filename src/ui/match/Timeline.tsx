import { ChevronRight, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { describePayload } from '../../domain/catalog';
import { compareEvents, isPending } from '../../domain/events';
import { formatClock } from '../../domain/format';
import type { MatchEvent, SquadEntry } from '../../domain/types';
import type { RedCard } from '../../stats/discipline';
import { Icon } from '../components/Icon';
import { iconForKind } from '../components/icons';
import { Segmented } from '../components/Segmented';
import { playerLabel } from './labels';

interface Props {
  events: readonly MatchEvent[];
  squad: readonly SquadEntry[];
  /** Rojas derivadas, para señalar qué evento las provoca. */
  cards: readonly RedCard[];
  initialFilter: 'all' | 'pending';
  onEdit: (event: MatchEvent) => void;
  onAdd: () => void;
}

/** Cronología editable: lo más reciente arriba. Tocar una acción la abre para corregirla. */
export function Timeline({ events, squad, cards, initialFilter, onEdit, onAdd }: Props) {
  const [filter, setFilter] = useState(initialFilter);
  const live = useMemo(
    () => events.filter((e) => e.deletedAt === null).sort(compareEvents).reverse(),
    [events],
  );
  const pending = live.filter(isPending);
  const shown = filter === 'pending' ? pending : live;
  const triggers = new Map(cards.map((c) => [c.triggerEventId, c.type]));
  /** Nota de disciplina: qué exclusión provoca la roja y qué roja no suma por estar ya descalificado. */
  const disciplineNote = (e: MatchEvent): string | null => {
    if (triggers.get(e.id) === 'accumulated') return 'Roja por acumulación';
    if (e.kind === 'red' && e.playerId !== null && !triggers.has(e.id)) return 'Ya descalificado: no suma';
    return null;
  };

  return (
    <div className="timeline">
      <button type="button" className="btn btn-block" onClick={onAdd}>
        <Icon as={Plus} />
        Añadir acción olvidada
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
      {shown.length === 0 ? (
        <p className="empty">{filter === 'pending' ? 'No hay acciones pendientes de atribuir.' : 'Aún no hay acciones.'}</p>
      ) : (
        <ul className="list tl-list">
          {shown.map((e) => (
            <li key={e.id}>
              <button type="button" className="tl-item" onClick={() => onEdit(e)}>
                <span className="tl-time">
                  {formatClock(e.matchTimeMs)}
                  <small>{e.period}.ª parte</small>
                </span>
                <span className={`tl-icon ${isGoal(e) ? 'is-goal' : ''}`}>
                  <Icon as={iconForKind(e.kind)} size={18} />
                </span>
                <span className="tl-main">
                  <strong>{describePayload(e)}</strong>
                  <span className={isPending(e) ? 'tl-pending' : 'muted'}>{playerLabel(squad, e.playerId, e.kind)}</span>
                  {disciplineNote(e) && <span className="tl-discipline">{disciplineNote(e)}</span>}
                </span>
                <Icon as={ChevronRight} className="chevron" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Goles (a favor o en contra) destacados en la cronología. */
function isGoal(e: MatchEvent): boolean {
  return (e.kind === 'shot' || e.kind === 'gk_shot') && e.result === 'goal';
}
