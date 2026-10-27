import { useState } from 'react';
import {
  eligiblePositions,
  FIELD_SHOT_RESULT_LABEL,
  FIELD_SHOT_RESULTS,
  FIELD_SHOT_TYPE_SHORT,
  FIELD_SHOT_TYPES,
  GK_SHOT_RESULT_LABEL,
  GK_SHOT_RESULTS,
  GK_SHOT_TYPE_SHORT,
  GK_SHOT_TYPES,
  KIND_LABEL,
  SIMPLE_KINDS,
  TURNOVER_LABEL,
  TURNOVER_TYPES,
} from '../../domain/catalog';
import type { EventTiming } from '../../domain/events';
import { formatClock, parseClock } from '../../domain/format';
import type {
  EventKind,
  EventPayload,
  FieldShotResult,
  FieldShotType,
  GkShotResult,
  GkShotType,
  Id,
  MatchEvent,
  Period,
  SquadEntry,
  TurnoverType,
} from '../../domain/types';
import { ConfirmSheet, Sheet } from '../components/Sheet';

const KINDS: readonly EventKind[] = ['shot', 'gk_shot', 'turnover', ...SIMPLE_KINDS];

interface Props {
  squad: readonly SquadEntry[];
  /** Descalificados: se pueden elegir (acciones olvidadas anteriores), pero se señalan. */
  disqualified: ReadonlySet<Id>;
  /** Evento a corregir; si no se da, se crea una acción olvidada. */
  event?: MatchEvent;
  defaultTiming: EventTiming;
  onSave: (payload: EventPayload, playerId: Id | null, timing: EventTiming) => Promise<boolean>;
  onDelete?: () => Promise<boolean>;
  onClose: () => void;
}

function Chips<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="chips">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          className={`chip ${o.value === value ? 'on' : ''}`}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function EventEditorSheet({ squad, disqualified, event, defaultTiming, onSave, onDelete, onClose }: Props) {
  const [kind, setKind] = useState<EventKind>(event?.kind ?? 'shot');
  const [shotType, setShotType] = useState<FieldShotType>(event?.kind === 'shot' ? event.shotType : 'nine_m');
  const [shotResult, setShotResult] = useState<FieldShotResult>(event?.kind === 'shot' ? event.result : 'goal');
  const [gkType, setGkType] = useState<GkShotType>(event?.kind === 'gk_shot' ? event.shotType : 'nine_m');
  const [gkResult, setGkResult] = useState<GkShotResult>(event?.kind === 'gk_shot' ? event.result : 'save');
  const [turnoverType, setTurnoverType] = useState<TurnoverType>(
    event?.kind === 'turnover' ? event.turnoverType : 'general',
  );
  const [playerId, setPlayerId] = useState<Id | null>(event?.playerId ?? null);
  const [period, setPeriod] = useState<Period>(event?.period ?? defaultTiming.period);
  const [timeText, setTimeText] = useState(formatClock(event?.matchTimeMs ?? defaultTiming.matchTimeMs));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const allowed = eligiblePositions(kind);
  const candidates = squad.filter((s) => allowed.includes(s.position)).sort((a, b) => a.number - b.number);
  // Si el tipo de acción ya no admite al jugador elegido, queda sin asignar (nunca se reasigna a otro).
  const effectivePlayer = candidates.some((c) => c.playerId === playerId) ? playerId : null;

  function payload(): EventPayload {
    switch (kind) {
      case 'shot':
        return { kind, shotType, result: shotResult };
      case 'gk_shot':
        return { kind, shotType: gkType, result: gkResult };
      case 'turnover':
        return { kind, turnoverType };
      default:
        return { kind };
    }
  }

  async function save() {
    const ms = parseClock(timeText);
    if (ms === null) {
      setError('Tiempo no válido. Usa el formato mm:ss, por ejemplo 23:45.');
      return;
    }
    setSaving(true);
    const ok = await onSave(payload(), effectivePlayer, { period, matchTimeMs: ms });
    setSaving(false);
    if (ok) onClose();
  }

  if (confirmDelete && onDelete) {
    return (
      <ConfirmSheet
        title="Eliminar acción"
        message="La acción dejará de contar en todas las estadísticas y en el marcador."
        confirmLabel="Eliminar"
        danger
        onCancel={() => setConfirmDelete(false)}
        onConfirm={async () => {
          if (await onDelete()) onClose();
        }}
      />
    );
  }

  return (
    <Sheet
      title={event ? 'Corregir acción' : 'Añadir acción olvidada'}
      onClose={onClose}
      footer={
        <>
          {event && onDelete && (
            <button type="button" className="btn btn-danger-outline" onClick={() => setConfirmDelete(true)}>
              Eliminar
            </button>
          )}
          <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void save()}>
            Guardar
          </button>
        </>
      }
    >
      <div className="form">
        <div className="field-label">Acción</div>
        <Chips value={kind} onChange={setKind} options={KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))} />

        {kind === 'shot' && (
          <>
            <div className="field-label">Tipo</div>
            <Chips
              value={shotType}
              onChange={setShotType}
              options={FIELD_SHOT_TYPES.map((t) => ({ value: t, label: FIELD_SHOT_TYPE_SHORT[t] }))}
            />
            <div className="field-label">Resultado</div>
            <Chips
              value={shotResult}
              onChange={setShotResult}
              options={FIELD_SHOT_RESULTS.map((r) => ({ value: r, label: FIELD_SHOT_RESULT_LABEL[r] }))}
            />
          </>
        )}
        {kind === 'gk_shot' && (
          <>
            <div className="field-label">Procedencia</div>
            <Chips
              value={gkType}
              onChange={setGkType}
              options={GK_SHOT_TYPES.map((t) => ({ value: t, label: GK_SHOT_TYPE_SHORT[t] }))}
            />
            <div className="field-label">Resultado</div>
            <Chips
              value={gkResult}
              onChange={setGkResult}
              options={GK_SHOT_RESULTS.map((r) => ({ value: r, label: GK_SHOT_RESULT_LABEL[r] }))}
            />
          </>
        )}
        {kind === 'turnover' && (
          <>
            <div className="field-label">Tipo de pérdida</div>
            <Chips
              value={turnoverType}
              onChange={setTurnoverType}
              options={TURNOVER_TYPES.map((t) => ({ value: t, label: TURNOVER_LABEL[t] }))}
            />
          </>
        )}

        <label>
          {kind === 'gk_shot' ? 'Portero' : 'Jugador'}
          <select
            value={effectivePlayer ?? ''}
            onChange={(e) => setPlayerId(e.target.value === '' ? null : e.target.value)}
          >
            <option value="">Sin asignar (pendiente)</option>
            {candidates.map((c) => (
              <option key={c.playerId} value={c.playerId}>
                {c.number} · {c.name}
                {disqualified.has(c.playerId) ? ' (descalificado)' : ''}
              </option>
            ))}
          </select>
        </label>

        <div className="form-row">
          <div>
            <div className="field-label">Parte</div>
            <Chips
              value={period}
              onChange={setPeriod}
              options={[
                { value: 1, label: '1.ª' },
                { value: 2, label: '2.ª' },
              ]}
            />
          </div>
          <label>
            Minuto (mm:ss)
            <input value={timeText} onChange={(e) => setTimeText(e.target.value)} inputMode="decimal" />
          </label>
        </div>
        {error && <p className="form-error">{error}</p>}
      </div>
    </Sheet>
  );
}
