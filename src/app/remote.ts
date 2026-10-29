import { createApi } from '../remote/api';
import { RemoteSession } from '../remote/session';
import { AccountStore } from '../remote/store';

/**
 * Servidor de la API, fijado al compilar (ver vite.config.ts). Vacío: esta
 * versión funciona solo en local y no muestra nada relacionado con el club.
 */
export const API_URL: string = (import.meta.env.VITE_API_URL ?? '').trim();

/** Sesión del dispositivo con el servidor; null si esta versión no usa servidor. */
export const remote: RemoteSession | null = API_URL
  ? new RemoteSession(createApi({ baseUrl: API_URL }), new AccountStore())
  : null;
