// 005E.3A: editar la convocatoria de un partido sin terminar y corregir fichas
// repetidas (borrar o unir) sin perder datos deportivos. Datos sintéticos.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { IndexedDbRepository } from '../data/indexedDbRepository';
import type { Match, Player, Team } from '../domain/types';
import { ValidationError } from '../domain/validation';
import { buildPlan } from '../remote/plan';
import type { TeamLink } from '../remote/store';
import { computeMatchStats } from '../stats/engine';
import { createMatch, currentTiming, deleteEvent, finishMatch, recordEvent, startHalftime, toggleClock, updateSquad } from './matchService';
import { cardActivity, deletePlayerCard, duplicateNumbers, mergePlayerCards, planMerge } from './rosterService';
import { createTeam, savePlayer } from './teamService';

let n = 0;
let repo: IndexedDbRepository;
let team: Team;
let p: Record<string, Player>;
const T0 = 1_700_000_000_000;
const MIN = 60_000;
const GOAL = { kind: 'shot', shotType: 'nine_m', result: 'goal' } as const;
const SAVE = { kind: 'gk_shot', shotType: 'nine_m', result: 'save' } as const;

beforeEach(async () => {
  repo = new IndexedDbRepository(`squad-roster-${++n}`);
  team = await createTeam(repo, { name: 'Senior Femenino B', code: 'sfb 2627', season: '2026/27', maxSquad: 16 });
  p = {};
  for (const [key, name, number, position] of [
    ['a7', 'Ana Siete', 7, 'field'],
    ['b9', 'Bea Nueve', 9, 'field'],
    ['c11', 'Carla Once', 11, 'field'],
    ['d14', 'Dani Catorce', 14, 'field'],
    ['g1', 'Gema Portera', 1, 'goalkeeper'],
  ] as const) {
    p[key] = await savePlayer(repo, team.id, { name, number, position, active: true });
  }
});

const newMatch = (keys: string[], id?: string) =>
  createMatch(repo, { teamId: team.id, opponent: 'Rival', date: '2026-11-15', venue: 'home', season: '2026/27', playerIds: keys.map((k) => p[k]!.id) }, id);
const ids = (m: Match) => m.squad.map((s) => s.playerId);
const fresh = async (m: Match) => (await repo.getMatch(m.id))!;

describe('editar la convocatoria', () => {
  it('antes del partido: añade y quita sin tocar el estado ni el cronómetro', async () => {
    const m = await newMatch(['a7', 'b9', 'g1']);
    const edited = await updateSquad(repo, m, [p.a7!.id, p.c11!.id, p.g1!.id]);
    expect(ids(edited)).toEqual([p.a7!.id, p.c11!.id, p.g1!.id]);
    expect(edited.status).toBe('ready');
    expect(edited.clock).toEqual(m.clock);
    expect(await fresh(m)).toEqual(edited);
  });

  it('minuto 8: se añade a quien faltaba, se le registra el gol y el reloj, el marcador y las acciones previas se conservan', async () => {
    let m = await toggleClock(repo, await newMatch(['a7', 'b9', 'g1']), T0);
    const first = await recordEvent(repo, m, GOAL, p.a7!.id, currentTiming(m, T0 + 3 * MIN));
    await expect(recordEvent(repo, m, GOAL, p.d14!.id, currentTiming(m, T0 + 8 * MIN))).rejects.toThrow(/no está convocado/);
    const before = { clock: m.clock, status: m.status, score: m.scoreAdjustment };
    m = await updateSquad(repo, m, [...ids(m), p.d14!.id]);
    expect({ clock: m.clock, status: m.status, score: m.scoreAdjustment }).toEqual(before);
    expect(m.squad.map((s) => s.number)).toEqual([7, 9, 14, 1]);
    const goal = await recordEvent(repo, m, GOAL, p.d14!.id, currentTiming(m, T0 + 8 * MIN));
    expect(goal.matchTimeMs).toBe(8 * MIN);
    const events = await repo.listEvents(m.id);
    expect(events.map((e) => e.id).sort()).toEqual([first.id, goal.id].sort());
    expect(computeMatchStats(await fresh(m), events).score.own).toBe(2);
    // El reloj sigue corriendo desde el mismo instante.
    expect((await fresh(m)).clock).toEqual(before.clock);
  });

  it('no se puede quitar a quien tiene acciones, tampoco anuladas; sí a quien no tiene ninguna', async () => {
    let m = await toggleClock(repo, await newMatch(['a7', 'b9', 'c11', 'g1']), T0);
    const e = await recordEvent(repo, m, GOAL, p.b9!.id, currentTiming(m, T0 + MIN));
    await expect(updateSquad(repo, m, [p.a7!.id, p.c11!.id, p.g1!.id])).rejects.toThrow(/9 · Bea Nueve tiene acciones/);
    await deleteEvent(repo, e);
    await expect(updateSquad(repo, m, [p.a7!.id, p.c11!.id, p.g1!.id])).rejects.toThrow(/tiene acciones/);
    m = await updateSquad(repo, m, [p.a7!.id, p.b9!.id, p.g1!.id]);
    expect(ids(m)).not.toContain(p.c11!.id);
  });

  it('en el descanso también; con el partido finalizado, no', async () => {
    let m = await toggleClock(repo, await newMatch(['a7', 'g1']), T0);
    m = await startHalftime(repo, m, T0 + 30 * MIN);
    m = await updateSquad(repo, m, [...ids(m), p.b9!.id]);
    expect(m.status).toBe('halftime');
    m = await finishMatch(repo, m, T0 + 70 * MIN);
    await expect(updateSquad(repo, m, [...ids(m), p.c11!.id])).rejects.toThrow(/finalizado/);
  });

  it('las mismas reglas que al crear: máximo, dorsales y plantilla activa; sin cambios no escribe', async () => {
    const m = await newMatch(['a7', 'g1']);
    await expect(updateSquad(repo, m, [])).rejects.toThrow(/al menos un convocado/);
    const off = await savePlayer(repo, team.id, { name: 'Baja', number: 30, position: 'field', active: false });
    await expect(updateSquad(repo, m, [...ids(m), off.id])).rejects.toThrow(/inactivo/);
    await repo.saveTeam({ ...team, maxSquad: 2 });
    await expect(updateSquad(repo, m, [...ids(m), p.b9!.id])).rejects.toThrow(/Máximo 2/);
    expect(await updateSquad(repo, m, ids(m))).toBe(m);
    expect((await fresh(m)).updatedAt).toBe(m.updatedAt);
  });

  it('quien sigue conserva la copia del partido (nombre y dorsal de entonces)', async () => {
    const m = await newMatch(['a7', 'g1']);
    await savePlayer(repo, team.id, { name: 'Ana Cambiada', number: 70, position: 'field', active: true }, p.a7);
    const edited = await updateSquad(repo, m, [...ids(m), p.b9!.id]);
    expect(edited.squad.find((s) => s.playerId === p.a7!.id)).toMatchObject({ name: 'Ana Siete', number: 7 });
  });

  it('una acción de portero obliga a seguir siendo portero: no se puede quitar a la portera con paradas', async () => {
    const m = await toggleClock(repo, await newMatch(['a7', 'g1']), T0);
    await recordEvent(repo, m, SAVE, p.g1!.id, currentTiming(m, T0 + MIN));
    await expect(updateSquad(repo, m, [p.a7!.id])).rejects.toThrow(/Gema Portera tiene acciones/);
  });
});

describe('fichas repetidas', () => {
  const ON_CLUB = new Set<string>();
  const isOnClub = async (id: string) => ON_CLUB.has(id);
  beforeEach(() => ON_CLUB.clear());

  /** Repite la ficha de `key` (otra ficha, mismo dorsal), como al juntarse dos plantillas. */
  async function duplicate(key: string): Promise<Player> {
    const original = p[key]!;
    const copy: Player = { ...original, id: `${original.id}-copia`, createdAt: original.createdAt, updatedAt: original.updatedAt };
    await repo.savePlayer(copy);
    return copy;
  }

  it('detecta los dorsales repetidos entre activos (no los inactivos ni el cuerpo técnico)', async () => {
    const dup = await duplicate('b9');
    await savePlayer(repo, team.id, { name: 'Baja', number: 7, position: 'field', active: false });
    expect(duplicateNumbers(await repo.listPlayers(team.id)).map((d) => [d.number, d.players.map((x) => x.id).sort()])).toEqual([[9, [p.b9!.id, dup.id].sort()]]);
  });

  it('borrar: solo una ficha que no llegó al club y no aparece en ningún partido', async () => {
    const dup = await duplicate('b9');
    await deletePlayerCard(repo, dup, isOnClub);
    expect(await repo.getPlayer(dup.id)).toBeUndefined();
    // En el club: no.
    ON_CLUB.add(p.c11!.id);
    await expect(deletePlayerCard(repo, p.c11!, isOnClub)).rejects.toThrow(/ya está en el club/);
    // Con convocatorias: no.
    await newMatch(['a7', 'g1']);
    await expect(deletePlayerCard(repo, p.a7!, isOnClub)).rejects.toThrow(/aparece en 1 partido/);
    expect(await repo.getPlayer(p.a7!.id)).toBeDefined();
  });

  it('caso real (SFB): dos fichas de la misma jugadora con actividad; se une la del dispositivo a la del club y el envío queda limpio', async () => {
    // Ficha del club (ya enviada) con un partido; ficha repetida del dispositivo con otro partido y acciones.
    ON_CLUB.add(p.b9!.id);
    const club = await toggleClock(repo, await newMatch(['a7', 'b9', 'g1'], 'm-club'), T0);
    await recordEvent(repo, club, GOAL, p.b9!.id, currentTiming(club, T0 + MIN));
    const dup = await duplicate('b9');
    let local = await createMatch(repo, { teamId: team.id, opponent: 'Rival 2', date: '2026-11-16', venue: 'away', season: '2026/27', playerIds: [p.a7!.id, dup.id, p.g1!.id] }, 'm-local');
    local = await toggleClock(repo, local, T0);
    const g1 = await recordEvent(repo, local, GOAL, dup.id, currentTiming(local, T0 + 2 * MIN));
    const g2 = await recordEvent(repo, local, GOAL, dup.id, currentTiming(local, T0 + 3 * MIN));
    await deleteEvent(repo, g2);

    const link = { localTeamId: team.id, remoteTeamId: 'r', remoteTeamName: 'SFB', remoteTeamCode: 'SFB2627', remoteSeason: '2026/27', clubName: 'Club', linkedAt: '' } as TeamLink;
    expect(buildPlan(await repo.readAll(), team, link).problems.join(' ')).toMatch(/Dorsal 9 repetido/);
    const before = await cardActivity(repo, team.id);
    expect(before.get(dup.id)).toEqual({ matches: 1, events: 2 });

    // Aunque se abra la ficha del club, se conserva la del club.
    const plan = await planMerge(repo, p.b9!, dup, isOnClub, dup);
    expect([plan.keep.id, plan.remove.id]).toEqual([p.b9!.id, dup.id]);
    await mergePlayerCards(repo, plan, isOnClub);

    expect(await repo.getPlayer(dup.id)).toBeUndefined();
    const after = await cardActivity(repo, team.id);
    expect(after.get(p.b9!.id)).toEqual({ matches: 2, events: 3 });
    const m = await fresh(local);
    expect(m.squad.find((s) => s.number === 9)).toMatchObject({ playerId: p.b9!.id, name: 'Bea Nueve' });
    const events = await repo.listEvents(local.id);
    expect(events.find((e) => e.id === g1.id)!.playerId).toBe(p.b9!.id);
    expect(events.find((e) => e.id === g2.id)!).toMatchObject({ playerId: p.b9!.id, deletedAt: expect.any(String) });
    // Marcador, cronómetro y estado del partido intactos; el envío ya no tiene problemas.
    expect(computeMatchStats(m, events).score.own).toBe(1);
    expect({ clock: m.clock, status: m.status }).toEqual({ clock: local.clock, status: local.status });
    expect(buildPlan(await repo.readAll(), team, link).problems).toEqual([]);
  });

  it('las dos en el mismo partido: queda una sola entrada y suman sus acciones', async () => {
    const dup = await duplicate('c11');
    // Mismo dorsal en la convocatoria (posible solo con datos ya repetidos): se monta a mano.
    const base = await newMatch(['a7', 'c11', 'g1']);
    const m: Match = { ...base, squad: [...base.squad, { ...base.squad.find((s) => s.playerId === p.c11!.id)!, playerId: dup.id }] };
    await repo.saveMatch(m);
    await recordEvent(repo, m, GOAL, dup.id, { period: 1, matchTimeMs: 1000 });
    await recordEvent(repo, m, GOAL, p.c11!.id, { period: 1, matchTimeMs: 2000 });
    await mergePlayerCards(repo, await planMerge(repo, p.c11!, dup, isOnClub), isOnClub);
    const after = await fresh(m);
    expect(after.squad.filter((s) => s.number === 11).map((s) => s.playerId)).toEqual([p.c11!.id]);
    expect((await repo.listEvents(m.id)).every((e) => e.playerId !== dup.id)).toBe(true);
  });

  it('no se une si alguna acción dejaría de ser válida, ni si las dos fichas están en el club; nunca entre equipos', async () => {
    // Portera con paradas unida a una jugadora de campo: la parada quedaría en una jugadora de campo.
    const keeper = await duplicate('g1');
    const m = await newMatch(['a7', 'g1']);
    const swapped: Match = { ...m, squad: m.squad.map((s) => (s.playerId === p.g1!.id ? { ...s, playerId: keeper.id } : s)) };
    await repo.saveMatch(swapped);
    await recordEvent(repo, swapped, SAVE, keeper.id, { period: 1, matchTimeMs: 1000 });
    await expect(planMerge(repo, p.a7!, keeper, isOnClub)).rejects.toThrow(/dejaría de ser válida/);
    ON_CLUB.add(p.a7!.id);
    ON_CLUB.add(p.b9!.id);
    await expect(planMerge(repo, p.a7!, p.b9!, isOnClub)).rejects.toThrow(/Las dos fichas ya están en el club/);
    const other = await createTeam(repo, { name: 'Otro', code: 'otro1', season: '2026/27', maxSquad: 16 });
    const foreign = await savePlayer(repo, other.id, { name: 'Ajena', number: 50, position: 'field', active: true });
    await expect(planMerge(repo, p.c11!, foreign, isOnClub)).rejects.toThrow(ValidationError);
    // Nada ha cambiado.
    expect((await repo.listEvents(swapped.id)).every((e) => e.playerId === keeper.id)).toBe(true);
  });

  it('si al confirmar la ficha que se iba a borrar ya está en el club, no se toca nada', async () => {
    const dup = await duplicate('d14');
    const m = await newMatch(['a7', 'g1']);
    await repo.saveMatch({ ...m, squad: [...m.squad, { playerId: dup.id, name: dup.name, number: 14, position: 'field' }] });
    const plan = await planMerge(repo, p.d14!, dup, isOnClub);
    ON_CLUB.add(dup.id);
    await expect(mergePlayerCards(repo, plan, isOnClub)).rejects.toThrow(/ya está en el club/);
    expect(await repo.getPlayer(dup.id)).toBeDefined();
    expect((await fresh(m)).squad.some((s) => s.playerId === dup.id)).toBe(true);
  });
});

describe('envío: las bajas antes que las altas', () => {
  it('una ficha inactiva se envía antes que la activa con el mismo dorsal, aunque su id vaya después', async () => {
    const active = await savePlayer(repo, team.id, { name: 'Nueva Nueve', number: 9, position: 'field', active: false }, undefined, '000-primera');
    await savePlayer(repo, team.id, { name: 'Bea Nueve', number: 9, position: 'field', active: false }, p.b9);
    await savePlayer(repo, team.id, { name: 'Nueva Nueve', number: 9, position: 'field', active: true }, active);
    const link = { localTeamId: team.id, remoteTeamId: 'r' } as TeamLink;
    const plan = buildPlan(await repo.readAll(), team, link);
    const order = plan.players.filter((x) => x.number === 9).map((x) => [x.id, x.active]);
    expect(order).toEqual([
      [p.b9!.id, false],
      ['000-primera', true],
    ]);
  });
});
