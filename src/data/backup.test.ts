import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createMatch, deleteEvent, deleteMatch, finishMatch, recordEvent, toggleClock } from '../services/matchService';
import { createTeam, savePlayer } from '../services/teamService';
import { computeSeasonStats } from '../stats/engine';
import type { Match, MatchEvent, Player, Team } from '../domain/types';
import { BACKUP_FORMAT, BACKUP_VERSION, backupFileName, buildBackup, serializeBackup, validateBackup, type Backup } from './backup';
import { DB_VERSION, IndexedDbRepository, openStatsDb } from './indexedDbRepository';

let n = 0;
let repo: IndexedDbRepository;
let dbName: string;

beforeEach(() => {
  dbName = `copia-${++n}`;
  repo = new IndexedDbRepository(dbName);
});

const t = { period: 1 as const, matchTimeMs: 60_000 };
const goal = { kind: 'shot', shotType: 'nine_m', result: 'goal' } as const;

/** Dos equipos con plantilla, partidos (uno eliminado) y acciones variadas. */
async function seed() {
  const teams: Team[] = [];
  const players: Record<string, Player[]> = {};
  for (const [name, code] of [
    ['Senior Masculino A', 'SMA2627'],
    ['Senior Femenino A', 'SFA2627'],
  ] as const) {
    const team = await createTeam(repo, { name, code, season: '2026/27', maxSquad: 16 });
    teams.push(team);
    players[team.id] = [
      await savePlayer(repo, team.id, { name: 'Jugadora Siete', number: 7, position: 'field', active: true }),
      await savePlayer(repo, team.id, { name: 'Jugadora Diez', number: 10, position: 'field', active: true }),
      await savePlayer(repo, team.id, { name: 'Portera Uno', number: 1, position: 'goalkeeper', active: true }),
    ];
  }
  const [a] = teams as [Team, Team];
  const pa = players[a.id]!;
  const match = (date: string, opponent: string) =>
    createMatch(repo, { teamId: a.id, opponent, date, venue: 'home', season: '2026/27', playerIds: pa.map((p) => p.id) });
  const m1 = await toggleClock(repo, await match('2026-10-04', 'Rival Uno'));
  const m2 = await match('2026-10-18', 'Rival Dos');
  await recordEvent(repo, m1, goal, pa[0]!.id, t);
  await recordEvent(repo, m1, { kind: 'gk_shot', shotType: 'six_m', result: 'save' }, pa[2]!.id, t);
  await recordEvent(repo, m1, { kind: 'recovery' }, null, t); // pendiente de atribuir
  const removed = await recordEvent(repo, m1, { kind: 'exclusion' }, pa[1]!.id, t);
  await deleteEvent(repo, removed);
  await recordEvent(repo, m2, goal, pa[1]!.id, t);
  await finishMatch(repo, m1);
  const gone = await match('2026-10-01', 'Partido de prueba');
  await recordEvent(repo, gone, goal, pa[0]!.id, t);
  await deleteMatch(repo, gone);
  return { teams, players };
}

async function backupOf(now = new Date('2026-10-28T09:30:00Z')): Promise<Backup> {
  return buildBackup(await repo.readAll(), now, DB_VERSION);
}

describe('copia de seguridad', () => {
  it('incluye formato, versión, fecha y recuentos', async () => {
    await seed();
    const b = await backupOf();
    expect(b).toMatchObject({ format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: '2026-10-28T09:30:00.000Z', storageVersion: 1 });
    expect(b.counts).toEqual({ teams: 2, players: 6, matches: 3, events: 6 });
    expect(Object.keys(b).sort()).toEqual(['counts', 'events', 'exportedAt', 'format', 'matches', 'players', 'storageVersion', 'teams', 'version']);
  });

  it('el JSON se relee idéntico y supera la comprobación de integridad', async () => {
    await seed();
    const b = await backupOf();
    const parsed = JSON.parse(serializeBackup(b)) as Backup;
    expect(parsed).toEqual(b);
    expect(validateBackup(parsed)).toEqual([]);
  });

  it('conserva identificadores, relaciones y también lo eliminado y lo pendiente', async () => {
    const { teams } = await seed();
    const b = await backupOf();
    expect(new Set(b.teams.map((x) => x.id))).toEqual(new Set(teams.map((x) => x.id)));
    for (const list of [b.teams, b.players, b.matches, b.events] as { id: string }[][]) {
      expect(list.map((x) => x.id)).toEqual(list.map((x) => x.id).sort());
    }
    expect(b.matches.filter((m) => m.deletedAt !== null)).toHaveLength(1);
    expect(b.events.filter((e) => e.deletedAt !== null)).toHaveLength(1);
    expect(b.events.filter((e) => e.playerId === null)).toHaveLength(1);
    // Exactamente lo mismo que hay guardado, registro a registro.
    const snapshot = await repo.readAll();
    for (const key of ['teams', 'players', 'matches', 'events'] as const) {
      const byId = new Map((snapshot[key] as { id: string }[]).map((x) => [x.id, x]));
      for (const item of b[key] as { id: string }[]) expect(item).toEqual(byId.get(item.id));
    }
  });

  it('con la copia se obtienen exactamente las mismas estadísticas de temporada', async () => {
    const { teams } = await seed();
    const team = teams[0]!;
    const fromRepo = computeSeasonStats(
      await Promise.all((await repo.listMatches(team.id)).map(async (m) => ({ match: m, events: await repo.listEvents(m.id) }))),
    );
    const b = JSON.parse(serializeBackup(await backupOf())) as Backup;
    const matches = b.matches.filter((m: Match) => m.teamId === team.id && m.deletedAt === null);
    const fromBackup = computeSeasonStats(matches.map((m) => ({ match: m, events: b.events.filter((e: MatchEvent) => e.matchId === m.id) })));
    expect(fromBackup).toEqual(fromRepo);
    expect(fromBackup.matches).toBe(2);
  });

  it('es solo lectura: los datos y la estructura de la base local no cambian', async () => {
    await seed();
    const before = await repo.readAll();
    await backupOf();
    serializeBackup(await backupOf());
    expect(await repo.readAll()).toEqual(before);
    const db = await openStatsDb(dbName);
    expect(db.version).toBe(1);
    expect([...db.objectStoreNames].sort()).toEqual(['events', 'matches', 'players', 'teams']);
    db.close();
  });

  it('con la base vacía genera una copia válida y vacía', async () => {
    const b = await backupOf();
    expect(b.counts).toEqual({ teams: 0, players: 0, matches: 0, events: 0 });
    expect(validateBackup(JSON.parse(serializeBackup(b)))).toEqual([]);
  });

  it('no incluye credenciales: solo los cuatro tipos de datos de la app', async () => {
    await seed();
    const text = serializeBackup(await backupOf());
    expect(text).not.toMatch(/token|pepper|secret|password|Bearer|INVITE_CODE/i);
  });

  it('nombre de archivo reconocible con la fecha local', () => {
    expect(backupFileName(new Date(2026, 9, 28, 23, 50))).toBe('galipaustats-backup-2026-10-28.json');
    expect(backupFileName(new Date(2027, 0, 5, 0, 10))).toBe('galipaustats-backup-2027-01-05.json');
  });
});

describe('comprobación de integridad', () => {
  it('detecta formato, versión, recuentos, duplicados y relaciones rotas', async () => {
    await seed();
    const good = JSON.parse(serializeBackup(await backupOf())) as Backup;
    expect(validateBackup(null)).toEqual(['No es un objeto.']);
    expect(validateBackup({ ...good, format: 'otro' })).toContain('Formato desconocido.');
    expect(validateBackup({ ...good, version: 2 })[0]).toMatch(/Versión de formato/);
    expect(validateBackup({ ...good, counts: { ...good.counts, events: 99 } })).toContain('El recuento de «events» no coincide.');
    const dup = { ...good, teams: [...good.teams, good.teams[0]!], counts: { ...good.counts, teams: good.teams.length + 1 } };
    expect(validateBackup(dup).some((p) => p.startsWith('Identificador repetido en «teams»'))).toBe(true);
    const orphan = { ...good, players: good.players.slice(1), counts: { ...good.counts, players: good.players.length - 1 } };
    expect(validateBackup(orphan).some((p) => /sin jugador en la copia|jugador que no está/.test(p))).toBe(true);
    const lost = { ...good, matches: [], counts: { ...good.counts, matches: 0 } };
    expect(validateBackup(lost).some((p) => p.includes('partido que no está'))).toBe(true);
  });
});
