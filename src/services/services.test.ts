import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { IndexedDbRepository } from '../data/indexedDbRepository';
import { elapsedMs, MINUTE_MS } from '../clock/clock';
import { availableForNewActions, disqualifications } from '../stats/discipline';
import { computeMatchStats, computeSeasonStats } from '../stats/engine';
import type { Match, Player, Team } from '../domain/types';
import { ValidationError } from '../domain/validation';
import {
  adjustClock,
  createMatch,
  currentTiming,
  deleteEvent,
  deleteMatch,
  finishMatch,
  previousSquadIds,
  recordEvent,
  reopenMatch,
  setScoreAdjustment,
  startHalftime,
  toggleClock,
  undoLast,
  updateEvent,
} from './matchService';
import { loadSeasonItems } from './statsService';
import { createTeam, savePlayer, updateTeam } from './teamService';

let dbCounter = 0;
let repo: IndexedDbRepository;
let dbName: string;
let team: Team;
let players: Record<string, Player>;

const T0 = 1_700_000_000_000;

async function setup() {
  dbName = `test-${++dbCounter}`;
  repo = new IndexedDbRepository(dbName);
  team = await createTeam(repo, { name: 'Senior Masculino', code: 'sm 2627', season: '2026/27', maxSquad: 16 });
  players = {};
  const roster = [
    ['p7', 'Jugador Siete', 7, 'field'],
    ['p14', 'Jugador Catorce', 14, 'field'],
    ['p69', 'Jugador Sesenta y nueve', 69, 'field'],
    ['g1', 'Portero Uno', 1, 'goalkeeper'],
    ['g12', 'Portero Doce', 12, 'goalkeeper'],
  ] as const;
  for (const [key, name, number, position] of roster) {
    players[key] = await savePlayer(repo, team.id, { name, number, position, active: true });
  }
}

const id = (key: string) => players[key]!.id;

async function newMatch(overrides: { date?: string; id?: string } = {}): Promise<Match> {
  return createMatch(
    repo,
    {
      teamId: team.id,
      opponent: 'Rival de prueba',
      date: overrides.date ?? '2026-10-25',
      venue: 'home',
      season: '2026/27',
      playerIds: Object.values(players).map((p) => p.id),
    },
    overrides.id,
  );
}

beforeEach(setup);

describe('equipos y plantilla', () => {
  it('normaliza el código corto y rechaza códigos repetidos', async () => {
    expect(team.code).toBe('SM2627');
    await expect(
      createTeam(repo, { name: 'Otro', code: 'SM2627', season: '2026/27', maxSquad: 16 }),
    ).rejects.toThrow(ValidationError);
  });

  it('rechaza dorsales repetidos entre jugadores activos, pero no con inactivos', async () => {
    await expect(
      savePlayer(repo, team.id, { name: 'Duplicado', number: 7, position: 'field', active: true }),
    ).rejects.toThrow(/dorsal 7/);
    await savePlayer(repo, team.id, { ...players.p7!, active: false }, players.p7);
    await expect(
      savePlayer(repo, team.id, { name: 'Nuevo siete', number: 7, position: 'field', active: true }),
    ).resolves.toMatchObject({ number: 7 });
  });

  it('los partidos conservan nombre y dorsal históricos aunque el jugador cambie', async () => {
    const match = await newMatch();
    await savePlayer(repo, team.id, { ...players.p7!, name: 'Nombre nuevo', number: 70 }, players.p7);
    const stored = await repo.getMatch(match.id);
    const entry = stored!.squad.find((s) => s.playerId === id('p7'))!;
    expect(entry).toMatchObject({ name: 'Jugador Siete', number: 7 });
    expect((await repo.getPlayer(id('p7')))!.number).toBe(70);
  });

  it('nombre público opcional: compartible entre equipos del club y sin tocar id ni código', async () => {
    const named = await updateTeam(repo, team, { ...team, publicName: '  BM   Burjassot ' });
    expect(named).toMatchObject({ id: team.id, code: 'SM2627', name: team.name, publicName: 'BM Burjassot' });
    // Otro equipo del mismo club puede usar el mismo nombre público; su código sigue siendo único.
    const other = await createTeam(repo, { name: 'Senior Femenino A', code: 'SFA2627', season: '2026/27', maxSquad: 16, publicName: 'BM Burjassot' });
    expect(other.publicName).toBe('BM Burjassot');
    expect(other.id).not.toBe(team.id);
    // Vaciarlo lo quita; el resto del equipo no cambia.
    const cleared = await updateTeam(repo, named, { ...named, publicName: '' });
    expect(cleared).not.toHaveProperty('publicName');
    expect(await repo.getTeam(team.id)).toEqual(cleared);
    // Sin el campo, un equipo creado antes de esta versión sigue igual.
    const plain = await createTeam(repo, { name: 'Juvenil', code: 'JM2627', season: '2026/27', maxSquad: 16 });
    expect(plain).not.toHaveProperty('publicName');
    await expect(updateTeam(repo, plain, { ...plain, publicName: 'x'.repeat(41) })).rejects.toThrow(ValidationError);
  });

  it('actualizar la temporada del equipo no cambia la de partidos existentes', async () => {
    const match = await newMatch();
    await updateTeam(repo, team, { ...team, season: '2027/28' });
    expect((await repo.getMatch(match.id))!.season).toBe('2026/27');
  });
});

describe('creación de partido', () => {
  it('es idempotente: repetir la creación con el mismo id no duplica el partido', async () => {
    const a = await newMatch({ id: 'match-fijo' });
    const b = await newMatch({ id: 'match-fijo' });
    expect(b).toEqual(a);
    expect(await repo.listMatches(team.id)).toHaveLength(1);
  });

  it('respeta el límite configurable de convocados', async () => {
    await updateTeam(repo, team, { ...team, maxSquad: 3 });
    await expect(newMatch()).rejects.toThrow(/Máximo 3/);
  });

  it('propone la convocatoria del partido anterior', async () => {
    await createMatch(repo, {
      teamId: team.id,
      opponent: 'A',
      date: '2026-10-01',
      venue: 'away',
      season: '2026/27',
      playerIds: [id('p7'), id('g1')],
    });
    expect(new Set(await previousSquadIds(repo, team.id))).toEqual(new Set([id('p7'), id('g1')]));
  });

  it('ordena la convocatoria: campo por dorsal y porteros al final', async () => {
    const match = await newMatch();
    expect(match.squad.map((s) => s.number)).toEqual([7, 14, 69, 1, 12]);
  });
});

describe('registro de eventos', () => {
  it('registra con el tiempo de partido y persiste antes de devolver', async () => {
    let match = await toggleClock(repo, await newMatch(), T0);
    const timing = currentTiming(match, T0 + 75_000);
    expect(timing).toEqual({ period: 1, matchTimeMs: 75_000 });
    const e = await recordEvent(repo, match, { kind: 'shot', shotType: 'nine_m', result: 'goal' }, id('p69'), timing);
    expect(await repo.getEvent(e.id)).toEqual(e);
    match = (await repo.getMatch(match.id))!;
    expect(match.status).toBe('in_progress');
  });

  it('no duplica un evento al repetir la operación con el mismo id', async () => {
    const match = await newMatch();
    const t = { period: 1 as const, matchTimeMs: 0 };
    await recordEvent(repo, match, { kind: 'recovery' }, id('p7'), t, 'ev-1');
    await recordEvent(repo, match, { kind: 'recovery' }, id('p7'), t, 'ev-1');
    expect(await repo.listEvents(match.id)).toHaveLength(1);
  });

  it('rechaza lanzamientos recibidos asignados a jugadores de campo', async () => {
    const match = await newMatch();
    const t = { period: 1 as const, matchTimeMs: 0 };
    await expect(
      recordEvent(repo, match, { kind: 'gk_shot', shotType: 'nine_m', result: 'save' }, id('p7'), t),
    ).rejects.toThrow(ValidationError);
    expect(await repo.listEvents(match.id)).toHaveLength(0);
  });

  it('un portero puede marcar: gol ofensivo suyo, marcador propio, no es lanzamiento recibido', async () => {
    const match = await newMatch();
    const t = { period: 2 as const, matchTimeMs: 58 * MINUTE_MS };
    await recordEvent(repo, match, { kind: 'shot', shotType: 'nine_m', result: 'goal' }, id('g1'), t);
    await recordEvent(repo, match, { kind: 'shot', shotType: 'nine_m', result: 'out' }, id('g1'), t);
    await recordEvent(repo, match, { kind: 'gk_shot', shotType: 'six_m', result: 'save' }, id('g1'), t);
    const stats = computeMatchStats(match, await repo.listEvents(match.id));
    const g1 = stats.players.get(id('g1'))!;
    expect(g1.shots).toEqual({ goals: 1, out: 1, saved: 0, attempts: 2 });
    expect(g1.gk).toEqual({ goals: 0, saves: 1, out: 0, received: 1 });
    expect(stats.score).toMatchObject({ own: 1, opponent: 0 });
    expect(stats.team.shots.goals).toBe(1);
    expect(stats.team.gk.received).toBe(1);
  });

  it('un gol de jugador de campo corregido a portero conserva el total colectivo', async () => {
    const match = await newMatch();
    const t = { period: 1 as const, matchTimeMs: 0 };
    const e = await recordEvent(repo, match, { kind: 'shot', shotType: 'nine_m', result: 'goal' }, id('p7'), t);
    await updateEvent(repo, match, e, { playerId: id('g12') });
    const stats = computeMatchStats(match, await repo.listEvents(match.id));
    expect(stats.players.get(id('p7'))!.shots.goals).toBe(0);
    expect(stats.players.get(id('g12'))!.shots.goals).toBe(1);
    expect(stats.players.get(id('g12'))!.gk.received).toBe(0);
    expect(stats.score.own).toBe(1);
  });

  it('permite acciones generales de porteros (pérdida, recuperación)', async () => {
    const match = await newMatch();
    const t = { period: 1 as const, matchTimeMs: 0 };
    await recordEvent(repo, match, { kind: 'turnover', turnoverType: 'general' }, id('g1'), t);
    const stats = computeMatchStats(match, await repo.listEvents(match.id));
    expect(stats.players.get(id('g1'))!.turnovers.total).toBe(1);
  });
});

describe('corrección de eventos', () => {
  const t = { period: 1 as const, matchTimeMs: 60_000 };

  it('cambiar el jugador de un gol mueve el gol sin cambiar el total', async () => {
    const match = await newMatch();
    const e = await recordEvent(repo, match, { kind: 'shot', shotType: 'nine_m', result: 'goal' }, id('p69'), t);
    await updateEvent(repo, match, e, { playerId: id('p14') });
    const stats = computeMatchStats(match, await repo.listEvents(match.id));
    expect(stats.players.get(id('p69'))!.shots.goals).toBe(0);
    expect(stats.players.get(id('p14'))!.shots.goals).toBe(1);
    expect(stats.team.shots.goals).toBe(1);
    expect(await repo.listEvents(match.id)).toHaveLength(1);
  });

  it('cambiar el resultado de gol a fuera actualiza el marcador', async () => {
    const match = await newMatch();
    const e = await recordEvent(repo, match, { kind: 'shot', shotType: 'nine_m', result: 'goal' }, id('p7'), t);
    await updateEvent(repo, match, e, { payload: { kind: 'shot', shotType: 'nine_m', result: 'out' } });
    const stats = computeMatchStats(match, await repo.listEvents(match.id));
    expect(stats.score.own).toBe(0);
    expect(stats.team.shots).toEqual({ goals: 0, out: 1, saved: 0, attempts: 1 });
  });

  it('cambiar el tipo de acción no arrastra campos del tipo anterior', async () => {
    const match = await newMatch();
    const e = await recordEvent(repo, match, { kind: 'shot', shotType: 'six_m', result: 'goal' }, id('p7'), t);
    const updated = await updateEvent(repo, match, e, { payload: { kind: 'turnover', turnoverType: 'steps' } });
    expect(updated).not.toHaveProperty('shotType');
    expect(updated).not.toHaveProperty('result');
    expect(updated.createdAt).toBe(e.createdAt);
    const stats = computeMatchStats(match, await repo.listEvents(match.id));
    expect(stats.team.shots.attempts).toBe(0);
    expect(stats.team.turnovers.steps).toBe(1);
  });

  it('cambiar el minuto mueve el evento de intervalo', async () => {
    const match = await newMatch();
    const e = await recordEvent(repo, match, { kind: 'recovery' }, id('p7'), t);
    await updateEvent(repo, match, e, { period: 2, matchTimeMs: 41 * MINUTE_MS });
    const stats = computeMatchStats(match, await repo.listEvents(match.id));
    expect(stats.intervals[0]!.counters.recoveries).toBe(0);
    expect(stats.intervals[8]!.counters.recoveries).toBe(1);
  });

  it('eliminar un evento elimina todas sus consecuencias (pasos → pérdida)', async () => {
    const match = await newMatch();
    const e = await recordEvent(repo, match, { kind: 'turnover', turnoverType: 'steps' }, id('p69'), t);
    await deleteEvent(repo, e);
    const stats = computeMatchStats(match, await repo.listEvents(match.id));
    expect(stats.players.get(id('p69'))!.turnovers).toMatchObject({ total: 0, steps: 0 });
    expect(stats.team.turnovers.total).toBe(0);
  });

  it('deshacer anula la última acción registrada, no la de mayor minuto', async () => {
    const match = await newMatch();
    await recordEvent(repo, match, { kind: 'recovery' }, id('p7'), { period: 1, matchTimeMs: 20 * MINUTE_MS });
    // Acción olvidada añadida después, pero con un minuto anterior.
    const forgotten = await recordEvent(repo, match, { kind: 'yellow' }, id('p14'), { period: 1, matchTimeMs: 2 * MINUTE_MS });
    const undone = await undoLast(repo, await repo.listEvents(match.id));
    expect(undone!.id).toBe(forgotten.id);
    const stats = computeMatchStats(match, await repo.listEvents(match.id));
    expect(stats.team.yellows).toBe(0);
    expect(stats.team.recoveries).toBe(1);
  });

  it('una acción pendiente puede atribuirse después', async () => {
    const match = await newMatch();
    const e = await recordEvent(repo, match, { kind: 'shot', shotType: 'fast_break', result: 'goal' }, null, t);
    let stats = computeMatchStats(match, await repo.listEvents(match.id));
    expect(stats.pendingCount).toBe(1);
    expect(stats.score.own).toBe(1);
    await updateEvent(repo, match, e, { playerId: id('p7') });
    stats = computeMatchStats(match, await repo.listEvents(match.id));
    expect(stats.pendingCount).toBe(0);
    expect(stats.players.get(id('p7'))!.shotsByType.fast_break.goals).toBe(1);
    expect(stats.score.own).toBe(1);
  });
});

describe('marcador manual', () => {
  it('se guarda separado de los eventos', async () => {
    let match = await newMatch();
    await recordEvent(repo, match, { kind: 'shot', shotType: 'nine_m', result: 'goal' }, id('p7'), { period: 1, matchTimeMs: 0 });
    match = await setScoreAdjustment(repo, match, { own: 1, opponent: 2 });
    const stored = (await repo.getMatch(match.id))!;
    const stats = computeMatchStats(stored, await repo.listEvents(match.id));
    expect(stats.score).toMatchObject({ ownFromEvents: 1, own: 2, opponentFromEvents: 0, opponent: 2 });
    expect(await repo.listEvents(match.id)).toHaveLength(1);
  });
});

describe('cronómetro persistente y recuperación', () => {
  it('tras «recargar» (nuevo repositorio sobre la misma base) reconstruye el tiempo en marcha', async () => {
    const match = await toggleClock(repo, await newMatch(), T0);
    const reloaded = await new IndexedDbRepository(dbName).getMatch(match.id);
    expect(reloaded!.clock.running).toBe(true);
    expect(elapsedMs(reloaded!.clock, T0 + 5 * MINUTE_MS)).toBe(5 * MINUTE_MS);
  });

  it('si estaba pausado, sigue pausado tras recargar', async () => {
    let match = await toggleClock(repo, await newMatch(), T0);
    match = await toggleClock(repo, match, T0 + 90_000);
    const reloaded = await new IndexedDbRepository(dbName).getMatch(match.id);
    expect(reloaded!.clock.running).toBe(false);
    expect(elapsedMs(reloaded!.clock, T0 + 60 * MINUTE_MS)).toBe(90_000);
  });

  it('descanso → segunda parte arranca en 30:00 con una pulsación', async () => {
    let match = await toggleClock(repo, await newMatch(), T0);
    match = await startHalftime(repo, match, T0 + 31 * MINUTE_MS);
    expect(match.status).toBe('halftime');
    expect(match.clock.running).toBe(false);
    match = await toggleClock(repo, match, T0 + 45 * MINUTE_MS);
    expect(match.status).toBe('in_progress');
    expect(match.clock.period).toBe(2);
    expect(elapsedMs(match.clock, T0 + 46 * MINUTE_MS)).toBe(31 * MINUTE_MS);
  });

  it('ajustar el reloj no modifica los tiempos de eventos ya registrados', async () => {
    const match = await toggleClock(repo, await newMatch(), T0);
    const e = await recordEvent(repo, match, { kind: 'recovery' }, id('p7'), currentTiming(match, T0 + 3 * MINUTE_MS));
    await adjustClock(repo, match, 10 * MINUTE_MS, T0 + 4 * MINUTE_MS);
    expect((await repo.getEvent(e.id))!.matchTimeMs).toBe(3 * MINUTE_MS);
  });

  it('finalizar detiene el reloj; reabrir lo deja parado', async () => {
    let match = await toggleClock(repo, await newMatch(), T0);
    match = await finishMatch(repo, match, T0 + 60_000);
    expect(match.status).toBe('finished');
    expect(match.finishedAt).not.toBeNull();
    await expect(toggleClock(repo, match, T0)).rejects.toThrow();
    match = await reopenMatch(repo, match);
    expect(match.status).toBe('in_progress');
    expect(match.clock.running).toBe(false);
  });

  it('los datos sobreviven a una reapertura de la base de datos', async () => {
    const match = await newMatch();
    await recordEvent(repo, match, { kind: 'shot', shotType: 'nine_m', result: 'goal' }, id('p7'), { period: 1, matchTimeMs: 0 });
    const fresh = new IndexedDbRepository(dbName);
    expect(await fresh.listTeams()).toHaveLength(1);
    expect(await fresh.listPlayers(team.id)).toHaveLength(5);
    expect(await fresh.listEvents(match.id)).toHaveLength(1);
  });
});

describe('temporada desde persistencia', () => {
  it('acumula partidos guardados', async () => {
    const m1 = await newMatch({ date: '2026-10-01' });
    const m2 = await newMatch({ date: '2026-10-08' });
    const t = { period: 1 as const, matchTimeMs: 0 };
    await recordEvent(repo, m1, { kind: 'shot', shotType: 'nine_m', result: 'goal' }, id('p7'), t);
    await recordEvent(repo, m2, { kind: 'shot', shotType: 'nine_m', result: 'out' }, id('p7'), t);
    await recordEvent(repo, m2, { kind: 'exclusion' }, id('p7'), t);
    const matches = await repo.listMatches(team.id);
    const season = computeSeasonStats(
      await Promise.all(matches.map(async (match) => ({ match, events: await repo.listEvents(match.id) }))),
    );
    const p7 = season.players.get(id('p7'))!;
    expect(p7.matches).toBe(2);
    expect(p7.counters.shots).toMatchObject({ goals: 1, attempts: 2 });
    expect(p7.counters.exclusions).toBe(1);
  });
});

describe('descalificación por tercera exclusión (persistencia)', () => {
  const at = (minute: number) => ({ period: (minute >= 30 ? 2 : 1) as 1 | 2, matchTimeMs: minute * MINUTE_MS });
  const excl = (match: Match, key: string, minute: number) =>
    recordEvent(repo, match, { kind: 'exclusion' }, id(key), at(minute));

  it('eliminar la tercera exclusión restaura la disponibilidad y quita la roja', async () => {
    const match = await newMatch();
    await excl(match, 'p7', 5);
    await excl(match, 'p7', 12);
    const third = await excl(match, 'p7', 40);
    let events = await repo.listEvents(match.id);
    expect(availableForNewActions(match.squad, events).map((s) => s.playerId)).not.toContain(id('p7'));
    expect(computeMatchStats(match, events).players.get(id('p7'))!.reds).toBe(1);

    await deleteEvent(repo, third);
    events = await repo.listEvents(match.id);
    expect(availableForNewActions(match.squad, events).map((s) => s.playerId)).toContain(id('p7'));
    expect(computeMatchStats(match, events).players.get(id('p7'))).toMatchObject({ exclusions: 2, reds: 0 });
  });

  it('corregir una exclusión a otro jugador recalcula ambas fichas', async () => {
    const match = await newMatch();
    await excl(match, 'p7', 5);
    await excl(match, 'p7', 12);
    const third = await excl(match, 'p7', 40);
    await excl(match, 'p14', 20);
    await excl(match, 'p14', 25);
    await updateEvent(repo, match, third, { playerId: id('p14') });
    const events = await repo.listEvents(match.id);
    const s = computeMatchStats(match, events);
    expect(s.players.get(id('p7'))).toMatchObject({ exclusions: 2, reds: 0 });
    expect(s.players.get(id('p14'))).toMatchObject({ exclusions: 3, reds: 1, redsAccumulated: 1 });
    expect(s.team).toMatchObject({ exclusions: 5, reds: 1 });
    const available = availableForNewActions(match.squad, events).map((s) => s.playerId);
    expect(available).toContain(id('p7'));
    expect(available).not.toContain(id('p14'));
  });

  it('registrar además una roja directa tras la tercera exclusión no duplica', async () => {
    const match = await newMatch();
    await excl(match, 'g1', 5);
    await excl(match, 'g1', 12);
    await excl(match, 'g1', 40);
    await recordEvent(repo, match, { kind: 'red' }, id('g1'), at(40));
    const s = computeMatchStats(match, await repo.listEvents(match.id));
    expect(s.players.get(id('g1'))).toMatchObject({ reds: 1, redsAccumulated: 1, redsDirect: 0 });
    expect(s.team.reds).toBe(1);
  });

  it('se puede atribuir al descalificado una acción olvidada anterior', async () => {
    const match = await newMatch();
    await excl(match, 'p7', 5);
    await excl(match, 'p7', 12);
    await excl(match, 'p7', 40);
    await recordEvent(repo, match, { kind: 'shot', shotType: 'nine_m', result: 'goal' }, id('p7'), at(8));
    const s = computeMatchStats(match, await repo.listEvents(match.id));
    expect(s.players.get(id('p7'))!.shots.goals).toBe(1);
    expect(s.score.own).toBe(1);
  });

  it('tras recargar, la descalificación y las estadísticas se reconstruyen igual', async () => {
    const match = await newMatch();
    await excl(match, 'p7', 5);
    await excl(match, 'p7', 12);
    await excl(match, 'p7', 40);
    const fresh = new IndexedDbRepository(dbName);
    const reloaded = (await fresh.getMatch(match.id))!;
    const events = await fresh.listEvents(match.id);
    expect(disqualifications(events).get(id('p7'))!.type).toBe('accumulated');
    expect(computeMatchStats(reloaded, events).players.get(id('p7'))).toMatchObject({ exclusions: 3, reds: 1 });
    // Convocatoria e historial intactos.
    expect(reloaded.squad.map((s) => s.playerId)).toContain(id('p7'));
    expect(events.filter((e) => e.kind === 'red')).toHaveLength(0);
  });
});

describe('eliminación de partidos', () => {
  const t = { period: 1 as const, matchTimeMs: 0 };
  const goalFor = (match: Match, key: string) =>
    recordEvent(repo, match, { kind: 'shot', shotType: 'nine_m', result: 'goal' }, id(key), t);
  const seasonOf = async () => {
    const matches = await repo.listMatches(team.id);
    return computeSeasonStats(
      await Promise.all(matches.map(async (match) => ({ match, events: await repo.listEvents(match.id) }))),
    );
  };

  it('elimina un partido preparado y desaparece de los listados', async () => {
    const match = await newMatch();
    expect(match.status).toBe('ready');
    await deleteMatch(repo, match);
    expect(await repo.listMatches(team.id)).toHaveLength(0);
    expect((await repo.getMatch(match.id))!.deletedAt).not.toBeNull();
  });

  it('elimina un partido en curso deteniendo su cronómetro', async () => {
    const match = await toggleClock(repo, await newMatch(), T0);
    const deleted = await deleteMatch(repo, match, T0 + 90_000);
    expect(deleted.clock.running).toBe(false);
    expect(elapsedMs(deleted.clock, T0 + 10 * MINUTE_MS)).toBe(90_000);
    expect(deleted.status).toBe('in_progress'); // el estado se conserva para una posible restauración
  });

  it('elimina un partido finalizado', async () => {
    const match = await finishMatch(repo, await toggleClock(repo, await newMatch(), T0), T0 + 1000);
    await deleteMatch(repo, match);
    expect(await repo.listMatches(team.id)).toHaveLength(0);
  });

  it('sus acciones dejan de contar en la temporada y los demás partidos quedan intactos', async () => {
    const keep = await newMatch({ date: '2026-10-01' });
    const remove = await newMatch({ date: '2026-10-08' });
    await goalFor(keep, 'p7');
    await goalFor(remove, 'p7');
    await goalFor(remove, 'p14');
    await recordEvent(repo, remove, { kind: 'exclusion' }, id('p7'), t);
    let season = await seasonOf();
    expect(season.matches).toBe(2);
    expect(season.team.shots.goals).toBe(3);

    await deleteMatch(repo, remove);
    season = await seasonOf();
    expect(season.matches).toBe(1);
    expect(season.team.shots.goals).toBe(1);
    expect(season.team.exclusions).toBe(0);
    expect(season.players.get(id('p7'))).toMatchObject({ matches: 1 });
    expect(season.players.get(id('p7'))!.counters.shots.goals).toBe(1);
    expect(season.players.has(id('p14'))).toBe(true); // sigue convocado en el partido que queda
    expect(season.players.get(id('p14'))!.counters.shots.goals).toBe(0);
    // Las acciones del partido eliminado se conservan en el almacenamiento (no se destruyen).
    expect(await repo.listEvents(remove.id)).toHaveLength(3);
  });

  it('no modifica la plantilla del equipo', async () => {
    const match = await newMatch();
    const before = await repo.listPlayers(team.id);
    await deleteMatch(repo, match);
    expect(await repo.listPlayers(team.id)).toEqual(before);
  });

  it('persiste tras recargar y no aparece como partido en curso', async () => {
    const match = await toggleClock(repo, await newMatch(), T0);
    await deleteMatch(repo, match);
    const fresh = new IndexedDbRepository(dbName);
    const listed = await fresh.listMatches(team.id);
    expect(listed).toHaveLength(0);
    expect(listed.filter((m) => m.status === 'in_progress' || m.status === 'halftime')).toHaveLength(0);
    expect((await fresh.getMatch(match.id))!.deletedAt).not.toBeNull();
  });

  it('repetir la eliminación no cambia nada (aunque se use una copia antigua del partido)', async () => {
    const match = await newMatch();
    const first = await deleteMatch(repo, match);
    const second = await deleteMatch(repo, match);
    expect(second).toEqual(first);
    expect((await repo.getMatch(match.id))!.deletedAt).toBe(first.deletedAt);
  });
});

describe('golpes francos: acción de equipo', () => {
  const t = { period: 1 as const, matchTimeMs: 60_000 };
  const ft = { kind: 'free_throw' } as const;

  it('se registran sin jugador, cuentan en el equipo y no son «pendientes»', async () => {
    const match = await newMatch();
    await recordEvent(repo, match, ft, null, t);
    await recordEvent(repo, match, ft, null, { period: 1, matchTimeMs: 90_000 });
    const s = computeMatchStats(match, await repo.listEvents(match.id));
    expect(s.team.freeThrows).toBe(2);
    expect(s.pendingCount).toBe(0);
    // No cambian marcador, goles, lanzamientos ni ninguna cifra de jugador.
    expect(s.score).toMatchObject({ own: 0, opponent: 0 });
    expect(s.team.shots.attempts + s.team.gk.received + s.team.turnovers.total).toBe(0);
    for (const c of s.players.values()) expect(c.freeThrows).toBe(0);
  });

  it('no se pueden asignar a un jugador', async () => {
    const match = await newMatch();
    await expect(recordEvent(repo, match, ft, id('p7'), t)).rejects.toThrow(ValidationError);
    const e = await recordEvent(repo, match, ft, null, t);
    await expect(updateEvent(repo, match, e, { playerId: id('p7') })).rejects.toThrow(ValidationError);
    // Corregir otra acción a golpe franco obliga a dejarla sin jugador.
    const y = await recordEvent(repo, match, { kind: 'yellow' }, id('p7'), t);
    await expect(updateEvent(repo, match, y, { payload: ft })).rejects.toThrow(ValidationError);
    const fixed = await updateEvent(repo, match, y, { payload: ft, playerId: null });
    expect(fixed).toMatchObject({ kind: 'free_throw', playerId: null });
  });

  it('deshacer y eliminar: las acciones anuladas no cuentan', async () => {
    const match = await newMatch();
    const a = await recordEvent(repo, match, ft, null, t);
    await recordEvent(repo, match, ft, null, { period: 1, matchTimeMs: 70_000 });
    await undoLast(repo, await repo.listEvents(match.id));
    await deleteEvent(repo, a);
    const events = await repo.listEvents(match.id);
    expect(events).toHaveLength(2); // siguen guardadas, marcadas como borradas
    expect(computeMatchStats(match, events).team.freeThrows).toBe(0);
  });

  it('repetir el registro con el mismo identificador no lo duplica', async () => {
    const match = await newMatch();
    await Promise.all([recordEvent(repo, match, ft, null, t, 'golpe-1'), recordEvent(repo, match, ft, null, t, 'golpe-1')]);
    expect(await repo.listEvents(match.id)).toHaveLength(1);
  });

  it('se acumulan en la temporada', async () => {
    const m1 = await newMatch();
    const m2 = await newMatch({ date: '2026-11-01' });
    await recordEvent(repo, m1, ft, null, t);
    await recordEvent(repo, m2, ft, null, t);
    await recordEvent(repo, m2, ft, null, { period: 2, matchTimeMs: 40 * 60_000 });
    const season = computeSeasonStats(await loadSeasonItems(repo, team.id));
    expect(season.team.freeThrows).toBe(3);
    expect(season.pendingCount).toBe(0);
  });

  it('un golpe franco antiguo, asignado a un jugador, se conserva y se puede corregir', async () => {
    const match = await newMatch();
    // Evento guardado por una versión anterior de la aplicación.
    const legacy = {
      id: 'antiguo-1',
      matchId: match.id,
      kind: 'free_throw' as const,
      playerId: id('p7'),
      period: 1 as const,
      matchTimeMs: 60_000,
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: '2026-09-01T10:00:00.000Z',
      deletedAt: null,
    };
    await repo.saveEvent(legacy);
    const fresh = new IndexedDbRepository(dbName);
    const events = await fresh.listEvents(match.id);
    expect(events).toEqual([legacy]);
    const s = computeMatchStats(match, events);
    expect(s.team.freeThrows).toBe(1);
    expect(s.players.get(id('p7'))!.freeThrows).toBe(1);

    // Corregir su minuto conserva su jugador; no puede pasar a otro jugador.
    const moved = await updateEvent(repo, match, legacy, { matchTimeMs: 65_000 });
    expect(moved).toMatchObject({ kind: 'free_throw', playerId: id('p7') });
    await expect(updateEvent(repo, match, moved, { playerId: id('p14') })).rejects.toThrow(ValidationError);
    const changed = await updateEvent(repo, match, moved, { payload: { kind: 'penalty_committed' } });
    expect(changed.kind).toBe('penalty_committed');
  });
});
