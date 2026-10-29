// Catálogo cerrado de acciones (planilla de evaluación). No añadir categorías
// estadísticas aquí sin aprobación expresa.
import type {
  EventKind,
  EventPayload,
  FieldShotResult,
  FieldShotType,
  GkShotResult,
  GkShotType,
  MatchEvent,
  MatchStatus,
  Position,
  SimpleEventKind,
  TurnoverType,
} from './types';

export const FIELD_SHOT_TYPES: readonly FieldShotType[] = ['nine_m', 'six_m', 'penalty', 'fast_break'];
export const FIELD_SHOT_RESULTS: readonly FieldShotResult[] = ['goal', 'out', 'saved'];

export const GK_SHOT_TYPES: readonly GkShotType[] = ['nine_m', 'six_m', 'wing', 'fast_break', 'penalty'];
export const GK_SHOT_RESULTS: readonly GkShotResult[] = ['goal', 'save', 'out'];

export const TURNOVER_TYPES: readonly TurnoverType[] = ['general', 'steps', 'double', 'bad_pass'];

/** Acciones del grupo «Defensa y sanciones» que se registran. */
export const DEFENSE_KINDS: readonly SimpleEventKind[] = ['yellow', 'exclusion', 'red', 'penalty_committed'];

/**
 * Acciones de equipo: se registran con un toque y sin jugador. El golpe franco
 * sancionado contra nuestro equipo es la única. Sin jugador no son «pendientes
 * de atribuir»: no hay nadie a quien atribuirlas.
 */
export const TEAM_KINDS: readonly SimpleEventKind[] = ['free_throw'];

export function isTeamKind(kind: EventKind): boolean {
  return (TEAM_KINDS as readonly EventKind[]).includes(kind);
}

/** Acciones simples que se pueden registrar hoy. */
export const SIMPLE_KINDS: readonly SimpleEventKind[] = ['recovery', ...DEFENSE_KINDS, ...TEAM_KINDS];

/**
 * Categorías históricas: ya no se registran, pero los eventos antiguos siguen
 * siendo válidos, se pueden leer, corregir o eliminar, y nunca se borran solos.
 * Hoy no hay ninguna: el golpe franco, retirado antes, vuelve como acción de
 * equipo (sus eventos antiguos, asignados a un jugador, se conservan tal cual).
 */
export const LEGACY_KINDS: readonly SimpleEventKind[] = [];

export function isLegacyKind(kind: EventKind): boolean {
  return (LEGACY_KINDS as readonly EventKind[]).includes(kind);
}

export const FIELD_SHOT_TYPE_LABEL: Record<FieldShotType, string> = {
  nine_m: '9 m / sobre defensa',
  six_m: 'Penetración / 6 m',
  penalty: 'Penalti',
  fast_break: 'Contraataque',
};

export const GK_SHOT_TYPE_LABEL: Record<GkShotType, string> = {
  nine_m: '9 m / sobre defensa',
  six_m: 'Penetración / 6 m',
  wing: 'Extremo',
  fast_break: 'Contraataque',
  penalty: 'Penalti',
};

/** Etiquetas cortas para botones y listas compactas. */
export const FIELD_SHOT_TYPE_SHORT: Record<FieldShotType, string> = {
  nine_m: '9 m',
  six_m: '6 m',
  penalty: 'Penalti',
  fast_break: 'Contraataque',
};

export const GK_SHOT_TYPE_SHORT: Record<GkShotType, string> = {
  nine_m: '9 m',
  six_m: '6 m',
  wing: 'Extremo',
  fast_break: 'Contraataque',
  penalty: 'Penalti',
};

export const FIELD_SHOT_RESULT_LABEL: Record<FieldShotResult, string> = {
  goal: 'Gol',
  out: 'Fuera',
  saved: 'Parada',
};

export const GK_SHOT_RESULT_LABEL: Record<GkShotResult, string> = {
  goal: 'Gol recibido',
  save: 'Parada',
  out: 'Fuera',
};

export const TURNOVER_LABEL: Record<TurnoverType, string> = {
  general: 'Pérdida',
  steps: 'Pasos',
  double: 'Dobles',
  bad_pass: 'Pase fallado',
};

export const SIMPLE_KIND_LABEL: Record<SimpleEventKind, string> = {
  recovery: 'Recuperación',
  yellow: 'Tarjeta amarilla',
  exclusion: 'Exclusión 2 min',
  red: 'Tarjeta roja',
  free_throw: 'Golpe franco',
  penalty_committed: 'Penalti cometido',
};

export const KIND_LABEL: Record<EventKind, string> = {
  shot: 'Lanzamiento',
  gk_shot: 'Portería',
  turnover: 'Pérdida',
  ...SIMPLE_KIND_LABEL,
};

export const MATCH_STATUS_LABEL: Record<MatchStatus, string> = {
  ready: 'Preparado',
  in_progress: 'En curso',
  halftime: 'Descanso',
  finished: 'Finalizado',
};

/**
 * Qué jugadores convocados pueden recibir cada tipo de acción. Un portero puede
 * lanzar (p. ej. a portería vacía); solo los porteros reciben lanzamientos.
 */
export function eligiblePositions(kind: EventKind): readonly Position[] {
  if (kind === 'gk_shot') return ['goalkeeper'];
  return ['field', 'goalkeeper'];
}

/** Descripción legible de la acción (sin jugador ni tiempo). */
export function describePayload(p: EventPayload | MatchEvent): string {
  switch (p.kind) {
    case 'shot':
      return `${FIELD_SHOT_RESULT_LABEL[p.result]} · ${FIELD_SHOT_TYPE_SHORT[p.shotType]}`;
    case 'gk_shot':
      return `${GK_SHOT_RESULT_LABEL[p.result]} · ${GK_SHOT_TYPE_SHORT[p.shotType]}`;
    case 'turnover':
      return TURNOVER_LABEL[p.turnoverType];
    default:
      return SIMPLE_KIND_LABEL[p.kind];
  }
}

/** Extrae la parte de contenido de un evento. */
export function payloadOf(e: MatchEvent): EventPayload {
  switch (e.kind) {
    case 'shot':
      return { kind: 'shot', shotType: e.shotType, result: e.result };
    case 'gk_shot':
      return { kind: 'gk_shot', shotType: e.shotType, result: e.result };
    case 'turnover':
      return { kind: 'turnover', turnoverType: e.turnoverType };
    default:
      return { kind: e.kind };
  }
}
