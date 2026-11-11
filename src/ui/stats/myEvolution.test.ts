// Evolución de «Mi jugador»: serie de partidos finalizados con convocatoria,
// recuentos, medias con denominador explícito y comparación reciente, con las
// reglas del motor (acciones anuladas, sin asignar, partidos que cuentan). Datos sintéticos.
import { describe, expect, it } from 'vitest';
import type { Match, MatchEvent, Player, SquadEntry } from '../../domain/types';
import type { TeamSnapshot } from '../../remote/api';
import { seasonItems } from '../../remote/viewer';
import { computeMatchStats, computeSeasonStats, efficiency, savePct, sumCounters, emptyCounters } from '../../stats/engine';
import { ev, goal, makeMatch, SQUAD } from '../../test/fixtures';
import {
  comparisonAverages,
  mainAverage,
  myAverages,
  myEvolution,
  myMatchSeries,
  myRate,
  mySeason,
  otherPositionMatches,
  RECENT_MATCHES,
  RECENT_MIN_MATCHES,
  recentMatches,
  SERIES_LIMIT,
} from './mySeason';

const SEASON = '2026/27';
const player = (id: string): Player => {
  const s = SQUAD.find((x) => x.playerId === id)!;
  return { id, teamId: 't1', name: s.name, number: s.number, position: s.position, active: true, createdAt: 'a', updatedAt: 'a' };
};
function snapshot(matches: Match[], events: MatchEvent[]): TeamSnapshot {
  return {
    team: { id: 't1', name: 'Infantil Masculino A', code: 'IMA2627', season: SEASON },
    club: { id: 'c', name: 'Club' },
    seq: 1,
    players: SQUAD.map((s) => ({ version: 1, player: player(s.playerId) })),
    matches: matches.map((match) => ({ version: 1, match, recordedHere: false })),
    events: events.map((event) => ({ version: 1, event })),
  };
}
const day = (n: number) => `2026-10-${String(n).padStart(2, '0')}`;
const finished = (id: string, date: string, extra: Partial<Match> = {}) => makeMatch({ id, date, status: 'finished', ...extra });
const MISS = { kind: 'shot', shotType: 'nine_m', result: 'out' } as const;
const SAVE = { kind: 'gk_shot', shotType: 'nine_m', result: 'save' } as const;
const CONCEDED = { kind: 'gk_shot', shotType: 'six_m', result: 'goal' } as const;
const GK_OUT = { kind: 'gk_shot', shotType: 'wing', result: 'out' } as const;
/** p7 convocado como portero en un partido (cambio de posición). */
const asKeeper = (squad: SquadEntry[], id: string): SquadEntry[] => squad.map((s) => (s.playerId === id ? { ...s, position: 'goalkeeper' } : s));

// Temporada base: cuatro finalizados con convocatoria de p7, uno sin convocarle,
// uno en juego, uno preparado sin acciones, uno borrado y otro de la temporada anterior.
const M1 = finished('m1', day(4));
const M2 = finished('m2', day(11)); // p7 convocado, sin acciones válidas (solo una anulada y una sin asignar)
const M3a = finished('m3a', day(18), { createdAt: '2026-10-18T09:00:00.000Z' });
const M3b = finished('m3b', day(18), { createdAt: '2026-10-18T09:00:00.000Z' }); // misma fecha y creación: desempata el id
const M3c = finished('m3c', day(18), { createdAt: '2026-10-18T08:00:00.000Z' }); // misma fecha, creado antes
const NOT_CONVOKED = finished('m5', day(20), { squad: SQUAD.filter((s) => s.playerId !== 'p7') });
const LIVE = makeMatch({ id: 'm6', date: day(25), status: 'in_progress' });
const READY = makeMatch({ id: 'm7', date: day(26), status: 'ready' });
const DELETED = finished('m8', day(22), { deletedAt: '2026-10-23T10:00:00.000Z' });
const OLD = finished('m0', '2025-10-01', { season: '2025/26' });
const EVENTS = [
  ev(goal(), 'p7', 1, { matchId: 'm1' }),
  ev(goal('penalty'), 'p7', 2, { matchId: 'm1' }),
  ev(MISS, 'p7', 3, { matchId: 'm1' }),
  ev({ kind: 'recovery' }, 'p7', 4, { matchId: 'm1' }),
  ev(goal(), 'p7', 5, { matchId: 'm2', deleted: true }), // anulada
  ev(goal(), null, 6, { matchId: 'm2' }), // sin asignar: no es de nadie
  ev(goal(), 'p14', 7, { matchId: 'm2' }), // de un compañero
  ev({ kind: 'turnover', turnoverType: 'steps' }, 'p7', 8, { matchId: 'm3a' }),
  ev(goal(), 'p7', 9, { matchId: 'm3b' }),
  ev(goal('fast_break'), 'p7', 10, { matchId: 'm3c' }),
  ev(goal(), 'p7', 11, { matchId: 'm5' }), // no convocado: no le cuenta (como en «Temporada»)
  ev(goal(), 'p7', 12, { matchId: 'm6' }), // en juego
  ev(goal(), 'p7', 13, { matchId: 'm8' }), // partido borrado
  ev(goal(), 'p7', 14, { matchId: 'm0' }), // otra temporada
  ev(SAVE, 'g1', 15, { matchId: 'm1' }),
  ev(CONCEDED, 'g1', 16, { matchId: 'm1' }),
];
const BASE = snapshot([M1, M2, M3a, M3b, M3c, NOT_CONVOKED, LIVE, READY, DELETED, OLD], EVENTS);

describe('serie de partidos de «Mi jugador»', () => {
  it('solo finalizados con convocatoria de la temporada, en orden cronológico con desempate estable', () => {
    const series = myMatchSeries(BASE, 'p7', SEASON);
    // Misma fecha: primero el creado antes (m3c) y, a igual creación, por identificador (m3a, m3b).
    expect(series.map((p) => p.matchId)).toEqual(['m1', 'm2', 'm3c', 'm3a', 'm3b']);
    // Es estable aunque los partidos lleguen en otro orden.
    const shuffled = snapshot([OLD, READY, M3b, LIVE, M3a, M2, DELETED, M3c, NOT_CONVOKED, M1], [...EVENTS].reverse());
    expect(myMatchSeries(shuffled, 'p7', SEASON)).toEqual(series);
  });

  it('datos de cada partido: fecha, rival, campo, marcador, resultado, posición y sus cifras', () => {
    const [m1] = myMatchSeries(BASE, 'p7', SEASON);
    expect(m1).toMatchObject({ matchId: 'm1', date: day(4), opponent: 'Rival de prueba', venue: 'home', position: 'field', actions: 4, gkOnTarget: 0 });
    expect(m1!.counters.shots).toEqual({ goals: 2, out: 1, saved: 0, attempts: 3 });
    expect(m1!.counters.recoveries).toBe(1);
    // El marcador y el resultado, los del motor (m1: 3 goles propios, 1 encajado).
    const engine = computeMatchStats(M1, EVENTS.filter((e) => e.matchId === 'm1'));
    expect(m1!.score).toEqual({ own: engine.score.own, opponent: engine.score.opponent });
    expect(m1!.result).toBe('win');
  });

  it('convocado sin acciones válidas: el partido se conserva, a cero y sin acciones (anuladas, sin asignar y ajenas no cuentan)', () => {
    const m2 = myMatchSeries(BASE, 'p7', SEASON).find((p) => p.matchId === 'm2')!;
    expect(m2.actions).toBe(0);
    expect(m2.counters).toEqual(emptyCounters());
    // El motor tampoco se las atribuye: la sin asignar queda pendiente para el equipo.
    expect(computeMatchStats(M2, EVENTS.filter((e) => e.matchId === 'm2')).players.get('p7')).toEqual(emptyCounters());
  });

  it('partidos en juego, preparados, borrados, de otra temporada o sin convocatoria: fuera de la serie', () => {
    const ids = myMatchSeries(BASE, 'p7', SEASON).map((p) => p.matchId);
    for (const id of ['m5', 'm6', 'm7', 'm8', 'm0']) expect(ids).not.toContain(id);
  });

  it('sin convocatorias: serie vacía, recuentos a cero, sin acumulados ni comparación', () => {
    const empty = myEvolution(BASE, 'p69-inexistente', SEASON);
    expect(empty).toEqual({
      counts: { convocations: 0, finished: 0, finishedWithActions: 0, finishedWithShotsOnTarget: 0 },
      series: [],
      byPosition: { field: null, goalkeeper: null },
      mixedPositions: false,
      comparisons: [],
    });
    expect(myEvolution(snapshot([], []), 'p7', SEASON).series).toEqual([]);
  });
});

describe('recuentos', () => {
  it('convocatorias (también en juego), en finalizados, con acciones válidas y con lanzamientos entre palos', () => {
    const { counts } = myEvolution(BASE, 'p7', SEASON);
    // m1, m2, m3a, m3b, m3c (finalizados) + m6 (en juego). m7 preparado sin acciones, no.
    expect(counts).toEqual({ convocations: 6, finished: 5, finishedWithActions: 4, finishedWithShotsOnTarget: 0 });
  });

  it('las convocatorias son las mismas que «Temporada» y «Mi jugador» (mySeason)', () => {
    for (const id of ['p7', 'p14', 'g1']) {
      expect(myEvolution(BASE, id, SEASON).counts.convocations).toBe(mySeason(BASE, player(id), SEASON).matches);
      const season = computeSeasonStats(seasonItems(BASE).filter((i) => i.match.season === SEASON));
      expect(myEvolution(BASE, id, SEASON).counts.convocations).toBe(season.players.get(id)?.matches ?? 0);
    }
  });

  it('portero convocado sin lanzamientos recibidos: cuenta la convocatoria, no el partido con lanzamientos', () => {
    // g1 recibe en m1; en el resto (también m5, donde solo falta p7) está convocado sin recibir nada.
    const { counts, series } = myEvolution(BASE, 'g1', SEASON);
    expect(counts).toMatchObject({ finished: 6, finishedWithActions: 1, finishedWithShotsOnTarget: 1 });
    expect(series.filter((p) => p.gkOnTarget === 0)).toHaveLength(5);
    expect(series.every((p) => p.position === 'goalkeeper')).toBe(true);
  });

  it('solo lanzamientos fuera: hay acción, pero ninguno entre palos', () => {
    const snap = snapshot([finished('k1', day(1))], [ev(GK_OUT, 'g1', 1, { matchId: 'k1' })]);
    const [k1] = myMatchSeries(snap, 'g1', SEASON);
    expect(k1).toMatchObject({ actions: 1, gkOnTarget: 0 });
    expect(myEvolution(snap, 'g1', SEASON).counts).toMatchObject({ finishedWithActions: 1, finishedWithShotsOnTarget: 0 });
  });
});

describe('consistencia con el motor', () => {
  it('la suma de la serie completa coincide con «Temporada» filtrada a los finalizados', () => {
    for (const id of ['p7', 'p14', 'g1']) {
      const series = myMatchSeries(BASE, id, SEASON);
      const sum = series.reduce((acc, p) => sumCounters(acc, p.counters), emptyCounters());
      const onlyFinished = computeSeasonStats(seasonItems(BASE).filter((i) => i.match.season === SEASON && i.match.status === 'finished'));
      expect(sum).toEqual(onlyFinished.players.get(id)?.counters ?? emptyCounters());
      expect(series.length).toBe(onlyFinished.players.get(id)?.matches ?? 0);
    }
  });

  it('las cifras de cada partido coinciden con los últimos partidos de «Mi jugador»', () => {
    const recent = recentMatches(BASE, 'p7', SEASON, 10);
    const byId = new Map(myMatchSeries(BASE, 'p7', SEASON).map((p) => [p.matchId, p]));
    expect(recent.length).toBe(byId.size);
    for (const r of recent) {
      expect(byId.get(r.match.id)!.counters).toEqual(r.counters);
      expect(byId.get(r.match.id)!.position).toBe(r.position);
    }
  });
});

// Temporada larga: 12 finalizados con convocatoria de p7 (de campo), con goles 0…11.
const LONG = Array.from({ length: 12 }, (_, i) => finished(`l${String(i + 1).padStart(2, '0')}`, day(i + 1)));
const LONG_EVENTS = LONG.flatMap((m, i) => [
  ...Array.from({ length: i }, (_, k) => ev(goal(), 'p7', k + 1, { matchId: m.id })),
  ev(MISS, 'p7', 40, { matchId: m.id }),
]);

describe('serie, medias y comparación', () => {
  it('más de diez partidos: solo los diez más recientes, del más antiguo al más reciente', () => {
    const { series, counts } = myEvolution(snapshot(LONG, LONG_EVENTS), 'p7', SEASON);
    expect(SERIES_LIMIT).toBe(10);
    expect(counts.finished).toBe(12);
    expect(series.map((p) => p.matchId)).toEqual(LONG.slice(2).map((m) => m.id));
    expect(series.map((p) => p.counters.shots.goals)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('medias de campo por partido finalizado con convocatoria, con el denominador explícito', () => {
    const { byPosition } = myEvolution(snapshot(LONG, LONG_EVENTS), 'p7', SEASON);
    const field = byPosition.field!;
    // 0+1+…+11 = 66 goles; 66 + 12 fuera = 78 lanzamientos; 12 partidos.
    expect(myAverages(field)).toEqual([
      { key: 'goals', total: 66, denominator: 12, per: 'finished_convocations', value: 5.5 },
      { key: 'attempts', total: 78, denominator: 12, per: 'finished_convocations', value: 6.5 },
      { key: 'recoveries', total: 0, denominator: 12, per: 'finished_convocations', value: 0 },
      { key: 'turnovers', total: 0, denominator: 12, per: 'finished_convocations', value: 0 },
    ]);
    expect(byPosition.goalkeeper).toBeNull();
  });

  it('comparación: últimos 3 frente a toda la temporada, con porcentajes sobre contadores sumados', () => {
    const { comparisons } = myEvolution(snapshot(LONG, LONG_EVENTS), 'p7', SEASON);
    expect(comparisons).toHaveLength(1);
    const [c] = comparisons;
    expect(c!.position).toBe('field');
    expect(c!.recent.matches).toBe(RECENT_MATCHES);
    // Últimos 3: 9+10+11 = 30 goles de 33 lanzamientos (no la media de 90 %, 90,9 % y 91,7 %).
    expect(c!.recent.counters.shots).toMatchObject({ goals: 30, attempts: 33 });
    expect(myRate(c!.recent)).toBe(efficiency({ goals: 30, out: 3, saved: 0, attempts: 33 }));
    expect(c!.season).toEqual(myEvolution(snapshot(LONG, LONG_EVENTS), 'p7', SEASON).byPosition.field);
    expect(c!.season.matches).toBe(12);
    expect(myAverages(c!.recent)[0]).toMatchObject({ total: 30, denominator: 3, value: 10 });
  });

  it('menos de seis partidos finalizados con convocatoria: sin comparación (aunque haya convocatorias en juego)', () => {
    const five = LONG.slice(0, RECENT_MIN_MATCHES - 1);
    const live = makeMatch({ id: 'vivo', date: day(28), status: 'in_progress' });
    const evo = myEvolution(snapshot([...five, live], [...LONG_EVENTS, ev(goal(), 'p7', 1, { matchId: 'vivo' })]), 'p7', SEASON);
    expect(evo.counts).toMatchObject({ convocations: 6, finished: 5 });
    expect(evo.comparisons).toEqual([]);
    expect(evo.series).toHaveLength(5);
    // Con seis, sí.
    expect(myEvolution(snapshot(LONG.slice(0, RECENT_MIN_MATCHES), LONG_EVENTS), 'p7', SEASON).comparisons).toHaveLength(1);
  });

  it('medias de portero por partido con lanzamientos entre palos; recuperaciones por convocatoria', () => {
    const k = [finished('k1', day(1)), finished('k2', day(2)), finished('k3', day(3))];
    const events = [
      ev(SAVE, 'g1', 1, { matchId: 'k1' }),
      ev(SAVE, 'g1', 2, { matchId: 'k1' }),
      ev(CONCEDED, 'g1', 3, { matchId: 'k1' }),
      ev(SAVE, 'g1', 4, { matchId: 'k3' }),
      ev(CONCEDED, 'g1', 5, { matchId: 'k3' }),
      ev(GK_OUT, 'g1', 6, { matchId: 'k3' }),
      ev({ kind: 'recovery' }, 'g1', 7, { matchId: 'k2' }),
    ];
    const gk = myEvolution(snapshot(k, events), 'g1', SEASON).byPosition.goalkeeper!;
    expect(gk).toMatchObject({ matches: 3, withActions: 3, withShotsOnTarget: 2 });
    expect(myAverages(gk)).toEqual([
      { key: 'saves', total: 3, denominator: 2, per: 'finished_with_shots_on_target', value: 1.5 },
      { key: 'goalsConceded', total: 2, denominator: 2, per: 'finished_with_shots_on_target', value: 1 },
      { key: 'onTarget', total: 5, denominator: 2, per: 'finished_with_shots_on_target', value: 2.5 },
      { key: 'recoveries', total: 1, denominator: 3, per: 'finished_convocations', value: 1 / 3 },
    ]);
    // % de paradas sobre la suma (3 de 5), no la media de los partidos (66,7 % y 50 %).
    expect(myRate(gk)).toBe(savePct({ goals: 2, saves: 3, out: 1, received: 6 }));
    expect(myRate(gk)).toBe(60);
  });

  it('portero sin lanzamientos recibidos en ningún partido: medias de portería sin dato (nunca 0)', () => {
    const gk = myEvolution(snapshot([finished('k1', day(1))], []), 'g1', SEASON).byPosition.goalkeeper!;
    expect(myAverages(gk).slice(0, 3).map((a) => [a.denominator, a.value])).toEqual([
      [0, null],
      [0, null],
      [0, null],
    ]);
    expect(myRate(gk)).toBeNull();
  });

  it('cambio de posición: cada partido con la suya y acumulados y comparaciones por separado', () => {
    // p7: 6 partidos de campo y 2 como portero.
    const matches = [
      ...LONG.slice(0, 6),
      finished('pk1', day(20), { squad: asKeeper(SQUAD, 'p7') }),
      finished('pk2', day(21), { squad: asKeeper(SQUAD, 'p7') }),
    ];
    const events = [...LONG_EVENTS, ev(SAVE, 'p7', 1, { matchId: 'pk1' }), ev(CONCEDED, 'p7', 2, { matchId: 'pk1' })];
    const evo = myEvolution(snapshot(matches, events), 'p7', SEASON);
    expect(evo.mixedPositions).toBe(true);
    expect(evo.series.map((p) => p.position)).toEqual(['field', 'field', 'field', 'field', 'field', 'field', 'goalkeeper', 'goalkeeper']);
    expect(evo.byPosition.field).toMatchObject({ matches: 6 });
    expect(evo.byPosition.goalkeeper).toMatchObject({ matches: 2, withShotsOnTarget: 1 });
    expect(evo.byPosition.goalkeeper!.counters.gk).toMatchObject({ saves: 1, goals: 1 });
    // Los goles de campo no se mezclan con la portería.
    expect(evo.byPosition.goalkeeper!.counters.shots.goals).toBe(0);
    // Solo la posición con seis partidos tiene comparación.
    expect(evo.comparisons.map((c) => c.position)).toEqual(['field']);
    expect(evo.counts).toMatchObject({ finished: 8, finishedWithShotsOnTarget: 1 });
  });
});

describe('media principal del resumen', () => {
  it('campo: goles por convocatoria en partido finalizado, sin el partido en juego', () => {
    const live = makeMatch({ id: 'vivo', date: day(28), status: 'in_progress' });
    const evo = myEvolution(snapshot([...LONG.slice(0, 4), live], [...LONG_EVENTS, ev(goal(), 'p7', 1, { matchId: 'vivo' })]), 'p7', SEASON);
    // 0+1+2+3 = 6 goles en 4 finalizados; el gol del partido en juego no entra en la media.
    expect(mainAverage(evo, 'field')).toEqual({ key: 'goals', total: 6, denominator: 4, per: 'finished_convocations', value: 1.5 });
    expect(evo.counts.convocations).toBe(5);
  });

  it('portero: paradas por partido con lanzamientos entre palos; sin ellos, sin media (no 0)', () => {
    const k = [finished('k1', day(1)), finished('k2', day(2))];
    const withShots = myEvolution(snapshot(k, [ev(SAVE, 'g1', 1, { matchId: 'k1' }), ev(SAVE, 'g1', 2, { matchId: 'k1' })]), 'g1', SEASON);
    expect(mainAverage(withShots, 'goalkeeper')).toMatchObject({ key: 'saves', total: 2, denominator: 1, value: 2 });
    const without = myEvolution(snapshot(k, []), 'g1', SEASON);
    expect(mainAverage(without, 'goalkeeper')).toMatchObject({ denominator: 0, value: null });
  });

  it('sin partidos finalizados en la posición: sin media', () => {
    const live = makeMatch({ id: 'vivo', date: day(28), status: 'in_progress' });
    expect(mainAverage(myEvolution(snapshot([live], []), 'p7', SEASON), 'field')).toBeNull();
    expect(mainAverage(myEvolution(snapshot([], []), 'p7', SEASON), 'goalkeeper')).toBeNull();
  });

  it('posición mixta: la media de cada posición solo con sus partidos, y cuántos son de la otra', () => {
    const matches = [...LONG.slice(0, 3), finished('pk1', day(20), { squad: asKeeper(SQUAD, 'p7') })];
    // Un gol como portero (pk1) no entra en la media de campo.
    const events = [...LONG_EVENTS, ev(goal(), 'p7', 1, { matchId: 'pk1' }), ev(SAVE, 'p7', 2, { matchId: 'pk1' })];
    const evo = myEvolution(snapshot(matches, events), 'p7', SEASON);
    expect(mainAverage(evo, 'field')).toMatchObject({ total: 3, denominator: 3, value: 1 });
    expect(mainAverage(evo, 'goalkeeper')).toMatchObject({ total: 1, denominator: 1, value: 1 });
    expect(otherPositionMatches(evo, 'field')).toBe(1);
    expect(otherPositionMatches(evo, 'goalkeeper')).toBe(3);
    expect(otherPositionMatches(myEvolution(snapshot(LONG.slice(0, 3), LONG_EVENTS), 'p7', SEASON), 'field')).toBe(0);
  });
});

describe('forma reciente frente a temporada', () => {
  const keeperGames = (n: number, withShots: (k: number) => boolean) => {
    const matches = Array.from({ length: n }, (_, i) => finished(`g${String(i + 1).padStart(2, '0')}`, day(i + 1)));
    const events = matches.flatMap((m, i) =>
      withShots(i + 1) ? [ev(SAVE, 'g1', 1, { matchId: m.id }), ev(SAVE, 'g1', 2, { matchId: m.id }), ev(CONCEDED, 'g1', 3, { matchId: m.id })] : [],
    );
    return snapshot(matches, events);
  };

  it('cinco partidos: sin comparación; seis: con ella', () => {
    expect(myEvolution(snapshot(LONG.slice(0, 5), LONG_EVENTS), 'p7', SEASON).comparisons).toEqual([]);
    const [c] = myEvolution(snapshot(LONG.slice(0, 6), LONG_EVENTS), 'p7', SEASON).comparisons;
    // Goles 0…5: últimos 3 = 3+4+5 = 12 en 3; temporada = 15 en 6.
    expect(comparisonAverages(c!)).toEqual({
      recent: { key: 'goals', total: 12, denominator: 3, per: 'finished_convocations', value: 4 },
      season: { key: 'goals', total: 15, denominator: 6, per: 'finished_convocations', value: 2.5 },
    });
    expect(c!.recentDates).toEqual({ from: day(4), to: day(6) });
  });

  it('más de diez partidos: los tres últimos frente a todos (no solo los diez de la gráfica)', () => {
    const [c] = myEvolution(snapshot(LONG, LONG_EVENTS), 'p7', SEASON).comparisons;
    expect(comparisonAverages(c!)).toMatchObject({ recent: { total: 30, denominator: 3, value: 10 }, season: { total: 66, denominator: 12, value: 5.5 } });
    expect(c!.recentDates).toEqual({ from: day(10), to: day(12) });
  });

  it('tres últimos sin acciones: siguen contando como convocatorias (media 0 sobre 3)', () => {
    const matches = LONG.slice(0, 6);
    const events = LONG_EVENTS.filter((e) => ['l01', 'l02', 'l03'].includes(e.matchId));
    const [c] = myEvolution(snapshot(matches, events), 'p7', SEASON).comparisons;
    expect(comparisonAverages(c!)).toMatchObject({ recent: { total: 0, denominator: 3, value: 0 }, season: { total: 3, denominator: 6, value: 0.5 } });
  });

  it('el partido en juego no entra en la comparación', () => {
    const live = makeMatch({ id: 'vivo', date: day(28), status: 'in_progress' });
    const extra = Array.from({ length: 9 }, (_, k) => ev(goal(), 'p7', k + 1, { matchId: 'vivo' }));
    const [c] = myEvolution(snapshot([...LONG.slice(0, 6), live], [...LONG_EVENTS, ...extra]), 'p7', SEASON).comparisons;
    expect(comparisonAverages(c!).recent).toMatchObject({ total: 12, denominator: 3 });
    expect(c!.recentDates.to).toBe(day(6));
  });

  it('portero: medias por partido con lanzamientos entre palos; los recientes, con cuántos tienen', () => {
    // Lanzamientos entre palos en los partidos 1, 2, 3, 4 y 6 (no en 5 ni 7): 2 paradas en cada uno.
    const [c] = myEvolution(keeperGames(7, (k) => k !== 5 && k !== 7), 'g1', SEASON).comparisons;
    expect(c!.position).toBe('goalkeeper');
    expect(comparisonAverages(c!)).toMatchObject({
      recent: { key: 'saves', total: 2, denominator: 1, per: 'finished_with_shots_on_target', value: 2 },
      season: { key: 'saves', total: 10, denominator: 5, value: 2 },
    });
    expect(c!.recent.matches).toBe(3);
  });

  it('portero sin lanzamientos entre palos en los tres últimos: sin media reciente (nunca 0)', () => {
    const [c] = myEvolution(keeperGames(6, (k) => k <= 3), 'g1', SEASON).comparisons;
    expect(comparisonAverages(c!).recent).toMatchObject({ total: 0, denominator: 0, value: null });
    expect(comparisonAverages(c!).season).toMatchObject({ denominator: 3, value: 2 });
  });

  it('portero sin ningún partido válido en la temporada: ninguna media', () => {
    const [c] = myEvolution(keeperGames(6, () => false), 'g1', SEASON).comparisons;
    expect(comparisonAverages(c!)).toMatchObject({ recent: { value: null }, season: { denominator: 0, value: null } });
  });

  it('posiciones mixtas: una comparación por posición con seis partidos en ella, sin mezclar', () => {
    // p7: seis de campo y seis de portero.
    const keeper = Array.from({ length: 6 }, (_, i) => finished(`pk${i + 1}`, day(20 + i), { squad: asKeeper(SQUAD, 'p7') }));
    const events = [...LONG_EVENTS, ...keeper.flatMap((m) => [ev(SAVE, 'p7', 1, { matchId: m.id }), ev(goal(), 'p7', 2, { matchId: m.id })])];
    const evo = myEvolution(snapshot([...LONG.slice(0, 6), ...keeper], events), 'p7', SEASON);
    expect(evo.comparisons.map((c) => c.position)).toEqual(['field', 'goalkeeper']);
    const [field, gk] = evo.comparisons.map(comparisonAverages);
    // Los goles marcados como portero no entran en la media de campo.
    expect(field).toMatchObject({ recent: { total: 12, denominator: 3 }, season: { total: 15, denominator: 6 } });
    expect(gk).toMatchObject({ recent: { key: 'saves', total: 3, denominator: 3 }, season: { total: 6, denominator: 6 } });
    // Con solo cinco como portero, solo la de campo.
    expect(myEvolution(snapshot([...LONG.slice(0, 6), ...keeper.slice(0, 5)], events), 'p7', SEASON).comparisons.map((c) => c.position)).toEqual(['field']);
  });
});
