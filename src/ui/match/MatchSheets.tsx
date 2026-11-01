import { ArrowLeft, Coffee, Flag, Minus, Plus, RotateCcw, Scale, Timer, Trash2, type LucideIcon } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { elapsedMs, MINUTE_MS, periodStartMs } from '../../clock/clock';
import { useNow } from '../../app/useNow';
import { clockFromParts, formatClock } from '../../domain/format';
import type { Match, ScoreAdjustment } from '../../domain/types';
import type { Score } from '../../stats/engine';
import { Icon } from '../components/Icon';
import { Sheet } from '../components/Sheet';
import { SyncIndicator } from './SyncIndicator';

/**
 * Ajuste manual del cronómetro: botones rápidos o un tiempo exacto en dos campos
 * numéricos (minutos y segundos), sin separadores que el teclado del móvil pueda
 * cambiar. Mientras no se toquen, los campos siguen al cronómetro: «Fijar» sin
 * cambiarlos no hace retroceder un reloj en marcha. Cerrar no cambia nada.
 */
export function ClockAdjustSheet({
  match,
  onShift,
  onSet,
  onClose,
}: {
  match: Match;
  onShift: (deltaMs: number) => void;
  onSet: (timeMs: number) => Promise<boolean>;
  onClose: () => void;
}) {
  const now = useNow(match.clock.running);
  const current = elapsedMs(match.clock, now);
  /** null: sin editar (muestran el tiempo actual). */
  const [fields, setFields] = useState<{ minutes: string; seconds: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const total = Math.floor(current / 1000);
  const shown = fields ?? { minutes: String(Math.floor(total / 60)).padStart(2, '0'), seconds: String(total % 60).padStart(2, '0') };
  const steps = [
    { label: '−1 min', d: -MINUTE_MS },
    { label: '−10 s', d: -10_000 },
    { label: '−1 s', d: -1_000 },
    { label: '+1 s', d: 1_000 },
    { label: '+10 s', d: 10_000 },
    { label: '+1 min', d: MINUTE_MS },
  ];

  const edit = (key: 'minutes' | 'seconds', value: string) => {
    setError(null);
    setFields({ ...shown, [key]: value.replace(/\D/g, '') });
  };

  async function apply(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const ms = clockFromParts(shown.minutes, shown.seconds);
    if (ms === null) {
      setError('Tiempo no válido: los minutos son un número y los segundos van de 00 a 59.');
      return;
    }
    setBusy(true);
    const ok = await onSet(ms);
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <Sheet title="Ajustar cronómetro" onClose={onClose}>
      <p className="adjust-now">
        {formatClock(current)} <small>{match.clock.period}.ª parte · {match.clock.running ? 'en marcha' : 'parado'}</small>
      </p>
      <div className="adjust-steps">
        {steps.map((s) => (
          <button key={s.label} type="button" className="btn" onClick={() => onShift(s.d)} disabled={busy}>
            {s.label}
          </button>
        ))}
      </div>
      <form className="adjust-exact" onSubmit={(e) => void apply(e)} noValidate>
        <span className="adjust-exact-title">Fijar tiempo exacto</span>
        <label>
          Minutos
          <input
            value={shown.minutes}
            onChange={(e) => edit('minutes', e.target.value)}
            onFocus={(e) => e.target.select()}
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={3}
            autoComplete="off"
          />
        </label>
        <span className="adjust-exact-sep" aria-hidden="true">
          :
        </span>
        <label>
          Segundos
          <input
            value={shown.seconds}
            onChange={(e) => edit('seconds', e.target.value)}
            onFocus={(e) => e.target.select()}
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={2}
            autoComplete="off"
          />
        </label>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Fijando…' : 'Fijar'}
        </button>
      </form>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <p className="hint">
        Es el tiempo total del partido
        {match.clock.period === 2 ? ` (la 2.ª parte empieza en ${formatClock(periodStartMs(2, match.halfMinutes))})` : ''}. Ajustar el
        reloj no cambia el minuto de las acciones ya registradas.
      </p>
    </Sheet>
  );
}

/**
 * Corrección manual del marcador. Se guarda aparte: no crea lanzamientos ni
 * atribuye goles, y no altera ninguna eficacia.
 */
export function ScoreSheet({
  match,
  score,
  onChange,
  onClose,
}: {
  match: Match;
  score: Score;
  onChange: (adjustment: ScoreAdjustment) => void;
  onClose: () => void;
}) {
  const adj = match.scoreAdjustment;
  const row = (label: string, fromEvents: number, value: number, key: keyof ScoreAdjustment) => (
    <div className="score-adj-row">
      <div>
        <strong>{label}</strong>
        <span className="muted">
          {fromEvents} por acciones {value !== 0 && `· ajuste ${value > 0 ? '+' : ''}${value}`}
        </span>
      </div>
      <div className="stepper">
        <button
          type="button"
          className="btn"
          disabled={fromEvents + value <= 0}
          onClick={() => onChange({ ...adj, [key]: value - 1 })}
          aria-label={`Restar un gol a ${label}`}
        >
          <Icon as={Minus} />
        </button>
        <span className="stepper-value">{Math.max(0, fromEvents + value)}</span>
        <button
          type="button"
          className="btn"
          onClick={() => onChange({ ...adj, [key]: value + 1 })}
          aria-label={`Sumar un gol a ${label}`}
        >
          <Icon as={Plus} />
        </button>
      </div>
    </div>
  );

  return (
    <Sheet title="Corregir marcador" onClose={onClose}>
      <p className="hint">
        Úsalo solo si se te ha escapado algún gol. La corrección cambia el resultado, pero no se inventan lanzamientos
        ni se atribuyen goles a nadie. Si sabes quién fue, mejor añade la acción desde la cronología.
      </p>
      {row('Nosotros', score.ownFromEvents, adj.own, 'own')}
      {row(match.opponent, score.opponentFromEvents, adj.opponent, 'opponent')}
      {(adj.own !== 0 || adj.opponent !== 0) && (
        <button type="button" className="btn btn-block" onClick={() => onChange({ own: 0, opponent: 0 })}>
          Quitar correcciones
        </button>
      )}
    </Sheet>
  );
}

interface MenuProps {
  match: Match;
  pendingCount: number;
  onAdjustClock: () => void;
  onScore: () => void;
  onHalftime: () => void;
  onFinish: () => void;
  onReopen: () => void;
  onExit: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export function MatchMenuSheet(p: MenuProps) {
  const finished = p.match.status === 'finished';
  const canHalftime = !finished && p.match.clock.period === 1 && p.match.status !== 'halftime';
  const item = (label: string, icon: LucideIcon, action: () => void, cls = '') => (
    <button type="button" className={'menu-item ' + cls} onClick={action}>
      <Icon as={icon} />
      {label}
    </button>
  );
  return (
    <Sheet title="Partido" onClose={p.onClose}>
      <SyncIndicator teamId={p.match.teamId} variant="text" />
      <div className="menu">
        {!finished && item('Ajustar cronómetro', Timer, p.onAdjustClock)}
        {item('Corregir marcador', Scale, p.onScore)}
        {canHalftime && item('Descanso (fin de la 1.ª parte)', Coffee, p.onHalftime)}
        {finished && item('Reabrir partido', RotateCcw, p.onReopen)}
        {item('Volver al equipo', ArrowLeft, p.onExit)}
      </div>
      {!finished && (
        <div className="menu">
          {item(
            'Finalizar partido' + (p.pendingCount ? ' (' + p.pendingCount + ' sin asignar)' : ''),
            Flag,
            p.onFinish,
          )}
        </div>
      )}
      {/* Acción destructiva, separada del resto. Pide confirmación. */}
      <div className="menu menu-separated">{item('Eliminar partido', Trash2, p.onDelete, 'menu-danger')}</div>
    </Sheet>
  );
}
