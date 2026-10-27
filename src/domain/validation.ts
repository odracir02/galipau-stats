import {
  DEFENSE_KINDS,
  LEGACY_KINDS,
  eligiblePositions,
  FIELD_SHOT_RESULTS,
  FIELD_SHOT_TYPES,
  GK_SHOT_RESULTS,
  GK_SHOT_TYPES,
  TURNOVER_TYPES,
} from './catalog';
import type { EventPayload, Id, Match, MatchEvent, Player, Position } from './types';

export class ValidationError extends Error {
  override name = 'ValidationError';
}

function includes<T>(list: readonly T[], value: unknown): value is T {
  return list.includes(value as T);
}

/** Comprueba que el contenido de una acción pertenece al catálogo aprobado. */
export function assertValidPayload(p: EventPayload): void {
  switch (p.kind) {
    case 'shot':
      if (!includes(FIELD_SHOT_TYPES, p.shotType) || !includes(FIELD_SHOT_RESULTS, p.result))
        throw new ValidationError('Lanzamiento no válido.');
      return;
    case 'gk_shot':
      if (!includes(GK_SHOT_TYPES, p.shotType) || !includes(GK_SHOT_RESULTS, p.result))
        throw new ValidationError('Lanzamiento recibido no válido.');
      return;
    case 'turnover':
      if (!includes(TURNOVER_TYPES, p.turnoverType)) throw new ValidationError('Tipo de pérdida no válido.');
      return;
    default:
      if (p.kind !== 'recovery' && !includes(DEFENSE_KINDS, p.kind) && !includes(LEGACY_KINDS, p.kind))
        throw new ValidationError('Acción no válida.');
  }
}

/** El jugador debe estar convocado y tener una posición compatible con la acción. */
export function assertEligiblePlayer(match: Pick<Match, 'squad'>, kind: MatchEvent['kind'], playerId: Id | null): void {
  if (playerId === null) return;
  const entry = match.squad.find((s) => s.playerId === playerId);
  if (!entry) throw new ValidationError('El jugador no está convocado en este partido.');
  if (!eligiblePositions(kind).includes(entry.position)) {
    throw new ValidationError('Los lanzamientos recibidos solo pueden asignarse a porteros.');
  }
}

export function assertValidEvent(match: Pick<Match, 'squad'>, e: MatchEvent): void {
  assertValidPayload(e);
  assertEligiblePlayer(match, e.kind, e.playerId);
  if (e.period !== 1 && e.period !== 2) throw new ValidationError('Parte no válida.');
  if (!Number.isFinite(e.matchTimeMs) || e.matchTimeMs < 0) throw new ValidationError('Tiempo no válido.');
}

/** Normaliza el código corto: mayúsculas, sin espacios. */
export function normalizeTeamCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, '');
}

export function assertValidTeamCode(code: string): void {
  if (!/^[A-Z0-9]{3,12}$/.test(code)) {
    throw new ValidationError('El código debe tener entre 3 y 12 letras o números, sin espacios.');
  }
}

/** Dorsales únicos dentro de la plantilla vigente (jugadores activos). */
export function assertUniqueNumber(
  players: readonly Pick<Player, 'id' | 'number' | 'active' | 'name'>[],
  candidate: { id: Id; number: number; active: boolean },
): void {
  if (!candidate.active) return;
  const clash = players.find((p) => p.active && p.id !== candidate.id && p.number === candidate.number);
  if (clash) throw new ValidationError(`El dorsal ${candidate.number} ya lo tiene ${clash.name}.`);
}

export function assertValidPlayerFields(p: { name: string; number: number; position: Position }): void {
  if (!p.name.trim()) throw new ValidationError('El nombre es obligatorio.');
  if (!Number.isInteger(p.number) || p.number < 0 || p.number > 99)
    throw new ValidationError('El dorsal debe ser un número entre 0 y 99.');
  if (p.position !== 'field' && p.position !== 'goalkeeper') throw new ValidationError('Posición no válida.');
}
