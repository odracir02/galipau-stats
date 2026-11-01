// Cuerpo técnico entre dos entrenadores, con la PWA (que declara conocerlo)
// contra el Worker real en memoria. Datos sintéticos.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ObservableRepository } from '../../src/app/observableRepository';
import { IndexedDbRepository } from '../../src/data/indexedDbRepository';
import type { Match, Player, Team } from '../../src/domain/types';
import * as svc from '../../src/services/matchService';
import { createTeam, savePlayer } from '../../src/services/teamService';
import { computeMatchStats } from '../../src/stats/engine';
import { createApi, type Api, type RemoteTeam } from '../../src/remote/api';
import { ClubSync } from '../../src/remote/clubsync';
import { TeamImporter } from '../../src/remote/importer';
import { TeamPuller } from '../../src/remote/pull';
import { AccountStore } from '../../src/remote/store';
import { stableJson } from '../../src/remote/upload';
import worker, { type Env } from '../src/index';
import { addClub, addDevice, addTeam, CODE_KEY, NOW, PEPPER } from './seed';
import { migratedDb, type SqliteD1 } from './sqliteD1';

const REMOTE = 'remoto-sma';
let n = 0;
let db: SqliteD1;
let env: Env;
let tokens: Record<'a' | 'b' | 'viewer', string>;

const remoteTeam = (role: RemoteTeam['role'] = 'coach'): RemoteTeam => ({ teamId: REMOTE, role, status: 'active', name: 'Senior Masculino A', code: 'SMA2627', season: '2026/27', clubId: 'A', clubName: 'Club A' });

async function device(name: string, token: string, role: RemoteTeam['role'] = 'coach') {
  const local = new IndexedDbRepository(`local-${n}-${name}`);
  const repo = new ObservableRepository(local);
  const store = new AccountStore(`cuenta-${n}-${name}`);
  await store.saveDevice({ deviceId: name, token, joinedAt: NOW });
  const net = { down: false, writes: 0, headers: new Set<string>() };
  const api: Api = createApi({
    baseUrl: 'https://api.example',
    fetch: async (input, init) => {
      if (net.down) throw new TypeError('Failed to fetch');
      if ((init?.method ?? 'GET') === 'POST') net.writes++;
      net.headers.add((init?.headers as Record<string, string>)['X-GalipauStats-Features'] ?? '(sin cabecera)');
      return worker.fetch(new Request(input as string, init), env);
    },
  });
  const teams = () => [remoteTeam(role)];
  const importer = new TeamImporter(local, store, api, teams);
  repo.protectReadOnly(importer);
  await importer.load();
  const sync = new ClubSync(repo, store, api, teams);
  const puller = new TeamPuller(local, store, api, teams, undefined, () => void importer.load());
  sync.receiveWith(puller);
  return { local, repo, store, net, api, importer, sync, puller };
}

let A: Awaited<ReturnType<typeof device>>;
let team: Team;
let players: Player[];
let staff: Player[];
let match: Match;

beforeEach(async () => {
  n++;
  db = migratedDb();
  addClub(db, 'A');
  addTeam(db, REMOTE, 'A', 'SMA2627');
  env = { DB: db, TOKEN_PEPPER: PEPPER, INVITE_CODE_KEY: CODE_KEY, ENVIRONMENT: 'test', ALLOWED_ORIGINS: 'https://develop.galipau-stats.pages.dev' };
  tokens = {
    a: (await addDevice(db, 'iphone', [{ clubId: 'A', teamId: REMOTE, role: 'coach' }])).token,
    b: (await addDevice(db, 'tablet', [{ clubId: 'A', teamId: REMOTE, role: 'coach' }])).token,
    viewer: (await addDevice(db, 'familia', [{ clubId: 'A', teamId: REMOTE, role: 'viewer' }])).token,
  };
  A = await device('iphone', tokens.a);
  team = await createTeam(A.repo, { name: 'Senior Masculino A', code: 'SMA2627', season: '2026/27', maxSquad: 16 });
  players = [];
  for (const [num, pos] of [[7, 'field'], [0, 'field'], [1, 'goalkeeper']] as const) {
    players.push(await savePlayer(A.repo, team.id, { name: `Jugador ${num}`, number: num, position: pos, active: true }));
  }
  staff = [];
  for (const name of ['Ana (entrenadora)', 'Luis (delegado)']) {
    staff.push(await savePlayer(A.repo, team.id, { name, number: 0, position: 'field', active: true, role: 'official' }));
  }
  match = await svc.createMatch(A.repo, { teamId: team.id, opponent: 'Rival', date: '2026-11-01', venue: 'home', season: '2026/27', playerIds: [...players, ...staff].map((p) => p.id) });
  match = await svc.toggleClock(A.repo, match);
  await svc.recordEvent(A.repo, match, { kind: 'shot', shotType: 'nine_m', result: 'goal' }, players[0]!.id, { period: 1, matchTimeMs: 60_000 });
  await svc.recordEvent(A.repo, match, { kind: 'shot', shotType: 'six_m', result: 'goal' }, players[1]!.id, { period: 1, matchTimeMs: 90_000 });
  await svc.recordEvent(A.repo, match, { kind: 'yellow' }, staff[0]!.id, { period: 1, matchTimeMs: 120_000 });
  await svc.recordEvent(A.repo, match, { kind: 'exclusion' }, staff[1]!.id, { period: 1, matchTimeMs: 180_000 });
  await A.sync.link(team.id, REMOTE);
});

describe('cuerpo técnico entre entrenadores', () => {
  it('se envía con su rol, sin dorsal real; reenviar no manda nada', async () => {
    expect((await A.sync.upload(team.id)).status).toBe('verified');
    expect(A.net.headers).toEqual(new Set(['officials']));
    expect(db.sqlite.prepare("SELECT name, number, role FROM players WHERE role = 'official' ORDER BY name").all()).toEqual([
      { name: 'Ana (entrenadora)', number: 0, role: 'official' },
      { name: 'Luis (delegado)', number: 0, role: 'official' },
    ]);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM match_squad WHERE role = 'official'").get()).toEqual({ n: 2 });
    expect(db.sqlite.prepare("SELECT kind, role FROM events e JOIN players p ON p.id = e.player_id WHERE p.role = 'official' ORDER BY match_time_ms").all()).toEqual([
      { kind: 'yellow', role: 'official' },
      { kind: 'exclusion', role: 'official' },
    ]);
    A.net.writes = 0;
    expect((await A.sync.upload(team.id)).status).toBe('verified');
    expect(A.net.writes).toBe(0);
    expect(await A.sync.pending(team.id)).toEqual({ players: 0, matches: 0, events: 0, matchDeletions: 0 });
  });

  it('el otro entrenador los recibe igual: mismas estadísticas, sanciones aparte y nada pendiente', async () => {
    expect((await A.sync.upload(team.id)).status).toBe('verified');
    const B = await device('tablet', tokens.b);
    await B.importer.incorporate();
    const idB = (await B.store.getLinkByRemote(REMOTE))!.localTeamId;
    const local = await B.local.readAll();
    expect(local.players.filter((p) => p.role === 'official').map((p) => p.name).sort()).toEqual(['Ana (entrenadora)', 'Luis (delegado)']);
    const mB = local.matches[0]!;
    expect(mB.squad.filter((s) => s.role === 'official')).toHaveLength(2);
    const statsA = computeMatchStats((await A.local.getMatch(match.id))!, await A.local.listEvents(match.id));
    const statsB = computeMatchStats(mB, local.events);
    const comparable = (st: typeof statsA) =>
      stableJson({ ...st, players: [...st.players.entries()].sort(), officials: { ...st.officials, byOfficial: [...st.officials.byOfficial.entries()].sort() } });
    expect(comparable(statsB)).toBe(comparable(statsA));
    expect(statsB.officials).toMatchObject({ yellows: 1, exclusions: 1, reds: 0 });
    expect(statsB.pendingCount).toBe(0);
    expect(await B.sync.pending(idB)).toEqual({ players: 0, matches: 0, events: 0, matchDeletions: 0 });
    // B edita el nombre de un oficial: se envía conservando el rol.
    const ana = local.players.find((p) => p.name.startsWith('Ana'))!;
    await savePlayer(B.repo, idB, { name: 'Ana López', number: 0, position: 'field', active: true }, ana);
    B.net.writes = 0;
    expect((await B.sync.upload(idB)).status).toBe('verified');
    expect(B.net.writes).toBe(1);
    expect(db.sqlite.prepare('SELECT name, role FROM players WHERE id = ?').get(ana.id)).toEqual({ name: 'Ana López', role: 'official' });
    // A lo recibe.
    await A.puller.pull(team.id);
    expect((await A.local.listPlayers(team.id)).find((p) => p.id === ana.id)).toMatchObject({ name: 'Ana López', role: 'official' });
  });

  it('sin conexión: la sanción del oficial queda pendiente y se envía una sola vez al volver', async () => {
    expect((await A.sync.upload(team.id)).status).toBe('verified');
    A.net.down = true;
    const red = await svc.recordEvent(A.repo, (await A.local.getMatch(match.id))!, { kind: 'red' }, staff[0]!.id, { period: 1, matchTimeMs: 240_000 });
    expect((await A.sync.upload(team.id)).status).toBe('stopped');
    expect((await A.sync.pending(team.id)).events).toBe(1);
    A.net.down = false;
    expect((await A.sync.upload(team.id)).status).toBe('verified');
    expect((await A.sync.upload(team.id)).status).toBe('verified');
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM events WHERE id = ?').get(red.id)).toEqual({ n: 1 });
  });

  it('consulta: recibe el cuerpo técnico, pero no puede escribir', async () => {
    expect((await A.sync.upload(team.id)).status).toBe('verified');
    const V = await device('familia', tokens.viewer, 'viewer');
    const snap = await V.api.snapshot(tokens.viewer, REMOTE);
    expect(snap.players.filter((p) => p.player.role === 'official')).toHaveLength(2);
    await expect(
      V.api.syncPlayer(tokens.viewer, { opId: 'v', teamId: REMOTE, baseVersion: null, record: { ...staff[0]!, id: 'nuevo', teamId: REMOTE } }),
    ).rejects.toMatchObject({ kind: 'forbidden' });
  });
});
