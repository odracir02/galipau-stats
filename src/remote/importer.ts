// Copia de un equipo del club en este dispositivo, para entrenadores. Ver
// docs/SINCRONIZACION.md.
//
// * Solo con permiso de entrenador vigente, y solo si el equipo del club no está
//   ya vinculado con un equipo de este dispositivo (p. ej. el del registrador
//   original): nunca se duplica ni se fusiona nada.
// * Se conservan los identificadores del servidor y se anotan sus versiones y
//   huellas, así que la copia queda «sincronizada»: no hay nada pendiente ni se
//   reenvía nada.
// * La copia es de SOLO LECTURA hasta que exista la sincronización en los dos
//   sentidos: no se puede editar ni enviar nada desde ella. «Actualizar copia»
//   la pone al día con el club.
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
import { eventContent, matchContent, playerContent, sha256, stableJson } from './upload';

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
      readOnly: true,
      cursor: snapshot.seq,
      refreshedAt: nowIso,
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
    return this.finish({ ...link, importState: undefined, cursor: snapshot.seq, refreshedAt: this.now().toISOString() }, metas, onProgress);
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

  // --- Mantener la copia ---------------------------------------------------------

  /** Pone la copia al día con el club (descarga completa). No envía nada. */
  async refresh(localTeamId: Id, onProgress?: (phase: ImportPhase) => void): Promise<ImportSummary> {
    const link = await this.store.getLink(localTeamId);
    if (!link || link.origin !== 'imported') throw new RemoteError('not_found', 'Este equipo no es una copia del club.');
    if (link.importState === 'pending') return this.importTeam(link.remoteTeamId, onProgress);
    if (!this.coachTeam(link.remoteTeamId)) throw new RemoteError('forbidden', 'Este dispositivo ya no tiene permiso de entrenador en ese equipo del club.');
    const device = await this.store.getDevice();
    if (!device) throw new RemoteError('unauthorized', 'Este dispositivo no tiene sesión con el club.');
    onProgress?.('download');
    const snapshot = await this.api.snapshot(device.token, link.remoteTeamId);
    const hashes = await serverHashes(snapshot);
    const nowIso = this.now().toISOString();
    const metas: SyncMeta[] = [...hashes.entries()].map(([key, h]) => ({ key, entity: h.entity, entityId: h.id, remoteTeamId: link.remoteTeamId, version: h.version, hash: h.hash, syncedAt: nowIso }));
    onProgress?.('check');
    return this.resume({ ...link, importState: 'pending' }, snapshot, metas, hashes, onProgress);
  }

  /** ¿Hay cambios en el club posteriores a la copia? Una consulta ligera; null si no se sabe. */
  async isBehind(localTeamId: Id): Promise<boolean | null> {
    const link = await this.store.getLink(localTeamId);
    const device = await this.store.getDevice();
    if (!link || link.origin !== 'imported' || link.cursor === undefined || !device) return null;
    try {
      const page = await this.api.changes(device.token, link.remoteTeamId, link.cursor);
      return page.nextSeq > link.cursor;
    } catch {
      return null;
    }
  }

  /**
   * Retira la copia de este dispositivo (datos del equipo, vínculo y versiones).
   * Solo copias importadas: nunca un equipo propio del dispositivo.
   */
  async discard(localTeamId: Id): Promise<void> {
    const link = await this.store.getLink(localTeamId);
    if (!link || link.origin !== 'imported') throw new RemoteError('not_found', 'Este equipo no es una copia del club.');
    // Primero los datos (sigue siendo de solo lectura mientras tanto) y después el vínculo.
    await this.local.removeTeamData(localTeamId);
    await this.store.removeImportedLink(localTeamId);
    this.imported.delete(localTeamId);
    this.emit();
  }

  /**
   * Sigue a la sesión: sin sesión, o si una comprobación correcta ya no da
   * permiso de entrenador en el equipo, se retira la copia (como lo descargado
   * para consulta). Sin conexión no se retira nada.
   */
  followSession(session: Pick<RemoteSession, 'getState' | 'subscribe'>): () => void {
    let lastChecked: string | null = null;
    const check = () => {
      const s = session.getState();
      if (!s.ready || s.checking) return;
      if (!s.linked) {
        lastChecked = null;
        void this.retireExcept([]);
      } else if (s.problem === null && s.checkedAt && s.checkedAt !== lastChecked) {
        lastChecked = s.checkedAt;
        void this.retireExcept(s.teams.filter((t) => t.role === 'coach' && t.status === 'active').map((t) => t.teamId));
      }
    };
    check();
    return session.subscribe(check);
  }

  /** Retira las copias de los equipos que no estén en la lista. Devuelve los equipos locales retirados. */
  async retireExcept(remoteTeamIds: readonly string[]): Promise<Id[]> {
    const allowed = new Set(remoteTeamIds);
    const retired: Id[] = [];
    for (const link of await this.store.listLinks()) {
      if (link.origin !== 'imported' || allowed.has(link.remoteTeamId)) continue;
      await this.discard(link.localTeamId);
      retired.push(link.localTeamId);
    }
    return retired;
  }
}
