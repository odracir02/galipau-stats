// Almacén de la sesión del dispositivo con el servidor. Es una base de datos
// IndexedDB PROPIA («galipaustats-cuenta»), separada de la de equipos y partidos
// («galipaustats»): crearla, usarla o borrarla nunca toca los datos locales.
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { RemoteTeam } from './api';

export const ACCOUNT_DB_NAME = 'galipaustats-cuenta';
const ACCOUNT_DB_VERSION = 1;

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

interface AccountDB extends DBSchema {
  account: {
    key: 'device' | 'teams';
    value: StoredDevice | StoredTeams;
  };
}

export class AccountStore {
  private readonly dbPromise: Promise<IDBPDatabase<AccountDB>>;

  constructor(name: string = ACCOUNT_DB_NAME) {
    this.dbPromise = openDB<AccountDB>(name, ACCOUNT_DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) db.createObjectStore('account');
      },
    });
  }

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

  /** Olvida la sesión del dispositivo (credencial y equipos). No toca ningún otro dato. */
  async clear(): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction('account', 'readwrite');
    await Promise.all([tx.store.delete('device'), tx.store.delete('teams')]);
    await tx.done;
  }
}
