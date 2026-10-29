import { createApi } from '../remote/api';
import { ClubSync } from '../remote/clubsync';
import { RemoteSession } from '../remote/session';
import { AccountStore } from '../remote/store';
import { ClubViewer, ViewerStore } from '../remote/viewer';
import { repo } from './repo';

/**
 * Servidor de la API, fijado al compilar (ver vite.config.ts). Vacío: esta
 * versión funciona solo en local y no muestra nada relacionado con el club.
 */
export const API_URL: string = (import.meta.env.VITE_API_URL ?? '').trim();

const api = API_URL ? createApi({ baseUrl: API_URL }) : null;
const accountStore = API_URL ? new AccountStore() : null;

/** Sesión del dispositivo con el servidor; null si esta versión no usa servidor. */
export const remote: RemoteSession | null = api && accountStore ? new RemoteSession(api, accountStore) : null;

/** Vinculación y envío manual de equipos; null si esta versión no usa servidor. */
export const clubSync: ClubSync | null =
  api && accountStore && remote ? new ClubSync(repo, accountStore, api, () => remote.getState().teams) : null;

/** Consulta (solo lectura) de los equipos del club; null si esta versión no usa servidor. */
export const clubViewer: ClubViewer | null =
  api && accountStore && remote
    ? new ClubViewer(api, accountStore, new ViewerStore(), undefined, () => void remote.refresh())
    : null;

// Los datos descargados siguen a la sesión: sin acceso verificado, se retiran.
if (remote && clubViewer) clubViewer.followSession(remote);
