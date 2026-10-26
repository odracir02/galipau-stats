import { useSyncExternalStore } from 'react';

export type Route =
  | { name: 'teams' }
  | { name: 'team'; teamId: string }
  | { name: 'newMatch'; teamId: string }
  | { name: 'match'; matchId: string };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'team' && parts[1]) {
    return parts[2] === 'new-match' ? { name: 'newMatch', teamId: parts[1] } : { name: 'team', teamId: parts[1] };
  }
  if (parts[0] === 'match' && parts[1]) return { name: 'match', matchId: parts[1] };
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
    case 'match':
      return `#/match/${encodeURIComponent(route.matchId)}`;
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
