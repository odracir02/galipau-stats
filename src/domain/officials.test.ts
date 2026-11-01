// Cuerpo técnico (role: 'official'): plantilla, convocatoria, reglas de las
// acciones, disciplina, inferioridades, estadísticas, rankings y huellas de
// sincronización. Datos sintéticos.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { IndexedDbRepository } from '../data/indexedDbRepository';
import { eventContent, matchContent, playerContent, stableJson } from '../remote/upload';
import * as svc from '../services/matchService';
import { createTeam, savePlayer } from '../services/teamService';
import { disqualifications, officialIds, redCards } from '../stats/discipline';
import { computeMatchStats, computeSeasonStats } from '../stats/engine';
import { activeReductions } from '../stats/exclusions';
import { RANKINGS, rankPlayers, seasonCandidates } from '../stats/rankings';
import { ev, goal, makeMatch, SQUAD } from '../test/fixtures';
import { canReceive, IHF_MAX_OFFICIALS, OFFICIAL_KINDS } from './catalog';
import type { Match, MatchEvent, Player, SquadEntry, Team } from './types';
import { assertEligiblePlayer, ValidationError } from './validation';

const OFF: SquadEntry = { playerId: 'of1', name: 'Ana Entrenadora', number: 0, position: 'field', role: 'official' };
const OFF2: SquadEntry = { playerId: 'of2', name: 'Delegado', number: 0, position: 'field', role: 'official' };
const withStaff = (over: Partial<Match> = {}) => makeMatch({ squad: [...SQUAD, OFF, OFF2], ...over });

let n = 0;
let repo: IndexedDbRepository;
let team: Team;
beforeEach(async () => {
  repo = new IndexedDbRepository(`oficiales-${++n}`);
  team = await createTeam(repo, { name: 'Senior Masculino A', code: 'SMA2627', season: '2026/27', maxSquad: 2 });
});

describe('plantilla', () => {
  it('alta de un oficial: sin dorsal real (0 técnico), con su rol; editar no cambia el rol', async () => {
    const o = await savePlayer(repo, team.id, { name: ' Ana ', number: 23, position: 'goalkeeper', active: true, role: 'official' });
    expect(o).toMatchObject({ name: 'Ana', number: 0, position: 'field', role: 'official' });
    const edited = await savePlayer(repo, team.id, { name: 'Ana López', number: 7, position: 'goalkeeper', active: false }, o);
    expect(edited).toMatchObject({ name: 'Ana López', number: 0, position: 'field', role: 'official', active: false });
    // Un jugador sigue igual y sin rol; no puede pasar a oficial al editarlo.
    const p = await savePlayer(repo, team.id, { name: 'Jugador', number: 0, position: 'field', active: true });
    expect(p).not.toHaveProperty('role');
    expect(await savePlayer(repo, team.id, { name: 'Jugador', number: 0, position: 'field', active: true, role: 'official' }, p)).not.toHaveProperty('role');
  });

  it('los oficiales no ocupan dorsal: varios oficiales y un jugador con el 0 conviven; el dorsal de jugadores sigue siendo único', async () => {
    await savePlayer(repo, team.id, { name: 'Ana', number: 0, position: 'field', active: true, role: 'official' });
    await savePlayer(repo, team.id, { name: 'Luis', number: 0, position: 'field', active: true, role: 'official' });
    await savePlayer(repo, team.id, { name: 'Cero', number: 0, position: 'field', active: true });
    await expect(savePlayer(repo, team.id, { name: 'Otro cero', number: 0, position: 'field', active: true })).rejects.toThrow(ValidationError);
  });

  it('sin límite de oficiales en la plantilla', async () => {
    for (let i = 0; i < 12; i++) await savePlayer(repo, team.id, { name: `Oficial ${i}`, number: 0, position: 'field', active: true, role: 'official' });
    expect((await repo.listPlayers(team.id)).length).toBe(12);
  });
});

describe('convocatoria', () => {
  async function roster() {
    const players: Player[] = [];
    for (const [num, pos] of [[7, 'field'], [1, 'goalkeeper']] as const) players.push(await savePlayer(repo, team.id, { name: `J${num}`, number: num, position: pos, active: true }));
    for (const name of ['Zoe', 'Ana']) players.push(await savePlayer(repo, team.id, { name, number: 0, position: 'field', active: true, role: 'official' }));
    return players;
  }

  it('los oficiales no cuentan para el máximo de convocados ni para los dorsales; van al final, por nombre', async () => {
    const players = await roster();
    // maxSquad = 2: dos jugadores y dos oficiales caben.
    const m = await svc.createMatch(repo, { teamId: team.id, opponent: 'Rival', date: '2026-11-01', venue: 'home', season: '2026/27', playerIds: players.map((p) => p.id) });
    expect(m.squad.map((s) => [s.name, s.role ?? 'player'])).toEqual([
      ['J7', 'player'],
      ['J1', 'player'],
      ['Ana', 'official'],
      ['Zoe', 'official'],
    ]);
  });

  it('solo oficiales no es una convocatoria válida', async () => {
    const players = await roster();
    const staff = players.filter((p) => p.role === 'official').map((p) => p.id);
    await expect(svc.createMatch(repo, { teamId: team.id, opponent: 'Rival', date: '2026-11-01', venue: 'home', season: '2026/27', playerIds: staff })).rejects.toThrow(/al menos un convocado/);
  });

  it('el aviso de las reglas IHF es de 5 oficiales', () => {
    expect(IHF_MAX_OFFICIALS).toBe(5);
  });
});

describe('acciones', () => {
  it('a un oficial solo amarilla, exclusión o roja', () => {
    expect(OFFICIAL_KINDS).toEqual(['yellow', 'exclusion', 'red']);
    const m = withStaff();
    for (const kind of ['shot', 'gk_shot', 'turnover', 'recovery', 'free_throw', 'penalty_committed'] as const) {
      expect(canReceive(OFF, kind), kind).toBe(false);
      expect(() => assertEligiblePlayer(m, kind, OFF.playerId), kind).toThrow(/cuerpo técnico/);
    }
    for (const kind of OFFICIAL_KINDS) {
      expect(canReceive(OFF, kind)).toBe(true);
      expect(() => assertEligiblePlayer(m, kind, OFF.playerId)).not.toThrow();
    }
    // Los jugadores, igual que antes.
    expect(canReceive(SQUAD[0]!, 'gk_shot')).toBe(false);
    expect(canReceive(SQUAD[3]!, 'gk_shot')).toBe(true);
  });

  it('registrar un gol a un oficial se rechaza; una exclusión se guarda como acción normal', async () => {
    const players = [await savePlayer(repo, team.id, { name: 'J7', number: 7, position: 'field', active: true }), await savePlayer(repo, team.id, { name: 'Ana', number: 0, position: 'field', active: true, role: 'official' })];
    const m = await svc.createMatch(repo, { teamId: team.id, opponent: 'Rival', date: '2026-11-01', venue: 'home', season: '2026/27', playerIds: players.map((p) => p.id) });
    await expect(svc.recordEvent(repo, m, goal(), players[1]!.id, { period: 1, matchTimeMs: 0 })).rejects.toThrow(/cuerpo técnico/);
    const e = await svc.recordEvent(repo, m, { kind: 'exclusion' }, players[1]!.id, { period: 1, matchTimeMs: 60_000 });
    expect(e).toMatchObject({ kind: 'exclusion', playerId: players[1]!.id });
  });
});

describe('disciplina e inferioridad', () => {
  const excl = (who: string, minute: number) => ev({ kind: 'exclusion' }, who, minute);

  it('tres exclusiones de un oficial no son roja por acumulación; las de un jugador, sí', () => {
    const m = withStaff();
    const events = [excl('of1', 2), excl('of1', 5), excl('of1', 9), excl('p7', 3), excl('p7', 6), excl('p7', 10)];
    const officials = officialIds(m.squad);
    expect(redCards(events, officials).map((c) => [c.playerId, c.type])).toEqual([['p7', 'accumulated']]);
    expect([...disqualifications(events, officials).keys()]).toEqual(['p7']);
  });

  it('la roja directa a un oficial sí lo descalifica', () => {
    const m = withStaff();
    expect(redCards([ev({ kind: 'red' }, 'of2', 4)], officialIds(m.squad))).toMatchObject([{ playerId: 'of2', type: 'direct' }]);
  });

  it('la exclusión y la roja de un oficial dejan al equipo con uno menos (2 minutos)', () => {
    const m = withStaff({ status: 'in_progress', clock: { period: 1, running: false, baseMs: 11 * 60_000, anchorWallMs: null } });
    const active = activeReductions(m, [excl('of1', 10), ev({ kind: 'red' }, 'of2', 10.5)], 0);
    expect(active.map((r) => [r.playerId, r.kind, r.remainingMs])).toEqual([
      ['of1', 'exclusion', 60_000],
      ['of2', 'red', 90_000],
    ]);
  });
});

describe('estadísticas y rankings', () => {
  const playerEvents = (): MatchEvent[] => [ev(goal(), 'p7', 1), ev(goal(), 'p14', 2), ev({ kind: 'exclusion' }, 'p7', 3), ev({ kind: 'yellow' }, 'p14', 4), ev({ kind: 'recovery' }, null, 5)];
  const staffEvents = (): MatchEvent[] => [ev({ kind: 'yellow' }, 'of1', 6), ev({ kind: 'exclusion' }, 'of1', 7), ev({ kind: 'red' }, 'of2', 8)];

  it('las sanciones del cuerpo técnico van aparte: el equipo, los jugadores y «sin asignar» no cambian', () => {
    const base = computeMatchStats(makeMatch(), playerEvents());
    const s = computeMatchStats(withStaff(), [...playerEvents(), ...staffEvents()]);
    expect(stableJson(s.team)).toBe(stableJson(base.team));
    expect(s.pendingCount).toBe(base.pendingCount);
    expect(stableJson(s.intervals)).toBe(stableJson(base.intervals));
    expect(s.score).toEqual(base.score);
    expect([...s.players.keys()].sort()).toEqual([...base.players.keys()].sort());
    expect(s.players.has('of1')).toBe(false);
    expect(s.officials).toMatchObject({ yellows: 1, exclusions: 1, reds: 1 });
    expect(s.officials.byOfficial.get('of1')).toEqual({ yellows: 1, exclusions: 1, reds: 0 });
    expect(s.officials.byOfficial.get('of2')).toEqual({ yellows: 0, exclusions: 0, reds: 1 });
    expect(base.officials).toMatchObject({ yellows: 0, exclusions: 0, reds: 0 });
  });

  it('temporada y rankings sin oficiales', () => {
    const m1 = withStaff({ id: 'm1' });
    const season = computeSeasonStats([{ match: m1, events: [...playerEvents(), ...staffEvents()] }]);
    expect([...season.players.keys()]).not.toContain('of1');
    expect(season.officials).toEqual({ yellows: 1, exclusions: 1, reds: 1 });
    for (const def of RANKINGS) expect(rankPlayers(def, seasonCandidates(season)).some((e) => e.player.playerId.startsWith('of'))).toBe(false);
  });
});

describe('huellas de sincronización', () => {
  /** Huella anterior a C3 (sin rol), tal como la tienen guardada los dispositivos. */
  const legacyPlayer = (p: Player) => {
    const { id, teamId, name, number, position, active, createdAt, updatedAt } = p;
    return stableJson({ id, teamId, name, number, position, active, createdAt, updatedAt });
  };

  it('jugadores y partidos sin oficiales: huellas idénticas a las de antes', () => {
    const p: Player = { id: 'p7', teamId: 't', name: 'J7', number: 7, position: 'field', active: true, createdAt: 'a', updatedAt: 'b' };
    expect(stableJson(playerContent(p))).toBe(legacyPlayer(p));
    const m = makeMatch();
    const legacySquad = m.squad.map(({ playerId, name, number, position }) => ({ playerId, name, number, position }));
    expect(stableJson(matchContent(m))).toBe(stableJson({ ...matchContent(m), squad: legacySquad }));
    const e = ev(goal(), 'p7', 3);
    expect(Object.keys(eventContent(e))).not.toContain('role');
  });

  it('el rol entra en la huella solo de los oficiales', () => {
    const o: Player = { id: 'of1', teamId: 't', name: 'Ana', number: 0, position: 'field', active: true, createdAt: 'a', updatedAt: 'b', role: 'official' };
    expect(playerContent(o)).toMatchObject({ role: 'official' });
    expect(stableJson(playerContent(o))).not.toBe(legacyPlayer(o));
    const squad = matchContent(withStaff()).squad as Record<string, unknown>[];
    expect(squad.filter((s) => 'role' in s).map((s) => s.playerId)).toEqual(['of1', 'of2']);
  });
});
