import type { Id, Match, MatchEvent, Player, Team } from '../domain/types';

/**
 * Acceso a datos. La interfaz no sabe nada de IndexedDB: en una tarea posterior
 * podrá envolverse con un repositorio que además sincronice con el servidor sin
 * que los componentes ni los servicios cambien.
 *
 * Todas las escrituras son `put` por identificador: repetir la misma operación
 * (doble pulsación, reintento, recarga) no crea duplicados.
 */
export interface Repository {
  listTeams(): Promise<Team[]>;
  getTeam(id: Id): Promise<Team | undefined>;
  saveTeam(team: Team): Promise<void>;

  listPlayers(teamId: Id): Promise<Player[]>;
  getPlayer(id: Id): Promise<Player | undefined>;
  savePlayer(player: Player): Promise<void>;

  /** Partidos del equipo (excluye los borrados). */
  listMatches(teamId: Id): Promise<Match[]>;
  getMatch(id: Id): Promise<Match | undefined>;
  saveMatch(match: Match): Promise<void>;

  /** Eventos del partido, incluidos los borrados lógicamente. */
  listEvents(matchId: Id): Promise<MatchEvent[]>;
  getEvent(id: Id): Promise<MatchEvent | undefined>;
  saveEvent(event: MatchEvent): Promise<void>;

  /**
   * Todo lo guardado, incluidos partidos y acciones eliminados lógicamente,
   * leído en una sola transacción de lectura (copia coherente). Solo lectura.
   */
  readAll(): Promise<LocalSnapshot>;
}

export interface LocalSnapshot {
  teams: Team[];
  players: Player[];
  matches: Match[];
  events: MatchEvent[];
}

/** Un equipo completo: el equipo, su plantilla, sus partidos (también eliminados) y sus acciones. */
export interface TeamData {
  team: Team;
  players: Player[];
  matches: Match[];
  events: MatchEvent[];
}

/**
 * Operaciones sobre un equipo completo, cada una en UNA transacción: o se aplica
 * entera o no se aplica nada (nunca quedan registros a medias a la vista).
 * Solo para incorporar o retirar copias de equipos del club.
 */
export interface TeamDataStore {
  /** Añade un equipo nuevo. Falla sin escribir nada si alguno de sus registros ya existe. */
  addTeamData(data: TeamData): Promise<void>;
  /** Sustituye los registros de un equipo ya guardado (mismos identificadores). */
  replaceTeamData(data: TeamData): Promise<void>;
  /** Lee un equipo completo en una sola lectura coherente (null si no existe). */
  readTeamData(teamId: Id): Promise<TeamData | null>;
  /** Borra un equipo y todos sus registros. */
  removeTeamData(teamId: Id): Promise<void>;
  /**
   * Guarda cambios recibidos del club, todos en una transacción. Antes de
   * escribir cada registro se comprueba, dentro de la misma transacción, que
   * el que hay guardado sigue siendo el esperado: si alguien lo ha cambiado
   * entretanto, no se escribe nada (ConcurrentChangeError).
   */
  applyRecords(changes: readonly RecordChange[]): Promise<void>;
}

export type RecordChange =
  | { store: 'players'; record: Player; expect: (current: Player | undefined) => boolean }
  | { store: 'matches'; record: Match; expect: (current: Match | undefined) => boolean }
  | { store: 'events'; record: MatchEvent; expect: (current: MatchEvent | undefined) => boolean };

/** Un registro cambió en el dispositivo mientras se aplicaban cambios del club: no se ha escrito nada. */
export class ConcurrentChangeError extends Error {
  override name = 'ConcurrentChangeError';
  constructor() {
    super('Un dato cambió en este dispositivo mientras se recibían los cambios del club.');
  }
}

/** Algún registro que se iba a añadir ya existe en el dispositivo: no se ha escrito nada. */
export class RecordExistsError extends Error {
  override name = 'RecordExistsError';
  constructor(options?: { cause?: unknown }) {
    super('Algunos de estos datos ya existen en el dispositivo.', options);
  }
}

export class StorageError extends Error {
  override name = 'StorageError';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}
