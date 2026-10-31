// Recepción de los cambios del club en los equipos de este dispositivo
// (entrenadores, también el registrador original). Ver docs/SINCRONIZACION.md.
//
// * Pide solo lo posterior al último cambio recibido (GET /changes con el
//   cursor del vínculo). Sin novedades no se descarga nada. Si han cambiado
//   partidos o jugadores, o es la primera vez, se descarga el equipo completo.
// * Un cambio del club se aplica solo si el registro de este dispositivo no ha
//   cambiado desde la última sincronización (su huella coincide con la anotada).
//   Si ha cambiado aquí y allí, es un CONFLICTO: no se toca y se espera a que el
//   usuario elija (los registros en conflicto se apartan del envío; los demás
//   se siguen enviando). Tampoco se elimina solo un partido eliminado en el club
//   si aquí tiene acciones sin enviar. Nunca se mezcla nada ni se pierde un
//   cambio sin enviar.
// * El cursor solo avanza junto con las versiones de lo aplicado y los
//   conflictos guardados (misma transacción), y después de guardar los registros.
// * Lo que ya está igual en los dos lados solo actualiza la versión anotada:
//   nada se reenvía.
// * Escrituras: los registros en una transacción de la base local (comprobando
//   dentro de ella que nadie los ha cambiado entretanto) y después el cursor y
//   las versiones en otra de la base de la cuenta. Repetir es inofensivo.
// * Un envío y una recepción del mismo equipo nunca van a la vez (mismo bloqueo).
// * No escribe nunca en el servidor.
import { ConcurrentChangeError, StorageError, type Repository, type TeamData, type TeamDataStore } from '../data/repository';
import { newId } from '../domain/ids';
import type { Id, Match, MatchEvent, Player } from '../domain/types';
import { RemoteError, type Api, type RemoteTeam, type TeamSnapshot } from './api';
import { metaKey, type AccountStore, type SyncEntity, type SyncMeta, type TeamLink } from './store';
import { eventContent, matchContent, playerContent, sha256, stableJson, UploadBusyError, waitForLock, withLock } from './upload';

/** Aviso de versiones anteriores (los conflictos ya no detienen el envío automático): se retira al recibir. */
export const CONFLICT_BLOCK = 'Hay cambios hechos aquí y en el club a la vez: elige cuál conservar antes de seguir enviando.';

export type PullStatus = 'ok' | 'skipped' | 'offline' | 'forbidden' | 'error' | 'busy';

export interface PullResult {
  status: PullStatus;
  /** Registros del club incorporados a este dispositivo. */
  applied: number;
  /** Conflictos pendientes tras la recepción. */
  conflicts: number;
  /** Se descargó el equipo completo. */
  full: boolean;
  message?: string;
}

interface Incoming {
  entity: SyncEntity;
  id: string;
  version: number;
  /** Registro tal como está en el club (equipo del club). */
  record: Player | Match | MatchEvent;
}

const contentOf = (entity: SyncEntity, record: Player | Match | MatchEvent, remoteTeamId: string): unknown =>
  entity === 'player'
    ? playerContent({ ...(record as Player), teamId: remoteTeamId })
    : entity === 'match'
      ? matchContent({ ...(record as Match), teamId: remoteTeamId })
      : eventContent(record as MatchEvent);

const hashOf = async (entity: SyncEntity, record: Player | Match | MatchEvent, remoteTeamId: string) => sha256(stableJson(contentOf(entity, record, remoteTeamId)));

const STORE = { player: 'players', match: 'matches', event: 'events' } as const;

function fromSnapshot(snapshot: TeamSnapshot): Incoming[] {
  return [
    ...snapshot.players.map(({ version, player }) => ({ entity: 'player' as const, id: player.id, version, record: player })),
    ...snapshot.matches.map(({ version, match }) => ({ entity: 'match' as const, id: match.id, version, record: match })),
    ...snapshot.events.map(({ version, event }) => ({ entity: 'event' as const, id: event.id, version, record: event })),
  ];
}

export class TeamPuller {
  private readonly listeners = new Set<(localTeamId: Id, matchIds: ReadonlySet<string>) => void>();

  constructor(
    private readonly local: Repository & TeamDataStore,
    private readonly store: AccountStore,
    private readonly api: Api,
    /** Equipos y permisos vigentes según la última comprobación de la sesión. */
    private readonly remoteTeams: () => RemoteTeam[],
    private readonly now: () => Date = () => new Date(),
    /** Se avisa cuando cambia algún vínculo (p. ej. deja de ser de solo lectura). */
    private readonly onLinkChanged: () => void = () => undefined,
  ) {}

  /**
   * Avisa cuando llegan cambios del club a un equipo de este dispositivo (para
   * volver a leerlo), con los partidos afectados (vacío: solo plantilla o estado).
   */
  onRemoteChange(listener: (localTeamId: Id, matchIds: ReadonlySet<string>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(localTeamId: Id, matchIds: ReadonlySet<string> = new Set()): void {
    for (const l of this.listeners) l(localTeamId, matchIds);
  }

  /** Recibe los cambios de todos los equipos vinculados de este dispositivo. */
  async pullAll(): Promise<void> {
    for (const link of await this.store.listLinks()) await this.pull(link.localTeamId);
  }

  /**
   * Recibe los cambios del club de un equipo de este dispositivo. `full` fuerza
   * la descarga completa (comprobación a fondo).
   */
  async pull(localTeamId: Id, { full = false }: { full?: boolean } = {}): Promise<PullResult> {
    const none = (status: PullStatus, message?: string): PullResult => ({ status, applied: 0, conflicts: 0, full: false, message });
    const link = await this.store.getLink(localTeamId);
    if (!link || link.importState === 'pending' || link.accessLost) return none('skipped');
    if (!this.remoteTeams().some((t) => t.teamId === link.remoteTeamId && t.status === 'active')) return none('forbidden');
    const device = await this.store.getDevice();
    if (!device) return none('forbidden');
    try {
      return await withLock(link.remoteTeamId, () => this.pullLocked(localTeamId, device.token, full));
    } catch (e) {
      if (e instanceof UploadBusyError) return none('busy');
      if (e instanceof ConcurrentChangeError) return none('busy');
      if (e instanceof RemoteError) {
        if (e.kind === 'offline' || e.kind === 'timeout') return none('offline', e.message);
        if (e.kind === 'unauthorized' || e.kind === 'forbidden' || e.kind === 'not_found') return none('forbidden', e.message);
        return none('error', e.message);
      }
      // Fallo al guardar en el dispositivo: no se ha anotado nada (cursor y versiones igual).
      if (e instanceof StorageError) return none('error', e.message);
      throw e;
    }
  }

  private async pullLocked(localTeamId: Id, token: string, forceFull: boolean): Promise<PullResult> {
    const link = await this.store.getLink(localTeamId);
    if (!link || link.importState === 'pending' || link.accessLost) return { status: 'skipped', applied: 0, conflicts: 0, full: false };
    const data = await this.local.readTeamData(localTeamId);
    if (!data) return { status: 'skipped', applied: 0, conflicts: 0, full: false };

    if (link.cursor !== undefined && !forceFull) {
      const page = await this.api.changes(token, link.remoteTeamId, link.cursor);
      if (page.nextSeq <= link.cursor) return this.apply(link, data, [], link.cursor, undefined, false);
      const known = new Set(data.matches.map((m) => m.id));
      // Solo acciones de partidos que ya están aquí: se aplican sin descargar el equipo.
      if (!page.hasMore && page.others.length === 0 && page.events.every((e) => known.has(e.event.matchId))) {
        const incoming = page.events.map(({ version, event }) => ({ entity: 'event' as const, id: event.id, version, record: event }));
        return this.apply(link, data, incoming, page.nextSeq, undefined, false);
      }
    }
    const snapshot = await this.api.snapshot(token, link.remoteTeamId);
    const elsewhere = snapshot.matches.filter((m) => m.control?.holder === 'other').map((m) => m.match.id);
    const epochs = Object.fromEntries(snapshot.matches.filter((m) => m.control).map((m) => [m.match.id, m.control!.epoch]));
    return this.apply({ ...link, controlEpochs: epochs }, data, fromSnapshot(snapshot), snapshot.seq, elsewhere, true);
  }

  private async apply(link: TeamLink, data: TeamData, incoming: Incoming[], cursor: number, elsewhere: string[] | undefined, full: boolean): Promise<PullResult> {
    const remoteTeamId = link.remoteTeamId;
    const metas = new Map((await this.store.listMeta(remoteTeamId)).map((m) => [m.key, m]));
    const localById = new Map<string, Player | Match | MatchEvent>([...data.players, ...data.matches, ...data.events].map((r) => [r.id, r]));
    const conflicts = new Map((link.conflicts ?? []).map((c) => [c.key, c]));
    const opponents = new Map([...data.matches].map((m) => [m.id, m.opponent]));
    const nowIso = this.now().toISOString();
    const changes: Parameters<TeamDataStore['applyRecords']>[0][number][] = [];
    const metaUpdates: SyncMeta[] = [];
    /** ¿Hay en este dispositivo acciones de ese partido sin enviar (nuevas o cambiadas)? */
    const pendingIn = async (matchId: string) => {
      for (const e of data.events) {
        if (e.matchId !== matchId) continue;
        const m = metas.get(metaKey('event', e.id));
        if (!m || m.hash !== (await hashOf('event', e, remoteTeamId))) return true;
      }
      return false;
    };

    for (const inc of incoming) {
      const key = metaKey(inc.entity, inc.id);
      const meta = metas.get(key);
      if (meta && meta.version >= inc.version && !conflicts.has(key)) continue; // ya conocido (también lo enviado desde aquí)
      const serverHash = await hashOf(inc.entity, inc.record, remoteTeamId);
      const mine = localById.get(inc.id);
      const mineHash = mine ? await hashOf(inc.entity, mine, remoteTeamId) : null;
      const newMeta: SyncMeta = { key, entity: inc.entity, entityId: inc.id, remoteTeamId, version: inc.version, hash: serverHash, syncedAt: nowIso };
      if (mineHash === serverHash) {
        // Ya igual en los dos lados: solo se anota la versión.
        metaUpdates.push(newMeta);
        conflicts.delete(key);
        continue;
      }
      // Partido eliminado en el club con acciones sin enviar aquí: no se elimina
      // solo (esas acciones quedarían sin enviar); se pregunta como conflicto.
      const remoteDeletes =
        inc.entity === 'match' && (inc.record as Match).deletedAt !== null && mine !== undefined && (mine as Match).deletedAt === null;
      if (remoteDeletes && (await pendingIn(inc.id))) {
        conflicts.set(key, { key, entity: inc.entity, entityId: inc.id, label: `${labelOf(inc, opponents)} · eliminado en el club`, server: { version: inc.version, hash: serverHash, record: inc.record } });
        continue;
      }
      if (!mine || (meta && mineHash === meta.hash)) {
        // Sin cambios aquí desde la última sincronización: se incorpora el del club.
        const record = inc.entity === 'event' ? inc.record : { ...inc.record, teamId: link.localTeamId };
        const expected = mine ? stableJson(mine) : null;
        changes.push({
          store: STORE[inc.entity],
          record,
          expect: (current: unknown) => (expected === null ? current === undefined : current !== undefined && stableJson(current) === expected),
        } as never);
        metaUpdates.push(newMeta);
        conflicts.delete(key);
        continue;
      }
      // Cambiado aquí y en el club: no se toca nada. Se guarda la versión más nueva del club.
      const known = conflicts.get(key);
      if (known && known.server.version >= inc.version) continue;
      conflicts.set(key, {
        key,
        entity: inc.entity,
        entityId: inc.id,
        label: labelOf(inc, opponents),
        server: { version: inc.version, hash: serverHash, record: inc.record },
      });
    }

    // 1. Registros (una transacción, comprobando que nadie los ha cambiado entretanto).
    await this.local.applyRecords(changes);
    // 2. Versiones, cursor y conflictos (una transacción).
    const remaining = [...conflicts.values()];
    const next: TeamLink = {
      ...link,
      cursor,
      refreshedAt: nowIso,
      conflicts: remaining.length > 0 ? remaining : undefined,
      controlledElsewhere: elsewhere ?? link.controlledElsewhere,
      // Una copia del club, ya al día, se puede editar.
      readOnly: link.origin === 'imported' ? false : link.readOnly,
      // Los registros en conflicto se apartan del envío; el resto sigue enviándose.
      autoBlocked: link.autoBlocked === CONFLICT_BLOCK ? null : link.autoBlocked,
    };
    const before = (await this.store.getLink(link.localTeamId)) ?? link;
    const linkChanged = stableJson(next) !== stableJson({ ...before, refreshedAt: nowIso, cursor });
    await this.store.saveSyncState(next, metaUpdates);
    if (linkChanged || link.readOnly !== next.readOnly) this.onLinkChanged();
    if (changes.length > 0 || linkChanged) {
      const matchIds = new Set<string>();
      for (const c of changes) matchIds.add(c.store === 'events' ? (c.record as MatchEvent).matchId : c.store === 'matches' ? c.record.id : '');
      for (const id of [...(elsewhere ?? []), ...(link.controlledElsewhere ?? [])]) matchIds.add(id);
      matchIds.delete('');
      this.emit(link.localTeamId, matchIds);
    }
    return { status: 'ok', applied: changes.length, conflicts: remaining.length, full };
  }

  /**
   * Resuelve un conflicto por elección expresa del usuario:
   *   «club»: se sustituye el registro de este dispositivo por el del club;
   *   «mine»: se conserva el de este dispositivo y se enviará sobre la versión
   *           del club (sustituyéndola), con el envío normal.
   */
  async resolve(localTeamId: Id, key: string, choice: 'club' | 'mine'): Promise<void> {
    const link = await this.store.getLink(localTeamId);
    const conflict = link?.conflicts?.find((c) => c.key === key);
    if (!link || !conflict) return;
    await waitForLock(link.remoteTeamId, async () => {
      const meta = await this.store.getMeta(conflict.entity, conflict.entityId);
      const nowIso = this.now().toISOString();
      const base = { key, entity: conflict.entity, entityId: conflict.entityId, remoteTeamId: link.remoteTeamId, syncedAt: nowIso };
      if (choice === 'club') {
        const data = await this.local.readTeamData(localTeamId);
        const mine = data && [...data.players, ...data.matches, ...data.events].find((r) => r.id === conflict.entityId);
        const expected = mine ? stableJson(mine) : null;
        const server = conflict.server.record as Player | Match | MatchEvent;
        const record = conflict.entity === 'event' ? server : { ...server, teamId: localTeamId };
        // Antes de sustituirlo, se guarda una copia del dato de este dispositivo.
        if (mine) {
          await this.store.keepDiscarded({ at: nowIso, remoteTeamId: link.remoteTeamId, entity: conflict.entity, entityId: conflict.entityId, label: conflict.label, record: mine });
        }
        await this.local.applyRecords([
          {
            store: STORE[conflict.entity],
            record,
            expect: (current: unknown) => (expected === null ? current === undefined : current !== undefined && stableJson(current) === expected),
          } as never,
        ]);
        await this.finishResolve(link, key, [{ ...base, version: conflict.server.version, hash: conflict.server.hash }]);
      } else {
        // La versión del club pasa a ser la base: el envío mandará la de aquí encima.
        await this.finishResolve(link, key, [{ ...base, version: conflict.server.version, hash: meta?.hash ?? '' }]);
      }
    });
    this.onLinkChanged();
    const record = conflict.server.record as { id: string; matchId?: string };
    this.emit(localTeamId, new Set(conflict.entity === 'player' ? [] : [conflict.entity === 'event' ? record.matchId! : record.id]));
  }

  /**
   * Toma el control de un partido en curso que registra otro dispositivo
   * (permiso de entrenador y conexión). Antes comprueba el estado actualizado
   * del club (descarga completa) y usa su contador de control: si otro lo ha
   * cambiado entretanto, el servidor lo rechaza y no se cambia nada. Las
   * acciones sin enviar de cualquier dispositivo se conservan siempre.
   * Devuelve «not_needed» si, al comprobarlo, ya no lo registra otro.
   */
  async takeControl(localTeamId: Id, matchId: string): Promise<'taken' | 'not_needed'> {
    const first = await this.store.getLink(localTeamId);
    if (!first || first.accessLost || first.importState === 'pending') {
      throw new RemoteError('forbidden', 'Este equipo está bloqueado en este dispositivo: no se puede tomar el control.');
    }
    if (!this.remoteTeams().some((t) => t.teamId === first.remoteTeamId && t.role === 'coach' && t.status === 'active')) {
      throw new RemoteError('forbidden', 'Solo un entrenador del equipo puede tomar el control de un partido.');
    }
    const device = await this.store.getDevice();
    if (!device) throw new RemoteError('unauthorized', 'Este dispositivo no tiene sesión con el club.');
    // 1. Estado actualizado: quién lo registra y su contador de control (si hay
    //    un envío en curso en este dispositivo, se espera un momento).
    let checked = await this.pull(localTeamId, { full: true });
    for (let i = 0; checked.status === 'busy' && i < 100; i++) {
      await new Promise((r) => setTimeout(r, 100));
      checked = await this.pull(localTeamId, { full: true });
    }
    if (checked.status === 'offline') throw new RemoteError('offline', 'Hace falta conexión para tomar el control de un partido.');
    if (checked.status !== 'ok') throw new RemoteError('server', checked.message ?? 'No se pudo comprobar el estado del partido. Inténtalo de nuevo.');
    const link = (await this.store.getLink(localTeamId))!;
    if (!link.controlledElsewhere?.includes(matchId)) return 'not_needed';
    const epoch = link.controlEpochs?.[matchId];
    if (epoch === undefined) throw new RemoteError('server', 'No se pudo comprobar el estado del partido. Inténtalo de nuevo.');
    // 2. Transferencia (con el bloqueo del equipo: ningún envío ni recepción a la vez).
    await waitForLock(link.remoteTeamId, async () => {
      let result;
      try {
        result = await this.api.takeControl(device.token, { opId: newId(), teamId: link.remoteTeamId, matchId, expectedEpoch: epoch });
      } catch (e) {
        if (e instanceof RemoteError && e.code === 'control_changed') {
          throw new RemoteError('conflict', 'Otro dispositivo ha cambiado el control de este partido mientras tanto. No se ha cambiado nada: revisa quién lo registra ahora.', e.status, e.code);
        }
        if (e instanceof RemoteError && e.code === 'match_not_active') {
          throw new RemoteError('conflict', 'El partido ya no está en curso: no hace falta tomar el control.', e.status, e.code);
        }
        throw e;
      }
      const fresh = (await this.store.getLink(localTeamId)) ?? link;
      await this.store.saveSyncState(
        {
          ...fresh,
          controlledElsewhere: (fresh.controlledElsewhere ?? []).filter((id) => id !== matchId),
          controlEpochs: { ...(fresh.controlEpochs ?? {}), [matchId]: result.epoch },
        },
        [],
      );
    });
    this.onLinkChanged();
    this.emit(localTeamId, new Set([matchId]));
    // 3. Datos del partido al día para continuarlo aquí (si falla, se reciben después).
    await this.pull(localTeamId);
    return 'taken';
  }

  /**
   * Acciones de un partido que este dispositivo tiene sin enviar (nuevas o
   * cambiadas): se avisa de ellas antes de aceptar que el club lo elimine.
   */
  async pendingEventsIn(localTeamId: Id, matchId: string): Promise<number> {
    const link = await this.store.getLink(localTeamId);
    const data = await this.local.readTeamData(localTeamId);
    if (!link || !data) return 0;
    const metas = new Map((await this.store.listMeta(link.remoteTeamId)).map((m) => [m.key, m.hash]));
    let n = 0;
    for (const e of data.events) {
      if (e.matchId === matchId && metas.get(metaKey('event', e.id)) !== (await hashOf('event', e, link.remoteTeamId))) n++;
    }
    return n;
  }

  private async finishResolve(link: TeamLink, key: string, metas: SyncMeta[]): Promise<void> {
    const fresh = (await this.store.getLink(link.localTeamId)) ?? link;
    const remaining = (fresh.conflicts ?? []).filter((c) => c.key !== key);
    await this.store.saveSyncState(
      {
        ...fresh,
        conflicts: remaining.length > 0 ? remaining : undefined,
        autoBlocked: fresh.autoBlocked === CONFLICT_BLOCK ? null : fresh.autoBlocked,
      },
      metas,
    );
  }
}

function labelOf(inc: Incoming, opponents: ReadonlyMap<string, string>): string {
  if (inc.entity === 'player') {
    const p = inc.record as Player;
    return `Jugador ${p.number} · ${p.name}`;
  }
  if (inc.entity === 'match') {
    const m = inc.record as Match;
    return `Partido vs ${m.opponent} (${m.date})`;
  }
  const e = inc.record as MatchEvent;
  return `Acción del partido vs ${opponents.get(e.matchId) ?? 'rival'}`;
}
