import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Id, Match, MatchEvent, Player, Team } from '../domain/types';
import { compareEvents } from '../domain/events';
import {
  ConcurrentChangeError,
  RecordExistsError,
  StorageError,
  type LocalSnapshot,
  type RecordChange,
  type Repository,
  type TeamData,
  type TeamDataStore,
} from './repository';

export const DB_NAME = 'galipaustats';
export const DB_VERSION = 1;

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

export class IndexedDbRepository implements Repository, TeamDataStore {
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

  // --- Equipos completos (una transacción por operación) -------------------------

  async addTeamData(data: TeamData): Promise<void> {
    try {
      const db = await this.dbPromise;
      const tx = db.transaction(['teams', 'players', 'matches', 'events'], 'readwrite', { durability: 'strict' });
      // add (no put): si cualquier registro ya existe, la transacción entera se anula.
      const writes = [
        tx.objectStore('teams').add(clone(data.team)),
        ...data.players.map((p) => tx.objectStore('players').add(clone(p))),
        ...data.matches.map((m) => tx.objectStore('matches').add(clone(m))),
        ...data.events.map((e) => tx.objectStore('events').add(clone(e))),
      ];
      await Promise.all([...writes, tx.done]);
    } catch (cause) {
      if ((cause as { name?: string } | null)?.name === 'ConstraintError') throw new RecordExistsError({ cause });
      throw new StorageError('No se pudo guardar el equipo en el almacenamiento del dispositivo.', { cause });
    }
  }

  replaceTeamData(data: TeamData): Promise<void> {
    return this.run('guardar el equipo', async (db) => {
      const tx = db.transaction(['teams', 'players', 'matches', 'events'], 'readwrite', { durability: 'strict' });
      await Promise.all([
        tx.objectStore('teams').put(clone(data.team)),
        ...data.players.map((p) => tx.objectStore('players').put(clone(p))),
        ...data.matches.map((m) => tx.objectStore('matches').put(clone(m))),
        ...data.events.map((e) => tx.objectStore('events').put(clone(e))),
        tx.done,
      ]);
    });
  }

  readTeamData(teamId: Id): Promise<TeamData | null> {
    return this.run('leer el equipo', async (db) => {
      const tx = db.transaction(['teams', 'players', 'matches', 'events'], 'readonly');
      const team = await tx.objectStore('teams').get(teamId);
      const players = await tx.objectStore('players').index('byTeam').getAll(teamId);
      const matches = await tx.objectStore('matches').index('byTeam').getAll(teamId);
      const events = (await Promise.all(matches.map((m) => tx.objectStore('events').index('byMatch').getAll(m.id)))).flat();
      await tx.done;
      return team ? clone({ team, players, matches, events }) : null;
    });
  }

  removeTeamData(teamId: Id): Promise<void> {
    return this.run('borrar el equipo', async (db) => {
      const tx = db.transaction(['teams', 'players', 'matches', 'events'], 'readwrite', { durability: 'strict' });
      const players = await tx.objectStore('players').index('byTeam').getAllKeys(teamId);
      const matches = await tx.objectStore('matches').index('byTeam').getAllKeys(teamId);
      const events = (await Promise.all(matches.map((id) => tx.objectStore('events').index('byMatch').getAllKeys(id)))).flat();
      await Promise.all([
        ...events.map((id) => tx.objectStore('events').delete(id)),
        ...matches.map((id) => tx.objectStore('matches').delete(id)),
        ...players.map((id) => tx.objectStore('players').delete(id)),
        tx.objectStore('teams').delete(teamId),
        tx.done,
      ]);
    });
  }

  async applyRecords(changes: readonly RecordChange[]): Promise<void> {
    if (changes.length === 0) return;
    let changed = false;
    try {
      const db = await this.dbPromise;
      const tx = db.transaction(['players', 'matches', 'events'], 'readwrite', { durability: 'strict' });
      for (const c of changes) {
        const store = tx.objectStore(c.store);
        const current = await store.get(c.record.id);
        if (!(c.expect as (x: unknown) => boolean)(current)) {
          changed = true;
          tx.abort();
          break;
        }
        await store.put(clone(c.record) as never);
      }
      await tx.done;
    } catch (cause) {
      if (changed) throw new ConcurrentChangeError();
      throw new StorageError('No se pudieron guardar los cambios del club en el almacenamiento del dispositivo.', { cause });
    }
  }

  readAll(): Promise<LocalSnapshot> {
    return this.run('leer los datos', async (db) => {
      // Una sola transacción de solo lectura sobre los cuatro almacenes.
      const tx = db.transaction(['teams', 'players', 'matches', 'events'], 'readonly');
      const [teams, players, matches, events] = await Promise.all([
        tx.objectStore('teams').getAll(),
        tx.objectStore('players').getAll(),
        tx.objectStore('matches').getAll(),
        tx.objectStore('events').getAll(),
      ]);
      await tx.done;
      return clone({ teams, players, matches, events });
    });
  }
}

