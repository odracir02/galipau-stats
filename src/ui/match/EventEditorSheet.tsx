import { TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  canReceive,
  isOfficial,
  OFFICIAL_KINDS,
  FIELD_SHOT_RESULT_LABEL,
  FIELD_SHOT_RESULTS,
  FIELD_SHOT_TYPE_SHORT,
  FIELD_SHOT_TYPES,
  GK_SHOT_RESULT_LABEL,
  GK_SHOT_RESULTS,
  GK_SHOT_TYPE_SHORT,
  GK_SHOT_TYPES,
  isLegacyKind,
  isTeamKind,
  KIND_LABEL,
  SIMPLE_KINDS,
  TURNOVER_LABEL,
  TURNOVER_TYPES,
} from '../../domain/catalog';
import type { EventTiming } from '../../domain/events';
import { officialLabel, staffOptions, type FixedOfficialSlot } from '../../domain/officials';
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
import { Icon } from '../components/Icon';
import { ConfirmSheet, Sheet } from '../components/Sheet';

const KINDS: readonly EventKind[] = ['shot', 'gk_shot', 'turnover', ...SIMPLE_KINDS];

interface Props {
  squad: readonly SquadEntry[];
  /** Puestos fijos del cuerpo técnico aún sin convocar: se ofrecen en las sanciones. */
  fixed: readonly { slot: FixedOfficialSlot; name: string }[];
  /** Descalificados: se pueden elegir (acciones olvidadas anteriores), pero se señalan. */
  disqualified: ReadonlySet<Id>;
  /** Evento a corregir; si no se da, se crea una acción olvidada. */
  event?: MatchEvent;
  defaultTiming: EventTiming;
  onSave: (payload: EventPayload, playerId: Id | null, timing: EventTiming) => Promise<boolean>;
  /**
   * Comprueba si el jugador ya estaba descalificado en ese momento. Devuelve el
   * texto de la advertencia o null. Solo avisa: «Guardar igualmente» sigue disponible.
   */
  checkDisqualified: (payload: EventPayload, playerId: Id | null, timing: EventTiming) => string | null;
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

export function EventEditorSheet({
  squad,
  fixed,
  disqualified,
  event,
  defaultTiming,
  onSave,
  checkDisqualified,
  onDelete,
  onClose,
}: Props) {
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
  const [warning, setWarning] = useState<string | null>(null);
  const warningRef = useRef<HTMLDivElement>(null);
  // La advertencia aparece al final del formulario: se desplaza a la vista para que se lea
  // antes de decidir entre «Revisar» y «Guardar igualmente».
  useEffect(() => {
    if (warning) warningRef.current?.scrollIntoView({ block: 'nearest' });
  }, [warning]);
  // Un evento histórico de una categoría retirada (golpe franco) conserva su opción solo al editarlo.
  const kindOptions = event && isLegacyKind(event.kind) ? [...KINDS, event.kind] : KINDS;

  const team = isTeamKind(kind);
  // Acción de equipo: sin jugador. Solo un golpe franco antiguo conserva el que ya tenía.
  const legacyOwner = team && event?.kind === kind ? event.playerId : null;
  // El cuerpo técnico solo en amarillas, exclusiones y rojas, al final; los tres
  // puestos fijos siempre, aunque aún no estén convocados.
  const eligible = squad.filter((s) => (team ? s.playerId === legacyOwner : canReceive(s, kind)));
  const candidates = [
    ...eligible.filter((s) => !isOfficial(s)).sort((a, b) => a.number - b.number),
    ...(team || !OFFICIAL_KINDS.includes(kind) ? eligible.filter(isOfficial) : staffOptions(eligible.filter(isOfficial), fixed)),
  ];
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

  async function save(force = false) {
    const ms = parseClock(timeText);
    if (ms === null) {
      setError('Tiempo no válido. Usa el formato mm:ss, por ejemplo 23:45.');
      return;
    }
    const timing = { period, matchTimeMs: ms };
    if (!force) {
      const message = checkDisqualified(payload(), effectivePlayer, timing);
      if (message) {
        setWarning(message);
        return;
      }
    }
    setWarning(null);
    setSaving(true);
    const ok = await onSave(payload(), effectivePlayer, timing);
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
        warning ? (
          <>
            <button type="button" className="btn" onClick={() => setWarning(null)}>
              Revisar
            </button>
            <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void save(true)}>
              Guardar igualmente
            </button>
          </>
        ) : (
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
        )
      }
    >
      <div className="form">
        <div className="field-label">Acción</div>
        <Chips value={kind} onChange={setKind} options={kindOptions.map((k) => ({ value: k, label: KIND_LABEL[k] }))} />

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
            <option value="">{team ? 'Equipo (sin jugador)' : 'Sin asignar (pendiente)'}</option>
            {candidates.map((c) => (
              <option key={c.playerId} value={c.playerId}>
                {isOfficial(c) ? officialLabel(c) : `${c.number} · ${c.name}`}
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
        {warning && (
          <div className="warning" role="alert" ref={warningRef}>
            <Icon as={TriangleAlert} />
            <div>
              <strong>Jugador ya descalificado</strong>
              <p>{warning}</p>
              <p className="muted">Revisa el jugador o el minuto. Si es correcto, puedes guardar igualmente.</p>
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
}
