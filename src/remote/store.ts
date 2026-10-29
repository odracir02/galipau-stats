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
    key: 'device' | 'teams';
    value: StoredDevice | StoredTeams;
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
