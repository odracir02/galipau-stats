// Opción secundaria de una inferioridad: marcar una sanción posterior del mismo
// jugador como «adicional antes de reanudar», para que sume 2 minutos a esta
// inferioridad (4 minutos) en lugar de abrir otra. Nunca se pregunta al registrar.
import { useNow } from '../../app/useNow';
import { describePayload } from '../../domain/catalog';
import { formatClock } from '../../domain/format';
import type { Id, Match, MatchEvent, SquadEntry } from '../../domain/types';
import { activeReductions, additionalCandidates } from '../../stats/exclusions';
import { Sheet } from '../components/Sheet';
import { playerLabel } from './labels';

interface Props {
  match: Match;
  events: readonly MatchEvent[];
  squad: readonly SquadEntry[];
  /** Jugador de la tarjeta pulsada (null = sanción sin asignar). */
  playerId: Id | null;
  /** Sanción que abre la tarjeta pulsada. */
  eventId: Id;
  onToggle: (event: MatchEvent, addsToPrevious: boolean) => void;
  onClose: () => void;
}

export function ReductionSheet({ match, events, squad, playerId, eventId, onToggle, onClose }: Props) {
  const now = useNow(match.clock.running);
  const active = activeReductions(match, events, now);
  // Se trabaja sobre la primera inferioridad activa del jugador: es a la que se suman las adicionales.
  const own = playerId === null ? active.filter((r) => r.eventId === eventId) : active.filter((r) => r.playerId === playerId);
  const served = (r: (typeof own)[number]) => r.durationMs - r.remainingMs;
  const anchor = [...own].sort((a, b) => served(b) - served(a))[0];
  const candidates = anchor ? additionalCandidates(events, anchor) : [];
  const who = playerLabel(squad, playerId);

  return (
    <Sheet title={`Inferioridad · ${who}`} onClose={onClose}>
      <div className="form">
        {anchor ? (
          <p className="adjust-now">
            {formatClock(anchor.remainingMs)}{' '}
            <small>
              de {formatClock(anchor.durationMs)}
              {anchor.kind !== 'exclusion' ? ' · Roja' : ''}
            </small>
          </p>
        ) : (
          <p className="hint">Esta inferioridad ya ha terminado.</p>
        )}
        <p className="hint">
          Cada exclusión o roja deja al equipo 2 minutos en inferioridad. Si este jugador recibió otra sanción antes de
          reanudarse el juego, la inferioridad es de 4 minutos: marca esa sanción para sumarla aquí en lugar de contarla
          aparte. Las sanciones y las estadísticas no cambian.
        </p>
        {anchor && candidates.length === 0 && (
          <p className="empty">
            {playerId === null
              ? 'Las sanciones sin asignar no se pueden sumar: asígnalas antes a un jugador.'
              : 'No hay otra sanción posterior de este jugador.'}
          </p>
        )}
        {candidates.map((e) => (
          <label key={e.id} className="check">
            <input
              type="checkbox"
              checked={Boolean(e.addsToPrevious)}
              onChange={(ev) => onToggle(e, ev.target.checked)}
            />
            {describePayload(e)} · {formatClock(e.matchTimeMs)} — sanción adicional antes de reanudar (+2 min)
          </label>
        ))}
      </div>
    </Sheet>
  );
}
