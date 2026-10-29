import { useSyncExternalStore } from 'react';

export type Route =
  | { name: 'teams' }
  | { name: 'team'; teamId: string }
  | { name: 'newMatch'; teamId: string }
  | { name: 'rankings'; teamId: string }
  | { name: 'match'; matchId: string }
  /** Equipo del club al que este dispositivo tiene acceso por código (datos del servidor). */
  | { name: 'remoteTeam'; teamId: string }
  /** Partido y rankings de un equipo del club: solo consulta. */
  | { name: 'remoteMatch'; teamId: string; matchId: string }
  | { name: 'remoteRankings'; teamId: string };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'team' && parts[1]) {
    if (parts[2] === 'new-match') return { name: 'newMatch', teamId: parts[1] };
    if (parts[2] === 'rankings') return { name: 'rankings', teamId: parts[1] };
    return { name: 'team', teamId: parts[1] };
  }
  if (parts[0] === 'match' && parts[1]) return { name: 'match', matchId: parts[1] };
  if (parts[0] === 'club' && parts[1]) {
    if (parts[2] === 'match' && parts[3]) return { name: 'remoteMatch', teamId: parts[1], matchId: parts[3] };
    if (parts[2] === 'rankings') return { name: 'remoteRankings', teamId: parts[1] };
    return { name: 'remoteTeam', teamId: parts[1] };
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
      return `#/club/${encodeURIComponent(route.teamId)}`;
    case 'remoteMatch':
      return `#/club/${encodeURIComponent(route.teamId)}/match/${encodeURIComponent(route.matchId)}`;
    case 'remoteRankings':
      return `#/club/${encodeURIComponent(route.teamId)}/rankings`;
  }
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
