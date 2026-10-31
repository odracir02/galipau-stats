// Almacén de la sesión del dispositivo con el servidor y de la sincronización.
// Es una base de datos IndexedDB PROPIA («galipaustats-cuenta»), separada de la
// de equipos y partidos («galipaustats»): crearla, usarla o borrarla nunca toca
// los datos locales.
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { RemoteTeam } from './api';

export const ACCOUNT_DB_NAME = 'galipaustats-cuenta';
/** 1: sesión. 2: vínculos, versiones enviadas e historial de envíos (solo añade almacenes). */
const ACCOUNT_DB_VERSION = 2;

/** Credencial del dispositivo. El token solo sale de aquí hacia la cabecera Authorization. */
export interface StoredDevice {
  deviceId: string;
  token: string;
  joinedAt: string;
}

/** Última respuesta conocida de /api/session, para mostrarla sin conexión. */
export interface StoredTeams {
  teams: RemoteTeam[];
  checkedAt: string;
}

/**
 * Vínculo explícito entre un equipo local y uno del club. Un equipo local tiene
 * como mucho un vínculo y un equipo del club, como mucho un equipo local.
 * Los identificadores locales no cambian: la correspondencia vive solo aquí.
 */
export interface TeamLink {
  localTeamId: string;
  remoteTeamId: string;
  remoteTeamName: string;
  remoteTeamCode: string;
  remoteSeason: string;
  clubName: string;
  linkedAt: string;
  /**
   * Envío automático: solo con `true`, que se guarda cuando el usuario lo activa
   * expresamente en este dispositivo. Sin el campo (vínculos anteriores), desactivado.
   */
  auto?: boolean;
  /**
   * El envío automático se detuvo por un conflicto o un rechazo: no se reanuda
   * solo. Un envío manual completo y comprobado lo vuelve a activar.
   */
  autoBlocked?: string | null;
  /**
   * «imported»: el equipo local se creó en este dispositivo como copia del
   * equipo del club (no se subió desde aquí). Sin el campo: vínculo de un equipo
   * propio del dispositivo (como el del registrador original).
   */
  origin?: 'imported';
  /** Importación empezada y sin terminar: el equipo aún no se puede usar. */
  importState?: 'pending';
  /** Solo lectura en este dispositivo: no se puede editar ni enviar nada. */
  readOnly?: boolean;
  /**
   * Se perdió el permiso de entrenador con cambios sin enviar: se conservan en
   * el dispositivo, bloqueados (sin edición ni envío), para recuperarlos.
   */
  accessLost?: boolean;
  /** Último cambio del club ya recibido en este dispositivo (seq de /changes). */
  cursor?: number;
  /** Última recepción de cambios del club. */
  refreshedAt?: string;
  /** Registros cambiados aquí y en el club a la vez: esperan a que el usuario elija. */
  conflicts?: SyncConflict[];
  /** Partidos en curso que registra OTRO dispositivo (según la última descarga). */
  controlledElsewhere?: string[];
}

/** Un registro cambiado en este dispositivo y en el club a la vez. */
export interface SyncConflict {
  key: string;
  entity: SyncEntity;
  entityId: string;
  /** Descripción para el usuario (sin datos sensibles). */
  label: string;
  /** Versión del club, tal como llegó (para «Quedarme con la del club»). */
  server: { version: number; hash: string; record: unknown };
}

/** Copia de un dato de este dispositivo sustituido por la versión del club al resolver un conflicto. */
export interface DiscardedRecord {
  at: string;
  remoteTeamId: string;
  entity: SyncEntity;
  entityId: string;
  label: string;
  record: unknown;
}

/** Cuántas copias de datos sustituidos se conservan (las más recientes). */
const DISCARDED_LIMIT = 50;

/** Preferencias de incorporación automática de equipos del club en este dispositivo. */
export interface TeamPrefs {
  /** Equipos del club que el usuario quitó de este dispositivo: no se vuelven a añadir solos. */
  dismissed: string[];
  /** Equipos del club que no se pudieron incorporar, con el motivo (no se reintenta solo). */
  blocked: Record<string, string>;
}

export type SyncEntity = 'player' | 'match' | 'event';

/** Lo último que el servidor confirmó de un registro (para reintentos y envíos futuros). */
export interface SyncMeta {
  /** `${entity}:${id}` */
  key: string;
  entity: SyncEntity;
  entityId: string;
  remoteTeamId: string;
  version: number;
  /** Huella del contenido enviado: si no cambia, no hay que volver a enviarlo. */
  hash: string;
  syncedAt: string;
}

/** Resumen de un envío (sin tokens ni datos personales). */
export interface UploadRecord {
  id: string;
  localTeamId: string;
  remoteTeamId: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'verified' | 'sent' | 'differences' | 'interrupted' | 'stopped';
  sent: { players: number; matches: number; events: number };
  skipped: number;
  message: string | null;
}

interface AccountDB extends DBSchema {
  account: {
    key: 'device' | 'teams' | 'prefs' | 'discarded';
    value: StoredDevice | StoredTeams | TeamPrefs | DiscardedRecord[];
  };
  links: {
    key: string;
    value: TeamLink;
    indexes: { byRemote: string };
  };
  syncMeta: {
    key: string;
    value: SyncMeta;
    indexes: { byRemoteTeam: string };
  };
  uploads: {
    key: string;
    value: UploadRecord;
    indexes: { byLocalTeam: string };
  };
}

export const metaKey = (entity: SyncEntity, id: string) => `${entity}:${id}`;

export class AccountStore {
  private readonly dbPromise: Promise<IDBPDatabase<AccountDB>>;

  constructor(name: string = ACCOUNT_DB_NAME) {
    this.dbPromise = openDB<AccountDB>(name, ACCOUNT_DB_VERSION, {
      upgrade(db, oldVersion) {
        // Migraciones solo aditivas: nunca se borran almacenes ni datos.
        if (oldVersion < 1) db.createObjectStore('account');
        if (oldVersion < 2) {
          db.createObjectStore('links', { keyPath: 'localTeamId' }).createIndex('byRemote', 'remoteTeamId', { unique: true });
          db.createObjectStore('syncMeta', { keyPath: 'key' }).createIndex('byRemoteTeam', 'remoteTeamId');
          db.createObjectStore('uploads', { keyPath: 'id' }).createIndex('byLocalTeam', 'localTeamId');
        }
      },
    });
  }

  // --- Sesión -------------------------------------------------------------------

  async getDevice(): Promise<StoredDevice | null> {
    return ((await (await this.dbPromise).get('account', 'device')) as StoredDevice | undefined) ?? null;
  }

  async getTeams(): Promise<StoredTeams | null> {
    return ((await (await this.dbPromise).get('account', 'teams')) as StoredTeams | undefined) ?? null;
  }

  async saveDevice(device: StoredDevice): Promise<void> {
    await (await this.dbPromise).put('account', device, 'device');
  }

  async saveTeams(teams: StoredTeams): Promise<void> {
    await (await this.dbPromise).put('account', teams, 'teams');
  }

  async getPrefs(): Promise<TeamPrefs> {
    const p = (await (await this.dbPromise).get('account', 'prefs')) as TeamPrefs | undefined;
    return { dismissed: p?.dismissed ?? [], blocked: p?.blocked ?? {} };
  }

  async savePrefs(prefs: TeamPrefs): Promise<void> {
    await (await this.dbPromise).put('account', prefs, 'prefs');
  }

  /** Copias de los datos sustituidos por la versión del club (más recientes primero). */
  async listDiscarded(): Promise<DiscardedRecord[]> {
    return ((await (await this.dbPromise).get('account', 'discarded')) as DiscardedRecord[] | undefined) ?? [];
  }

  /** Guarda una copia de un dato antes de sustituirlo (se conservan las últimas). */
  async keepDiscarded(record: DiscardedRecord): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction('account', 'readwrite');
    const list = ((await tx.store.get('discarded')) as DiscardedRecord[] | undefined) ?? [];
    await Promise.all([tx.store.put([record, ...list].slice(0, DISCARDED_LIMIT), 'discarded'), tx.done]);
  }

  /**
   * Olvida la sesión del dispositivo (credencial y equipos). Los vínculos y lo
   * ya enviado se conservan: describen los datos de este dispositivo, no la sesión.
   */
  async clear(): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction('account', 'readwrite');
    await Promise.all([tx.store.delete('device'), tx.store.delete('teams')]);
    await tx.done;
  }

  // --- Vínculos -----------------------------------------------------------------

  async getLink(localTeamId: string): Promise<TeamLink | null> {
    return (await (await this.dbPromise).get('links', localTeamId)) ?? null;
  }

  async listLinks(): Promise<TeamLink[]> {
    return (await this.dbPromise).getAll('links');
  }

  /**
   * Guarda un vínculo nuevo. Falla si el equipo local ya está vinculado o si el
   * equipo del club ya lo está con otro equipo local: nunca se sustituye uno.
   */
  async addLink(link: TeamLink): Promise<void> {
    const db = await this.dbPromise;
    try {
      // add (no put): si ya existe la clave o el equipo del club ya está en el índice único, falla.
      await db.add('links', link);
    } catch (e) {
      throw new LinkTakenError(e);
    }
  }

  /** Actualiza las opciones de un vínculo existente (envío automático). Nunca cambia los equipos. */
  async updateLink(link: TeamLink): Promise<void> {
    const db = await this.dbPromise;
    const current = await db.get('links', link.localTeamId);
    if (!current || current.remoteTeamId !== link.remoteTeamId) throw new LinkTakenError(null);
    await db.put('links', link);
  }

  /**
   * Registra una copia importada: vínculo nuevo y versiones del servidor de
   * todos sus registros, en una sola transacción. Falla sin escribir nada si el
   * equipo local o el del club ya están vinculados.
   */
  async addImportedLink(link: TeamLink, metas: SyncMeta[]): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction(['links', 'syncMeta'], 'readwrite');
    try {
      await Promise.all([tx.objectStore('links').add(link), ...metas.map((m) => tx.objectStore('syncMeta').put(m)), tx.done]);
    } catch (e) {
      throw new LinkTakenError(e);
    }
  }

  /** Actualiza una copia importada (vínculo y versiones) en una sola transacción. */
  async updateImportedLink(link: TeamLink, metas: SyncMeta[]): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction(['links', 'syncMeta'], 'readwrite');
    const current = await tx.objectStore('links').get(link.localTeamId);
    if (!current || current.remoteTeamId !== link.remoteTeamId || current.origin !== 'imported') {
      tx.abort();
      await tx.done.catch(() => undefined);
      throw new LinkTakenError(null);
    }
    await Promise.all([tx.objectStore('links').put(link), ...metas.map((m) => tx.objectStore('syncMeta').put(m)), tx.done]);
  }

  /**
   * Guarda el estado de sincronización de un vínculo (cursor, conflictos…) y las
   * versiones recibidas, en una sola transacción. Nunca cambia los equipos.
   */
  async saveSyncState(link: TeamLink, metas: SyncMeta[]): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction(['links', 'syncMeta'], 'readwrite');
    const current = await tx.objectStore('links').get(link.localTeamId);
    if (!current || current.remoteTeamId !== link.remoteTeamId) {
      tx.abort();
      await tx.done.catch(() => undefined);
      throw new LinkTakenError(null);
    }
    await Promise.all([tx.objectStore('links').put(link), ...metas.map((m) => tx.objectStore('syncMeta').put(m)), tx.done]);
  }

  /** Olvida una copia importada: su vínculo y sus versiones, en una sola transacción. */
  async removeImportedLink(localTeamId: string): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction(['links', 'syncMeta'], 'readwrite');
    const link = await tx.objectStore('links').get(localTeamId);
    if (!link || link.origin !== 'imported') {
      await tx.done;
      return;
    }
    const keys = await tx.objectStore('syncMeta').index('byRemoteTeam').getAllKeys(link.remoteTeamId);
    await Promise.all([...keys.map((k) => tx.objectStore('syncMeta').delete(k)), tx.objectStore('links').delete(localTeamId), tx.done]);
  }

  async getLinkByRemote(remoteTeamId: string): Promise<TeamLink | null> {
    return (await (await this.dbPromise).getFromIndex('links', 'byRemote', remoteTeamId)) ?? null;
  }

  /** Quita un vínculo. Solo se ofrece si todavía no se ha enviado nada con él. */
  async removeLink(localTeamId: string): Promise<void> {
    await (await this.dbPromise).delete('links', localTeamId);
  }

  // --- Versiones enviadas ----------------------------------------------------------

  async getMeta(entity: SyncEntity, id: string): Promise<SyncMeta | null> {
    return (await (await this.dbPromise).get('syncMeta', metaKey(entity, id))) ?? null;
  }

  async saveMeta(meta: SyncMeta): Promise<void> {
    await (await this.dbPromise).put('syncMeta', meta);
  }

  async listMeta(remoteTeamId: string): Promise<SyncMeta[]> {
    return (await this.dbPromise).getAllFromIndex('syncMeta', 'byRemoteTeam', remoteTeamId);
  }

  // --- Historial de envíos -----------------------------------------------------------

  async saveUpload(record: UploadRecord): Promise<void> {
    await (await this.dbPromise).put('uploads', record);
  }

  async lastUpload(localTeamId: string): Promise<UploadRecord | null> {
    const all = await (await this.dbPromise).getAllFromIndex('uploads', 'byLocalTeam', localTeamId);
    return all.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null;
  }
}

export class LinkTakenError extends Error {
  override name = 'LinkTakenError';
  constructor(cause: unknown) {
    super('Ese equipo ya está vinculado.', { cause });
  }
}
