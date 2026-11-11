// Temporada de «Mi jugador»: mismas cifras que «Temporada» y la ficha completa,
// con las reglas del motor (convocatoria, acciones anuladas, partidos que cuentan).
// Datos sintéticos.
import { describe, expect, it } from 'vitest';
import type { Match, MatchEvent, Player } from '../../domain/types';
import type { TeamSnapshot } from '../../remote/api';
import { seasonItems } from '../../remote/viewer';
import { computeSeasonStats, efficiency, emptyCounters, savePct } from '../../stats/engine';
import { RANKINGS } from '../../stats/rankings';
import { ev, goal, makeMatch, SQUAD } from '../../test/fixtures';
import { liveMatches, matchLine, myRankings, mySeason, recentMatches } from './mySeason';

const player = (id: string): Player => {
  const s = SQUAD.find((x) => x.playerId === id)!;
  return { id, teamId: 't1', name: s.name, number: s.number, position: s.position, active: true, createdAt: 'a', updatedAt: 'a' };
};
const official = { playerId: 'oficial-head-t1', name: 'Entrenador', number: 0, position: 'field' as const, role: 'official' as const };

function snapshot(matches: Match[], events: MatchEvent[]): TeamSnapshot {
  return {
    team: { id: 't1', name: 'Infantil Masculino A', code: 'IMA2627', season: '2026/27' },
    club: { id: 'c', name: 'Club' },
    seq: 1,
    players: SQUAD.map((s) => ({ version: 1, player: player(s.playerId) })),
    matches: matches.map((match) => ({ version: 1, match, recordedHere: false })),
    events: events.map((event) => ({ version: 1, event })),
  };
}

const finished = (id: string, date: string, extra: Partial<Match> = {}) =>
  makeMatch({ id, date, status: 'finished', squad: [...SQUAD, official], ...extra });

// Tres partidos finalizados, uno en juego, uno creado sin empezar, uno borrado y otro de la temporada anterior.
const M1 = finished('m1', '2026-10-04');
const M2 = finished('m2', '2026-10-11', { squad: SQUAD.filter((s) => s.playerId !== 'p14') });
const M3 = finished('m3', '2026-10-18');
const LIVE = makeMatch({ id: 'm4', date: '2026-10-25', status: 'in_progress' });
const READY = makeMatch({ id: 'm5', date: '2026-11-01', status: 'ready' });
const DELETED = finished('m6', '2026-10-20', { deletedAt: '2026-10-21T10:00:00.000Z' });
const OLD = finished('m0', '2025-10-01', { season: '2025/26' });
const EVENTS = [
  ev(goal(), 'p7', 1, { matchId: 'm1' }),
  ev(goal('penalty'), 'p7', 2, { matchId: 'm1' }),
  ev({ kind: 'shot', shotType: 'penalty', result: 'saved' }, 'p7', 3, { matchId: 'm1' }),
  ev({ kind: 'shot', shotType: 'nine_m', result: 'out' }, 'p7', 4, { matchId: 'm2' }),
  ev(goal(), 'p7', 5, { matchId: 'm2', deleted: true }), // anulada: no cuenta
  ev({ kind: 'recovery' }, 'p7', 6, { matchId: 'm3' }),
  ev(goal('fast_break'), 'p7', 7, { matchId: 'm4' }), // en juego: cuenta, como en «Temporada»
  ev(goal(), 'p7', 8, { matchId: 'm6' }), // partido borrado: no cuenta
  ev(goal(), 'p7', 9, { matchId: 'm0' }), // otra temporada
  ev({ kind: 'gk_shot', shotType: 'nine_m', result: 'save' }, 'g1', 10, { matchId: 'm1' }),
  ev({ kind: 'gk_shot', shotType: 'penalty', result: 'save' }, 'g1', 11, { matchId: 'm1' }),
  ev({ kind: 'gk_shot', shotType: 'penalty', result: 'goal' }, 'g1', 12, { matchId: 'm3' }),
  ev({ kind: 'gk_shot', shotType: 'six_m', result: 'out' }, 'g1', 13, { matchId: 'm3' }),
  ev({ kind: 'yellow' }, 'oficial-head-t1', 14, { matchId: 'm1' }),
];
const SNAP = snapshot([M1, M2, M3, LIVE, READY, DELETED, OLD], EVENTS);

describe('temporada de «Mi jugador»', () => {
  it('jugador de campo: partidos con convocatoria, goles, eficacia y penaltis; sin anuladas, borrados ni otra temporada', () => {
    const s = mySeason(SNAP, player('p7'), '2026/27');
    // m1, m2, m3 (finalizados) y m4 (en juego). m5 (sin empezar y sin acciones), m6 (borrado) y m0 (otra temporada), no.
    expect(s).toMatchObject({ matches: 4, finished: 3, live: 1 });
    const c = s.row.counters;
    expect(c.shots).toEqual({ goals: 3, out: 1, saved: 1, attempts: 5 });
    expect(c.shotsByType.penalty).toEqual({ goals: 1, out: 0, saved: 1, attempts: 2 });
    expect(c.shotsByType.fast_break.goals).toBe(1);
    expect(c.recoveries).toBe(1);
    expect(efficiency(c.shots)).toBe(60);
  });

  it('portero: paradas, goles encajados, recibidos y penaltis parados con las reglas del motor', () => {
    const s = mySeason(SNAP, player('g1'), '2026/27');
    expect(s.row.position).toBe('goalkeeper');
    expect(s.row.counters.gk).toEqual({ goals: 1, saves: 2, out: 1, received: 4 });
    expect(s.row.counters.gkByType.penalty).toEqual({ goals: 1, saves: 1, out: 0, received: 2 });
    // % paradas = paradas / (paradas + goles): los fuera no cuentan.
    expect(savePct(s.row.counters.gk)).toBeCloseTo(66.67, 1);
  });

  it('las mismas cifras que «Temporada» (y la ficha completa, que usa esta misma fila)', () => {
    const season = computeSeasonStats(seasonItems(SNAP).filter((i) => i.match.season === '2026/27'));
    for (const id of ['p7', 'p14', 'p69', 'g1', 'g12']) {
      const p = season.players.get(id)!;
      expect(mySeason(SNAP, player(id), '2026/27').row).toEqual({ ...p.latest, matches: p.matches, counters: p.counters });
    }
  });

  it('convocado sin acciones: cuenta el partido, todo a cero y porcentajes sin datos (nunca 0 %)', () => {
    const s = mySeason(SNAP, player('p69'), '2026/27');
    expect(s.matches).toBe(4);
    expect(s.row.counters.shots.attempts).toBe(0);
    expect(efficiency(s.row.counters.shots)).toBeNull();
    const keeper = mySeason(SNAP, player('g12'), '2026/27');
    expect(savePct(keeper.row.counters.gk)).toBeNull();
  });

  it('no convocado en un partido: ese partido no le cuenta', () => {
    expect(mySeason(SNAP, player('p14'), '2026/27')).toMatchObject({ matches: 3, finished: 2, live: 1 });
  });

  it('sin partidos (equipo nuevo, otra temporada o fuera de toda convocatoria): fila a cero con sus datos', () => {
    const empty = mySeason(snapshot([], []), player('p7'), '2026/27');
    expect(empty).toMatchObject({ matches: 0, finished: 0, live: 0 });
    expect(empty.row).toMatchObject({ playerId: 'p7', name: 'Jugador Siete', number: 7, position: 'field', matches: 0 });
    expect(mySeason(SNAP, player('p7'), '2027/28').matches).toBe(0);
  });

  it('el cuerpo técnico nunca suma como jugador', () => {
    const s = mySeason(SNAP, { id: 'oficial-head-t1', name: 'Entrenador', number: 0, position: 'field' }, '2026/27');
    expect(s.matches).toBe(0);
    expect(s.row.counters.yellows).toBe(0);
  });

  it('llegan cambios del equipo (directo o «Actualizar»): las cifras se recalculan con los datos nuevos', () => {
    const before = mySeason(SNAP, player('p7'), '2026/27');
    const more = snapshot([M1, M2, M3, { ...LIVE, status: 'finished' }, READY, DELETED, OLD], [...EVENTS, ev(goal(), 'p7', 20, { matchId: 'm4' })]);
    const after = mySeason(more, player('p7'), '2026/27');
    expect(after.row.counters.shots.goals).toBe(before.row.counters.shots.goals + 1);
    expect(after).toMatchObject({ matches: 4, finished: 4, live: 0 });
  });
});

describe('rankings de «Mi jugador»', () => {
  it('jugador de campo: su puesto en las positivas; la de porcentaje sin el mínimo, sin puesto (no se inventa)', () => {
    const r = myRankings(SNAP, 'p7', 'field', '2026/27');
    expect(r.map((x) => [x.def.id, x.entry?.position ?? null, x.inTop])).toEqual([
      ['top_scorer', 1, true],
      ['sharpshooter', null, false], // 5 lanzamientos: mínimo 10
      ['shots', 1, true],
      ['thief', 1, true],
      // 7 metros: 1 de 2 (mínimo 5), no entra ni se muestra; contraataque: 1 gol, primero.
      ['speedster', 1, true],
    ]);
    expect(r[0]!.entry).toMatchObject({ value: 3 });
  });

  it('portero: «El muro» (aún sin el mínimo) y solo las demás en las que entra', () => {
    // 1 penalti parado: primero en «El cerrojo de 7 metros».
    expect(myRankings(SNAP, 'g1', 'goalkeeper', '2026/27').map((x) => [x.def.id, x.entry?.position ?? null, x.entry?.value ?? null])).toEqual([
      ['wall', null, null],
      ['penalty_stopper', 1, 1],
    ]);
  });

  it('sin acciones: sin puesto en ninguna; sin partidos, ninguna clasificación', () => {
    expect(myRankings(SNAP, 'p69', 'field', '2026/27').every((x) => x.entry === null)).toBe(true);
    expect(myRankings(snapshot([], []), 'p7', 'field', '2026/27')).toEqual([]);
  });

  it('fuera del Top 10: su puesto real, sin datos de quienes están por debajo del décimo', () => {
    const squad = Array.from({ length: 12 }, (_, i) => ({ playerId: `j${i + 1}`, name: `Jugador ${i + 1}`, number: i + 1, position: 'field' as const }));
    const m = makeMatch({ id: 'mt', status: 'finished', squad });
    const events = squad.flatMap((s, i) => Array.from({ length: 12 - i }, (_, k) => ev(goal(), s.playerId, k + 1, { matchId: 'mt' })));
    const r = myRankings(snapshot([m], events), 'j12', 'field', '2026/27');
    const scorer = r.find((x) => x.def.id === 'top_scorer')!;
    expect(scorer).toMatchObject({ ranked: 12, inTop: false, entry: { position: 12, value: 1 } });
    // Solo su fila: nada de los demás jugadores.
    expect(scorer.entry!.player.playerId).toBe('j12');
    expect(Object.keys(scorer)).toEqual(['def', 'entry', 'ranked', 'inTop']);
  });

  it('nunca destaca clasificaciones negativas (exclusiones, pérdidas)', () => {
    const negative = RANKINGS.filter((d) => d.id === 'repeat_offender' || d.id === 'generous').map((d) => d.id);
    const withNegative = snapshot([M1], [ev({ kind: 'exclusion' }, 'p7', 1), ev({ kind: 'turnover', turnoverType: 'general' }, 'p7', 2)]);
    for (const pos of ['field', 'goalkeeper'] as const) {
      expect(myRankings(withNegative, 'p7', pos, '2026/27').some((x) => negative.includes(x.def.id))).toBe(false);
    }
  });
});

describe('partidos de «Mi jugador»', () => {
  it('últimos partidos: finalizados con convocatoria, del más reciente; sin borrados, preparados ni en juego', () => {
    expect(recentMatches(SNAP, 'p7', '2026/27').map((m) => m.match.id)).toEqual(['m3', 'm2', 'm1']);
    // El 14 no está convocado en m2: no se cuenta ese partido.
    expect(recentMatches(SNAP, 'p14', '2026/27').map((m) => m.match.id)).toEqual(['m3', 'm1']);
  });

  it('solo los de la temporada del equipo: un partido de otra temporada nunca aparece', () => {
    expect(recentMatches(SNAP, 'p14', '2026/27').some((m) => m.match.season !== '2026/27')).toBe(false);
    expect(recentMatches(SNAP, 'p7', '2025/26').map((m) => m.match.id)).toEqual(['m0']);
  });

  it('sus cifras de cada partido: solo sus acciones, sin anuladas ni las de compañeros o sin asignar', () => {
    const withPending = snapshot([M1, M2, M3], [...EVENTS, ev(goal(), null, 30, { matchId: 'm1' }), ev(goal(), 'p14', 31, { matchId: 'm1' })]);
    const [m3, m2, m1] = recentMatches(withPending, 'p7', '2026/27');
    expect(matchLine(m1!.counters!, 'field')).toBe('2 goles de 3 lanzamientos');
    expect(matchLine(m2!.counters!, 'field')).toBe('0 goles de 1 lanzamiento'); // el gol anulado no cuenta
    expect(matchLine(m3!.counters!, 'field')).toBe('1 recuperación');
    expect(m1!.score.own).toBe(4); // el marcador sí incluye todo el equipo
  });

  it('portero y sin acciones: paradas entre palos, sin porcentajes; sin acciones, nada', () => {
    const [m3, m1] = recentMatches(SNAP, 'g1', '2026/27').filter((m) => m.match.id !== 'm2');
    expect(matchLine(m1!.counters!, 'goalkeeper')).toBe('2 paradas de 2 entre palos');
    expect(matchLine(m3!.counters!, 'goalkeeper')).toBe('0 paradas de 1 entre palos');
    const onlyOut = emptyCounters();
    onlyOut.gk = { goals: 0, saves: 0, out: 2, received: 2 };
    expect(matchLine(onlyOut, 'goalkeeper')).toBe('2 lanzamientos fuera');
    expect(matchLine(emptyCounters(), 'field')).toBeNull();
  });

  it('en directo: en curso y en el descanso; convocado con sus cifras o «no convocado» sin inventar nada', () => {
    expect(liveMatches(SNAP, 'p7').map((m) => [m.match.id, matchLine(m.counters!, m.position!)])).toEqual([['m4', '1 gol de 1 lanzamiento']]);
    const half = { ...LIVE, status: 'halftime' as const, squad: SQUAD.filter((s) => s.playerId !== 'p69') };
    const s = snapshot([M1, half], EVENTS);
    expect(liveMatches(s, 'p7').map((m) => m.match.status)).toEqual(['halftime']);
    expect(liveMatches(s, 'p69')).toMatchObject([{ counters: null, position: null }]);
    expect(liveMatches(snapshot([M1, { ...LIVE, status: 'finished' }], EVENTS), 'p7')).toEqual([]);
  });
});
