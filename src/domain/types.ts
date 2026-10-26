// Modelo de dominio de GalipauStats.
// Los eventos son la fuente de verdad; las estadísticas se derivan siempre de ellos.

export type Id = string;

/** Fecha/hora ISO 8601 (UTC). */
export type IsoDateTime = string;

/** Fecha de calendario local, formato YYYY-MM-DD. */
export type LocalDate = string;

export type Position = 'field' | 'goalkeeper';

export interface Team {
  id: Id;
  name: string;
  /** Código corto identificativo (p. ej. SM2627). No es una contraseña. */
  code: string;
  /** Temporada vigente, propuesta por defecto al crear partidos (p. ej. 2026/27). */
  season: string;
  /** Límite configurable de convocados por partido. */
  maxSquad: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface Player {
  id: Id;
  teamId: Id;
  name: string;
  number: number;
  position: Position;
  active: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/**
 * Copia de los datos del jugador en el momento del partido. Si después cambia
 * su nombre, dorsal o posición, el partido conserva lo que había entonces.
 */
export interface SquadEntry {
  playerId: Id;
  name: string;
  number: number;
  position: Position;
}

export type Period = 1 | 2;

/**
 * Estado persistente del cronómetro. El tiempo nunca se acumula con intervalos:
 * se reconstruye a partir de una referencia de reloj de pared.
 */
export interface ClockState {
  period: Period;
  running: boolean;
  /** Tiempo de partido acumulado (ms) en el último punto de anclaje. */
  baseMs: number;
  /** Date.now() en el momento en que se puso en marcha; null si está parado. */
  anchorWallMs: number | null;
}

export type MatchStatus = 'ready' | 'in_progress' | 'halftime' | 'finished';

export type Venue = 'home' | 'away';

/** Corrección manual del marcador, separada de lo acreditado por eventos. */
export interface ScoreAdjustment {
  own: number;
  opponent: number;
}

export interface Match {
  id: Id;
  teamId: Id;
  opponent: string;
  date: LocalDate;
  venue: Venue;
  season: string;
  status: MatchStatus;
  /** Duración nominal de cada parte, en minutos (habitualmente 30). */
  halfMinutes: number;
  squad: SquadEntry[];
  clock: ClockState;
  scoreAdjustment: ScoreAdjustment;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  finishedAt: IsoDateTime | null;
  /** Borrado lógico (preparado para una futura sincronización). */
  deletedAt: IsoDateTime | null;
}

// --- Eventos -------------------------------------------------------------

/** Lanzamientos de nuestros jugadores de campo. */
export type FieldShotType = 'nine_m' | 'six_m' | 'penalty' | 'fast_break';
export type FieldShotResult = 'goal' | 'out' | 'saved';

/** Lanzamientos recibidos por nuestros porteros. */
export type GkShotType = 'nine_m' | 'six_m' | 'wing' | 'fast_break' | 'penalty';
export type GkShotResult = 'goal' | 'save' | 'out';

export type TurnoverType = 'general' | 'steps' | 'double' | 'bad_pass';

interface EventBase {
  id: Id;
  matchId: Id;
  /** Jugador; null = acción pendiente de atribución. */
  playerId: Id | null;
  period: Period;
  /** Tiempo de partido (ms) en el momento del registro. */
  matchTimeMs: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  /** Borrado lógico: un evento borrado no cuenta en ninguna estadística. */
  deletedAt: IsoDateTime | null;
}

export interface ShotEvent extends EventBase {
  kind: 'shot';
  shotType: FieldShotType;
  result: FieldShotResult;
}

export interface GkShotEvent extends EventBase {
  kind: 'gk_shot';
  shotType: GkShotType;
  result: GkShotResult;
}

export interface TurnoverEvent extends EventBase {
  kind: 'turnover';
  turnoverType: TurnoverType;
}

/** Acciones simples, sin subtipo ni resultado. */
export type SimpleEventKind =
  | 'recovery'
  | 'yellow'
  | 'exclusion'
  | 'red'
  | 'free_throw'
  | 'penalty_committed';

export interface SimpleEvent extends EventBase {
  kind: SimpleEventKind;
}

export type MatchEvent = ShotEvent | GkShotEvent | TurnoverEvent | SimpleEvent;
export type EventKind = MatchEvent['kind'];

/** Parte "de contenido" de un evento, lo que el usuario elige o corrige. */
export type EventPayload =
  | Pick<ShotEvent, 'kind' | 'shotType' | 'result'>
  | Pick<GkShotEvent, 'kind' | 'shotType' | 'result'>
  | Pick<TurnoverEvent, 'kind' | 'turnoverType'>
  | Pick<SimpleEvent, 'kind'>;
