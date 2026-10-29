// Consulta de equipos del club: descarga el equipo completo (solo lectura) y lo
// guarda para verlo sin conexión. Los datos descargados viven en una base
// IndexedDB PROPIA («galipaustats-consulta»): nunca se mezclan con los equipos
// del dispositivo («galipaustats») ni con la sesión («galipaustats-cuenta»).
//
// Desde aquí no se escribe nunca en el servidor: solo GET del equipo completo.
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { MatchWithEvents } from '../stats/engine';
import { countsForSeason } from '../services/statsService';
import { RemoteError, type Api, type RemoteTeam, type TeamSnapshot } from './api';
import type { RemoteSession } from './session';
import type { AccountStore } from './store';

export const VIEWER_DB_NAME = 'galipaustats-consulta';

export interface CachedTeam {
  teamId: string;
  snapshot: TeamSnapshot;
  /** Momento de la última descarga correcta (ISO). */
  fetchedAt: string;
}

interface ViewerDB extends DBSchema {
  teams: { key: string; value: CachedTeam };
}

export class ViewerStore {
  private readonly dbPromise: Promise<IDBPDatabase<ViewerDB>>;

  constructor(name: string = VIEWER_DB_NAME) {
    this.dbPromise = openDB<ViewerDB>(name, 1, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) db.createObjectStore('teams', { keyPath: 'teamId' });
      },
    });
  }

  async get(teamId: string): Promise<CachedTeam | null> {
    return (await (await this.dbPromise).get('teams', teamId)) ?? null;
  }

  async put(team: CachedTeam): Promise<void> {
    await (await this.dbPromise).put('teams', team);
  }

  async delete(teamId: string): Promise<void> {
    await (await this.dbPromise).delete('teams', teamId);
  }

  async keys(): Promise<string[]> {
    return (await this.dbPromise).getAllKeys('teams');
  }
}

export type ViewProblem = 'offline' | 'server' | 'revoked' | 'no_access';

export interface TeamView {
  cached: CachedTeam | null;
  loading: boolean;
  /** Problema de la última descarga; si hay datos guardados, se siguen mostrando. */
  problem: ViewProblem | null;
}

const EMPTY: TeamView = { cached: null, loading: false, problem: null };

/** Partidos que cuentan para la temporada, con sus acciones (como en el equipo local). */
export function seasonItems(snapshot: TeamSnapshot): MatchWithEvents[] {
  const byMatch = new Map<string, TeamSnapshot['events'][number]['event'][]>();
  for (const { event } of snapshot.events) byMatch.set(event.matchId, [...(byMatch.get(event.matchId) ?? []), event]);
  return snapshot.matches
    .filter(({ match }) => match.deletedAt === null)
    .map(({ match }) => ({ match, events: byMatch.get(match.id) ?? [] }))
    .filter(({ match, events }) => countsForSeason(match, events));
}

export class ClubViewer {
  private readonly views = new Map<string, TeamView>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly api: Api,
    private readonly account: AccountStore,
    private readonly store: ViewerStore,
    private readonly now: () => Date = () => new Date(),
    /** Se avisa cuando el servidor rechaza la credencial (para comprobar la sesión). */
    private readonly onUnauthorized: () => void = () => undefined,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  view = (teamId: string): TeamView => this.views.get(teamId) ?? EMPTY;

  private set(teamId: string, patch: Partial<TeamView>): void {
    this.views.set(teamId, { ...this.view(teamId), ...patch });
    for (const l of this.listeners) l();
  }

  /** Muestra lo guardado (si lo hay) sin ir a la red. */
  async load(teamId: string): Promise<void> {
    const cached = await this.store.get(teamId);
    this.set(teamId, { cached });
  }

  /**
   * Descarga de nuevo el equipo completo. Solo para equipos a los que la sesión
   * da acceso. Si falla por conexión, se conserva lo último descargado; si el
   * servidor confirma que ya no hay acceso, se borra lo guardado de ese equipo.
   */
  async refresh(team: RemoteTeam): Promise<void> {
    const device = await this.account.getDevice();
    if (!device) {
      await this.forget(team.teamId);
      this.set(team.teamId, { problem: 'revoked', loading: false });
      return;
    }
    this.set(team.teamId, { loading: true });
    try {
      const snapshot = await this.api.snapshot(device.token, team.teamId);
      const cached: CachedTeam = { teamId: team.teamId, snapshot, fetchedAt: this.now().toISOString() };
      await this.store.put(cached);
      this.set(team.teamId, { cached, loading: false, problem: null });
    } catch (e) {
      if (!(e instanceof RemoteError)) throw e;
      if (e.kind === 'unauthorized') {
        // Credencial revocada: los datos del club dejan de mostrarse en este dispositivo.
        await this.forget(team.teamId);
        this.set(team.teamId, { cached: null, loading: false, problem: 'revoked' });
        this.onUnauthorized();
      } else if (e.kind === 'forbidden' || e.kind === 'not_found') {
        // El servidor confirma que este dispositivo ya no puede ver el equipo.
        await this.forget(team.teamId);
        this.set(team.teamId, { cached: null, loading: false, problem: 'no_access' });
      } else {
        const offline = e.kind === 'offline' || e.kind === 'timeout';
        this.set(team.teamId, { loading: false, problem: offline ? 'offline' : 'server' });
      }
    }
  }

  /** Borra los datos descargados de un equipo (solo en esta base de consulta). */
  async forget(teamId: string): Promise<void> {
    await this.store.delete(teamId);
    this.views.delete(teamId);
    for (const l of this.listeners) l();
  }

  /**
   * Tras una comprobación correcta de la sesión, retira lo descargado de los
   * equipos a los que ya no se tiene acceso (o de todos, si no hay sesión).
   */
  async keepOnly(teamIds: readonly string[]): Promise<void> {
    const allowed = new Set(teamIds);
    for (const id of await this.store.keys()) if (!allowed.has(id)) await this.forget(id);
  }

  /**
   * Sigue a la sesión: sin sesión (cerrada o revocada) se borra todo lo
   * descargado; tras cada comprobación correcta con el servidor, lo de los
   * equipos que ya no son accesibles. Sin conexión no se borra nada: la
   * revocación aún no se ha podido verificar.
   */
  followSession(session: Pick<RemoteSession, 'getState' | 'subscribe'>): () => void {
    let lastChecked: string | null = null;
    const check = () => {
      const s = session.getState();
      if (!s.ready || s.checking) return;
      if (!s.linked) {
        lastChecked = null;
        void this.keepOnly([]);
      } else if (s.problem === null && s.checkedAt && s.checkedAt !== lastChecked) {
        lastChecked = s.checkedAt;
        void this.keepOnly(s.teams.filter((t) => t.status === 'active').map((t) => t.teamId));
      }
    };
    check();
    return session.subscribe(check);
  }
}
