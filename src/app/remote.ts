import { createApi } from '../remote/api';
import { AutoSync } from '../remote/autosync';
import { ClubSync } from '../remote/clubsync';
import { TeamImporter } from '../remote/importer';
import { TeamPuller } from '../remote/pull';
import { LiveFeed } from '../remote/live';
import { RemoteSession } from '../remote/session';
import { AccountStore } from '../remote/store';
import { ClubViewer, ViewerStore } from '../remote/viewer';
import { localDb, repo } from './repo';

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

/** Copias de equipos del club en este dispositivo (entrenadores); null si esta versión no usa servidor. */
export const teamImporter: TeamImporter | null =
  api && accountStore && remote ? new TeamImporter(localDb, accountStore, api, () => remote.getState().teams) : null;

/** Recepción de los cambios del club en los equipos vinculados; null si esta versión no usa servidor. */
export const teamPuller: TeamPuller | null =
  api && accountStore && remote
    ? new TeamPuller(localDb, accountStore, api, () => remote.getState().teams, undefined, () => void teamImporter?.load())
    : null;

if (teamImporter && teamPuller && remote) {
  // Un envío manual recibe lo del club antes de comprobar que todo coincide.
  clubSync?.receiveWith(teamPuller);
  // Las copias bloqueadas (importación sin terminar, permiso perdido) no se pueden modificar desde ninguna pantalla.
  repo.protectReadOnly(teamImporter);
  void teamImporter.load();
  // Tras cada comprobación correcta de la sesión: copias sin permiso retiradas
  // (o bloqueadas si tienen cambios sin enviar), equipos de entrenador que faltan
  // preparados y cambios del club recibidos.
  teamImporter.followSession(remote, () => void teamPuller.pullAll());
  // Recepción puntual al abrir la app, al volver a ella o al recuperar la
  // conexión (nunca periódica salvo en un partido que registra otro dispositivo).
  let last = 0;
  const pull = () => {
    if (Date.now() - last < 15_000) return;
    last = Date.now();
    void remote.whenReady().then(() => teamPuller.pullAll());
  };
  pull();
  window.addEventListener('online', pull);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') pull();
  });
}

/** Actualización en directo de la consulta (solo con una pantalla de consulta abierta y la app visible). */
export const liveFeed: LiveFeed | null = clubViewer && remote ? new LiveFeed(clubViewer, () => remote.getState().teams) : null;

/** Envío automático desde el dispositivo que registra; null si esta versión no usa servidor. */
export const autoSync: AutoSync | null =
  clubSync && accountStore && api && remote ? new AutoSync(clubSync, accountStore, api, () => remote.getState().teams) : null;

if (autoSync && remote) {
  // Ante un conflicto, el envío automático recibe primero los cambios del club.
  if (teamPuller) autoSync.receiveWith(teamPuller);
  // Cada cambio guardado en un equipo local (jugadores, partidos, acciones) programa su envío.
  repo.onChange((c) => {
    if (c.entity !== 'team') autoSync.changed(c.teamId);
  });
  // Al abrir la app, volver a ella o recuperar la conexión, se mira si quedaba algo pendiente.
  const check = () => void remote.whenReady().then(() => autoSync.checkAll());
  check();
  window.addEventListener('online', check);
  window.addEventListener('pageshow', check);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
}
