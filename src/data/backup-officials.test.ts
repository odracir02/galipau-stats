// Copias JSON con cuerpo técnico (role: 'official'): se exportan, se comprueban
// y se cargan en una base local nueva sin perder el rol, las convocatorias ni
// las sanciones. Las copias anteriores (sin rol) siguen igual. Datos sintéticos.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createMatch, finishMatch, recordEvent, toggleClock } from '../services/matchService';
import { createTeam, savePlayer } from '../services/teamService';
import { computeMatchStats, computeSeasonStats } from '../stats/engine';
import { RANKINGS, rankPlayers, seasonCandidates } from '../stats/rankings';
import type { Player, Team } from '../domain/types';
import { buildBackup, serializeBackup, validateBackup, type Backup } from './backup';
import { DB_VERSION, IndexedDbRepository } from './indexedDbRepository';

let n = 0;
let repo: IndexedDbRepository;
let team: Team;
let players: Player[];
let staff: Player[];

beforeEach(async () => {
  repo = new IndexedDbRepository(`copia-oficiales-${++n}`);
  team = await createTeam(repo, { name: 'Senior Femenino A', code: 'SFA2627', season: '2026/27', maxSquad: 16 });
  players = [];
  for (const [num, pos] of [[7, 'field'], [0, 'field'], [1, 'goalkeeper']] as const) {
    players.push(await savePlayer(repo, team.id, { name: `Jugadora ${num}`, number: num, position: pos, active: true }));
  }
  staff = [];
  for (const name of ['Entrenadora', 'Delegado', 'Fisio']) {
    staff.push(await savePlayer(repo, team.id, { name, number: 0, position: 'field', active: true, role: 'official' }));
  }
  let m = await createMatch(repo, { teamId: team.id, opponent: 'Rival', date: '2026-11-01', venue: 'home', season: '2026/27', playerIds: [...players, ...staff].map((p) => p.id) });
  m = await toggleClock(repo, m, 1_000);
  await recordEvent(repo, m, { kind: 'shot', shotType: 'nine_m', result: 'goal' }, players[0]!.id, { period: 1, matchTimeMs: 60_000 });
  await recordEvent(repo, m, { kind: 'exclusion' }, players[1]!.id, { period: 1, matchTimeMs: 90_000 });
  await recordEvent(repo, m, { kind: 'yellow' }, staff[0]!.id, { period: 1, matchTimeMs: 120_000 });
  await recordEvent(repo, m, { kind: 'exclusion' }, staff[1]!.id, { period: 1, matchTimeMs: 180_000 });
  await recordEvent(repo, m, { kind: 'red' }, staff[1]!.id, { period: 1, matchTimeMs: 200_000 });
  await finishMatch(repo, m, 2_000);
});

/** Exporta, pasa por JSON y la carga en una base local nueva, equipo a equipo. */
async function roundTrip(backup: Backup) {
  const parsed = JSON.parse(serializeBackup(backup)) as Backup;
  expect(validateBackup(parsed)).toEqual([]);
  const target = new IndexedDbRepository(`copia-destino-${n}-${Math.random()}`);
  for (const t of parsed.teams) {
    const matches = parsed.matches.filter((m) => m.teamId === t.id);
    const ids = new Set(matches.map((m) => m.id));
    await target.addTeamData({ team: t, players: parsed.players.filter((p) => p.teamId === t.id), matches, events: parsed.events.filter((e) => ids.has(e.matchId)) });
  }
  return target;
}

describe('copias JSON con cuerpo técnico', () => {
  it('se conservan el rol, los nombres, las convocatorias y las sanciones; las cifras son las mismas', async () => {
    const original = await repo.readAll();
    const restored = await roundTrip(buildBackup(original, new Date(), DB_VERSION));
    const copy = await restored.readAll();
    expect(copy).toEqual(original);
    const officials = copy.players.filter((p) => p.role === 'official');
    expect(officials.map((p) => p.name).sort()).toEqual(['Delegado', 'Entrenadora', 'Fisio']);
    expect(officials.every((p) => p.number === 0 && p.position === 'field')).toBe(true);
    expect(copy.players.filter((p) => p.role === undefined)).toHaveLength(3);
    expect(copy.matches[0]!.squad.filter((s) => s.role === 'official')).toHaveLength(3);

    const before = computeMatchStats(original.matches[0]!, original.events);
    const after = computeMatchStats(copy.matches[0]!, copy.events);
    expect(after.officials).toMatchObject({ yellows: 1, exclusions: 1, reds: 1 });
    expect(after.team).toEqual(before.team);
    expect([...after.players.keys()].sort()).toEqual([...before.players.keys()].sort());
    expect(after.players.has(staff[0]!.id)).toBe(false);
    expect(after.pendingCount).toBe(0);

    // No son jugadores ni entran en los rankings.
    const season = computeSeasonStats([{ match: copy.matches[0]!, events: copy.events }]);
    const staffIds = new Set(officials.map((p) => p.id));
    expect([...season.players.keys()].some((id) => staffIds.has(id))).toBe(false);
    for (const def of RANKINGS) expect(rankPlayers(def, seasonCandidates(season)).some((e) => staffIds.has(e.player.playerId))).toBe(false);
  });

  it('una copia anterior (sin rol) se carga igual y todos siguen siendo jugadores', async () => {
    // Copia de antes del cuerpo técnico: sin oficiales ni campo de rol.
    const old = await repo.readAll();
    const staffIds = new Set(staff.map((p) => p.id));
    const legacy = buildBackup(
      {
        ...old,
        players: old.players.filter((p) => !staffIds.has(p.id)),
        matches: old.matches.map((m) => ({ ...m, squad: m.squad.filter((s) => !staffIds.has(s.playerId)) })),
        events: old.events.filter((e) => e.playerId === null || !staffIds.has(e.playerId)),
      },
      new Date(),
      DB_VERSION,
    );
    expect(serializeBackup(legacy)).not.toContain('"role"');
    const copy = await (await roundTrip(legacy)).readAll();
    expect(copy.players).toHaveLength(3);
    expect(copy.players.every((p) => !('role' in p))).toBe(true);
    const stats = computeMatchStats(copy.matches[0]!, copy.events);
    expect([...stats.players.keys()]).toHaveLength(3);
    expect(stats.officials).toMatchObject({ yellows: 0, exclusions: 0, reds: 0 });
    expect(stats.team.exclusions).toBe(1);
  });
});
