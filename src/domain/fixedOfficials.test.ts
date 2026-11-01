// Cuerpo técnico automático: tres puestos fijos que se crean y se convocan solos
// la primera vez que se sancionan, en la misma transacción que la sanción.
// Datos sintéticos.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ObservableRepository, ReadOnlyTeamError } from '../app/observableRepository';
import { IndexedDbRepository } from '../data/indexedDbRepository';
import * as svc from '../services/matchService';
import { createTeam, savePlayer } from '../services/teamService';
import { computeMatchStats, computeSeasonStats } from '../stats/engine';
import { RANKINGS, rankPlayers, seasonCandidates } from '../stats/rankings';
import { fixedOfficialId, fixedPick, fixedSlotOf, FIXED_OFFICIALS, officialLabel, pickedSlot, staffOptions } from './officials';
import type { Match, Player, Team } from './types';

let n = 0;
let local: IndexedDbRepository;
let repo: ObservableRepository;
let team: Team;
let players: Player[];
let match: Match;
const readOnly = new Set<string>();
const T = (s: number) => ({ period: 1 as const, matchTimeMs: s * 1000 });

beforeEach(async () => {
  local = new IndexedDbRepository(`fijos-${++n}`);
  repo = new ObservableRepository(local);
  readOnly.clear();
  repo.protectReadOnly({ any: () => readOnly.size > 0, isReadOnly: async (id) => readOnly.has(id) });
  team = await createTeam(repo, { name: 'Senior Masculino B', code: 'SMB2627', season: '2026/27', maxSquad: 16 });
  players = [];
  for (const [num, pos] of [[7, 'field'], [1, 'goalkeeper']] as const) players.push(await savePlayer(repo, team.id, { name: `J${num}`, number: num, position: pos, active: true }));
  match = await svc.createMatch(repo, { teamId: team.id, opponent: 'Rival', date: '2026-11-01', venue: 'home', season: '2026/27', playerIds: players.map((p) => p.id) });
  match = await svc.toggleClock(repo, match);
});

/** Sanción a un puesto fijo como lo hace la pantalla del partido. */
async function sanction(slot: 'head' | 'assistant' | 'staff', kind: 'yellow' | 'exclusion' | 'red', at: number, key = 'remoto-smb', id?: string) {
  const current = (await repo.getMatch(match.id))!;
  const { playerId, match: target, join } = await svc.prepareFixedOfficial(repo, current, slot, key);
  const e = await svc.recordEvent(repo, target, { kind }, playerId, T(at), id, join);
  return { e, target };
}

describe('puestos fijos', () => {
  it('tres opciones fijas, con identificador estable por equipo del club y puesto', () => {
    expect(FIXED_OFFICIALS.map((f) => f.name)).toEqual(['Entrenador', 'Segundo entrenador', 'Cuerpo técnico']);
    expect(fixedOfficialId('head', 'remoto-smb')).toBe('oficial-head-remoto-smb');
    expect(fixedSlotOf('oficial-assistant-remoto-smb')).toBe('assistant');
    expect(fixedSlotOf('a1b2c3')).toBeNull();
    expect(pickedSlot(fixedPick('staff'))).toBe('staff');
    expect(pickedSlot('oficial-head-x')).toBeNull();
    // En el selector: los tres puestos (convocados o no) en su orden y después los demás oficiales.
    const manual = { playerId: 'manual', name: 'Ana', number: 0, position: 'field' as const, role: 'official' as const };
    const convoked = { playerId: 'oficial-assistant-r', name: 'Segundo entrenador', number: 0, position: 'field' as const, role: 'official' as const };
    expect(staffOptions([manual, convoked], FIXED_OFFICIALS.filter((f) => f.slot !== 'assistant')).map((s) => s.name)).toEqual(['Entrenador', 'Segundo entrenador', 'Cuerpo técnico', 'Ana']);
    expect(officialLabel(convoked)).toBe('Segundo entrenador');
    expect(officialLabel(manual)).toBe('Ana · cuerpo técnico');
  });

  it('sin oficiales en la plantilla: la primera sanción crea el oficial, lo convoca y guarda la sanción, todo junto', async () => {
    expect((await repo.listPlayers(team.id)).some((p) => p.role === 'official')).toBe(false);
    const changes: string[] = [];
    repo.onChange((c) => changes.push(c.entity));
    const { e } = await sanction('head', 'exclusion', 30);
    const official = await repo.getPlayer('oficial-head-remoto-smb');
    expect(official).toMatchObject({ teamId: team.id, name: 'Entrenador', number: 0, position: 'field', role: 'official', active: true });
    const saved = (await repo.getMatch(match.id))!;
    expect(saved.squad.at(-1)).toEqual({ playerId: official!.id, name: 'Entrenador', number: 0, position: 'field', role: 'official' });
    expect(await repo.getEvent(e.id)).toMatchObject({ kind: 'exclusion', playerId: official!.id });
    expect(changes.sort()).toEqual(['event', 'match', 'player']);
  });

  it('la segunda vez no crea ni convoca nada más: solo la sanción', async () => {
    await sanction('head', 'yellow', 10);
    const before = (await repo.getMatch(match.id))!;
    const second = await svc.prepareFixedOfficial(repo, before, 'head', 'remoto-smb');
    expect(second.join).toEqual({ player: null, match: null });
    await svc.recordEvent(repo, second.match, { kind: 'exclusion' }, second.playerId, T(20), undefined, second.join);
    expect((await repo.getMatch(match.id))!).toEqual(before);
    expect((await repo.listPlayers(team.id)).filter((p) => p.role === 'official')).toHaveLength(1);
    expect(await repo.listEvents(match.id)).toHaveLength(2);
  });

  it('reintentos y pulsaciones repetidas (mismo id): ni oficiales, ni convocados, ni sanciones duplicados', async () => {
    await sanction('assistant', 'red', 15, 'remoto-smb', 'sancion-1');
    await sanction('assistant', 'red', 15, 'remoto-smb', 'sancion-1');
    expect((await repo.getMatch(match.id))!.squad.filter((s) => s.playerId === 'oficial-assistant-remoto-smb')).toHaveLength(1);
    expect((await repo.listPlayers(team.id)).filter((p) => p.role === 'official')).toHaveLength(1);
    expect(await repo.listEvents(match.id)).toHaveLength(1);
  });

  it('nunca un gol, lanzamiento u otra acción: se rechaza y no queda nada a medias', async () => {
    const current = (await repo.getMatch(match.id))!;
    const { playerId, match: target, join } = await svc.prepareFixedOfficial(repo, current, 'staff', 'remoto-smb');
    await expect(svc.recordEvent(repo, target, { kind: 'shot', shotType: 'nine_m', result: 'goal' }, playerId, T(5), undefined, join)).rejects.toThrow(/cuerpo técnico/);
    expect(await repo.getPlayer(playerId)).toBeUndefined();
    expect((await repo.getMatch(match.id))!).toEqual(current);
    expect(await repo.listEvents(match.id)).toHaveLength(0);
  });

  it('si falla el guardado de cualquiera de los tres, no queda ninguno (una sola transacción)', async () => {
    const current = (await repo.getMatch(match.id))!;
    const { playerId, match: target, join } = await svc.prepareFixedOfficial(repo, current, 'head', 'remoto-smb');
    const broken = { id: undefined, matchId: match.id, kind: 'yellow', playerId, period: 1, matchTimeMs: 0, createdAt: 'a', updatedAt: 'a', deletedAt: null } as unknown as Parameters<typeof local.saveEvent>[0];
    await expect(local.saveTogether({ players: [join.player!], matches: [target], events: [broken] })).rejects.toThrow();
    expect(await repo.getPlayer(playerId)).toBeUndefined();
    expect((await repo.getMatch(match.id))!).toEqual(current);
    expect(await repo.listEvents(match.id)).toHaveLength(0);
  });

  it('sin permiso para modificar el equipo (copia de solo lectura): no se guarda nada', async () => {
    readOnly.add(team.id);
    await expect(sanction('head', 'yellow', 5)).rejects.toBeInstanceOf(ReadOnlyTeamError);
    expect(await repo.getPlayer('oficial-head-remoto-smb')).toBeUndefined();
    expect((await repo.getMatch(match.id))!.squad).toHaveLength(2);
    expect(await repo.listEvents(match.id)).toHaveLength(0);
  });

  it('partido histórico: se convoca el puesto al sancionarlo; sus acciones y cifras de jugadores no cambian', async () => {
    await svc.recordEvent(repo, match, { kind: 'shot', shotType: 'nine_m', result: 'goal' }, players[0]!.id, T(1));
    match = await svc.finishMatch(repo, (await repo.getMatch(match.id))!);
    const events = await repo.listEvents(match.id);
    const before = computeMatchStats(match, events);
    await sanction('head', 'exclusion', 40);
    const after = (await repo.getMatch(match.id))!;
    const all = await repo.listEvents(match.id);
    expect(all.filter((e) => events.some((x) => x.id === e.id))).toEqual(events);
    const stats = computeMatchStats(after, all);
    expect(stats.team).toEqual(before.team);
    expect([...stats.players.keys()]).toEqual([...before.players.keys()]);
    expect(stats.officials).toMatchObject({ exclusions: 1 });
    // Nunca como jugadores ni en los rankings.
    const season = computeSeasonStats([{ match: after, events: all }]);
    expect(season.players.has('oficial-head-remoto-smb')).toBe(false);
    for (const def of RANKINGS) expect(rankPlayers(def, seasonCandidates(season)).some((r) => fixedSlotOf(r.player.playerId))).toBe(false);
  });

  it('corregir una acción para atribuirla a un puesto fijo: se convoca y se guarda junto', async () => {
    const pending = await svc.recordEvent(repo, match, { kind: 'yellow' }, null, T(3));
    const current = (await repo.getMatch(match.id))!;
    const { playerId, match: target, join } = await svc.prepareFixedOfficial(repo, current, 'staff', 'remoto-smb');
    const fixed = await svc.updateEvent(repo, target, pending, { playerId }, join);
    expect(fixed.playerId).toBe('oficial-staff-remoto-smb');
    expect((await repo.getMatch(match.id))!.squad.some((s) => s.playerId === playerId)).toBe(true);
    expect(computeMatchStats((await repo.getMatch(match.id))!, await repo.listEvents(match.id)).pendingCount).toBe(0);
  });

  it('equipo sin vincular: identificador del equipo local; el puesto ya convocado de un vínculo anterior se reutiliza', async () => {
    await sanction('head', 'yellow', 2, team.id);
    expect(await repo.getPlayer(`oficial-head-${team.id}`)).toBeDefined();
    // Después se vincula: en este partido sigue usándose el ya convocado (no otro «Entrenador»).
    const again = await svc.prepareFixedOfficial(repo, (await repo.getMatch(match.id))!, 'head', 'remoto-smb');
    expect(again.playerId).toBe(`oficial-head-${team.id}`);
    expect(again.join).toEqual({ player: null, match: null });
  });
});
