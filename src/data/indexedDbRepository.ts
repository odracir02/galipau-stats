import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Id, Match, MatchEvent, Player, Team } from '../domain/types';
import { compareEvents } from '../domain/events';
import { StorageError, type Repository } from './repository';

export const DB_NAME = 'galipaustats';
const DB_VERSION = 1;

interface StatsDB extends DBSchema {
  teams: { key: Id; value: Team };
  players: { key: Id; value: Player; indexes: { byTeam: Id } };
  matches: { key: Id; value: Match; indexes: { byTeam: Id } };
  events: { key: Id; value: MatchEvent; indexes: { byMatch: Id } };
}

export function openStatsDb(name: string = DB_NAME): Promise<IDBPDatabase<StatsDB>> {
  return openDB<StatsDB>(name, DB_VERSION, {
    upgrade(db, oldVersion) {
      // Migraciones incrementales: cada versión añade sus cambios.
      if (oldVersion < 1) {
        db.createObjectStore('teams', { keyPath: 'id' });
        db.createObjectStore('players', { keyPath: 'id' }).createIndex('byTeam', 'teamId');
        db.createObjectStore('matches', { keyPath: 'id' }).createIndex('byTeam', 'teamId');
        db.createObjectStore('events', { keyPath: 'id' }).createIndex('byMatch', 'matchId');
      }
    },
    blocked() {
      console.warn('GalipauStats: hay otra pestaña con una versión antigua de la base de datos abierta.');
    },
  });
}

/** Copia profunda para que nadie mute los objetos que se guardan o se leen. */
const clone = <T>(value: T): T => structuredClone(value);

export class IndexedDbRepository implements Repository {
  private readonly dbPromise: Promise<IDBPDatabase<StatsDB>>;

  constructor(name: string = DB_NAME) {
    this.dbPromise = openStatsDb(name);
  }

  private async run<T>(what: string, fn: (db: IDBPDatabase<StatsDB>) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.dbPromise);
    } catch (cause) {
      throw new StorageError(`No se pudo ${what} en el almacenamiento del dispositivo.`, { cause });
    }
  }

  /** `put` dentro de una transacción que se espera hasta confirmarse en disco. */
  private put<S extends 'teams' | 'players' | 'matches' | 'events'>(
    store: S,
    value: StatsDB[S]['value'],
    what: string,
  ): Promise<void> {
    return this.run(what, async (db) => {
      const tx = db.transaction(store, 'readwrite', { durability: 'strict' });
      await tx.store.put(clone(value));
      await tx.done;
    });
  }

  listTeams() {
    return this.run('leer los equipos', async (db) =>
      (await db.getAll('teams')).sort((a, b) => a.name.localeCompare(b.name, 'es')),
    );
  }
  getTeam(id: Id) {
    return this.run('leer el equipo', (db) => db.get('teams', id));
  }
  saveTeam(team: Team) {
    return this.put('teams', team, 'guardar el equipo');
  }

  listPlayers(teamId: Id) {
    return this.run('leer la plantilla', async (db) =>
      (await db.getAllFromIndex('players', 'byTeam', teamId)).sort((a, b) => a.number - b.number),
    );
  }
  getPlayer(id: Id) {
    return this.run('leer el jugador', (db) => db.get('players', id));
  }
  savePlayer(player: Player) {
    return this.put('players', player, 'guardar el jugador');
  }

  listMatches(teamId: Id) {
    return this.run('leer los partidos', async (db) =>
      (await db.getAllFromIndex('matches', 'byTeam', teamId))
        .filter((m) => m.deletedAt === null)
        .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)),
    );
  }
  getMatch(id: Id) {
    return this.run('leer el partido', (db) => db.get('matches', id));
  }
  saveMatch(match: Match) {
    return this.put('matches', match, 'guardar el partido');
  }

  listEvents(matchId: Id) {
    return this.run('leer las acciones', async (db) =>
      (await db.getAllFromIndex('events', 'byMatch', matchId)).sort(compareEvents),
    );
  }
  getEvent(id: Id) {
    return this.run('leer la acción', (db) => db.get('events', id));
  }
  saveEvent(event: MatchEvent) {
    return this.put('events', event, 'guardar la acción');
  }
}

