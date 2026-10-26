import { countdownMs, elapsedMs } from '../../clock/clock';
import { useNow } from '../../app/useNow';
import { formatClock } from '../../domain/format';
import type { Match } from '../../domain/types';
import type { Score } from '../../stats/engine';

interface Props {
  match: Match;
  teamCode: string;
  score: Score;
  onToggle: () => void;
  onMenu: () => void;
  onScore: () => void;
}

/** Cabecera compacta y fija: marcador, cronómetro y botón de pausa/reanudación. */
export function ClockHeader({ match, teamCode, score, onToggle, onMenu, onScore }: Props) {
  const now = useNow(match.clock.running);
  const t = elapsedMs(match.clock, now);
  const remaining =
    match.status === 'in_progress' || match.status === 'ready'
      ? countdownMs(match.clock, now, match.halfMinutes)
      : null;
  const adjusted = score.ownAdjustment !== 0 || score.opponentAdjustment !== 0;

  let button: { label: string; cls: string } | null;
  if (match.status === 'finished') button = null;
  else if (match.status === 'halftime') button = { label: '▶ Iniciar 2.ª parte', cls: 'clock-btn-start' };
  else if (match.clock.running) button = { label: '❚❚ Pausar', cls: 'clock-btn-pause' };
  else if (match.status === 'ready') button = { label: '▶ Iniciar partido', cls: 'clock-btn-start' };
  else button = { label: '▶ Reanudar', cls: 'clock-btn-start' };

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
      <div className="mh-row">
        <button type="button" className="mh-score" onClick={onScore} aria-label="Corregir marcador">
          <span className="mh-team">{teamCode}</span>
          <span className="mh-goals">
            {score.own} – {score.opponent}
            {adjusted && <sup title="Incluye corrección manual">*</sup>}
          </span>
          <span className="mh-team">{match.opponent}</span>
        </button>
        <button type="button" className="icon-btn mh-menu" onClick={onMenu} aria-label="Menú del partido">
          ⋮
        </button>
      </div>
      <div className="mh-row mh-clock-row">
        <span className="mh-clock" aria-live="off">
          {formatClock(t)}
        </span>
        <span className="mh-meta">
          <span>
            {match.clock.period === 1 ? '1.ª parte' : '2.ª parte'} ·{' '}
            <span className={`mh-state ${match.clock.running ? 'run' : ''}`}>{state}</span>
          </span>
          {/* Espacio siempre reservado: la cuenta atrás no desplaza el botón de pausa al aparecer. */}
          <span className={`mh-countdown ${remaining === null ? 'is-hidden' : ''}`} aria-hidden={remaining === null}>
            quedan ≈ {formatClock(remaining ?? 0)}
          </span>
        </span>
      </div>
      {button && (
        <button type="button" className={`clock-btn ${button.cls}`} onClick={onToggle}>
          {button.label}
        </button>
      )}
    </header>
  );
}
