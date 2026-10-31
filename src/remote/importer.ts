// Copia de un equipo del club en este dispositivo, para entrenadores. Ver
// docs/SINCRONIZACION.md.
//
// * Solo con permiso de entrenador vigente, y solo si el equipo del club no está
//   ya vinculado con un equipo de este dispositivo (p. ej. el del registrador
//   original): nunca se duplica ni se fusiona nada.
// * Se conservan los identificadores del servidor y se anotan sus versiones y
//   huellas, así que la copia queda «sincronizada»: no hay nada pendiente ni se
//   reenvía nada.
// * Se hace sola al canjear un código de entrenador (incorporate): un equipo,
//   una entrada. La copia se edita como cualquier equipo; los cambios del club
//   llegan con la recepción de cambios (pull.ts).
// * Al perder el permiso, una copia sin cambios propios se retira; con cambios
//   sin enviar se conserva bloqueada para recuperarla con autorización.
// * Atomicidad: los datos del equipo se escriben en una sola transacción de la
//   base local, y el vínculo con sus versiones en otra de la base de la cuenta.
//   El vínculo se registra antes como «pendiente» (de solo lectura); si algo se
//   interrumpe, la importación se puede reanudar o descartar y nunca queda a la
//   vista un equipo a medias ni un equipo sin vincular.
import type { Repository, TeamData, TeamDataStore } from '../data/repository';
import { RecordExistsError } from '../data/repository';
import { newId } from '../domain/ids';
import type { Id, Team } from '../domain/types';
import { RemoteError, type Api, type RemoteTeam, type TeamSnapshot } from './api';
import type { RemoteSession } from './session';
import { metaKey, type AccountStore, type SyncEntity, type SyncMeta, type TeamLink } from './store';
import { eventContent, matchContent, playerContent, sha256, stableJson, waitForLock } from './upload';

/** Situación de un equipo del club en este dispositivo. */
export type ImportState =
  /** Vinculado con un equipo propio de este dispositivo (p. ej. el del registrador). */
  | { kind: 'linked'; link: TeamLink }
  /** Copia del club en este dispositivo. */
  | { kind: 'imported'; link: TeamLink }
  /** Importación interrumpida: se puede reanudar o descartar. */
  | { kind: 'pending'; link: TeamLink }
  /** Se puede importar (permiso de entrenador vigente). */
  | { kind: 'available' }
  /** Sin permiso de entrenador o equipo no disponible. */
  | { kind: 'not_allowed' };

export type ImportPhase = 'download' | 'check' | 'save' | 'verify';

export interface ImportSummary {
  localTeamId: Id;
  players: number;
  matches: number;
  deletedMatches: number;
  events: number;
  deletedEvents: number;
}

const DEFAULT_MAX_SQUAD = 16;

const hashOf = async (content: unknown) => sha256(stableJson(content));

/** Huellas del servidor de cada registro de la descarga (las mismas que calcula el envío). */
async function serverHashes(snapshot: TeamSnapshot): Promise<Map<string, { entity: SyncEntity; id: string; version: number; hash: string }>> {
  const out = new Map<string, { entity: SyncEntity; id: string; version: number; hash: string }>();
  for (const { version, player } of snapshot.players) out.set(metaKey('player', player.id), { entity: 'player', id: player.id, version, hash: await hashOf(playerContent(player)) });
  for (const { version, match } of snapshot.matches) out.set(metaKey('match', match.id), { entity: 'match', id: match.id, version, hash: await hashOf(matchContent(match)) });
  for (const { version, event } of snapshot.events) out.set(metaKey('event', event.id), { entity: 'event', id: event.id, version, hash: await hashOf(eventContent(event)) });
  return out;
}

/** Huellas de los registros locales, tal como se enviarían al equipo del club. */
async function localHashes(data: TeamData, remoteTeamId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const p of data.players) out.set(metaKey('player', p.id), await hashOf(playerContent({ ...p, teamId: remoteTeamId })));
  for (const m of data.matches) out.set(metaKey('match', m.id), await hashOf(matchContent({ ...m, teamId: remoteTeamId })));
  for (const e of data.events) out.set(metaKey('event', e.id), await hashOf(eventContent(e)));
  return out;
}

/** El equipo del club como equipo de este dispositivo (mismos identificadores). */
function toLocal(snapshot: TeamSnapshot, team: Team): TeamData {
  return {
    team,
    players: snapshot.players.map(({ player }) => ({ ...player, teamId: team.id })),
    matches: snapshot.matches.map(({ match }) => ({ ...match, teamId: team.id })),
    events: snapshot.events.map(({ event }) => event),
  };
}

export class TeamImporter {
  /** Vínculos de copias importadas, por equipo local (para saber cuáles son de solo lectura). */
  private readonly imported = new Map<Id, TeamLink>();
  private readonly listeners = new Set<() => void>();
  private loaded: Promise<void> | null = null;

  constructor(
    private readonly local: Repository & TeamDataStore,
    private readonly store: AccountStore,
    private readonly api: Api,
    /** Equipos y permisos vigentes según la última comprobación de la sesión. */
    private readonly remoteTeams: () => RemoteTeam[],
    private readonly now: () => Date = () => new Date(),
  ) {}

  // --- Solo lectura (lo consulta el repositorio antes de cada escritura) ------------

  /** Lee los vínculos guardados. Se llama al arrancar y tras cada cambio. */
  load(): Promise<void> {
    this.loaded = (async () => {
      const links = await this.store.listLinks();
      this.imported.clear();
      for (const l of links) if (l.origin === 'imported') this.imported.set(l.localTeamId, l);
      this.emit();
    })();
    return this.loaded;
  }

  /** Mientras no se sepa, se supone que puede haber copias (se espera a leerlas). */
  any(): boolean {
    return this.loaded === null || this.imported.size > 0;
  }

  async isReadOnly(teamId: Id): Promise<boolean> {
    await (this.loaded ?? this.load());
    const link = this.imported.get(teamId);
    return link !== undefined && (link.readOnly === true || link.importState === 'pending');
  }

  /** Vínculo de la copia importada de este equipo local (null si no lo es). Síncrono, tras cargar. */
  importedLink(teamId: Id): TeamLink | null {
    return this.imported.get(teamId) ?? null;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit(): void {
    for (const l of this.listeners) l();
  }

  // --- Estado ------------------------------------------------------------------------

  private coachTeam(remoteTeamId: string): RemoteTeam | undefined {
    return this.remoteTeams().find((t) => t.teamId === remoteTeamId && t.role === 'coach' && t.status === 'active');
  }

  async state(remoteTeamId: string): Promise<ImportState> {
    const link = await this.store.getLinkByRemote(remoteTeamId);
    if (link && link.origin !== 'imported') return { kind: 'linked', link };
    if (link) return link.importState === 'pending' ? { kind: 'pending', link } : { kind: 'imported', link };
    return this.coachTeam(remoteTeamId) ? { kind: 'available' } : { kind: 'not_allowed' };
  }

  // --- Importar --------------------------------------------------------------------

  /**
   * Importa (o reanuda la importación de) un equipo del club. Devuelve el
   * resumen de lo copiado. No escribe nada en el servidor.
   */
  async importTeam(remoteTeamId: string, onProgress?: (phase: ImportPhase) => void): Promise<ImportSummary> {
    const remote = this.coachTeam(remoteTeamId);
    if (!remote) throw new RemoteError('forbidden', 'Solo se puede trabajar con un equipo del club en el que este dispositivo tenga permiso de entrenador.');
    const device = await this.store.getDevice();
    if (!device) throw new RemoteError('unauthorized', 'Este dispositivo no tiene sesión con el club.');
    const existing = await this.store.getLinkByRemote(remoteTeamId);
    if (existing && existing.origin !== 'imported') {
      const team = await this.local.getTeam(existing.localTeamId);
      throw new RemoteError('conflict', `Este equipo del club ya está vinculado con «${team?.name ?? 'un equipo de este dispositivo'}»: no se importa otra vez.`);
    }
    if (existing && existing.importState !== 'pending') return this.summary(existing.localTeamId);

    onProgress?.('download');
    const snapshot = await this.api.snapshot(device.token, remoteTeamId);
    if (snapshot.team.id !== remoteTeamId) throw new RemoteError('invalid', 'La descarga no corresponde a ese equipo.');
    const hashes = await serverHashes(snapshot);
    const nowIso = this.now().toISOString();
    const metas: SyncMeta[] = [...hashes.entries()].map(([key, h]) => ({ key, entity: h.entity, entityId: h.id, remoteTeamId, version: h.version, hash: h.hash, syncedAt: nowIso }));

    onProgress?.('check');
    if (existing) return this.resume(existing, snapshot, metas, hashes, onProgress);

    const localTeamId = newId();
    const team: Team = {
      id: localTeamId,
      name: snapshot.team.name,
      code: snapshot.team.code,
      season: snapshot.team.season,
      maxSquad: DEFAULT_MAX_SQUAD,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const data = toLocal(snapshot, team);
    await this.assertNoOverlap(data, remoteTeamId);

    const link: TeamLink = {
      localTeamId,
      remoteTeamId,
      remoteTeamName: remote.name,
      remoteTeamCode: remote.code,
      remoteSeason: remote.season,
      clubName: remote.clubName,
      linkedAt: nowIso,
      origin: 'imported',
      importState: 'pending',
      // Recién descargada y al día: se puede editar en cuanto termina la importación.
      readOnly: false,
      cursor: snapshot.seq,
      refreshedAt: nowIso,
      controlledElsewhere: snapshot.matches.filter((m) => m.control?.holder === 'other').map((m) => m.match.id),
    };
    onProgress?.('save');
    // 1. Vínculo pendiente y versiones (una transacción). Desde aquí el equipo es de solo lectura.
    await this.store.addImportedLink(link, metas);
    this.imported.set(localTeamId, link);
    // 2. Datos del equipo (una transacción). Si falla, se retira el vínculo: no queda nada.
    try {
      await this.local.addTeamData(data);
    } catch (e) {
      await this.store.removeImportedLink(localTeamId);
      this.imported.delete(localTeamId);
      this.emit();
      if (e instanceof RecordExistsError) {
        throw new RemoteError('conflict', 'Algunos datos de ese equipo ya existen en este dispositivo en otro equipo. No se ha importado nada.');
      }
      throw e;
    }
    // 3. Importación terminada.
    return this.finish({ ...link, importState: undefined }, [], onProgress);
  }

  /** Reanuda una importación interrumpida con la descarga recién hecha. */
  private async resume(
    link: TeamLink,
    snapshot: TeamSnapshot,
    metas: SyncMeta[],
    hashes: Awaited<ReturnType<typeof serverHashes>>,
    onProgress?: (phase: ImportPhase) => void,
  ): Promise<ImportSummary> {
    const current = await this.local.readTeamData(link.localTeamId);
    onProgress?.('save');
    if (current) {
      await this.assertUnchanged(current, link.remoteTeamId, hashes);
      await this.local.replaceTeamData(toLocal(snapshot, { ...current.team, name: snapshot.team.name, code: snapshot.team.code, season: snapshot.team.season }));
    } else {
      const nowIso = this.now().toISOString();
      const data = toLocal(snapshot, { id: link.localTeamId, name: snapshot.team.name, code: snapshot.team.code, season: snapshot.team.season, maxSquad: DEFAULT_MAX_SQUAD, createdAt: nowIso, updatedAt: nowIso });
      await this.assertNoOverlap(data, link.remoteTeamId);
      await this.local.addTeamData(data);
    }
    return this.finish(
      {
        ...link,
        importState: undefined,
        readOnly: false,
        cursor: snapshot.seq,
        refreshedAt: this.now().toISOString(),
        controlledElsewhere: snapshot.matches.filter((m) => m.control?.holder === 'other').map((m) => m.match.id),
      },
      metas,
      onProgress,
    );
  }

  private async finish(link: TeamLink, metas: SyncMeta[], onProgress?: (phase: ImportPhase) => void): Promise<ImportSummary> {
    await this.store.updateImportedLink(link, metas);
    this.imported.set(link.localTeamId, link);
    this.emit();
    onProgress?.('verify');
    // Comprobación final: la copia coincide registro a registro con lo anotado.
    const data = await this.local.readTeamData(link.localTeamId);
    if (!data) throw new RemoteError('invalid', 'No se encuentra la copia del equipo.');
    const known = new Map((await this.store.listMeta(link.remoteTeamId)).map((m) => [m.key, m.hash]));
    for (const [key, hash] of await localHashes(data, link.remoteTeamId)) {
      if (known.get(key) !== hash) throw new RemoteError('invalid', 'La copia no coincide con el club. Descártala y vuelve a importarla.');
    }
    return this.summary(link.localTeamId);
  }

  private async summary(localTeamId: Id): Promise<ImportSummary> {
    const data = await this.local.readTeamData(localTeamId);
    return {
      localTeamId,
      players: data?.players.length ?? 0,
      matches: data?.matches.filter((m) => m.deletedAt === null).length ?? 0,
      deletedMatches: data?.matches.filter((m) => m.deletedAt !== null).length ?? 0,
      events: data?.events.filter((e) => e.deletedAt === null).length ?? 0,
      deletedEvents: data?.events.filter((e) => e.deletedAt !== null).length ?? 0,
    };
  }

  /**
   * Nunca se fusiona con datos que ya estén en el dispositivo: ni registros con
   * los mismos identificadores (p. ej. de una copia de seguridad restaurada), ni
   * un equipo sin vincular con el mismo código.
   */
  private async assertNoOverlap(data: TeamData, remoteTeamId: string): Promise<void> {
    const all = await this.local.readAll();
    const ids = new Set([...all.players.map((p) => p.id), ...all.matches.map((m) => m.id), ...all.events.map((e) => e.id)]);
    const overlap = [...data.players, ...data.matches, ...data.events].some((r) => ids.has(r.id));
    const sameCode = all.teams.find((t) => t.code.trim().toUpperCase() === data.team.code.trim().toUpperCase());
    if (overlap || sameCode) {
      const owner =
        sameCode ??
        all.teams.find(
          (t) =>
            all.players.some((p) => p.teamId === t.id && data.players.some((x) => x.id === p.id)) ||
            all.matches.some((m) => m.teamId === t.id && data.matches.some((x) => x.id === m.id)),
        );
      throw new RemoteError(
        'conflict',
        `Este dispositivo ya tiene un equipo parecido${owner ? ` («${owner.name}»)` : ''} sin vincular con el club. No se mezclan automáticamente: si es el mismo equipo, vincúlalo desde su ficha. No se ha importado nada.`,
      );
    }
    const metas = await this.store.listMeta(remoteTeamId);
    if (metas.length > 0) throw new RemoteError('conflict', 'Este dispositivo ya tiene datos enviados de ese equipo. No se ha importado nada.');
  }

  /**
   * La copia no tiene cambios propios: cada registro coincide con lo último
   * anotado o con lo que hay ahora en el club. (Es de solo lectura, así que no
   * debería tenerlos; si los tuviera, no se sobrescriben.)
   */
  private async assertUnchanged(data: TeamData, remoteTeamId: string, server: Awaited<ReturnType<typeof serverHashes>>): Promise<void> {
    const known = new Map((await this.store.listMeta(remoteTeamId)).map((m) => [m.key, m.hash]));
    for (const [key, hash] of await localHashes(data, remoteTeamId)) {
      if (known.get(key) !== hash && server.get(key)?.hash !== hash) {
        throw new RemoteError('conflict', 'La copia de este dispositivo tiene cambios que no están en el club: no se sobrescribe. No se ha cambiado nada.');
      }
    }
  }

  // --- Incorporación automática (al canjear un código de entrenador) -------------

  /** Situación de la incorporación de cada equipo del club, para mostrarla (solo en memoria). */
  private readonly incorporation = new Map<string, Incorporation>();

  incorporationOf(remoteTeamId: string): Incorporation | null {
    return this.incorporation.get(remoteTeamId) ?? null;
  }

  private setIncorporation(remoteTeamId: string, value: Incorporation | null): void {
    if (value) this.incorporation.set(remoteTeamId, value);
    else this.incorporation.delete(remoteTeamId);
    this.emit();
  }

  /**
   * Prepara en este dispositivo los equipos del club con permiso de entrenador
   * que aún no están: si ya hay uno vinculado, se usa tal cual; si no, se
   * importa. Nunca reintenta solo los que el usuario quitó ni los que no se
   * pudieron incorporar por coincidir con datos de este dispositivo.
   */
  async incorporate(onlyRemoteTeamId?: string): Promise<void> {
    const prefs = await this.store.getPrefs();
    for (const t of this.remoteTeams()) {
      if (t.role !== 'coach' || t.status !== 'active') continue;
      if (onlyRemoteTeamId && t.teamId !== onlyRemoteTeamId) continue;
      const link = await this.store.getLinkByRemote(t.teamId);
      if (link && link.importState !== 'pending') {
        if (this.incorporation.has(t.teamId)) this.setIncorporation(t.teamId, null);
        continue;
      }
      if (prefs.dismissed.includes(t.teamId)) {
        this.setIncorporation(t.teamId, { status: 'dismissed' });
        continue;
      }
      const blocked = prefs.blocked[t.teamId];
      if (blocked) {
        this.setIncorporation(t.teamId, { status: 'blocked', message: blocked });
        continue;
      }
      if (this.incorporation.get(t.teamId)?.status === 'working') continue;
      this.setIncorporation(t.teamId, { status: 'working' });
      try {
        await this.importTeam(t.teamId);
        this.setIncorporation(t.teamId, null);
      } catch (e) {
        if (e instanceof RemoteError && (e.kind === 'offline' || e.kind === 'timeout')) {
          this.setIncorporation(t.teamId, { status: 'offline', message: 'Hace falta conexión una vez para preparar el equipo en este dispositivo.' });
        } else if (e instanceof RemoteError && e.kind === 'conflict') {
          // Coincide con datos de este dispositivo: no se fusiona ni se reintenta solo.
          const next = await this.store.getPrefs();
          await this.store.savePrefs({ ...next, blocked: { ...next.blocked, [t.teamId]: e.message } });
          this.setIncorporation(t.teamId, { status: 'blocked', message: e.message });
        } else {
          this.setIncorporation(t.teamId, { status: 'error', message: e instanceof Error ? e.message : 'No se pudo preparar el equipo.' });
        }
      }
    }
  }

  /** «Añadir a este dispositivo» tras haberlo quitado o tras resolver una coincidencia. */
  async addAgain(remoteTeamId: string): Promise<void> {
    const prefs = await this.store.getPrefs();
    const blocked = { ...prefs.blocked };
    delete blocked[remoteTeamId];
    await this.store.savePrefs({ dismissed: prefs.dismissed.filter((id) => id !== remoteTeamId), blocked });
    this.setIncorporation(remoteTeamId, null);
    await this.incorporate(remoteTeamId);
  }

  // --- Quitar, perder el acceso ------------------------------------------------------

  /** ¿Tiene la copia cambios hechos aquí que no están en el club (registros nuevos o distintos)? */
  async hasLocalChanges(localTeamId: Id): Promise<boolean> {
    const link = await this.store.getLink(localTeamId);
    const data = await this.local.readTeamData(localTeamId);
    if (!link || !data) return false;
    const known = new Map((await this.store.listMeta(link.remoteTeamId)).map((m) => [m.key, m.hash]));
    for (const [key, hash] of await localHashes(data, link.remoteTeamId)) if (known.get(key) !== hash) return true;
    return false;
  }

  /**
   * Quita la copia de este dispositivo (datos del equipo, vínculo y versiones).
   * Solo copias importadas: nunca un equipo propio del dispositivo. Si la quita
   * el usuario (`dismiss`), no se vuelve a añadir sola.
   */
  async discard(localTeamId: Id, { dismiss = false }: { dismiss?: boolean } = {}): Promise<void> {
    const link = await this.store.getLink(localTeamId);
    if (!link || link.origin !== 'imported') throw new RemoteError('not_found', 'Este equipo no es una copia del club.');
    // Espera a que termine cualquier envío o recepción del equipo: nada puede escribir después.
    await waitForLock(link.remoteTeamId, () => this.discardLocked(localTeamId, dismiss));
  }

  private async discardLocked(localTeamId: Id, dismiss: boolean): Promise<void> {
    const link = await this.store.getLink(localTeamId);
    if (!link || link.origin !== 'imported') return;
    if (dismiss) {
      const prefs = await this.store.getPrefs();
      if (!prefs.dismissed.includes(link.remoteTeamId)) await this.store.savePrefs({ ...prefs, dismissed: [...prefs.dismissed, link.remoteTeamId] });
    }
    // Primero los datos (de solo lectura mientras tanto) y después el vínculo.
    this.imported.set(localTeamId, { ...link, readOnly: true });
    await this.local.removeTeamData(localTeamId);
    await this.store.removeImportedLink(localTeamId);
    this.imported.delete(localTeamId);
    this.emit();
  }

  /**
   * Sigue a la sesión. Tras cada comprobación correcta: retira (o bloquea) las
   * copias de equipos sin permiso de entrenador y prepara los que faltan. Sin
   * sesión, se retiran o bloquean todas. Sin conexión no se hace nada.
   */
  followSession(session: Pick<RemoteSession, 'getState' | 'subscribe'>, afterCheck?: () => void): () => void {
    let lastChecked: string | null = null;
    const check = () => {
      const s = session.getState();
      if (!s.ready || s.checking) return;
      if (!s.linked) {
        lastChecked = null;
        void this.retireExcept([]);
      } else if (s.problem === null && s.checkedAt && s.checkedAt !== lastChecked) {
        lastChecked = s.checkedAt;
        void this.retireExcept(s.teams.filter((t) => t.role === 'coach' && t.status === 'active').map((t) => t.teamId))
          .then(() => this.incorporate())
          .then(() => afterCheck?.());
      }
    };
    check();
    return session.subscribe(check);
  }

  /**
   * Copias de equipos que ya no están en la lista: sin cambios propios se
   * retiran; con cambios sin enviar se CONSERVAN bloqueadas (sin edición ni
   * envío), para recuperarlas con autorización. Las que vuelven a tener permiso
   * se desbloquean. Nunca toca un equipo propio del dispositivo. Devuelve los
   * equipos locales retirados.
   */
  async retireExcept(remoteTeamIds: readonly string[]): Promise<Id[]> {
    const allowed = new Set(remoteTeamIds);
    const retired: Id[] = [];
    for (const link of await this.store.listLinks()) {
      if (link.origin !== 'imported') continue;
      if (allowed.has(link.remoteTeamId) && !link.accessLost) continue; // con permiso y sin bloquear: nada que hacer
      // Con el bloqueo del equipo: ningún envío ni recepción a la vez.
      const gone = await waitForLock(link.remoteTeamId, async () => {
        const current = await this.store.getLink(link.localTeamId);
        if (!current || current.origin !== 'imported') return false;
        if (allowed.has(current.remoteTeamId)) {
          if (current.accessLost) {
            await this.store.saveSyncState({ ...current, accessLost: undefined, readOnly: false, autoBlocked: current.autoBlocked === ACCESS_LOST ? null : current.autoBlocked }, []);
            await this.load();
          }
          return false;
        }
        if (current.importState !== 'pending' && (await this.hasLocalChanges(current.localTeamId))) {
          if (!current.accessLost) {
            await this.store.saveSyncState({ ...current, accessLost: true, readOnly: true, autoBlocked: ACCESS_LOST }, []);
            await this.load();
          }
          return false;
        }
        await this.discardLocked(current.localTeamId, false);
        return true;
      });
      if (gone) retired.push(link.localTeamId);
    }
    return retired;
  }
}

/** Aviso en una copia que perdió el permiso con cambios sin enviar. */
export const ACCESS_LOST =
  'Este dispositivo ya no tiene permiso de entrenador en el equipo del club. Los cambios sin enviar se conservan aquí, bloqueados, hasta recuperar el permiso.';

/** Situación de la incorporación automática de un equipo del club. */
export type Incorporation =
  | { status: 'working' }
  | { status: 'offline'; message: string }
  | { status: 'blocked'; message: string }
  | { status: 'error'; message: string }
  | { status: 'dismissed' };
