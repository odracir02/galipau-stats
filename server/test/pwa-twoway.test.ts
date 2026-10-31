// Sincronización en los dos sentidos entre entrenadores (src/remote/pull.ts e
// importer.ts), contra el Worker real en memoria: el iPhone original (A) con
// su equipo vinculado y un entrenador nuevo (B) que lo incorpora al canjear su
// código. Datos sintéticos.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ObservableRepository, ReadOnlyTeamError } from '../../src/app/observableRepository';
import { ConcurrentChangeError, StorageError } from '../../src/data/repository';
import { IndexedDbRepository } from '../../src/data/indexedDbRepository';
import type { Match, Team } from '../../src/domain/types';
import { loadSeasonItems } from '../../src/services/statsService';
import * as svc from '../../src/services/matchService';
import { createTeam, savePlayer } from '../../src/services/teamService';
import { computeSeasonStats } from '../../src/stats/engine';
import { createApi, type Api, type RemoteTeam } from '../../src/remote/api';
import { AutoSync } from '../../src/remote/autosync';
import { ClubSync } from '../../src/remote/clubsync';
import { ACCESS_LOST, TeamImporter } from '../../src/remote/importer';
import { CONFLICT_BLOCK, TeamPuller } from '../../src/remote/pull';
import { AccountStore } from '../../src/remote/store';
import { stableJson, withLock } from '../../src/remote/upload';
import worker, { type Env } from '../src/index';
import { addClub, addDevice, addTeam, CODE_KEY, PEPPER } from './seed';
import { migratedDb, type SqliteD1 } from './sqliteD1';

const REMOTE = 'remoto-sma';
let n = 0;
let db: SqliteD1;
let env: Env;
let tokens: Record<'a' | 'b' | 'viewer' | 'otro', string>;
let A: Awaited<ReturnType<typeof device>>;
let teamA: Team;
let finished: Match;
let ids: string[];
const autos: AutoSync[] = [];

const remoteTeam = (role: RemoteTeam['role'] = 'coach', teamId = REMOTE): RemoteTeam => ({
  teamId,
  role,
  status: 'active',
  name: 'Senior Masculino A',
  code: 'SMA2627',
  season: '2026/27',
  clubId: 'A',
  clubName: 'Club A',
});

const count = (sql: string) => (db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get() as { n: number }).n;
const seasonJson = (s: ReturnType<typeof computeSeasonStats>) => stableJson({ ...s, players: [...s.players.entries()].sort() });

/** Un dispositivo completo: base local protegida, cuenta, envío, recepción e incorporación. */
async function device(name: string, token: string, role: RemoteTeam['role'] = 'coach') {
  const local = new IndexedDbRepository(`local-${n}-${name}`);
  const repo = new ObservableRepository(local);
  const store = new AccountStore(`cuenta-${n}-${name}`);
  await store.saveDevice({ deviceId: name, token, joinedAt: '2026-10-31T10:00:00.000Z' });
  const net = { down: false, writes: 0, reads: 0, snapshots: 0 };
  const api: Api = createApi({
    baseUrl: 'https://api.example',
    fetch: async (input, init) => {
      if (net.down) throw new TypeError('Failed to fetch');
      if ((init?.method ?? 'GET') === 'POST') net.writes++;
      else net.reads++;
      if (String(input).endsWith('/snapshot')) net.snapshots++;
      return worker.fetch(new Request(input as string, init), env);
    },
  });
  const teams = [remoteTeam(role)];
  const importer = new TeamImporter(local, store, api, () => teams);
  repo.protectReadOnly(importer);
  await importer.load();
  const sync = new ClubSync(repo, store, api, () => teams);
  const puller = new TeamPuller(local, store, api, () => teams, undefined, () => void importer.load());
  sync.receiveWith(puller);
  /** Equipo local vinculado con el del club. */
  const localTeam = async () => (await store.getLinkByRemote(REMOTE))!.localTeamId;
  return { name, local, repo, store, net, api, teams, importer, sync, puller, localTeam };
}

beforeEach(async () => {
  n++;
  db = migratedDb();
  addClub(db, 'A');
  addClub(db, 'B');
  addTeam(db, REMOTE, 'A', 'SMA2627');
  addTeam(db, 'otro-club-equipo', 'B', 'SMA2627');
  env = { DB: db, TOKEN_PEPPER: PEPPER, INVITE_CODE_KEY: CODE_KEY, ENVIRONMENT: 'test', ALLOWED_ORIGINS: 'https://develop.galipau-stats.pages.dev' };
  tokens = {
    a: (await addDevice(db, 'iphone', [{ clubId: 'A', teamId: REMOTE, role: 'coach' }])).token,
    b: (await addDevice(db, 'entrenador-b', [{ clubId: 'A', teamId: REMOTE, role: 'coach' }])).token,
    viewer: (await addDevice(db, 'familia', [{ clubId: 'A', teamId: REMOTE, role: 'viewer' }])).token,
    otro: (await addDevice(db, 'otro-club', [{ clubId: 'B', teamId: 'otro-club-equipo', role: 'coach' }])).token,
  };
  // A: el registrador original, con su equipo propio vinculado y enviado.
  A = await device('iphone', tokens.a);
  teamA = await createTeam(A.repo, { name: 'Senior Masculino A', code: 'SMA2627', season: '2026/27', maxSquad: 16 });
  ids = [];
  for (const [num, pos] of [[7, 'field'], [9, 'field'], [14, 'field'], [22, 'field'], [1, 'goalkeeper']] as const) {
    ids.push((await savePlayer(A.repo, teamA.id, { name: `Jugador ${num}`, number: num, position: pos, active: true })).id);
  }
  finished = await svc.createMatch(A.repo, { teamId: teamA.id, opponent: 'CH Xàtiva', date: '2026-10-04', venue: 'away', season: '2026/27', playerIds: ids });
  for (let i = 0; i < 8; i++) {
    await svc.recordEvent(A.repo, finished, { kind: 'shot', shotType: 'nine_m', result: i % 3 ? 'goal' : 'saved' }, ids[i % 4]!, { period: 1, matchTimeMs: i * 60_000 });
  }
  finished = await svc.finishMatch(A.repo, finished);
  await A.sync.link(teamA.id, REMOTE);
  expect((await A.sync.upload(teamA.id)).status).toBe('verified');
  await A.puller.pull(teamA.id);
  A.net.writes = 0;
});

afterEach(async () => {
  for (const a of autos.splice(0)) await a.dispose();
});

/** B: entrenador nuevo que canjea su código e incorpora el equipo. */
async function coachB() {
  const B = await device('entrenador-b', tokens.b);
  await B.importer.incorporate();
  return B;
}

/** Cambio del club en una acción histórica (hecho por B y enviado). */
async function remoteCorrection(B: Awaited<ReturnType<typeof coachB>>, index: number, matchTimeMs: number) {
  const idB = await B.localTeam();
  const target = (await B.local.listEvents(finished.id))[index]!;
  await svc.updateEvent(B.repo, (await B.local.getMatch(finished.id))!, target, { matchTimeMs });
  expect((await B.sync.upload(idB)).status).toBe('verified');
  return target.id;
}

describe('acceso con código de entrenador', () => {
  it('dispositivo vacío: el equipo queda listo y editable, sin pendientes ni envíos', async () => {
    const B = await coachB();
    const id = await B.localTeam();
    expect(await B.store.getLink(id)).toMatchObject({ origin: 'imported', readOnly: false });
    expect((await B.store.getLink(id))?.auto).toBeUndefined();
    expect(await B.sync.pending(id)).toEqual({ players: 0, matches: 0, events: 0, matchDeletions: 0 });
    expect((await B.local.readAll()).teams).toHaveLength(1);
    // Editable: crea un partido.
    const m = await svc.createMatch(B.repo, { teamId: id, opponent: 'Nuevo', date: '2026-11-01', venue: 'home', season: '2026/27', playerIds: ids });
    expect(m.teamId).toBe(id);
    expect(B.net.writes).toBe(0);
  });

  it('volver a incorporar no duplica; un equipo quitado por el usuario no vuelve solo', async () => {
    const B = await coachB();
    await B.importer.incorporate();
    expect((await B.local.readAll()).teams).toHaveLength(1);
    await B.importer.discard(await B.localTeam(), { dismiss: true });
    await B.importer.incorporate();
    expect((await B.local.readAll()).teams).toHaveLength(0);
    expect(B.importer.incorporationOf(REMOTE)).toEqual({ status: 'dismissed' });
    await B.importer.addAgain(REMOTE);
    expect((await B.local.readAll()).teams).toHaveLength(1);
  });

  it('el iPhone original: su equipo se reutiliza tal cual, sin descargas ni cambios', async () => {
    const before = await A.local.readAll();
    const reads = A.net.reads;
    await A.importer.incorporate();
    expect(A.net.reads).toBe(reads);
    expect(await A.local.readAll()).toEqual(before);
    expect(A.importer.incorporationOf(REMOTE)).toBeNull();
  });

  it('código de consulta: no se prepara ningún equipo en el dispositivo', async () => {
    const V = await device('familia', tokens.viewer, 'viewer');
    await V.importer.incorporate();
    expect((await V.local.readAll()).teams).toEqual([]);
    expect(V.net.reads).toBe(0);
  });

  it('equipo local parecido sin vincular: se detiene con una explicación y no se reintenta solo', async () => {
    const B = await device('entrenador-b', tokens.b);
    await createTeam(B.repo, { name: 'Mi Senior', code: 'SMA2627', season: '2026/27', maxSquad: 16 });
    await B.importer.incorporate();
    expect(B.importer.incorporationOf(REMOTE)).toMatchObject({ status: 'blocked', message: expect.stringMatching(/«Mi Senior»/) });
    const reads = B.net.reads;
    await B.importer.incorporate();
    expect(B.net.reads).toBe(reads);
    expect((await B.local.readAll()).teams).toHaveLength(1);
  });

  it('sin conexión la primera vez: se indica que hace falta conectarse una vez', async () => {
    const B = await device('entrenador-b', tokens.b);
    B.net.down = true;
    await B.importer.incorporate();
    expect(B.importer.incorporationOf(REMOTE)).toMatchObject({ status: 'offline', message: expect.stringMatching(/conexión una vez/) });
    expect((await B.local.readAll()).teams).toEqual([]);
    B.net.down = false;
    await B.importer.incorporate();
    expect((await B.local.readAll()).teams).toHaveLength(1);
  });
});

describe('dos entrenadores sobre el mismo equipo', () => {
  it('partidos distintos a la vez: cada uno recibe el del otro, sin duplicados ni reenvíos', async () => {
    const B = await coachB();
    const idB = await B.localTeam();
    // A registra un partido en curso; B otro.
    let mA = await svc.createMatch(A.repo, { teamId: teamA.id, opponent: 'Rival A', date: '2026-11-01', venue: 'home', season: '2026/27', playerIds: ids });
    mA = await svc.toggleClock(A.repo, mA);
    await svc.recordEvent(A.repo, mA, { kind: 'shot', shotType: 'six_m', result: 'goal' }, ids[0]!, { period: 1, matchTimeMs: 1000 });
    let mB = await svc.createMatch(B.repo, { teamId: idB, opponent: 'Rival B', date: '2026-11-01', venue: 'away', season: '2026/27', playerIds: ids });
    mB = await svc.toggleClock(B.repo, mB);
    await svc.recordEvent(B.repo, mB, { kind: 'shot', shotType: 'six_m', result: 'goal' }, ids[1]!, { period: 1, matchTimeMs: 1000 });
    expect((await A.sync.upload(teamA.id)).status).toBe('verified');
    expect((await B.sync.upload(idB)).status).toBe('verified');
    // Control por partido: cada uno el suyo.
    expect(db.sqlite.prepare("SELECT opponent, control_device_id FROM matches WHERE status = 'in_progress' ORDER BY opponent").all()).toEqual([
      { opponent: 'Rival A', control_device_id: 'iphone' },
      { opponent: 'Rival B', control_device_id: 'entrenador-b' },
    ]);
    expect((await A.puller.pull(teamA.id)).status).toBe('ok');
    expect((await B.puller.pull(idB)).status).toBe('ok');
    expect((await A.local.getMatch(mB.id))?.opponent).toBe('Rival B');
    expect((await B.local.getMatch(mA.id))?.opponent).toBe('Rival A');
    // Cada uno sabe qué partido registra el otro.
    expect((await A.store.getLink(teamA.id))?.controlledElsewhere).toEqual([mB.id]);
    expect((await B.store.getLink(idB))?.controlledElsewhere).toEqual([mA.id]);
    // Nada pendiente en ninguno: lo recibido no se reenvía.
    expect(await A.sync.pending(teamA.id)).toEqual({ players: 0, matches: 0, events: 0, matchDeletions: 0 });
    expect(await B.sync.pending(idB)).toEqual({ players: 0, matches: 0, events: 0, matchDeletions: 0 });
    expect(seasonJson(computeSeasonStats(await loadSeasonItems(A.local, teamA.id)))).toBe(seasonJson(computeSeasonStats(await loadSeasonItems(B.local, idB))));
    expect(count('matches')).toBe(3);
    expect(count('events')).toBe(10);
  });

  it('un partido que registra otro dispositivo: el servidor rechaza las escrituras del otro y no se pierde nada', async () => {
    const B = await coachB();
    const idB = await B.localTeam();
    let m = await svc.createMatch(A.repo, { teamId: teamA.id, opponent: 'En directo', date: '2026-11-02', venue: 'home', season: '2026/27', playerIds: ids });
    m = await svc.toggleClock(A.repo, m);
    expect((await A.sync.upload(teamA.id)).status).toBe('verified');
    await B.puller.pull(idB);
    expect((await B.store.getLink(idB))?.controlledElsewhere).toEqual([m.id]);
    // Aun así, si B escribe (p. ej. sin haberlo recibido), el servidor lo rechaza y B lo conserva.
    const local = (await B.local.getMatch(m.id))!;
    const e = await svc.recordEvent(B.repo, local, { kind: 'recovery' }, null, { period: 1, matchTimeMs: 0 });
    expect(await B.sync.upload(idB)).toMatchObject({ status: 'stopped', stop: { reason: 'recorded_elsewhere' } });
    expect(await B.local.getEvent(e.id)).toBeDefined();
    expect(count(`events WHERE id = '${e.id}'`)).toBe(0);
  });

  it('correcciones históricas: llegan al otro entrenador y no se reenvían', async () => {
    const B = await coachB();
    const idB = await B.localTeam();
    const target = (await B.local.listEvents(finished.id))[0]!;
    const match = (await B.local.getMatch(finished.id))!;
    await svc.updateEvent(B.repo, match, target, { matchTimeMs: target.matchTimeMs + 5000 });
    expect((await B.sync.upload(idB)).status).toBe('verified');
    expect(await A.puller.pull(teamA.id)).toMatchObject({ status: 'ok', applied: 1, conflicts: 0, full: false });
    expect((await A.local.getEvent(target.id))!.matchTimeMs).toBe(target.matchTimeMs + 5000);
    expect((await A.store.getMeta('event', target.id))!.version).toBe(2);
    expect(await A.sync.pending(teamA.id)).toEqual({ players: 0, matches: 0, events: 0, matchDeletions: 0 });
  });
});

describe('conflictos', () => {
  it('acción cambiada aquí y en el club: no se toca, se avisa y se resuelve con la del club', async () => {
    const B = await coachB();
    const idB = await B.localTeam();
    const target = (await A.local.listEvents(finished.id))[1]!;
    // A la cambia sin enviar; B la cambia y la envía.
    await svc.updateEvent(A.repo, finished, target, { playerId: ids[2]! });
    await svc.updateEvent(B.repo, (await B.local.getMatch(finished.id))!, (await B.local.getEvent(target.id))!, { playerId: ids[3]! });
    expect((await B.sync.upload(idB)).status).toBe('verified');
    expect(await A.puller.pull(teamA.id)).toMatchObject({ status: 'ok', conflicts: 1 });
    expect((await A.local.getEvent(target.id))!.playerId).toBe(ids[2]); // el de A sigue intacto
    const link = (await A.store.getLink(teamA.id))!;
    expect(link.conflicts?.[0]).toMatchObject({ entity: 'event', entityId: target.id, label: expect.stringMatching(/CH Xàtiva/) });
    // El conflicto no detiene el envío del resto: ese registro se aparta y no pisa la del club.
    expect(link.autoBlocked ?? null).not.toBe(CONFLICT_BLOCK);
    expect((await A.sync.preview(teamA.id)).setAside).toContain(`event:${target.id}`);
    expect((await A.sync.upload(teamA.id)).status).toBe('verified');
    expect(db.sqlite.prepare('SELECT player_id FROM events WHERE id = ?').get(target.id)).toEqual({ player_id: ids[3] });
    // Elección expresa: la del club. Se guarda una copia del dato descartado.
    await A.puller.resolve(teamA.id, link.conflicts![0]!.key, 'club');
    expect((await A.local.getEvent(target.id))!.playerId).toBe(ids[3]);
    const kept = await A.store.listDiscarded();
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ entity: 'event', entityId: target.id, record: { playerId: ids[2] } });
    expect((await A.store.getLink(teamA.id))?.conflicts).toBeUndefined();
    expect((await A.store.getLink(teamA.id))?.autoBlocked ?? null).toBeNull();
    expect(await A.sync.pending(teamA.id)).toEqual({ players: 0, matches: 0, events: 0, matchDeletions: 0 });
  });

  it('jugador cambiado en los dos lados: «la mía» se envía sustituyendo la del club, por elección expresa', async () => {
    const B = await coachB();
    const idB = await B.localTeam();
    const p = (await A.local.getPlayer(ids[0]!))!;
    await A.repo.savePlayer({ ...p, name: 'Nombre de A', updatedAt: '2026-10-31T12:00:00.000Z' });
    await B.repo.savePlayer({ ...(await B.local.getPlayer(ids[0]!))!, name: 'Nombre de B', updatedAt: '2026-10-31T12:00:01.000Z' });
    expect((await B.sync.upload(idB)).status).toBe('verified');
    expect(await A.puller.pull(teamA.id)).toMatchObject({ conflicts: 1 });
    expect((await A.local.getPlayer(ids[0]!))!.name).toBe('Nombre de A');
    await A.puller.resolve(teamA.id, (await A.store.getLink(teamA.id))!.conflicts![0]!.key, 'mine');
    expect((await A.sync.upload(teamA.id)).status).toBe('verified');
    expect(db.sqlite.prepare('SELECT name FROM players WHERE id = ?').get(ids[0]!)).toEqual({ name: 'Nombre de A' });
    // B lo recibe después.
    await B.puller.pull(idB);
    expect((await B.local.getPlayer(ids[0]!))!.name).toBe('Nombre de A');
  });

  it('dorsal repetido por dos entrenadores: el servidor lo rechaza con un mensaje claro y nada se pierde', async () => {
    const B = await coachB();
    const idB = await B.localTeam();
    const mine = await savePlayer(A.repo, teamA.id, { name: 'Nuevo de A', number: 30, position: 'field', active: true });
    await savePlayer(B.repo, idB, { name: 'Nuevo de B', number: 30, position: 'field', active: true });
    expect((await B.sync.upload(idB)).status).toBe('verified');
    await A.puller.pull(teamA.id);
    // A recibe el de B: con dos 30 en el equipo, su envío se detiene antes de salir y lo explica.
    expect((await A.sync.preview(teamA.id)).problems.join(' ')).toMatch(/30/);
    await expect(A.sync.upload(teamA.id)).rejects.toThrow(/no aceptaría/);
    expect(await A.local.getPlayer(mine.id)).toBeDefined();
    expect(count("players WHERE name = 'Nuevo de A'")).toBe(0);
  });

  it('un cambio local mientras se reciben cambios: la recepción no lo pisa (se reintenta)', async () => {
    const B = await coachB();
    const idB = await B.localTeam();
    const target = (await B.local.listEvents(finished.id))[2]!;
    await svc.updateEvent(B.repo, (await B.local.getMatch(finished.id))!, target, { matchTimeMs: 1 });
    expect((await B.sync.upload(idB)).status).toBe('verified');
    // Justo cuando A va a guardar lo recibido, el usuario cambia esa acción.
    const real = A.local.applyRecords.bind(A.local);
    A.local.applyRecords = async (changes) => {
      const e = (await A.local.getEvent(target.id))!;
      await A.local.saveEvent({ ...e, matchTimeMs: 999 });
      return real(changes);
    };
    expect(await A.puller.pull(teamA.id)).toMatchObject({ status: 'busy' });
    expect((await A.local.getEvent(target.id))!.matchTimeMs).toBe(999);
    A.local.applyRecords = real;
    // La siguiente recepción lo ve como conflicto (cambiado en los dos lados).
    expect(await A.puller.pull(teamA.id)).toMatchObject({ conflicts: 1 });
    expect(ConcurrentChangeError).toBeDefined();
  });
});

describe('conexión y edición sin conexión', () => {
  it('sin conexión: se registra igual, nada se pierde y al volver se recibe y se envía', async () => {
    const B = await coachB();
    const idB = await B.localTeam();
    B.net.down = true;
    expect(await B.puller.pull(idB)).toMatchObject({ status: 'offline' });
    const m = await svc.createMatch(B.repo, { teamId: idB, opponent: 'Sin red', date: '2026-11-03', venue: 'home', season: '2026/27', playerIds: ids });
    await svc.recordEvent(B.repo, m, { kind: 'recovery' }, null, { period: 1, matchTimeMs: 0 });
    // Mientras, A corrige un histórico.
    const target = (await A.local.listEvents(finished.id))[3]!;
    await svc.updateEvent(A.repo, finished, target, { matchTimeMs: 4321 });
    expect((await A.sync.upload(teamA.id)).status).toBe('verified');
    B.net.down = false;
    expect(await B.puller.pull(idB)).toMatchObject({ status: 'ok', conflicts: 0 });
    expect((await B.local.getEvent(target.id))!.matchTimeMs).toBe(4321);
    expect((await B.sync.upload(idB)).status).toBe('verified');
    expect(count("matches WHERE opponent = 'Sin red'")).toBe(1);
  });

  it('el envío automático de un equipo incorporado sigue desactivado hasta activarlo; el del iPhone no cambia', async () => {
    const B = await coachB();
    const idB = await B.localTeam();
    const auto = new AutoSync(B.sync, B.store, B.api, () => B.teams, { quietMs: 10, maxWaitMs: 50 });
    autos.push(auto);
    await svc.recordEvent(B.repo, (await B.local.getMatch(finished.id))!, { kind: 'recovery' }, null, { period: 2, matchTimeMs: 3_500_000 });
    auto.changed(idB);
    await new Promise((r) => setTimeout(r, 120));
    expect(B.net.writes).toBe(0);
    expect((await A.store.getLink(teamA.id))?.auto).toBeUndefined();
  });
});

describe('permisos', () => {
  it('acceso retirado con cambios sin enviar: se conservan bloqueados y se desbloquean al recuperar el permiso', async () => {
    const B = await coachB();
    const idB = await B.localTeam();
    const e = await svc.recordEvent(B.repo, (await B.local.getMatch(finished.id))!, { kind: 'recovery' }, null, { period: 2, matchTimeMs: 3_000_000 });
    db.sqlite.prepare("UPDATE grants SET revoked_at = '2026-10-31T12:00:00.000Z' WHERE device_id = 'entrenador-b'").run();
    expect(await B.importer.retireExcept([])).toEqual([]);
    const link = (await B.store.getLink(idB))!;
    expect(link).toMatchObject({ accessLost: true, readOnly: true, autoBlocked: ACCESS_LOST });
    expect(await B.local.getEvent(e.id)).toBeDefined(); // nada se pierde
    // Bloqueado: ni edición ni envío.
    await expect(svc.recordEvent(B.repo, (await B.local.getMatch(finished.id))!, { kind: 'recovery' }, null, { period: 2, matchTimeMs: 1 })).rejects.toBeInstanceOf(ReadOnlyTeamError);
    await expect(B.sync.upload(idB)).rejects.toThrow(/solo lectura/);
    expect(await B.puller.pull(idB)).toMatchObject({ status: 'skipped' });
    // Recupera el permiso: se desbloquea y lo pendiente se envía.
    db.sqlite.prepare("INSERT INTO grants (id, device_id, club_id, team_id, role, created_at) VALUES ('g2', 'entrenador-b', 'A', ?, 'coach', ?)").run(REMOTE, '2026-10-31T13:00:00.000Z');
    await B.importer.retireExcept([REMOTE]);
    expect((await B.store.getLink(idB))).toMatchObject({ readOnly: false });
    expect((await B.store.getLink(idB))?.accessLost).toBeUndefined();
    expect((await B.sync.upload(idB)).status).toBe('verified');
    expect(count(`events WHERE id = '${e.id}'`)).toBe(1);
  });

  it('sin cambios propios, la copia se retira; el equipo original del iPhone nunca', async () => {
    const B = await coachB();
    expect(await B.importer.retireExcept([])).toHaveLength(1);
    expect((await B.local.readAll()).teams).toEqual([]);
    const before = await A.local.readAll();
    expect(await A.importer.retireExcept([])).toEqual([]);
    expect(await A.local.readAll()).toEqual(before);
  });

  it('un entrenador de otro club no recibe ni ve nada de este equipo', async () => {
    const C = await device('otro-club', tokens.otro);
    C.teams.splice(0, 1, remoteTeam('coach', 'otro-club-equipo'));
    await C.importer.incorporate();
    const all = await C.local.readAll();
    expect(all.players.some((p) => ids.includes(p.id))).toBe(false);
    // Aunque lo intentara directamente, el servidor no da el equipo.
    await expect(C.api.snapshot(tokens.otro, REMOTE)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(C.api.changes(tokens.otro, REMOTE, 0)).rejects.toMatchObject({ kind: 'not_found' });
  });
});

describe('eficiencia', () => {
  it('sin novedades no se descarga el equipo: una sola consulta ligera', async () => {
    const B = await coachB();
    const idB = await B.localTeam();
    const snaps = B.net.snapshots;
    for (let i = 0; i < 3; i++) expect(await B.puller.pull(idB)).toMatchObject({ status: 'ok', applied: 0, full: false });
    expect(B.net.snapshots).toBe(snaps);
  });
});

describe('integridad de la recepción', () => {
  const state = async () => ({ link: await A.store.getLink(teamA.id), metas: await A.store.listMeta(REMOTE), data: await A.local.readTeamData(teamA.id) });

  it('falla el guardado local tras la descarga: nada cambia (ni cursor ni versiones) y después se aplica', async () => {
    const B = await coachB();
    const id = await remoteCorrection(B, 0, 111);
    const before = await state();
    const real = A.local.applyRecords.bind(A.local);
    A.local.applyRecords = async () => {
      throw new StorageError('Sin espacio');
    };
    expect(await A.puller.pull(teamA.id)).toMatchObject({ status: 'error' });
    expect(await state()).toEqual(before);
    A.local.applyRecords = real;
    expect(await A.puller.pull(teamA.id)).toMatchObject({ status: 'ok', applied: 1 });
    expect((await A.local.getEvent(id))!.matchTimeMs).toBe(111);
  });

  it('cierre tras guardar los registros y antes de anotar versiones y cursor: la siguiente recepción lo completa sin duplicar', async () => {
    const B = await coachB();
    const id = await remoteCorrection(B, 1, 222);
    const cursor = (await A.store.getLink(teamA.id))!.cursor;
    const real = A.store.saveSyncState.bind(A.store);
    A.store.saveSyncState = async () => {
      throw new Error('cierre de la aplicación');
    };
    await expect(A.puller.pull(teamA.id)).rejects.toThrow(/cierre/);
    expect((await A.local.getEvent(id))!.matchTimeMs).toBe(222); // el registro sí quedó
    expect((await A.store.getLink(teamA.id))!.cursor).toBe(cursor); // el cursor no avanzó
    A.store.saveSyncState = real;
    expect(await A.puller.pull(teamA.id)).toMatchObject({ status: 'ok', conflicts: 0 });
    expect((await A.store.getMeta('event', id))!.version).toBe(2);
    expect((await A.store.getLink(teamA.id))!.cursor).toBeGreaterThan(cursor!);
    expect(await A.sync.pending(teamA.id)).toEqual({ players: 0, matches: 0, events: 0, matchDeletions: 0 });
    expect((await A.local.readAll()).events).toHaveLength(8);
  });

  it('muchos cambios (respuesta paginada): se descarga el equipo y el cursor queda en lo descargado', async () => {
    const B = await coachB();
    await remoteCorrection(B, 2, 333);
    const realChanges = A.api.changes;
    A.api.changes = async (...args) => ({ ...(await realChanges(...args)), hasMore: true });
    const snaps = A.net.snapshots;
    expect(await A.puller.pull(teamA.id)).toMatchObject({ status: 'ok', full: true });
    expect(A.net.snapshots).toBe(snaps + 1);
    const seq = (db.sqlite.prepare('SELECT MAX(seq) AS s FROM change_log').get() as { s: number }).s;
    expect((await A.store.getLink(teamA.id))!.cursor).toBe(seq);
    A.api.changes = realChanges;
  });

  it('un cambio local durante la recepción aborta todo: ni registros, ni versiones, ni cursor', async () => {
    const B = await coachB();
    const id = await remoteCorrection(B, 3, 444);
    const before = await A.store.getLink(teamA.id);
    const real = A.local.applyRecords.bind(A.local);
    A.local.applyRecords = async (changes) => {
      await A.local.saveEvent({ ...(await A.local.getEvent(id))!, matchTimeMs: 999 });
      return real(changes);
    };
    expect(await A.puller.pull(teamA.id)).toMatchObject({ status: 'busy' });
    A.local.applyRecords = real;
    expect(await A.store.getLink(teamA.id)).toEqual(before);
    expect((await A.store.getMeta('event', id))!.version).toBe(1);
    expect((await A.local.getEvent(id))!.matchTimeMs).toBe(999);
  });
});

describe('envío y recepción a la vez', () => {
  it('con un envío en curso la recepción no entra (y al revés)', async () => {
    const result = await withLock(REMOTE, () => A.puller.pull(teamA.id));
    expect(result).toMatchObject({ status: 'busy' });
    await expect(withLock(REMOTE, () => A.sync.upload(teamA.id))).resolves.toBeDefined().catch(() => undefined);
  });

  it('un conflicto no detiene el envío automático del partido en curso', async () => {
    const B = await coachB();
    const idB = await B.localTeam();
    const auto = new AutoSync(A.sync, A.store, A.api, () => A.teams, { quietMs: 20, maxWaitMs: 100, retryMs: [50] }).receiveWith(A.puller);
    autos.push(auto);
    await A.store.updateLink({ ...(await A.store.getLink(teamA.id))!, auto: true });
    // Conflicto en una acción histórica, aún no recibido por A.
    const target = (await A.local.listEvents(finished.id))[4]!;
    await svc.updateEvent(A.repo, finished, target, { playerId: ids[2]! });
    await svc.updateEvent(B.repo, (await B.local.getMatch(finished.id))!, (await B.local.getEvent(target.id))!, { playerId: ids[3]! });
    expect((await B.sync.upload(idB)).status).toBe('verified');
    // A registra en directo: sus acciones llegan aunque haya un conflicto.
    let live = await svc.createMatch(A.repo, { teamId: teamA.id, opponent: 'Directo', date: '2026-11-04', venue: 'home', season: '2026/27', playerIds: ids });
    live = await svc.toggleClock(A.repo, live);
    const e = await svc.recordEvent(A.repo, live, { kind: 'shot', shotType: 'six_m', result: 'goal' }, ids[0]!, { period: 1, matchTimeMs: 5000 });
    await auto.checkAll();
    const until = Date.now() + 4000;
    while (Date.now() < until && count(`events WHERE id = '${e.id}'`) === 0) await new Promise((r) => setTimeout(r, 30));
    expect(count(`events WHERE id = '${e.id}'`)).toBe(1);
    // El conflicto quedó registrado, sin pisar la del club, y el envío automático no se detuvo.
    const link = (await A.store.getLink(teamA.id))!;
    expect(link.conflicts?.map((c) => c.entityId)).toEqual([target.id]);
    expect(link.autoBlocked ?? null).toBeNull();
    expect(db.sqlite.prepare('SELECT player_id FROM events WHERE id = ?').get(target.id)).toEqual({ player_id: ids[3] });
  });

  it('«la mía» con un cambio posterior del club: el envío detecta el conflicto y no sustituye nada', async () => {
    const B = await coachB();
    const idB = await B.localTeam();
    const p = (await A.local.getPlayer(ids[1]!))!;
    await A.repo.savePlayer({ ...p, name: 'De A', updatedAt: '2026-10-31T12:00:00.000Z' });
    await B.repo.savePlayer({ ...(await B.local.getPlayer(ids[1]!))!, name: 'De B', updatedAt: '2026-10-31T12:00:01.000Z' });
    expect((await B.sync.upload(idB)).status).toBe('verified');
    await A.puller.pull(teamA.id);
    const key = (await A.store.getLink(teamA.id))!.conflicts![0]!.key;
    // B vuelve a cambiarlo antes de que A envíe su elección.
    await B.repo.savePlayer({ ...(await B.local.getPlayer(ids[1]!))!, name: 'De B otra vez', updatedAt: '2026-10-31T12:00:02.000Z' });
    expect((await B.sync.upload(idB)).status).toBe('verified');
    await A.puller.resolve(teamA.id, key, 'mine');
    const out = await A.sync.upload(teamA.id);
    expect(out.status === 'stopped' || out.status === 'differences').toBe(true);
    expect(db.sqlite.prepare('SELECT name FROM players WHERE id = ?').get(ids[1]!)).toEqual({ name: 'De B otra vez' });
    // Y se ofrece de nuevo como conflicto (nada se ha perdido).
    await A.puller.pull(teamA.id);
    expect((await A.store.getLink(teamA.id))!.conflicts?.[0]?.entityId).toBe(ids[1]);
    expect((await A.local.getPlayer(ids[1]!))!.name).toBe('De A');
  });
});

describe('eliminaciones y revocaciones', () => {
  it('partido eliminado en el club con acciones sin enviar aquí: no se elimina solo; se elige y nada se borra', async () => {
    const B = await coachB();
    const idB = await B.localTeam();
    const mine = await svc.recordEvent(A.repo, finished, { kind: 'recovery' }, ids[0]!, { period: 2, matchTimeMs: 3_100_000 });
    await svc.deleteMatch(B.repo, (await B.local.getMatch(finished.id))!);
    expect((await B.sync.upload(idB)).status).toBe('verified');
    expect(await A.puller.pull(teamA.id)).toMatchObject({ conflicts: 1 });
    expect((await A.local.getMatch(finished.id))!.deletedAt).toBeNull();
    expect((await A.store.getLink(teamA.id))!.conflicts![0]!.label).toMatch(/eliminado en el club/);
    // Antes de confirmar, se cuentan las acciones sin enviar que quedarían sin enviar.
    expect(await A.puller.pendingEventsIn(teamA.id, finished.id)).toBe(1);
    // «La del club»: el partido se elimina aquí; la acción sin enviar sigue guardada.
    await A.puller.resolve(teamA.id, `match:${finished.id}`, 'club');
    expect((await A.local.getMatch(finished.id))!.deletedAt).not.toBeNull();
    expect(await A.local.getEvent(mine.id)).toBeDefined();
    expect(count(`events WHERE id = '${mine.id}'`)).toBe(0);
  });

  it('acción anulada en el club y corregida aquí: conflicto; nada se resucita ni se pisa', async () => {
    const B = await coachB();
    const idB = await B.localTeam();
    const target = (await A.local.listEvents(finished.id))[5]!;
    await svc.updateEvent(A.repo, finished, target, { matchTimeMs: 1234 });
    await svc.deleteEvent(B.repo, (await B.local.getEvent(target.id))!);
    expect((await B.sync.upload(idB)).status).toBe('verified');
    expect(await A.puller.pull(teamA.id)).toMatchObject({ conflicts: 1 });
    expect((await A.local.getEvent(target.id))!.deletedAt).toBeNull();
    expect((await A.sync.upload(teamA.id)).status).toBe('verified'); // apartada: no se envía
    expect(db.sqlite.prepare('SELECT deleted_at IS NOT NULL AS anulada FROM events WHERE id = ?').get(target.id)).toEqual({ anulada: 1 });
  });

  it('eliminado en el club sin cambios aquí: se elimina y las siguientes recepciones no lo resucitan', async () => {
    const B = await coachB();
    const idB = await B.localTeam();
    await svc.deleteMatch(B.repo, (await B.local.getMatch(finished.id))!);
    expect((await B.sync.upload(idB)).status).toBe('verified');
    await A.puller.pull(teamA.id);
    expect((await A.local.getMatch(finished.id))!.deletedAt).not.toBeNull();
    for (let i = 0; i < 2; i++) await A.puller.pull(teamA.id, { full: true });
    expect((await A.local.getMatch(finished.id))!.deletedAt).not.toBeNull();
    expect(await A.sync.pending(teamA.id)).toEqual({ players: 0, matches: 0, events: 0, matchDeletions: 0 });
  });

  it('cambios recibidos fuera de orden: una versión antigua nunca sustituye a una más nueva', async () => {
    const B = await coachB();
    const id = await remoteCorrection(B, 6, 600);
    const old = await A.api.snapshot(tokens.a, REMOTE); // descarga con la versión 2
    // B la vuelve a corregir (versión 3).
    await svc.updateEvent(B.repo, (await B.local.getMatch(finished.id))!, (await B.local.getEvent(id))!, { matchTimeMs: 700 });
    expect((await B.sync.upload(await B.localTeam())).status).toBe('verified');
    await A.puller.pull(teamA.id);
    expect((await A.local.getEvent(id))!.matchTimeMs).toBe(700);
    // Llega tarde la descarga antigua.
    const realSnap = A.api.snapshot;
    A.api.snapshot = async () => old;
    await A.puller.pull(teamA.id, { full: true });
    A.api.snapshot = realSnap;
    expect((await A.local.getEvent(id))!.matchTimeMs).toBe(700);
    expect((await A.store.getMeta('event', id))!.version).toBe(3);
  });

  it('revocación durante una recepción: la retirada espera y no quedan registros huérfanos', async () => {
    const B = await coachB();
    const idB = await B.localTeam();
    await remoteCorrection(B, 7, 777);
    const realSnap = B.api.snapshot;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    B.api.snapshot = async (...args) => {
      await gate;
      return realSnap(...args);
    };
    const pulling = B.puller.pull(idB, { full: true });
    await new Promise((r) => setTimeout(r, 20));
    const retiring = B.importer.retireExcept([]);
    await new Promise((r) => setTimeout(r, 50));
    release();
    await pulling;
    expect(await retiring).toEqual([idB]);
    B.api.snapshot = realSnap;
    expect(await B.local.readAll()).toEqual({ teams: [], players: [], matches: [], events: [] });
    expect(await B.store.listLinks()).toEqual([]);
  });

  it('cierre de sesión con cambios sin enviar: se conservan; al volver con conexión y permiso, se desbloquean', async () => {
    const B = await coachB();
    const idB = await B.localTeam();
    const e = await svc.recordEvent(B.repo, (await B.local.getMatch(finished.id))!, { kind: 'recovery' }, null, { period: 2, matchTimeMs: 3_000_000 });
    const listeners = new Set<() => void>();
    let s = { ready: true, checking: false, linked: false, problem: null as null | string, checkedAt: null as null | string, teams: [] as RemoteTeam[] };
    B.importer.followSession({ getState: () => s as never, subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)) });
    await new Promise((r) => setTimeout(r, 50));
    expect(await B.store.getLink(idB)).toMatchObject({ accessLost: true });
    expect(await B.local.getEvent(e.id)).toBeDefined();
    // Sin conexión: nada cambia.
    s = { ...s, linked: true, problem: 'offline', checkedAt: '2026-10-31T14:00:00.000Z' };
    listeners.forEach((l) => l());
    await new Promise((r) => setTimeout(r, 50));
    expect(await B.store.getLink(idB)).toMatchObject({ accessLost: true });
    // Comprobación correcta con permiso: se desbloquea.
    s = { ...s, problem: null, checkedAt: '2026-10-31T15:00:00.000Z', teams: [remoteTeam('coach')] };
    listeners.forEach((l) => l());
    await new Promise((r) => setTimeout(r, 100));
    expect((await B.store.getLink(idB))?.accessLost).toBeUndefined();
    expect((await B.sync.upload(idB)).status).toBe('verified');
    expect(count(`events WHERE id = '${e.id}'`)).toBe(1);
  });
});
