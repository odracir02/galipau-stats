import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { MINUTE_MS } from '../clock/clock';
import { IndexedDbRepository } from '../data/indexedDbRepository';
import type { ClockState, Match, MatchEvent, Team } from '../domain/types';
import {
  createMatch,
  currentTiming,
  deleteEvent,
  finishMatch,
  recordEvent,
  setAddsToPrevious,
  startHalftime,
  toggleClock,
  undoLast,
  updateEvent,
} from '../services/matchService';
import { createTeam, savePlayer } from '../services/teamService';
import { ev, makeMatch } from '../test/fixtures';
import { computeMatchStats } from './engine';
import { activeReductions, additionalCandidates, REDUCTION_MS, servedMs, teamReductions } from './exclusions';

const exclusion = { kind: 'exclusion' } as const;
const S = 1000;
/** Reloj parado en un minuto concreto de una parte. */
const stopped = (period: 1 | 2, timeMs: number, extra: Partial<ClockState> = {}): ClockState => ({
  period,
  running: false,
  baseMs: timeMs,
  anchorWallMs: null,
  ...extra,
});
const at = (minute: number, seconds = 0) => minute * MINUTE_MS + seconds * S;
const remaining = (match: Match, events: MatchEvent[], now = 0) =>
  activeReductions(match, events, now).map((x) => [x.playerId, x.remainingMs]);

describe('exclusiones activas: cálculo', () => {
  it('cuenta atrás de 2:00 con el tiempo oficial del partido y desaparece al llegar a cero', () => {
    const e = ev(exclusion, 'p7', 10);
    expect(remaining(makeMatch({ clock: stopped(1, at(10)) }), [e])).toEqual([['p7', REDUCTION_MS]]);
    expect(remaining(makeMatch({ clock: stopped(1, at(11, 15)) }), [e])).toEqual([['p7', 45 * S]]);
    expect(remaining(makeMatch({ clock: stopped(1, at(11, 59)) }), [e])).toEqual([['p7', 1 * S]]);
    expect(remaining(makeMatch({ clock: stopped(1, at(12)) }), [e])).toEqual([]);
    // La sanción sigue en el historial: solo deja de estar «activa».
    expect(e.deletedAt).toBeNull();
  });

  it('con el reloj en marcha avanza con el tiempo real; parado, se congela', () => {
    const running: ClockState = { period: 1, running: true, baseMs: at(10), anchorWallMs: 1_000_000 };
    const match = makeMatch({ clock: running });
    const e = ev(exclusion, 'p7', 10);
    expect(remaining(match, [e], 1_000_000 + 30 * S)).toEqual([['p7', 90 * S]]);
    // Pausado en 10:30: por mucho tiempo real que pase, quedan 1:30.
    const paused = makeMatch({ clock: stopped(1, at(10, 30)) });
    expect(remaining(paused, [e], 9_999_999_999)).toEqual([['p7', 90 * S]]);
  });

  it('varias exclusiones simultáneas, ordenadas por la que antes termina', () => {
    const events = [ev(exclusion, 'p7', 10), ev(exclusion, 'p14', 11), ev(exclusion, null, 11)];
    const match = makeMatch({ clock: stopped(1, at(11, 30)) });
    expect(remaining(match, events)).toEqual([
      ['p7', 30 * S],
      ['p14', 90 * S],
      [null, 90 * S],
    ]);
  });

  it('exclusiones consecutivas del mismo jugador: cada una cuenta sus propios dos minutos', () => {
    const events = [ev(exclusion, 'p7', 10), ev(exclusion, 'p7', 11)];
    expect(remaining(makeMatch({ clock: stopped(1, at(11, 30)) }), events)).toEqual([
      ['p7', 30 * S],
      ['p7', 90 * S],
    ]);
    expect(remaining(makeMatch({ clock: stopped(1, at(12, 30)) }), events)).toEqual([['p7', 30 * S]]);
  });

  it('a través del descanso: suma lo cumplido al final de la 1.ª parte, hasta donde llegó el reloj', () => {
    // Exclusión a 29:30; la 1.ª parte terminó en 30:20 (50 s cumplidos). Quedan 1:10 al empezar la 2.ª.
    const e = ev(exclusion, 'p7', 0, { period: 1 });
    const excl = { ...e, matchTimeMs: at(29, 30) };
    const halftime = makeMatch({ status: 'halftime', clock: stopped(1, at(30, 20)) });
    expect(remaining(halftime, [excl])).toEqual([['p7', 70 * S]]);
    const secondHalf = makeMatch({ clock: stopped(2, at(30), { firstHalfEndMs: at(30, 20) }) });
    expect(remaining(secondHalf, [excl])).toEqual([['p7', 70 * S]]);
    const later = makeMatch({ clock: stopped(2, at(31, 10), { firstHalfEndMs: at(30, 20) }) });
    expect(remaining(later, [excl])).toEqual([]);
  });

  it('partido anterior a este dato: usa el final nominal de la 1.ª parte, sin inventar nada', () => {
    const excl = { ...ev(exclusion, 'p7', 0, { period: 1 }), matchTimeMs: at(29, 30) };
    // Sin firstHalfEndMs: 30 s cumplidos en la 1.ª parte (hasta 30:00).
    const match = makeMatch({ clock: stopped(2, at(30)) });
    expect(remaining(match, [excl])).toEqual([['p7', 90 * S]]);
  });

  it('una exclusión registrada en un momento posterior al reloj no está activa', () => {
    const e = ev(exclusion, 'p7', 20);
    expect(remaining(makeMatch({ clock: stopped(1, at(15)) }), [e])).toEqual([]);
    expect(servedMs({ period: 2, matchTimeMs: at(31) }, { period: 1, timeMs: at(20) }, makeMatch())).toBeLessThan(0);
  });

  it('borrada o corregida a otra acción, deja de contar; otras acciones no cuentan', () => {
    const e = ev(exclusion, 'p7', 10);
    const match = makeMatch({ clock: stopped(1, at(10, 30)) });
    expect(remaining(match, [{ ...e, deletedAt: e.createdAt }])).toEqual([]);
    expect(remaining(match, [ev({ kind: 'yellow' }, 'p7', 10), ev({ kind: 'penalty_committed' }, 'p14', 10)])).toEqual([]);
  });

  it('sin contador en partidos preparados (registro sin reloj) ni finalizados', () => {
    const e = ev(exclusion, 'p7', 0);
    expect(remaining(makeMatch({ status: 'ready', clock: stopped(1, 0) }), [e])).toEqual([]);
    expect(remaining(makeMatch({ status: 'finished', clock: stopped(2, at(59)) }), [ev(exclusion, 'p7', 58)])).toEqual([]);
  });
});

describe('inferioridades: rojas, 3.ª exclusión y sanciones adicionales (4 min)', () => {
  const red = { kind: 'red' } as const;
  const match = (minute: number, seconds = 0, extra: Partial<Match> = {}) =>
    makeMatch({ clock: stopped(1, at(minute, seconds)), ...extra });
  const detail = (m: Match, events: MatchEvent[]) =>
    activeReductions(m, events, 0).map((r) => [r.playerId, r.kind, r.durationMs / S, r.remainingMs / S]);
  const flagged = (e: MatchEvent): MatchEvent => ({ ...e, addsToPrevious: true });

  it('roja directa: 2 minutos de inferioridad, identificada como roja', () => {
    expect(detail(match(10, 30), [ev(red, 'p7', 10)])).toEqual([['p7', 'red', 120, 90]]);
    // Roja sin asignar: también abre inferioridad.
    expect(detail(match(10, 30), [ev(red, null, 10)])).toEqual([[null, 'red', 120, 90]]);
  });

  it('3.ª exclusión: una sola inferioridad de 2 min (la roja por acumulación no abre otra)', () => {
    const events = [ev(exclusion, 'p7', 5), ev(exclusion, 'p7', 8), ev(exclusion, 'p7', 10)];
    expect(detail(match(10, 30), events)).toEqual([['p7', 'accumulated', 120, 90]]);
    expect(teamReductions(events)).toHaveLength(3);
  });

  it('una roja a un jugador ya descalificado no abre otra inferioridad', () => {
    const afterThird = [ev(exclusion, 'p7', 5), ev(exclusion, 'p7', 8), ev(exclusion, 'p7', 10), ev(red, 'p7', 10)];
    expect(detail(match(10, 30), afterThird)).toEqual([['p7', 'accumulated', 120, 90]]);
    const twoReds = [ev(red, 'p14', 10), ev(red, 'p14', 10)];
    expect(detail(match(10, 30), twoReds)).toEqual([['p14', 'red', 120, 90]]);
  });

  it('sin marcar, dos sanciones del mismo jugador no se encadenan: dos inferioridades en paralelo', () => {
    const events = [ev(exclusion, 'p7', 10), ev(exclusion, 'p7', 10)];
    expect(detail(match(10, 30), events)).toEqual([
      ['p7', 'exclusion', 120, 90],
      ['p7', 'exclusion', 120, 90],
    ]);
  });

  it('sanción adicional antes de reanudar (marcada): una sola inferioridad de 4 min', () => {
    const first = ev(exclusion, 'p7', 10);
    const second = flagged(ev(exclusion, 'p7', 10));
    expect(detail(match(10, 30), [first, second])).toEqual([['p7', 'exclusion', 240, 210]]);
    expect(detail(match(13, 59), [first, second])).toEqual([['p7', 'exclusion', 240, 1]]);
    expect(detail(match(14), [first, second])).toEqual([]);
    // Las estadísticas no cambian: siguen siendo dos exclusiones.
    expect(computeMatchStats(makeMatch(), [first, second]).team.exclusions).toBe(2);
  });

  it('exclusión y roja antes de reanudar: 4 min; roja directa con adicional: roja de 4 min', () => {
    const events = [ev(exclusion, 'p7', 10), flagged(ev(red, 'p7', 10))];
    expect(detail(match(11), events)).toEqual([['p7', 'red', 240, 180]]);
    const redFirst = [ev(red, 'p14', 10), flagged(ev(exclusion, 'p14', 10))];
    expect(detail(match(11), redFirst)).toEqual([['p14', 'red', 240, 180]]);
  });

  it('3.ª exclusión y roja adicional antes de reanudar: 4 min, sin contadores dobles', () => {
    const events = [ev(exclusion, 'p7', 5), ev(exclusion, 'p7', 8), ev(exclusion, 'p7', 10), flagged(ev(red, 'p7', 10))];
    expect(detail(match(10, 30), events)).toEqual([['p7', 'accumulated', 240, 210]]);
  });

  it('la marca sin inferioridad anterior del jugador no cambia nada; borrar la adicional vuelve a 2 min', () => {
    expect(detail(match(10, 30), [flagged(ev(exclusion, 'p7', 10))])).toEqual([['p7', 'exclusion', 120, 90]]);
    const other = [ev(exclusion, 'p14', 10), flagged(ev(exclusion, 'p7', 10))];
    expect(detail(match(10, 30), other)).toHaveLength(2);
    const second = flagged(ev(exclusion, 'p7', 10));
    expect(detail(match(10, 30), [ev(exclusion, 'p7', 10), { ...second, deletedAt: second.createdAt }])).toEqual([
      ['p7', 'exclusion', 120, 90],
    ]);
  });

  it('4 min a través del descanso: se congela en el descanso y sigue desde el inicio de la 2.ª', () => {
    const base = ev(exclusion, 'p7', 1);
    const events = [{ ...base, matchTimeMs: at(29) }, flagged({ ...ev(exclusion, 'p7', 1), matchTimeMs: at(29) })];
    const half = makeMatch({ status: 'halftime', clock: stopped(1, at(30)) });
    expect(detail(half, events)).toEqual([['p7', 'exclusion', 240, 180]]);
    const second = makeMatch({ clock: stopped(2, at(32), { firstHalfEndMs: at(30) }) });
    expect(detail(second, events)).toEqual([['p7', 'exclusion', 240, 60]]);
  });

  it('candidatas a sanción adicional: solo las posteriores del mismo jugador', () => {
    const a = ev(exclusion, 'p7', 10);
    const b = ev(red, 'p7', 10);
    const events = [a, ev(exclusion, 'p14', 10), b, ev({ kind: 'yellow' }, 'p7', 10)];
    expect(additionalCandidates(events, { eventId: a.id, playerId: 'p7' }).map((e) => e.id)).toEqual([b.id]);
    expect(additionalCandidates(events, { eventId: a.id, playerId: null })).toEqual([]);
  });
});

describe('exclusiones activas: flujo real con el dispositivo', () => {
  let repo: IndexedDbRepository;
  let dbName: string;
  let team: Team;
  let n = 0;
  const T0 = Date.UTC(2026, 9, 25, 18, 0, 0);

  beforeEach(async () => {
    dbName = `exclusiones-${++n}`;
    repo = new IndexedDbRepository(dbName);
    team = await createTeam(repo, { name: 'Senior', code: `EX${n}`, season: '2026/27', maxSquad: 16 });
  });

  async function startedMatch() {
    const p7 = await savePlayer(repo, team.id, { name: 'Jugador Siete', number: 7, position: 'field', active: true });
    const p9 = await savePlayer(repo, team.id, { name: 'Jugador Nueve', number: 9, position: 'field', active: true });
    const match = await createMatch(repo, {
      teamId: team.id,
      opponent: 'Rival',
      date: '2026-10-25',
      venue: 'home',
      season: '2026/27',
      playerIds: [p7.id, p9.id],
    });
    return { match: await toggleClock(repo, match, T0), p7, p9 };
  }

  it('pausa, reanudación, cierre y reapertura de la app', async () => {
    const { match, p7 } = await startedMatch();
    await recordEvent(repo, match, exclusion, p7.id, currentTiming(match, T0 + at(10)));
    // Pausa a los 10:40 de partido.
    const paused = await toggleClock(repo, match, T0 + at(10, 40));
    // «Cerrar y reabrir»: otra conexión a la misma base, mucho más tarde.
    const reopened = new IndexedDbRepository(dbName);
    const stored = (await reopened.getMatch(match.id))!;
    const events = await reopened.listEvents(match.id);
    expect(remaining(stored, events, T0 + 3 * 60 * MINUTE_MS)).toEqual([[p7.id, 80 * S]]);
    // Reanudar 20 minutos reales después: sigue desde 1:20.
    const resumed = await toggleClock(repo, paused, T0 + at(30));
    expect(remaining(resumed, events, T0 + at(30, 30))).toEqual([[p7.id, 50 * S]]);
    expect(remaining(resumed, events, T0 + at(31, 20))).toEqual([]);
  });

  it('a través del descanso con el flujo de la app (Descanso → Iniciar 2.ª parte)', async () => {
    const { match, p7 } = await startedMatch();
    // Exclusión a 29:30; descanso a los 30:20 de partido.
    await recordEvent(repo, match, exclusion, p7.id, currentTiming(match, T0 + at(29, 30)));
    const half = await startHalftime(repo, match, T0 + at(30, 20));
    const events = await repo.listEvents(match.id);
    expect(remaining(half, events, T0 + at(45))).toEqual([[p7.id, 70 * S]]);
    const second = await toggleClock(repo, half, T0 + at(45));
    expect(second.clock).toMatchObject({ period: 2, firstHalfEndMs: at(30, 20) });
    expect(remaining(second, events, T0 + at(45, 30))).toEqual([[p7.id, 40 * S]]);
    expect(remaining(second, events, T0 + at(46, 10))).toEqual([]);
    // El dato se conserva al guardar y releer.
    expect((await new IndexedDbRepository(dbName).getMatch(match.id))!.clock.firstHalfEndMs).toBe(at(30, 20));
  });

  it('deshacer, eliminar o corregir la sanción actualiza el contador; finalizar lo oculta', async () => {
    const { match, p7, p9 } = await startedMatch();
    const now = T0 + at(10, 30);
    const a = await recordEvent(repo, match, exclusion, p7.id, currentTiming(match, T0 + at(10)));
    await recordEvent(repo, match, exclusion, p9.id, currentTiming(match, T0 + at(10, 10)));
    expect(remaining(match, await repo.listEvents(match.id), now)).toHaveLength(2);
    await undoLast(repo, await repo.listEvents(match.id));
    expect(remaining(match, await repo.listEvents(match.id), now)).toEqual([[p7.id, 90 * S]]);
    // Corregir el minuto de la exclusión mueve su cuenta atrás.
    const moved = await updateEvent(repo, match, a, { matchTimeMs: at(9) });
    expect(remaining(match, await repo.listEvents(match.id), now)).toEqual([[p7.id, 30 * S]]);
    await deleteEvent(repo, moved);
    expect(remaining(match, await repo.listEvents(match.id), now)).toEqual([]);
    // Las sanciones borradas siguen guardadas (borrado lógico).
    expect(await repo.listEvents(match.id)).toHaveLength(2);

    const b = await recordEvent(repo, match, exclusion, p9.id, currentTiming(match, now));
    const finished = await finishMatch(repo, match, now + 10 * S);
    expect(remaining(finished, [b], now + 10 * S)).toEqual([]);
  });

  it('marcar la sanción adicional se guarda, sobrevive a reabrir la app y se puede desmarcar', async () => {
    const { match, p7 } = await startedMatch();
    const timing = currentTiming(match, T0 + at(10));
    await recordEvent(repo, match, exclusion, p7.id, timing);
    const second = await recordEvent(repo, match, { kind: 'red' }, p7.id, timing);
    const now = T0 + at(11);
    const marked = await setAddsToPrevious(repo, second, true);
    const events = await new IndexedDbRepository(dbName).listEvents(match.id);
    expect(events.find((e) => e.id === second.id)!.addsToPrevious).toBe(true);
    expect(activeReductions(match, events, now).map((r) => [r.durationMs, r.remainingMs])).toEqual([[240 * S, 180 * S]]);
    // Corregir el minuto conserva la marca.
    const moved = await updateEvent(repo, match, marked, { matchTimeMs: at(10, 5) });
    expect(moved.addsToPrevious).toBe(true);
    // Desmarcar: vuelven a ser dos inferioridades de 2 min.
    const unmarked = await setAddsToPrevious(repo, moved, false);
    expect(unmarked).not.toHaveProperty('addsToPrevious');
    expect(activeReductions(match, await repo.listEvents(match.id), now)).toHaveLength(2);
    // Solo se marcan exclusiones o rojas de un jugador.
    const yellow = await recordEvent(repo, match, { kind: 'yellow' }, p7.id, timing);
    await expect(setAddsToPrevious(repo, yellow, true)).rejects.toThrow();
    const pending = await recordEvent(repo, match, exclusion, null, timing);
    await expect(setAddsToPrevious(repo, pending, true)).rejects.toThrow();
  });

  it('al reasignar la sanción a otro jugador se pierde la marca', async () => {
    const { match, p7, p9 } = await startedMatch();
    const timing = currentTiming(match, T0 + at(10));
    await recordEvent(repo, match, exclusion, p7.id, timing);
    const second = await setAddsToPrevious(repo, await recordEvent(repo, match, exclusion, p7.id, timing), true);
    const reassigned = await updateEvent(repo, match, second, { playerId: p9.id });
    expect(reassigned).not.toHaveProperty('addsToPrevious');
  });
});
