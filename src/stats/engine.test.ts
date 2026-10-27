import { describe, expect, it } from 'vitest';
import { ev, goal, makeMatch } from '../test/fixtures';
import {
  computeMatchStats,
  computeSeasonStats,
  efficiency,
  intervalIndex,
  onTarget,
  sanctions,
  savePct,
} from './engine';
import { MINUTE_MS } from '../clock/clock';
import type { MatchEvent } from '../domain/types';

const match = makeMatch();
const stats = (events: MatchEvent[], m = match) => computeMatchStats(m, events);
const player = (events: MatchEvent[], id: string) => {
  const c = stats(events).players.get(id);
  if (!c) throw new Error(`sin estadísticas para ${id}`);
  return c;
};

describe('lanzamientos de jugadores de campo', () => {
  it('un gol suma gol, lanzamiento, eficacia, total colectivo y marcador propio', () => {
    const s = stats([ev(goal('nine_m'), 'p69')]);
    const p = s.players.get('p69')!;
    expect(p.shots).toEqual({ goals: 1, out: 0, saved: 0, attempts: 1 });
    expect(p.shotsByType.nine_m.goals).toBe(1);
    expect(efficiency(p.shots)).toBe(100);
    expect(s.team.shots.goals).toBe(1);
    expect(s.score.own).toBe(1);
    expect(s.score.opponent).toBe(0);
  });

  it('un lanzamiento fuera cuenta como intento, no como gol', () => {
    const p = player([ev({ kind: 'shot', shotType: 'six_m', result: 'out' }, 'p7')], 'p7');
    expect(p.shots).toEqual({ goals: 0, out: 1, saved: 0, attempts: 1 });
    expect(p.shotsByType.six_m.out).toBe(1);
    expect(efficiency(p.shots)).toBe(0);
  });

  it('un lanzamiento parado por el portero rival cuenta como intento', () => {
    const s = stats([ev({ kind: 'shot', shotType: 'fast_break', result: 'saved' }, 'p7')]);
    expect(s.players.get('p7')!.shots).toEqual({ goals: 0, out: 0, saved: 1, attempts: 1 });
    expect(s.team.shots.saved).toBe(1);
    expect(s.score.own).toBe(0);
  });

  it('eficacia = goles / lanzamientos × 100', () => {
    const events = [
      ev(goal(), 'p14'),
      ev(goal('six_m'), 'p14'),
      ev({ kind: 'shot', shotType: 'nine_m', result: 'out' }, 'p14'),
      ev({ kind: 'shot', shotType: 'penalty', result: 'saved' }, 'p14'),
    ];
    const p = player(events, 'p14');
    expect(p.shots.attempts).toBe(4);
    expect(efficiency(p.shots)).toBe(50);
    expect(p.shotsByType.penalty).toEqual({ goals: 0, out: 0, saved: 1, attempts: 1 });
  });

  it('sin lanzamientos la eficacia es «sin datos» (null), no 0 %', () => {
    expect(efficiency(player([], 'p7').shots)).toBeNull();
  });
});

describe('porteros', () => {
  it('un gol recibido suma al portero y al marcador rival', () => {
    const s = stats([ev({ kind: 'gk_shot', shotType: 'wing', result: 'goal' }, 'g1')]);
    const g = s.players.get('g1')!;
    expect(g.gk).toEqual({ goals: 1, saves: 0, out: 0, received: 1 });
    expect(g.gkByType.wing.goals).toBe(1);
    expect(s.score.opponent).toBe(1);
    expect(s.score.own).toBe(0);
  });

  it('una parada suma parada y lanzamiento recibido', () => {
    const g = player([ev({ kind: 'gk_shot', shotType: 'nine_m', result: 'save' }, 'g12')], 'g12');
    expect(g.gk).toEqual({ goals: 0, saves: 1, out: 0, received: 1 });
    expect(savePct(g.gk)).toBe(100);
  });

  it('un lanzamiento rival fuera es lanzamiento recibido pero no entra en el % de paradas', () => {
    const g = player([ev({ kind: 'gk_shot', shotType: 'six_m', result: 'out' }, 'g1')], 'g1');
    expect(g.gk.received).toBe(1);
    expect(g.gk.out).toBe(1);
    expect(onTarget(g.gk)).toBe(0);
    expect(savePct(g.gk)).toBeNull();
  });

  it('% paradas = paradas / (paradas + goles) × 100, excluyendo los fuera', () => {
    const events = [
      ev({ kind: 'gk_shot', shotType: 'nine_m', result: 'save' }, 'g1'),
      ev({ kind: 'gk_shot', shotType: 'nine_m', result: 'goal' }, 'g1'),
      ev({ kind: 'gk_shot', shotType: 'penalty', result: 'goal' }, 'g1'),
      ev({ kind: 'gk_shot', shotType: 'fast_break', result: 'save' }, 'g1'),
      ev({ kind: 'gk_shot', shotType: 'wing', result: 'out' }, 'g1'),
    ];
    const g = player(events, 'g1');
    expect(g.gk.received).toBe(5);
    expect(onTarget(g.gk)).toBe(4);
    expect(savePct(g.gk)).toBe(50);
    expect(savePct(g.gkByType.nine_m)).toBe(50);
    expect(savePct(g.gkByType.penalty)).toBe(0);
  });
});

describe('pérdidas automáticas', () => {
  it.each([
    ['steps', 'steps'],
    ['double', 'double'],
    ['bad_pass', 'badPass'],
  ] as const)('%s cuenta su tipo y también una pérdida, sin duplicar', (type, key) => {
    const s = stats([ev({ kind: 'turnover', turnoverType: type }, 'p69')]);
    const p = s.players.get('p69')!;
    expect(p.turnovers[key]).toBe(1);
    expect(p.turnovers.total).toBe(1);
    expect(s.team.turnovers[key]).toBe(1);
    expect(s.team.turnovers.total).toBe(1);
  });

  it('pérdida general cuenta solo como pérdida', () => {
    const p = player([ev({ kind: 'turnover', turnoverType: 'general' }, 'g1')], 'g1');
    expect(p.turnovers).toEqual({ total: 1, general: 1, steps: 0, double: 0, badPass: 0 });
  });

  it('varias pérdidas de tipos distintos suman el total correcto', () => {
    const events = [
      ev({ kind: 'turnover', turnoverType: 'steps' }, 'p7'),
      ev({ kind: 'turnover', turnoverType: 'bad_pass' }, 'p7'),
      ev({ kind: 'turnover', turnoverType: 'general' }, 'p7'),
    ];
    expect(player(events, 'p7').turnovers.total).toBe(3);
  });
});

describe('penaltis: tres conceptos distintos', () => {
  it('penalti lanzado, penalti cometido y penalti recibido no se mezclan', () => {
    const s = stats([
      ev({ kind: 'shot', shotType: 'penalty', result: 'goal' }, 'p7'),
      ev({ kind: 'penalty_committed' }, 'p14'),
      ev({ kind: 'gk_shot', shotType: 'penalty', result: 'save' }, 'g1'),
    ]);
    expect(s.team.shotsByType.penalty.attempts).toBe(1);
    expect(s.team.penaltiesCommitted).toBe(1);
    expect(s.team.gkByType.penalty.received).toBe(1);
    expect(s.players.get('p7')!.penaltiesCommitted).toBe(0);
    expect(s.players.get('p14')!.shots.attempts).toBe(0);
    expect(s.players.get('p14')!.penaltiesCommitted).toBe(1);
    expect(s.score).toMatchObject({ own: 1, opponent: 0 });
  });
});

describe('sanciones y acciones generales', () => {
  it('cuenta amarillas, exclusiones, rojas, golpes francos y recuperaciones', () => {
    const s = stats([
      ev({ kind: 'yellow' }, 'p7'),
      ev({ kind: 'exclusion' }, 'p7'),
      ev({ kind: 'exclusion' }, 'p14'),
      ev({ kind: 'red' }, 'p14'),
      ev({ kind: 'free_throw' }, 'p69'),
      ev({ kind: 'recovery' }, 'g1'),
    ]);
    expect(sanctions(s.team)).toBe(4);
    expect(s.team.exclusions).toBe(2);
    expect(s.team.freeThrows).toBe(1);
    expect(s.players.get('g1')!.recoveries).toBe(1);
    expect(sanctions(s.players.get('p7')!)).toBe(2);
  });

  it('los eventos borrados no cuentan en nada', () => {
    const s = stats([ev(goal(), 'p7', 1, { deleted: true }), ev({ kind: 'recovery' }, 'p7', 2, { deleted: true })]);
    expect(s.team.shots.attempts).toBe(0);
    expect(s.team.recoveries).toBe(0);
    expect(s.score.own).toBe(0);
  });
});

describe('acciones pendientes de atribución', () => {
  it('suman al colectivo y al marcador, pero a ningún jugador', () => {
    const s = stats([
      ev(goal(), null),
      ev({ kind: 'gk_shot', shotType: 'nine_m', result: 'goal' }, null),
      ev({ kind: 'turnover', turnoverType: 'steps' }, null),
    ]);
    expect(s.pendingCount).toBe(3);
    expect(s.team.shots.goals).toBe(1);
    expect(s.team.turnovers.total).toBe(1);
    expect(s.score).toMatchObject({ own: 1, opponent: 1 });
    for (const c of s.players.values()) {
      expect(c.shots.attempts + c.gk.received + c.turnovers.total).toBe(0);
    }
  });
});

describe('corrección manual del marcador', () => {
  it('modifica el marcador sin inventar lanzamientos ni alterar eficacias', () => {
    const m = makeMatch({ scoreAdjustment: { own: 2, opponent: -1 } });
    const s = stats(
      [ev(goal(), 'p7'), ev({ kind: 'shot', shotType: 'nine_m', result: 'out' }, 'p7'), ev({ kind: 'gk_shot', shotType: 'nine_m', result: 'goal' }, 'g1'), ev({ kind: 'gk_shot', shotType: 'six_m', result: 'goal' }, 'g1')],
      m,
    );
    expect(s.score).toEqual({
      ownFromEvents: 1,
      opponentFromEvents: 2,
      ownAdjustment: 2,
      opponentAdjustment: -1,
      own: 3,
      opponent: 1,
    });
    expect(s.team.shots.goals).toBe(1);
    expect(efficiency(s.team.shots)).toBe(50);
    expect(savePct(s.team.gk)).toBe(0);
  });
});

describe('intervalos de cinco minutos', () => {
  it('asigna cada evento a su tramo de la parte correspondiente', () => {
    expect(intervalIndex({ period: 1, matchTimeMs: 0 }, 30)).toBe(0);
    expect(intervalIndex({ period: 1, matchTimeMs: 4 * MINUTE_MS + 59_999 }, 30)).toBe(0);
    expect(intervalIndex({ period: 1, matchTimeMs: 5 * MINUTE_MS }, 30)).toBe(1);
    expect(intervalIndex({ period: 1, matchTimeMs: 29 * MINUTE_MS }, 30)).toBe(5);
    expect(intervalIndex({ period: 2, matchTimeMs: 30 * MINUTE_MS }, 30)).toBe(6);
    expect(intervalIndex({ period: 2, matchTimeMs: 59 * MINUTE_MS + 59_000 }, 30)).toBe(11);
  });

  it('el tiempo añadido de una parte queda en su último tramo, no en la parte siguiente', () => {
    expect(intervalIndex({ period: 1, matchTimeMs: 31 * MINUTE_MS }, 30)).toBe(5);
    expect(intervalIndex({ period: 2, matchTimeMs: 62 * MINUTE_MS }, 30)).toBe(11);
    // Un evento de 2.ª parte con un tiempo anterior a 30:00 (ajuste raro) cae en el primer tramo de la 2.ª.
    expect(intervalIndex({ period: 2, matchTimeMs: 10 * MINUTE_MS }, 30)).toBe(6);
  });

  it('reparte goles a favor y en contra por tramos', () => {
    const s = stats([
      ev(goal(), 'p7', 2),
      ev(goal(), 'p7', 3),
      ev({ kind: 'gk_shot', shotType: 'nine_m', result: 'goal' }, 'g1', 7),
      ev(goal(), 'p14', 31, { period: 1 }),
      ev(goal(), 'p14', 58),
    ]);
    expect(s.intervals).toHaveLength(12);
    expect(s.intervals.map((i) => i.endMinute)).toEqual([5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60]);
    expect(s.intervals[0]!.counters.shots.goals).toBe(2);
    expect(s.intervals[1]!.counters.gk.goals).toBe(1);
    expect(s.intervals[5]!.counters.shots.goals).toBe(1);
    expect(s.intervals[11]!.counters.shots.goals).toBe(1);
    const totalGoals = s.intervals.reduce((n, i) => n + i.counters.shots.goals, 0);
    expect(totalGoals).toBe(s.team.shots.goals);
  });
});

describe('estadísticas de temporada', () => {
  it('suma partidos y calcula porcentajes sobre totales, no promediando porcentajes', () => {
    const m1 = makeMatch({ id: 'm1', date: '2026-10-01' });
    const m2 = makeMatch({
      id: 'm2',
      date: '2026-10-08',
      squad: [
        // En el segundo partido p7 cambió de dorsal.
        { playerId: 'p7', name: 'Jugador Siete', number: 77, position: 'field' },
        { playerId: 'g1', name: 'Portero Uno', number: 1, position: 'goalkeeper' },
      ],
      scoreAdjustment: { own: 1, opponent: 0 },
    });
    // Partido 1: p7 1/1 (100 %). Partido 2: p7 1/3 (33 %). Media simple sería 66,7 %; real 2/4 = 50 %.
    const season = computeSeasonStats([
      {
        match: m1,
        events: [ev(goal(), 'p7', 1, { matchId: 'm1' }), ev({ kind: 'gk_shot', shotType: 'nine_m', result: 'save' }, 'g1', 2, { matchId: 'm1' })],
      },
      {
        match: m2,
        events: [
          ev(goal(), 'p7', 1, { matchId: 'm2' }),
          ev({ kind: 'shot', shotType: 'nine_m', result: 'out' }, 'p7', 2, { matchId: 'm2' }),
          ev({ kind: 'shot', shotType: 'six_m', result: 'saved' }, 'p7', 3, { matchId: 'm2' }),
          ev({ kind: 'gk_shot', shotType: 'nine_m', result: 'goal' }, 'g1', 4, { matchId: 'm2' }),
          ev({ kind: 'gk_shot', shotType: 'nine_m', result: 'goal' }, 'g1', 5, { matchId: 'm2' }),
          ev({ kind: 'gk_shot', shotType: 'nine_m', result: 'save' }, 'g1', 6, { matchId: 'm2' }),
        ],
      },
    ]);
    expect(season.matches).toBe(2);
    const p7 = season.players.get('p7')!;
    expect(p7.matches).toBe(2);
    expect(p7.latest.number).toBe(77);
    expect(p7.counters.shots).toEqual({ goals: 2, out: 1, saved: 1, attempts: 4 });
    expect(efficiency(p7.counters.shots)).toBe(50);
    // Portero: partido 1 100 %, partido 2 33 %; total 2 paradas / 4 entre palos = 50 %.
    expect(savePct(season.players.get('g1')!.counters.gk)).toBe(50);
    // p14 solo fue convocado en el primer partido.
    expect(season.players.get('p14')!.matches).toBe(1);
    // Marcador acumulado incluye la corrección manual; las eficacias no.
    expect(season.goalsFor).toBe(3);
    expect(season.goalsAgainst).toBe(2);
    expect(season.team.shots.goals).toBe(2);
    // Intervalos acumulados: 2 goles propios en el primer tramo (uno por partido).
    expect(season.intervals![0]!.counters.shots.goals).toBe(2);
    expect(season.intervals![1]!.counters.gk.goals).toBe(1);
  });
});

describe('gol de portero', () => {
  it('cuenta como lanzamiento ofensivo del portero y en el marcador propio, nunca como recibido', () => {
    const s = stats([ev(goal('fast_break'), 'g1'), ev({ kind: 'gk_shot', shotType: 'nine_m', result: 'goal' }, 'g1')]);
    const g = s.players.get('g1')!;
    expect(g.shots).toEqual({ goals: 1, out: 0, saved: 0, attempts: 1 });
    expect(g.shotsByType.fast_break.goals).toBe(1);
    expect(efficiency(g.shots)).toBe(100);
    expect(g.gk).toEqual({ goals: 1, saves: 0, out: 0, received: 1 });
    expect(savePct(g.gk)).toBe(0);
    expect(s.score).toMatchObject({ own: 1, opponent: 1 });
  });
});
