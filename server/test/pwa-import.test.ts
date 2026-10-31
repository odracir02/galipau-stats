// Copia de un equipo del club en el dispositivo de otro entrenador
// (src/remote/importer.ts), contra el Worker real en memoria. El iPhone sube un
// equipo sintético equivalente al real (23 jugadores, 3 partidos oficiales con
// 273 acciones, anuladas, sanciones adicionales y un partido de prueba
// eliminado). Nunca toca datos reales ni D1 Preview.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ObservableRepository, ReadOnlyTeamError } from '../../src/app/observableRepository';
import { IndexedDbRepository } from '../../src/data/indexedDbRepository';
import { StorageError, type TeamData } from '../../src/data/repository';
import type { Match, Team } from '../../src/domain/types';
import { loadSeasonItems } from '../../src/services/statsService';
import * as svc from '../../src/services/matchService';
import { createTeam, savePlayer } from '../../src/services/teamService';
import { computeMatchStats, computeSeasonStats } from '../../src/stats/engine';
import { RANKINGS, rankPlayers, seasonCandidates } from '../../src/stats/rankings';
import { createApi, type Api, type RemoteTeam } from '../../src/remote/api';
import { AutoSync } from '../../src/remote/autosync';
import { ClubSync } from '../../src/remote/clubsync';
import { TeamImporter } from '../../src/remote/importer';
import { buildPlan } from '../../src/remote/plan';
import { AccountStore } from '../../src/remote/store';
import { pendingChanges, pendingTotal, stableJson } from '../../src/remote/upload';
import { ClubViewer, ViewerStore } from '../../src/remote/viewer';
import worker, { type Env } from '../src/index';
import { addClub, addDevice, addTeam, CODE_KEY, PEPPER } from './seed';
import { migratedDb, type SqliteD1 } from './sqliteD1';

const REMOTE = 'remoto-sma';
let n = 0;
let db: SqliteD1;
let env: Env;
let iphoneRepo: IndexedDbRepository;
let iphoneTeam: Team;
let iphone: ClubSync;
let tokens: Record<'coach' | 'other' | 'viewer', string>;
let matches: Match[];

const remoteTeam = (role: RemoteTeam['role'] = 'coach', status: RemoteTeam['status'] = 'active'): RemoteTeam => ({
  teamId: REMOTE,
  role,
  status,
  name: 'Senior Masculino A',
  code: 'SMA2627',
  season: '2026/27',
  clubId: 'A',
  clubName: 'Club A',
});

/** Red de un dispositivo: recuento de peticiones, corte y fallo puntual. */
function network() {
  const net = { down: false, writes: 0, reads: 0, api: null as unknown as Api };
  net.api = createApi({
    baseUrl: 'https://api.example',
    fetch: async (input, init) => {
      if (net.down) throw new TypeError('Failed to fetch');
      if ((init?.method ?? 'GET') === 'POST') net.writes++;
      else net.reads++;
      return worker.fetch(new Request(input as string, init), env);
    },
  });
  return net;
}

const count = (sql: string) => (db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get() as { n: number }).n;
const serverDump = () =>
  JSON.stringify(['players', 'matches', 'match_squad', 'events', 'change_log', 'sync_ops'].map((t) => db.sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));

/** Dispositivo de otro entrenador (o de consulta): base local propia, cuenta y copia. */
async function coachDevice(name: string, token = tokens.other, role: RemoteTeam['role'] = 'coach') {
  const local = new IndexedDbRepository(`local-${n}-${name}`);
  const repo = new ObservableRepository(local);
  const store = new AccountStore(`cuenta-${n}-${name}`);
  await store.saveDevice({ deviceId: name, token, joinedAt: '2026-10-31T10:00:00.000Z' });
  const net = network();
  const teams = [remoteTeam(role)];
  const importer = new TeamImporter(local, store, net.api, () => teams);
  repo.protectReadOnly(importer);
  await importer.load();
  const sync = new ClubSync(repo, store, net.api, () => teams);
  return { local, repo, store, net, teams, importer, sync };
}

/** Lo que mandaría un envío desde la copia (sin enviar nada), saltándose el bloqueo de solo lectura. */
async function pendingOf(d: Awaited<ReturnType<typeof coachDevice>>, localTeamId: string) {
  const link = (await d.store.getLink(localTeamId))!;
  const team = (await d.local.getTeam(localTeamId))!;
  const sent = new Set((await d.store.listMeta(REMOTE)).filter((m) => m.entity === 'match').map((m) => m.entityId));
  return pendingTotal(await pendingChanges(buildPlan(await d.local.readAll(), team, { ...link, readOnly: false }, sent), d.store));
}

const seasonJson = (s: ReturnType<typeof computeSeasonStats>) => stableJson({ ...s, players: [...s.players.entries()].sort() });

beforeEach(async () => {
  n++;
  db = migratedDb();
  addClub(db, 'A');
  addTeam(db, REMOTE, 'A', 'SMA2627');
  env = { DB: db, TOKEN_PEPPER: PEPPER, INVITE_CODE_KEY: CODE_KEY, ENVIRONMENT: 'test', ALLOWED_ORIGINS: 'https://develop.galipau-stats.pages.dev' };
  tokens = {
    coach: (await addDevice(db, 'iphone', [{ clubId: 'A', teamId: REMOTE, role: 'coach' }])).token,
    other: (await addDevice(db, 'otro-entrenador', [{ clubId: 'A', teamId: REMOTE, role: 'coach' }])).token,
    viewer: (await addDevice(db, 'familia', [{ clubId: 'A', teamId: REMOTE, role: 'viewer' }])).token,
  };

  // Equipo del iPhone, equivalente en estructura y volumen al real.
  iphoneRepo = new IndexedDbRepository(`local-${n}-iphone`);
  iphoneTeam = await createTeam(iphoneRepo, { name: 'Senior Masculino A', code: 'SMA2627', season: '2026/27', maxSquad: 16 });
  const ids: string[] = [];
  for (let i = 0; i < 23; i++) {
    ids.push((await savePlayer(iphoneRepo, iphoneTeam.id, { name: `Jugador ${i + 1}`, number: i + 1, position: i < 3 ? 'goalkeeper' : 'field', active: true })).id);
  }
  const squad = ids.slice(0, 16);
  matches = [];
  const t = (i: number) => ({ period: (i < 45 ? 1 : 2) as 1 | 2, matchTimeMs: i * 20_000 });
  for (const [m, total] of [[0, 80], [1, 90], [2, 103]] as const) {
    let match = await svc.createMatch(iphoneRepo, { teamId: iphoneTeam.id, opponent: `Rival ${m}`, date: `2026-10-0${m + 3}`, venue: 'home', season: '2026/27', playerIds: squad });
    for (let i = 0; i < total; i++) {
      const field = squad[3 + (i % 13)]!;
      if (i % 9 === 0) await svc.recordEvent(iphoneRepo, match, { kind: 'gk_shot', shotType: 'nine_m', result: i % 2 ? 'goal' : 'save' }, squad[0]!, t(i));
      else if (i % 23 === 0) {
        await svc.recordEvent(iphoneRepo, match, { kind: 'exclusion' }, field, t(i));
        await svc.setAddsToPrevious(iphoneRepo, await svc.recordEvent(iphoneRepo, match, { kind: 'red' }, field, t(i)), true);
        i++;
      } else if (i % 31 === 0) await svc.recordEvent(iphoneRepo, match, { kind: 'free_throw' }, null, t(i));
      else if (i % 17 === 0) await svc.deleteEvent(iphoneRepo, await svc.recordEvent(iphoneRepo, match, { kind: 'shot', shotType: 'six_m', result: 'goal' }, field, t(i)));
      else await svc.recordEvent(iphoneRepo, match, { kind: 'shot', shotType: i % 3 ? 'nine_m' : 'six_m', result: i % 4 ? 'goal' : 'saved' }, field, t(i));
    }
    match = await svc.setScoreAdjustment(iphoneRepo, match, { own: m, opponent: 0 });
    matches.push(await svc.finishMatch(iphoneRepo, match));
  }
  // Partido de prueba eliminado, con sus 10 acciones.
  const probe = await svc.createMatch(iphoneRepo, { teamId: iphoneTeam.id, opponent: 'Prueba', date: '2026-10-29', venue: 'home', season: '2026/27', playerIds: squad });
  for (let i = 0; i < 10; i++) await svc.recordEvent(iphoneRepo, probe, { kind: 'recovery' }, squad[4]!, t(i));
  const iphoneStore = new AccountStore(`cuenta-${n}-iphone`);
  await iphoneStore.saveDevice({ deviceId: 'iphone', token: tokens.coach, joinedAt: '2026-10-31T10:00:00.000Z' });
  iphone = new ClubSync(iphoneRepo, iphoneStore, network().api, () => [remoteTeam('coach')]);
  await iphone.link(iphoneTeam.id, REMOTE);
  expect((await iphone.upload(iphoneTeam.id)).status).toBe('verified');
  await svc.deleteMatch(iphoneRepo, (await iphoneRepo.getMatch(probe.id))!);
  expect((await iphone.upload(iphoneTeam.id)).status).toBe('verified');
  expect(count("events WHERE match_id <> '" + probe.id + "'")).toBe(273);
});

describe('importar un equipo del club', () => {
  it('copia completa: mismos identificadores, anuladas, sanciones, eliminados y versiones', async () => {
    const d = await coachDevice('portatil');
    const phases: string[] = [];
    const r = await d.importer.importTeam(REMOTE, (p) => phases.push(p));
    expect(phases).toEqual(['download', 'check', 'save', 'verify']);
    expect(r).toMatchObject({ players: 23, matches: 3, deletedMatches: 1 });
    expect(r.events + r.deletedEvents).toBe(283);

    const copy = (await d.local.readTeamData(r.localTeamId))!;
    const orig = (await iphoneRepo.readTeamData(iphoneTeam.id))!;
    const strip = (x: TeamData) => ({
      players: x.players.map(({ teamId: _, ...p }) => p).sort((a, b) => a.id.localeCompare(b.id)),
      matches: x.matches.map(({ teamId: _, ...m }) => m).sort((a, b) => a.id.localeCompare(b.id)),
      events: [...x.events].sort((a, b) => a.id.localeCompare(b.id)),
    });
    expect(stableJson(strip(copy))).toBe(stableJson(strip(orig)));
    expect(copy.events.filter((e) => e.addsToPrevious === true).length).toBeGreaterThan(0);
    expect(copy.events.filter((e) => e.deletedAt !== null).length).toBe(orig.events.filter((e) => e.deletedAt !== null).length);
    // Versiones del servidor anotadas tal cual.
    const metas = await d.store.listMeta(REMOTE);
    expect(metas).toHaveLength(23 + 4 + 283);
    const serverVersion = db.sqlite.prepare("SELECT version FROM matches WHERE opponent = 'Prueba'").get() as { version: number };
    expect(metas.find((m) => m.entity === 'match' && m.entityId === orig.matches.find((x) => x.opponent === 'Prueba')!.id)!.version).toBe(serverVersion.version);
    // Vínculo de copia: solo lectura, sin envío automático, con el cursor del club.
    expect(await d.store.getLink(r.localTeamId)).toMatchObject({ origin: 'imported', readOnly: true, cursor: expect.any(Number) });
    expect((await d.store.getLink(r.localTeamId))?.auto).toBeUndefined();
  });

  it('las estadísticas, resultados y rankings son los mismos que en el iPhone', async () => {
    const d = await coachDevice('portatil');
    const { localTeamId } = await d.importer.importTeam(REMOTE);
    const a = await loadSeasonItems(iphoneRepo, iphoneTeam.id);
    const b = await loadSeasonItems(d.local, localTeamId);
    expect(seasonJson(computeSeasonStats(b))).toBe(seasonJson(computeSeasonStats(a)));
    const scores = (items: typeof a) => items.map(({ match, events }) => [match.id, computeMatchStats(match, events).score]).sort();
    expect(scores(b)).toEqual(scores(a));
    for (const def of RANKINGS) {
      const r = (items: typeof a) => rankPlayers(def, seasonCandidates(computeSeasonStats(items))).map((e) => [e.position, e.player.playerId, e.value]);
      expect(r(b), def.id).toEqual(r(a));
    }
  });

  it('nada pendiente y ninguna escritura en el servidor (tampoco las 273 acciones históricas)', async () => {
    const before = serverDump();
    const d = await coachDevice('portatil');
    const { localTeamId } = await d.importer.importTeam(REMOTE);
    expect(await pendingOf(d, localTeamId)).toBe(0);
    expect(d.net.writes).toBe(0);
    // El envío automático no se puede activar y no envía nada.
    const auto = new AutoSync(d.sync, d.store, d.net.api, () => d.teams, { quietMs: 10, maxWaitMs: 50 });
    await expect(auto.setEnabled(localTeamId, true)).rejects.toThrow(/solo lectura/);
    await auto.checkAll();
    await new Promise((r) => setTimeout(r, 100));
    await auto.dispose();
    // Tampoco el envío manual.
    await expect(d.sync.upload(localTeamId)).rejects.toThrow(/solo lectura/);
    expect(d.net.writes).toBe(0);
    expect(serverDump()).toBe(before);
  });

  it('repetir la importación no duplica nada', async () => {
    const d = await coachDevice('portatil');
    const first = await d.importer.importTeam(REMOTE);
    const reads = d.net.reads;
    const again = await d.importer.importTeam(REMOTE);
    expect(again).toEqual(first);
    expect(d.net.reads).toBe(reads); // ni siquiera vuelve a descargar
    const all = await d.local.readAll();
    expect(all.teams).toHaveLength(1);
    expect(all.players).toHaveLength(23);
    expect(await d.store.listLinks()).toHaveLength(1);
  });
});

describe('interrupciones', () => {
  it('sin conexión al descargar: no se escribe nada', async () => {
    const d = await coachDevice('portatil');
    d.net.down = true;
    await expect(d.importer.importTeam(REMOTE)).rejects.toMatchObject({ kind: 'offline' });
    expect(await d.local.readAll()).toEqual({ teams: [], players: [], matches: [], events: [] });
    expect(await d.store.listLinks()).toEqual([]);
    expect(await d.store.listMeta(REMOTE)).toEqual([]);
  });

  it('fallo al guardar la copia: se retira el vínculo y no queda nada', async () => {
    const d = await coachDevice('portatil');
    d.local.addTeamData = async () => {
      throw new StorageError('Sin espacio');
    };
    await expect(d.importer.importTeam(REMOTE)).rejects.toThrow(/Sin espacio/);
    expect((await d.local.readAll()).teams).toEqual([]);
    expect(await d.store.listLinks()).toEqual([]);
    expect(await d.store.listMeta(REMOTE)).toEqual([]);
    expect(await d.importer.state(REMOTE)).toEqual({ kind: 'available' });
  });

  it('cortada justo antes de terminar: queda pendiente, de solo lectura, y se reanuda sin duplicar', async () => {
    const d = await coachDevice('portatil');
    const real = d.store.updateImportedLink.bind(d.store);
    d.store.updateImportedLink = async () => {
      throw new Error('cierre de la aplicación');
    };
    await expect(d.importer.importTeam(REMOTE)).rejects.toThrow(/cierre/);
    const state = await d.importer.state(REMOTE);
    expect(state.kind).toBe('pending');
    const localTeamId = (state as { link: { localTeamId: string } }).link.localTeamId;
    // Mientras está pendiente no se puede tocar.
    const match = (await d.local.listMatches(localTeamId))[0]!;
    await expect(svc.recordEvent(d.repo, match, { kind: 'recovery' }, null, { period: 1, matchTimeMs: 0 })).rejects.toBeInstanceOf(ReadOnlyTeamError);
    d.store.updateImportedLink = real;
    // Al reabrir la aplicación se reanuda.
    const reopened = new TeamImporter(d.local, d.store, d.net.api, () => d.teams);
    await reopened.load();
    const r = await reopened.importTeam(REMOTE);
    expect(r.localTeamId).toBe(localTeamId);
    expect((await d.local.readAll()).teams).toHaveLength(1);
    expect(await reopened.state(REMOTE)).toMatchObject({ kind: 'imported' });
    expect(await pendingOf(d, localTeamId)).toBe(0);
  });

  it('una importación pendiente también se puede descartar sin dejar rastro', async () => {
    const d = await coachDevice('portatil');
    d.store.updateImportedLink = async () => {
      throw new Error('cierre de la aplicación');
    };
    await expect(d.importer.importTeam(REMOTE)).rejects.toThrow();
    const { link } = (await d.importer.state(REMOTE)) as { link: { localTeamId: string } };
    await d.importer.discard(link.localTeamId);
    expect(await d.local.readAll()).toEqual({ teams: [], players: [], matches: [], events: [] });
    expect(await d.store.listLinks()).toEqual([]);
    expect(await d.store.listMeta(REMOTE)).toEqual([]);
  });
});

describe('protección de los equipos existentes', () => {
  it('en el iPhone, su equipo ya vinculado nunca se importa ni se toca', async () => {
    const iphoneStore = new AccountStore(`cuenta-${n}-iphone`);
    const net = network();
    const importer = new TeamImporter(iphoneRepo, iphoneStore, net.api, () => [remoteTeam('coach')]);
    await importer.load();
    const before = await iphoneRepo.readAll();
    const link = await iphoneStore.getLink(iphoneTeam.id);
    expect(await importer.state(REMOTE)).toMatchObject({ kind: 'linked' });
    await expect(importer.importTeam(REMOTE)).rejects.toThrow(/ya está vinculado con «Senior Masculino A»/);
    expect(net.reads + net.writes).toBe(0);
    expect(await iphoneRepo.readAll()).toEqual(before);
    expect(await iphoneStore.getLink(iphoneTeam.id)).toEqual(link);
    // La retirada por sesión nunca toca un equipo propio.
    expect(await importer.retireExcept([])).toEqual([]);
    expect(await iphoneRepo.readAll()).toEqual(before);
  });

  it('un equipo local parecido sin vincular (mismo código) no se fusiona', async () => {
    const d = await coachDevice('portatil');
    await createTeam(d.repo, { name: 'Mi Senior', code: 'SMA2627', season: '2026/27', maxSquad: 16 });
    const before = await d.local.readAll();
    await expect(d.importer.importTeam(REMOTE)).rejects.toThrow(/«Mi Senior».*No se ha importado nada/);
    expect(await d.local.readAll()).toEqual(before);
    expect(await d.store.listLinks()).toEqual([]);
  });

  it('datos con los mismos identificadores (p. ej. una copia de seguridad restaurada) no se fusionan', async () => {
    const d = await coachDevice('portatil');
    const restored = (await iphoneRepo.readTeamData(iphoneTeam.id))!;
    await d.local.addTeamData({ ...restored, team: { ...restored.team, code: 'COPIA' } });
    const before = await d.local.readAll();
    await expect(d.importer.importTeam(REMOTE)).rejects.toThrow(/sin vincular con el club/);
    expect(await d.local.readAll()).toEqual(before);
    expect(await d.store.listLinks()).toEqual([]);
  });

  it('el envío automático del iPhone sigue igual después de que otro importe', async () => {
    const d = await coachDevice('portatil');
    await d.importer.importTeam(REMOTE);
    const iphoneStore = new AccountStore(`cuenta-${n}-iphone`);
    expect((await iphoneStore.getLink(iphoneTeam.id))?.auto).toBeUndefined();
    const match = (await iphoneRepo.getMatch(matches[0]!.id))!;
    await svc.recordEvent(iphoneRepo, match, { kind: 'recovery' }, null, { period: 2, matchTimeMs: 3_000_000 });
    expect((await iphone.upload(iphoneTeam.id)).status).toBe('verified');
  });
});

describe('permisos', () => {
  it('con código de consulta no se puede importar', async () => {
    const d = await coachDevice('familia', tokens.viewer, 'viewer');
    expect(await d.importer.state(REMOTE)).toEqual({ kind: 'not_allowed' });
    await expect(d.importer.importTeam(REMOTE)).rejects.toMatchObject({ kind: 'forbidden' });
    expect(d.net.reads).toBe(0);
    expect((await d.local.readAll()).teams).toEqual([]);
  });

  it('club no disponible: no se puede importar', async () => {
    const d = await coachDevice('portatil');
    d.teams.splice(0, 1, remoteTeam('coach', 'unavailable'));
    await expect(d.importer.importTeam(REMOTE)).rejects.toMatchObject({ kind: 'forbidden' });
  });

  it('acceso retirado: la copia se retira del dispositivo y no se puede enviar nada', async () => {
    const d = await coachDevice('portatil');
    const { localTeamId } = await d.importer.importTeam(REMOTE);
    // Sesión simulada: una comprobación correcta que ya no incluye el equipo.
    const listeners = new Set<() => void>();
    let state = { ready: true, checking: false, linked: true, problem: null as null | string, checkedAt: '2026-10-31T10:00:00.000Z', teams: [remoteTeam('coach')] };
    const session = { getState: () => state as never, subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)) };
    d.importer.followSession(session);
    await new Promise((r) => setTimeout(r, 20));
    expect(await d.local.getTeam(localTeamId)).toBeDefined(); // con permiso, se conserva
    db.sqlite.prepare("UPDATE grants SET revoked_at = '2026-10-31T11:00:00.000Z' WHERE device_id = 'otro-entrenador'").run();
    state = { ...state, checkedAt: '2026-10-31T11:00:00.000Z', teams: [] };
    listeners.forEach((l) => l());
    await new Promise((r) => setTimeout(r, 50));
    expect(await d.local.readAll()).toEqual({ teams: [], players: [], matches: [], events: [] });
    expect(await d.store.listLinks()).toEqual([]);
    expect(await d.sync.upload(localTeamId).catch((e: Error) => e.message)).toMatch(/no está vinculado/);
  });

  it('sin conexión, una sesión no verificada no retira la copia', async () => {
    const d = await coachDevice('portatil');
    const { localTeamId } = await d.importer.importTeam(REMOTE);
    const state = { ready: true, checking: false, linked: true, problem: 'offline', checkedAt: '2026-10-31T09:00:00.000Z', teams: [] };
    d.importer.followSession({ getState: () => state as never, subscribe: () => () => undefined });
    await new Promise((r) => setTimeout(r, 30));
    expect(await d.local.getTeam(localTeamId)).toBeDefined();
  });
});

describe('cambios en el club después de importar', () => {
  it('se detectan, la copia no se puede editar y «Actualizar copia» la pone al día sin pendientes', async () => {
    const d = await coachDevice('portatil');
    const { localTeamId } = await d.importer.importTeam(REMOTE);
    expect(await d.importer.isBehind(localTeamId)).toBe(false);

    // El iPhone corrige una acción histórica y registra otra.
    const match = (await iphoneRepo.getMatch(matches[1]!.id))!;
    const target = (await iphoneRepo.listEvents(match.id)).find((e) => e.kind === 'shot' && e.deletedAt === null)!;
    await svc.updateEvent(iphoneRepo, match, target, { matchTimeMs: target.matchTimeMs + 1000 });
    await svc.recordEvent(iphoneRepo, match, { kind: 'recovery' }, null, { period: 2, matchTimeMs: 3_000_000 });
    expect((await iphone.upload(iphoneTeam.id)).status).toBe('verified');
    expect(await d.importer.isBehind(localTeamId)).toBe(true);

    // Nadie puede sobrescribir desde la copia antigua.
    const copyMatch = (await d.local.getMatch(match.id))!;
    const stale = (await d.local.getEvent(target.id))!;
    await expect(svc.updateEvent(d.repo, copyMatch, stale, { matchTimeMs: 1 })).rejects.toBeInstanceOf(ReadOnlyTeamError);
    await expect(svc.recordEvent(d.repo, copyMatch, { kind: 'recovery' }, null, { period: 1, matchTimeMs: 0 })).rejects.toBeInstanceOf(ReadOnlyTeamError);
    await expect(d.repo.savePlayer({ ...(await d.local.listPlayers(localTeamId))[0]!, name: 'Cambio' })).rejects.toBeInstanceOf(ReadOnlyTeamError);
    expect((await d.local.getEvent(target.id))!.matchTimeMs).toBe(target.matchTimeMs);

    // Actualizar copia.
    await d.importer.refresh(localTeamId);
    expect((await d.local.getEvent(target.id))!.matchTimeMs).toBe(target.matchTimeMs + 1000);
    expect((await d.store.getMeta('event', target.id))!.version).toBe(2);
    expect(await d.importer.isBehind(localTeamId)).toBe(false);
    expect(await pendingOf(d, localTeamId)).toBe(0);
    const a = await loadSeasonItems(iphoneRepo, iphoneTeam.id);
    const b = await loadSeasonItems(d.local, localTeamId);
    expect(seasonJson(computeSeasonStats(b))).toBe(seasonJson(computeSeasonStats(a)));
    expect(d.net.writes).toBe(0);
  });

  it('si la copia tuviera cambios propios, «Actualizar copia» no los sobrescribe', async () => {
    const d = await coachDevice('portatil');
    const { localTeamId } = await d.importer.importTeam(REMOTE);
    // Cambio hecho por debajo del repositorio (no debería poder ocurrir).
    const p = (await d.local.listPlayers(localTeamId))[0]!;
    await d.local.savePlayer({ ...p, name: 'Cambio local' });
    await expect(d.importer.refresh(localTeamId)).rejects.toThrow(/no se sobrescribe/);
    expect((await d.local.getPlayer(p.id))!.name).toBe('Cambio local');
  });

  it('los demás equipos del dispositivo siguen siendo editables', async () => {
    const d = await coachDevice('portatil');
    await d.importer.importTeam(REMOTE);
    const own = await createTeam(d.repo, { name: 'Infantil', code: 'INF', season: '2026/27', maxSquad: 16 });
    expect((await savePlayer(d.repo, own.id, { name: 'Propio', number: 5, position: 'field', active: true })).name).toBe('Propio');
  });
});

describe('compatibilidad', () => {
  it('la consulta en directo del mismo equipo sigue funcionando en el dispositivo y aparte de la copia', async () => {
    const d = await coachDevice('portatil');
    const { localTeamId } = await d.importer.importTeam(REMOTE);
    const viewer = new ClubViewer(d.net.api, d.store, new ViewerStore(`consulta-${n}-portatil`));
    expect(await viewer.refresh(remoteTeam('coach'))).toBe('ok');
    expect(viewer.view(REMOTE).cached!.snapshot.events).toHaveLength(283);
    expect(await viewer.poll(remoteTeam('coach'))).toBe('ok');
    // Retirar lo descargado para consulta no toca la copia.
    await viewer.forget(REMOTE);
    expect(await d.local.getTeam(localTeamId)).toBeDefined();
    expect(d.net.writes).toBe(0);
  });

  it('las bases del dispositivo no cambian de versión', async () => {
    const d = await coachDevice('portatil');
    await d.importer.importTeam(REMOTE);
    const dbs = await indexedDB.databases();
    expect(dbs.find((x) => x.name === `local-${n}-portatil`)?.version).toBe(1);
    expect(dbs.find((x) => x.name === `cuenta-${n}-portatil`)?.version).toBe(2);
  });
});
