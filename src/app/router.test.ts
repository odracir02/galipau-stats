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
    { name: 'remoteTeam', teamId: 'equipo-1', tab: 'me' },
    { name: 'remoteTeam', teamId: 'equipo-1', tab: 'matches' },
    { name: 'remoteTeam', teamId: 'equipo-1', tab: 'players' },
    { name: 'remoteTeam', teamId: 'equipo-1', tab: 'season' },
    { name: 'remoteMatch', teamId: 'equipo-1', matchId: 'partido-1' },
    { name: 'remoteRankings', teamId: 'equipo-1' },
    { name: 'install' },
  ])('ida y vuelta %o', (route) => {
    expect(parseRoute(routeHref(route))).toEqual(route);
  });

  it('pestañas del equipo del club: con nombre legible; los enlaces anteriores siguen valiendo', () => {
    expect(routeHref({ name: 'remoteTeam', teamId: 'e1', tab: 'me' })).toBe('#/club/e1/mi-jugador');
    expect(routeHref({ name: 'remoteTeam', teamId: 'e1' })).toBe('#/club/e1');
    expect(parseRoute('#/club/e1')).toEqual({ name: 'remoteTeam', teamId: 'e1' });
    expect(parseRoute('#/club/e1/lo-que-sea')).toEqual({ name: 'remoteTeam', teamId: 'e1' });
    expect(parseRoute('#/club/e1/rankings')).toEqual({ name: 'remoteRankings', teamId: 'e1' });
    expect(parseRoute('#/club/e1/match/m1')).toEqual({ name: 'remoteMatch', teamId: 'e1', matchId: 'm1' });
  });

  it('rutas desconocidas llevan al inicio', () => {
    expect(parseRoute('#/lo-que-sea')).toEqual({ name: 'teams' });
    expect(parseRoute('')).toEqual({ name: 'teams' });
  });
});
