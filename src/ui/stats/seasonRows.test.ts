// Filas de «Temporada» con la plantilla (consulta): jugadores sin convocatorias,
// sin duplicados, sin oficiales ni inactivos nuevos. Datos sintéticos.
import { describe, expect, it } from 'vitest';
import type { Player } from '../../domain/types';
import { computeSeasonStats } from '../../stats/engine';
import { ev, goal, makeMatch, SQUAD } from '../../test/fixtures';
import { seasonRows } from './seasonRows';

const player = (id: string, number: number, extra: Partial<Player> = {}): Player => ({
  id, teamId: 't1', name: `Jugador ${id}`, number, position: 'field', active: true, createdAt: 'a', updatedAt: 'a', ...extra,
});
const official = { playerId: 'oficial-head-t1', name: 'Entrenador', number: 0, position: 'field' as const, role: 'official' as const };
const live = makeMatch({ id: 'm1', status: 'in_progress', squad: [...SQUAD.filter((s) => s.playerId !== 'p69'), official] });
const items = [{ match: live, events: [ev(goal(), 'p7', 1)] }];
const roster: Player[] = [
  ...SQUAD.map((s) => player(s.playerId, s.number, { name: s.name, position: s.position })),
  player('nuevo', 22),
  player('portero-nuevo', 30, { position: 'goalkeeper' }),
  player('inactivo', 33, { active: false }),
  player('oficial-manual', 0, { role: 'official' }),
  player('oficial-head-t1', 0, { role: 'official' }),
];

describe('filas de «Temporada» con la plantilla', () => {
  it('sin plantilla (entrenador): exactamente las filas del motor', () => {
    const stats = computeSeasonStats(items);
    expect(seasonRows(stats, items).map((r) => r.playerId)).toEqual([...stats.players.values()].sort((a, b) => a.latest.number - b.latest.number).map((p) => p.playerId));
  });

  it('con plantilla: añade los activos sin convocatoria, a cero; sin duplicados, oficiales ni inactivos', () => {
    const rows = seasonRows(computeSeasonStats(items), items, roster);
    expect(rows.map((r) => [r.playerId, r.matches])).toEqual([
      ['g1', 1],
      ['p7', 1],
      ['g12', 1],
      ['p14', 1],
      ['nuevo', 0],
      ['portero-nuevo', 0],
      ['p69', 0],
    ]);
    expect(new Set(rows.map((r) => r.playerId)).size).toBe(rows.length);
    expect(rows.find((r) => r.playerId === 'p7')!.counters.shots.goals).toBe(1);
    expect(rows.find((r) => r.playerId === 'portero-nuevo')).toMatchObject({ position: 'goalkeeper', counters: { shots: { attempts: 0 } } });
  });

  it('un convocado fuera del filtro («Solo finalizados») no reaparece como «sin estadísticas»', () => {
    const rows = seasonRows(computeSeasonStats([]), items, roster);
    expect(rows.some((r) => r.playerId === 'p7')).toBe(false);
    expect(rows.map((r) => r.playerId)).toEqual(['nuevo', 'portero-nuevo', 'p69']);
  });
});
