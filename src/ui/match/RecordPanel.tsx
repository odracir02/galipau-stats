// Panel de registro en directo. Regla fundamental: primero la acción y después
// el jugador. Al completar una acción se vuelve siempre al inicio y nunca queda
// un jugador seleccionado.
import { ChevronLeft } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import {
  DEFENSE_KINDS,
  describePayload,
  eligiblePositions,
  FIELD_SHOT_RESULT_LABEL,
  FIELD_SHOT_RESULTS,
  FIELD_SHOT_TYPE_LABEL,
  FIELD_SHOT_TYPES,
  GK_SHOT_RESULT_LABEL,
  GK_SHOT_RESULTS,
  GK_SHOT_TYPE_LABEL,
  GK_SHOT_TYPES,
  SIMPLE_KIND_LABEL,
  TURNOVER_LABEL,
  TURNOVER_TYPES,
} from '../../domain/catalog';
import type { EventTiming } from '../../domain/events';
import type { EventPayload, Id, SimpleEventKind, SquadEntry } from '../../domain/types';
import { Icon } from '../components/Icon';
import { ACTION_ICON } from '../components/icons';

type Step =
  | { name: 'home' }
  | { name: 'shot'; timing: EventTiming }
  | { name: 'gk'; timing: EventTiming }
  | { name: 'turnover'; timing: EventTiming }
  | { name: 'defense'; timing: EventTiming }
  | { name: 'player'; timing: EventTiming; payload: EventPayload };

interface Props {
  /** Convocados disponibles para acciones nuevas (sin los descalificados). */
  squad: readonly SquadEntry[];
  /** Convocados descalificados: no se pueden elegir aquí, solo desde el editor. */
  unavailable: readonly SquadEntry[];
  /** Momento de partido actual; se toma en la primera pulsación de la acción. */
  getTiming: () => EventTiming;
  /** Guarda la acción; resuelve a true si quedó guardada en el dispositivo. */
  onRecord: (payload: EventPayload, playerId: Id | null, timing: EventTiming) => Promise<boolean>;
}

const CARD_MARK: Partial<Record<SimpleEventKind, string>> = {
  yellow: 'card-mark card-mark-yellow',
  red: 'card-mark card-mark-red',
};

export function RecordPanel({ squad, unavailable, getTiming, onRecord }: Props) {
  const [step, setStep] = useState<Step>({ name: 'home' });
  const [saving, setSaving] = useState(false);
  const home = () => setStep({ name: 'home' });

  const choose = (payload: EventPayload, timing: EventTiming) => setStep({ name: 'player', timing, payload });

  async function pickPlayer(playerId: Id | null) {
    if (step.name !== 'player' || saving) return;
    setSaving(true);
    const ok = await onRecord(step.payload, playerId, step.timing);
    setSaving(false);
    // Si falla el guardado, mantenemos la selección para poder reintentar.
    if (ok) home();
  }

  switch (step.name) {
    case 'home':
      return (
        <div className="rec-grid">
          <ActionButton
            icon={ACTION_ICON.shot}
            title="Lanzamiento"
            sub="Gol · Fuera · Parada"
            onClick={() => setStep({ name: 'shot', timing: getTiming() })}
          />
          <ActionButton
            icon={ACTION_ICON.gk}
            title="Portería"
            sub="Lanzamiento recibido"
            onClick={() => setStep({ name: 'gk', timing: getTiming() })}
          />
          <ActionButton
            icon={ACTION_ICON.turnover}
            title="Pérdida"
            sub="Pasos · Dobles · Pase"
            onClick={() => setStep({ name: 'turnover', timing: getTiming() })}
          />
          <ActionButton
            icon={ACTION_ICON.recovery}
            title="Recuperación"
            sub="Balón recuperado"
            onClick={() => choose({ kind: 'recovery' }, getTiming())}
          />
          <ActionButton
            wide
            icon={ACTION_ICON.defense}
            title="Defensa y sanciones"
            sub="Amarilla · 2 min · Roja · Golpe franco · Penalti"
            onClick={() => setStep({ name: 'defense', timing: getTiming() })}
          />
        </div>
      );

    case 'shot':
      return (
        <StepFrame title="Lanzamiento" onBack={home}>
          <div className="matrix">
            <span />
            {FIELD_SHOT_RESULTS.map((r) => (
              <span key={r} className="matrix-head">
                {FIELD_SHOT_RESULT_LABEL[r]}
              </span>
            ))}
            {FIELD_SHOT_TYPES.map((t) => (
              <MatrixRow key={t} label={FIELD_SHOT_TYPE_LABEL[t]}>
                {FIELD_SHOT_RESULTS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    className={`cell cell-${r}`}
                    onClick={() => choose({ kind: 'shot', shotType: t, result: r }, step.timing)}
                  >
                    {FIELD_SHOT_RESULT_LABEL[r]}
                  </button>
                ))}
              </MatrixRow>
            ))}
          </div>
        </StepFrame>
      );

    case 'gk':
      return (
        <StepFrame title="Lanzamiento recibido" onBack={home}>
          <div className="matrix">
            <span />
            {GK_SHOT_RESULTS.map((r) => (
              <span key={r} className="matrix-head">
                {GK_SHOT_RESULT_LABEL[r]}
              </span>
            ))}
            {GK_SHOT_TYPES.map((t) => (
              <MatrixRow key={t} label={GK_SHOT_TYPE_LABEL[t]}>
                {GK_SHOT_RESULTS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    className={`cell cell-gk-${r}`}
                    onClick={() => choose({ kind: 'gk_shot', shotType: t, result: r }, step.timing)}
                  >
                    {r === 'goal' ? 'Gol' : GK_SHOT_RESULT_LABEL[r]}
                  </button>
                ))}
              </MatrixRow>
            ))}
          </div>
        </StepFrame>
      );

    case 'turnover':
      return (
        <StepFrame title="Pérdida de balón" onBack={home}>
          <div className="options">
            {TURNOVER_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                className="opt"
                onClick={() => choose({ kind: 'turnover', turnoverType: t }, step.timing)}
              >
                {t === 'general' ? 'Otra pérdida' : TURNOVER_LABEL[t]}
              </button>
            ))}
          </div>
        </StepFrame>
      );

    case 'defense':
      return (
        <StepFrame title="Defensa y sanciones" onBack={home}>
          <div className="options">
            {DEFENSE_KINDS.map((k) => (
              <button key={k} type="button" className="opt" onClick={() => choose({ kind: k }, step.timing)}>
                {CARD_MARK[k] && <span className={CARD_MARK[k]} aria-hidden="true" />}
                {SIMPLE_KIND_LABEL[k]}
              </button>
            ))}
          </div>
        </StepFrame>
      );

    case 'player': {
      const allowed = eligiblePositions(step.payload.kind);
      const byNumber = (a: SquadEntry, b: SquadEntry) => a.number - b.number;
      const field = squad.filter((s) => s.position === 'field' && allowed.includes('field')).sort(byNumber);
      const gks = squad.filter((s) => s.position === 'goalkeeper' && allowed.includes('goalkeeper')).sort(byNumber);
      // En lanzamientos los porteros van al final, marcados «POR»: es la excepción (portería vacía).
      const total = field.length + gks.length;
      const tile = (s: SquadEntry) => (
        <button
          key={s.playerId}
          type="button"
          className="player"
          disabled={saving}
          onClick={() => void pickPlayer(s.playerId)}
        >
          {s.position === 'goalkeeper' && <span className="tag-gk">POR</span>}
          <span className="player-num">{s.number}</span>
          <span className="player-name">{s.name}</span>
        </button>
      );
      return (
        <StepFrame title={`${describePayload(step.payload)} · ¿quién?`} onBack={home}>
          <div className={`players ${total <= 4 ? 'players-few' : ''}`}>
            {field.map(tile)}
            {gks.map(tile)}
          </div>
          <button
            type="button"
            className="btn btn-block btn-pending"
            disabled={saving}
            onClick={() => void pickPlayer(null)}
          >
            Sin identificar · asignar después
          </button>
          {unavailable.length > 0 && (
            <p className="hint">
              Descalificados (no disponibles):{' '}
              {unavailable.map((s) => `${s.number} · ${s.name}`).join(', ')}. Sus acciones anteriores se pueden
              añadir desde la cronología.
            </p>
          )}
        </StepFrame>
      );
    }
  }
}

function ActionButton(props: {
  icon: typeof ACTION_ICON.shot;
  title: string;
  sub: string;
  wide?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={`act ${props.wide ? 'act-wide' : ''}`} onClick={props.onClick}>
      <span className="act-icon">
        <Icon as={props.icon} />
      </span>
      <span className="act-text">
        <span className="act-title">{props.title}</span>
        <span className="act-sub">{props.sub}</span>
      </span>
    </button>
  );
}

function StepFrame({ title, onBack, children }: { title: string; onBack: () => void; children: ReactNode }) {
  return (
    <div className="rec-step">
      <div className="rec-step-head">
        <button type="button" className="btn btn-ghost btn-back" onClick={onBack}>
          <Icon as={ChevronLeft} />
          Cancelar
        </button>
        <strong>{title}</strong>
      </div>
      {children}
    </div>
  );
}

function MatrixRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span className="matrix-label">{label}</span>
      {children}
    </>
  );
}
