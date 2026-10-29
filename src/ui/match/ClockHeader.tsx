import { EllipsisVertical, Pause, Play } from 'lucide-react';
import { countdownMs, elapsedMs } from '../../clock/clock';
import { useNow } from '../../app/useNow';
import { formatClock } from '../../domain/format';
import type { Match, MatchEvent, SquadEntry } from '../../domain/types';
import type { Score } from '../../stats/engine';
import { activeReductions, type ActiveReduction } from '../../stats/exclusions';
import { reductionTag } from './labels';
import { Icon } from '../components/Icon';

interface Props {
  match: Match;
  /** Nombre público de nuestro equipo (nunca su código interno). */
  teamName: string;
  score: Score;
  /** Acciones del partido y convocatoria: para las exclusiones activas. */
  events: readonly MatchEvent[];
  squad: readonly SquadEntry[];
  onToggle: () => void;
  onMenu: () => void;
  onScore: () => void;
  /** Tocar una inferioridad: opción secundaria de sanción adicional. */
  onReduction: (r: ActiveReduction) => void;
}

/** Cabecera compacta y fija: marcador, cronómetro y botón de pausa/reanudación. */
export function ClockHeader({ match, teamName, score, events, squad, onToggle, onMenu, onScore, onReduction }: Props) {
  const now = useNow(match.clock.running);
  const t = elapsedMs(match.clock, now);
  const reductions = activeReductions(match, events, now);
  const remaining =
    match.status === 'in_progress' || match.status === 'ready'
      ? countdownMs(match.clock, now, match.halfMinutes)
      : null;
  const adjusted = score.ownAdjustment !== 0 || score.opponentAdjustment !== 0;

  let button: { label: string; cls: string; icon: typeof Play } | null;
  if (match.status === 'finished') button = null;
  else if (match.status === 'halftime') button = { label: 'Iniciar 2.ª parte', cls: 'clock-btn-start', icon: Play };
  else if (match.clock.running) button = { label: 'Pausar', cls: 'clock-btn-pause', icon: Pause };
  else if (match.status === 'ready') button = { label: 'Iniciar', cls: 'clock-btn-start', icon: Play };
  else button = { label: 'Reanudar', cls: 'clock-btn-start', icon: Play };

  const state =
    match.status === 'finished'
      ? 'Finalizado'
      : match.status === 'halftime'
        ? 'Descanso'
        : match.clock.running
          ? 'En marcha'
          : 'Parado';

  return (
    <header className={`match-head ${match.clock.running ? 'is-running' : 'is-stopped'}`}>
      <div className="mh-top">
        <button type="button" className="mh-score" onClick={onScore} aria-label="Marcador. Pulsa para corregirlo">
          <span className="mh-team mh-team-own">{teamName}</span>
          <span className="mh-goals">
            {score.own}–{score.opponent}
            {adjusted && <sup title="Incluye corrección manual">*</sup>}
          </span>
          <span className="mh-team mh-team-opp">{match.opponent}</span>
        </button>
        <button type="button" className="icon-btn" onClick={onMenu} aria-label="Menú del partido">
          <Icon as={EllipsisVertical} />
        </button>
      </div>
      <div className="mh-main">
        <div className="mh-clock-block">
          <span className="mh-clock">{formatClock(t)}</span>
          <span className="mh-meta">
            <span className="mh-dot" />
            {match.clock.period === 1 ? '1.ª parte' : '2.ª parte'} ·{' '}
            {/* En los últimos minutos la cuenta atrás ocupa el lugar del estado (que ya indican el
                punto y el botón): misma línea, nada se desplaza y cabe en pantallas estrechas. */}
            {remaining === null ? (
              state
            ) : (
              <span className="mh-countdown" aria-label={`${state}. Quedan ${formatClock(remaining)}`}>
                quedan {formatClock(remaining)}
              </span>
            )}
          </span>
        </div>
        {button ? (
          <button type="button" className={`clock-btn ${button.cls}`} onClick={onToggle}>
            <Icon as={button.icon} size={22} fill="currentColor" />
            {button.label}
          </button>
        ) : (
          <span className="mh-finished">Finalizado</span>
        )}
      </div>
      {/* Solo aparece con alguna inferioridad en curso: sin hueco reservado. */}
      {reductions.length > 0 && <ReductionStrip reductions={reductions} squad={squad} onOpen={onReduction} />}
    </header>
  );
}

/**
 * Inferioridades en curso: tarjetas compactas con dorsal, nombre, tipo y tiempo
 * restante. Tocar una abre la opción secundaria de sanción adicional (4 min).
 */
function ReductionStrip({
  reductions,
  squad,
  onOpen,
}: {
  reductions: ActiveReduction[];
  squad: readonly SquadEntry[];
  onOpen: (r: ActiveReduction) => void;
}) {
  return (
    <ul className="mh-excl" aria-label="Inferioridades del equipo">
      {reductions.map((x) => {
        const who = squad.find((s) => s.playerId === x.playerId);
        const name = who ? who.name : 'Sin asignar';
        const tag = reductionTag(x);
        return (
          <li key={x.eventId}>
            <button
              type="button"
              className={`mh-excl-item ${x.kind === 'exclusion' ? '' : 'is-red'}`}
              onClick={() => onOpen(x)}
              aria-label={`Inferioridad${tag ? ` (${tag})` : ''}: ${who ? `${who.number} ${who.name}` : name}, quedan ${formatClock(x.remainingMs)}`}
            >
              <span className="mh-excl-num">{who ? who.number : '?'}</span>
              <span className="mh-excl-name">{name}</span>
              {tag && <span className="mh-excl-tag">{tag}</span>}
              <span className="mh-excl-time">{formatClock(x.remainingMs)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
