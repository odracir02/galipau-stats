import { useSyncExternalStore } from 'react';

/** Pestaña de un equipo del club; en la dirección, con su nombre en castellano. */
export type RemoteTab = 'me' | 'matches' | 'players' | 'season';
const TAB_SLUG: Record<RemoteTab, string> = { me: 'mi-jugador', matches: 'partidos', players: 'jugadores', season: 'temporada' };
const tabOfSlug = (slug: string | undefined): RemoteTab | undefined =>
  (Object.keys(TAB_SLUG) as RemoteTab[]).find((t) => TAB_SLUG[t] === slug);

export type Route =
  | { name: 'teams' }
  | { name: 'team'; teamId: string }
  | { name: 'newMatch'; teamId: string }
  | { name: 'rankings'; teamId: string }
  | { name: 'match'; matchId: string }
  /**
   * Equipo del club al que este dispositivo tiene acceso por código (datos del
   * servidor). Sin `tab` (enlaces anteriores), la pestaña por defecto.
   */
  | { name: 'remoteTeam'; teamId: string; tab?: RemoteTab }
  /** Partido y rankings de un equipo del club: solo consulta. */
  | { name: 'remoteMatch'; teamId: string; matchId: string }
  | { name: 'remoteRankings'; teamId: string }
  /** Cómo instalar la aplicación (sin sesión ni códigos). */
  | { name: 'install' };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'team' && parts[1]) {
    if (parts[2] === 'new-match') return { name: 'newMatch', teamId: parts[1] };
    if (parts[2] === 'rankings') return { name: 'rankings', teamId: parts[1] };
    return { name: 'team', teamId: parts[1] };
  }
  if (parts[0] === 'instalar') return { name: 'install' };
  if (parts[0] === 'match' && parts[1]) return { name: 'match', matchId: parts[1] };
  if (parts[0] === 'club' && parts[1]) {
    if (parts[2] === 'match' && parts[3]) return { name: 'remoteMatch', teamId: parts[1], matchId: parts[3] };
    if (parts[2] === 'rankings') return { name: 'remoteRankings', teamId: parts[1] };
    const tab = tabOfSlug(parts[2]);
    return tab ? { name: 'remoteTeam', teamId: parts[1], tab } : { name: 'remoteTeam', teamId: parts[1] };
  }
  return { name: 'teams' };
}

export function routeHref(route: Route): string {
  switch (route.name) {
    case 'teams':
      return '#/';
    case 'team':
      return `#/team/${encodeURIComponent(route.teamId)}`;
    case 'newMatch':
      return `#/team/${encodeURIComponent(route.teamId)}/new-match`;
    case 'rankings':
      return `#/team/${encodeURIComponent(route.teamId)}/rankings`;
    case 'match':
      return `#/match/${encodeURIComponent(route.matchId)}`;
    case 'remoteTeam':
      return `#/club/${encodeURIComponent(route.teamId)}${route.tab ? `/${TAB_SLUG[route.tab]}` : ''}`;
    case 'remoteMatch':
      return `#/club/${encodeURIComponent(route.teamId)}/match/${encodeURIComponent(route.matchId)}`;
    case 'remoteRankings':
      return `#/club/${encodeURIComponent(route.teamId)}/rankings`;
    case 'install':
      return '#/instalar';
  }
}

/**
 * Última pestaña abierta de cada equipo de consulta, para volver a ella desde un
 * partido o los rankings. Solo en memoria; la del entrenador no se guarda.
 */
const openTabs = new Map<string, RemoteTab>();
export const rememberTab = (teamId: string, tab: RemoteTab): void => void openTabs.set(teamId, tab);
export const lastTab = (teamId: string): RemoteTab | undefined => openTabs.get(teamId);

/**
 * Partido o rankings de un equipo del club abiertos desde su pantalla (sin
 * recargar): volver es volver atrás en el historial, sin añadir otra entrada
 * (así el botón Atrás del navegador no rebota entre el equipo y el partido).
 */
let openedFrom: string | null = null;
export function openFromTeam(teamId: string, route: Route): void {
  openedFrom = teamId;
  navigate(route);
}

/** Vuelta de la consulta a su equipo: atrás si se llegó desde él; si no (enlace, recarga), a su última pestaña. */
export function backToTeam(teamId: string): void {
  if (openedFrom === teamId) {
    openedFrom = null;
    window.history.back();
  } else navigate({ name: 'remoteTeam', teamId, tab: lastTab(teamId) }, { replace: true });
}

export function navigate(route: Route, { replace = false } = {}): void {
  const href = routeHref(route);
  if (replace) window.location.replace(href);
  else window.location.hash = href;
}

function subscribe(onChange: () => void) {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parseRoute(hash);
}
