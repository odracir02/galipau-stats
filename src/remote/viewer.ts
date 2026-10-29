// Consulta de equipos del club: descarga el equipo completo (solo lectura) y lo
// guarda para verlo sin conexión. Los datos descargados viven en una base
// IndexedDB PROPIA («galipaustats-consulta»): nunca se mezclan con los equipos
// del dispositivo («galipaustats») ni con la sesión («galipaustats-cuenta»).
//
// Desde aquí no se escribe nunca en el servidor: solo GET del equipo completo
// y de sus cambios (GET /changes), con los que se actualiza en directo.
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { MatchWithEvents } from '../stats/engine';
import { countsForSeason } from '../services/statsService';
import { RemoteError, type Api, type ChangesPage, type RemoteTeam, type TeamSnapshot } from './api';
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

/**
 * Actualización en directo (ver live.ts): «live» solo con un partido en curso y
 * cuando la última consulta ha confirmado con el servidor que los datos están al
 * día; «paused», tras el máximo de seguimiento continuo.
 */
export type LiveStatus = 'checking' | 'live' | 'retrying' | 'offline' | 'stale' | 'paused';

export interface TeamView {
  cached: CachedTeam | null;
  /** Descarga pedida con «Actualizar» (las consultas en directo no la activan). */
  loading: boolean;
  /** Problema de la última descarga; si hay datos guardados, se siguen mostrando. */
  problem: ViewProblem | null;
  /** Última vez que el servidor confirmó que los datos estaban al día (ISO). */
  checkedAt?: string | null;
  /** null: sin actualización en directo para este equipo. */
  live?: LiveStatus | null;
}

/** Resultado de una consulta al servidor. */
export type FetchResult = 'ok' | 'offline' | 'error' | 'revoked';

const EMPTY: TeamView = { cached: null, loading: false, problem: null };

type VersionedEvent = TeamSnapshot['events'][number];

/** Mismo orden que la descarga completa del servidor. */
function eventOrder({ event: a }: VersionedEvent, { event: b }: VersionedEvent): number {
  const ka = [a.matchId, a.period, a.matchTimeMs, a.createdAt, a.id] as const;
  const kb = [b.matchId, b.period, b.matchTimeMs, b.createdAt, b.id] as const;
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i]! < kb[i]! ? -1 : 1;
  return 0;
}

/** Aplica a lo descargado unos cambios que solo afectan a acciones. */
export function applyEventChanges(snapshot: TeamSnapshot, page: ChangesPage): TeamSnapshot {
  const byId = new Map(snapshot.events.map((e) => [e.event.id, e]));
  for (const e of page.events) {
    const current = byId.get(e.event.id);
    if (!current || current.version <= e.version) byId.set(e.event.id, e);
  }
  return { ...snapshot, seq: page.nextSeq, events: [...byId.values()].sort(eventOrder) };
}

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
  private readonly queues = new Map<string, Promise<void>>();
  /** Aumenta al retirar un equipo: las respuestas pendientes de antes se descartan. */
  private readonly epochs = new Map<string, number>();

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
   * Con `quiet` no se muestra «Actualizando…» (actualización en directo).
   */
  refresh(team: RemoteTeam, { quiet = false }: { quiet?: boolean } = {}): Promise<FetchResult> {
    // La «época» se fija al pedirlo: si el equipo se retira después (acceso
    // revocado, «Salir», sesión cerrada), esta petición ya no guarda nada.
    const epoch = this.epoch(team.teamId);
    return this.exclusive(team.teamId, () => this.download(team, quiet, epoch));
  }

  /**
   * Consulta ligera para la actualización en directo: pide solo los cambios
   * posteriores a lo descargado. Sin cambios, no se descarga nada; si solo han
   * cambiado acciones, se aplican; si ha cambiado algo más (partido, jugador…)
   * o son muchos, se descarga el equipo completo.
   */
  poll(team: RemoteTeam): Promise<FetchResult> {
    const teamId = team.teamId;
    const epoch = this.epoch(teamId);
    return this.exclusive(teamId, async () => {
      if (this.epoch(teamId) !== epoch) return 'ok';
      const current = this.view(teamId).cached ?? (await this.store.get(teamId));
      if (this.epoch(teamId) !== epoch) return 'ok';
      if (!current) return this.download(team, true, epoch);
      const device = await this.account.getDevice();
      if (!device) return this.lost(teamId, 'revoked');
      const since = current.snapshot.seq;
      let page: ChangesPage;
      try {
        page = await this.api.changes(device.token, teamId, since);
      } catch (e) {
        return this.failed(teamId, epoch, e);
      }
      // Respuesta antigua: mientras tanto se retiró el equipo o llegaron datos más recientes.
      const latest = this.view(teamId).cached ?? current;
      if (this.epoch(teamId) !== epoch || latest.snapshot.seq !== since) return 'ok';
      if (page.nextSeq <= since) {
        this.set(teamId, { cached: latest, problem: null, checkedAt: this.now().toISOString() });
        return 'ok';
      }
      if (page.hasMore || page.others.length > 0) return this.download(team, true, epoch);
      await this.keep(teamId, epoch, { ...latest, snapshot: applyEventChanges(latest.snapshot, page), fetchedAt: this.now().toISOString() });
      return 'ok';
    });
  }

  /** Cambia el estado de la actualización en directo de un equipo. */
  setLive(teamId: string, live: LiveStatus | null): void {
    if (this.view(teamId).live !== live) this.set(teamId, { live });
  }

  /** Una consulta a la vez por equipo: nunca hay dos peticiones en paralelo. */
  private exclusive<T>(teamId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(teamId) ?? Promise.resolve()).then(fn, fn);
    this.queues.set(
      teamId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private epoch(teamId: string): number {
    return this.epochs.get(teamId) ?? 0;
  }

  private async download(team: RemoteTeam, quiet: boolean, epoch: number): Promise<FetchResult> {
    const teamId = team.teamId;
    if (this.epoch(teamId) !== epoch) return 'ok';
    const device = await this.account.getDevice();
    if (!device) return this.lost(teamId, 'revoked');
    if (this.epoch(teamId) !== epoch) return 'ok';
    if (!quiet) this.set(teamId, { loading: true });
    try {
      const snapshot = await this.api.snapshot(device.token, teamId);
      const latest = this.view(teamId).cached;
      // Nunca se sustituyen datos más recientes por una respuesta más antigua.
      if (this.epoch(teamId) !== epoch || (latest && latest.snapshot.seq > snapshot.seq)) {
        this.set(teamId, { loading: false });
        return 'ok';
      }
      await this.keep(teamId, epoch, { teamId, snapshot, fetchedAt: this.now().toISOString() });
      return 'ok';
    } catch (e) {
      return this.failed(teamId, epoch, e);
    }
  }

  /** Guarda lo descargado, salvo que el equipo se haya retirado mientras tanto. */
  private async keep(teamId: string, epoch: number, cached: CachedTeam): Promise<void> {
    if (this.epoch(teamId) !== epoch) return;
    await this.store.put(cached);
    if (this.epoch(teamId) !== epoch) {
      await this.store.delete(teamId);
      return;
    }
    this.set(teamId, { cached, loading: false, problem: null, checkedAt: cached.fetchedAt });
  }

  private async lost(teamId: string, problem: 'revoked' | 'no_access'): Promise<FetchResult> {
    await this.forget(teamId);
    this.set(teamId, { cached: null, loading: false, problem });
    return 'revoked';
  }

  private async failed(teamId: string, epoch: number, e: unknown): Promise<FetchResult> {
    if (!(e instanceof RemoteError)) throw e;
    if (e.kind === 'unauthorized') {
      // Credencial revocada: los datos del club dejan de mostrarse en este dispositivo.
      await this.lost(teamId, 'revoked');
      this.onUnauthorized();
      return 'revoked';
    }
    if (e.kind === 'forbidden' || e.kind === 'not_found') {
      // El servidor confirma que este dispositivo ya no puede ver el equipo.
      return this.lost(teamId, 'no_access');
    }
    const offline = e.kind === 'offline' || e.kind === 'timeout';
    // Equipo retirado mientras tanto: no se vuelve a mostrar nada de él.
    if (this.epoch(teamId) === epoch) this.set(teamId, { loading: false, problem: offline ? 'offline' : 'server' });
    return offline ? 'offline' : 'error';
  }

  /** Borra los datos descargados de un equipo (solo en esta base de consulta). */
  async forget(teamId: string): Promise<void> {
    this.epochs.set(teamId, this.epoch(teamId) + 1);
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
    // También los que solo están en memoria o tienen una descarga en curso
    // (aún sin guardar): esa descarga ya no podrá guardarlos.
    const known = new Set([...this.views.keys(), ...this.queues.keys()]);
    for (const id of known) if (!allowed.has(id)) this.epochs.set(id, this.epoch(id) + 1);
    for (const id of new Set([...known, ...(await this.store.keys())])) if (!allowed.has(id)) await this.forget(id);
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
