import { describe, expect, it } from 'vitest';
import { ev, goal, makeMatch, SQUAD } from '../test/fixtures';
import type { EventPayload, MatchEvent, SquadEntry } from '../domain/types';
import { computeSeasonStats, savePct, type MatchWithEvents } from './engine';
import {
  positionOf,
  RANKING_LIMIT,
  RANKING_THRESHOLDS,
  RANKINGS,
  rankingById,
  rankPlayers,
  seasonCandidates,
  topOf,
  type RankingId,
} from './rankings';

const miss = { kind: 'shot', shotType: 'nine_m', result: 'out' } as const;
const saved = { kind: 'shot', shotType: 'six_m', result: 'saved' } as const;
const gkSave = { kind: 'gk_shot', shotType: 'nine_m', result: 'save' } as const;
const gkGoal = { kind: 'gk_shot', shotType: 'six_m', result: 'goal' } as const;
const gkOut = { kind: 'gk_shot', shotType: 'wing', result: 'out' } as const;
const exclusion = { kind: 'exclusion' } as const;
const recovery = { kind: 'recovery' } as const;

const times = (n: number, payload: EventPayload, playerId: string | null, matchId = 'm1'): MatchEvent[] =>
  Array.from({ length: n }, (_, i) => ev(payload, playerId, 1 + i, { matchId }));

function rank(id: RankingId, items: MatchWithEvents[]) {
  return rankPlayers(rankingById(id), seasonCandidates(computeSeasonStats(items)));
}

const summary = (r: ReturnType<typeof rank>) => r.map((e) => [e.position, e.player.playerId, e.value]);

describe('rankings: orden y empates', () => {
  it('ordena de mayor a menor y omite a quien no tiene actividad', () => {
    const events = [...times(3, goal(), 'p14'), ...times(5, goal(), 'p7'), ...times(4, miss, 'p69')];
    expect(summary(rank('top_scorer', [{ match: makeMatch(), events }]))).toEqual([
      [1, 'p7', 5],
      [2, 'p14', 3],
    ]);
  });

  it('los empatados comparten puesto y el siguiente salta (1, 1, 3)', () => {
    const events = [...times(2, recovery, 'p69'), ...times(2, recovery, 'p7'), ...times(1, recovery, 'p14')];
    const r = rank('thief', [{ match: makeMatch(), events }]);
    // Dentro del empate, por dorsal.
    expect(summary(r)).toEqual([
      [1, 'p7', 2],
      [1, 'p69', 2],
      [3, 'p14', 1],
    ]);
  });

  it('suma la temporada y no cuenta acciones pendientes de atribuir', () => {
    const r = rank('repeat_offender', [
      { match: makeMatch({ id: 'm1' }), events: [ev(exclusion, 'p7', 5), ev(exclusion, null, 6)] },
      { match: makeMatch({ id: 'm2', date: '2026-11-01' }), events: [ev(exclusion, 'p7', 5, { matchId: 'm2' })] },
    ]);
    expect(summary(r)).toEqual([[1, 'p7', 2]]);
    expect(r[0]!.player.matches).toBe(2);
  });

  it('usa el nombre y dorsal de la última convocatoria', () => {
    const renamed: SquadEntry[] = SQUAD.map((s) => (s.playerId === 'p7' ? { ...s, name: 'Nuevo nombre', number: 70 } : s));
    const r = rank('top_scorer', [
      { match: makeMatch({ id: 'm1' }), events: [ev(goal(), 'p7')] },
      { match: makeMatch({ id: 'm2', date: '2026-11-01', squad: renamed }), events: [] },
    ]);
    expect(r[0]!.player).toMatchObject({ name: 'Nuevo nombre', number: 70 });
  });
});

describe('rankings: Top 10', () => {
  const squad: SquadEntry[] = Array.from({ length: 14 }, (_, i) => ({
    playerId: `j${i + 1}`,
    name: `Jugador ${i + 1}`,
    number: i + 1,
    position: 'field',
  }));

  it('muestra como máximo diez y conserva la clasificación completa', () => {
    // j1 marca 1 gol, j2 marca 2… j14 marca 14.
    const events = squad.flatMap((s, i) => times(i + 1, goal(), s.playerId));
    const ranked = rank('top_scorer', [{ match: makeMatch({ squad }), events }]);
    expect(ranked).toHaveLength(14);
    const top = topOf(ranked);
    expect(top.entries).toHaveLength(RANKING_LIMIT);
    expect(top.entries[0]!.player.playerId).toBe('j14');
    expect(top.entries.at(-1)!.position).toBe(10);
    expect(top.hiddenTies).toBe(0);
    // Posición individual fuera del Top 10 (futuro modo jugador).
    expect(positionOf(ranked, 'j1')?.position).toBe(14);
    expect(positionOf(ranked, 'nadie')).toBeUndefined();
  });

  it('avisa de los empatados en el último puesto que no caben', () => {
    // j1..j8 con 10, 9… 3 recuperaciones (puestos 1 a 8); j9..j12 empatan con 1 en el 9.º.
    const events = squad.slice(0, 12).flatMap((s, i) => times(i < 8 ? 10 - i : 1, recovery, s.playerId));
    const top = topOf(rank('thief', [{ match: makeMatch({ squad }), events }]));
    expect(top.entries).toHaveLength(10);
    expect(top.entries.at(-1)!.position).toBe(9);
    expect(top.hiddenTies).toBe(2);
  });

  it('con menos de diez participantes los muestra todos', () => {
    const top = topOf(rank('top_scorer', [{ match: makeMatch(), events: [ev(goal(), 'p7')] }]));
    expect(top.entries).toHaveLength(1);
    expect(top.hiddenTies).toBe(0);
  });
});

describe('rankings: porcentajes y mínimos', () => {
  const min = RANKING_THRESHOLDS.minShots;

  it('el francotirador exige el mínimo de lanzamientos', () => {
    const events = [
      // p7: 9 de 9 (100 %), por debajo del mínimo.
      ...times(min - 1, goal(), 'p7'),
      // p14: 6 de 10 (60 %).
      ...times(6, goal(), 'p14'),
      ...times(4, miss, 'p14'),
      // p69: 8 de 12 (66,7 %).
      ...times(8, goal(), 'p69'),
      ...times(2, miss, 'p69'),
      ...times(2, saved, 'p69'),
    ];
    const r = rank('sharpshooter', [{ match: makeMatch(), events }]);
    expect(r.map((e) => [e.position, e.player.playerId, e.value, e.made, e.of])).toEqual([
      [1, 'p69', 66.7, 8, 12],
      [2, 'p14', 60, 6, 10],
    ]);
  });

  it('dos porcentajes iguales en pantalla empatan', () => {
    const events = [
      ...times(5, goal(), 'p7'),
      ...times(5, miss, 'p7'),
      ...times(10, goal(), 'p14'),
      ...times(10, miss, 'p14'),
    ];
    const r = rank('sharpshooter', [{ match: makeMatch(), events }]);
    expect(r.map((e) => e.position)).toEqual([1, 1]);
  });

  it('el muro usa paradas / (paradas + goles); los fuera no cuentan', () => {
    // Los datos están pensados para un mínimo de 20 tiros a puerta.
    expect(RANKING_THRESHOLDS.minGkOnTarget).toBe(20);
    const events = [
      // g1: 12 paradas y 8 goles = 20 a puerta (60 %), más 15 fuera.
      ...times(12, gkSave, 'g1'),
      ...times(8, gkGoal, 'g1'),
      ...times(15, gkOut, 'g1'),
      // g12: 15 paradas y 4 goles = 19 a puerta, bajo el mínimo aunque tenga fuera.
      ...times(15, gkSave, 'g12'),
      ...times(4, gkGoal, 'g12'),
      ...times(10, gkOut, 'g12'),
    ];
    const items = [{ match: makeMatch(), events }];
    const r = rank('wall', items);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ value: 60, made: 12, of: 20, position: 1 });
    // Misma cifra que el panel de porteros.
    const stats = computeSeasonStats(items);
    expect(r[0]!.value).toBe(savePct(stats.players.get('g1')!.counters.gk));

    // Muro defensivo: número de paradas, sin mínimo.
    expect(summary(rank('saves', items))).toEqual([
      [1, 'g12', 15],
      [2, 'g1', 12],
    ]);
  });

  it('cada ranking de porcentaje explica su mínimo en el texto', () => {
    for (const def of RANKINGS.filter((d) => d.format === 'pct')) expect(def.minimum).toMatch(/Mínimo \d+/);
  });
});

describe('rankings: cifras del motor', () => {
  it('pérdidas incluyen pasos, dobles y pases fallados; lanzamientos = goles + fuera + parados', () => {
    const events = [
      ev({ kind: 'turnover', turnoverType: 'steps' }, 'p7'),
      ev({ kind: 'turnover', turnoverType: 'bad_pass' }, 'p7'),
      ev({ kind: 'turnover', turnoverType: 'general' }, 'p14'),
      ev(goal(), 'p14'),
      ev(miss, 'p14'),
      ev(saved, 'p14'),
      ev(goal('penalty'), 'g1'),
    ];
    const items = [{ match: makeMatch(), events }];
    expect(summary(rank('generous', items))).toEqual([
      [1, 'p7', 2],
      [2, 'p14', 1],
    ]);
    // Un portero que marca también suma en los rankings de lanzamiento.
    expect(summary(rank('shots', items))).toEqual([
      [1, 'p14', 3],
      [2, 'g1', 1],
    ]);
  });

  it('la tercera exclusión cuenta como exclusión; la roja por acumulación no suma otra', () => {
    const events = [ev(exclusion, 'p7', 5), ev(exclusion, 'p7', 15), ev(exclusion, 'p7', 25)];
    expect(summary(rank('repeat_offender', [{ match: makeMatch(), events }]))).toEqual([[1, 'p7', 3]]);
  });
});

describe('rankings: cambios en los eventos', () => {
  it('una acción borrada deja de contar y una editada cuenta con su nuevo tipo', () => {
    const g = ev(goal(), 'p14');
    const events = [ev(goal(), 'p7'), ev(goal(), 'p7'), g];
    expect(summary(rank('top_scorer', [{ match: makeMatch(), events }]))[0]).toEqual([1, 'p7', 2]);

    const deleted = events.map((e, i) => (i === 0 ? { ...e, deletedAt: e.createdAt } : e));
    expect(summary(rank('top_scorer', [{ match: makeMatch(), events: deleted }]))).toEqual([
      [1, 'p7', 1],
      [1, 'p14', 1],
    ]);

    // El gol de p14 se corrige a lanzamiento fuera: sale de goleadores, sigue en lanzamientos.
    const edited = deleted.map((e) => (e.id === g.id ? { ...g, ...miss } : e));
    const items = [{ match: makeMatch(), events: edited }];
    expect(summary(rank('top_scorer', items))).toEqual([[1, 'p7', 1]]);
    expect(summary(rank('shots', items))).toEqual([
      [1, 'p7', 1],
      [1, 'p14', 1],
    ]);
  });
});

describe('rankings: sin datos', () => {
  it('sin partidos ni acciones, todas las clasificaciones están vacías', () => {
    for (const def of RANKINGS) {
      expect(rank(def.id, [])).toEqual([]);
      expect(rank(def.id, [{ match: makeMatch(), events: [] }])).toEqual([]);
    }
    expect(topOf([])).toEqual({ entries: [], hiddenTies: 0 });
  });
});
