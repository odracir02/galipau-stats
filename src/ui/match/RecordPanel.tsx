// Panel de registro en directo. Regla fundamental: primero la acción y después
// el jugador. Al completar una acción se vuelve siempre al inicio y nunca queda
// un jugador seleccionado.
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
import type { EventPayload, Id, SquadEntry } from '../../domain/types';

type Step =
  | { name: 'home' }
  | { name: 'shot'; timing: EventTiming }
  | { name: 'gk'; timing: EventTiming }
  | { name: 'turnover'; timing: EventTiming }
  | { name: 'defense'; timing: EventTiming }
  | { name: 'player'; timing: EventTiming; payload: EventPayload };

interface Props {
  squad: readonly SquadEntry[];
  /** Momento de partido actual; se toma en la primera pulsación de la acción. */
  getTiming: () => EventTiming;
  /** Guarda la acción; resuelve a true si quedó guardada en el dispositivo. */
  onRecord: (payload: EventPayload, playerId: Id | null, timing: EventTiming) => Promise<boolean>;
}

export function RecordPanel({ squad, getTiming, onRecord }: Props) {
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
        <div className="rec-home">
          <button type="button" className="act act-shot" onClick={() => setStep({ name: 'shot', timing: getTiming() })}>
            <span className="act-title">Lanzamiento</span>
            <span className="act-sub">Gol · Fuera · Parada</span>
          </button>
          <button type="button" className="act act-gk" onClick={() => setStep({ name: 'gk', timing: getTiming() })}>
            <span className="act-title">Portería</span>
            <span className="act-sub">Lanzamiento recibido</span>
          </button>
          <button
            type="button"
            className="act act-turnover"
            onClick={() => setStep({ name: 'turnover', timing: getTiming() })}
          >
            <span className="act-title">Pérdida</span>
            <span className="act-sub">Pasos · Dobles · Pase</span>
          </button>
          <button type="button" className="act act-recovery" onClick={() => choose({ kind: 'recovery' }, getTiming())}>
            <span className="act-title">Recuperación</span>
          </button>
          <button
            type="button"
            className="act act-defense"
            onClick={() => setStep({ name: 'defense', timing: getTiming() })}
          >
            <span className="act-title">Defensa y sanciones</span>
            <span className="act-sub">Amarilla · 2 min · Roja · Golpe franco · Penalti</span>
          </button>
        </div>
      );

    case 'shot':
      return (
        <StepFrame title="Lanzamiento" onBack={home}>
          <div className="matrix" style={{ gridTemplateColumns: 'minmax(5.5rem, 1.1fr) repeat(3, 1fr)' }}>
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
        <StepFrame title="Portería · lanzamiento recibido" onBack={home}>
          <div className="matrix" style={{ gridTemplateColumns: 'minmax(5.5rem, 1.1fr) repeat(3, 1fr)' }}>
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
                {t === 'general' ? 'Pérdida (otra)' : TURNOVER_LABEL[t]}
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
              <button
                key={k}
                type="button"
                className={`opt opt-${k}`}
                onClick={() => choose({ kind: k }, step.timing)}
              >
                {SIMPLE_KIND_LABEL[k]}
              </button>
            ))}
          </div>
        </StepFrame>
      );

    case 'player': {
      const allowed = eligiblePositions(step.payload.kind);
      const candidates = squad
        .filter((s) => allowed.includes(s.position))
        .sort((a, b) => a.number - b.number);
      return (
        <StepFrame title={`${describePayload(step.payload)} · ¿quién?`} onBack={home}>
          <div className={`players ${candidates.length <= 4 ? 'players-few' : ''}`}>
            {candidates.map((s) => (
              <button
                key={s.playerId}
                type="button"
                className={`player ${s.position === 'goalkeeper' ? 'player-gk' : ''}`}
                disabled={saving}
                onClick={() => void pickPlayer(s.playerId)}
              >
                <span className="player-num">{s.number}</span>
                <span className="player-name">{s.name}</span>
              </button>
            ))}
          </div>
          <button type="button" className="btn btn-block btn-pending" disabled={saving} onClick={() => void pickPlayer(null)}>
            Sin identificar (asignar después)
          </button>
        </StepFrame>
      );
    }
  }
}

function StepFrame({ title, onBack, children }: { title: string; onBack: () => void; children: ReactNode }) {
  return (
    <div className="rec-step">
      <div className="rec-step-head">
        <button type="button" className="btn btn-back" onClick={onBack}>
          ← Cancelar
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
