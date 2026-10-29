import { describe, expect, it } from 'vitest';
import { parseRoute, routeHref, type Route } from './router';

describe('rutas', () => {
  it.each<Route>([
    { name: 'teams' },
    { name: 'team', teamId: 'abc' },
    { name: 'newMatch', teamId: 'abc' },
    { name: 'rankings', teamId: 'abc' },
    { name: 'match', matchId: 'x-1' },
    { name: 'remoteTeam', teamId: 'equipo-1' },
    { name: 'remoteMatch', teamId: 'equipo-1', matchId: 'partido-1' },
    { name: 'remoteRankings', teamId: 'equipo-1' },
  ])('ida y vuelta %o', (route) => {
    expect(parseRoute(routeHref(route))).toEqual(route);
  });

  it('rutas desconocidas llevan al inicio', () => {
    expect(parseRoute('#/lo-que-sea')).toEqual({ name: 'teams' });
    expect(parseRoute('')).toEqual({ name: 'teams' });
  });
});
