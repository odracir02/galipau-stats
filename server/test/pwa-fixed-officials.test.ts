// Cuerpo técnico automático entre dos entrenadores, con la PWA contra el Worker
// real en memoria: los puestos fijos se crean al sancionarlos, sin duplicados
// aunque los dos los usen a la vez. Datos sintéticos.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ObservableRepository } from '../../src/app/observableRepository';
import { IndexedDbRepository } from '../../src/data/indexedDbRepository';
import type { Match, Team } from '../../src/domain/types';
import * as svc from '../../src/services/matchService';
import { createTeam, savePlayer } from '../../src/services/teamService';
import { computeMatchStats } from '../../src/stats/engine';
import { createApi, type Api, type RemoteTeam } from '../../src/remote/api';
import { ClubSync } from '../../src/remote/clubsync';
import { TeamImporter } from '../../src/remote/importer';
import { TeamPuller } from '../../src/remote/pull';
import { AccountStore } from '../../src/remote/store';
import worker, { type Env } from '../src/index';
import { addClub, addDevice, addTeam, CODE_KEY, NOW, PEPPER } from './seed';
import { migratedDb, type SqliteD1 } from './sqliteD1';

const REMOTE = 'remoto-smb';
let n = 0;
let db: SqliteD1;
let env: Env;
let tokens: Record<'a' | 'b', string>;
const remoteTeam: RemoteTeam = { teamId: REMOTE, role: 'coach', status: 'active', name: 'Senior Masculino B', code: 'SMB2627', season: '2026/27', clubId: 'A', clubName: 'Club A' };
const count = (sql: string) => (db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get() as { n: number }).n;

async function device(name: string, token: string) {
  const local = new IndexedDbRepository(`local-${n}-${name}`);
  const repo = new ObservableRepository(local);
  const store = new AccountStore(`cuenta-${n}-${name}`);
  await store.saveDevice({ deviceId: name, token, joinedAt: NOW });
  const net = { down: false, writes: 0, failAfter: Infinity };
  const api: Api = createApi({
    baseUrl: 'https://api.example',
    fetch: async (input, init) => {
      if (net.down) throw new TypeError('Failed to fetch');
      if ((init?.method ?? 'GET') === 'POST' && net.writes++ >= net.failAfter) throw new TypeError('Failed to fetch');
      return worker.fetch(new Request(input as string, init), env);
    },
  });
  const teams = () => [remoteTeam];
  const importer = new TeamImporter(local, store, api, teams);
  repo.protectReadOnly(importer);
  await importer.load();
  const sync = new ClubSync(repo, store, api, teams);
  const puller = new TeamPuller(local, store, api, teams, undefined, () => void importer.load());
  sync.receiveWith(puller);
  return { local, repo, store, net, api, importer, sync, puller };
}
type Device = Awaited<ReturnType<typeof device>>;

/** Sanción a un puesto fijo como la pantalla del partido: el equipo del club se lee del vínculo. */
async function sanction(d: Device, localTeamId: string, matchId: string, slot: 'head' | 'assistant' | 'staff', kind: 'yellow' | 'exclusion' | 'red', s: number) {
  const link = await d.store.getLink(localTeamId);
  const { playerId, match, join } = await svc.prepareFixedOfficial(d.repo, (await d.local.getMatch(matchId))!, slot, link?.remoteTeamId ?? localTeamId);
  return svc.recordEvent(d.repo, match, { kind }, playerId, { period: 1, matchTimeMs: s * 1000 }, undefined, join);
}

let A: Device;
let team: Team;
let ids: string[];

beforeEach(async () => {
  n++;
  db = migratedDb();
  addClub(db, 'A');
  addTeam(db, REMOTE, 'A', 'SMB2627');
  env = { DB: db, TOKEN_PEPPER: PEPPER, INVITE_CODE_KEY: CODE_KEY, ENVIRONMENT: 'test', ALLOWED_ORIGINS: 'https://develop.galipau-stats.pages.dev' };
  tokens = {
    a: (await addDevice(db, 'iphone', [{ clubId: 'A', teamId: REMOTE, role: 'coach' }])).token,
    b: (await addDevice(db, 'tablet', [{ clubId: 'A', teamId: REMOTE, role: 'coach' }])).token,
  };
  A = await device('iphone', tokens.a);
  team = await createTeam(A.repo, { name: 'Senior Masculino B', code: 'SMB2627', season: '2026/27', maxSquad: 16 });
  ids = [];
  for (const [num, pos] of [[7, 'field'], [1, 'goalkeeper']] as const) ids.push((await savePlayer(A.repo, team.id, { name: `J${num}`, number: num, position: pos, active: true })).id);
  await A.sync.link(team.id, REMOTE);
});

const newMatch = async (d: Device, teamId: string, opponent: string, playerIds: string[]): Promise<Match> =>
  svc.createMatch(d.repo, { teamId, opponent, date: '2026-11-01', venue: 'home', season: '2026/27', playerIds });

describe('cuerpo técnico automático entre entrenadores', () => {
  it('un equipo que nunca sanciona al banquillo no tiene oficiales (ni bloqueo para versiones antiguas)', async () => {
    const m = await newMatch(A, team.id, 'Rival', ids);
    await svc.recordEvent(A.repo, m, { kind: 'exclusion' }, ids[0]!, { period: 1, matchTimeMs: 1000 });
    expect((await A.sync.upload(team.id)).status).toBe('verified');
    expect(count("players WHERE role = 'official'")).toBe(0);
  });

  it('dos entrenadores usan «Entrenador» a la vez, sin conexión: un solo oficial; las dos sanciones llegan, en orden, sin reenvíos', async () => {
    // Plantilla en el club e incorporación de B antes del partido.
    expect((await A.sync.upload(team.id)).status).toBe('verified');
    const B = await device('tablet', tokens.b);
    await B.importer.incorporate();
    const idB = (await B.store.getLinkByRemote(REMOTE))!.localTeamId;
    const playersB = (await B.local.listPlayers(idB)).map((p) => p.id);
    // Cada uno registra su partido sin conexión y sanciona al entrenador.
    A.net.down = true;
    B.net.down = true;
    const mA = await newMatch(A, team.id, 'Rival A', ids);
    const mB = await newMatch(B, idB, 'Rival B', playersB);
    const eA = await sanction(A, team.id, mA.id, 'head', 'yellow', 10);
    const eB = await sanction(B, idB, mB.id, 'head', 'exclusion', 20);
    expect(eA.playerId).toBe(`oficial-head-${REMOTE}`);
    expect(eB.playerId).toBe(eA.playerId);
    expect((await A.sync.upload(team.id)).status).toBe('stopped');
    expect(await A.sync.pending(team.id)).toEqual({ players: 1, matches: 1, events: 1, matchDeletions: 0 });
    // Vuelve la conexión: oficial → convocatoria → sanción; el segundo alta es la misma.
    A.net.down = false;
    B.net.down = false;
    expect((await A.sync.upload(team.id)).status).toBe('verified');
    expect((await B.sync.upload(idB)).status).toBe('verified');
    expect(count("players WHERE role = 'official'")).toBe(1);
    expect(count(`match_squad WHERE player_id = 'oficial-head-${REMOTE}'`)).toBe(2);
    expect(count(`events WHERE player_id = 'oficial-head-${REMOTE}'`)).toBe(2);
    // Nada pendiente ni que reenviar.
    A.net.writes = 0;
    B.net.writes = 0;
    expect((await A.sync.upload(team.id)).status).toBe('verified');
    expect((await B.sync.upload(idB)).status).toBe('verified');
    expect(A.net.writes + B.net.writes).toBe(0);
    // Cada uno recibe el partido del otro; un solo «Entrenador» en cada dispositivo.
    await A.puller.pull(team.id);
    await B.puller.pull(idB);
    for (const [d, tid] of [[A, team.id], [B, idB]] as const) {
      expect((await d.local.listPlayers(tid)).filter((p) => p.role === 'official').map((p) => p.name)).toEqual(['Entrenador']);
      const matches = await d.local.listMatches(tid);
      expect(matches).toHaveLength(2);
      for (const m of matches) {
        const s = computeMatchStats(m, await d.local.listEvents(m.id));
        expect(s.players.has(`oficial-head-${REMOTE}`)).toBe(false);
        expect(s.officials.yellows + s.officials.exclusions).toBe(1);
      }
    }
  });

  it('la conexión se corta a mitad del envío: la sanción y lo que necesita siguen pendientes y llegan después, sin duplicar', async () => {
    expect((await A.sync.upload(team.id)).status).toBe('verified');
    const m = await newMatch(A, team.id, 'Rival', ids);
    expect((await A.sync.upload(team.id)).status).toBe('verified');
    await sanction(A, team.id, m.id, 'head', 'red', 50);
    expect(await A.sync.pending(team.id)).toEqual({ players: 1, matches: 1, events: 1, matchDeletions: 0 });
    // Solo llega la primera escritura (el oficial); el resto falla.
    A.net.writes = 0;
    A.net.failAfter = 1;
    expect((await A.sync.upload(team.id)).status).not.toBe('verified');
    const left = await A.sync.pending(team.id);
    expect(left.matches + left.events).toBe(2);
    expect(count(`events WHERE player_id = 'oficial-head-${REMOTE}'`)).toBe(0);
    A.net.failAfter = Infinity;
    expect((await A.sync.upload(team.id)).status).toBe('verified');
    expect(await A.sync.pending(team.id)).toEqual({ players: 0, matches: 0, events: 0, matchDeletions: 0 });
    expect(count("players WHERE role = 'official'")).toBe(1);
    expect(count(`match_squad WHERE match_id = '${m.id}' AND role = 'official'`)).toBe(1);
    expect(count(`events WHERE player_id = 'oficial-head-${REMOTE}'`)).toBe(1);
  });

  it('el que no tiene el control de un partido en curso no consigue sancionar en el club', async () => {
    const m = await svc.toggleClock(A.repo, await newMatch(A, team.id, 'Rival', ids));
    await svc.recordEvent(A.repo, m, { kind: 'shot', shotType: 'nine_m', result: 'goal' }, ids[0]!, { period: 1, matchTimeMs: 1000 });
    expect((await A.sync.upload(team.id)).status).toBe('verified');
    const B = await device('tablet', tokens.b);
    await B.importer.incorporate();
    const idB = (await B.store.getLinkByRemote(REMOTE))!.localTeamId;
    await B.puller.pull(idB);
    // La pantalla de B es de consulta; aunque se forzara en el dispositivo, el club no lo acepta.
    const e = await sanction(B, idB, m.id, 'staff', 'yellow', 30);
    await B.sync.upload(idB);
    expect(count(`events WHERE id = '${e.id}'`)).toBe(0);
    expect(count(`match_squad WHERE match_id = '${m.id}' AND role = 'official'`)).toBe(0);
    expect(await B.local.getEvent(e.id)).toBeDefined();
  });
});
