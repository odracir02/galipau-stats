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
}

export class StorageError extends Error {
  override name = 'StorageError';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}
