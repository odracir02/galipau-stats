import { describe, expect, it } from 'vitest';
import { ev, makeMatch, SQUAD } from '../test/fixtures';
import type { MatchEvent } from '../domain/types';
import { actionAfterDisqualification, availableForNewActions, disqualifications, redCards } from './discipline';
import { computeMatchStats, computeSeasonStats, sanctions } from './engine';

const exclusion = (player: string | null, minute: number, opts = {}) => ev({ kind: 'exclusion' }, player, minute, opts);
const red = (player: string | null, minute: number) => ev({ kind: 'red' }, player, minute);
const stats = (events: MatchEvent[]) => computeMatchStats(makeMatch(), events);

describe('roja por acumulación de exclusiones', () => {
  it('primera y segunda exclusión no generan roja', () => {
    const s = stats([exclusion('p7', 5), exclusion('p7', 12)]);
    const p = s.players.get('p7')!;
    expect(p.exclusions).toBe(2);
    expect(p.reds).toBe(0);
    expect(disqualifications([exclusion('p7', 5), exclusion('p7', 12)]).size).toBe(0);
  });

  it('la tercera exclusión genera una roja por acumulación, sin evento manual', () => {
    const events = [exclusion('p7', 5), exclusion('p7', 12), exclusion('p7', 40)];
    const p = stats(events).players.get('p7')!;
    expect(p.exclusions).toBe(3);
    expect(p).toMatchObject({ reds: 1, redsAccumulated: 1, redsDirect: 0 });
    expect(sanctions(p)).toBe(4);
    expect(events.filter((e) => e.kind === 'red')).toHaveLength(0);
    const card = disqualifications(events).get('p7')!;
    expect(card).toMatchObject({ type: 'accumulated', triggerEventId: events[2]!.id });
  });

  it('el orden cuenta por minuto de partido, no por orden de registro', () => {
    // La tercera registrada es una exclusión olvidada del minuto 3: la que provoca la roja es la del 12.
    const events = [exclusion('p7', 5), exclusion('p7', 12), exclusion('p7', 3)];
    expect(disqualifications(events).get('p7')!.triggerEventId).toBe(events[1]!.id);
  });

  it('una cuarta exclusión (dato erróneo) no genera una segunda roja', () => {
    const p = stats([exclusion('p7', 5), exclusion('p7', 12), exclusion('p7', 40), exclusion('p7', 50)]).players.get(
      'p7',
    )!;
    expect(p.exclusions).toBe(4);
    expect(p.reds).toBe(1);
  });

  it('se aplica igual a porteros', () => {
    const p = stats([exclusion('g1', 5), exclusion('g1', 12), exclusion('g1', 40)]).players.get('g1')!;
    expect(p).toMatchObject({ exclusions: 3, reds: 1, redsAccumulated: 1 });
  });

  it('las exclusiones de jugadores distintos no se mezclan', () => {
    const s = stats([exclusion('p7', 5), exclusion('p14', 12), exclusion('p7', 40), exclusion('p14', 41)]);
    expect(s.team.reds).toBe(0);
    expect(s.team.exclusions).toBe(4);
  });
});

describe('roja directa', () => {
  it('cuenta sin exclusiones previas', () => {
    const p = stats([red('p14', 20)]).players.get('p14')!;
    expect(p).toMatchObject({ reds: 1, redsDirect: 1, redsAccumulated: 0, exclusions: 0 });
    expect(disqualifications([red('p14', 20)]).get('p14')!.type).toBe('direct');
  });

  it('una roja directa tras la tercera exclusión no duplica la tarjeta', () => {
    const p = stats([exclusion('p7', 5), exclusion('p7', 12), exclusion('p7', 40), red('p7', 40)]).players.get('p7')!;
    expect(p).toMatchObject({ reds: 1, redsAccumulated: 1, redsDirect: 0 });
  });

  it('una roja directa anterior manda: exclusiones posteriores no añaden otra', () => {
    const p = stats([exclusion('p7', 5), red('p7', 10), exclusion('p7', 12), exclusion('p7', 40)]).players.get('p7')!;
    expect(p).toMatchObject({ reds: 1, redsDirect: 1, redsAccumulated: 0 });
  });

  it('las rojas pendientes de atribución cuentan en el equipo', () => {
    const s = stats([red(null, 10), red('p7', 20)]);
    expect(s.team).toMatchObject({ reds: 2, redsDirect: 2 });
    expect(redCards([red(null, 10)])).toHaveLength(1);
  });

  it('las exclusiones pendientes no acumulan roja de nadie', () => {
    expect(stats([exclusion(null, 1), exclusion(null, 2), exclusion(null, 3)]).team.reds).toBe(0);
  });
});

describe('equipo, intervalos y temporada', () => {
  it('el total del equipo suma rojas directas y por acumulación', () => {
    const s = stats([exclusion('p7', 5), exclusion('p7', 12), exclusion('p7', 40), red('p14', 20)]);
    expect(s.team).toMatchObject({ reds: 2, redsDirect: 1, redsAccumulated: 1, exclusions: 3 });
    expect(sanctions(s.team)).toBe(5);
  });

  it('la roja por acumulación cae en el intervalo de la tercera exclusión', () => {
    const s = stats([exclusion('p7', 5), exclusion('p7', 12), exclusion('p7', 41)]);
    expect(s.intervals[8]!.counters.reds).toBe(1);
    expect(s.intervals.reduce((n, iv) => n + iv.counters.reds, 0)).toBe(1);
  });

  it('la temporada suma las rojas de cada partido', () => {
    const m2 = makeMatch({ id: 'm2', date: '2026-11-01' });
    const season = computeSeasonStats([
      { match: makeMatch(), events: [exclusion('p7', 5), exclusion('p7', 12), exclusion('p7', 40)] },
      { match: m2, events: [ev({ kind: 'red' }, 'p7', 3, { matchId: 'm2' })] },
    ]);
    expect(season.players.get('p7')!.counters).toMatchObject({ reds: 2, redsAccumulated: 1, redsDirect: 1 });
  });
});

describe('disponibilidad en directo', () => {
  it('el descalificado deja de estar disponible pero sigue en la convocatoria', () => {
    const events = [exclusion('p7', 5), exclusion('p7', 12), exclusion('p7', 40)];
    const available = availableForNewActions(SQUAD, events);
    expect(available.map((s) => s.playerId)).not.toContain('p7');
    expect(available).toHaveLength(SQUAD.length - 1);
    expect(makeMatch().squad.map((s) => s.playerId)).toContain('p7');
  });

  it('borrar una de las tres exclusiones devuelve la disponibilidad', () => {
    const events = [exclusion('p7', 5), exclusion('p7', 12), exclusion('p7', 40, { deleted: true })];
    expect(availableForNewActions(SQUAD, events).map((s) => s.playerId)).toContain('p7');
    expect(stats(events).players.get('p7')!.reds).toBe(0);
  });
});

describe('advertencia de acción posterior a la expulsión', () => {
  const goalAt = (player: string, minute: number) => ev({ kind: 'shot', shotType: 'nine_m', result: 'goal' }, player, minute);

  it('avisa si la acción es posterior a una roja por tercera exclusión', () => {
    const events = [exclusion('p69', 5), exclusion('p69', 20), exclusion('p69', 42)];
    const card = actionAfterDisqualification(events, goalAt('p69', 47));
    expect(card).toMatchObject({ type: 'accumulated', triggerEventId: events[2]!.id });
  });

  it('avisa si la acción es posterior a una roja directa', () => {
    expect(actionAfterDisqualification([red('p7', 10)], goalAt('p7', 12))?.type).toBe('direct');
  });

  it('no avisa para acciones anteriores ni del mismo instante', () => {
    const events = [red('p7', 10)];
    expect(actionAfterDisqualification(events, goalAt('p7', 8))).toBeNull();
    expect(actionAfterDisqualification(events, goalAt('p7', 10))).toBeNull();
  });

  it('no avisa para jugadores no descalificados ni para pendientes', () => {
    expect(actionAfterDisqualification([red('p7', 10)], goalAt('p14', 50))).toBeNull();
    expect(actionAfterDisqualification([red('p7', 10)], ev({ kind: 'recovery' }, null, 50))).toBeNull();
  });

  it('corregir la propia 3.ª exclusión a un minuto posterior no avisa contra sí misma', () => {
    const events = [exclusion('p7', 5), exclusion('p7', 20), exclusion('p7', 42)];
    const moved = { ...events[2]!, matchTimeMs: 50 * 60_000 };
    expect(actionAfterDisqualification(events, moved)).toBeNull();
  });

  it('mover una exclusión antes de la 3.ª cambia el momento de la expulsión', () => {
    // Con la 3.ª en el 42, un gol en el 45 avisa; si una de ellas pasa a ser posterior al gol, deja de avisar.
    const events = [exclusion('p7', 5), exclusion('p7', 20), exclusion('p7', 42)];
    const goal = goalAt('p7', 45);
    expect(actionAfterDisqualification(events, goal)).not.toBeNull();
    const later = [events[0]!, events[1]!, { ...events[2]!, matchTimeMs: 50 * 60_000 }];
    expect(actionAfterDisqualification(later, goal)).toBeNull();
  });

  it('eliminar la sanción quita la advertencia', () => {
    const events = [exclusion('p7', 5), exclusion('p7', 20), exclusion('p7', 42, { deleted: true })];
    expect(actionAfterDisqualification(events, goalAt('p7', 47))).toBeNull();
  });

  it('una acción corregida que pasa a otro dorsal se evalúa con el nuevo jugador', () => {
    const events = [red('p7', 10)];
    const goal = goalAt('p14', 20);
    expect(actionAfterDisqualification(events, goal)).toBeNull();
    expect(actionAfterDisqualification(events, { ...goal, playerId: 'p7' })).not.toBeNull();
  });

  it('una descalificación no afecta a otro partido', () => {
    const otherMatchEvents: MatchEvent[] = [];
    expect(actionAfterDisqualification(otherMatchEvents, goalAt('p7', 47))).toBeNull();
  });
});
